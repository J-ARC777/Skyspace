/**
 * CatalogLoader
 * Fetches stars.bin and unpacks into flat typed arrays
 * ready to feed directly into Three.js BufferGeometry attributes.
 */

const BYTES_PER_STAR = 48;

export class CatalogLoader {
  constructor() {
    this.positions = null;   // Float32Array [x,y,z, ...]
    this.colors = null;      // Float32Array [r,g,b, ...]
    this.magnitudes = null;  // Float32Array
    this.distances = null;   // Float32Array (light years)
    this.hipIds = null;      // Uint32Array
    this.nameIndices = null; // Int32Array (-1 = unnamed)
    this.names = null;       // string[]
    this.starCount = 0;
  }

  async load() {
    const base = import.meta.env.BASE_URL;
    const [binRes, namesRes] = await Promise.all([
      fetch(`${base}data/stars.bin`),
      fetch(`${base}data/star-names.json`),
    ]);

    const [buffer, names] = await Promise.all([
      binRes.arrayBuffer(),
      namesRes.json(),
    ]);

    this.names = names;
    this.starCount = Math.floor(buffer.byteLength / BYTES_PER_STAR);

    this.positions   = new Float32Array(this.starCount * 3);
    this.colors      = new Float32Array(this.starCount * 3);
    this.magnitudes  = new Float32Array(this.starCount);
    this.distances   = new Float32Array(this.starCount);
    this.hipIds      = new Uint32Array(this.starCount);
    this.nameIndices = new Int32Array(this.starCount);

    const view = new DataView(buffer);
    for (let i = 0; i < this.starCount; i++) {
      const base = i * BYTES_PER_STAR;
      this.positions[i * 3]     = view.getFloat32(base,      true);
      this.positions[i * 3 + 1] = view.getFloat32(base + 4,  true);
      this.positions[i * 3 + 2] = view.getFloat32(base + 8,  true);
      this.colors[i * 3]        = view.getFloat32(base + 12, true);
      this.colors[i * 3 + 1]    = view.getFloat32(base + 16, true);
      this.colors[i * 3 + 2]    = view.getFloat32(base + 20, true);
      this.magnitudes[i]        = view.getFloat32(base + 24, true);
      this.distances[i]         = view.getFloat32(base + 28, true);
      this.hipIds[i]            = view.getUint32(base + 32,  true);
      this.nameIndices[i]       = view.getInt32(base + 36,   true);
    }

    return this;
  }

  getStarName(index) {
    const nameIdx = this.nameIndices[index];
    if (nameIdx < 0 || !this.names) return null;
    return this.names[nameIdx] || null;
  }

  getStarData(index) {
    return {
      index,
      x: this.positions[index * 3],
      y: this.positions[index * 3 + 1],
      z: this.positions[index * 3 + 2],
      r: this.colors[index * 3],
      g: this.colors[index * 3 + 1],
      b: this.colors[index * 3 + 2],
      magnitude: this.magnitudes[index],
      distanceLy: this.distances[index],
      hipId: this.hipIds[index],
      name: this.getStarName(index),
    };
  }
}
