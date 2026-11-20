import { decodeFile, resample, mixToMono, computePeaks, encodeOgg } from "./audio.js";
import { Waveform } from "./waveform.js";
import { transcribe } from "./transcribe.js";
import { normalizeText, parseLyrics, alignLyrics, eventsFromRaw } from "./lyrics.js";
import { renderJs, ExportError, sanitizeSongKey, normalizeFilename, sortEvents } from "./exporter.js";
import { readTags } from "./tags.js";
import { openAddon, installSong, looksLikeOgg, AddonError } from "./addon.js";

const $ = (id) => document.getElementById(id);
const NUDGE = 0.05;

const S = {
  file: null, bytes: null, buffer: null, duration: 0,
  stereo: null, mono22: null, vocal22: null, vocal16: null, orig16: null, origUrl: null, vocalUrl: null,
  events: [], sel: new Set(), nextId: 1, ver: 0, sortedCache: null,
  raw: null,
  mode: "orig", addon: null, busy: false, asrJob: null, nameTouched: false, region: null,
  manualVocalBuffer: null, manualInstrumentalBuffer: null, manualMixBuffer: null,
  manualVocalUrl: null, manualInstrumentalUrl: null,
};
window.__lf = { S }; // handy for debugging in the browser console

// ------------------------------------------------------------------ small helpers
const store = {
  get(k, d) { try { const v = localStorage.getItem("lf." + k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("lf." + k, v); } catch { /* storage may be blocked */ } },
};
let toastTimer;
function toast(msg) {
  const t = $("toast"); if (!t) return;
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3800);
}
function status(id, text, kind = "") {
  const el = $(id);
  if (!el) { console.warn(`LyricGlyph: status element #${id} is missing`); return; }
  el.textContent = text || "";
  el.className = "status" + (kind ? " " + kind : "");
}
function chip(id, state, label) {
  const c = $(id); if (!c) { console.warn(`LyricGlyph: chip element #${id} is missing`); return; }
  c.className = "chip " + state; c.textContent = label;
}
function bar(id, pct) {
  const b = $(id);
  if (pct === null || pct === undefined) { b.hidden = true; return; }
  b.hidden = false; b.classList.toggle("indet", pct < 0);
  if (pct >= 0) b.firstElementChild.style.width = Math.min(100, pct) + "%";
}
function fmtClock(sec) { sec = Math.max(0, sec || 0); const m = Math.floor(sec / 60); return `${m}:${(sec - m * 60).toFixed(2).padStart(5, "0")}`; }
function parseTime(text) {
  const t = String(text).trim().replace(",", ".");
  let v;
  if (t.includes(":")) { const [m, s] = t.split(":"); v = Number(m) * 60 + Number(s); } else v = Number(t);
  if (!Number.isFinite(v) || v < 0) throw new Error("bad time");
  return v;
}
function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const nextFrame = () => new Promise((r) => setTimeout(r, 0));

// ------------------------------------------------------------------ audio element + waveform
const audio = $("audio");
audio.preservesPitch = true;
const wave = new Waveform($("wave"), { onSeek: (t) => { audio.currentTime = t; tick(); } });

function setSource(mode) {
  const t = audio.currentTime || 0, was = !audio.paused;
  S.mode = mode;
  const url = S.origUrl;
  audio.src = url;
  audio.addEventListener("loadedmetadata", () => { audio.currentTime = t; audio.playbackRate = Number($("speed").value); if (was) audio.play(); }, { once: true });
}
audio.addEventListener("error", async () => {
  // Some browsers (notably iOS Safari) cannot play OGG: fall back to a WAV made from the decoded audio.
  if (S.mode === "orig" && S.mono22 && !S.fallbackWav) {
    S.fallbackWav = URL.createObjectURL(encodeWav([S.mono22], 22050));
    S.origUrl = S.fallbackWav; audio.src = S.fallbackWav;
    toast("This browser cannot play that format directly - using a converted preview.");
  }
});

let raf = 0;
function sortedEvents() {
  if (!S.sortedCache || S.sortedCache.ver !== S.ver) S.sortedCache = { ver: S.ver, list: sortEvents(S.events) };
  return S.sortedCache.list;
}
function currentWordIndex(t) {
  const L = sortedEvents(); let lo = 0, hi = L.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (L[m].time <= t + 0.02) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}
let lastCurId = null;
function tick() {
  const t = audio.currentTime || 0;
  $("time").textContent = `${fmtClock(t)} / ${fmtClock(S.duration)}`;
  wave.setHead(t, !audio.paused && $("follow").checked);
  const timelineHead = timeline?._playhead;
  const timelineHandle = timeline?._headHandle;
  if (timelineHead) timelineHead.style.left = `${Math.max(0, t * timelineScale)}px`;
  if (timelineHandle) timelineHandle.style.left = `${Math.max(0, t * timelineScale)}px`;
  const i = currentWordIndex(t), ev = i >= 0 ? sortedEvents()[i] : null;
  const shown = ev && t - ev.time < 4 ? ev : null;
  $("glyphWord").textContent = shown ? shown.text : "-";
  $("glyph").classList.toggle("idle", !shown);
  const id = shown ? shown.id : null;
  if (id !== lastCurId) {
    lastCurId = id;
    for (const r of $("list").querySelectorAll(".row.cur")) r.classList.remove("cur");
    if (id !== null) {
      const row = $("list").querySelector(`.row[data-id="${id}"]`);
      if (row) { row.classList.add("cur"); if (!audio.paused && $("follow").checked) keepVisible(row); }
    }
  }
  if (S.region && !audio.paused && t >= S.region[1]) {
    if ($("loop").checked) audio.currentTime = S.region[0]; else { audio.pause(); audio.currentTime = S.region[1]; }
  }
}
function keepVisible(row) {
  const list = $("list"), top = row.offsetTop, bottom = top + row.offsetHeight;
  if (top < list.scrollTop || bottom > list.scrollTop + list.clientHeight) list.scrollTop = top - list.clientHeight / 3;
}
function loop() { tick(); if (!audio.paused) raf = requestAnimationFrame(loop); }
audio.addEventListener("play", () => { $("play").textContent = "Pause"; cancelAnimationFrame(raf); raf = requestAnimationFrame(loop); });
audio.addEventListener("pause", () => { $("play").textContent = "Play"; tick(); });
audio.addEventListener("seeked", tick);
audio.addEventListener("ended", () => { $("play").textContent = "Play"; });

