/**
 * main.js — Skyspace entry point
 */

import './style.css';
import * as THREE from 'three';

import { CatalogLoader }    from './data/CatalogLoader.js';
import { SceneManager }     from './core/SceneManager.js';
import { StarField }        from './core/StarField.js';
import { SelectionState }   from './core/SelectionState.js';
import { ViewState, VIEWS } from './core/ViewState.js';
import { ObserverState }    from './core/ObserverState.js';

import { LandingView }  from './views/LandingView.js';
import { SkyMapView }   from './views/SkyMapView.js';
import { StarMapView }  from './views/StarMapView.js';
import { StarDetailView } from './views/StarDetailView.js';

import { NavDock }      from './ui/NavDock.js';
import { SelectionBar } from './ui/SelectionBar.js';

async function boot() {
  const appEl = document.getElementById('app');

  const loadEl = document.createElement('div');
  loadEl.style.cssText = `
    position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    font-family:var(--font-ui);font-size:12px;letter-spacing:0.1em;
    color:rgba(221,227,238,0.4);text-transform:uppercase;z-index:999;background:#06070e;
  `;
  loadEl.textContent = 'loading catalog…';
  appEl.appendChild(loadEl);

  const viewState      = new ViewState();
  const selectionState = new SelectionState();
  const observer       = new ObserverState();

  const catalog = new CatalogLoader();
  await catalog.load();

  const sm        = new SceneManager(appEl);
  const starField = new StarField(catalog);
  sm.scene.add(starField.points);
  sm.scene.add(starField.rings);
  sm.scene.add(starField.lineMesh);

  // Normalise star point sizes to CSS pixels — gl_PointSize is in physical
  // pixels, so without this stars appear 2× smaller on HiDPI (DPR=2) displays.
  // GLOBAL_STAR_SCALE is a single global size lever (0.6 = 40% smaller).
  const GLOBAL_STAR_SCALE = 0.6;
  starField.setScale(Math.min(window.devicePixelRatio || 1, 2) * GLOBAL_STAR_SCALE);
  sm.scene.background = new THREE.Color(0x08090e);

  selectionState.onchange((s) => starField.updateSelection(s));

  // Selection colours: sky-blue highlight for selected stars + route line,
  // amber for the primary ("you are here") marker.
  starField.setSelectionColor(0.478, 0.690, 0.878);
  starField.setPrimaryTint(0.94, 0.72, 0.25);

  let navDock = null;
  let selBar  = null;

  function mountChrome() {
    if (navDock) return;
    navDock = new NavDock(appEl, viewState);
    selBar  = new SelectionBar(appEl, selectionState, catalog, viewState);
  }

  let activeView = null;
  let updateOff  = null;

  function gotoView(view) {
    activeView?.unmount?.();
    activeView = null;
    updateOff?.();

    if (view === VIEWS.LANDING) return;
    mountChrome();

    const viewArgs = {
      scene: sm.scene,
      sceneManager: sm,
      starField,
      catalog,
      selection: selectionState,
      observer,
      viewState,
    };

    if (view === VIEWS.SKYMAP) {
      activeView = new SkyMapView(viewArgs);
      activeView.mount(appEl);
      updateOff = sm.onUpdate((t) => activeView?.update(t));
    } else if (view === VIEWS.STARMAP) {
      activeView = new StarMapView(viewArgs);
      activeView.mount(appEl);
      updateOff = sm.onUpdate((t) => activeView?.update(t));
    } else if (view === VIEWS.STARDETAIL) {
      activeView = new StarDetailView(viewArgs);
      activeView.mount(appEl);
      updateOff = sm.onUpdate((t) => activeView?.update(t));
    }
  }

  viewState.onchange(({ current }) => gotoView(current));

  loadEl.remove();
  sm.start();

  const landing = new LandingView(appEl, viewState);
  landing.mount();
}

boot().catch(err => {
  console.error('Skyspace boot failed:', err);
  document.getElementById('app').innerHTML =
    `<div style="display:flex;align-items:center;justify-content:center;height:100vh;
      font-family:monospace;color:rgba(255,100,100,0.8);font-size:13px;">
      boot error: ${err.message}</div>`;
});
