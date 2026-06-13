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
attribute float aHover;

uniform float uTime;
uniform float uMinMag;
uniform float uMaxDist;
uniform float uSizeScale;
uniform float uSizeMin;
uniform float uSizeMax;
uniform float uTightBaseSize;
uniform float uWideBaseSize;
uniform float uBodyMagMin;
uniform float uBodyMagMax;
uniform float uFov;
uniform vec2  uViewport;
uniform mat4  uPrevViewProj;
uniform float uMotionBlur;

varying vec3  vColor;
varying float vSelected;
varying float vAlpha;
varying float vBodyBlend;
varying float vLuminance;
varying vec2  vStreakUV;
varying float vCoreRatio;
varying float vStreakMag;

void main() {
  vColor    = color;
  vSelected = aSelected;

  float magOk  = step(aMagnitude, uMinMag);
  float distOk = step(aDistance, uMaxDist);

  // Pogson luminance — used by fragment for bloom threshold
  float flux = exp(-0.92103 * aMagnitude);
  vLuminance = clamp(pow(flux * 4.0, 0.45), 0.0, 1.0);

  // Body blend: 0 = full wide (bright/low mag), 1 = full tight (dim/high mag)
  vBodyBlend = smoothstep(uBodyMagMin, uBodyMagMax, aMagnitude);

  // Smooth fade near the magnitude cutoff
  float visWeight = clamp((uMinMag - aMagnitude) * 1.5 + 1.0, 0.0, 1.0);
  vAlpha = magOk * distOk * aVisible * visWeight;

  // Size scales continuously with luminance between the two base sizes
  float baseSize  = mix(uTightBaseSize, uWideBaseSize, vLuminance);
  float selBump   = float(aSelected > 0.5) * 1.2;
  float hoverBoost = 1.0 + aHover * 0.55;
  float rawSize   = clamp(baseSize + selBump, uSizeMin, uSizeMax);

  // FOV zoom: flat ≥15°, grows toward 5°
  float fovFactor = 15.0 / clamp(uFov, 5.0, 15.0);

  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPos;

  float physSize = max(rawSize * fovFactor * hoverBoost * uSizeScale, 1.8);

  // Motion blur — screen-space velocity from previous frame view-projection
  vec4  prevClip  = uPrevViewProj * vec4(position, 1.0);
  vec2  curNDC    = gl_Position.xy / max(gl_Position.w,  1e-4);
  vec2  prevNDC   = prevClip.xy    / max(prevClip.w,     1e-4);
  vec2  velPx     = (curNDC - prevNDC) * 0.5 * uViewport * uMotionBlur;
  float streakLen = length(velPx);
  float maxStreak = 48.0;
  if (streakLen > maxStreak) { velPx *= maxStreak / streakLen; streakLen = maxStreak; }

  float enlarged = physSize + streakLen;
  gl_PointSize = enlarged;
  vCoreRatio   = enlarged / max(physSize, 0.001);
  vStreakUV    = vec2(velPx.x, -velPx.y) / max(physSize, 1.0);
  vStreakMag   = streakLen;

  // Edge fade so sprites don't pop at canvas boundary
  vec2 marginNDC = vec2(gl_PointSize * 1.5) / uViewport;
  vec2 edge      = vec2(1.0) - smoothstep(vec2(1.0) - marginNDC, vec2(1.0), abs(curNDC));
  vAlpha        *= edge.x * edge.y;
}
`;

const FRAG = `
varying vec3  vColor;
varying float vSelected;
varying float vAlpha;
varying float vBodyBlend;
varying float vLuminance;
varying vec2  vStreakUV;
varying float vCoreRatio;
varying float vStreakMag;

uniform float uExposure;
uniform sampler2D uStarTex;
uniform sampler2D uStarTexWide;
uniform float uTexGamma;
uniform float uBloomScale;
uniform float uBloomFadeBase;
uniform float uBloomLumMin;
uniform float uBloomLumMax;
uniform float uBloomGamma;
uniform vec3  uPrimaryTint;
uniform float uTightCrop;

