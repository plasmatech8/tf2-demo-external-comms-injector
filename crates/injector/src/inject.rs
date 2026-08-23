//! Demo inspection and voice-injection rewrite.

use std::collections::BTreeMap;
#[cfg(feature = "extract")]
use std::collections::HashMap;
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

use crate::audio::{load_mono_pcm_from_bytes, Loudness};
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

/// In-memory inject options (WASM / library callers). Audio must be PCM WAV bytes.
#[derive(Debug, Clone)]
pub struct InjectBytesOptions {
    /// Demo-time inject start in seconds. `None` = auto `teamplay_round_start`, else `0`.
    pub offset_secs: Option<f32>,
    /// Seconds to drop from the start of the input audio (game start in the recording).
    pub audio_skip_secs: f32,
    pub loudness: Loudness,
    pub player_name: Option<String>,
    pub steam_id: Option<String>,
    pub client_index: Option<u8>,
    pub sample_rate: u32,
    pub bitrate: i32,
    pub replace_existing: bool,
}

impl Default for InjectBytesOptions {
    fn default() -> Self {
        Self {
            offset_secs: None,
            audio_skip_secs: 0.0,
            loudness: Loudness::from_gain(1.0),
            player_name: None,
            steam_id: None,
            client_index: None,
            sample_rate: DEFAULT_SAMPLE_RATE,
            bitrate: DEFAULT_BITRATE,
            replace_existing: false,
        }
    }
}

/// Result of an in-memory inject (demo bytes + metadata).
#[derive(Debug)]
pub struct InjectBytesResult {
    pub demo: Vec<u8>,
    pub meta: InjectResult,
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
    /// Voice frames dropped because the demo ended before they could be scheduled.
    #[serde(default)]
    pub packets_truncated: usize,
    pub voice_init: Option<VoiceInitSummary>,
}

/// Inspect a demo for players, voice codec, and timing metadata.
pub fn inspect_demo(path: &Path) -> Result<InspectReport> {
    let file = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    inspect_demo_bytes(&file)
}

