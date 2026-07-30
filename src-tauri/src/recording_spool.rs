//! Crash-safe encrypted recording spool.
//!
//! Native callbacks enqueue bounded PCM frames. A writer thread coalesces them
//! into independently authenticated, roughly one-second records and fsyncs each
//! committed record. Only encrypted records and non-sensitive format metadata
//! are persisted; the recording key lives in a dedicated OS-keychain entry.

use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};

const FORMAT_VERSION: u16 = 1;
const FILE_MAGIC: &[u8; 8] = b"ADVSP001";
const KEYRING_SERVICE: &str = "adversaria-recordings";
const KEYRING_ACCOUNT: &str = "spool-key-v1";
const QUEUE_CAPACITY: usize = 128;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct AudioFormat {
    pub sample_rate: u32,
    pub channels: u16,
    pub bits_per_sample: u16,
    pub format_tag: u16,
}

impl AudioFormat {
    pub fn bytes_per_second(self) -> usize {
        self.sample_rate as usize * self.channels as usize * (self.bits_per_sample as usize / 8)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelManifest {
    pub channel: String,
    pub records_file: String,
    pub nonce_prefix_hex: String,
    pub format: AudioFormat,
    pub last_committed_chunk: u64,
    pub committed_plaintext_bytes: u64,
    pub first_committed_at: String,
    pub last_committed_at: String,
    pub committed_duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionManifest {
    pub format_version: u16,
    pub session_id: String,
    pub state: String,
    pub created_at: String,
    pub updated_at: String,
    pub channels: Vec<String>,
}

#[derive(Debug)]
pub(crate) struct Frame {
    bytes: Vec<u8>,
    format: AudioFormat,
}

pub struct StreamWriter {
    sender: Option<SyncSender<Frame>>,
    join: Option<JoinHandle<Result<Option<ChannelManifest>, String>>>,
    failure: Arc<Mutex<Option<String>>>,
}

impl StreamWriter {
    pub(crate) fn sender(&self) -> SyncSender<Frame> {
        self.sender
            .as_ref()
            .expect("writer already finished")
            .clone()
    }

    pub(crate) fn failure(&self) -> Arc<Mutex<Option<String>>> {
        self.failure.clone()
    }

    fn finish(mut self) -> Result<Option<ChannelManifest>, String> {
        self.sender.take();
        self.join
            .take()
            .expect("writer join handle missing")
            .join()
            .map_err(|_| "encrypted recording writer panicked".to_string())?
    }
}

pub struct SpoolSession {
    root: PathBuf,
    manifest: SessionManifest,
    pub system: StreamWriter,
    pub mic: StreamWriter,
}

pub struct FinishedSpool {
    pub path: PathBuf,
    pub warning: Option<String>,
}

impl SpoolSession {
    pub fn start(output_dir: &Path) -> Result<Self, String> {
        let key = recording_key()?;
        Self::start_with_key(output_dir, key)
    }

    fn start_with_key(output_dir: &Path, key: [u8; 32]) -> Result<Self, String> {
        let session_id = random_hex(16);
        let root = output_dir.join(format!("{session_id}.adversaria-spool"));
        create_private_dir(&root).map_err(|e| format!("Could not create recording spool: {e}"))?;
        let now = chrono::Utc::now().to_rfc3339();
        let manifest = SessionManifest {
            format_version: FORMAT_VERSION,
            session_id,
            state: "capturing".to_string(),
            created_at: now.clone(),
            updated_at: now,
            channels: Vec::new(),
        };
        write_json_atomic(&root.join("manifest.json"), &manifest)
            .map_err(|e| format!("Could not initialize recording manifest: {e}"))?;
        let system = spawn_writer(&root, &manifest.session_id, "system", key)?;
        let mic = spawn_writer(&root, &manifest.session_id, "mic", key)?;
        Ok(Self {
            root,
            manifest,
            system,
            mic,
        })
    }

    pub fn path(&self) -> &Path {
        &self.root
    }

    pub fn finish(self) -> Result<PathBuf, String> {
        let finished = self.finish_recoverably()?;
        if let Some(warning) = finished.warning {
            return Err(warning);
        }
        Ok(finished.path)
    }

    /// Finalize every writer and return any recoverable writer failure as a
    /// warning. Capture callers use this form so already committed chunks can
    /// still become a visible pending meeting instead of disappearing until a
    /// restart.
    pub fn finish_recoverably(mut self) -> Result<FinishedSpool, String> {
        let system = self.system.finish();
        let mic = self.mic.finish();
        let mut warnings = Vec::new();
        if let Err(error) = &system {
            warnings.push(error.clone());
        }
        if let Err(error) = &mic {
            warnings.push(format!("Microphone spool: {error}"));
        }
        let has_system = matches!(system, Ok(Some(_))) || self.root.join("system.json").exists();
        if !has_system {
            return Err(format!(
                "No system audio reached the encrypted spool. The recoverable spool is at {}.",
                self.root.display()
            ));
        }
        self.manifest.channels.push("system".to_string());
        if matches!(mic, Ok(Some(_))) || self.root.join("mic.json").exists() {
            self.manifest.channels.push("mic".to_string());
        }
        self.manifest.state = "pending".to_string();
        self.manifest.updated_at = chrono::Utc::now().to_rfc3339();
        write_json_atomic(&self.root.join("manifest.json"), &self.manifest)
            .map_err(|e| format!("Could not finalize recording manifest: {e}"))?;
        Ok(FinishedSpool {
            path: self.root,
            warning: (!warnings.is_empty()).then(|| warnings.join(" ")),
        })
    }
}

/// Encrypt a legacy pending WAV into the v1 spool, authenticate a full
/// round-trip, and return the new spool path. The caller updates its DB
/// reference before deleting the plaintext source.
pub fn migrate_legacy_wav(system_path: &Path, output_dir: &Path) -> Result<PathBuf, String> {
    let mic_path = legacy_mic_path(&system_path.to_string_lossy()).map(PathBuf::from);
    let session = SpoolSession::start(output_dir)?;
    send_wav_to_writer(system_path, &session.system)?;
    if let Some(mic) = mic_path.as_deref() {
        send_wav_to_writer(mic, &session.mic)?;
    }
    let root = session.finish()?;
    // Verify every committed record before the plaintext path can be swapped.
    let prepared = prepare_for_transcription(&root.to_string_lossy())?;
    drop(prepared);
    Ok(root)
}

fn send_wav_to_writer(path: &Path, writer: &StreamWriter) -> Result<(), String> {
    let mut file = File::open(path)
        .map_err(|e| format!("Could not open legacy WAV {}: {e}", path.display()))?;
    let (format, data_offset, data_len) = read_wav_header(&mut file)?;
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(data_offset))
        .map_err(|e| format!("Could not seek legacy WAV {}: {e}", path.display()))?;
    let block_align = format.channels as usize * (format.bits_per_sample as usize / 8);
    let chunk_size = format.bytes_per_second().max(block_align).max(64 * 1024);
    let mut remaining = data_len as usize;
    let sender = writer.sender();
    while remaining > 0 {
        let take = remaining.min(chunk_size);
        let mut bytes = vec![0u8; take];
        file.read_exact(&mut bytes)
            .map_err(|e| format!("Legacy WAV {} ended early: {e}", path.display()))?;
        sender
            .send(Frame { bytes, format })
            .map_err(|_| "Encrypted migration writer stopped unexpectedly".to_string())?;
        remaining -= take;
    }
    Ok(())
}

fn read_wav_header(file: &mut File) -> Result<(AudioFormat, u64, u32), String> {
    use std::io::{Seek, SeekFrom};
    let mut riff = [0u8; 12];
    file.read_exact(&mut riff)
        .map_err(|e| format!("WAV header is incomplete: {e}"))?;
    if &riff[..4] != b"RIFF" || &riff[8..] != b"WAVE" {
        return Err("Legacy recording is not a RIFF/WAVE file".to_string());
    }
    let mut format = None;
    loop {
        let mut header = [0u8; 8];
        file.read_exact(&mut header)
            .map_err(|e| format!("WAV chunk header is incomplete: {e}"))?;
        let length = u32::from_le_bytes(header[4..8].try_into().unwrap());
        let body_offset = file
            .stream_position()
            .map_err(|e| format!("Could not inspect WAV: {e}"))?;
        if &header[..4] == b"fmt " {
            if length < 16 {
                return Err("Legacy WAV has an invalid format chunk".to_string());
            }
            let mut body = vec![0u8; length as usize];
            file.read_exact(&mut body)
                .map_err(|e| format!("WAV format chunk is incomplete: {e}"))?;
            let tag = u16::from_le_bytes(body[0..2].try_into().unwrap());
            format = Some(AudioFormat {
                format_tag: if tag == 3 { 3 } else { 1 },
                channels: u16::from_le_bytes(body[2..4].try_into().unwrap()),
                sample_rate: u32::from_le_bytes(body[4..8].try_into().unwrap()),
                bits_per_sample: u16::from_le_bytes(body[14..16].try_into().unwrap()),
            });
        } else if &header[..4] == b"data" {
            let format =
                format.ok_or_else(|| "Legacy WAV data appeared before its format".to_string())?;
            return Ok((format, body_offset, length));
        } else {
            file.seek(SeekFrom::Current(length as i64))
                .map_err(|e| format!("Could not skip WAV chunk: {e}"))?;
        }
        if length % 2 == 1 {
            file.seek(SeekFrom::Current(1))
                .map_err(|e| format!("Could not skip WAV padding: {e}"))?;
        }
    }
}

pub(crate) fn enqueue_frame(
    sender: &SyncSender<Frame>,
    failure: &Arc<Mutex<Option<String>>>,
    bytes: &[u8],
    format: AudioFormat,
) -> Result<(), String> {
    if bytes.is_empty() {
        return Ok(());
    }
    match sender.try_send(Frame {
        bytes: bytes.to_vec(),
        format,
    }) {
        Ok(()) => Ok(()),
        Err(TrySendError::Full(_)) => {
            let message = "Encrypted recording writer could not keep up; capture was stopped to protect the recording. Free disk space and try again.".to_string();
            *failure.lock().unwrap() = Some(message.clone());
            Err(message)
        }
        Err(TrySendError::Disconnected(_)) => {
            let message = "Encrypted recording writer stopped unexpectedly. The committed audio remains recoverable.".to_string();
            *failure.lock().unwrap() = Some(message.clone());
            Err(message)
        }
    }
}

fn spawn_writer(
    root: &Path,
    session_id: &str,
    channel: &str,
    key: [u8; 32],
) -> Result<StreamWriter, String> {
    let (sender, receiver) = mpsc::sync_channel::<Frame>(QUEUE_CAPACITY);
    let failure = Arc::new(Mutex::new(None));
    let failure_for_thread = failure.clone();
    let root = root.to_path_buf();
    let session_id = session_id.to_string();
    let channel = channel.to_string();
    let join = std::thread::Builder::new()
        .name(format!("recording-writer-{channel}"))
        .spawn(move || {
            let result = run_writer(&root, &session_id, &channel, key, receiver);
            if let Err(error) = &result {
                *failure_for_thread.lock().unwrap() = Some(error.clone());
            }
            result
        })
        .map_err(|e| format!("Could not start encrypted recording writer: {e}"))?;
    Ok(StreamWriter {
        sender: Some(sender),
        join: Some(join),
        failure,
    })
}

fn run_writer(
    root: &Path,
    session_id: &str,
    channel: &str,
    key: [u8; 32],
    receiver: mpsc::Receiver<Frame>,
) -> Result<Option<ChannelManifest>, String> {
    let records_name = format!("{channel}.records");
    let records_path = root.join(&records_name);
    let mut records = create_private_file(&records_path)
        .map_err(|e| format!("Could not create {channel} spool: {e}"))?;
    records
        .write_all(FILE_MAGIC)
        .and_then(|_| records.write_all(&FORMAT_VERSION.to_le_bytes()))
        .map_err(|e| format!("Could not initialize {channel} spool: {e}"))?;

    let mut nonce_prefix = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut nonce_prefix);
    let cipher = XChaCha20Poly1305::new((&key).into());
    let mut pending = Vec::new();
    let mut format: Option<AudioFormat> = None;
    let mut chunk_index = 0u64;
    let mut committed = 0u64;
    let mut first_committed_at: Option<String> = None;

    let mut flush = |pending: &mut Vec<u8>, format: AudioFormat| -> Result<(), String> {
        if pending.is_empty() {
            return Ok(());
        }
        let index = chunk_index;
        let nonce = nonce_for(nonce_prefix, index);
        let aad = additional_data(session_id, channel, index, format)?;
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: pending,
                    aad: &aad,
                },
            )
            .map_err(|_| format!("Could not encrypt {channel} recording chunk {index}"))?;
        records
            .write_all(&index.to_le_bytes())
            .and_then(|_| records.write_all(&(pending.len() as u32).to_le_bytes()))
            .and_then(|_| records.write_all(&(ciphertext.len() as u32).to_le_bytes()))
            .and_then(|_| records.write_all(&ciphertext))
            .and_then(|_| records.flush())
            .and_then(|_| records.sync_data())
            .map_err(|e| format!("Could not commit {channel} recording chunk {index}: {e}"))?;
        committed += pending.len() as u64;
        let committed_at = chrono::Utc::now().to_rfc3339();
        let first_committed_at = first_committed_at
            .get_or_insert_with(|| committed_at.clone())
            .clone();
        let stream_manifest = ChannelManifest {
            channel: channel.to_string(),
            records_file: records_name.clone(),
            nonce_prefix_hex: hex_encode(&nonce_prefix),
            format,
            last_committed_chunk: index,
            committed_plaintext_bytes: committed,
            first_committed_at,
            last_committed_at: committed_at,
            committed_duration_ms: committed.saturating_mul(1000)
                / format.bytes_per_second().max(1) as u64,
        };
        write_json_atomic(&root.join(format!("{channel}.json")), &stream_manifest)
            .map_err(|e| format!("Could not update {channel} manifest: {e}"))?;
        chunk_index += 1;
        pending.clear();
        Ok(())
    };

    while let Ok(frame) = receiver.recv() {
        if let Some(previous) = format {
            if previous != frame.format {
                flush(&mut pending, previous)?;
            }
        }
        format = Some(frame.format);
        pending.extend_from_slice(&frame.bytes);
        let target = frame.format.bytes_per_second().max(64 * 1024);
        if pending.len() >= target {
            flush(&mut pending, frame.format)?;
        }
    }
    if let Some(format) = format {
        flush(&mut pending, format)?;
    }
    if chunk_index == 0 {
        let _ = std::fs::remove_file(&records_path);
        return Ok(None);
    }
    let manifest = read_json::<ChannelManifest>(&root.join(format!("{channel}.json")))
        .map_err(|e| format!("Could not reload {channel} manifest: {e}"))?;
    Ok(Some(manifest))
}

