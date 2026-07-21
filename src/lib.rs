//! Inject external audio into TF2 SourceTV demos as Steam voice chat (`svc_VoiceData`).
//!
//! Pipeline:
//! 1. Load PCM from a WAV (or decode via ffmpeg externally to WAV)
//! 2. Encode frames as Steam Voice (steamid + sample-rate + Opus PLC + CRC32)
//! 3. Rewrite the demo, appending `svc_VoiceData` messages onto packets at target ticks

pub mod audio;
pub mod inject;
pub mod steam_voice;
pub mod steamid;

pub use audio::{load_mono_pcm, Loudness};
pub use inject::{inject_comms, InspectReport, InjectOptions, PlayerSlot};
pub use steam_voice::{SteamVoiceEncoder, DEFAULT_SAMPLE_RATE, FRAME_SAMPLES};
pub use steamid::{parse_steam_id, steam_id_to_u64};
