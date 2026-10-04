import { world, system, BlockPermutation, BlockVolume } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { floodRegion, nearestRegion } from "./frame.js";
import { findMachines } from "./machine.js";
import * as notes from "./notes.js";
import * as portals from "./portals.js";

const NOTEBLOCK = notes.NOTEBLOCK;
const AIR = "minecraft:air";
const PLAYER = "minecraft:player";
const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const SLOTS = CONFIG.scale.length;
const playOrder = CONFIG.sequence.map((degree) => degree - 1); // slot indices, in play order

const portalCache = new Map(); // note block key -> { tick, portal } (for click sparkles)
const lastHorn = new Map(); // playerId -> tick
const playing = new Set(); // portal ids whose melody is currently playing
const probed = new Set();
let debug = CONFIG.debug;
let fastScan = true;

const warn = (m) => console.warn(`[siftprobe] ${m}`);
const bar = (player, text) => {
  try {
    player.onScreenDisplay.setActionBar(text);
  } catch {
    /* player may have left */
  }
};
const dbg = (player, text) => {
  if (debug) bar(player, text);
};
const safe = (name, fn) => (ev) => {
  try {
    fn(ev);
  } catch (e) {
    warn(`${name}: ${e}`);
    if (debug) world.sendMessage(`§c[siftprobe] ${name}: ${e}`);
  }
};
const portalId = (dimId, p) => `${dimId}|${p.axis}|${p.plane}|${p.bbox.u0},${p.bbox.y0}`;

// ---------------------------------------------------------------- scanning

// Positions of every block of `typeId` within `r` blocks of `c` (c must be integer coordinates).
function blocksAround(dim, c, r, typeId) {
  const range = dim.heightRange;
  const from = { x: c.x - r, y: Math.max(range.min, c.y - r), z: c.z - r };
  const to = { x: c.x + r, y: Math.min(range.max - 1, c.y + r), z: c.z + r };
  const out = [];
  if (fastScan) {
    try {
      const hits = dim.getBlocks(new BlockVolume(from, to), { includeTypes: [typeId] }, true);
      for (const l of hits.getBlockLocationIterator()) out.push({ x: l.x, y: l.y, z: l.z });
      return out;
    } catch (e) {
      fastScan = false;
      warn(`getBlocks unavailable, using a manual scan instead: ${e}`);
      out.length = 0;
    }
  }
  for (let x = from.x; x <= to.x; x++) {
    for (let y = from.y; y <= to.y; y++) {
      for (let z = from.z; z <= to.z; z++) {
        if (dim.getBlock({ x, y, z })?.typeId === typeId) out.push({ x, y, z });
      }
    }
  }
  return out;
}

// Closest closed frame near `origin`. The interior is found by flood fill, so it only needs to be
// enclosed by reinforced deepslate; it may hold air (to be filled) or portal blocks (already lit).
function findPortal(dim, origin) {
  const seeds = blocksAround(dim, origin, CONFIG.scanRadius, CONFIG.frameBlock);
  if (!seeds.length) return null;

  const types = new Map();
  const typeAt = (x, y, z) => {
    const k = `${x},${y},${z}`;
    let t = types.get(k);
    if (t === undefined) {
      try {
        t = dim.getBlock({ x, y, z })?.typeId ?? "unloaded";
      } catch {
        t = "unloaded";
      }
      types.set(k, t);
    }
    return t;
  };
  const kindAt = (x, y, z) => {
    const t = typeAt(x, y, z);
    if (t === CONFIG.frameBlock) return "frame";
    return t === AIR || t === CONFIG.portalBlock ? "open" : "other";
  };

  const tried = new Set();
  const found = [];
  for (const s of seeds) {
    for (const axis of ["x", "z"]) {
      for (const [du, dy] of DIRS) {
        const c = axis === "x" ? { x: s.x + du, y: s.y + dy, z: s.z } : { x: s.x, y: s.y + dy, z: s.z + du };
        if (kindAt(c.x, c.y, c.z) !== "open") continue;
        const plane = axis === "x" ? c.z : c.x;
        const u = axis === "x" ? c.x : c.z;
        if (tried.has(`${axis}|${plane}|${u},${c.y}`)) continue;

        const r = floodRegion(kindAt, c, axis, CONFIG);
        for (const v of r.visited) tried.add(`${axis}|${plane}|${v}`);
        if (r.ok) {
          r.lit = r.cells.every((p) => typeAt(p.x, p.y, p.z) === CONFIG.portalBlock);
          found.push(r);
        }
      }
    }
  }
  return nearestRegion(found, origin);
}

