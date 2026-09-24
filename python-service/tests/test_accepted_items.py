"""Accepted live items survive prompt construction, HTTP routing, and rendering."""

from __future__ import annotations

import json
from copy import deepcopy
from difflib import SequenceMatcher
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

import src.summarizer as summarizer_module
from src.models import AcceptedLiveItem, SummarizeRequest


PROMPTS_DIR = Path(__file__).parent.parent / "prompts"
PREAMBLE = (
    "Items inside <accepted_live_items> were confirmed by the user during the meeting."
)
ACTION_LINE = "Me: Prepare the demo — due 2026-09-19"


@pytest.fixture
def accepted_items() -> list[AcceptedLiveItem]:
    return [
        AcceptedLiveItem(
            id="decision-1", kind="decision", text="Use the staged rollout"
        ),
        AcceptedLiveItem(
            id="action-1",
            kind="action",
            text="Prepare the demo",
            owner="Me",
            due="2026-09-19",
            evidence_turn_ids=["turn-2", "turn-3"],
            revision=2,
        ),
        AcceptedLiveItem(
            id="question-1", kind="question", text="Who will approve the launch?"
        ),
    ]


@pytest.fixture
def summarizer(monkeypatch) -> summarizer_module.OllamaSummarizer:
    # Patch the client per test; do not replace shared modules during collection.
    monkeypatch.setattr(summarizer_module, "Client", MagicMock())
    instance = summarizer_module.OllamaSummarizer(backend="ollama")
    monkeypatch.setattr(
        instance,
        "_chat",
        MagicMock(
            return_value=json.dumps(
                {
                    "title": "Launch planning",
                    "category": "meeting",
                    "attendees": [],
                    "sections": [
                        {"heading": "Overview", "bullets": ["Discussed launch plans"]},
                        {"heading": "Action Items", "bullets": ["None mentioned"]},
                        {"heading": "Follow-ups", "bullets": ["Check launch readiness"]},
                    ],
                }
            )
        ),
    )
    monkeypatch.setattr(
        instance,
        "_load_template",
        lambda name: (PROMPTS_DIR / f"{name}.md").read_text(encoding="utf-8"),
    )
    return instance


def test_reconciliation_appends_to_existing_sections(summarizer, accepted_items):
    data = {
        "sections": [
            {"heading": "Decisions", "bullets": ["Keep the current budget"]},
            {"heading": "Action Items", "bullets": ["Sam: Book the room"]},
            {"heading": "Follow-ups", "bullets": ["Confirm the venue"]},
        ]
    }

    summarizer._ensure_accepted_items_section(data, accepted_items)

    assert data["sections"] == [
        {
            "heading": "Decisions",
            "bullets": ["Keep the current budget", "Use the staged rollout"],
        },
        {"heading": "Action Items", "bullets": ["Sam: Book the room", ACTION_LINE]},
        {
            "heading": "Follow-ups",
            "bullets": ["Confirm the venue", "Open question: Who will approve the launch?"],
        },
    ]


def test_missing_sections_are_inserted_before_followups(summarizer, accepted_items):
    data = {"sections": [{"heading": "Follow-ups", "bullets": ["Confirm the venue"]}]}

    # Ordering must also work when an action is accepted before a decision.
    summarizer._ensure_accepted_items_section(data, list(reversed(accepted_items)))

    assert [section["heading"] for section in data["sections"]] == [
        "Decisions", "Action Items", "Follow-ups"
    ]
    assert data["sections"][0]["bullets"] == ["Use the staged rollout"]
    assert data["sections"][1]["bullets"] == [ACTION_LINE]


def test_similar_wording_is_not_duplicated(summarizer):
    existing = "Use a staged rollout for the launch"
    confirmed = "Use the staged rollout for launch"
    # Exercise fuzzy matching rather than equality or substring containment.
    assert existing.lower() not in confirmed.lower()
    assert confirmed.lower() not in existing.lower()
    assert SequenceMatcher(None, existing.lower(), confirmed.lower()).ratio() >= 0.8
    data = {"sections": [{"heading": "Decisions", "bullets": [existing]}]}

    summarizer._ensure_accepted_items_section(
        data, [AcceptedLiveItem(id="decision-1", kind="decision", text=confirmed)]
    )

    assert data["sections"][0]["bullets"] == [existing]


@pytest.mark.parametrize("placeholder", ["None mentioned", "None"])
def test_placeholder_is_replaced(summarizer, accepted_items, placeholder):
    data = {"sections": [{"heading": "Action Items", "bullets": [placeholder]}]}

    summarizer._ensure_accepted_items_section(data, [accepted_items[1]])

    assert data["sections"][0]["bullets"] == [ACTION_LINE]