function togglePlay() { if (!S.buffer) return; if (audio.paused) { S.region = null; wave.setRegion(null); audio.play(); } else audio.pause(); }
$("play").onclick = togglePlay;
$("stop").onclick = () => { audio.pause(); audio.currentTime = 0; S.region = null; wave.setRegion(null); tick(); };
$("zoomIn").onclick = () => wave.zoom(1 / 1.6, audio.currentTime);
$("zoomOut").onclick = () => wave.zoom(1.6, audio.currentTime);
$("fit").onclick = () => wave.fit();
$("speed").onchange = () => { audio.playbackRate = Number($("speed").value); };

// ------------------------------------------------------------------ Google lyrics search + in-app mini browser
function lyricsSearchUrl(query) {
  return "https://www.google.com/search?" + new URLSearchParams({ q: query + " lyrics" });
}
function currentLyricsQuery() {
  const title = $("title").value.trim();
  return title ? `${title} lyrics` : "song lyrics";
}
function openLyricsSearch() {
  const query = currentLyricsQuery();
  $("miniQuery").value = query;
  $("miniBrowser").hidden = false;
  window.open(lyricsSearchUrl(query), "_blank", "noopener,noreferrer");
}
$("title").addEventListener("input", () => {
  const title = $("title").value.trim();
  $("expTitle").value = title;
  refreshExport();
});
$("googleSearch").onclick = () => window.open(lyricsSearchUrl(currentLyricsQuery()), "_blank", "noopener,noreferrer");
$("openMiniSearch").onclick = openLyricsSearch;
$("miniGo").onclick = () => {
  const q = $("miniQuery").value.trim() || currentLyricsQuery();
  $("miniQuery").value = q;
  window.open(lyricsSearchUrl(q), "_blank", "noopener,noreferrer");
};
$("miniQuery").addEventListener("keydown", e => { if (e.key === "Enter") $("miniGo").click(); });
$("miniClose").onclick = () => { $("miniBrowser").hidden = true; };
$("miniPaste").onclick = async () => {
  try {
    const copied = await navigator.clipboard.readText();
    if (!copied.trim()) { toast("Clipboard is empty. Copy the lyrics first."); return; }
    const area = $("lyricsText");
    area.value = area.value.trim() ? area.value.trimEnd() + "\n" + copied.trim() : copied.trim();
    area.dispatchEvent(new Event("input", { bubbles: true }));
    toast("Copied lyrics pasted. Review them before applying.");
  } catch {
    toast("Clipboard access was blocked. Paste directly into the lyrics box instead.");
    $("lyricsText").focus();
  }
};


// ------------------------------------------------------------------ loading a song
const drop = $("drop");
$("file").onchange = (e) => e.target.files[0] && loadFile(e.target.files[0]);
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) loadFile(f); });

function setBusy(b) {
  S.busy = b;
  for (const id of ["auto", "googleSearch", "openMiniSearch", "runAsr", "applyLyr", "separateVocals"]) $(id).disabled = b || !enabledNow(id);
  $("cancelAsr").hidden = !(b && S.asrJob);
}
function enabledNow(id) {
  if (!S.buffer) return false;
  if (id === "applyLyr") return !!S.raw;
  return true;
}
function refreshEnabled() { setBusy(S.busy); }

async function loadFile(file) {
  if (S.busy) return;
  setBusy(true);
  status("autoStatus", "Reading the song...");
  bar("bar", -1);
  try {
    resetSong();
    const { bytes, buffer } = await decodeFile(file);
    Object.assign(S, { file, bytes, buffer, duration: buffer.duration, vocal22: null, vocal16: null });
    const st = await resample(buffer, 22050, 2);
    const l = st.getChannelData(0).slice(), r = st.numberOfChannels > 1 ? st.getChannelData(1).slice() : l;
    S.mono22 = mixToMono(l, r);
    const pk = computePeaks(S.mono22, 22050, 100);
    wave.setData(pk.peaks, pk.perSecond, S.duration);
    S.origUrl = URL.createObjectURL(file); audio.src = S.origUrl; audio.playbackRate = Number($("speed").value);
    const tags = readTags(bytes, file.name);
    $("title").value = tags.title; $("expTitle").value = tags.title;
    if (!S.nameTouched) $("expName").value = sanitizeSongKey(tags.title) + ".js";
    $("dropMain").textContent = file.name;
    $("dropHint").textContent = `${fmtClock(S.duration)} - ${(file.size / 1048576).toFixed(1)} MB - tap to change`;
    for (const id of ["play", "stop"]) $(id).disabled = false;
    status("autoStatus", "Ready. Press Auto-generate lyrics.", "ok");
    tick();
  } catch (err) {
    status("autoStatus", err.message, "err");
  } finally { bar("bar", null); setBusy(false); refreshWordsUi(); }
}
function resetSong() {
  audio.pause();
  for (const u of [S.fallbackWav, S.manualVocalUrl, S.manualInstrumentalUrl]) if (u) URL.revokeObjectURL(u);
  if (S.origUrl) URL.revokeObjectURL(S.origUrl);
  if (S.vocalUrl) URL.revokeObjectURL(S.vocalUrl);
  if (S.instrumentalUrl) URL.revokeObjectURL(S.instrumentalUrl);
  for (const url of (S.stemUrls || [])) { try { URL.revokeObjectURL(url); } catch {} }
  for (const id of ["vocalPreview", "instrumentalPreview"]) { const el = $(id); if (el) { el.pause(); el.removeAttribute("src"); el.load(); el.hidden = true; } }
  Object.assign(S, { orig16: null, vocal16: null, vocal22: null, vocalUrl: null, instrumentalUrl: null, stemUrls: [], fallbackWav: null, origUrl: null, raw: null, mode: "orig", region: null, manualVocalBuffer: null, manualInstrumentalBuffer: null, manualMixBuffer: null, manualVocalUrl: null, manualInstrumentalUrl: null });
  for (const id of ["manualVocalFile", "manualInstrumentalFile"]) $(id).value = "";
  status("manualStemStatus", "");
  $("clearManualStems").disabled = true;
  S.events = []; S.sel.clear(); S.ver++;
  chip("chip-lyr", "", "waiting"); chip("chip-asr", "", "waiting");
  for (const id of ["lyrStatus", "asrStatus"]) status(id, "");
  $("lyricsText").value = "";
  renderWords();
}

