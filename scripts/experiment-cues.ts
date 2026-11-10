// Scores the gentle cue policy against the ai-trainer-cue-policy dataset as a LangSmith experiment.
// Expected cues are written by hand from the spec (2-of-3 persistence, 15 s gap, never rep 1, priority, praise after 2 clean reps).
// Run: LANGSMITH_API_KEY=... npx tsx scripts/experiment-cues.ts [--offline]
import { Client } from "langsmith";
import { evaluate } from "langsmith/evaluation";
import type { Fault } from "../src/pose/formRules";
import { CuePolicy } from "../src/session/cuePolicy";

const DATASET = "ai-trainer-cue-policy";
type Rep = { t_s: number; faults: Fault[] };
type Out = { rep: number; kind: "cue" | "resolved"; fault: Fault };
type Case = { name: string; reps: Rep[]; expected: Out[] };

const every = (n: number, faults: (i: number) => Fault[], gap = 2.5): Rep[] => Array.from({ length: n }, (_, i) => ({ t_s: (i + 1) * gap, faults: faults(i + 1) }));
const cue = (rep: number, fault: Fault): Out => ({ rep, kind: "cue", fault });
const praise = (rep: number, fault: Fault): Out => ({ rep, kind: "resolved", fault });

const CASES: Case[] = [
  { name: "clean set", reps: every(12, () => []), expected: [] },
  { name: "fault on rep 1 only", reps: every(6, (i) => (i === 1 ? ["depth"] : [])), expected: [] },
  { name: "persistent shallow, re-cued after 15 s", reps: every(12, () => ["depth"]), expected: [cue(2, "depth"), cue(8, "depth")] },
  { name: "2 of 3 persistence", reps: every(5, (i) => (i === 1 || i === 3 ? ["uneven"] : [])), expected: [cue(3, "uneven"), praise(5, "uneven")] },
  { name: "1 of 3 never cues", reps: every(9, (i) => (i % 3 === 0 ? ["depth"] : [])), expected: [] },
  { name: "priority: knees over depth", reps: every(3, () => ["depth", "knees_caving"]), expected: [cue(2, "knees_caving")] },
  { name: "priority: depth over balance", reps: every(3, () => ["balance", "depth"]), expected: [cue(2, "depth")] },
  { name: "praise after 2 clean reps", reps: every(6, (i) => (i <= 4 ? ["depth"] : [])), expected: [cue(2, "depth"), praise(6, "depth")] },
  { name: "relapse resets praise", reps: every(7, (i) => (i <= 2 || i === 4 ? ["depth"] : [])), expected: [cue(2, "depth"), praise(6, "depth")] },
  { name: "slow reps: gap respected", reps: every(6, () => ["balance"], 6), expected: [cue(2, "balance"), cue(5, "balance")] },
  { name: "second fault waits for gap", reps: every(9, (i) => (i <= 3 ? ["depth"] : ["uneven"])), expected: [cue(2, "depth"), praise(5, "depth"), cue(8, "uneven")] },
];

function target({ reps }: { reps: Rep[] }): { cues: Out[] } {
  const p = new CuePolicy();
  const cues: Out[] = [];
  reps.forEach((r, i) => {
    const d = p.onRep(r.faults, r.t_s * 1000);
    if (d) cues.push({ rep: i + 1, kind: d.kind, fault: d.fault });
  });
  return { cues };
}

const key = (o: Out) => `${o.rep}:${o.kind}:${o.fault}`;
const exactMatch = ({ outputs, referenceOutputs }: { outputs?: Record<string, any>; referenceOutputs?: Record<string, any> }) => ({
  key: "cues_exact_match",
  score: JSON.stringify((outputs?.cues ?? []).map(key)) === JSON.stringify((referenceOutputs?.expected ?? []).map(key)) ? 1 : 0,
});
const noFalseCues = ({ outputs, referenceOutputs }: { outputs?: Record<string, any>; referenceOutputs?: Record<string, any> }) => {
  const want = new Set((referenceOutputs?.expected ?? []).map(key));
  return { key: "no_unexpected_cues", score: (outputs?.cues ?? []).every((o: Out) => want.has(key(o))) ? 1 : 0 };
};

if (process.argv.includes("--offline")) {
  let bad = 0;
  for (const c of CASES) {
    const got = target(c).cues.map(key), want = c.expected.map(key);
    if (JSON.stringify(got) === JSON.stringify(want)) continue;
    bad++;
    console.error(`FAIL ${c.name}: got ${got} want ${want}`);
  }
  if (bad) process.exit(1);
  console.log(`cue policy ok: ${CASES.length} dataset cases match`);
} else {
  const client = new Client();
  const ds = await client.readDataset({ datasetName: DATASET }).catch(() =>
    client.createDataset(DATASET, { description: "Rep fault sequences with the cues the spec says should fire. Scored by scripts/experiment-cues.ts." }),
  );
  const have = new Set<string>();
  for await (const ex of client.listExamples({ datasetId: ds.id })) have.add(String(ex.metadata?.case));
  const missing = CASES.filter((c) => !have.has(c.name));
  if (missing.length)
    await client.createExamples(missing.map((c) => ({ dataset_id: ds.id, inputs: { reps: c.reps }, reference_outputs: { expected: c.expected }, metadata: { case: c.name } })));
  console.log(`dataset ${DATASET}: ${have.size + missing.length} examples (${missing.length} added)`);
  const res = await evaluate(target, { data: DATASET, evaluators: [exactMatch, noFalseCues], experimentPrefix: "cue-policy", client });
  let pass = 0, n = 0;
  for (const r of res.results) {
    n++;
    if (r.evaluationResults.results.every((e) => e.score === 1)) pass++;
  }
  console.log(`experiment ${res.experimentName}: ${pass}/${n} examples pass`);
}
