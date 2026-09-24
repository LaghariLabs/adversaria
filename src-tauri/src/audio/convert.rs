//! Sample conversion for capture paths that receive the device's native mix
//! format (WASAPI on Windows).
//!
//! Both Windows streams are normalized to **mono float32 at a fixed rate** for
//! the whole recording, like the macOS mic path. That keeps one honest WAV
//! header per stream even when the endpoint changes mid-meeting (a headset
//! plugged in, a new default device with a different rate), and it stops a
//! multi-channel virtual device from multiplying the spool size by its channel
//! count (a 16-channel input once produced a 7.6 GB / 45 min mic track).
//!
//! Pure functions only, so the conversion is tested on every platform even
//! though only the Windows capture path calls it.

#![cfg_attr(not(windows), allow(dead_code))]

/// The native layout of one packet of interleaved samples.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct InputFormat {
    pub sample_rate: u32,
    pub channels: u16,
    pub bits_per_sample: u16,
    /// IEEE float samples (otherwise signed integer PCM, or unsigned 8-bit).
    pub float: bool,
}

impl InputFormat {
    pub fn block_align(&self) -> usize {
        usize::from(self.channels) * usize::from(self.bits_per_sample / 8)
    }

    /// Whether `append_mono_f32` can decode this layout.
    pub fn is_supported(&self) -> bool {
        self.channels > 0
            && self.sample_rate > 0
            && matches!(
                (self.float, self.bits_per_sample),
                (true, 32) | (true, 64) | (false, 8) | (false, 16) | (false, 24) | (false, 32)
            )
    }
}

/// Decode `data` (whole frames of interleaved `format` samples) and append one
/// mono float32 sample per frame to `out`, averaging the channels.
pub(crate) fn append_mono_f32(data: &[u8], format: &InputFormat, out: &mut Vec<f32>) {
    let channels = usize::from(format.channels.max(1));
    let width = usize::from(format.bits_per_sample / 8);
    let block = channels * width;
    if block == 0 || !format.is_supported() {
        return;
    }
    out.reserve(data.len() / block);
    for frame in data.chunks_exact(block) {
        let mut sum = 0.0f32;
        for sample in frame.chunks_exact(width) {
            sum += decode_sample(sample, format.float);
        }
        out.push(sum / channels as f32);
    }
}

fn decode_sample(bytes: &[u8], float: bool) -> f32 {
    match (float, bytes.len()) {
        (true, 4) => f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
        (true, 8) => {
            let mut raw = [0u8; 8];
            raw.copy_from_slice(bytes);
            f64::from_le_bytes(raw) as f32
        }
        // 8-bit WAV PCM is unsigned, centered on 128.
        (false, 1) => (f32::from(bytes[0]) - 128.0) / 128.0,
        (false, 2) => f32::from(i16::from_le_bytes([bytes[0], bytes[1]])) / 32_768.0,
        (false, 3) => {
            // Sign-extend the 24-bit sample through the top of an i32.
            let value = i32::from_le_bytes([0, bytes[0], bytes[1], bytes[2]]) >> 8;
            value as f32 / 8_388_608.0
        }
        (false, 4) => {
            i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f32 / 2_147_483_648.0
        }
        _ => 0.0,
    }
}

/// Little-endian bytes of float32 samples, the layout the spool stores.
pub(crate) fn f32_bytes(samples: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 4);
    for sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    out
}

/// Streaming linear resampler for mono float32.
///
/// Only used when a replacement endpoint runs at a different rate from the one
/// the recording started on; speech transcription at 16 kHz does not need a
/// higher-order filter, and the common case (same rate) is a plain copy.
#[derive(Debug, Clone)]
pub(crate) struct LinearResampler {
    /// Input samples advanced per output sample (in_rate / out_rate).
    step: f64,
    /// Read position relative to the next input block; `-1.0` addresses `last`.
    pos: f64,
    /// Final sample of the previous block, for interpolating across blocks.
    last: Option<f32>,
}

impl LinearResampler {
    pub fn new(in_rate: u32, out_rate: u32) -> Self {
        Self {
            step: f64::from(in_rate.max(1)) / f64::from(out_rate.max(1)),
            pos: 0.0,
            last: None,
        }
    }