// ------------------------------------------------------------------ manual stem import + mix for final addon audio
async function prepareWhisperFromBuffer(buffer) {
  const vocalStereo = await resample(buffer, 22050, 2);
  const left = vocalStereo.getChannelData(0).slice();
  const right = vocalStereo.numberOfChannels > 1 ? vocalStereo.getChannelData(1).slice() : left;
  S.vocal22 = mixToMono(left, right);
  S.vocal16 = null;
}

async function buildManualStemMix() {
  const vf = $("manualVocalFile").files[0];
  const inf = $("manualInstrumentalFile").files[0];
  if (!vf || !inf) {
    status("manualStemStatus", "Choose both the vocal and instrumental files.");
    return;
  }
  if (S.busy) return;
  setBusy(true);
  status("manualStemStatus", "Decoding both stems locally...");
  try {
    const [vocalDecoded, instrumentalDecoded] = await Promise.all([decodeFile(vf), decodeFile(inf)]);
    const vocal = vocalDecoded.buffer, instrumental = instrumentalDecoded.buffer;
    const referenceDuration = S.duration || Math.max(vocal.duration, instrumental.duration);
    if (Math.abs(vocal.duration - instrumental.duration) > 0.75) {
      throw new Error(`Stem lengths differ by ${Math.abs(vocal.duration - instrumental.duration).toFixed(2)}s. Re-export both stems with matching start/end points.`);
    }
    if (S.buffer && (Math.abs(vocal.duration - referenceDuration) > 1.5 || Math.abs(instrumental.duration - referenceDuration) > 1.5)) {
      throw new Error("These stems do not match the currently imported song duration. Make sure you selected stems from this song.");
    }
    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OfflineCtx) throw new Error("OfflineAudioContext is not supported in this browser. Use the latest Chrome or Edge.");
    const sampleRate = S.buffer?.sampleRate || Math.max(vocal.sampleRate, instrumental.sampleRate);
    const duration = S.duration || Math.max(vocal.duration, instrumental.duration);
    const frames = Math.max(1, Math.ceil(duration * sampleRate));
    const ctx = new OfflineCtx(2, frames, sampleRate);
    const vSrc = ctx.createBufferSource(), iSrc = ctx.createBufferSource();
    const vGain = ctx.createGain(), iGain = ctx.createGain();
    vSrc.buffer = vocal; iSrc.buffer = instrumental;
    // Equal-power-safe headroom: each stem starts at -6 dB to reduce clipping.
    vGain.gain.value = 0.5; iGain.gain.value = 0.5;
    vSrc.connect(vGain).connect(ctx.destination); iSrc.connect(iGain).connect(ctx.destination);
    vSrc.start(0); iSrc.start(0);
    status("manualStemStatus", "Preparing the combined track and vocal transcription audio...");
    const mixed = await ctx.startRendering();
    const oldUrls = new Set([S.vocalUrl, S.instrumentalUrl, ...(S.stemUrls || []), S.manualVocalUrl, S.manualInstrumentalUrl].filter(Boolean));
    for (const url of oldUrls) { try { URL.revokeObjectURL(url); } catch {} }
    S.stemUrls = [];
    S.manualVocalBuffer = vocal;
    S.manualInstrumentalBuffer = instrumental;
    S.manualMixBuffer = mixed;
    S.manualVocalUrl = URL.createObjectURL(vf);
    S.manualInstrumentalUrl = URL.createObjectURL(inf);
    S.vocalUrl = S.manualVocalUrl;
    S.instrumentalUrl = S.manualInstrumentalUrl;
    const vp = $("vocalPreview"), ip = $("instrumentalPreview");
    vp.src = S.manualVocalUrl; vp.hidden = false;
    ip.src = S.manualInstrumentalUrl; ip.hidden = false;
    await prepareWhisperFromBuffer(vocal);
    chip("chip-asr", "done", "manual vocals ready");
    $("clearManualStems").disabled = false;
    if ($("addonAudio")?.options[0]) $("addonAudio").options[0].textContent = "Vocal + instrumental mix (manual stems)";
    status("manualStemStatus", "Both stems loaded. Whisper will use vocals; MCAddon export will automatically mix vocals + instrumental.", "ok");
  } catch (err) {
    S.manualVocalBuffer = S.manualInstrumentalBuffer = S.manualMixBuffer = null;
    S.vocal22 = S.vocal16 = null;
    status("manualStemStatus", err?.message || String(err), "err");
  } finally { setBusy(false); }
}
$("manualVocalFile").addEventListener("change", buildManualStemMix);
$("manualInstrumentalFile").addEventListener("change", buildManualStemMix);
$("clearManualStems").onclick = () => {
  for (const u of [S.manualVocalUrl, S.manualInstrumentalUrl]) if (u) URL.revokeObjectURL(u);
  Object.assign(S, { manualVocalBuffer: null, manualInstrumentalBuffer: null, manualMixBuffer: null, manualVocalUrl: null, manualInstrumentalUrl: null, vocal22: null, vocal16: null, vocalUrl: null, instrumentalUrl: null, stemUrls: [] });
  $("manualVocalFile").value = $("manualInstrumentalFile").value = "";
  for (const id of ["vocalPreview", "instrumentalPreview"]) { const el = $(id); el.pause(); el.removeAttribute("src"); el.load(); el.hidden = true; }
  $("clearManualStems").disabled = true;
  if ($("addonAudio")?.options[0]) $("addonAudio").options[0].textContent = "Imported song (local audio)";
  chip("chip-asr", "", "waiting");
  status("manualStemStatus", "Manual stems cleared. Whisper will use the original song unless you separate vocals again.");
};