pub struct PreparedRecording {
    pub system_path: String,
    pub mic_path: Option<String>,
    temporary_files: Vec<PathBuf>,
}

impl Drop for PreparedRecording {
    fn drop(&mut self) {
        for path in &self.temporary_files {
            let _ = std::fs::remove_file(path);
        }
    }
}

pub fn prepare_for_transcription(path: &str) -> Result<PreparedRecording, String> {
    let root = Path::new(path);
    if !root.is_dir() || root.extension().and_then(|v| v.to_str()) != Some("adversaria-spool") {
        return Ok(PreparedRecording {
            system_path: path.to_string(),
            mic_path: legacy_mic_path(path),
            temporary_files: Vec::new(),
        });
    }
    let session = read_session(root)?;
    let key = recording_key()?;
    let processing = root
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(".processing");
    create_private_dir(&processing)
        .map_err(|e| format!("Could not create private processing directory: {e}"))?;
    let mut temporary_files = Vec::new();
    let system = decrypt_channel(root, &session.session_id, "system", key, &processing)?;
    temporary_files.push(system.clone());
    let mic = if session.channels.iter().any(|c| c == "mic") {
        let path = decrypt_channel(root, &session.session_id, "mic", key, &processing)?;
        temporary_files.push(path.clone());
        Some(path.to_string_lossy().to_string())
    } else {
        None
    };
    Ok(PreparedRecording {
        system_path: system.to_string_lossy().to_string(),
        mic_path: mic,
        temporary_files,
    })
}

