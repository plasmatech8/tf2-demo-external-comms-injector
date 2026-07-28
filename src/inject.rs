//! Demo inspection and voice-injection rewrite.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use bitbuffer::{BitRead, BitReadBuffer, BitReadStream, BitWrite, LittleEndian};
use serde::Serialize;
use tf_demo_parser::demo::data::DemoTick;
use tf_demo_parser::demo::gameevent_gen::GameEvent;
use tf_demo_parser::demo::header::Header;
use tf_demo_parser::demo::message::voice::VoiceDataMessage;
use tf_demo_parser::demo::message::{Message, MessageType};
use tf_demo_parser::demo::packet::stringtable::StringTablePacket;
use tf_demo_parser::demo::packet::{Packet, PacketType};
use tf_demo_parser::demo::parser::{DemoHandler, Encode, NullHandler, RawPacketStream};
use tf_demo_parser::Demo;

use crate::audio::{load_mono_pcm, Loudness};
use crate::steam_voice::{SteamVoiceEncoder, DEFAULT_BITRATE, DEFAULT_SAMPLE_RATE};
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
    /// First `teamplay_round_start` time in demo seconds, if present (typical “GO”).
    pub round_start_secs: Option<f32>,
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
    /// Demo-time inject start in seconds. `None` = auto `teamplay_round_start`, else `0`.
    pub offset_secs: Option<f32>,
    /// Seconds to drop from the start of the input audio (game start in the recording).
    pub audio_skip_secs: f32,
    pub loudness: Loudness,
    /// Prefer matching by name substring (case-insensitive).
    pub player_name: Option<String>,
    /// Prefer matching by steam id (any common format).
    pub steam_id: Option<String>,
    /// Explicit client index (0-based slot) override.
    pub client_index: Option<u8>,
    pub sample_rate: u32,
    /// Opus bitrate in bits/sec (default 64000). Use -1 for max.
    pub bitrate: i32,
    /// If true, replace existing voice for the chosen client in the injection window.
    pub replace_existing: bool,
}

#[derive(Debug, Serialize)]
pub struct InjectResult {
    pub output: String,
    pub player: PlayerSlot,
    pub start_tick: u32,
    /// Demo-time seconds where injection begins.
    pub offset_secs: f32,
    /// `manual` | `teamplay_round_start` | `fallback_zero`
    pub offset_source: String,
    pub audio_skip_secs: f32,
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
    let mut round_start_tick: Option<u32> = None;
    let mut tickrate = if header.ticks > 0 && header.duration > 0.0 {
        header.ticks as f32 / header.duration
    } else {
        66.666
    };

