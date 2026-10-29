'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'public', 'rmm-viewer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'rmm-viewer', 'index.html'), 'utf8');
const begin = renderer.indexOf('function markFrameRendered() {');
const end = renderer.indexOf('function updateResolution()', begin);
assert.ok(begin > 0 && end > begin);

function runFrame({ handoff = false, ready = false, safari = true } = {}) {
  let cleared = 0;
  const classes = new Set(['transition-hold']);
  const state = {
    clearReconnectPoster() {},
    document: { body: { classList: { add() {}, remove() {} } } },
    isMobileViewerSurface: () => false,
    hasEverRenderedFrame: true,
    mobileRecoveryAttempts: 0,
    mobileRecoveryStage: 'Idle',
    secureDesktopActive: handoff,
    desktopHandoffActive: false,
    revealOnNextFrame: ready,
    desktopTransitionDecodedBaseline: 10,
    lastFramesDecoded: 10,
    secureDesktopLikely: false,
    passiveOverlayActive: false,
    desktopTransitionReadyAtMs: 123,
    desktopTransitionEnteredAtMs: 111,
    elOverlay: { classList: { contains: x => classes.has(x) } },
    elVideo: { requestVideoFrameCallback: safari ? () => {} : undefined },
    hideOverlay: () => { classes.delete('transition-hold'); cleared++; },
    showStream: () => { classes.delete('transition-hold'); cleared++; },
    setStatus() {}
  };
  vm.createContext(state);
  vm.runInContext(renderer.slice(begin, end), state);
  state.markFrameRendered();
  return { state, cleared };
}
test('Windows desktop-handoff frame dismisses overlay without waiting for ready event', () => {
  const result = runFrame({ handoff: true });
  assert.equal(result.cleared, 1);
  assert.equal(result.state.secureDesktopActive, true);
});
test('Safari presented video takes precedence over stale decoded-frame counter', () => {
  const result = runFrame({ ready: true, safari: true });
  assert.equal(result.cleared, 1);
  assert.equal(result.state.revealOnNextFrame, false);
});
test('fallback stats path still waits for a real decoded frame after handoff', () => {
  const result = runFrame({ ready: true, safari: false });
  assert.equal(result.cleared, 0);
  assert.equal(result.state.revealOnNextFrame, true);
});
test('transition overlay hides icon and does not block touch or keyboard', () => {
  assert.match(html, /#overlay\.transition-hold\s*\{[^}]*pointer-events:\s*none/s);
  assert.ok(html.includes('#overlay.transition-hold .overlay-icon,'));
  assert.ok(html.includes('body.viewer-has-video #overlay .overlay-icon { display: none !important; }'));
  assert.ok(html.includes('#overlay.transition-hold .spinner,'));
});

test('viewer icon only on initial connection',()=>{assert.ok(renderer.includes("document.body.classList.add('viewer-has-video')")); assert.ok(renderer.includes("document.body.classList.remove('viewer-has-video')"));});
