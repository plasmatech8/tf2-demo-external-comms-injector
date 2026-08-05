# Scratch (local only)

Drop demos / audio / video here for one-off manual testing. Everything except this README is gitignored.

## Current manual-test set

| File | Notes |
|------|--------|
| `MedalTV…mp4` | Source recording (multi-track: All Audio / game / Discord / Mic) |
| `start_time.txt` | Video “GO” ≈ 3s → use as `--audio-skip` |
| `sultry.dem` | Original STV demo (`teamplay_round_start` ≈ 5.01s, auto `--offset`) |
| `comms.wav` | Discord+Mic @ 24 kHz. **Already** ffmpeg `-ss 3`’d (GO at t=0 in this file) → use `--audio-skip 0`. For a raw export, skip GO with `--audio-skip` instead of ffmpeg `-ss`. |
| `sultry_with_comms.dem` | Last known-good inject (may be older than HEAD; regen with recipe below) |

Open with Demoman from this folder.

**Note:** 48 kHz Steam voice (`--sample-rate 48000`) shows speaking indicators in TF2 but little/no audible audio. Stick to 24 kHz.

## Inject recipe (current CLI)

From `crates/injector`:

```bash
cargo run --release --bin inject-comms -- \
  scratch/sultry.dem \
  scratch/comms.wav \
  -o scratch/sultry_with_comms.dem \
  --player plasmatech8 \
  --audio-skip 0 \
  --sample-rate 24000 \
  --bitrate 64000
```

Omit `--offset` to auto-align to `teamplay_round_start`. See [docs/timing.md](../docs/timing.md).

If your WAV still includes pre-GO countdown, set `--audio-skip` to that many seconds (and don’t also ffmpeg `-ss`).
