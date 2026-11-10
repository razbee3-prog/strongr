import { EXERCISES, type ExerciseDef } from "../exercises";
import type { RepDetector } from "../pose/detectors";
import type { Fault } from "../pose/formRules";
import type { PoseFrame } from "../pose/tracker";
import type { AudioEngine } from "./audio";
import { CuePolicy } from "./cuePolicy";
import { exName, LINE } from "./lines";
import type { BlockSummary, TraceEvent, Tracer } from "./trace";

export interface Block {
  type: "exercise" | "rest";
  exercise?: string;
  mode?: "time" | "reps";
  target_s?: number;
  target_reps?: number;
  cap_s?: number;
  count_reps?: boolean;
  form?: boolean;
}
export interface Workout {
  id: string;
  blocks: Block[];
}

export type Phase = "READY" | "INTRO" | "COUNTDOWN" | "ACTIVE" | "OUTRO" | "REST" | "DONE";

export interface Snapshot {
  phase: Phase;
  paused: boolean;
  blockIndex: number;
  title: string;
  /** Big number: seconds left, or "7 / 12". */
  main: string;
  sub: string;
  next: string;
  progress: number;
  countdown: number | null;
  cueActive: boolean;
  bodyReadyPct: number;
  fallback: boolean;
  debug: { kneeAvg: number | null; kneeMin: number | null; tilt: number | null; detector: string; faults: Fault[]; fullBody: boolean };
}

const INTRO_MS = 3000;
const COUNTDOWN_MS = 3000;
const OUTRO_MS = 1800;
const BODY_READY_MS = 2000;
const TRACKING_LOSS_MS = 3000;
const CUE_VISUAL_MS = 4000;
const PROGRESS_MS = 15_000;

const blockDurS = (b: Block) => b.target_s ?? b.cap_s ?? 60;

export class Session {
  phase: Phase = "READY";
  private i = -1;
  private phaseStart = 0;
  private bodySince: number | null = null;
  private lastBodyAt = 0;
  private detector: RepDetector | null = null;
  private cues = new CuePolicy();
  private reps = 0;
  private fallback = false;
  private said10 = false;
  private said3 = false;
  private events: TraceEvent[] = [];
  private blockStartIso = "";
  private totalReps = 0;
  private cueAt = -Infinity;
  private countdownStep = -1;
  private lastFrame: PoseFrame | null = null;
  private lastFaults: Fault[] = [];
  private totalDur: number;
  private workout: Workout;
  private audio: AudioEngine;
  private tracer: Tracer;
  private setVideo: (file: string | null, dim: boolean) => void;
  private pausedAt: number | null = null;
  private lastProgressAt = 0;
  avgFps = () => 0;

  constructor(workout: Workout, audio: AudioEngine, tracer: Tracer, setVideo: (file: string | null, dim: boolean) => void) {
    this.workout = workout;
    this.audio = audio;
    this.tracer = tracer;
    this.setVideo = setVideo;
    this.totalDur = workout.blocks.reduce((s, b) => s + blockDurS(b), 0);
  }

  private get block(): Block | undefined {
    return this.workout.blocks[this.i];
  }
  private get def(): ExerciseDef | undefined {
    return this.block?.exercise ? EXERCISES[this.block.exercise] : undefined;
  }

  onPose(f: PoseFrame) {
    this.lastFrame = f;
    if (this.pausedAt !== null) return;
    const now = f.tMs;
    if (f.fullBody) {
      this.lastBodyAt = now;
      this.bodySince ??= now;
    } else this.bodySince = null;

    if (this.pausedAt !== null || this.phase !== "ACTIVE" || !this.detector || !f.features || !f.fullBody) return;
    const rep = this.detector.update(f.features, now / 1000);
    if (!rep) return;
    this.reps++;
    const b = this.block!;
    const faults = b.form && this.def?.rules ? this.def.rules(rep) : [];
    this.lastFaults = faults;
    this.events.push({ type: "rep", t: new Date().toISOString(), n: this.reps, min_knee_angle: Math.round(rep.minKnee), max_torso_tilt: Math.round(rep.maxTilt), faults });
    if (b.mode === "reps" && !this.fallback && !this.said3 && b.target_reps! - this.reps === 3) {
      this.said3 = true;
      this.audio.say(LINE.threeMore, "trainer");
    }
    if (!b.form) return;
    const d = this.cues.onRep(faults, now);
    if (d?.kind === "cue") {
      this.cueAt = now;
      this.audio.say(d.text, "cue");
      this.events.push({ type: "cue_fired", t: new Date().toISOString(), fault: d.fault, text: d.text, persistence: `${d.persistence}/3`, rep: this.reps });
    } else if (d?.kind === "resolved") {
      this.audio.say(d.text, "encouragement");
      this.events.push({ type: "cue_resolved", t: new Date().toISOString(), fault: d.fault, rep: this.reps });
    }
  }

  get paused() {
    return this.pausedAt !== null;
  }

