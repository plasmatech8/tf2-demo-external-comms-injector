//! Dump early round-related game events with demo time.
use std::path::PathBuf;

use anyhow::Result;
use bitbuffer::BitRead;
use clap::Parser;
use tf_demo_parser::demo::data::DemoTick;
use tf_demo_parser::demo::gameevent_gen::GameEvent;
use tf_demo_parser::demo::header::Header;
use tf_demo_parser::demo::message::{Message, MessageType};
use tf_demo_parser::demo::parser::{DemoHandler, MessageHandler, RawPacketStream};
use tf_demo_parser::{Demo, ParserState};

#[derive(Parser, Debug)]
struct Args {
    demo: PathBuf,
    /// Only print events in the first N seconds (default 60)
    #[arg(long, default_value_t = 60.0)]
    first_secs: f32,
}

struct EventDump {
    tickrate: f32,
    max_tick: u32,
    rows: Vec<(u32, String)>,
}

impl MessageHandler for EventDump {
    type Output = Vec<(u32, String)>;

    fn does_handle(message_type: MessageType) -> bool {
        matches!(message_type, MessageType::GameEvent | MessageType::GameEventList)
    }

    fn handle_message(&mut self, message: &Message, tick: DemoTick, _state: &ParserState) {
        let tick_u: u32 = tick.into();
        if tick_u > self.max_tick {
            return;
        }
        if let Message::GameEvent(ev) = message {
            let name = match &ev.event {
                GameEvent::RoundStart(_) => Some(format!("round_start")),
                GameEvent::TeamPlayRoundStart(_) => Some(format!("teamplay_round_start")),
                GameEvent::TeamPlayRoundActive(_) => Some(format!("teamplay_round_active")),
                GameEvent::TeamPlaySetupFinished(_) => Some(format!("teamplay_setup_finished")),
                GameEvent::TeamPlayWaitingBegins(_) => Some(format!("teamplay_waiting_begins")),
                GameEvent::TeamPlayWaitingEnds(_) => Some(format!("teamplay_waiting_ends")),
                GameEvent::TeamPlayRoundRestartSeconds(e) => {
                    Some(format!("teamplay_round_restart_seconds(seconds={})", e.seconds))
                }
                GameEvent::ArenaRoundStart(_) => Some(format!("arena_round_start")),
                GameEvent::TeamPlayGameOver(_) => Some(format!("teamplay_game_over")),
                GameEvent::TfGameOver(_) => Some(format!("tf_game_over")),
                _ => None,
            };
            if let Some(n) = name {
                self.rows.push((tick_u, n));
            }
        }
    }

    fn into_output(self, _state: &ParserState) -> Self::Output {
        self.rows
    }
}

fn main() -> Result<()> {
    let args = Args::parse();
    let file = std::fs::read(&args.demo)?;
    let demo = Demo::new(&file);
    let mut stream = demo.get_stream();
    let header = Header::read(&mut stream)?;
    let tickrate = if header.ticks > 0 && header.duration > 0.0 {
        header.ticks as f32 / header.duration
    } else {
        66.666
    };
    let max_tick = (args.first_secs * tickrate).ceil() as u32;

    let mut packets = RawPacketStream::new(stream);
    let mut handler = DemoHandler::parse_all_with_analyser(EventDump {
        tickrate,
        max_tick,
        rows: Vec::new(),
    });

    while let Some(packet) = packets.next(&handler.state_handler)? {
        handler.handle_packet(packet)?;
    }

    let rows = handler.into_output();
    println!(
        "map={} duration={:.3}s ticks={} tickrate={:.3}",
        header.map, header.duration, header.ticks, tickrate
    );
    println!("events in first {:.1}s:", args.first_secs);
    for (tick, name) in rows {
        let t = tick as f32 / tickrate;
        println!("  t={t:7.3}s  tick={tick:<7}  {name}");
    }
    Ok(())
}
