import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { normalizeText, parseLyrics, parseLrc, alignLyrics, matchScore, eventsFromRaw, rankCandidates } from "../js/lyrics.js";
import { renderJs, ExportError, sanitizeSongKey, normalizeFilename } from "../js/exporter.js";
import { readTags, guessFromFilename } from "../js/tags.js";
import { openAddon, installSong, looksLikeOgg } from "../js/addon.js";
const JSZip = createRequire(import.meta.url)("../js/vendor/jszip.min.js");
let n = 0; const t = (name, fn) => Promise.resolve(fn()).then(() => { n++; console.log("  ok", name); });

await t("normalize", () => {
  assert.deepEqual(normalizeText("Don't-stop, Baby!"), ["dont", "stop", "baby"]);
  assert.deepEqual(parseLyrics("[Chorus]\nHello (oh) world"), ["hello", "oh", "world"]);
});
await t("lrc parse", () => {
  const l = parseLrc("[00:12.50] hello there\n[01:02.00]second line\nnope");
  assert.equal(l.length, 2); assert.equal(l[0].time, 12.5); assert.equal(l[1].time, 62);
});
await t("align: exact / approx / interpolated", () => {
  const lyr = parseLyrics("hello darkness my old friend i've come to talk with you again");
  const heard = [["hello", 1, 1.4], ["darkness", 1.5, 2], ["my", 2.1, 2.3], ["ol", 2.4, 2.7], ["friend", 2.8, 3.2],
    ["to", 5, 5.2], ["talk", 5.3, 5.6], ["with", 5.7, 5.9], ["you", 6, 6.3], ["again", 6.4, 7]]
    .map(([text, start, end]) => ({ text, start, end }));
  const r = alignLyrics(lyr, heard, 10);
  assert.equal(r.events.length, lyr.length);
  assert.equal(r.events.map((e) => e.text).join(" "), lyr.join(" "));               // text always kept
  assert.equal(r.events[0].time, 1); assert.equal(r.events[4].uncertain, false);
  assert.equal(r.events[3].uncertain, true);                                            // old vs ol
  const come = r.events[6]; assert.ok(come.time >= 3.2 && come.time <= 5, "interpolated between neighbours");
  assert.ok(r.interpolated >= 1 && r.approx === 1);
  for (let i = 1; i < r.events.length; i++) assert.ok(r.events[i].time >= r.events[i - 1].time);
});
await t("align: falls back to synced lines when nothing was heard", () => {
  const lyr = parseLyrics("one two three four five six");
  const lrc = parseLrc("[00:10.00] one two three\n[00:20.00] four five six");
  const r = alignLyrics(lyr, [{ text: "zzz", start: 1, end: 2 }], 40, lrc);
  assert.ok(r.fromLrc); assert.ok(r.events[0].time >= 10 && r.events[3].time >= 20 && r.events[2].time < 20);
});
await t("align: throws without anything heard and no lrc", () => {
  assert.throws(() => alignLyrics(["a", "b"], [], 10));
});
await t("matchScore prefers the right lyrics", () => {
  const heard = "hello darkness my old friend".split(" ").map((text, i) => ({ text, start: i, end: i + 0.5 }));
  assert.ok(matchScore(parseLyrics("hello darkness my old friend"), heard) > matchScore(parseLyrics("totally different words here"), heard));
});
await t("eventsFromRaw", () => {
  const r = eventsFromRaw([{ text: " Don't", start: 2, end: 2.4 }, { text: "...", start: 3, end: 3.1 }, { text: "Hi", start: 1, end: 1.2 }], 10);
  assert.deepEqual(r.events.map((e) => e.text), ["hi", "dont"]); assert.equal(r.dropped.length, 1);
});
await t("rankCandidates sorts by duration closeness", () => {
  const r = rankCandidates([{ id: 1, trackName: "A", artistName: "X", duration: 300, plainLyrics: "x" }, { id: 2, trackName: "A", artistName: "Y", duration: 201, plainLyrics: "x" }, { id: 3, instrumental: true }], 200);
  assert.equal(r[0].id, 2); assert.equal(r.length, 2);
});
await t("export matches addon format and validates", () => {
  const js = renderJs([{ time: 2.5, text: "hi" }, { time: 1, text: "yo" }], { duration: 10.2, title: "My Song" });
  assert.match(js, /format: "lyricglyph"/); assert.match(js, /title: "My Song"/); assert.match(js, /duration: 11,/);
  assert.ok(js.indexOf('"yo"') < js.indexOf('"hi"'));
  assert.throws(() => renderJs([{ time: 1, text: "Hi!" }], { duration: 5, title: "x" }), ExportError);
  assert.throws(() => renderJs([{ time: 9, text: "hi" }], { duration: 5, title: "x" }), ExportError);
  assert.throws(() => renderJs([], { duration: 5, title: "x" }), ExportError);
  assert.equal(sanitizeSongKey("My song!"), "My_song"); assert.equal(normalizeFilename("a"), "a.js");
});
await t("exported js is loadable by node (real ES module)", async () => {
  const js = renderJs([{ time: 1, text: "hi" }], { duration: 5, title: "T" });
  const p = "/tmp/_lf_export_test.mjs"; fs.writeFileSync(p, js);
  const m = await import(p); assert.equal(m.default.events[0].text, "hi"); assert.equal(m.default.format, "lyricglyph");
});
await t("filename + tag guessing", () => {
  assert.deepEqual(guessFromFilename("03 - Simon & Garfunkel - The Sound of Silence (Official Video).ogg"), { artist: "Simon & Garfunkel", title: "The Sound of Silence" });
  assert.deepEqual(guessFromFilename("From_The_Start.mp3"), { artist: "", title: "From The Start" });
});
await t("tags read from real ogg + mp3 made with ffmpeg", () => {
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=1", "-metadata", "title=Test Song", "-metadata", "artist=Test Artist", "/tmp/_t.ogg"]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=1", "-metadata", "title=Mp3 Song", "-metadata", "artist=Mp3 Artist", "-id3v2_version", "3", "/tmp/_t.mp3"]);
  const rd = (p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
  const o = readTags(rd("/tmp/_t.ogg"), "x.ogg"), m = readTags(rd("/tmp/_t.mp3"), "x.mp3");
  assert.deepEqual([o.title, o.artist], ["Test Song", "Test Artist"]);
  assert.deepEqual([m.title, m.artist], ["Mp3 Song", "Mp3 Artist"]);
  assert.ok(looksLikeOgg(new Uint8Array(rd("/tmp/_t.ogg"))));
});

