# Measurements (pre-device)

Measured on the dev VM (headless Chrome, Apple Silicon, GPU delegate) with Chrome's fake camera fed by the trainer clips. **iPhone numbers still need to be taken on a real device** (use `?debug=1`; avg fps is also sent to LangSmith as `avg_fps` on the root run).

| What | Result |
| --- | --- |
| Pose fps (lite model, GPU delegate, 640×480 camera) | 40–57 fps on the VM |
| Jumping jacks (real pose pipeline, NASM clip looped as camera) | counting steadily ~0.85 reps/s, detector alternates OPEN/CLOSED cleanly |
| Squat detector, synthetic knee-angle traces with ±3° noise (`npx tsx scripts/sim.ts`) | 12/12 at 2.5 s/rep, 12/12 at 1.2 s/rep, 0 false reps on ±6° standing jitter |
| Depth cue, 12 shallow squats (min knee 120°) | fires on rep 2, again only after 15 s (rep 8) |
| Shallow ×4 then good reps | cue on rep 2, "That's it, much better" after 2 clean reps |

The supplied squat clip cuts to close-ups after ~1.5 s, so it can't stand in for a person at 2.5 m; squat accuracy on real video still needs an on-device check.
