'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'public', 'rmm-viewer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'rmm-viewer', 'index.html'), 'utf8');

function getVideoMount() {
  const start = renderer.indexOf('    // Safari cannot present video frames while the HTML video element is');
  const end = renderer.indexOf('    ev.track.onunmute = () => {', start);
  assert.ok(start > 0 && end > start, 'ontrack compositor workaround is present');
  return renderer.slice(start, end);
}

test('Safari video is displayed beneath overlay before assigning MediaStream', () => {
  const actions = [];
  const classes = new Set();
  const video = {
    classList: { add(name) { actions.push('visible'); classes.add(name); }, contains(name) { return classes.has(name); } },
    get srcObject() { return this._srcObject; },
    set srcObject(value) { actions.push('src'); this._srcObject = value; },
  };
  const overlay = { classList: { contains: (name) => name === 'hidden' ? false : true } };
  const stream = { id: 'remote' };
  const ctx = { elVideo: video, elOverlay: overlay, stream, stopPresentedFrameWatch() { actions.push('reset-rvfc'); } };
  vm.createContext(ctx);
  vm.runInContext(getVideoMount(), ctx);
  assert.deepEqual(actions, ['visible', 'reset-rvfc', 'src']);
  assert.equal(video.classList.contains('visible'), true);
  assert.equal(overlay.classList.contains('hidden'), false);
  assert.equal(video.srcObject, stream);
  assert.ok(html.includes('#remote-video.visible,'));
});

test('first-frame reveal remains gated by presented frames', () => {
  assert.ok(renderer.includes('presentedFrameCallbackId = elVideo.requestVideoFrameCallback'));
  assert.ok(renderer.includes('++presentedFrameCount;\n      markFrameRendered();'));
  assert.ok(renderer.includes('if (typeof elVideo?.requestVideoFrameCallback !== "function") markFrameRendered();'));
});

test('read-only startup diagnostic differentiates no RTP, decode and presentation', () => {
  assert.ok(renderer.includes('bytesReceived / 1024'));
  assert.ok(renderer.includes("framesDecoded + 'decoded'"));
  assert.ok(renderer.includes("presentedFrameCount + 'presented'"));
  assert.ok(renderer.includes("stage: 'stats'"));
  assert.ok(renderer.includes('nowMs - lastVideoTelemetryAtMs >= 5000'));
});

test('new script version bypasses Safari cache', () => {
  assert.ok(html.includes('renderer.js?v=20261028-safari-first-frame-composite'));
});
