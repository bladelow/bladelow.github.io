// Browser audio helpers: decode, resample, waveform peaks, WAV encode, OGG encode.
export async function decodeFile(file) {
  const bytes = await file.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    const buffer = await ctx.decodeAudioData(bytes.slice(0));
    return { bytes, buffer };
  } catch {
    throw new Error("This browser cannot decode that audio. Try Chrome/Firefox, or convert the song to MP3/WAV first.");
  } finally { ctx.close && ctx.close(); }
}

/** Resample (and up/down-mix) an AudioBuffer using the browser's own high-quality resampler. */
export async function resample(buffer, rate, channels) {
  const frames = Math.max(1, Math.ceil(buffer.duration * rate));
  const off = new OfflineAudioContext(channels, frames, rate);
  const src = off.createBufferSource();
  src.buffer = buffer; src.connect(off.destination); src.start();
  return off.startRendering();
}

export function mixToMono(l, r) {
  if (!r || r === l) return l;
  const out = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) out[i] = (l[i] + r[i]) / 2;
  return out;
}

export function computePeaks(mono, rate, perSecond = 100) {
  const bin = Math.max(1, Math.floor(rate / perSecond));
  const n = Math.floor(mono.length / bin);
  const peaks = new Float32Array(Math.max(1, n));
  let top = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = i * bin; j < (i + 1) * bin; j++) { const a = Math.abs(mono[j]); if (a > m) m = a; }
    peaks[i] = m; if (m > top) top = m;
  }
  if (top > 0) for (let i = 0; i < n; i++) peaks[i] /= top;
  return { peaks, perSecond: rate / bin };
}

export function encodeWav(channels, rate) {
  const n = channels[0].length, ch = channels.length;
  const buf = new ArrayBuffer(44 + n * ch * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * ch * 2, true); w(8, "WAVEfmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, n * ch * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const s = Math.max(-1, Math.min(1, channels[c][i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
  }
  return new Blob([buf], { type: "audio/wav" });
}

const ENCODER_URL = "https://cdn.jsdelivr.net/npm/wasm-media-encoders@0.6.0/+esm";
/** Encode PCM channels to OGG Vorbis (needed because Minecraft only plays .ogg). Loaded on demand. */
export async function encodeOgg(channels, sampleRate, onProgress) {
  let mod;
  try { mod = await import(ENCODER_URL); }
  catch { throw new Error("Could not load the OGG encoder (needs internet once). Convert the song to .ogg yourself and import that file instead."); }
  const enc = await mod.createOggEncoder();
  enc.configure({ channels: channels.length, sampleRate });
  const parts = [];
  const CH = 48000;
  for (let i = 0; i < channels[0].length; i += CH) {
    parts.push(enc.encode(channels.map((c) => c.subarray(i, i + CH))).slice());
    if (onProgress && (i / CH) % 40 === 0) { onProgress(i / channels[0].length); await new Promise((r) => setTimeout(r)); }
  }
  parts.push(enc.finalize().slice());
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
