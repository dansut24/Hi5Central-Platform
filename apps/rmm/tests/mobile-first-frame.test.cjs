'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'rmm-viewer', 'renderer.js'), 'utf8');

function between(start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `Missing ${start}`);
  const until = source.indexOf(end, from + start.length);
  assert.ok(until > from, `Missing end marker ${end}`);
  return source.slice(from, until);
}

test('mobile ontrack starts initial-frame watchdog without awaiting Safari play()', () => {
  const handler = between('  pc.ontrack = async (ev) => {', '  // Preserve the existing production ICE diagnostic');
  const watchdog = handler.indexOf('    startStatsPoll();');
  const playback = handler.indexOf('    void ensureRemoteVideoPlayback("ontrack");');
  assert.ok(watchdog >= 0);
  assert.ok(playback > watchdog);
  assert.ok(!handler.includes('await ensureRemoteVideoPlayback("ontrack")'));
});

test('playback lifecycle events cannot claim that a frame was decoded', () => {
  const data = between('    elVideo.onloadeddata = () => {', '    elVideo.oncanplay = async () => {');
  const playing = between('    elVideo.onplaying = () => {', '    elVideo.onerror = () => {');
  assert.ok(!data.includes('markFrameRendered()'));
  assert.ok(!playing.includes('markFrameRendered()'));
  assert.match(between('  if (inbound) {', '  const rttMs = selectedPair'), /framesDecoded > lastFramesDecoded[\\s\\S]*markFrameRendered\(\)/);
});

test('keyframe recovery uses open input-control channel and limits requests to 5 seconds', () => {
  const sent = [];
  let now = 10000;
  const context = {
    currentSession: { sessionId: 'test' },
    inputControlDc: { readyState: 'open', send: (msg) => sent.push(JSON.parse(msg)) },
    inputDc: null,
    RECOVERY_KEYFRAME_BACKOFF_MS: 5000,
    lastKeyframeRequestAtMs: 0,
    Date: { now: () => now },
    console: { log() {}, warn() {} },
    JSON
  };
  vm.createContext(context);
  vm.runInContext(between('function requestRemoteKeyframe(', 'function sendFastMouseMove(')
    + between('function sendControlObject(', 'function sendViewerStreamProfile('), context);
  assert.equal(context.requestRemoteKeyframe('initial-timeout'), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'request_keyframe');
  now += 1000;
  assert.equal(context.requestRemoteKeyframe('retry'), false);
  now += 4000;
  assert.equal(context.requestRemoteKeyframe('retry'), true);
  assert.equal(sent.length, 2);
});

test('repeated playback recovery does not issue play() 4 times per second', async () => {
  let attempts = 0;
  let now = 10000;
  const elVideo = {
    srcObject: {},
    paused: true,
    ended: false,
    setAttribute() {},
    play() { attempts += 1; return new Promise(() => {}); }
  };
  const context = {
    elVideo,
    VIDEO_PLAY_RETRY_MS: 1500,
    lastVideoPlaybackAttemptAtMs: 0,
    Date: { now: () => now },
    console: { warn() {} },
    String
  };
  vm.createContext(context);
  vm.runInContext(between('async function ensureRemoteVideoPlayback(', 'function armDecodedFrameReveal('), context);
  void context.ensureRemoteVideoPlayback('initial');
  now += 250;
  assert.equal(await context.ensureRemoteVideoPlayback('watchdog'), false);
  assert.equal(attempts, 1);
});
