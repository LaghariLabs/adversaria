"""Cloud (BYO-key) transcription path — downsamples each channel to 16 kHz mono,
chunks under the provider's upload cap, uploads to an OpenAI-compatible
/audio/transcriptions endpoint, and merges Me/Them. httpx is monkeypatched so no
network call is made; real (tiny) WAVs are written so the PyAV decode runs."""

import wave

import httpx
import numpy as np
import pytest
from scipy.io import wavfile

import src.transcriber as tmod
from src.transcriber import transcribe_cloud


class _FakeResp:
    def __init__(self, payload):
        self._p = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._p


def _write_float_wav(path, seconds=0.4, rate=48000, channels=2):
    """Write a real WAV mimicking capture (48 kHz stereo 32-bit float by default)
    so transcribe_cloud's PyAV decode + resample actually runs."""
    n = int(seconds * rate)
    rng = np.random.default_rng(0)
    data = (rng.standard_normal((n, channels)) * 0.01).astype(np.float32)
    if channels == 1:
        data = data[:, 0]
    wavfile.write(str(path), rate, data)


def test_transcribe_cloud_merges_channels(monkeypatch, tmp_path):
    sys_wav = tmp_path / "system.wav"
    _write_float_wav(sys_wav, seconds=0.4, rate=48000, channels=2)
    mic_wav = tmp_path / "mic.wav"
    _write_float_wav(mic_wav, seconds=0.4, rate=44100, channels=1)

    calls = []

    def fake_post(url, headers=None, files=None, data=None, timeout=None):
        calls.append((url, data["model"], "Authorization" in (headers or {})))
        name = files["file"][0]
        if "mic" in name:
            return _FakeResp({"segments": [{"start": 1.0, "text": "Hi from me."}]})
        return _FakeResp(
            {
                "segments": [
                    {"start": 0.0, "text": "Hello from them."},
                    {"start": 2.0, "text": "More them."},
                ],
            }
        )

    monkeypatch.setattr(httpx, "post", fake_post)

    res = transcribe_cloud(
        str(sys_wav), str(mic_wav),
        "https://api.groq.com/openai/v1/", "gsk_test", "whisper-large-v3",
    )

    # endpoint, model, and bearer auth are built correctly (trailing slash handled)
    assert calls[0][0] == "https://api.groq.com/openai/v1/audio/transcriptions"
    assert calls[0][1] == "whisper-large-v3"
    assert calls[0][2] is True
    # both channels merged, interleaved by start time, labeled Me/Them
    assert res.text == "Them: Hello from them.\nMe: Hi from me.\nThem: More them."
    # duration now reflects the decoded 16 kHz mono audio, not a server field
    assert res.duration_seconds == pytest.approx(0.4, abs=0.1)


def test_transcribe_cloud_system_only(monkeypatch, tmp_path):
    sys_wav = tmp_path / "system.wav"
    _write_float_wav(sys_wav, seconds=0.3, rate=48000, channels=2)

    def fake_post(url, headers=None, files=None, data=None, timeout=None):
        return _FakeResp({"segments": [{"start": 0.0, "text": "Solo."}]})

    monkeypatch.setattr(httpx, "post", fake_post)

    res = transcribe_cloud(str(sys_wav), None, "https://x/v1", "", "whisper-large-v3")
    assert res.text == "Them: Solo."


def test_write_wav_chunks_splits_under_limit(tmp_path):
    """A large mono-16k buffer is split into multiple WAVs, each under the byte
    cap, with correct time offsets and lossless reconstruction."""
    samples = np.arange(100_000, dtype=np.int16)  # 200 KB of PCM
    limit = 50_000
    chunks = tmod._write_wav_chunks(samples, "system", str(tmp_path), limit)

    assert len(chunks) > 1  # actually splits
    rebuilt = []
    for i, (path, offset) in enumerate(chunks):
        assert __import__("os").path.getsize(path) <= limit  # each file under cap
        with wave.open(path, "rb") as w:
            assert w.getnchannels() == 1
            assert w.getframerate() == 16000
            rebuilt.append(
                np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
            )
        # offset of chunk i = (samples before it) / rate
        expected_offset = sum(len(b) for b in rebuilt[:-1]) / 16000
        assert offset == pytest.approx(expected_offset)

    assert np.array_equal(np.concatenate(rebuilt), samples)  # lossless


def test_transcribe_cloud_chunks_long_audio(monkeypatch, tmp_path):
    """A recording too large for one upload is split into chunks; each chunk's
    segments are offset back onto the full timeline before merging (so long
    meetings don't 413)."""
    # 3 s of 16 kHz mono → ~48000 samples; force a tiny cap so it splits.
    sys_wav = tmp_path / "system.wav"
    with wave.open(str(sys_wav), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(np.zeros(48_000, dtype=np.int16).tobytes())
    monkeypatch.setattr(tmod, "_CLOUD_MAX_UPLOAD_BYTES", 60_000)  # ~27000 samples/chunk

    seq = iter(["first", "second", "third"])

    def fake_post(url, headers=None, files=None, data=None, timeout=None):
        return _FakeResp({"segments": [{"start": 0.0, "text": next(seq)}]})

    monkeypatch.setattr(httpx, "post", fake_post)

    res = transcribe_cloud(str(sys_wav), None, "https://x/v1", "k", "whisper-large-v3")

    # split into 2 chunks (27000 + 21000 samples); both uploaded and merged in
    # timeline order (consecutive same-speaker segments join onto one line).
    assert res.text == "Them: first second"
    assert res.duration_seconds == pytest.approx(3.0, abs=0.05)
