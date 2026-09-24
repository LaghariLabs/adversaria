"""Tests for Live Copilot live_extract endpoint, prompt, validation, and execution."""

from __future__ import annotations

import json
import logging
from unittest.mock import MagicMock, patch

import pytest
from pydantic import ValidationError

from src.live_extract import (
    LIVE_EXTRACT_SYSTEM_PROMPT,
    build_user_text,
    extract,
    validate_output,
)
from src.models import (
    LiveExtractModelOutput,
    LiveExtractModelOutputNoSummary,
    LiveExtractModelOutputWithSummary,
    LiveExtractRequest,
    LiveExtractResponse,
    LiveItemIn,
    LiveRetraction,
    LiveSummary,
    LiveTurn,
    LiveUpsert,
)
from src.server import _ACCESS_LOG_POLL_FILTER


def test_prompt_content() -> None:
    """Prompt must contain required phrasing regarding evidence turns, JSON output, and action/summary rules."""
    assert "never cite ids that are not in the input" in LIVE_EXTRACT_SYSTEM_PROMPT
    assert "Output JSON only" in LIVE_EXTRACT_SYSTEM_PROMPT
    assert "is an ACTION with that speaker as owner" in LIVE_EXTRACT_SYSTEM_PROMPT
    assert "never return null" in LIVE_EXTRACT_SYSTEM_PROMPT


def test_prompt_includes_implicit_decision_rule_and_example() -> None:
    """Settled choices are decisions, with the reversal guidance now supplied by the retraction block."""
    rule = (
        'A statement that settles a choice ("we go with X", "let\'s use X", "we\'re doing X", '
        '"we\'re not doing Y", "scrap Y") is a DECISION even without the word decide.'
    )
    example = (
        "Example: t3 Me: We go with Cytoscape for diagrams, not Mermaid, because it's already in the app. "
        '→ decision upsert {"kind": "decision", "text": "Use Cytoscape for diagrams instead of Mermaid.", '
        '"evidence_turn_ids": ["t3"]}'
    )
    assert rule in LIVE_EXTRACT_SYSTEM_PROMPT
    assert example in LIVE_EXTRACT_SYSTEM_PROMPT
    assert "a later reversal of a decision is a retraction of the earlier one plus a new decision." not in LIVE_EXTRACT_SYSTEM_PROMPT


def test_build_user_text_includes_all_sections_and_caps() -> None:
    """build_user_text includes items, summary, flag and turns, and caps at 24,000 chars dropping oldest turns."""
    # 1. Verify content inclusion
    req = LiveExtractRequest(
        request_id="req_1",
        session_id="ses_1",
        base_revision=1,
        model="qwen3.6:35b",
        update_summary=True,
        items=[
            LiveItemIn(
                id="li_01",
                kind="action",
                text="Ship the demo.",
                owner="Them",
                due="Friday",
                status="proposed",
                evidence_turn_ids=["t1"],
            )
        ],
        summary=LiveSummary(
            bullets=["Kickoff meeting started."], evidence_turn_ids=["t1"]
        ),
        turns=[
            LiveTurn(id="t1", start_ms=0, end_ms=3000, source="Them", text="Let's start."),
            LiveTurn(id="t2", start_ms=3000, end_ms=6000, source="Me", text="Sounds good."),
        ],
    )
    user_text, rendered_ids = build_user_text(req)
    assert "EXISTING ITEMS:" in user_text
    assert "li_01 | action | proposed | Them | Friday | t1 | Ship the demo." in user_text
    assert "CURRENT SUMMARY:" in user_text
    assert "- Kickoff meeting started." in user_text
    assert "UPDATE_SUMMARY: true" in user_text
    assert "TURNS:" in user_text
    assert "t1 [0-3000] Them: Let's start." in user_text
    assert "t2 [3000-6000] Me: Sounds good." in user_text

    # 2. Verify capping at 24,000 chars and dropping oldest turns first while preserving items
    turns = [
        LiveTurn(
            id=f"t{i:03d}",
            start_ms=i * 1000,
            end_ms=(i + 1) * 1000,
            source="Me",
            text=f"Turn message {i:03d} " + ("x" * 280),
        )
        for i in range(100)
    ]
    long_req = LiveExtractRequest(
        request_id="req_long",
        session_id="ses_long",
        base_revision=1,
        model="qwen3.6:35b",
        update_summary=False,
        items=[
            LiveItemIn(
                id="li_must_keep",
                kind="decision",
                text="Never drop this item.",
                owner="Me",
                due=None,
                status="accepted",
                evidence_turn_ids=["t1"],
            )
        ],
        turns=turns,
    )
    capped_text, capped_ids = build_user_text(long_req)
    assert len(capped_text) <= 24_000
    assert "li_must_keep | decision | accepted" in capped_text
    assert "t000 [" not in capped_text
    assert "t099 [" in capped_text
    assert "t000" not in capped_ids
    assert "t099" in capped_ids


