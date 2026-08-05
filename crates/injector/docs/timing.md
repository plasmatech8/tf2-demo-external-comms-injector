# Timing: audio skip vs demo offset

Two clocks. Do not conflate them.

| Concept                       | Meaning                                                       | CLI / API                                      |
| ----------------------------- | ------------------------------------------------------------- | ---------------------------------------------- |
| **Game start in audio/video** | Seconds into the user’s recording until GO / end of countdown | `--audio-skip` (or trim the WAV before inject) |
| **Inject start in the demo**  | Demo timeline position where that trimmed audio should begin  | `--offset` (demo seconds), or **auto**         |

## Default demo align

If `--offset` is omitted, inject at the first `teamplay_round_start` event (`InspectReport.round_start_secs` / `InjectResult.offset_source = "teamplay_round_start"`).

If that event is missing: inject at `0` and warn (`offset_source = "fallback_zero"`). Pass `--offset` explicitly to override.

## UI mapping

Expose one primary field to users: “Game start in audio/video (seconds)” → `--audio-skip`.

Do **not** ask for demo offset in the main UI; rely on auto `teamplay_round_start`. Optional advanced: manual `--offset`.

## Example (Medal clip + STV)

- Recording: countdown ends / GO at ~3s → `--audio-skip 3`
- Demo: `teamplay_round_start` ~5.01s → omit `--offset` (auto)

```bash
inject-comms match.dem comms.wav -o out.dem --player Name --audio-skip 3
```

## Also

- Encode at **24 kHz** for in-game playback; 48 kHz often shows speaking indicators with little/no audio.
- See `scratch/README.md` for a known-good local recipe.