// ---- addon patching against the user's REAL addon
const ADDON = "/mnt/user-data/attachments/6b81b32c-bda7-5b29-b71c-4a9a757ecd7f/8b2ed387-LyricGlyph.mcaddon";
if (fs.existsSync(ADDON)) {
const buf = fs.readFileSync(ADDON);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
await t("real addon: slots detected (4 used, 8 free)", async () => {
  const a = await openAddon(JSZip, ab);
  assert.equal(a.slots.length, 12);
  assert.equal(a.slots.filter((s) => !s.free).length, 4);
  assert.equal(a.slots[0].title, "From The Start"); assert.ok(a.slots[0].words > 100); assert.equal(a.slots[4].free, true);
});
await t("real addon: install into free slot 5, rest untouched", async () => {
  const a = await openAddon(JSZip, ab);
  const fakeOgg = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4]);
  const js = renderJs([{ time: 1, text: "hello" }], { duration: 30, title: "New Song" });
  const out = await installSong(a, { n: 5, js, ogg: fakeOgg });
  const z = await JSZip.loadAsync(out);
  assert.equal(await z.file("LyricGlyphBP/scripts/lyrics/song_05.js").async("string"), js);
  assert.deepEqual([...(await z.file("LyricGlyphRP/sounds/songs/song_05.ogg").async("uint8array"))], [...fakeOgg]);
  const orig = await JSZip.loadAsync(ab);
  for (const f of ["LyricGlyphBP/scripts/lyrics/song_01.js", "LyricGlyphRP/sounds/songs/song_01.ogg", "LyricGlyphBP/manifest.json"])
    assert.equal((await z.file(f).async("uint8array")).length, (await orig.file(f).async("uint8array")).length);
  assert.equal(Object.keys(z.files).length, Object.keys(orig.files).length);
  const b = await openAddon(JSZip, out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
  assert.equal(b.slots[4].title, "New Song");
});
await t("real addon: brand-new slot 13 is registered in index + sound defs", async () => {
  const a = await openAddon(JSZip, ab);
  const js = renderJs([{ time: 1, text: "hello" }], { duration: 30, title: "Thirteen" });
  const out = await installSong(a, { n: 13, js, ogg: new Uint8Array([0x4f, 0x67, 0x67, 0x53]) });
  const z = await JSZip.loadAsync(out);
  const idx = await z.file("LyricGlyphBP/scripts/songs_index.js").async("string");
  assert.match(idx, /import lyrics_13 from "\.\/lyrics\/song_13\.js";/); assert.match(idx, /lyrics_12,\n\s+lyrics_13\n\];/);
  const defs = JSON.parse(await z.file("LyricGlyphRP/sounds/sound_definitions.json").async("string"));
  assert.ok(defs.sound_definitions["lyricglyph.song.song_13"]);
  // the patched index must still be valid JS that yields 5 visible songs
  fs.mkdirSync("/tmp/_idx/lyrics", { recursive: true });
  fs.writeFileSync("/tmp/_idx/songs_index.js", idx);
  for (let i = 1; i <= 13; i++) {
    const k = String(i).padStart(2, "0"); const f = z.file(`LyricGlyphBP/scripts/lyrics/song_${k}.js`);
    fs.writeFileSync(`/tmp/_idx/lyrics/song_${k}.js`, f ? await f.async("string") : "export default {};");
  }
  const m = await import("/tmp/_idx/songs_index.js?x=" + Date.now());
  assert.equal(m.SONG_LIST.length, 5); assert.equal(m.SONG_LIST[4].title, "Thirteen");
});
} else {
  console.log("  skip real-addon integration tests (optional user addon fixture is not mounted)");
}
console.log(`\n${n} tests passed`);
