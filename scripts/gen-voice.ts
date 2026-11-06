// Pre-records every trainer line with ElevenLabs into public/voice/ (+ manifest.json).
// Run: ELEVEN_LABS_KEY=... npx tsx scripts/gen-voice.ts   (only missing clips are generated)
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import workout from "../src/workouts/full-body-10.json" with { type: "json" };
import { allLines } from "../src/session/lines";
import type { Workout } from "../src/session/orchestrator";

const VOICE_ID = process.env.ELEVEN_VOICE_ID || "SYXbTJsLE7zmSjr1DchT";
const MODEL = "eleven_multilingual_v2";
const DIR = "public/voice";
const key = process.env.ELEVEN_LABS_KEY;
if (!key) throw new Error("ELEVEN_LABS_KEY is not set");

mkdirSync(DIR, { recursive: true });
const manifestPath = `${DIR}/manifest.json`;
const lines: Record<string, string> = {};

for (const { text, kind } of allLines(workout as Workout)) {
  // Cues and praise are calmer and a touch slower, per the gentle-cue spec.
  const calm = kind === "cue" || kind === "encouragement";
  const settings = { stability: calm ? 0.65 : 0.45, similarity_boost: 0.8, style: calm ? 0.1 : 0.35, speed: calm ? 0.95 : 1.0 };
  const file = `${createHash("sha1").update(JSON.stringify([VOICE_ID, MODEL, settings, text])).digest("hex").slice(0, 12)}.mp3`;
  lines[text] = file;
  if (existsSync(`${DIR}/${file}`)) continue;
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_64`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ text, model_id: MODEL, voice_settings: settings }),
  });
  if (!r.ok) throw new Error(`ElevenLabs ${r.status} for "${text}": ${(await r.text()).slice(0, 200)}`);
  writeFileSync(`${DIR}/${file}`, Buffer.from(await r.arrayBuffer()));
  console.log("recorded", file, text);
}

const keep = new Set([...Object.values(lines), "manifest.json"]);
for (const f of readdirSync(DIR)) if (!keep.has(f)) rmSync(`${DIR}/${f}`);
const manifest = JSON.stringify({ voice_id: VOICE_ID, model: MODEL, lines }, null, 2) + "\n";
if (!existsSync(manifestPath) || readFileSync(manifestPath, "utf8") !== manifest) writeFileSync(manifestPath, manifest);
console.log(`${Object.keys(lines).length} lines in ${manifestPath}`);
