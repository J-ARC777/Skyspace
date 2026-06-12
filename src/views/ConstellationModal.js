/**
 * ConstellationModal
 * Centered modal triggered by clicking a constellation label.
 *
 * Renders an isolated scene with only the constellation's stars + lines.
 * Mouse drag = orbit around centroid. Scroll = zoom.
 */

import * as THREE from 'three';

export class ConstellationModal {
  constructor(sceneManager, catalog) {
    this.sm      = sceneManager;
    this.catalog = catalog;

    this._open      = false;
    this._constellation = null;
    this._overlay   = null;
    this._container = null;
    this._canvas    = null;
    this._labelOverlay = null;
    this._starLabels   = [];   // { el, pos3D: THREE.Vector3 }
    this._renderer  = null;
    this._scene     = null;
    this._camera    = null;
    this._rafId     = null;
    this._lastT     = 0;

    // Orbit state
    this._orbitTheta   = 0.4;
    this._orbitPhi     = 0.3;
    this._orbitRadius  = 10;
    this._orbitTarget  = new THREE.Vector3();
    this._dragging     = false;
    this._lastMouseX   = 0;
    this._lastMouseY   = 0;
    this._hoveredStar  = null;
    this._meshes       = [];

    // Modal drag state
    this._modalDragging = false;
    this._dragOffX = 0;
    this._dragOffY = 0;

    this._injectStyles();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  open(constellation, appEl) {
    if (this._open) this._close();
    this._open = true;
    this._constellation = constellation;
    this._appEl = appEl;
    this._starLabelData = [];
    this._hoveredStar   = null;
    this._meshes        = [];
    this._orbitTarget   = new THREE.Vector3();
    this._build(appEl);
    this._buildScene();
    this._buildRenderer();
    this._buildAxisWidget();
    this._buildPanLine();
    this._buildLabels();
    this._bindOrbitEvents();
    this._startLoop();
  }

  close() { this._close(); }

  get isOpen() { return this._open; }

  // ── Private ─────────────────────────────────────────────────────────────────

  _buildScene() {
    this._scene = new THREE.Scene();

    const con = this._constellation;
    const c   = con.centroid;

    // Compute orbit radius from star spread (80th-percentile distance from centroid)
    const dists = [];
    for (const idx of con.stars) {
      const dx = this.catalog.positions[idx * 3]     - c.x;
      const dy = this.catalog.positions[idx * 3 + 1] - c.y;
      const dz = this.catalog.positions[idx * 3 + 2] - c.z;
      dists.push(Math.sqrt(dx*dx + dy*dy + dz*dz));
    }
    dists.sort((a, b) => a - b);
    const p80idx = Math.floor(dists.length * 0.80);
    const SPREAD_SCALE = 1.0;
    this._maxDist = Math.max(dists[p80idx] ?? dists[dists.length - 1], 1) * SPREAD_SCALE;

    // Furthest star distance from Sol (parsecs) — used as pan rail upper bound
    let maxStarDistPC = 1;
    for (const idx of con.stars) {
      const sx = this.catalog.positions[idx * 3];
      const sy = this.catalog.positions[idx * 3 + 1];
      const sz = this.catalog.positions[idx * 3 + 2];
      const d  = Math.sqrt(sx*sx + sy*sy + sz*sz);
      if (d > maxStarDistPC) maxStarDistPC = d;
    }
    this._panMaxT = maxStarDistPC; // pan rail: [0, _panMaxT] along Sol→centroid axis

    const cLen = Math.sqrt(c.x*c.x + c.y*c.y + c.z*c.z) || 1;
    this._orbitRadius = cLen;
    this._centroid    = c.clone();

    // Direction from Sol → centroid, used to constrain middle-mouse pan to the axis
    this._solToCentroidDir = new THREE.Vector3(c.x, c.y, c.z).normalize();

    // Initialise orbit angles so camera starts at Sol's position relative to centroid.
    // Direction from centroid → Sol is simply -c (normalised).
    this._orbitTheta = Math.atan2(-c.x, -c.z);
    this._orbitPhi   = Math.acos(Math.max(-1, Math.min(1, -c.y / cLen)));
    // Store initial angles for "return to earth view" detection
    this._initialTheta  = this._orbitTheta;
    this._initialPhi    = this._orbitPhi;
    // Lerp target (null = not lerping)
    this._lerpTarget    = null;

    // Compute the correct camera up vector for the earth-perspective view.
    // Hipparcos coords: x=cos(dec)cos(ra), y=cos(dec)sin(ra), z=sin(dec),
    // so celestial north = (0, 0, 1).  Project it onto the camera view plane.
    const north   = new THREE.Vector3(0, 0, 1);
    const lookDir = new THREE.Vector3(c.x, c.y, c.z).normalize(); // Sol→centroid
    const upVec   = north.clone().sub(lookDir.clone().multiplyScalar(north.dot(lookDir)));
    this._cameraUp = upVec.lengthSq() > 1e-4
      ? upVec.normalize()
      : new THREE.Vector3(0, 1, 0); // fallback for pole-on views

    // ── Background star field (full catalog, gray, for spatial context) ──────
    {
      // Only the brightest 15% by apparent magnitude (lower vmag = brighter)
      const mags = Array.from(this.catalog.magnitudes).sort((a, b) => a - b);
      const magCutoff = mags[Math.floor(mags.length * 0.01)];

      const filtered = [];
      for (let i = 0; i < this.catalog.starCount; i++) {
        if (this.catalog.magnitudes[i] <= magCutoff) filtered.push(i);
      }
      const n   = filtered.length;
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const idx = filtered[i];
        pos[i * 3]     = this.catalog.positions[idx * 3]     - c.x;
        pos[i * 3 + 1] = this.catalog.positions[idx * 3 + 1] - c.y;
        pos[i * 3 + 2] = this.catalog.positions[idx * 3 + 2] - c.z;
      }
      const bgGeo = new THREE.BufferGeometry();
      bgGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const bgMat = new THREE.PointsMaterial({
        color:           0x6a7f99,
        size:            2.5,
        sizeAttenuation: false,
        transparent:     true,
        opacity:         0.15,
        depthWrite:      false,
      });
      this._bgStarGeo = bgGeo;
      this._bgStarMat = bgMat;
      this._scene.add(new THREE.Points(bgGeo, bgMat));
    }

    // ── Sol marker ───────────────────────────────────────────────────────────
    // Sol is at world origin; in local (centroid-relative) space it's at -c
    {
      const solPos = new Float32Array([-c.x, -c.y, -c.z]);
      const solGeo = new THREE.BufferGeometry();
      solGeo.setAttribute('position', new THREE.BufferAttribute(solPos, 3));
      const solTex = this._createGlowTexture();
      const solMat = new THREE.PointsMaterial({
        color:           0xffe066,
        size:            22,
        map:             solTex,
        sizeAttenuation: false,
        transparent:     true,
        opacity:         1.0,
        depthWrite:      false,
        blending:        THREE.AdditiveBlending,
        alphaTest:       0.002,
      });
      this._solGeo = solGeo;
      this._solMat = solMat;
      const solPosVec = new THREE.Vector3(-c.x, -c.y, -c.z);
      const solEntry  = { pos: solPosVec, name: 'Sol', dist: '0 ly', isSol: true,
                          baseR: 1.0, baseG: 0.88, baseB: 0.40 };
      this._meshes.push(solEntry);
      this._starLabelData.push({ pos: solPosVec, name: 'Sol', dist: '0 ly' });
      this._scene.add(new THREE.Points(solGeo, solMat));
      this._buildRangeMarkers(solPosVec);
      this._solScenePos = solPosVec.clone(); // pan rail anchor
    }

    // ── Star sprites ─────────────────────────────────────────────────────────
    const starList = [...con.stars];
    const count    = starList.length;
    const positions = new Float32Array(count * 3);
    const colors    = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const idx = starList[i];
      const sx = (this.catalog.positions[idx * 3]     - c.x) * SPREAD_SCALE;
      const sy = (this.catalog.positions[idx * 3 + 1] - c.y) * SPREAD_SCALE;
      const sz = (this.catalog.positions[idx * 3 + 2] - c.z) * SPREAD_SCALE;
      positions[i * 3]     = sx;
      positions[i * 3 + 1] = sy;
      positions[i * 3 + 2] = sz;

      colors[i * 3]     = this.catalog.colors[idx * 3];
      colors[i * 3 + 1] = this.catalog.colors[idx * 3 + 1];
      colors[i * 3 + 2] = this.catalog.colors[idx * 3 + 2];

      const name = this.catalog.getStarName(idx) || `HIP ${this.catalog.hipIds[idx]}`;
      const dist = this.catalog.distances[idx];
      const distStr = dist > 0
        ? (dist < 10 ? dist.toFixed(1) : Math.round(dist)) + ' ly' : '—';
      const pos = new THREE.Vector3(sx, sy, sz);
      this._starLabelData.push({ pos, name, dist: distStr });
      // _meshes repurposed as star data (no Three mesh — hit-tested in screen space)
      this._meshes.push({ pos, name, dist: distStr,
        baseR: colors[i*3], baseG: colors[i*3+1], baseB: colors[i*3+2] });
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));

    const tex = this._createGlowTexture();
    const mat = new THREE.PointsMaterial({
      size:            14,
      map:             tex,
      vertexColors:    true,
      transparent:     true,
      depthWrite:      false,
      sizeAttenuation: false,
      blending:        THREE.AdditiveBlending,
      alphaTest:       0.002,
    });
    this._starPoints   = new THREE.Points(geo, mat);
    this._starMat      = mat;
    this._starColors   = colors;
    this._starGeo      = geo;
    this._baseStarSize = 14;
    this._scene.add(this._starPoints);

    // Hover highlight overlay — single point, larger, drawn on top
    this._hoverGeo = new THREE.BufferGeometry();
    this._hoverGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    this._hoverGeo.setAttribute('color',    new THREE.BufferAttribute(new Float32Array([1,1,1]), 3));
    this._hoverMat = new THREE.PointsMaterial({
      size: 14 * 1.20, map: tex, vertexColors: true,
      transparent: true, depthWrite: false,
      sizeAttenuation: false, blending: THREE.AdditiveBlending, alphaTest: 0.002,
    });
    this._hoverPoints = new THREE.Points(this._hoverGeo, this._hoverMat);
    this._hoverPoints.visible = false;
    this._scene.add(this._hoverPoints);

    // ── Camera ────────────────────────────────────────────────────────────────
    this._camera = new THREE.PerspectiveCamera(60, 1, 0.01, 50000);
    this._camera.up.copy(this._cameraUp);
    this._setCameraFromAngles();
    this._fitFovToConstellation();
    this._initialOrbitRadius = this._orbitRadius;
    this._initialCamPos = this._camera.position.clone();
  }

  _createGlowTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0,    'rgba(255,255,255,1.00)');
    g.addColorStop(0.05, 'rgba(255,255,255,1.00)');
    g.addColorStop(0.18, 'rgba(255,255,255,0.65)');
    g.addColorStop(0.40, 'rgba(255,255,255,0.18)');
    g.addColorStop(0.70, 'rgba(255,255,255,0.04)');
    g.addColorStop(1.0,  'rgba(255,255,255,0.00)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(canvas);
  }

  _fitFovToConstellation() {
    if (!this._meshes.length) return;
    const camPos      = this._camera.position.clone();
    const toCentroid  = new THREE.Vector3().sub(camPos).normalize(); // origin is centroid
    let   maxAngle    = 0;

    for (const entry of this._meshes) {
      if (entry.isSol) continue; // Sol is far outside the constellation — exclude from FOV fit
      const toStar = entry.pos.clone().sub(camPos).normalize();
      const angle  = Math.acos(Math.max(-1, Math.min(1, toCentroid.dot(toStar))));
      maxAngle = Math.max(maxAngle, angle);
    }

    // Full cone = 2× half-angle, padded by 35% so stars aren't at the very edge
    const fovDeg = (maxAngle * 2 * (180 / Math.PI)) * 1.35;
    this._camera.fov = Math.max(5, Math.min(120, fovDeg));
    this._camera.updateProjectionMatrix();
  }

  /** Used only for initial camera placement from phi/theta angles. */
  _setCameraFromAngles() {
    const phi = Math.max(0.05, Math.min(Math.PI - 0.05, this._orbitPhi));
    const dx  = this._orbitRadius * Math.sin(phi) * Math.sin(this._orbitTheta);
    const dy  = this._orbitRadius * Math.cos(phi);
    const dz  = this._orbitRadius * Math.sin(phi) * Math.cos(this._orbitTheta);
    this._camera.position.set(
      this._orbitTarget.x + dx,
      this._orbitTarget.y + dy,
      this._orbitTarget.z + dz,
    );
    this._camera.lookAt(this._orbitTarget);
  }

  /** Quaternion orbit — rotates camera position around orbit target.
   *  yawAxis  = celestial north (0,0,1), pitchAxis = camera's current right.
   *  No gimbal lock regardless of camera orientation. */
  _orbitCamera(dx, dy) {
    const offset = this._camera.position.clone().sub(this._orbitTarget);

    // Yaw: rotate around celestial north
    const north  = new THREE.Vector3(0, 0, 1);
    const yawQ   = new THREE.Quaternion().setFromAxisAngle(north, -dx * 0.005);
    offset.applyQuaternion(yawQ);
    this._camera.up.applyQuaternion(yawQ).normalize();

    // Pitch: rotate around camera's current right axis
    const lookDir = offset.clone().normalize().negate();
    const right   = new THREE.Vector3().crossVectors(lookDir, this._camera.up).normalize();
    const pitchQ  = new THREE.Quaternion().setFromAxisAngle(right, -dy * 0.005);
    offset.applyQuaternion(pitchQ);
    this._camera.up.applyQuaternion(pitchQ).normalize();

    // Preserve orbit radius
    offset.setLength(this._orbitRadius);
    this._camera.position.copy(this._orbitTarget).add(offset);
    this._camera.lookAt(this._orbitTarget);
  }

  _buildPanLine() {
    // 64-point polyline along the Sol→centroid axis, shown while middle-mouse panning.
    // Vertex colors create a bell-curve fade — bright at orbit target, dark at both ends.
    const N   = 64;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));
    const mat = new THREE.ShaderMaterial({
      vertexShader: `
        attribute vec3 color;
        varying   vec3 vColor;
        void main() {
          vColor      = color;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        void main() {
          float a = length(vColor) * 1.732; // approx brightness 0..1
          if (a < 0.01) discard;
          gl_FragColor = vec4(vColor, a);
        }
      `,
      transparent: true,
      depthTest:   false,
      depthWrite:  false,
    });
    this._panLine         = new THREE.Line(geo, mat);
    this._panLine.frustumCulled = false;
    this._panLine.visible = false;
    this._scene.add(this._panLine);
  }

  _updatePanLine() {
    if (!this._panLine || !this._camera || !this._solToCentroidDir) return;
    this._panLine.visible = this._panning;
    if (!this._panning) return;

    const N      = 64;
    const posArr = this._panLine.geometry.attributes.position.array;
    const colArr = this._panLine.geometry.attributes.color.array;

    // Line spans from Sol to furthest star along the axis, centred on orbit target.
    // Half-length = full rail length so the line fills Sol→furthestStar.
    const solPos  = this._solScenePos  || new THREE.Vector3();
    const halfLen = (this._panMaxT || this._orbitRadius);
    const lineStart = solPos.clone();
    const lineEnd   = solPos.clone().add(
      this._solToCentroidDir.clone().multiplyScalar(halfLen)
    );

    // Project orbit target onto axis to find its 0–1 position along the line
    const fromSol   = this._orbitTarget.clone().sub(solPos);
    const tNorm     = Math.max(0, Math.min(1,
      fromSol.dot(this._solToCentroidDir) / halfLen
    ));

    for (let i = 0; i < N; i++) {
      const u = i / (N - 1); // 0..1 along the line
      const pt = lineStart.clone().lerp(lineEnd, u);
      posArr[i * 3]     = pt.x;
      posArr[i * 3 + 1] = pt.y;
      posArr[i * 3 + 2] = pt.z;

      // Bell-curve centred on orbit target's normalised position along the rail
      const dist  = Math.abs(u - tNorm);
      const alpha = Math.exp(-dist * dist * 120); // narrow Gaussian, ~30% of line lit
      // Accent blue (100, 180, 255)
      colArr[i * 3]     = (100 / 255) * alpha;
      colArr[i * 3 + 1] = (180 / 255) * alpha;
      colArr[i * 3 + 2] = (255 / 255) * alpha;
    }

    this._panLine.geometry.attributes.position.needsUpdate = true;
    this._panLine.geometry.attributes.color.needsUpdate    = true;
  }


  _buildLabels() {
    this._labelOverlay = this._container.querySelector('.const-modal-label-overlay');
    this._starLabels = [];
    for (const { pos, name, dist } of (this._starLabelData || [])) {
      const el = document.createElement('div');
      el.className = 'star-label';
      el.innerHTML = `<span class="star-label-name">${name}</span><span class="star-label-dist">${dist}</span>`;
      el.style.opacity = '0';
      this._labelOverlay.appendChild(el);
      this._starLabels.push({ el, pos });
    }

    // Range labels — always visible, positioned along the Sol→centroid line
    this._rangeLabelEls = [];
    for (const { pos, text } of (this._rangeLabelPositions || [])) {
      const el = document.createElement('div');
      el.className = 'range-label';
      el.textContent = text;
      this._labelOverlay.appendChild(el);
      this._rangeLabelEls.push({ el, pos });
    }
  }

  _updateLabels() {
    if (!this._camera) return;
    const W = this._canvas.clientWidth;
    const H = this._canvas.clientHeight;
    const v = new THREE.Vector3();

    // Star / Sol hover labels
    for (let i = 0; i < this._starLabels.length; i++) {
      const { el, pos } = this._starLabels[i];
      const isActive = this._meshes[i] === this._hoveredStar;
      if (!isActive) { el.style.opacity = '0'; continue; }

      v.copy(pos).project(this._camera);
      if (v.z > 1) { el.style.opacity = '0'; continue; }

      const x = (v.x *  0.5 + 0.5) * W;
      const y = (v.y * -0.5 + 0.5) * H;
      el.style.opacity = '1';
      el.style.left    = x + 'px';
      el.style.top     = (y - 28) + 'px';
    }

    // Range labels — opacity driven by _updateRangeFade; just update position
    for (const { el, pos } of (this._rangeLabelEls || [])) {
      v.copy(pos).project(this._camera);
      if (v.z > 1) { el.style.opacity = '0'; continue; }
      const x = (v.x *  0.5 + 0.5) * W;
      const y = (v.y * -0.5 + 0.5) * H;
      el.style.left = x + 'px';
      el.style.top  = (y - 6) + 'px';
    }
  }

  _updateHoverOverlay() {
    if (!this._hoverPoints || !this._hoverGeo) return;
    if (!this._hoveredStar) {
      this._hoverPoints.visible = false;
      return;
    }
    const p = this._hoverGeo.attributes.position.array;
    p[0] = this._hoveredStar.pos.x;
    p[1] = this._hoveredStar.pos.y;
    p[2] = this._hoveredStar.pos.z;
    this._hoverGeo.attributes.position.needsUpdate = true;
    const c = this._hoverGeo.attributes.color.array;
    c[0] = this._hoveredStar.baseR;
    c[1] = this._hoveredStar.baseG;
    c[2] = this._hoveredStar.baseB;
    this._hoverGeo.attributes.color.needsUpdate = true;
    this._hoverPoints.visible = true;
  }

  _buildRangeMarkers(solPos) {
    const LY_TO_PC = 1 / 3.26156;
    this._solLocalPos = solPos.clone();
    this._rangeGeos   = [];
    this._rangeMats   = [];
    this._sphereData  = []; // { mat, radiusPC } for per-frame fade

    const VERT = `
      varying vec3 vNormal;
      varying vec3 vViewDir;
      void main() {
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        vNormal  = normalize(normalMatrix * normal);
        vViewDir = normalize(-mvPos.xyz);
        gl_Position = projectionMatrix * mvPos;
      }
    `;
    const FRAG = `
      varying vec3 vNormal;
      varying vec3 vViewDir;
      uniform float uOpacity;
      void main() {
        float fresnel = pow(1.0 - clamp(dot(vNormal, vViewDir), 0.0, 1.0), 1.8);
        gl_FragColor = vec4(0.19, 0.36, 0.70, fresnel * uOpacity);
      }
    `;

    const RADII_LY = [10, 50, 100, 200, 500, 1000, 2000, 4000];
    for (const ly of RADII_LY) {
      const r   = ly * LY_TO_PC;
      const geo = new THREE.SphereGeometry(r, 64, 48);
      const mat = new THREE.ShaderMaterial({
        vertexShader:   VERT,
        fragmentShader: FRAG,
        uniforms:       { uOpacity: { value: 0.0 } },
        transparent:    true,
        depthWrite:     false,
        side:           THREE.FrontSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(solPos);
      mesh.frustumCulled = false;
      this._scene.add(mesh);
      this._rangeGeos.push(geo);
      this._rangeMats.push(mat);
      this._sphereData.push({ mat, radiusPC: r });
    }

    // Range label positions — sit on the celestial-north pole of each sphere
    const northUp = new THREE.Vector3(0, 0, 1);
    this._rangeLabelPositions = RADII_LY.map(ly => ({
      pos:  solPos.clone().add(northUp.clone().multiplyScalar(ly * LY_TO_PC)),
      text: `${ly} ly`,
    }));

    // Heliocentric equatorial grid — circular fade, 50 ly spacing, fades out at 75k ly.
    // KEY: pass position.xy as a varying and compute length() per-FRAGMENT, not per-vertex.
    // If we compute length in the vertex shader and interpolate, long lines have high
    // vDistLy at both endpoints so the interpolated midpoint also reads as far → discarded.
    // Computing length per-fragment uses the correct interpolated XY position.
    const PC_TO_LY       = 3.26156;
    const GRID_RADIUS_LY = 5000;
    const GRID_STEP_LY   = 50;              // 50 ly — visible at constellation scales
    const GRID_RADIUS_PC = GRID_RADIUS_LY * LY_TO_PC;
    const GRID_STEP_PC   = GRID_STEP_LY   * LY_TO_PC;

    const gridVert = `
      varying vec2 vXY;
      void main() {
        vXY = position.xy;            // local XY in parsecs relative to Sol
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;
    const gridFrag = `
      varying vec2 vXY;
      void main() {
        float distLy = length(vXY) * ${PC_TO_LY.toFixed(5)};
        float fade = 1.0 - smoothstep(3500.0, 5000.0, distLy);
        if (fade < 0.008) discard;
        gl_FragColor = vec4(0.10, 0.22, 0.38, 0.14 * fade);
      }
    `;
    const gridMat = new THREE.ShaderMaterial({
      vertexShader:   gridVert,
      fragmentShader: gridFrag,
      transparent:    true,
      depthWrite:     false,
    });

    const steps = Math.ceil(GRID_RADIUS_LY / GRID_STEP_LY);
    const gridPts = [];
    for (let i = -steps; i <= steps; i++) {
      const t = i * GRID_STEP_PC;
      // Clip each line to the circle so edges are rounded, not square
      const halfSpan = Math.sqrt(Math.max(0, GRID_RADIUS_PC * GRID_RADIUS_PC - t * t));
      if (halfSpan < 1e-6) continue;
      gridPts.push(-halfSpan, t, 0,  halfSpan, t, 0); // horizontal at y=t
      gridPts.push(t, -halfSpan, 0,  t,  halfSpan, 0); // vertical at x=t
    }
    const gridGeo = new THREE.BufferGeometry();
    gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gridPts, 3));
    const gridLines = new THREE.LineSegments(gridGeo, gridMat);
    gridLines.position.copy(solPos);
    gridLines.frustumCulled = false;
    this._scene.add(gridLines);
    this._rangeGeos.push(gridGeo);
    this._rangeMats.push(gridMat);
  }

  /** Pan: slide both camera and orbit target along the Sol→centroid axis.
   *  Mouse movement is projected onto the screen-space representation of the axis,
   *  so dragging in the axis direction moves deeper into / back out of the constellation.
   *  The orbit target stays on the meaningful Sol→centroid line at all times. */
  _panCamera(dx, dy) {
    if (!this._camera || !this._solToCentroidDir) return;
    const W = this._canvas.clientWidth  || 1;
    const H = this._canvas.clientHeight || 1;

    // Project a small step along the 3D axis to find its 2D screen direction
    const p0 = this._orbitTarget.clone().project(this._camera);
    const p1 = this._orbitTarget.clone()
      .add(this._solToCentroidDir.clone().multiplyScalar(0.1))
      .project(this._camera);

    const axSx = (p1.x - p0.x) * W * 0.5;
    const axSy = -(p1.y - p0.y) * H * 0.5; // flip Y (screen vs NDC)
    const axLen = Math.sqrt(axSx * axSx + axSy * axSy);

    // Project mouse movement onto that screen-space direction.
    // Fall back to dy when axis is nearly perpendicular to the screen (pointing straight at us).
    const proj = axLen > 1.0
      ? (dx * axSx + dy * axSy) / axLen
      : -dy;

    const scale = 2 * Math.tan(this._camera.fov * Math.PI / 360) * this._orbitRadius / H;
    const delta = this._solToCentroidDir.clone().multiplyScalar(proj * scale);
    this._camera.position.add(delta);
    this._orbitTarget.add(delta);

    // Clamp orbit target to the rail between Sol and the furthest constellation star.
    // Project current orbit target onto the Sol→centroid axis and clamp to [0, _panMaxT].
    if (this._solScenePos && this._panMaxT) {
      const fromSol = this._orbitTarget.clone().sub(this._solScenePos);
      const t       = fromSol.dot(this._solToCentroidDir);
      const tClamped = Math.max(0, Math.min(this._panMaxT, t));
      const clamped  = this._solScenePos.clone()
        .add(this._solToCentroidDir.clone().multiplyScalar(tClamped));
      const correction = clamped.clone().sub(this._orbitTarget);
      this._orbitTarget.copy(clamped);
      this._camera.position.add(correction);
    }
  }

  _buildAxisWidget() {
    this._axisScene = new THREE.Scene();

    // All arrows live inside a group — we rotate the group each frame
    // rather than moving the camera, so the camera always looks at origin.
    this._axisGroup = new THREE.Group();
    this._axisScene.add(this._axisGroup);

    // Axes: X=red, Y=green, Z=blue (Hipparcos z = celestial north)
    const AXES = [
      { dir: new THREE.Vector3(1, 0, 0), color: 0xff4455 },
      { dir: new THREE.Vector3(0, 1, 0), color: 0x44dd66 },
      { dir: new THREE.Vector3(0, 0, 1), color: 0x4499ff },
    ];
    const LEN = 0.72, HEAD = 0.22, HEAD_R = 0.09;
    for (const { dir, color } of AXES) {
      const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(), LEN, color, HEAD, HEAD_R);
      arrow.line.material.transparent = true;
      arrow.line.material.opacity     = 0.90;
      arrow.cone.material.transparent = true;
      arrow.cone.material.opacity     = 0.90;
      this._axisGroup.add(arrow);
      // Dimmer negative stub
      const neg = new THREE.ArrowHelper(
        dir.clone().negate(), new THREE.Vector3(), LEN * 0.45, color, 0, 0,
      );
      neg.line.material.transparent = true;
      neg.line.material.opacity     = 0.22;
      this._axisGroup.add(neg);
    }

    // Camera is fixed — always at +Z looking toward origin
    this._axisCamera = new THREE.OrthographicCamera(-1.1, 1.1, 1.1, -1.1, 0.1, 10);
    this._axisCamera.position.set(0, 0, 3);
    this._axisCamera.lookAt(0, 0, 0);
  }

  _renderAxisWidget() {
    if (!this._axisScene || !this._axisGroup || !this._camera || !this._renderer) return;

    // Rotate the axis group by the INVERSE of the main camera's quaternion.
    // This keeps the arrows aligned to world space as seen from the camera.
    this._axisGroup.quaternion.copy(this._camera.quaternion).invert();

    const dpr  = this._renderer.getPixelRatio();
    const rw   = this._renderer.domElement.width;
    const rh   = this._renderer.domElement.height;
    const SIZE = Math.round(80 * dpr);
    const PAD  = Math.round(14 * dpr);

    this._renderer.setScissorTest(true);
    this._renderer.setScissor(PAD, PAD, SIZE, SIZE);
    this._renderer.setViewport(PAD, PAD, SIZE, SIZE);
    this._renderer.autoClear = false;
    this._renderer.clearDepth();
    this._renderer.render(this._axisScene, this._axisCamera);
    this._renderer.autoClear = true;
    this._renderer.setScissorTest(false);
    this._renderer.setViewport(0, 0, rw, rh);
  }

  _buildRenderer() {
    this._canvas = this._container.querySelector('.const-modal-canvas');
    this._renderer = new THREE.WebGLRenderer({
      canvas: this._canvas,
      alpha: true,
      antialias: true,
    });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.setClearColor(0x000000, 0);
    this._resizeRenderer();
  }

  _resizeRenderer() {
    if (!this._canvas || !this._renderer) return;
    const w = this._canvas.clientWidth;
    const h = this._canvas.clientHeight;
    if (w > 0 && h > 0) {
      this._renderer.setSize(w, h, false);
      if (this._camera) {
        this._camera.aspect = w / h;
        this._camera.updateProjectionMatrix();
      }
    }
  }

  _startLoop() {
    this._lastT = performance.now();
    const tick = (now) => {
      if (!this._open) return;
      this._rafId = requestAnimationFrame(tick);
      const dt = Math.min((now - this._lastT) / 1000, 0.1);
      this._lastT = now;
      this._tickLerp(dt);
      this._resizeRenderer();
      this._updateStarSize();
      this._updateRangeFade();
      this._updatePanLine();
      this._updateReturnButton();
      this._renderer.render(this._scene, this._camera);
      this._renderAxisWidget();
      this._updateLabels();
    };
    this._rafId = requestAnimationFrame(tick);
  }

  _tickLerp(dt) {
    if (!this._lerpTarget || !this._camera) return;
    const k = 1 - Math.pow(0.004, dt); // exponential decay, ~0.7s settle

    this._camera.position.lerp(this._lerpTarget, k);
    if (this._lerpOrbitTarget) this._orbitTarget.lerp(this._lerpOrbitTarget, k);
    this._orbitRadius = this._camera.position.distanceTo(this._orbitTarget);

    if (this._cameraUp) this._camera.up.lerp(this._cameraUp, k).normalize();
    this._camera.lookAt(this._orbitTarget);

    if (this._camera.position.distanceTo(this._lerpTarget) < 0.0005) {
      this._camera.position.copy(this._lerpTarget);
      if (this._lerpOrbitTarget) { this._orbitTarget.copy(this._lerpOrbitTarget); this._lerpOrbitTarget = null; }
      this._orbitRadius = this._lerpTarget.distanceTo(this._orbitTarget);
      if (this._cameraUp) this._camera.up.copy(this._cameraUp);
      this._lerpTarget  = null;
      this._camera.lookAt(this._orbitTarget);
    }
  }

  _updateStarSize() {
    if (!this._starMat || !this._initialOrbitRadius) return;
    // Stay at base size until within 10% of initial radius; then ramp exponentially
    const threshold = this._initialOrbitRadius * 0.10;
    let scale = 1.0;
    if (this._orbitRadius < threshold) {
      const t = 1 - this._orbitRadius / threshold; // 0 at threshold, 1 at origin
      scale = 1 + Math.pow(t, 1.6) * 12;
    }
    const size = Math.max(2, Math.min(120, this._baseStarSize * scale));
    this._starMat.size = size;
    if (this._hoverMat) this._hoverMat.size = size * 1.20;
  }

  _updateRangeFade() {
    if (!this._sphereData || !this._solLocalPos || !this._camera) return;
    const dist = this._camera.position.distanceTo(this._solLocalPos);
    this._sphereData.forEach(({ mat, radiusPC }, i) => {
      // Sphere becomes visible at ~2× its radius — offset so you need to zoom out to see it
      const OFFSET  = 2.0;
      const fadeIn  = THREE.MathUtils.clamp((dist - radiusPC * OFFSET) / (radiusPC * 0.50), 0, 1);
      // Fade out mirrors the next sphere's fade-in (crossfade at the same offset)
      const nextR   = this._sphereData[i + 1]?.radiusPC;
      const fadeOut = nextR
        ? 1 - THREE.MathUtils.clamp((dist - nextR * OFFSET) / (nextR * 0.50), 0, 1)
        : 1.0;
      const t = fadeIn * fadeOut;
      mat.uniforms.uOpacity.value = 0.15 * t;
      const labelEntry = this._rangeLabelEls?.[i];
      if (labelEntry) labelEntry.el.style.opacity = String(t);
    });
  }

  _updateReturnButton() {
    if (!this._returnBtn || !this._initialCamPos || !this._camera) return;
    const camDist    = this._camera.position.distanceTo(this._initialCamPos);
    const orbitDrift = this._orbitTarget.length();
    const moved = camDist > this._initialOrbitRadius * 0.08 || orbitDrift > this._initialOrbitRadius * 0.05;
    this._returnBtn.style.opacity       = moved ? '1' : '0';
    this._returnBtn.style.pointerEvents = moved ? 'auto' : 'none';
  }

  _bindOrbitEvents() {
    const canvas = this._canvas;

    const getMeshAt = (clientX, clientY) => {
      if (!this._meshes.length || !this._camera) return null;
      const rect = canvas.getBoundingClientRect();
      const W = rect.width, H = rect.height;
      const v = new THREE.Vector3();
      let best = null, bestD = 35;
      for (const entry of this._meshes) {
        v.copy(entry.pos).project(this._camera);
        if (v.z > 1) continue;
        const sx = (v.x *  0.5 + 0.5) * W + rect.left;
        const sy = (v.y * -0.5 + 0.5) * H + rect.top;
        const d  = Math.hypot(clientX - sx, clientY - sy);
        if (d < bestD) { bestD = d; best = entry; }
      }
      return best;
    };

    const onDown = (e) => {
      this._lerpTarget      = null;
      this._lerpOrbitTarget = null;
      this._lastMouseX = e.clientX;
      this._lastMouseY = e.clientY;
      if (e.button === 1) {
        this._panning = true;
        canvas.style.cursor = 'move';
        e.preventDefault(); // suppress browser auto-scroll on middle click
      } else {
        this._dragging = true;
      }
      e.stopPropagation();
    };

    const onMove = (e) => {
      const dx = e.clientX - this._lastMouseX;
      const dy = e.clientY - this._lastMouseY;

      if (this._panning) {
        this._lastMouseX = e.clientX;
        this._lastMouseY = e.clientY;
        this._panCamera(dx, dy);
        return;
      }
      if (!this._dragging) {
        const entry = getMeshAt(e.clientX, e.clientY);
        if (entry !== this._hoveredStar) {
          this._hoveredStar = entry;
          canvas.style.cursor = entry ? 'pointer' : 'grab';
          this._updateHoverOverlay();
        }
        return;
      }
      this._lastMouseX = e.clientX;
      this._lastMouseY = e.clientY;
      this._orbitCamera(dx, dy);
    };

    const onUp = (e) => {
      if (e.button === 1) {
        this._panning = false;
        canvas.style.cursor = 'grab';
      } else {
        this._dragging = false;
      }
    };

    const onWheel = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._lerpTarget  = null;
      this._orbitRadius = Math.max(0.5, this._orbitRadius * Math.pow(1.0004, e.deltaY));
      const offset = this._camera.position.clone().sub(this._orbitTarget);
      offset.setLength(this._orbitRadius);
      this._camera.position.copy(this._orbitTarget).add(offset);
      this._camera.lookAt(this._orbitTarget);
    };

    const onLeave = () => {
      this._hoveredStar = null;
      canvas.style.cursor = 'grab';
      this._updateHoverOverlay();
    };

    // ── Touch (mobile): 1-finger drag = orbit, 2-finger pinch = zoom ──────────
    const tdist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    let tMode = null, ltx = 0, lty = 0, lpinch = 0;

    const onTouchStart = (e) => {
      this._lerpTarget = null; this._lerpOrbitTarget = null;
      if (e.touches.length === 1) {
        tMode = 'orbit';
        ltx = e.touches[0].clientX; lty = e.touches[0].clientY;
      } else if (e.touches.length >= 2) {
        tMode = 'pinch';
        lpinch = tdist(e.touches[0], e.touches[1]);
      }
      e.preventDefault();
    };
    const onTouchMove = (e) => {
      e.preventDefault();
      if (tMode === 'orbit' && e.touches.length === 1) {
        const dx = e.touches[0].clientX - ltx, dy = e.touches[0].clientY - lty;
        ltx = e.touches[0].clientX; lty = e.touches[0].clientY;
        this._orbitCamera(dx, dy);
      } else if (tMode === 'pinch' && e.touches.length >= 2) {
        const d = tdist(e.touches[0], e.touches[1]);
        const delta = d - lpinch; lpinch = d;
        // fingers apart (delta > 0) → zoom in (smaller orbit radius)
        this._orbitRadius = Math.max(0.5, this._orbitRadius * Math.pow(0.992, delta));
        const off = this._camera.position.clone().sub(this._orbitTarget).setLength(this._orbitRadius);
        this._camera.position.copy(this._orbitTarget).add(off);
        this._camera.lookAt(this._orbitTarget);
      }
    };
    const onTouchEnd = (e) => {
      if (e.touches.length === 0) tMode = null;
      else if (e.touches.length === 1) {
        tMode = 'orbit'; ltx = e.touches[0].clientX; lty = e.touches[0].clientY;
      }
    };

    canvas.addEventListener('mousedown',  onDown);
    canvas.addEventListener('mouseleave', onLeave);
    canvas.addEventListener('wheel',      onWheel, { passive: false });
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove',  onTouchMove,  { passive: false });
    canvas.addEventListener('touchend',   onTouchEnd);
    window.addEventListener('mousemove',  onMove);
    window.addEventListener('mouseup',    onUp);

    this._orbitCleanup = () => {
      canvas.removeEventListener('mousedown',  onDown);
      canvas.removeEventListener('mouseleave', onLeave);
      canvas.removeEventListener('wheel',      onWheel);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove',  onTouchMove);
      canvas.removeEventListener('touchend',   onTouchEnd);
      window.removeEventListener('mousemove',  onMove);
      window.removeEventListener('mouseup',    onUp);
    };
  }

  _build(appEl) {
    // Dim overlay
    this._overlay = document.createElement('div');
    this._overlay.className = 'const-modal-overlay';
    this._overlay.addEventListener('click', (e) => {
      if (e.target === this._overlay) this._close();
    });
    appEl.appendChild(this._overlay);

    // Modal container
    this._container = document.createElement('div');
    this._container.className = 'const-modal';

    const con = this._constellation;
    const nearName = con.nearestIdx  >= 0 ? this.catalog.getStarName(con.nearestIdx)  || `HIP ${this.catalog.hipIds[con.nearestIdx]}`  : '—';
    const farName  = con.farthestIdx >= 0 ? this.catalog.getStarName(con.farthestIdx) || `HIP ${this.catalog.hipIds[con.farthestIdx]}` : '—';
    const nearDist = con.nearestLy  > 0 ? (con.nearestLy  < 10 ? con.nearestLy.toFixed(1)  : Math.round(con.nearestLy))  + ' ly' : '—';
    const farDist  = con.farthestLy > 0 ? (con.farthestLy < 10 ? con.farthestLy.toFixed(1) : Math.round(con.farthestLy)) + ' ly' : '—';
    const depth    = con.depthLy    > 0 ? (con.depthLy    < 10 ? con.depthLy.toFixed(1)    : Math.round(con.depthLy))    + ' ly' : '—';

    this._container.innerHTML = `
      <div class="const-modal-header">
        <span class="const-modal-title">${con.name}</span>
        <button class="const-modal-dismiss hud-btn">✕</button>
      </div>
      <div class="const-modal-viewport">
        <canvas class="const-modal-canvas"></canvas>
        <div class="const-modal-label-overlay"></div>
        <button class="const-modal-return hud-btn">⊕ earth view</button>
      </div>
      <div class="const-modal-stats">
        <div class="const-stat">
          <span class="const-stat-label">nearest</span>
          <span class="const-stat-name">${nearName}</span>
          <span class="const-stat-val">${nearDist}</span>
        </div>
        <div class="const-stat">
          <span class="const-stat-label">farthest</span>
          <span class="const-stat-name">${farName}</span>
          <span class="const-stat-val">${farDist}</span>
        </div>
        <div class="const-stat">
          <span class="const-stat-label">depth span</span>
          <span class="const-stat-name"></span>
          <span class="const-stat-val">${depth}</span>
        </div>
      </div>
    `;

    // Position centered
    this._container.style.left = '50%';
    this._container.style.top  = '50%';
    this._container.style.transform = 'translate(-50%, -50%)';

    appEl.appendChild(this._container);

    // Dismiss
    this._container.querySelector('.const-modal-dismiss').addEventListener('click', () => this._close());

    // Return to earth view
    this._returnBtn = this._container.querySelector('.const-modal-return');
    this._returnBtn.style.opacity = '0';
    this._returnBtn.style.pointerEvents = 'none';
    this._returnBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._lerpTarget      = this._initialCamPos.clone();
      this._lerpOrbitTarget = new THREE.Vector3(0, 0, 0);
    });

    // Modal drag (header)
    const header = this._container.querySelector('.const-modal-header');
    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      this._modalDragging = true;
      const r = this._container.getBoundingClientRect();
      this._dragOffX = e.clientX - r.left;
      this._dragOffY = e.clientY - r.top;
      this._container.style.transform = 'none';
      this._container.style.left = r.left + 'px';
      this._container.style.top  = r.top  + 'px';
      e.preventDefault();
    });
    window.addEventListener('mousemove', this._onDragMove = (e) => {
      if (!this._modalDragging) return;
      this._container.style.left = (e.clientX - this._dragOffX) + 'px';
      this._container.style.top  = (e.clientY - this._dragOffY) + 'px';
    });
    window.addEventListener('mouseup', this._onDragUp = () => { this._modalDragging = false; });
  }

  _close() {
    if (!this._open) return;
    this._open = false;

    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    if (this._orbitCleanup) { this._orbitCleanup(); this._orbitCleanup = null; }
    if (this._renderer) { this._renderer.dispose(); this._renderer = null; }
    if (this._bgStarGeo) { this._bgStarGeo.dispose(); this._bgStarGeo = null; }
    if (this._bgStarMat) { this._bgStarMat.dispose(); this._bgStarMat = null; }
    if (this._solGeo)    { this._solGeo.dispose();    this._solGeo    = null; }
    if (this._solMat)    { this._solMat.map?.dispose(); this._solMat.dispose(); this._solMat = null; }
    if (this._rangeGeos) { this._rangeGeos.forEach(g => g.dispose()); this._rangeGeos = null; }
    if (this._rangeMats) { this._rangeMats.forEach(m => m.dispose()); this._rangeMats = null; }
    if (this._panLine) {
      this._panLine.geometry.dispose();
      this._panLine.material.dispose();
      this._panLine = null;
    }
    if (this._starGeo)   { this._starGeo.dispose();   this._starGeo   = null; }
    if (this._starMat)   { this._starMat.map?.dispose(); this._starMat.dispose(); this._starMat = null; }
    if (this._hoverGeo)  { this._hoverGeo.dispose();  this._hoverGeo  = null; }
    if (this._hoverMat)  { this._hoverMat.dispose();  this._hoverMat  = null; }
    this._starPoints  = null;
    this._hoverPoints = null;
    this._starColors  = null;
    this._scene       = null;
    this._axisScene   = null;
    this._axisCamera  = null;
    this._axisGroup   = null;

    this._overlay?.remove();
    this._container?.remove();
    window.removeEventListener('mousemove', this._onDragMove);
    window.removeEventListener('mouseup',   this._onDragUp);
    this._overlay      = null;
    this._container    = null;
    this._canvas       = null;
    this._labelOverlay = null;
    this._starLabels        = [];
    this._starLabelData     = [];
    this._rangeLabelEls     = [];
    this._rangeLabelPositions = [];
    this._meshes      = [];
    this._hoveredStar = null;
    this._camera      = null;
  }

  _injectStyles() {
    if (document.getElementById('const-modal-style')) return;
    const s = document.createElement('style');
    s.id = 'const-modal-style';
    s.textContent = `
      .const-modal-overlay {
        position: absolute;
        inset: 0;
        background: rgba(3, 5, 16, 0.78);
        z-index: 200;
      }
      .const-modal {
        position: absolute;
        z-index: 201;
        width: min(860px, 50vw);
        background: var(--c-surface-raised);
        border: 0.5px solid var(--c-border);
        border-radius: var(--radius-md);
        overflow: hidden;
        box-shadow:
          0 1px 0 rgba(255,255,255,0.04) inset,
          0 12px 48px rgba(0,0,0,0.75);
        backdrop-filter: blur(18px);
        -webkit-backdrop-filter: blur(18px);
        font-family: var(--font-ui);
        user-select: none;
      }
      .const-modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 11px 14px 9px;
        border-bottom: 0.5px solid var(--c-border-subtle);
        cursor: move;
      }
      .const-modal-title {
        font-family: var(--font-header);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.10em;
        color: var(--c-text);
        text-transform: uppercase;
      }
      .const-modal-dismiss {
        cursor: pointer;
        font-size: 10px;
        padding: 3px 8px;
      }
      .const-modal-viewport {
        width: 100%;
        height: 50vh;
        position: relative;
        background: #04050c;
        display: block;
        overflow: hidden;
        cursor: grab;
      }
      .const-modal-viewport:active { cursor: grabbing; }
      .const-modal-canvas {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        display: block;
      }
      .const-modal-label-overlay {
        position: absolute;
        inset: 0;
        pointer-events: none;
        overflow: hidden;
      }
      .const-modal-return {
        position: absolute;
        bottom: 10px;
        left: 50%;
        transform: translateX(-50%);
        font-size: 9px;
        letter-spacing: 0.08em;
        opacity: 0;
        transition: opacity 0.2s ease;
        pointer-events: none;
        z-index: 10;
      }
      .star-label {
        position: absolute;
        transform: translateX(-50%);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1px;
        pointer-events: none;
      }
      .star-label-name {
        font-size: 9px;
        font-family: var(--font-ui);
        letter-spacing: 0.07em;
        color: rgba(200, 220, 255, 0.85);
        white-space: nowrap;
        text-shadow: 0 1px 4px rgba(0,0,0,0.9);
      }
      .range-label {
        position: absolute;
        transform: translateX(-50%);
        font-size: 8px;
        font-family: var(--font-mono);
        letter-spacing: 0.06em;
        color: rgba(100, 160, 255, 0.55);
        white-space: nowrap;
        pointer-events: none;
        text-shadow: 0 1px 4px rgba(0,0,0,0.9);
      }
      .star-label-dist {
        font-size: 8px;
        font-family: var(--font-mono);
        color: rgba(140, 170, 220, 0.55);
        white-space: nowrap;
        text-shadow: 0 1px 4px rgba(0,0,0,0.9);
      }
      .const-modal-stats {
        display: flex;
        border-top: 0.5px solid var(--c-border-subtle);
        padding: 8px 0 7px;
      }
      .const-stat {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 3px;
        padding: 0 10px;
        border-right: 0.5px solid var(--c-border-subtle);
      }
      .const-stat:last-child { border-right: none; }
      .const-stat-label {
        font-size: 9px;
        text-transform: uppercase;
        letter-spacing: 0.09em;
        color: var(--c-text-dim);
      }
      .const-stat-name {
        font-size: 11px;
        color: var(--c-text);
        max-width: 120px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .const-stat-val {
        font-size: 10px;
        color: var(--c-text-muted);
        font-family: var(--font-mono);
      }
      .const-label {
        position: absolute;
        font-family: var(--font-ui);
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: rgba(140, 195, 255, 0.70);
        pointer-events: auto;
        cursor: pointer;
        transform: translate(-50%, -50%);
        white-space: nowrap;
        z-index: 10;
        transition: color 0.15s;
        padding: 4px 6px;
      }
      .const-label:hover {
        color: rgba(180, 220, 255, 0.95);
      }
    `;
    document.head.appendChild(s);
  }
}
