// Score recent workouts in LangSmith and attach the scores as feedback (skips keys already scored).
// Run: LANGSMITH_API_KEY=... npx tsx scripts/evals.ts [--limit 20] [--dry]
import { Client } from "langsmith";
import { evaluateTrace } from "../api/evals";

const args = process.argv.slice(2);
const limit = Number(args[args.indexOf("--limit") + 1]) || 20;
const dry = args.includes("--dry");
const projectName = process.env.LANGSMITH_PROJECT || "ai-trainer";
const client = new Client();

const ids: string[] = [];
for await (const r of client.listRuns({ projectName, isRoot: true, limit })) if (r.name === "workout_session") ids.push(r.id);
for (const id of ids) {
  const res = await evaluateTrace(client, projectName, id, { post: !dry });
  if (!res) continue;
  console.log(`\n${id}  ${new Date(res.root.start_time!).toISOString()}`);
  for (const s of res.scores) console.log(`  ${s.score ? "PASS" : "FAIL"}  ${s.key.padEnd(18)} ${s.comment}`);
}
