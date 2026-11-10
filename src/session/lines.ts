import { EXERCISES } from "../exercises";
import { CUE_TEXT } from "../pose/formRules";
import type { VoiceKind } from "./audio";
import type { Block, Workout } from "./orchestrator";

export const PRAISE = "That's it, much better";

export const exName = (b?: Block) => (b ? (b.type === "rest" ? "Rest" : EXERCISES[b.exercise!]?.name ?? b.exercise!) : "Finish");

/** Every line the trainer can say. Shared with scripts/gen-voice.ts so each has a pre-recorded clip. */
export const LINE = {
  ready: "Prop your phone up and step back until I can see your whole body",
  go: "Go!",
  threeMore: "3 more",
  tenLeft: "10 seconds left",
  lost: "I lost you for a sec, keep going",
  resume: "Let's keep going",
  done: "That's the whole workout. Amazing job today",
  intro: (b: Block) => {
    const def = EXERCISES[b.exercise!];
    return def.intro ?? `${def.name}, ${b.mode === "reps" ? `${b.target_reps} reps` : `${b.target_s} seconds`}`;
  },
  outro: (b: Block) => EXERCISES[b.exercise!].outro,
  rest: (b: Block, next?: Block) => `Rest, ${b.target_s} seconds. Next up, ${exName(next).toLowerCase()}`,
  restTen: (next?: Block) => `10 seconds. Get ready for ${exName(next).toLowerCase()}`,
};

export function allLines(w: Workout): { text: string; kind: VoiceKind }[] {
  const out = new Map<string, VoiceKind>();
  const add = (text: string, kind: VoiceKind) => out.set(text, kind);
  for (const t of [LINE.ready, LINE.threeMore, LINE.tenLeft, LINE.lost, LINE.resume, LINE.done]) add(t, "trainer");
  add(LINE.go, "countdown");
  for (const t of Object.values(CUE_TEXT)) add(t, "cue");
  add(PRAISE, "encouragement");
  w.blocks.forEach((b, i) => {
    const next = w.blocks[i + 1];
    if (b.type === "rest") {
      add(LINE.rest(b, next), "trainer");
      add(LINE.restTen(next), "trainer");
    } else {
      add(LINE.intro(b), "trainer");
      add(LINE.outro(b), "trainer");
    }
  });
  return [...out].map(([text, kind]) => ({ text, kind }));
}
