// Pure flood-fill region detection. No Minecraft imports.

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

// kindAt(x, y, z) -> "frame" | "open" | "other"
// Flood fills the "open" cells connected to `start` inside ONE vertical plane
// (axis "x": z is fixed and the plane spans x/y; axis "z": x is fixed and it spans z/y).
// The region is a closed frame only if every in-plane neighbour that is not open is a frame block.
// `visited` is always returned so callers can skip cells that were already tried.
export function floodRegion(kindAt, start, axis, opts) {
  const { maxCells, minWidth, minHeight, maxSize } = opts;
  const plane = axis === "x" ? start.z : start.x;
  const u0 = axis === "x" ? start.x : start.z;
  const at = (u, y) => (axis === "x" ? kindAt(u, y, plane) : kindAt(plane, y, u));

  const visited = new Set([`${u0},${start.y}`]);
  const queue = [[u0, start.y]];
  let minU = u0;
  let maxU = u0;
  let minY = start.y;
  let maxY = start.y;

  for (let i = 0; i < queue.length; i++) {
    const [u, y] = queue[i];
    for (const [du, dy] of DIRS) {
      const nu = u + du;
      const ny = y + dy;
      const key = `${nu},${ny}`;
      if (visited.has(key)) continue;
      const kind = at(nu, ny);
      if (kind === "frame") continue;
      if (kind !== "open") return { ok: false, reason: "terhalang", visited };
      visited.add(key);
      queue.push([nu, ny]);
      if (queue.length > maxCells) return { ok: false, reason: "terbuka", visited };
      if (nu < minU) minU = nu;
      if (nu > maxU) maxU = nu;
      if (ny < minY) minY = ny;
      if (ny > maxY) maxY = ny;
    }
  }

  const width = maxU - minU + 1;
  const height = maxY - minY + 1;
  if (width < minWidth || height < minHeight || width > maxSize || height > maxSize) {
    return { ok: false, reason: "ukuran", visited };
  }

  const cells = queue.map(([u, y]) => (axis === "x" ? { x: u, y, z: plane } : { x: plane, y, z: u }));
  const midU = (minU + maxU) / 2 + 0.5;
  const midY = (minY + maxY) / 2 + 0.5;
  const center = axis === "x" ? { x: midU, y: midY, z: plane + 0.5 } : { x: plane + 0.5, y: midY, z: midU };
  return { ok: true, axis, plane, cells, bbox: { u0: minU, u1: maxU, y0: minY, y1: maxY }, width, height, center, visited };
}

export function nearestRegion(list, pos) {
  let best = null;
  let bestD = Infinity;
  for (const r of list) {
    const d = (r.center.x - pos.x) ** 2 + (r.center.y - pos.y) ** 2 + (r.center.z - pos.z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best;
}
