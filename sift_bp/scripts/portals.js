// Registry of active portals, saved in one world dynamic property.
// Entry: { d: dimensionId, a: axis, p: plane, u0, u1, y0, y1: bounding box, n: [[x,y,z] x 8] note blocks }

import { world, system } from "@minecraft/server";

const STORE_KEY = "siftprobe:portals";
const MAX_PORTALS = 40;
const entries = new Map();
let saveQueued = false;

export function loadPortals() {
  try {
    const raw = world.getDynamicProperty(STORE_KEY);
    if (typeof raw !== "string") return;
    for (const [id, e] of Object.entries(JSON.parse(raw))) entries.set(id, e);
  } catch (e) {
    console.warn(`[siftprobe] could not load portals: ${e}`);
  }
}

function queueSave() {
  if (saveQueued) return;
  saveQueued = true;
  system.runTimeout(() => {
    saveQueued = false;
    try {
      world.setDynamicProperty(STORE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch (e) {
      console.warn(`[siftprobe] could not save portals: ${e}`);
    }
  }, 20);
}

export const allPortals = () => [...entries.entries()];
export const portalCount = () => entries.size;

export function addPortal(id, entry) {
  entries.delete(id);
  entries.set(id, entry);
  while (entries.size > MAX_PORTALS) entries.delete(entries.keys().next().value);
  queueSave();
}

export function removePortal(id) {
  if (entries.delete(id)) queueSave();
}
