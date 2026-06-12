/**
 * SceneManager
 * Owns the Three.js renderer, scene, and EffectComposer.
 * Views register their camera and update hooks here.
 */

import * as THREE from 'three';

// Post-processing via three/examples
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

// Rayleigh scattering screenspace shader
const RayleighShader = {
  uniforms: {
    tDiffuse:     { value: null },
    uHorizonY:    { value: 0.5 },   // horizon in NDC y (0-1)
    uStrength:    { value: 0.6 },   // overall scattering strength
    uEnabled:     { value: 1.0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uHorizonY;
    uniform float uStrength;
    uniform float uEnabled;
    varying vec2 vUv;

    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      if (uEnabled < 0.5) { gl_FragColor = color; return; }

      // Altitude above horizon (0 at horizon, 1 at zenith)
      float altitude = clamp((vUv.y - uHorizonY) / (1.0 - uHorizonY), 0.0, 1.0);

      // Optical depth increases toward horizon (air mass ~ 1/cos(zenith_angle))
      float opticalDepth = pow(1.0 - altitude, 3.0) * uStrength;

      // Wavelength-dependent scattering: blue scatters most
      vec3 scatter = vec3(
        opticalDepth * 0.35,   // R — least scattering
        opticalDepth * 0.55,   // G
        opticalDepth * 0.85    // B — most scattering (Rayleigh λ^-4)
      );

      // Stars near horizon shift red and dim
      vec3 scattered = color.rgb;
      scattered.r *= 1.0 + scatter.b * 0.3;   // reddening
      scattered.gb *= 1.0 - scatter.gb * 0.4; // desaturate blue/green
      scattered *= 1.0 - opticalDepth * 0.5;  // extinction

      gl_FragColor = vec4(mix(color.rgb, scattered, opticalDepth), color.a);
    }
  `,
};

export class SceneManager {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, this._aspect(), 0.001, 50000);
    this.camera.position.set(0, 0, 0.001);

    this._initRenderer();
    this._initComposer();
    this._initResize();

    this._updateCallbacks = [];
    this._running = false;
  }

  _aspect() {
    return this.container.clientWidth / this.container.clientHeight;
  }

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.container.appendChild(this.renderer.domElement);
  }

  _initComposer() {
    const size = new THREE.Vector2(this.container.clientWidth, this.container.clientHeight);

    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    // Rayleigh scattering (pass 2 — before bloom)
    this.rayleighPass = new ShaderPass(RayleighShader);
    this.composer.addPass(this.rayleighPass);

    // Bloom (pass 3)
    this.bloomPass = new UnrealBloomPass(size, 0.34, 0.10, 0.85);
    this.composer.addPass(this.bloomPass);

    // Output / tone mapping (pass 4)
    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);
  }

  _initResize() {
    this._resizeObserver = new ResizeObserver(() => this._onResize());
    this._resizeObserver.observe(this.container);
  }

  _onResize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  }

  setCamera(camera) {
    this.camera = camera;
    this.renderPass.camera = camera;
  }

  setRayleigh(enabled, horizonY = 0.5, strength = 0.6) {
    this.rayleighPass.uniforms.uEnabled.value = enabled ? 1.0 : 0.0;
    this.rayleighPass.uniforms.uHorizonY.value = horizonY;
    this.rayleighPass.uniforms.uStrength.value = strength;
  }

  /** Enable/disable the bloom pass (kept in the pipeline; only some views use it). */
  setBloom(enabled, strength) {
    this.bloomPass.enabled = enabled;
    if (strength !== undefined) this.bloomPass.strength = strength;
  }

  onUpdate(fn) {
    this._updateCallbacks.push(fn);
    return () => { this._updateCallbacks = this._updateCallbacks.filter(f => f !== fn); };
  }

  /** Register a callback fired AFTER composer.render() each frame */
  onPostRender(fn) {
    this._postRenderCallbacks = this._postRenderCallbacks || [];
    this._postRenderCallbacks.push(fn);
    return () => {
      this._postRenderCallbacks = (this._postRenderCallbacks || []).filter(f => f !== fn);
    };
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._clock = new THREE.Clock();
    this._loop();
  }

  _loop() {
    if (!this._running) return;
    requestAnimationFrame(() => this._loop());
    const t = this._clock.getElapsedTime();
    this._updateCallbacks.forEach(fn => fn(t));
    this.composer.render();
    if (this._postRenderCallbacks?.length) {
      this._postRenderCallbacks.forEach(fn => fn(t));
    }
  }

  stop() {
    this._running = false;
  }

  dispose() {
    this.stop();
    this._resizeObserver.disconnect();
    this.renderer.dispose();
  }
}
