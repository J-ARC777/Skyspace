# Skyspace — Wireframes

ASCII layout reference for each view. All views fill the full viewport (`100vw × 100vh`), background `#070910`.

---

## Landing View

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   · ·  ·    ·     ·  ·      ·   ·    ·         ·    ·          │
│       ·          ·       ·            ·    ·                    │
│  ·         ·  ·               ·    ·        ·                   │
│                                                                 │
│                                                                 │
│                   S K Y S P A C E                               │
│              interactive stellar cartography                    │
│                                                                 │
│                    ┌─────────────┐                              │
│                    │   Explore   │                              │
│                    └─────────────┘                              │
│                                                                 │
│  ·    ·        ·         ·   ·      ·           ·               │
│          ·  ·       ·               ·       ·                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

Canvas layer:  2D twinkling particles (280 stars, random positions)
Content layer: wordmark (Outfit 300, clamp 36–72px, 0.22em tracking)
               subtitle (12px, 0.14em tracking, 32% opacity)
               button (pill, 28px radius, frosted glass)
```

---

## Sky Map View

```
┌─────────────────────────────────────────────────────────────────┐
│ ┌────────────────────────────────────┐  ┌──────┐ ┌─────┐ ┌───┐ │  ← top toolbar (z:100)
│ │ 28.5°N · 80.6°W │ 21:34 UTC │ parallax ▾ │  │ grid │ │const│ │flt│ │
│ └────────────────────────────────────┘  └──────┘ └─────┘ └───┘ │
│                                                                 │
│                                                                 │
│        ·           ✦          ·      ·                          │  ← Three.js WebGL canvas
│              ·          ·                  ✦                    │     Stars as GL_POINTS
│    ·                                  ·         ·               │     PTZ camera at origin
│         ✦          ·         ·                       ✦          │
│              ·                    ·        ·                    │
│    ·                    ·                       ·               │
│          ·       ✦             ·      ·                ·        │
│                        ·                   ✦                    │
│   ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌     │  ← horizon (Rayleigh scattering)
│                                                                 │
│                                                                 │
│ ┌───────────────────┐              ┌──────────────────────────┐ │
│ │ 🔵 sky map        │              │  1 selected              │ │  ← NavDock (bottom-left)
│ │ ⬤  star map       │              │  ● Sirius      8.6 ly    │ │  ← SelectionBar (bottom-right)
│ │ ◎  star detail    │              │  [detail] [map] [clear]  │ │
│ └───────────────────┘              └──────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘

NavDock collapsed:    icon-only, ~40px tall
NavDock hovered:      labels slide in below icons, ~60px tall
SelectionBar empty:   "click a star to select" (22% opacity)
SelectionBar active:  gold dot = primary, blue dot = secondary
```

### Parallax Dropdown (expands below toolbar-left)

```
┌─────────────────────┐
│ PARALLAX RAIL       │
│ speed ────●──── 1 AU/s │
│ range ──●────── 50 AU  │
│ unit: [AU] ls  lm  lh  ld │
└─────────────────────┘
Position: absolute, top:48px, left:14px, width:220px
```

---

## Star Map View (planned)

```
┌─────────────────────────────────────────────────────────────────┐
│                           [Sol ×]                               │  ← origin chip / breadcrumb
│                                                                 │
│                                                                 │
│           Proxima ·                                             │
│                        · Alpha Cen A                            │
│               Sol ★                                             │
│                    · Alpha Cen B                                │
│                                                                 │
│        · Barnard's                   · Sirius                   │
│                                                                 │
│                                                                 │
│ ┌───────────────────┐              ┌──────────────────────────┐ │
│ │ ⬤  sky map        │              │  3 selected              │ │
│ │ 🔵 star map        │              │  ● Sirius    8.6 ly      │ │
│ │ ◎  star detail    │              │  · Vega     25.0 ly      │ │
│ └───────────────────┘              │  · Altair   16.7 ly      │ │
│                                    │  [detail]        [clear]  │ │
│                                    └──────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘

3D perspective view recentered on origin star (or Sol).
Stars displayed as labeled points. Camera orbits the origin.
Edges/lines may connect selected stars to show route/distances.
```

---

## Star Detail View (planned)

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   ┌──────────────────────────────────────────────────────────┐  │
│   │                                                          │  │
│   │   ✦  SIRIUS                              HIP 32349       │  │
│   │      Alpha Canis Majoris                                  │  │
│   │                                                          │  │
│   │   Distance      8.60 ly      Magnitude    −1.46          │  │
│   │   Spectral      A1V          Parallax     379 mas        │  │
│   │   Color         blue-white                               │  │
│   │                                                          │  │
│   │   Coordinates   RA 06h 45m   Dec −16° 43'               │  │
│   │   Cartesian     x: −2.1 pc  y: 7.7 pc  z: −2.6 pc      │  │
│   │                                                          │  │
│   │   [← back to sky map]            [add to route →]       │  │
│   └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│                    (star rendered in 3D background)             │
│                                                                 │
│ ┌───────────────────┐              ┌──────────────────────────┐ │
│ │ ⬤  sky map        │              │  1 selected              │ │
│ │ ⬤  star map       │              │  ● Sirius      8.6 ly    │ │
│ │ 🔵 star detail     │              │  [detail] [map] [clear]  │ │
│ └───────────────────┘              └──────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘

Data shown: name, HIP ID, Bayer designation if available,
distance (ly), apparent magnitude, spectral class,
Cartesian position (parsecs). Actions TBD.
```

---

## Component z-index stack

```
z:999   Boot loading screen
z:200   LandingView overlay
z:200   Parallax dropdown panel
z:100   SkyMap toolbar
z:100   NavDock
z:100   SelectionBar
z:0     Three.js canvas (position:absolute, inset:0)
```

---

## Design tokens (from `src/style.css`)

| Token | Value | Usage |
|---|---|---|
| `--c-bg` | `#070910` | Page / canvas background |
| `--c-surface` | `rgba(255,255,255,0.05)` | Panel / button fill |
| `--c-border` | `rgba(255,255,255,0.10)` | Panel borders |
| `--c-accent` | `rgba(100,180,255,1)` | Active state, selected stars |
| `--c-gold` | `rgba(255,210,100,1)` | Primary star indicator |
| `--c-text` | `rgba(255,255,255,0.90)` | Body text |
| `--c-text-muted` | `rgba(255,255,255,0.45)` | Secondary text |
| `--c-text-dim` | `rgba(255,255,255,0.22)` | Hint / placeholder text |
| `--font-ui` | Outfit 300/400/500 | All UI labels |
| `--font-mono` | Space Mono 400/700 | Coordinate / numeric readouts |
| `--radius-lg` | `13px` | NavDock, large panels |
| `--radius-md` | `9px` | `.panel` class |
| `--radius-sm` | `6px` | `.hud-btn` |
