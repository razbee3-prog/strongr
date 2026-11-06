import type { Client } from "langsmith";
import workoutJson from "../src/workouts/full-body-10.json";
import { FAULT_PRIORITY } from "../src/pose/formRules";

type Json = Record<string, any>;
export interface RunLike {
  id?: string;
  name?: string;
  parent_run_id?: string | null;
  session_id?: string;
  start_time?: number | string;
  end_time?: number | string;
  inputs?: Json;
  outputs?: Json;
  events?: Json[];
}
export interface Score {
  key: string;
  score: number;
  value?: number;
  comment: string;
}

const WORKOUTS: Record<string, { blocks: Json[] }> = { [workoutJson.id]: workoutJson };
const CUE_GAP_MS = 15_000;
const CUE_GAP_SLACK_MS = 250;
const MIN_FPS = 20;
/** Keys that would mean video, images or raw landmarks leaked into a trace. */
const FORBIDDEN_KEY = /landmark|image|frame|video|pixel|base64|keypoint|norm/i;

const ms = (t: unknown) => (typeof t === "number" ? t : Date.parse(String(t)));
const pass = (key: string, ok: boolean, okText: string, problems: string[], value?: number): Score => ({
  key,
  score: ok ? 1 : 0,
  value,
  comment: ok ? okText : problems.slice(0, 5).join("; ") + (problems.length > 5 ? ` (+${problems.length - 5} more)` : ""),
});

interface Cue {
  block: number;
  t: number;
  rep: number;
  fault: string;
}

