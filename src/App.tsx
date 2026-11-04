import { useEffect, useRef, useState } from "react";
import workoutJson from "./workouts/full-body-10.json";
import { EXERCISES } from "./exercises";
import { createLandmarker, PoseTracker } from "./pose/tracker";
import { AudioEngine } from "./session/audio";
import { Session, type Snapshot, type Workout } from "./session/orchestrator";
import { Tracer } from "./session/trace";
import type { PoseLandmarker } from "@mediapipe/tasks-vision";
import type { Pt } from "./pose/oneEuro";

const workout = workoutJson as Workout;
const DEBUG = new URLSearchParams(location.search).has("debug");
const VIDEO_FILES = [...new Set(workout.blocks.filter((b) => b.exercise).map((b) => EXERCISES[b.exercise!].video))];

const EDGES: [number, number][] = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32],
];

function drawSkeleton(canvas: HTMLCanvasElement, pts: Pt[] | null, color: string) {
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!pts) return;
  const w = canvas.width, h = canvas.height;
  ctx.lineWidth = Math.max(2, w / 120);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  for (const [a, b] of EDGES) {
    if (pts[a].v < 0.4 || pts[b].v < 0.4) continue;
    ctx.beginPath();
    ctx.moveTo(pts[a].x * w, pts[a].y * h);
    ctx.lineTo(pts[b].x * w, pts[b].y * h);
    ctx.stroke();
  }
  for (const i of [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
    if (pts[i].v < 0.4) continue;
    ctx.beginPath();
    ctx.arc(pts[i].x * w, pts[i].y * h, ctx.lineWidth * 1.2, 0, Math.PI * 2);
    ctx.fill();
  }
}

async function preloadVideos(onProgress: (done: number) => void) {
  const urls: Record<string, string | null> = {};
  let done = 0;
  await Promise.all(
    VIDEO_FILES.map(async (f) => {
      try {
        const r = await fetch(`/videos/${f}`);
        if (!r.ok || !(r.headers.get("content-type") ?? "").includes("video")) throw new Error(String(r.status));
        urls[f] = URL.createObjectURL(await r.blob());
      } catch {
        console.warn("missing video", f);
        urls[f] = null;
      }
      onProgress(++done);
    }),
  );
  return urls;
}

