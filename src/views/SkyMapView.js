/**
 * SkyMapView
 * PTZ camera locked to origin. Sky atlas mode.
 * Manages: constellation lines, RA/Dec grid, parallax dropdown, Rayleigh.
 */

import * as THREE from 'three';
import { LineSegments2 }        from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial }         from 'three/addons/lines/LineMaterial.js';
import { PTZCamera }           from '../core/PTZCamera.js';
import { ConstellationLoader } from '../data/ConstellationLoader.js';
import { ConstellationModal }  from './ConstellationModal.js';

export class SkyMapView {
  constructor({ scene, sceneManager, starField, catalog, selection, observer, viewState }) {
    this.scene = scene;
    this.sm = sceneManager;
    this.starField = starField;
    this.catalog = catalog;
    this.selection = selection;
    this.observer = observer;
    this.viewState = viewState;

    this.ptz = null;
    this._toolbar = null;
    this._parallaxOpen = false;
    this._parallaxActive = false;
    this._parallaxBar = null;
    this._parallaxBarLabel = null;
    this._parallaxBarCanvas = null;
    this._parallaxBarCtx = null;
    this._lastTime = null;
    this._keysDown = new Set();
    this._raycaster = new THREE.Raycaster();
    this._mouse = new THREE.Vector2();
    this._cleanups = [];
    this._constellationLines = null;
    this._constellationLabels = [];
    this._constellationsVisible = false;
    this._constLoader = new ConstellationLoader();
    this._constModal  = new ConstellationModal(sceneManager, catalog);
    this._constLoaded = false;
    this._lastDt = 0;
  }

  mount(container) {
    this.container = container;
    this.ptz = new PTZCamera(container);
    this.ptz.setAspect(container.clientWidth / container.clientHeight);
    this.sm.setCamera(this.ptz.camera);

    this._buildConstellationLines();
    this._buildToolbar(container);
    this._buildFovBar(container);
    this._buildDevPanel(container);
    this._buildParallaxBar(container);
    this._bindEvents(container);

    // Set initial resolution for screen-space shaders
    this.starField.setResolution(container.clientWidth, container.clientHeight);
    const onResize = () => {
      this.starField.setResolution(container.clientWidth, container.clientHeight);
      if (this._constMaterials) {
        for (const mat of this._constMaterials.values()) {
          mat.uniforms.uResolution.value.set(container.clientWidth, container.clientHeight);
        }
      }
    };
    window.addEventListener('resize', onResize);
    this._cleanups.push(() => window.removeEventListener('resize', onResize));
    this.sm.setRayleigh(true, 0.5, 0.55);

    // Update Rayleigh horizon each frame
    const off = this.sm.onUpdate(() => {
      const h = this.ptz.horizonNDC;
      this.sm.setRayleigh(true, h, 0.55);
    });
    this._cleanups.push(off);

  }

  _buildFovBar(container) {
    this._fovBar = document.createElement('div');
    this._fovBar.className = 'fov-bar';
    this._fovBar.innerHTML = `
      <div class="fov-bar-track">
        <div class="fov-bar-indicator" id="fov-indicator">
          <div class="fov-arrow-head"></div>
          <div class="fov-arrow-stem"></div>
          <span class="fov-bar-value" id="fov-value">70°</span>
        </div>
      </div>
    `;
    this._injectFovBarStyles();
    container.appendChild(this._fovBar);

    const indicator = this._fovBar.querySelector('#fov-indicator');
    const label     = this._fovBar.querySelector('#fov-value');

    const MIN_LOG = Math.log(0.5);
    const MAX_LOG = Math.log(90);

    const update = (fov) => {
      // 0.5° = top (0%), 90° = bottom (100%)
      const t = (Math.log(fov) - MIN_LOG) / (MAX_LOG - MIN_LOG);
      indicator.style.top = `${t * 100}%`;
      label.textContent = fov < 10 ? fov.toFixed(1) + '°' : Math.round(fov) + '°';
    };

    update(70);
    const off = this.ptz.onFovChange(update);
    this._cleanups.push(off);
  }

  _injectFovBarStyles() {
    if (document.getElementById('fov-bar-style')) return;
    const s = document.createElement('style');
    s.id = 'fov-bar-style';
    s.textContent = `
      .fov-bar {
        position: absolute;
        left: 14px;
        top: 50%;
        transform: translateY(-50%);
        z-index: 100;
        pointer-events: none;
      }
      .fov-bar-track {
        position: relative;
        width: 2px;
        height: 140px;
        background: rgba(255,255,255,0.10);
        border-radius: 1px;
      }
      /* Tick marks at top (0.5°) and bottom (90°) */
      .fov-bar-track::before,
      .fov-bar-track::after {
        content: '';
        position: absolute;
        left: 0;
        width: 10px;
        height: 1.5px;
        background: rgba(255,255,255,0.28);
      }
      .fov-bar-track::before { top: 0; }
      .fov-bar-track::after  { bottom: 0; }
      .fov-bar-indicator {
        position: absolute;
        left: 2px;
        transform: translateY(-50%);
        display: flex;
        align-items: center;
        transition: top 0.08s ease;
      }
      .fov-arrow-stem {
        width: 9px;
        height: 1.5px;
        background: var(--c-accent);
        box-shadow: 0 0 4px rgba(100,180,255,0.55);
      }
      .fov-arrow-head {
        width: 0;
        height: 0;
        border-top: 3px solid transparent;
        border-bottom: 3px solid transparent;
        border-right: 5px solid rgba(100,180,255,1);
      }
      .fov-bar-value {
        font-family: var(--font-mono);
        font-size: 9px;
        color: var(--c-accent);
        margin-left: 5px;
        white-space: nowrap;
        text-shadow: 0 0 5px rgba(100,180,255,0.45);
      }
    `;
    document.head.appendChild(s);
  }

