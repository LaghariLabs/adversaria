//! macOS audio capture.
//!
//! Captures two streams simultaneously:
//! - **System audio** via a Core Audio process tap (cpal loopback, backed by
//!   `AudioHardwareCreateProcessTap`; what the user hears → "Them"). This does
//!   not create a ScreenCaptureKit session or require Screen Recording access.
//! - **Microphone** via cpal (what the user says → "Me"), captured on its own
//!   thread so a missing/failing mic never aborts the meeting.
//!
//! Both feed the shared [`StreamState`] accumulator, so the WAV writer and the
//! live-caption snapshot are identical to the Windows path.
//!
//! Phase 1 limitations: the process tap remains anchored to the default output
//! selected at start if the device changes mid-recording (the Phase 2 watchdog
//! is tracked in `docs/AUDIO_TAP_MIGRATION.md`), and it records every process,
//! including this app. The app plays no meeting audio, so that is accepted for
//! now. macOS shows its expected purple system-audio menu-bar indicator while
//! the tap is active, matching Granola's behavior.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use super::{snapshot_since, RecordingPaths, StreamState, WAV_FORMAT_IEEE_FLOAT};
use crate::recording_spool::SpoolSession;

/// Manages the recording lifecycle on macOS.
pub struct AudioCapture {
    recording: Arc<AtomicBool>,
    system_path: Mutex<Option<PathBuf>>,
    mic_path: Mutex<Option<PathBuf>>,
    system: StreamState,
    mic: StreamState,
    /// Owns the thread holding the non-Send cpal loopback stream.
    system_handle: Mutex<Option<std::thread::JoinHandle<()>>>,
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
            system_handle: Mutex::new(None),
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
        let system_handle = match spawn_system_thread(self.recording.clone(), self.system.clone()) {
            Ok(handle) => handle,
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
        *self.system_handle.lock().unwrap() = Some(system_handle);
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
        // Signal both capture threads to stop, then join them symmetrically.
        self.recording.store(false, Ordering::SeqCst);

        if let Some(handle) = self.system_handle.lock().unwrap().take() {
            let _ = handle.join();
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
// System audio — Core Audio process tap via cpal loopback
// ---------------------------------------------------------------------------

/// Spawn the system-capture thread and wait until its cpal stream is playing.
fn spawn_system_thread(
    recording: Arc<AtomicBool>,
    system: StreamState,
) -> Result<std::thread::JoinHandle<()>, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let handle = std::thread::spawn(move || {
        if let Err(error) = run_system_capture(&recording, &system, &tx) {
            let _ = tx.send(Err(error));
        }
    });

    match rx.recv_timeout(std::time::Duration::from_secs(10)) {
        Ok(Ok(())) => Ok(handle),
        Ok(Err(error)) => {
            let _ = handle.join();
            Err(error)
        }
        Err(_) => Err("System-audio capture did not start within 10 s".to_string()),
    }
}

/// Capture the default output device through cpal's Core Audio loopback tap.
fn run_system_capture(
    recording: &Arc<AtomicBool>,
    system: &StreamState,
    startup: &std::sync::mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or("No output device available to capture system audio from.")?;
    let supported = device
        .default_input_config()
        .or_else(|_| device.default_output_config())
        .map_err(|e| format!("No default system-audio config: {e}"))?;

    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();

    // Set the native interleaved format before the first callback so every
    // snapshot and the finished WAV receive an honest header.
    *system.sample_rate.lock().unwrap() = config.sample_rate;
    *system.num_channels.lock().unwrap() = config.channels;
    *system.bits_per_sample.lock().unwrap() = 32;
    *system.format_tag.lock().unwrap() = WAV_FORMAT_IEEE_FLOAT;

    let err_fn = |e: cpal::Error| eprintln!("System-audio stream error: {e}");
    let stream = match sample_format {
        cpal::SampleFormat::F32 => device.build_input_stream(
            config,
            {
                let system = system.clone();
                let recording = recording.clone();
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    let mut out = Vec::with_capacity(std::mem::size_of_val(data));
                    for &sample in data {
                        out.extend_from_slice(&sample.to_le_bytes());
                    }
                    if system.push(&out).is_err() {
                        recording.store(false, Ordering::SeqCst);
                    }
                }
            },
            err_fn,
            None,
        ),
        other => {
            return Err(format!("Unsupported system-audio sample format: {other:?}"));
        }
    }
    .map_err(|e| format!("Failed to build system-audio input stream: {e}"))?;

    stream
        .play()
        .map_err(|e| format!("Failed to start system-audio stream: {e}"))?;
    startup
        .send(Ok(()))
        .map_err(|e| format!("Failed to confirm system-audio startup: {e}"))?;

    // Keep the non-Send cpal stream alive here until stop; dropping it destroys
    // the process tap and cpal's private aggregate device.
    while recording.load(Ordering::SeqCst) {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    drop(stream);
    Ok(())
}

/// Prove the system-audio tap actually works: play a near-silent tone through
/// the default output and check the tap hears ANY nonzero sample. This is the
/// only honest permission check — macOS offers no public API, and a denied
/// tap fails silently (stream plays, zero callbacks). First-ever call may
/// block on the macOS consent prompt, so the budget is generous.
pub fn probe_system_audio() -> Result<bool, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(run_system_audio_probe());
    });
    rx.recv_timeout(std::time::Duration::from_secs(120))
        .map_err(|_| "The system-audio check timed out after 120 seconds.".to_string())?
}