void main() {
  if (vAlpha < 0.01) discard;

  vec2  coreUV  = (gl_PointCoord - 0.5) * vCoreRatio + 0.5;
  vec2  tightUV = (coreUV - 0.5) * uTightCrop + 0.5;
  float jit     = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  bool  moving  = vStreakMag >= 0.75;

  // ── Tight texture (star_2d_tight) ─────────────────────────────────────────
  float tight;
  if (!moving) {
    tight = pow(texture2D(uStarTex, tightUV).r, uTexGamma);
  } else {
    float acc = 0.0;
    for (int i = 0; i < 11; i++) {
      float t   = (float(i) + jit) / 11.0 - 0.5;
      vec2  suv = tightUV - vStreakUV * t;
      vec2  inb = step(vec2(0.0), suv) * step(suv, vec2(1.0));
      acc += pow(texture2D(uStarTex, suv).r, uTexGamma) * inb.x * inb.y;
    }
    tight = acc / 11.0;
  }

  // ── Wide texture (star_2d_wide) body ──────────────────────────────────────
  float wide;
  if (!moving) {
    wide = pow(texture2D(uStarTexWide, coreUV).r, uTexGamma);
  } else {
    float acc = 0.0;
    for (int i = 0; i < 11; i++) {
      float t   = (float(i) + jit) / 11.0 - 0.5;
      vec2  suv = coreUV - vStreakUV * t;
      vec2  inb = step(vec2(0.0), suv) * step(suv, vec2(1.0));
      acc += pow(texture2D(uStarTexWide, suv).r, uTexGamma) * inb.x * inb.y;
    }
    wide = acc / 11.0;
  }

  // ── Body: screen-blend tight + wide weighted by vBodyBlend ────────────────
  float tightW = tight * vBodyBlend;
  float wideW  = wide  * (1.0 - vBodyBlend);
  float body   = 1.0 - (1.0 - tightW) * (1.0 - wideW);

  // ── Bloom: wide texture at uBloomScale zoom, driven by luminance ──────────
  float bloomAmt  = smoothstep(uBloomLumMin, uBloomLumMax, vLuminance) * uBloomFadeBase;
  vec2  bloomUV   = (coreUV - 0.5) / max(uBloomScale, 0.001) + 0.5;
  float bloomTex  = pow(texture2D(uStarTexWide, bloomUV).r, uBloomGamma);
  // Thin safety fade at sprite boundary; gamma already crushes near-zero corner values
  float bloomDist = length(gl_PointCoord - vec2(0.5));
  float bloom     = bloomTex * bloomAmt * (1.0 - smoothstep(0.48, 0.5, bloomDist));

  // Screen-blend body + bloom. The texture falloff defines the star shape —
  // no circular clip needed; AdditiveBlending means zero-alpha adds nothing.
  float luma = clamp(1.0 - (1.0 - body) * (1.0 - bloom), 0.0, 1.0);

  if (luma < 0.002) discard;

  // Color dodge — burns toward white at centre
  float core = pow(luma, 1.4);
  vec3 baseCol = (vSelected > 1.5) ? uPrimaryTint : vColor;
  vec3 dodged  = baseCol / max(1.0 - core * 0.75, 0.04);
  float maxChan = max(dodged.r, max(dodged.g, dodged.b));
  vec3 col = maxChan > 1.0 ? dodged / maxChan : dodged;

  // Saturation
  float mean = (col.r + col.g + col.b) / 3.0;
  col = mean + (col - mean) * mix(0.5, 1.4, vLuminance);
  col = max(col, vec3(0.0));

  gl_FragColor = vec4(col, luma * vAlpha * uExposure);
}
`;

const RING_VERT = `
attribute float aMagnitude;
attribute float aIsPrimary;
uniform float uSizeScale;
varying float vIsPrimary;
void main() {
  vIsPrimary = aIsPrimary;
  // Larger ring for brighter (lower magnitude) stars — range mag -2 to 8 → 44px to 22px
  float magT    = clamp((aMagnitude + 2.0) / 10.0, 0.0, 1.0);
  float baseSize = mix(44.0, 22.0, magT);
  // Secondary rings are 52% the size of the primary
  float ringSize = aIsPrimary > 0.5 ? baseSize : baseSize * 0.52;
  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = ringSize * uSizeScale;
  gl_Position = projectionMatrix * mvPos;
}
`;

const RING_FRAG = `
uniform float uTime;
uniform vec3  uSelColor;
varying float vIsPrimary;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);

  // Thin ring band
  float inner = smoothstep(0.38, 0.41, d);
  float outer = smoothstep(0.50, 0.47, d);
  float ring = inner * outer;
  if (ring < 0.01) discard;

  if (vIsPrimary > 0.5) {
    // Primary: solid selection colour with a subtle rotating sheen (single hue)
    float angle = atan(uv.y, uv.x);
    float raw = 0.5 + 0.5 * sin(angle - uTime * 0.56); // slowed to 40%

    float fade = mix(0.5, 1.0, raw);     // gentle sheen sweep
    gl_FragColor = vec4(uSelColor, ring * fade * 0.95);
  } else {
    // Secondary: dimmer selection colour
    gl_FragColor = vec4(uSelColor * 0.5, ring * 0.55);
  }
}
`;

// ─── Screen-space line shaders ───────────────────────────────────────────────
// Each segment is a quad: 4 verts with both endpoints as attributes so the
// vertex shader can compute the screen-space perpendicular for thickness.
const LINE_VERT = `
attribute vec3 aPositionA;
attribute vec3 aPositionB;
attribute float aSide;   // -1 or +1 (left/right of line)
attribute float aT;      // 0 = end A, 1 = end B
attribute float aV;      // 0 = bottom edge, 1 = top edge

