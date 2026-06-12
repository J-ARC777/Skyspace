/**
 * LandingView
 * Full-screen entry with animated star particles and Explore button.
 */

import { VIEWS } from '../core/ViewState.js';

export class LandingView {
  constructor(container, viewState) {
    this.container = container;
    this.viewState = viewState;
    this.el = null;
    this._canvas = null;
    this._ctx = null;
    this._stars = [];
    this._raf = null;
  }

  mount() {
    this.el = document.createElement('div');
    this.el.className = 'landing-view';
    this.el.innerHTML = `
      <canvas class="landing-canvas"></canvas>
      <div class="landing-content">
        <div class="landing-wordmark">Skyspace</div>
        <div class="landing-sub">interactive stellar cartography</div>
        <button class="landing-explore">Explore</button>
      </div>
    `;
    this._injectStyles();
    this.container.appendChild(this.el);

    this._canvas = this.el.querySelector('.landing-canvas');
    this._ctx = this._canvas.getContext('2d');
    this._resize();
    this._initStars();
    this._loop();

    window.addEventListener('resize', () => this._resize());
    this.el.querySelector('.landing-explore').addEventListener('click', () => {
      this._fadeOut(() => this.viewState.goto(VIEWS.SKYMAP));
    });
  }

  _injectStyles() {
    if (document.getElementById('landing-style')) return;
    const s = document.createElement('style');
    s.id = 'landing-style';
    s.textContent = `
      .landing-view {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 200;
        background: radial-gradient(ellipse at 50% 40%, #0d0e15 0%, #08090e 60%, #050609 100%);
        transition: opacity 0.8s ease;
      }
      .landing-canvas {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
      }
      .landing-content {
        position: relative;
        z-index: 2;
        text-align: center;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
      }
      .landing-wordmark {
        font-family: var(--font-header);
        font-size: clamp(36px, 6vw, 70px);
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        background: var(--gradient-accent-light);
        -webkit-background-clip: text;
        background-clip: text;
        -webkit-text-fill-color: transparent;
        color: transparent;
        filter: saturate(1.05) brightness(1.08);
      }
      .landing-sub {
        font-family: var(--font-mono);
        font-size: 11px;
        letter-spacing: 0.22em;
        color: var(--c-text-dim);
        text-transform: uppercase;
        margin-bottom: 26px;
      }
      .landing-explore {
        font-family: var(--font-mono);
        font-weight: 700;
        font-size: 12px;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: var(--c-text);
        background: rgba(255,255,255,0.03);
        border: 1px solid var(--c-accent-border);
        border-radius: var(--radius-sm);
        padding: 11px 38px;
        cursor: pointer;
        transition: background 0.2s, border-color 0.2s, color 0.2s, box-shadow 0.2s;
      }
      .landing-explore:hover {
        background: var(--c-accent-dim);
        border-color: var(--c-accent);
        color: #fff;
        box-shadow: 0 0 18px rgba(80, 96, 232, 0.28);
      }
    `;
    document.head.appendChild(s);
  }

  _resize() {
    if (!this._canvas) return;
    this._canvas.width  = this.container.clientWidth;
    this._canvas.height = this.container.clientHeight;
    this._initStars();
  }

  _initStars() {
    const w = this._canvas.width;
    const h = this._canvas.height;
    this._stars = Array.from({ length: 280 }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() * 1.2 + 0.2,
      alpha: Math.random() * 0.6 + 0.2,
      twinkle: Math.random() * Math.PI * 2,
      speed: Math.random() * 0.02 + 0.005,
    }));
  }

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop());
    const ctx = this._ctx;
    const w = this._canvas.width;
    const h = this._canvas.height;
    ctx.clearRect(0, 0, w, h);

    for (const s of this._stars) {
      s.twinkle += s.speed;
      const a = s.alpha * (0.7 + 0.3 * Math.sin(s.twinkle));
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(200,215,255,${a.toFixed(3)})`;
      ctx.fill();
    }
  }

  _fadeOut(cb) {
    this.el.style.opacity = '0';
    setTimeout(() => {
      cb();
      this.unmount();
    }, 800);
  }

  unmount() {
    cancelAnimationFrame(this._raf);
    this.el?.remove();
    this.el = null;
  }
}
