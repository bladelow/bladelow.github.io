// Tiny tag readers (ID3v2 for MP3, Vorbis/Opus comments for OGG) + filename guessing.
// Used only to pre-fill the song title / artist for the online lyrics search.

function decode(bytes, enc) {
  try {
    if (enc === 0) return new TextDecoder("latin1").decode(bytes);
    if (enc === 1) {
      if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
      if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
      return new TextDecoder("utf-16le").decode(bytes);
    }
    if (enc === 2) return new TextDecoder("utf-16be").decode(bytes);
    return new TextDecoder("utf-8").decode(bytes);
  } catch { return ""; }
}
const clean = (s) => String(s || "").replace(/\0/g, "").trim();

function readId3(u8) {
  if (u8.length < 10 || u8[0] !== 0x49 || u8[1] !== 0x44 || u8[2] !== 0x33) return null;
  const ver = u8[3];
  const size = (u8[6] << 21) | (u8[7] << 14) | (u8[8] << 7) | u8[9];
  const end = Math.min(u8.length, 10 + size);
  const out = {};
  let p = 10;
  const idLen = ver === 2 ? 3 : 4, hdr = ver === 2 ? 6 : 10;
  while (p + hdr < end) {
    const id = String.fromCharCode(...u8.subarray(p, p + idLen));
    if (!/^[A-Z0-9]+$/.test(id)) break;
    let fsize;
    if (ver === 2) fsize = (u8[p + 3] << 16) | (u8[p + 4] << 8) | u8[p + 5];
    else if (ver === 4) fsize = (u8[p + 4] << 21) | (u8[p + 5] << 14) | (u8[p + 6] << 7) | u8[p + 7];
    else fsize = ((u8[p + 4] << 24) | (u8[p + 5] << 16) | (u8[p + 6] << 8) | u8[p + 7]) >>> 0;
    if (!fsize || p + hdr + fsize > end) break;
    const data = u8.subarray(p + hdr, p + hdr + fsize);
    if (id === "TIT2" || id === "TT2") out.title = clean(decode(data.subarray(1), data[0]));
    if (id === "TPE1" || id === "TP1") out.artist = clean(decode(data.subarray(1), data[0]));
    p += hdr + fsize;
  }
  return out;
}

function readVorbisComments(u8) {
  const limit = Math.min(u8.length, 262144);
  const find = (needle) => {
    outer: for (let i = 0; i < limit - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) if (u8[i + j] !== needle.charCodeAt(j)) continue outer;
      return i + needle.length;
    }
    return -1;
  };
  let p = find("\x03vorbis");
  if (p < 0) p = find("OpusTags");
  if (p < 0) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = {};
  try {
    p += 4 + dv.getUint32(p, true);
    const count = dv.getUint32(p, true); p += 4;
    for (let i = 0; i < count && i < 200; i++) {
      const len = dv.getUint32(p, true); p += 4;
      if (len > 4096 || p + len > u8.length) break;
      const s = new TextDecoder().decode(u8.subarray(p, p + len)); p += len;
      const eq = s.indexOf("=");
      if (eq < 0) continue;
      const k = s.slice(0, eq).toUpperCase(), v = clean(s.slice(eq + 1));
      if (k === "TITLE") out.title = v;
      if (k === "ARTIST") out.artist = v;
    }
  } catch { /* cover art can split the header across pages; fall back to the filename */ }
  return out;
}

export function guessFromFilename(name) {
  let s = String(name || "").replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[_]+/g, " ");
  s = s.replace(/[\[(][^\])]*(official|lyric|video|audio|hd|hq|remaster)[^\])]*[\])]/gi, " ");
  s = s.replace(/^\s*\d{1,3}\s*[-.)]\s*/, "").replace(/\s+/g, " ").trim();
  const parts = s.split(/\s+-\s+/);
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(" - ").trim() };
  return { artist: "", title: s };
}

export function readTags(arrayBuffer, filename) {
  const u8 = new Uint8Array(arrayBuffer, 0, Math.min(arrayBuffer.byteLength, 1 << 20));
  let tags = null;
  try { tags = readId3(u8) || readVorbisComments(u8); } catch { tags = null; }
  const guess = guessFromFilename(filename);
  return {
    title: (tags && tags.title) || guess.title,
    artist: (tags && tags.artist) || guess.artist,
    fromTags: !!(tags && tags.title),
  };
}