// ------------------------------------------------------------------ local vocal separation (original audio remains the export source)
// Audio decoding / STFT preparation needs browser audio APIs and stays on the page.
// ONNX Runtime's WASM inference is proxied to its own Web Worker so the expensive
// model execution does not monopolize the UI thread.
let separationRunning = false;
const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve, 0));
$("separateVocals").onclick = async () => {
  if (!S.file || S.busy || separationRunning) return;
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineCtx) {
    status("sepStatus", "This browser does not support OfflineAudioContext. Please use the latest Chrome or Edge.", "err");
    return;
  }

  separationRunning = true;
  setBusy(true);
  bar("barSep", -1);
  chip("chip-asr", "run", "separating");
  let sourceUrl = null;
  let stemUrls = [];
  let currentStage = "Starting local vocal separation...";
  let separatingStartedAt = 0;
  const startedAt = Date.now();
  const showElapsed = () => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    const detail = separatingStartedAt && elapsed >= 180
      ? "\nStill processing. This separator library does not expose per-cent progress, so elapsed time is shown instead."
      : "";
    status("sepStatus", `${currentStage} (${elapsed}s elapsed)${detail}`);
  };
  const elapsedTimer = setInterval(showElapsed, 1000);
  const setStage = async (message) => {
    currentStage = message;
    showElapsed();
    await yieldToBrowser();
  };

  try {
    await setStage("Preparing background AI inference (local browser processing)...");

    // This must be the exact same ONNX Runtime module instance used by
    // web-audio-separation. The import map in index.html pins the peer dependency.
    const ort = await import("onnxruntime-web");
    if (!ort?.env?.wasm) throw new Error("ONNX Runtime Web could not be initialized.");
    // Official ORT proxy-worker mode: heavy WASM inference runs in a Worker.
    // Do not silently fall back to main-thread WASM if the worker is blocked.
    ort.env.wasm.proxy = true;

    await setStage("Loading vocal-separation engine. The first run downloads the model (~67 MB)...");
    const { createSeparator } = await import("https://esm.sh/web-audio-separation@0.3.0?external=onnxruntime-web");
    const separator = createSeparator("Kim_Vocal_2", {
      // Do not override common.primaryStemName / secondaryStemName here.
      // The model registry defines Kim_Vocal_2's primary stem as Vocals;
      // the separator returns [primary, secondary]. Keeping the registry
      // metadata intact prevents an accidental stem-name/order mismatch.
      common: { logLevel: "error" },
      mdx: {
        segmentSize: 256,
        overlap: 0.25,
        batchSize: 1,
        // Proxy-worker mode is for WASM. Avoid WebGPU here so the ONNX runtime
        // consistently keeps CPU inference off the UI thread on every device.
        executionProviders: ["wasm"],
      },
    });

    await setStage("Downloading/loading Kim Vocal 2 (~67 MB). Keep this tab open; first use can take a few minutes...");
    await separator.loadModel();

    const sourceBlob = new Blob([await S.file.arrayBuffer()], { type: S.file.type || "application/octet-stream" });
    sourceUrl = URL.createObjectURL(sourceBlob);
    separatingStartedAt = Date.now();
    const songDuration = Number(S.duration || 0);
    await setStage(`Model ready. Separating ${fmtClock(songDuration)} of audio locally. This step may take several minutes; progress is not exposed by the separator library...`);
    const stems = await separator.separate(sourceUrl);
    if (!Array.isArray(stems) || stems.length < 1 || typeof stems[0] !== "string") {
      throw new Error("The separator finished but did not return a vocal stem.");
    }
    stemUrls = stems;
    // Keep the returned object URLs alive so the user can audition the actual stems.
    // They are revoked only when a new song is loaded or the page state is reset.
    if (S.vocalUrl) URL.revokeObjectURL(S.vocalUrl);
    if (S.instrumentalUrl) URL.revokeObjectURL(S.instrumentalUrl);
    for (const url of (S.stemUrls || [])) { try { URL.revokeObjectURL(url); } catch {} }
    S.stemUrls = stems;
    S.manualMixBuffer = null;
    S.manualVocalBuffer = S.manualInstrumentalBuffer = null;
    S.manualVocalUrl = S.manualInstrumentalUrl = null;
    // Kim_Vocal_2 is registered with Vocals as its primary stem, so index 0
    // is the vocal output and index 1 is the instrumental residual.
    S.vocalUrl = stems[0];
    S.instrumentalUrl = stems[1] || null;
    const vocalPreview = $("vocalPreview");
    vocalPreview.src = S.vocalUrl;
    vocalPreview.hidden = false;
    const instrumentalPreview = $("instrumentalPreview");
    if (S.instrumentalUrl) { instrumentalPreview.src = S.instrumentalUrl; instrumentalPreview.hidden = false; }
    const response = await fetch(stems[0]);
    if (!response.ok) throw new Error(`Could not read the vocal stem (HTTP ${response.status}).`);
    const vocalBuffer = await response.arrayBuffer();
    if (!vocalBuffer.byteLength) throw new Error("The vocal stem is empty.");

    const vocalBlob = new Blob([vocalBuffer], { type: response.headers.get("content-type") || "audio/wav" });
    const vocalFile = new File([vocalBlob], "lyricglyph-vocals.wav", { type: vocalBlob.type || "audio/wav" });
    await setStage("Preparing separated vocals for Whisper...");
    const decoded = await decodeFile(vocalFile);
    const vocalStereo = await resample(decoded.buffer, 22050, 2);
    const left = vocalStereo.getChannelData(0).slice();
    const right = vocalStereo.numberOfChannels > 1 ? vocalStereo.getChannelData(1).slice() : left;
    S.vocal22 = mixToMono(left, right);
    S.vocal16 = null;
    // Whisper uses a decoded in-memory copy; preview continues using the separator output URL.
    chip("chip-asr", "done", "vocals ready");
    status("sepStatus", "Separation complete. Listen to the vocals and instrumental previews below. Whisper will analyze vocals only; main playback and MCAddon export still use the original song.", "ok");
  } catch (err) {
    console.error("LyricGlyph vocal separation:", err);
    chip("chip-asr", "err", "separation failed");
    status("sepStatus", "Vocal separation failed: " + (err?.message || String(err)) + "\nYour original song is safe. You can still transcribe the original audio.", "err");
  } finally {
    clearInterval(elapsedTimer);
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    bar("barSep", null);
    setBusy(false);
    separationRunning = false;
  }
};

// ------------------------------------------------------------------ step 4: transcribe + time the lyrics
$("model").value = store.get("model", "Xenova/whisper-base.en");
$("device").value = store.get("device", "wasm");
if (!navigator.gpu) $("device").querySelector('[value="webgpu"]').disabled = true;
$("model").onchange = () => store.set("model", $("model").value);
$("device").onchange = () => store.set("device", $("device").value);
$("cancelAsr").onclick = () => { if (S.asrJob) S.asrJob.cancel(); };

