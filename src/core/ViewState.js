/**
 * ViewState
 * Manages which view is active and drives transitions.
 * Views: 'landing' | 'skymap' | 'starmap' | 'stardetail'
 */

export const VIEWS = {
  LANDING:    'landing',
  SKYMAP:     'skymap',
  STARMAP:    'starmap',
  STARDETAIL: 'stardetail',
};

export class ViewState {
  constructor() {
    this._current = VIEWS.LANDING;
    this._listeners = [];
    this._origin = null; // star index used as reference origin in starmap (null = Sol)
  }

  onchange(fn) {
    this._listeners.push(fn);
    return () => { this._listeners = this._listeners.filter(l => l !== fn); };
  }

  _emit(prev) {
    this._listeners.forEach(fn => fn({ current: this._current, prev }));
  }

  goto(view) {
    if (view === this._current) return;
    const prev = this._current;
    this._current = view;
    this._emit(prev);
  }

  get current() { return this._current; }

  setOrigin(starIndex) {
    this._origin = starIndex;
  }

  get origin() { return this._origin; }
}
