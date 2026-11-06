import type { PoseFeatures } from "./features";

export interface Rep {
  t: number;
  /** Lowest knee angle (deg) seen during the rep. */
  minKnee: number;
  /** Features at the deepest point of the rep. */
  bottom: PoseFeatures;
  /** Largest torso tilt from vertical during the rep. */
  maxTilt: number;
}

export interface RepDetector {
  state: string;
  update(f: PoseFeatures, tSec: number): Rep | null;
  reset(): void;
}

const MIN_REP_S = 0.6;

/** UP → DOWN → UP on a knee-angle signal with hysteresis. */
class KneeAngleDetector implements RepDetector {
  state = "WAIT";
  private lastRepT = -Infinity;
  private minKnee = Infinity;
  private bottom: PoseFeatures | null = null;
  private maxTilt = 0;
  private signal: (f: PoseFeatures) => number;
  private downDeg: number;
  private upDeg: number;

  constructor(signal: (f: PoseFeatures) => number, downDeg: number, upDeg: number) {
    this.signal = signal;
    this.downDeg = downDeg;
    this.upDeg = upDeg;
  }

  update(f: PoseFeatures, t: number): Rep | null {
    const a = this.signal(f);
    if (this.state === "WAIT") {
      if (a > this.upDeg) this.state = "UP";
      return null;
    }
    if (this.state === "UP") {
      if (a < this.downDeg) {
        this.state = "DOWN";
        this.minKnee = a;
        this.bottom = f;
        this.maxTilt = f.torsoTiltDeg;
      }
      return null;
    }
    // DOWN
    if (a < this.minKnee) {
      this.minKnee = a;
      this.bottom = f;
    }
    this.maxTilt = Math.max(this.maxTilt, f.torsoTiltDeg);
    if (a > this.upDeg) {
      this.state = "UP";
      if (t - this.lastRepT < MIN_REP_S || !this.bottom) return null;
      this.lastRepT = t;
      return { t, minKnee: this.minKnee, bottom: this.bottom, maxTilt: this.maxTilt };
    }
    return null;
  }

  reset() {
    this.state = "WAIT";
    this.lastRepT = -Infinity;
  }
}

/**
 * Squat: average knee angle. The spec's full-depth bar is < 100°; we enter DOWN at < 135°
 * so shallow squats still count as reps and can be flagged by the depth rule (> 110°).
 */
export const SQUAT_DOWN_DEG = 135;
export const SQUAT_UP_DEG = 160;
export const squatDetector = () => new KneeAngleDetector((f) => f.kneeAvg, SQUAT_DOWN_DEG, SQUAT_UP_DEG);

/** Reverse lunge: the front (most bent) knee crosses below 105° and returns above 155°. */
export const lungeDetector = () => new KneeAngleDetector((f) => f.kneeMin, 105, 155);

/** Jumping jacks: wrists above shoulders AND ankles > 1.5× hip width, then back. */
class JackDetector implements RepDetector {
  state = "WAIT";
  private lastRepT = -Infinity;
  private bottom: PoseFeatures | null = null;

  update(f: PoseFeatures, t: number): Rep | null {
    const open = f.wristsAboveShoulders && f.ankleDist > 1.5 * f.hipWidth;
    const closed = !f.wristsAboveShoulders && f.ankleDist < 1.2 * f.hipWidth;
    if (this.state === "WAIT" || this.state === "CLOSED") {
      if (closed) this.state = "CLOSED";
      if (this.state === "CLOSED" && open) {
        this.state = "OPEN";
        this.bottom = f;
      }
      return null;
    }
    if (closed) {
      this.state = "CLOSED";
      if (t - this.lastRepT < MIN_REP_S || !this.bottom) return null;
      this.lastRepT = t;
      return { t, minKnee: f.kneeAvg, bottom: this.bottom, maxTilt: f.torsoTiltDeg };
    }
    return null;
  }

  reset() {
    this.state = "WAIT";
    this.lastRepT = -Infinity;
  }
}

export const jackDetector = () => new JackDetector();