// Fast linear resampling from the app's 22.05 kHz mono buffer to Whisper's 16 kHz input.
// This avoids a long OfflineAudioContext render that can look like a frozen button on phones/low-end PCs.
async function to16k(mono22) {
  if (!mono22 || !mono22.length) throw new Error("Import a song before transcribing.");
  const outLength = Math.max(1, Math.floor(mono22.length * 16000 / 22050));
  const out = new Float32Array(outLength);
  const ratio = 22050 / 16000;
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, mono22.length - 1);
    const frac = pos - left;
    out[i] = mono22[left] * (1 - frac) + mono22[right] * frac;
  }
  return out;
}

async function runTranscribe() {
  if (!S.mono22) throw new Error("Import a song before transcribing.");
  chip("chip-asr", "run", "working"); bar("barAsr", -1);
  let job = null;
  try {
    status("asrStatus", "Preparing audio for transcription...");
    const sourceMono = S.vocal22 || S.mono22;
    const samples = S.vocal22 ? (S.vocal16 || (S.vocal16 = await to16k(sourceMono))) : (S.orig16 || (S.orig16 = await to16k(sourceMono)));
    status("asrStatus", "Starting local speech engine. First run may download the model (40–250 MB)...");
    job = transcribe(samples, { model: $("model").value, device: $("device").value }, (pct, msg) => { bar("barAsr", pct); status("asrStatus", msg); });
    S.asrJob = job; $("cancelAsr").hidden = false;
    S.raw = await job.promise;
    if (!S.raw.length) {
      chip("chip-asr", "err", "nothing heard");
      status("asrStatus", "No words were heard. Try separating vocals first, or check the original audio.", "err");
      throw new Error("No words were detected.");
    }
    chip("chip-asr", "done", "done");
    status("asrStatus", `Finished: ${S.raw.length} words heard.`, "ok");
    applyLyrics();
  } catch (err) {
    if (!(err && err.message === "No words were detected.")) {
      chip("chip-asr", "err", "failed");
      status("asrStatus", "Transcription failed: " + ((err && err.message) || String(err)), "err");
    }
    throw err;
  } finally {
    S.asrJob = null;
    $("cancelAsr").hidden = true;
    bar("barAsr", null);
  }
}
$("runAsr").onclick = async () => { setBusy(true); try { await runTranscribe(); } catch (err) { console.error("LyricGlyph transcription:", err); } finally { setBusy(false); } };

function applyLyrics() {
  if (!S.raw) throw new Error("Transcribe first.");
  const words = parseLyrics($("lyricsText").value);
  let events, msg;
  if (words.length) {
    const r = alignLyrics(words, S.raw, S.duration);
    events = r.events;
    msg = r.fromLrc
      ? `Little of the singing could be matched, so timings come from the lyrics site's synced lines (${words.length} words). Check them carefully.`
      : `${words.length} lyric words timed: ${r.exact} exact, ${r.approx} approximate, ${r.interpolated} estimated. Orange rows need a look.`;
  } else {
    const r = eventsFromRaw(S.raw, S.duration);
    events = r.events;
    msg = `${events.length} words, exactly as heard.` + (r.dropped.length ? ` ${r.dropped.length} items with no letters were skipped: ${r.dropped.slice(0, 8).join(" ")}` : "");
  }
  S.events = events.map((e) => ({ id: S.nextId++, ...e })); S.ver++; S.sel.clear();
  renderWords();
  status("asrStatus", msg, "ok");
  refreshExport();
}

// ------------------------------------------------------------------ auto pipeline
$("auto").onclick = async () => {
  if (!S.buffer || S.busy) return;
  setBusy(true); bar("bar", -1);
  const step = (n, t) => status("autoStatus", `Step ${n} of 2: ${t}`);
  try {
    if (!$("lyricsText").value.trim()) status("lyrStatus", "No lyrics pasted yet. Transcribing the imported song directly; you can add lyrics from Google afterward.");
    step(2, "listening and timing the words...");
    await runTranscribe();
    status("autoStatus", "Done. Review the orange words, then export.", "ok");
    document.getElementById("card-words").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    status("autoStatus", "Stopped: " + (err.message || err), "err");
  } finally { bar("bar", null); setBusy(false); }
};

