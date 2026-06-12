/**
 * StarMapView
 * Full-screen 6DOF orbit view of the heliocentric star field.
 *
 * Reuses the ConstellationModal visual language — quaternion orbit camera
 * (no gimbal lock), fresnel range spheres, circular fading equatorial grid,
 * corner axis widget, Sol glow marker, floating star labels — but operates on
 * the SHARED scene + StarField rather than an isolated modal renderer.
 *
 * Stars come from the shared StarField (spectral-coloured, selectable via the
 * existing CPU pick). On top we add a reference grid, range markers, a route
 * line (Sol → selected stars in order), wireframe markers around selected
 * stars, and name labels.
 */

import * as THREE from 'three';

const LY_TO_PC = 1 / 3.26156;
const PC_TO_LY = 3.26156;

export class StarMapView {
  constructor({ scene, sceneManager, starField, catalog, selection, observer, viewState }) {
    this.scene     = scene;
    this.sm        = sceneManager;
    this.starField = starField;
    this.catalog   = catalog;
    this.selection = selection;
    this.observer  = observer;
    this.viewState = viewState;

    this.container = null;
    this.camera    = null;
    this._group    = null;   // all StarMap-owned 3D objects live here
    this._cleanups = [];

    // Orbit state (quaternion-based, mirrors ConstellationModal)
    this._orbitTarget = new THREE.Vector3(0, 0, 0);
    this._orbitRadius = 18;          // parsecs
    this._dragging    = false;
    this._panning     = false;
    this._lastX       = 0;
    this._lastY       = 0;

    // Lerp (camera + target ease toward a goal on selection change / return)
    this._lerpCam    = null;
    this._lerpTarget = null;

    // Labels
    this._labelOverlay = null;
    this._labels       = []; // { el, pos:Vector3, kind }

    // Selection markers (pooled wireframe spheres)
    this._selMeshes = [];

    this._onSelectionChange = this._onSelectionChange.bind(this);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  mount(container) {
    this.container = container;

    this._group = new THREE.Group();
    this.scene.add(this._group);

    this._buildCamera(container);
    this._buildReferenceMarkers();
    this._buildSolMarker();
    this._buildRouteLine();
    this._buildAxisWidget();
    this._buildLabelOverlay(container);
    this._buildHUD(container);
    this._bindEvents(container);

    // StarMap is a space view — no atmosphere.
    this.sm.setRayleigh(false);
    this.starField.setResolution(container.clientWidth, container.clientHeight);

    // React to selection changes (route, markers, aim).
    const off = this.selection.onchange(this._onSelectionChange);
    this._cleanups.push(off);

    // Axis widget overlay renders after the composer each frame.
    const offPost = this.sm.onPostRender(() => this._renderAxisWidget());
    this._cleanups.push(offPost);

    const onResize = () => {
      const w = container.clientWidth, h = container.clientHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.starField.setResolution(w, h);
    };
    window.addEventListener('resize', onResize);
    this._cleanups.push(() => window.removeEventListener('resize', onResize));

    // Seed from current selection
    this._onSelectionChange(this.selection);
    this._aimAtSelection();
  }

  update(time) {
    this.starField.update(time);
    this.starField.setFov(this.camera.fov);
    this.starField.updateSelection(this.selection);

    this._tickLerp();
    this.starField.updateMotion(this.camera);
    this._updateLabels();
  }

  unmount() {
    this._cleanups.forEach(fn => fn());
    this._cleanups = [];

    // Dispose everything under the group
    this.scene.remove(this._group);
    this._group.traverse(obj => {
      obj.geometry?.dispose?.();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach(m => { m.map?.dispose?.(); m.dispose?.(); });
      }
    });
    this._group = null;
    this._routeLine = null; // disposed via group traversal above

    if (this._axisScene) {
      this._axisScene.traverse(o => {
        o.geometry?.dispose?.();
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach(m => m.dispose?.());
        }
      });
      this._axisScene = null;
      this._axisCamera = null;
      this._axisGroup = null;
    }

