#!/usr/bin/env python3
"""R1-H copilot answer regression harness (scripts lane).

Posts invented practice-case fixtures to a local /copilot_answer_stream
endpoint, assembles the SSE text per (sec, i), and checks the SAY line
against numeric or regex expectations.

Invented fixtures only: scripts/copilot-e2e/fixtures/*.json must never
contain real user data. Python 3 stdlib only. Loopback only, no redirects.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"

LOOPBACK_HOSTS = {"127.0.0.1", "localhost"}

REQUEST_TIMEOUT_S = 180.0


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse all HTTP redirects to enforce strict loopback confinement."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(
            req.full_url,
            code,
            f"HTTP redirect blocked ({code}) to {newurl}",
            headers,
            fp,
        )


NO_REDIRECT_OPENER = urllib.request.build_opener(
    urllib.request.ProxyHandler({}), NoRedirectHandler
)


def refuse_unless_loopback(url_str: str, flag: str) -> str:
    """Exit 2 unless the URL host is 127.0.0.1 or localhost."""
    try:
        host = urllib.parse.urlsplit(url_str).hostname
    except Exception:
        host = None
    if (host or "").lower() not in LOOPBACK_HOSTS:
        print(
            f"answer_regress: {flag} host must be 127.0.0.1 or localhost, "
            f"got: {url_str!r}",
            file=sys.stderr,
        )
        sys.exit(2)
    return url_str


# ---------------------------------------------------------------------------
# Number extraction
# ---------------------------------------------------------------------------

UNITS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4,
    "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
    "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13,
    "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17,
    "eighteen": 18, "nineteen": 19,
}
TENS = {
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
    "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
}
WORD_SCALES = {
    "hundred": 100,
    "thousand": 1_000,
    "million": 1_000_000,
    "billion": 1_000_000_000,
    "trillion": 1_000_000_000_000,
}
SIGN_WORDS = {"negative", "minus"}
TRAILING_WORDS = {"dollar", "dollars", "percent", "percentage"}

LETTER_SCALE = {"k": 1_000, "m": 1_000_000, "b": 1_000_000_000}

_DIGIT_RE = re.compile(
    r"""
    (?<!\w)
    (?:(?P<signword>negative|minus)\s+)?
    (?P<negsign>[-−])?
    \s*\$?\s*
    (?P<int>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)
    (?:\s*(?P<scale>trillions?|billions?|millions?|thousands?|[mMbBkK](?![A-Za-z])))?
    (?:\s*(?P<pct>%|percents?|percentage))?
    (?![\w%])
    """,
    re.IGNORECASE | re.VERBOSE,
)

_WORD_RE = re.compile(r"[A-Za-z]+")


def _scale_mult(scale_token: str | None) -> float:
    if not scale_token:
        return 1.0
    low = scale_token.lower()
    if low in WORD_SCALES:
        return float(WORD_SCALES[low])
    if len(low) == 1 and low in LETTER_SCALE:
        return float(LETTER_SCALE[low])
    if low.endswith("s"):
        singular = low[:-1]
        if singular in WORD_SCALES:
            return float(WORD_SCALES[singular])
    return 1.0


def _parse_word_run(tokens: list[str]) -> float | None:
    """Parse a run of English number words. Returns None if not a number."""
    total = 0.0
    current = 0.0
    seen_number = False
    for w in tokens:
        if w in UNITS:
            current += UNITS[w]
            seen_number = True
        elif w in TENS:
            current += TENS[w]
            seen_number = True
        elif w == "hundred":
            current = (current if current else 1.0) * 100.0
            seen_number = True
        elif w in WORD_SCALES:
            current = (current if current else 1.0) * WORD_SCALES[w]
            total += current
            current = 0.0
            seen_number = True
        elif w == "and":
            continue
        else:
            return None
    if not seen_number:
        return None
    return total + current


def _in_spans(start: int, end: int, spans: list[tuple[int, int]]) -> bool:
    return any(start < s_end and end > s_start for s_start, s_end in spans)


def extract_numbers(text: str) -> list[float]:
    """Extract every number from text as floats.

    Understands $11,484,150 / -$9.37M / 11.5 million / negative 9.4
    million / 13.3% and spelled-out English ("negative nine million
    three hundred sixty-seven thousand five hundred dollars").
    Percents keep their face value (13.3 percent -> 13.3).
    """
    values: list[float] = []
    spans: list[tuple[int, int]] = []

    for m in _DIGIT_RE.finditer(text):
        raw = m.group("int").replace(",", "")
        try:
            base = float(raw)
        except ValueError:
            continue
        value = base * _scale_mult(m.group("scale"))
        if m.group("signword") or m.group("negsign"):
            value = -value
        values.append(value)
        spans.append((m.start(), m.end()))

    words = [(m.group(0).lower(), m.start(), m.end()) for m in _WORD_RE.finditer(text)]
    i = 0
    while i < len(words):
        w, ws, we = words[i]
        neg = False
        j = i
        if w in SIGN_WORDS and i + 1 < len(words):
            nxt = words[i + 1][0]
            if nxt in UNITS or nxt in TENS:
                neg = True
                j = i + 1
        if words[j][0] not in UNITS and words[j][0] not in TENS:
            i += 1
            continue
        k = j
        run: list[str] = []
        while k < len(words) and (
            words[k][0] in UNITS
            or words[k][0] in TENS
            or words[k][0] in WORD_SCALES
            or words[k][0] == "and"
        ):
            run.append(words[k][0])
            k += 1
        # Consume one trailing unit word (dollars / percent); value unchanged.
        if k < len(words) and words[k][0] in TRAILING_WORDS:
            k += 1
        run_start = words[i][1]
        run_end = words[k - 1][2]
        if _in_spans(run_start, run_end, spans):
            i = k
            continue
        parsed = _parse_word_run(run)
        if parsed is not None:
            values.append(-parsed if neg else parsed)
        i = k if k > i else i + 1

    return values


# ---------------------------------------------------------------------------
# SSE + evaluation
# ---------------------------------------------------------------------------

def post_answer_stream(
    service: str, payload: dict, timeout: float = REQUEST_TIMEOUT_S
) -> tuple[dict[tuple[str, int], str], float | None, float, str | None]:
    """POST /copilot_answer_stream and assemble text per (sec, i).

    Returns (parts, first_text_s, total_s, error). Frames carrying a
    "replay" or "usage" key are ignored.
    """
    url = service.rstrip("/") + "/copilot_answer_stream"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        },
    )
    parts: dict[tuple[str, int], str] = {}
    first_text_s: float | None = None
    error: str | None = None
    t0 = time.perf_counter()
    try:
        resp = NO_REDIRECT_OPENER.open(req, timeout=timeout)
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode("utf-8", "replace")[:500]
        except Exception:
            detail = str(exc)
        return parts, None, time.perf_counter() - t0, f"http_{exc.code}: {detail}"
    with resp:
        for line_bytes in resp:
            try:
                line = line_bytes.decode("utf-8").strip()
            except UnicodeDecodeError:
                continue
            if not line or not line.startswith("data:"):
                continue
            content = line[5:].strip()
            if content == "[DONE]":
                break
            try:
                frame = json.loads(content)
            except json.JSONDecodeError:
                continue
            if not isinstance(frame, dict):
                continue
            if "replay" in frame or "usage" in frame:
                continue
            if "error" in frame and "t" not in frame:
                error = str(frame.get("error"))[:500]
                break
            if "t" not in frame:
                continue
            if frame.get("drop"):
                continue
            chunk = frame.get("t")
            if not isinstance(chunk, str) or not chunk:
                continue
            if first_text_s is None:
                first_text_s = time.perf_counter() - t0
            sec = frame.get("sec", "say")
            idx = frame.get("i", 0)
            if not isinstance(sec, str):
                sec = "say"
            if not isinstance(idx, int):
                idx = 0
            key = (sec.lower(), idx)
            parts[key] = parts.get(key, "") + chunk
    return parts, first_text_s, time.perf_counter() - t0, error


def join_section(parts: dict[tuple[str, int], str], sec: str, sep: str) -> str:
    items = sorted(
        ((idx, text) for (s, idx), text in parts.items() if s == sec),
        key=lambda kv: kv[0],
    )
    return sep.join(text.strip() for _, text in items if text.strip())


def check_fixture(
    parts: dict[tuple[str, int], str],
    expect: dict,
    first_text_s: float | None,
    stream_error: str | None,
) -> tuple[bool, str, str]:
    """Return (passed, reason, say_text)."""
    say_text = join_section(parts, "say", " ")
    specific_text = join_section(parts, "specific", "\n")
    combined = say_text + ("\n" + specific_text if specific_text else "")

    if stream_error:
        return False, f"stream_error: {stream_error}", say_text
    if not say_text.strip():
        return False, "empty SAY: no say text received", say_text

    max_first = expect.get("max_first_text_s")
    if max_first is not None:
        if first_text_s is None:
            return False, "no first text received", say_text
        if first_text_s > float(max_first):
            return (
                False,
                f"slow first text: {first_text_s:.2f}s > {float(max_first):.2f}s",
                say_text,
            )

    say_num = expect.get("say_number")
    if say_num is not None:
        target = float(say_num["value"])
        tol = float(say_num.get("tolerance_pct", 0.0))
        found = extract_numbers(say_text)
        bound = abs(target) * tol / 100.0
        if not any(abs(n - target) <= bound for n in found):
            shown = ", ".join(
                f"{n:,.4g}" for n in found[:8]
            ) or "none"
            return (
                False,
                f"say_number: no SAY number within {tol:g}% of {target:,.4g} "
                f"(found: {shown})",
                say_text,
            )

    for pat in expect.get("must_match", []) or []:
        if not re.search(pat, combined, re.IGNORECASE):
            return False, f"must_match failed: /{pat}/", say_text

    for pat in expect.get("must_not_match", []) or []:
        if re.search(pat, combined, re.IGNORECASE):
            return False, f"must_not_match hit: /{pat}/", say_text

    say_count = expect.get("say_count")
    if say_count is not None:
        lo, hi = say_count
        n_say = sum(
            1 for (s, _), text in parts.items() if s == "say" and text.strip()
        )
        if not (lo <= n_say <= hi):
            return False, f"say_count: {n_say} not in [{lo}, {hi}]", say_text

    specific_count = expect.get("specific_count")
    if specific_count is not None:
        lo, hi = specific_count
        n_specific = sum(
            1 for (s, _), text in parts.items() if s == "specific" and text.strip()
        )
        if not (lo <= n_specific <= hi):
            return False, f"specific_count: {n_specific} not in [{lo}, {hi}]", say_text

    for pat in expect.get("say_must_match", []) or []:
        if not re.search(pat, say_text, re.IGNORECASE):
            return False, f"say_must_match failed: /{pat}/", say_text

    shape = expect.get("shape")
    if shape is not None and shape not in ("brief", "steps"):
        return False, f"unknown shape: {shape!r}", say_text

    return True, "", say_text


def load_fixtures(only: str | None) -> list[dict]:
    if not FIXTURES_DIR.is_dir():
        print(f"answer_regress: fixtures dir not found: {FIXTURES_DIR}", file=sys.stderr)
        sys.exit(1)
    paths = sorted(FIXTURES_DIR.glob("*.json"))
    if only:
        paths = [p for p in paths if p.stem == only]
        if not paths:
            print(f"answer_regress: no fixture named {only!r}", file=sys.stderr)
            sys.exit(1)
    fixtures = []
    for p in paths:
        try:
            fixtures.append(json.loads(p.read_text(encoding="utf-8")))
        except Exception as exc:
            print(f"answer_regress: bad fixture {p.name}: {exc}", file=sys.stderr)
            sys.exit(1)
    return fixtures


def run_self_test() -> int:
    cases = [
        ("$11,484,150", 11484150.0),
        ("-$9.37M", -9370000.0),
        (
            "negative nine million three hundred sixty-seven thousand "
            "five hundred dollars",
            -9367500.0,
        ),
        ("approximately 316.5 false alerts", 316.5),
        ("13.3 percent", 13.3),
        ("11.5 million dollars", 11500000.0),
    ]
    failed = 0
    for text, want in cases:
        got = extract_numbers(text)
        if not any(n == want for n in got):
            print(f"SELF-TEST FAIL: {text!r} -> {got}, want {want}")
            failed += 1
    if failed:
        return 1
    print("OK")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Copilot answer regression harness (invented fixtures only)."
    )
    parser.add_argument("--service", default="http://127.0.0.1:9876")
    parser.add_argument("--model", default="qwen3.6:35b")
    parser.add_argument("--llm-base-url", default="http://127.0.0.1:11434/v1")
    parser.add_argument("--only", default=None)
    parser.add_argument("--runs", type=int, default=1)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        return run_self_test()

    refuse_unless_loopback(args.service, "--service")
    refuse_unless_loopback(args.llm_base_url, "--llm-base-url")
    if args.runs < 1:
        print("answer_regress: --runs must be >= 1", file=sys.stderr)
        return 2

    fixtures = load_fixtures(args.only)

    passed = 0
    failed = 0
    for fixture in fixtures:
        name = fixture.get("name", "?")
        expect = fixture.get("expect", {})
        base_request = dict(fixture.get("request", {}))
        base_request["model"] = args.model
        base_request["llm_base_url"] = args.llm_base_url
        for run in range(1, args.runs + 1):
            tag = f" run {run}/{args.runs}" if args.runs > 1 else ""
            try:
                parts, first_text_s, total_s, stream_error = post_answer_stream(
                    args.service, base_request
                )
            except (urllib.error.URLError, ConnectionError, OSError) as exc:
                print(
                    f"answer_regress: service unreachable at {args.service}: {exc}"
                )
                return 3
            except Exception as exc:  # never a traceback for transport issues
                print(
                    f"answer_regress: service unreachable at {args.service}: {exc}"
                )
                return 3
            ok, reason, say_text = check_fixture(
                parts, expect, first_text_s, stream_error
            )
            first_s = f"{first_text_s:.2f}s" if first_text_s is not None else "n/a"
            if ok:
                passed += 1
                print(f"PASS {name}{tag} first_text={first_s} total={total_s:.2f}s")
            else:
                failed += 1
                say_short = say_text.strip().replace("\n", " ")[:300]
                print(
                    f"FAIL {name}{tag} first_text={first_s} total={total_s:.2f}s "
                    f"reason={reason} SAY: {say_short}"
                )

    print(f"{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
