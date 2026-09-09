// ── A soft ping ───────────────────────────────────────────────────────────────
// Two short sine notes, synthesised on the spot. No audio file to fetch, and
// nothing to fail to load on a slow connection — the sound is what tells the
// owner a delivery was just filed while they are looking at something else.
//
// Browsers refuse to play audio until the page has had a real click, so the
// first ping after a fresh load can be silent; the toast still shows.

let ctx: AudioContext | null = null;

export function ping() {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();

    const at = ctx.currentTime;
    for (const [freq, start] of [[880, 0], [1320, 0.09]] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at + start);
      gain.gain.exponentialRampToValueAtTime(0.12, at + start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + start + 0.28);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at + start);
      osc.stop(at + start + 0.3);
    }
  } catch {
    // No audio device, or autoplay blocked — the toast is enough.
  }
}