uniform float uThickness; // px
uniform vec2  uResolution;

varying float vT;
varying float vV;
varying vec2  vStartScreen; // screen-space position of endpoint A (px)
varying vec2  vEndScreen;   // screen-space position of endpoint B (px)

void main() {
  vec4 clipA = projectionMatrix * modelViewMatrix * vec4(aPositionA, 1.0);
  vec4 clipB = projectionMatrix * modelViewMatrix * vec4(aPositionB, 1.0);

  vec2 ndcA = clipA.xy / clipA.w;
  vec2 ndcB = clipB.xy / clipB.w;

  vStartScreen = (ndcA * 0.5 + 0.5) * uResolution;
  vEndScreen   = (ndcB * 0.5 + 0.5) * uResolution;

  float aspect = uResolution.x / uResolution.y;
  vec2 dir = ndcB - ndcA;
  dir.x *= aspect;
  dir = normalize(dir);
  vec2 perp = vec2(-dir.y, dir.x);
  perp.x /= aspect;

  float thickNDC = uThickness / uResolution.y * 2.0;
  vec4 clipPos = aT < 0.5 ? clipA : clipB;
  clipPos.xy += aSide * perp * thickNDC * clipPos.w;

  vT = aT;
  vV = aV;
  gl_Position = clipPos;
}
`;

const LINE_FRAG = `
uniform float uMidFade;
uniform float uTime;
uniform float uLineOpacity;
uniform vec3  uSelColor;

varying float vT;
varying float vV;
varying vec2  vStartScreen;
varying vec2  vEndScreen;

