import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import { computeFeatures, isFullBody, type PoseFeatures } from "./features";
import { LandmarkSmoother, type Pt } from "./oneEuro";

export interface PoseFrame {
  tMs: number;
  /** Smoothed landmarks, normalized 0..1 (for drawing). */
  norm: Pt[] | null;
  fullBody: boolean;
  features: PoseFeatures | null;
}

export async function createLandmarker(): Promise<{ landmarker: PoseLandmarker; delegate: "GPU" | "CPU" }> {
  const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
  const make = (delegate: "GPU" | "CPU") =>
    PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: "/models/pose_landmarker_lite.task", delegate },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  try {
    return { landmarker: await make("GPU"), delegate: "GPU" };
  } catch (e) {
    console.warn("GPU delegate failed, falling back to CPU", e);
    return { landmarker: await make("CPU"), delegate: "CPU" };
  }
}

export class PoseTracker {
  private smoother = new LandmarkSmoother();
  private lastVideoTime = -1;
  private frameTimes: number[] = [];
  private fpsSum = 0;
  private fpsN = 0;
  fps = 0;
  private landmarker: PoseLandmarker;

  constructor(landmarker: PoseLandmarker) {
    this.landmarker = landmarker;
  }

  get avgFps() {
    return this.fpsN ? Math.round((this.fpsSum / this.fpsN) * 10) / 10 : 0;
  }

  /** Returns null when the camera has no new frame. */
  process(video: HTMLVideoElement, nowMs: number): PoseFrame | null {
    if (video.readyState < 2 || video.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = video.currentTime;
    const res = this.landmarker.detectForVideo(video, nowMs);
    this.frameTimes.push(nowMs);
    while (this.frameTimes.length && nowMs - this.frameTimes[0] > 1000) this.frameTimes.shift();
    this.fps = this.frameTimes.length;
    if (this.frameTimes.length > 5) {
      this.fpsSum += this.fps;
      this.fpsN++;
    }
    const lm = res.landmarks[0];
    if (!lm) {
      this.smoother.reset();
      return { tMs: nowMs, norm: null, fullBody: false, features: null };
    }
    const w = video.videoWidth || 1;
    const h = video.videoHeight || 1;
    const raw: Pt[] = lm.map((p) => ({ x: p.x, y: p.y, v: p.visibility ?? 1 }));
    const px = this.smoother.smooth(raw.map((p) => ({ x: p.x * w, y: p.y * h, v: p.v })), nowMs / 1000);
    const fullBody = isFullBody(raw);
    return {
      tMs: nowMs,
      norm: px.map((p) => ({ x: p.x / w, y: p.y / h, v: p.v })),
      fullBody,
      features: computeFeatures(px, fullBody),
    };
  }
}
