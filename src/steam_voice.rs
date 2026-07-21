//! Steam Voice packet encoder (wrapper around Opus PLC).
//!
//! Packet layout (from public reverse engineering / demostf steam-audio-codec):
//! ```text
//! steamid64 (u64 LE)
//! payload type 0x0B + sample_rate (u16 LE)     // SampleRate
//! payload type 0x06 + byte_len (u16 LE) + data // OpusPlc
//!   data = repeated: frame_len (u16) + seq (u16) + opus_bytes
//! CRC32 (u32 LE) over all preceding bytes
//! ```

use opus::{Application, Bitrate, Channels, Encoder};
use thiserror::Error;

/// Default sample rate used by TF2 Steam voice dumps / Valve's opus voice test.
pub const DEFAULT_SAMPLE_RATE: u32 = 24_000;
/// 20 ms frames at 24 kHz.
pub const FRAME_SAMPLES: usize = 480;

#[derive(Debug, Error)]
pub enum SteamVoiceError {
    #[error("opus error: {0}")]
    Opus(#[from] opus::Error),
    #[error("frame too large for u16 length field ({0} bytes)")]
    FrameTooLarge(usize),
}

/// CRC32 matching Steam voice / demostf `crc32b` (IEEE, reflected).
pub fn steam_crc32(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for &byte in data {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            let mask = 0u32.wrapping_sub(crc & 1);
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

/// Encode PCM into Steam Voice datagrams suitable for `svc_VoiceData` payloads.
pub struct SteamVoiceEncoder {
    encoder: Encoder,
    sample_rate: u32,
    steam_id: u64,
    seq: u16,
    frame_samples: usize,
}

impl SteamVoiceEncoder {
    pub fn new(steam_id: u64, sample_rate: u32) -> Result<Self, SteamVoiceError> {
        let mut encoder = Encoder::new(sample_rate, Channels::Mono, Application::Voip)?;
        // ~22 kbps is in the ballpark of in-game voice; keep quality usable for comms.
        encoder.set_bitrate(Bitrate::Bits(24_000))?;
        encoder.set_vbr(true)?;
        Ok(Self {
            encoder,
            sample_rate,
            steam_id,
            seq: 0,
            frame_samples: match sample_rate {
                8_000 => 160,
                12_000 => 240,
                16_000 => 320,
                24_000 => 480,
                48_000 => 960,
                _ => ((sample_rate as usize) / 50).max(120), // ~20ms
            },
        })
    }

    pub fn frame_samples(&self) -> usize {
        self.frame_samples
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// Encode a single PCM frame into one complete Steam Voice packet (with CRC).
    pub fn encode_frame(&mut self, pcm: &[i16]) -> Result<Vec<u8>, SteamVoiceError> {
        let mut opus_buf = vec![0u8; 4000];
        let n = self.encoder.encode(pcm, &mut opus_buf)?;
        let opus = &opus_buf[..n];
        if opus.len() > u16::MAX as usize {
            return Err(SteamVoiceError::FrameTooLarge(opus.len()));
        }

        let mut plc = Vec::with_capacity(4 + opus.len());
        plc.extend_from_slice(&(opus.len() as u16).to_le_bytes());
        plc.extend_from_slice(&self.seq.to_le_bytes());
        plc.extend_from_slice(opus);
        self.seq = self.seq.wrapping_add(1);

        let mut packet = Vec::with_capacity(8 + 3 + 3 + plc.len() + 4);
        packet.extend_from_slice(&self.steam_id.to_le_bytes());
        // SampleRate payload
        packet.push(0x0B);
        packet.extend_from_slice(&(self.sample_rate as u16).to_le_bytes());
        // OpusPlc payload
        packet.push(0x06);
        packet.extend_from_slice(&(plc.len() as u16).to_le_bytes());
        packet.extend_from_slice(&plc);
        let crc = steam_crc32(&packet);
        packet.extend_from_slice(&crc.to_le_bytes());
        Ok(packet)
    }

    /// Slice PCM into frames (zero-pad the last), encode each to a Steam Voice packet.
    pub fn encode_pcm(&mut self, pcm: &[i16]) -> Result<Vec<Vec<u8>>, SteamVoiceError> {
        let mut out = Vec::new();
        let mut offset = 0;
        while offset < pcm.len() {
            let end = (offset + self.frame_samples).min(pcm.len());
            let mut frame = vec![0i16; self.frame_samples];
            frame[..end - offset].copy_from_slice(&pcm[offset..end]);
            out.push(self.encode_frame(&frame)?);
            offset = end;
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use steam_audio_codec::{SteamVoiceData, SteamVoiceDecoder};

    #[test]
    fn crc_matches_known_vector() {
        // Empty payload CRC of just steamid is deterministic
        let data = 0x0110000111C64B96u64.to_le_bytes();
        let _crc = steam_crc32(&data);
        // Round-trip via decode validation path: build minimal invalid-ish packet
        let mut pkt = data.to_vec();
        pkt.push(0x0B);
        pkt.extend_from_slice(&24000u16.to_le_bytes());
        let crc2 = steam_crc32(&pkt);
        pkt.extend_from_slice(&crc2.to_le_bytes());
        let parsed = SteamVoiceData::new(&pkt).expect("crc must validate");
        assert_eq!(parsed.steam_id, 0x0110000111C64B96);
    }

    #[test]
    fn encode_decode_roundtrip_produces_pcm() {
        let mut enc = SteamVoiceEncoder::new(76561198024494988, DEFAULT_SAMPLE_RATE).unwrap();
        // 440 Hz tone
        let mut pcm = vec![0i16; FRAME_SAMPLES * 5];
        for (i, s) in pcm.iter_mut().enumerate() {
            let t = i as f32 / DEFAULT_SAMPLE_RATE as f32;
            *s = ((t * 440.0 * 2.0 * std::f32::consts::PI).sin() * 0.3 * i16::MAX as f32) as i16;
        }
        let packets = enc.encode_pcm(&pcm).unwrap();
        assert!(!packets.is_empty());

        let mut dec = SteamVoiceDecoder::new();
        let mut out = vec![0i16; 8192];
        let mut total = 0usize;
        for pkt in &packets {
            let data = SteamVoiceData::new(pkt).expect("our packets must CRC-validate");
            assert_eq!(data.steam_id, 76561198024494988);
            let n = dec.decode(data, &mut out).expect("decode");
            total += n;
        }
        assert!(total > FRAME_SAMPLES * 3, "expected substantial decoded audio, got {total}");
        // Signal should not be all zeros
        assert!(out.iter().take(total).any(|&s| s.abs() > 100));
    }
}