  _buildConstellationLines() {
    const group = new THREE.Group();
    group.visible = false;
    this._constellationLines = group;
    this.scene.add(group);

    // Per-constellation LineMaterial instances for thick lines + highlight
    this._constMaterials = new Map(); // abbrev → LineMaterial

    this._constLoader.load(this.catalog).then((constellations) => {
      this._constLoaded = true;
      const res = new THREE.Vector2(this.container.clientWidth, this.container.clientHeight);
      for (const con of Object.values(constellations)) {
        if (con.segments.length === 0) continue;
        const positions = [];
        for (const { a, b } of con.segments) {
          positions.push(
            this.catalog.positions[a * 3],     this.catalog.positions[a * 3 + 1], this.catalog.positions[a * 3 + 2],
            this.catalog.positions[b * 3],     this.catalog.positions[b * 3 + 1], this.catalog.positions[b * 3 + 2],
          );
        }
        const geo = new LineSegmentsGeometry();
        geo.setPositions(positions);
        const mat = new LineMaterial({
          color:       0x4d7daa,
          linewidth:   1.8,         // pixels
          opacity:     0.45,
          transparent: true,
          depthWrite:  false,
          resolution:  res.clone(),
        });
        this._constMaterials.set(con.abbrev, mat);
        const lineSegs = new LineSegments2(geo, mat);
        lineSegs.userData.abbrev = con.abbrev;
        group.add(lineSegs);
      }
      if (this._constellationsVisible) this._showConstellationLabels();
    }).catch(err => console.warn('Constellation load failed:', err));
  }

  _showConstellationLabels() {
    this._hideConstellationLabels();
    if (!this._constLoaded) return;
    for (const con of this._constLoader.list()) {
      const label = document.createElement('span');
      label.className = 'const-label';
      label.textContent = con.name;
      label.dataset.abbrev = con.abbrev;
      label.addEventListener('click', (e) => {
        e.stopPropagation();
        this._constModal.open(con, this.container);
      });
      label.addEventListener('mouseenter', () => {
        this.starField.setHoveredStars(con.stars);
        const mat = this._constMaterials?.get(con.abbrev);
        if (mat) { mat.color.set(0x8dc8ff); mat.linewidth = 2.0; mat.opacity = 0.80; }
      });
      label.addEventListener('mouseleave', () => {
        this.starField.setHoveredStars(null);
        const mat = this._constMaterials?.get(con.abbrev);
        if (mat) { mat.color.set(0x4d7daa); mat.linewidth = 1.8; mat.opacity = 0.45; }
      });
      this.container.appendChild(label);
      this._constellationLabels.push(label);
    }
    this._updateLabelPositions();
  }

  _hideConstellationLabels() {
    for (const el of this._constellationLabels) el.remove();
    this._constellationLabels = [];
  }

  _updateLabelPositions() {
    if (!this._constellationLabels.length) return;
    const W = this.container.clientWidth;
    const H = this.container.clientHeight;
    const cam = this.ptz.camera;

    for (const label of this._constellationLabels) {
      const abbrev = label.dataset.abbrev;
      const con = this._constLoader.constellations[abbrev];
      if (!con) continue;

      // Project centroid to screen
      const v = con.centroid.clone().project(cam);
      // v.z > 1 means it's behind the camera
      if (v.z > 1) { label.style.display = 'none'; continue; }
      label.style.display = '';
      const x = (v.x * 0.5 + 0.5) * W;
      const y = (-v.y * 0.5 + 0.5) * H;
      label.style.left = x + 'px';
      label.style.top  = y + 'px';
    }
  }

  _updateConstellationOpacity() {
    // Lines fade via screen-space shader (centre 50% → edge 0%)
    // Labels fade by FOV: visible at all zoom levels but stronger when zoomed in
    const fov = this.ptz._fov;
    const t = Math.pow(1.0 - Math.min(1, Math.max(0, (fov - 10) / 60)), 1.6);
    const labelAlpha = 0.35 + t * 0.55;
    for (const el of this._constellationLabels) {
      el.style.opacity = labelAlpha.toFixed(2);
    }
  }

  _buildToolbar(container) {
    this._toolbar = document.createElement('div');
    this._toolbar.className = 'skymap-toolbar';
    this._toolbar.innerHTML = `
      <div class="skymap-toolbar-left">
        <span class="hud-pill" id="obs-pos">${this.observer.posString}</span>
        <span class="hud-pill" id="obs-time">${this.observer.utcString}</span>
        <button class="hud-btn" id="parallax-toggle">
          parallax <span style="opacity:0.5;font-size:9px;">▾</span>
        </button>
      </div>
      <div class="skymap-toolbar-right">
        <div class="exposure-ctrl">
          <span class="exposure-label">exp</span>
          <input type="range" id="exposure-slider" min="0.05" max="5" step="0.05" value="1" />
        </div>
        <button class="hud-btn" id="grid-btn">grid</button>
        <button class="hud-btn" id="const-btn">const.</button>
        <button class="hud-btn" id="filter-btn">filter</button>
      </div>
    `;
    this._injectToolbarStyles();
    container.appendChild(this._toolbar);

    // Parallax dropdown
    this._parallaxDropdown = document.createElement('div');
    this._parallaxDropdown.className = 'parallax-dropdown panel';
    this._parallaxDropdown.innerHTML = `
      <div class="pd-title">parallax rail</div>
      <div class="pd-row">
        <span class="pd-label">speed</span>
        <input type="range" id="px-speed" min="10" max="60" value="20" step="1" />
        <span class="pd-val" id="px-speed-val">20 lm/s</span>
      </div>
      <div class="pd-units">
        <span class="pd-unit-label">unit</span>
        <div class="pd-unit-btns">
          <button class="hud-btn active" data-unit="lm">lm</button>
          <button class="hud-btn" data-unit="lh">lh</button>
          <button class="hud-btn" data-unit="ld">ld</button>
          <button class="hud-btn" data-unit="ly">ly</button>
        </div>
      </div>
    `;
    this._parallaxDropdown.style.display = 'none';
    container.appendChild(this._parallaxDropdown);

    this._bindToolbarEvents();
  }