export default function App() {
  const [stage, setStage] = useState<"start" | "running">("start");
  const [loaded, setLoaded] = useState(0);
  const [modelReady, setModelReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [fps, setFps] = useState(0);
  const [delegate, setDelegate] = useState("");
  const [video, setVideo] = useState<{ src: string | null; dim: boolean; name: string }>({ src: null, dim: false, name: "" });

  const urlsRef = useRef<Record<string, string | null> | null>(null);
  const landmarkerRef = useRef<PoseLandmarker | null>(null);
  const camRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trainerRef = useRef<HTMLVideoElement>(null);
  const sessionRef = useRef<Session | null>(null);
  const tracerRef = useRef<Tracer | null>(null);
  const trackerRef = useRef<PoseTracker | null>(null);

  useEffect(() => {
    const preload = { cancelled: false };
    preloadVideos(setLoaded).then((u) => {
      if (preload.cancelled) return Object.values(u).forEach((url) => url && URL.revokeObjectURL(url));
      urlsRef.current = u;
    });
    createLandmarker()
      .then(({ landmarker, delegate }) => {
        landmarkerRef.current = landmarker;
        setDelegate(delegate);
        setModelReady(true);
      })
      .catch((e) => setError(`Pose model failed to load: ${e}`));
    return () => {
      preload.cancelled = true;
      setLoaded(0);
    };
  }, []);

  const ready = modelReady && loaded === VIDEO_FILES.length;

  useEffect(() => {
    const v = trainerRef.current;
    if (v && video.src) void v.play().catch(() => undefined);
  }, [video]);

  async function start() {
    const audio = new AudioEngine();
    audio.unlock();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    } catch (e) {
      setError(`Camera access is needed: ${e}`);
      return;
    }
    const cam = camRef.current!;
    cam.srcObject = stream;
    await cam.play();
    // Prime the trainer <video> inside the gesture so later src swaps can autoplay.
    void trainerRef.current?.play().catch(() => undefined);

    let wake: WakeLockSentinel | null = null;
    let released = false;
    const lock = async () => {
      try {
        wake = await navigator.wakeLock?.request("screen");
      } catch {
        /* unsupported */
      }
    };
    void lock();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !released && (!wake || wake.released)) void lock();
    });

    const tracer = new Tracer(workout.id);
    tracerRef.current = tracer;
    const tracker = new PoseTracker(landmarkerRef.current!);
    trackerRef.current = tracker;
    const session = new Session(workout, audio, tracer, (file, dim) => {
      const name = Object.values(EXERCISES).find((e) => e.video === file)?.name ?? "";
      setVideo({ src: file ? urlsRef.current?.[file] ?? null : null, dim, name });
    });
    session.avgFps = () => tracker.avgFps;
    sessionRef.current = session;
    const release = () => {
      released = true;
      stream.getTracks().forEach((t) => t.stop());
      cam.srcObject = null;
      void wake?.release().catch(() => undefined);
      wake = null;
      audio.close();
    };
    window.addEventListener("pagehide", () => {
      const now = performance.now();
      if (session.phase !== "DONE" && session.phase !== "READY")
        tracer.end(false, session.total, session.blocksDone, tracker.avgFps, session.pendingSummary(now), true);
      release();
    });
    setStage("running");

    let lastUi = 0;
    const loop = () => {
      const now = performance.now();
      const frame = tracker.process(cam, now);
      if (frame) {
        session.onPose(frame);
        const c = canvasRef.current;
        if (c) {
          if (c.width !== cam.videoWidth) {
            c.width = cam.videoWidth;
            c.height = cam.videoHeight;
          }
          const s = session.snapshot(now);
          drawSkeleton(c, frame.norm, !frame.fullBody ? "#9ca3af" : s.cueActive ? "#f59e0b" : "#22c55e");
        }
      }
      session.tick(now);
      if (now - lastUi > 100) {
        lastUi = now;
        setSnap(session.snapshot(now));
        setFps(tracker.fps);
      }
      if (session.phase !== "DONE") requestAnimationFrame(loop);
      else {
        setSnap(session.snapshot(now));
        release();
      }
    };
    requestAnimationFrame(loop);
  }

  function downloadEvents() {
    const blob = new Blob([JSON.stringify(tracerRef.current?.log ?? [], null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `session-${tracerRef.current?.sessionId ?? "none"}.json`;
    a.click();
  }

  const s = snap;
  return (
    <div className="app">
      <div className={`trainer ${video.dim ? "dim" : ""}`}>
        <video ref={trainerRef} src={video.src ?? undefined} playsInline muted loop autoPlay preload="auto" />
        {stage === "running" && !video.src && s?.phase !== "READY" && <div className="placeholder">{video.name || s?.title}</div>}
      </div>

      <div className={`pip ${stage === "running" ? "" : "hidden"} ${s?.cueActive ? "amber" : ""}`}>
        <div className="mirror">
          <video ref={camRef} playsInline muted autoPlay />
          <canvas ref={canvasRef} />
        </div>
      </div>

      {stage === "start" && (
        <div className="start">
          <h1>AI Trainer</h1>
          <p className="lead">10-minute full-body workout</p>
          <p>Prop your phone up, step back until your whole body is in frame.</p>
          <button disabled={!ready} onClick={start}>
            {ready ? "Start workout" : `Loading… ${loaded}/${VIDEO_FILES.length} videos${modelReady ? "" : ", pose model"}`}
          </button>
          {error && <p className="error">{error}</p>}
        </div>
      )}

      {stage === "running" && s && s.phase === "READY" && (
        <div className="ready">
          <p>Prop your phone up, step back until your whole body is in frame.</p>
          <div className="bar"><div style={{ width: `${s.bodyReadyPct * 100}%` }} /></div>
          <p className="small">{s.debug.fullBody ? "Got you — hold still…" : "Looking for your whole body (head to ankles)…"}</p>
        </div>
      )}

      {stage === "running" && s && s.countdown !== null && <div className="countdown">{s.countdown}</div>}
      {stage === "running" && s && s.phase === "REST" && <div className="restTag">REST</div>}

      {stage === "running" && s && s.phase !== "READY" && (
        <div className="hud">
          <div className="row">
            <div>
              <div className="title">{s.title}</div>
              <div className="next">{s.phase === "DONE" ? "Nice work today" : `Next: ${s.next}`}</div>
            </div>
            <div className="big">
              {s.main}
              <span>{s.sub}</span>
            </div>
          </div>
          <div className="bar"><div style={{ width: `${s.progress * 100}%` }} /></div>
        </div>
      )}

      {DEBUG && stage === "running" && s && (
        <div className="debug">
          <div>fps {fps} ({delegate})</div>
          <div>phase {s.phase} · block {s.blockIndex}</div>
          <div>knee avg {s.debug.kneeAvg ?? "-"}° · min {s.debug.kneeMin ?? "-"}°</div>
          <div>tilt {s.debug.tilt ?? "-"}° · body {s.debug.fullBody ? "yes" : "no"}</div>
          <div>detector {s.debug.detector}{s.fallback ? " · FALLBACK" : ""}</div>
          <div>faults {s.debug.faults.join(", ") || "none"}</div>
          <button onClick={downloadEvents}>Download events</button>
          <button onClick={() => sessionRef.current?.skip(performance.now())}>Skip</button>
        </div>
      )}
    </div>
  );
}
