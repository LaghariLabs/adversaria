"""Unit tests for Copilot rev 6 section parser, user text builder, and request validation."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from src.copilot_answer import (
    COPILOT_SYSTEM_PROMPT,
    SectionStreamParser,
    build_user_text,
)
from src.models import (
    CopilotAnswerPassage,
    CopilotAnswerRequest,
    RecentCard,
)


def test_labelled_output_in_one_delta_orders_frames() -> None:
    parser = SectionStreamParser()
    text = (
        "SAY: The system uses Polly. Polly is our orchestrator.\n"
        "SPECIFIC: eight permits\n"
        "SPECIFIC: bounded queue\n"
        'NOTES: P1 | "Polly runs it." | adds orchestrator\n'
        "NEXT: How is Polly configured?\n"
    )
    frames = parser.feed(text)
    frames.extend(parser.flush())

    expected = [
        {"t": "The system uses Polly.", "sec": "say", "i": 0},
        {"t": "Polly is our orchestrator.", "sec": "say", "i": 1},
        {"t": "eight permits", "sec": "specific", "i": 0},
        {"t": "bounded queue", "sec": "specific", "i": 1},
        {"t": 'P1 | "Polly runs it." | adds orchestrator', "sec": "notes", "i": 0},
        {"t": "How is Polly configured?", "sec": "next", "i": 0},
    ]
    assert frames == expected


def test_unlabelled_prose_emits_say_sentences_and_flushes_trailing_fragment() -> None:
    parser = SectionStreamParser()
    frames = parser.feed(
        "This is sentence one. This is sentence two. Trailing fragment"
    )
    assert frames == [
        {"t": "This is sentence one.", "sec": "say", "i": 0},
        {"t": "This is sentence two.", "sec": "say", "i": 1},
    ]

    flushed = parser.flush()
    assert flushed == [
        {"t": "Trailing fragment", "sec": "say", "i": 2},
    ]


def test_label_split_across_deltas() -> None:
    parser = SectionStreamParser()
    frames1 = parser.feed("SPE")
    assert frames1 == []

    frames2 = parser.feed("CIFIC: eight permits\n")
    frames2.extend(parser.flush())
    assert frames2 == [
        {"t": "eight permits", "sec": "specific", "i": 0},
    ]


def test_bullet_markers_stripped() -> None:
    parser = SectionStreamParser()
    frames = parser.feed("- SAY: It is a counter.\n")
    frames.extend(parser.flush())
    assert frames == [
        {"t": "It is a counter.", "sec": "say", "i": 0},
    ]

    # Also check leading bullet marker on unlabelled sentence
    parser2 = SectionStreamParser()
    frames2 = parser2.feed("- First sentence. Second sentence.\n")
    frames2.extend(parser2.flush())
    assert frames2 == [
        {"t": "First sentence.", "sec": "say", "i": 0},
        {"t": "Second sentence.", "sec": "say", "i": 1},
    ]


def test_steps_parser_keeps_six_specifics_and_brief_keeps_two() -> None:
    steps_parser = SectionStreamParser(max_specifics=6)
    steps_text = (
        "SPECIFIC: first\n"
        "SPECIFIC: second\n"
        "SPECIFIC: third\n"
        "SPECIFIC: fourth\n"
        "SPECIFIC: fifth\n"
        "SPECIFIC: sixth\n"
        "SPECIFIC: seventh\n"
    )
    steps_frames = steps_parser.feed(steps_text)
    steps_frames.extend(steps_parser.flush())
    steps_specific = [
        f for f in steps_frames if f.get("sec") == "specific" and not f.get("drop")
    ]
    assert [f["i"] for f in steps_specific] == [0, 1, 2, 3, 4, 5]
    assert [f["t"] for f in steps_specific] == [
        "first",
        "second",
        "third",
        "fourth",
        "fifth",
        "sixth",
    ]

    brief_parser = SectionStreamParser(max_specifics=2)
    brief_text = (
        "SPECIFIC: one\n"
        "SPECIFIC: two\n"
        "SPECIFIC: three\n"
    )
    brief_frames = brief_parser.feed(brief_text)
    brief_frames.extend(brief_parser.flush())
    brief_specific = [
        f for f in brief_frames if f.get("sec") == "specific" and not f.get("drop")
    ]
    assert [f["i"] for f in brief_specific] == [0, 1]


def test_steps_fragmented_six_specifics_yield_six_completed_items() -> None:
    parser = SectionStreamParser(max_specifics=6)
    frames: list[dict[str, Any]] = []
    stream = (
        "SPECIFIC: a\n"
        "SPECIFIC: b\n"
        "SPECIFIC: c\n"
        "SPECIFIC: d\n"
        "SPECIFIC: e\n"
        "SPECIFIC: f\n"
    )
    for ch in stream:
        frames.extend(parser.feed(ch))
    frames.extend(parser.flush())

    specific = [
        f for f in frames if f.get("sec") == "specific" and not f.get("drop")
    ]
    assert [f["i"] for f in specific] == [0, 1, 2, 3, 4, 5]
    assert [f["t"] for f in specific] == ["a", "b", "c", "d", "e", "f"]


def test_third_specific_dropped_and_next_i_is_zero() -> None:
    parser = SectionStreamParser()
    text = (
        "SPECIFIC: first specific\n"
        "SPECIFIC: second specific\n"
        "SPECIFIC: third specific\n"
        "NEXT: What about retry policies?\n"
    )
    frames = parser.feed(text)
    frames.extend(parser.flush())

    assert frames == [
        {"t": "first specific", "sec": "specific", "i": 0},
        {"t": "second specific", "sec": "specific", "i": 1},
        {"t": "What about retry policies?", "sec": "next", "i": 0},
    ]


def test_text_seen_tracking() -> None:
    parser = SectionStreamParser()
    assert parser.text_seen == 0

    parser.feed("")
    assert parser.text_seen == 0

    parser.feed("SAY: ")
    assert parser.text_seen == 0

    parser.feed("Hello")
    assert parser.text_seen == 5


def test_build_user_text_structure_and_envelopes() -> None:
    passages = [
        CopilotAnswerPassage(title="Plan", text="Polly runs it.", source="notes.md"),
        CopilotAnswerPassage(title="Architecture", text="ECS task.", source="doc.md"),
    ]
    req = CopilotAnswerRequest(
        provider="local",
        question="How does it work?",
        question_source="Them",
        context_turns=["Turn 1", "Turn 2"],
        passages=passages,
        persona="Tech Lead",
        voice_samples=["Concise style."],
        meeting_header="Sprint retro",
        running_summary="Polly rollout discussion",
    )

    # 1. Passages numbered P1..
    user_text = build_user_text(req, include_passages=True)
    assert "HEADER (about Me, from Me's own documents):" in user_text
    assert "Sprint retro" in user_text
    assert "Instructions: Tech Lead" in user_text
    assert user_text.index("Sprint retro") < user_text.index("Instructions: Tech Lead")
    assert "SUMMARY:\nPolly rollout discussion" in user_text
    assert "TURNS:\nTurn 1\nTurn 2" in user_text
    assert (
        "PASSAGES:\nP1 | Plan | notes.md\nPolly runs it.\n\nP2 | Architecture | doc.md\nECS task."
        in user_text
    )
    assert "VOICE (style only, never facts):\nV1: Concise style." in user_text
    assert "QUESTION (Them):\nHow does it work?" in user_text

    # 2. include_passages=False omits the block
    no_passages_text = build_user_text(req, include_passages=False)
    assert "PASSAGES:" not in no_passages_text

    # 3. Cloud budget drops VOICE first when over the envelope cap
    # Cloud cap is 24,576 bytes. Create an oversized request bypassing validation.
    big_turn = "A" * 700
    oversized_req = CopilotAnswerRequest.model_construct(
        schema_version=7,
        provider="claude",
        question="Valid question" * 10,
        question_source="Them",
        context_turns=[f"Turn {i}: {big_turn}" for i in range(40)],
        passages=[
            CopilotAnswerPassage.model_construct(
                title=f"Doc {i}", text="Passage text " * 50, source="source"
            )
            for i in range(15)
        ],
        persona="Lead",
        voice_samples=["Sample voice style"],
        meeting_header="Header " * 40,
        running_summary="Summary " * 40,
        api_key="sk-test",
    )
    cloud_text = build_user_text(oversized_req, include_passages=True)
    assert len(cloud_text.encode("utf-8")) <= 24576
    assert "VOICE" not in cloud_text

    # 4. Question never trimmed below validated 2000 chars
    long_q = "Q" * 2000
    req_q = CopilotAnswerRequest(provider="local", question=long_q)
    built_q = build_user_text(req_q)
    assert long_q in built_q


def test_copilot_answer_request_validation() -> None:
    # 5 turns accepted for local
    req_local = CopilotAnswerRequest(
        provider="local",
        question="What changed?",
        context_turns=["turn"] * 5,
    )
    assert len(req_local.context_turns) == 5

    # 5 turns rejected for deepseek
    with pytest.raises(
        ValidationError, match="context turns exceed 4 for cloud providers"
    ):
        CopilotAnswerRequest(
            provider="deepseek",
            question="What changed?",
            llm_api_key="sk-deepseek-test",
            llm_base_url="https://api.deepseek.com",
            model="deepseek-v4-pro",
            context_turns=["turn"] * 5,
        )

    # deepseek allows both deepseek-v4-flash and deepseek-v4-pro
    req_flash = CopilotAnswerRequest(
        provider="deepseek",
        question="What changed?",
        llm_api_key="sk-deepseek-test",
        llm_base_url="https://api.deepseek.com",
        model="deepseek-v4-flash",
    )
    assert req_flash.model == "deepseek-v4-flash"
    req_pro = CopilotAnswerRequest(
        provider="deepseek",
        question="What changed?",
        llm_api_key="sk-deepseek-test",
        llm_base_url="https://api.deepseek.com",
        model="deepseek-v4-pro",
    )
    assert req_pro.model == "deepseek-v4-pro"

    # voice_samples of 601 chars rejected
    with pytest.raises(ValidationError, match="voice sample exceeds 600 characters"):
        CopilotAnswerRequest(
            provider="local",
            question="What changed?",
            voice_samples=["v" * 601],
        )

    # schema_version=8 rejected
    with pytest.raises(ValidationError):
        CopilotAnswerRequest(
            provider="local",
            question="What changed?",
            schema_version=8,  # type: ignore[arg-type]
        )

    # Defaults: schema_version == 7, question_source == "Them"
    req_default = CopilotAnswerRequest(
        provider="local",
        question="What changed?",
    )
    assert req_default.schema_version == 7
    assert req_default.question_source == "Them"

    # v5 and v6 payloads still validate
    req_v5 = CopilotAnswerRequest(
        provider="local",
        question="What changed?",
        schema_version=5,
    )
    assert req_v5.schema_version == 5
    req_v6 = CopilotAnswerRequest(
        provider="local",
        question="What changed?",
        schema_version=6,
    )
    assert req_v6.schema_version == 6


def test_system_prompt_contains_slice_1_5_key_phrases() -> None:
    key_phrases = [
        "apply the definition form to each definition question",
        "Relate:",
        "one plausible new question",
        "Never describe what the notes",
        "about the subject of the question",
    ]
    for phrase in key_phrases:
        assert phrase in COPILOT_SYSTEM_PROMPT, f"Missing key phrase: {phrase}"


def test_notes_empty_brackets_produces_drop_frame_and_no_non_empty_text() -> None:
    parser = SectionStreamParser()
    frames = parser.feed("NOTES: []\n")
    frames.extend(parser.flush())
    assert frames == [{"t": "", "sec": "notes", "i": 0, "drop": True}]
    assert not any(f["t"] != "" for f in frames if f.get("sec") == "notes")


def test_specific_none_produces_drop_frame_and_no_non_empty_text() -> None:
    parser = SectionStreamParser()
    frames = parser.feed("SPECIFIC: none\n")
    frames.extend(parser.flush())
    assert frames == [{"t": "", "sec": "specific", "i": 0, "drop": True}]
    assert not any(f["t"] != "" for f in frames if f.get("sec") == "specific")


def test_real_notes_line_still_streams() -> None:
    parser = SectionStreamParser()
    f1 = parser.feed("NOTES: P1 | ")
    f2 = parser.feed('"Polly runs it."')
    f3 = parser.feed(" | adds orchestrator\n")
    f_all = f1 + f2 + f3 + parser.flush()
    assert f_all == [
        {"t": "P1 | ", "sec": "notes", "i": 0},
        {"t": '"Polly runs it."', "sec": "notes", "i": 0},
        {"t": " | adds orchestrator", "sec": "notes", "i": 0},
    ]


def test_say_sentences_only_brackets_or_none_dropped_outright() -> None:
    parser = SectionStreamParser()
    frames = parser.feed("SAY: []\nSAY: none\nSAY: The system uses Polly.\n")
    frames.extend(parser.flush())
    assert frames == [
        {"t": "The system uses Polly.", "sec": "say", "i": 0},
    ]


def test_system_prompt_contains_slice_1_6_appended_paragraphs_and_order() -> None:
    assert "Never answer as an AI assistant" in COPILOT_SYSTEM_PROMPT
    assert "machine-transcribed speech" in COPILOT_SYSTEM_PROMPT

    idx_say = COPILOT_SYSTEM_PROMPT.index("SAY is what Me will say aloud")
    idx_no_ai = COPILOT_SYSTEM_PROMPT.index("Never answer as an AI assistant")
    idx_relate = COPILOT_SYSTEM_PROMPT.index("Relate:")

    assert idx_say < idx_no_ai < idx_relate


def test_prompt_contains_shapes_and_removes_old_rules() -> None:
    assert "Write one to three complete, standalone sentences" in COPILOT_SYSTEM_PROMPT
    assert "Directly answer every question in the order asked" in COPILOT_SYSTEM_PROMPT
    assert "Write two to five SPECIFIC lines" in COPILOT_SYSTEM_PROMPT
    assert "Write exactly one complete, standalone sentence" not in COPILOT_SYSTEM_PROMPT
    assert "no markdown and no second sentence" not in COPILOT_SYSTEM_PROMPT
    assert "Write two or three SPECIFIC lines" not in COPILOT_SYSTEM_PROMPT
    assert "three to five SAY sentences" not in COPILOT_SYSTEM_PROMPT
    assert "60 to 90 words" not in COPILOT_SYSTEM_PROMPT
    assert "first person throughout" not in COPILOT_SYSTEM_PROMPT
    assert "Never open with a definition frame" not in COPILOT_SYSTEM_PROMPT
    assert "at most 45 words" not in COPILOT_SYSTEM_PROMPT
    assert "Definitions do not require first person" not in COPILOT_SYSTEM_PROMPT
    assert (
        "First-person framing must not imply unsupported personal experience."
        in COPILOT_SYSTEM_PROMPT
    )
    assert (
        "a supplied passage or reliably attributed turn directly supports it"
        in COPILOT_SYSTEM_PROMPT
    )
    assert (
        "RECENT CARDS contains generated suggestions, not testimony or evidence."
        in COPILOT_SYSTEM_PROMPT
    )


def test_prompt_brief_shape_rules() -> None:
    assert "Write one to three complete, standalone sentences" in COPILOT_SYSTEM_PROMPT
    assert "Directly answer every question in the order asked" in COPILOT_SYSTEM_PROMPT
    assert "Write two to five SPECIFIC lines" in COPILOT_SYSTEM_PROMPT
    assert "SAY is what Me will say aloud" in COPILOT_SYSTEM_PROMPT

    assert "three to five SAY sentences" not in COPILOT_SYSTEM_PROMPT
    assert "60 to 90 words" not in COPILOT_SYSTEM_PROMPT
    assert "first person throughout" not in COPILOT_SYSTEM_PROMPT
    assert "Never open with a definition frame" not in COPILOT_SYSTEM_PROMPT


def test_pack_prefix_and_drop_order() -> None:
    pack = "Project Alpha: A high-performance inference gateway.\n\nProject Beta: Speech-to-text pipeline."
    req1 = CopilotAnswerRequest(
        provider="local", question="What is Alpha?", standing_pack=pack
    )
    req2 = CopilotAnswerRequest(
        provider="local", question="How does Beta scale?", standing_pack=pack
    )
    t1 = build_user_text(req1)
    t2 = build_user_text(req2)
    expected_prefix = (
        "PACK (about Me's projects, orientation only; personal claims still need a passage):\n"
        + pack
    )
    assert t1.startswith(expected_prefix)
    assert t2.startswith(expected_prefix)

    # RECENT CARDS is cut oldest-first when overflowing block cap
    c1 = RecentCard(card_ref="s:1", question="Q1", say="Say 1" * 200)
    c2 = RecentCard(card_ref="s:2", question="Q2", say="Say 2" * 200)
    req_cards = CopilotAnswerRequest(
        provider="claude",
        question="What about cards?",
        recent_cards=[c1, c2],
        api_key="sk-test",
    )
    rendered = build_user_text(req_cards)
    assert "s:1" not in rendered
    assert "s:2" in rendered

    # Drop order over envelope: VOICE goes first, and PACK goes before any passage
    turn_body = "Sentence describing system architecture and design choices. " * 15
    passage = CopilotAnswerPassage(title="PTitle", text="PText " * 20, source="PSrc")
    req_drop = CopilotAnswerRequest.model_construct(
        schema_version=7,
        provider="claude",
        question="Final Q",
        question_source="Them",
        standing_pack="Standing pack content " * 100,
        voice_samples=["Voice style " * 20],
        recent_cards=[RecentCard(card_ref="s:1", question="Old Q", say="Old say")],
        running_summary="Summary " * 400,
        meeting_header="Header " * 400,
        context_turns=[f"Turn {i}: {turn_body}" for i in range(35)],
        passages=[passage],
        api_key="sk-test",
    )
    text_drop = build_user_text(req_drop, include_passages=True)
    assert len(text_drop.encode("utf-8")) <= 24576
    assert "VOICE" not in text_drop
    assert "PACK" not in text_drop
    assert "PASSAGES:" in text_drop


def test_recent_cards_never_evidence() -> None:
    c = RecentCard(
        card_ref="sess-1:42",
        question="What is subject hash?",
        say="Subject hash is a blake3 digest.",
        origin="generated_suggestion",
        evidence_refs=["file:src/hash.rs"],
    )
    req = CopilotAnswerRequest(
        provider="local",
        question="Followup question",
        recent_cards=[c],
    )
    user_text = build_user_text(req)
    assert (
        "RECENT CARDS (oldest first; the last card is the most recent answer; suggestions shown to Me earlier, not words Me said, never evidence):"
        in user_text
    )
    assert '"card_ref":"sess-1:42"' in user_text
    assert '"origin":"generated_suggestion"' in user_text
    assert (
        "RECENT CARDS contains generated suggestions, not testimony or evidence."
        in COPILOT_SYSTEM_PROMPT
    )


def test_shape_fixtures_chunked() -> None:
    fixtures = [
        (
            # Definition: 1 SAY, 1 SPECIFIC, 0 NOTES, 0 NEXT
            (
                "SAY: An idempotent operation produces the same result no matter how many times it runs.\n"
                "SPECIFIC: In HTTP, GET and PUT are idempotent methods whereas POST is not.\n"
            ),
            1,
            1,
            False,
        ),
        (
            # How or why: 4 SAY, 1 SPECIFIC, 0 NOTES, 0 NEXT
            (
                "SAY: We handle failovers by promoting the hot standby replica immediately. "
                "The coordinator health-checks the primary every five hundred milliseconds through heartbeat pings. "
                "When three consecutive pings fail, it acquires a distributed lock and executes the promotion. "
                "The main tradeoff is brief write unavailability during the leadership election window.\n"
                "SPECIFIC: Heartbeat timeouts use an exponential backoff with jitter to prevent split-brain flaps.\n"
            ),
            4,
            1,
            False,
        ),
        (
            # Experience: 4 SAY, 1 SPECIFIC, 1 NOTES with P1, 0 NEXT
            (
                "SAY: At Acme, we needed to reduce our p99 query latency on the events table. "
                "I partitioned the PostgreSQL tables by timestamp and added partial indexes on active tenants. "
                "I also introduced an in-memory cache for recent token lookups. "
                "This brought our tail latency down from eight hundred milliseconds to forty.\n"
                "SPECIFIC: Partition pruning skipped ninety percent of scanned heap pages during query planning.\n"
                'NOTES: P1 | "tail latency down to forty milliseconds" | confirms measured result\n'
            ),
            4,
            1,
            True,
        ),
        (
            # Design: 4 SAY, 2 SPECIFIC, 0 NOTES, 0 NEXT
            (
                "SAY: What are our target write throughput numbers and latency bounds? "
                "Do we require strict linearizable consistency or will causal consistency suffice? "
                "The architecture uses an append-only event log with partitioned consumer groups. "
                "The tradeoff is eventual consistency on downstream read views in exchange for high ingestion availability.\n"
                "SPECIFIC: Partitions are replicated across three availability zones using Raft consensus.\n"
                "SPECIFIC: Read replicas serve queries with a bounded lag watermark of one second.\n"
            ),
            4,
            2,
            False,
        ),
    ]

    for text, exp_say_count, exp_specific_count, has_notes in fixtures:
        parser = SectionStreamParser()
        frames: list[dict[str, Any]] = []
        for ch in text:
            frames.extend(parser.feed(ch))
        frames.extend(parser.flush())

        say_frames = [f for f in frames if f.get("sec") == "say"]
        assert len(say_frames) == exp_say_count, (
            f"Expected {exp_say_count} SAY frames, got {len(say_frames)}"
        )
        assert [f["i"] for f in say_frames] == list(range(exp_say_count))

        specific_indices = {
            f["i"] for f in frames if f.get("sec") == "specific" and not f.get("drop")
        }
        assert len(specific_indices) == exp_specific_count, (
            f"Expected {exp_specific_count} SPECIFIC items, got {len(specific_indices)}"
        )

        notes_frames = [
            f for f in frames if f.get("sec") == "notes" and not f.get("drop")
        ]
        if has_notes:
            assert len(notes_frames) > 0
            full_notes_text = "".join(f["t"] for f in notes_frames)
            assert "P1" in full_notes_text
        else:
            assert len(notes_frames) == 0

        next_frames = [
            f for f in frames if f.get("sec") == "next" and not f.get("drop")
        ]
        assert len(next_frames) == 0
