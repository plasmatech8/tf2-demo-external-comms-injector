use std::path::PathBuf;

use anyhow::Result;
use clap::Parser;
use tf2_demo_comms_injector::inject::extract_voice_wav;

#[derive(Debug, Parser)]
#[command(
    name = "extract-voice",
    about = "Extract and decode Steam voice from a TF2 demo into a WAV"
)]
struct Args {
    demo: PathBuf,
    #[arg(short, long)]
    output: PathBuf,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let stats = extract_voice_wav(&args.demo, &args.output)?;
    println!("{}", serde_json::to_string_pretty(&stats)?);
    Ok(())
}
