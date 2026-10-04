// Pitch bookkeeping for vanilla note blocks.
//
// The script cannot read a note block's pitch directly, so we infer it: a freshly placed
// note block is at pitch 0 and every right-click adds one (wrapping after 24). Records are
// keyed by dimension + coordinates and saved in one world dynamic property.
//
// Ghost records (block broken, exploded, pushed, replaced) are cleaned up three ways:
// event handlers in main.js, validate-on-use, and a slow background sweep.

import { world, system } from "@minecraft/server";
import { CONFIG } from "./config.js";

export const NOTEBLOCK = "minecraft:noteblock";
const STORE_KEY = "siftprobe:notes";

const pitches = new Map(); // "dimId|x,y,z" -> 0..24
let saveQueued = false;
let sweepCursor = 0;

export const noteKey = (dimId, p) => `${dimId}|${p.x},${p.y},${p.z}`;

function parseKey(key) {
  const [dimId, xyz] = key.split("|");
  const [x, y, z] = xyz.split(",").map(Number);
  return { dimId, loc: { x, y, z } };
}

export function loadNotes() {
  try {
    const raw = world.getDynamicProperty(STORE_KEY);
    if (typeof raw !== "string") return;
    for (const [k, v] of Object.entries(JSON.parse(raw))) pitches.set(k, v);
  } catch (e) {
    console.warn(`[siftprobe] could not load saved notes: ${e}`);
  }
}

function queueSave() {
  if (saveQueued) return;
  saveQueued = true;
  system.runTimeout(() => {
    saveQueued = false;
    try {
      world.setDynamicProperty(STORE_KEY, JSON.stringify(Object.fromEntries(pitches)));
    } catch (e) {
      console.warn(`[siftprobe] could not save notes: ${e}`);
    }
  }, 20);
}

// undefined means "never seen this block placed": its real pitch is unknown.
export const getPitch = (key) => pitches.get(key);
export const trackedCount = () => pitches.size;

export function setPitch(key, pitch) {
  pitches.delete(key); // re-insert so the oldest entries are evicted first
  pitches.set(key, pitch);
  while (pitches.size > CONFIG.maxTracked) pitches.delete(pitches.keys().next().value);
  queueSave();
}

export function dropNote(key) {
  if (pitches.delete(key)) queueSave();
}

export function clearNotes() {
  pitches.clear();
  queueSave();
}

// Drop the record if there is no note block at that spot any more.
// Unloaded chunks are left alone (getBlock returns undefined there).
export function validate(key) {
  const { dimId, loc } = parseKey(key);
  let block;
  try {
    block = world.getDimension(dimId).getBlock(loc);
  } catch {
    return;
  }
  if (block && block.typeId !== NOTEBLOCK) dropNote(key);
}

// Re-check records near a spot, e.g. after a piston fired.
export function validateNear(dimId, center, radius) {
  for (const key of [...pitches.keys()]) {
    if (!key.startsWith(`${dimId}|`)) continue;
    const { loc } = parseKey(key);
    if (Math.abs(loc.x - center.x) <= radius && Math.abs(loc.y - center.y) <= radius && Math.abs(loc.z - center.z) <= radius) {
      validate(key);
    }
  }
}

// Background sweep: a few records per pass, round-robin.
export function sweep(batch = 40) {
  const keys = [...pitches.keys()];
  for (let i = 0; i < Math.min(batch, keys.length); i++) {
    sweepCursor = (sweepCursor + 1) % keys.length;
    validate(keys[sweepCursor]);
  }
}
