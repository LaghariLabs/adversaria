"""Aggregate JSON and dependency-free HTML report writers."""

from __future__ import annotations

import html
import json
from pathlib import Path
from typing import Any


def _display(value: Any) -> str:
    if value is None:
        return "—"
    if isinstance(value, float):
        return f"{value:.4f}"
    return str(value)


def write_reports(report: dict[str, Any], output_dir: Path) -> tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / "report.json"
    html_path = output_dir / "report.html"
    json_path.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    gate_rows = "".join(
        "<tr>"
        f"<td>{html.escape(gate['name'])}</td>"
        f"<td class='{html.escape(gate['status'])}'>{html.escape(gate['status'])}</td>"
        f"<td>{html.escape(gate['detail'])}</td>"
        "</tr>"
        for gate in report["gates"]
    )
    metric_names = [
        "wer",
        "cer",
        "der",
        "jer",
        "speaker_attributed_wer",
        "speaker_count_accuracy",
        "entity_number_preservation",
        "summary_factual_precision",
        "action_item_traceability",
    ]
    slice_rows = "".join(
        "<tr>"
        f"<td>{html.escape(slice_name)}</td>"
        f"<td>{values['session_count']}</td>"
        + "".join(
            f"<td>{html.escape(_display(values['metrics'].get(metric)))}</td>"
            for metric in metric_names
        )
        + "</tr>"
        for slice_name, values in report["slices"].items()
    )
    metric_headers = "".join(f"<th>{html.escape(metric)}</th>" for metric in metric_names)
    document = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Adversaria evaluation — {html.escape(report['corpus_id'])}</title>
<style>
body {{ font: 14px system-ui, sans-serif; margin: 2rem; color: #18212f; }}
table {{ border-collapse: collapse; width: 100%; margin: 1rem 0 2rem; }}
th, td {{ border: 1px solid #ccd3dc; padding: .5rem; text-align: left; }}
th {{ background: #eef2f6; position: sticky; top: 0; }}
.passed {{ color: #167044; font-weight: 700; }}
.failed {{ color: #b42318; font-weight: 700; }}
.skipped {{ color: #667085; }}
.scroll {{ overflow-x: auto; }}
</style>
</head>
<body>
<h1>Adversaria aggregate evaluation</h1>
<p>Corpus <strong>{html.escape(report['corpus_id'])}</strong> ·
{report['session_count']} sessions · {report['duration_seconds'] / 3600:.2f} hours</p>
<p>{html.escape(report['privacy'])}</p>
<h2>Release gates</h2>
<table><thead><tr><th>Gate</th><th>Status</th><th>Detail</th></tr></thead>
<tbody>{gate_rows}</tbody></table>
<h2>Slice metrics</h2>
<div class="scroll"><table><thead><tr><th>Slice</th><th>Sessions</th>
{metric_headers}</tr></thead><tbody>{slice_rows}</tbody></table></div>
</body>
</html>
"""
    html_path.write_text(document, encoding="utf-8")
    return json_path, html_path

