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

import { NavDock }      from './ui/NavDock.js';
import { SelectionBar } from './ui/SelectionBar.js';

async function boot() {
  const appEl = document.getElementById('app');

  const loadEl = document.createElement('div');
  loadEl.style.cssText = `
    position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    font-family:var(--font-ui);font-size:12px;letter-spacing:0.1em;
    color:rgba(255,255,255,0.3);text-transform:uppercase;z-index:999;background:#070910;
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
  sm.scene.background = new THREE.Color(0x080c18);

  selectionState.onchange((s) => starField.updateSelection(s));

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

    if (view === VIEWS.SKYMAP) {
      activeView = new SkyMapView({
        scene: sm.scene,
        sceneManager: sm,
        starField,
        catalog,
        selection: selectionState,
        observer,
        viewState,
      });
      activeView.mount(appEl);
      updateOff = sm.onUpdate((t) => activeView?.update(t));
    }
    // STARMAP + STARDETAIL added in next build phases
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
