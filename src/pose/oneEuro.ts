class LowPass {
  private y: number | null = null;
  filter(x: number, alpha: number): number {
    this.y = this.y === null ? x : alpha * x + (1 - alpha) * this.y;
    return this.y;
  }
  last(): number | null {
    return this.y;
  }
}

const alphaFor = (cutoff: number, dt: number) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

export class OneEuroFilter {
  private x = new LowPass();
  private dx = new LowPass();
  private lastT: number | null = null;
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;

  constructor(minCutoff = 1.2, beta = 0.4, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  filter(value: number, tSec: number): number {
    const prev = this.x.last();
    const dt = this.lastT === null ? 1 / 30 : Math.max(1e-3, tSec - this.lastT);
    this.lastT = tSec;
    const deriv = prev === null ? 0 : (value - prev) / dt;
    const edx = this.dx.filter(deriv, alphaFor(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.x.filter(value, alphaFor(cutoff, dt));
  }
}

export interface Pt {
  x: number;
  y: number;
  v: number;
}

/** One Euro filter over every landmark's x/y (pixel space). */
export class LandmarkSmoother {
  private fx: OneEuroFilter[] = [];
  private fy: OneEuroFilter[] = [];

  smooth(points: Pt[], tSec: number): Pt[] {
    return points.map((p, i) => {
      if (!this.fx[i]) {
        this.fx[i] = new OneEuroFilter();
        this.fy[i] = new OneEuroFilter();
      }
      return { x: this.fx[i].filter(p.x, tSec), y: this.fy[i].filter(p.y, tSec), v: p.v };
    });
  }

  reset() {
    this.fx = [];
    this.fy = [];
  }
}
