import { CUE_TEXT, FAULT_PRIORITY, type Fault } from "../pose/formRules";
import { PRAISE } from "./lines";

export type CueDecision =
  | { kind: "cue"; fault: Fault; text: string; persistence: number }
  | { kind: "resolved"; fault: Fault; text: string }
  | null;

const WINDOW = 3;
const NEEDED = 2;
const MIN_GAP_MS = 15_000;
const RESOLVE_REPS = 2;

/**
 * Gentle cue policy: a fault must appear in 2 of the last 3 reps, max one cue per 15 s,
 * never on the first rep, only the highest-priority fault, praise when a cued fault clears for 2 reps.
 * One policy spans the whole session so the 15 s gap holds across blocks; call newBlock() per block.
 */
export class CuePolicy {
  private history: Fault[][] = [];
  private lastCueAt = -Infinity;
  private active: { fault: Fault; cleanReps: number } | null = null;
  private repCount = 0;

  newBlock() {
    this.history = [];
    this.active = null;
    this.repCount = 0;
  }

  /** Shift the cue clock after a pause so paused time doesn't count toward the gap. */
  shift(ms: number) {
    this.lastCueAt += ms;
  }

  /** Called once per rep while the block is ACTIVE. */
  onRep(faults: Fault[], nowMs: number): CueDecision {
    this.repCount++;
    this.history.push(faults);
    if (this.history.length > WINDOW) this.history.shift();

    if (this.active) {
      if (faults.includes(this.active.fault)) this.active.cleanReps = 0;
      else if (++this.active.cleanReps >= RESOLVE_REPS) {
        const fault = this.active.fault;
        this.active = null;
        return { kind: "resolved", fault, text: PRAISE };
      }
    }

    if (this.repCount < 2 || nowMs - this.lastCueAt < MIN_GAP_MS) return null;
    for (const fault of FAULT_PRIORITY) {
      const persistence = this.history.filter((h) => h.includes(fault)).length;
      if (persistence >= NEEDED) {
        this.lastCueAt = nowMs;
        this.active = { fault, cleanReps: 0 };
        return { kind: "cue", fault, text: CUE_TEXT[fault], persistence };
      }
    }
    return null;
  }
}
