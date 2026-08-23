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
//!
//! Opus backend:
//! - `native-opus` (default): libopus via the `opus` crate
//! - `wasm-opus`: pure-Rust `rusty-opus` for browser WASM

use thiserror::Error;

/// Default sample rate used by TF2 Steam voice dumps / Valve's opus voice test.
pub const DEFAULT_SAMPLE_RATE: u32 = 24_000;
/// Offline demos are not bandwidth-bound; prefer clearer speech than live voice defaults.
pub const DEFAULT_BITRATE: i32 = 64_000;
/// 20 ms frames at 24 kHz.
pub const FRAME_SAMPLES: usize = 480;

#[derive(Debug, Error)]
pub enum SteamVoiceError {
    #[error("opus error: {0}")]
    Opus(String),
    #[error("frame too large for u16 length field ({0} bytes)")]
    FrameTooLarge(usize),
    #[error("invalid opus bitrate {0} (use 6000..=510000, or -1 for max / -1000 for auto)")]
    InvalidBitrate(i32),
}

#[cfg(feature = "native-opus")]
impl From<opus::Error> for SteamVoiceError {
    fn from(value: opus::Error) -> Self {
        Self::Opus(value.to_string())
    }
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

fn frame_samples_for_rate(sample_rate: u32) -> usize {
    match sample_rate {
        8_000 => 160,
        12_000 => 240,
        16_000 => 320,
        24_000 => 480,
        48_000 => 960,
        _ => ((sample_rate as usize) / 50).max(120), // ~20ms
    }
}

/// Encode PCM into Steam Voice datagrams suitable for `svc_VoiceData` payloads.
pub struct SteamVoiceEncoder {
    #[cfg(feature = "native-opus")]
    encoder: opus::Encoder,
    #[cfg(all(feature = "wasm-opus", not(feature = "native-opus")))]
    encoder: rusty_opus::OpusEncoder,
    sample_rate: u32,
    steam_id: u64,
    seq: u16,
    frame_samples: usize,
}

impl SteamVoiceEncoder {
    pub fn new(steam_id: u64, sample_rate: u32) -> Result<Self, SteamVoiceError> {
        Self::with_bitrate(steam_id, sample_rate, DEFAULT_BITRATE)
    }

    pub fn with_bitrate(
        steam_id: u64,
        sample_rate: u32,
        bitrate: i32,
    ) -> Result<Self, SteamVoiceError> {
        #[cfg(feature = "native-opus")]
        {
            use opus::{Application, Bitrate, Channels, Encoder};
            let mut encoder = Encoder::new(sample_rate, Channels::Mono, Application::Voip)?;
            let opus_bitrate = match bitrate {
                -1000 => Bitrate::Auto,
                -1 => Bitrate::Max,
                b if (6_000..=510_000).contains(&b) => Bitrate::Bits(b),
                other => return Err(SteamVoiceError::InvalidBitrate(other)),
            };
            encoder.set_bitrate(opus_bitrate)?;
            encoder.set_vbr(true)?;
            // Max effort — encode is offline; size/CPU are fine for demo injection.
            encoder.set_complexity(10)?;
            return Ok(Self {
                encoder,
                sample_rate,
                steam_id,
                seq: 0,
                frame_samples: frame_samples_for_rate(sample_rate),
            });
        }

        #[cfg(all(feature = "wasm-opus", not(feature = "native-opus")))]
        {
            use rusty_opus::{Application, Bandwidth, OpusEncoder, SignalType};
            let mut encoder = OpusEncoder::new(sample_rate as i32, 1, Application::Voip)
                .map_err(|e| SteamVoiceError::Opus(format!("{e:?}")))?;
            match bitrate {
                -1000 => {}
                -1 => encoder.bitrate_bps = 510_000,
                b if (6_000..=510_000).contains(&b) => encoder.bitrate_bps = b,
                other => return Err(SteamVoiceError::InvalidBitrate(other)),
            }
            encoder.use_cbr = false;
            // rusty-opus 0.1.x:
            // - complexity 10 panics on real speech (CELT short-MDCT buffer bug)
            // - Superwideband/hybrid bitstreams decode with a loud ~10 kHz whine in
            //   libopus / TF2. Force Wideband so packets interoperate cleanly.
            encoder.complexity = 5;
            encoder.signal_type = Some(SignalType::Voice);
            encoder.force_bandwidth = Some(Bandwidth::Wideband);
            encoder.max_bandwidth = Bandwidth::Wideband;
            return Ok(Self {
                encoder,
                sample_rate,
                steam_id,
                seq: 0,
                frame_samples: frame_samples_for_rate(sample_rate),
            });
        }

        #[cfg(not(any(feature = "native-opus", feature = "wasm-opus")))]
        {
            let _ = (steam_id, sample_rate, bitrate);
            compile_error!("enable feature native-opus or wasm-opus");
        }
    }

