//! Dual audio capture: system audio ("Them") + microphone ("Me").
//!
//! The public surface (`AudioCapture`, `RecordingPaths`) is identical on every
//! platform so `commands.rs` is platform-agnostic. Only the capture mechanism
//! differs:
//! - **Windows** (`wasapi`): WASAPI loopback for system audio + WASAPI capture
//!   for the mic.
//! - **macOS** (`macos`): Core Audio process tap for system audio + cpal for the mic.
//!
//! Both implementations share the WAV writer, the live-caption delta snapshot,
//! and the `StreamState` accumulator below. Mic capture is always best-effort: a
//! missing or failing microphone falls back to system audio only and never
//! aborts the recording.

use std::collections::VecDeque;
use std::fs::OpenOptions;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Mutex};

use crate::recording_spool::{self, AudioFormat, Frame, StreamWriter};

type WriterFailure = Arc<Mutex<Option<String>>>;

#[cfg(windows)]
mod wasapi;
#[cfg(windows)]
pub use wasapi::AudioCapture;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::{probe_system_audio, AudioCapture};

/// WASAPI loopback has no permission gate, so the permission probe is a no-op.
#[cfg(not(target_os = "macos"))]
pub fn probe_system_audio() -> Result<bool, String> {
    Ok(true)
}

/// WAV format tag for integer PCM samples.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) const WAV_FORMAT_PCM: u16 = 1;
/// WAV format tag for IEEE float samples (WASAPI shared mode + Core Audio tap).
pub(crate) const WAV_FORMAT_IEEE_FLOAT: u16 = 3;

/// Paths of the WAV files produced by a finished recording.
#[derive(serde::Serialize)]
pub struct RecordingPaths {
    /// System (loopback) audio — always present.
    pub system_path: String,
    /// Microphone audio — `None` when no mic was available or capture failed.
    pub mic_path: Option<String>,
    /// Persistence/capture warning when committed encrypted audio was saved but
    /// the writer could not keep up or encountered a recoverable failure.
    pub warning: Option<String>,
}

/// Bounded rolling audio retained only for live captions and the waveform.
#[derive(Default)]
struct LiveBuffer {
    bytes: VecDeque<u8>,
    /// Absolute byte offset represented by `bytes.front()`.
    start_offset: usize,
    /// Absolute offset immediately after the newest captured byte.
    end_offset: usize,
}

/// Shared state for one capture stream (encrypted writer + live rolling buffer).
///
/// The buffer holds interleaved raw samples exactly as captured; `format_tag`
/// (1 = integer PCM, 3 = IEEE float) plus the rate/channel/bit-depth fields are
/// enough to write a correct WAV header without re-encoding.
#[derive(Clone)]
pub(crate) struct StreamState {
    live: Arc<Mutex<LiveBuffer>>,
    writer: Arc<Mutex<Option<SyncSender<Frame>>>>,
    writer_failure: Arc<Mutex<Option<WriterFailure>>>,
    pub(crate) sample_rate: Arc<Mutex<u32>>,
    pub(crate) num_channels: Arc<Mutex<u16>>,
    pub(crate) bits_per_sample: Arc<Mutex<u16>>,
    /// WAV format tag (1 = integer PCM, 3 = IEEE float).
    pub(crate) format_tag: Arc<Mutex<u16>>,
    /// Set to false by the capture thread/stream when it failed.
    pub(crate) ok: Arc<Mutex<bool>>,
}

impl StreamState {
    pub(crate) fn new() -> Self {
        Self {
            live: Arc::new(Mutex::new(LiveBuffer::default())),
            writer: Arc::new(Mutex::new(None)),
            writer_failure: Arc::new(Mutex::new(None)),
            sample_rate: Arc::new(Mutex::new(44100)),
            num_channels: Arc::new(Mutex::new(2)),
            bits_per_sample: Arc::new(Mutex::new(16)),
            format_tag: Arc::new(Mutex::new(WAV_FORMAT_PCM)),
            ok: Arc::new(Mutex::new(true)),
        }
    }

    pub(crate) fn reset(&self) {
        *self.live.lock().unwrap() = LiveBuffer::default();
        *self.writer.lock().unwrap() = None;
        *self.writer_failure.lock().unwrap() = None;
        *self.ok.lock().unwrap() = true;
    }

    pub(crate) fn attach_writer(&self, writer: &StreamWriter) {
        *self.writer.lock().unwrap() = Some(writer.sender());
        *self.writer_failure.lock().unwrap() = Some(writer.failure());
    }

    pub(crate) fn detach_writer(&self) {
        *self.writer.lock().unwrap() = None;
    }

    pub(crate) fn format(&self) -> AudioFormat {
        AudioFormat {
            sample_rate: *self.sample_rate.lock().unwrap(),
            channels: *self.num_channels.lock().unwrap(),
            bits_per_sample: *self.bits_per_sample.lock().unwrap(),
            format_tag: *self.format_tag.lock().unwrap(),
        }
    }

