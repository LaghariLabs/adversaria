"""Service configuration and prompt template loading."""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path


def _resolve_prompts_dir() -> Path:
    """Where editable prompt templates live.

    Dev: the repo's ``prompts/`` folder (current behavior). Packaged
    (PyInstaller-frozen): a writable per-user dir — the ``.app`` bundle is
    read-only, so the user-editable templates feature must write elsewhere. The
    dir is seeded once from the bundled defaults so the templates still appear.
    """
    if getattr(sys, "frozen", False):
        base = Path(
            os.environ.get("ADVERSARIA_DATA_DIR")
            or (Path.home() / "Library" / "Application Support" / "meeting-note-taker")
        )
        target = base / "prompts"
        target.mkdir(parents=True, exist_ok=True)
        bundled = Path(getattr(sys, "_MEIPASS", "")) / "prompts"
        if bundled.is_dir():
            for default in bundled.glob("*.md"):
                dest = target / default.name
                if not dest.exists():
                    dest.write_text(default.read_text(encoding="utf-8"), encoding="utf-8")
        return target
    return Path(__file__).parent.parent / "prompts"


PROMPTS_DIR = _resolve_prompts_dir()

_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,48}$")


def _safe_name(name: str) -> str:
    """Validate a template name to a safe slug (prevents path traversal)."""
    if not _NAME_RE.match(name):
        raise ValueError(
            "Template name must be lowercase letters, digits, or hyphens."
        )
    return name


def load_prompt(template: str) -> str:
    """Load a prompt template by name (without .md extension).

    Args:
        template: Template name (e.g. 'general', 'one-on-one', 'client-meeting').

    Returns:
        The raw prompt template text.

    Raises:
        FileNotFoundError: If the template file does not exist.
    """
    prompt_path = PROMPTS_DIR / f"{template}.md"
    if not prompt_path.exists():
        raise FileNotFoundError(f"Prompt template not found: {template}")
    return prompt_path.read_text(encoding="utf-8")


def list_template_files() -> list[str]:
    """List available prompt template names (without .md extension).

    Returns:
        Sorted list of template names.
    """
    return sorted(p.stem for p in PROMPTS_DIR.glob("*.md"))


def save_prompt(name: str, content: str) -> None:
    """Create or overwrite a prompt template file."""
    safe = _safe_name(name)
    PROMPTS_DIR.mkdir(parents=True, exist_ok=True)
    (PROMPTS_DIR / f"{safe}.md").write_text(content, encoding="utf-8")


def delete_prompt(name: str) -> None:
    """Delete a prompt template file."""
    safe = _safe_name(name)
    path = PROMPTS_DIR / f"{safe}.md"
    if not path.exists():
        raise FileNotFoundError(f"Prompt template not found: {name}")
    path.unlink()