    pub fn frame_samples(&self) -> usize {
        self.frame_samples
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    fn encode_opus(&mut self, pcm: &[i16]) -> Result<Vec<u8>, SteamVoiceError> {
        #[cfg(feature = "native-opus")]
        {
            let mut opus_buf = vec![0u8; 4000];
            let n = self.encoder.encode(pcm, &mut opus_buf)?;
            return Ok(opus_buf[..n].to_vec());
        }

        #[cfg(all(feature = "wasm-opus", not(feature = "native-opus")))]
        {
            let mut f32_pcm = vec![0.0f32; pcm.len()];
            for (dst, &src) in f32_pcm.iter_mut().zip(pcm.iter()) {
                *dst = (src as f32) / 32768.0;
            }
            let mut opus_buf = vec![0u8; 4000];
            let n = self
                .encoder
                .encode(&f32_pcm, pcm.len(), &mut opus_buf)
                .map_err(|e| SteamVoiceError::Opus(format!("{e:?}")))?;
            return Ok(opus_buf[..n].to_vec());
        }

        #[cfg(not(any(feature = "native-opus", feature = "wasm-opus")))]
        {
            let _ = pcm;
            unreachable!()
        }
    }

    fn wrap_steam_packet(&self, plc: &[u8]) -> Result<Vec<u8>, SteamVoiceError> {
        if plc.len() > u16::MAX as usize {
            return Err(SteamVoiceError::FrameTooLarge(plc.len()));
        }
        let mut packet = Vec::with_capacity(8 + 3 + 3 + plc.len() + 4);
        packet.extend_from_slice(&self.steam_id.to_le_bytes());
        // SampleRate payload
        packet.push(0x0B);
        packet.extend_from_slice(&(self.sample_rate as u16).to_le_bytes());
        // OpusPlc payload
        packet.push(0x06);
        packet.extend_from_slice(&(plc.len() as u16).to_le_bytes());
        packet.extend_from_slice(plc);
        let crc = steam_crc32(&packet);
        packet.extend_from_slice(&crc.to_le_bytes());
        Ok(packet)
    }

    fn push_reset_segment(&mut self, plc: &mut Vec<u8>) {
        plc.extend_from_slice(&0xFFFFu16.to_le_bytes());
        plc.extend_from_slice(&self.seq.to_le_bytes());
        self.seq = self.seq.wrapping_add(1);
    }

    fn push_opus_segment(&mut self, plc: &mut Vec<u8>, opus: &[u8]) -> Result<(), SteamVoiceError> {
        if opus.len() > u16::MAX as usize {
            return Err(SteamVoiceError::FrameTooLarge(opus.len()));
        }
        plc.extend_from_slice(&(opus.len() as u16).to_le_bytes());
        plc.extend_from_slice(&self.seq.to_le_bytes());
        plc.extend_from_slice(opus);
        self.seq = self.seq.wrapping_add(1);
        Ok(())
    }

    /// Encode a single PCM frame into one complete Steam Voice packet (with CRC).
    pub fn encode_frame(&mut self, pcm: &[i16]) -> Result<Vec<u8>, SteamVoiceError> {
        self.encode_frame_inner(pcm, false)
    }

    fn encode_frame_inner(
        &mut self,
        pcm: &[i16],
        reset_decoder: bool,
    ) -> Result<Vec<u8>, SteamVoiceError> {
        let opus = self.encode_opus(pcm)?;
        let mut plc = Vec::with_capacity(8 + opus.len());
        if reset_decoder {
            // `opus_len == 0xFFFF` resets Steam / TF2 decoder state (talk-spurt start).
            self.push_reset_segment(&mut plc);
        }
        self.push_opus_segment(&mut plc, &opus)?;
        self.wrap_steam_packet(&plc)
    }

    /// Slice PCM into frames (zero-pad the last), encode each to a Steam Voice packet.
    ///
    /// The first datagram includes an Opus PLC reset (`0xFFFF`) so TF2 starts the
    /// decoder cleanly instead of inheriting leftover PLC state.
    pub fn encode_pcm(&mut self, pcm: &[i16]) -> Result<Vec<Vec<u8>>, SteamVoiceError> {
        let mut out = Vec::new();
        let mut offset = 0;
        while offset < pcm.len() {
            let end = (offset + self.frame_samples).min(pcm.len());
            let mut frame = vec![0i16; self.frame_samples];
            frame[..end - offset].copy_from_slice(&pcm[offset..end]);
            let reset = out.is_empty();
            out.push(self.encode_frame_inner(&frame, reset)?);
            offset = end;
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_encode_pcm_packet_starts_with_plc_reset() {
        let mut enc = SteamVoiceEncoder::new(76561198081400087, DEFAULT_SAMPLE_RATE).unwrap();
        let packets = enc.encode_pcm(&vec![1000i16; FRAME_SAMPLES * 2]).unwrap();
        assert_eq!(packets.len(), 2);
        for pkt in &packets {
            let (body, crc_bytes) = pkt.split_at(pkt.len() - 4);
            let crc = u32::from_le_bytes(crc_bytes.try_into().unwrap());
            assert_eq!(crc, steam_crc32(body));
        }
        // steamid(8) + 0x0B + rate(2) + 0x06 + len(2) = 14
        assert_eq!(&packets[0][14..16], &[0xFF, 0xFF]);
        assert_ne!(&packets[1][14..16], &[0xFF, 0xFF]);
    }

    #[test]
    fn crc_matches_known_vector() {
        let data = 0x0110000111C64B96u64.to_le_bytes();
        let _crc = steam_crc32(&data);
        let mut pkt = data.to_vec();
        pkt.push(0x0B);
        pkt.extend_from_slice(&24000u16.to_le_bytes());
        let crc2 = steam_crc32(&pkt);
        pkt.extend_from_slice(&crc2.to_le_bytes());

        #[cfg(feature = "extract")]
        {
            use steam_audio_codec::SteamVoiceData;
            let parsed = SteamVoiceData::new(&pkt).expect("crc must validate");
            assert_eq!(parsed.steam_id, 0x0110000111C64B96);
        }
        #[cfg(not(feature = "extract"))]
        {
            let _ = pkt;
        }
    }

    #[test]
    #[cfg(feature = "extract")]
    fn encode_decode_roundtrip_produces_pcm() {
        use steam_audio_codec::{SteamVoiceData, SteamVoiceDecoder};

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
        assert!(
            total > FRAME_SAMPLES * 3,
            "expected substantial decoded audio, got {total}"
        );
        // Signal should not be all zeros
        assert!(out.iter().take(total).any(|&s| s.abs() > 100));
    }
}