/// Inspect demo bytes (no filesystem).
pub fn inspect_demo_bytes(file: &[u8]) -> Result<InspectReport> {
    let demo = Demo::new(file);
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
                    // table_id → name comes from earlier CreateStringTable / StringTables
                    // (updated when we handle_packet at end of each loop iteration).
                    let is_userinfo = handler
                        .string_table_names
                        .get(update.table_id as usize)
                        .is_some_and(|name| name.as_ref() == "userinfo");
                    if is_userinfo {
                        for (idx, entry) in &update.entries {
                            if let Some(player) = player_from_entry(*idx, entry)? {
                                players.insert(player.client_index, player);
                            }
                        }
                    }
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
    client_index: Option<u8>,
    steam_id: Option<&str>,
    player_name: Option<&str>,
) -> Result<&'a PlayerSlot> {
    if let Some(idx) = client_index {
        return players
            .iter()
            .find(|p| p.client_index == idx)
            .ok_or_else(|| anyhow!("no player with client_index {idx}"));
    }
    if let Some(sid) = steam_id {
        let want = parse_steam_id(sid)?;
        if let Some(p) = players.iter().find(|p| p.steam_id64 == Some(want)) {
            return Ok(p);
        }
        if let Some(p) = players
            .iter()
            .find(|p| p.steam_id.eq_ignore_ascii_case(sid))
        {
            return Ok(p);
        }
        // Fall through to --player when both were supplied; only hard-fail if name isn't set.
        if player_name.is_none() {
            bail!("no player matching steam id {sid}");
        }
    }
    if let Some(name) = player_name {
        let needle = name.to_lowercase();
        let matches: Vec<_> = players
            .iter()
            .filter(|p| p.name.to_lowercase().contains(&needle))
            .collect();
        match matches.as_slice() {
            [one] => return Ok(one),
            [] => {
                if steam_id.is_some() {
                    bail!(
                        "no player matching steam id {:?} or name containing '{}'",
                        steam_id,
                        name
                    );
                }
                bail!("no player name containing '{name}'");
            }
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
    let demo = std::fs::read(&opts.demo_path)
        .with_context(|| format!("read {}", opts.demo_path.display()))?;
    let audio = std::fs::read(&opts.audio_path)
        .with_context(|| format!("read {}", opts.audio_path.display()))?;
    let bytes_opts = InjectBytesOptions {
        offset_secs: opts.offset_secs,
        audio_skip_secs: opts.audio_skip_secs,
        loudness: opts.loudness,
        player_name: opts.player_name,
        steam_id: opts.steam_id,
        client_index: opts.client_index,
        sample_rate: opts.sample_rate,
        bitrate: opts.bitrate,
        replace_existing: opts.replace_existing,
    };
    let InjectBytesResult { demo: out, meta } = inject_comms_bytes(&demo, &audio, &bytes_opts)?;
    std::fs::write(&opts.output_path, &out)
        .with_context(|| format!("write {}", opts.output_path.display()))?;
    Ok(InjectResult {
        output: opts.output_path.display().to_string(),
        ..meta
    })
}

/// Inject audio WAV bytes into demo bytes. Returns the rewritten demo and metadata.
pub fn inject_comms_bytes(
    demo_bytes: &[u8],
    audio_wav: &[u8],
    opts: &InjectBytesOptions,
) -> Result<InjectBytesResult> {
    let report = inspect_demo_bytes(demo_bytes)?;
    let player = select_player(
        &report.players,
        opts.client_index,
        opts.steam_id.as_deref(),
        opts.player_name.as_deref(),
    )?
    .clone();
    // Attribute voice to the resolved player slot's steam id. (--steam-id is a selector;
    // if it missed and we fell through to --player, do not stamp the unmatched id.)
    let steam_id64 = match player.steam_id64 {
        Some(id) => id,
        None => match opts.steam_id.as_deref() {
            Some(s) => parse_steam_id(s)?,
            None => bail!(
                "player '{}' has no parseable steam id; pass --steam-id",
                player.name
            ),
        },
    };

    let (offset_secs, offset_source) =
        resolve_demo_offset(opts.offset_secs, report.round_start_secs);
    if offset_source == "fallback_zero" {
        eprintln!(
            "warning: no teamplay_round_start in demo; injecting at demo t=0. \
             Pass --offset explicitly if that is wrong."
        );
    }

    let mut pcm = load_mono_pcm_from_bytes(audio_wav, opts.sample_rate, opts.loudness)?;
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
    let ticks_per_frame =
        (report.tickrate * (encoder.frame_samples() as f32) / opts.sample_rate as f32).max(1.0);

    // Schedule: frame i at tick start + round(i * ticks_per_frame)
    let schedule: Vec<(u32, Vec<u8>)> = voice_packets
        .into_iter()
        .enumerate()
        .map(|(i, pkt)| {
            let tick = start_tick + (i as f32 * ticks_per_frame).round() as u32;
            (tick, pkt)
        })
        .collect();

    let (out_buffer, packets_injected) = rewrite_demo_with_voice(
        demo_bytes,
        &schedule,
        player.client_index,
        start_tick,
        opts.replace_existing,
    )?;

    let packets_truncated = schedule.len().saturating_sub(packets_injected);
    Ok(InjectBytesResult {
        demo: out_buffer,
        meta: InjectResult {
            output: String::new(),
            player,
            start_tick,
            offset_secs,
            offset_source: offset_source.to_string(),
            audio_skip_secs,
            packets_injected,
            packets_truncated,
            voice_init: report.voice_init,
        },
    })
}

fn rewrite_demo_with_voice(
    file: &[u8],
    schedule: &[(u32, Vec<u8>)],
    client_index: u8,
    start_tick: u32,
    replace_existing: bool,
) -> Result<(Vec<u8>, usize)> {
    // Surgical rewrite: keep original packet bytes intact. For Message packets that
    // need voice, copy the packet prefix + existing net-message bits and append
    // VoiceData, without re-encoding PacketEntities (full re-encode makes TF2
    // refuse playdemo).
    //
    // TF2's demo player does not treat a Message packet that contains only
    // svc_VoiceData as a speaking frame (no indicator, no audio). Voice must ride
    // on an existing gameplay dem_packet. Demos skip ticks, so several 20 ms
    // frames may land on one host packet across a gap.
    let demo = Demo::new(file);
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

        // Collect voice frames due by this Message packet's tick.
        // Hang each pending frame on the first packet whose tick is >= the frame's
        // scheduled tick (may batch several frames onto one packet across a gap).
        let mut frames_for_packet: Vec<Vec<u8>> = Vec::new();
        let mut strip_existing = false;
        if let Packet::Message(msg) = &packet {
            let pkt_tick: u32 = msg.tick.into();
            strip_existing = replace_existing && pkt_tick >= start_tick && pkt_tick <= end_tick;
            while sched_idx < schedule.len() && schedule[sched_idx].0 <= pkt_tick {
                frames_for_packet.push(schedule[sched_idx].1.clone());
                sched_idx += 1;
            }
        }

        let needs_voice_init_patch = match &packet {
            Packet::Signon(msg) | Packet::Message(msg) => msg
                .messages
                .iter()
                .any(|m| matches!(m, Message::VoiceInit(init) if init.codec != "steam")),
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
                client_index,
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
        // Medal / VODs often run longer than the demo (post-game, lobby). Place what fits.
        eprintln!(
            "warning: demo ended with {} voice frames remaining; truncating audio to fit",
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
    Ok((out_buffer, sched_idx))
}

const MESSAGE_PREFIX: usize = 1 + 4 + 84; // type + tick + MessagePacketMeta

fn write_voice_data_message(
    writer: &mut bitbuffer::BitWriteStream<LittleEndian>,
    frame: &[u8],
    client_index: u8,
) -> Result<()> {
    let bit_len = (frame.len() * 8) as u16;
    let data = BitReadStream::new(BitReadBuffer::new(frame, LittleEndian));
    MessageType::VoiceData.write(writer)?;
    VoiceDataMessage {
        client: client_index,
        proximity: 0,
        length: bit_len,
        data,
    }
    .write(writer)?;
    Ok(())
}

fn resolve_demo_offset(manual: Option<f32>, round_start_secs: Option<f32>) -> (f32, &'static str) {
    if let Some(secs) = manual {
        return (secs.max(0.0), "manual");
    }
    if let Some(secs) = round_start_secs {
        return (secs.max(0.0), "teamplay_round_start");
    }
    (0.0, "fallback_zero")
}

/// Copy a raw `dem_packet` (Message) and optionally strip / append Steam voice.
///
/// Packet layout: type(u8) + tick(i32) + meta(84) + size(u32) + size bytes of bitpacked net messages.
fn rewrite_message_packet_append_voice(
    raw_packet: &[u8],
    voice_frames: &[Vec<u8>],
    client_index: u8,
    strip_existing_for_client: bool,
    state: &tf_demo_parser::ParserState,
) -> Result<Vec<u8>> {
    if raw_packet.len() < MESSAGE_PREFIX + 4 {
        bail!("message packet too short ({})", raw_packet.len());
    }
    if raw_packet[0] != PacketType::Message as u8 {
        bail!("expected Message packet type 2, got {}", raw_packet[0]);
    }

    let old_len = u32::from_le_bytes(
        raw_packet[MESSAGE_PREFIX..MESSAGE_PREFIX + 4]
            .try_into()
            .unwrap(),
    ) as usize;
    let data_off = MESSAGE_PREFIX + 4;
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
        let mut reader = BitReadStream::new(BitReadBuffer::new(old_data, LittleEndian));

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
            let mut copy_reader = BitReadStream::new(BitReadBuffer::new(old_data, LittleEndian));
            copy_reader.set_pos(msg_start)?;
            let bits = copy_reader.read_bits(msg_end - msg_start)?;
            writer.write_bits(&bits)?;
        }

        for frame in voice_frames {
            write_voice_data_message(&mut writer, frame, client_index)?;
        }

        writer.align();
    }

    let mut out = Vec::with_capacity(MESSAGE_PREFIX + 4 + new_data.len());
    out.extend_from_slice(&raw_packet[..MESSAGE_PREFIX]);
    out.extend_from_slice(&(new_data.len() as u32).to_le_bytes());
    out.extend_from_slice(&new_data);
    Ok(out)
}

/// Extract all Steam voice payloads from a demo into a mono WAV (mixed).
#[cfg(feature = "extract")]
pub fn extract_voice_wav(demo_path: &Path, out_wav: &Path) -> Result<ExtractStats> {
    let file = std::fs::read(demo_path)?;
    let demo = Demo::new(&file);
    let parser =
        tf_demo_parser::DemoParser::new_all_with_analyser(demo.get_stream(), VoiceExtract::new());
    let (_header, decoded) = parser.parse()?;

    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: decoded.sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(out_wav, spec)
        .with_context(|| format!("create wav {}", out_wav.display()))?;
    for &sample in &decoded.pcm {
        writer
            .write_sample(sample)
            .with_context(|| format!("write wav sample {}", out_wav.display()))?;
    }
    writer
        .finalize()
        .with_context(|| format!("finalize wav {}", out_wav.display()))?;

    Ok(ExtractStats {
        packets: decoded.packets,
        decoded_samples: decoded.pcm.len(),
        steam_ids: decoded.steam_ids.into_keys().collect(),
        output: out_wav.display().to_string(),
    })
}

#[derive(Debug, Default, Serialize)]
pub struct ExtractStats {
    pub packets: usize,
    pub decoded_samples: usize,
    pub steam_ids: Vec<u64>,
    pub output: String,
}

#[cfg(feature = "extract")]
struct DecodedVoice {
    packets: usize,
    pcm: Vec<i16>,
    steam_ids: HashMap<u64, ()>,
    sample_rate: u32,
}

#[cfg(feature = "extract")]
struct VoiceExtract {
    decoder: steam_audio_codec::SteamVoiceDecoder,
    out_buffer: Vec<i16>,
    pcm: Vec<i16>,
    packets: usize,
    steam_ids: HashMap<u64, ()>,
    sample_rate: u32,
}

#[cfg(feature = "extract")]
impl VoiceExtract {
    fn new() -> Self {
        Self {
            decoder: steam_audio_codec::SteamVoiceDecoder::new(),
            out_buffer: vec![0; 16_384],
            pcm: Vec::new(),
            packets: 0,
            steam_ids: HashMap::new(),
            sample_rate: DEFAULT_SAMPLE_RATE,
        }
    }
}

#[cfg(feature = "extract")]
impl tf_demo_parser::demo::parser::MessageHandler for VoiceExtract {
    type Output = DecodedVoice;

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
        DecodedVoice {
            packets: self.packets,
            pcm: self.pcm,
            steam_ids: self.steam_ids,
            sample_rate: self.sample_rate,
        }
    }
}

