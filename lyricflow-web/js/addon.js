// Patches a LyricGlyph .mcaddon (a zip holding the behaviour pack + resource pack):
//   song audio  -> <RP>/sounds/songs/song_NN.ogg
//   lyrics file -> <BP>/scripts/lyrics/song_NN.js
// and, when a brand-new slot is needed, registers it in songs_index.js and sound_definitions.json.

const pad = (n) => String(n).padStart(2, "0");
const keyOf = (n) => `song_${pad(n)}`;

export class AddonError extends Error {}

function findRoots(zip) {
  let bp = null, rp = null;
  for (const name of Object.keys(zip.files)) {
    if (!name.endsWith("manifest.json") || zip.files[name].dir) continue;
    const root = name.slice(0, name.length - "manifest.json".length);
    zip.__manifests = zip.__manifests || [];
    zip.__manifests.push([root, name]);
  }
  return Promise.all((zip.__manifests || []).map(async ([root, name]) => {
    try {
      const m = JSON.parse(await zip.file(name).async("string"));
      const types = (m.modules || []).map((x) => x.type);
      if (types.includes("script") || types.includes("data")) bp = bp ?? root;
      else if (types.includes("resources")) rp = rp ?? root;
    } catch { /* ignore unreadable manifests */ }
  })).then(() => ({ bp, rp }));
}

export async function openAddon(JSZip, arrayBuffer) {
  let zip;
  try { zip = await JSZip.loadAsync(arrayBuffer); }
  catch { throw new AddonError("This file is not a valid .mcaddon / .zip."); }
  const { bp, rp } = await findRoots(zip);
  if (bp === null || rp === null) throw new AddonError("Could not find both the behaviour pack and the resource pack inside this addon.");
  const slots = [];
  for (let n = 1; n < 500; n++) {
    const jsFile = zip.file(`${bp}scripts/lyrics/${keyOf(n)}.js`);
    if (!jsFile) break;
    const src = await jsFile.async("string");
    const title = (src.match(/title:\s*"((?:[^"\\]|\\.)*)"/) || [])[1] || "";
    const words = (src.match(/\{\s*time:/g) || []).length;
    const hasAudio = !!zip.file(`${rp}sounds/songs/${keyOf(n)}.ogg`);
    slots.push({ n, key: keyOf(n), title, words, hasAudio, free: !title && !words });
  }
  if (!slots.length) throw new AddonError("No song slots (scripts/lyrics/song_NN.js) were found in this addon.");
  const idx = zip.file(`${bp}scripts/songs_index.js`);
  if (!idx) throw new AddonError("scripts/songs_index.js is missing, so new slots cannot be registered.");
  return { zip, bp, rp, slots };
}

function addSlotToIndex(src, n) {
  const k = pad(n);
  const importLine = `import lyrics_${k} from "./lyrics/song_${k}.js";`;
  if (src.includes(importLine)) return src;
  const imports = [...src.matchAll(/^import .*$/gm)];
  if (!imports.length) throw new AddonError("songs_index.js has an unexpected layout (no imports found).");
  const last = imports[imports.length - 1];
  src = src.slice(0, last.index + last[0].length) + "\n" + importLine + src.slice(last.index + last[0].length);
  const m = src.match(/const SLOTS = \[([\s\S]*?)\n\];/);
  if (!m) throw new AddonError("songs_index.js has an unexpected layout (SLOTS list not found).");
  const body = m[1].replace(/\s+$/, "");
  return src.replace(m[0], `const SLOTS = [${body},\n    lyrics_${k}\n];`);
}

/**
 * @param {object} addon result of openAddon
 * @param {{n:number, js:string, ogg:Uint8Array}} song
 * @returns {Promise<Uint8Array>} the patched .mcaddon
 */
export async function installSong(addon, { n, js, ogg }) {
  const { zip, bp, rp, slots } = addon;
  if (!(n >= 1)) throw new AddonError("Pick a slot.");
  if (n > slots.length + 1) throw new AddonError("New slots must be added one after another.");
  zip.file(`${bp}scripts/lyrics/${keyOf(n)}.js`, js);
  zip.file(`${rp}sounds/songs/${keyOf(n)}.ogg`, ogg, { compression: "STORE" });
  if (n > slots.length) {
    const idxPath = `${bp}scripts/songs_index.js`;
    zip.file(idxPath, addSlotToIndex(await zip.file(idxPath).async("string"), n));
    const defPath = `${rp}sounds/sound_definitions.json`;
    const defs = JSON.parse(await zip.file(defPath).async("string"));
    defs.sound_definitions = defs.sound_definitions || {};
    defs.sound_definitions[`lyricglyph.song.${keyOf(n)}`] = { category: "music", sounds: [{ name: `sounds/songs/${keyOf(n)}`, stream: true }] };
    zip.file(defPath, JSON.stringify(defs, null, 2));
  } else {
    const defPath = `${rp}sounds/sound_definitions.json`;
    const defs = JSON.parse(await zip.file(defPath).async("string"));
    const id = `lyricglyph.song.${keyOf(n)}`;
    if (!defs.sound_definitions || !defs.sound_definitions[id]) {
      defs.sound_definitions = defs.sound_definitions || {};
      defs.sound_definitions[id] = { category: "music", sounds: [{ name: `sounds/songs/${keyOf(n)}`, stream: true }] };
      zip.file(defPath, JSON.stringify(defs, null, 2));
    }
  }
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

/** Ogg container check: files must start with "OggS". */
export function looksLikeOgg(u8) {
  return u8.length > 4 && u8[0] === 0x4f && u8[1] === 0x67 && u8[2] === 0x67 && u8[3] === 0x53;
}
