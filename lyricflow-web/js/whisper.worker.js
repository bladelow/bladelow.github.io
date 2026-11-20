// Speech recognition in a Web Worker using transformers.js (Whisper, runs locally in the browser).
// The library and model files download once from the CDN / Hugging Face and are cached by the browser.
const LIB = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3";
const SR = 16000;

const post = (pct, msg) => self.postMessage({ type: "progress", pct, msg });

/** Cut into <=30 s pieces, preferring the quietest spot near each boundary so words are not split. */
function planSlices(x, target = 27, search = 3) {
  const slices = [];
  let start = 0;
  while (start < x.length) {
    let end = start + target * SR;
    if (end >= x.length) end = x.length;
    else {
      let best = end, bestE = Infinity;
      const frame = Math.floor(SR * 0.05);
      for (let p = end - search * SR; p <= end + search * SR - frame; p += frame) {
        let e = 0;
        for (let i = p; i < p + frame; i++) e += x[i] * x[i];
        if (e < bestE) { bestE = e; best = p + (frame >> 1); }
      }
      end = best;
    }
    slices.push([start, end]);
    start = end;
  }
  if (slices.length > 1) {                       // fold a tiny tail into the previous piece
    const last = slices[slices.length - 1];
    if (last[1] - last[0] < SR * 0.5) { slices.pop(); slices[slices.length - 1][1] = last[1]; }
  }
  return slices;
}

function rms(x, a, b) { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); }

self.onmessage = async (e) => {
  if (e.data.type !== "run") return;
  const { samples, model, device } = e.data;
  try {
    post(-1, "Loading speech engine...");
    const tf = await import(LIB);
    post(-1, "Speech engine loaded. Preparing model download...");
    const useGpu = device === "webgpu";
    const files = new Map();
    const asr = await tf.pipeline("automatic-speech-recognition", model, {
      device: useGpu ? "webgpu" : "wasm",
      dtype: useGpu ? { encoder_model: "fp32", decoder_model_merged: "q4" } : "q8",
      progress_callback: (p) => {
        if (p.status === "initiate") post(-1, `Preparing ${p.file || "speech model files"}...`);
        else if (p.status === "download") post(-1, `Downloading ${p.file || "speech model file"}...`);
        else if (p.status === "progress" && p.file) {
          files.set(p.file, p.progress || 0);
          const avg = [...files.values()].reduce((a, b) => a + b, 0) / files.size;
          post(-1, `Downloading speech model... ${Math.round(avg)}%`);
        } else if (p.status === "done") post(-1, `Loaded ${p.file || "model file"}...`);
      },
    });
    const slices = planSlices(samples);
    const words = [];
    for (let i = 0; i < slices.length; i++) {
      const [a, b] = slices[i];
      post(Math.round((i / slices.length) * 100), `Listening... ${i + 1}/${slices.length}`);
      if (rms(samples, a, b) < 1e-4) continue;                  // silence: skip, avoids invented words
      const out = await asr(samples.subarray(a, b), { return_timestamps: "word", chunk_length_s: 30 });
      const offset = a / SR;
      for (const c of out.chunks || []) {
        const text = (c.text || "").trim();
        if (!text) continue;
        const s = c.timestamp && c.timestamp[0] != null ? c.timestamp[0] : null;
        if (s == null) continue;
        const en = c.timestamp[1] != null ? c.timestamp[1] : s + 0.3;
        words.push({ text, start: offset + s, end: offset + en, probability: null });
      }
    }
    post(100, `Finished: ${words.length} words heard.`);
    self.postMessage({ type: "done", words });
  } catch (err) {
    self.postMessage({ type: "error", message: String((err && err.message) || err) });
  }
};
