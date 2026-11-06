import type { Rep } from "./detectors";

export type Fault = "knees_caving" | "depth" | "uneven" | "balance";

/** Highest priority first. */
export const FAULT_PRIORITY: Fault[] = ["knees_caving", "depth", "uneven", "balance"];

export const CUE_TEXT: Record<Fault, string> = {
  knees_caving: "Push your knees out over your toes",
  depth: "Try sinking a little deeper",
  uneven: "Keep your hips level",
  balance: "Stay tall through your chest",
};

export type RuleSet = (rep: Rep) => Fault[];

export const squatRules: RuleSet = (rep) => {
  const out: Fault[] = [];
  const b = rep.bottom;
  if (b.kneeDist < 0.8 * b.ankleDist) out.push("knees_caving");
  if (rep.minKnee > 110) out.push("depth");
  if (b.hipDiff > 0.08 * b.torsoLen) out.push("uneven");
  return out;
};

export const lungeRules: RuleSet = (rep) => (rep.maxTilt > 15 ? ["balance"] : []);
