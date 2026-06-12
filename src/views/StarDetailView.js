/**
 * StarDetailView
 * Close-up of the primary-selected star.
 *
 *  - Orbit camera centred on the primary star's true world position.
 *  - Plasma surface: animated FBM-noise ShaderMaterial on a sphere, with
 *    limb darkening and spectral-temperature colour ramp.
 *  - Solar corona: camera-facing billboard with animated angular flares /
 *    prominences (additive), tuned to bleed into the bloom pass.
 *  - 210px right info panel (name, class, distance, magnitude, temperature,
 *    blurb, "add to route" + "set as origin"). Driven by the primary
 *    selection — changing primary updates the view without remounting.
 *  - Nearest-neighbour star names fade in as they orbit into view.
 *
 * Uses the shared scene + StarField (background context) + SceneManager
 * composer so the plasma star benefits from the bloom pipeline.
 */

import * as THREE from 'three';

// ── Shared GLSL noise (value-noise FBM) ──────────────────────────────────────
const NOISE = `
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float vnoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
          mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
          mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * vnoise(p); p *= 2.0; a *= 0.5; }
    return v;
  }
`;

const PLASMA_VERT = `
  varying vec3 vLocal;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vLocal = normalize(position);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView   = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const PLASMA_FRAG = `
  varying vec3 vLocal;
  varying vec3 vNormal;
  varying vec3 vView;
  uniform float uTime;
  uniform vec3  uColor;
  ${NOISE}
  void main() {
    // Convection granulation: two FBM layers drifting at different rates
    vec3  q     = vLocal * 3.2;
    float slow  = fbm(q + vec3(0.0, uTime * 0.05, 0.0));
    float fast  = fbm(q * 2.3 - vec3(uTime * 0.08, 0.0, uTime * 0.04));
    float cells = fbm(q * 5.0 + slow * 1.5 - uTime * 0.06);
    float t     = slow * 0.5 + fast * 0.3 + cells * 0.2;

    // Spectral colour ramp: keep the star's hue — only the brightest cores
    // lift partway toward white so cool stars stay warm, hot stars stay blue.
    vec3 cool = uColor * 0.30;
    vec3 mid  = uColor;
    vec3 hot  = mix(uColor, vec3(1.0, 0.95, 0.85), 0.40);
    vec3 col  = mix(cool, mid, smoothstep(0.22, 0.55, t));
    col       = mix(col, hot, smoothstep(0.58, 0.88, t));

    // Bright faculae / hot spots — tinted by the star colour, not pure white
    col += hot * pow(max(t - 0.5, 0.0), 2.2) * 1.1;

    // Limb darkening — dim toward the silhouette edge
    float ndv = clamp(dot(vNormal, vView), 0.0, 1.0);
    col *= mix(0.40, 1.18, pow(ndv, 0.6));

    gl_FragColor = vec4(col, 1.0);
  }
`;

const CORONA_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const CORONA_FRAG = `
  varying vec2 vUv;
  uniform float uTime;
  uniform vec3  uColor;
  uniform float uSphereFrac; // sphere silhouette radius within the quad (0..1)
  ${NOISE}
  void main() {
    vec2  p = (vUv - 0.5) * 2.0;
    float r = length(p);
    if (r < uSphereFrac) discard;          // let the plasma surface show through
    if (r > 1.0) discard;

    float edge   = uSphereFrac;
    float beyond = (r - edge) / max(1.0 - edge, 0.001); // 0 at edge → 1 at quad rim

    float ang  = atan(p.y, p.x);
    vec2  ring = vec2(cos(ang), sin(ang));

    // Angular prominence field — broad tongues + sharp flicker, sharpened for
    // distinct flares that lick out from the limb.
    float broad = fbm(vec3(ring * 1.3, uTime * 0.14));
    float fine  = fbm(vec3(ring * 4.5, uTime * 0.40));
    float spikes = pow(clamp(mix(broad, fine, 0.5), 0.0, 1.0), 2.2);

    // Each angle reaches a different distance; high spikes shoot further out.
    float reach = 0.14 + spikes * 1.05;
    float body  = exp(-beyond / max(reach, 0.02) * 3.2);

    // Bright rim hugging the silhouette + radial flare rays
    float rim   = smoothstep(0.16, 0.0, beyond);
    float rays  = pow(fbm(vec3(ring * 9.0, uTime * 0.3)), 2.4);
    float intensity = body * (0.22 + spikes * 2.1 + rays * 0.7) + rim * 1.25;
    intensity = clamp(intensity, 0.0, 2.0);
    if (intensity < 0.012) discard;

    // Corona inherits the star's spectral colour. Flare tips keep the hue with
    // only a whisper of warmth; the hot inner rim brightens toward a tinted
    // white (not pure white) so blue stars stay blue and red stars stay red.
    vec3 tips   = mix(uColor, vec3(1.0, 0.6, 0.3), 0.12);
    vec3 hotRim = mix(uColor, vec3(1.0), 0.6);
    vec3 col = mix(tips, hotRim, rim);

    gl_FragColor = vec4(col * intensity, intensity);
  }
