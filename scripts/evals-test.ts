// Offline check that each eval passes a clean session and catches the fault it's meant to catch.
// Run: npx tsx scripts/evals-test.ts
import assert from "node:assert/strict";
import workout from "../src/workouts/full-body-10.json" with { type: "json" };
import { scoreSession, type RunLike } from "../api/evals";

const T0 = Date.parse("2026-11-06T10:00:00Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();

/** Squat block (index 1) starts active at 60 s; reps every 2.5 s. Shallow reps 1-3, then deep. */
function session(edit: (s: { root: RunLike; children: RunLike[] }) => void = () => {}) {
  const children: RunLike[] = workout.blocks.map((b, i) => {
    const start = i * 60;
    const isSquat = i === 1;
    const reps = isSquat
      ? Array.from({ length: 12 }, (_, k) => ({ type: "rep", t: iso(start + 2.5 * (k + 1)), n: k + 1, min_knee_angle: k < 3 ? 120 : 85, faults: k < 3 ? ["depth"] : [] }))
      : [];
    const cues = isSquat
      ? [
          { type: "cue_fired", t: iso(start + 5), fault: "depth", text: "Try sinking a little deeper", persistence: "2/3", rep: 2 },
          { type: "cue_resolved", t: iso(start + 12.5), fault: "depth", rep: 5 },
        ]
      : [];
    return {
      name: `block_${i}`,
      parent_run_id: "root",
      start_time: iso(start),
      end_time: iso(start + 40),
      inputs: { index: i, type: b.type, exercise: (b as { exercise?: string }).exercise, mode: (b as { mode?: string }).mode },
      outputs: { actual_reps: reps.length, ended_by: "target", reps, cues, tracking_lost: [] },
      events: [...reps, ...cues].map((e) => ({ name: e.type, time: e.t, kwargs: e })),
    };
  });
  const root: RunLike = { id: "root", name: "workout_session", start_time: iso(0), end_time: iso(700), inputs: { workout_id: workout.id }, outputs: { completed: true, total_reps: 12, blocks_done: 11, avg_fps: 28 } };
  const s = { root, children };
  edit(s);
  return Object.fromEntries(scoreSession(s.root, s.children).map((x) => [x.key, x]));
}

const squat = (s: { children: RunLike[] }) => s.children[1].outputs!;
const clean = session();
for (const k of ["trace_structure", "fps_at_least_20", "cue_timing", "cue_persistence", "cue_priority", "praise_after_fix", "privacy"]) assert.equal(clean[k]?.score, 1, `${k}: ${clean[k]?.comment}`);
assert.equal(clean.cue_spacing, undefined, "cue_spacing skipped with one cue");

const fails: [string, string, (s: { root: RunLike; children: RunLike[] }) => void][] = [
  ["trace_structure", "missing block", (s) => s.children.splice(4, 1)],
  ["trace_structure", "wrong exercise", (s) => (s.children[2].inputs!.exercise = "squat")],
  ["fps_at_least_20", "slow", (s) => (s.root.outputs!.avg_fps = 14)],
  ["cue_spacing", "cues 6 s apart", (s) => squat(s).cues.push({ type: "cue_fired", t: iso(71), fault: "depth", rep: 4 })],
  ["cue_timing", "first-rep cue", (s) => (squat(s).cues[0].rep = 1)],
  ["cue_timing", "cue in countdown", (s) => (squat(s).cues[0].t = iso(58))],
  ["cue_persistence", "fault seen once", (s) => (squat(s).reps[0].faults = [])],
  ["cue_priority", "lower-priority cue", (s) => { squat(s).reps[0].faults.push("knees_caving"); squat(s).reps[1].faults.push("knees_caving"); }],
  ["praise_after_fix", "missing praise", (s) => squat(s).cues.pop()],
  ["privacy", "landmarks", (s) => (squat(s).landmarks = [[{ x: 0, y: 0 }]])],
  ["privacy", "image", (s) => (s.root.inputs!.snap = "data:image/png;base64,AAAA")],
];
for (const [key, why, edit] of fails) assert.equal(session(edit)[key]?.score, 0, `${key} should fail: ${why}`);
console.log(`evals ok: clean session passes, ${fails.length} faulty sessions caught`);
