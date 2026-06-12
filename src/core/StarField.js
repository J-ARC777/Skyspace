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
uniform float uExposure;
uniform float uBaseSize;
uniform float uBleedFactor;
uniform float uSizeMax;
uniform float uBrightCapLum;
uniform float uBrightCapSize;
uniform float uRefMag;
uniform float uDimBias;
uniform float uZoomScale;
uniform float uFov;
uniform vec2  uViewport; // drawing-buffer size in physical px
uniform mat4  uPrevViewProj; // previous frame's view-projection (for motion blur)
uniform float uMotionBlur;

varying vec3 vColor;
varying float vSelected;
varying float vAlpha;
varying float vLuminance;
varying float vDist;
varying vec2  vStreakUV;  // motion-blur streak vector in core-uv units
varying float vCoreRatio; // enlarged-quad / base-size ratio
varying float vStreakMag; // streak length in px

void main() {
  vColor = color;
  vSelected = aSelected;
  vDist = aDistance;

  float magOk = step(aMagnitude, uMinMag);
  float distOk = step(aDistance, uMaxDist);
  vAlpha = magOk * distOk * aVisible;

  // Pogson log scale — vLuminance passed to frag for brightness
  float flux = exp(-0.92103 * aMagnitude);
  vLuminance = clamp(pow(flux * 4.0, 0.45), 0.0, 1.0);

  // FOV zoom curve: flat ≥15°, grows toward 5°
  float fovFactor = 15.0 / clamp(uFov, 5.0, 15.0);
  float zoomAdjust = pow(fovFactor, uZoomScale);

  // Stop-based size from apparent magnitude.
  // Pogson: 5 mag = 100× = 6.644 stops → 1.329 stops per magnitude.
  float starStops     = (uRefMag - aMagnitude) * 1.329;
  // Wider range: 4.0 multiplier gives −3.8 stops at exp=0.05 (blue hour) and +28 at exp=8 (Hubble)
  float exposureStops = (uExposure - 1.0) * 4.0;
  float totalStops    = exposureStops + starStops;

  // Dim bias: lift stars dimmer than refMag slightly without inverting ordering.
  float dimBias        = uDimBias * max(0.0, -starStops);
  float effectiveStops = max(0.0, totalStops + dimBias);

  // Smooth visibility fade: stars roll off as they approach the exposure threshold
  // rather than snapping on/off. 1.5 roll = ~0.67 stops of fade width.
  float visWeight = clamp(totalStops * 1.5 + 1.0, 0.0, 1.0);
  vAlpha = magOk * distOk * aVisible * visWeight;

  // Exponential size growth with stops above threshold.
  float sizeMultiplier = exp2(effectiveStops * uBleedFactor);

  // Selected stars get a small additive bump.
  float selBump = float(aSelected > 0.5) * 1.2;

  // Magnitude-based size variation for background/faint stars.
  // Faint stars all hit effectiveStops=0 and become identical — this lifts them
  // nonlinearly by magnitude so brighter-faint stars are visibly larger.
  // Only opens up at higher exposures so they stay hidden at blue-hour end.
  float exposureT  = clamp((uExposure - 0.5) / 1.5, 0.0, 1.0);
  float faintMaskS = 1.0 - smoothstep(0.55, 0.85, vLuminance); // exclude already-bright stars
  float magSizeBoost = 1.0 + pow(vLuminance, 0.6) * 1.3 * exposureT * faintMaskS;

  // Bright star floor: top ~1-2% of stars (vLuminance > 0.88) always keep a minimum glow
  // so Sirius-class stars never collapse to a point at low exposure
  float brightFloor = mix(uSizeMin, 4.5, smoothstep(0.88, 1.0, vLuminance));

  // Dynamic size ceiling: sits at ~6.5px until halfway through exposure range,
  // then cranks nonlinearly up to uSizeMax toward the top end.
  float expT = pow(clamp((uExposure - 0.5) / 4.5, 0.0, 1.0), 2.6);
  float dynamicMax = mix(6.5, uSizeMax, expT);

  // Bright cap also ramps from the same base so bright stars grow naturally
  // with exposure — they just have a lower ceiling than dim stars at max exposure.
  float dynamicBrightCap = mix(6.5, uBrightCapSize, expT);
  float brightCapT = smoothstep(uBrightCapLum, uBrightCapLum + 0.20, vLuminance);
  float effectiveMax = mix(dynamicMax, dynamicBrightCap, brightCapT);

  // Cap in pre-zoom space so relative brightness ordering is preserved.
  // NOTE: uSizeScale (devicePixelRatio) is applied at the very end — NOT here —
  // so all px-denominated settings (uSizeMin/uSizeMax/brightFloor/brightCap)
  // stay in CSS-pixel space and aren't slammed into the clamp on HiDPI displays.
  float rawSize = clamp(
    max(brightFloor, (uBaseSize + selBump) * sizeMultiplier * magSizeBoost),
    uSizeMin, effectiveMax
  );

  // Luminance-weighted zoom: bright stars get full zoomAdjust, dim stars get much less
  // so they don't race past the cap and overtake brighter stars when zooming in.
  float lumZoomWeight = smoothstep(0.15, 0.65, vLuminance);
  float lumZoomAdjust = mix(1.0, zoomAdjust, lumZoomWeight);

  // Hover boost: scale up stars belonging to the hovered constellation
  float hoverBoost = 1.0 + aHover * 0.55;

  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  // Final DPR scale converts CSS-pixel sizes → physical pixels uniformly.
  // Floor at ~1.8 physical px so the faintest points never go sub-pixel (which
  // causes shimmer/aliasing); their low alpha keeps them visually subtle.
  float baseSize = max(rawSize * lumZoomAdjust * hoverBoost * uSizeScale, 1.8);
  gl_Position  = projectionMatrix * mvPos;

  // ── Camera motion blur ────────────────────────────────────────────────────
  // Per-star screen-space velocity from the previous frame's view-projection
  // (model is identity for the star cloud, so worldPos = position). Stars streak
  // along their on-screen motion; velocity-scaled, so zero blur at rest.
  vec4  prevClip  = uPrevViewProj * vec4(position, 1.0);
  vec2  curNDC    = gl_Position.xy / max(gl_Position.w, 1e-4);
  vec2  prevNDC   = prevClip.xy    / max(prevClip.w,    1e-4);
  vec2  velPx     = (curNDC - prevNDC) * 0.5 * uViewport * uMotionBlur;
  float streakLen = length(velPx);
  float maxStreak = 48.0;                     // px cap (also guards point-size limit)
  if (streakLen > maxStreak) { velPx *= maxStreak / streakLen; streakLen = maxStreak; }

  // Grow the sprite to hold the streak; the fragment re-centres so the core keeps
  // its base size and averages taps along the streak.
  // BRIGHT stars must NOT enlarge with velocity: their analytic brightness scales
  // with the quad size (vCoreRatio), and per-frame velocity is never perfectly
  // steady during a pan — so a velocity-driven enlargement makes them flicker.
  // Keep their quad at base size (stable); they still streak, capped within the
  // sprite. Faint stars enlarge fully for the long streaks (flicker invisible there).
  float brightW  = smoothstep(uBrightCapLum, uBrightCapLum + 0.12, vLuminance);
  float enlarged = baseSize + streakLen * (1.0 - brightW);
  gl_PointSize = enlarged;
  vCoreRatio   = enlarged / max(baseSize, 0.001);
  // gl_PointCoord's Y axis points DOWN (top-left origin) while screen velocity is
  // Y-up — flip Y so diagonal streaks run along the travel, not perpendicular.
  vStreakUV    = vec2(velPx.x, -velPx.y) / max(baseSize, 1.0); // streak in core-uv units
  vStreakMag   = streakLen;

  // Edge fade: GL discards a point the instant its CENTRE leaves the viewport, so
  // large sprites pop out abruptly at the canvas edge. Fade alpha as the centre
  // approaches the edge (within ~1.5× the sprite size) so stars scroll off
  // smoothly instead of flickering. marginNDC = sprite size expressed in NDC.
  vec2 marginNDC = vec2(gl_PointSize * 1.5) / uViewport;
  vec2 edge      = vec2(1.0) - smoothstep(vec2(1.0) - marginNDC, vec2(1.0), abs(curNDC));
  vAlpha        *= edge.x * edge.y;
}
`;

const FRAG = `
varying vec3 vColor;
varying float vSelected;
varying float vAlpha;
varying float vLuminance;
varying float vDist;
varying vec2  vStreakUV;
varying float vCoreRatio;
varying float vStreakMag;

