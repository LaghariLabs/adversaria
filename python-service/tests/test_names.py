"""Tests for the names module (attendee dedup + roster grounding)."""

from __future__ import annotations

from src.names import dedupe_attendees, ground_to_roster


class TestDedupeAttendees:
    """Deterministic attendee deduplication."""

    # -- exact duplicates -------------------------------------------------

    def test_exact_dup_merge_keeps_first(self) -> None:
        assert dedupe_attendees(["Hamza", "Hamza"]) == ["Hamza"]

    def test_exact_dup_different_case_keeps_first_display(self) -> None:
        assert dedupe_attendees(["Hamza", "hamza"]) == ["Hamza"]

    def test_exact_dup_with_whitespace(self) -> None:
        assert dedupe_attendees(["  Hamza  ", "Hamza"]) == ["Hamza"]

    def test_exact_dup_strips_surrounding_punctuation(self) -> None:
        # trailing punctuation should not create a "different" name
        assert dedupe_attendees(["(Hamza)", "Hamza"]) == ["Hamza"]

    # -- subset merge -----------------------------------------------------

    def test_subset_merge_shorter_first(self) -> None:
        """Hamza appears, then Hamza Laghari → keep the longer form."""
        assert dedupe_attendees(["Hamza", "Hamza Laghari"]) == ["Hamza Laghari"]

    def test_subset_merge_longer_first(self) -> None:
        """Hamza Laghari appears, then just Hamza → keep the longer form."""
        assert dedupe_attendees(["Hamza Laghari", "Hamza"]) == ["Hamza Laghari"]

    def test_subset_merge_middle_name(self) -> None:
        assert dedupe_attendees(["Sarah", "Sarah Jane Smith"]) == ["Sarah Jane Smith"]

    # -- no false merge ---------------------------------------------------

    def test_no_merge_different_names(self) -> None:
        """Sara and Sarah are different people — no merge."""
        assert dedupe_attendees(["Sara", "Sarah"]) == ["Sara", "Sarah"]

    def test_no_merge_jon_john(self) -> None:
        """Jon and John are different people — no merge."""
        assert dedupe_attendees(["Jon", "John"]) == ["Jon", "John"]

    def test_no_merge_non_subset(self) -> None:
        """Hamza Khan and Hamza Laghari should NOT merge — neither is a subset."""
        assert dedupe_attendees(["Hamza Khan", "Hamza Laghari"]) == [
            "Hamza Khan",
            "Hamza Laghari",
        ]

    # -- Me/Them preservation ---------------------------------------------

    def test_me_preserved(self) -> None:
        assert dedupe_attendees(["Me"]) == ["Me"]

    def test_them_preserved(self) -> None:
        assert dedupe_attendees(["Them"]) == ["Them"]

    def test_me_not_merged_into_named_person(self) -> None:
        """Me should never be merged into a named person, even if tokens overlap."""
        # 'Me' is special, not a subset of any named person
        assert dedupe_attendees(["Me", "Hamza"]) == ["Me", "Hamza"]

    def test_them_not_merged_into_named_person(self) -> None:
        assert dedupe_attendees(["Them", "Sarah"]) == ["Them", "Sarah"]

    def test_me_exact_dup_merged(self) -> None:
        """Duplicate Me/Them should still be merged."""
        assert dedupe_attendees(["Me", "Me"]) == ["Me"]

    def test_me_casefold_dup(self) -> None:
        assert dedupe_attendees(["Me", "me"]) == ["Me"]

    # -- ordering stable --------------------------------------------------

    def test_ordering_stable(self) -> None:
        result = dedupe_attendees(["Me", "Hamza", "Sarah", "Hamza Laghari"])
        assert result == ["Me", "Hamza Laghari", "Sarah"]

    # -- edge cases -------------------------------------------------------

    def test_empty_list(self) -> None:
        assert dedupe_attendees([]) == []

    def test_single_name(self) -> None:
        assert dedupe_attendees(["Hamza"]) == ["Hamza"]

    def test_blank_names_filtered(self) -> None:
        assert dedupe_attendees(["Hamza", "   ", "Sarah"]) == ["Hamza", "Sarah"]

    def test_initial_abbreviation_not_merged(self) -> None:
        """Hamza L and Hamza Laghari have different tokens — no subset merge."""
        assert dedupe_attendees(["Hamza L", "Hamza Laghari"]) == [
            "Hamza L", "Hamza Laghari"
        ]
        # But Hamza (subset of Hamza L) still merges into the longer form:
        assert dedupe_attendees(["Hamza", "Hamza L"]) == ["Hamza L"]


class TestGroundToRoster:
    """Roster grounding maps extracted names to canonical spellings."""

    # -- no roster is a no-op ---------------------------------------------

    def test_none_roster_noop(self) -> None:
        assert ground_to_roster(["hamza"], []) == ["hamza"]

    # -- single exact match -----------------------------------------------

    def test_exact_containment(self) -> None:
        result = ground_to_roster(["hamza l"], ["Hamza Laghari"])
        assert result == ["Hamza Laghari"]

    def test_reverse_containment(self) -> None:
        """Extracted name contains a known attendee name."""
        result = ground_to_roster(["Hamza Laghari"], ["Hamza"])
        assert result == ["Hamza"]

    def test_case_insensitive(self) -> None:
        result = ground_to_roster(["hamza laghari"], ["Hamza Laghari"])
        assert result == ["Hamza Laghari"]

    # -- ambiguous match leaves as-is -------------------------------------

    def test_multiple_matches_left_as_is(self) -> None:
        result = ground_to_roster(["Hamza"], ["Hamza Laghari", "Hamza Khan"])
        assert result == ["Hamza"]

    def test_no_match_left_as_is(self) -> None:
        result = ground_to_roster(["Jane"], ["Hamza Laghari"])
        assert result == ["Jane"]

    # -- multiple names ---------------------------------------------------

    def test_mixed_matches(self) -> None:
        result = ground_to_roster(
            ["hamza l", "jane", "me"],
            ["Hamza Laghari", "Jane Smith"],
        )
        assert result == ["Hamza Laghari", "Jane Smith", "me"]


def test_relabel_me_survives_backslash_in_name():
    # A pasted "Domain\User"-style name used to raise re.error (bad escape)
    # because it was passed as an re.sub REPLACEMENT string, 500ing the
    # whole transcription.
    from src.transcriber import relabel_me

    text = "Me: hello there\nThem: hi"
    assert relabel_me(text, "CORP\\hamza") == "CORP\\hamza: hello there\nThem: hi"


def test_relabel_turns_survives_backslash_in_name():
    # Turn relabeling must handle backslashes without error (same scenario
    # as relabel_me but for structured turn objects).
    from src.transcriber import relabel_turns
    from src.models import TranscriptTurn

    turns = [TranscriptTurn(speaker="Me", text="hello there", start=0.0, end=2.0)]
    result = relabel_turns(turns, "CORP\\hamza")
    assert result[0].speaker == "CORP\\hamza"