/// Decide how a decrypted channel becomes a WAV Whisper can read. WAV data is
/// capped at u32::MAX bytes; an oversized multi-channel float recording (e.g.
/// from a 16-channel virtual input device) is downmixed to mono instead of
/// failing. Returns (wav_data_size, wav_channels, downmix).
fn wav_output_plan(
    committed_plaintext_bytes: u64,
    channels: u16,
    bits_per_sample: u16,
    format_tag: u16,
) -> Result<(u32, u16, bool), String> {
    if let Ok(size) = u32::try_from(committed_plaintext_bytes) {
        return Ok((size, channels, false));
    }
    // Downmix is only defined for interleaved 32-bit float frames — the only
    // format the capture layer writes.
    let float32 = bits_per_sample == 32 && format_tag == 3;
    if channels > 1 && float32 {
        let frame_size = u64::from(channels) * 4;
        let mono_bytes = (committed_plaintext_bytes / frame_size) * 4;
        if let Ok(size) = u32::try_from(mono_bytes) {
            return Ok((size, 1, true));
        }
    }
    Err("recording is too large for WAV processing".to_string())
}

/// Average interleaved little-endian f32 frames to mono. `carry` holds the
/// bytes of an incomplete frame between encrypted chunks.
fn downmix_f32_to_mono(carry: &mut Vec<u8>, input: &[u8], channels: usize) -> Vec<u8> {
    carry.extend_from_slice(input);
    let frame_size = channels * 4;
    let complete = (carry.len() / frame_size) * frame_size;
    let mut out = Vec::with_capacity((complete / frame_size) * 4);
    for frame in carry[..complete].chunks_exact(frame_size) {
        let mut sum = 0f32;
        for sample in frame.chunks_exact(4) {
            sum += f32::from_le_bytes(sample.try_into().unwrap());
        }
        out.extend_from_slice(&(sum / channels as f32).to_le_bytes());
    }
    carry.drain(..complete);
    out
}