def test_validate_output_rules() -> None:
    """validate_output drops unknown turn ids, duplicates by normalized text, forces summary None, keeps <=4 bullets."""
    req = LiveExtractRequest(
        request_id="req_v",
        session_id="ses_v",
        base_revision=2,
        model="qwen3.6:35b",
        update_summary=False,
        new_turn_ids=["t2"],
        items=[
            LiveItemIn(
                id="li_existing",
                kind="action",
                text="Prepare the demo.",
                owner="Me",
                due=None,
                status="proposed",
                evidence_turn_ids=["t1"],
            )
        ],
        turns=[
            LiveTurn(id="t1", start_ms=0, end_ms=4000, source="Me", text="I'll prepare the demo."),
            LiveTurn(id="t2", start_ms=4000, end_ms=8000, source="Them", text="Agreed on schedule."),
        ],
    )
    raw = LiveExtractModelOutputWithSummary(
        upserts=[
            # Citing unknown turn id "t99" -> drop
            LiveUpsert(
                id=None,
                kind="action",
                text="Unknown turn reference",
                evidence_turn_ids=["t99"],
            ),
            # Duplicate of existing item by normalized text ("preparethedemo") -> drop
            LiveUpsert(
                id=None,
                kind="action",
                text="Prepare the demo!",
                evidence_turn_ids=["t1"],
            ),
            # Blank text -> drop
            LiveUpsert(
                id=None,
                kind="action",
                text="   ",
                evidence_turn_ids=["t1"],
            ),
            # Text over 240 chars -> drop
            LiveUpsert(
                id=None,
                kind="action",
                text="a" * 241,
                evidence_turn_ids=["t1"],
            ),
            # Empty evidence_turn_ids -> drop
            LiveUpsert(
                id=None,
                kind="action",
                text="Valid text but no evidence",
                evidence_turn_ids=[],
            ),
            # Unknown id set -> set id to None (treated as new)
            LiveUpsert(
                id="li_unknown_id",
                kind="decision",
                text="We decided on Thursday.",
                evidence_turn_ids=["t2"],
                supersedes_id="li_invalid_super",
            ),
            # Valid update to existing item
            LiveUpsert(
                id="li_existing",
                kind="action",
                text="Prepare the full interactive demo.",
                owner="Me",
                due="Tomorrow",
                evidence_turn_ids=["t1"],
            ),
        ],
        retractions=[
            # Unknown retraction id -> drop
            LiveRetraction(id="li_not_existing", evidence_turn_ids=["t2"], reason_code="explicit_withdrawal", withdrawal_quote="Agreed on schedule"),
            # Valid retraction
            LiveRetraction(id="li_existing", evidence_turn_ids=["t2"], reason_code="explicit_withdrawal", withdrawal_quote="Agreed on schedule"),
            # Retraction with unknown turn id -> drop
            LiveRetraction(id="li_existing", evidence_turn_ids=["t999"], reason_code="explicit_withdrawal", withdrawal_quote="Agreed on schedule"),
        ],
        summary=LiveSummary(
            bullets=[
                " Bullet 1 ",
                "",
                "Bullet 2",
                "Bullet 3",
                "  ",
                "Bullet 4",
                "Bullet 5",
            ],
            evidence_turn_ids=["t1"],
        ),
    )

    upserts, retractions, summary = validate_output(raw, req)

    # 1. Upserts check
    # We expect:
    # - "We decided on Thursday." with id=None and supersedes_id=None
    # - "Prepare the full interactive demo." with id="li_existing"
    assert len(upserts) == 2
    assert upserts[0].text == "We decided on Thursday."
    assert upserts[0].id is None
    assert upserts[0].supersedes_id is None
    assert upserts[1].id == "li_existing"
    assert upserts[1].text == "Prepare the full interactive demo."

    # 2. Retractions check
    assert len(retractions) == 1
    assert retractions[0].id == "li_existing"
    assert retractions[0].evidence_turn_ids == ["t2"]

    # 3. Summary check: update_summary was False -> summary forced None
    assert summary is None

    # 4. Now with update_summary=True: keep at most 4 non-empty bullets
    req_with_summary = req.model_copy(update={"update_summary": True})
    _, _, summary_enabled = validate_output(raw, req_with_summary)
    assert summary_enabled is not None
    assert len(summary_enabled.bullets) == 4
    assert summary_enabled.bullets == ["Bullet 1", "Bullet 2", "Bullet 3", "Bullet 4"]

    # 5. Summary with unknown turn id -> summary dropped
    raw_invalid_summary = raw.model_copy(
        update={
            "summary": LiveSummary(
                bullets=["A valid bullet"], evidence_turn_ids=["t_unknown"]
            )
        }
    )
    _, _, summary_dropped = validate_output(raw_invalid_summary, req_with_summary)
    assert summary_dropped is None


