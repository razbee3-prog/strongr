export interface TraceEvent {
  type: "rep" | "cue_fired" | "cue_resolved" | "tracking_lost" | "paused";
  t: string;
  [k: string]: unknown;
}

export interface BlockSummary {
  index: number;
  type: "exercise" | "rest";
  exercise?: string;
  mode: string;
  target_reps?: number;
  target_s?: number;
  cap_s?: number;
  actual_reps: number;
  actual_s: number;
  ended_by: "target" | "cap" | "fallback" | "aborted";
  start_time: string;
  end_time: string;
  events: TraceEvent[];
}

type Payload =
  | { kind: "session_start"; session_id: string; start_time: string; workout_id: string; user_agent: string }
  | { kind: "block"; session_id: string; session_start: string; block: BlockSummary }
  | { kind: "session_end"; session_id: string; session_start: string; end_time: string; completed: boolean; total_reps: number; blocks_done: number; avg_fps: number };

/** Buffers events in the browser and ships them to /api/trace (no video, images, or landmarks). */
export class Tracer {
  readonly sessionId = crypto.randomUUID();
  readonly startTime = new Date().toISOString();
  readonly log: unknown[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private ended = false;
  private workoutId: string;
  /** Server-issued HMAC for this session; required for block/session_end. */
  private token = "";

  constructor(workoutId: string) {
    this.workoutId = workoutId;
  }

  start() {
    this.send(this.startPayload());
  }

  private startPayload(): Payload {
    return { kind: "session_start", session_id: this.sessionId, start_time: this.startTime, workout_id: this.workoutId, user_agent: navigator.userAgent };
  }

  block(block: BlockSummary) {
    this.send({ kind: "block", session_id: this.sessionId, session_start: this.startTime, block });
  }

  end(completed: boolean, totalReps: number, blocksDone: number, avgFps: number, pending?: BlockSummary, beacon = false) {
    if (this.ended) return;
    this.ended = true;
    const endP: Payload = { kind: "session_end", session_id: this.sessionId, session_start: this.startTime, end_time: new Date().toISOString(), completed, total_reps: totalReps, blocks_done: blocksDone, avg_fps: avgFps };
    if (beacon) {
      const batch: Payload[] = pending ? [{ kind: "block", session_id: this.sessionId, session_start: this.startTime, block: pending }, endP] : [endP];
      // No token yet means session_start never completed; resend it so the server can authorise this batch.
      if (!this.token) batch.unshift(this.startPayload());
      this.log.push(...batch);
      navigator.sendBeacon?.("/api/trace", new Blob([JSON.stringify(batch.map((b) => ({ ...b, token: this.token })))], { type: "application/json" }));
      return;
    }
    if (pending) this.block(pending);
    this.send(endP);
  }

  private send(p: Payload) {
    this.log.push(p);
    this.chain = this.chain.then(async () => {
      try {
        const r = await fetch("/api/trace", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([{ ...p, token: this.token }]), keepalive: true });
        if (p.kind === "session_start") this.token = ((await r.json()) as { token?: string }).token ?? "";
      } catch {
        /* tracing is best-effort */
      }
    });
  }
}