// ------------------------------------------------------------------ single-track word timeline
const timeline = $("timeline");
const timelineScroll = $("timelineScroll");
let timelineScale = 58; // pixels per second; zoom controls change this
function timeFromTimelineX(clientX, track) {
  const rect = track.getBoundingClientRect();
  return Math.max(0, Math.min(S.duration, (clientX - rect.left) / timelineScale));
}
function moveTimelineHead(clientX, track) {
  audio.currentTime = timeFromTimelineX(clientX, track);
  tick();
}
function renderTimeline() {
  if (!timeline) return;
  timeline.innerHTML = "";
  if (!S.events.length) { timeline.innerHTML = '<p class="empty">Generate words to edit them on the timeline.</p>'; return; }
  const width = Math.max(900, Math.ceil((S.duration || 30) * timelineScale) + 80);
  timeline.style.width = width + "px";
  timeline.style.minHeight = "104px";
  const ruler = document.createElement("div"); ruler.className = "timeline-ruler";
  ruler.style.width = width + "px";
  const step = Math.max(1, Math.ceil((S.duration || 30) / 14));
  for (let t = 0; t <= S.duration; t += step) {
    const mark = document.createElement("span"); mark.style.left = (t * timelineScale) + "px"; mark.textContent = fmtClock(t); ruler.appendChild(mark);
  }
  timeline.appendChild(ruler);
  const track = document.createElement("div"); track.className = "timeline-track timeline-single-track";
  track.style.width = width + "px";
  track.style.height = "64px";
  track.addEventListener("pointerdown", e => {
    if (e.target.closest(".timeline-word, .timeline-playhead-handle")) return;
    moveTimelineHead(e.clientX, track);
  });
  const playhead = document.createElement("div"); playhead.className = "timeline-playhead";
  playhead.style.left = `${Math.max(0, Math.min(width, (audio.currentTime || 0) * timelineScale))}px`;
  const headHandle = document.createElement("button"); headHandle.type = "button"; headHandle.className = "timeline-playhead-handle";
  headHandle.setAttribute("aria-label", "Drag playback position"); headHandle.title = "Drag to move playback position";
  headHandle.addEventListener("pointerdown", e => {
    e.preventDefault(); e.stopPropagation(); headHandle.setPointerCapture(e.pointerId);
    const move = ev => { ev.preventDefault(); moveTimelineHead(ev.clientX, track); playhead.style.left = `${audio.currentTime * timelineScale}px`; headHandle.style.left = `${audio.currentTime * timelineScale}px`; };
    const up = () => { headHandle.removeEventListener("pointermove", move); headHandle.removeEventListener("pointerup", up); };
    headHandle.addEventListener("pointermove", move); headHandle.addEventListener("pointerup", up, { once: true });
  });
  headHandle.style.left = playhead.style.left;
  track.append(playhead, headHandle);

  const events = sortedEvents();
  events.forEach((ev, i) => {
    const block = document.createElement("button"); block.type = "button"; block.className = "timeline-word";
    block.textContent = ev.text; block.dataset.id = ev.id;
    block.style.left = Math.max(0, ev.time * timelineScale) + "px";
    const next = events[i + 1];
    const gap = next ? Math.max(0.32, next.time - ev.time) : 0.8;
    const clipWidth = Math.max(34, Math.min(150, Math.max(ev.text.length * 7 + 18, gap * timelineScale * 0.88)));
    block.style.width = clipWidth + "px";
    block.classList.toggle("unc", !!ev.uncertain); block.classList.toggle("selected", S.sel.has(ev.id));
    block.title = `${ev.text} — ${ev.time.toFixed(2)}s. Drag to retime.`;
    block.addEventListener("click", e => { if (!block.dataset.dragged) { select(ev.id, e.shiftKey ? "range" : e.ctrlKey || e.metaKey ? "toggle" : "one"); audio.currentTime = ev.time; tick(); } });
    block.addEventListener("pointerdown", e => {
      e.preventDefault(); e.stopPropagation(); block.setPointerCapture(e.pointerId);
      const startX = e.clientX, startTime = ev.time; block.dataset.dragged = "";
      const move = ev2 => {
        ev2.preventDefault();
        const delta = (ev2.clientX - startX) / timelineScale;
        if (Math.abs(ev2.clientX - startX) > 3) block.dataset.dragged = "1";
        ev.time = Math.max(0, Math.min(S.duration, Math.round((startTime + delta) * 1000) / 1000));
        ev.uncertain = false; ev.note = "";
        block.style.left = (ev.time * timelineScale) + "px";
        block.title = `${ev.text} — ${ev.time.toFixed(2)}s. Drag to retime.`;
        const row = rowOf(ev.id); if (row) row.querySelector(".t").value = ev.time.toFixed(2);
        syncWave();
      };
      const up = () => {
        block.removeEventListener("pointermove", move); block.removeEventListener("pointerup", up);
        if (block.dataset.dragged) { S.ver++; repaint(); block.dataset.dragged = "1"; setTimeout(() => { block.dataset.dragged = ""; }, 80); }
      };
      block.addEventListener("pointermove", move); block.addEventListener("pointerup", up, { once: true });
    });
    track.appendChild(block);
  });
  timeline.appendChild(track);
  timeline._track = track; timeline._playhead = playhead; timeline._headHandle = headHandle;
}
function zoomTimeline(factor) { timelineScale = Math.max(12, Math.min(180, timelineScale * factor)); renderTimeline(); }
$("timelineZoomIn")?.addEventListener("click", () => zoomTimeline(1.25));
$("timelineZoomOut")?.addEventListener("click", () => zoomTimeline(0.8));
$("timelineZoomFit")?.addEventListener("click", () => { timelineScale = Math.max(6, Math.min(100, 900 / Math.max(10, S.duration))); renderTimeline(); });
$("timelineBack")?.addEventListener("click", () => { audio.currentTime = Math.max(0, audio.currentTime - 0.5); tick(); });
$("timelineForward")?.addEventListener("click", () => { audio.currentTime = Math.min(S.duration, audio.currentTime + 0.5); tick(); });
$("timelinePlayPause")?.addEventListener("click", togglePlay);

// ------------------------------------------------------------------ word list
const list = $("list");
function renderWords() {
  list.innerHTML = "";
  if (!S.events.length) {
    list.innerHTML = '<p class="empty">No words yet. Import a song and press Auto-generate lyrics.</p>';
  } else {
    const frag = document.createDocumentFragment();
    S.events.forEach((e, i) => {
      const row = document.createElement("div");
      row.className = "row"; row.dataset.id = e.id; row.setAttribute("role", "listitem");
      row.innerHTML = '<button class="idx" tabindex="-1"></button><input class="t" inputmode="decimal" aria-label="Time in seconds"><input class="w" autocapitalize="none" autocomplete="off" spellcheck="false" aria-label="Word">';
      row.querySelector(".idx").textContent = i + 1;
      row.querySelector(".t").value = e.time.toFixed(2);
      row.querySelector(".w").value = e.text;
      frag.appendChild(row);
      paintRow(row, e);
    });
    list.appendChild(frag);
  }
  lastCurId = null;
  renderTimeline();
  refreshWordsUi(); syncWave(); tick();
}
function paintRow(row, e) {
  row.classList.toggle("unc", !!e.uncertain);
  row.classList.toggle("sel", S.sel.has(e.id));
  let note = row.querySelector(".note");
  if (e.uncertain && e.note) {
    if (!note) { note = document.createElement("span"); note.className = "note"; row.appendChild(note); }
    note.textContent = e.note;
  } else if (note) note.remove();
}
function rowOf(id) { return list.querySelector(`.row[data-id="${id}"]`); }
function evOf(id) { return S.events.find((e) => e.id === id); }
function syncWave() { wave.setEvents(sortedEvents(), S.sel); }
function repaint() { renderTimeline(); for (const row of list.querySelectorAll(".row")) paintRow(row, evOf(Number(row.dataset.id))); syncWave(); refreshWordsUi(); }
function refreshWordsUi() {
  const has = S.events.length > 0, sel = S.sel.size > 0;
  $("count").textContent = `${S.events.length} words` + (S.events.some((e) => e.uncertain) ? `, ${S.events.filter((e) => e.uncertain).length} to check` : "");
  const on = !!S.buffer;
  $("addWord").disabled = !on;
  for (const id of ["setTime", "minus", "plus", "playWord", "playSel", "del"]) $(id).disabled = !sel;
  $("reviewed").disabled = !sel; $("nextUnc").disabled = !S.events.some((e) => e.uncertain); $("sort").disabled = !has;
  refreshExport();
}
function select(id, mode) {
  if (mode === "one") { S.sel.clear(); S.sel.add(id); S.anchor = id; }
  else if (mode === "toggle") { S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id); S.anchor = id; }
  else if (mode === "range" && S.anchor != null) {
    const ids = S.events.map((e) => e.id), a = ids.indexOf(S.anchor), b = ids.indexOf(id);
    S.sel.clear(); for (let i = Math.min(a, b); i <= Math.max(a, b); i++) S.sel.add(ids[i]);
  } else { S.sel.clear(); S.sel.add(id); S.anchor = id; }
  repaint();
}
list.addEventListener("click", (e) => {
  const row = e.target.closest(".row"); if (!row) return;
  const id = Number(row.dataset.id);
  if (e.target.tagName === "INPUT") return;              // focusin handles it
  select(id, e.shiftKey ? "range" : e.ctrlKey || e.metaKey ? "toggle" : "one");
});
list.addEventListener("focusin", (e) => {
  const row = e.target.closest(".row"); if (!row || e.target.tagName !== "INPUT") return;
  const id = Number(row.dataset.id);
  if (!(S.sel.size === 1 && S.sel.has(id))) select(id, "one");
});
list.addEventListener("dblclick", (e) => {
  if (!e.target.classList.contains("idx")) return;
  const ev = evOf(Number(e.target.closest(".row").dataset.id)); if (ev) playFrom(ev.time);
});
list.addEventListener("change", (e) => {
  const row = e.target.closest(".row"); if (!row) return;
  const ev = evOf(Number(row.dataset.id)); if (!ev) return;
  if (e.target.classList.contains("t")) {
    try { ev.time = Math.min(parseTime(e.target.value), S.duration); ev.uncertain = false; ev.note = ""; }
    catch { toast("Time must be seconds like 12.5 or minutes like 1:02.50"); }
    e.target.value = ev.time.toFixed(2);
    S.ver++; repaint();
  } else if (e.target.classList.contains("w")) {
    const toks = normalizeText(e.target.value);
    if (!toks.length) { toast("A word needs at least one letter or number (a-z, 0-9)."); e.target.value = ev.text; return; }
    ev.text = toks[0]; ev.uncertain = false; ev.note = "";
    if (toks.length > 1) {                                  // "well-known" -> two words, spread over the gap
      const L = sortedEvents(), nxt = L[L.indexOf(ev) + 1];
      const gap = nxt ? Math.min(nxt.time - ev.time, toks.length * 0.5) : toks.length * 0.3;
      const at = S.events.indexOf(ev);
      const extra = toks.slice(1).map((t, i) => ({ id: S.nextId++, time: Math.round((ev.time + ((i + 1) * gap) / toks.length) * 1000) / 1000, text: t, uncertain: false, note: "" }));
      S.events.splice(at + 1, 0, ...extra);
      e.target.value = ev.text;                             // keeps a repeated change event harmless
      S.ver++; renderWords(); return;
    }
    e.target.value = ev.text; S.ver++; repaint();
  }
});

