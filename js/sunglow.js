// Port of effects/sun_glow.py: always-on natural light of the setting sun.
// Breathing density, swaying/flickering rays and an outward shimmer around the sun.

const SUN_U = 0.995, SUN_V = 0.34;
const CORE_RADIUS = 0.11, HALO_RADIUS = 0.3, RAY_REACH = 0.75, HORIZON_V = 0.455;
const CORE_LIGHT = [70, 14, 10], HALO_LIGHT = [26, 4, 3], RAY_LIGHT = [85, 12, 9];
const RAY_WIDTH = 0.038, RAY_SWAY = 0.07;

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SunGlow {
  constructor() {
    this.time = 0;
    this.key = null;
    const rnd = mulberry32(1995);
    const n = 9;
    this.rays = Array.from({ length: n }, (_, k) => ({
      angle: -1.15 + (1.37 * k) / (n - 1) + (rnd() - 0.5) * 0.08,
      swayF: 0.05 + rnd() * 0.08,
      flickF: 0.12 + rnd() * 0.23,
      p0: rnd() * Math.PI * 2,
      p1: rnd() * Math.PI * 2,
      width: RAY_WIDTH * (0.7 + rnd() * 0.7),
    }));
  }

  update(dt) { this.time += dt; }

  intensity() {
    const t = this.time, TAU = Math.PI * 2;
    const swell = 0.5 + 0.5 * Math.sin((TAU * t) / 11.3);
    const drift = 0.5 + 0.5 * Math.sin((TAU * t) / 4.7 + 1.9);
    const haze = 0.5 + 0.5 * Math.sin((TAU * t) / 2.3 + 0.4) * Math.sin((TAU * t) / 6.1);
    return 0.15 + 0.85 * (0.55 * swell + 0.3 * drift + 0.15 * haze);
  }

  _fields(w, h) {
    const key = `${w}x${h}`;
    if (key === this.key) return;
    const sel = [], d = [], phi = [], core = [], halo = [], prof = [];
    for (let y = 0; y < h; y++) {
      const v = (y + 0.5) / h;
      for (let x = 0; x < w; x++) {
        const u = (x + 0.5) / w;
        const du = u - SUN_U, dv = v - SUN_V;
        const dd = Math.hypot(du, dv);
        const below = Math.min(Math.max((v - HORIZON_V) / 0.08, 0), 1);
        const hl = Math.exp(-((dd / HALO_RADIUS) ** 2)) * (1 - 0.5 * below);
        if (!(hl > 0.01 || (dd < RAY_REACH && v < HORIZON_V + 0.02))) continue;
        sel.push(y * w + x);
        d.push(dd);
        phi.push(Math.atan2(dv, -du));
        core.push(Math.exp(-((dd / CORE_RADIUS) ** 2)) * (1 - 0.6 * below));
        halo.push(hl);
        const sky = Math.min(Math.max((HORIZON_V + 0.02 - v) / 0.04, 0), 1);
        prof.push(sky * Math.min(Math.max((dd - 0.03) / 0.05, 0), 1) * Math.max(1 - dd / RAY_REACH, 0) ** 1.1);
      }
    }
    this.sel = Int32Array.from(sel);
    this.d = Float32Array.from(d);
    this.phi = Float32Array.from(phi);
    this.core = Float32Array.from(core);
    this.halo = Float32Array.from(halo);
    this.prof = Float32Array.from(prof);
    this.key = key;
  }

  /** Writes the lit frame into outI / outC (copies of the base frame). */
  apply(baseI, baseC, outI, outC, w, h, rampLen) {
    this._fields(w, h);
    outI.set(baseI);
    outC.set(baseC);
    const t = this.time, TAU = Math.PI * 2;
    const intensity = this.intensity();
    const level = intensity - 0.3;
    const glow = Math.max(level, 0);
    const reach = 0.55 + 0.45 * glow;
    const rayAmp = 0.35 + 0.65 * intensity;
    const rays = this.rays.map((r) => ({
      a: r.angle + RAY_SWAY * Math.sin(TAU * r.swayF * t + r.p0),
      f: 0.5 + 0.5 * Math.sin(TAU * r.flickF * t + r.p1),
      w: r.width,
    }));

    const n = this.sel.length;
    for (let k = 0; k < n; k++) {
      const cell = this.sel[k], dd = this.d[k], ph = this.phi[k];
      const core = this.core[k], halo = this.halo[k];
      let ray = 0;
      if (this.prof[k] > 0) {
        for (const r of rays) ray += r.f * Math.exp(-(((ph - r.a) / r.w) ** 2));
        ray = Math.min(ray, 1.2) * this.prof[k] * Math.min(Math.max(reach - dd / RAY_REACH + 0.45, 0), 1) * rayAmp;
      }
      const ring = halo * (1 - core);
      const shimmer = Math.sin(dd * 55 - 1.7 * t + 1.3 * Math.sin(4 * ph + 0.5 * t)) * ring;

      const gain = 1 + 0.65 * level * halo + 1.05 * level * core + 0.8 * ray + 0.08 * shimmer;
      const p = cell * 3;
      for (let c = 0; c < 3; c++) {
        const v = baseC[p + c] * gain + glow * core * CORE_LIGHT[c] + glow * halo * HALO_LIGHT[c] + ray * RAY_LIGHT[c];
        outC[p + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
      const i = baseI[cell];
      if (i > 0) {
        const delta = 4.5 * level * halo ** 1.3 + 4.5 * ray + 1.1 * shimmer;
        outI[cell] = Math.min(Math.max(Math.round(i + delta), 1), rampLen - 1);
      }
    }
  }
}
