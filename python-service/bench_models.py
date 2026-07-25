"""Scratch benchmark: score summarization models on a stored meeting transcript.

Usage: python bench_models.py <meeting_id> <model> [<model> ...]
Calls the running service's /summarize per model (single timed call incl. cold
load) and writes full outputs to bench_results.json plus a metrics table to
stdout. Not part of the app.
"""

import json
import sqlite3
import sys
import time
import urllib.request
from pathlib import Path

DB = Path.home() / "AppData" / "Roaming" / "meeting-note-taker" / "meetings.db"
URL = "http://127.0.0.1:9877/summarize"
OUT = Path(__file__).parent / "bench_results.json"


def call(transcript: str, model: str) -> tuple[float, dict]:
    body = json.dumps(
        {"transcript": transcript, "template_name": "general", "model": model}
    ).encode()
    req = urllib.request.Request(
        URL, data=body, headers={"Content-Type": "application/json"}
    )
    start = time.monotonic()
    resp = json.loads(urllib.request.urlopen(req, timeout=600).read())
    return time.monotonic() - start, resp


def main() -> None:
    meeting_id = int(sys.argv[1])
    models = sys.argv[2:]
    con = sqlite3.connect(str(DB))
    transcript = con.execute(
        "SELECT transcript FROM meetings WHERE id=?", (meeting_id,)
    ).fetchone()[0]
    print(
        f"transcript: {len(transcript)} chars / {len(transcript.split())} words\n",
        flush=True,
    )

    results = []
    for model in models:
        try:
            dt, r = call(transcript, model)
        except Exception as exc:  # noqa: BLE001 — bench tool
            print(f"{model:26s} ERROR: {type(exc).__name__}: {str(exc)[:90]}", flush=True)
            results.append({"model": model, "error": f"{type(exc).__name__}: {exc}"})
            continue
        summary = r.get("summary", "")
        record = {
            "model": model,
            "seconds": round(dt, 1),
            "title": r.get("title"),
            "attendees": r.get("attendees"),
            "summary_chars": len(summary),
            "summary": summary,
        }
        results.append(record)
        print(
            f"{model:26s} [{dt:5.0f}s] attendees={len(r.get('attendees') or [])} "
            f"chars={len(summary)} title={r.get('title')!r}",
            flush=True,
        )
        OUT.write_text(json.dumps(results, indent=2), encoding="utf-8")

    OUT.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"\nFull outputs written to {OUT}", flush=True)


if __name__ == "__main__":
    main()