function playFrom(t) { S.region = null; wave.setRegion(null); audio.currentTime = Math.max(0, t); audio.play(); }
function selectedSorted() { return sortedEvents().filter((e) => S.sel.has(e.id)); }
$("playWord").onclick = () => { const s = selectedSorted(); if (s.length) playFrom(s[0].time - 0.15); };
$("playSel").onclick = () => {
  const s = selectedSorted(); if (!s.length) return;
  const L = sortedEvents(), nxt = L[L.indexOf(s[s.length - 1]) + 1];
  const a = Math.max(0, s[0].time - 0.15), b = nxt ? nxt.time : Math.min(S.duration, s[s.length - 1].time + 1);
  S.region = [a, b]; wave.setRegion(S.region); audio.currentTime = a; audio.play();
};
$("addWord").onclick = () => {
  const t = audio.currentTime || 0;
  const text = window.prompt(`Word to add at ${t.toFixed(2)}s (letters and numbers only):`, "");
  if (text === null) return;
  const toks = normalizeText(text); if (!toks.length) { toast("Nothing to add - use letters a-z or numbers."); return; }
  const added = toks.map((w, i) => ({ id: S.nextId++, time: Math.round((t + i * 0.25) * 1000) / 1000, text: w, uncertain: false, note: "" }));
  S.events.push(...added); S.events = sortEvents(S.events); S.ver++;
  S.sel = new Set(added.map((a) => a.id)); renderWords(); repaint();
  const row = rowOf(added[0].id); if (row) keepVisible(row);
};
$("setTime").onclick = () => {
  const s = selectedSorted(); if (!s.length) return;
  const d = (audio.currentTime || 0) - s[0].time;
  for (const e of s) { e.time = Math.max(0, Math.min(S.duration, Math.round((e.time + d) * 1000) / 1000)); e.uncertain = false; e.note = ""; }
  refreshTimes();
};
function nudge(d) {
  const s = selectedSorted(); if (!s.length) return;
  for (const e of s) { e.time = Math.max(0, Math.min(S.duration, Math.round((e.time + d) * 1000) / 1000)); e.uncertain = false; e.note = ""; }
  refreshTimes(); playFrom(s[0].time - 0.15);
}
$("minus").onclick = () => nudge(-NUDGE); $("plus").onclick = () => nudge(NUDGE);
function refreshTimes() {
  S.ver++;
  for (const row of list.querySelectorAll(".row")) { const e = evOf(Number(row.dataset.id)); if (e) row.querySelector(".t").value = e.time.toFixed(2); }
  repaint();
}
$("del").onclick = () => {
  if (!S.sel.size) return;
  S.events = S.events.filter((e) => !S.sel.has(e.id)); S.sel.clear(); S.ver++; renderWords();
};
$("sort").onclick = () => { S.events = sortEvents(S.events); S.ver++; renderWords(); toast("Sorted by time."); };
$("reviewed").onclick = () => { for (const id of S.sel) { const e = evOf(id); if (e) { e.uncertain = false; e.note = ""; } } repaint(); };
$("nextUnc").onclick = () => {
  const L = sortedEvents(), unc = L.filter((e) => e.uncertain); if (!unc.length) return;
  const cur = selectedSorted()[0], from = cur ? L.indexOf(cur) : -1;
  const nxt = L.slice(from + 1).find((e) => e.uncertain) || unc[0];
  select(nxt.id, "one");
  const row = rowOf(nxt.id); if (row) keepVisible(row);
  audio.currentTime = Math.max(0, nxt.time - 0.5); tick();
  wave.start = wave.clampStart(nxt.time - wave.span / 2); wave.draw();
};

