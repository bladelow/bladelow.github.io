import { world, system, ItemTypes, MolangVariableMap } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { structures } from "./structures/index.js";
import config from "./config.js";

// ---------- Settings ----------
const GHOST_MODE = config.mode !== "particle";   // "ghost" = ghost block entity, "particle" = particle preview
const GHOST_PREFIX = "ghost:";
const WRONG_PARTICLE = "minecraft:villager_angry"; // marks wrongly placed blocks
const WRONG_RADIUS = 7, WRONG_MAX = 100;
const DOT_RADIUS = 6, DOT_MAX = 120;               // particle mode: dots for missing blocks
const DOT_PARTICLE = "minecraft:colored_flame_particle";
const LINE_PARTICLE = "minecraft:endrod";

// ---------- Per-player state ----------
const state = new Map();
function st(p) {
  if (!state.has(p.id)) {
    state.set(p.id, {
      name: null, rot: 0, locked: false, anchor: null, show: true, auto: true,
      layer: null, lastKey: null,
      ghost: null, ghostName: null, ghostDim: null, layerSent: undefined, rotSent: undefined, sig: null,
    });
  }
  return state.get(p.id);
}

// Blocks whose item id differs from the block id (extend as needed)
const ITEM_MAP = {
  "minecraft:redstone_wire": "minecraft:redstone",
  "minecraft:standing_sign": "minecraft:oak_sign",
  "minecraft:wall_sign": "minecraft:oak_sign",
  "minecraft:unpowered_repeater": "minecraft:repeater",
  "minecraft:powered_repeater": "minecraft:repeater",
  "minecraft:unpowered_comparator": "minecraft:comparator",
  "minecraft:powered_comparator": "minecraft:comparator",
  "minecraft:flowing_water": "minecraft:water_bucket",
  "minecraft:water": "minecraft:water_bucket",
  "minecraft:flowing_lava": "minecraft:lava_bucket",
  "minecraft:lava": "minecraft:lava_bucket",
  "minecraft:lit_furnace": "minecraft:furnace",
  "minecraft:wheat": "minecraft:wheat_seeds",
};

const short = (id) => id.replace("minecraft:", "");
const isAirName = (n) => n === "minecraft:air" || n === "minecraft:structure_void";

function footprint(s, rot) {
  const [w, h, d] = s.size;
  return rot % 2 === 0 ? [w, h, d] : [d, h, w];
}

function countMaterials(s) {
  const c = {};
  for (const i of s.blocks) {
    if (i < 0) continue;
    const n = s.palette[i].name;
    if (isAirName(n)) continue;
    c[n] = (c[n] || 0) + 1;
  }
  return c;
}

// Palette index at a position inside the rotated blueprint (-1 = air / outside)
function idxAt(s, rot, lx, ly, lz) {
  const [w, h, d] = s.size;
  let x, z;
  switch (rot) {
    case 0: x = lx; z = lz; break;
    case 1: x = lz; z = d - 1 - lx; break;
    case 2: x = w - 1 - lx; z = d - 1 - lz; break;
    default: x = w - 1 - lz; z = lx;
  }
  if (x < 0 || x >= w || z < 0 || z >= d || ly < 0 || ly >= h) return -1;
  const i = s.blocks[(x * h + ly) * d + z];
  if (i == null || i < 0 || isAirName(s.palette[i].name)) return -1;
  return i;
}
function blockAt(s, rot, lx, ly, lz) {
  const i = idxAt(s, rot, lx, ly, lz);
  return i < 0 ? null : s.palette[i].name;
}

function countItem(container, itemId) {
  let n = 0;
  for (let i = 0; i < container.size; i++) {
    const it = container.getItem(i);
    if (it && it.typeId === itemId) n += it.amount;
  }
  return n;
}

// ---------- Ghost entity (ghost mode) ----------
function ghostValid(s) {
  try { return !!(s.ghost && s.ghost.isValid); } catch (e) { return false; }
}

function removeGhost(s) {
  try { if (ghostValid(s)) s.ghost.remove(); } catch (e) { /* ignore */ }
  s.ghost = null; s.ghostName = null; s.ghostDim = null; s.layerSent = undefined; s.rotSent = undefined; s.sig = null;
}