  _injectToolbarStyles() {
    if (document.getElementById('skymap-toolbar-style')) return;
    const s = document.createElement('style');
    s.id = 'skymap-toolbar-style';
    s.textContent = `
      .skymap-toolbar {
        position: absolute;
        top: 12px;
        left: 14px;
        right: 14px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        z-index: 100;
        pointer-events: none;
      }
      .skymap-toolbar-left, .skymap-toolbar-right {
        display: flex;
        gap: 6px;
        align-items: center;
        pointer-events: all;
      }
      .parallax-dropdown {
        position: absolute;
        top: 48px;
        left: 14px;
        width: 220px;
        padding: 12px 14px;
        z-index: 200;
        font-family: var(--font-ui);
      }
      .pd-title {
        font-size: 9px;
        color: var(--c-text-dim);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        margin-bottom: 10px;
      }
      .pd-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }
      .pd-label { font-size: 10px; color: var(--c-text-muted); min-width: 36px; }
      .pd-val { font-size: 10px; color: var(--c-accent); min-width: 48px; text-align: right; }
      .pd-units { border-top: 0.5px solid var(--c-border-subtle); padding-top: 8px; margin-top: 4px; }
      .pd-unit-label { font-size: 9px; color: var(--c-text-dim); margin-bottom: 5px; display: block; }
      .pd-unit-btns { display: flex; gap: 4px; flex-wrap: wrap; }
      .pd-unit-btns .hud-btn { padding: 3px 8px; font-size: 10px; }
      input[type=range] { flex: 1; }
      .exposure-ctrl {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 0 4px;
      }
      .exposure-label {
        font-family: var(--font-ui);
        font-size: 10px;
        color: var(--c-text-dim);
        letter-spacing: 0.08em;
        text-transform: uppercase;
        white-space: nowrap;
      }
      #exposure-slider {
        width: 72px;
        flex: none;
        accent-color: rgba(100,180,255,0.8);
        opacity: 0.55;
        transition: opacity 0.15s ease;
      }
      #exposure-slider:hover { opacity: 1; }
    `;
    document.head.appendChild(s);
  }

  _bindToolbarEvents() {
    const t = this._toolbar;
    t.querySelector('#parallax-toggle').addEventListener('click', () => {
      this._parallaxOpen = !this._parallaxOpen;
      this._parallaxDropdown.style.display = this._parallaxOpen ? 'block' : 'none';
      t.querySelector('#parallax-toggle').classList.toggle('active', this._parallaxOpen);
    });

    // Per-unit slider range and default value
    const UNIT_RANGES = {
      lm: { min: 10,  max: 60,  def: 20  },
      lh: { min: 1,   max: 24,  def: 6   },
      ld: { min: 1,   max: 365, def: 7   },
      ly: { min: 1,   max: 10,  def: 1   },
    };
    const unitLabel = { lm: 'lm/s', lh: 'lh/s', ld: 'ld/s', ly: 'ly/s' };
    let activeUnit = 'lm';

    const speedSlider = this._parallaxDropdown.querySelector('#px-speed');
    const speedVal    = this._parallaxDropdown.querySelector('#px-speed-val');

    const applyUnit = (unit) => {
      activeUnit = unit;
      const r = UNIT_RANGES[unit];
      speedSlider.min   = r.min;
      speedSlider.max   = r.max;
      speedSlider.value = r.def;
      speedVal.textContent = `${r.def} ${unitLabel[unit]}`;
      this._parallaxDropdown.querySelectorAll('[data-unit]').forEach(b =>
        b.classList.toggle('active', b.dataset.unit === unit)
      );
    };

    this._parallaxDropdown.querySelectorAll('[data-unit]').forEach(btn => {
      btn.addEventListener('click', () => applyUnit(btn.dataset.unit));
    });

    speedSlider.addEventListener('input', () => {
      speedVal.textContent = `${speedSlider.value} ${unitLabel[activeUnit]}`;
    });

    const applyExposure = (exp) => {
      this.starField.setExposure(exp);
      const t = (exp - 0.25) / 4.75; // 0 at min, 1 at max
      this.starField.setBaseSize(3.0 - 2.0 * t); // 3.0 at min → 1.0 at max
    };
    applyExposure(1.0);
    t.querySelector('#exposure-slider').addEventListener('input', (e) => {
      applyExposure(parseFloat(e.target.value));
    });

    // Update observer display
    const posEl = t.querySelector('#obs-pos');
    const timeEl = t.querySelector('#obs-time');
    const off = this.observer.onchange(() => {
      posEl.textContent = this.observer.posString;
      timeEl.textContent = this.observer.utcString;
    });
    this._cleanups.push(off);

    // Constellation toggle
    t.querySelector('#const-btn').addEventListener('click', () => {
      this._constellationsVisible = !this._constellationsVisible;
      t.querySelector('#const-btn').classList.toggle('active', this._constellationsVisible);
      if (this._constellationLines) {
        this._constellationLines.visible = this._constellationsVisible;
      }
      if (this._constellationsVisible) {
        this._showConstellationLabels();
      } else {
        this._hideConstellationLabels();
        this._constModal.close();
      }
    });
  }


