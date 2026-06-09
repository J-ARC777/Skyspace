# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start Vite dev server (localhost:5173)
npm run build        # Production build → dist/
npm run preview      # Preview the production build

node scripts/build-catalog.js      # Rebuild stars.bin from Hipparcos/VizieR (requires internet)
node scripts/build-catalog-dev.js  # Rebuild stars.bin using synthetic data only (offline)
```

There is no test suite. No linter is configured.

The catalog scripts write to `public/data/` — `stars.bin`, `star-names.json`, and `catalog-meta.json`. The dev script forces synthetic data. The production script falls back to synthetic if the VizieR fetch fails.

## Architecture

Skyspace is a vanilla ES-module app (no framework). Vite is the only build tool. Everything is orchestrated from `src/main.js`'s `boot()` function.

### State layer (`src/core/`)

Three singleton state objects are created in `boot()` and passed down:

| Class | Purpose |
|---|---|
| `ViewState` | Which view is active (`landing` / `skymap` / `starmap` / `stardetail`). Holds optional `origin` star index for the star-map view. |
| `SelectionState` | Multi-star selection set + a single `primary` index (the most recently selected, used for the detail panel). |
| `ObserverState` | Observer lat/lon and date. Computes Local Sidereal Time and zenith vector for horizon-plane math. |

All three follow the same pattern: `onchange(fn)` registers a listener and returns an unsubscribe function.

### Rendering layer (`src/core/`)

**`SceneManager`** owns the Three.js `WebGLRenderer`, a single shared `THREE.Scene`, and an `EffectComposer` post-processing pipeline. The pipeline is:
1. `RenderPass` — renders the scene
2. `RayleighShader` (custom `ShaderPass`) — screenspace atmospheric scattering; horizon position updated every frame from `PTZCamera.horizonNDC`
3. `UnrealBloomPass` — bloom
4. `OutputPass` — tone mapping

Views call `sm.setCamera(camera)` to swap the active camera. The render loop fires `sm.onUpdate(fn)` callbacks (returns unsubscribe). `SceneManager.start()` begins the rAF loop; never call it twice.

**`StarField`** wraps a single `THREE.Points` object that is always in the scene. Filtering (magnitude, distance) is handled entirely in the GLSL vertex shader via `uMinMag` / `uMaxDist` uniforms — stars are never removed from the geometry. Selection state writes per-star `aSelected` (0/1/2) and `aVisible` (0–1) buffer attributes on the CPU, then sets `needsUpdate = true`. Picking is done on the CPU via a manual ray-distance loop (not Three.js `Raycaster.intersectObjects`), using a scaled proximity threshold.

**`PTZCamera`** is a camera locked at the heliocentric origin that rotates to look at any direction on the celestial sphere. Mouse drag = azimuth/altitude pan. Scroll = FOV zoom. It exposes `horizonNDC` (0–1 normalized Y position of the horizon) for the Rayleigh shader. `lookAt(azDeg, altDeg)` sets direction programmatically.

### Views (`src/views/`)

Views implement: `mount(container)`, `update(time)`, `unmount()`.

- **`LandingView`** — a 2D canvas overlay with a twinkling particle animation. Fades out on "Explore" click then calls `viewState.goto(VIEWS.SKYMAP)`.
- **`SkyMapView`** — mounts a `PTZCamera`, builds constellation line geometry, creates the toolbar HUD and parallax dropdown panel, binds click/mousemove for star picking. Cleans up all event listeners and DOM nodes in `unmount()` via a `_cleanups` array. The `update(time)` method ticks `StarField`.
- **`StarMapView`** and **`StarDetailView`** — not yet implemented (VIEWS constants exist; NavDock icons exist; `main.js` has placeholder comments).

`main.js` mounts the `NavDock` and `SelectionBar` ("chrome") lazily on first non-landing view, then they persist. Views are swapped by the `viewState.onchange` listener.

### UI (`src/ui/`)

- **`NavDock`** — bottom-left icon dock. Re-renders its innerHTML on hover (to show/hide labels) and on `viewState.onchange`. Uses `data-view` attributes for click routing.
- **`SelectionBar`** — bottom-right panel. Subscribes to `selectionState.onchange`, re-renders completely. Shows named stars or `HIP {id}` fallback. Emits actions via `data-action` attributes.

### Data pipeline

`CatalogLoader` fetches `stars.bin` and `star-names.json` in parallel. The binary format is **48 bytes per star**, little-endian:

| Offset | Type | Field |
|---|---|---|
| 0–11 | float32 ×3 | x, y, z (heliocentric Cartesian, parsecs) |
| 12–23 | float32 ×3 | r, g, b (spectral class color) |
| 24 | float32 | apparent magnitude (Vmag) |
| 28 | float32 | distance (light years) |
| 32 | uint32 | Hipparcos ID |
| 36 | int32 | name index into star-names.json (−1 = unnamed) |
| 40–47 | uint32 ×2 | padding |

Star coordinates are in **parsecs** in the geometry. Distance-in-light-years is stored separately for display. The camera sits at (0, 0, 0.001).

### CSS / Design system

All global tokens are in `src/style.css` as CSS custom properties: `--font-ui` (Outfit), `--font-mono` (Space Mono), `--c-bg`, `--c-surface`, `--c-border`, `--c-accent` (blue), `--c-gold`, etc. Utility classes `.hud-pill`, `.hud-btn`, `.panel` are defined there.

Per-component styles are injected into `<head>` via `_injectStyles()` / `_applyStyles()` on first mount. Each injection guard-checks by ID (e.g. `document.getElementById('sel-bar-style')`).

## Key conventions

- All state listeners: `const off = state.onchange(fn); /* later */ off();` — always unsubscribe in `unmount()`.
- When modifying `StarField` GPU attributes (selection, visibility), set `geometry.attributes.<name>.needsUpdate = true` after writing into the `Float32Array`.
- Adding a new view requires: adding the constant to `VIEWS` in `ViewState.js`, adding an icon entry to `NavDock.js`, and adding a branch in `main.js`'s `gotoView()`.
- `SceneManager.setCamera()` must be called by any view that uses a non-default camera.
- The post-processing composer renders instead of `renderer.render()` directly — don't add raw `renderer.render()` calls.



## Updates from the original agent who helped 
# Skyspace — Claude Code Context

## What this is

Skyspace is an interactive 3D stellar cartography web app. It is a learning tool that lets users explore the spatial relationships between stars — grounding the familiar night sky (as seen in apps like Sky Guide and Stellarium) into true three-dimensional space using real stellar distance data.

Primary inspirations: Sky Guide (sky atlas aesthetic), Elite Dangerous galaxy map (3D spatial navigation), Space Engine (free camera star field), Stellarium (RA/Dec overlays, constellation lines). The Bobiverse and Project Hail Mary informed the "routes between stars" interaction concept.

---

## Design philosophy

**Everything is always 3D.** There are no mode switches that change the underlying scene. All view changes are camera constraint changes. Filters hide/reveal stars via shader attributes — the scene is never rebuilt.

**The camera is the interface.** Each view is defined by how the camera is constrained, not by what geometry exists in the scene.

**UI chrome never competes with the canvas.** All persistent UI is docked to corners. The 3D canvas is always full-bleed.

**Color encodes meaning.** Gold = primary selection. Blue = secondary selection / accent. Unselected stars dim when a selection exists. Spectral class drives star color.

---

## Tech stack

- **Vite** — build tool and dev server
- **Three.js** — 3D rendering, BufferGeometry point cloud, ShaderMaterial, EffectComposer
- **GLSL** — custom vertex/fragment shaders for star rendering and Rayleigh scattering
- **Tween.js** — installed, not yet wired (for camera transition animations)
- **Vanilla JS** — no framework. All UI is hand-rolled DOM.
- **Fonts** — Outfit (UI), Space Mono (mono/data readouts)

---

## Coordinate system

**Heliocentric Cartesian (parsecs)** is the canonical 3D coordinate space. Sol is at origin (0,0,0). Star positions come directly from Hipparcos parallax data converted to XYZ.

RA/Dec is a **display overlay only** — used for the celestial sphere mesh, constellation lines, and grid. It is never the backend coordinate space. The observer's Local Sidereal Time (computed in `ObserverState`) is used to align the RA/Dec overlay with the heliocentric scene.

The observer's **zenith vector** is derived from lat/lon:
```
N = (cos(lat)cos(LST), cos(lat)sin(LST), sin(lat))
```
This vector drives the Rayleigh scattering horizon plane.

---

## Catalog data

- Source: Hipparcos catalog (~118k stars, magnitude < 8, parallax > 0)
- Build script: `scripts/build-catalog.js` — fetches from VizieR API, falls back to synthetic
- Output: `public/data/stars.bin` (binary, 48 bytes/star) + `public/data/star-names.json`
- **Run `node scripts/build-catalog.js` locally to pull real Hipparcos data** (VizieR is accessible from local machines; it is blocked in Claude's sandbox environment)
- Current dev catalog: ~4,800 synthetic stars with correct named star positions for ~12 key stars

### Binary format (48 bytes/star)

| Offset | Type | Field |
|--------|------|-------|
| 0 | float32 | x (parsecs) |
| 4 | float32 | y (parsecs) |
| 8 | float32 | z (parsecs) |
| 12 | float32 | r (spectral color) |
| 16 | float32 | g |
| 20 | float32 | b |
| 24 | float32 | vmag (apparent magnitude) |
| 28 | float32 | distanceLy |
| 32 | uint32 | hipId |
| 36 | int32 | nameIdx (-1 = unnamed) |
| 40 | uint32 | padding |
| 44 | uint32 | padding |

---

## File structure

```
skyspace/
├── index.html
├── package.json
├── scripts/
│   └── build-catalog.js        # Hipparcos → stars.bin pipeline
├── public/
│   └── data/
│       ├── stars.bin            # prebuilt catalog binary
│       ├── star-names.json      # string array of named star names
│       └── catalog-meta.json    # build metadata
└── src/
    ├── main.js                  # boot, wires all state + views
    ├── style.css                # global CSS design tokens
    ├── core/
    │   ├── SceneManager.js      # Three.js renderer + EffectComposer
    │   ├── StarField.js         # BufferGeometry point cloud + shaders
    │   ├── PTZCamera.js         # pan/tilt/zoom camera locked to origin
    │   ├── SelectionState.js    # primary + multi-select state
    │   ├── ViewState.js         # current view routing
    │   └── ObserverState.js     # lat/lon, time, sidereal time, zenith vector
    ├── data/
    │   └── CatalogLoader.js     # fetches + parses stars.bin into typed arrays
    ├── views/
    │   ├── LandingView.js       # entry screen, canvas star animation, Explore button
    │   ├── SkyMapView.js        # PTZ sky atlas view — BUILT
    │   ├── StarMapView.js       # 6DOF free camera view — STUBBED
    │   └── StarDetailView.js    # isolated star view — STUBBED
    └── ui/
        ├── NavDock.js           # bottom-left horizontal dock, hover expand
        └── SelectionBar.js      # bottom-right persistent selection summary
