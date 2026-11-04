import { Client, RunTree } from "langsmith";

type Json = Record<string, unknown>;

interface Req {
  method?: string;
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
  }
}

export default async function handler(req: Req, res: Res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!process.env.LANGSMITH_API_KEY) return res.status(200).json({ ok: false, reason: "LANGSMITH_API_KEY not set" });
  let body = req.body;
  if (typeof body === "string") body = JSON.parse(body);
  const items = (Array.isArray(body) ? body : [body]) as Json[];
  try {
    for (const p of items) await handle(p);
    await getClient().awaitPendingTraceBatches();
    res.status(200).json({ ok: true, n: items.length });
  } catch (e) {
    console.error("trace error", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
}
