import { jackDetector, lungeDetector, squatDetector, type RepDetector } from "./pose/detectors";
import { lungeRules, squatRules, type RuleSet } from "./pose/formRules";

export interface ExerciseDef {
  name: string;
  /** File in /public/videos/. */
  video: string;
  /** Optional custom intro line; default is generated from the block target. */
  intro?: string;
  outro: string;
  detector?: () => RepDetector;
  rules?: RuleSet;
}

export const EXERCISES: Record<string, ExerciseDef> = {
  march_arm_circles: { name: "March + Arm Circles", video: "march_arm_circles.mp4", outro: "Nice warm up" },
  jumping_jacks: { name: "Jumping Jacks", video: "jumping_jacks.mp4", outro: "Nice work", detector: jackDetector },
  squat: { name: "Squats", video: "squat.mp4", outro: "Nice work", detector: squatDetector, rules: squatRules },
  reverse_lunge: { name: "Reverse Lunges", video: "reverse_lunge.mp4", outro: "Great job", detector: lungeDetector, rules: lungeRules },
  high_knees: { name: "High Knees", video: "high_knees.mp4", outro: "Nice work" },
  stretch: { name: "Stretch", video: "stretch.mp4", intro: "Time to stretch, 90 seconds. Breathe slow", outro: "All done. Great workout" },
};
