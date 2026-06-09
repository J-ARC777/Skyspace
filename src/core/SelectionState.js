/**
 * SelectionState
 * Single source of truth for star selection across all views.
 * Primary = most recently selected (drives star detail panel).
 * Selected set = all selected stars (drives route in star map).
 */

export class SelectionState {
  constructor() {
    this._primary = null;      // star index | null
    this._selected = new Set(); // Set of star indices
    this._listeners = [];
  }

  onchange(fn) {
    this._listeners.push(fn);
    return () => { this._listeners = this._listeners.filter(l => l !== fn); };
  }

  _emit() {
    this._listeners.forEach(fn => fn({
      primary: this._primary,
      selected: new Set(this._selected),
    }));
  }

  select(index) {
    this._primary = index;
    this._selected.add(index);
    this._emit();
  }

  deselect(index) {
    this._selected.delete(index);
    if (this._primary === index) {
      // Move primary to most recently added remaining star
      const remaining = [...this._selected];
      this._primary = remaining.length > 0 ? remaining[remaining.length - 1] : null;
    }
    this._emit();
  }

  toggle(index) {
    if (this._selected.has(index)) {
      this.deselect(index);
    } else {
      this.select(index);
    }
  }

  setPrimary(index) {
    this._primary = index;
    this._selected.add(index);
    this._emit();
  }

  clear() {
    this._primary = null;
    this._selected.clear();
    this._emit();
  }

  get primary() { return this._primary; }
  get selected() { return new Set(this._selected); }
  get count() { return this._selected.size; }
  has(index) { return this._selected.has(index); }
}
