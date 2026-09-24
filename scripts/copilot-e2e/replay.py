#!/usr/bin/env python3
"""E1a Service Replay Harness for Realtime Copilot v2.

Drives synthetic /live_feed audio deltas and /copilot_answer_stream requests
against a local loopback service to measure latency, streaming continuity,
and contract adherence without touching live user databases or remote providers.
"""

from __future__ import annotations

import argparse
import datetime
import json
import math
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import wave
from pathlib import Path
from typing import Any


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse all HTTP redirects to enforce strict loopback confinement."""

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> Any:
        raise urllib.error.HTTPError(
            req.full_url,
            code,
            f"HTTP redirect blocked ({code}) to {newurl}",
            headers,
            fp,
        )


# Do not inherit HTTP(S)_PROXY for a harness that is required to stay on loopback.
NO_REDIRECT_OPENER = urllib.request.build_opener(
    urllib.request.ProxyHandler({}), NoRedirectHandler
)


def http_open(req: urllib.request.Request, timeout: float = 10.0) -> Any:
    """Open an HTTP request using the shared no-redirect opener."""
    return NO_REDIRECT_OPENER.open(req, timeout=timeout)


def iso_now() -> str:
    """Return current UTC timestamp in ISO 8601 format."""
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def validate_loopback_url(url_str: str, param_name: str = "URL") -> None:
    """Ensure URL is strictly a loopback HTTP endpoint without credentials or paths/queries."""
    if not url_str:
        return
    parsed = urllib.parse.urlsplit(url_str)
    if parsed.scheme != "http":
        raise ValueError(f"{param_name} scheme must be http, got: {parsed.scheme!r}")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError(f"{param_name} must not contain user credentials")
    if parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError(
            f"{param_name} host must be a loopback interface (127.0.0.1, localhost, ::1), got: {parsed.hostname!r}"
        )
    if parsed.query or parsed.fragment:
        raise ValueError(f"{param_name} must not contain query parameters or fragments")


def redact_secrets(data: Any, secrets: list[str]) -> Any:
    """Recursively redact known secrets and absolute paths from dictionaries, lists, and strings."""
    active_secrets = [s for s in secrets if s and len(s) >= 4]
    if isinstance(data, dict):
        cleaned: dict[str, Any] = {}
        for k, v in data.items():
            key = k.lower()
            is_sensitive_key = key in {
                "api_key",
                "authorization",
                "key",
                "password",
                "refresh_token",
                "secret",
                "token",
            } or key.endswith(("_api_key", "_password", "_secret"))
            if is_sensitive_key:
                cleaned[k] = "[REDACTED]" if v else None
            else:
                cleaned[k] = redact_secrets(v, active_secrets)
        return cleaned
    if isinstance(data, list):
        return [redact_secrets(item, active_secrets) for item in data]
    if isinstance(data, str):
        result = data
        for s in active_secrets:
            result = result.replace(s, "[REDACTED]")
        result = re.sub(
            r"/(?:Users|private|tmp|var|etc|Volumes)/[^\s'\"]+", "[PATH]", result
        )
        return result
    return data


def compute_percentiles(values: list[float]) -> dict[str, float]:
    """Compute p50, p95, and max for a list of float values in milliseconds."""
    if not values:
        return {"p50": 0.0, "p95": 0.0, "max": 0.0, "count": 0}
    sorted_vals = sorted(values)
    n = len(sorted_vals)

    def percentile(p: float) -> float:
        idx = (len(sorted_vals) - 1) * p
        lower = math.floor(idx)
        upper = math.ceil(idx)
        if lower == upper:
            return sorted_vals[int(idx)]
        return sorted_vals[lower] * (upper - idx) + sorted_vals[upper] * (idx - lower)

    return {
        "p50": round(percentile(0.50), 2),
        "p95": round(percentile(0.95), 2),
        "max": round(sorted_vals[-1], 2),
        "count": n,
    }


def write_json_atomically(target_path: Path, data: dict[str, Any]) -> None:
    """Write JSON data atomically using a temporary file in the same directory."""
    target_path.parent.mkdir(parents=True, exist_ok=True)
    temp_file = target_path.with_name(f".{target_path.name}.tmp.{os.getpid()}")
    try:
        with open(temp_file, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(temp_file, target_path)
    finally:
        if temp_file.exists():
            try:
                temp_file.unlink()
            except OSError:
                pass


def is_valid_usage(usage: Any) -> bool:
    """Check that usage frame contains non-negative numeric tokens and web searches."""
    if not isinstance(usage, dict):
        return False
    for k in ("input_tokens", "output_tokens", "web_searches"):
        if k not in usage:
            return False
        val = usage[k]
        if not isinstance(val, (int, float)) or isinstance(val, bool) or val < 0:
            return False
    return True


def get_first_bullet_text(text: str) -> str:
    """Extract first non-empty bullet line without leading bullet markers."""
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith(("- ", "* ", "• ")):
            return line[2:].strip()
        return line
    return ""


def validate_bullet_shape(text: str) -> list[str]:
    """Return contract failures for the 1-3 bullets / 12 words shape."""
    nonempty = [line.strip() for line in text.splitlines() if line.strip()]
    reasons: list[str] = []
    if not 1 <= len(nonempty) <= 3:
        reasons.append(
            f"Answer must contain 1 to 3 non-empty bullet lines (got {len(nonempty)})"
        )
    for index, line in enumerate(nonempty, start=1):
        if not line.startswith(("- ", "* ", "• ")):
            reasons.append(f"Answer line {index} is not a bullet")
            continue
        word_count = len(line[2:].split())
        if word_count > 12:
            reasons.append(f"Answer bullet {index} exceeds 12 words (got {word_count})")
    return reasons


def validate_answer_result(
    stream_res: dict[str, Any], case: dict[str, Any]
) -> tuple[bool, list[str]]:
    """Centralized verification of answer stream terminal status, usage, and grounding."""
    reasons: list[str] = []
    if stream_res.get("has_malformed_frame"):
        reasons.append(f"Malformed SSE JSON frame: {stream_res.get('error')}")

    if stream_res.get("terminal_kind") != "done" or not stream_res.get("seen_done"):
        reasons.append(
            f"Missing authoritative [DONE] terminal (kind: {stream_res.get('terminal_kind')}, error: {stream_res.get('error')})"
        )

    usage = stream_res.get("usage")
    if not is_valid_usage(usage):
        reasons.append(f"Missing or invalid usage metrics: {usage}")

    full_text = stream_res.get("full_text", "")
    if not full_text.strip():
        reasons.append("Answer output text is empty")
    else:
        reasons.extend(validate_bullet_shape(full_text))

    if is_valid_usage(usage) and usage["web_searches"] != 0:
        reasons.append(
            f"Local answer reported web_searches={usage['web_searches']}; expected 0"
        )

    req_prefix = case.get("required_prefix")
    if req_prefix:
        first_bullet = get_first_bullet_text(full_text)
        if not first_bullet.startswith(req_prefix):
            reasons.append(
                f"First bullet does not start with required prefix {req_prefix!r} (got: {first_bullet!r})"
            )

    req_phrase = case.get("required_phrase")
    if req_phrase and req_phrase.lower() not in full_text.lower():
        reasons.append(f"Missing required phrase: {req_phrase!r}")

    disallowed = case.get("disallowed_phrase")
    if disallowed and disallowed.lower() in full_text.lower():
        reasons.append(f"Found disallowed phrase: {disallowed!r}")

    return (len(reasons) == 0), reasons


def generate_tts_wav(text: str, output_wav: Path, temp_dir: Path) -> bool:
    """Generate a 16 kHz mono 16-bit PCM WAV using macOS built-in tools (say and afconvert)."""
    say_bin = shutil.which("say")
    afconvert_bin = shutil.which("afconvert")
    if not say_bin or not afconvert_bin:
        return False

    temp_aiff = temp_dir / f"tts_{os.getpid()}_{int(time.time() * 1000)}.aiff"
    try:
        cmd_say = [say_bin, "-o", str(temp_aiff), text]
        subprocess.run(
            cmd_say,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        cmd_convert = [
            afconvert_bin,
            "-f",
            "WAVE",
            "-d",
            "LEI16@16000",
            "-c",
            "1",
            str(temp_aiff),
            str(output_wav),
        ]
        subprocess.run(
            cmd_convert,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return output_wav.exists() and output_wav.stat().st_size > 44
    except Exception:
        return False
    finally:
        if temp_aiff.exists():
            temp_aiff.unlink()


def create_silence_wav(
    output_wav: Path, duration_sec: float = 0.5, sample_rate: int = 16000
) -> None:
    """Create a mono 16-bit PCM silence WAV file."""
    num_samples = int(duration_sec * sample_rate)
    silence_pcm = b"\x00" * (num_samples * 2)
    with wave.open(str(output_wav), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(silence_pcm)


def slice_wav_into_chunks(
    wav_path: Path, out_dir: Path, step_seconds: float = 0.5
) -> list[Path]:
    """Slice a WAV file into uniform PCM chunks for /live_feed emulation."""
    chunks: list[Path] = []
    with wave.open(str(wav_path), "rb") as w:
        sr = w.getframerate()
        channels = w.getnchannels()
        sampwidth = w.getsampwidth()
        pcm = w.readframes(w.getnframes())

    bytes_per_sample = channels * sampwidth
    step_bytes = int(step_seconds * sr) * bytes_per_sample

    for idx, offset in enumerate(range(0, len(pcm), step_bytes)):
        chunk_data = pcm[offset : offset + step_bytes]
        chunk_file = out_dir / f"chunk_{idx:03d}.wav"
        with wave.open(str(chunk_file), "wb") as cw:
            cw.setnchannels(channels)
            cw.setsampwidth(sampwidth)
            cw.setframerate(sr)
            cw.writeframes(chunk_data)
        chunks.append(chunk_file)

    return chunks


def check_service_health(service_url: str) -> tuple[bool, str]:
    """Probe service endpoint to check if it is active and responding on loopback without redirects."""
    health_url = f"{service_url.rstrip('/')}/health"
    req = urllib.request.Request(health_url, method="GET")
    try:
        with http_open(req, timeout=1.5) as resp:
            if resp.status == 200:
                return True, "Service is healthy"
            return False, f"Unexpected health status: {resp.status}"
    except urllib.error.URLError as exc:
        docs_url = f"{service_url.rstrip('/')}/docs"
        try:
            req_docs = urllib.request.Request(docs_url, method="GET")
            with http_open(req_docs, timeout=1.0) as resp:
                if resp.status == 200:
                    return True, "Service is responding on /docs"
        except Exception:
            pass
        return False, f"Connection failed: {exc}"
    except Exception as exc:
        return False, f"Health check failed: {exc}"


def check_local_model_readiness(
    service_url: str,
    model: str | None = None,
    llm_base_url: str | None = None,
    llm_api_key: str | None = None,
    timeout: float = 20.0,
) -> tuple[bool, str]:
    """Probe /copilot_answer_stream and strictly parse complete stream to confirm model readiness."""
    payload = {
        "provider": "local",
        "question": "Is the local engine ready?",
        "context_turns": [],
        "passages": [],
        "model": model,
        "llm_base_url": llm_base_url,
        "llm_api_key": llm_api_key,
    }
    stream_res = consume_copilot_stream(service_url, payload, timeout=timeout)
    if stream_res["has_malformed_frame"]:
        return (
            False,
            f"Malformed SSE frame in readiness probe: {stream_res.get('error')}",
        )
    if stream_res["terminal_kind"] != "done" or not stream_res["seen_done"]:
        return (
            False,
            f"Readiness probe did not receive [DONE] terminal (kind={stream_res['terminal_kind']}): {stream_res.get('error')}",
        )
    if stream_res["usage"] is None or not is_valid_usage(stream_res["usage"]):
        return False, "Readiness probe missing valid usage metrics"
    if not stream_res["full_text"].strip():
        return False, "Readiness probe produced empty answer text"
    return True, "Local engine ready and warmed"


def post_live_feed_chunk(
    service_url: str,
    chunk_path: Path,
    session_epoch: int,
    source: str = "them",
    timeout: float = 5.0,
) -> dict[str, Any]:
    """Post an audio delta chunk to /live_feed and record start/end timestamps and latency."""
    feed_url = f"{service_url.rstrip('/')}/live_feed"
    payload = {
        "audio_path": str(chunk_path.resolve()),
        "session": session_epoch,
        "source": source,
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        feed_url, data=data, headers={"Content-Type": "application/json"}
    )
    t0_perf = time.perf_counter()
    ts_start = iso_now()
    try:
        with http_open(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            t1_perf = time.perf_counter()
            ts_end = iso_now()
            return {
                "request_start_ts": ts_start,
                "request_end_ts": ts_end,
                "request_start_perf": t0_perf,
                "request_end_perf": t1_perf,
                "source": source,
                "latency_ms": round((t1_perf - t0_perf) * 1000.0, 2),
                "success": True,
                "error": None,
                "during_answer": False,
                "response": body,
            }
    except Exception as exc:
        t1_perf = time.perf_counter()
        ts_end = iso_now()
        return {
            "request_start_ts": ts_start,
            "request_end_ts": ts_end,
            "request_start_perf": t0_perf,
            "request_end_perf": t1_perf,
            "source": source,
            "latency_ms": round((t1_perf - t0_perf) * 1000.0, 2),
            "success": False,
            "error": str(exc),
            "during_answer": False,
            "response": None,
        }


def post_live_feed_chunks(
    service_url: str,
    chunks: list[Path],
    session_epoch: int,
    source: str,
    cadence_ms: int,
) -> list[dict[str, Any]]:
    """Post chunks with request starts paced to the requested cadence."""
    cadence_s = cadence_ms / 1000.0
    next_start = time.perf_counter()
    samples: list[dict[str, Any]] = []
    for chunk in chunks:
        delay = next_start - time.perf_counter()
        if delay > 0:
            time.sleep(delay)
        samples.append(
            post_live_feed_chunk(service_url, chunk, session_epoch, source=source)
        )
        next_start = max(next_start + cadence_s, time.perf_counter())
    return samples


def post_live_feed_chunks_with_vad_flush(
    service_url: str,
    chunks: list[Path],
    silence_path: Path,
    session_epoch: int,
    source: str,
    cadence_ms: int,
) -> list[dict[str, Any]]:
    """Post speech and its VAD flush on one request-start cadence."""
    create_silence_wav(silence_path, 0.5)
    return post_live_feed_chunks(
        service_url,
        [*chunks, silence_path],
        session_epoch,
        source,
        cadence_ms,
    )


def all_feed_samples_succeeded(samples: list[dict[str, Any]]) -> bool:
    """Return true only when at least one feed was attempted and all attempts succeeded."""
    return bool(samples) and all(sample["success"] for sample in samples)


def aggregate_live_status(
    *,
    had_tts_skip: bool,
    failed_count: int,
    passed_count: int,
    total_error_samples: int,
) -> str:
    """Aggregate case and ingestion outcomes without allowing partial feed success."""
    if had_tts_skip:
        return "incomplete"
    if failed_count == 0 and total_error_samples == 0 and passed_count > 0:
        return "passed"
    return "failed"


def aggregate_feed_continuity(case_results: list[dict[str, Any]]) -> bool:
    """Require at least one executed answer case and continuity in every one."""
    executed = [
        case for case in case_results if case.get("status") in {"passed", "failed"}
    ]
    return bool(executed) and all(
        case.get("feed_continued_during_answer") is True for case in executed
    )


def consume_copilot_stream(
    service_url: str,
    payload: dict[str, Any],
    timeout: float = 20.0,
) -> dict[str, Any]:
    """Stream /copilot_answer_stream SSE frames, capturing TTFT, text, and terminal status."""
    stream_url = f"{service_url.rstrip('/')}/copilot_answer_stream"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        stream_url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        },
    )

    t0_perf = time.perf_counter()
    answer_start_ts = iso_now()
    answer_first_token_ts: str | None = None
    ttft_ms: float | None = None
    frames: list[dict[str, Any] | str] = []
    text_chunks: list[str] = []
    citations: list[dict[str, Any]] = []
    usage: dict[str, Any] | None = None
    terminal_kind: str = "unknown"
    error_msg: str | None = None
    seen_done = False
    has_malformed_frame = False

    try:
        with http_open(req, timeout=timeout) as resp:
            for line_bytes in resp:
                line = line_bytes.decode("utf-8").strip()
                if not line or not line.startswith("data:"):
                    continue
                content = line[5:].strip()
                if content == "[DONE]":
                    if not has_malformed_frame:
                        if usage is not None and is_valid_usage(usage):
                            seen_done = True
                            terminal_kind = "done"
                        else:
                            terminal_kind = "missing_usage"
                            error_msg = "Stream terminated with [DONE] but missing or invalid usage frame"
                    break

                try:
                    frame_obj = json.loads(content)
                except Exception as exc:
                    has_malformed_frame = True
                    terminal_kind = "error"
                    error_msg = f"Malformed SSE JSON frame: {content!r} ({exc})"
                    break

                frames.append(frame_obj)
                if "t" in frame_obj:
                    if ttft_ms is None:
                        ttft_ms = (time.perf_counter() - t0_perf) * 1000.0
                        answer_first_token_ts = iso_now()
                    text_chunks.append(frame_obj["t"])
                elif "c" in frame_obj:
                    citations.append(frame_obj["c"])
                elif "usage" in frame_obj:
                    usage = frame_obj["usage"]
                elif "error" in frame_obj:
                    terminal_kind = "error"
                    error_msg = frame_obj["error"]
                    break

            if terminal_kind == "unknown":
                terminal_kind = "ended_early"
    except Exception as exc:
        if terminal_kind == "unknown":
            terminal_kind = "transport_error"
        error_msg = str(exc)

    t1_perf = time.perf_counter()
    answer_end_ts = iso_now()
    total_time_ms = (t1_perf - t0_perf) * 1000.0
    full_text = "".join(text_chunks)

    return {
        "answer_start_perf": t0_perf,
        "answer_end_perf": t1_perf,
        "answer_start_ts": answer_start_ts,
        "answer_first_token_ts": answer_first_token_ts,
        "answer_end_ts": answer_end_ts,
        "ttft_ms": round(ttft_ms, 2) if ttft_ms is not None else None,
        "total_time_ms": round(total_time_ms, 2),
        "terminal_kind": terminal_kind,
        "seen_done": seen_done,
        "has_malformed_frame": has_malformed_frame,
        "error": error_msg,
        "full_text": full_text,
        "citations": citations,
        "usage": usage,
        "frame_count": len(frames),
    }


def execute_answer_with_background_feed(
    service_url: str,
    answer_payload: dict[str, Any],
    temp_dir_path: Path,
    session_epoch: int,
    cadence_ms: int,
    timeout: float = 20.0,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Consume /copilot_answer_stream while concurrently driving background /live_feed requests."""
    bg_samples: list[dict[str, Any]] = []
    bg_samples_lock = threading.Lock()
    stop_event = threading.Event()

    def bg_worker() -> None:
        bg_silence = temp_dir_path / f"bg_{os.getpid()}_{int(time.time() * 1000)}.wav"
        create_silence_wav(bg_silence, 0.5)
        cadence_s = cadence_ms / 1000.0
        next_start = time.perf_counter()
        while not stop_event.is_set():
            delay = next_start - time.perf_counter()
            if delay > 0 and stop_event.wait(timeout=delay):
                break
            sample = post_live_feed_chunk(
                service_url,
                bg_silence,
                session_epoch,
                source="me",
                timeout=5.0,
            )
            with bg_samples_lock:
                bg_samples.append(sample)
            next_start = max(next_start + cadence_s, time.perf_counter())

    bg_thread = threading.Thread(target=bg_worker, daemon=False)
    bg_thread.start()

    try:
        stream_res = consume_copilot_stream(
            service_url, answer_payload, timeout=timeout
        )
    finally:
        stop_event.set()
        # post_live_feed_chunk has a five-second request timeout. Wait for that
        # bounded request to finish so no worker can outlive its temporary WAV
        # or spill a late sample into the next case.
        bg_thread.join()

    with bg_samples_lock:
        final_bg_samples = list(bg_samples)

    # Item 6: Determine during_answer temporally based on measured timestamps
    ans_start = stream_res["answer_start_perf"]
    ans_end = stream_res["answer_end_perf"]
    for s in final_bg_samples:
        s["during_answer"] = ans_start <= s["request_end_perf"] <= ans_end

    return stream_res, final_bg_samples