void main() {
  // Single-hue selection colour, with a gentle brightness flow along the line.
  vec3 dimC    = uSelColor * 0.42;
  vec3 brightC = uSelColor * 1.05;
  float wave = 0.5 + 0.5 * sin((vT - uTime * 0.12) * 3.14159 * 2.0);
  vec3 col   = mix(dimC, brightC, pow(wave, 1.5));

  // Edge softness across the line width
  float edgeT = abs(vV * 2.0 - 1.0);
  float edge  = smoothstep(1.0, 0.4, edgeT);

  float alpha = edge * uLineOpacity;
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(col, alpha);
}
`;
// ─────────────────────────────────────────────────────────────────────────────

export class StarField {
  constructor(catalog) {
    this.catalog = catalog;
    this.points = null;
    this.geometry = null;
    this.rings = null;
    this._ringGeometry = null;
    this._ringMaterial = null;
    this._ringPositions = null;
    this.lineMesh = null;
    this._lineGeom = null;
    this._lineMat = null;

    // Filter state
    this.maxMagnitude = 7.0;
    this.maxDistanceLy = 5000;

    // Per-star mutable attributes
    this._selected = new Float32Array(catalog.starCount);
    this._visible  = new Float32Array(catalog.starCount).fill(1);
    this._hover    = new Float32Array(catalog.starCount);

    this._textures = this._loadStarTextures();
    this._build();
    this._buildRings();
    this._buildLines();
  }

  /**
   * Radial-gaussian star sprite with a trilinear mipmap chain.
   * Fades to transparent BLACK (rgba 0,0,0,0) — never white — so mip averaging
   * doesn't bleed bright squares at the edges. The gaussian lives in the alpha
   * channel; the fragment samples .a as the brightness profile. Mipmaps give
   * distant/small points pre-filtered minification → no shimmer.
   */
  _makeProceduralTex(sigma) {
    const S = 64, c = (S - 1) / 2;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = S;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const r = Math.sqrt((x - c) ** 2 + (y - c) ** 2) / (S * 0.5);
        const a = Math.exp(-r * r * sigma);
        const i = (y * S + x) * 4;
        img.data[i] = img.data[i+1] = img.data[i+2] = Math.round(a * 255);
        img.data[i+3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  }

  _loadStarTextures() {
    const tight = this._makeProceduralTex(7.0);
    const wide  = this._makeProceduralTex(2.5);

    const loader = new THREE.TextureLoader();
    const base = import.meta.env.BASE_URL;

    loader.load(`${base}star_2d_tight.png`, (tex) => {
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      if (this.material) this.material.uniforms.uStarTex.value = tex;
    });

    loader.load(`${base}star_2d_wide.png`, (tex) => {
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      if (this.material) this.material.uniforms.uStarTexWide.value = tex;
    });

    return { tight, wide };
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
    this.geometry.setAttribute('aHover',     new THREE.BufferAttribute(this._hover, 1));

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime:            { value: 0 },
        uMinMag:          { value: this.maxMagnitude },
        uMaxDist:         { value: this.maxDistanceLy },
        uSizeScale:       { value: 1.0 },
        uSizeMin:         { value: 2.6 },
        uSizeMax:         { value: 110.0 },
        uTightBaseSize:   { value: 2.0 },
        uWideBaseSize:    { value: 21.0 },
        uBodyMagMin:      { value: 2.0 },
        uBodyMagMax:      { value: 7.1 },
        uTexGamma:        { value: 2.2 },
        uExposure:        { value: 0.4 },
        uFov:             { value: 70.0 },
        uViewport:        { value: new THREE.Vector2(window.innerWidth, window.innerHeight)
                              .multiplyScalar(Math.min(window.devicePixelRatio || 1, 2)) },
        uPrevViewProj:    { value: new THREE.Matrix4() },
        uMotionBlur:      { value: 0.6 },
        uStarTex:         { value: this._textures.tight },
        uStarTexWide:     { value: this._textures.wide },
        uBloomScale:      { value: 6.0 },
        uBloomFadeBase:   { value: 0.05 },
        uBloomLumMin:     { value: 0.0 },
        uBloomLumMax:     { value: 0.35 },
        uBloomGamma:      { value: 12.0 },
        uTightCrop:       { value: 0.40 },
        uPrimaryTint:     { value: new THREE.Color(1.0, 0.85, 0.4) },
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
    this._ringPositions  = new Float32Array(1000 * 3);
    this._ringMagnitudes = new Float32Array(1000);
    this._ringIsPrimary  = new Float32Array(1000);
    this._ringGeometry = new THREE.BufferGeometry();
    this._ringGeometry.setAttribute('position',   new THREE.BufferAttribute(this._ringPositions, 3));
    this._ringGeometry.setAttribute('aMagnitude', new THREE.BufferAttribute(this._ringMagnitudes, 1));
    this._ringGeometry.setAttribute('aIsPrimary', new THREE.BufferAttribute(this._ringIsPrimary, 1));
    this._ringGeometry.setDrawRange(0, 0);

    this._ringMaterial = new THREE.ShaderMaterial({
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      uniforms: {
        uSizeScale: { value: 1.0 },
        uTime:      { value: 0.0 },
        uSelColor:  { value: new THREE.Color(0.16, 0.34, 0.95) },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.rings = new THREE.Points(this._ringGeometry, this._ringMaterial);
    this.rings.frustumCulled = false;
  }

  _buildLines() {
    const MAX_SEGS = 999;
    const V = MAX_SEGS * 4; // 4 verts per segment

    this._linePosA = new Float32Array(V * 3);
    this._linePosB = new Float32Array(V * 3);
    this._lineSide = new Float32Array(V);
    this._lineT    = new Float32Array(V);
    this._lineV    = new Float32Array(V);

    // Constant per-vertex aSide / aT / aV — fill once
    for (let s = 0; s < MAX_SEGS; s++) {
      const v = s * 4;
      // vert 0: A-end, left edge
      this._lineSide[v]   = -1; this._lineT[v]   = 0; this._lineV[v]   = 0;
      // vert 1: A-end, right edge
      this._lineSide[v+1] = +1; this._lineT[v+1] = 0; this._lineV[v+1] = 1;
      // vert 2: B-end, left edge
      this._lineSide[v+2] = -1; this._lineT[v+2] = 1; this._lineV[v+2] = 0;
      // vert 3: B-end, right edge
      this._lineSide[v+3] = +1; this._lineT[v+3] = 1; this._lineV[v+3] = 1;
    }

    // Constant index buffer — two triangles per segment
    const indices = new Uint32Array(MAX_SEGS * 6);
    for (let s = 0; s < MAX_SEGS; s++) {
      const v = s * 4, t = s * 6;
      indices[t]   = v;   indices[t+1] = v+1; indices[t+2] = v+2;
      indices[t+3] = v+1; indices[t+4] = v+3; indices[t+5] = v+2;
    }

    this._lineGeom = new THREE.BufferGeometry();
    this._lineGeom.setAttribute('aPositionA', new THREE.BufferAttribute(this._linePosA, 3));
    this._lineGeom.setAttribute('aPositionB', new THREE.BufferAttribute(this._linePosB, 3));
    this._lineGeom.setAttribute('aSide',      new THREE.BufferAttribute(this._lineSide, 1));
    this._lineGeom.setAttribute('aT',         new THREE.BufferAttribute(this._lineT,    1));
    this._lineGeom.setAttribute('aV',         new THREE.BufferAttribute(this._lineV,    1));
    this._lineGeom.setIndex(new THREE.BufferAttribute(indices, 1));
    this._lineGeom.setDrawRange(0, 0);
    // Dummy position so Three.js frustum culling doesn't cull it
    this._lineGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(V * 3), 3));

    this._lineMat = new THREE.ShaderMaterial({
      vertexShader:   LINE_VERT,
      fragmentShader: LINE_FRAG,
      uniforms: {
        uThickness:   { value: 3.0 },
        uResolution:  { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
        uMidFade:     { value: 0.30 },
        uLineOpacity: { value: 0.24 },
        uTime:        { value: 0.0 },
        uSelColor:    { value: new THREE.Color(0.16, 0.34, 0.95) },
      },
      transparent: true,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
      side:        THREE.DoubleSide,
    });

    this.lineMesh = new THREE.Mesh(this._lineGeom, this._lineMat);
    this.lineMesh.frustumCulled = false;
  }

  update(time) {
    this.material.uniforms.uTime.value = time;
    if (this._ringMaterial) this._ringMaterial.uniforms.uTime.value = time;
    if (this._lineMat)      this._lineMat.uniforms.uTime.value      = time;
  }


  setScale(scale) {
    this.material.uniforms.uSizeScale.value = scale;
    if (this._ringMaterial) this._ringMaterial.uniforms.uSizeScale.value = scale;
  }

  /** Theme hook: colour of the selection rings + route line (r,g,b in 0–1). */
  setSelectionColor(r, g, b) {
    if (this._ringMaterial) this._ringMaterial.uniforms.uSelColor.value.setRGB(r, g, b);
    if (this._lineMat)      this._lineMat.uniforms.uSelColor.value.setRGB(r, g, b);
  }

  /** Theme hook: tint of the primary-selected star point (r,g,b in 0–1). */
  setPrimaryTint(r, g, b) {
    this.material.uniforms.uPrimaryTint.value.setRGB(r, g, b);
  }

  setLineThickness(v)         { if (this._lineMat) this._lineMat.uniforms.uThickness.value = v; }
  setLineEndFade(v)           { if (this._lineMat) this._lineMat.uniforms.uEndFade?.value !== undefined && (this._lineMat.uniforms.uEndFade.value = v); }
  setLineMidFade(v)           { if (this._lineMat) this._lineMat.uniforms.uMidFade.value = v; }
  setLineOpacity(v)           { if (this._lineMat) this._lineMat.uniforms.uLineOpacity.value = v; }
  setResolution(w, h) {
    if (this._lineMat) this._lineMat.uniforms.uResolution.value.set(w, h);
    // Points edge-fade needs the physical-pixel drawing-buffer size.
    const pr = Math.min(window.devicePixelRatio || 1, 2);
    this.material.uniforms.uViewport.value.set(w * pr, h * pr);
  }

  /** Highlight a set of star indices on hover (pass null to clear). */
  setHoveredStars(indices) {
    this._hover.fill(0);
    if (indices) {
      for (const idx of indices) {
        if (idx >= 0 && idx < this._hover.length) this._hover[idx] = 1;
      }
    }
    this.geometry.attributes.aHover.needsUpdate = true;
  }

  setSizeMin(v)           { this.material.uniforms.uSizeMin.value = v; }
  setSizeMax(v)           { this.material.uniforms.uSizeMax.value = v; }
  setTexGamma(v)          { this.material.uniforms.uTexGamma.value = v; }
  setTightBaseSize(v)     { this.material.uniforms.uTightBaseSize.value = v; }
  setWideBaseSize(v)      { this.material.uniforms.uWideBaseSize.value = v; }
  setBodyMagMin(v)        { this.material.uniforms.uBodyMagMin.value = v; }
  setBodyMagMax(v)        { this.material.uniforms.uBodyMagMax.value = v; }
  setBloomScale(v)        { this.material.uniforms.uBloomScale.value = v; }
  setBloomFadeBase(v)     { this.material.uniforms.uBloomFadeBase.value = v; }
  setBloomLumMin(v)       { this.material.uniforms.uBloomLumMin.value = v; }
  setBloomLumMax(v)       { this.material.uniforms.uBloomLumMax.value = v; }
  setBloomGamma(v)        { this.material.uniforms.uBloomGamma.value = v; }
  setTightCrop(v)         { this.material.uniforms.uTightCrop.value = v; }
  setFov(fov)             { this.material.uniforms.uFov.value = fov; }
  setMotionBlur(v)        { this.material.uniforms.uMotionBlur.value = v; }
  setBaseSize(v)          { /* shelved — use setTightBaseSize / setWideBaseSize */ }

  /**
   * Per-frame camera motion for the motion-blur shader. Call once per frame from
   * the active view BEFORE the scene renders. Stores the previous frame's
   * view-projection so the shader can derive each star's screen velocity.
   */
  updateMotion(camera) {
    if (!this._curViewProj) { this._curViewProj = new THREE.Matrix4(); this._tmpViewProj = new THREE.Matrix4(); }
    camera.updateMatrixWorld();
    this._tmpViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    // On the first frame (or a camera switch) seed both so velocity starts at 0.
    if (this._motionCam !== camera) { this._motionCam = camera; this._curViewProj.copy(this._tmpViewProj); }
    this.material.uniforms.uPrevViewProj.value.copy(this._curViewProj);
    this._curViewProj.copy(this._tmpViewProj);
  }
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

    // Update ring positions + magnitudes + primary flag for all selected stars
    const { positions, magnitudes } = this.catalog;
    let ringIdx = 0;
    for (const idx of selected) {
      if (ringIdx >= 1000) break;
      this._ringPositions[ringIdx * 3]     = positions[idx * 3];
      this._ringPositions[ringIdx * 3 + 1] = positions[idx * 3 + 1];
      this._ringPositions[ringIdx * 3 + 2] = positions[idx * 3 + 2];
      this._ringMagnitudes[ringIdx]         = magnitudes[idx];
      this._ringIsPrimary[ringIdx]          = idx === primary ? 1.0 : 0.0;
      ringIdx++;
    }
    this._ringGeometry.setDrawRange(0, ringIdx);
    this._ringGeometry.attributes.position.needsUpdate   = true;
    this._ringGeometry.attributes.aMagnitude.needsUpdate = true;
    this._ringGeometry.attributes.aIsPrimary.needsUpdate = true;

    // Rebuild line segments connecting selected stars in selection order
    const starArr = [...selected];
    let segCount = 0;
    for (let i = 0; i < starArr.length - 1; i++) {
      const ia = starArr[i], ib = starArr[i + 1];
      for (let v = 0; v < 4; v++) {
        const base = (segCount * 4 + v) * 3;
        this._linePosA[base]   = positions[ia * 3];
        this._linePosA[base+1] = positions[ia * 3 + 1];
        this._linePosA[base+2] = positions[ia * 3 + 2];
        this._linePosB[base]   = positions[ib * 3];
        this._linePosB[base+1] = positions[ib * 3 + 1];
        this._linePosB[base+2] = positions[ib * 3 + 2];
      }
      segCount++;
    }
    this._lineGeom.setDrawRange(0, segCount * 6); // 6 indices per segment
    this._lineGeom.attributes.aPositionA.needsUpdate = true;
    this._lineGeom.attributes.aPositionB.needsUpdate = true;
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
    const fovFactor  = 15.0 / Math.max(5.0, Math.min(15.0, u.uFov.value));
    const computeSize = (mag) => {
      const flux = Math.exp(-0.92103 * mag);
      const lum  = Math.min(1, Math.pow(flux * 4.0, 0.45));
      const size = u.uTightBaseSize.value + (u.uWideBaseSize.value - u.uTightBaseSize.value) * lum;
      return Math.max(u.uSizeMin.value, Math.min(u.uSizeMax.value, size)) * u.uSizeScale.value * fovFactor;
    };

    const MIN_SIZE = 1.5;
    const candidates = [];

    for (let i = 0; i < this.catalog.starCount; i++) {
      if (magnitudes[i] > this.maxMagnitude) continue;
      if (distances[i]  > this.maxDistanceLy) continue;

      // Mirror shader visWeight
      const visWeight = Math.min(1, Math.max(0, (this.maxMagnitude - magnitudes[i]) * 1.5 + 1.0));
      if (visWeight < 0.05) continue;

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

    // Sort by angular proximity first — click the closest star to the cursor.
    // Only prefer brightness when two candidates are within 15% distance of each other
    // (avoids grabbing a bright neighbour over the star you're clearly aiming at).
    candidates.sort((a, b) => {
      const relativeDiff = Math.abs(a.dist - b.dist) / Math.max(a.dist, b.dist);
      if (relativeDiff < 0.15) return a.mag - b.mag;
      return a.dist - b.dist;
    });
    return candidates[0].idx;
  }

  dispose() {
    this.geometry.dispose();
    this.material.uniforms.uMap.value.dispose();
    this.material.dispose();
    this._ringGeometry?.dispose();
    this._ringMaterial?.dispose();
    this._lineGeom?.dispose();
    this._lineMat?.dispose();
  }
}