`;

export class StarDetailView {
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
    this._group    = null;   // star sphere + corona, repositioned per primary
    this._cleanups = [];

    this._primaryIdx = null;
    this._target     = new THREE.Vector3();

    // Display scale (parsec-space units). Neighbours sit at true catalog
    // positions, so a small sphere keeps them readable as surrounding points.
    this.SPHERE_RADIUS = 0.6;
    this.CORONA_QUAD   = this.SPHERE_RADIUS * 6; // full quad width

    // Orbit
    this._orbitRadius = this.SPHERE_RADIUS * 4.2;
    this._yaw   = 0.5;
    this._pitch = 1.1;
    this._dragging = false;
    this._autoRotate = true;
    this._lastX = 0;
    this._lastY = 0;

    this._labelOverlay = null;
    this._neighborLabels = []; // { el, pos:Vector3 }
    this._primaryLabel   = null;

    this._onSelectionChange = this._onSelectionChange.bind(this);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  mount(container) {
    this.container = container;

    const aspect = container.clientWidth / container.clientHeight;
    this.camera = new THREE.PerspectiveCamera(50, aspect, 0.001, 50000);
    this.camera.up.set(0, 0, 1);
    this.sm.setCamera(this.camera);
    this.sm.setRayleigh(false);

    this._buildStar();
    this._buildLabelOverlay(container);
    this._buildPanel(container);
    this._bindEvents(container);

    this.starField.setResolution(container.clientWidth, container.clientHeight);

    const off = this.selection.onchange(this._onSelectionChange);
    this._cleanups.push(off);

    const onResize = () => {
      const w = container.clientWidth, h = container.clientHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.starField.setResolution(w, h);
    };
    window.addEventListener('resize', onResize);
    this._cleanups.push(() => window.removeEventListener('resize', onResize));

    // Seed from current primary
    this._setPrimary(this.selection.primary);
  }

  update(time) {
    this.starField.update(time);
    this.starField.setFov(this.camera.fov);
    this.starField.updateSelection(this.selection);

    if (this._plasmaMat) this._plasmaMat.uniforms.uTime.value = time;
    if (this._coronaMat) this._coronaMat.uniforms.uTime.value = time;

    // Gentle auto-orbit when idle so neighbour labels sweep into view
    if (this._autoRotate && !this._dragging && this._primaryIdx != null) {
      this._yaw += 0.0015;
    }
    this._applyOrbit();
    this.starField.updateMotion(this.camera);

    // Billboard the corona toward the camera
    if (this._corona) this._corona.quaternion.copy(this.camera.quaternion);

    this._updateLabels();
  }

  unmount() {
    this._cleanups.forEach(fn => fn());
    this._cleanups = [];

    if (this._group) {
      this.scene.remove(this._group);
      this._group.traverse(o => {
        o.geometry?.dispose?.();
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach(m => m.dispose?.());
        }
      });
      this._group = null;
    }

    this._labelOverlay?.remove();
    this._panel?.remove();
    this._labelOverlay = null;
    this._panel = null;
    this._neighborLabels = [];
    this._primaryLabel = null;
  }

  // ── Star geometry (plasma sphere + corona) ───────────────────────────────────

  _buildStar() {
    this._group = new THREE.Group();
    this._group.visible = false;
    this.scene.add(this._group);

    const sphereGeo = new THREE.SphereGeometry(this.SPHERE_RADIUS, 96, 64);
    this._plasmaMat = new THREE.ShaderMaterial({
      vertexShader: PLASMA_VERT,
      fragmentShader: PLASMA_FRAG,
      uniforms: {
        uTime:  { value: 0 },
        uColor: { value: new THREE.Color(1, 1, 1) },
      },
    });
    this._sphere = new THREE.Mesh(sphereGeo, this._plasmaMat);
    this._sphere.frustumCulled = false;
    this._group.add(this._sphere);

    const quadGeo = new THREE.PlaneGeometry(this.CORONA_QUAD, this.CORONA_QUAD);
    this._coronaMat = new THREE.ShaderMaterial({
      vertexShader: CORONA_VERT,
      fragmentShader: CORONA_FRAG,
      uniforms: {
        uTime:       { value: 0 },
        uColor:      { value: new THREE.Color(1, 1, 1) },
        uSphereFrac: { value: this.SPHERE_RADIUS / (this.CORONA_QUAD / 2) },
      },
      transparent: true,
      depthWrite:  false,
      depthTest:   false,
      blending:    THREE.AdditiveBlending,
    });
    this._corona = new THREE.Mesh(quadGeo, this._coronaMat);
    this._corona.frustumCulled = false;
    this._corona.renderOrder = 10;
    this._group.add(this._corona);
  }

  // ── Primary handling ─────────────────────────────────────────────────────────

  _onSelectionChange() {
    const p = this.selection.primary;
    if (p !== this._primaryIdx) this._setPrimary(p);
    else this._updatePanelButtons();
  }

  _setPrimary(idx) {
    this._primaryIdx = idx;

    if (idx == null) {
      if (this._group) this._group.visible = false;
      this._renderPanel(null);
      this._buildNeighborLabels();
      return;
    }

    const pos = new THREE.Vector3(
      this.catalog.positions[idx * 3],
      this.catalog.positions[idx * 3 + 1],
      this.catalog.positions[idx * 3 + 2],
    );
    this._target.copy(pos);
    this._group.position.copy(pos);
    this._group.visible = true;

    // Spectral colour drives both shaders (slightly lifted for vibrancy)
    const c = new THREE.Color(
      this.catalog.colors[idx * 3],
      this.catalog.colors[idx * 3 + 1],
      this.catalog.colors[idx * 3 + 2],
    );
    // Keep the hue vivid at a moderate lightness — over-lifting lightness
    // washes the colour out to white once bloom is applied.
    const hsl = {}; c.getHSL(hsl);
    c.setHSL(hsl.h, Math.min(1, hsl.s * 1.5 + 0.25), 0.52);
    this._plasmaMat.uniforms.uColor.value.copy(c);
    this._coronaMat.uniforms.uColor.value.copy(c);

    // Reset orbit framing
    this._orbitRadius = this.SPHERE_RADIUS * 4.2;
    this._applyOrbit();

    this._renderPanel(idx);
    this._buildNeighborLabels();
  }

  // ── Camera orbit ──────────────────────────────────────────────────────────────

  _applyOrbit() {
    const phi = Math.max(0.08, Math.min(Math.PI - 0.08, this._pitch));
    const r = this._orbitRadius;
    const dx = r * Math.sin(phi) * Math.sin(this._yaw);
    const dz = r * Math.cos(phi);
    const dy = r * Math.sin(phi) * Math.cos(this._yaw);
    this.camera.position.set(
      this._target.x + dx, this._target.y + dy, this._target.z + dz,
    );
    this.camera.lookAt(this._target);
  }

  _orbitDrag(dx, dy) {
    this._yaw   -= dx * 0.006;
    this._pitch -= dy * 0.006;
    this._pitch  = Math.max(0.08, Math.min(Math.PI - 0.08, this._pitch));
    this._applyOrbit();
  }

  _dolly(deltaY) {
    const min = this.SPHERE_RADIUS * 1.4;
    const max = this.SPHERE_RADIUS * 60;
    this._orbitRadius = Math.max(min, Math.min(max, this._orbitRadius * Math.pow(1.0008, deltaY)));
    this._applyOrbit();
  }

  // ── Neighbour labels ──────────────────────────────────────────────────────────

  _buildNeighborLabels() {
    if (!this._labelOverlay) return;
    this._labelOverlay.innerHTML = '';
    this._neighborLabels = [];
    this._primaryLabel = null;
    if (this._primaryIdx == null) return;

    const idx = this._primaryIdx;
    const px = this.catalog.positions[idx * 3];
    const py = this.catalog.positions[idx * 3 + 1];
    const pz = this.catalog.positions[idx * 3 + 2];

    // Nearest N catalog stars to the primary (3D distance)
    const N = 8;
    const near = [];
    for (let i = 0; i < this.catalog.starCount; i++) {
      if (i === idx) continue;
      if (this.catalog.magnitudes[i] > this.starField.maxMagnitude) continue;
      const dx = this.catalog.positions[i * 3]     - px;
      const dy = this.catalog.positions[i * 3 + 1] - py;
      const dz = this.catalog.positions[i * 3 + 2] - pz;
      const d2 = dx*dx + dy*dy + dz*dz;
      near.push({ i, d2 });
    }
    near.sort((a, b) => a.d2 - b.d2);

    const mk = (i, cls) => {
      const el = document.createElement('div');
      el.className = `sd-label ${cls}`;
      const name = this.catalog.getStarName(i) || `HIP ${this.catalog.hipIds[i]}`;
      const dly  = this.catalog.distances[i];
      const distStr = dly > 0 ? (dly < 10 ? dly.toFixed(1) : Math.round(dly)) + ' ly' : '';
      el.innerHTML = `<span class="sd-label-name">${name}</span><span class="sd-label-dist">${distStr}</span>`;
      el.style.opacity = '0';
      this._labelOverlay.appendChild(el);
      return el;
    };

    // Primary label
    const pel = mk(idx, 'primary');
    this._primaryLabel = { el: pel, pos: new THREE.Vector3(px, py, pz) };

    for (let k = 0; k < Math.min(N, near.length); k++) {
      const i = near[k].i;
      const el = mk(i, 'neighbor');
      this._neighborLabels.push({
        el,
        pos: new THREE.Vector3(
          this.catalog.positions[i * 3],
          this.catalog.positions[i * 3 + 1],
          this.catalog.positions[i * 3 + 2],
        ),
      });
    }
  }

  _updateLabels() {
    if (!this.camera || !this.container) return;
    const W = this.container.clientWidth;
    const H = this.container.clientHeight;
    const v = new THREE.Vector3();
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);

    const project = (pos) => {
      v.copy(pos).project(this.camera);
      return { x: (v.x * 0.5 + 0.5) * W, y: (v.y * -0.5 + 0.5) * H, behind: v.z > 1 };
    };

    if (this._primaryLabel) {
      const { el, pos } = this._primaryLabel;
      const s = project(pos);
      if (s.behind) { el.style.opacity = '0'; }
      else {
        el.style.left = s.x + 'px';
        el.style.top  = (s.y - this._sphereScreenOffset()) + 'px';
        el.style.opacity = '1';
      }
    }

    const camPos = this.camera.position;
    const dir = new THREE.Vector3();
    for (const { el, pos } of this._neighborLabels) {
      const s = project(pos);
      if (s.behind) { el.style.opacity = '0'; continue; }
      // Fade in as the neighbour swings toward the view centre
      dir.copy(pos).sub(camPos).normalize();
      const facing = dir.dot(fwd); // 1 = dead ahead
      const op = THREE.MathUtils.clamp((facing - 0.72) / 0.22, 0, 1);
      el.style.left = s.x + 'px';
      el.style.top  = (s.y - 8) + 'px';
      el.style.opacity = (op * 0.85).toFixed(2);
    }
  }

  /** Vertical screen offset so the primary label clears the plasma disk. */
  _sphereScreenOffset() {
    const H = this.container.clientHeight;
    const halfFov = (this.camera.fov * Math.PI / 360);
    const screenR = (this.SPHERE_RADIUS / (this._orbitRadius * Math.tan(halfFov))) * (H / 2);
    return screenR + 14;
  }

  // ── Spectral estimates ────────────────────────────────────────────────────────

  _spectral(idx) {
    const r = this.catalog.colors[idx * 3];
    const b = this.catalog.colors[idx * 3 + 2];
    const d = r - b; // >0 reddish (cool), <0 bluish (hot)
    let cls, temp, blurb;
    if (d < -0.18)      { cls = 'O'; temp = 32000; blurb = 'A scorching blue giant — among the hottest, most luminous, and shortest-lived stars.'; }
    else if (d < -0.08) { cls = 'B'; temp = 16000; blurb = 'A hot blue-white star, blazing with intense ultraviolet light.'; }
    else if (d < -0.02) { cls = 'A'; temp = 9200;  blurb = 'A blue-white star with strong hydrogen lines and a brilliant white glow.'; }
    else if (d < 0.05)  { cls = 'F'; temp = 6900;  blurb = 'A yellow-white star, slightly hotter and brighter than the Sun.'; }
    else if (d < 0.14)  { cls = 'G'; temp = 5600;  blurb = 'A yellow main-sequence star, much like the Sun.'; }
    else if (d < 0.26)  { cls = 'K'; temp = 4400;  blurb = 'A cooler orange star, long-lived and abundant across the galaxy.'; }
    else                { cls = 'M'; temp = 3300;  blurb = 'A cool red dwarf or red giant glowing deep orange-red.'; }
    return { cls, temp, blurb };
  }

  // ── Info panel ────────────────────────────────────────────────────────────────

  _buildPanel(container) {
    this._panel = document.createElement('div');
    this._panel.className = 'sd-panel';
    this._injectStyles();
    container.appendChild(this._panel);

    this._panel.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (!action || this._primaryIdx == null) return;
      if (action === 'route') {
        this.selection.select(this._primaryIdx);
      } else if (action === 'origin') {
        this.viewState.setOrigin(this._primaryIdx);
        const btn = this._panel.querySelector('[data-action="origin"]');
        if (btn) { btn.classList.add('active'); btn.textContent = '✓ origin set'; }
      }
    });
  }

  _renderPanel(idx) {
    if (!this._panel) return;
    if (idx == null) {
      this._panel.innerHTML = `<div class="sd-empty">no star selected<br><span>pick a star, then open detail</span></div>`;
      return;
    }

    const name = this.catalog.getStarName(idx) || `HIP ${this.catalog.hipIds[idx]}`;
    const hip  = this.catalog.hipIds[idx];
    const dly  = this.catalog.distances[idx];
    const mag  = this.catalog.magnitudes[idx];
    const { cls, temp, blurb } = this._spectral(idx);

    const r = Math.round(this.catalog.colors[idx * 3]     * 255);
    const g = Math.round(this.catalog.colors[idx * 3 + 1] * 255);
    const b = Math.round(this.catalog.colors[idx * 3 + 2] * 255);
    const distStr = dly > 0 ? (dly < 10 ? dly.toFixed(2) : Math.round(dly)) + ' ly' : '—';

    this._panel.innerHTML = `
      <div class="sd-head">
        <div class="sd-swatch" style="background:rgb(${r},${g},${b})"></div>
        <div class="sd-title">
          <div class="sd-name">${name}</div>
          <div class="sd-sub">HIP ${hip}</div>
        </div>
      </div>
      <div class="sd-class">
        <span class="sd-class-letter">${cls}</span>
        <span class="sd-class-label">spectral class</span>
      </div>
      <div class="sd-stats">
        <div class="sd-stat"><span class="sd-stat-k">distance</span><span class="sd-stat-v">${distStr}</span></div>
        <div class="sd-stat"><span class="sd-stat-k">apparent mag</span><span class="sd-stat-v">${mag.toFixed(2)}</span></div>
        <div class="sd-stat"><span class="sd-stat-k">temperature</span><span class="sd-stat-v">~${temp.toLocaleString()} K</span></div>
      </div>
      <div class="sd-blurb">${blurb}</div>
      <div class="sd-actions">
        <button class="hud-btn" data-action="route">＋ add to route</button>
        <button class="hud-btn" data-action="origin">◎ set as origin</button>
      </div>
      <div class="sd-foot">estimates derived from spectral colour</div>
    `;
    this._updatePanelButtons();
  }

  _updatePanelButtons() {
    if (!this._panel || this._primaryIdx == null) return;
    const originBtn = this._panel.querySelector('[data-action="origin"]');
    if (originBtn && this.viewState.origin === this._primaryIdx) {
      originBtn.classList.add('active');
      originBtn.textContent = '✓ origin set';
    }
  }

  // ── Input ────────────────────────────────────────────────────────────────────

  _bindEvents(container) {
    this._mouse = new THREE.Vector2();
    this._raycaster = new THREE.Raycaster();
    this._downX = 0; this._downY = 0; this._moved = false;

    const onDown = (e) => {
      if (e.target.closest('.sd-panel, .hud-btn, .nav-dock, .sel-bar')) return;
      this._dragging = true;
      this._autoRotate = false;
      this._lastX = e.clientX; this._lastY = e.clientY;
      this._downX = e.clientX; this._downY = e.clientY;
      this._moved = false;
    };
    const onMove = (e) => {
      const rect = container.getBoundingClientRect();
      this._mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this._mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      if (!this._dragging) return;
      const dx = e.clientX - this._lastX;
      const dy = e.clientY - this._lastY;
      if (Math.abs(e.clientX - this._downX) + Math.abs(e.clientY - this._downY) > 3) this._moved = true;
      this._lastX = e.clientX; this._lastY = e.clientY;
      this._orbitDrag(dx, dy);
    };
    const onUp = (e) => {
      const wasDragging = this._dragging;
      this._dragging = false;
      // Resume auto-rotate shortly after the user lets go
      clearTimeout(this._autoResume);
      this._autoResume = setTimeout(() => { this._autoRotate = true; }, 2500);
      if (e.button === 0 && wasDragging && !this._moved) {
        this._raycaster.setFromCamera(this._mouse, this.camera);
        const hit = this.starField.pick(this._raycaster, this.camera);
        if (hit >= 0) this.selection.setPrimary(hit); // jump detail to clicked star
      }
    };
    const onWheel = (e) => {
      if (e.target.closest('.sd-panel')) return;
      e.preventDefault();
      this._dolly(e.deltaY);
    };

    // ── Touch: 1-finger orbit, 2-finger pinch zoom, tap = focus star ─────────
    const tdist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    let tMode = null, ltx = 0, lty = 0, lpinch = 0, tDownX = 0, tDownY = 0, tMoved = false;

    const onTouchStart = (e) => {
      if (e.target.closest('.sd-panel, .hud-btn, .nav-dock, .sel-bar')) return;
      if (e.touches.length === 1) {
        tMode = 'orbit'; this._autoRotate = false;
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
        this._orbitDrag(dx, dy);
      } else if (tMode === 'pinch' && e.touches.length >= 2) {
        const d = tdist(e.touches[0], e.touches[1]);
        const delta = d - lpinch; lpinch = d;
        this._dolly(-delta * 12); // apart → zoom in
      }
    };
    const onTouchEnd = (e) => {
      if (tMode === 'orbit' && !tMoved) {
        const rect = container.getBoundingClientRect();
        this._mouse.x = ((tDownX - rect.left) / rect.width) * 2 - 1;
        this._mouse.y = -((tDownY - rect.top) / rect.height) * 2 + 1;
        this._raycaster.setFromCamera(this._mouse, this.camera);
        const hit = this.starField.pick(this._raycaster, this.camera);
        if (hit >= 0) this.selection.setPrimary(hit);
      }
      clearTimeout(this._autoResume);
      this._autoResume = setTimeout(() => { this._autoRotate = true; }, 2500);
      if (e.touches.length === 0) tMode = null;
      else if (e.touches.length === 1) {
        tMode = 'orbit'; ltx = e.touches[0].clientX; lty = e.touches[0].clientY; tMoved = true;
      }
    };

    container.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    container.addEventListener('wheel', onWheel, { passive: false });
    container.addEventListener('touchstart', onTouchStart, { passive: false });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd);
    this._cleanups.push(() => {
      container.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      clearTimeout(this._autoResume);
    });
  }

  // ── Overlay + styles ──────────────────────────────────────────────────────────

  _buildLabelOverlay(container) {
    this._labelOverlay = document.createElement('div');
    this._labelOverlay.className = 'sd-label-overlay';
    container.appendChild(this._labelOverlay);
  }

  _injectStyles() {
    if (document.getElementById('stardetail-style')) return;
    const s = document.createElement('style');
    s.id = 'stardetail-style';
    s.textContent = `
      .sd-label-overlay { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 90; }
      .sd-label {
        position: absolute; transform: translateX(-50%);
        display: flex; flex-direction: column; align-items: center; gap: 1px;
        pointer-events: none; transition: opacity 0.2s ease;
      }
      .sd-label-name {
        font-family: var(--font-ui); font-size: 10px; letter-spacing: 0.06em;
        white-space: nowrap; text-shadow: 0 1px 4px rgba(0,0,0,0.9);
        color: rgba(200, 220, 255, 0.9);
      }
      .sd-label.primary .sd-label-name {
        font-size: 13px; letter-spacing: 0.1em; color: var(--c-gold);
        text-transform: uppercase;
      }
      .sd-label-dist {
        font-family: var(--font-mono); font-size: 8px;
        color: rgba(140, 170, 220, 0.6); white-space: nowrap;
        text-shadow: 0 1px 4px rgba(0,0,0,0.9);
      }
      .sd-panel {
        position: absolute; top: 0; right: 0; bottom: 0;
        width: 210px; z-index: 100;
        padding: 18px 16px 14px;
        background: var(--c-surface-raised);
        border-left: 1px solid var(--c-border);
        backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
        font-family: var(--font-ui);
        display: flex; flex-direction: column; gap: 14px;
        box-shadow: -6px 0 28px rgba(0,0,0,0.4);
      }
      .sd-empty {
        color: var(--c-text-dim); font-size: 12px; margin-top: 40px;
        text-align: center; line-height: 1.7;
      }
      .sd-empty span { font-size: 10px; color: var(--c-text-dim); }
      .sd-head { display: flex; align-items: center; gap: 10px; }
      .sd-swatch {
        width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0;
        box-shadow: 0 0 14px 1px currentColor, inset 0 0 6px rgba(255,255,255,0.4);
      }
      .sd-name { font-family: var(--font-header); font-size: 15px; color: var(--c-text); font-weight: 700; letter-spacing: 0.01em; }
      .sd-sub  { font-size: 10px; color: var(--c-text-dim); font-family: var(--font-mono); }
      .sd-class {
        display: flex; align-items: baseline; gap: 8px;
        border-top: 0.5px solid var(--c-border-subtle);
        border-bottom: 0.5px solid var(--c-border-subtle);
        padding: 10px 0;
      }
      .sd-class-letter {
        font-size: 30px; font-weight: 700; line-height: 1;
        color: var(--c-select); font-family: var(--font-header);
      }
      .sd-class-label {
        font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em;
        color: var(--c-text-dim);
      }
      .sd-stats { display: flex; flex-direction: column; gap: 8px; }
      .sd-stat { display: flex; justify-content: space-between; align-items: baseline; }
      .sd-stat-k { font-size: 10px; color: var(--c-text-muted); text-transform: uppercase; letter-spacing: 0.06em; }
      .sd-stat-v { font-size: 12px; color: var(--c-text); font-family: var(--font-mono); }
      .sd-blurb {
        font-size: 11px; line-height: 1.6; color: var(--c-text-muted);
        border-top: 0.5px solid var(--c-border-subtle); padding-top: 12px;
      }
      .sd-actions { display: flex; flex-direction: column; gap: 6px; margin-top: auto; }
      .sd-actions .hud-btn { text-align: center; padding: 7px; font-size: 11px; }
      .sd-foot { font-size: 8px; color: var(--c-text-dim); text-align: center; letter-spacing: 0.04em; }
    `;
    document.head.appendChild(s);
  }
}
