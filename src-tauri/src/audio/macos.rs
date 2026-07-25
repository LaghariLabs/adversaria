//! macOS audio capture.
//!
//! Captures two streams simultaneously:
//! - **System audio** via ScreenCaptureKit (what the user hears → "Them").
//!   ScreenCaptureKit delivers 32-bit float PCM at 48 kHz; we interleave it and
//!   write a float WAV. Requires the **Screen Recording** permission.
//! - **Microphone** via cpal (what the user says → "Me"), captured on its own
//!   thread so a missing/failing mic never aborts the meeting.
//!
//! Both feed the shared [`StreamState`] accumulator, so the WAV writer and the
//! live-caption snapshot are identical to the Windows path.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use screencapturekit::prelude::*;

use super::{snapshot_since, RecordingPaths, StreamState, WAV_FORMAT_IEEE_FLOAT};
use crate::recording_spool::SpoolSession;

/// System audio is captured at this fixed rate (ScreenCaptureKit default).
const SYSTEM_SAMPLE_RATE: u32 = 48_000;

/// Manages the recording lifecycle on macOS.
pub struct AudioCapture {
    recording: Arc<AtomicBool>,
    system_path: Mutex<Option<PathBuf>>,
    mic_path: Mutex<Option<PathBuf>>,
    system: StreamState,
    mic: StreamState,
    /// The live ScreenCaptureKit stream; held here so it stays alive between
    /// the start and stop IPC calls, and dropped on stop to end capture.
    system_stream: Mutex<Option<SCStream>>,
    mic_handle: Mutex<Option<std::thread::JoinHandle<()>>>,
    spool: Mutex<Option<SpoolSession>>,
}

impl AudioCapture {
    /// Create a new idle recorder.
    pub fn new() -> Self {
        Self {
            recording: Arc::new(AtomicBool::new(false)),
            system_path: Mutex::new(None),
            mic_path: Mutex::new(None),
            system: StreamState::new(),
            mic: StreamState::new(),
            system_stream: Mutex::new(None),
            mic_handle: Mutex::new(None),
            spool: Mutex::new(None),
        }
    }

    /// Returns `true` while a recording is in progress.
    pub fn is_recording(&self) -> bool {
        self.recording.load(Ordering::SeqCst)
    }

    /// Begin capturing system audio and microphone to timestamped WAV files in
    /// `output_dir`. System audio is required; the mic is best-effort.
    pub fn start(&self, output_dir: &str) -> Result<String, String> {
        // Claim the recording slot atomically — a second concurrent start()
        // must fail HERE, not race past a check-then-act window (one toggle
        // spawned twin capture sessions, stranding one spool as "capturing").
        if self
            .recording
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("Already recording".to_string());
        }

        self.system.reset();
        self.mic.reset();
        // System format is fixed by ScreenCaptureKit: float32 @ 48 kHz. The
        // channel count is corrected to the real value on the first callback.
        *self.system.sample_rate.lock().unwrap() = SYSTEM_SAMPLE_RATE;
        *self.system.num_channels.lock().unwrap() = 2;
        *self.system.bits_per_sample.lock().unwrap() = 32;
        *self.system.format_tag.lock().unwrap() = WAV_FORMAT_IEEE_FLOAT;

        let spool = match SpoolSession::start(Path::new(output_dir)) {
            Ok(spool) => spool,
            Err(error) => {
                self.recording.store(false, Ordering::SeqCst);
                return Err(error);
            }
        };
        let spool_path = spool.path().to_string_lossy().to_string();
        self.system.attach_writer(&spool.system);
        self.mic.attach_writer(&spool.mic);
        *self.spool.lock().unwrap() = Some(spool);

        // Start system-audio capture first; it is the critical stream.
        let stream = match start_system_capture(self.system.clone(), self.recording.clone()) {
            Ok(stream) => stream,
            Err(error) => {
                self.recording.store(false, Ordering::SeqCst);
                self.system.detach_writer();
                self.mic.detach_writer();
                if let Some(spool) = self.spool.lock().unwrap().take() {
                    let _ = spool.finish();
                }
                return Err(error);
            }
        };
        *self.system_stream.lock().unwrap() = Some(stream);
        *self.system_path.lock().unwrap() = Some(PathBuf::from(&spool_path));
        *self.mic_path.lock().unwrap() = None;