    /// Queue PCM for encrypted persistence and retain only a bounded live tail.
    pub(crate) fn push(&self, bytes: &[u8]) -> Result<(), String> {
        if bytes.is_empty() || !*self.ok.lock().unwrap() {
            return Ok(());
        }
        let writer = self.writer.lock().unwrap().clone();
        let failure = self.writer_failure.lock().unwrap().clone();
        if let (Some(writer), Some(failure)) = (writer, failure) {
            if let Err(error) =
                recording_spool::enqueue_frame(&writer, &failure, bytes, self.format())
            {
                *self.ok.lock().unwrap() = false;
                return Err(error);
            }
        } else {
            *self.ok.lock().unwrap() = false;
            return Err("Encrypted recording writer is not available.".to_string());
        }

        self.append_live(bytes);
        Ok(())
    }

    fn append_live(&self, bytes: &[u8]) {
        let max_live_bytes = self
            .format()
            .bytes_per_second()
            .saturating_mul(15)
            .max(64 * 1024);
        let mut live = self.live.lock().unwrap();
        live.bytes.extend(bytes);
        live.end_offset = live.end_offset.saturating_add(bytes.len());
        while live.bytes.len() > max_live_bytes {
            let remove = (live.bytes.len() - max_live_bytes).min(64 * 1024);
            live.bytes.drain(..remove);
            live.start_offset = live.start_offset.saturating_add(remove);
        }
    }

    pub(crate) fn writer_error(&self) -> Option<String> {
        if let Some(message) = self
            .writer_failure
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|value| value.lock().unwrap().clone())
        {
            return Some(message);
        }
        if !*self.ok.lock().unwrap() {
            return Some("Audio capture stopped before it could be persisted safely.".to_string());
        }
        None
    }
}

/// Write all audio captured AFTER `from_byte` to `path` as a WAV — the delta
/// feed for VAD-gated live captions. Returns `(wrote, next_offset)`: `wrote`
/// is false when there's under ~250 ms of new audio (not worth a round-trip),
/// and `next_offset` is where the NEXT call should resume. Offsets are stable
/// because the capture buffer is append-only for the life of a recording.
pub(crate) fn snapshot_since(
    state: &StreamState,
    path: &Path,
    from_byte: usize,
) -> Result<(bool, usize), String> {
    let sample_rate = *state.sample_rate.lock().unwrap();
    let num_channels = *state.num_channels.lock().unwrap();
    let bits_per_sample = *state.bits_per_sample.lock().unwrap();
    let format_tag = *state.format_tag.lock().unwrap();

    let block_align = (num_channels as usize) * (bits_per_sample as usize / 8);
    if block_align == 0 {
        return Ok((false, from_byte));
    }
    let min_new_bytes = (sample_rate as usize) * block_align / 4; // ~250 ms

    let live = state.live.lock().unwrap();
    let requested = from_byte.max(live.start_offset).min(live.end_offset);
    let mut start = requested.saturating_sub(live.start_offset);
    start -= start % block_align;
    if live.bytes.len().saturating_sub(start) < min_new_bytes {
        return Ok((false, live.start_offset + start));
    }
    let mut end = live.bytes.len();
    end -= end % block_align;
    let delta: Vec<u8> = live
        .bytes
        .iter()
        .skip(start)
        .take(end - start)
        .copied()
        .collect();
    let next_offset = live.start_offset + end;
    drop(live);

    write_wav_file(
        path,
        &delta,
        sample_rate,
        num_channels,
        bits_per_sample,
        format_tag,
    )
    .map_err(|e| format!("Failed to write live-delta WAV: {e}"))?;
    Ok((true, next_offset))
}

/// Root-mean-square amplitude (0.0..~1.0) of the most recent ~120 ms of a
/// stream's buffered audio — a cheap live "loudness" reading for the recording
/// waveform. Returns 0.0 when there's nothing buffered. Handles both IEEE-float
/// (Core Audio process tap / WASAPI shared) and 16-bit PCM samples; channels are all
/// folded together (we only want overall level).
pub(crate) fn current_rms(state: &StreamState) -> f32 {
    let sample_rate = *state.sample_rate.lock().unwrap();
    let num_channels = *state.num_channels.lock().unwrap();
    let bits_per_sample = *state.bits_per_sample.lock().unwrap();
    let format_tag = *state.format_tag.lock().unwrap();

    let bytes_per_sample = (bits_per_sample as usize) / 8;
    let block_align = (num_channels as usize) * bytes_per_sample;
    if block_align == 0 {
        return 0.0;
    }
    // ~120 ms window.
    let window_bytes = ((sample_rate as usize) * block_align / 8).max(block_align);

    let live = state.live.lock().unwrap();
    if live.bytes.is_empty() {
        return 0.0;
    }
    let mut start = live.bytes.len().saturating_sub(window_bytes);
    start -= start % bytes_per_sample.max(1); // align to a whole sample
    let tail: Vec<u8> = live.bytes.iter().skip(start).copied().collect();

    let mut sum_sq = 0.0f64;
    let mut n = 0u64;
    match (format_tag, bytes_per_sample) {
        (WAV_FORMAT_IEEE_FLOAT, 4) => {
            for c in tail.chunks_exact(4) {
                let v = f32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f64;
                sum_sq += v * v;
                n += 1;
            }
        }
        (WAV_FORMAT_PCM, 2) => {
            for c in tail.chunks_exact(2) {
                let v = (i16::from_le_bytes([c[0], c[1]]) as f64) / 32768.0;
                sum_sq += v * v;
                n += 1;
            }
        }
        _ => return 0.0,
    }
    if n == 0 {
        return 0.0;
    }
    (sum_sq / n as f64).sqrt() as f32
}