    pub fn is_passthrough(&self) -> bool {
        (self.step - 1.0).abs() < f64::EPSILON
    }

    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if input.is_empty() {
            return;
        }
        if self.is_passthrough() {
            out.extend_from_slice(input);
            return;
        }
        // Before the first block `pos` is 0.0, so `previous` is never read.
        let previous = self.last.unwrap_or(input[0]);
        let at = |index: isize| -> f32 {
            if index < 0 {
                previous
            } else {
                input[index as usize]
            }
        };
        let last_index = input.len() as f64 - 1.0;
        while self.pos < last_index {
            let base = self.pos.floor();
            let frac = (self.pos - base) as f32;
            let a = at(base as isize);
            let b = at(base as isize + 1);
            out.push(a + (b - a) * frac);
            self.pos += self.step;
        }
        self.pos -= input.len() as f64;
        self.last = Some(input[input.len() - 1]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn format(channels: u16, bits: u16, float: bool) -> InputFormat {
        InputFormat {
            sample_rate: 48_000,
            channels,
            bits_per_sample: bits,
            float,
        }
    }

    #[test]
    fn float_stereo_is_averaged_to_mono() {
        let mut data = Vec::new();
        for sample in [0.5f32, -0.5, 1.0, 0.0] {
            data.extend_from_slice(&sample.to_le_bytes());
        }
        let mut out = Vec::new();
        append_mono_f32(&data, &format(2, 32, true), &mut out);
        assert_eq!(out, vec![0.0, 0.5]);
    }

    #[test]
    fn integer_pcm_widths_decode_to_unit_range() {
        let mut out = Vec::new();
        append_mono_f32(&i16::MIN.to_le_bytes(), &format(1, 16, false), &mut out);
        append_mono_f32(&[0x00, 0x00, 0x40], &format(1, 24, false), &mut out); // +0.5
        append_mono_f32(&[0xFF, 0xFF, 0xFF], &format(1, 24, false), &mut out); // -1 LSB
        append_mono_f32(
            &(i32::MAX / 2).to_le_bytes(),
            &format(1, 32, false),
            &mut out,
        );
        append_mono_f32(&[128], &format(1, 8, false), &mut out);
        assert_eq!(out[0], -1.0);
        assert!((out[1] - 0.5).abs() < 1e-6);
        assert!(out[2] < 0.0 && out[2] > -1e-6);
        assert!((out[3] - 0.5).abs() < 1e-6);
        assert_eq!(out[4], 0.0);
    }

    #[test]
    fn many_channel_virtual_devices_shrink_to_one_channel() {
        // 16 channels of int16: 32 bytes per frame in, 4 bytes per frame out.
        let frame: Vec<u8> = (0..16).flat_map(|_| 16_384i16.to_le_bytes()).collect();
        let data: Vec<u8> = frame
            .iter()
            .copied()
            .cycle()
            .take(frame.len() * 10)
            .collect();
        let mut out = Vec::new();
        append_mono_f32(&data, &format(16, 16, false), &mut out);
        assert_eq!(out.len(), 10);
        assert!(out.iter().all(|s| (s - 0.5).abs() < 1e-6));
        assert_eq!(f32_bytes(&out).len(), 40);
    }

    #[test]
    fn partial_frames_and_unsupported_formats_are_ignored() {
        let mut out = Vec::new();
        append_mono_f32(&[0, 0, 0], &format(1, 16, false), &mut out);
        assert_eq!(out.len(), 1);
        append_mono_f32(&[0; 12], &format(1, 12, false), &mut out);
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn same_rate_resampling_is_a_copy() {
        let mut resampler = LinearResampler::new(48_000, 48_000);
        let mut out = Vec::new();
        resampler.process(&[0.1, 0.2, 0.3], &mut out);
        assert_eq!(out, vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn resampling_keeps_duration_across_blocks() {
        // One second of 44.1 kHz fed in uneven blocks comes out as ~1 s at 48 kHz.
        let mut resampler = LinearResampler::new(44_100, 48_000);
        let input: Vec<f32> = (0..44_100).map(|i| i as f32 / 44_100.0).collect();
        let mut out = Vec::new();
        for block in input.chunks(441 * 7) {
            resampler.process(block, &mut out);
        }
        assert!((out.len() as i64 - 48_000).abs() <= 2, "{}", out.len());
        // A ramp stays a monotonic ramp: no seams at block boundaries.
        assert!(out.windows(2).all(|pair| pair[1] >= pair[0]));
        assert_eq!(out[0], 0.0);
    }

    #[test]
    fn downsampling_halves_the_sample_count() {
        let mut resampler = LinearResampler::new(96_000, 48_000);
        let input = vec![0.25f32; 9_600];
        let mut out = Vec::new();
        resampler.process(&input, &mut out);
        assert!((out.len() as i64 - 4_800).abs() <= 1);
        assert!(out.iter().all(|s| (s - 0.25).abs() < 1e-6));
    }
}
