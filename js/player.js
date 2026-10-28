// Album player for the web version: <audio> playback + lookup of the precomputed analysis
// (exported by tools/export_web.py). Mirrors AudioAnalyzer's public surface:
// *_energy in [0, 1] and is_*_hit (every onset since the previous update fires).

function decodeEnv(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function anyOnset(times, t0, t1) {
  // first index with times[i] > t0 (binary search), then check it is <= t1
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t0) lo = mid + 1; else hi = mid;
  }
  return lo < times.length && times[lo] <= t1;
}

export class AlbumPlayer {
  constructor(playlist, onTrackChange) {
    this.playlist = playlist;
    this.onTrackChange = onTrackChange;
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.audio.addEventListener("ended", () => this.next());
    this.index = 0;
    this.analysis = null;
    this.cache = new Map();
    this.lastT = -1;
    this.reset();
  }

  reset() {
    this.kick = this.snare = this.hat = this.bass = this.mid = 0;
    this.kickHit = this.snareHit = this.hatHit = false;
  }

  get playing() { return !this.audio.paused; }
  get track() { return this.playlist[this.index]; }
  get duration() { return this.audio.duration || (this.analysis ? this.analysis.duration : 0); }
  get time() { return this.audio.currentTime || 0; }

  async load(index, autoplay = true) {
    this.index = (index + this.playlist.length) % this.playlist.length;
    const track = this.track;
    this.analysis = null;
    this.lastT = -1;
    this.audio.src = track.audio;
    this.onTrackChange?.(track);
    const pending = autoplay ? this.audio.play().catch(() => {}) : null;
    try {
      if (!this.cache.has(track.index)) {
        const a = await (await fetch(track.analysis)).json();
        for (const k of ["kick_env", "snare_env", "hat_env", "bass_env", "mid_env"]) a[k] = decodeEnv(a[k]);
        this.cache.set(track.index, a);
      }
      if (this.track === track) this.analysis = this.cache.get(track.index);
    } catch (e) {
      console.warn("analysis unavailable", e);
    }
    await pending;
  }

  next() { return this.load(this.index + 1); }
  prev() { return this.load(this.index - 1); }
  toggle() { return this.audio.paused ? this.audio.play() : this.audio.pause(); }
  seek(fraction) { if (this.duration) this.audio.currentTime = fraction * this.duration; }
  setVolume(v) { this.audio.volume = Math.min(Math.max(v, 0), 1); }

  /** Reads the analysis at the current playback position (call once per frame). */
  update() {
    this.kickHit = this.snareHit = this.hatHit = false;
    const a = this.analysis;
    if (!a || this.audio.paused) {
      this.kick *= 0.85; this.snare *= 0.85; this.hat *= 0.85; this.bass *= 0.85; this.mid *= 0.85;
      return;
    }
    const t = this.time;
    const f = Math.min(Math.floor(t * a.env_fps), a.kick_env.length - 1);
    this.kick = a.kick_env[f] / 255;
    this.snare = a.snare_env[f] / 255;
    this.hat = a.hat_env[f] / 255;
    this.bass = a.bass_env[f] / 255;
    this.mid = a.mid_env[f] / 255;

    let prev = this.lastT;
    if (prev < 0 || t < prev || t - prev > 0.25) prev = t - 0.1;
    this.kickHit = anyOnset(a.kick_times, prev, t);
    this.snareHit = anyOnset(a.snare_times, prev, t);
    this.hatHit = anyOnset(a.hat_times, prev, t);
    this.lastT = t;
  }
}