function portalNear(block) {
  const key = notes.noteKey(block.dimension.id, block.location);
  const now = system.currentTick;
  const hit = portalCache.get(key);
  if (hit && now - hit.tick < 40) return hit.portal;
  const portal = findPortal(block.dimension, block.location);
  if (portalCache.size > 64) portalCache.clear();
  portalCache.set(key, { tick: now, portal });
  return portal;
}

// ---------------------------------------------------------------- effects

function spark(dim, id, at, count, spread) {
  for (let i = 0; i < count; i++) {
    try {
      dim.spawnParticle(id, {
        x: at.x + (Math.random() - 0.5) * spread * 2,
        y: at.y + Math.random() * 0.3,
        z: at.z + (Math.random() - 0.5) * spread * 2,
      });
    } catch {
      return; // unknown particle id: skip silently
    }
  }
}

// Green sparkles above a note block = "an unlit closed frame is in range".
function indicate(block) {
  const portal = portalNear(block);
  if (portal && !portal.lit) {
    const l = block.location;
    spark(block.dimension, "minecraft:villager_happy", { x: l.x + 0.5, y: l.y + 1.1, z: l.z + 0.5 }, 4, 0.3);
  }
  return portal;
}

// Real note blocks pick their instrument from the block below; we always use the harp.
function playNote(dim, slot, pitch) {
  const at = { x: slot.x + 0.5, y: slot.y + 0.5, z: slot.z + 0.5 };
  try {
    dim.playSound("note.harp", at, { pitch: Math.pow(2, (pitch - 12) / 12), volume: 3 });
  } catch {
    /* sound is optional */
  }
  spark(dim, "minecraft:note_particle", { x: at.x, y: slot.y + 1.1, z: at.z }, 1, 0.1);
}

// ---------------------------------------------------------------- activate / deactivate

function machineIntact(dim, slots) {
  return slots.every((s) => {
    const b = dim.getBlock(s);
    return !b || b.typeId === NOTEBLOCK; // unloaded chunk counts as intact
  });
}

function finish(player, dim, portal, machine, id) {
  const mod8 = (n) => ((n % 8) + 8) % 8;
  const perms = new Map(); // one permutation per tile
  const permFor = (c) => {
    const tu = mod8(portal.axis === "x" ? c.x : c.z);
    const tv = mod8(c.y);
    const key = `${tu},${tv}`;
    if (!perms.has(key)) {
      perms.set(key, BlockPermutation.resolve(CONFIG.portalBlock, { "sift:axis": portal.axis, "sift:tu": tu, "sift:tv": tv }));
    }
    return perms.get(key);
  };
  let placed = 0;
  for (const c of portal.cells) {
    const b = dim.getBlock(c);
    if (!b || b.typeId !== AIR) continue; // only air is replaced
    try {
      b.setPermutation(permFor(c));
      placed++;
    } catch (e) {
      warn(`could not place portal at ${c.x},${c.y},${c.z}: ${e}`);
    }
  }

  portals.addPortal(id, {
    d: dim.id,
    a: portal.axis,
    p: portal.plane,
    u0: portal.bbox.u0,
    u1: portal.bbox.u1,
    y0: portal.bbox.y0,
    y1: portal.bbox.y1,
    n: machine.slots.map((s) => [s.x, s.y, s.z]),
  });
  portalCache.clear();

  spark(dim, "minecraft:totem_particle", portal.center, 12, 0.8);
  try {
    dim.playSound("random.levelup", portal.center, { volume: 1 });
  } catch {
    /* sound is optional */
  }
  bar(player, `§aPortal menyala (${placed} blok).`);
}

