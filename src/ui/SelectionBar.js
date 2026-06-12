/**
 * SelectionBar
 * Bottom-right persistent panel showing primary star and selection list.
 */

export class SelectionBar {
  constructor(container, selectionState, catalogLoader, viewState) {
    this.container = container;
    this.selection = selectionState;
    this.catalog = catalogLoader;
    this.viewState = viewState;
    this.el = null;
    this._mount();

    selectionState.onchange(() => this._render());
  }

  _mount() {
    this.el = document.createElement('div');
    this.el.className = 'sel-bar panel';
    this._injectStyles();
    this.container.appendChild(this.el);
    this._render();

    this.el.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'clear') this.selection.clear();
      if (action === 'starmap') this.viewState.goto('starmap');
      if (action === 'stardetail') this.viewState.goto('stardetail');
      if (action === 'deselect') {
        const idx = parseInt(e.target.closest('[data-action]').dataset.idx);
        this.selection.deselect(idx);
      }
    });
  }

  _injectStyles() {
    if (document.getElementById('sel-bar-style')) return;
    const s = document.createElement('style');
    s.id = 'sel-bar-style';
    s.textContent = `
      .sel-bar {
        position: absolute;
        bottom: 14px;
        right: 14px;
        min-width: 148px;
        max-width: 210px;
        padding: 10px 12px;
        z-index: 100;
        font-family: var(--font-ui);
      }
      .sel-bar-empty { color: var(--c-text-dim); font-size: 11px; }
      .sel-star-row {
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 2px 0;
      }
      .sel-dot {
        border-radius: 50%;
        flex-shrink: 0;
      }
      .sel-star-name { font-size: 11px; color: var(--c-select); flex: 1; }
      .sel-star-name.primary { color: var(--c-gold); font-weight: 700; }
      .sel-star-dist { font-size: 10px; color: var(--c-text-dim); }
      .sel-actions { display: flex; gap: 5px; margin-top: 8px; flex-wrap: wrap; }
      .sel-header {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin-bottom: 6px;
      }
      .sel-count { font-size: 10px; color: var(--c-text-dim); }
      .sel-clear { font-size: 10px; color: var(--c-text-dim); cursor: pointer; }
      .sel-clear:hover { color: var(--c-text-muted); }
    `;
    document.head.appendChild(s);
  }

  _starLabel(idx) {
    const name = this.catalog.getStarName(idx);
    const dist = this.catalog.distances[idx];
    return { name: name || `HIP ${this.catalog.hipIds[idx]}`, dist };
  }

  _render() {
    const { primary, selected, count } = this.selection;

    if (count === 0) {
      this.el.innerHTML = `<div class="sel-bar-empty">click a star to select</div>`;
      return;
    }

    const selectedArr = [...selected];
    const rows = selectedArr.map(idx => {
      const { name, dist } = this._starLabel(idx);
      const isPrimary = idx === primary;
      const distStr = dist > 0 ? (dist < 10 ? dist.toFixed(2) : Math.round(dist)) + ' ly' : '—';

      // Spectral color from catalog (0–1 floats → CSS rgb)
      const r = Math.round(this.catalog.colors[idx * 3]     * 255);
      const g = Math.round(this.catalog.colors[idx * 3 + 1] * 255);
      const b = Math.round(this.catalog.colors[idx * 3 + 2] * 255);
      const dotColor = `rgb(${r},${g},${b})`;

      // Dot size: magnitude 0 → 9px, magnitude 6 → 4px
      const mag = this.catalog.magnitudes[idx];
      const dotSize = Math.max(4, Math.round(9 - mag * 0.8)) + 'px';

      return `
        <div class="sel-star-row">
          <div class="sel-dot" style="width:${dotSize};height:${dotSize};background:${dotColor}"></div>
          <span class="sel-star-name ${isPrimary ? 'primary' : ''}">${name}</span>
          <span class="sel-star-dist">${distStr}</span>
        </div>
      `;
    }).join('');

    const actions = [];
    if (count >= 1) actions.push(`<button class="hud-btn" data-action="stardetail">detail</button>`);
    if (count >= 1) actions.push(`<button class="hud-btn" data-action="starmap">map</button>`);
    actions.push(`<button class="hud-btn" data-action="clear">clear</button>`);

    this.el.innerHTML = `
      <div class="sel-header">
        <span class="sel-count">${count} selected</span>
        <span class="sel-clear" data-action="clear">clear</span>
      </div>
      ${rows}
      <div class="sel-actions">${actions.join('')}</div>
    `;
  }
}
