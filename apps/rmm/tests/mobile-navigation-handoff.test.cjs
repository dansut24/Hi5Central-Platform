'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'public', 'rmm-viewer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'rmm-viewer', 'index.html'), 'utf8');

function section(start, end) {
  const pos = renderer.indexOf(start);
  const until = renderer.indexOf(end, pos + start.length);
  assert.ok(pos >= 0 && until > pos, 'Section not found: ' + start);
  return renderer.slice(pos, until);
}

test('browser Back releases the active session and leaves the Viewer page', () => {
  const callbacks = {};
  const actions = [];
  const state = {
    window: { addEventListener: (name, fn) => { callbacks[name] = fn; } },
    currentSession: { sessionId: 'old', viewerClient: 'browser' },
    isMobileViewerSurface: () => true,
    mobileHistoryGuardActive: true,
    mobileHistoryGuardReleasing: false,
    disconnect: (...args) => actions.push(['disconnect', ...args]),
    history: { back: () => actions.push(['back']) }
  };
  vm.createContext(state);
  vm.runInContext(section("  window.addEventListener('popstate',", '  document.addEventListener("pointerdown"'), state);
  callbacks.popstate();
  assert.equal(state.mobileHistoryGuardActive, false);
  assert.equal(actions[0][0], 'disconnect');
  assert.equal(actions[0][2].silent, true);
  assert.equal(actions[0][2].notifyRemote, true);
  assert.equal(actions[1][0], 'back');
});

test('pagehide closes browser session, but a visibility change only suspends it', () => {
  const callbacks = {};
  const actions = [];
  const state = {
    window: { addEventListener: (name, fn) => { callbacks[name] = fn; } },
    currentSession: { sessionId: 'old', viewerClient: 'browser' },
    isMobileViewerSurface: () => true,
    releaseMobileWakeLock: () => {},
    captureMobileViewportAnchor: () => null,
    mobileViewportResumeAnchor: null,
    mobileViewportStableAnchor: null,
    resetMobileGestureForLifecycle: () => {},
    disconnect: (...args) => actions.push(args)
  };
  vm.createContext(state);
  vm.runInContext(section("  window.addEventListener('pagehide',", "  window.addEventListener('popstate',"), state);
  callbacks.pagehide();
  assert.equal(actions.length, 1);
  assert.equal(actions[0][1].notifyRemote, true);
  assert.equal(actions[0][1].silent, true);
});

test('a server superseded-close code cannot start obsolete viewer reconnection', () => {
  const block = section('  socket.onclose = (event) => {', '  return true;\n}\n\nfunction scheduleMobileSessionReconnect');
  const actions = [];
  const socket = {};
  const state = {
    ws: socket,
    socket,
    currentSession: { sessionId: 'old', viewerClient: 'browser' },
    isMobileViewerSurface: () => true,
    disconnect: (...args) => actions.push(['disconnect', ...args]),
    scheduleMobileSessionReconnect: (...args) => actions.push(['reconnect', ...args])
  };
  vm.createContext(state);
  vm.runInContext(block, state);
  socket.onclose({ code: 4000 });
  assert.equal(actions.length, 1);
  assert.equal(actions[0][0], 'disconnect');
  assert.equal(state.ws, null);
  assert.ok(renderer.includes('case "session_terminated":'));
});

test('only one presented-frame callback is pending, and old callbacks cannot reveal newer peers', () => {
  let nextId = 0;
  const callbacks = new Map();
  let paints = 0;
  const elVideo = {
    srcObject: {},
    requestVideoFrameCallback(cb) { const id = ++nextId; callbacks.set(id, cb); return id; },
    cancelVideoFrameCallback(id) { callbacks.delete(id); }
  };
  const state = {
    elVideo,
    currentSession: { sessionId: 'session' },
    presentedFrameCallbackId: null,
    presentedFrameCallbackEpoch: 0,
    hasEverRenderedFrame: true,
    revealOnNextFrame: false,
    secureDesktopLikely: false,
    passiveOverlayActive: false,
    markFrameRendered: () => { paints += 1; },
    updateResolution: () => {},
    refreshRemoteCursorPosition: () => {}
  };
  vm.createContext(state);
  vm.runInContext(section('function stopPresentedFrameWatch() {', 'function setOverlayMode('), state);
  state.armDecodedFrameReveal();
  state.armDecodedFrameReveal();
  assert.equal(callbacks.size, 1);
  const first = callbacks.get(1);
  first();
  assert.equal(paints, 1);
  assert.equal(nextId, 2);
  state.stopPresentedFrameWatch();
  callbacks.get(2)?.();
  assert.equal(paints, 1);
});

test('handoff overlay never displays a connecting icon or spinner', () => {
  assert.ok(html.includes('#overlay.transition-hold .overlay-icon,'));
  assert.ok(html.includes('#overlay.transition-hold .spinner,'));
  assert.ok(html.includes('display: none !important;'));
  assert.ok(renderer.includes('if (typeof elVideo?.requestVideoFrameCallback !== "function") markFrameRendered();'));
});