function startPlayback(player, dim, portal, machine) {
  const id = portalId(dim.id, portal);
  if (playing.has(id)) return;
  playing.add(id);

  let i = 0;
  const step = () => {
    try {
      if (!machineIntact(dim, machine.slots)) {
        playing.delete(id);
        bar(player, "§cMesin rusak saat dimainkan, portal batal.");
        return;
      }
      if (i < playOrder.length) {
        const slotIndex = playOrder[i++];
        const slot = machine.slots[slotIndex];
        playNote(dim, slot, notes.getPitch(notes.noteKey(dim.id, slot)) ?? CONFIG.scale[slotIndex]);
        system.runTimeout(step, CONFIG.noteIntervalTicks);
        return;
      }
      playing.delete(id);
      finish(player, dim, portal, machine, id);
    } catch (e) {
      playing.delete(id);
      warn(`playback: ${e}`);
    }
  };
  bar(player, "§bMesin note block bergema...");
  system.runTimeout(step, CONFIG.startDelayTicks);
}

function destroy(dim, pos) {
  try {
    const r = dim.runCommand(`setblock ${pos.x} ${pos.y} ${pos.z} air destroy`); // "destroy" = break particles + sound
    if (r && r.successCount > 0) return;
  } catch {
    /* fall through to the plain replace */
  }
  try {
    dim.getBlock(pos)?.setType(AIR);
  } catch {
    /* ignore */
  }
}

// Turn a portal off: every portal block inside its bounding box becomes air (with break effects).
function deactivate(id, e, reason) {
  portals.removePortal(id);
  portalCache.clear();
  let dim;
  try {
    dim = world.getDimension(e.d);
  } catch {
    return;
  }
  for (let u = e.u0; u <= e.u1; u++) {
    for (let y = e.y0; y <= e.y1; y++) {
      const pos = e.a === "x" ? { x: u, y, z: e.p } : { x: e.p, y, z: u };
      let block;
      try {
        block = dim.getBlock(pos);
      } catch {
        continue;
      }
      if (block?.typeId === CONFIG.portalBlock) destroy(dim, pos);
    }
  }
  const mid = (e.u0 + e.u1) / 2 + 0.5;
  const cy = (e.y0 + e.y1) / 2 + 0.5;
  const center = e.a === "x" ? { x: mid, y: cy, z: e.p + 0.5 } : { x: e.p + 0.5, y: cy, z: mid };
  try {
    for (const p of dim.getPlayers({ location: center, maxDistance: 32 })) bar(p, `§cPortal padam: ${reason}`);
  } catch {
    /* ignore */
  }
}

// A note block disappeared at (dimId, loc): switch off every portal that uses it.
function noteGone(dimId, loc) {
  for (const [id, e] of portals.allPortals()) {
    if (e.d !== dimId) continue;
    if (e.n.some(([x, y, z]) => x === loc.x && y === loc.y && z === loc.z)) deactivate(id, e, "note block hancur.");
  }
}