        // Mic capture is best-effort and runs on its own thread.
        let mic_handle = spawn_mic_thread(self.recording.clone(), self.mic.clone());
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
    pub fn stop(&self) -> Result<RecordingPaths, String> {
        if !self.is_recording() {
            return Err("Not recording".to_string());
        }
        // Signal the mic thread to stop, then tear down the system stream.
        self.recording.store(false, Ordering::SeqCst);

        if let Some(stream) = self.system_stream.lock().unwrap().take() {
            let _ = stream.stop_capture();
            // `stream` drops here, releasing ScreenCaptureKit resources.
        }
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

// ---------------------------------------------------------------------------
// System audio — ScreenCaptureKit
// ---------------------------------------------------------------------------

/// ScreenCaptureKit output handler: appends interleaved float32 PCM to the
/// shared system buffer. Runs on a ScreenCaptureKit dispatch queue.
struct AudioSink {
    state: StreamState,
    recording: Arc<AtomicBool>,
}

impl SCStreamOutputTrait for AudioSink {
    fn did_output_sample_buffer(&self, sample: CMSampleBuffer, of_type: SCStreamOutputType) {
        if of_type != SCStreamOutputType::Audio {
            return;
        }
        let Some(list) = sample.audio_buffer_list() else {
            return;
        };

        // Each AudioBuffer is one (or, when interleaved, all) channel(s) of f32.
        let planes: Vec<&[f32]> = list
            .iter()
            .map(|b| {
                let bytes = b.data();
                // SAFETY: ScreenCaptureKit delivers 4-byte-aligned f32 PCM.
                unsafe { std::slice::from_raw_parts(bytes.as_ptr().cast::<f32>(), bytes.len() / 4) }
            })
            .collect();
        if planes.is_empty() {
            return;
        }

        // Real channel count = sum across buffers (planar) or the lone buffer's
        // channel count (interleaved). Keep the WAV header honest.
        let channels: u16 = list.iter().map(|b| b.number_channels as u16).sum();
        if channels > 0 {
            *self.state.num_channels.lock().unwrap() = channels;
        }

        let mut out = Vec::new();
        if planes.len() == 1 {
            // Single buffer: mono or already-interleaved stereo — copy as-is.
            for &s in planes[0] {
                out.extend_from_slice(&s.to_le_bytes());
            }
        } else {
            // Planar: one buffer per channel — interleave L,R,L,R,…
            let frames = planes.iter().map(|p| p.len()).min().unwrap_or(0);
            for f in 0..frames {
                for p in &planes {
                    out.extend_from_slice(&p[f].to_le_bytes());
                }
            }
        }
        if self.state.push(&out).is_err() {
            self.recording.store(false, Ordering::SeqCst);
        }
    }
}

/// Build and start a ScreenCaptureKit system-audio stream feeding `state`.
fn start_system_capture(
    state: StreamState,
    recording: Arc<AtomicBool>,
) -> Result<SCStream, String> {
    let content = SCShareableContent::get().map_err(|e| {
        format!(
            "Could not access screen content for audio capture ({e:?}). Grant Screen Recording \
             permission in System Settings → Privacy & Security → Screen & System Audio Recording, \
             then restart the app."
        )
    })?;

    let display = content.displays().into_iter().next().ok_or_else(|| {
        "No display available for audio capture. Grant Screen Recording permission in System \
         Settings → Privacy & Security → Screen & System Audio Recording, then restart the app."
            .to_string()
    })?;

    let filter = SCContentFilter::create()
        .with_display(&display)
        .with_excluding_windows(&[])
        .build();

    let config = SCStreamConfiguration::new()
        .with_captures_audio(true)
        .with_sample_rate(SYSTEM_SAMPLE_RATE as i32)
        .with_channel_count(2)
        .with_excludes_current_process_audio(true);

    let mut stream = SCStream::new(&filter, &config);
    stream.add_output_handler(AudioSink { state, recording }, SCStreamOutputType::Audio);
    stream
        .start_capture()
        .map_err(|e| format!("Failed to start system-audio capture: {e:?}"))?;

    Ok(stream)
}

// ---------------------------------------------------------------------------
// Microphone — cpal
// ---------------------------------------------------------------------------

/// Spawn the mic-capture thread. Best-effort: any failure flags the stream
/// not-OK so the meeting falls back to system audio only.
fn spawn_mic_thread(recording: Arc<AtomicBool>, mic: StreamState) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        if let Err(e) = run_mic_capture(&recording, &mic) {
            eprintln!("Mic capture error: {e}");
            *mic.ok.lock().unwrap() = false;
        }
    })
}