fn decrypt_channel(
    root: &Path,
    session_id: &str,
    channel: &str,
    key: [u8; 32],
    processing: &Path,
) -> Result<PathBuf, String> {
    let manifest = read_json::<ChannelManifest>(&root.join(format!("{channel}.json")))
        .map_err(|e| format!("Could not read {channel} recording manifest: {e}"))?;
    let prefix = hex_decode::<16>(&manifest.nonce_prefix_hex)?;
    let mut file = File::open(root.join(&manifest.records_file))
        .map_err(|e| format!("Could not open encrypted {channel} recording: {e}"))?;
    let mut magic = [0u8; 8];
    let mut version = [0u8; 2];
    file.read_exact(&mut magic)
        .and_then(|_| file.read_exact(&mut version))
        .map_err(|e| format!("Encrypted {channel} recording header is incomplete: {e}"))?;
    if &magic != FILE_MAGIC || u16::from_le_bytes(version) != FORMAT_VERSION {
        return Err(format!("Unsupported encrypted {channel} recording format"));
    }
    let cipher = XChaCha20Poly1305::new((&key).into());
    let (data_size, output_channels, downmix) = wav_output_plan(
        manifest.committed_plaintext_bytes,
        manifest.format.channels,
        manifest.format.bits_per_sample,
        manifest.format.format_tag,
    )
    .map_err(|error| format!("Encrypted {channel} {error}"))?;
    let output = processing.join(format!("{session_id}-{channel}-{}.wav", random_hex(6)));
    let output_file = create_private_file(&output)
        .map_err(|e| format!("Could not create private {channel} WAV: {e}"))?;
    let mut writer = BufWriter::new(output_file);
    crate::audio::write_wav_header(
        &mut writer,
        data_size,
        manifest.format.sample_rate,
        output_channels,
        manifest.format.bits_per_sample,
        manifest.format.format_tag,
    )
    .map_err(|e| format!("Could not initialize private {channel} WAV: {e}"))?;

    let result = (|| -> Result<(), String> {
        let mut committed_plaintext = 0u64;
        let mut carry: Vec<u8> = Vec::new();
        for expected_index in 0..=manifest.last_committed_chunk {
            let mut record_header = [0u8; 16];
            file.read_exact(&mut record_header).map_err(|e| {
                format!("Committed {channel} recording chunk {expected_index} is incomplete: {e}")
            })?;
            let index = u64::from_le_bytes(record_header[0..8].try_into().unwrap());
            if index != expected_index {
                return Err(format!(
                    "Encrypted {channel} recording chunk sequence is invalid: expected {expected_index}, found {index}"
                ));
            }
            let plaintext_len =
                u32::from_le_bytes(record_header[8..12].try_into().unwrap()) as usize;
            let ciphertext_len =
                u32::from_le_bytes(record_header[12..16].try_into().unwrap()) as usize;
            if ciphertext_len > 256 * 1024 * 1024 || plaintext_len > 256 * 1024 * 1024 {
                return Err(format!("Invalid {channel} recording chunk length"));
            }
            let mut ciphertext = vec![0u8; ciphertext_len];
            file.read_exact(&mut ciphertext).map_err(|e| {
                format!("Committed {channel} recording chunk {index} is incomplete: {e}")
            })?;
            let nonce = nonce_for(prefix, index);
            let aad = additional_data(session_id, channel, index, manifest.format)?;
            let plaintext = cipher
                .decrypt(
                    XNonce::from_slice(&nonce),
                    Payload {
                        msg: &ciphertext,
                        aad: &aad,
                    },
                )
                .map_err(|_| {
                    format!("Authentication failed for {channel} recording chunk {index}")
                })?;
            if plaintext.len() != plaintext_len {
                return Err(format!(
                    "Invalid plaintext length for {channel} chunk {index}"
                ));
            }
            if downmix {
                let mono = downmix_f32_to_mono(
                    &mut carry,
                    &plaintext,
                    manifest.format.channels.max(1) as usize,
                );
                writer
                    .write_all(&mono)
                    .map_err(|e| format!("Could not write private {channel} WAV: {e}"))?;
            } else {
                writer
                    .write_all(&plaintext)
                    .map_err(|e| format!("Could not write private {channel} WAV: {e}"))?;
            }
            committed_plaintext = committed_plaintext
                .checked_add(plaintext.len() as u64)
                .ok_or_else(|| format!("Encrypted {channel} recording size overflow"))?;
        }
        if committed_plaintext == 0 {
            return Err(format!(
                "Encrypted {channel} recording contains no authenticated audio"
            ));
        }
        if committed_plaintext != manifest.committed_plaintext_bytes {
            return Err(format!(
                "Encrypted {channel} recording manifest expected {} bytes, authenticated {committed_plaintext}",
                manifest.committed_plaintext_bytes
            ));
        }
        writer
            .flush()
            .and_then(|_| writer.get_ref().sync_all())
            .map_err(|e| format!("Could not commit private {channel} WAV: {e}"))?;
        Ok(())
    })();
    if let Err(error) = result {
        drop(writer);
        let _ = std::fs::remove_file(&output);
        return Err(error);
    }
    Ok(output)
}

