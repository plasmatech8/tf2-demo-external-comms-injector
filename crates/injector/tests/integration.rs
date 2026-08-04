//! Integration-style tests that do not require a full STV demo download.

use std::io::Write;
use tempfile::tempdir;
use tf2_demo_comms_injector::steam_voice::{
    steam_crc32, SteamVoiceEncoder, DEFAULT_SAMPLE_RATE, FRAME_SAMPLES,
};
use steam_audio_codec::SteamVoiceData;

#[test]
fn encoder_packets_are_crc_valid_and_sized() {
    let mut enc = SteamVoiceEncoder::new(76561198081400087, DEFAULT_SAMPLE_RATE).unwrap();
    let pcm = vec![1000i16; FRAME_SAMPLES * 3];
    let packets = enc.encode_pcm(&pcm).unwrap();
    assert_eq!(packets.len(), 3);
    for pkt in packets {
        assert!(pkt.len() > 16);
        SteamVoiceData::new(&pkt).expect("crc");
        let (body, crc_bytes) = pkt.split_at(pkt.len() - 4);
        let crc = u32::from_le_bytes(crc_bytes.try_into().unwrap());
        assert_eq!(crc, steam_crc32(body));
    }
}

#[test]
fn wav_loudness_and_load_roundtrip() {
    use hound::{SampleFormat, WavSpec, WavWriter};
    use tf2_demo_comms_injector::audio::{load_mono_pcm, Loudness};

    let dir = tempdir().unwrap();
    let path = dir.path().join("t.wav");
    let spec = WavSpec {
        channels: 1,
        sample_rate: 24000,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    {
        let mut w = WavWriter::create(&path, spec).unwrap();
        for i in 0..4800 {
            let s = ((i as f32 / 24000.0 * 440.0 * 2.0 * std::f32::consts::PI).sin()
                * 1000.0) as i16;
            w.write_sample(s).unwrap();
        }
        w.finalize().unwrap();
    }
    let pcm = load_mono_pcm(&path, 24000, Loudness::from_db(6.0)).unwrap();
    assert!(!pcm.is_empty());
    // +6 dB ≈ *2
    assert!(pcm.iter().map(|s| s.abs()).max().unwrap() > 1500);
}

#[test]
fn wav_24bit_scales_into_audible_i16_range() {
    use hound::{SampleFormat, WavSpec, WavWriter};
    use tf2_demo_comms_injector::audio::{load_mono_pcm, Loudness};

    let dir = tempdir().unwrap();
    let path = dir.path().join("t24.wav");
    let spec = WavSpec {
        channels: 1,
        sample_rate: 24000,
        bits_per_sample: 24,
        sample_format: SampleFormat::Int,
    };
    {
        let mut w = WavWriter::create(&path, spec).unwrap();
        // Peak near full-scale 24-bit (sign-extended into i32 low 24 bits).
        w.write_sample(4_000_000i32).unwrap();
        w.write_sample(-4_000_000i32).unwrap();
        w.finalize().unwrap();
    }
    let pcm = load_mono_pcm(&path, 24000, Loudness::from_gain(1.0)).unwrap();
    assert_eq!(pcm.len(), 2);
    // >> 8 keeps amplitude; >> 16 would collapse this to ~±61.
    assert!(pcm[0].abs() > 10_000, "got {}", pcm[0]);
    assert!(pcm[1].abs() > 10_000, "got {}", pcm[1]);
}

#[test]
fn write_tiny_marker_file() {
    // Keeps tempfile dependency exercised in CI without needing network demos.
    let dir = tempdir().unwrap();
    let p = dir.path().join("marker.txt");
    std::fs::File::create(&p)
        .unwrap()
        .write_all(b"ok")
        .unwrap();
    assert_eq!(std::fs::read_to_string(p).unwrap(), "ok");
}