function updateGhost(p, s) {
  if (!s.name || !s.anchor || !s.show) { removeGhost(s); return; }
  const bp = structures[s.name];
  const [fw, , fd] = footprint(bp, s.rot);
  // The entity sits away from the build (above or below, see "lift") and the model is offset back onto the build,
  // so its tiny hitbox never blocks building
  const pos = { x: s.anchor.x + fw / 2, y: s.anchor.y + (bp.lift ?? 0), z: s.anchor.z + fd / 2 };
  const dimId = p.dimension.id;
  const sig = [s.name, pos.x, pos.y, pos.z, s.rot, s.layer, dimId].join("|");
  if (ghostValid(s) && s.sig === sig) return;

  try {
    if (!ghostValid(s) || s.ghostName !== s.name || s.ghostDim !== dimId) {
      removeGhost(s);
      s.ghost = p.dimension.spawnEntity(GHOST_PREFIX + s.name, pos);
      s.ghostName = s.name;
      s.ghostDim = dimId;
      s.layerSent = undefined; s.rotSent = undefined;
    }
    s.ghost.teleport(pos, { dimension: p.dimension, rotation: { x: 0, y: 0 } });
    if (s.rotSent !== s.rot) { s.ghost.triggerEvent("ghost:rot_" + s.rot); s.rotSent = s.rot; }
    if (s.layerSent !== s.layer) {
      s.ghost.triggerEvent(s.layer === null ? "ghost:layer_all" : "ghost:layer_" + s.layer);
      s.layerSent = s.layer;
    }
    s.sig = sig;
  } catch (e) {
    s.sig = null;
  }
}

// The ghost must never turn by itself: keep its yaw at 0
function enforceYaw(s) {
  if (!ghostValid(s)) return;
  try {
    const y = s.ghost.getRotation().y;
    if (Math.abs(y) > 0.5) s.ghost.setRotation({ x: 0, y: 0 });
  } catch (e) { /* ignore */ }
}

// Remove leftover ghosts from a previous session
system.run(() => {
  for (const id of ["overworld", "nether", "the_end"]) {
    try {
      for (const e of world.getDimension(id).getEntities({ families: ["ghost"] })) e.remove();
    } catch (e) { /* dimension not available */ }
  }
});

world.afterEvents.playerLeave.subscribe((ev) => {
  const s = state.get(ev.playerId);
  if (s) removeGhost(s);
  state.delete(ev.playerId);
});

// Follow the crosshair until the position is locked
system.runInterval(() => {
  for (const p of world.getAllPlayers()) {
    const s = state.get(p.id);
    if (!s || !s.name) continue;
    const bp = structures[s.name];
    const [fw, , fd] = footprint(bp, s.rot);

    if (!s.locked) {
      const hit = p.getBlockFromViewDirection({ maxDistance: 12 });
      if (hit) {
        const b = hit.block.location;
        s.anchor = { x: b.x - Math.floor(fw / 2), y: b.y + 1, z: b.z - Math.floor(fd / 2) };
      }
    }
    if (GHOST_MODE) {
      updateGhost(p, s);
      enforceYaw(s);
    }
  }
}, 1);

// ---------- Particles ----------
function colorMap(rgb) {
  const m = new MolangVariableMap();
  m.setColorRGB("variable.color", { red: rgb[0], green: rgb[1], blue: rgb[2] });
  return m;
}

function spawn(dim, id, pos, vars) {
  try { dim.spawnParticle(id, pos, vars); }
  catch (e) { try { dim.spawnParticle(LINE_PARTICLE, pos); } catch (e2) { /* chunk not loaded */ } }
}

function line(dim, a, b, rgb) {
  const len = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z));
  const steps = Math.max(1, Math.min(Math.round(len * 2), 40));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const pos = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
    if (rgb) spawn(dim, DOT_PARTICLE, pos, colorMap(rgb));
    else spawn(dim, LINE_PARTICLE, pos);
  }
}