def test_free_text_due_date_is_parenthesized(summarizer, accepted_items):
    action = accepted_items[1].model_copy(update={"due": "Friday"})
    data = {"sections": []}

    summarizer._ensure_accepted_items_section(data, [action])

    assert data["sections"] == [
        {"heading": "Action Items", "bullets": ["Me: Prepare the demo (due Friday)"]}
    ]


def test_reconciliation_is_idempotent(summarizer, accepted_items):
    data = {"sections": []}
    summarizer._ensure_accepted_items_section(data, accepted_items)
    reconciled = deepcopy(data)

    summarizer._ensure_accepted_items_section(data, accepted_items)

    assert data == reconciled
    assert len(data["sections"]) == 3
    assert all(len(section["bullets"]) == 1 for section in data["sections"])


def test_prompt_includes_accepted_items_and_preamble(summarizer, accepted_items):
    summarizer.summarize(
        "Them: We discussed launch plans.", accepted_live_items=accepted_items
    )

    summarizer._chat.assert_called_once()
    messages = summarizer._chat.call_args.kwargs["messages"]
    assert PREAMBLE in messages[0]["content"]
    assert (
        "<accepted_live_items>\n"
        "decision | - | - | Use the staged rollout\n"
        "action | Me | 2026-09-19 | Prepare the demo\n"
        "question | - | - | Who will approve the launch?\n"
        "</accepted_live_items>"
    ) in messages[1]["content"]


@pytest.mark.parametrize("items", [None, []])
def test_prompt_omits_accepted_block_and_preamble_when_absent(summarizer, items):
    kwargs = {} if items is None else {"accepted_live_items": items}
    result = summarizer.summarize("Them: We discussed launch plans.", **kwargs)

    messages = summarizer._chat.call_args.kwargs["messages"]
    # The static template references the tag; only the dynamic preamble and
    # actual user-message block depend on accepted items being present.
    assert PREAMBLE not in messages[0]["content"]
    assert "<accepted_live_items>" not in messages[1]["content"]
    assert "</accepted_live_items>" not in messages[1]["content"]
    assert "Prepare the demo" not in result.summary


def test_request_defaults_to_an_independent_empty_list(accepted_items):
    first = SummarizeRequest(transcript="Hello.")
    second = SummarizeRequest(transcript="Hello again.")
    assert first.accepted_live_items == []
    assert second.accepted_live_items == []

    first.accepted_live_items.append(accepted_items[1])

    assert second.accepted_live_items == []


def test_request_validates_a_full_accepted_item():
    payload = {
        "id": "action-1",
        "kind": "action",
        "text": "Prepare the demo",
        "owner": "Me",
        "due": "2026-09-19",
        "evidence_turn_ids": ["turn-2", "turn-3"],
        "revision": 2,
    }

    request = SummarizeRequest.model_validate(
        {"transcript": "Hello.", "accepted_live_items": [payload]}
    )

    assert len(request.accepted_live_items) == 1
    assert isinstance(request.accepted_live_items[0], AcceptedLiveItem)
    assert request.accepted_live_items[0].model_dump() == payload


def test_general_prompt_has_accepted_items_exception():
    prompt = (PROMPTS_DIR / "general.md").read_text(encoding="utf-8")

    assert "Exception: items inside <accepted_live_items>" in prompt


def test_route_forwards_accepted_action_and_renders_it(
    monkeypatch, summarizer, accepted_items
):
    from src import server

    action = accepted_items[1]
    summarize_spy = MagicMock(wraps=summarizer.summarize)
    monkeypatch.setattr(summarizer, "summarize", summarize_spy)
    monkeypatch.setattr(server, "_summarizer", summarizer)

    # No lifespan context: inject the mocked service without loading ML models.
    response = TestClient(server.app).post(
        "/summarize",
        json={
            "transcript": "Them: We discussed launch plans.",
            "accepted_live_items": [action.model_dump()],
        },
    )

    assert response.status_code == 200, response.text
    summarize_spy.assert_called_once()
    forwarded = summarize_spy.call_args.kwargs["accepted_live_items"]
    assert forwarded == [action]
    assert isinstance(forwarded[0], AcceptedLiveItem)
    summarizer._chat.assert_called_once()
    markdown = response.json()["summary"]
    assert f"**Action Items**\n\n- {ACTION_LINE}" in markdown
    assert markdown.count(ACTION_LINE) == 1
    assert "None mentioned" not in markdown
