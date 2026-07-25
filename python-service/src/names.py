"""Attendee name normalization and deduplication.

Pure helpers with no ML dependencies — the only imports are from the stdlib.
"""

from __future__ import annotations

import string


def _normalise(name: str) -> str:
    """Normalise a name for comparison: strip, collapse whitespace,
    strip surrounding punctuation, casefold."""
    cleaned = " ".join(name.strip().split())
    # Strip punctuation from start and end (but not internal, e.g. hyphens)
    cleaned = cleaned.strip(string.punctuation + " ")
    return cleaned.casefold()


def dedupe_attendees(names: list[str]) -> list[str]:
    """Deduplicate attendees conservatively.

    Rules:
    - Merge exact normalised duplicates (keep first-seen display form).
    - Merge when one name's tokens are a strict subset of another's
      (keep the longer, more-complete form).
    - Never merge on edit-distance/fuzzy similarity.
    - Never merge "Me"/"Them" into named people.
    - Preserve ordering (first-seen position).

    >>> dedupe_attendees(["Hamza", "Hamza"])
    ['Hamza']
    >>> dedupe_attendees(["Hamza", "Hamza Laghari"])
    ['Hamza Laghari']
    >>> dedupe_attendees(["Hamza Laghari", "Hamza"])
    ['Hamza Laghari']
    >>> dedupe_attendees(["Sara", "Sarah"])
    ['Sara', 'Sarah']
    >>> dedupe_attendees(["Me", "Me"])
    ['Me']
    """
    kept: list[tuple[str, str, set[str]]] = []  # (display, norm, tokens)

    for name in names:
        if not name.strip():
            continue

        norm = _normalise(name)
        tokens = set(norm.split())
        is_special = norm in ("me", "them")
        # Derive a clean display form (strip surrounding punctuation).
        display = " ".join(name.strip().split()).strip(string.punctuation + " ")

        replaced_existing = False
        skip = False

        for i, (k_display, k_norm, k_tokens) in enumerate(kept):
            # Exact duplicate
            if norm == k_norm:
                skip = True
                break

            k_is_special = k_norm in ("me", "them")
            # Never merge Me/Them with named people
            if is_special != k_is_special:
                continue

            if tokens < k_tokens:
                # Current name's tokens are a strict subset of an existing one
                skip = True
                break
            elif k_tokens < tokens:
                # Existing name's tokens are a strict subset of current one
                kept[i] = (display, norm, tokens)
                replaced_existing = True
                break

        if not skip and not replaced_existing:
            kept.append((display, norm, tokens))

    return [display for display, _, _ in kept]


def ground_to_roster(
    attendees: list[str], known_attendees: list[str]
) -> list[str]:
    """Map extracted names to canonical roster spellings.

    Each extracted name that maps to exactly one known attendee
    (case-insensitive containment) is replaced with that attendee's
    canonical spelling. Ambiguous matches (multiple roster entries)
    are left as-is. Empty roster is a no-op.

    >>> ground_to_roster(["hamza l"], ["Hamza Laghari"])
    ['Hamza Laghari']
    >>> ground_to_roster(["Hamza"], ["Hamza Laghari", "Hamza Khan"])
    ['Hamza']
    """
    if not known_attendees:
        return list(attendees)

    known_cleaned: list[str] = []
    known_lower: list[str] = []
    for k in known_attendees:
        kc = k.strip()
        known_cleaned.append(kc)
        known_lower.append(kc.casefold())

    result: list[str] = []
    for name in attendees:
        name_lower = name.strip().casefold()
        matches = [
            known_cleaned[i]
            for i, k_lower in enumerate(known_lower)
            if name_lower in k_lower or k_lower in name_lower
        ]
        if len(matches) == 1:
            result.append(matches[0])
        else:
            result.append(name.strip())
    return result
