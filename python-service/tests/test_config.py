"""Tests for prompt-template loading and packaged-install seeding (src/config.py)."""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

from src import config

# Mirror of the heading regex the to-do pipeline uses (src-tauri/src/storage.rs
# `extract_action_items`, mirrored in src/lib/summary.ts `ACTIONABLE`). Bullets
# only become to-do rows when they sit under a heading matching this.
ACTIONABLE = re.compile(
    r"(?i)(action item|action point|next step|to[ -]?(?:do|build)|deliverable|task)"
)


class TestBrainDumpTemplate:
    """The morning brain-dump template ships and keeps the to-do contract."""

    def test_loads_by_name(self) -> None:
        """load_prompt('brain-dump') returns the bundled template."""
        content = config.load_prompt("brain-dump")
        assert "brain dump" in content.lower()

    def test_is_listed(self) -> None:
        """The template is discoverable, so the UI offers it."""
        assert "brain-dump" in config.list_template_files()

    def test_names_an_actionable_section(self) -> None:
        """One declared section heading must match the to-do extractor's regex —
        without it the template produces no to-do rows at all."""
        headings = re.findall(r'\*\*"([^"]+)"\*\*', config.load_prompt("brain-dump"))
        assert headings, "template must declare its section headings"
        assert [h for h in headings if ACTIONABLE.search(h)] == ["Action Items"]

    def test_pins_the_owner_prefixed_bullet_shape(self) -> None:
        """`Owner: instruction` is what storage.rs `split_label` peels into the
        assignee column; the template must dictate that exact shape."""
        content = config.load_prompt("brain-dump")
        assert "`Owner: instruction`" in content
        assert "`Me: Fix the Windows updater signing secret.`" in content


