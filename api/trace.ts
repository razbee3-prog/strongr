import { createHmac, timingSafeEqual } from "node:crypto";
import { Client, RunTree } from "langsmith";
import { evaluateTrace } from "./evals";

type Json = Record<string, unknown>;

interface Req {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}
interface Res {
  status(code: number): Res;
  json(body: unknown): void;
}

let client: Client | null = null;
const getClient = () =>
  (client ??= new Client({
    apiKey: process.env.LANGSMITH_API_KEY,
    apiUrl: process.env.LANGSMITH_ENDPOINT || "https://api.smith.langchain.com",
  }));
const project = () => process.env.LANGSMITH_PROJECT || "ai-trainer";

/** Rebuild the root RunTree deterministically (same id + start_time ⇒ same dotted_order) so each request can attach children. */
const root = (sessionId: string, start: string, extra: Partial<ConstructorParameters<typeof RunTree>[0]> = {}) =>
  new RunTree({
    id: sessionId,
    name: "workout_session",
    run_type: "chain",
    start_time: Date.parse(start),
    project_name: project(),
    client: getClient(),
    ...extra,
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = new Set(["session_start", "block", "session_end"]);
const MAX_ITEMS = 3;
const MAX_EVENTS = 500;
const MAX_BODY = 256_000;
const MAX_AGE_MS = 6 * 3600_000;

const secret = () => process.env.TRACE_SECRET || process.env.LANGSMITH_API_KEY || "";
const sign = (sid: string, start: string) => createHmac("sha256", secret()).update(`${sid}|${start}`).digest("hex");
const tokenOk = (sid: string, start: string, token: unknown) => {
  if (typeof token !== "string") return false;
  const a = Buffer.from(sign(sid, start));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

const header = (req: Req, name: string) => {
  const v = req.headers?.[name];
  return Array.isArray(v) ? v[0] : v;
};
/** Browsers always send Origin on cross-site POSTs; reject anything not from our own host. */
const sameOrigin = (req: Req) => {
  const origin = header(req, "origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === (header(req, "x-forwarded-host") ?? header(req, "host"));
  } catch {
    return false;
  }
};

/** Returns an error string if the payload is malformed or not authorised for its session. */
function invalid(p: Json, batch: Json[]): string | null {
  if (!p || typeof p !== "object" || !KINDS.has(String(p.kind))) return "bad kind";
  const sid = String(p.session_id);
  if (!UUID.test(sid)) return "bad session_id";
  const start = String(p.kind === "session_start" ? p.start_time : p.session_start);
  const t = Date.parse(start);
  if (!Number.isFinite(t) || Math.abs(Date.now() - t) > MAX_AGE_MS) return "bad start time";
  if (p.kind === "session_start") return null;
  const startedHere = batch.some((q) => q?.kind === "session_start" && q.session_id === sid && q.start_time === start);
  if (!startedHere && !tokenOk(sid, start, p.token)) return "bad token";
  if (p.kind === "block") {
    const b = p.block as Json | undefined;
    if (!b || !Array.isArray(b.events) || b.events.length > MAX_EVENTS) return "bad block";
  }
  return null;
}

const EVAL_DELAYS_MS = [15_000, 45_000, 120_000];
/** Score a finished workout once LangSmith has ingested its block runs (best-effort; needs a long-lived server). */
function scheduleEval(sid: string, minChildren: number, attempt = 0) {
  setTimeout(async () => {
    const last = attempt === EVAL_DELAYS_MS.length - 1;
    try {
      const r = await evaluateTrace(getClient(), project(), sid, { post: true, minChildren: last ? undefined : minChildren });
      if (!r && !last) scheduleEval(sid, minChildren, attempt + 1);
    } catch (e) {
      console.error("eval error", e);
      if (!last) scheduleEval(sid, minChildren, attempt + 1);
    }
  }, EVAL_DELAYS_MS[attempt]).unref?.();
}

async function handle(p: Json) {
  const sid = String(p.session_id);
  if (p.kind === "session_start") {
    const r = root(sid, String(p.start_time), {
      inputs: { workout_id: p.workout_id, user_agent: p.user_agent, start_time: p.start_time },
      metadata: { workout_id: p.workout_id, user_agent: p.user_agent },
    });
    await r.postRun();
  } else if (p.kind === "block") {
    const b = p.block as Json & { events: Json[] };
    const r = root(sid, String(p.session_start));
    const child = r.createChild({
      name: b.type === "rest" ? `rest_${b.index}` : `block_${b.index}_${b.exercise}`,
      run_type: "chain",
      start_time: Date.parse(String(b.start_time)),
      inputs: { index: b.index, type: b.type, exercise: b.exercise, mode: b.mode, target_reps: b.target_reps, target_s: b.target_s, cap_s: b.cap_s },
      metadata: { exercise: b.exercise, mode: b.mode, ended_by: b.ended_by },
    });
    child.events = b.events.map((e) => ({ name: String(e.type), time: String(e.t), kwargs: e }));
    child.outputs = {
      actual_reps: b.actual_reps,
      actual_s: b.actual_s,
      ended_by: b.ended_by,
      reps: b.events.filter((e) => e.type === "rep"),
      cues: b.events.filter((e) => e.type === "cue_fired" || e.type === "cue_resolved"),
      tracking_lost: b.events.filter((e) => e.type === "tracking_lost"),
    };
    child.end_time = Date.parse(String(b.end_time));
    await child.postRun();
  } else if (p.kind === "session_end") {
    const r = root(sid, String(p.session_start));
    r.outputs = { completed: p.completed, total_reps: p.total_reps, blocks_done: p.blocks_done, avg_fps: p.avg_fps, end_time: p.end_time };
    r.end_time = Date.parse(String(p.end_time));
    await r.patchRun();
    if (process.env.TRACE_EVALS === "1") scheduleEval(sid, Number(p.blocks_done) || 0);
  }
}

export default async function handler(req: Req, res: Res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!process.env.LANGSMITH_API_KEY) return res.status(200).json({ ok: false, reason: "LANGSMITH_API_KEY not set" });
  if (!sameOrigin(req)) return res.status(403).json({ error: "cross-origin" });
  let body = req.body;
  try {
    const raw = typeof body === "string" ? body : JSON.stringify(body ?? null);
    if (raw.length > MAX_BODY) return res.status(413).json({ error: "too large" });
    if (typeof body === "string") body = JSON.parse(body);
  } catch {
    return res.status(400).json({ error: "bad json" });
  }
  const items = (Array.isArray(body) ? body : [body]) as Json[];
  if (items.length > MAX_ITEMS) return res.status(400).json({ error: "too many items" });
  for (const p of items) {
    const err = invalid(p, items);
    if (err) return res.status(400).json({ error: err });
  }
  try {
    for (const p of items) await handle(p);
    await getClient().awaitPendingTraceBatches();
    const startItem = items.find((p) => p.kind === "session_start");
    const token = startItem ? sign(String(startItem.session_id), String(startItem.start_time)) : undefined;
    res.status(200).json({ ok: true, n: items.length, token });
  } catch (e) {
    console.error("trace error", e);
    res.status(500).json({ ok: false, error: "trace failed" });
  }
}
