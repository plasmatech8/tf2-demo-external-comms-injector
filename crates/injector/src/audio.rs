//! Audio loading and loudness adjustment.

use hound::{SampleFormat, WavReader};
use std::io::Cursor;
use std::path::Path;
use thiserror::Error;

use crate::steam_voice::DEFAULT_SAMPLE_RATE;

#[derive(Debug, Error)]
pub enum AudioError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("wav error: {0}")]
    Wav(#[from] hound::Error),
    #[error("unsupported wav format (need PCM integer samples)")]
    UnsupportedFormat,
    #[error("empty audio")]
    Empty,
}

#[derive(Debug, Clone, Copy)]
pub struct Loudness {
    /// Linear gain multiplier (1.0 = unchanged). Prefer this or `db`.
    pub gain: f32,
}

impl Loudness {
    pub fn from_db(db: f32) -> Self {
        Self {
            gain: 10f32.powf(db / 20.0),
        }
    }

    pub fn from_gain(gain: f32) -> Self {
        Self { gain }
    }

    pub fn apply(&self, samples: &mut [i16]) {
        if (self.gain - 1.0).abs() < f32::EPSILON {
            return;
        }
        for s in samples {
            let v = (*s as f32) * self.gain;
            *s = v.clamp(i16::MIN as f32, i16::MAX as f32) as i16;
        }
    }
}

/// Load a WAV as mono PCM at `target_rate` (default 24 kHz), applying simple nearest/linear resample.
pub fn load_mono_pcm(path: &Path, target_rate: u32, loudness: Loudness) -> Result<Vec<i16>, AudioError> {
    let mut reader = WavReader::open(path)?;
    load_mono_pcm_from_reader(&mut reader, target_rate, loudness)
}

/// Load mono PCM from in-memory WAV bytes (browser / WASM path).
pub fn load_mono_pcm_from_bytes(
    wav: &[u8],
    target_rate: u32,
    loudness: Loudness,
) -> Result<Vec<i16>, AudioError> {
    let mut reader = WavReader::new(Cursor::new(wav))?;
    load_mono_pcm_from_reader(&mut reader, target_rate, loudness)
}

fn load_mono_pcm_from_reader<R: std::io::Read>(
    reader: &mut WavReader<R>,
    target_rate: u32,
    loudness: Loudness,
) -> Result<Vec<i16>, AudioError> {
    let spec = reader.spec();
    if spec.sample_format != SampleFormat::Int {
        return Err(AudioError::UnsupportedFormat);
    }

    let channels = spec.channels as usize;
    let interleaved: Vec<i16> = match spec.bits_per_sample {
        16 => reader.samples::<i16>().collect::<Result<Vec<_>, _>>()?,
        8 => reader
            .samples::<i8>()
            .map(|r| r.map(|s| (s as i16) << 8))
            .collect::<Result<Vec<_>, _>>()?,
        // hound yields i32 for both; 24-bit is sign-extended in the low 24 bits.
        24 => reader
            .samples::<i32>()
            .map(|r| r.map(|s| (s >> 8) as i16))
            .collect::<Result<Vec<_>, _>>()?,
        32 => reader
            .samples::<i32>()
            .map(|r| r.map(|s| (s >> 16) as i16))
            .collect::<Result<Vec<_>, _>>()?,
        _ => return Err(AudioError::UnsupportedFormat),
    };

    if interleaved.is_empty() {
        return Err(AudioError::Empty);
    }

    // Downmix to mono
    let mut mono = Vec::with_capacity(interleaved.len() / channels.max(1));
    if channels <= 1 {
        mono = interleaved;
    } else {
        for chunk in interleaved.chunks(channels) {
            let sum: i32 = chunk.iter().map(|&s| s as i32).sum();
            mono.push((sum / channels as i32) as i16);
        }
    }

    let src_rate = spec.sample_rate;
    let mut pcm = if src_rate == target_rate {
        mono
    } else {
        resample_linear(&mono, src_rate, target_rate)
    };

    loudness.apply(&mut pcm);
    Ok(pcm)
}

fn resample_linear(input: &[i16], src_rate: u32, dst_rate: u32) -> Vec<i16> {
    if input.is_empty() {
        return Vec::new();
    }
    let out_len = (input.len() as u64 * dst_rate as u64 / src_rate as u64).max(1) as usize;
    let mut out = vec![0i16; out_len];
    let scale = src_rate as f64 / dst_rate as f64;
    for (i, sample) in out.iter_mut().enumerate() {
        let src_pos = i as f64 * scale;
        let i0 = src_pos.floor() as usize;
        let i1 = (i0 + 1).min(input.len() - 1);
        let frac = src_pos - i0 as f64;
        let a = input[i0.min(input.len() - 1)] as f64;
        let b = input[i1] as f64;
        *sample = (a + (b - a) * frac) as i16;
    }
    out
}

pub fn default_target_rate() -> u32 {
    DEFAULT_SAMPLE_RATE
}