#[cfg(test)]
mod select_player_tests {
    use super::*;

    fn slot(name: &str, steam_id64: u64, client_index: u8) -> PlayerSlot {
        PlayerSlot {
            client_index,
            entity_id: u32::from(client_index) + 1,
            user_id: u32::from(client_index) + 10,
            name: name.to_string(),
            steam_id: steam_id64.to_string(),
            steam_id64: Some(steam_id64),
        }
    }

    #[test]
    fn steam_id_miss_falls_through_to_player_name() {
        let players = vec![
            slot("alice", 76561198000000001, 1),
            slot("plasmatech8", 76561198081400087, 12),
        ];
        let chosen =
            select_player(&players, None, Some("76561198000000999"), Some("plasma")).unwrap();
        assert_eq!(chosen.name, "plasmatech8");
        assert_eq!(chosen.steam_id64, Some(76561198081400087));
    }

    #[test]
    fn steam_id_miss_without_player_name_errors() {
        let players = vec![slot("alice", 76561198000000001, 1)];
        let err = select_player(&players, None, Some("76561198000000999"), None).unwrap_err();
        assert!(err.to_string().contains("steam id"), "{err}");
    }
}

#[cfg(test)]
mod voice_insert_tests {
    use super::*;
    use tf_demo_parser::demo::packet::message::{MessagePacket, MessagePacketMeta};

