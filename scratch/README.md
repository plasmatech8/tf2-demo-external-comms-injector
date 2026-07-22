# Scratch (local only)

Drop demos, WAV/MP3, or video here for one-off manual testing. Contents are gitignored.

Examples:

```bash
cargo run --release --bin inject-comms -- \
  scratch/match.dem \
  scratch/comms.wav \
  -o scratch/injected.dem \
  --player YourName \
  --offset 10

# Convert video audio first (ffmpeg optional)
ffmpeg -i scratch/clip.mp4 -ar 24000 -ac 1 scratch/comms.wav
```