def _retraction_req(**overrides) -> LiveExtractRequest:
    defaults: dict = dict(
        request_id="req_ret",
        session_id="ses_ret",
        base_revision=1,
        model="qwen3.6:35b",
        new_turn_ids=["t2"],
        items=[
            LiveItemIn(
                id="li_1",
                kind="decision",
                text="Use Mermaid for diagrams.",
                status="proposed",
                evidence_turn_ids=["t1"],
            )
        ],
        turns=[
            LiveTurn(id="t1", start_ms=0, end_ms=1000, source="Me", text="We'll use Mermaid for diagrams."),
            LiveTurn(id="t2", start_ms=1000, end_ms=2000, source="Me", text="Scrap the Mermaid idea completely."),
        ],
    )
    defaults.update(overrides)
    return LiveExtractRequest(**defaults)


def test_retraction_valid_withdrawal_kept() -> None:
    """A retraction with a matching quote, new-turn evidence, and valid reason code is kept."""
    req = _retraction_req()
    raw = LiveExtractModelOutput(
        upserts=[],
        retractions=[
            LiveRetraction(
                id="li_1",
                evidence_turn_ids=["t2"],
                reason_code="explicit_withdrawal",
                withdrawal_quote="Scrap the Mermaid idea completely",
            ),
        ],
    )
    upserts, retractions, _ = validate_output(raw, req)
    assert len(retractions) == 1
    assert retractions[0].id == "li_1"
    assert retractions[0].reason_code == "explicit_withdrawal"


def test_retraction_missing_quote_dropped() -> None:
    """A retraction whose quote is blank is dropped."""
    req = _retraction_req()
    raw = LiveExtractModelOutput(
        upserts=[],
        retractions=[
            LiveRetraction(
                id="li_1",
                evidence_turn_ids=["t2"],
                reason_code="explicit_withdrawal",
                withdrawal_quote="   ",
            ),
        ],
    )
    _, retractions, _ = validate_output(raw, req)
    assert retractions == []


def test_retraction_quote_not_in_cited_turn_dropped() -> None:
    """A quote that is not a substring of any cited turn's text is dropped."""
    req = _retraction_req()
    raw = LiveExtractModelOutput(
        upserts=[],
        retractions=[
            LiveRetraction(
                id="li_1",
                evidence_turn_ids=["t2"],
                reason_code="explicit_withdrawal",
                withdrawal_quote="Totally unrelated sentence",
            ),
        ],
    )
    _, retractions, _ = validate_output(raw, req)
    assert retractions == []


