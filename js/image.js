// Port of engine/image_processor.py: cover image -> ASCII ramp indices + RGB colours.

export const RAMPS = {
  lostdir: " .'`^,·:;~-+=*xX#0QZ%8@█",
  detailed: " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$",
  minimal: " .:-=+*#%@",
  tech: " .<>/{}[];:=*#&@",
  binary: " 01",
  glitch: " _-=+░▒▓█",
};

export async function loadImagePixels(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const cv = document.createElement("canvas");
  cv.width = img.naturalWidth;
  cv.height = img.naturalHeight;
  const ctx = cv.getContext("2d");
  ctx.drawImage(img, 0, 0);
  return { width: cv.width, height: cv.height, data: ctx.getImageData(0, 0, cv.width, cv.height).data };
}

/** Area-average downsample (cv2.INTER_AREA) to gw x gh, RGB floats in [0, 1]. */
function resizeArea(src, gw, gh) {
  const { width: W, height: H, data } = src;
  const out = new Float32Array(gw * gh * 3);
  for (let gy = 0; gy < gh; gy++) {
    const y0 = (gy * H) / gh, y1 = ((gy + 1) * H) / gh;
    for (let gx = 0; gx < gw; gx++) {
      const x0 = (gx * W) / gw, x1 = ((gx + 1) * W) / gw;
      let r = 0, g = 0, b = 0, wsum = 0;
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
          const wgt = wy * (Math.min(x + 1, x1) - Math.max(x, x0));
          const p = (y * W + x) * 4;
          r += data[p] * wgt; g += data[p + 1] * wgt; b += data[p + 2] * wgt;
          wsum += wgt;
        }
      }
      const o = (gy * gw + gx) * 3;
      out[o] = r / wsum / 255; out[o + 1] = g / wsum / 255; out[o + 2] = b / wsum / 255;
    }
  }
  return out;
}

/** Separable gaussian blur like cv2.GaussianBlur(sigma) on float data (reflect-101 border). */
function gaussianBlur(src, w, h, sigma) {
  const k = Math.round(sigma * 4 * 2 + 1) | 1;
  const r = (k - 1) / 2;
  const kernel = new Float32Array(k);
  let s = 0;
  for (let i = 0; i < k; i++) { kernel[i] = Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)); s += kernel[i]; }
  for (let i = 0; i < k; i++) kernel[i] /= s;
  const refl = (i, n) => (i < 0 ? -i : i >= n ? 2 * n - 2 - i : i);
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = 0; i < k; i++) acc += kernel[i] * src[y * w + refl(x + i - r, w)];
      tmp[y * w + x] = acc;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = 0; i < k; i++) acc += kernel[i] * tmp[refl(y + i - r, h) * w + x];
      out[y * w + x] = acc;
    }
  return out;
}

/** numpy.percentile with linear interpolation. */
function percentile(arr, q) {
  const s = Float32Array.from(arr).sort();
  const pos = (q / 100) * (s.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/**
 * Same steps as ImageProcessor.process. Returns { indices: Uint8Array(w*h), colors: Uint8Array(w*h*3), ramp }.
 */
export function processImage(src, grid, s) {
  const ramp = RAMPS[s.ramp_name] || RAMPS.lostdir;
  const n = [...ramp].length;
  const w = grid, h = grid;
  const px = resizeArea(src, w, h);
  const adj = new Float32Array(px.length);
  const bc = s.black_crush;
  for (let i = 0; i < px.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      let v = px[i + c] * (c === 0 ? s.red_intensity : 1);
      v = (v - 0.5) * s.contrast + 0.5 * s.brightness;
      if (bc > 0) v = Math.max(0, v - bc) / (1 - bc + 1e-6);
      if (s.gamma !== 1) v = Math.pow(Math.min(Math.max(v, 0), 1), 1 / s.gamma);
      adj[i + c] = Math.min(Math.max(v, 0), 1);
    }
  }

  let lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = 0.75 * adj[i * 3] + 0.15 * adj[i * 3 + 1] + 0.1 * adj[i * 3 + 2];
  if (s.shadow_detail > 0) {
    const blur = gaussianBlur(lum, w, h, 1.5);
    for (let i = 0; i < lum.length; i++) lum[i] = Math.min(Math.max(lum[i] + s.shadow_detail * (lum[i] - blur[i]), 0), 1);
  }
  for (let i = 0; i < lum.length; i++) lum[i] = Math.pow(lum[i], 0.7);
  const pLow = percentile(lum, 0.5), pHigh = percentile(lum, 99.0);
  const span = Math.max(pHigh - pLow, 0.01);

  const indices = new Uint8Array(w * h);
  const colors = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const l = Math.min(Math.max((lum[i] - pLow) / span, 0), 1);
    indices[i] = Math.min(Math.max(Math.floor(l * n), 0), n - 1);
    for (let c = 0; c < 3; c++) colors[i * 3 + c] = Math.min(Math.max(adj[i * 3 + c] * 1.35 * 255, 0), 255);
    colors[i * 3] = Math.max(colors[i * 3], 35);
  }
  return { indices, colors, ramp, w, h };
}
