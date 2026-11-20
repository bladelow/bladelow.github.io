// Lyrics text handling, alignment against recognised words, and online lookup (LRCLIB).
// Pure logic - no DOM - so it can be unit-tested in Node.

export function normalizeText(raw) {
  let s = String(raw || "").normalize("NFKD");
  s = s.replace(/[^\x00-\x7f]/g, "").toLowerCase().replace(/['’]/g, "");
  s = s.replace(/[^a-z0-9]+/g, " ").trim();
  return s ? s.split(" ") : [];
}

const SECTION_RE = /\[[^\]]*\]/g;
export function parseLyrics(text) {
  return normalizeText(String(text || "").replace(SECTION_RE, " "));
}

/** "[01:23.45] some words" -> [{time, text}] */
export function parseLrc(lrc) {
  const out = [];
  for (const line of String(lrc || "").split(/\r?\n/)) {
    const m = line.match(/^((?:\[\d+:\d+(?:[.:]\d+)?\])+)\s*(.*)$/);
    if (!m) continue;
    const text = m[2].trim();
    for (const t of m[1].matchAll(/\[(\d+):(\d+)(?:[.:](\d+))?\]/g)) {
      const frac = t[3] ? Number("0." + t[3]) : 0;
      out.push({ time: Number(t[1]) * 60 + Number(t[2]) + frac, text });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

// ---- LCS diff between two token arrays -> list of [i, j] matched pairs
function lcsPairs(a, b) {
  const n = a.length, m = b.length, w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const pairs = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return pairs;
}

export const TRAILING_SPACING = 0.3;

/**
 * Time the user's / online lyrics against recognised words.
 * Lyric text is always kept exactly; recognised words only supply timing.
 * @param {string[]} lyrics normalised lyric words
 * @param {{text:string,start:number,end:number,probability?:number|null}[]} rawWords
 * @param {number} duration seconds
 * @param {{time:number,text:string}[]=} lrc optional synced lines, used as a fallback timing source
 */
export function alignLyrics(lyrics, rawWords, duration, lrc) {
  if (!lyrics.length) throw new Error("No lyrics to align.");
  const heard = [];
  for (const w of rawWords) {
    const toks = normalizeText(w.text);
    if (!toks.length || !Number.isFinite(w.start) || !Number.isFinite(w.end)) continue;
    const s = Math.min(Math.max(0, w.start), duration);
    const e = Math.min(Math.max(w.end, s), duration);
    const step = (e - s) / toks.length;
    toks.forEach((t, i) => heard.push({ t, s: s + i * step, e: s + (i + 1) * step }));
  }
  const n = lyrics.length;
  const start = new Array(n).fill(null), end = new Array(n).fill(null), kind = new Array(n).fill(null);

  if (heard.length) {
    const pairs = lcsPairs(lyrics, heard.map((h) => h.t));
    for (const [i, j] of pairs) { start[i] = heard[j].s; end[i] = heard[j].e; kind[i] = "exact"; }
    // gaps between matches: same-size gaps are "replaced" words (heard differently)
    let pi = 0, pj = 0;
    const gaps = [...pairs, [n, heard.length]];
    for (const [i, j] of gaps) {
      const cntL = i - pi, cntH = j - pj;
      if (cntL > 0 && cntH > 0) {
        if (cntL === cntH) {
          for (let k = 0; k < cntL; k++) { start[pi + k] = heard[pj + k].s; end[pi + k] = heard[pj + k].e; kind[pi + k] = "approx"; }
        } else {
          const s0 = heard[pj].s, e0 = heard[j - 1].e, step = (e0 - s0) / cntL;
          for (let k = 0; k < cntL; k++) { start[pi + k] = s0 + k * step; end[pi + k] = s0 + (k + 1) * step; kind[pi + k] = "approx"; }
        }
      }
      pi = i + 1; pj = j + 1;
    }
  }

  const matched = kind.filter((k) => k === "exact").length;
  const usableMatch = matched >= Math.max(3, n * 0.15);
  if (!usableMatch) {
    if (lrc && lrc.length) return alignFromLrc(lyrics, lrc, duration);
    if (!matched && !kind.some(Boolean)) throw new Error("The lyrics did not match anything that was heard, so they could not be timed.");
  }

  // words nobody heard: spread evenly between their neighbours
  for (let i = 0; i < n;) {
    if (start[i] !== null) { i++; continue; }
    let j = i;
    while (j < n && start[j] === null) j++;
    const cnt = j - i;
    const lo = i > 0 ? end[i - 1] : 0;
    let hi = j < n ? start[j] : Math.min(duration, lo + cnt * TRAILING_SPACING);
    hi = Math.max(hi, lo);
    const step = (hi - lo) / cnt;
    for (let k = 0; k < cnt; k++) { start[i + k] = lo + k * step; end[i + k] = lo + (k + 1) * step; kind[i + k] = "interp"; }
    i = j;
  }

  return finish(lyrics, start, kind, duration);
}

function finish(lyrics, start, kind, duration) {
  const res = { events: [], exact: 0, approx: 0, interpolated: 0 };
  let prev = 0;
  lyrics.forEach((word, idx) => {
    const t = Math.round(Math.min(Math.max(start[idx], prev), duration) * 1000) / 1000;
    prev = t;
    const k = kind[idx];
    if (k === "exact") { res.exact++; res.events.push({ time: t, text: word, uncertain: false, note: "" }); }
    else if (k === "approx") { res.approx++; res.events.push({ time: t, text: word, uncertain: true, note: "approximate match - check" }); }
    else { res.interpolated++; res.events.push({ time: t, text: word, uncertain: true, note: "estimated - check" }); }
  });
  return res;
}

/** Fallback when almost nothing was heard: use the synced line times from the lyrics site. */
export function alignFromLrc(lyrics, lrc, duration) {
  const lines = lrc.map((l) => ({ time: l.time, words: normalizeText(l.text.replace(SECTION_RE, " ")) })).filter((l) => l.words.length);
  const flat = lines.flatMap((l) => l.words);
  // map the user's words onto the lines by LCS so edits of the text still land on the right line
  const start = new Array(lyrics.length).fill(null), kind = new Array(lyrics.length).fill(null);
  let pos = 0;
  const lineOfFlat = [];
  lines.forEach((l, li) => l.words.forEach((_, wi) => lineOfFlat.push([li, wi])));
  const pairs = lcsPairs(lyrics, flat);
  for (const [i, j] of pairs) {
    const [li, wi] = lineOfFlat[j];
    const l = lines[li];
    const next = lines[li + 1] ? lines[li + 1].time : Math.min(duration, l.time + l.words.length * 0.5);
    const span = Math.max(0.2, Math.min(next - l.time, l.words.length * 0.8));
    start[i] = l.time + (wi / l.words.length) * span;
    kind[i] = "approx";
  }
  for (let i = 0; i < lyrics.length;) {
    if (start[i] !== null) { i++; continue; }
    let j = i;
    while (j < lyrics.length && start[j] === null) j++;
    const lo = i > 0 ? start[i - 1] : 0;
    const hi = j < lyrics.length ? start[j] : Math.min(duration, lo + (j - i) * TRAILING_SPACING);
    for (let k = 0; k < j - i; k++) { start[i + k] = lo + ((hi - lo) * (k + 1)) / (j - i + 1); kind[i + k] = "interp"; }
    i = j;
  }
  void pos;
  const res = finish(lyrics, start, kind, duration);
  res.fromLrc = true;
  return res;
}

/** How well do these lyrics match what was heard? 0..1 (used to pick the right song among candidates). */
export function matchScore(lyrics, rawWords) {
  const heard = rawWords.flatMap((w) => normalizeText(w.text));
  if (!lyrics.length || !heard.length) return 0;
  const pairs = lcsPairs(lyrics, heard);
  return pairs.length / Math.max(heard.length, Math.min(lyrics.length, heard.length * 2));
}

/** Words straight from the recogniser (no lyrics pasted). Confidence is unknown, so only odd timings are flagged. */
export function eventsFromRaw(rawWords, duration) {
  const events = [];
  const dropped = [];
  for (const w of rawWords) {
    const toks = normalizeText(w.text);
    if (!toks.length || !Number.isFinite(w.start)) { dropped.push((w.text || "").trim() || "(empty)"); continue; }
    const s = Math.min(Math.max(0, w.start), duration);
    const e = Number.isFinite(w.end) ? Math.min(Math.max(w.end, s), duration) : s;
    const step = (e - s) / toks.length;
    const odd = e - s < 0.03 || (w.probability != null && w.probability < 0.5);
    toks.forEach((t, i) => events.push({
      time: Math.round((s + i * step) * 1000) / 1000, text: t,
      uncertain: odd, note: odd ? "odd timing - check" : "",
    }));
  }
  events.sort((a, b) => a.time - b.time);
  return { events, dropped };
}

// ------------------------------------------------------------------ online lookup (LRCLIB)
const LRCLIB = "https://lrclib.net/api";

async function lrclibSearch(params, signal) {
  const res = await fetch(`${LRCLIB}/search?${new URLSearchParams(params)}`, { signal });
  if (!res.ok) throw new Error(`Lyrics site answered ${res.status}.`);
  return res.json();
}

/** Search by title (+ artist). Returns candidates sorted by closeness to the audio length. */
export async function findLyricsOnline({ title, artist, duration }, signal) {
  if (!title && !artist) throw new Error("Enter a song title first.");
  let list = [];
  if (title && artist) list = await lrclibSearch({ track_name: title, artist_name: artist }, signal);
  if (!list.length) list = await lrclibSearch({ q: [artist, title].filter(Boolean).join(" ") }, signal);
  return rankCandidates(list, duration);
}

export function rankCandidates(list, duration) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .filter((c) => c && !c.instrumental && (c.plainLyrics || c.syncedLyrics))
    .map((c) => ({
      id: c.id, title: c.trackName || c.name || "", artist: c.artistName || "", album: c.albumName || "",
      duration: Number(c.duration) || 0,
      diff: duration && c.duration ? Math.abs(Number(c.duration) - duration) : null,
      plain: c.plainLyrics || (c.syncedLyrics ? parseLrc(c.syncedLyrics).map((l) => l.text).join("\n") : ""),
      synced: c.syncedLyrics || "",
    }))
    .filter((c) => { const key = `${c.artist}|${c.title}|${Math.round(c.duration)}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((a, b) => (a.diff ?? 999) - (b.diff ?? 999) || Number(!!b.synced) - Number(!!a.synced))
    .slice(0, 8);
}

/** Optional: identify a song by listening (AudD). Needs the user's own free API token. */
export async function identifyByAudio(wavBlob, token, signal) {
  const fd = new FormData();
  fd.append("api_token", token);
  fd.append("file", wavBlob, "clip.wav");
  const res = await fetch("https://api.audd.io/", { method: "POST", body: fd, signal });
  if (!res.ok) throw new Error(`Recognition service answered ${res.status}.`);
  const json = await res.json();
  if (json.status !== "success") throw new Error(json.error?.error_message || "Recognition failed.");
  if (!json.result) return null;
  return { title: json.result.title, artist: json.result.artist };
}