    this._labelOverlay?.remove();
    this._hud?.remove();
    this._labelOverlay = null;
    this._labels = [];
    this._selMeshes = [];
  }

  // ── Camera ────────────────────────────────────────────────────────────────

  _buildCamera(container) {
    const aspect = container.clientWidth / container.clientHeight;
    this.camera = new THREE.PerspectiveCamera(55, aspect, 0.01, 50000);
    this.camera.up.set(0, 0, 1); // celestial north

    // If an origin star is configured, orbit it; otherwise orbit Sol.
    const originIdx = this.viewState.origin;
    if (originIdx != null) {
      this._orbitTarget.set(
        this.catalog.positions[originIdx * 3],
        this.catalog.positions[originIdx * 3 + 1],
        this.catalog.positions[originIdx * 3 + 2],
      );
    } else {
      this._orbitTarget.set(0, 0, 0);
    }

    // Start pulled back and slightly above the equatorial plane.
    this._orbitYaw   = 0.6;
    this._orbitPitch = 0.9;
    this._applyOrbit();

    this.sm.setCamera(this.camera);
  }

  /** Place the camera from yaw/pitch spherical angles around the target. */
  _applyOrbit() {
    const phi = Math.max(0.05, Math.min(Math.PI - 0.05, this._orbitPitch));
    const r   = this._orbitRadius;
    const dx  = r * Math.sin(phi) * Math.sin(this._orbitYaw);
    const dz  = r * Math.cos(phi);
    const dy  = r * Math.sin(phi) * Math.cos(this._orbitYaw);
    this.camera.position.set(
      this._orbitTarget.x + dx,
      this._orbitTarget.y + dy,
      this._orbitTarget.z + dz,
    );
    this.camera.lookAt(this._orbitTarget);
  }

  /** Quaternion orbit — no gimbal lock (mirrors ConstellationModal). */
  _orbitCamera(dx, dy) {
    const offset = this.camera.position.clone().sub(this._orbitTarget);

    const north = new THREE.Vector3(0, 0, 1);
    const yawQ  = new THREE.Quaternion().setFromAxisAngle(north, -dx * 0.005);
    offset.applyQuaternion(yawQ);
    this.camera.up.applyQuaternion(yawQ).normalize();

    const lookDir = offset.clone().normalize().negate();
    const right   = new THREE.Vector3().crossVectors(lookDir, this.camera.up).normalize();
    const pitchQ  = new THREE.Quaternion().setFromAxisAngle(right, -dy * 0.005);
    offset.applyQuaternion(pitchQ);
    this.camera.up.applyQuaternion(pitchQ).normalize();

    offset.setLength(this._orbitRadius);
    this.camera.position.copy(this._orbitTarget).add(offset);
    this.camera.lookAt(this._orbitTarget);
  }

  /** Slide camera + target across the screen plane. */
  _panCamera(dx, dy) {
    const scale = 2 * Math.tan(this.camera.fov * Math.PI / 360) * this._orbitRadius
                / (this.container.clientHeight || 1);
    // Derive screen basis from the camera quaternion (matrix may be stale pre-render)
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const up    = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const delta = right.multiplyScalar(-dx * scale).add(up.multiplyScalar(dy * scale));
    this.camera.position.add(delta);
    this._orbitTarget.add(delta);
  }

  _dolly(deltaY) {
    this._orbitRadius = Math.max(0.3, Math.min(8000, this._orbitRadius * Math.pow(1.0005, deltaY)));
    const offset = this.camera.position.clone().sub(this._orbitTarget).setLength(this._orbitRadius);
    this.camera.position.copy(this._orbitTarget).add(offset);
    this.camera.lookAt(this._orbitTarget);
  }

  _tickLerp() {
    if (!this._lerpTarget && !this._lerpCam) return;
    const k = 0.12;
    if (this._lerpTarget) {
      this._orbitTarget.lerp(this._lerpTarget, k);
      if (this._orbitTarget.distanceTo(this._lerpTarget) < 0.01) {
        this._orbitTarget.copy(this._lerpTarget);
        this._lerpTarget = null;
      }
    }
    if (this._lerpCam != null) {
      this._orbitRadius += (this._lerpCam - this._orbitRadius) * k;
      if (Math.abs(this._orbitRadius - this._lerpCam) < 0.05) {
        this._orbitRadius = this._lerpCam;
        this._lerpCam = null;
      }
    }
    const offset = this.camera.position.clone().sub(this._orbitTarget).setLength(this._orbitRadius);
    this.camera.position.copy(this._orbitTarget).add(offset);
    this.camera.lookAt(this._orbitTarget);
  }

  /** Ease the orbit target toward the midpoint of Sol + selected stars. */
  _aimAtSelection() {
    const sel = [...this.selection.selected];
    if (sel.length === 0) {
      this._lerpTarget = new THREE.Vector3(0, 0, 0);
      return;
    }
    const mid = new THREE.Vector3(0, 0, 0); // include Sol
    let n = 1;
    let maxR = 1;
    for (const idx of sel) {
      const p = new THREE.Vector3(
        this.catalog.positions[idx * 3],
        this.catalog.positions[idx * 3 + 1],
        this.catalog.positions[idx * 3 + 2],
      );
      mid.add(p); n++;
      maxR = Math.max(maxR, p.length());
    }
    mid.divideScalar(n);
    this._lerpTarget = mid;
    // Frame the whole route comfortably
    this._lerpCam = Math.max(8, maxR * 1.6);
  }

  // ── Reference markers (grid + fresnel spheres + rings + labels) ───────────────

  _buildReferenceMarkers() {
    this._rangeLabelData = []; // { pos, text }

    // ── Fresnel range spheres at Sol ────────────────────────────────────────
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

    this._sphereData = []; // { mat, radiusPC }
    const RADII_LY = [10, 50, 100, 200, 500, 1000];
    for (const ly of RADII_LY) {
      const r   = ly * LY_TO_PC;
      const geo = new THREE.SphereGeometry(r, 64, 48);
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: FRAG,
        uniforms: { uOpacity: { value: 0.0 } },
        transparent: true, depthWrite: false, side: THREE.FrontSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      this._group.add(mesh);
      this._sphereData.push({ mat, radiusPC: r });

      // Distance ring on the equatorial plane
      this._group.add(this._makeRing(r));

      // Label sits on the celestial-north pole of each shell
      this._rangeLabelData.push({
        pos: new THREE.Vector3(0, 0, r),
        text: `${ly} ly`,
        kind: 'range',
      });
    }

    // ── Circular fading equatorial grid (z = 0 plane through Sol) ────────────
    const GRID_RADIUS_LY = 1200;
    const GRID_STEP_LY   = 25;
    const GRID_RADIUS_PC = GRID_RADIUS_LY * LY_TO_PC;
    const GRID_STEP_PC   = GRID_STEP_LY   * LY_TO_PC;

    const gridMat = new THREE.ShaderMaterial({
      vertexShader: `
        varying vec2 vXY;
        void main() {
          vXY = position.xy;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vXY;
        void main() {
          float distLy = length(vXY) * ${PC_TO_LY.toFixed(5)};
          float fade = 1.0 - smoothstep(700.0, 1200.0, distLy);
          if (fade < 0.008) discard;
          gl_FragColor = vec4(0.10, 0.22, 0.38, 0.16 * fade);
        }
      `,
      transparent: true, depthWrite: false,
    });
    const steps = Math.ceil(GRID_RADIUS_LY / GRID_STEP_LY);
    const gridPts = [];
    for (let i = -steps; i <= steps; i++) {
      const t = i * GRID_STEP_PC;
      const halfSpan = Math.sqrt(Math.max(0, GRID_RADIUS_PC * GRID_RADIUS_PC - t * t));
      if (halfSpan < 1e-6) continue;
      gridPts.push(-halfSpan, t, 0,  halfSpan, t, 0);
      gridPts.push(t, -halfSpan, 0,  t,  halfSpan, 0);
    }
    const gridGeo = new THREE.BufferGeometry();
    gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gridPts, 3));
    const gridLines = new THREE.LineSegments(gridGeo, gridMat);
    gridLines.frustumCulled = false;
    this._group.add(gridLines);
  }

  /** Thin circle in the equatorial plane at radius r (parsecs). */
  _makeRing(r) {
    const SEG = 128;
    const pts = [];
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      pts.push(Math.cos(a) * r, Math.sin(a) * r, 0);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0x2a4d72, transparent: true, opacity: 0.30, depthWrite: false,
    });
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    return line;
  }

  _buildSolMarker() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    const mat = new THREE.PointsMaterial({
      color: 0xffe066,
      size: 20,
      map: this._glowTexture(),
      sizeAttenuation: false,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      alphaTest: 0.002,
    });
    const sol = new THREE.Points(geo, mat);
    sol.frustumCulled = false;
    this._group.add(sol);

    // Sol always gets a label
    this._solLabelData = { pos: new THREE.Vector3(0, 0, 0), text: 'Sol', kind: 'sol' };
  }

  _glowTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0,    'rgba(255,255,255,1.00)');
    g.addColorStop(0.05, 'rgba(255,255,255,1.00)');
    g.addColorStop(0.18, 'rgba(255,255,255,0.65)');
    g.addColorStop(0.40, 'rgba(255,255,255,0.18)');
    g.addColorStop(0.70, 'rgba(255,255,255,0.04)');
    g.addColorStop(1.0,  'rgba(0,0,0,0.00)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(canvas);
  }

  // ── Route line (Sol → selected stars in order) ───────────────────────────────

  _buildRouteLine() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 1001), 3));
    geo.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({
      color: 0x64b4ff, transparent: true, opacity: 0.7, depthWrite: false,
    });
    this._routeLine = new THREE.Line(geo, mat);
    this._routeLine.frustumCulled = false;
    this._group.add(this._routeLine);
  }

  _updateRoute() {
    const sel = [...this.selection.selected];
    const arr = this._routeLine.geometry.attributes.position.array;
    // Always start at Sol
    arr[0] = 0; arr[1] = 0; arr[2] = 0;
    let n = 1;
    for (const idx of sel) {
      arr[n * 3]     = this.catalog.positions[idx * 3];
      arr[n * 3 + 1] = this.catalog.positions[idx * 3 + 1];
      arr[n * 3 + 2] = this.catalog.positions[idx * 3 + 2];
      n++;
    }
    this._routeLine.geometry.setDrawRange(0, sel.length > 0 ? n : 0);
    this._routeLine.geometry.attributes.position.needsUpdate = true;
  }

  // ── Selection markers (wireframe spheres) + labels ───────────────────────────

  _onSelectionChange() {
    this._updateRoute();
    this._updateSelectionMeshes();
    this._rebuildLabels();
    this._aimAtSelection();
  }

  _updateSelectionMeshes() {
    const sel = [...this.selection.selected];
    const primary = this.selection.primary;

    // Grow pool as needed
    while (this._selMeshes.length < sel.length) {
      const geo = new THREE.SphereGeometry(0.45, 16, 12);
      const mat = new THREE.MeshBasicMaterial({
        color: 0x64b4ff, wireframe: true, transparent: true, opacity: 0.5, depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      this._group.add(mesh);
      this._selMeshes.push(mesh);
    }

    for (let i = 0; i < this._selMeshes.length; i++) {
      const mesh = this._selMeshes[i];
      if (i < sel.length) {
        const idx = sel[i];
        mesh.position.set(
          this.catalog.positions[idx * 3],
          this.catalog.positions[idx * 3 + 1],
          this.catalog.positions[idx * 3 + 2],
        );
        const isPrimary = idx === primary;
        mesh.material.color.set(isPrimary ? 0xffd264 : 0x64b4ff);
        mesh.material.opacity = isPrimary ? 0.7 : 0.45;
        mesh.visible = true;
      } else {
        mesh.visible = false;
      }
    }
  }

  // ── Labels ────────────────────────────────────────────────────────────────

  _buildLabelOverlay(container) {
    this._labelOverlay = document.createElement('div');
    this._labelOverlay.className = 'starmap-label-overlay';
    this._injectStyles();
    container.appendChild(this._labelOverlay);
  }

  _rebuildLabels() {
    if (!this._labelOverlay) return;
    this._labelOverlay.innerHTML = '';
    this._labels = [];

    const push = (pos, name, dist, kind) => {
      const el = document.createElement('div');
      el.className = `starmap-label ${kind}`;
      const distStr = dist != null
        ? `<span class="sm-label-dist">${dist}</span>` : '';
      el.innerHTML = `<span class="sm-label-name">${name}</span>${distStr}`;
      this._labelOverlay.appendChild(el);
      this._labels.push({ el, pos: pos.clone(), kind });
    };

    // Sol
    if (this._solLabelData) push(this._solLabelData.pos, 'Sol', '0 ly', 'sol');

    // Range shells
    for (const r of (this._rangeLabelData || [])) push(r.pos, r.text, null, 'range');

    // Selected stars
    const primary = this.selection.primary;
    for (const idx of this.selection.selected) {
      const pos = new THREE.Vector3(
        this.catalog.positions[idx * 3],
        this.catalog.positions[idx * 3 + 1],
        this.catalog.positions[idx * 3 + 2],
      );
      const name = this.catalog.getStarName(idx) || `HIP ${this.catalog.hipIds[idx]}`;
      const dly  = this.catalog.distances[idx];
      const distStr = dly > 0 ? (dly < 10 ? dly.toFixed(1) : Math.round(dly)) + ' ly' : '—';
      push(pos, name, distStr, idx === primary ? 'primary' : 'selected');
    }
  }

  _updateLabels() {
    if (!this._labels.length || !this.camera) return;
    const W = this.container.clientWidth;
    const H = this.container.clientHeight;
    const v = new THREE.Vector3();
    for (const { el, pos, kind } of this._labels) {
      v.copy(pos).project(this.camera);
      if (v.z > 1) { el.style.opacity = '0'; continue; }
      const x = (v.x *  0.5 + 0.5) * W;
      const y = (v.y * -0.5 + 0.5) * H;
      el.style.left = x + 'px';
      el.style.top  = (y - 14) + 'px';
      // Range labels are faint; star labels solid
      el.style.opacity = kind === 'range' ? '0.5' : '1';
    }
  }

  // ── Axis widget (corner, scissored over the composer output) ─────────────────

  _buildAxisWidget() {
    this._axisScene = new THREE.Scene();
    this._axisGroup = new THREE.Group();
    this._axisScene.add(this._axisGroup);

    const AXES = [
      { dir: new THREE.Vector3(1, 0, 0), color: 0xff4455 },
      { dir: new THREE.Vector3(0, 1, 0), color: 0x44dd66 },
      { dir: new THREE.Vector3(0, 0, 1), color: 0x4499ff },
    ];
    const LEN = 0.72, HEAD = 0.22, HEAD_R = 0.09;
    for (const { dir, color } of AXES) {
      const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(), LEN, color, HEAD, HEAD_R);
      arrow.line.material.transparent = true; arrow.line.material.opacity = 0.9;
      arrow.cone.material.transparent = true; arrow.cone.material.opacity = 0.9;
      this._axisGroup.add(arrow);
      const neg = new THREE.ArrowHelper(dir.clone().negate(), new THREE.Vector3(), LEN * 0.45, color, 0, 0);
      neg.line.material.transparent = true; neg.line.material.opacity = 0.22;
      this._axisGroup.add(neg);
    }
    this._axisCamera = new THREE.OrthographicCamera(-1.1, 1.1, 1.1, -1.1, 0.1, 10);
    this._axisCamera.position.set(0, 0, 3);
    this._axisCamera.lookAt(0, 0, 0);
  }

  _renderAxisWidget() {
    if (!this._axisScene || !this.camera) return;
    const renderer = this.sm.renderer;
    this._axisGroup.quaternion.copy(this.camera.quaternion).invert();

    const dpr  = renderer.getPixelRatio();
    const rw   = renderer.domElement.width;
    const rh   = renderer.domElement.height;
    const SIZE = Math.round(80 * dpr);
    const PAD  = Math.round(14 * dpr);

    // Top-right, tucked under the recenter button — clear of the NavDock
    // (bottom-left) and SelectionBar (bottom-right) DOM overlays.
    const x = rw - SIZE - PAD;
    const y = rh - SIZE - Math.round(52 * dpr);

    renderer.setScissorTest(true);
    renderer.setScissor(x, y, SIZE, SIZE);
    renderer.setViewport(x, y, SIZE, SIZE);
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this._axisScene, this._axisCamera);
    renderer.autoClear = true;
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, rw, rh);
  }

  // ── HUD ─────────────────────────────────────────────────────────────────────

  _buildHUD(container) {
    this._hud = document.createElement('div');
    this._hud.className = 'starmap-hud';
    this._hud.innerHTML = `
      <div class="starmap-hud-left">
        <span class="hud-pill" id="sm-origin">origin · Sol</span>
        <span class="hud-pill" id="sm-hint">drag orbit · scroll zoom · middle-drag pan</span>
      </div>
      <div class="starmap-hud-right">
        <button class="hud-btn" id="sm-return">⊕ recenter</button>
      </div>
    `;
    container.appendChild(this._hud);

    const originEl = this._hud.querySelector('#sm-origin');
    const originIdx = this.viewState.origin;
    if (originIdx != null) {
      const name = this.catalog.getStarName(originIdx) || `HIP ${this.catalog.hipIds[originIdx]}`;
      originEl.textContent = `origin · ${name}`;
    }

    this._hud.querySelector('#sm-return').addEventListener('click', (e) => {
      e.stopPropagation();
      this._aimAtSelection();
    });
  }

  // ── Input ────────────────────────────────────────────────────────────────────

  _bindEvents(container) {
    this._mouse = new THREE.Vector2();
    this._raycaster = new THREE.Raycaster();
    this._downX = 0; this._downY = 0; this._moved = false;

    const onDown = (e) => {
      if (e.target.closest('.hud-btn, .hud-pill, .panel, .nav-dock, .sel-bar, .starmap-hud')) return;
      this._lerpTarget = null; this._lerpCam = null;
      this._lastX = e.clientX; this._lastY = e.clientY;
      this._downX = e.clientX; this._downY = e.clientY;
      this._moved = false;
      if (e.button === 1) { this._panning = true; e.preventDefault(); }
      else if (e.button === 0) { this._dragging = true; }
    };

    const onMove = (e) => {
      const rect = container.getBoundingClientRect();
      this._mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this._mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      const dx = e.clientX - this._lastX;
      const dy = e.clientY - this._lastY;
      if (Math.abs(e.clientX - this._downX) + Math.abs(e.clientY - this._downY) > 3) this._moved = true;
      this._lastX = e.clientX; this._lastY = e.clientY;

      if (this._panning) this._panCamera(dx, dy);
      else if (this._dragging) this._orbitCamera(dx, dy);
    };

    const onUp = (e) => {
      const wasDragging = this._dragging;
      this._dragging = false;
      this._panning = false;
      // Treat a click without drag as a pick
      if (e.button === 0 && wasDragging && !this._moved) this._pick();
    };

    const onWheel = (e) => {
      e.preventDefault();
      this._lerpCam = null;
      this._dolly(e.deltaY);
    };

    const onContext = (e) => {
      if (e.target.closest('.hud-btn, .hud-pill, .panel, .nav-dock, .sel-bar, .starmap-hud')) return;
      e.preventDefault();
      // Right-click on a star deselects it; empty space clears
      const idx = this._pickIndex();
      if (idx >= 0) this.selection.deselect(idx);
      else this.selection.clear();
    };

    // ── Touch: 1-finger orbit, 2-finger pinch zoom, tap = pick ───────────────
    const tdist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    let tMode = null, ltx = 0, lty = 0, lpinch = 0, tDownX = 0, tDownY = 0, tMoved = false;

    const onTouchStart = (e) => {
      if (e.target.closest('.hud-btn, .hud-pill, .panel, .nav-dock, .sel-bar, .starmap-hud')) return;
      this._lerpTarget = null; this._lerpCam = null;
      if (e.touches.length === 1) {
        tMode = 'orbit';
        ltx = tDownX = e.touches[0].clientX; lty = tDownY = e.touches[0].clientY;
        tMoved = false;
      } else if (e.touches.length >= 2) {
        tMode = 'pinch';
        lpinch = tdist(e.touches[0], e.touches[1]);
      }
      e.preventDefault();
    };
    const onTouchMove = (e) => {
      if (tMode === null) return;
      e.preventDefault();
      if (tMode === 'orbit' && e.touches.length === 1) {
        const dx = e.touches[0].clientX - ltx, dy = e.touches[0].clientY - lty;
        ltx = e.touches[0].clientX; lty = e.touches[0].clientY;
        if (Math.abs(e.touches[0].clientX - tDownX) + Math.abs(e.touches[0].clientY - tDownY) > 4) tMoved = true;
        this._orbitCamera(dx, dy);
      } else if (tMode === 'pinch' && e.touches.length >= 2) {
        const d = tdist(e.touches[0], e.touches[1]);
        const delta = d - lpinch; lpinch = d;
        this._dolly(-delta * 14); // apart → zoom in
      }
    };
    const onTouchEnd = (e) => {
      if (tMode === 'orbit' && !tMoved) {
        const rect = container.getBoundingClientRect();
        this._mouse.x = ((tDownX - rect.left) / rect.width) * 2 - 1;
        this._mouse.y = -((tDownY - rect.top) / rect.height) * 2 + 1;
        this._pick();
      }
      if (e.touches.length === 0) tMode = null;
      else if (e.touches.length === 1) {
        tMode = 'orbit'; ltx = e.touches[0].clientX; lty = e.touches[0].clientY; tMoved = true;
      }
    };

    container.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    container.addEventListener('wheel', onWheel, { passive: false });
    container.addEventListener('contextmenu', onContext);
    container.addEventListener('touchstart', onTouchStart, { passive: false });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd);

    this._cleanups.push(() => {
      container.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('contextmenu', onContext);
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
    });
  }

  _pickIndex() {
    this._raycaster.setFromCamera(this._mouse, this.camera);
    return this.starField.pick(this._raycaster, this.camera);
  }

  _pick() {
    const idx = this._pickIndex();
    if (idx >= 0) this.selection.toggle(idx);
  }

  // ── Styles ────────────────────────────────────────────────────────────────

  _injectStyles() {
    if (document.getElementById('starmap-style')) return;
    const s = document.createElement('style');
    s.id = 'starmap-style';
    s.textContent = `
      .starmap-label-overlay {
        position: absolute; inset: 0;
        pointer-events: none; overflow: hidden;
        z-index: 90;
      }
      .starmap-label {
        position: absolute;
        transform: translateX(-50%);
        display: flex; flex-direction: column; align-items: center; gap: 1px;
        pointer-events: none;
        transition: opacity 0.15s ease;
      }
      .sm-label-name {
        font-family: var(--font-ui);
        font-size: 10px;
        letter-spacing: 0.06em;
        white-space: nowrap;
        text-shadow: 0 1px 4px rgba(0,0,0,0.9);
        color: rgba(200, 220, 255, 0.9);
      }
      .starmap-label.primary .sm-label-name { color: var(--c-gold); }
      .starmap-label.sol     .sm-label-name { color: rgba(255, 224, 120, 0.95); }
      .starmap-label.range   .sm-label-name {
        font-family: var(--font-mono);
        font-size: 8px;
        color: rgba(100, 160, 255, 0.55);
      }
      .sm-label-dist {
        font-family: var(--font-mono);
        font-size: 8px;
        color: rgba(140, 170, 220, 0.6);
        white-space: nowrap;
        text-shadow: 0 1px 4px rgba(0,0,0,0.9);
      }
      .starmap-hud {
        position: absolute;
        top: 12px; left: 14px; right: 14px;
        display: flex; justify-content: space-between; align-items: center;
        gap: 8px; z-index: 100; pointer-events: none;
      }
      .starmap-hud-left, .starmap-hud-right {
        display: flex; gap: 6px; align-items: center; pointer-events: all;
      }
    `;
    document.head.appendChild(s);
  }
}