  /** Only once the workout is running (not while finding the body or after it's done). */
  get canPause() {
    return this.phase !== "READY" && this.phase !== "DONE";
  }

  pause(now: number) {
    if (this.pausedAt !== null || !this.canPause) return;
    this.pausedAt = now;
    this.audio.pause();
  }

  resume(now: number) {
    if (this.pausedAt === null) return;
    const dt = now - this.pausedAt;
    this.pausedAt = null;
    // Paused time doesn't count toward the block timer, tracking loss, or the cue gap.
    this.phaseStart += dt;
    this.lastBodyAt += dt;
    this.cueAt += dt;
    this.cues.shift(dt);
    this.detector?.reset();
    this.events.push({ type: "paused", t: new Date().toISOString(), duration_s: Math.round(dt / 100) / 10 });
    this.audio.resume();
    this.audio.say(LINE.resume, "trainer");
  }

  tick(now: number) {
    if (this.pausedAt !== null) return;
    if (now - this.lastProgressAt >= PROGRESS_MS && (this.phase === "ACTIVE" || this.phase === "REST")) {
      this.lastProgressAt = now;
      this.tracer.progress(this.totalReps + this.reps, this.blocksDone, this.avgFps(), { ...this.summary("aborted", now), events: [...this.events] });
    }
    const el = now - this.phaseStart;
    switch (this.phase) {
      case "READY":
        if (this.bodySince !== null && now - this.bodySince >= BODY_READY_MS) {
          this.tracer.start();
          this.begin(0, now);
        }
        break;
      case "INTRO":
        if (el >= INTRO_MS) this.go("COUNTDOWN", now);
        break;
      case "COUNTDOWN": {
        const step = Math.floor(el / 1000);
        if (step !== this.countdownStep && step < 3) {
          this.countdownStep = step;
          this.audio.beep(660, 0.15);
        }
        if (el >= COUNTDOWN_MS) {
          this.audio.beep(990, 0.3);
          this.audio.say(LINE.go, "countdown");
          this.startActive(now);
        }
        break;
      }
      case "ACTIVE":
        this.tickActive(now, el / 1000);
        break;
      case "REST": {
        const left = this.block!.target_s! - el / 1000;
        if (!this.said10 && left <= 10) {
          this.said10 = true;
          this.audio.say(LINE.restTen(this.workout.blocks[this.i + 1]), "trainer");
        }
        if (left <= 0) this.endBlock("target", now);
        break;
      }
      case "OUTRO":
        if (el >= OUTRO_MS) this.begin(this.i + 1, now);
        break;
    }
  }

  /** Debug helper. */
  skip(now: number) {
    if (this.phase === "ACTIVE" || this.phase === "REST") this.endBlock("aborted", now);
    else if (this.phase === "INTRO" || this.phase === "COUNTDOWN") this.startActive(now);
  }

  pendingSummary(now: number): BlockSummary | undefined {
    return this.phase === "ACTIVE" || this.phase === "REST" ? this.summary("aborted", now) : undefined;
  }

  get total() {
    return this.totalReps;
  }
  get blocksDone() {
    return Math.max(0, this.i);
  }

  private go(p: Phase, now: number) {
    this.phase = p;
    this.phaseStart = now;
    this.countdownStep = -1;
  }

  private begin(i: number, now: number) {
    this.i = i;
    const b = this.block;
    if (!b) {
      this.go("DONE", now);
      this.setVideo(null, false);
      this.audio.say(LINE.done, "trainer");
      this.tracer.end("completed", this.totalReps, this.workout.blocks.length, this.avgFps());
      return;
    }
    this.said10 = false;
    this.said3 = false;
    this.events = [];
    this.reps = 0;
    this.fallback = false;
    this.blockStartIso = new Date().toISOString();
    if (b.type === "rest") {
      const nextB = this.workout.blocks[i + 1];
      const nextDef = nextB?.exercise ? EXERCISES[nextB.exercise] : undefined;
      this.setVideo(nextDef?.video ?? null, true);
      this.go("REST", now);
      this.openBlockRun(now);
      this.audio.say(LINE.rest(b, nextB), "trainer");
      return;
    }
    const def = this.def!;
    this.setVideo(def.video, false);
    this.go("INTRO", now);
    this.audio.say(LINE.intro(b), "trainer");
  }

  private startActive(now: number) {
    this.go("ACTIVE", now);
    this.blockStartIso = new Date().toISOString();
    this.openBlockRun(now);
    this.detector = this.def?.detector?.() ?? null;
    this.cues.newBlock();
    this.cueAt = -Infinity;
    this.lastFaults = [];
    this.lastBodyAt = Math.max(this.lastBodyAt, now);
  }

  private openBlockRun(now: number) {
    const b = this.block!;
    this.lastProgressAt = now;
    this.tracer.blockStart({ index: this.i, type: b.type, exercise: b.exercise, mode: b.type === "rest" ? "time" : b.mode!, target_reps: b.target_reps, target_s: b.target_s, cap_s: b.cap_s, start_time: this.blockStartIso });
  }