// ------------------------------------------------------------------ export
$("expTitle").oninput = () => { if (!S.nameTouched) $("expName").value = sanitizeSongKey($("expTitle").value) + ".js"; refreshExport(); };
$("expName").oninput = () => { S.nameTouched = true; };
let currentJs = null;
function refreshExport() {
  const prob = $("problems"); currentJs = null;
  let js = "";
  try {
    js = renderJs(sortedEvents(), { duration: S.duration, title: $("expTitle").value });
    currentJs = js; prob.hidden = true;
  } catch (e) {
    if (e instanceof ExportError) {
      prob.hidden = !S.events.length && !$("expTitle").value;
      prob.innerHTML = ""; for (const p of e.problems.slice(0, 6)) { const li = document.createElement("li"); li.textContent = p; prob.appendChild(li); }
      if (e.problems.length > 6) { const li = document.createElement("li"); li.textContent = `...and ${e.problems.length - 6} more`; prob.appendChild(li); }
    } else throw e;
  }
  $("preview").value = js;
  $("dlJs").disabled = $("copyJs").disabled = !currentJs;
  updateAddonButtons();
}
$("dlJs").onclick = () => {
  if (!currentJs) return;
  try { download(new Blob([currentJs], { type: "text/javascript" }), normalizeFilename($("expName").value)); status("exportStatus", "Saved. Copy it to BehaviorPack/scripts/lyrics/, or use the addon builder below.", "ok"); }
  catch (e) { toast(e.message); }
};
$("copyJs").onclick = async () => { try { await navigator.clipboard.writeText(currentJs); toast("Copied."); } catch { $("preview").select(); toast("Select-all done - press copy."); } };

// ---- addon builder
$("addonFile").onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    S.addon = await openAddon(window.JSZip, await f.arrayBuffer());
    $("addonName").textContent = f.name; $("addonBox").hidden = false;
    renderSlots(); status("exportStatus", "");
  } catch (err) {
    S.addon = null; $("addonBox").hidden = true;
    status("exportStatus", err instanceof AddonError ? err.message : "Could not read the addon: " + err.message, "err");
  }
};
function renderSlots() {
  const box = $("slots"); box.querySelectorAll("label").forEach((l) => l.remove());
  const slots = S.addon.slots, firstFree = slots.find((s) => s.free);
  const add = (n, html, checked) => {
    const l = document.createElement("label");
    l.innerHTML = `<input type="radio" name="slot" value="${n}"${checked ? " checked" : ""}><span></span>`;
    l.querySelector("span").innerHTML = html; box.appendChild(l);
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  for (const s of slots) add(s.n, s.free ? `Slot ${String(s.n).padStart(2, "0")} <span class="free">free</span>` : `Slot ${String(s.n).padStart(2, "0")} <span class="used">${esc(s.title || "untitled")} (${s.words} words) - will be replaced</span>`, firstFree ? s === firstFree : false);
  const nn = slots.length + 1;
  add(nn, `Slot ${String(nn).padStart(2, "0")} <span class="free">new slot (added to the addon)</span>`, !firstFree);
  box.onchange = updateAddonButtons;
  updateAddonButtons();
}
function updateAddonButtons() {
  const ok = !!currentJs && !!S.buffer;
  $("buildAddon").disabled = !(ok && S.addon); $("dlOgg").disabled = !ok;

}
function isVorbisOgg(u8) {
  if (!looksLikeOgg(u8)) return false;
  const head = new TextDecoder("latin1").decode(u8.subarray(0, 120));
  return head.includes("vorbis");
}
async function getOgg() {
  const p = (f) => bar("barOut", Math.round(f * 100));
  // Manual stem mode always exports the rendered vocal + instrumental mix.
  if (S.manualMixBuffer) {
    status("exportStatus", "Encoding the vocal + instrumental mix to OGG..."); bar("barOut", 0);
    const ch = [];
    for (let i = 0; i < Math.min(2, S.manualMixBuffer.numberOfChannels); i++) ch.push(S.manualMixBuffer.getChannelData(i));
    return encodeOgg(ch, S.manualMixBuffer.sampleRate, p);
  }
  const u8 = new Uint8Array(S.bytes);
  if (isVorbisOgg(u8)) return u8; // unchanged original OGG when no manual stems were imported
  status("exportStatus", "Converting to OGG..."); bar("barOut", 0);
  const ch = []; for (let i = 0; i < S.buffer.numberOfChannels; i++) ch.push(S.buffer.getChannelData(i));
  return encodeOgg(ch.slice(0, 2), S.buffer.sampleRate, p);
}
$("dlOgg").onclick = async () => {
  try {
    const ogg = await getOgg();
    const base = sanitizeSongKey($("expTitle").value);
    download(new Blob([ogg], { type: "audio/ogg" }), base + ".ogg"); status("exportStatus", "Saved the .ogg.", "ok");
  } catch (e) { status("exportStatus", e.message, "err"); } finally { bar("barOut", null); }
};
$("buildAddon").onclick = async () => {
  if (!S.addon || !currentJs) return;
  const slot = Number(document.querySelector('input[name="slot"]:checked')?.value);
  $("buildAddon").disabled = true;
  try {
    const ogg = await getOgg();
    status("exportStatus", "Building addon..."); bar("barOut", -1);
    const out = await installSong(S.addon, { n: slot, js: currentJs, ogg });
    download(new Blob([out], { type: "application/octet-stream" }), "LyricGlyph_updated.mcaddon");
    status("exportStatus", `Done. Slot ${String(slot).padStart(2, "0")} now holds "${$("expTitle").value}". Import the downloaded .mcaddon into Minecraft.`, "ok");
    // re-open so the slot list reflects the new state if another song is added
    S.addon = await openAddon(window.JSZip, out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)); renderSlots();
  } catch (e) { status("exportStatus", e.message || String(e), "err"); }
  finally { bar("barOut", null); updateAddonButtons(); }
};

// ------------------------------------------------------------------ shortcuts + init
document.addEventListener("keydown", (e) => {
  const tag = (e.target.tagName || "").toLowerCase(), typing = tag === "input" || tag === "textarea" || tag === "select";
  if ((e.ctrlKey || e.metaKey) && e.code === "Space") { e.preventDefault(); togglePlay(); }
  else if (e.code === "Space" && !typing && tag !== "button") { e.preventDefault(); togglePlay(); }
  else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); $("playWord").click(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "e") { e.preventDefault(); $("dlJs").click(); }
});
refreshExport(); tick();
