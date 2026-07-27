//! WASAPI audio capture (Windows).
//!
//! Captures two streams simultaneously:
//! - **System audio** via WASAPI loopback (what the user hears), and
//! - **Microphone** via the default capture device (what the user says).
//!
//! Each stream is written to its own WAV file. Mic capture is best-effort — a
//! missing or failing microphone never aborts the recording; the meeting simply
//! falls back to system audio only.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use super::{snapshot_since, RecordingPaths, StreamState, WAV_FORMAT_IEEE_FLOAT, WAV_FORMAT_PCM};
use crate::recording_spool::SpoolSession;

/// WAVEFORMATEXTENSIBLE marker — actual format is in the SubFormat GUID.
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;

/// Which WASAPI endpoint a capture stream records from.
#[derive(Clone, Copy, PartialEq)]
enum CaptureSource {
    /// Default render device in loopback mode — system audio.
    SystemLoopback,
    /// Default capture device — the user's microphone.
    Microphone,
}

/// Manages the recording lifecycle — start, stop, and the current state.
pub struct AudioCapture {
    recording: Arc<Mutex<bool>>,
    system_path: Arc<Mutex<Option<PathBuf>>>,
    mic_path: Arc<Mutex<Option<PathBuf>>>,
    system: StreamState,
    mic: StreamState,
    /// Handles to the capture threads; joined on stop so the WAV files
    /// are guaranteed to be fully written before the paths are returned.
    system_handle: Mutex<Option<std::thread::JoinHandle<()>>>,
    mic_handle: Mutex<Option<std::thread::JoinHandle<()>>>,
    spool: Mutex<Option<SpoolSession>>,
}

impl AudioCapture {
    /// Create a new idle recorder.
    pub fn new() -> Self {
        Self {
            recording: Arc::new(Mutex::new(false)),
            system_path: Arc::new(Mutex::new(None)),
            mic_path: Arc::new(Mutex::new(None)),
            system: StreamState::new(),
            mic: StreamState::new(),
            system_handle: Mutex::new(None),
            mic_handle: Mutex::new(None),
            spool: Mutex::new(None),
        }
    }

    /// Returns `true` while a recording is in progress.
    pub fn is_recording(&self) -> bool {
        *self.recording.lock().unwrap()
    }

    /// Begin capturing system audio and microphone to timestamped WAV
    /// files in `output_dir`. The filenames are generated automatically.
    pub fn start(&self, output_dir: &str) -> Result<String, String> {
        {
            // Claim the recording slot atomically (same twin-spool race as
            // macOS): check and set under ONE lock hold.
            let mut recording = self.recording.lock().unwrap();
            if *recording {
                return Err("Already recording".to_string());
            }
            *recording = true;
        }

        self.system.reset();
        self.mic.reset();
        let spool = match SpoolSession::start(Path::new(output_dir)) {
            Ok(spool) => spool,
            Err(error) => {
                *self.recording.lock().unwrap() = false;
                return Err(error);
            }
        };
        let spool_path = spool.path().to_string_lossy().to_string();
        self.system.attach_writer(&spool.system);
        self.mic.attach_writer(&spool.mic);
        *self.spool.lock().unwrap() = Some(spool);
        *self.system_path.lock().unwrap() = Some(PathBuf::from(&spool_path));
        *self.mic_path.lock().unwrap() = None;

        let system_handle = spawn_capture_thread(
            CaptureSource::SystemLoopback,
            self.recording.clone(),
            self.system.clone(),
        );
        let mic_handle = spawn_capture_thread(
            CaptureSource::Microphone,
            self.recording.clone(),
            self.mic.clone(),
        );

        *self.system_handle.lock().unwrap() = Some(system_handle);
        *self.mic_handle.lock().unwrap() = Some(mic_handle);

        Ok(spool_path)
    }

    /// Write system audio captured after `from_byte` to `path` — the delta feed
    /// for VAD-gated live captions. Returns (wrote, next_offset).
    pub fn snapshot_system_since(
        &self,
        path: &Path,
        from_byte: usize,
    ) -> Result<(bool, usize), String> {
        snapshot_since(&self.system, path, from_byte)
    }

    /// Write microphone audio captured after `from_byte` to `path` — the mic
    /// half of the VAD-gated live captions, so the user's OWN speech shows in
    /// the live preview and not only system audio. Empty when no mic was
    /// captured (best-effort), so the live loop simply gets no mic captions.
    /// Returns (wrote, next_offset).
    pub fn snapshot_mic_since(
        &self,
        path: &Path,
        from_byte: usize,
    ) -> Result<(bool, usize), String> {
        snapshot_since(&self.mic, path, from_byte)
    }

