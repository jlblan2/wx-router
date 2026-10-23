// Built-in coastline for the US East Coast, the Gulf, the Bahamas and the
// Caribbean (8°N to 45°N, 98°W to 59°W), from GSHHG full resolution. It ships
// with the app in 1° tiles, so land is always checked even when the online
// map data can't be reached.
const BASE = new URL('../data/coast/', import.meta.url);

let index = null; // Promise of { bbox, scale, have: Set('i_j') }
const tiles = new Map(); // 'i_j' -> Promise of [{ a, b }]

function getIndex() {
  index ??= fetch(new URL('index.json', BASE))
    .then((res) => {
      if (!res.ok) throw new Error(`built-in coastline ${res.status}`);
      return res.json();
    })
    .then((ix) => ({ ...ix, have: new Set(ix.tiles.map(([i, j]) => `${i}_${j}`)) }))
    .catch((e) => {
      index = null; // try again next time
      throw e;
    });
  return index;
}

// Coastline segments in the 1° tile with south-west corner (i°, j°): [] for
// open sea, null outside the built-in area.
export async function coastTile(i, j) {
  const ix = await getIndex();
  const [S, W, N, E] = ix.bbox;
  if (i < S || i >= N || j < W || j >= E) return null;
  const k = `${i}_${j}`;
  if (!ix.have.has(k)) return [];
  if (!tiles.has(k)) {
    const p = fetch(new URL(`${k}.json`, BASE))
      .then((res) => {
        if (!res.ok) throw new Error(`built-in coastline ${res.status}`);
        return res.json();
      })
      .then((lines) => {
        // Each line is [x0, y0, dx1, dy1, dx2, dy2, …] in 1/scale degrees.
        const segs = [];
        for (const l of lines) {
          let x = l[0], y = l[1];
          let a = { lat: y / ix.scale, lon: x / ix.scale };
          for (let n = 2; n < l.length; n += 2) {
            x += l[n];
            y += l[n + 1];
            const b = { lat: y / ix.scale, lon: x / ix.scale };
            segs.push({ a, b });
            a = b;
          }
        }
        return segs;
      })
      .catch((e) => {
        tiles.delete(k);
        throw e;
      });
    tiles.set(k, p);
  }
  return tiles.get(k);
}
