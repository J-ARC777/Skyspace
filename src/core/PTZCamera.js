/**
 * PTZCamera
 * Camera locked at the heliocentric origin, rotates to look at any point
 * on the celestial sphere. Mouse drag = pan/tilt. Scroll = zoom (FOV).
 */

import * as THREE from 'three';

const DEG = Math.PI / 180;

export class PTZCamera {
  constructor(domElement) {
    this.domElement = domElement;
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.001, 50000);
    this.camera.position.set(0, 0, 0.001); // at origin

    this._az  = 0;      // azimuth (radians, 0 = North)
    this._alt = 0;      // altitude (radians, 0 = horizon)
    this._fov = 70;     // degrees

    this._fovListeners = [];
    this._dragging = false;
    this._lastX = 0;
    this._lastY = 0;
    this._panScale = 1.0;

    this._bindEvents();
    this._applyRotation();
  }

  _bindEvents() {
    const el = this.domElement;
    el.addEventListener('mousedown', this._onDown.bind(this));
    el.addEventListener('mousemove', this._onMove.bind(this));
    el.addEventListener('mouseup',   this._onUp.bind(this));
    el.addEventListener('mouseleave', this._onUp.bind(this));
    el.addEventListener('wheel',     this._onWheel.bind(this), { passive: false });
    el.addEventListener('touchstart', this._onTouchStart.bind(this), { passive: false });
    el.addEventListener('touchmove',  this._onTouchMove.bind(this),  { passive: false });
    el.addEventListener('touchend',   this._onUp.bind(this));
  }

  _onDown(e) {
    if (e.target.closest('.panel, .nav-dock, .sel-bar, .skymap-toolbar, .const-label, .const-modal, input, button')) return;
    this._dragging = true;
    this._lastX = e.clientX;
    this._lastY = e.clientY;
  }

  _onMove(e) {
    if (!this._dragging) return;
    const dx = e.clientX - this._lastX;
    const dy = e.clientY - this._lastY;
    this._lastX = e.clientX;
    this._lastY = e.clientY;
    this._pan(dx, dy);
  }

  _onUp() { this._dragging = false; }

  _onWheel(e) {
    e.preventDefault();
    this._fov = Math.max(0.5, Math.min(90, this._fov * Math.pow(1.001, e.deltaY)));
    this.camera.fov = this._fov;
    this.camera.updateProjectionMatrix();
    this._fovListeners.forEach(fn => fn(this._fov));
  }

  onFovChange(fn) {
    this._fovListeners.push(fn);
    return () => { this._fovListeners = this._fovListeners.filter(f => f !== fn); };
  }

  _onTouchStart(e) {
    if (e.touches.length === 1) {
      this._dragging = true;
      this._lastX = e.touches[0].clientX;
      this._lastY = e.touches[0].clientY;
    }
  }

  _onTouchMove(e) {
    e.preventDefault();
    if (!this._dragging || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - this._lastX;
    const dy = e.touches[0].clientY - this._lastY;
    this._lastX = e.touches[0].clientX;
    this._lastY = e.touches[0].clientY;
    this._pan(dx, dy);
  }

  _pan(dx, dy) {
    // Linear FOV scaling keeps angular degrees-per-pixel constant at any zoom level.
    // panScale adds a gentle extra tightening above 1.0 for personal preference.
    const sensitivity = Math.pow(this._fov / 70, 1.0 + this._panScale * 0.3) * 0.003;
    this._az  -= dx * sensitivity;
    this._alt  = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01,
                          this._alt - dy * sensitivity));
    this._applyRotation();
  }

  setPanScale(v) { this._panScale = v; }

  _applyRotation() {
    // Convert az/alt to a look-at direction
    const x = Math.cos(this._alt) * Math.sin(this._az);
    const y = Math.sin(this._alt);
    const z = Math.cos(this._alt) * Math.cos(this._az);
    const target = new THREE.Vector3(x, y, z).multiplyScalar(100);
    this.camera.lookAt(target);
  }

  setAspect(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Returns horizon Y in normalized device coords (0-1) for Rayleigh shader.
   * Based on current alt angle vs FOV.
   */
  get horizonNDC() {
    const halfFovRad = (this._fov / 2) * DEG;
    // Fraction of screen height below centre that corresponds to alt=0
    const horizonFrac = -Math.tan(this._alt) / Math.tan(halfFovRad);
    return 0.5 + horizonFrac * 0.5;
  }

  lookAt(azDeg, altDeg) {
    this._az  = azDeg  * DEG;
    this._alt = altDeg * DEG;
    this._applyRotation();
  }

  destroy() {
    const el = this.domElement;
    el.removeEventListener('mousedown', this._onDown);
    el.removeEventListener('mousemove', this._onMove);
    el.removeEventListener('mouseup',   this._onUp);
    el.removeEventListener('mouseleave', this._onUp);
    el.removeEventListener('wheel',     this._onWheel);
  }
}
