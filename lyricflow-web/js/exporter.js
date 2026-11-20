// Generates the LyricGlyph lyrics ES module (same shape as scripts/lyrics/song_NN.js in the addon).
const WORD_RE = /^[a-z0-9]+$/;
const TIME_TOLERANCE = 0.05;

export class ExportError extends Error {
  constructor(problems) { super(problems.join("\n")); this.problems = problems; }
}

export function sanitizeSongKey(text) {
  const s = String(text || "").trim().replace(/\s+/g, "_").replace(/[^A-Za-z0-9_-]/g, "");
  return s || "song";
}

export function normalizeFilename(name) {
  const n = String(name || "").trim().replace(/[\\/:*?"<>|]/g, "_");
  if (!n || n === ".js") throw new ExportError(["Output filename is empty."]);
  return n.toLowerCase().endsWith(".js") ? n : n + ".js";
}

export function validateEvents(events, duration) {
  const problems = [];
  events.forEach((e, idx) => {
    const label = `Word #${idx + 1} ('${e.text}')`;
    if (typeof e.text !== "string" || !WORD_RE.test(e.text)) problems.push(`${label}: text must be one word using only a-z and 0-9.`);
    if (typeof e.time !== "number" || !Number.isFinite(e.time)) { problems.push(`${label}: timestamp is not a valid number.`); return; }
    if (e.time < 0) problems.push(`${label}: timestamp ${e.time.toFixed(2)}s is negative.`);
    if (duration != null && e.time > duration + TIME_TOLERANCE) problems.push(`${label}: timestamp ${e.time.toFixed(2)}s is after the end of the audio (${duration.toFixed(2)}s).`);
  });
  return problems;
}

export function sortEvents(events) {
  return events.map((e, i) => [e, i]).sort((a, b) => a[0].time - b[0].time || a[1] - b[1]).map((p) => p[0]);
}

export function renderJs(events, { duration, title } = {}) {
  const problems = [];
  if (!events.length) problems.push("There are no lyrics to export.");
  if (!title || !String(title).trim()) problems.push("Enter a song title.");
  problems.push(...validateEvents(events, duration));
  if (problems.length) throw new ExportError(problems);
  const body = sortEvents(events).map((e) => `        { time: ${e.time.toFixed(2)}, text: ${JSON.stringify(e.text)} }`).join(",\n");
  const js =
    "export default {\n" +
    '    format: "lyricglyph",\n' +
    "    version: 1,\n\n" +
    `    title: ${JSON.stringify(String(title).trim())},\n` +
    `    duration: ${Math.floor(duration) + 1},\n\n` +
    '    sync: "word",\n\n' +
    "    events: [\n" + body + "\n    ]\n" +
    "};\n";
  const found = (js.match(/\{ time: [0-9.]+, text: "[a-z0-9]+" \}/g) || []).length;
  if (found !== events.length) throw new ExportError(["Internal check failed: generated JavaScript is malformed."]);
  return js;
}
