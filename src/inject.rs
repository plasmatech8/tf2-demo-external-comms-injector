//! Demo inspection and voice-injection rewrite.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use bitbuffer::{BitRead, BitReadBuffer, BitReadStream, BitWrite, LittleEndian};
use serde::Serialize;
use tf_demo_parser::demo::data::DemoTick;
use tf_demo_parser::demo::header::Header;
use tf_demo_parser::demo::message::voice::VoiceDataMessage;
use tf_demo_parser::demo::message::Message;
use tf_demo_parser::demo::packet::stringtable::StringTablePacket;
use tf_demo_parser::demo::packet::{Packet, PacketType};
use tf_demo_parser::demo::parser::{DemoHandler, Encode, NullHandler, RawPacketStream};
use tf_demo_parser::{Demo, MessageType};

use crate::audio::{load_mono_pcm, Loudness};
use crate::steam_voice::{SteamVoiceEncoder, DEFAULT_SAMPLE_RATE};
use crate::steamid::parse_steam_id;

#[derive(Debug, Clone, Serialize)]
pub struct PlayerSlot {
    pub client_index: u8,
    pub entity_id: u32,
    pub user_id: u32,
    pub name: String,
    pub steam_id: String,
    pub steam_id64: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InspectReport {
    pub map: String,
    pub server: String,
    pub duration_secs: f32,
    pub ticks: u32,
    pub frames: u32,
    pub tickrate: f32,
    pub voice_init: Option<VoiceInitSummary>,
    pub existing_voice_packets: usize,
    pub players: Vec<PlayerSlot>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VoiceInitSummary {
    pub codec: String,
    pub quality: u8,
    pub sampling_rate: u16,
}

#[derive(Debug, Clone)]
pub struct InjectOptions {
    pub demo_path: std::path::PathBuf,
    pub audio_path: std::path::PathBuf,
    pub output_path: std::path::PathBuf,
    /// Start time in seconds from demo start.
    pub offset_secs: f32,
    pub loudness: Loudness,
    /// Prefer matching by name substring (case-insensitive).
    pub player_name: Option<String>,
    /// Prefer matching by steam id (any common format).
    pub steam_id: Option<String>,
    /// Explicit client index (0-based slot) override.
    pub client_index: Option<u8>,
    pub sample_rate: u32,
    /// If true, replace existing voice for the chosen client in the injection window.
    pub replace_existing: bool,
}

#[derive(Debug, Serialize)]
pub struct InjectResult {
    pub output: String,
    pub player: PlayerSlot,
    pub start_tick: u32,
    pub packets_injected: usize,
    pub voice_init: Option<VoiceInitSummary>,
}

/// Inspect a demo for players, voice codec, and timing metadata.
pub fn inspect_demo(path: &Path) -> Result<InspectReport> {
    let file = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let demo = Demo::new(&file);
    let mut stream = demo.get_stream();
    let header = Header::read(&mut stream)?;
    let mut packets = RawPacketStream::new(stream);
    let mut handler = DemoHandler::parse_all_with_analyser(NullHandler);

    let mut voice_init = None;
    let mut voice_count = 0usize;
    let mut players: BTreeMap<u8, PlayerSlot> = BTreeMap::new();
    let mut tickrate = if header.ticks > 0 && header.duration > 0.0 {
        header.ticks as f32 / header.duration
    } else {
        66.666
    };

    while let Some(packet) = packets.next(&handler.state_handler)? {
        match &packet {
            Packet::Signon(msg) | Packet::Message(msg) => {
                for message in &msg.messages {
                    match message {
                        Message::VoiceInit(init) => {
                            voice_init = Some(VoiceInitSummary {
                                codec: init.codec.clone(),
                                quality: init.quality,
                                sampling_rate: init.sampling_rate,
                            });
                        }
                        Message::VoiceData(_) => voice_count += 1,
                        Message::ServerInfo(info) => {
                            if info.interval_per_tick > 0.0 {
                                tickrate = 1.0 / info.interval_per_tick;
                            }
                        }
                        _ => {}
                    }
                }
            }
            Packet::StringTables(tables) => {
                collect_players_from_stringtables(tables, &mut players)?;
            }
            _ => {}
        }

        // Also catch CreateStringTable / UpdateStringTable carrying userinfo
        if let Packet::Signon(msg) | Packet::Message(msg) = &packet {
            for message in &msg.messages {
                if let Message::CreateStringTable(create) = message {
                    if create.table.name == "userinfo" {
                        for (idx, entry) in &create.table.entries {
                            if let Some(player) = player_from_entry(*idx, entry)? {
                                players.insert(player.client_index, player);
                            }
                        }
                    }
                }
                if let Message::UpdateStringTable(update) = message {
                    // table_id resolution needs state; fall back to stringtables packet primarily
                    let _ = update;
                }
            }
        }

        handler.handle_packet(packet)?;
    }

    Ok(InspectReport {
        map: header.map.clone(),
        server: header.server.clone(),
        duration_secs: header.duration,
        ticks: header.ticks,
        frames: header.frames,
        tickrate,
        voice_init,
        existing_voice_packets: voice_count,
        players: players.into_values().collect(),
    })
}

fn collect_players_from_stringtables(
    tables: &StringTablePacket<'_>,
    players: &mut BTreeMap<u8, PlayerSlot>,
) -> Result<()> {
    for table in &tables.tables {
        if table.name != "userinfo" {
            continue;
        }
        for (idx, entry) in &table.entries {
            if let Some(player) = player_from_entry(*idx, entry)? {
                players.insert(player.client_index, player);
            }
        }
    }
    Ok(())
}

fn player_from_entry(
    index: u16,
    entry: &tf_demo_parser::demo::packet::stringtable::StringTableEntry<'_>,
) -> Result<Option<PlayerSlot>> {
    use tf_demo_parser::demo::data::UserInfo;
    let info = UserInfo::parse_from_string_table(
        index,
        entry.text.as_ref().map(|s| s.as_ref()),
        entry.extra_data.as_ref().map(|e| e.data.clone()),
    )?;
    let Some(info) = info else {
        return Ok(None);
    };
    let steam = info.player_info.steam_id.clone();
    let steam_id64 = parse_steam_id(&steam).ok();
    let entity_id: u32 = info.entity_id.into();
    let client_index = entity_id.saturating_sub(1) as u8;
    Ok(Some(PlayerSlot {
        client_index,
        entity_id,
        user_id: u32::from(info.player_info.user_id),
        name: info.player_info.name.clone(),
        steam_id: steam,
        steam_id64,
    }))
}

fn select_player<'a>(
    players: &'a [PlayerSlot],
    opts: &InjectOptions,
) -> Result<&'a PlayerSlot> {
    if let Some(idx) = opts.client_index {
        return players
            .iter()
            .find(|p| p.client_index == idx)
            .ok_or_else(|| anyhow!("no player with client_index {idx}"));
    }
    if let Some(sid) = &opts.steam_id {
        let want = parse_steam_id(sid)?;
        if let Some(p) = players.iter().find(|p| p.steam_id64 == Some(want)) {
            return Ok(p);
        }
        if let Some(p) = players.iter().find(|p| p.steam_id.eq_ignore_ascii_case(sid)) {
            return Ok(p);
        }
        bail!("no player matching steam id {sid}");
    }
    if let Some(name) = &opts.player_name {
        let needle = name.to_lowercase();
        let matches: Vec<_> = players
            .iter()
            .filter(|p| p.name.to_lowercase().contains(&needle))
            .collect();
        match matches.as_slice() {
            [one] => return Ok(one),
            [] => bail!("no player name containing '{name}'"),
            many => bail!(
                "ambiguous player name '{name}', matches: {}",
                many.iter()
                    .map(|p| format!("{} (slot {})", p.name, p.client_index))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        }
    }
    // Default: first non-bot looking player with a steamid64
    players
        .iter()
        .find(|p| p.steam_id64.is_some() && !p.name.is_empty())
        .ok_or_else(|| anyhow!("demo has no identifiable players to attach voice to"))
}

/// Inject audio into a demo as Steam voice packets attributed to a player.
pub fn inject_comms(opts: InjectOptions) -> Result<InjectResult> {
    let report = inspect_demo(&opts.demo_path)?;
    let player = select_player(&report.players, &opts)?.clone();
    let steam_id64 = match (opts.steam_id.as_deref(), player.steam_id64) {
        (Some(s), _) => parse_steam_id(s)?,
        (_, Some(id)) => id,
        _ => bail!(
            "player '{}' has no parseable steam id; pass --steam-id",
            player.name
        ),
    };

    let pcm = load_mono_pcm(&opts.audio_path, opts.sample_rate, opts.loudness)?;
    let mut encoder = SteamVoiceEncoder::new(steam_id64, opts.sample_rate)?;
    let voice_packets = encoder.encode_pcm(&pcm)?;
    if voice_packets.is_empty() {
        bail!("no voice frames produced from audio");
    }

    let start_tick = (opts.offset_secs * report.tickrate).round().max(0.0) as u32;
    let ticks_per_frame = (report.tickrate * (encoder.frame_samples() as f32)
        / opts.sample_rate as f32)
        .max(1.0);

    // Schedule: frame i at tick start + round(i * ticks_per_frame)
    let schedule: Vec<(u32, Vec<u8>)> = voice_packets
        .into_iter()
        .enumerate()
        .map(|(i, pkt)| {
            let tick = start_tick + (i as f32 * ticks_per_frame).round() as u32;
            (tick, pkt)
        })
        .collect();

    // Keep owned packet bytes alive for Stream borrows during encode.
    // Strategy: rewrite demo in one pass; when we hit a Message/Signon packet whose tick
    // is >= next scheduled voice tick, append pending voice messages whose tick <= packet.tick.
    let file = std::fs::read(&opts.demo_path)?;
    let demo = Demo::new(&file);
    let mut stream = demo.get_stream();
    let header = Header::read(&mut stream)?;
    let mut packets = RawPacketStream::new(stream);

    let mut out_buffer: Vec<u8> = Vec::with_capacity(file.len() + schedule.len() * 128);
    {
        let mut out_stream = bitbuffer::BitWriteStream::new(&mut out_buffer, LittleEndian);
        header.write(&mut out_stream)?;

        let mut handler = DemoHandler::parse_all_with_analyser(NullHandler);
        let mut encode_handler = DemoHandler::parse_all_with_analyser(NullHandler);
        let mut sched_idx = 0usize;

        let end_tick = schedule.last().map(|(t, _)| *t).unwrap_or(start_tick);
        let mut has_stop = false;
        let mut last_tick = DemoTick::from(0u32);

        while let Some(packet) = packets.next(&handler.state_handler)? {
            last_tick = packet.tick();
            if packet.packet_type() == PacketType::Stop {
                has_stop = true;
            }

            let mut encode_packet = packet.clone();

            // Ensure VoiceInit exists / is steam if we can patch an existing one.
            if matches!(
                encode_packet.packet_type(),
                PacketType::Signon | PacketType::Message
            ) {
                if let Packet::Signon(msg) | Packet::Message(msg) = &mut encode_packet {
                    for m in msg.messages.iter_mut() {
                        if let Message::VoiceInit(init) = m {
                            if init.codec != "steam" {
                                init.codec = "steam".into();
                                init.quality = 255;
                                init.sampling_rate = opts.sample_rate as u16;
                            }
                        }
                    }

                    let pkt_tick: u32 = msg.tick.into();
                    if opts.replace_existing && pkt_tick >= start_tick && pkt_tick <= end_tick {
                        msg.messages.retain(|m| match m {
                            Message::VoiceData(v) => v.client != player.client_index,
                            _ => true,
                        });
                    }

                    // Flush all scheduled frames with tick <= this packet tick
                    while sched_idx < schedule.len() && schedule[sched_idx].0 <= pkt_tick {
                        let frame = schedule[sched_idx].1.clone();
                        let bit_len = (frame.len() * 8) as u16;
                        let data = BitReadStream::new(BitReadBuffer::new_owned(frame, LittleEndian));
                        msg.messages.push(Message::VoiceData(VoiceDataMessage {
                            client: player.client_index,
                            proximity: 0,
                            length: bit_len,
                            data,
                        }));
                        sched_idx += 1;
                    }
                }
            }

            encode_packet.encode(&mut out_stream, &encode_handler.state_handler)?;
            handler.handle_packet(packet)?;
            encode_handler.handle_packet(encode_packet)?;
        }

        if sched_idx < schedule.len() {
            bail!(
                "demo ended before all voice frames could be placed ({} remaining). \
                 Try an earlier --offset",
                schedule.len() - sched_idx
            );
        }

        if !has_stop {
            Packet::Stop(tf_demo_parser::demo::packet::stop::StopPacket { tick: last_tick })
                .encode(&mut out_stream, &encode_handler.state_handler)?;
        }
    }

    // Re-count injected from schedule length (reliable)
    let packets_injected = schedule.len();
    std::fs::write(&opts.output_path, &out_buffer)
        .with_context(|| format!("write {}", opts.output_path.display()))?;

    Ok(InjectResult {
        output: opts.output_path.display().to_string(),
        player,
        start_tick,
        packets_injected,
        voice_init: report.voice_init,
    })
}

/// Extract all Steam voice payloads from a demo into a mono WAV (mixed).
pub fn extract_voice_wav(demo_path: &Path, out_wav: &Path) -> Result<ExtractStats> {
    let file = std::fs::read(demo_path)?;
    let demo = Demo::new(&file);
    let parser = tf_demo_parser::DemoParser::new_all_with_analyser(
        demo.get_stream(),
        VoiceExtract::new(out_wav)?,
    );
    let (_header, stats) = parser.parse()?;
    Ok(stats)
}

#[derive(Debug, Default, Serialize)]
pub struct ExtractStats {
    pub packets: usize,
    pub decoded_samples: usize,
    pub steam_ids: Vec<u64>,
    pub output: String,
}

struct VoiceExtract {
    decoder: steam_audio_codec::SteamVoiceDecoder,
    out_buffer: Vec<i16>,
    pcm: Vec<i16>,
    packets: usize,
    steam_ids: HashMap<u64, ()>,
    path: std::path::PathBuf,
    sample_rate: u32,
}

impl VoiceExtract {
    fn new(path: &Path) -> Result<Self> {
        Ok(Self {
            decoder: steam_audio_codec::SteamVoiceDecoder::new(),
            out_buffer: vec![0; 16_384],
            pcm: Vec::new(),
            packets: 0,
            steam_ids: HashMap::new(),
            path: path.to_path_buf(),
            sample_rate: DEFAULT_SAMPLE_RATE,
        })
    }
}

impl tf_demo_parser::demo::parser::MessageHandler for VoiceExtract {
    type Output = ExtractStats;