    while let Some(packet) = packets.next(&handler.state_handler)? {
        match &packet {
            Packet::Signon(msg) | Packet::Message(msg) => {
                let pkt_tick: u32 = msg.tick.into();
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
                        Message::GameEvent(ev) => {
                            if round_start_tick.is_none()
                                && matches!(ev.event, GameEvent::TeamPlayRoundStart(_))
                            {
                                round_start_tick = Some(pkt_tick);
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
        round_start_secs: round_start_tick.map(|t| t as f32 / tickrate),
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

    let (offset_secs, offset_source) = resolve_demo_offset(opts.offset_secs, report.round_start_secs);
    if offset_source == "fallback_zero" {
        eprintln!(
            "warning: no teamplay_round_start in demo; injecting at demo t=0. \
             Pass --offset explicitly if that is wrong."
        );
    }

    let mut pcm = load_mono_pcm(&opts.audio_path, opts.sample_rate, opts.loudness)?;
    let audio_skip_secs = opts.audio_skip_secs.max(0.0);
    if audio_skip_secs > 0.0 {
        let skip = (audio_skip_secs * opts.sample_rate as f32).round() as usize;
        if skip >= pcm.len() {
            bail!(
                "--audio-skip {audio_skip_secs}s removes all audio ({} samples @ {} Hz)",
                pcm.len(),
                opts.sample_rate
            );
        }
        pcm = pcm[skip..].to_vec();
    }

    let bitrate = if opts.bitrate == 0 {
        DEFAULT_BITRATE
    } else {
        opts.bitrate
    };
    let mut encoder = SteamVoiceEncoder::with_bitrate(steam_id64, opts.sample_rate, bitrate)?;
    let voice_packets = encoder.encode_pcm(&pcm)?;
    if voice_packets.is_empty() {
        bail!("no voice frames produced from audio");
    }

    let start_tick = (offset_secs * report.tickrate).round().max(0.0) as u32;
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

    // Surgical rewrite: keep original packet bytes intact. For Message packets that need
    // voice, copy the packet prefix + existing net-message bits and append VoiceData,
    // without re-encoding PacketEntities (full re-encode makes TF2 refuse playdemo).
    let file = std::fs::read(&opts.demo_path)?;
    let demo = Demo::new(&file);
    let mut stream = demo.get_stream();
    let header = Header::read(&mut stream)?;
    let header_end_bits = stream.pos();
    if header_end_bits % 8 != 0 {
        bail!("demo header is not byte-aligned");
    }
    let mut packets = RawPacketStream::new(stream);

    let mut out_buffer: Vec<u8> = Vec::with_capacity(file.len() + schedule.len() * 128);
    out_buffer.extend_from_slice(&file[..header_end_bits / 8]);

    let mut handler = DemoHandler::parse_all_with_analyser(NullHandler);
    let mut encode_handler = DemoHandler::parse_all_with_analyser(NullHandler);
    let mut sched_idx = 0usize;

    let end_tick = schedule.last().map(|(t, _)| *t).unwrap_or(start_tick);
    let mut has_stop = false;
    let mut last_tick = DemoTick::from(0u32);

    loop {
        let packet_start_bits = packets.pos();
        let Some(packet) = packets.next(&handler.state_handler)? else {
            break;
        };
        let packet_end_bits = packets.pos();
        if packet_start_bits % 8 != 0 || packet_end_bits % 8 != 0 {
            bail!(
                "demo packet not byte-aligned ({}..{} bits)",
                packet_start_bits,
                packet_end_bits
            );
        }
        let packet_start = packet_start_bits / 8;
        let packet_end = packet_end_bits / 8;

        last_tick = packet.tick();
        if packet.packet_type() == PacketType::Stop {
            has_stop = true;
        }

        // Collect voice frames that belong in this Message packet (if any).
        let mut frames_for_packet: Vec<Vec<u8>> = Vec::new();
        let mut strip_existing = false;
        if let Packet::Message(msg) = &packet {
            let pkt_tick: u32 = msg.tick.into();
            strip_existing =
                opts.replace_existing && pkt_tick >= start_tick && pkt_tick <= end_tick;
            while sched_idx < schedule.len() && schedule[sched_idx].0 <= pkt_tick {
                frames_for_packet.push(schedule[sched_idx].1.clone());
                sched_idx += 1;
            }
        }

        let needs_voice_init_patch = match &packet {
            Packet::Signon(msg) | Packet::Message(msg) => msg.messages.iter().any(|m| {
                matches!(m, Message::VoiceInit(init) if init.codec != "steam")
            }),
            _ => false,
        };

        if needs_voice_init_patch {
            bail!(
                "demo VoiceInit is not 'steam'; rewriting it requires a Signon/Message \
                 rebuild that TF2 often rejects. Re-record/export with sv_voicecodec steam."
            );
        }

        if matches!(packet.packet_type(), PacketType::Message)
            && (!frames_for_packet.is_empty() || strip_existing)
        {
            let rewritten = rewrite_message_packet_append_voice(
                &file[packet_start..packet_end],
                &frames_for_packet,
                player.client_index,
                strip_existing,
                &encode_handler.state_handler,
            )?;
            out_buffer.extend_from_slice(&rewritten);
        } else {
            out_buffer.extend_from_slice(&file[packet_start..packet_end]);
        }

        // Keep parser state in sync for subsequent packets (sendtables, etc.).
        let encode_packet = packet.clone();
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
        let mut encoded = Vec::new();
        {
            let mut out_stream = bitbuffer::BitWriteStream::new(&mut encoded, LittleEndian);
            Packet::Stop(tf_demo_parser::demo::packet::stop::StopPacket { tick: last_tick })
                .encode(&mut out_stream, &encode_handler.state_handler)?;
            out_stream.align();
        }
        out_buffer.extend_from_slice(&encoded);
    }

    // Original header.signon is preserved (we never rewrite the signon region).
    let _ = header;

    let packets_injected = schedule.len();
    std::fs::write(&opts.output_path, &out_buffer)
        .with_context(|| format!("write {}", opts.output_path.display()))?;

    Ok(InjectResult {
        output: opts.output_path.display().to_string(),
        player,
        start_tick,
        offset_secs,
        offset_source: offset_source.to_string(),
        audio_skip_secs,
        packets_injected,
        voice_init: report.voice_init,
    })
}

fn resolve_demo_offset(
    manual: Option<f32>,
    round_start_secs: Option<f32>,
) -> (f32, &'static str) {
    if let Some(secs) = manual {
        return (secs.max(0.0), "manual");
    }
    if let Some(secs) = round_start_secs {
        return (secs.max(0.0), "teamplay_round_start");
    }
    (0.0, "fallback_zero")
}

/// Copy a raw `dem_packet` (Message) and append Steam voice messages to its payload.
///
/// Packet layout: type(u8) + tick(i32) + meta(84) + size(u32) + size bytes of bitpacked net messages.
fn rewrite_message_packet_append_voice(
    raw_packet: &[u8],
    voice_frames: &[Vec<u8>],
    client_index: u8,
    strip_existing_for_client: bool,
    state: &tf_demo_parser::ParserState,
) -> Result<Vec<u8>> {
    const PREFIX: usize = 1 + 4 + 84; // type + tick + MessagePacketMeta
    if raw_packet.len() < PREFIX + 4 {
        bail!("message packet too short ({})", raw_packet.len());
    }
    if raw_packet[0] != PacketType::Message as u8 {
        bail!("expected Message packet type 2, got {}", raw_packet[0]);
    }

    let old_len = u32::from_le_bytes(raw_packet[PREFIX..PREFIX + 4].try_into().unwrap()) as usize;
    let data_off = PREFIX + 4;
    if data_off + old_len > raw_packet.len() {
        bail!(
            "message packet length {old_len} exceeds packet size {}",
            raw_packet.len()
        );
    }
    let old_data = &raw_packet[data_off..data_off + old_len];

    let mut new_data: Vec<u8> = Vec::with_capacity(old_len + voice_frames.len() * 64);
    {
        let mut writer = bitbuffer::BitWriteStream::new(&mut new_data, LittleEndian);
        let mut reader =
            BitReadStream::new(BitReadBuffer::new(old_data, LittleEndian));

        // Copy existing net messages bit-for-bit (optionally dropping this client's voice).
        while reader.bits_left() > 6 {
            let msg_start = reader.pos();
            let msg_type = MessageType::read(&mut reader)?;
            if strip_existing_for_client && msg_type == MessageType::VoiceData {
                let voice = VoiceDataMessage::read(&mut reader)?;
                if voice.client == client_index {
                    continue;
                }
            } else {
                Message::skip_type(msg_type, &mut reader, state)?;
            }
            let msg_end = reader.pos();
            let mut copy_reader =
                BitReadStream::new(BitReadBuffer::new(old_data, LittleEndian));
            copy_reader.set_pos(msg_start)?;
            let bits = copy_reader.read_bits(msg_end - msg_start)?;
            writer.write_bits(&bits)?;
        }

        for frame in voice_frames {
            let bit_len = (frame.len() * 8) as u16;
            let data = BitReadStream::new(BitReadBuffer::new(frame, LittleEndian));
            MessageType::VoiceData.write(&mut writer)?;
            VoiceDataMessage {
                client: client_index,
                proximity: 0,
                length: bit_len,
                data,
            }
            .write(&mut writer)?;
        }

        writer.align();
    }

    let mut out = Vec::with_capacity(PREFIX + 4 + new_data.len());
    out.extend_from_slice(&raw_packet[..PREFIX]);
    out.extend_from_slice(&(new_data.len() as u32).to_le_bytes());
    out.extend_from_slice(&new_data);
    Ok(out)
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
