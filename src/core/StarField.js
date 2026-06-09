/**
 * StarField
 * Manages the Three.js BufferGeometry point cloud.
 * All stars are always in the scene; visibility is shader-driven.
 */

import * as THREE from 'three';

const VERT = `
attribute float aMagnitude;
attribute float aDistance;
attribute float aSelected;
attribute float aVisible;

uniform float uTime;
uniform float uMinMag;
uniform float uMaxDist;
uniform float uSizeScale;
uniform float uSizeMin;
uniform float uExposure;
uniform float uBaseSize;
uniform float uBleedFactor;
uniform float uRefMag;
uniform float uDimBias;
uniform float uZoomScale;
uniform float uFov;

varying vec3 vColor;
varying float vSelected;
varying float vAlpha;
varying float vLuminance;

void main() {
  vColor = color;
  vSelected = aSelected;

  float magOk = step(aMagnitude, uMinMag);
  float distOk = step(aDistance, uMaxDist);
  vAlpha = magOk * distOk * aVisible;

  // Pogson log scale — vLuminance passed to frag for brightness
  float flux = exp(-0.92103 * aMagnitude);
  vLuminance = pow(clamp(flux / 6.31, 0.0, 1.0), 0.5);

  // FOV zoom curve: flat ≥15°, grows toward 5°
  float fovFactor = 15.0 / clamp(uFov, 5.0, 15.0);
  float zoomAdjust = pow(fovFactor, uZoomScale);

  // Stop-based size from apparent magnitude.
  // Pogson: 5 mag = 100× = 6.644 stops → 1.329 stops per magnitude.
  float starStops     = (uRefMag - aMagnitude) * 1.329;
  float exposureStops = (uExposure - 1.0) * 2.0;
  float totalStops    = exposureStops + starStops;

  // Dim bias: lift stars dimmer than refMag slightly without inverting ordering.
  float dimBias      = uDimBias * max(0.0, -starStops);
  float effectiveStops = max(0.0, totalStops + dimBias);

  // Exponential size growth with stops above threshold.
  float sizeMultiplier = exp2(effectiveStops * uBleedFactor);

  // Selected stars get a small additive bump.
  float selBump = float(aSelected > 0.5) * 1.2;

  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = max(uSizeMin, (uBaseSize + selBump) * sizeMultiplier) * uSizeScale * zoomAdjust;
  gl_Position  = projectionMatrix * mvPos;
}
`;

const FRAG = `
varying vec3 vColor;
varying float vSelected;
varying float vAlpha;
varying float vLuminance;

uniform sampler2D uMap;
uniform float uExposure;
uniform float uMinBrightness;
uniform float uExpBrightCompression;

void main() {
  if (vAlpha < 0.01) discard;

  vec4 texel = texture2D(uMap, gl_PointCoord);
  if (texel.a < 0.01) discard;

  // Color dodge: burns rapidly toward white at center.
  float core = pow(texel.a, 1.4);
  vec3 baseCol = (vSelected > 1.5) ? vec3(1.0, 0.85, 0.4) : vColor;
  vec3 col = min(baseCol / max(1.0 - core * 0.92, 0.04), vec3(1.0));

  // Exposure gamma: 1/sqrt(uExposure) — gentler curve than 1/exp.
  // Range 0.25→4 gives lumGamma 2.0→0.5, avoiding near-zero crush at the low end.
  float lumGamma = 1.0 / sqrt(max(uExposure, 0.01));
  // Bright compensation: top-tier stars resist exposure change (blue-hour saturation effect).
  // smoothstep selects brightest ~10% (mag 3+); raising slider past 1 widens the protected tier.
  float brightFactor = smoothstep(0.08, 0.25, vLuminance);
  float effectiveGamma = mix(lumGamma, 1.0, clamp(brightFactor * uExpBrightCompression, 0.0, 1.0));
  float lum = mix(uMinBrightness, 1.0, vLuminance);
  float exposedLum = pow(lum, effectiveGamma);
  gl_FragColor = vec4(col, texel.a * exposedLum * vAlpha);
}
`;

const RING_VERT = `
uniform float uSizeScale;
void main() {
  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = 22.0 * uSizeScale;
  gl_Position = projectionMatrix * mvPos;
}
`;