function box(dim, x0, y0, z0, x1, y1, z1, rgb) {
  const P = (x, y, z) => ({ x, y, z });
  line(dim, P(x0, y0, z0), P(x1, y0, z0), rgb); line(dim, P(x1, y0, z0), P(x1, y0, z1), rgb);
  line(dim, P(x1, y0, z1), P(x0, y0, z1), rgb); line(dim, P(x0, y0, z1), P(x0, y0, z0), rgb);
  line(dim, P(x0, y1, z0), P(x1, y1, z0), rgb); line(dim, P(x1, y1, z0), P(x1, y1, z1), rgb);
  line(dim, P(x1, y1, z1), P(x0, y1, z1), rgb); line(dim, P(x0, y1, z1), P(x0, y1, z0), rgb);
  line(dim, P(x0, y0, z0), P(x0, y1, z0), rgb); line(dim, P(x1, y0, z0), P(x1, y1, z0), rgb);
  line(dim, P(x1, y0, z1), P(x1, y1, z1), rgb); line(dim, P(x0, y0, z1), P(x0, y1, z1), rgb);
}

// Window of blueprint coordinates around the player
function window3(p, s, w, h, d, radius) {
  const a = s.anchor, loc = p.location;
  const px = Math.floor(loc.x) - a.x, pz = Math.floor(loc.z) - a.z;
  let y0, y1;
  if (s.layer !== null) { y0 = y1 = s.layer; }
  else { const py = Math.floor(loc.y) - a.y; y0 = Math.max(0, py - 2); y1 = Math.min(h - 1, py + 3); }
  return {
    x0: Math.max(0, px - radius), x1: Math.min(w - 1, px + radius),
    z0: Math.max(0, pz - radius), z1: Math.min(d - 1, pz + radius), y0, y1,
  };
}

// Particle preview: outline, layer frame, coloured dots for missing blocks, cube around the block you aim at
function drawParticlePreview(p, s) {
  const bp = structures[s.name];
  const [w, h, d] = footprint(bp, s.rot);
  const a = s.anchor, dim = p.dimension;

  box(dim, a.x, a.y, a.z, a.x + w, a.y + h, a.z + d, null);
  if (!s.locked) return;

  if (s.layer !== null) {
    const y = a.y + s.layer;
    box(dim, a.x, y, a.z, a.x + w, y + 1, a.z + d, [0.34, 0.82, 0.24]);
  }

  const win = window3(p, s, w, h, d, DOT_RADIUS);
  let shown = 0;
  outer:
  for (let ly = win.y0; ly <= win.y1; ly++) {
    for (let lx = win.x0; lx <= win.x1; lx++) {
      for (let lz = win.z0; lz <= win.z1; lz++) {
        if (shown >= DOT_MAX) break outer;
        const i = idxAt(bp, s.rot, lx, ly, lz);
        if (i < 0) continue;
        const pos = { x: a.x + lx, y: a.y + ly, z: a.z + lz };
        let wb;
        try { wb = dim.getBlock(pos); } catch (e) { continue; }
        if (!wb || wb.typeId === bp.palette[i].name) continue;   // unloaded or already correct
        if (!wb.isAir) continue;                                   // wrong blocks are marked separately
        spawn(dim, DOT_PARTICLE, { x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 }, colorMap(bp.colors?.[i] ?? [0.8, 0.8, 0.8]));
        shown++;
      }
    }
  }

  // Cube around the block you are about to place
  const hit = p.getBlockFromViewDirection({ maxDistance: 8 });
  if (hit) {
    const t = targetPos(hit);
    const i = idxAt(bp, s.rot, t.x - a.x, t.y - a.y, t.z - a.z);
    if (i >= 0) box(dim, t.x, t.y, t.z, t.x + 1, t.y + 1, t.z + 1, bp.colors?.[i] ?? [1, 1, 1]);
  }
}

system.runInterval(() => {
  if (GHOST_MODE) return;
  for (const p of world.getAllPlayers()) {
    const s = state.get(p.id);
    if (!s || !s.name || !s.show || !s.anchor) continue;
    drawParticlePreview(p, s);
  }
}, 5);