pub fn read_session(root: &Path) -> Result<SessionManifest, String> {
    read_json(&root.join("manifest.json"))
        .map_err(|e| format!("Could not read recording manifest: {e}"))
}

/// Seconds of audio a spool already holds, from the channel manifests.
///
/// A just-stopped recording is saved with the transcript still to come, and
/// its row used to report `0 minutes` until transcription finished — so a
/// 26-minute meeting displayed as "Untranscribed recording · 0 min", which
/// reads exactly like "your recording is gone". The spool has always known
/// the real length; nothing had asked it. Returns None for legacy WAV paths
/// and unreadable spools — callers keep their previous default.
pub fn recorded_duration_seconds(path: &str) -> Option<f64> {
    let root = Path::new(path);
    if !root.is_dir() || root.extension().and_then(|v| v.to_str()) != Some("adversaria-spool") {
        return None;
    }
    let longest = ["system", "mic"]
        .iter()
        .filter_map(|channel| {
            read_json::<ChannelManifest>(&root.join(format!("{channel}.json"))).ok()
        })
        .map(|manifest| manifest.committed_duration_ms)
        .max()?;
    (longest > 0).then(|| longest as f64 / 1000.0)
}

pub fn asset_snapshot(root: &Path) -> Result<(String, String, u64), String> {
    let session = read_session(root)?;
    let mut channels = Vec::new();
    let mut last_committed = 0u64;
    for channel in ["system", "mic"] {
        let path = root.join(format!("{channel}.json"));
        if !path.exists() {
            continue;
        }
        let manifest = read_json::<ChannelManifest>(&path)
            .map_err(|e| format!("Could not read {channel} manifest: {e}"))?;
        last_committed = last_committed.max(manifest.last_committed_chunk);
        channels.push(manifest);
    }
    let metadata = serde_json::to_string(&channels)
        .map_err(|e| format!("Could not serialize recording metadata: {e}"))?;
    Ok((session.session_id, metadata, last_committed))
}

