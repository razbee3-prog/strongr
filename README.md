# AI Trainer (v0 prototype)

Mobile web app that runs a guided 10-minute full-body workout on iPhone Safari. A trainer video demonstrates each move while the front camera tracks your pose (MediaPipe `PoseLandmarker`, lite model), counts reps, and speaks gentle form cues. Everything runs in the browser; the only server piece is `/api/trace`, which forwards session summaries to LangSmith.

## Run locally

```bash
npm install
npm run dev            # http://localhost:5173  (add ?debug=1 for the debug overlay)
```

Camera access needs HTTPS on a phone. To test on an iPhone locally, tunnel the dev server (e.g. `npx cloudflared tunnel --url http://localhost:5173`) or use a Vercel preview deploy.

`/api/trace` also runs under `vite dev` (see `vite.config.ts`), so tracing works locally if the env vars below are set in your shell.

## Env vars (Vercel → Project → Settings → Environment Variables)

| Name | Value |
| --- | --- |
| `LANGSMITH_API_KEY` | your LangSmith API key (server only, never sent to the browser) |
| `LANGSMITH_PROJECT` | project name, default `ai-trainer` |
| `LANGSMITH_ENDPOINT` | optional, default `https://api.smith.langchain.com` |

Without `LANGSMITH_API_KEY` the app still works; `/api/trace` just no-ops.

## Deploy

```bash
npx vercel --prod
```

## How it fits together

- `src/workouts/full-body-10.json` — the workout script (blocks).
- `src/exercises.ts` — exercise catalog: display name, video file, intro/outro lines, rep detector, form rules.
- `src/session/orchestrator.ts` — state machine `READY → INTRO → COUNTDOWN → ACTIVE → OUTRO → REST/next → DONE`, advance rules, tracking-loss fallback, voice prompts.
- `src/pose/` — One Euro smoothing, joint-angle features, rep detectors (squat / reverse lunge / jumping jacks), form rules.
- `src/session/cuePolicy.ts` — gentle cue policy (2 of last 3 reps, 1 cue / 15 s, priority order, praise on fix).
- `src/session/audio.ts` — single priority speech queue (countdown > trainer > cue > encouragement), beeps, ducking.
- `src/session/trace.ts` + `api/trace.ts` — event buffering and the LangSmith run tree (`workout_session` root → one child run per block, with `rep` / `cue_fired` / `cue_resolved` / `tracking_lost` events). No video, images or landmarks are sent.

## Add an exercise

1. Drop the clip in `public/videos/<id>.mp4` (H.264, muted, short loop; ~960px wide is plenty).
2. Add an entry to `EXERCISES` in `src/exercises.ts`:
   ```ts
   side_lunge: { name: "Side Lunges", video: "side_lunge.mp4", outro: "Nice work", detector: lungeDetector, rules: lungeRules },
   ```
   `detector` and `rules` are optional — without them the block is timed only.
3. Reference it from a workout block: `{"type":"exercise","exercise":"side_lunge","mode":"reps","target_reps":10,"cap_s":60,"form":true}`.
4. For a new movement pattern, write a detector in `src/pose/detectors.ts` (implement `RepDetector`) and a `RuleSet` in `src/pose/formRules.ts`.

## Notes / deviations from the spec

- **Squat DOWN threshold is 135°, not 100°.** With a 100° bar, a shallow squat (min knee angle > 110°) never registers as a rep, so the depth cue could never fire. Reps are counted UP(>160°) → DOWN(<135°) → UP, and the depth rule flags any rep whose minimum knee angle stays above 110°.
- Missing trainer clips show the exercise name on a dark card instead of blocking the workout.
- Rest blocks show the next exercise's clip dimmed behind a REST label.

## Measurements

See `docs/measurements.md`.