// ---------- Wrong-block markers (both modes) ----------
system.runInterval(() => {
  for (const p of world.getAllPlayers()) {
    const s = state.get(p.id);
    if (!s || !s.name || !s.show || !s.locked || !s.anchor) continue;
    const bp = structures[s.name];
    const [w, h, d] = footprint(bp, s.rot);
    const a = s.anchor, dim = p.dimension;
    const win = window3(p, s, w, h, d, WRONG_RADIUS);
    let shown = 0;
    outer:
    for (let ly = win.y0; ly <= win.y1; ly++) {
      for (let lx = win.x0; lx <= win.x1; lx++) {
        for (let lz = win.z0; lz <= win.z1; lz++) {
          if (shown >= WRONG_MAX) break outer;
          const name = blockAt(bp, s.rot, lx, ly, lz);
          if (!name) continue;
          const pos = { x: a.x + lx, y: a.y + ly, z: a.z + lz };
          let wb;
          try { wb = dim.getBlock(pos); } catch (e) { continue; }
          if (!wb || wb.isAir || wb.typeId === name) continue; // only wrong, non-empty blocks
          try {
            dim.spawnParticle(WRONG_PARTICLE, { x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 });
          } catch (e) { /* ignore */ }
          shown++;
        }
      }
    }
  }
}, 10);

// ---------- Auto-fill ----------
function targetPos(hit) {
  const b = hit.block.location;
  switch (hit.face) {
    case "Up": return { x: b.x, y: b.y + 1, z: b.z };
    case "Down": return { x: b.x, y: b.y - 1, z: b.z };
    case "North": return { x: b.x, y: b.y, z: b.z - 1 };
    case "South": return { x: b.x, y: b.y, z: b.z + 1 };
    case "East": return { x: b.x + 1, y: b.y, z: b.z };
    default: return { x: b.x - 1, y: b.y, z: b.z };
  }
}

function selectItem(p, container, itemId) {
  const sel = p.selectedSlotIndex;
  const cur = container.getItem(sel);
  if (cur && cur.typeId === itemId) return;
  for (let i = 0; i < 9; i++) {
    const it = container.getItem(i);
    if (it && it.typeId === itemId) { p.selectedSlotIndex = i; return; }
  }
  for (let i = 9; i < container.size; i++) {
    const it = container.getItem(i);
    if (it && it.typeId === itemId) {
      let target = sel;
      for (let e = 0; e < 9; e++) {
        if (!container.getItem(e)) { target = e; break; }
      }
      container.swapItems(i, target, container);
      p.selectedSlotIndex = target;
      return;
    }
  }
}

function autoFill(p) {
  const s = state.get(p.id);
  if (!s || !s.name || !s.auto || !s.locked || !s.anchor) return;
  const hit = p.getBlockFromViewDirection({ maxDistance: 8 });
  if (!hit) return;
  const t = targetPos(hit);
  const name = blockAt(structures[s.name], s.rot, t.x - s.anchor.x, t.y - s.anchor.y, t.z - s.anchor.z);
  if (!name) { p.onScreenDisplay.setActionBar("Nothing to place here"); return; }

  const itemId = ITEM_MAP[name] ?? name;
  if (!ItemTypes.get(itemId)) {
    p.onScreenDisplay.setActionBar("Can't place (no item for " + short(name) + ")");
    return;
  }
  const container = p.getComponent("inventory").container;
  const have = countItem(container, itemId);
  p.onScreenDisplay.setActionBar("Need: " + short(itemId) + " (have " + have + ")");

  const key = t.x + "," + t.y + "," + t.z;
  if (key === s.lastKey) return;
  s.lastKey = key;
  if (have > 0) selectItem(p, container, itemId);
}

// Every tick, plus immediately after each block is placed (so quick clicking keeps up)
system.runInterval(() => {
  for (const p of world.getAllPlayers()) autoFill(p);
}, 1);

world.afterEvents.playerPlaceBlock.subscribe((ev) => {
  const p = ev.player;
  const s = state.get(p.id);
  if (s) s.lastKey = null;
  system.run(() => autoFill(p));
});

