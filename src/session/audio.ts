export type VoiceKind = "countdown" | "trainer" | "cue" | "encouragement";

const PRIORITY: Record<VoiceKind, number> = { countdown: 0, trainer: 1, cue: 2, encouragement: 3 };
const STALE_MS = 3000;

interface Item {
  text: string;
  kind: VoiceKind;
  createdAt: number;
  onStart?: () => void;
}

/** Single priority queue so voices never overlap; Web Audio beeps duck while a cue plays. */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private queue: Item[] = [];
  private current: Item | null = null;
  private watchdog: number | undefined;
  private voice: SpeechSynthesisVoice | null = null;
  speaking = false;

  /** Must be called from a user gesture (iOS). */
  unlock() {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    void this.ctx.resume();
    const buf = this.ctx.createBuffer(1, 1, 22050);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.master);
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

  beep(freq = 880, durS = 0.15) {
    if (!this.ctx || !this.master) return;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.frequency.value = freq;
    const t = this.ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + durS);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + durS + 0.02);
  }

  say(text: string, kind: VoiceKind, onStart?: () => void) {
    const item = { text, kind, createdAt: performance.now(), onStart };
    // Higher-priority speech interrupts lower-priority speech.
    if (this.current && PRIORITY[kind] < PRIORITY[this.current.kind] && PRIORITY[this.current.kind] >= PRIORITY.cue) {
      this.queue.push(item);
      speechSynthesis.cancel();
      this.finish();
      return;
    }
    this.queue.push(item);
    this.pump();
  }

  clear() {
    this.queue = [];
    speechSynthesis.cancel();
    this.finish();
  }

  private duck(on: boolean) {
    if (!this.master || !this.ctx) return;
    this.master.gain.setTargetAtTime(on ? 0.25 : 1, this.ctx.currentTime, 0.05);
  }

  private pump() {
    if (this.current) return;
    const now = performance.now();
    this.queue = this.queue.filter((i) => PRIORITY[i.kind] < PRIORITY.cue || now - i.createdAt <= STALE_MS);
    if (!this.queue.length) return;
    this.queue.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.createdAt - b.createdAt);
    const item = this.queue.shift()!;
    this.current = item;
    this.speaking = true;
    const u = new SpeechSynthesisUtterance(item.text);
    if (this.voice) u.voice = this.voice;
    u.lang = "en-US";
    u.rate = item.kind === "cue" || item.kind === "encouragement" ? 0.95 : 1.0;
    u.pitch = 1;
    if (item.kind === "cue") this.duck(true);
    u.onend = () => this.current === item && this.finish();
    u.onerror = () => this.current === item && this.finish();
    item.onStart?.();
    speechSynthesis.speak(u);
    // iOS sometimes never fires onend.
    this.watchdog = window.setTimeout(() => this.current === item && this.finish(), 1500 + item.text.length * 90);
  }

  private finish() {
    window.clearTimeout(this.watchdog);
    if (this.current?.kind === "cue") this.duck(false);
    this.current = null;
    this.speaking = false;
    queueMicrotask(() => this.pump());
  }
}
