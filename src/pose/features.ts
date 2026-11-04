import type { Pt } from "./oneEuro";

export const LM = {
  lShoulder: 11, rShoulder: 12, lWrist: 15, rWrist: 16,
  lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnkle: 27, rAnkle: 28,
} as const;

const BODY = [LM.lShoulder, LM.rShoulder, LM.lHip, LM.rHip, LM.lKnee, LM.rKnee, LM.lAnkle, LM.rAnkle];

export interface PoseFeatures {
  fullBody: boolean;
  kneeL: number;
  kneeR: number;
  kneeAvg: number;
  kneeMin: number;
  kneeDist: number;
  ankleDist: number;
  hipWidth: number;
  hipDiff: number;
  torsoLen: number;
  torsoTiltDeg: number;
  wristsAboveShoulders: boolean;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

export function angleDeg(a: Pt, b: Pt, c: Pt): number {
  const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
  const cos = (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

export function isFullBody(raw: Pt[] | null): boolean {
  if (!raw || raw.length < 33) return false;
  return BODY.every((i) => raw[i].v > 0.5 && raw[i].x >= 0 && raw[i].y >= 0 && raw[i].y <= 1.02);
}

/** `p` must be in pixel space (aspect-correct) so angles are not distorted. */
export function computeFeatures(p: Pt[], fullBody: boolean): PoseFeatures {
  const kneeL = angleDeg(p[LM.lHip], p[LM.lKnee], p[LM.lAnkle]);
  const kneeR = angleDeg(p[LM.rHip], p[LM.rKnee], p[LM.rAnkle]);
  const midSh = { x: (p[LM.lShoulder].x + p[LM.rShoulder].x) / 2, y: (p[LM.lShoulder].y + p[LM.rShoulder].y) / 2, v: 1 };
  const midHip = { x: (p[LM.lHip].x + p[LM.rHip].x) / 2, y: (p[LM.lHip].y + p[LM.rHip].y) / 2, v: 1 };
  const torsoLen = dist(midSh, midHip) || 1;
  const tilt = (Math.atan2(Math.abs(midSh.x - midHip.x), Math.abs(midHip.y - midSh.y)) * 180) / Math.PI;
  return {
    fullBody,
    kneeL,
    kneeR,
    kneeAvg: (kneeL + kneeR) / 2,
    kneeMin: Math.min(kneeL, kneeR),
    kneeDist: Math.abs(p[LM.lKnee].x - p[LM.rKnee].x),
    ankleDist: Math.abs(p[LM.lAnkle].x - p[LM.rAnkle].x),
    hipWidth: Math.abs(p[LM.lHip].x - p[LM.rHip].x) || 1,
    hipDiff: Math.abs(p[LM.lHip].y - p[LM.rHip].y),
    torsoLen,
    torsoTiltDeg: tilt,
    wristsAboveShoulders: p[LM.lWrist].y < p[LM.lShoulder].y && p[LM.rWrist].y < p[LM.rShoulder].y,
  };
}
