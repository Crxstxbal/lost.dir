// LOST.DIR Visual Engine — web / mobile version.
// Same pipeline as main.py: cover -> ASCII grid -> sun glow -> WebGL CRT shader,
// with the album player and the audio reactivity (bloom / chromatic aberration on beats).

import { ASCIIRenderer } from "./renderer.js";
import { loadImagePixels, processImage } from "./image.js";
import { SunGlow } from "./sunglow.js";
import { AlbumPlayer } from "./player.js";

const $ = (id) => document.getElementById(id);
const STORE_KEY = "lostdir.settings";
const TRACK_KEY = "lostdir.track";

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: not remembered */ }
}
function showError(msg) {
  const el = $("error");
  el.textContent = msg;
  el.style.display = "block";
}
const fmtTime = (s) => (isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "0:00");

async function boot() {
  let manifest;
  try {
    manifest = await (await fetch("data/manifest.json")).json();
  } catch {
    showError("No se encontraron los datos. Ejecuta `python tools/export_web.py` y abre la página con el servidor (python tools/serve_web.py).");
    return;
  }
  const base = manifest.settings;
  const settings = Object.assign({
    grid_size: base.grid_size, red_intensity: base.red_intensity, contrast: base.contrast,
    brightness: base.brightness, shadow_detail: base.shadow_detail, black_crush: base.black_crush,
    scanlines: base.scanlines, vignette: base.vignette_str > 0, grain: base.grain_str > 0,
    volume: base.volume, audio_reactive: base.audio_reactive, audio_force: base.audio_force,
  }, load(STORE_KEY, {}));

  const canvas = $("view");
  let renderer;
  try {
    renderer = new ASCIIRenderer(canvas);
  } catch (e) {
    showError(String(e.message || e));
    return;
  }
  const cover = await loadImagePixels("data/cover.png");
  const sun = new SunGlow();

  // ------------------------------------------------------------------ player
  const player = new AlbumPlayer(manifest.playlist, (track) => {
    $("num").textContent = `TRACK ${String(track.index).padStart(2, "0")}/${String(manifest.playlist.length).padStart(2, "0")}`;
    $("title").textContent = track.title;
    save(TRACK_KEY, player.index);
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title, artist: "LOST.DIR", album: "LOST.DIR VOL.I",
        artwork: [{ src: "data/cover.png", sizes: "1024x1024", type: "image/png" }],
      });
    }
  });
  player.setVolume(settings.volume);
  const audio = player.audio;
  const syncPlayIcon = () => { $("play").innerHTML = audio.paused ? "&#x25B6;" : "&#x23F8;"; };
  audio.addEventListener("play", syncPlayIcon);
  audio.addEventListener("pause", syncPlayIcon);
  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", () => audio.play());
    navigator.mediaSession.setActionHandler("pause", () => audio.pause());
    navigator.mediaSession.setActionHandler("nexttrack", () => player.next());
    navigator.mediaSession.setActionHandler("previoustrack", () => player.prev());
  }

  // Keep the screen awake while the music plays (only available over HTTPS)
  let wakeLock = null;
  audio.addEventListener("play", async () => {
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* not available */ }
  });
  audio.addEventListener("pause", () => { wakeLock?.release?.(); wakeLock = null; });

  $("start").addEventListener("click", () => {
    $("start").classList.add("hidden");
    player.load(load(TRACK_KEY, 0));
  });
  // ?autostart: skip the tap-to-start screen (desktop / kiosk; phones still need a tap for sound)
  if (new URLSearchParams(location.search).has("autostart")) $("start").click();
  $("play").addEventListener("click", () => player.toggle());
  $("next").addEventListener("click", () => player.next());
  $("prev").addEventListener("click", () => player.prev());

  // Seekable progress bar
  const progress = $("progress");
  const seekTo = (e) => {
    const r = progress.getBoundingClientRect();
    player.seek(Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1));
  };
  progress.addEventListener("pointerdown", (e) => { progress.setPointerCapture(e.pointerId); seekTo(e); });
  progress.addEventListener("pointermove", (e) => { if (progress.hasPointerCapture(e.pointerId)) seekTo(e); });

  // ------------------------------------------------------------------ settings sheet
  const sheet = $("sheet");
  $("menu").addEventListener("click", () => sheet.classList.toggle("open"));
  let needsProcess = true;
  const fmt = {
    grid_size: (v) => `${v}`, volume: (v) => `${Math.round(v * 100)}%`, audio_force: (v) => `${(+v).toFixed(1)}x`,
    black_crush: (v) => (+v).toFixed(2), default: (v) => `${(+v).toFixed(2)}x`,
  };
  const applySetting = (key) => {
    const v = settings[key];
    const label = document.querySelector(`[data-for="${key}"]`);
    if (label) label.textContent = (fmt[key] || fmt.default)(v);
    if (key === "volume") player.setVolume(v);
    else if (key === "scanlines") renderer.set("u_scanlines", v);
    else if (key === "vignette") renderer.set("u_vignette_str", v ? base.vignette_str || 0.25 : 0);
    else if (key === "grain") renderer.set("u_grain_str", v ? base.grain_str || 0.06 : 0);
    else if (!["audio_reactive", "audio_force"].includes(key)) needsProcess = true;
  };
  for (const input of sheet.querySelectorAll("[data-key]")) {
    const key = input.dataset.key;
    if (input.type === "checkbox") input.checked = !!settings[key];
    else input.value = settings[key];
    input.addEventListener("input", () => {
      settings[key] = input.type === "checkbox" ? input.checked : parseFloat(input.value);
      applySetting(key);
      save(STORE_KEY, settings);
    });
    applySetting(key);
  }
  renderer.set("u_scanline_str", base.scanline_str);

  // ------------------------------------------------------------------ canvas sizing
  const stage = $("stage");
  let atlasKey = "";
  const resize = () => {
    const side = Math.floor(Math.min(stage.clientWidth, stage.clientHeight));
    const dpr = Math.min(window.devicePixelRatio || 1, 2048 / Math.max(side, 1));
    canvas.style.width = canvas.style.height = `${side}px`;
    canvas.width = canvas.height = Math.max(1, Math.round(side * dpr));
    atlasKey = "";   // glyph resolution follows the cell size
  };
  new ResizeObserver(resize).observe(stage);
  resize();

  // ------------------------------------------------------------------ gestures on the image
  let down = null, lastTap = 0, tapTimer = null;
  canvas.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  canvas.addEventListener("pointerup", (e) => {
    if (!down) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y, dt = performance.now() - down.t;
    down = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy) && dt < 600) {
      dx < 0 ? player.next() : player.prev();            // swipe: change track
      return;
    }
    if (Math.hypot(dx, dy) > 12) return;
    const now = performance.now();
    if (now - lastTap < 300) {                            // double tap: fullscreen
      clearTimeout(tapTimer);
      lastTap = 0;
      if (document.fullscreenElement) document.exitFullscreen?.();
      else document.documentElement.requestFullscreen?.().catch(() => {});
      return;
    }
    lastTap = now;
    tapTimer = setTimeout(() => {                         // single tap: hide / show the controls
      if (sheet.classList.contains("open")) sheet.classList.remove("open");
      else document.body.classList.toggle("hide-ui");
    }, 300);
  });

  // In landscape the controls overlay the image: hide them after a few idle seconds of playback
  const landscape = matchMedia("(orientation: landscape) and (max-height: 600px)");
  let idleTimer = null;
  const armAutoHide = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (landscape.matches && !audio.paused && !sheet.classList.contains("open")) document.body.classList.add("hide-ui");
    }, 4000);
  };
  for (const ev of ["pointerdown", "keydown"]) document.addEventListener(ev, armAutoHide);
  audio.addEventListener("play", armAutoHide);

  // ------------------------------------------------------------------ frame loop
  let frameData = null, outI = null, outC = null;
  let last = performance.now();
  let snareFlash = 0, kickPulse = 0, uiTick = 0;
  const vu = { kick: $("vu-kick"), snare: $("vu-snare"), bass: $("vu-bass"), hat: $("vu-hat") };

  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;

    if (needsProcess) {
      frameData = processImage(cover, Math.round(settings.grid_size), { ...base, ...settings });
      outI = new Uint8Array(frameData.indices.length);
      outC = new Uint8Array(frameData.colors.length);
      needsProcess = false;
      atlasKey = "";
    }
    const cellPx = canvas.width / frameData.w;
    const fontSize = Math.min(Math.max(Math.round(cellPx * 2.3), 10), 40);
    const key = `${frameData.ramp}|${fontSize}`;
    if (key !== atlasKey) {
      renderer.updateFontAtlas(frameData.ramp, fontSize);
      atlasKey = key;
    }

    // Audio analysis & reactivity (same mapping as main.py)
    player.update();
    if (player.playing) sun.update(dt);
    const force = settings.audio_force;
    snareFlash = Math.max(0, snareFlash - dt * 9);
    kickPulse = Math.max(0, kickPulse - dt * 8);
    if (settings.audio_reactive) {
      if (player.snareHit) snareFlash = 1;
      if (player.kickHit) kickPulse = 1;
      renderer.set("u_aberration_str", base.aberration_str + (snareFlash * 0.0035 + kickPulse * 0.0012) * force);
      renderer.set("u_bloom_boost", 0.15 + (snareFlash * 0.25 + kickPulse * 0.14 + player.bass * 0.08) * force);
    } else {
      renderer.set("u_aberration_str", base.aberration_str);
      renderer.set("u_bloom_boost", 0.15);
    }

    sun.apply(frameData.indices, frameData.colors, outI, outC, frameData.w, frameData.h, [...frameData.ramp].length);
    renderer.updateFrame(outI, outC, frameData.w, frameData.h);
    renderer.render();

    // UI (progress every frame, meters ~20 fps and only while visible)
    const dur = player.duration;
    $("fill").style.transform = `scaleX(${dur ? player.time / dur : 0})`;
    if ((uiTick = (uiTick + 1) % 3) === 0) {
      $("t-cur").textContent = fmtTime(player.time);
      $("t-dur").textContent = fmtTime(dur);
      if (sheet.classList.contains("open")) {
        vu.kick.style.transform = `scaleX(${player.kick})`;
        vu.snare.style.transform = `scaleX(${player.snare})`;
        vu.bass.style.transform = `scaleX(${player.bass})`;
        vu.hat.style.transform = `scaleX(${player.hat})`;
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

boot().catch((e) => showError(String(e.message || e)));
