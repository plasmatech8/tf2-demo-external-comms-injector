use std::path::PathBuf;

use anyhow::Result;
use clap::Parser;
use tf2_demo_comms_injector::inject::inspect_demo;

#[derive(Debug, Parser)]
#[command(name = "inspect-demo", about = "Summarize TF2 demo players and voice metadata")]
struct Args {
    demo: PathBuf,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let report = inspect_demo(&args.demo)?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