pub fn mark_session_pending(root: &Path) -> Result<SessionManifest, String> {
    let mut manifest = read_session(root)?;
    manifest.state = "pending".to_string();
    manifest.updated_at = chrono::Utc::now().to_rfc3339();
    // Recover channel membership from authenticated stream manifests. A partial
    // final record is ignored by the decryptor; committed records survive.
    manifest.channels.clear();
    for channel in ["system", "mic"] {
        if root.join(format!("{channel}.json")).exists() {
            manifest.channels.push(channel.to_string());
        }
    }
    write_json_atomic(&root.join("manifest.json"), &manifest)
        .map_err(|e| format!("Could not update recovered recording manifest: {e}"))?;
    Ok(manifest)
}

pub fn remove_recording(path: &str) -> std::io::Result<()> {
    let path = Path::new(path);
    if path.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
}

pub fn janitor_processing_dir(recordings_dir: &Path) {
    let processing = recordings_dir.join(".processing");
    let Ok(entries) = std::fs::read_dir(&processing) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.path().extension().and_then(|v| v.to_str()) == Some("wav") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Process-lifetime cache of the recording encryption key. Fetching it hits the
/// OS keychain, which can prompt the user; without this it prompted on every
/// recording start, every transcription, and once per pending spool during
/// recovery — repeatedly, and annoyingly. Only a successful fetch is cached, so a
/// canceled/failed prompt is retried on the next call.
static RECORDING_KEY_CACHE: std::sync::Mutex<Option<[u8; 32]>> = std::sync::Mutex::new(None);

fn recording_key() -> Result<[u8; 32], String> {
    if let Some(key) = *RECORDING_KEY_CACHE.lock().unwrap() {
        return Ok(key);
    }
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| format!("Recording keychain is unavailable: {e}"))?;
    let hex = match entry.get_password() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => {
            let mut key = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut key);
            let value = hex_encode(&key);
            entry
                .set_password(&value)
                .map_err(|e| format!("Could not store the recording encryption key: {e}"))?;
            value
        }
        Err(e) => {
            return Err(format!(
                "Recording encryption key is unavailable ({e}). Unlock the OS keychain and try again; plaintext capture is never used as a fallback."
            ))
        }
    };
    let key = hex_decode::<32>(&hex)?;
    *RECORDING_KEY_CACHE.lock().unwrap() = Some(key);
    Ok(key)
}