class TestPackagedPromptSeeding:
    """A frozen build seeds the user's writable prompts dir from the bundle."""

    @staticmethod
    def _resolve(
        monkeypatch: pytest.MonkeyPatch, bundle_root: Path, data_dir: Path
    ) -> Path:
        """Run _resolve_prompts_dir() as if PyInstaller-frozen at bundle_root."""
        monkeypatch.setattr(sys, "frozen", True, raising=False)
        monkeypatch.setattr(sys, "_MEIPASS", str(bundle_root), raising=False)
        monkeypatch.setenv("ADVERSARIA_DATA_DIR", str(data_dir))
        return config._resolve_prompts_dir()

    @staticmethod
    def _bundle(tmp_path: Path, files: dict[str, str]) -> Path:
        """Build a fake PyInstaller bundle root containing prompts/."""
        prompts = tmp_path / "bundle" / "prompts"
        prompts.mkdir(parents=True)
        for name, text in files.items():
            (prompts / name).write_text(text, encoding="utf-8")
        return prompts.parent

    def test_seeds_every_template_on_a_fresh_install(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """No prompts dir yet: all bundled templates are copied in."""
        bundle = self._bundle(
            tmp_path, {"general.md": "general", "brain-dump.md": "dump"}
        )
        data_dir = tmp_path / "appdata"

        target = self._resolve(monkeypatch, bundle, data_dir)

        assert target == data_dir / "prompts"
        assert sorted(p.name for p in target.glob("*.md")) == [
            "brain-dump.md",
            "general.md",
        ]

    def test_seeds_a_new_template_into_an_existing_install(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """An install that predates brain-dump.md still gets it — seeding is
        per-file, not "only when the directory is missing"."""
        bundle = self._bundle(
            tmp_path, {"general.md": "general", "brain-dump.md": "dump"}
        )
        data_dir = tmp_path / "appdata"
        installed = data_dir / "prompts"
        installed.mkdir(parents=True)
        (installed / "general.md").write_text("general", encoding="utf-8")

        target = self._resolve(monkeypatch, bundle, data_dir)

        assert (target / "brain-dump.md").read_text(encoding="utf-8") == "dump"

    def test_refreshes_a_stale_default_and_keeps_a_backup(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The bug this contract exists for: Hamza's packaged app ran a
        `general.md` frozen at 2026-06-20 (2,563 B vs the repo's 6,353) because
        seeding only ever copied a MISSING file, so six weeks of prompt fixes
        never reached it. An unclaimed template is now brought up to date — and
        because an install predating the ownership file has no record, whatever
        was there is backed up beside it rather than lost."""
        bundle = self._bundle(tmp_path, {"general.md": "CURRENT default"})
        data_dir = tmp_path / "appdata"
        installed = data_dir / "prompts"
        installed.mkdir(parents=True)
        (installed / "general.md").write_text("stale June default", encoding="utf-8")

        target = self._resolve(monkeypatch, bundle, data_dir)

        assert (target / "general.md").read_text(encoding="utf-8") == "CURRENT default"
        backups = list(target.glob("general.bak-*.md"))
        assert len(backups) == 1, "the previous copy must be recoverable"
        assert backups[0].read_text(encoding="utf-8") == "stale June default"

    def test_never_touches_a_template_the_user_saved(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Saving a template in the app claims it: seeding leaves it alone
        forever after, with no backup churn."""
        bundle = self._bundle(
            tmp_path, {"general.md": "bundled default", "brain-dump.md": "dump"}
        )
        data_dir = tmp_path / "appdata"
        installed = data_dir / "prompts"
        installed.mkdir(parents=True)
        (installed / "general.md").write_text("MY EDITS", encoding="utf-8")
        config._mark_user_owned(installed, "general")

        target = self._resolve(monkeypatch, bundle, data_dir)

        assert (target / "general.md").read_text(encoding="utf-8") == "MY EDITS"
        assert not list(target.glob("general.bak-*.md"))
        assert (target / "brain-dump.md").exists(), "other templates still seed"

    def test_does_not_resurrect_a_template_the_user_deleted(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Deleting claims the name too, so per-file seeding cannot bring a
        bundled template the user removed back on the next start."""
        bundle = self._bundle(
            tmp_path, {"general.md": "general", "youtube.md": "yt"}
        )
        data_dir = tmp_path / "appdata"
        installed = data_dir / "prompts"
        installed.mkdir(parents=True)
        config._mark_user_owned(installed, "youtube")

        target = self._resolve(monkeypatch, bundle, data_dir)

        assert not (target / "youtube.md").exists()
        assert (target / "general.md").exists()

    def test_an_up_to_date_template_is_left_untouched(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Identical content: no rewrite, and above all no backup on every launch."""
        bundle = self._bundle(tmp_path, {"general.md": "same"})
        data_dir = tmp_path / "appdata"
        installed = data_dir / "prompts"
        installed.mkdir(parents=True)
        (installed / "general.md").write_text("same", encoding="utf-8")

        target = self._resolve(monkeypatch, bundle, data_dir)

        assert (target / "general.md").read_text(encoding="utf-8") == "same"
        assert not list(target.glob("general.bak-*.md"))

    def test_backups_are_not_offered_as_templates(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A `.bak-<stamp>.md` copy must never appear in the template picker —
        its name isn't even loadable."""
        bundle = self._bundle(tmp_path, {"general.md": "CURRENT"})
        data_dir = tmp_path / "appdata"
        installed = data_dir / "prompts"
        installed.mkdir(parents=True)
        (installed / "general.md").write_text("stale", encoding="utf-8")

        target = self._resolve(monkeypatch, bundle, data_dir)
        monkeypatch.setattr(config, "PROMPTS_DIR", target)

        assert list(target.glob("general.bak-*.md")), "precondition: a backup exists"
        assert config.list_template_files() == ["general"]

    def test_leaves_user_created_templates_alone(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Templates the user saved themselves are not touched or removed."""
        bundle = self._bundle(tmp_path, {"brain-dump.md": "dump"})
        data_dir = tmp_path / "appdata"
        installed = data_dir / "prompts"
        installed.mkdir(parents=True)
        (installed / "q3-planning.md").write_text("mine", encoding="utf-8")

        target = self._resolve(monkeypatch, bundle, data_dir)

        assert (target / "q3-planning.md").read_text(encoding="utf-8") == "mine"
