# Research notes: injecting comms into TF2 demos

## Goal

Produce a modified `.dem` such that TF2's built-in demo viewer plays external audio as if it were in-game voice chat — without client mods or process hooks.

## Why voice injection (vs alternatives)

| Approach                                       | Pros                                                                        | Cons                                                                                   |
| ---------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Demo `svc_VoiceData` injection** (this repo) | Stays inside Valve's playback path; no runtime hooks; sync is tick-accurate | Must match Steam Voice framing; STV must use `steam` codec; needs in-game confirmation |
| Client mod selecting a WAV                     | Flexible UX                                                                 | VAC/mod risk, install friction, sync with demo tick is still hard                      |
| External app hooking TF2 / mixing overlays     | Can use any audio                                                           | Security-sensitive, brittle across updates, not “in the demo”                          |

## Demo container (Source DEM)

High-level layout (from demboyz / Source SDK knowledge):

```
HL2DEMO header
repeated: [cmd_type u8][tick i32][payload]
  dem_signon / dem_packet → democmdinfo + seq in/out + raw net messages
  dem_stop → end
```

Net messages of interest:

- `svc_VoiceInit` (14) — codec string (`"steam"`), quality, optional sample rate
- `svc_VoiceData` (15) — `client u8`, `proximity u8`, `length_bits u16`, payload bits

Player slots come from the `userinfo` string table. Client index for voice ≈ `entity_id - 1`.

## Steam Voice payload

Public reverse engineering (Zhenyang Li) and `demostf/steam-audio-codec` agree on:

```
u64 steamid64 LE
0x0B + u16 sample_rate          # SampleRate
0x06 + u16 nbytes + bytes       # OpusPlc blob
u32 CRC32 LE over preceding bytes
```

Inside the OpusPlc blob (may repeat):

```
u16 opus_len | u16 seq | opus_len bytes
```

`seq ==` continuity counter; `opus_len == 0xFFFF` resets decoder state.

TF2 dumps commonly use **24 kHz mono**, ~20 ms frames (480 samples). CRC is IEEE CRC-32 (reflected poly `0xEDB88320`).

Encoding here uses libopus `Application::Voip` at ~24 kbps VBR, then the wrapper above.

## Sample used

- [demos.tf/1479677](https://demos.tf/1479677) — `match-20260717-1011-koth_proot_b6c-alt2.dem`
- Map `koth_proot_b6c-alt2`, ~833 s, protocol demo=3 / net=24
- `VoiceInit { codec: "steam", quality: 255, sampling_rate: 0 }`
- **0** pre-existing voice packets (clean injection target)
- Includes player `plasmatech8` (steamid64 `76561198081400087`, client index 12)

## Offline verification method

Without TF2:

1. Inject known audio (440 Hz tone)
2. Re-parse output demo for `svc_VoiceData`
3. Validate Steam CRC via `steam-audio-codec`
4. Decode Opus → WAV and check duration / spectrum / steamid attribution

This does **not** prove the TF2 client’s voice mixer will accept the packets (edge cases: proximity, mute, STV voice cvars), but it proves the demo is well-formed and the payloads are valid Steam Voice.

## Tooling landscape

- **tf-demo-parser** (demostf) — parse + encode demos (`write` feature; vendored because crates.io 0.6.4 omits it)
- **steam-audio-codec** — decode/validate Steam Voice
- **demboyz** — C++ dem↔json and voice _extraction_ (needs Steam API for decode); README jokes about adding phony voice, which matches this use-case

## Timing

`--audio-skip` (recording GO) is not `--offset` (demo timeline). Default offset is auto `teamplay_round_start`. See [timing.md](timing.md).

1. STV viewer may gate voice on server/TV settings from when the demo was recorded.
2. Attribution UI may require the client index to still be “connected” at that tick.
3. Opus framing differences vs Steam’s exact encoder settings might cause glitches even when our decoder succeeds.
4. Extremely loud / long audio may hit practical net-message size limits (we keep frames small).

## Next experiments

- Inject short speech and confirm in TF2 `playdemo`
- Try `--replace-existing` on a demo that already contains voice
- Probe whether `proximity=1` changes anything in STV
- Optionally patch `VoiceInit.sampling_rate` when it is `0`
