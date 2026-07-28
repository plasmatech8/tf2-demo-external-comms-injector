use std::path::PathBuf;

use anyhow::Result;
use clap::Parser;
use tf2_demo_comms_injector::inject::{inject_comms, InjectOptions};
use tf2_demo_comms_injector::{Loudness, DEFAULT_BITRATE, DEFAULT_SAMPLE_RATE};

#[derive(Debug, Parser)]
#[command(
    name = "inject-comms",
    about = "Inject external audio into a TF2 demo as Steam voice chat (svc_VoiceData)"
)]
struct Args {
    /// Input .dem file
    demo: PathBuf,
    /// Input audio (.wav, mono/stereo PCM). Convert with ffmpeg if needed.
    audio: PathBuf,
    /// Output .dem path
    #[arg(short, long)]
    output: PathBuf,
    /// Demo-time inject start in seconds. Default: auto teamplay_round_start (else 0).
    /// This is NOT “game start in your recording” — use --audio-skip for that.
    #[arg(long)]
    offset: Option<f32>,
    /// Seconds to skip from the start of the input audio (game start / end of countdown in the recording).
    #[arg(long, default_value_t = 0.0)]
    audio_skip: f32,
    /// Loudness gain as dB (e.g. -6, 0, 3)
    #[arg(long, default_value_t = 0.0)]
    loudness_db: f32,
    /// Linear gain (overrides --loudness-db when set)
    #[arg(long)]
    gain: Option<f32>,
    /// Attribute voice to this player name (substring, case-insensitive)
    #[arg(long)]
    player: Option<String>,
    /// Attribute voice to this SteamID (steamid64 / STEAM_X:Y:Z / [U:1:n])
    #[arg(long)]
    steam_id: Option<String>,
    /// Explicit client slot index (0-based)
    #[arg(long)]
    client_index: Option<u8>,
    /// Opus/Steam voice sample rate (use 24000 for in-game TF2 playback)
    #[arg(long, default_value_t = DEFAULT_SAMPLE_RATE)]
    sample_rate: u32,
    /// Opus bitrate in bits/sec (default 64000). Higher = clearer; -1 = max.
    #[arg(long, default_value_t = DEFAULT_BITRATE)]
    bitrate: i32,
    /// Remove existing voice for the chosen client during the injection window
    #[arg(long, default_value_t = false)]
    replace_existing: bool,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let loudness = if let Some(g) = args.gain {
        Loudness::from_gain(g)
    } else {
        Loudness::from_db(args.loudness_db)
    };

    let result = inject_comms(InjectOptions {
        demo_path: args.demo,
        audio_path: args.audio,
        output_path: args.output,
        offset_secs: args.offset,
        audio_skip_secs: args.audio_skip,
        loudness,
        player_name: args.player,
        steam_id: args.steam_id,
        client_index: args.client_index,
        sample_rate: args.sample_rate,
        bitrate: args.bitrate,
        replace_existing: args.replace_existing,
    })?;

    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}