def run_dry_run(manifest_data: dict[str, Any]) -> dict[str, Any]:
    """Perform synthetic dry-run verification of manifest cases and calculation logic."""
    cases = manifest_data.get("cases", [])
    results: list[dict[str, Any]] = []
    simulated_feed_latencies: list[float] = []
    simulated_ttfts: list[float] = []

    for c in cases:
        c_id = c["id"]
        is_audio = c.get("audio_replay", False)
        start_ts = iso_now()

        if is_audio and c_id == "tag_question":
            sim_samples = [
                {
                    "request_start_ts": iso_now(),
                    "request_end_ts": iso_now(),
                    "source": "them",
                    "latency_ms": 21.0,
                    "success": True,
                    "error": None,
                    "during_answer": False,
                }
            ]
            results.append(
                {
                    "id": c_id,
                    "status": "audio_fed_detector_untested",
                    "simulated": True,
                    "detector_expectation": "not_applicable_service_only",
                    "note": "Detection logic is native-only and not exercised in service replay.",
                    "start_time": start_ts,
                    "end_time": iso_now(),
                    "feed_samples": sim_samples,
                    "terminal_kind": "not_applicable",
                    "seen_done": False,
                    "feed_continued_during_answer": "simulated",
                }
            )
            continue

        if is_audio and c_id == "rapid_pair":
            q1_ttft = 450.0
            q2_ttft = 480.0
            simulated_ttfts.extend([q1_ttft, q2_ttft])
            simulated_feed_latencies.extend([22.0, 24.0, 23.5])
            results.append(
                {
                    "id": "rapid_pair",
                    "status": "simulated_pass",
                    "simulated": True,
                    "detector_queue_note": "Service replay exercises sequential answer streaming for both distinct questions. Detector/backpressure queueing (1 active + 1 waiting) is native-only and not proven by service replay.",
                    "start_time": start_ts,
                    "end_time": iso_now(),
                    "feed_samples": [
                        {
                            "request_start_ts": iso_now(),
                            "request_end_ts": iso_now(),
                            "source": "them",
                            "latency_ms": 22.0,
                            "success": True,
                            "error": None,
                            "during_answer": False,
                        },
                        {
                            "request_start_ts": iso_now(),
                            "request_end_ts": iso_now(),
                            "source": "me",
                            "latency_ms": 24.0,
                            "success": True,
                            "error": None,
                            "during_answer": True,
                        },
                    ],
                    "q1": {
                        "question": c["question"],
                        "terminal_kind": "done",
                        "seen_done": True,
                        "ttft_ms": q1_ttft,
                        "answer_text": "- Grounded in 9102",
                        "feed_continued_during_answer": "simulated",
                    },
                    "q2": {
                        "question": c.get("rapid_second_question", {}).get(
                            "question", ""
                        ),
                        "terminal_kind": "done",
                        "seen_done": True,
                        "ttft_ms": q2_ttft,
                        "answer_text": "- Grounded in 50 connections",
                        "feed_continued_during_answer": "simulated",
                    },
                    "feed_continued_during_answer": "simulated",
                }
            )
            continue

        if is_audio:
            sim_lat = 18.5 + (len(c_id) % 7) * 2.1
            simulated_feed_latencies.append(sim_lat)
            sim_ttft = 420.0 + (len(c["question"]) % 15) * 18.0
            simulated_ttfts.append(sim_ttft)
            case_status = "simulated_pass"
            term = "done"
            seen_done = True
            ans_text = f"- Dry run answer grounded in {c.get('required_phrase', 'synthetic data')}"
            if c.get("required_prefix"):
                ans_text = f"- {c['required_prefix']}\n- Simulated suggestion."
            samples = [
                {
                    "request_start_ts": iso_now(),
                    "request_end_ts": iso_now(),
                    "source": "them",
                    "latency_ms": sim_lat,
                    "success": True,
                    "error": None,
                    "during_answer": False,
                },
                {
                    "request_start_ts": iso_now(),
                    "request_end_ts": iso_now(),
                    "source": "me",
                    "latency_ms": sim_lat + 2.0,
                    "success": True,
                    "error": None,
                    "during_answer": True,
                },
            ]
        else:
            case_status = "skipped_non_audio"
            term = "not_run"
            seen_done = False
            ans_text = ""
            sim_ttft = None
            samples = []

        results.append(
            {
                "id": c_id,
                "status": case_status,
                "simulated": True,
                "audio_participated": is_audio,
                "start_time": start_ts,
                "end_time": iso_now(),
                "feed_samples": samples,
                "terminal_kind": term,
                "seen_done": seen_done,
                "ttft_ms": sim_ttft,
                "answer_text": ans_text,
                "feed_continued_during_answer": "simulated" if is_audio else None,
            }
        )

    feed_stats = compute_percentiles(simulated_feed_latencies)
    ttft_stats = compute_percentiles(simulated_ttfts)

    return {
        "status": "dry_run",
        "simulated": True,
        "timestamp": iso_now(),
        "environment": {
            "os": platform.platform(),
            "hardware": platform.machine(),
            "python_version": platform.python_version(),
            "service_host": "dry-run (offline)",
            "model": "dry-run-simulator",
            "cold_warm_state": "simulated_warm",
        },
        "summary": {
            "total_cases": len(cases),
            "eligible_replay_cases": sum(1 for c in cases if c.get("audio_replay")),
            "simulated_cases": len(cases),
            "executed_cases": 0,
            "passed_cases": 0,
            "failed_cases": 0,
            "simulated_feed_latencies_count": len(simulated_feed_latencies),
            "simulated_live_feed_p50_ms": feed_stats["p50"],
            "simulated_live_feed_p95_ms": feed_stats["p95"],
            "simulated_live_feed_max_ms": feed_stats["max"],
            "simulated_answer_ttft_p50_ms": ttft_stats["p50"],
            "simulated_answer_ttft_p95_ms": ttft_stats["p95"],
            "feed_continued_during_answer": "simulated",
            "note": "Dry run values are explicitly simulated and not measured evidence.",
        },
        "cases": results,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="E1a Service Replay Harness for Realtime Copilot v2 (macOS / loopback only)."
    )
    parser.add_argument(
        "--service-url",
        default="http://127.0.0.1:9876",
        help="Loopback base URL of the Python service (default: http://127.0.0.1:9876)",
    )
    parser.add_argument(
        "--manifest",
        default="python-service/tests/fixtures/copilot/manifest.json",
        help="Path to the synthetic fixture manifest JSON",
    )
    parser.add_argument(
        "--output",
        default=".recon/realtime-copilot-20260905/e1a-results.json",
        help="Path to write the resulting JSON report",
    )
    parser.add_argument(
        "--model",
        default=None,
        help="Exact Local LLM model identifier (required for live replay evidence)",
    )
    parser.add_argument(
        "--llm-base-url",
        default="http://127.0.0.1:11434",
        help="Registered loopback base URL for the local engine (default Ollama: http://127.0.0.1:11434; override for app-managed Ollama or Rapid-MLX)",
    )
    parser.add_argument(
        "--llm-api-key-env",
        default=None,
        help="Name of environment variable containing the local LLM API key (if needed)",
    )
    parser.add_argument(
        "--cadence-ms",
        type=int,
        default=500,
        help="Interval between /live_feed chunks in milliseconds (must be > 0, default: 500)",
    )
    parser.add_argument(
        "--warmup",
        action="store_true",
        help="Send a short warmup audio chunk to /live_feed prior to testing (note: does not warm the LLM answer model, which is probed separately)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Run harness in dry-run mode without connecting to the service",
    )

    args = parser.parse_args()

    # Item 8: Validate cadence-ms > 0
    if args.cadence_ms <= 0:
        print(
            f"[REPLAY ERROR] --cadence-ms must be greater than 0, got: {args.cadence_ms}",
            file=sys.stderr,
        )
        return 1

    # 1. URL and Security Validation
    try:
        validate_loopback_url(args.service_url, "--service-url")
        if args.llm_base_url:
            validate_loopback_url(args.llm_base_url, "--llm-base-url")
    except ValueError as exc:
        print(f"[REPLAY ERROR] Security/Validation failure: {exc}", file=sys.stderr)
        return 1

    secrets_to_redact: list[str] = []
    local_api_key: str | None = None
    if args.llm_api_key_env:
        val = os.environ.get(args.llm_api_key_env, "").strip()
        if val:
            local_api_key = val
            secrets_to_redact.append(val)

    # 2. Manifest Loading
    manifest_path = Path(args.manifest)
    if not manifest_path.is_file():
        print(
            f"[REPLAY ERROR] Manifest file not found: {manifest_path}",
            file=sys.stderr,
        )
        return 1

    try:
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest_data = json.load(f)
    except Exception as exc:
        print(f"[REPLAY ERROR] Failed to parse manifest: {exc}", file=sys.stderr)
        return 1

    output_path = Path(args.output)

    # 3. Dry-Run Execution
    if args.dry_run:
        print("[REPLAY] Running in dry-run mode...")
        report = run_dry_run(manifest_data)
        safe_report = redact_secrets(report, secrets_to_redact)
        write_json_atomically(output_path, safe_report)
        print(f"[REPLAY] Dry-run report written atomically to: {output_path}")
        return 0

    # Replace any prior result before the first network request. Health and
    # model-readiness probing are part of live execution and may be interrupted.
    initial_running = {
        "status": "running",
        "timestamp": iso_now(),
        "environment": {
            "os": platform.platform(),
            "hardware": platform.machine(),
            "python_version": platform.python_version(),
            "service_host": urllib.parse.urlsplit(args.service_url).netloc,
            "model": args.model.strip()
            if isinstance(args.model, str) and args.model.strip()
            else "not_supplied",
            "cold_warm_state": "checking_service_and_model",
        },
        "summary": {"status": "running"},
        "cases": [],
    }
    write_json_atomically(
        output_path, redact_secrets(initial_running, secrets_to_redact)
    )

    # 4. Service Health Check
    try:
        service_healthy, health_msg = check_service_health(args.service_url)
    except KeyboardInterrupt:
        interrupted_report = {
            "status": "interrupted",
            "reason": "Execution interrupted by SIGINT during service readiness",
            "timestamp": iso_now(),
            "summary": {"status": "interrupted"},
            "cases": [],
        }
        write_json_atomically(
            output_path, redact_secrets(interrupted_report, secrets_to_redact)
        )
        return 130
    except Exception as exc:
        safe_error = redact_secrets(str(exc), secrets_to_redact)
        error_report = {
            "status": "error",
            "error": safe_error,
            "timestamp": iso_now(),
            "summary": {"status": "error"},
            "cases": [],
        }
        write_json_atomically(output_path, error_report)
        print(f"[REPLAY ERROR] Service readiness failed: {safe_error}", file=sys.stderr)
        return 1
    if not service_healthy:
        print(f"[REPLAY] Local service unavailable at {args.service_url}: {health_msg}")
        print("[REPLAY] Recording structured skipped result...")
        skipped_report = {
            "status": "skipped",
            "skip_reason": f"Service unavailable at {args.service_url}: {health_msg}",
            "timestamp": iso_now(),
            "environment": {
                "os": platform.platform(),
                "hardware": platform.machine(),
                "python_version": platform.python_version(),
                "service_host": urllib.parse.urlsplit(args.service_url).netloc,
                "model": args.model or "unconfigured",
                "cold_warm_state": "cold",
            },
            "summary": {
                "total_cases": len(manifest_data.get("cases", [])),
                "eligible_replay_cases": sum(
                    1 for c in manifest_data.get("cases", []) if c.get("audio_replay")
                ),
                "executed_cases": 0,
                "passed_cases": 0,
                "failed_cases": 0,
                "total_feed_samples": 0,
            },
            "cases": [],
        }
        safe_skipped = redact_secrets(skipped_report, secrets_to_redact)
        write_json_atomically(output_path, safe_skipped)
        print(f"[REPLAY] Skipped report written to: {output_path}")
        return 0

    if not isinstance(args.model, str) or not args.model.strip():
        model_error = {
            "status": "invalid",
            "reason": "--model is required for reproducible live replay evidence",
            "timestamp": iso_now(),
            "environment": {
                "os": platform.platform(),
                "hardware": platform.machine(),
                "python_version": platform.python_version(),
                "service_host": urllib.parse.urlsplit(args.service_url).netloc,
                "model": "not_supplied",
                "cold_warm_state": "service_ready_model_not_checked",
            },
            "summary": {"status": "invalid", "executed_cases": 0},
            "cases": [],
        }
        write_json_atomically(
            output_path, redact_secrets(model_error, secrets_to_redact)
        )
        print(
            "[REPLAY ERROR] --model is required for reproducible live replay evidence",
            file=sys.stderr,
        )
        return 1
    args.model = args.model.strip()

    # 5. Model Readiness Probe Check (Consumes full stream)
    try:
        model_ready, model_msg = check_local_model_readiness(
            args.service_url,
            model=args.model,
            llm_base_url=args.llm_base_url,
            llm_api_key=local_api_key,
        )
    except KeyboardInterrupt:
        interrupted_report = {
            "status": "interrupted",
            "reason": "Execution interrupted by SIGINT during model readiness",
            "timestamp": iso_now(),
            "summary": {"status": "interrupted"},
            "cases": [],
        }
        write_json_atomically(
            output_path, redact_secrets(interrupted_report, secrets_to_redact)
        )
        return 130
    except Exception as exc:
        safe_error = redact_secrets(str(exc), secrets_to_redact)
        error_report = {
            "status": "error",
            "error": safe_error,
            "timestamp": iso_now(),
            "summary": {"status": "error"},
            "cases": [],
        }
        write_json_atomically(output_path, error_report)
        print(f"[REPLAY ERROR] Model readiness failed: {safe_error}", file=sys.stderr)
        return 1
    if not model_ready:
        print(f"[REPLAY] Local model engine not ready via service route: {model_msg}")
        print("[REPLAY] Recording structured overall skip...")
        skipped_model_report = {
            "status": "skipped",
            "skip_reason": f"Local model unavailable via service route: {model_msg}",
            "timestamp": iso_now(),
            "environment": {
                "os": platform.platform(),
                "hardware": platform.machine(),
                "python_version": platform.python_version(),
                "service_host": urllib.parse.urlsplit(args.service_url).netloc,
                "model": args.model,
                "cold_warm_state": "cold",
            },
            "summary": {
                "total_cases": len(manifest_data.get("cases", [])),
                "eligible_replay_cases": sum(
                    1 for c in manifest_data.get("cases", []) if c.get("audio_replay")
                ),
                "executed_cases": 0,
                "passed_cases": 0,
                "failed_cases": 0,
                "total_feed_samples": 0,
            },
            "cases": [],
        }
        safe_skipped_model = redact_secrets(skipped_model_report, secrets_to_redact)
        write_json_atomically(output_path, safe_skipped_model)
        print(f"[REPLAY] Skipped report written to: {output_path}")
        return 0

    # Record the readiness transition before the replay cases start.
    initial_running = {
        "status": "running",
        "timestamp": iso_now(),
        "environment": {
            "os": platform.platform(),
            "hardware": platform.machine(),
            "python_version": platform.python_version(),
            "service_host": urllib.parse.urlsplit(args.service_url).netloc,
            "model": args.model,
            "cold_warm_state": "warmed_by_readiness_probe",
        },
        "summary": {"status": "running"},
        "cases": [],
    }
    write_json_atomically(
        output_path, redact_secrets(initial_running, secrets_to_redact)
    )

    try:
        # 6. Live Replay Execution
        print(
            f"[REPLAY] Service healthy and model warmed by readiness probe. Starting live replay against {args.service_url}..."
        )
        all_feed_samples: list[dict[str, Any]] = []
        answer_ttfts: list[float] = []
        case_results: list[dict[str, Any]] = []
        had_tts_skip = False

        with tempfile.TemporaryDirectory(prefix="copilot_e2e_") as tmpdir:
            temp_dir_path = Path(tmpdir)
            session_epoch = int(time.time())

            # Optional /live_feed warmup
            if args.warmup:
                warmup_silence = temp_dir_path / "warmup_silence.wav"
                create_silence_wav(warmup_silence, 0.5)
                s_warm = post_live_feed_chunk(
                    args.service_url, warmup_silence, session_epoch
                )
                all_feed_samples.append(s_warm)

            cases = manifest_data.get("cases", [])
            for case in cases:
                c_id = case["id"]
                is_audio = case.get("audio_replay", False)
                case_start_ts = iso_now()
                case_samples: list[dict[str, Any]] = []

                if not is_audio:
                    case_results.append(
                        {
                            "id": c_id,
                            "status": "skipped_audio",
                            "reason": "Case does not participate in audio replay",
                            "start_time": case_start_ts,
                            "end_time": iso_now(),
                            "feed_samples": [],
                        }
                    )
                    continue

                # Tag Question handling
                if c_id == "tag_question":
                    print(
                        "[REPLAY] Feeding audio for tag_question (detection out of scope for service replay)"
                    )
                    wav_file = temp_dir_path / f"{c_id}.wav"
                    tts_ok = generate_tts_wav(case["question"], wav_file, temp_dir_path)
                    if not tts_ok:
                        had_tts_skip = True
                        case_results.append(
                            {
                                "id": c_id,
                                "status": "skipped_tts",
                                "reason": "TTS synthesis failed for tag_question",
                                "start_time": case_start_ts,
                                "end_time": iso_now(),
                                "feed_samples": [],
                            }
                        )
                        continue

                    chunks = slice_wav_into_chunks(
                        wav_file,
                        temp_dir_path,
                        step_seconds=args.cadence_ms / 1000.0,
                    )
                    tag_samples = post_live_feed_chunks(
                        args.service_url,
                        chunks,
                        session_epoch,
                        "them",
                        args.cadence_ms,
                    )
                    case_samples.extend(tag_samples)
                    all_feed_samples.extend(tag_samples)

                    # Every scheduled foreground feed must succeed. A partial
                    # ingest cannot establish detector readiness.
                    feed_ok = all_feed_samples_succeeded(case_samples)
                    case_results.append(
                        {
                            "id": c_id,
                            "status": (
                                "audio_fed_detector_untested" if feed_ok else "failed"
                            ),
                            "detector_expectation": "not_applicable_service_only",
                            "note": "Detection logic is native-only and not exercised in service replay.",
                            "start_time": case_start_ts,
                            "end_time": iso_now(),
                            "feed_samples": case_samples,
                        }
                    )
                    continue

                # Rapid Pair handling (both Q1 and Q2)
                if c_id == "rapid_pair":
                    print(
                        "[REPLAY] Executing rapid_pair: testing sequential continuity for both distinct questions"
                    )
                    wav_file1 = temp_dir_path / f"{c_id}_q1.wav"
                    wav_file2 = temp_dir_path / f"{c_id}_q2.wav"
                    tts1 = generate_tts_wav(case["question"], wav_file1, temp_dir_path)
                    q2_data = case.get("rapid_second_question", {})
                    tts2 = generate_tts_wav(
                        q2_data.get("question", ""), wav_file2, temp_dir_path
                    )

                    if not tts1 or not tts2:
                        had_tts_skip = True
                        case_results.append(
                            {
                                "id": c_id,
                                "status": "skipped_tts",
                                "reason": "TTS synthesis failed for rapid_pair",
                                "start_time": case_start_ts,
                                "end_time": iso_now(),
                                "feed_samples": [],
                            }
                        )
                        continue

                    # Feed audio for Q1
                    chunks1 = slice_wav_into_chunks(
                        wav_file1,
                        temp_dir_path,
                        step_seconds=args.cadence_ms / 1000.0,
                    )
                    q1_feed_samples = post_live_feed_chunks(
                        args.service_url,
                        chunks1,
                        session_epoch,
                        "them",
                        args.cadence_ms,
                    )
                    case_samples.extend(q1_feed_samples)
                    all_feed_samples.extend(q1_feed_samples)

                    # Stream Q1 with concurrent background feed
                    payload1 = {
                        "provider": "local",
                        "question": case["question"],
                        "context_turns": case.get("context_turns", []),
                        "passages": case.get("passages", []),
                        "model": args.model,
                        "llm_base_url": args.llm_base_url,
                        "llm_api_key": local_api_key,
                    }
                    stream_res1, bg_samples1 = execute_answer_with_background_feed(
                        args.service_url,
                        payload1,
                        temp_dir_path,
                        session_epoch,
                        args.cadence_ms,
                        timeout=20.0,
                    )
                    case_samples.extend(bg_samples1)
                    all_feed_samples.extend(bg_samples1)
                    if stream_res1["ttft_ms"] is not None:
                        answer_ttfts.append(stream_res1["ttft_ms"])

                    # Feed audio for Q2
                    chunks2 = slice_wav_into_chunks(
                        wav_file2,
                        temp_dir_path,
                        step_seconds=args.cadence_ms / 1000.0,
                    )
                    q2_feed_samples = post_live_feed_chunks(
                        args.service_url,
                        chunks2,
                        session_epoch,
                        "them",
                        args.cadence_ms,
                    )
                    case_samples.extend(q2_feed_samples)
                    all_feed_samples.extend(q2_feed_samples)

                    # Stream Q2 with concurrent background feed
                    payload2 = {
                        "provider": "local",
                        "question": q2_data.get("question", ""),
                        "context_turns": q2_data.get("context_turns", []),
                        "passages": q2_data.get("passages", []),
                        "model": args.model,
                        "llm_base_url": args.llm_base_url,
                        "llm_api_key": local_api_key,
                    }
                    stream_res2, bg_samples2 = execute_answer_with_background_feed(
                        args.service_url,
                        payload2,
                        temp_dir_path,
                        session_epoch,
                        args.cadence_ms,
                        timeout=20.0,
                    )
                    case_samples.extend(bg_samples2)
                    all_feed_samples.extend(bg_samples2)
                    if stream_res2["ttft_ms"] is not None:
                        answer_ttfts.append(stream_res2["ttft_ms"])

                    # Item 5: Centralized validation for both Q1 and Q2
                    q1_valid, q1_reasons = validate_answer_result(stream_res1, case)
                    q2_valid, q2_reasons = validate_answer_result(stream_res2, q2_data)

                    fg_errors = sum(
                        1
                        for s in case_samples
                        if not s["during_answer"] and not s["success"]
                    )
                    bg1_during = [s for s in bg_samples1 if s["during_answer"]]
                    bg1_ok = (
                        len([s for s in bg1_during if s["success"]]) >= 1
                        and len([s for s in bg1_during if not s["success"]]) == 0
                    )
                    bg2_during = [s for s in bg_samples2 if s["during_answer"]]
                    bg2_ok = (
                        len([s for s in bg2_during if s["success"]]) >= 1
                        and len([s for s in bg2_during if not s["success"]]) == 0
                    )
                    pair_continuity = bg1_ok and bg2_ok

                    pair_passed = (
                        (fg_errors == 0) and pair_continuity and q1_valid and q2_valid
                    )

                    case_results.append(
                        {
                            "id": c_id,
                            "status": "passed" if pair_passed else "failed",
                            "detector_queue_note": "Service replay exercises sequential answer streaming for both distinct questions. Detector/backpressure queueing (1 active + 1 waiting) is native-only and not proven by service replay.",
                            "start_time": case_start_ts,
                            "end_time": iso_now(),
                            "feed_samples": case_samples,
                            "feed_continued_during_answer": pair_continuity,
                            "q1": {
                                "question": case["question"],
                                "answer_start_ts": stream_res1["answer_start_ts"],
                                "answer_first_token_ts": stream_res1[
                                    "answer_first_token_ts"
                                ],
                                "answer_end_ts": stream_res1["answer_end_ts"],
                                "terminal_kind": stream_res1["terminal_kind"],
                                "seen_done": stream_res1["seen_done"],
                                "ttft_ms": stream_res1["ttft_ms"],
                                "answer_text": stream_res1["full_text"],
                                "usage": stream_res1["usage"],
                                "valid": q1_valid,
                                "reasons": q1_reasons,
                                "feed_continued_during_answer": bg1_ok,
                            },
                            "q2": {
                                "question": q2_data.get("question", ""),
                                "answer_start_ts": stream_res2["answer_start_ts"],
                                "answer_first_token_ts": stream_res2[
                                    "answer_first_token_ts"
                                ],
                                "answer_end_ts": stream_res2["answer_end_ts"],
                                "terminal_kind": stream_res2["terminal_kind"],
                                "seen_done": stream_res2["seen_done"],
                                "ttft_ms": stream_res2["ttft_ms"],
                                "answer_text": stream_res2["full_text"],
                                "usage": stream_res2["usage"],
                                "valid": q2_valid,
                                "reasons": q2_reasons,
                                "feed_continued_during_answer": bg2_ok,
                            },
                        }
                    )
                    continue

                # Standard Replay Case
                print(f"[REPLAY] Executing case: {c_id}")
                wav_file = temp_dir_path / f"{c_id}.wav"
                tts_ok = generate_tts_wav(case["question"], wav_file, temp_dir_path)
                if not tts_ok:
                    had_tts_skip = True
                    case_results.append(
                        {
                            "id": c_id,
                            "status": "skipped_tts",
                            "reason": "TTS synthesis failed or tools unavailable",
                            "start_time": case_start_ts,
                            "end_time": iso_now(),
                            "feed_samples": [],
                        }
                    )
                    continue

                chunks = slice_wav_into_chunks(
                    wav_file,
                    temp_dir_path,
                    step_seconds=args.cadence_ms / 1000.0,
                )

                # Feed speech chunks and the VAD flush on one cadence.
                silence_wav = temp_dir_path / f"{c_id}_silence.wav"
                foreground_samples = post_live_feed_chunks_with_vad_flush(
                    args.service_url,
                    chunks,
                    silence_wav,
                    session_epoch,
                    "them",
                    args.cadence_ms,
                )
                case_samples.extend(foreground_samples)
                all_feed_samples.extend(foreground_samples)

                # Prepare answer request
                answer_payload = {
                    "provider": "local",
                    "question": case["question"],
                    "context_turns": case.get("context_turns", []),
                    "passages": case.get("passages", []),
                    "model": args.model,
                    "llm_base_url": args.llm_base_url,
                    "llm_api_key": local_api_key,
                }

                # Execute answer stream with background feed
                stream_res, bg_samples = execute_answer_with_background_feed(
                    args.service_url,
                    answer_payload,
                    temp_dir_path,
                    session_epoch,
                    args.cadence_ms,
                    timeout=20.0,
                )
                case_samples.extend(bg_samples)
                all_feed_samples.extend(bg_samples)

                if stream_res["ttft_ms"] is not None:
                    answer_ttfts.append(stream_res["ttft_ms"])

                # Centralized answer validation
                ans_valid, failure_reasons = validate_answer_result(stream_res, case)

                fg_errors = sum(
                    1
                    for s in case_samples
                    if not s["during_answer"] and not s["success"]
                )
                bg_during = [s for s in case_samples if s["during_answer"]]
                bg_success_count = sum(1 for s in bg_during if s["success"])
                bg_error_count = sum(1 for s in bg_during if not s["success"])
                continuity_ok = (bg_success_count >= 1) and (bg_error_count == 0)

                if fg_errors > 0:
                    ans_valid = False
                    failure_reasons.append(f"Foreground feed had {fg_errors} error(s)")

                if not continuity_ok:
                    ans_valid = False
                    failure_reasons.append(
                        f"Background feed continuity failed (successes={bg_success_count}, errors={bg_error_count})"
                    )

                case_results.append(
                    {
                        "id": c_id,
                        "status": "passed" if ans_valid else "failed",
                        "failure_reasons": failure_reasons,
                        "start_time": case_start_ts,
                        "end_time": iso_now(),
                        "answer_start_ts": stream_res["answer_start_ts"],
                        "answer_first_token_ts": stream_res["answer_first_token_ts"],
                        "answer_end_ts": stream_res["answer_end_ts"],
                        "feed_samples": case_samples,
                        "feed_continued_during_answer": continuity_ok,
                        "terminal_kind": stream_res["terminal_kind"],
                        "seen_done": stream_res["seen_done"],
                        "ttft_ms": stream_res["ttft_ms"],
                        "total_time_ms": stream_res["total_time_ms"],
                        "answer_text": stream_res["full_text"],
                        "usage": stream_res["usage"],
                    }
                )

        # Aggregate telemetry statistics
        all_latencies = [
            s["latency_ms"] for s in all_feed_samples if s["latency_ms"] is not None
        ]
        feed_stats = compute_percentiles(all_latencies)
        ttft_stats = compute_percentiles(answer_ttfts)

        passed_count = sum(1 for c in case_results if c.get("status") == "passed")
        failed_count = sum(1 for c in case_results if c.get("status") == "failed")
        total_fg_samples = sum(1 for s in all_feed_samples if not s["during_answer"])
        total_bg_samples = sum(1 for s in all_feed_samples if s["during_answer"])
        total_success_samples = sum(1 for s in all_feed_samples if s["success"])
        total_error_samples = sum(1 for s in all_feed_samples if not s["success"])

        overall_continuity = aggregate_feed_continuity(case_results)

        # Item 7: A partial eligible replay cannot report overall passed
        overall_status = aggregate_live_status(
            had_tts_skip=had_tts_skip,
            failed_count=failed_count,
            passed_count=passed_count,
            total_error_samples=total_error_samples,
        )

        final_report = {
            "status": overall_status,
            "timestamp": iso_now(),
            "environment": {
                "os": platform.platform(),
                "hardware": platform.machine(),
                "python_version": platform.python_version(),
                "service_host": urllib.parse.urlsplit(args.service_url).netloc,
                "model": args.model,
                "cold_warm_state": "warmed_by_readiness_probe",
            },
            "summary": {
                "total_cases": len(manifest_data.get("cases", [])),
                "eligible_replay_cases": sum(
                    1 for c in manifest_data.get("cases", []) if c.get("audio_replay")
                ),
                "executed_cases": len(
                    [c for c in case_results if c.get("status") in {"passed", "failed"}]
                ),
                "passed_cases": passed_count,
                "failed_cases": failed_count,
                "had_tts_skip": had_tts_skip,
                "total_feed_samples": len(all_feed_samples),
                "foreground_feed_samples": total_fg_samples,
                "background_feed_samples": total_bg_samples,
                "successful_feed_samples": total_success_samples,
                "failed_feed_samples": total_error_samples,
                "live_feed_p50_ms": feed_stats["p50"],
                "live_feed_p95_ms": feed_stats["p95"],
                "live_feed_max_ms": feed_stats["max"],
                "answer_ttft_p50_ms": ttft_stats["p50"],
                "answer_ttft_p95_ms": ttft_stats["p95"],
                "answer_ttft_samples": ttft_stats["count"],
                "feed_continued_during_answer": overall_continuity,
            },
            "cases": case_results,
        }

        safe_final = redact_secrets(final_report, secrets_to_redact)
        write_json_atomically(output_path, safe_final)
        print(f"[REPLAY] Report written atomically to: {output_path}")
        return 0 if final_report["status"] == "passed" else 1

    except KeyboardInterrupt:
        print("\n[REPLAY ERROR] Execution interrupted by user (SIGINT)")
        interrupted_report = {
            "status": "interrupted",
            "reason": "Execution interrupted by SIGINT",
            "timestamp": iso_now(),
            "environment": {
                "os": platform.platform(),
                "hardware": platform.machine(),
                "python_version": platform.python_version(),
            },
            "summary": {"status": "interrupted"},
            "cases": [],
        }
        write_json_atomically(
            output_path, redact_secrets(interrupted_report, secrets_to_redact)
        )
        return 130
    except Exception as exc:
        print(f"[REPLAY ERROR] Unexpected live-run error: {exc}", file=sys.stderr)
        error_report = {
            "status": "error",
            "error": redact_secrets(str(exc), secrets_to_redact),
            "timestamp": iso_now(),
            "environment": {
                "os": platform.platform(),
                "hardware": platform.machine(),
                "python_version": platform.python_version(),
            },
            "summary": {"status": "error"},
            "cases": [],
        }
        write_json_atomically(
            output_path, redact_secrets(error_report, secrets_to_redact)
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