    /// Live overall loudness (0.0..1.0) for the recording waveform — the louder
    /// of the system and mic streams, so it tracks whoever is speaking.
    pub fn current_level(&self) -> f32 {
        let (sys, mic) = self.current_levels();
        sys.max(mic)
    }

    /// Live per-channel loudness (0.0..1.0) as `(system "Them", mic "Me")` so
    /// the two recording waveforms move independently with whoever is speaking.
    pub fn current_levels(&self) -> (f32, f32) {
        let sys = super::current_rms(&self.system);
        let mic = super::current_rms(&self.mic);
        ((sys * 12.0).min(1.0), (mic * 12.0).min(1.0))
    }

    /// Stop recording and return the paths to the recorded WAV files.
    ///
    /// Joins both capture threads, so the WAV files are fully written by
    /// the time this returns.
    pub fn stop(&self) -> Result<RecordingPaths, String> {
        let system_handle = self.system_handle.lock().unwrap().take();
        let Some(system_handle) = system_handle else {
            return Err("Not recording".to_string());
        };

        *self.recording.lock().unwrap() = false;

        system_handle
            .join()
            .map_err(|_| "Audio capture thread panicked".to_string())?;

        // The mic thread is best-effort: a panic or failure must not lose
        // the meeting.
        if let Some(handle) = self.mic_handle.lock().unwrap().take() {
            let _ = handle.join();
        }

        let writer_error = self.system.writer_error();
        self.system.detach_writer();
        self.mic.detach_writer();
        let spool = self
            .spool
            .lock()
            .unwrap()
            .take()
            .ok_or("Encrypted recording spool is missing")?;
        let finished = spool.finish_recoverably()?;
        let warning = match (writer_error, finished.warning) {
            (Some(capture), Some(writer)) => Some(format!("{capture} {writer}")),
            (Some(capture), None) => Some(capture),
            (None, writer) => writer,
        };

        Ok(RecordingPaths {
            system_path: finished.path.to_string_lossy().to_string(),
            mic_path: None,
            warning,
        })
    }
}

impl Default for AudioCapture {
    fn default() -> Self {
        Self::new()
    }
}

/// Spawn a thread that captures one WASAPI stream and writes it to
/// `output_path` when recording stops.
fn spawn_capture_thread(
    source: CaptureSource,
    recording: Arc<Mutex<bool>>,
    state: StreamState,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let label = match source {
            CaptureSource::SystemLoopback => "system",
            CaptureSource::Microphone => "mic",
        };

        if let Err(e) = capture_wasapi(source, recording, state.clone()) {
            eprintln!("Audio capture error ({label}): {e}");
            *state.ok.lock().unwrap() = false;
        }
    })
}

