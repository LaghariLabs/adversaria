"""Versioned evaluation-corpus contracts and safe path loading."""

from __future__ import annotations

import json
import hashlib
import re
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from eval import SCHEMA_VERSION

_SESSION_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{5,63}$")


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Provenance(StrictModel):
    kind: Literal["consented-private", "public", "synthetic"]
    consent_confirmed: bool
    source_note: str = Field(min_length=1, max_length=240)
    license: str | None = Field(default=None, max_length=160)


class AudioAsset(StrictModel):
    path: str
    channel_role: Literal["system", "mic", "mixed"]
    sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


class ReferenceAssets(StrictModel):
    transcript: str
    turns: str
    outcomes: str
    rttm: str | None = None


class SessionManifest(StrictModel):
    schema_version: Literal[1]
    session_id: str
    release_set: bool = True
    duration_seconds: float = Field(gt=0)
    languages: list[Literal["en", "ar", "code-switch", "other"]] = Field(
        min_length=1
    )
    conditions: list[
        Literal[
            "clean",
            "silence",
            "playback-only",
            "bleed",
            "background-noise",
            "overlap",
            "long",
        ]
    ] = Field(min_length=1)
    expected_speaker_count: int = Field(ge=0, le=32)
    audio: list[AudioAsset] = Field(min_length=1)
    reference: ReferenceAssets
    hypothesis: str
    provenance: Provenance

    @field_validator("session_id")
    @classmethod
    def anonymized_session_id(cls, value: str) -> str:
        if not _SESSION_ID.fullmatch(value):
            raise ValueError(
                "session_id must be a stable anonymized lowercase identifier"
            )
        return value


class CorpusManifest(StrictModel):
    schema_version: Literal[1]
    corpus_id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{2,63}$")
    sessions: list[str] = Field(min_length=1)


class TranscriptTurn(StrictModel):
    id: str
    speaker: str = Field(min_length=1, max_length=80)
    text: str
    start: float = Field(ge=0)
    end: float = Field(ge=0)

    @model_validator(mode="after")
    def ordered_times(self) -> "TranscriptTurn":
        if self.end < self.start:
            raise ValueError("turn end must be at or after start")
        return self


class ReferenceItem(StrictModel):
    id: str
    text: str = Field(min_length=1)
    critical: bool = False


class ReferenceOutcomes(StrictModel):
    names: list[ReferenceItem] = Field(default_factory=list)
    entities: list[ReferenceItem] = Field(default_factory=list)
    dates: list[ReferenceItem] = Field(default_factory=list)
    numbers: list[ReferenceItem] = Field(default_factory=list)
    facts: list[ReferenceItem] = Field(default_factory=list)
    decisions: list[ReferenceItem] = Field(default_factory=list)
    action_items: list[ReferenceItem] = Field(default_factory=list)


class EvaluatedClaim(StrictModel):
    text: str
    kind: Literal["fact", "decision", "other"] = "fact"
    reference_ids: list[str] = Field(default_factory=list)
    evidence_turn_ids: list[str] = Field(default_factory=list)
    critical: bool = False


class EvaluatedActionItem(StrictModel):
    text: str
    reference_id: str | None = None
    evidence_turn_ids: list[str] = Field(default_factory=list)


class Hypothesis(StrictModel):
    schema_version: Literal[1]
    app_version: str = Field(min_length=1)
    model_profile: str = Field(min_length=1)
    model_revisions: dict[str, str] = Field(min_length=1)
    evaluation_config: dict[str, str | int | float | bool]
    transcript: str
    turns: list[TranscriptTurn]
    summary: str
    summary_claims: list[EvaluatedClaim]
    action_items: list[EvaluatedActionItem]


class LoadedSession(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    root: Path
    manifest: SessionManifest
    reference_transcript: str
    reference_turns: list[TranscriptTurn]
    reference_outcomes: ReferenceOutcomes
    hypothesis: Hypothesis


def _safe_path(root: Path, relative: str) -> Path:
    candidate = (root / relative).resolve()
    resolved_root = root.resolve()
    if candidate != resolved_root and resolved_root not in candidate.parents:
        raise ValueError(f"evaluation path escapes its root: {relative}")
    return candidate


def _load_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ValueError(f"missing evaluation asset: {path}") from error
    except json.JSONDecodeError as error:
        raise ValueError(f"invalid JSON in {path}: {error}") from error


def load_corpus(root: Path) -> tuple[CorpusManifest, list[LoadedSession]]:
    root = root.resolve()
    corpus = CorpusManifest.model_validate(_load_json(root / "corpus.json"))
    sessions: list[LoadedSession] = []
    seen: set[str] = set()
    for manifest_relative in corpus.sessions:
        manifest_path = _safe_path(root, manifest_relative)
        session_root = manifest_path.parent
        manifest = SessionManifest.model_validate(_load_json(manifest_path))
        if manifest.schema_version != SCHEMA_VERSION:
            raise ValueError(f"unsupported session schema: {manifest.schema_version}")
        if manifest.session_id in seen:
            raise ValueError(f"duplicate session_id: {manifest.session_id}")
        seen.add(manifest.session_id)
        if manifest.provenance.kind == "consented-private" and not (
            manifest.provenance.consent_confirmed
        ):
            raise ValueError(f"private session lacks consent: {manifest.session_id}")
        for audio in manifest.audio:
            audio_path = _safe_path(session_root, audio.path)
            if not audio_path.exists():
                raise ValueError(f"missing audio asset for {manifest.session_id}")
            if audio.sha256:
                digest = hashlib.sha256(audio_path.read_bytes()).hexdigest()
                if digest != audio.sha256:
                    raise ValueError(f"audio hash mismatch for {manifest.session_id}")
        transcript_path = _safe_path(session_root, manifest.reference.transcript)
        turns_path = _safe_path(session_root, manifest.reference.turns)
        outcomes_path = _safe_path(session_root, manifest.reference.outcomes)
        if manifest.reference.rttm:
            rttm_path = _safe_path(session_root, manifest.reference.rttm)
            if not rttm_path.exists():
                raise ValueError(f"missing RTTM for {manifest.session_id}")
        reference_turns = [
            TranscriptTurn.model_validate(turn) for turn in _load_json(turns_path)
        ]
        turn_ids = [turn.id for turn in reference_turns]
        if len(turn_ids) != len(set(turn_ids)):
            raise ValueError(f"duplicate reference turn id: {manifest.session_id}")
        reference_speakers = {turn.speaker for turn in reference_turns}
        if len(reference_speakers) != manifest.expected_speaker_count:
            raise ValueError(
                f"reference speaker count disagrees with {manifest.session_id} manifest"
            )
        if any(turn.end > manifest.duration_seconds + 0.5 for turn in reference_turns):
            raise ValueError(f"reference turn exceeds duration: {manifest.session_id}")
        sessions.append(
            LoadedSession(
                root=session_root,
                manifest=manifest,
                reference_transcript=transcript_path.read_text(encoding="utf-8"),
                reference_turns=reference_turns,
                reference_outcomes=ReferenceOutcomes.model_validate(
                    _load_json(outcomes_path)
                ),
                hypothesis=Hypothesis.model_validate(
                    _load_json(_safe_path(session_root, manifest.hypothesis))
                ),
            )
        )
    return corpus, sessions
