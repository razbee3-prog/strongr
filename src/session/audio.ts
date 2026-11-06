export type VoiceKind = "countdown" | "trainer" | "cue" | "encouragement";

const PRIORITY: Record<VoiceKind, number> = { countdown: 0, trainer: 1, cue: 2, encouragement: 3 };
const STALE_MS = 3000;

interface Item {
  text: string;
  kind: VoiceKind;
  createdAt: number;
  onStart?: () => void;
}

/**
 * Single priority queue so voices never overlap. Lines play from pre-recorded trainer clips
 * (public/voice) and fall back to speechSynthesis for any line without a clip. Beeps duck while a cue plays.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private fx: GainNode | null = null;
  private voiceOut: GainNode | null = null;
  private clips = new Map<string, AudioBuffer>();
  private loading: Promise<unknown> | null = null;
  private queue: Item[] = [];
  private current: Item | null = null;
  private src: AudioBufferSourceNode | null = null;
  private watchdog: number | undefined;
  private voice: SpeechSynthesisVoice | null = null;
  speaking = false;

  /** Must be called from a user gesture (iOS). */
  unlock() {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctx();
    this.fx = this.ctx.createGain();
    this.fx.connect(this.ctx.destination);
    this.voiceOut = this.ctx.createGain();
    this.voiceOut.connect(this.ctx.destination);
    void this.ctx.resume();
    const buf = this.ctx.createBuffer(1, 1, 22050);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.fx);
    src.start(0);
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    speechSynthesis.speak(u);
    const pick = () => {
      const voices = speechSynthesis.getVoices();
      this.voice =
        voices.find((v) => /Samantha|Ava|Allison|Google US English/.test(v.name)) ??
        voices.find((v) => v.lang.startsWith("en")) ??
        null;
    };
    pick();
    speechSynthesis.addEventListener?.("voiceschanged", pick);
  }

  /** Decode pre-fetched trainer clips (text → mp3 bytes). Speech waits for this to finish. */
  load(raw: Record<string, ArrayBuffer>) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.loading = Promise.all(
      Object.entries(raw).map(async ([text, bytes]) => {
        try {
          this.clips.set(text, await ctx.decodeAudioData(bytes.slice(0)));
        } catch {
          /* fall back to speechSynthesis for this line */
        }
      }),
    ).finally(() => {
      this.loading = null;
      this.pump();
    });
  }

  pause() {
    window.clearTimeout(this.watchdog);
    void this.ctx?.suspend();
    speechSynthesis.pause();
  }

  resume() {
    void this.ctx?.resume();
    speechSynthesis.resume();
    const item = this.current;
    if (item && !this.src) this.watchdog = window.setTimeout(() => this.current === item && this.finish(), 1500 + item.text.length * 90);
  }

  close() {
    window.setTimeout(() => {
      speechSynthesis.cancel();
      void this.ctx?.close();
    }, 4000);
  }

  beep(freq = 880, durS = 0.15) {
    if (!this.ctx || !this.fx) return;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.frequency.value = freq;
    const t = this.ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + durS);
    osc.connect(g).connect(this.fx);
    osc.start(t);
    osc.stop(t + durS + 0.02);
  }

  say(text: string, kind: VoiceKind, onStart?: () => void) {
    const item = { text, kind, createdAt: performance.now(), onStart };
    this.queue.push(item);
    // Higher-priority speech interrupts a cue or encouragement.
    if (this.current && PRIORITY[kind] < PRIORITY[this.current.kind] && PRIORITY[this.current.kind] >= PRIORITY.cue) {
      this.stopCurrent();
      return;
    }
    this.pump();
  }

  clear() {
    this.queue = [];
    this.stopCurrent();
  }

  private stopCurrent() {
    const src = this.src;
    this.src = null;
    try {
      src?.stop();
    } catch {
      /* already stopped */
    }
    speechSynthesis.cancel();
    this.finish();
  }

  private duck(on: boolean) {
    if (!this.fx || !this.ctx) return;
    this.fx.gain.setTargetAtTime(on ? 0.25 : 1, this.ctx.currentTime, 0.05);
  }

  private pump() {
    if (this.current || this.loading) return;
    const now = performance.now();
    this.queue = this.queue.filter((i) => PRIORITY[i.kind] < PRIORITY.cue || now - i.createdAt <= STALE_MS);
    if (!this.queue.length) return;
    this.queue.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.createdAt - b.createdAt);
    const item = this.queue.shift()!;
    this.current = item;
    this.speaking = true;
    if (item.kind === "cue") this.duck(true);
    item.onStart?.();
    const clip = this.clips.get(item.text);
    if (clip && this.ctx && this.voiceOut) {
      const src = this.ctx.createBufferSource();
      src.buffer = clip;
      src.connect(this.voiceOut);
      src.onended = () => this.src === src && this.current === item && this.finish();
      this.src = src;
      src.start();
      return;
    }
    const u = new SpeechSynthesisUtterance(item.text);
    if (this.voice) u.voice = this.voice;
    u.lang = "en-US";
    u.rate = item.kind === "cue" || item.kind === "encouragement" ? 0.95 : 1.0;
    u.onend = () => this.current === item && this.finish();
    u.onerror = () => this.current === item && this.finish();
    speechSynthesis.speak(u);
    // iOS sometimes never fires onend.
    this.watchdog = window.setTimeout(() => this.current === item && this.finish(), 1500 + item.text.length * 90);
  }

  private finish() {
    window.clearTimeout(this.watchdog);
    if (this.current?.kind === "cue") this.duck(false);
    this.current = null;
    this.src = null;
    this.speaking = false;
    queueMicrotask(() => this.pump());
  }
}
