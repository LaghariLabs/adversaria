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
                let byte_count = (frames_available * wave_format.nBlockAlign as u32) as usize;
                let data = std::slice::from_raw_parts(data_ptr, byte_count);
                state.push(data)?;

                let _ = capture_client.ReleaseBuffer(frames_available);
            } else {
                // No packet available (buffer empty or error) — sleep
                // briefly instead of busy-spinning a core.
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }

        // Stop the audio client.
        let _ = audio_client.Stop();
    }

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
