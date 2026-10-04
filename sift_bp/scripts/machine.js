// Pure machine detection: a straight, gap-free row of `count` note blocks beside the portal.
//
// Slot order is "left to right" as seen from the portal looking at the machine:
//   portal plane spans x (faces north/south): machine north -> west..east, machine south -> east..west
//   portal plane spans z (faces east/west):   machine east  -> north..south, machine west -> south..north
//
// blocks: [{x,y,z}] of note blocks. axis/plane describe the portal (see frame.js).
// Returns { machines: [{ side, slots: [{x,y,z} x count] }], longest }.

export function findMachines(blocks, axis, plane, { count, maxDistance }) {
  const nOf = (b) => (axis === "x" ? b.z : b.x); // coordinate along the portal normal
  const uOf = (b) => (axis === "x" ? b.x : b.z); // coordinate along the portal width

  const rows = new Map(); // same side, same normal coordinate, same height
  for (const b of blocks) {
    const off = nOf(b) - plane;
    if (off === 0 || Math.abs(off) > maxDistance) continue;
    const key = `${Math.sign(off)}|${nOf(b)}|${b.y}`;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(b);
  }

  const machines = [];
  let longest = 0;
  for (const [key, list] of rows) {
    const side = Number(key.split("|")[0]);
    list.sort((a, b) => uOf(a) - uOf(b));

    const runs = [];
    let run = [list[0]];
    for (let i = 1; i < list.length; i++) {
      if (uOf(list[i]) === uOf(list[i - 1]) + 1) {
        run.push(list[i]);
      } else {
        runs.push(run);
        run = [list[i]];
      }
    }
    runs.push(run);

    for (const r of runs) {
      if (r.length > longest) longest = r.length;
      if (r.length !== count) continue;
      const ascending = (axis === "x" ? -side : side) === 1; // does "left to right" mean growing u?
      machines.push({ side, slots: ascending ? r : [...r].reverse() });
    }
  }
  return { machines, longest };
}