  _bindEvents(container) {
    const onMove = (e) => {
      const rect = container.getBoundingClientRect();
      this._mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this._mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    };

    const onClick = (e) => {
      if (e.target !== container && !container.contains(e.target)) return;
      if (e.target.closest('.hud-btn, .hud-pill, .panel, .nav-dock, .sel-bar, .parallax-dropdown')) return;

      this._raycaster.setFromCamera(this._mouse, this.ptz.camera);
      const idx = this.starField.pick(this._raycaster, this.ptz.camera);
      if (idx >= 0) {
        // Left click: always additive — toggle star in/out of selection
        this.selection.toggle(idx);
      }
    };

    const onRightClick = (e) => {
      if (e.target.closest('.hud-btn, .hud-pill, .panel, .nav-dock, .sel-bar, .parallax-dropdown')) return;
      e.preventDefault();

      this._raycaster.setFromCamera(this._mouse, this.ptz.camera);
      const idx = this.starField.pick(this._raycaster, this.ptz.camera);
      if (idx >= 0) {
        // Right click on star: deselect just that star
        this.selection.deselect(idx);
      } else {
        // Right click on empty space: clear everything
        this.selection.clear();
      }
    };

    const onKeyDown = (e) => {
      if (e.key === 'p' || e.key === 'P') this._toggleParallax();
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (this._parallaxActive) e.preventDefault();
        this._keysDown.add(e.key);
      }
    };
    const onKeyUp = (e) => { this._keysDown.delete(e.key); };