    fn stub_demo(message_ticks: &[u32]) -> Vec<u8> {
        let header = Header {
            demo_type: "HL2DEMO".into(),
            version: 3,
            protocol: 24,
            server: "test".into(),
            nick: "stv".into(),
            map: "koth_test".into(),
            game: "tf".into(),
            duration: 1.0,
            ticks: 66,
            frames: message_ticks.len() as u32,
            signon: 0,
        };
        let encode_handler = DemoHandler::parse_all_with_analyser(NullHandler);
        let mut buf = Vec::new();
        {
            let mut stream = bitbuffer::BitWriteStream::new(&mut buf, LittleEndian);
            header.write(&mut stream).unwrap();
            stream.align();
            for &tick in message_ticks {
                Packet::Message(MessagePacket {
                    tick: DemoTick::from(tick),
                    messages: Vec::new(),
                    meta: MessagePacketMeta::default(),
                })
                .encode(&mut stream, &encode_handler.state_handler)
                .unwrap();
            }
            Packet::Stop(tf_demo_parser::demo::packet::stop::StopPacket {
                tick: DemoTick::from(*message_ticks.last().unwrap_or(&0)),
            })
            .encode(&mut stream, &encode_handler.state_handler)
            .unwrap();
            stream.align();
        }
        buf
    }

