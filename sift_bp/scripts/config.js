// All tunables live here.
export const CONFIG = {
  debug: true, // action-bar readouts; toggle in game: /scriptevent siftprobe:debug on|off

  // The machine: 8 note blocks in a row. Slot 1..8 (left to right, seen from the portal)
  // must be tuned to scale[0..7]. After the horn, slots play in `sequence` order (1-based).
  sequence: [1, 3, 7, 6, 5, 2, 4, 8],
  scale: [0, 2, 4, 5, 7, 9, 11, 12], // note block pitch (0..24) per slot; default = major scale
  requireTuning: true, // false = skip the pitch check (any pitches are accepted)

  hornItem: "minecraft:goat_horn",
  hornCooldownTicks: 120, // ignore repeated horn events (several events fire per blow)
  startDelayTicks: 30, // pause after the horn before the first note
  noteIntervalTicks: 8, // gap between notes

  frameBlock: "minecraft:reinforced_deepslate",
  portalBlock: "sift:portal",
  scanRadius: 16, // blocks around the player to look for the frame and the machine
  maxCells: 600, // flood fill gives up past this many cells (frame is not closed)
  minWidth: 2,
  minHeight: 3,
  maxSize: 21,
  machineMaxDistance: 10, // how far from the portal plane the note block row may be

  // Pitch tracking. 500 entries stays under the 32,767-char dynamic property limit.
  maxTracked: 500,
};