/** Scores one workout trace (root run + its block runs). Checks that don't apply (e.g. cue checks with no cues) are omitted. */
export function scoreSession(root: RunLike, children: RunLike[]): Score[] {
  const out: Score[] = [];
  const blocks = [...children].sort((a, b) => Number(a.inputs?.index) - Number(b.inputs?.index));
  const ro = root.outputs ?? {};

  // 2. One root run with one child per block, in order.
  {
    const p: string[] = [];
    const plan = WORKOUTS[String(root.inputs?.workout_id)]?.blocks;
    if (!plan) p.push(`unknown workout ${root.inputs?.workout_id}`);
    if (root.name !== "workout_session") p.push(`root named ${root.name}`);
    if (!root.end_time || ro.completed === undefined) p.push("root run never ended");
    blocks.forEach((c, i) => {
      const idx = Number(c.inputs?.index);
      if (idx !== i) p.push(`block ${i} missing or duplicated (got index ${idx})`);
      const want = plan?.[idx];
      if (plan && (!want || want.type !== c.inputs?.type || (want.exercise ?? undefined) !== (c.inputs?.exercise ?? undefined)))
        p.push(`block ${idx} is ${c.inputs?.exercise ?? c.inputs?.type}, plan says ${want?.exercise ?? want?.type}`);
    });
    if (ro.completed === true && plan) {
      if (blocks.length !== plan.length) p.push(`completed but ${blocks.length}/${plan.length} block runs`);
      if (blocks.some((c) => c.outputs?.ended_by === "aborted")) p.push("completed but a block was aborted");
    }
    out.push(pass("trace_structure", !p.length, `1 root + ${blocks.length} block runs, in order`, p, blocks.length));
  }

  // 3. Pose ran at >= 20 fps.
  {
    const fps = Number(ro.avg_fps);
    out.push(pass("fps_at_least_20", Number.isFinite(fps) && fps >= MIN_FPS, `avg ${fps} fps`, [`avg ${Number.isFinite(fps) ? fps : "unknown"} fps (< ${MIN_FPS})`], Number.isFinite(fps) ? fps : undefined));
  }

  const repsOf = (c: RunLike): Json[] => (c.outputs?.reps ?? []) as Json[];
  const cueEvents = (c: RunLike): Json[] => (c.outputs?.cues ?? []) as Json[];
  const cues: Cue[] = blocks.flatMap((c) =>
    cueEvents(c)
      .filter((e) => e.type === "cue_fired")
      .map((e) => ({ block: Number(c.inputs?.index), t: ms(e.t), rep: Number(e.rep), fault: String(e.fault) })),
  );

  // 4. No two cues within 15 s (across the whole session).
  if (cues.length >= 2) {
    const sorted = [...cues].sort((a, b) => a.t - b.t);
    const p: string[] = [];
    let minGap = Infinity;
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].t - sorted[i - 1].t;
      minGap = Math.min(minGap, gap);
      if (gap < CUE_GAP_MS - CUE_GAP_SLACK_MS) p.push(`${sorted[i - 1].fault} → ${sorted[i].fault} only ${(gap / 1000).toFixed(1)} s apart`);
    }
    out.push(pass("cue_spacing", !p.length, `${cues.length} cues, closest ${(minGap / 1000).toFixed(1)} s apart`, p, Math.round(minGap / 100) / 10));
  }

  if (cues.length) {
    // 5. Never on the first rep, never during intro/countdown (block runs start when ACTIVE starts).
    const p5: string[] = [];
    for (const c of cues) {
      const run = blocks.find((b) => Number(b.inputs?.index) === c.block)!;
      if (!(c.rep >= 2)) p5.push(`block ${c.block}: ${c.fault} cue on rep ${c.rep}`);
      if (c.t < ms(run.start_time) || (run.end_time && c.t > ms(run.end_time))) p5.push(`block ${c.block}: ${c.fault} cue outside the active phase`);
    }
    out.push(pass("cue_timing", !p5.length, `all ${cues.length} cues after rep 1 and inside active time`, p5));

    // 6 + 7. Each cue's fault was in 2 of the last 3 reps, and it was the top-priority persistent fault.
    const p6: string[] = [];
    const p7: string[] = [];
    for (const c of cues) {
      const reps = repsOf(blocks.find((b) => Number(b.inputs?.index) === c.block)!);
      const win = reps.filter((r) => Number(r.n) > c.rep - 3 && Number(r.n) <= c.rep);
      const count = (f: string) => win.filter((r) => (r.faults ?? []).includes(f)).length;
      if (count(c.fault) < 2) p6.push(`block ${c.block} rep ${c.rep}: ${c.fault} in only ${count(c.fault)}/3 reps`);
      const top = FAULT_PRIORITY.find((f) => count(f) >= 2);
      if (top && top !== c.fault) p7.push(`block ${c.block} rep ${c.rep}: cued ${c.fault} but ${top} ranks higher`);
    }
    out.push(pass("cue_persistence", !p6.length, `all ${cues.length} cues had their fault in ≥2 of the last 3 reps`, p6));
    out.push(pass("cue_priority", !p7.length, `all ${cues.length} cues picked the top-priority fault`, p7));

    // 8. Praise exactly when a cued fault stays gone for 2 reps.
    const p8: string[] = [];
    let expected = 0;
    for (const b of blocks) {
      const fired = new Map(cueEvents(b).filter((e) => e.type === "cue_fired").map((e) => [Number(e.rep), String(e.fault)]));
      const praised = new Map(cueEvents(b).filter((e) => e.type === "cue_resolved").map((e) => [Number(e.rep), String(e.fault)]));
      let active: { fault: string; clean: number } | null = null;
      for (const r of repsOf(b)) {
        const n = Number(r.n);
        let due: string | null = null;
        if (active) {
          if ((r.faults ?? []).includes(active.fault)) active.clean = 0;
          else if (++active.clean >= 2) {
            due = active.fault;
            active = null;
          }
        }
        if (due) {
          expected++;
          if (praised.get(n) !== due) p8.push(`block ${b.inputs?.index} rep ${n}: ${due} fixed for 2 reps but no praise`);
        } else if (praised.has(n)) p8.push(`block ${b.inputs?.index} rep ${n}: praise without a fix`);
        if (fired.has(n)) active = { fault: fired.get(n)!, clean: 0 };
      }
    }
    out.push(pass("praise_after_fix", !p8.length, expected ? `praised all ${expected} fixes` : "no fixes to praise", p8));
  }

  // 12. No video, images or per-frame landmarks in the trace.
  {
    const p: string[] = [];
    const walk = (v: unknown, path: string) => {
      if (typeof v === "string") {
        if (/^data:(image|video)\//.test(v) || (v.length > 2000 && /^[A-Za-z0-9+/=]+$/.test(v))) p.push(`${path} looks like encoded media`);
        return;
      }
      if (!v || typeof v !== "object") return;
      if (Array.isArray(v)) {
        if (v.length >= 20 && v.every((x) => x && typeof x === "object" && "x" in x && "y" in x)) p.push(`${path} looks like landmarks`);
        v.forEach((x, i) => walk(x, `${path}[${i}]`));
        return;
      }
      for (const [k, x] of Object.entries(v)) {
        if (FORBIDDEN_KEY.test(k)) p.push(`${path}.${k} is not allowed`);
        walk(x, `${path}.${k}`);
      }
    };
    for (const r of [root, ...blocks]) for (const part of ["inputs", "outputs", "events"] as const) walk(r[part], `${r.name}.${part}`);
    out.push(pass("privacy", !p.length, "no media or landmarks in trace", p));
  }
  return out;
}

/** Load a trace from LangSmith, score it, and attach the scores as feedback on the root run. */
export async function evaluateTrace(client: Client, projectName: string, traceId: string, opts: { post?: boolean; minChildren?: number } = {}) {
  const runs: RunLike[] = [];
  for await (const r of client.listRuns({ projectName, traceId })) runs.push(r as unknown as RunLike);
  const root = runs.find((r) => !r.parent_run_id);
  if (!root) return null;
  const children = runs.filter((r) => r.parent_run_id === root.id);
  if (opts.minChildren !== undefined && children.length < opts.minChildren) return null;
  const scores = scoreSession(root, children);
  if (opts.post) {
    const have = new Set<string>();
    for await (const f of client.listFeedback({ runIds: [root.id!] })) have.add(f.key);
    for (const s of scores) {
      if (have.has(s.key)) continue;
      await client.createFeedback({ runId: root.id!, sessionId: root.session_id!, key: s.key, score: s.score, value: s.value, comment: s.comment, feedbackSourceType: "model" });
    }
  }
  return { root, scores };
}
