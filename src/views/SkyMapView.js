/**
 * SkyMapView
 * PTZ camera locked to origin. Sky atlas mode.
 * Manages: constellation lines, RA/Dec grid, parallax dropdown, Rayleigh.
 */

import * as THREE from 'three';
import { PTZCamera } from '../core/PTZCamera.js';

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
    // Simplified Orion as placeholder — real data would be a full IAU constellation set
    // Each pair of indices references named stars by approximate position
    const lines = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({
      color: 0x4488aa,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    });

    // We'll wire this properly once catalog is loaded with named star lookup
    // For now add the group so it exists in scene
    this._constellationLines = lines;
    this.scene.add(lines);
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
          <input type="range" id="exposure-slider" min="0.25" max="5" step="0.05" value="1" />
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
        <input type="range" id="px-speed" min="0" max="100" value="20" step="1" />
        <span class="pd-val" id="px-speed-val">1 AU/s</span>
      </div>
      <div class="pd-row">
        <span class="pd-label">range</span>
        <input type="range" id="px-range" min="0" max="100" value="15" step="1" />
        <span class="pd-val" id="px-range-val">50 AU</span>
      </div>
      <div class="pd-units">
        <span class="pd-unit-label">unit</span>
        <div class="pd-unit-btns">
          <button class="hud-btn active" data-unit="AU">AU</button>
          <button class="hud-btn" data-unit="ls">ls</button>
          <button class="hud-btn" data-unit="lm">lm</button>
          <button class="hud-btn" data-unit="lh">lh</button>
          <button class="hud-btn" data-unit="ld">ld</button>
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

    const units = ['AU','ls','lm','lh','ld'];
    const unitLabels = {
      AU: v => `${Math.round(v)} AU/s`,
      ls: v => `${Math.round(v)} ls/s`,
      lm: v => `${Math.round(v)} lm/s`,
      lh: v => `${Math.round(v)} lh/s`,
      ld: v => `${Math.round(v)} ld/s`,
    };
    let activeUnit = 'AU';

    this._parallaxDropdown.querySelectorAll('[data-unit]').forEach(btn => {
      btn.addEventListener('click', () => {
        activeUnit = btn.dataset.unit;
        this._parallaxDropdown.querySelectorAll('[data-unit]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._updateSpeedLabel(activeUnit, unitLabels);
      });
    });

    const speedSlider = this._parallaxDropdown.querySelector('#px-speed');
    speedSlider.addEventListener('input', () => this._updateSpeedLabel(activeUnit, unitLabels));

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
  }

  _updateSpeedLabel(unit, labels) {
    const v = parseInt(this._parallaxDropdown.querySelector('#px-speed').value);
    const fn = labels[unit] || labels.AU;
    this._parallaxDropdown.querySelector('#px-speed-val').textContent = fn(v);
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
        if (e.shiftKey) {
          this.selection.toggle(idx);
        } else {
          this.selection.clear();
          this.selection.select(idx);
        }
      } else {
        if (!e.shiftKey) this.selection.clear();
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
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    this._cleanups.push(() => {
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
    });
  }

  update(time) {
    this.starField.update(time);
    this.starField.setFov(this.ptz._fov);
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
        const unit        = unitBtn?.dataset.unit || 'AU';
        const UNIT_PC     = { AU: 4.848e-6, ls: 9.716e-9, lm: 5.830e-7, lh: 3.498e-5, ld: 8.395e-4 };
        const speedPcPerSec = speedVal * (UNIT_PC[unit] ?? UNIT_PC.AU);
        const dir = fwd ? 1 : -1;

        const lookDir = new THREE.Vector3();
        this.ptz.camera.getWorldDirection(lookDir);
        this.ptz.camera.position.addScaledVector(lookDir, dir * speedPcPerSec * dt);

        // Don't let camera go behind Sol
        if (this.ptz.camera.position.length() < 0.001) {
          this.ptz.camera.position.set(0, 0, 0.001);
        }
      }

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
      <div class="pd-title">star rendering</div>
      <div class="dev-row">
        <span class="dev-label">bleed factor</span>
        <input type="range" id="dev-bleed" min="0" max="1" step="0.01" value="0.38" />
        <span class="dev-val" id="dev-bleed-val">0.38</span>
      </div>
      <div class="dev-row">
        <span class="dev-label">ref mag</span>
        <input type="range" id="dev-ref-mag" min="-2" max="8" step="0.1" value="4.8" />
        <span class="dev-val" id="dev-ref-mag-val">4.8</span>
      </div>
      <div class="dev-row">
        <span class="dev-label">dim bias</span>
        <input type="range" id="dev-dim-bias" min="0" max="2" step="0.05" value="0.40" />
        <span class="dev-val" id="dev-dim-bias-val">0.40</span>
      </div>
      <div class="dev-row">
        <span class="dev-label">size min</span>
        <input type="range" id="dev-size-min" min="0.1" max="5" step="0.1" value="1.7" />
        <span class="dev-val" id="dev-size-min-val">1.7 px</span>
      </div>
      <div class="dev-row">
        <span class="dev-label">zoom scale</span>
        <input type="range" id="dev-zoom" min="0" max="4" step="0.05" value="1.49" />
        <span class="dev-val" id="dev-zoom-val">1.49</span>
      </div>
      <div class="dev-row">
        <span class="dev-label">pan tighten</span>
        <input type="range" id="dev-pan-scale" min="0" max="3" step="0.05" value="1.0" />
        <span class="dev-val" id="dev-pan-scale-val">1.00</span>
      </div>
      <div class="dev-row">
        <span class="dev-label">min bright</span>
        <input type="range" id="dev-min-bright" min="0" max="0.5" step="0.005" value="0.165" />
        <span class="dev-val" id="dev-min-bright-val">0.165</span>
      </div>
      <div class="dev-row">
        <span class="dev-label">exp bright comp</span>
        <input type="range" id="dev-exp-bright-comp" min="0" max="3" step="0.05" value="0.00" />
        <span class="dev-val" id="dev-exp-bright-comp-val">0.00</span>
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

    wire('dev-bleed',            'dev-bleed-val',            v => v.toFixed(2), v => this.starField.setBleedFactor(v));
    wire('dev-ref-mag',          'dev-ref-mag-val',          v => v.toFixed(1), v => this.starField.setRefMag(v));
    wire('dev-dim-bias',         'dev-dim-bias-val',         v => v.toFixed(2), v => this.starField.setDimBias(v));
    wire('dev-size-min',         'dev-size-min-val',         v => v.toFixed(1) + ' px', v => this.starField.setSizeMin(v));
    wire('dev-zoom',             'dev-zoom-val',             v => v.toFixed(2), v => this.starField.setZoomScale(v));
    wire('dev-pan-scale',        'dev-pan-scale-val',        v => v.toFixed(2), v => this.ptz.setPanScale(v));
    wire('dev-min-bright',       'dev-min-bright-val',       v => v.toFixed(3), v => this.starField.setMinBrightness(v));
    wire('dev-exp-bright-comp',  'dev-exp-bright-comp-val',  v => v.toFixed(2), v => this.starField.setExpBrightCompression(v));
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

  _toggleParallax() {
    this._parallaxActive = !this._parallaxActive;
    if (this._parallaxActive) {
      // Record starting position so distance bar shows displacement, not absolute position
      this._parallaxOrigin = this.ptz.camera.position.clone();
    } else {
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
    this.ptz.camera.position.set(0, 0, 0.001);
    this.ptz?.destroy();
    if (this._constellationLines) {
      this.scene.remove(this._constellationLines);
    }
  }
}
