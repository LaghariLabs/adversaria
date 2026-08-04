"""Service configuration and prompt template loading."""

from __future__ import annotations

import json
import logging
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

#: Records which templates the USER owns — ones they edited or deleted in the
#: app. Seeding never touches these. Everything else is ours to keep current.
_OWNERSHIP_FILE = "_user_templates.json"


def _load_user_owned(prompts_dir: Path) -> set[str]:
    """Template names the user has edited or deleted (empty set if unknown)."""
    try:
        data = json.loads((prompts_dir / _OWNERSHIP_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return set()
    owned = data.get("user_owned") if isinstance(data, dict) else None
    return {str(n) for n in owned} if isinstance(owned, list) else set()


def _mark_user_owned(prompts_dir: Path, name: str) -> None:
    """Claim a template for the user, so seeding leaves it alone forever."""
    owned = _load_user_owned(prompts_dir) | {name}
    try:
        (prompts_dir / _OWNERSHIP_FILE).write_text(
            json.dumps({"user_owned": sorted(owned)}, indent=2), encoding="utf-8"
        )
    except OSError as exc:  # a read-only dir must not break saving a template
        logger.warning("Could not record template ownership for %s: %s", name, exc)


def _seed_bundled_prompts(target: Path, bundled: Path) -> None:
    """Bring the user's prompt dir up to date with the bundled defaults.

    The old rule was "copy only if missing", which froze every template that
    existed at first launch: a packaged install shipped 2026-06-20 was still
    running that day's ``general.md`` six weeks and many prompt fixes later,
    while templates ADDED after install arrived normally. Prompt improvements
    therefore only ever showed up in dev, which reads the repo folder directly.

    The rule now: a template the user has claimed (edited or deleted in the app)
    is never touched; anything else is kept current. Because installs predating
    the ownership file have no record, a template whose content differs from the
    bundled default is BACKED UP beside itself before being updated — so a
    hand-edit made before this existed is recoverable rather than lost.
    """
    owned = _load_user_owned(target)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    for default in sorted(bundled.glob("*.md")):
        name = default.stem
        if name in owned:
            continue
        dest = target / default.name
        current = default.read_text(encoding="utf-8")
        if dest.exists():
            existing = dest.read_text(encoding="utf-8")
            if existing == current:
                continue
            backup = target / f"{name}.bak-{stamp}.md"
            try:
                backup.write_text(existing, encoding="utf-8")
            except OSError as exc:
                logger.warning("Could not back up %s (%s) — leaving it alone.", name, exc)
                continue
            logger.info("Updating bundled template %s (previous copy → %s).", name, backup.name)
        dest.write_text(current, encoding="utf-8")


def _resolve_prompts_dir() -> Path:
    """Where editable prompt templates live.

    Dev: the repo's ``prompts/`` folder (current behavior). Packaged
    (PyInstaller-frozen): a writable per-user dir — the ``.app`` bundle is
    read-only, so the user-editable templates feature must write elsewhere,
    and the bundled defaults are seeded/refreshed there by
    ``_seed_bundled_prompts``.
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
            _seed_bundled_prompts(target, bundled)
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

    Only real, loadable templates: a name that ``_safe_name`` would reject can
    never be loaded, so listing it would put a dead entry in the picker. That
    filter is what keeps the ``<name>.bak-<stamp>.md`` copies seeding leaves
    behind out of the UI.

    Returns:
        Sorted list of template names.
    """
    return sorted(
        p.stem for p in PROMPTS_DIR.glob("*.md") if _NAME_RE.match(p.stem)
    )


def save_prompt(name: str, content: str) -> None:
    """Create or overwrite a prompt template file.

    Saving claims the template for the user: seeding will never overwrite it
    with a newer bundled default afterwards.
    """
    safe = _safe_name(name)
    PROMPTS_DIR.mkdir(parents=True, exist_ok=True)
    (PROMPTS_DIR / f"{safe}.md").write_text(content, encoding="utf-8")
    _mark_user_owned(PROMPTS_DIR, safe)


def delete_prompt(name: str) -> None:
    """Delete a prompt template file.

    Deleting also claims the name, so a bundled template the user removed is
    not resurrected by seeding on the next start.
    """
    safe = _safe_name(name)
    path = PROMPTS_DIR / f"{safe}.md"
    if not path.exists():
        raise FileNotFoundError(f"Prompt template not found: {name}")
    path.unlink()
    _mark_user_owned(PROMPTS_DIR, safe)