uniform float uExposure;
uniform float uMinBrightness;
uniform float uExpBrightCompression;
uniform float uFov;
uniform float uBrightCapLum;
uniform float uFarGaussian;
uniform sampler2D uStarTex;
uniform vec3  uPrimaryTint;

void main() {
  if (vAlpha < 0.01) discard;

  // Re-centre/zoom so the star core keeps its base size inside the (possibly
  // enlarged) motion-blur quad. When motion blur is off, vCoreRatio = 1 →
  // coreUV = gl_PointCoord (identical to the non-blurred path).
  vec2 coreUV = (gl_PointCoord - 0.5) * vCoreRatio + 0.5;
  float d = length(coreUV - 0.5) * 2.0;

  float farBias = smoothstep(80.0, 1200.0, vDist) * uFarGaussian * 2.0;
  bool  moving  = vStreakMag >= 0.75;
  // Screen-space jitter (gl_FragCoord, NOT gl_PointCoord) dithers the streak taps
  // into a continuous smear. Screen-space means the dither pattern is fixed to the
  // display and doesn't crawl with the moving star → no per-frame noise/flicker.
  float jit = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);

  // ── tight: small / faint stars → MIPMAPPED sprite ─────────────────────────
  // These get minified (camera-distant), so the mip chain pre-filters them →
  // no minification aliasing/shimmer. Out-of-[0,1] streak taps contribute ZERO
  // (not the clamped edge texel) so the enlarged quad shows only the streak.
  float tight;
  if (!moving) {
    tight = texture2D(uStarTex, coreUV, farBias).a;
  } else {
    float acc = 0.0;
    for (int i = 0; i < 11; i++) {
      float t   = (float(i) + jit) / 11.0 - 0.5;
      vec2  suv = coreUV - vStreakUV * t;
      vec2  inb = step(vec2(0.0), suv) * step(suv, vec2(1.0));
      acc += texture2D(uStarTex, suv, farBias).a * inb.x * inb.y;
    }
    tight = acc / 11.0;
  }

  // ── wide: bright stars → pure ANALYTIC gaussian ───────────────────────────
  // Bright stars are large points (never minified), so they don't need the
  // mipmap — and using it makes them FLICKER, because a large sprite's auto-LOD
  // wobbles as its rasterised size rounds N↔N+1 px while the camera creeps. An
  // analytic profile has no texture LOD at all → rock-stable on slow pans.
  // A single SMOOTH gaussian — no sub-pixel-scale core. A tight centre spike's
  // integrated brightness wobbles with the star's sub-pixel position (and the
  // colour-dodge + bloom amplify it), which read as intensity changing with
  // camera angle. A smooth gaussian spread over several pixels stays stable.
  // Coefficient stays high enough to fade before the quad edge (else it boxes).
  float wide;
  if (!moving) {
    wide = exp(-d * d * 2.8);
  } else {
    float acc = 0.0;
    for (int i = 0; i < 11; i++) {
      float t  = (float(i) + jit) / 11.0 - 0.5;
      vec2  s  = coreUV - vStreakUV * t;
      float dd = length(s - 0.5) * 2.0;
      acc += exp(-dd * dd * 2.8);
    }
    wide = acc / 11.0;
  }

  // Small mipmapped sprite up to the bright-cap luminance; brightest get the halo.
  float profile = smoothstep(uBrightCapLum, uBrightCapLum + 0.12, vLuminance);
  float luma    = mix(tight, wide, profile);

  // Circular filter — clip anything past the (enlarged) quad's inscribed circle so
  // the square point quad can never read as a box. The cutoff radius scales with
  // vCoreRatio, which still contains the motion-blur streak (so streaks aren't cut).
  luma *= 1.0 - smoothstep(vCoreRatio * 0.86, vCoreRatio, d);

  if (luma < 0.004) discard;

  // Color dodge: burns rapidly toward white at center.
  float core = pow(luma, 1.4);
  vec3 baseCol = (vSelected > 1.5) ? uPrimaryTint : vColor;
  vec3 dodged = baseCol / max(1.0 - core * 0.75, 0.04);
  // Normalize by max channel instead of clamping — preserves hue so blue stars stay blue
  float maxChan = max(dodged.r, max(dodged.g, dodged.b));
  vec3 col = maxChan > 1.0 ? dodged / maxChan : dodged;

  // Saturation: dim stars get less, bright stars get full boost
  float baseSat = mix(0.5, 1.4, vLuminance);

  // Zoom boost for mid/faint stars only — bright stars (vLuminance > 0.7) are excluded
  float zoomT = clamp((15.0 - uFov) / 10.0, 0.0, 1.0); // 0 at FOV≥15°, 1 at FOV≤5°
  float faintMask = 1.0 - smoothstep(0.4, 0.75, vLuminance);
  float satBoost = baseSat + zoomT * faintMask * 1.4;

  float mean = (col.r + col.g + col.b) / 3.0;
  col = mean + (col - mean) * satBoost;
  col = max(col, vec3(0.0));

  // Aesthetic grade: yellows → orange, blues → teal
  float yellowness = max(0.0, min(col.r, col.g) - col.b);
  col.g -= yellowness * 0.09;
  col.r += yellowness * 0.03;

  float blueDominance = max(0.0, col.b - max(col.r, col.g));
  col.g += blueDominance * 0.55;

  // Re-normalise after grade
  maxChan = max(col.r, max(col.g, col.b));
  col = maxChan > 1.0 ? col / maxChan : col;

  // Exposure gamma: 1/sqrt(uExposure) — gentler curve than 1/exp.
  // Range 0.25→4 gives lumGamma 2.0→0.5, avoiding near-zero crush at the low end.
  float lumGamma = 1.0 / sqrt(max(uExposure, 0.01));
  // Bright compensation: top-tier stars resist exposure change (blue-hour saturation effect).
  // smoothstep selects brightest ~10% (mag 3+); raising slider past 1 widens the protected tier.
  float brightFactor = smoothstep(0.08, 0.25, vLuminance);
  float effectiveGamma = mix(lumGamma, 1.0, clamp(brightFactor * uExpBrightCompression, 0.0, 1.0));
  // Scale brightness floor with exposure — at low exposure dim stars get no lift
  float adjMinBright = uMinBrightness * clamp(uExposure, 0.0, 1.0);
  float lum = mix(adjMinBright, 1.0, vLuminance);
  float exposedLum = pow(lum, effectiveGamma);
  gl_FragColor = vec4(col, luma * exposedLum * vAlpha * 7.0);
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
  _createStarSprite() {
    const S = 64;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = S;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(S, S);
    const c = (S - 1) / 2;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const dx = (x - c) / (S * 0.5);
        const dy = (y - c) / (S * 0.5);
        const r = Math.sqrt(dx * dx + dy * dy);   // 0 at centre, ~1 at edge
        let a = Math.exp(-r * r * 6.0);            // soft radial gaussian
        if (r > 1.0) a = 0.0;                      // hard circular cutoff
        const i = (y * S + x) * 4;
        img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(a * 255);
      }
    }
    ctx.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter; // trilinear
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
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
        uTime:             { value: 0 },
        uMinMag:           { value: this.maxMagnitude },
        uMaxDist:          { value: this.maxDistanceLy },
        uSizeScale:        { value: 1.0 },
        uSizeMin:          { value: 1.6 },
        uBaseSize:         { value: 2.6 },
        uBleedFactor:      { value: 0.38 },
        uSizeMax:          { value: 60.0 },
        uBrightCapLum:     { value: 0.45 },
        uBrightCapSize:    { value: 11.0 },
        uRefMag:           { value: 4.8 },
        uDimBias:          { value: 0.40 },
        uExposure:         { value: 1.0 },
        uMinBrightness:         { value: 0.130 },
        uExpBrightCompression:  { value: 0.00 },
        uZoomScale:        { value: 1.85 },
        uFov:              { value: 70.0 },
        uViewport:         { value: new THREE.Vector2(window.innerWidth, window.innerHeight)
                               .multiplyScalar(Math.min(window.devicePixelRatio || 1, 2)) },
        uPrevViewProj:     { value: new THREE.Matrix4() },
        uMotionBlur:       { value: 0.6 },
        uFarGaussian:      { value: 0.2 },
        uStarTex:          { value: this._createStarSprite() },
        uPrimaryTint:      { value: new THREE.Color(1.0, 0.85, 0.4) },
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

  setSizeMin(v)               { this.material.uniforms.uSizeMin.value = v; }
  setSizeMax(v)               { this.material.uniforms.uSizeMax.value = v; }
  setBrightCapLum(v)          { this.material.uniforms.uBrightCapLum.value = v; }
  setBrightCapSize(v)         { this.material.uniforms.uBrightCapSize.value = v; }
  setBaseSize(v)              { this.material.uniforms.uBaseSize.value = v; }
  setBleedFactor(v)           { this.material.uniforms.uBleedFactor.value = v; }
  setRefMag(v)                { this.material.uniforms.uRefMag.value = v; }
  setDimBias(v)               { this.material.uniforms.uDimBias.value = v; }
  setZoomScale(v)             { this.material.uniforms.uZoomScale.value = v; }
  setFov(fov)                 { this.material.uniforms.uFov.value = fov; }
  setFarGaussian(v)           { this.material.uniforms.uFarGaussian.value = v; }
  setMotionBlur(v)            { this.material.uniforms.uMotionBlur.value = v; }

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
    const fovFactor   = 15.0 / Math.max(5.0, Math.min(15.0, u.uFov.value));
    const zoomAdjust  = Math.pow(fovFactor, u.uZoomScale.value);
    const expStops    = (u.uExposure.value - 1.0) * 4.0; // matches shader multiplier
    const computeSize = (mag) => {
      const starStops      = (u.uRefMag.value - mag) * 1.329;
      const dimBias        = u.uDimBias.value * Math.max(0, -starStops);
      const effectiveStops = Math.max(0, expStops + starStops + dimBias);
      const mult           = Math.pow(2, effectiveStops * u.uBleedFactor.value);
      return Math.max(u.uSizeMin.value, u.uBaseSize.value * mult) * u.uSizeScale.value * zoomAdjust;
    };

    const MIN_SIZE = 1.5; // px — lowered so faint-but-visible stars remain selectable
    const candidates = [];

    for (let i = 0; i < this.catalog.starCount; i++) {
      if (magnitudes[i] > this.maxMagnitude) continue;
      if (distances[i]  > this.maxDistanceLy) continue;

      // Mirror shader visWeight — skip stars faded out by exposure
      const starStops  = (u.uRefMag.value - magnitudes[i]) * 1.329;
      const expStopsV  = (u.uExposure.value - 1.0) * 4.0;
      const dimBiasV   = u.uDimBias.value * Math.max(0, -starStops);
      const totalStops = expStopsV + starStops + dimBiasV;
      const visWeight  = Math.min(1, Math.max(0, totalStops * 1.5 + 1.0));
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
