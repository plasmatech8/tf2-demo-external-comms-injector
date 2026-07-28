# Scratch (local only)

Drop demos / audio / video here for manual testing. Everything except this README is gitignored.

## Current manual-test set

| File | Notes |
|------|--------|
| `MedalTV…mp4` | Source recording (multi-track: All Audio / game / Discord / Mic) |
| `start_time.txt` | Video “GO” ≈ 3s; demo `teamplay_round_start` ≈ 5.01s |
| `sultry.dem` | Original STV demo |
| `comms.wav` | Discord+Mic mix, 24 kHz mono, first 3s of video skipped |
| `sultry_with_comms.dem` | Working inject: 24 kHz @ 64 kbps, `--offset 5.01` |

Open with Demoman from this folder.

**Note:** 48 kHz Steam voice (`--sample-rate 48000`) shows speaking indicators in TF2 but little/no audible audio. Stick to 24 kHz.

## Inject recipe (known-good)

```bash
cargo run --release --bin inject-comms -- \
  scratch/sultry.dem \
  scratch/comms.wav \
  -o scratch/sultry_with_comms.dem \
  --player plasmatech8 \
  --offset 5.01 \
  --sample-rate 24000 \
  --bitrate 64000
```

Do **not** use `--sample-rate 48000` for in-game playback — TF2 shows speaking indicators but little/no audible voice.
