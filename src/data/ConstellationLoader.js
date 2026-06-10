/**
 * ConstellationLoader
 * Loads constellations.json and resolves HIP IDs → catalog star indices.
 * Provides centroid positions and stats for each constellation.
 */

import * as THREE from 'three';

export class ConstellationLoader {
  constructor() {
    this.constellations = {}; // abbrev → { name, segments: [{a,b}], stars: Set<idx>, centroid, nearestLy, farthestLy, depthLy }
    this._loaded = false;
  }

  async load(catalog) {
    const res = await fetch('./data/constellations.json');
    const raw = await res.json();

    // Build HIP → index lookup from catalog
    const hipToIdx = new Map();
    for (let i = 0; i < catalog.starCount; i++) {
      hipToIdx.set(catalog.hipIds[i], i);
    }

    for (const [abbrev, data] of Object.entries(raw)) {
      const segments = [];
      const stars = new Set();

      for (const [hipA, hipB] of data.lines) {
        const a = hipToIdx.get(hipA);
        const b = hipToIdx.get(hipB);
        if (a === undefined || b === undefined) continue; // star not in catalog
        segments.push({ a, b });
        stars.add(a);
        stars.add(b);
      }

      if (stars.size === 0) continue; // all stars missing from catalog

      // Centroid in world space
      const centroid = new THREE.Vector3();
      for (const idx of stars) {
        centroid.x += catalog.positions[idx * 3];
        centroid.y += catalog.positions[idx * 3 + 1];
        centroid.z += catalog.positions[idx * 3 + 2];
      }
      centroid.divideScalar(stars.size);

      // Distance stats
      const distances = [...stars].map(idx => catalog.distances[idx]).filter(d => d > 0);
      const nearestLy  = distances.length ? Math.min(...distances) : 0;
      const farthestLy = distances.length ? Math.max(...distances) : 0;
      const depthLy    = farthestLy - nearestLy;

      // Nearest and farthest star index
      let nearestIdx = -1, farthestIdx = -1;
      let minD = Infinity, maxD = -Infinity;
      for (const idx of stars) {
        const d = catalog.distances[idx];
        if (d > 0 && d < minD)  { minD = d;  nearestIdx  = idx; }
        if (d > 0 && d > maxD)  { maxD = d;  farthestIdx = idx; }
      }

      this.constellations[abbrev] = {
        abbrev,
        name: data.name,
        segments,
        stars,
        centroid,
        nearestLy,
        farthestLy,
        depthLy,
        nearestIdx,
        farthestIdx,
      };
    }

    this._loaded = true;
    return this.constellations;
  }

  get loaded() { return this._loaded; }

  /** Returns array of all resolved constellations */
  list() { return Object.values(this.constellations); }
}
