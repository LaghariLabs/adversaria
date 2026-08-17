"""Tests for summary output-language directives."""

from __future__ import annotations

import pytest

from src.summarizer import _language_directive


NEW_LANGUAGES = {
    "zh": ("chinese", "Simplified Chinese"),
    "hi": ("hindi", "Hindi, in Devanagari script"),
    "es": ("spanish", "Spanish"),
    "fr": ("french", "French"),
    "bn": ("bengali", "Bengali, in Bengali script"),
    "pt": ("portuguese", "Portuguese"),
    "ru": ("russian", "Russian, in Cyrillic script"),
    "ur": ("urdu", "Urdu, in Arabic script"),
}


@pytest.mark.parametrize(
    ("code", "_alias", "language_name"),
    [(code, alias, name) for code, (alias, name) in NEW_LANGUAGES.items()],
)
def test_new_language_directive_names_language(
    code: str, _alias: str, language_name: str
) -> None:
    directive = _language_directive(code)

    assert directive is not None
    assert language_name in directive
    assert "ENTIRE output" in directive


@pytest.mark.parametrize(
    ("code", "alias", "_language_name"),
    [(code, alias, name) for code, (alias, name) in NEW_LANGUAGES.items()],
)
def test_new_language_full_name_alias(code: str, alias: str, _language_name: str) -> None:
    assert _language_directive(alias) == _language_directive(code)


def test_existing_language_directives_are_unchanged() -> None:
    arabic = (
        "OUTPUT LANGUAGE: Write the ENTIRE output — the title, every section "
        "heading, and every bullet — in Arabic (Modern Standard Arabic), in "
        "Arabic script. Keep product names, acronyms, and technical terms in "
        "their original form when there is no common Arabic equivalent."
    )
    match_spoken = (
        "OUTPUT LANGUAGE: Write the entire output in the same language the "
        "meeting was primarily conducted in (infer it from the transcript)."
    )

    assert _language_directive("en") == (
        "OUTPUT LANGUAGE: Write the entire output in English."
    )
    assert _language_directive("ar") == arabic
    assert _language_directive("auto") == match_spoken
    assert _language_directive("match") == match_spoken
    assert _language_directive(None) is None
    assert _language_directive("xx") is None