  private tickActive(now: number, elS: number) {
    const b = this.block!;
    const timed = b.mode === "time" || this.fallback;
    const limit = b.mode === "time" ? b.target_s! : b.cap_s!;
    if (b.mode === "reps" && !this.fallback && now - this.lastBodyAt > TRACKING_LOSS_MS) {
      this.fallback = true;
      this.events.push({ type: "tracking_lost", t: new Date().toISOString(), elapsed_s: Math.round(elS), reps_so_far: this.reps });
      this.audio.say(LINE.lost, "trainer");
    }
    if (timed && !this.said10 && limit - elS <= 10 && limit > 15) {
      this.said10 = true;
      this.audio.say(LINE.tenLeft, "trainer");
    }
    if (b.mode === "reps" && !this.fallback && this.reps >= b.target_reps!) return this.endBlock("target", now);
    if (elS >= limit) return this.endBlock(b.mode === "time" ? "target" : this.fallback ? "fallback" : "cap", now);
  }

  private summary(by: BlockSummary["ended_by"], now: number): BlockSummary {
    const b = this.block!;
    return {
      index: this.i,
      type: b.type,
      exercise: b.exercise,
      mode: b.type === "rest" ? "time" : this.fallback ? "reps→time (fallback)" : b.mode!,
      target_reps: b.target_reps,
      target_s: b.target_s,
      cap_s: b.cap_s,
      actual_reps: this.reps,
      actual_s: Math.round((now - this.phaseStart) / 100) / 10,
      ended_by: by,
      start_time: this.blockStartIso,
      end_time: new Date().toISOString(),
      events: this.events,
    };
  }

  private endBlock(by: BlockSummary["ended_by"], now: number) {
    this.tracer.block(this.summary(by, now));
    this.totalReps += this.reps;
    this.detector = null;
    const b = this.block!;
    if (b.type === "rest") return this.begin(this.i + 1, now);
    this.go("OUTRO", now);
    this.audio.say(LINE.outro(b), "trainer");
  }

  snapshot(at: number): Snapshot {
    const now = this.pausedAt ?? at;
    const b = this.block;
    const el = (now - this.phaseStart) / 1000;
    const f = this.lastFrame?.features ?? null;
    const doneDur = this.workout.blocks.slice(0, Math.max(0, this.i)).reduce((s, x) => s + blockDurS(x), 0);
    let cur = 0;
    let main = "";
    let sub = "";
    if (b && this.phase === "ACTIVE") {
      const limit = b.mode === "time" ? b.target_s! : b.cap_s!;
      cur = Math.min(1, el / limit);
      if (b.mode === "reps" && !this.fallback) {
        main = `${this.reps} / ${b.target_reps}`;
        sub = `${Math.max(0, Math.ceil(limit - el))}s cap`;
        cur = Math.max(cur, this.reps / b.target_reps!);
      } else {
        main = `${Math.max(0, Math.ceil(limit - el))}`;
        sub = b.count_reps || this.fallback ? `${this.reps} reps` : "seconds";
      }
    } else if (b && this.phase === "REST") {
      cur = Math.min(1, el / b.target_s!);
      main = `${Math.max(0, Math.ceil(b.target_s! - el))}`;
      sub = "seconds";
    } else if (b && (this.phase === "INTRO" || this.phase === "COUNTDOWN")) {
      main = b.mode === "reps" ? `0 / ${b.target_reps}` : `${b.target_s}`;
      sub = b.mode === "reps" ? "reps" : "seconds";
    } else if (b && this.phase === "OUTRO") cur = 1;
    return {
      phase: this.phase,
      paused: this.pausedAt !== null,
      blockIndex: this.i,
      title: this.phase === "READY" ? "Get in frame" : this.phase === "DONE" ? "Workout complete" : exName(b),
      main: this.phase === "DONE" ? `${this.totalReps}` : main,
      sub: this.phase === "DONE" ? "total reps" : sub,
      next: exName(this.workout.blocks[this.i + 1]),
      progress: this.phase === "DONE" ? 1 : b ? (doneDur + cur * blockDurS(b)) / this.totalDur : 0,
      countdown: this.phase === "COUNTDOWN" ? Math.max(1, 3 - Math.floor(el)) : null,
      cueActive: now - this.cueAt < CUE_VISUAL_MS,
      bodyReadyPct: this.bodySince === null ? 0 : Math.min(1, (now - this.bodySince) / BODY_READY_MS),
      fallback: this.fallback,
      debug: {
        kneeAvg: f ? Math.round(f.kneeAvg) : null,
        kneeMin: f ? Math.round(f.kneeMin) : null,
        tilt: f ? Math.round(f.torsoTiltDeg) : null,
        detector: this.detector?.state ?? "-",
        faults: this.lastFaults,
        fullBody: this.lastFrame?.fullBody ?? false,
      },
    };
  }
}
