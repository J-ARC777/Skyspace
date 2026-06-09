/**
 * ObserverState
 * Stores observer position (lat/lon) and time.
 * Computes Local Sidereal Time for RA/Dec alignment and horizon plane.
 */

const DEG = Math.PI / 180;

export class ObserverState {
  constructor() {
    this.lat = 28.5;   // degrees N
    this.lon = -80.6;  // degrees E (negative = West)
    this.date = new Date();
    this._listeners = [];
  }

  onchange(fn) {
    this._listeners.push(fn);
    return () => { this._listeners = this._listeners.filter(l => l !== fn); };
  }

  _emit() {
    this._listeners.forEach(fn => fn(this));
  }

  setPosition(lat, lon) {
    this.lat = Math.max(-90, Math.min(90, lat));
    this.lon = lon;
    this._emit();
  }

  setDate(date) {
    this.date = date;
    this._emit();
  }

  /**
   * Returns the zenith unit vector in heliocentric Cartesian (J2000 approx).
   * This is the normal to the observer's horizon plane.
   */
  get zenithVector() {
    const lst = this.localSiderealTime; // radians
    const latRad = this.lat * DEG;
    return {
      x: Math.cos(latRad) * Math.cos(lst),
      y: Math.cos(latRad) * Math.sin(lst),
      z: Math.sin(latRad),
    };
  }

  /**
   * Local Sidereal Time in radians.
   * Approximate formula accurate to ~0.1s.
   */
  get localSiderealTime() {
    const jd = this._julianDate(this.date);
    const T = (jd - 2451545.0) / 36525.0;
    // Greenwich Mean Sidereal Time in degrees
    let gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0)
             + 0.000387933 * T * T - T * T * T / 38710000;
    gmst = ((gmst % 360) + 360) % 360;
    const lst = gmst + this.lon;
    return ((lst % 360) + 360) % 360 * DEG;
  }

  get utcString() {
    return this.date.toISOString().substring(11, 16) + ' UTC';
  }

  get posString() {
    const latStr = Math.abs(this.lat).toFixed(1) + '°' + (this.lat >= 0 ? 'N' : 'S');
    const lonStr = Math.abs(this.lon).toFixed(1) + '°' + (this.lon >= 0 ? 'E' : 'W');
    return `${latStr} · ${lonStr}`;
  }

  _julianDate(date) {
    return date.getTime() / 86400000 + 2440587.5;
  }
}