/// Run a WASAPI capture loop for the given source. Appends raw PCM
/// bytes to the stream buffer until `recording` is set to `false`.
fn capture_wasapi(
    source: CaptureSource,
    recording: Arc<Mutex<bool>>,
    state: StreamState,
) -> Result<(), String> {
    use windows::Win32::Media::Audio::*;
    use windows::Win32::System::Com::*;

    // SAFETY: We initialise COM once per capture session and
    // uninitialize it when this scope exits.
    unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() {
            return Err(format!("CoInitializeEx failed: {hr:?}"));
        }

        // Ensure COM is cleaned up even on early returns.
        let _com_guard = ComGuard;

        // Create the device enumerator.
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| format!("CoCreateInstance failed: {e:?}"))?;

        // System audio comes from the default render device in loopback
        // mode; the microphone is the default capture device.
        let (dataflow, stream_flags) = match source {
            CaptureSource::SystemLoopback => (eRender, AUDCLNT_STREAMFLAGS_LOOPBACK),
            CaptureSource::Microphone => (eCapture, 0),
        };

        let device = enumerator
            .GetDefaultAudioEndpoint(dataflow, eConsole)
            .map_err(|e| format!("GetDefaultAudioEndpoint failed: {e:?}"))?;

        // Activate the audio client.
        let audio_client: IAudioClient = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| format!("Activate IAudioClient failed: {e:?}"))?;

        // Retrieve the mix format.
        let mix_format = audio_client
            .GetMixFormat()
            .map_err(|e| format!("GetMixFormat failed: {e:?}"))?;
        let wave_format = &*mix_format;

        // Store actual format parameters for the WAV header.
        *state.sample_rate.lock().unwrap() = wave_format.nSamplesPerSec;
        *state.num_channels.lock().unwrap() = wave_format.nChannels;
        *state.bits_per_sample.lock().unwrap() = wave_format.wBitsPerSample as u16;
        {
            // Shared-mode mix format is almost always 32-bit IEEE float,
            // wrapped in WAVEFORMATEXTENSIBLE. The SubFormat GUID's first
            // dword equals the classic format tag (1 = PCM, 3 = float).
            let tag = wave_format.wFormatTag;
            let resolved = if tag == WAVE_FORMAT_EXTENSIBLE {
                let ext = &*(mix_format as *const WAVEFORMATEXTENSIBLE);
                ext.SubFormat.data1 as u16
            } else {
                tag
            };
            *state.format_tag.lock().unwrap() = if resolved == WAV_FORMAT_IEEE_FLOAT {
                WAV_FORMAT_IEEE_FLOAT
            } else {
                WAV_FORMAT_PCM
            };
        }

        // Initialise the client for this capture mode.
        let hns_buffer_duration = 1_000_000i64; // 100 ms
        audio_client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                stream_flags,
                hns_buffer_duration,
                0,
                wave_format,
                None,
            )
            .map_err(|e| format!("Initialize audio client failed: {e:?}"))?;

        // Obtain the capture client.
        let capture_client: IAudioCaptureClient = audio_client
            .GetService()
            .map_err(|e| format!("GetService IAudioCaptureClient failed: {e:?}"))?;

        // Start recording.
        audio_client
            .Start()
            .map_err(|e| format!("Audio client Start failed: {e:?}"))?;

        let mut data_ptr: *mut u8 = std::ptr::null_mut();
        let mut frames_available: u32 = 0;
        let mut flags: u32 = 0;

        let block_align = wave_format.nBlockAlign as usize;
        let sample_rate = wave_format.nSamplesPerSec as u64;

        // A loopback endpoint delivers NOTHING while nothing is playing — not
        // silent packets, no packets at all. The microphone stream meanwhile
        // keeps delivering continuously, so every quiet stretch shortens the
        // system stream relative to the mic one. Left uncorrected the two
        // spooled streams drift apart, and because `build_labeled_turns`
        // interleaves them by timestamp, every later "Them" turn is placed
        // earlier than it was actually spoken. ScreenCaptureKit pads silence
        // for us on macOS, which is why this has no counterpart there.
        //
        // So for loopback only, top the stream up with the silence the device
        // declined to give us, keeping it aligned to wall clock.
        let pad_silence = source == CaptureSource::SystemLoopback;
        let started = std::time::Instant::now();
        let mut frames_written: u64 = 0;
        // ~50 ms of zeroed frames, reused so a long quiet stretch doesn't
        // reallocate on every top-up.
        let silence = vec![0u8; block_align * (sample_rate as usize / 20).max(1)];

        loop {
            if !*recording.lock().unwrap() {
                break;
            }

            // Try to get the next buffer of captured audio.
            let hr = capture_client.GetBuffer(
                &mut data_ptr,
                &mut frames_available,
                &mut flags,
                None,
                None,
            );

            if hr.is_ok() && frames_available > 0 && !data_ptr.is_null() {
                // Close any gap that opened while the endpoint was idle BEFORE
                // appending this packet, so the packet lands at its true offset.
                if pad_silence {
                    pad_to_wall_clock(
                        &state,
                        &silence,
                        block_align,
                        sample_rate,
                        started,
                        &mut frames_written,
                    )?;
                }

                let byte_count = frames_available as usize * block_align;
                // AUDCLNT_BUFFERFLAGS_SILENT means the packet's contents are
                // undefined and must be treated as silence — reading them
                // verbatim feeds whatever the driver left in the buffer into
                // the transcript.
                let is_silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
                let result = if is_silent {
                    push_silence(&state, &silence, byte_count)
                } else {
                    state.push(std::slice::from_raw_parts(data_ptr, byte_count))
                };

                // Release before propagating any error: returning with the
                // packet still held leaks it and wedges the capture client.
                let _ = capture_client.ReleaseBuffer(frames_available);
                result?;
                frames_written += frames_available as u64;
            } else {
                // No packet available (buffer empty or error). Keep the loopback
                // stream growing in real time rather than only catching up when
                // audio resumes, then sleep instead of busy-spinning a core.
                if pad_silence {
                    pad_to_wall_clock(
                        &state,
                        &silence,
                        block_align,
                        sample_rate,
                        started,
                        &mut frames_written,
                    )?;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }

        // Stop the audio client.
        let _ = audio_client.Stop();
    }

    Ok(())
}

/// Append `bytes` of silence to `state`, chunked out of the reusable `silence`
/// buffer so a long quiet stretch never allocates.
fn push_silence(state: &StreamState, silence: &[u8], bytes: usize) -> Result<(), String> {
    // Guard the degenerate buffer: `remaining -= 0` would spin this thread
    // forever. Unreachable while the format is sane (the buffer is sized from
    // block_align, which is non-zero whenever `bytes` is), but a hung capture
    // thread is a bad way to find out otherwise.
    if silence.is_empty() {
        return Ok(());
    }
    let mut remaining = bytes;
    while remaining > 0 {
        let chunk = remaining.min(silence.len());
        state.push(&silence[..chunk])?;
        remaining -= chunk;
    }
    Ok(())
}

