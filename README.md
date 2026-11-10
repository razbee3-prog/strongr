# AI Trainer (v0 prototype)

Mobile web app that runs a guided 10-minute full-body workout on iPhone Safari. A trainer video demonstrates each move while the front camera tracks your pose (MediaPipe `PoseLandmarker`, lite model), counts reps, and speaks gentle form cues. Everything runs in the browser; the only server piece is `/api/trace`, which forwards session summaries to LangSmith.

## Run locally

```bash
npm install
npm run dev            # http://localhost:5173  (add ?debug=1 for the debug overlay)
```

Camera access needs HTTPS on a phone. To test on an iPhone locally, tunnel the dev server (e.g. `npx cloudflared tunnel --url http://localhost:5173`) or use a Vercel preview deploy.

`/api/trace` also runs under `vite dev` (see `vite.config.ts`), so tracing works locally if the env vars below are set in your shell.

## Env vars (server only)

| Name | Value |
| --- | --- |
| `LANGSMITH_API_KEY` | your LangSmith API key (server only, never sent to the browser) |
| `LANGSMITH_PROJECT` | project name, default `ai-trainer` |
| `LANGSMITH_ENDPOINT` | optional, default `https://api.smith.langchain.com` |
| `TRACE_SECRET` | optional HMAC secret for per-session trace tokens, defaults to the LangSmith key |

Without `LANGSMITH_API_KEY` the app still works; `/api/trace` just no-ops.

## Deploy

Live at https://trainer-167-71-17-98.sslip.io: a Docker container (`Dockerfile`, Node server in `server/index.ts` that serves `dist/` plus `/api/trace`) on the shared DigitalOcean droplet.

```bash
rsync -az --delete --exclude node_modules --exclude dist --exclude .git ./ root@<droplet>:/opt/strongr/app/
ssh root@<droplet> 'cd /opt/strongr/app && docker build -t strongr-trainer . && docker rm -f strongr-trainer; \
  docker run -d --name strongr-trainer --restart unless-stopped --env-file /opt/strongr/.env --network noa_edge strongr-trainer'
```

TLS and routing come from the Noa Caddy container (`noa-caddy-1`), which has a `trainer.<ip>.sslip.io { reverse_proxy strongr-trainer:3000 }` site block. `vercel.json` + `api/trace.ts` still work for a Vercel deploy (`npx vercel --prod`).

## How it fits together

- `src/workouts/full-body-10.json` — the workout script (blocks).
- `src/exercises.ts` — exercise catalog: display name, video file, intro/outro lines, rep detector, form rules.
- `src/session/orchestrator.ts` — state machine `READY → INTRO → COUNTDOWN → ACTIVE → OUTRO → REST/next → DONE`, advance rules, tracking-loss fallback, voice prompts.
- `src/pose/` — One Euro smoothing, joint-angle features, rep detectors (squat / reverse lunge / jumping jacks), form rules.
- `src/session/cuePolicy.ts` — gentle cue policy (2 of last 3 reps, 1 cue / 15 s, priority order, praise on fix).
- `src/session/audio.ts` — single priority speech queue (countdown > trainer > cue > encouragement), beeps, ducking, pause/resume.
- `src/session/lines.ts` + `scripts/gen-voice.ts` — every trainer line, pre-recorded with ElevenLabs into `public/voice/` (`ELEVEN_LABS_KEY=... npm run voice`; only new lines are generated). Lines without a clip fall back to the browser's speech voice.
- `evals/online/` — LangSmith online code evaluators on the `ai-trainer` project (`npm run evals:online` creates/replaces them). Each block run is scored about 1–3 min after the block ends (`trace_structure` vs the plan, `privacy`, and when a cue fired: `cue_spacing`, `cue_timing`, `cue_persistence`, `cue_priority`, `praise_after_fix`); the `workout_session` root gets `trace_structure`, `fps_at_least_20`, `privacy` when the workout ends. Edit the `.py` files and rerun the command to change them.
- `api/evals.ts` — the same checks across a whole trace (incl. cross-block cue spacing and block order). Off on the server by default (`TRACE_EVALS=1` turns it on) so scores aren't duplicated; it attaches LangSmith feedback on the root run: `trace_structure`, `fps_at_least_20`, `cue_spacing`, `cue_timing`, `cue_persistence`, `cue_priority`, `praise_after_fix`, `privacy` (cue checks are skipped when no cue fired). `npm run evals -- --limit 20 [--dry]` (re)scores recent workouts; `npm test` checks the evals and squat sim offline.
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