fn additional_data(
    session_id: &str,
    channel: &str,
    chunk_index: u64,
    format: AudioFormat,
) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&serde_json::json!({
        "version": FORMAT_VERSION,
        "session_id": session_id,
        "channel": channel,
        "chunk_index": chunk_index,
        "sample_rate": format.sample_rate,
        "channels": format.channels,
        "bits_per_sample": format.bits_per_sample,
        "format_tag": format.format_tag,
    }))
    .map_err(|e| format!("Could not authenticate recording metadata: {e}"))
}

fn nonce_for(prefix: [u8; 16], counter: u64) -> [u8; 24] {
    let mut nonce = [0u8; 24];
    nonce[..16].copy_from_slice(&prefix);
    nonce[16..].copy_from_slice(&counter.to_be_bytes());
    nonce
}

fn legacy_mic_path(system_path: &str) -> Option<String> {
    system_path
        .strip_suffix(".wav")
        .map(|stem| format!("{stem}_mic.wav"))
        .filter(|path| Path::new(path).exists())
}

fn random_hex(bytes: usize) -> String {
    let mut value = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut value);
    hex_encode(&value)
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn hex_decode<const N: usize>(value: &str) -> Result<[u8; N], String> {
    if value.len() != N * 2 {
        return Err("Stored recording encryption metadata is malformed".to_string());
    }
    let mut out = [0u8; N];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| "Stored recording encryption metadata is malformed".to_string())?;
    }
    Ok(out)
}