// Safety net for removals that raise no event (pistons, commands, explosions we missed).
function checkMachines() {
  for (const [id, e] of portals.allPortals()) {
    let dim;
    try {
      dim = world.getDimension(e.d);
    } catch {
      continue;
    }
    for (const [x, y, z] of e.n) {
      let b;
      try {
        b = dim.getBlock({ x, y, z });
      } catch {
        continue;
      }
      if (b && b.typeId !== NOTEBLOCK) {
        deactivate(id, e, "note block hilang.");
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- horn

function tuningProblem(dim, machine) {
  for (let i = 0; i < machine.slots.length; i++) {
    const have = notes.getPitch(notes.noteKey(dim.id, machine.slots[i]));
    const want = CONFIG.scale[i];
    if (have === undefined) return `slot ${i + 1} belum terlacak (hancurkan lalu pasang ulang note block itu)`;
    if (have !== want) return debug ? `slot ${i + 1}: nada ${have}, seharusnya ${want}` : `slot ${i + 1} belum selaras`;
  }
  return undefined;
}

function onHorn(player) {
  const now = system.currentTick;
  if (now - (lastHorn.get(player.id) ?? -99999) < CONFIG.hornCooldownTicks) return;
  lastHorn.set(player.id, now);

  const dim = player.dimension;
  const l = player.location;
  const origin = { x: Math.floor(l.x), y: Math.floor(l.y), z: Math.floor(l.z) };

  const portal = findPortal(dim, origin);
  if (!portal) return dbg(player, "§7Tanduk: tidak ada frame tertutup di sekitar.");
  if (portal.lit) return bar(player, "§7Portal ini sudah menyala.");
  if (playing.has(portalId(dim.id, portal))) return;

  const found = findMachines(blocksAround(dim, origin, CONFIG.scanRadius, NOTEBLOCK), portal.axis, portal.plane, {
    count: SLOTS,
    maxDistance: CONFIG.machineMaxDistance,
  });
  if (!found.machines.length) {
    const extra = found.longest ? ` Baris terpanjang yang ditemukan: ${found.longest}.` : "";
    return bar(player, `§eButuh ${SLOTS} note block berjejer lurus di satu sisi portal.${extra}`);
  }

  // Several candidate rows: take the one closest to the portal.
  let machine = found.machines[0];
  let best = Infinity;
  for (const m of found.machines) {
    const s = m.slots[0];
    const d = (s.x - portal.center.x) ** 2 + (s.y - portal.center.y) ** 2 + (s.z - portal.center.z) ** 2;
    if (d < best) {
      best = d;
      machine = m;
    }
  }

  if (CONFIG.requireTuning) {
    const problem = tuningProblem(dim, machine);
    if (problem) return bar(player, `§eMesin belum selaras: ${problem}`);
  }
  startPlayback(player, dim, portal, machine);
}

// ---------------------------------------------------------------- probe + tuning

function probe(player, block) {
  const l = block.location;
  const lines = [`§b[probe] ${block.typeId} @ ${l.x},${l.y},${l.z}`];
  try {
    lines.push(`states: ${JSON.stringify(block.permutation.getAllStates())}`);
  } catch (e) {
    lines.push(`states: error ${e}`);
  }
  for (const id of ["minecraft:note_block", "minecraft:noteblock", "minecraft:dynamic_properties"]) {
    try {
      const c = block.getComponent(id);
      if (!c) {
        lines.push(`${id}: tidak ada`);
        continue;
      }
      lines.push(`${id}: ADA`);
      if (id === "minecraft:dynamic_properties") {
        c.set("siftprobe:t", 7);
        lines.push(`  set/get -> ${c.get("siftprobe:t")}`);
        c.set("siftprobe:t", undefined);
      }
    } catch (e) {
      lines.push(`${id}: error ${e}`);
    }
  }
  player.sendMessage(lines.join("\n"));
}

// Right-click tunes a note block (+1 pitch, wraps after 24). We mirror that in our records.
function onTune(player, block) {
  const key = notes.noteKey(block.dimension.id, block.location);
  const old = notes.getPitch(key);
  if (old === undefined) return bar(player, "§eNote block ini belum terlacak. Hancurkan lalu pasang ulang.");
  const pitch = (old + 1) % 25;
  notes.setPitch(key, pitch);
  const portal = indicate(block);
  dbg(player, `§7disetel ke nada §f${pitch}§7 | frame: §f${portal ? `${portal.width}x${portal.height}${portal.lit ? " (menyala)" : ""}` : "tidak ada"}`);
}

// ---------------------------------------------------------------- wiring

function start() {
  notes.loadNotes();
  portals.loadPortals();

  world.afterEvents.playerPlaceBlock.subscribe(
    safe("place", (ev) => {
      if (ev.block.typeId !== NOTEBLOCK) return;
      notes.setPitch(notes.noteKey(ev.block.dimension.id, ev.block.location), 0); // new blocks start at pitch 0
    })
  );

  world.afterEvents.playerInteractWithBlock.subscribe(
    safe("interact", (ev) => {
      if (ev.block.typeId !== NOTEBLOCK || ev.isFirstEvent === false) return;
      if (ev.player.isSneaking && ev.beforeItemStack) return; // that is a block placement, not a tune
      if (!probed.has(ev.player.id)) {
        probed.add(ev.player.id);
        probe(ev.player, ev.block);
      }
      onTune(ev.player, ev.block);
    })
  );

  // Goat horn: several of these may fire for one blow; onHorn() debounces them.
  const hornEvent = safe("horn", (ev) => {
    if (ev.itemStack?.typeId !== CONFIG.hornItem || ev.source?.typeId !== PLAYER) return;
    onHorn(ev.source);
  });
  world.afterEvents.itemUse.subscribe(hornEvent);
  world.afterEvents.itemStartUse?.subscribe(hornEvent);
  world.afterEvents.itemCompleteUse?.subscribe(hornEvent);

  // Note block removed: forget its pitch and switch off any portal that uses it.
  world.afterEvents.playerBreakBlock.subscribe(
    safe("break", (ev) => {
      if (ev.brokenBlockPermutation.type.id !== NOTEBLOCK) return;
      const dimId = ev.block.dimension.id;
      notes.dropNote(notes.noteKey(dimId, ev.block.location));
      noteGone(dimId, ev.block.location);
    })
  );
  world.afterEvents.blockExplode?.subscribe(
    safe("explode", (ev) => {
      if (ev.explodedBlockPermutation?.type.id !== NOTEBLOCK) return;
      const dimId = ev.block.dimension.id;
      notes.dropNote(notes.noteKey(dimId, ev.block.location));
      noteGone(dimId, ev.block.location);
    })
  );
  world.afterEvents.pistonActivate?.subscribe(
    safe("piston", (ev) => {
      const dimId = ev.block.dimension.id;
      const at = ev.block.location;
      system.runTimeout(() => notes.validateNear(dimId, at, 14), 10); // after the move animation
    })
  );

  system.runInterval(checkMachines, 10);
  system.runInterval(() => notes.sweep(), 600);

  world.afterEvents.playerSpawn.subscribe((ev) => {
    if (!ev.initialSpawn) return;
    ev.player.sendMessage(
      "§b[Sift Probe]§r aktif. Pasang 8 note block berjejer di satu sisi frame, setel nada (klik kanan), lalu tiup goat horn. " +
        "Perintah: /scriptevent siftprobe:status | debug on|off | reset | probe"
    );
  });

  system.afterEvents.scriptEventReceive.subscribe(
    safe("scriptevent", (ev) => {
      if (!ev.id.startsWith("siftprobe:")) return;
      const cmd = ev.id.slice("siftprobe:".length);
      const p = ev.sourceEntity?.typeId === PLAYER ? ev.sourceEntity : undefined;
      const reply = (m) => (p ? p.sendMessage(m) : world.sendMessage(m));
      if (cmd === "debug") {
        debug = ev.message.trim() !== "off";
        reply(`§7debug ${debug ? "on" : "off"}`);
      } else if (cmd === "reset") {
        for (const [id, e] of portals.allPortals()) deactivate(id, e, "reset.");
        notes.clearNotes();
        portalCache.clear();
        reply("§7Semua portal dimatikan dan catatan nada dihapus.");
      } else if (cmd === "status") {
        reply(
          `§7Note block tercatat: ${notes.trackedCount()} | portal aktif: ${portals.portalCount()} | ` +
            `nada per slot: ${CONFIG.scale.join(", ")} | urutan main: ${CONFIG.sequence.join("-")}`
        );
      } else if (cmd === "probe") {
        const b = p?.getBlockFromViewDirection({ maxDistance: 8 })?.block;
        if (b) probe(p, b);
        else reply("§eArahkan crosshair ke sebuah blok.");
      }
    })
  );

  warn("ready");
}

world.afterEvents.worldLoad.subscribe(() => {
  try {
    start();
  } catch (e) {
    warn(`start failed: ${e}${e?.stack ? `\n${e.stack}` : ""}`);
  }
});