def test_retraction_evidence_only_overlap_dropped() -> None:
    """Evidence only on overlap turns (none in new_turn_ids) is dropped."""
    req = _retraction_req(new_turn_ids=["t3"])
    raw = LiveExtractModelOutput(
        upserts=[],
        retractions=[
            LiveRetraction(
                id="li_1",
                evidence_turn_ids=["t2"],
                reason_code="explicit_withdrawal",
                withdrawal_quote="Scrap the Mermaid idea completely",
            ),
        ],
    )
    _, retractions, _ = validate_output(raw, req)
    assert retractions == []


def test_retraction_replacement_without_upsert_drops_both() -> None:
    """explicit_replacement without a matching supersedes_id upsert drops both the retraction and replacement."""
    req = _retraction_req()
    raw = LiveExtractModelOutput(
        upserts=[],
        retractions=[
            LiveRetraction(
                id="li_1",
                evidence_turn_ids=["t2"],
                reason_code="explicit_replacement",
                withdrawal_quote="Scrap the Mermaid idea completely",
            ),
        ],
    )
    upserts, retractions, _ = validate_output(raw, req)
    assert retractions == []
    assert upserts == []


def test_retraction_replacement_with_upsert_kept() -> None:
    """explicit_replacement paired with a supersedes_id upsert is kept atomically."""
    req = _retraction_req()
    raw = LiveExtractModelOutput(
        upserts=[
            LiveUpsert(
                id=None,
                kind="decision",
                text="Use Cytoscape for diagrams.",
                evidence_turn_ids=["t2"],
                supersedes_id="li_1",
            ),
        ],
        retractions=[
            LiveRetraction(
                id="li_1",
                evidence_turn_ids=["t2"],
                reason_code="explicit_replacement",
                withdrawal_quote="Scrap the Mermaid idea completely",
            ),
        ],
    )
    upserts, retractions, _ = validate_output(raw, req)
    assert len(retractions) == 1
    assert len(upserts) == 1
    assert upserts[0].supersedes_id == "li_1"


def test_prompt_preserve_existing_items_phrase() -> None:
    """The prompt carries the exact preserve-unless-explicitly-withdrawn instruction."""
    assert (
        "Preserve existing items unless a NEW turn explicitly withdraws or replaces the identified item"
        in LIVE_EXTRACT_SYSTEM_PROMPT
    )


def test_extract_success() -> None:
    """extract returns validated upserts for mocked model output and through_ms = max end_ms."""
    mock_summarizer = MagicMock()
    model_payload = {
        "upserts": [
            {
                "id": None,
                "kind": "action",
                "text": "Prepare the demo.",
                "owner": "Me",
                "due": None,
                "evidence_turn_ids": ["t9"],
                "supersedes_id": None,
            }
        ],
        "retractions": [],
        "summary": None,
    }
    mock_summarizer._chat_ollama_once.return_value = {
        "message": {"content": json.dumps(model_payload)}
    }
    mock_client = MagicMock()

    req = LiveExtractRequest(
        request_id="x1",
        session_id="s1",
        base_revision=4,
        model="qwen3.6:35b",
        turns=[
            LiveTurn(
                id="t8",
                start_ms=135000,
                end_ms=140000,
                source="Them",
                text="Can you demo?",
            ),
            LiveTurn(
                id="t9",
                start_ms=140000,
                end_ms=145000,
                source="Me",
                text="I'll prepare the demo.",
            ),
        ],
    )

    resp = extract(req, mock_summarizer, mock_client)

    assert resp.status == "ok"
    assert resp.request_id == "x1"
    assert resp.session_id == "s1"
    assert resp.base_revision == 4
    assert resp.through_ms == 145000
    assert len(resp.upserts) == 1
    assert resp.upserts[0].text == "Prepare the demo."
    assert resp.upserts[0].owner == "Me"
    assert resp.upserts[0].evidence_turn_ids == ["t9"]
    assert resp.retractions == []
    assert resp.summary is None


