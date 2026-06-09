/**
 * NavDock
 * Horizontal dock bottom-left. Icons only at rest, labels appear on hover.
 */

import { VIEWS } from '../core/ViewState.js';

const ICONS = {
  [VIEWS.SKYMAP]: {
    label: 'sky map',
    svg: `<svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.4"/>
      <circle cx="11" cy="11" r="2.8" fill="currentColor"/>
    </svg>`,
  },
  [VIEWS.STARMAP]: {
    label: 'star map',
    svg: `<svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <circle cx="11" cy="11" r="2" fill="currentColor"/>
      <circle cx="4"  cy="7"  r="1.3" fill="currentColor" opacity="0.7"/>
      <circle cx="18" cy="6"  r="1.3" fill="currentColor" opacity="0.7"/>
      <circle cx="6"  cy="16" r="1.3" fill="currentColor" opacity="0.7"/>
      <circle cx="17" cy="15" r="1.3" fill="currentColor" opacity="0.7"/>
    </svg>`,
  },
  [VIEWS.STARDETAIL]: {
    label: 'star detail',
    svg: `<svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.2"/>
      <circle cx="11" cy="11" r="3" fill="currentColor" opacity="0.7"/>
      <line x1="11" y1="2" x2="11" y2="4"   stroke="currentColor" stroke-width="1.3"/>
      <line x1="11" y1="18" x2="11" y2="20" stroke="currentColor" stroke-width="1.3"/>
      <line x1="2"  y1="11" x2="4"  y2="11" stroke="currentColor" stroke-width="1.3"/>
      <line x1="18" y1="11" x2="20" y2="11" stroke="currentColor" stroke-width="1.3"/>
    </svg>`,
  },
};

const ORDER = [VIEWS.SKYMAP, VIEWS.STARMAP, VIEWS.STARDETAIL];

export class NavDock {
  constructor(container, viewState) {
    this.container = container;
    this.viewState = viewState;
    this.el = null;
    this._hovered = false;
    this._mount();

    viewState.onchange(() => this._render());
  }

  _mount() {
    this.el = document.createElement('div');
    this.el.className = 'nav-dock';
    this.el.innerHTML = this._html();
    this._applyStyles();
    this.container.appendChild(this.el);

    this.el.addEventListener('mouseenter', () => { this._hovered = true;  this._render(); });
    this.el.addEventListener('mouseleave', () => { this._hovered = false; this._render(); });
    this.el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-view]');
      if (btn) this.viewState.goto(btn.dataset.view);
    });
  }

  _applyStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .nav-dock {
        position: absolute;
        bottom: 14px;
        left: 14px;
        background: linear-gradient(158deg, rgba(13,14,20,0.94) 0%, rgba(8,9,15,0.97) 100%);
        border: 0.5px solid rgba(150,158,190,0.13);
        border-radius: 12px;
        padding: 8px 10px;
        display: inline-flex;
        align-items: center;
        gap: 2px;
        backdrop-filter: blur(18px);
        -webkit-backdrop-filter: blur(18px);
        box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 6px 28px rgba(0,0,0,0.50);
        z-index: 100;
        transition: padding 0.18s ease;
      }
      .nav-dock-divider {
        width: 0.5px;
        background: rgba(150,158,190,0.10);
        margin: 0 3px;
        border-radius: 1px;
        transition: height 0.18s ease;
      }
      .nav-dock-item {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        padding: 6px 10px;
        border-radius: 7px;
        cursor: pointer;
        transition: background 0.15s ease, color 0.15s ease;
        color: rgba(175,178,190,0.42);
        user-select: none;
      }
      .nav-dock-item:hover {
        background: rgba(180,182,192,0.07);
        color: rgba(210,212,220,0.74);
      }
      .nav-dock-item.active {
        background: linear-gradient(135deg, rgba(24,32,80,0.55) 0%, rgba(60,20,100,0.40) 100%);
        border: 0.5px solid rgba(130,110,200,0.38);
        color: rgba(210,215,235,0.92);
        box-shadow: 0 0 10px rgba(80,60,180,0.14), 0 1px 0 rgba(255,255,255,0.05) inset;
      }
      .nav-dock-label {
        font-size: 9px;
        font-family: var(--font-ui);
        letter-spacing: 0.04em;
        white-space: nowrap;
        opacity: 0;
        height: 0;
        overflow: hidden;
        transition: opacity 0.15s ease, height 0.15s ease;
      }
      .nav-dock.expanded .nav-dock-label {
        opacity: 1;
        height: 13px;
      }
      .nav-dock.expanded .nav-dock-divider {
        height: 50px;
      }
      .nav-dock:not(.expanded) .nav-dock-divider {
        height: 28px;
      }
    `;
    document.head.appendChild(style);
  }

  _html() {
    const current = this.viewState.current;
    return ORDER.map((view, i) => {
      const { label, svg } = ICONS[view];
      const active = current === view;
      const divider = i < ORDER.length - 1
        ? `<div class="nav-dock-divider"></div>`
        : '';
      return `
        <div class="nav-dock-item ${active ? 'active' : ''}" data-view="${view}">
          ${svg}
          <span class="nav-dock-label">${label}</span>
        </div>
        ${divider}
      `;
    }).join('');
  }

  _render() {
    this.el.innerHTML = this._html();
    if (this._hovered) {
      this.el.classList.add('expanded');
    } else {
      this.el.classList.remove('expanded');
    }
    // Re-attach hover (innerHTML clobbers listeners on children but el listener persists)
  }
}
