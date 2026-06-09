# Skyspace — Functional Specification

Interactive stellar cartography app. A 3D view of real star positions (Hipparcos catalog, heliocentric Cartesian J2000) rendered with Three.js, navigable from the observer's perspective.

---

## Views

### Landing (`VIEWS.LANDING`)

Full-screen entry screen. Animated 2D canvas particle field (twinkling stars). Wordmark "Skyspace" + subtitle "interactive stellar cartography" + "Explore" button. Clicking Explore fades out (0.8s opacity transition) and navigates to Sky Map. No chrome (NavDock, SelectionBar) is mounted until after leaving Landing.

### Sky Map (`VIEWS.SKYMAP`)

The primary atlas view. Camera is locked at the heliocentric origin (0,0,0.001); the user rotates the view to look at any direction on the celestial sphere.

**Camera controls:**
- Mouse drag — pan (azimuth) and tilt (altitude)
- Scroll wheel — zoom via FOV (10°–120°, default 70°)
- Touch drag — single-finger pan/tilt
- Altitude clamped to ±89.9° (prevents gimbal flip)

**Star interaction:**
- Click a star — clears selection, selects that star as primary
- Shift+click — toggles the star in/out of the multi-selection set
- Click empty space (no Shift) — clears selection

**Rendering:**
- All stars always present in the `THREE.Points` geometry; visibility is shader-driven (magnitude/distance filter uniforms)
- Selected stars: blue tint (`aSelected = 1`); primary: gold tint (`aSelected = 2`); unselected when anything is selected: dimmed to 35% visibility
- Atmospheric scattering: screenspace Rayleigh shader dims and reddens stars near the horizon; strength tracks actual horizon position via `PTZCamera.horizonNDC`
- Bloom applied to all bright stars

**Toolbar HUD (top bar):**
- Left: observer position pill (lat/lon), UTC time pill, "parallax" dropdown toggle
- Right: "grid" button (RA/Dec grid toggle), "const." button (constellation lines toggle), "filter" button (magnitude/distance filter panel toggle)

**Parallax dropdown:**
- Speed slider (0–100), range slider (0–100)
- Unit selector: AU / ls / lm / lh / ld
- Controls a future camera fly-along-rail animation from Sol

**Constellation lines:**
- `THREE.Group` added to scene on mount, removed on unmount
- Currently a structural placeholder; real IAU constellation line data not yet wired

### Star Map (`VIEWS.STARMAP`) — not yet implemented

Planned: 3D star neighborhood view recentered on a chosen origin star (or Sol). Shows spatial relationships and distances between selected stars. Origin is set via `viewState.setOrigin(starIndex)`.

### Star Detail (`VIEWS.STARDETAIL`) — not yet implemented

Planned: full data panel for the primary selected star. Stellar properties from catalog, contextual information.

---

## Persistent UI (mounted once, persists across non-landing views)

### NavDock

Bottom-left horizontal icon dock. Three navigation items: Sky Map, Star Map, Star Detail. Icons only at rest; labels slide in on hover (CSS transition via `.expanded` class). Active view highlighted in accent blue. Clicking navigates via `viewState.goto()`.

### SelectionBar

Bottom-right panel. Shows the current selection:
- When empty: "click a star to select" hint
- When populated: count header + list of selected stars (name or HIP ID, distance in ly)
- Primary star shown in gold; secondary selected stars in blue
- Action buttons: "detail" (→ StarDetail), "map" (→ StarMap), "clear"

---

## State model

### SelectionState

- `primary`: single star index or null — drives the detail panel and gold highlight
- `selected`: `Set<index>` — drives route display in StarMap and multi-highlight
- `select(i)` — adds to set, sets as primary
- `toggle(i)` — adds or removes
- `deselect(i)` — removes; promotes last remaining to primary
- `clear()` — resets everything

### ViewState

- `current`: one of `VIEWS.*`
- `origin`: star index used as the reference point in StarMap (null = Sol)
- `goto(view)` fires `onchange` listeners

### ObserverState

- `lat`, `lon` in degrees; default Kennedy Space Center (28.5°N, 80.6°W)
- `date`: JavaScript `Date`, used for sidereal time computation
- `localSiderealTime`: GMST formula accurate to ~0.1s, returns radians
- `zenithVector`: observer's zenith in heliocentric Cartesian (J2000 approx) — used to compute the horizon plane for future horizon masking

---

## Catalog / data format

Source: Hipparcos catalog via VizieR API (`I/239/hip_main`), filtered to Vmag < 8.0, parallax > 0, distance < 2000 pc.

Binary format `stars.bin`: 48 bytes per star, little-endian. Fields: `[x, y, z, r, g, b, vmag, distLy, hipId, nameIdx, pad, pad]`. All floats are float32 except hipId (uint32) and nameIdx (int32, −1 = unnamed).

`star-names.json`: flat array of name strings. `nameIdx` in the binary is an index into this array.

Star colors are derived from spectral class (first character): O=blue-white, B=blue-white, A=white, F=yellow-white, G=yellow, K=orange, M=red-orange.

The dev build script (`build-catalog-dev.js`) forces synthetic generation (skips VizieR fetch). The production script (`build-catalog.js`) falls back to synthetic if fetch fails. The current committed `stars.bin` contains 4812 synthetic stars.

---

## Rendering pipeline

```
WebGLRenderer
  └─ EffectComposer
       ├─ RenderPass          (scene + active camera)
       ├─ ShaderPass (Rayleigh) — screenspace atmospheric scattering
       ├─ UnrealBloomPass     (strength 0.4, radius 0.3, threshold 0.85)
       └─ OutputPass          (ACESFilmic tone mapping)
```

The Rayleigh shader models wavelength-dependent scattering: optical depth increases as a cubic toward the horizon. Blue wavelengths scatter most (λ⁻⁴). Stars near the horizon shift red and dim. The `uHorizonY` uniform (0–1 NDC) is updated every frame from `PTZCamera.horizonNDC`.

---

## Planned features (in-progress / not started)

- **RA/Dec grid** — toggle in toolbar, not yet rendered
- **Constellation lines** — toggle in toolbar; `THREE.Group` exists in scene but geometry not loaded
- **Filter panel** — magnitude and distance sliders, connected to `StarField.setFilter()`
- **Parallax rail** — camera animation that moves along a track from Sol, revealing stellar parallax shifts
- **StarMap view** — 3D neighborhood graph, possibly with TWEEN.js camera transitions
- **StarDetail view** — stellar data panel
- **Observer settings** — UI to change lat/lon/date
- **Real Hipparcos catalog** — currently using synthetic data; production build connects to VizieR