```

---

## State architecture

Three shared state objects are created once in `main.js` and passed into views and UI components:

### ViewState (`src/core/ViewState.js`)
- Tracks current view: `'landing' | 'skymap' | 'starmap' | 'stardetail'`
- `viewState.goto(view)` triggers view teardown/mount cycle
- `viewState.origin` — star index used as reference origin in StarMap (null = Sol)
- `viewState.setOrigin(index)` — moves the reference plane anchor

### SelectionState (`src/core/SelectionState.js`)
- `primary` — most recently selected star index (drives StarDetail panel)
- `selected` — Set of all selected star indices (drives route in StarMap)
- `select(idx)` — adds to set, sets as primary
- `toggle(idx)` — shift-click behaviour
- `clear()` — resets everything
- Emits onChange to StarField (shader update) and SelectionBar (UI update)

### ObserverState (`src/core/ObserverState.js`)
- `lat`, `lon` — observer position in degrees
- `date` — JavaScript Date object
- `zenithVector` — computed unit vector for Rayleigh shader
- `localSiderealTime` — radians, used to orient RA/Dec overlay
- `posString`, `utcString` — formatted display strings

---

## Render pipeline (EffectComposer order)

1. **RenderPass** — base scene
2. **RayleighPass** (custom ShaderPass) — screenspace horizon-relative scattering
3. **UnrealBloomPass** — star glow
4. **OutputPass** — tone mapping

**Order is intentional:** Rayleigh must run before bloom so that horizon-reddened stars bleed correctly into the bloom pass. Inverting this order causes bloom to amplify unscattered colors before the extinction effect is applied.

### Rayleigh shader uniforms
- `uHorizonY` — horizon in NDC y (0–1), updated each frame from `PTZCamera.horizonNDC`
- `uStrength` — overall scattering strength (0.55 default)
- `uEnabled` — float toggle (1.0 = on)

**Rayleigh is a screenspace effect retained on the parallax rail** — it does not simulate physical atmospheric scattering per-star. It is an anchoring cue that preserves the "I am a human observer on Earth" perspective even as the camera translates outward. This was a deliberate design choice.

---

## The four views

### 1. Landing (`LandingView`)
- Full-screen, no Three.js scene visible
- Canvas 2D twinkling star animation
- "Explore" button → fades out → mounts SkyMap
- No NavDock, no SelectionBar

### 2. Sky Map (`SkyMapView`) — **BUILT**
- Camera: `PTZCamera` — pan/tilt locked at origin, scroll = FOV zoom
- Rayleigh scattering: enabled, horizon tracks camera altitude
- Constellation lines: `THREE.LineSegments` in scene (IAU data TODO)
- Celestial sphere: inverted sphere with RA/Dec grid (TODO)
- Parallax rail: dropdown anchored to toolbar (speed + range sliders, unit presets)
- Observer config: lat/lon + time displayed in toolbar pills
- Selection: click = select primary, shift+click = add to set

### 3. Star Map (`StarMapView`) — **STUBBED**
- Camera: `THREE.OrbitControls` (6DOF free camera)
- Reference plane: flat disc at heliocentric origin (or configurable alternate origin) with concentric radial distance rings and axis lines
- Sol always visible as a labeled anchor point
- Route lines: `THREE.Line` drawn between all selected stars in order of selection, Sol→star1→star2→...
- Camera aims at route midpoint when selection changes
- Origin is configurable: any star can be set as origin via `viewState.setOrigin(idx)`; reference plane and distance labels shift accordingly. Sol remains visible as a secondary reference point.
- Unselected stars: gray points, still selectable
- Selected stars: wireframe sphere + name label + line between them

### 4. Star Detail (`StarDetailView`) — **STUBBED**
- Camera: orbit camera centered on primary selected star
- Left canvas: star with plasma surface shader + flare geometry/shader
- Right panel (210px, always visible): primary star info — name, spectral class, distance, magnitude, temperature, radius, text blurb
- Nearest neighbor stars appear as gray points; names fade in as camera orbits into view
- No circular selection ring (removed from spec)
- "Add to route" and "Set as origin" buttons in right panel
- Primary selection drives panel content — updating primary (via SelectionState) updates the panel without remounting the view

---

## UI layout grammar

This is fixed — do not change the layout positions without discussion:

| Element | Position | Visibility |
|---------|----------|------------|
| NavDock | Bottom-left | All views except Landing |
| SelectionBar | Bottom-right | All views except Landing |
| Right info panel | Right edge, full height | StarDetail only |
| View toolbars | Top of screen | Per-view |
| Constellation modal | Centered | Sky Map only, on constellation select |

### NavDock behaviour
- Horizontal row of 3 icons (Sky Map, Star Map, Star Detail)
- Collapsed: icons only, 40×40px each
- Hovered: dock expands, labels appear below each icon
- Active view: blue accent background + border on that icon
- Transition: CSS only, 0.18s ease

### SelectionBar
- Shows count, list of selected stars (primary in gold, others in blue-accent)
- Action buttons: "detail", "map", "clear"
- When empty: "click a star to select" placeholder

---

## Constellation modal

When a constellation is selected in Sky Map:
- A modal appears centered on screen
- Background canvas dims (rgba overlay)
- Modal has its own **scissored viewport** (not a second renderer) showing a 3D depth view of the constellation
- The 3D depth view auto-orbits around the constellation's centroid
- Modal is draggable
- Stats strip at bottom: nearest star, farthest star, total depth span
- Dismiss button returns to normal Sky Map

**Implementation note:** Use a single `WebGLRenderer` with `renderer.setScissor()` and `renderer.setViewport()` for the modal's 3D view. Do not create a second renderer — GPU memory implications on lower-end hardware.

---

## Star rendering (StarField shaders)

### Vertex shader attributes
- `position` — xyz in parsecs (standard Three.js)
- `color` — rgb spectral color
- `aMagnitude` — apparent Vmag
- `aDistance` — light years
- `aSelected` — 0 = unselected, 1 = selected, 2 = primary
- `aVisible` — 0–1 filter weight (dimming unselected when selection active)

### Uniforms updated per frame
- `uTime` — elapsed seconds
- `uMinMag` — magnitude cutoff filter
- `uMaxDist` — distance cutoff filter (light years)

### LOD strategy
Stars outside filter range are discarded in the fragment shader (`discard`). The geometry is never modified at runtime — only uniforms and per-vertex attributes. `BufferAttribute.needsUpdate = true` is set only when selection changes.

---

## Star sphere (on selection — TODO)

When a star is set as primary, a sphere is instantiated at that star's position:
- Shared `ShaderMaterial` for plasma surface simulation (noise-based displacement + color animation)
- Shared flare geometry (billboard sprites at cardinal points)
- Single sphere instance, moved to primary star position when primary changes
- Visible only in StarDetail view (hidden in SkyMap and StarMap)

---

## Parallax rail

The parallax rail translates the camera outward from the observer origin along the current PTZ look direction. It does not change the camera's pointing direction. Speed units:

| Unit | Label |
|------|-------|
| AU | Astronomical Units/second |
| ls | Light-seconds/second |
| lm | Light-minutes/second |
| lh | Light-hours/second |
| ld | Light-days/second |

Range is dependent on speed setting. Rayleigh scattering is retained during parallax movement as a human-perspective anchor cue.

---

## CSS design tokens (`src/style.css`)

```css
--font-ui: 'Outfit', sans-serif
--font-mono: 'Space Mono', monospace
--c-bg: #070910
--c-surface: rgba(255,255,255,0.05)
--c-border: rgba(255,255,255,0.10)
--c-border-subtle: rgba(255,255,255,0.06)
--c-text: rgba(255,255,255,0.90)
--c-text-muted: rgba(255,255,255,0.45)
--c-text-dim: rgba(255,255,255,0.22)
--c-accent: rgba(100,180,255,1)          /* selection, active states */
--c-accent-dim: rgba(100,180,255,0.15)
--c-accent-border: rgba(100,180,255,0.35)
--c-gold: rgba(255,210,100,1)            /* primary selection */
--c-gold-dim: rgba(255,210,100,0.15)
--c-gold-border: rgba(255,210,100,0.35)
```

Reusable classes: `.hud-pill`, `.hud-btn`, `.hud-btn.active`, `.panel`

---

## What is built vs stubbed

| Feature | Status |
|---------|--------|
| Landing screen | ✅ Built |
| Star field point cloud + shaders | ✅ Built |
| PTZ camera | ✅ Built |
| Post-process pipeline (Rayleigh + Bloom) | ✅ Built |
| SelectionState | ✅ Built |
| NavDock with hover expand | ✅ Built |
| SelectionBar | ✅ Built |
| SkyMapView with toolbar + parallax dropdown | ✅ Built |
| CatalogLoader (binary parser) | ✅ Built |
| ObserverState (LST, zenith vector) | ✅ Built |
| StarMapView | ⬜ Stubbed |
| StarDetailView | ⬜ Stubbed |
| Constellation lines (IAU data) | ⬜ TODO |
| Celestial sphere / RA/Dec grid | ⬜ TODO |
| Constellation modal | ⬜ TODO |
| Star sphere plasma shader | ⬜ TODO |
| Route lines between selected stars | ⬜ TODO |
| Reference plane + radial rings | ⬜ TODO |
| Real Hipparcos catalog | ⬜ Run build script locally |
| Planet meshes + satellite tracks | 🔵 Phase 2 |
| Deep sky objects (Messier) | 🔵 Phase 2 |
| Custom skybox backgrounds | 🔵 Phase 2 |

---

## Conventions

- **No frameworks.** DOM manipulation is direct. No React, Vue, Svelte.
- **Views mount/unmount cleanly.** Every view has `mount(container)` and `unmount()`. Unmount removes DOM elements, removes Three.js objects from scene, and calls all cleanup functions stored in `this._cleanups`.
- **State flows one way.** `main.js` owns all state. Views receive state as constructor args. Views call state methods. Views never hold their own copies of state.
- **No scene graph rebuilding.** Never add/remove stars from the scene. Use shader attributes and uniforms.
- **Shader attributes use `needsUpdate`.** Set `geometry.attributes.X.needsUpdate = true` after modifying typed arrays. Do not recreate BufferAttribute.
- **Z-index layers:** Canvas = 0, Three.js canvas = absolute, UI chrome = z-index 100, modals = z-index 200, loaders = z-index 999.