    /// (header.frames, voice ticks, max VoiceData messages on any original-style packet)
    fn voice_layout(file: &[u8]) -> (u32, Vec<u32>, usize) {
        let demo = Demo::new(file);
        let mut stream = demo.get_stream();
        let header = Header::read(&mut stream).unwrap();
        let mut packets = RawPacketStream::new(stream);
        let mut handler = DemoHandler::parse_all_with_analyser(NullHandler);
        let mut voice_ticks = Vec::new();
        let mut max_voice_on_packet = 0usize;
        while let Some(packet) = packets.next(&handler.state_handler).unwrap() {
            if let Packet::Message(msg) = &packet {
                let tick: u32 = msg.tick.into();
                let voice = msg
                    .messages
                    .iter()
                    .filter(|m| matches!(m, Message::VoiceData(_)))
                    .count();
                max_voice_on_packet = max_voice_on_packet.max(voice);
                for _ in 0..voice {
                    voice_ticks.push(tick);
                }
            }
            handler.handle_packet(packet).unwrap();
        }
        (header.frames, voice_ticks, max_voice_on_packet)
    }

    #[test]
    fn hangs_due_frames_on_next_host_packet_across_tick_gaps() {
        // Host packets at 5 and 15; frames 6..=9 and 15 hang on tick 15, 16 on 30.
        let demo = stub_demo(&[5, 15, 30]);
        let schedule: Vec<(u32, Vec<u8>)> = [6u32, 7, 8, 9, 15, 16]
            .into_iter()
            .map(|tick| (tick, vec![tick as u8; 16]))
            .collect();

        let (out, placed) = rewrite_demo_with_voice(&demo, &schedule, 12, 6, false).unwrap();
        assert_eq!(placed, 6);

        let (frames, voice_ticks, max_voice) = voice_layout(&out);
        assert_eq!(voice_ticks, vec![15, 15, 15, 15, 15, 30]);
        assert_eq!(max_voice, 5);
        assert_eq!(frames, 3);
    }

    #[test]
    fn first_pcm_packet_includes_decoder_reset() {
        use crate::steam_voice::{SteamVoiceEncoder, DEFAULT_SAMPLE_RATE, FRAME_SAMPLES};
        let mut enc = SteamVoiceEncoder::new(76561198081400087, DEFAULT_SAMPLE_RATE).unwrap();
        let packets = enc.encode_pcm(&vec![1000i16; FRAME_SAMPLES * 2]).unwrap();
        assert_eq!(packets.len(), 2);
        // steamid(8) + SampleRate(3) + OpusPlc type/len(3) = 14
        assert_eq!(&packets[0][14..16], &[0xFF, 0xFF]);
        assert_ne!(&packets[1][14..16], &[0xFF, 0xFF]);
    }
}