// ---------- Menus ----------
function chooseMenu(p) {
  const names = Object.keys(structures);
  const f = new ActionFormData().title("Structure choose");
  names.forEach((n) => {
    const z = structures[n].size;
    f.button(`${n}\n${z[0]}x${z[1]}x${z[2]}`);
  });
  f.show(p).then((res) => {
    if (res.canceled) return;
    const s = st(p);
    removeGhost(s);
    s.name = names[res.selection];
    s.rot = 0; s.locked = false; s.anchor = null; s.lastKey = null; s.layer = null;
    p.sendMessage("Selected: " + s.name);
  });
}

function materialMenu(p) {
  const s = st(p);
  if (!s.name) return p.sendMessage("Choose a structure first.");
  const container = p.getComponent("inventory").container;
  const lines = Object.entries(countMaterials(structures[s.name]))
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => {
      const have = countItem(container, ITEM_MAP[n] ?? n);
      return `${have >= c ? "§a" : "§c"}${short(n)}: ${have}/${c}`;
    });
  new ActionFormData()
    .title("Materials: " + s.name)
    .body("In inventory / needed (red = not enough)\n\n" + lines.join("\n"))
    .button("OK")
    .show(p);
}

function toggleLock(p) {
  const s = st(p);
  if (!s.name) return p.sendMessage("Choose a structure first.");
  if (!s.anchor) return p.sendMessage("Look at a block first to set a position.");
  s.locked = !s.locked;
  s.lastKey = null;
  p.sendMessage(s.locked ? "Position locked." : "Position unlocked, following crosshair.");
}

function changeLayer(p, delta) {
  const s = st(p);
  if (!s.name) return p.sendMessage("Choose a structure first.");
  if (!s.locked) return p.sendMessage("Lock the position first.");
  const h = structures[s.name].size[1];
  if (s.layer === null) {
    s.layer = Math.min(h - 1, Math.max(0, Math.floor(p.location.y) - s.anchor.y));
  } else {
    s.layer = Math.min(h - 1, Math.max(0, s.layer + delta));
  }
  p.sendMessage("Layer " + (s.layer + 1) + " / " + h);
}

function mainMenu(p) {
  const s = st(p);
  const h = s.name ? structures[s.name].size[1] : 0;
  const layerTxt = s.layer === null ? "all" : (s.layer + 1) + " / " + h;
  new ActionFormData()
    .title("Blueprint Menu")
    .body(`Structure: ${s.name ?? "none"}\nRotation: ${s.rot * 90}\nPosition: ${s.locked ? "locked" : "following"}\nLayer: ${layerTxt}\nAuto-fill: ${s.auto ? "on" : "off"}\nPreview: ${GHOST_MODE ? "ghost blocks" : "particles"}`)
    .button("Structure choose")
    .button("Material list")
    .button("Rotate 90")
    .button(s.locked ? "Unlock position" : "Lock position")
    .button(s.show ? "Hide preview" : "Show preview")
    .button(s.auto ? "Auto-fill: turn off" : "Auto-fill: turn on")
    .button("Layer up")
    .button("Layer down")
    .button("All layers")
    .show(p)
    .then((res) => {
      if (res.canceled) return;
      switch (res.selection) {
        case 0: chooseMenu(p); break;
        case 1: materialMenu(p); break;
        case 2:
          if (!s.name) return p.sendMessage("Choose a structure first.");
          if (s.locked) return p.sendMessage("Unlock the position before rotating.");
          s.rot = (s.rot + 1) % 4;
          p.sendMessage("Rotation: " + s.rot * 90);
          break;
        case 3: toggleLock(p); break;
        case 4: s.show = !s.show; break;
        case 5: s.auto = !s.auto; s.lastKey = null; break;
        case 6: changeLayer(p, 1); break;
        case 7: changeLayer(p, -1); break;
        case 8: s.layer = null; p.sendMessage("Showing all layers."); break;
      }
    });
}

// Stick: right click = menu, sneak + right click = lock/unlock
world.afterEvents.itemUse.subscribe((ev) => {
  if (ev.itemStack.typeId !== "minecraft:stick") return;
  if (ev.source.isSneaking) toggleLock(ev.source);
  else mainMenu(ev.source);
});