    container.addEventListener('mousemove', onMove);
    container.addEventListener('click', onClick);
    container.addEventListener('contextmenu', onRightClick);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    this._cleanups.push(() => {
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('click', onClick);
      container.removeEventListener('contextmenu', onRightClick);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
    });
  }

  update(time) {
    const dt = this._lastUpdateTime !== undefined ? time - this._lastUpdateTime : 0;
    this._lastUpdateTime = time;

    this.starField.update(time);
    this.starField.setFov(this.ptz._fov);
    this.starField.updateMotion(this.ptz.camera);

    // Update constellation label positions and line opacity based on FOV
    if (this._constellationsVisible) {
      this._updateLabelPositions();
      this._updateConstellationOpacity();
    }

    this.starField.updateSelection(this.selection);

    if (this._parallaxActive) {
      const dt = this._lastTime !== null ? time - this._lastTime : 0;
      this._lastTime = time;

      const fwd  = this._keysDown.has('ArrowUp');
      const back = this._keysDown.has('ArrowDown');
      if (fwd || back) {
        const speedSlider = this._parallaxDropdown?.querySelector('#px-speed');
        const speedVal    = speedSlider ? parseFloat(speedSlider.value) : 0;
        const unitBtn     = this._parallaxDropdown?.querySelector('[data-unit].active');
        const unit        = unitBtn?.dataset.unit || 'lm';
        const UNIT_PC     = { lm: 5.830e-7, lh: 3.498e-5, ld: 8.395e-4, ly: 0.30660 };
        const speedPcPerSec = speedVal * (UNIT_PC[unit] ?? UNIT_PC.lm);
        const dir = fwd ? 1 : -1;

        const lookDir = new THREE.Vector3();
        this.ptz.camera.getWorldDirection(lookDir);
        this.ptz.camera.position.addScaledVector(lookDir, dir * speedPcPerSec * dt);

        // Don't let camera go behind Sol
        if (this.ptz.camera.position.length() < 0.001) {
          this.ptz.camera.position.set(0, 0, 0.001);
        }
      }

      this._updateGhostSystem();

      const dispPc = this._parallaxOrigin
        ? this.ptz.camera.position.distanceTo(this._parallaxOrigin)
        : 0;
      this._updateDistanceBar(dispPc * 3.26156);
    } else {
      this._lastTime = null;
    }
  }

  _buildDevPanel(container) {
    this._devOpen = false;

    const devBtn = document.createElement('button');
    devBtn.className = 'hud-btn';
    devBtn.id = 'dev-toggle';
    devBtn.textContent = 'dev';
    this._toolbar.querySelector('.skymap-toolbar-right').appendChild(devBtn);

    this._devPanel = document.createElement('div');
    this._devPanel.className = 'dev-panel panel';
    this._devPanel.style.display = 'none';
    this._devPanel.innerHTML = `
      <div class="pd-title">star body</div>
      <div class="dev-row">
        <span class="dev-label">tight base px</span>
        <input type="range" id="dev-tight-size" min="0.5" max="80" step="0.5" value="2" />
        <span class="dev-val" id="dev-tight-size-val">2 px</span>
      </div>
      <div class="dev-row">
        <span class="dev-label">tight crop</span>
        <input type="range" id="dev-tight-crop" min="0.3" max="1.5" step="0.05" value="0.4" />
        <span class="dev-val" id="dev-tight-crop-val">0.40</span>
      </div>
      <div class="dev-row">
        <span class="dev-label">wide base px</span>
        <input type="range" id="dev-wide-size" min="1" max="120" step="1" value="21" />
        <span class="dev-val" id="dev-wide-size-val">21.0 px</span>
      </div>
      <div class="dev-row">
        <span class="dev-label">size min</span>
        <input type="range" id="dev-size-min" min="0.5" max="5" step="0.1" value="2.6" />
        <span class="dev-val" id="dev-size-min-val">2.6 px</span>
      </div>
      <div class="dev-row">
        <span class="dev-label">size max</span>
        <input type="range" id="dev-size-max" min="5" max="250" step="5" value="110" />
        <span class="dev-val" id="dev-size-max-val">110 px</span>
      </div>
      <div class="dev-row">
        <span class="dev-label">tex gamma</span>
        <input type="range" id="dev-tex-gamma" min="0.3" max="4" step="0.1" value="2.2" />
        <span class="dev-val" id="dev-tex-gamma-val">2.2</span>
      </div>
      <div class="dev-row">
        <span class="dev-label">body mag min</span>
        <input type="range" id="dev-body-mag-min" min="-2" max="7" step="0.1" value="2" />
        <span class="dev-val" id="dev-body-mag-min-val">2.0</span>
      </div>
      <div class="dev-row">
        <span class="dev-label">body mag max</span>
        <input type="range" id="dev-body-mag-max" min="-2" max="8" step="0.1" value="7.1" />
        <span class="dev-val" id="dev-body-mag-max-val">7.1</span>
      </div>
      <div class="pd-title" style="margin-top:8px">bloom</div>
      <div class="dev-row">
        <span class="dev-label">bloom scale</span>
        <input type="range" id="dev-bloom-scale" min="1" max="32" step="0.5" value="6" />
        <span class="dev-val" id="dev-bloom-scale-val">6.0×</span>
      </div>
      <div class="dev-row">
        <span class="dev-label">bloom gamma</span>
        <input type="range" id="dev-bloom-gamma" min="0.3" max="12" step="0.1" value="12" />
        <span class="dev-val" id="dev-bloom-gamma-val">12.0</span>
      </div>
      <div class="dev-row">
        <span class="dev-label">bloom fade base</span>
        <input type="range" id="dev-bloom-fade" min="0" max="2" step="0.05" value="0.05" />
        <span class="dev-val" id="dev-bloom-fade-val">0.05</span>
      </div>
      <div class="dev-row">
        <span class="dev-label">bloom lum min</span>
        <input type="range" id="dev-bloom-lum-min" min="0" max="1" step="0.01" value="0" />
        <span class="dev-val" id="dev-bloom-lum-min-val">0.00</span>
      </div>
      <div class="dev-row">
        <span class="dev-label">bloom lum max</span>
        <input type="range" id="dev-bloom-lum-max" min="0" max="1" step="0.01" value="0.35" />
        <span class="dev-val" id="dev-bloom-lum-max-val">0.35</span>
      </div>
      <div class="pd-title" style="margin-top:8px">motion + pan</div>
      <div class="dev-row">
        <span class="dev-label">motion blur</span>
        <input type="range" id="dev-motion-blur" min="0" max="2.5" step="0.05" value="0.6" />
        <span class="dev-val" id="dev-motion-blur-val">0.60</span>
      </div>
      <div class="dev-row">
        <span class="dev-label">pan tighten</span>
        <input type="range" id="dev-pan-scale" min="0" max="3" step="0.05" value="1.0" />
        <span class="dev-val" id="dev-pan-scale-val">1.00</span>
      </div>
      <div class="pd-title" style="margin-top:8px">line rendering</div>
      <div class="dev-row">
        <span class="dev-label">thickness</span>
        <input type="range" id="dev-line-thick" min="0.5" max="8" step="0.5" value="3.0" />
        <span class="dev-val" id="dev-line-thick-val">3.0 px</span>
      </div>
      <div class="dev-row">
        <span class="dev-label">opacity</span>
        <input type="range" id="dev-line-opacity" min="0" max="1" step="0.01" value="0.24" />
        <span class="dev-val" id="dev-line-opacity-val">0.24</span>
      </div>
    `;
    this._injectDevPanelStyles();
    container.appendChild(this._devPanel);

    devBtn.addEventListener('click', () => {
      this._devOpen = !this._devOpen;
      this._devPanel.style.display = this._devOpen ? 'block' : 'none';
      devBtn.classList.toggle('active', this._devOpen);
    });

    const wire = (id, valId, fmt, fn) => {
      const input = this._devPanel.querySelector(`#${id}`);
      const label = this._devPanel.querySelector(`#${valId}`);
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        label.textContent = fmt(v);
        fn(v);
      });
    };

    wire('dev-tight-size',    'dev-tight-size-val',    v => v.toFixed(1) + ' px', v => this.starField.setTightBaseSize(v));
    wire('dev-tight-crop',    'dev-tight-crop-val',    v => v.toFixed(2),          v => this.starField.setTightCrop(v));
    wire('dev-wide-size',     'dev-wide-size-val',     v => v.toFixed(1) + ' px', v => this.starField.setWideBaseSize(v));
    wire('dev-size-min',      'dev-size-min-val',      v => v.toFixed(1) + ' px', v => this.starField.setSizeMin(v));
    wire('dev-size-max',      'dev-size-max-val',      v => v.toFixed(0) + ' px', v => this.starField.setSizeMax(v));
    wire('dev-tex-gamma',     'dev-tex-gamma-val',     v => v.toFixed(1),          v => this.starField.setTexGamma(v));
    wire('dev-body-mag-min',  'dev-body-mag-min-val',  v => v.toFixed(1),          v => this.starField.setBodyMagMin(v));
    wire('dev-body-mag-max',  'dev-body-mag-max-val',  v => v.toFixed(1),          v => this.starField.setBodyMagMax(v));
    wire('dev-bloom-scale',   'dev-bloom-scale-val',   v => v.toFixed(1) + '×',   v => this.starField.setBloomScale(v));
    wire('dev-bloom-gamma',   'dev-bloom-gamma-val',   v => v.toFixed(1),          v => this.starField.setBloomGamma(v));
    wire('dev-bloom-fade',    'dev-bloom-fade-val',    v => v.toFixed(2),          v => this.starField.setBloomFadeBase(v));
    wire('dev-bloom-lum-min', 'dev-bloom-lum-min-val', v => v.toFixed(2),          v => this.starField.setBloomLumMin(v));
    wire('dev-bloom-lum-max', 'dev-bloom-lum-max-val', v => v.toFixed(2),          v => this.starField.setBloomLumMax(v));
    wire('dev-motion-blur',   'dev-motion-blur-val',   v => v.toFixed(2),          v => this.starField.setMotionBlur(v));
    wire('dev-pan-scale',     'dev-pan-scale-val',     v => v.toFixed(2),          v => this.ptz.setPanScale(v));
    wire('dev-line-thick',    'dev-line-thick-val',    v => v.toFixed(1) + ' px',  v => this.starField.setLineThickness(v));
    wire('dev-line-opacity',  'dev-line-opacity-val',  v => v.toFixed(2),          v => this.starField.setLineOpacity(v));
  }

  _injectDevPanelStyles() {
    if (document.getElementById('dev-panel-style')) return;
    const s = document.createElement('style');
    s.id = 'dev-panel-style';
    s.textContent = `
      .dev-panel {
        position: absolute;
        top: 48px;
        right: 14px;
        width: 230px;
        padding: 12px 14px;
        z-index: 200;
        font-family: var(--font-ui);
      }
      .dev-row {
        display: grid;
        grid-template-columns: 72px 1fr 46px;
        align-items: center;
        gap: 6px;
        margin-bottom: 8px;
      }
      .dev-label {
        font-size: 10px;
        color: var(--c-text-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .dev-val {
        font-size: 10px;
        color: var(--c-accent);
        text-align: right;
        font-family: var(--font-mono);
        white-space: nowrap;
      }
      .dev-row input[type=range] {
        width: 100%;
        min-width: 0;
        accent-color: rgba(100,180,255,0.8);
      }
    `;
    document.head.appendChild(s);
  }

  _buildParallaxBar(container) {
    this._parallaxBar = document.createElement('div');
    this._parallaxBar.className = 'px-bar';
    this._parallaxBar.style.display = 'none';
    this._parallaxBar.innerHTML = `
      <div class="px-bar-label" id="px-dist-label">0.000 ly from Sol</div>
      <canvas class="px-bar-canvas"></canvas>
    `;
    this._injectParallaxBarStyles();
    container.appendChild(this._parallaxBar);
    this._parallaxBarLabel  = this._parallaxBar.querySelector('#px-dist-label');
    this._parallaxBarCanvas = this._parallaxBar.querySelector('.px-bar-canvas');

    // Size canvas to fill the bar width, scaled for DPR
    const logicalW = this._parallaxBar.offsetWidth || Math.min(800, container.clientWidth - 140);
    const logicalH = 48;
    const dpr = window.devicePixelRatio || 1;
    this._parallaxBarCanvas.width  = logicalW * dpr;
    this._parallaxBarCanvas.height = logicalH * dpr;
    this._parallaxBarCanvas.style.width  = logicalW + 'px';
    this._parallaxBarCanvas.style.height = logicalH + 'px';
    this._parallaxBarLogicalW = logicalW;
    this._parallaxBarLogicalH = logicalH;

    this._parallaxBarCtx = this._parallaxBarCanvas.getContext('2d');
    this._parallaxBarCtx.scale(dpr, dpr);
  }

  _injectParallaxBarStyles() {
    if (document.getElementById('px-bar-style')) return;
    const s = document.createElement('style');
    s.id = 'px-bar-style';
    s.textContent = `
      .px-bar {
        position: absolute;
        bottom: 64px;
        left: 50%;
        transform: translateX(-50%);
        width: min(860px, calc(100vw - 140px));
        z-index: 100;
        pointer-events: none;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
      }
      .px-bar-label {
        font-family: var(--font-mono);
        font-size: 10px;
        color: rgba(160, 200, 255, 0.60);
        letter-spacing: 0.08em;
        white-space: nowrap;
      }
      .px-bar-canvas {
        display: block;
        border-radius: 3px;
        width: 100%;
      }
    `;
    document.head.appendChild(s);
  }

  // ── Ghost star system ─────────────────────────────────────────────────────
  //
  // Visualises parallax. When the rail is engaged we freeze a *ghost* marker at
  // each star's true 3D position — "where the star was." As the camera translates
  // outward, an *apparent* star drifts away from its ghost, weighted by distance
  // (nearby stars swing far, distant stars barely move), with a connector line
  // drawn between the two. Only the apparent star moves; the ghost stays put.

  _buildGhostSystem() {
    if (this._ghostSystem) this._destroyGhostSystem();

    // Dev constants — tune here
    const GHOST_SIZE     = 7;     // px — fresnel ring marker (small, like modal spheres)
    const APPARENT_SIZE  = 5;     // px — the moving apparent star
    const REF_DIST_PC    = 10.0;  // pc — star at this distance drifts 1:1 with camera travel
    const MAX_FACTOR     = 8.0;   // clamp drift multiplier for very near stars
    const LINE_MIN_DISP  = 0.02;  // pc — connector fades in above this drift
    const LINE_FULL_DISP = 0.50;  // pc — connector reaches full opacity here

    const E0    = this._parallaxOrigin.clone();
    const count = this.catalog.starCount;
    const cpos  = this.catalog.positions;
    const mags  = this.catalog.magnitudes;
    const cols  = this.catalog.colors;

    // Per-star precompute: true position, drift factor, desaturated ghost colour.
    const truePos = new Float32Array(count * 3); // fixed ghost/anchor positions
    const factor  = new Float32Array(count);     // distance-weighted drift multiplier
    const gColor  = new Float32Array(count * 3); // ghost (phantom) colour
    const aColor  = new Float32Array(count * 3); // apparent-star spectral colour
    const aSize   = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const sx = cpos[i*3], sy = cpos[i*3+1], sz = cpos[i*3+2];
      truePos[i*3] = sx; truePos[i*3+1] = sy; truePos[i*3+2] = sz;

      const dx = sx - E0.x, dy = sy - E0.y, dz = sz - E0.z;
      const dist = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
      factor[i] = Math.min(MAX_FACTOR, REF_DIST_PC / dist);

      const r = cols[i*3], g = cols[i*3+1], b = cols[i*3+2];
      aColor[i*3] = r; aColor[i*3+1] = g; aColor[i*3+2] = b;
      // Ghost desaturated toward cold white → reads as a phantom
      gColor[i*3]   = r + (1 - r) * 0.55;
      gColor[i*3+1] = g + (1 - g) * 0.55;
      gColor[i*3+2] = b + (1 - b) * 0.62;

      aSize[i] = Math.max(3, APPARENT_SIZE + (2.0 - mags[i]) * 0.6);
    }

    // ── Ghost markers — fixed fresnel-ring sprites at true positions ──────────
    const ghostGeo = new THREE.BufferGeometry();
    ghostGeo.setAttribute('position', new THREE.BufferAttribute(truePos.slice(), 3));
    ghostGeo.setAttribute('aColor',   new THREE.BufferAttribute(gColor, 3));
    const ghostMat = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: GHOST_SIZE * (Math.min(window.devicePixelRatio, 2)) } },
      vertexShader: `
        attribute vec3 aColor;
        varying   vec3 vColor;
        uniform   float uSize;
        void main() {
          vColor       = aColor;
          gl_PointSize = uSize;
          gl_Position  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        void main() {
          // Soft fresnel-style ring: bright rim, hollow centre
          float d    = length(gl_PointCoord - 0.5) * 2.0;
          float ring = smoothstep(0.55, 0.85, d) * (1.0 - smoothstep(0.85, 1.0, d));
          float core = (1.0 - smoothstep(0.0, 0.35, d)) * 0.25;
          float a    = ring + core;
          if (a < 0.02) discard;
          gl_FragColor = vec4(vColor, a * 0.75);
        }
      `,
      transparent: true,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
    });
    const ghostPoints = new THREE.Points(ghostGeo, ghostMat);
    ghostPoints.frustumCulled = false;
    this.scene.add(ghostPoints);

    // ── Apparent stars — moving spectral points (positions set per frame) ─────
    const appPos = new Float32Array(count * 3);
    const appGeo = new THREE.BufferGeometry();
    appGeo.setAttribute('position', new THREE.BufferAttribute(appPos, 3));
    appGeo.setAttribute('aColor',   new THREE.BufferAttribute(aColor, 3));
    appGeo.setAttribute('aSize',    new THREE.BufferAttribute(aSize, 1));
    const appMat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: Math.min(window.devicePixelRatio, 2) } },
      vertexShader: `
        attribute vec3  aColor;
        attribute float aSize;
        varying   vec3  vColor;
        uniform   float uScale;
        void main() {
          vColor       = aColor;
          gl_PointSize = aSize * uScale;
          gl_Position  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = exp(-d * d * 4.5) + 0.6 * exp(-d * d * 40.0);
          if (a < 0.01) discard;
          gl_FragColor = vec4(vColor, a);
        }
      `,
      transparent: true,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
    });
    const appPoints = new THREE.Points(appGeo, appMat);
    appPoints.frustumCulled = false;
    this.scene.add(appPoints);

    // ── Connector lines — ghost(true) → apparent (positions set per frame) ────
    const cLinePos = new Float32Array(count * 6); // 2 verts × 3 floats per star
    const cLineOpa = new Float32Array(count * 2); // per-vertex opacity
    const connGeo = new THREE.BufferGeometry();
    connGeo.setAttribute('position', new THREE.BufferAttribute(cLinePos, 3));
    connGeo.setAttribute('aOpacity', new THREE.BufferAttribute(cLineOpa, 1));
    const connMat = new THREE.ShaderMaterial({
      vertexShader: `
        attribute float aOpacity;
        varying   float vOpacity;
        void main() {
          vOpacity    = aOpacity;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying float vOpacity;
        void main() {
          if (vOpacity < 0.01) discard;
          gl_FragColor = vec4(0.55, 0.75, 1.0, vOpacity * 0.5);
        }
      `,
      transparent: true,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
    });
    const connLines = new THREE.LineSegments(connGeo, connMat);
    connLines.frustumCulled = false;
    this.scene.add(connLines);

    this._ghostSystem = {
      E0, truePos, factor,
      ghostPoints, ghostGeo, ghostMat,
      appPoints, appGeo, appMat, appPos,
      connLines, connGeo, connMat, cLinePos, cLineOpa,
      LINE_MIN_DISP, LINE_FULL_DISP,
    };
  }

  _destroyGhostSystem() {
    if (!this._ghostSystem) return;
    const s = this._ghostSystem;
    this.scene.remove(s.ghostPoints);
    this.scene.remove(s.appPoints);
    this.scene.remove(s.connLines);
    s.ghostGeo.dispose(); s.ghostMat.dispose();
    s.appGeo.dispose();   s.appMat.dispose();
    s.connGeo.dispose();  s.connMat.dispose();
    this._ghostSystem = null;
  }

  _updateGhostSystem() {
    if (!this._ghostSystem || !this.ptz) return;
    const {
      E0, truePos, factor,
      appGeo, appPos,
      connGeo, cLinePos, cLineOpa,
      LINE_MIN_DISP, LINE_FULL_DISP,
    } = this._ghostSystem;

    const Ec    = this.ptz.camera.position;
    const count = this.catalog.starCount;

    // Camera travel since the rail engaged. Apparent stars drift opposite to it,
    // scaled per-star by the distance-weighted factor → stylised parallax.
    const bx = Ec.x - E0.x, by = Ec.y - E0.y, bz = Ec.z - E0.z;

    for (let i = 0; i < count; i++) {
      const gx = truePos[i*3], gy = truePos[i*3+1], gz = truePos[i*3+2];
      const f  = factor[i];

      // Apparent position: true position pushed opposite camera travel
      const ox = -bx * f, oy = -by * f, oz = -bz * f;
      const ax = gx + ox, ay = gy + oy, az = gz + oz;

      appPos[i*3] = ax; appPos[i*3+1] = ay; appPos[i*3+2] = az;

      // Connector: ghost(true) → apparent
      cLinePos[i*6]   = gx; cLinePos[i*6+1] = gy; cLinePos[i*6+2] = gz;
      cLinePos[i*6+3] = ax; cLinePos[i*6+4] = ay; cLinePos[i*6+5] = az;

      // Drift magnitude drives connector opacity
      const disp = Math.sqrt(ox*ox + oy*oy + oz*oz);
      const opa  = Math.min(1, Math.max(0,
        (disp - LINE_MIN_DISP) / (LINE_FULL_DISP - LINE_MIN_DISP)));
      cLineOpa[i*2] = cLineOpa[i*2+1] = opa;
    }

    appGeo.attributes.position.needsUpdate  = true;
    connGeo.attributes.position.needsUpdate = true;
    connGeo.attributes.aOpacity.needsUpdate = true;
  }

  _toggleParallax() {
    this._parallaxActive = !this._parallaxActive;
    if (this._parallaxActive) {
      // Record starting position so distance bar shows displacement, not absolute position
      this._parallaxOrigin = this.ptz.camera.position.clone();
      this._buildGhostSystem();
    } else {
      this._destroyGhostSystem();
      this.ptz.camera.position.set(0, 0, 0.001);
      this._parallaxOrigin = null;
      this._lastTime = null;
      if (this._parallaxBarLabel) this._parallaxBarLabel.textContent = '0 AU from Sol';
    }
    if (this._parallaxBar) {
      this._parallaxBar.style.display = this._parallaxActive ? 'flex' : 'none';
    }
  }

  _updateDistanceBar(distLy) {
    if (!this._parallaxBarCtx) return;

    // Choose display unit
    let distInUnit, unitLabel;
    if (distLy < 0.01) {
      distInUnit = distLy * 63241.1;
      unitLabel  = 'AU';
    } else if (distLy < 1000) {
      distInUnit = distLy;
      unitLabel  = 'ly';
    } else {
      distInUnit = distLy / 3.26156;
      unitLabel  = 'pc';
    }

    // Update text label
    const decimals = distInUnit < 10 ? 3 : distInUnit < 100 ? 1 : 0;
    this._parallaxBarLabel.textContent =
      distInUnit.toFixed(decimals) + ' ' + unitLabel + ' from Sol';

    // Canvas ruler — major interval = power of 10 containing current dist
    const ctx = this._parallaxBarCtx;
    const W = this._parallaxBarLogicalW;
    const H = this._parallaxBarLogicalH;
    ctx.clearRect(0, 0, W, H);

    // Subtle background strip
    ctx.fillStyle = 'rgba(10, 14, 30, 0.55)';
    ctx.fillRect(0, 0, W, H);

    const safeD = Math.max(distInUnit, 1e-9);
    const majorInterval = Math.pow(10, Math.floor(Math.log10(safeD)));
    const minorInterval = majorInterval / 10;

    // Visible window: 5 major intervals on each side of current pos
    const halfRange = 5 * majorInterval;
    const leftEdge  = distInUnit - halfRange;
    const rightEdge = distInUnit + halfRange;
    const toX = (d) => ((d - leftEdge) / (rightEdge - leftEdge)) * W;

    // Baseline track
    ctx.fillStyle = 'rgba(100, 140, 220, 0.25)';
    ctx.fillRect(0, H - 2, W, 2);

    // Minor ticks
    const firstMinor = Math.ceil(leftEdge / minorInterval) * minorInterval;
    ctx.fillStyle = 'rgba(140, 185, 255, 0.55)';
    for (let d = firstMinor; d <= rightEdge + minorInterval * 0.5; d += minorInterval) {
      const x = toX(d);
      if (x < 0 || x > W) continue;
      ctx.fillRect(Math.round(x), H - 7, 1, 6);
    }

    // Major ticks + labels
    const firstMajor = Math.ceil(leftEdge / majorInterval) * majorInterval;
    ctx.font = '8px "Space Mono", monospace';
    ctx.textAlign = 'center';
    for (let d = firstMajor; d <= rightEdge + majorInterval * 0.5; d += majorInterval) {
      if (d < -majorInterval * 0.01) continue;
      const x = toX(d);
      if (x < 0 || x > W) continue;
      ctx.fillStyle = 'rgba(160, 205, 255, 0.90)';
      ctx.fillRect(Math.round(x), H - 14, 2, 13);
      const lbl = d < 10 ? (d < 1 ? d.toFixed(2) : d.toFixed(1)) : Math.round(d).toString();
      ctx.fillStyle = 'rgba(160, 205, 255, 0.70)';
      ctx.fillText(lbl + ' ' + unitLabel, x, H - 17);
    }

    // Current-position marker — bright white notch
    const cx = toX(distInUnit);
    ctx.fillStyle = 'rgba(220, 235, 255, 1.0)';
    ctx.fillRect(Math.round(cx) - 1, H - 20, 3, 19);

    // Fade edges via destination-out gradient
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0,    'rgba(0,0,0,1)');
    grad.addColorStop(0.12, 'rgba(0,0,0,0)');
    grad.addColorStop(0.88, 'rgba(0,0,0,0)');
    grad.addColorStop(1,    'rgba(0,0,0,1)');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
  }

  unmount() {
    this._cleanups.forEach(fn => fn());
    this._cleanups = [];
    this._toolbar?.remove();
    this._parallaxDropdown?.remove();
    this._devPanel?.remove();
    this._fovBar?.remove();
    this._parallaxBar?.remove();
    this._hideConstellationLabels();
    this._constModal.close();
    this._destroyGhostSystem();
    this.starField.setHoveredStars(null);
    this.ptz.camera.position.set(0, 0, 0.001);
    this.ptz?.destroy();
    if (this._constellationLines) {
      this.scene.remove(this._constellationLines);
    }
  }
}