/// Capture the default input device with cpal until `recording` clears.
/// All sample formats are normalised to float32 and all channel layouts are
/// downmixed to mono so the mic WAV is always `WAVE_FORMAT_IEEE_FLOAT`.
fn run_mic_capture(recording: &Arc<AtomicBool>, mic: &StreamState) -> Result<(), String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("No default input (microphone) device")?;
    let supported = device
        .default_input_config()
        .map_err(|e| format!("No default input config: {e}"))?;

    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();

    // Downmix to mono in the callback: Whisper mixes to mono regardless, and
    // recording a device's native channel count verbatim once produced a
    // 7.6 GB / 45 min mic track from a 16-channel virtual input device.
    let channels = (config.channels as usize).max(1);

    *mic.sample_rate.lock().unwrap() = config.sample_rate; // SampleRate = u32 in cpal 0.18
    *mic.num_channels.lock().unwrap() = 1;
    *mic.bits_per_sample.lock().unwrap() = 32;
    *mic.format_tag.lock().unwrap() = WAV_FORMAT_IEEE_FLOAT;

    let err_fn = |e: cpal::Error| eprintln!("Mic stream error: {e}");

    // Merge interleaved frames to mono f32. `config` is `Copy`; `channels` is
    // `Copy` — each move closure gets its own copy.
    let stream = match sample_format {
        cpal::SampleFormat::F32 => device.build_input_stream(
            config,
            {
                let mic = mic.clone();
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    let mut out = Vec::with_capacity((data.len() / channels) * 4);
                    for frame in data.chunks_exact(channels) {
                        let avg = frame.iter().sum::<f32>() / channels as f32;
                        out.extend_from_slice(&avg.to_le_bytes());
                    }
                    let _ = mic.push(&out);
                }
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            config,
            {
                let mic = mic.clone();
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    let mut out = Vec::with_capacity((data.len() / channels) * 4);
                    for frame in data.chunks_exact(channels) {
                        let avg = frame.iter().map(|&s| s as f32 / 32768.0).sum::<f32>()
                            / channels as f32;
                        out.extend_from_slice(&avg.to_le_bytes());
                    }
                    let _ = mic.push(&out);
                }
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            config,
            {
                let mic = mic.clone();
                move |data: &[u16], _: &cpal::InputCallbackInfo| {
                    let mut out = Vec::with_capacity((data.len() / channels) * 4);
                    for frame in data.chunks_exact(channels) {
                        let avg = frame
                            .iter()
                            .map(|&s| (s as f32 - 32768.0) / 32768.0)
                            .sum::<f32>()
                            / channels as f32;
                        out.extend_from_slice(&avg.to_le_bytes());
                    }
                    let _ = mic.push(&out);
                }
            },
            err_fn,
            None,
        ),
        other => return Err(format!("Unsupported mic sample format: {other:?}")),
    }
    .map_err(|e| format!("Failed to build mic input stream: {e}"))?;

    stream
        .play()
        .map_err(|e| format!("Failed to start mic stream: {e}"))?;

    // Keep the (non-Send) cpal stream alive on this thread until stop.
    while recording.load(Ordering::SeqCst) {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    drop(stream);
    Ok(())
}