    fn does_handle(message_type: MessageType) -> bool {
        matches!(
            message_type,
            MessageType::VoiceInit | MessageType::VoiceData
        )
    }

    fn handle_message(
        &mut self,
        message: &Message,
        _tick: DemoTick,
        _parser_state: &tf_demo_parser::ParserState,
    ) {
        match message {
            Message::VoiceInit(init) => {
                if init.sampling_rate > 0 {
                    self.sample_rate = init.sampling_rate as u32;
                }
            }
            Message::VoiceData(data) => {
                use steam_audio_codec::SteamVoiceData;
                let bytes = match data.data.clone().read_bytes(data.length as usize / 8) {
                    Ok(b) => b,
                    Err(_) => return,
                };
                if let Ok(steam_data) = SteamVoiceData::new(&bytes) {
                    self.steam_ids.insert(steam_data.steam_id, ());
                    if let Ok(n) = self.decoder.decode(steam_data, &mut self.out_buffer) {
                        self.pcm.extend_from_slice(&self.out_buffer[..n]);
                        self.packets += 1;
                    }
                }
            }
            _ => {}
        }
    }

    fn into_output(self, _state: &tf_demo_parser::ParserState) -> Self::Output {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: self.sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        if let Ok(mut w) = hound::WavWriter::create(&self.path, spec) {
            for &s in &self.pcm {
                let _ = w.write_sample(s);
            }
            let _ = w.finalize();
        }
        ExtractStats {
            packets: self.packets,
            decoded_samples: self.pcm.len(),
            steam_ids: self.steam_ids.into_keys().collect(),
            output: self.path.display().to_string(),
        }
    }
}
