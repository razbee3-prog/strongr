// Offline check of the squat detector + gentle cue policy on synthetic knee-angle traces.
// Run: npx tsx scripts/sim.ts
import { squatDetector } from "../src/pose/detectors";
import type { PoseFeatures } from "../src/pose/features";
import { squatRules } from "../src/pose/formRules";
import { CuePolicy } from "../src/session/cuePolicy";

const base: PoseFeatures = { fullBody: true, kneeL: 175, kneeR: 175, kneeAvg: 175, kneeMin: 175, kneeDist: 100, ankleDist: 100, hipWidth: 80, hipDiff: 2, torsoLen: 200, torsoTiltDeg: 3, wristsAboveShoulders: false };

function run(name: string, bottoms: number[], repS = 2.5, noise = 3) {
  const det = squatDetector();
  const cues = new CuePolicy();
  const fps = 30;
  let t = 0;
  let reps = 0;
  const log: string[] = [];
  for (let i = 0; i < fps; i++) det.update(base, (t += 1 / fps)); // stand
  for (const bottom of bottoms) {
    const n = Math.round(repS * fps);
    for (let i = 0; i < n; i++) {
      const phase = i / n;
      const a = 175 - (175 - bottom) * Math.sin(Math.PI * phase) + (Math.random() - 0.5) * 2 * noise;
      const rep = det.update({ ...base, kneeAvg: a, kneeL: a, kneeR: a, kneeMin: a }, (t += 1 / fps));
      if (rep) {
        reps++;
        const d = cues.onRep(squatRules(rep), t * 1000);
        if (d) log.push(`rep ${reps} @${t.toFixed(1)}s: ${d.kind} ${d.text}`);
      }
    }
  }
  console.log(`${name}: counted ${reps}/${bottoms.length}`, log);
}

run("12 good squats", Array(12).fill(85));
run("12 good squats, fast 1.2s", Array(12).fill(85), 1.2);
run("12 shallow squats", Array(12).fill(120));
run("shallow x4 then good", [120, 120, 120, 120, 85, 85, 85, 85]);
run("jitter only (no reps)", Array(10).fill(170), 2.5, 6);