def test_extract_model_error() -> None:
    """extract returns status: error with reason when the model call raises."""
    mock_summarizer = MagicMock()
    mock_summarizer._chat_ollama_once.side_effect = RuntimeError("Ollama connection timed out")
    mock_client = MagicMock()

    req = LiveExtractRequest(
        request_id="x1",
        session_id="s1",
        base_revision=4,
        model="qwen3.6:35b",
        turns=[
            LiveTurn(
                id="t9",
                start_ms=140000,
                end_ms=145000,
                source="Me",
                text="I'll prepare the demo.",
            ),
        ],
    )

    resp = extract(req, mock_summarizer, mock_client)

    assert resp.status == "error"
    assert resp.reason is not None
    assert "Ollama connection timed out" in resp.reason
    assert resp.through_ms is None
    assert resp.upserts == []
    assert resp.retractions == []
    assert resp.summary is None


def test_route_live_extract_no_turns() -> None:
    """POST /copilot/live_extract with no turns returns ok/empty without calling the model."""
    from test_server import client

    with patch("src.server.live_extract.extract") as mock_extract:
        resp = client.post(
            "/copilot/live_extract",
            json={
                "request_id": "r_no_turns",
                "session_id": "s_no_turns",
                "base_revision": 1,
                "model": "qwen3.6:35b",
                "turns": [],
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert data["through_ms"] is None
        assert data["upserts"] == []
        assert data["retractions"] == []
        assert data["summary"] is None
        mock_extract.assert_not_called()


def test_route_live_extract_with_turns() -> None:
    """POST /copilot/live_extract with turns calls the extractor and returns its response."""
    from test_server import client

    expected = LiveExtractResponse(
        request_id="r_with_turns",
        session_id="s_with_turns",
        base_revision=3,
        status="ok",
        through_ms=12000,
        upserts=[
            LiveUpsert(
                id=None,
                kind="decision",
                text="Proceed with deployment.",
                evidence_turn_ids=["t1"],
            )
        ],
        retractions=[],
        summary=None,
    )

    with patch("src.server.live_extract.extract", return_value=expected) as mock_extract:
        resp = client.post(
            "/copilot/live_extract",
            json={
                "request_id": "r_with_turns",
                "session_id": "s_with_turns",
                "base_revision": 3,
                "model": "qwen3.6:35b",
                "turns": [
                    {
                        "id": "t1",
                        "start_ms": 10000,
                        "end_ms": 12000,
                        "source": "Me",
                        "text": "Let's proceed with deployment.",
                    }
                ],
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert data["through_ms"] == 12000
        assert len(data["upserts"]) == 1
        assert data["upserts"][0]["text"] == "Proceed with deployment."
        mock_extract.assert_called_once()


def test_access_log_filter_drops_copilot_live_extract_2xx() -> None:
    """Access log filter drops 2xx POST /copilot/live_extract, retains non-2xx and others."""
    # 2xx POST /copilot/live_extract is dropped (filter returns False)
    rec_200 = logging.LogRecord(
        name="uvicorn.access",
        level=logging.INFO,
        pathname="",
        lineno=0,
        msg="",
        args=("127.0.0.1", "POST", "/copilot/live_extract", "1.1", 200),
        exc_info=None,
    )
    assert _ACCESS_LOG_POLL_FILTER.filter(rec_200) is False

    # Non-2xx POST /copilot/live_extract is logged (filter returns True)
    rec_500 = logging.LogRecord(
        name="uvicorn.access",
        level=logging.INFO,
        pathname="",
        lineno=0,
        msg="",
        args=("127.0.0.1", "POST", "/copilot/live_extract", "1.1", 500),
        exc_info=None,
    )
    assert _ACCESS_LOG_POLL_FILTER.filter(rec_500) is True

    # Other POST routes are logged
    rec_other = logging.LogRecord(
        name="uvicorn.access",
        level=logging.INFO,
        pathname="",
        lineno=0,
        msg="",
        args=("127.0.0.1", "POST", "/copilot_answer_stream", "1.1", 200),
        exc_info=None,
    )
    assert _ACCESS_LOG_POLL_FILTER.filter(rec_other) is True


def test_models_required_fields_and_schemas() -> None:
    """Verify LiveExtractModelOutput fields are required and schemas handle summary presence/absence."""
    # LiveExtractModelOutput requires upserts and retractions (no defaults)
    with pytest.raises(ValidationError):
        LiveExtractModelOutput()  # type: ignore[call-arg]

    with pytest.raises(ValidationError):
        LiveExtractModelOutput(upserts=[])  # type: ignore[call-arg]

    with pytest.raises(ValidationError):
        LiveExtractModelOutput(retractions=[])  # type: ignore[call-arg]

    # LiveExtractModelOutputWithSummary requires summary (not null, not omitted)
    with pytest.raises(ValidationError):
        LiveExtractModelOutputWithSummary(upserts=[], retractions=[])  # type: ignore[call-arg]

    with pytest.raises(ValidationError):
        LiveExtractModelOutputWithSummary(upserts=[], retractions=[], summary=None)  # type: ignore[arg-type]

    valid_with = LiveExtractModelOutputWithSummary(
        upserts=[],
        retractions=[],
        summary=LiveSummary(bullets=["Meeting started."], evidence_turn_ids=["t1"]),
    )
    assert valid_with.summary.bullets == ["Meeting started."]

    # Schemas:
    schema_with = LiveExtractModelOutputWithSummary.model_json_schema()
    schema_no = LiveExtractModelOutputNoSummary.model_json_schema()

    # When update_summary is true: summary is required
    assert "summary" in schema_with["properties"]
    assert "summary" in schema_with["required"]
    assert "upserts" in schema_with["required"]
    assert "retractions" in schema_with["required"]

    # When update_summary is false: summary is absent
    assert "summary" not in schema_no["properties"]
    assert "summary" not in schema_no.get("required", [])
    assert "upserts" in schema_no["required"]
    assert "retractions" in schema_no["required"]


def test_extract_schema_selection_and_summary_forcing() -> None:
    """extract uses WithSummary schema when update_summary=True, NoSummary schema when False, and forces summary None."""
    mock_summarizer = MagicMock()
    mock_client = MagicMock()

    captured_schemas = []

    def mock_chat_ollama_once(**kwargs):
        captured_schemas.append(kwargs.get("json_schema"))
        return {
            "message": {
                "content": json.dumps(
                    {
                        "upserts": [],
                        "retractions": [],
                        "summary": {
                            "bullets": ["Live bullet"],
                            "evidence_turn_ids": ["t1"],
                        },
                    }
                )
            }
        }

    mock_summarizer._chat_ollama_once.side_effect = mock_chat_ollama_once

    base_turns = [
        LiveTurn(id="t1", start_ms=0, end_ms=2000, source="Me", text="Hello world"),
    ]

    # 1. update_summary = True: schema has summary required
    req_true = LiveExtractRequest(
        request_id="r1",
        session_id="s1",
        base_revision=1,
        model="qwen3.6:35b",
        update_summary=True,
        turns=base_turns,
    )
    resp_true = extract(req_true, mock_summarizer, mock_client)
    assert resp_true.status == "ok"
    assert resp_true.summary is not None
    assert resp_true.summary.bullets == ["Live bullet"]

    schema_true = captured_schemas[0]
    assert "summary" in schema_true["properties"]
    assert "summary" in schema_true["required"]

    # 2. update_summary = False: schema has summary absent and summary is forced None
    req_false = LiveExtractRequest(
        request_id="r2",
        session_id="s1",
        base_revision=2,
        model="qwen3.6:35b",
        update_summary=False,
        turns=base_turns,
    )
    resp_false = extract(req_false, mock_summarizer, mock_client)
    assert resp_false.status == "ok"
    assert resp_false.summary is None

    schema_false = captured_schemas[1]
    assert "summary" not in schema_false["properties"]
    assert "summary" not in schema_false.get("required", [])