/// Only a wall-clock shortfall larger than this counts as a real silence gap.
///
/// The capture thread can fall tens of milliseconds behind for reasons that are
/// NOT the endpoint going quiet — the 10 ms idle sleep below, scheduler jitter,
/// or `StreamState::push` blocking while the spool encrypts and flushes to disk.
/// Padding at that scale would splice silence into audio that never stopped,
/// which is a worse bug than the drift it was meant to fix. A quarter second is
/// comfortably above that noise floor and far below the multi-second scale at
/// which speaker turns get reordered, so the residual misalignment this leaves
/// (never more than one threshold) is inaudible in the transcript.
const SILENCE_GAP_THRESHOLD_MS: u64 = 250;

/// Frames of silence needed to bring a stream back to wall clock — 0 when it is
/// level, ahead, or short by less than [`SILENCE_GAP_THRESHOLD_MS`].
///
/// Split out from [`pad_to_wall_clock`] so the decision is testable without a
/// live WASAPI endpoint and an attached spool writer.
fn silence_deficit_frames(
    elapsed: std::time::Duration,
    frames_written: u64,
    sample_rate: u64,
) -> u64 {
    let elapsed_frames = (elapsed.as_secs_f64() * sample_rate as f64) as u64;
    let deficit = elapsed_frames.saturating_sub(frames_written);
    if deficit < sample_rate * SILENCE_GAP_THRESHOLD_MS / 1000 {
        return 0;
    }
    deficit
}

/// Insert the silence a loopback endpoint declines to deliver while it is idle,
/// so the system stream stays aligned to wall clock and therefore to the
/// microphone stream captured alongside it.
fn pad_to_wall_clock(
    state: &StreamState,
    silence: &[u8],
    block_align: usize,
    sample_rate: u64,
    started: std::time::Instant,
    frames_written: &mut u64,
) -> Result<(), String> {
    if block_align == 0 || sample_rate == 0 {
        return Ok(());
    }
    let deficit = silence_deficit_frames(started.elapsed(), *frames_written, sample_rate);
    if deficit == 0 {
        return Ok(());
    }
    push_silence(state, silence, deficit as usize * block_align)?;
    *frames_written += deficit;
    Ok(())
}

/// RAII guard that calls `CoUninitialize` on drop.
struct ComGuard;

impl Drop for ComGuard {
    fn drop(&mut self) {
        unsafe {
            windows::Win32::System::Com::CoUninitialize();
        }
    }
}

#[cfg(test)]
mod silence_gap_tests {
    use std::time::Duration;

    use super::{silence_deficit_frames, SILENCE_GAP_THRESHOLD_MS};

    const RATE: u64 = 48_000;

    #[test]
    fn stream_level_with_wall_clock_needs_no_padding() {
        assert_eq!(
            silence_deficit_frames(Duration::from_secs(10), RATE * 10, RATE),
            0
        );
    }

    #[test]
    fn stream_ahead_of_wall_clock_never_pads() {
        // A device clock running slightly fast must not underflow into a huge
        // bogus deficit.
        assert_eq!(
            silence_deficit_frames(Duration::from_secs(10), RATE * 11, RATE),
            0
        );
    }

    #[test]
    fn jitter_below_the_threshold_is_ignored() {
        // 100 ms behind — the idle sleep plus a slow spool flush, not a gap.
        let written = RATE * 10 - RATE / 10;
        assert_eq!(
            silence_deficit_frames(Duration::from_secs(10), written, RATE),
            0
        );
    }

    #[test]
    fn a_real_silence_gap_is_padded_to_wall_clock() {
        // Three seconds of an idle endpoint: pad the whole shortfall, so the
        // next real packet lands at its true offset instead of 3 s early.
        let written = RATE * 7;
        assert_eq!(
            silence_deficit_frames(Duration::from_secs(10), written, RATE),
            RATE * 3
        );
    }

    #[test]
    fn threshold_boundary_is_the_documented_quarter_second() {
        let threshold = RATE * SILENCE_GAP_THRESHOLD_MS / 1000;
        let elapsed = Duration::from_secs(10);
        let base = RATE * 10;
        assert_eq!(
            silence_deficit_frames(elapsed, base - threshold + 1, RATE),
            0
        );
        assert_eq!(
            silence_deficit_frames(elapsed, base - threshold, RATE),
            threshold
        );
    }
}