const RING_FRAG = `
void main() {
  float d = length(gl_PointCoord - 0.5);
  float inner = smoothstep(0.30, 0.34, d);
  float outer = smoothstep(0.50, 0.46, d);
  float ring = inner * outer;
  if (ring < 0.01) discard;
  gl_FragColor = vec4(1.0, 0.22, 0.12, ring * 0.88);
}
`;

export class StarField {
  constructor(catalog) {
    this.catalog = catalog;
    this.points = null;
    this.geometry = null;
    this.rings = null;
    this._ringGeometry = null;
    this._ringMaterial = null;
    this._ringPositions = null;

    // Filter state
    this.maxMagnitude = 7.0;
    this.maxDistanceLy = 5000;

    // Per-star mutable attributes
    this._selected = new Float32Array(catalog.starCount);
    this._visible  = new Float32Array(catalog.starCount).fill(1);

    this._build();
    this._buildRings();
  }

  _build() {
    const { starCount, positions, colors, magnitudes, distances } = this.catalog;

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions.slice(), 3));
    this.geometry.setAttribute('color',    new THREE.BufferAttribute(colors.slice(), 3));
    this.geometry.setAttribute('aMagnitude', new THREE.BufferAttribute(magnitudes.slice(), 1));
    this.geometry.setAttribute('aDistance',  new THREE.BufferAttribute(distances.slice(), 1));
    this.geometry.setAttribute('aSelected',  new THREE.BufferAttribute(this._selected, 1));
    this.geometry.setAttribute('aVisible',   new THREE.BufferAttribute(this._visible, 1));

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime:             { value: 0 },
        uMinMag:           { value: this.maxMagnitude },
        uMaxDist:          { value: this.maxDistanceLy },
        uMap:              { value: this._createStarTexture() },
        uSizeScale:        { value: 1.0 },
        uSizeMin:          { value: 1.7 },
        uBaseSize:         { value: 2.6 },  // formula at default exposure 1.0: 3.0 - 2.0*(0.75/3.75)
        uBleedFactor:      { value: 0.38 },
        uRefMag:           { value: 4.8 },
        uDimBias:          { value: 0.40 },
        uExposure:         { value: 1.0 },
        uMinBrightness:         { value: 0.165 },
        uExpBrightCompression:  { value: 0.00 },
        uZoomScale:        { value: 1.49 },
        uFov:              { value: 70.0 },
      },
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
  }

  _buildRings() {
    this._ringPositions = new Float32Array(1000 * 3);
    this._ringGeometry = new THREE.BufferGeometry();
    this._ringGeometry.setAttribute('position', new THREE.BufferAttribute(this._ringPositions, 3));
    this._ringGeometry.setDrawRange(0, 0);

    this._ringMaterial = new THREE.ShaderMaterial({
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      uniforms: { uSizeScale: { value: 1.0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.rings = new THREE.Points(this._ringGeometry, this._ringMaterial);
    this.rings.frustumCulled = false;
  }

  update(time) {
    this.material.uniforms.uTime.value = time;
  }

  _createStarTexture() {
    // Fallback: bright tight core, steep dropoff — mirrors a well-exposed star sprite.
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0,    'rgba(255,255,255,1.00)');
    g.addColorStop(0.07, 'rgba(255,255,255,0.92)');
    g.addColorStop(0.22, 'rgba(255,255,255,0.30)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.05)');
    g.addColorStop(1.0,  'rgba(255,255,255,0.00)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    const placeholder = new THREE.CanvasTexture(canvas);

    new THREE.TextureLoader().load(
      '/star_2d_distance.png',
      (tex) => {
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        if (this.material) {
          this.material.uniforms.uMap.value.dispose();
          this.material.uniforms.uMap.value = tex;
        }
      },
      undefined,
      (err) => console.warn('[StarField] star texture failed to load:', err),
    );

    return placeholder;
  }

  setScale(scale) {
    this.material.uniforms.uSizeScale.value = scale;
    if (this._ringMaterial) this._ringMaterial.uniforms.uSizeScale.value = scale;
  }

  setSizeMin(v)               { this.material.uniforms.uSizeMin.value = v; }
  setBaseSize(v)              { this.material.uniforms.uBaseSize.value = v; }
  setBleedFactor(v)           { this.material.uniforms.uBleedFactor.value = v; }
  setRefMag(v)                { this.material.uniforms.uRefMag.value = v; }
  setDimBias(v)               { this.material.uniforms.uDimBias.value = v; }
  setZoomScale(v)             { this.material.uniforms.uZoomScale.value = v; }
  setFov(fov)                 { this.material.uniforms.uFov.value = fov; }
  setMinBrightness(v)         { this.material.uniforms.uMinBrightness.value = v; }
  setExpBrightCompression(v)  { this.material.uniforms.uExpBrightCompression.value = v; }

  setExposure(v) {
    this.material.uniforms.uExposure.value = v;
  }

  setFilter(maxMag, maxDistLy) {
    this.maxMagnitude = maxMag;
    this.maxDistanceLy = maxDistLy;
    this.material.uniforms.uMinMag.value = maxMag;
    this.material.uniforms.uMaxDist.value = maxDistLy;
  }

  updateSelection(selectionState) {
    const { primary, selected } = selectionState;

    for (let i = 0; i < this.catalog.starCount; i++) {
      if (i === primary) {
        this._selected[i] = 2;
      } else if (selected.has(i)) {
        this._selected[i] = 1;
      } else {
        this._selected[i] = 0;
      }
      this._visible[i] = 1.0;
    }

    this.geometry.attributes.aSelected.needsUpdate = true;
    this.geometry.attributes.aVisible.needsUpdate = true;

    // Update ring positions for all selected stars
    const { positions } = this.catalog;
    let ringIdx = 0;
    for (const idx of selected) {
      if (ringIdx >= 1000) break;
      this._ringPositions[ringIdx * 3]     = positions[idx * 3];
      this._ringPositions[ringIdx * 3 + 1] = positions[idx * 3 + 1];
      this._ringPositions[ringIdx * 3 + 2] = positions[idx * 3 + 2];
      ringIdx++;
    }
    this._ringGeometry.setDrawRange(0, ringIdx);
    this._ringGeometry.attributes.position.needsUpdate = true;
  }

  /**
   * Raycast to find the nearest star to a screen ray.
   * Returns star index or -1.
   */
  pick(raycaster, camera) {
    const { positions, magnitudes, distances } = this.catalog;
    const threshold = 0.012; // angular threshold in radians (~0.7°)
    const ray = raycaster.ray;

    // Mirror shader size math to determine if a star is large enough to click
    const u = this.material.uniforms;
    const fovFactor   = 15.0 / Math.max(5.0, Math.min(15.0, u.uFov.value));
    const zoomAdjust  = Math.pow(fovFactor, u.uZoomScale.value);
    const expStops    = (u.uExposure.value - 1.0) * 2.0;
    const computeSize = (mag) => {
      const starStops      = (u.uRefMag.value - mag) * 1.329;
      const dimBias        = u.uDimBias.value * Math.max(0, -starStops);
      const effectiveStops = Math.max(0, expStops + starStops + dimBias);
      const mult           = Math.pow(2, effectiveStops * u.uBleedFactor.value);
      return Math.max(u.uSizeMin.value, u.uBaseSize.value * mult) * u.uSizeScale.value * zoomAdjust;
    };

    const MIN_SIZE = 2.5; // px — stars smaller than this are invisible and unselectable
    const candidates = [];

    for (let i = 0; i < this.catalog.starCount; i++) {
      if (magnitudes[i] > this.maxMagnitude) continue;
      if (distances[i]  > this.maxDistanceLy) continue;
      if (computeSize(magnitudes[i]) < MIN_SIZE) continue;

      const px = positions[i * 3];
      const py = positions[i * 3 + 1];
      const pz = positions[i * 3 + 2];

      const starVec = new THREE.Vector3(px, py, pz);
      const dist    = ray.distanceToPoint(starVec);
      const camDist = camera.position.distanceTo(starVec);

      if (dist < camDist * threshold) {
        candidates.push({ idx: i, mag: magnitudes[i], dist });
      }
    }

    if (candidates.length === 0) return -1;

    // Prefer brighter stars (lower magnitude); use ray distance as tiebreak
    candidates.sort((a, b) => a.mag - b.mag || a.dist - b.dist);
    return candidates[0].idx;
  }

  dispose() {
    this.geometry.dispose();
    this.material.uniforms.uMap.value.dispose();
    this.material.dispose();
    this._ringGeometry?.dispose();
    this._ringMaterial?.dispose();
  }
}