fn run_system_audio_probe() -> Result<bool, String> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or("No output device is available for the system-audio check.")?;
    let input_supported = device
        .default_input_config()
        .or_else(|_| device.default_output_config())
        .map_err(|error| format!("No default system-audio check config: {error}"))?;
    if input_supported.sample_format() != cpal::SampleFormat::F32 {
        return Err(format!(
            "Unsupported system-audio check sample format: {:?}",
            input_supported.sample_format()
        ));
    }
    let input_config: cpal::StreamConfig = input_supported.into();
    let heard_nonzero = Arc::new(Mutex::new(false));
    let stream_error = Arc::new(Mutex::new(None::<String>));

    let input_stream = device
        .build_input_stream(
            input_config,
            {
                let heard_nonzero = heard_nonzero.clone();
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    if data.iter().any(|sample| *sample != 0.0) {
                        *heard_nonzero.lock().unwrap() = true;
                    }
                }
            },
            {
                let stream_error = stream_error.clone();
                move |error| {
                    *stream_error.lock().unwrap() =
                        Some(format!("System-audio check input stream failed: {error}"));
                }
            },
            None,
        )
        .map_err(|error| format!("Failed to build system-audio check input stream: {error}"))?;

    input_stream
        .play()
        .map_err(|error| format!("Failed to start system-audio check input stream: {error}"))?;

    let output_supported = device
        .default_output_config()
        .map_err(|error| format!("No default tone output config: {error}"))?;
    let output_sample_format = output_supported.sample_format();
    let output_config: cpal::StreamConfig = output_supported.into();
    let channels = usize::from(output_config.channels.max(1));
    let phase_step = std::f32::consts::TAU * 220.0 / output_config.sample_rate as f32;
    let output_stream = match output_sample_format {
        cpal::SampleFormat::F32 => {
            let mut phase = 0.0f32;
            device.build_output_stream(
                output_config,
                move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                    for frame in data.chunks_mut(channels) {
                        let sample = phase.sin() * 0.002;
                        frame.fill(sample);
                        phase = (phase + phase_step) % std::f32::consts::TAU;
                    }
                },
                {
                    let stream_error = stream_error.clone();
                    move |error| {
                        *stream_error.lock().unwrap() =
                            Some(format!("System-audio check tone stream failed: {error}"));
                    }
                },
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            let mut phase = 0.0f32;
            device.build_output_stream(
                output_config,
                move |data: &mut [i16], _: &cpal::OutputCallbackInfo| {
                    for frame in data.chunks_mut(channels) {
                        let sample = (phase.sin() * 0.002 * i16::MAX as f32) as i16;
                        frame.fill(sample);
                        phase = (phase + phase_step) % std::f32::consts::TAU;
                    }
                },
                {
                    let stream_error = stream_error.clone();
                    move |error| {
                        *stream_error.lock().unwrap() =
                            Some(format!("System-audio check tone stream failed: {error}"));
                    }
                },
                None,
            )
        }
        cpal::SampleFormat::U16 => {
            let mut phase = 0.0f32;
            device.build_output_stream(
                output_config,
                move |data: &mut [u16], _: &cpal::OutputCallbackInfo| {
                    for frame in data.chunks_mut(channels) {
                        let sample = (phase.sin() * 0.002 * i16::MAX as f32 + 32768.0) as u16;
                        frame.fill(sample);
                        phase = (phase + phase_step) % std::f32::consts::TAU;
                    }
                },
                {
                    let stream_error = stream_error.clone();
                    move |error| {
                        *stream_error.lock().unwrap() =
                            Some(format!("System-audio check tone stream failed: {error}"));
                    }
                },
                None,
            )
        }
        other => return Err(format!("Unsupported tone output sample format: {other:?}")),
    }
    .map_err(|error| format!("Failed to build system-audio check tone stream: {error}"))?;

    output_stream
        .play()
        .map_err(|error| format!("Failed to start system-audio check tone stream: {error}"))?;
    std::thread::sleep(std::time::Duration::from_millis(1500));
    drop(output_stream);
    drop(input_stream);

    if let Some(error) = stream_error.lock().unwrap().take() {
        return Err(error);
    }
    let heard_nonzero = *heard_nonzero.lock().unwrap();
    Ok(heard_nonzero)
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
