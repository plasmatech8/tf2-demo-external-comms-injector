# Steam Voice + svc_VoiceData cheat sheet

## svc_VoiceData (message type 15)

| Field     | Type | Notes                                           |
| --------- | ---- | ----------------------------------------------- |
| client    | u8   | Player slot (0-based); matches `userinfo` index |
| proximity | u8   | Usually 0                                       |
| length    | u16  | Payload length in **bits**                      |
| data      | bits | Steam Voice datagram                            |

## Steam Voice datagram

| Field           | Size      | Notes                                             |
| --------------- | --------- | ------------------------------------------------- |
| steamid64       | 8         | Little-endian                                     |
| type SampleRate | 1 + 2     | `0x0B` + rate (`8000`…`48000`, TF2 often `24000`) |
| type OpusPlc    | 1 + 2 + N | `0x06` + N + blob                                 |
| CRC32           | 4         | Over all bytes before CRC                         |

### OpusPlc blob

Repeated:

| Field     | Size                      |
| --------- | ------------------------- |
| frame_len | u16 LE (`0xFFFF` = reset) |
| seq       | u16 LE                    |
| opus      | `frame_len` bytes         |

## VoiceInit (message type 14)

| Field         | Notes                                                        |
| ------------- | ------------------------------------------------------------ |
| codec         | `"steam"` for modern TF2                                     |
| quality       | `255` ⇒ v2 header includes sampling_rate field               |
| sampling_rate | May be `0` in STV demos; per-packet SampleRate still applies |

## Tick timing

At 66.67 tick/s and 20 ms Opus frames → ~1.333 ticks/frame. This tool places frame `i` at:

```
start_tick + round(i * tickrate * frame_samples / sample_rate)
```

Each frame is written as its own voice-only `dem_packet` (one `svc_VoiceData`) immediately before the next original packet whose tick is `>=` the scheduled tick. Frames are not batched onto a gameplay packet. The first Steam Voice datagram starts with an Opus PLC reset (`frame_len = 0xFFFF`).