fn create_private_dir(path: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn create_private_file(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    let temporary = path.with_extension("tmp");
    let bytes = serde_json::to_vec_pretty(value).map_err(std::io::Error::other)?;
    let mut file = create_private_file(&temporary)?;
    file.write_all(&bytes)?;
    file.flush()?;
    file.sync_all()?;
    std::fs::rename(temporary, path)?;
    Ok(())
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> std::io::Result<T> {
    let bytes = std::fs::read(path)?;
    serde_json::from_slice(&bytes).map_err(std::io::Error::other)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Seek, SeekFrom};

    fn test_root(label: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("adversaria-spool-test-{label}-{}", random_hex(8)));
        create_private_dir(&root).unwrap();
        root
    }

    fn finished_test_spool(base: &Path, key: [u8; 32], pcm: &[u8]) -> PathBuf {
        let session = SpoolSession::start_with_key(base, key).unwrap();
        session
            .system
            .sender()
            .send(Frame {
                bytes: pcm.to_vec(),
                format: AudioFormat {
                    sample_rate: 48_000,
                    channels: 2,
                    bits_per_sample: 16,
                    format_tag: 1,
                },
            })
            .unwrap();
        session.finish().unwrap()
    }

    #[test]
    fn nonce_combines_prefix_and_monotonic_counter() {
        let prefix = [7u8; 16];
        assert_ne!(nonce_for(prefix, 1), nonce_for(prefix, 2));
        assert_eq!(&nonce_for(prefix, 9)[..16], &prefix);
    }

    #[test]
    fn authenticated_metadata_changes_with_channel_and_format() {
        let format = AudioFormat {
            sample_rate: 48_000,
            channels: 2,
            bits_per_sample: 32,
            format_tag: 3,
        };
        assert_ne!(
            additional_data("s", "system", 0, format).unwrap(),
            additional_data("s", "mic", 0, format).unwrap()
        );
    }

    #[test]
    fn decrypts_committed_audio_and_ignores_incomplete_trailing_record() {
        let base = test_root("partial-tail");
        let key = [23u8; 32];
        let pcm = vec![0x2a; 96_000];
        let root = finished_test_spool(&base, key, &pcm);

        // Simulate a forced process termination while the next record header
        // is being appended. It was never added to the committed manifest.
        let mut records = OpenOptions::new()
            .append(true)
            .open(root.join("system.records"))
            .unwrap();
        records.write_all(&[9u8; 7]).unwrap();
        records.sync_all().unwrap();

        let processing = base.join("processing");
        create_private_dir(&processing).unwrap();
        let session_id = read_session(&root).unwrap().session_id;
        let wav = decrypt_channel(&root, &session_id, "system", key, &processing).unwrap();
        let decoded = std::fs::read(&wav).unwrap();
        assert_eq!(&decoded[44..], pcm.as_slice());
        let manifest = read_json::<ChannelManifest>(&root.join("system.json")).unwrap();
        assert_eq!(manifest.committed_plaintext_bytes, pcm.len() as u64);
        assert_eq!(manifest.committed_duration_ms, 500);

        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn rejects_tampering_in_a_committed_record_and_removes_temp_plaintext() {
        let base = test_root("tamper");
        let key = [41u8; 32];
        let root = finished_test_spool(&base, key, &[0x55; 8_192]);
        let records_path = root.join("system.records");
        let mut records = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&records_path)
            .unwrap();
        records.seek(SeekFrom::Start(26)).unwrap();
        let mut byte = [0u8; 1];
        records.read_exact(&mut byte).unwrap();
        byte[0] ^= 0xff;
        records.seek(SeekFrom::Start(26)).unwrap();
        records.write_all(&byte).unwrap();
        records.sync_all().unwrap();

        let processing = base.join("processing");
        create_private_dir(&processing).unwrap();
        let session_id = read_session(&root).unwrap().session_id;
        let error = decrypt_channel(&root, &session_id, "system", key, &processing).unwrap_err();
        assert!(error.contains("Authentication failed"), "{error}");
        assert_eq!(std::fs::read_dir(&processing).unwrap().count(), 0);

        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn wav_plan_passes_small_recordings_through() {
        assert_eq!(wav_output_plan(1_000, 2, 32, 3).unwrap(), (1_000, 2, false));
    }

    #[test]
    fn wav_plan_downmixes_oversized_multichannel_float() {
        // 45 min of 16-channel f32 @ 44.1 kHz — the real incident size.
        let (size, channels, downmix) = wav_output_plan(7_674_593_280, 16, 32, 3).unwrap();
        assert_eq!(channels, 1);
        assert!(downmix);
        assert_eq!(u64::from(size), 7_674_593_280u64 / 64 * 4);
    }

    #[test]
    fn wav_plan_rejects_oversized_mono() {
        assert!(wav_output_plan(u64::from(u32::MAX) + 1, 1, 32, 3).is_err());
    }

    #[test]
    fn downmix_averages_frames_and_carries_partial_frames() {
        let mut carry = Vec::new();
        let mut input = Vec::new();
        input.extend_from_slice(&0.5f32.to_le_bytes());
        input.extend_from_slice(&(-0.5f32).to_le_bytes());
        input.extend_from_slice(&[1, 2, 3]);
        let out = downmix_f32_to_mono(&mut carry, &input, 2);
        assert_eq!(out, 0.0f32.to_le_bytes().to_vec());
        assert_eq!(carry, vec![1, 2, 3]);
        let mut more = Vec::new();
        more.extend_from_slice(&[0, 0, 0, 0, 0]); // completes nothing meaningful but exercises carry growth
        let _ = downmix_f32_to_mono(&mut carry, &more, 2);
    }
}