/// Write a WAV file from accumulated raw samples.
///
/// `format_tag` must be 1 (integer PCM) or 3 (IEEE float) and match the raw
/// bytes — WASAPI shared mode and the Core Audio process tap both deliver float32.
pub(crate) fn write_wav_file(
    path: &Path,
    pcm_data: &[u8],
    sample_rate: u32,
    num_channels: u16,
    bits_per_sample: u16,
    format_tag: u16,
) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    let mut writer = BufWriter::new(file);

    write_wav_header(
        &mut writer,
        pcm_data.len() as u32,
        sample_rate,
        num_channels,
        bits_per_sample,
        format_tag,
    )?;
    writer.write_all(pcm_data)?;

    writer.flush()?;
    Ok(())
}

/// Write a canonical 44-byte PCM/IEEE-float WAV header. The spool decryptor
/// uses this directly so it can stream authenticated chunks to disk without
/// ever collecting a full meeting in memory.
pub(crate) fn write_wav_header(
    writer: &mut impl Write,
    data_size: u32,
    sample_rate: u32,
    num_channels: u16,
    bits_per_sample: u16,
    format_tag: u16,
) -> std::io::Result<()> {
    let byte_rate = sample_rate * num_channels as u32 * (bits_per_sample as u32 / 8);
    let block_align = num_channels * (bits_per_sample / 8);
    let chunk_size = 36 + data_size;

    // RIFF header
    writer.write_all(b"RIFF")?;
    writer.write_all(&chunk_size.to_le_bytes())?;
    writer.write_all(b"WAVE")?;

    // fmt subchunk
    writer.write_all(b"fmt ")?;
    writer.write_all(&16u32.to_le_bytes())?; // Subchunk1Size
    writer.write_all(&format_tag.to_le_bytes())?; // AudioFormat (1 = PCM, 3 = float)
    writer.write_all(&num_channels.to_le_bytes())?;
    writer.write_all(&sample_rate.to_le_bytes())?;
    writer.write_all(&byte_rate.to_le_bytes())?;
    writer.write_all(&block_align.to_le_bytes())?;
    writer.write_all(&bits_per_sample.to_le_bytes())?;

    // data subchunk
    writer.write_all(b"data")?;
    writer.write_all(&data_size.to_le_bytes())?;
    Ok(())
}

#[cfg(test)]
mod level_tests {
    use super::*;

    fn float_stream(samples: &[f32]) -> StreamState {
        let s = StreamState::new();
        *s.format_tag.lock().unwrap() = WAV_FORMAT_IEEE_FLOAT;
        *s.bits_per_sample.lock().unwrap() = 32;
        *s.num_channels.lock().unwrap() = 1;
        *s.sample_rate.lock().unwrap() = 16000;
        let mut bytes = Vec::new();
        for v in samples {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        let mut live = s.live.lock().unwrap();
        live.end_offset = bytes.len();
        live.bytes.extend(bytes);
        drop(live);
        s
    }

    #[test]
    fn rms_of_constant_amplitude_matches() {
        // A full second of constant 0.5 → RMS 0.5.
        let s = float_stream(&vec![0.5f32; 16000]);
        let rms = current_rms(&s);
        assert!((rms - 0.5).abs() < 0.01, "expected ~0.5, got {rms}");
    }

    #[test]
    fn rms_of_silence_is_zero() {
        let s = float_stream(&vec![0.0f32; 16000]);
        assert_eq!(current_rms(&s), 0.0);
    }

    #[test]
    fn rms_of_empty_buffer_is_zero() {
        let s = float_stream(&[]);
        assert_eq!(current_rms(&s), 0.0);
    }

    #[test]
    fn live_buffer_memory_does_not_grow_with_session_duration() {
        let state = StreamState::new();
        *state.format_tag.lock().unwrap() = WAV_FORMAT_IEEE_FLOAT;
        *state.bits_per_sample.lock().unwrap() = 32;
        *state.num_channels.lock().unwrap() = 2;
        *state.sample_rate.lock().unwrap() = 48_000;
        let one_second = vec![0u8; state.format().bytes_per_second()];

        // Sixty seconds is enough to cross the retention boundary repeatedly;
        // the invariant is duration-independent, including a 60-minute capture.
        for _ in 0..60 {
            state.append_live(&one_second);
        }

        let live = state.live.lock().unwrap();
        assert_eq!(live.bytes.len(), one_second.len() * 15);
        assert_eq!(live.start_offset, one_second.len() * 45);
        assert_eq!(live.end_offset, one_second.len() * 60);
        assert!(live.bytes.capacity() < 16 * 1024 * 1024);
    }
}
