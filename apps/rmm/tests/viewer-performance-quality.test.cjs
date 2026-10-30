const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/rmm-viewer/index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public/rmm-viewer/renderer.js'), 'utf8');

test('viewer declares every performance metric and accessible quality control', () => {
  for (const id of [
    'viewer-quality-preset', 'viewer-performance-toggle', 'session-performance-panel',
    'perf-codec', 'perf-presented-fps', 'perf-bitrate', 'perf-rtt',
    'perf-loss', 'perf-decode', 'diag-presented-fps', 'diag-frames-dropped',
    'diag-jitter', 'diag-jitter-buffer', 'diag-decode-ms', 'diag-loss-rate'
  ]) {
    assert.match(html, new RegExp('id="' + id + '"'));
    assert.match(js, new RegExp('getElementById\\("' + id + '"\\)'));
  }
  for (const label of ['Automatic', 'Prioritise speed', 'Prioritise clarity', 'Maximum clarity']) {
    assert.ok(html.includes(label), label);
  }
});

test('fixed presets use the already-negotiated codec and bounded WebRTC stream controls', () => {
  const start = js.indexOf('const VIEWER_QUALITY_PRESETS =');
  const end = js.indexOf('function syncPerformanceOverlay()', start);
  assert.ok(start !== -1 && end > start);
  const source = js.slice(start, end);
  const mobilePrefs = { qualityPreset: 'automatic' };
  const sandbox = {
    mobilePrefs,
    currentSession: { sessionId: 'safe-test-session' },
    mobileAdaptiveState: { tier: 0 },
    autoFpsProof: { sessionId: 'safe-test-session', qualifiedMaxFps: 20 },
    mobileStreamProfilePayload: () => ({ preference: 'native', target_fps: 18, target_bitrate_kbps: 4200, max_width: 0, max_height: 0 })
  };
  const select = vm.runInNewContext(source + '\nselectedViewerStreamProfile;', sandbox);
  assert.equal(select().target_bitrate_kbps, 4200);
  mobilePrefs.qualityPreset = 'speed';
  assert.equal(select().preference, '720p');
  assert.equal(select().max_width, 1280);
  mobilePrefs.qualityPreset = 'clarity';
  assert.equal(select().max_width, 0);
  assert.equal(select().target_bitrate_kbps, 8000);
  mobilePrefs.qualityPreset = 'maximum';
  assert.equal(select().target_bitrate_kbps, 12000);
  assert.ok(select().target_fps <= 60);
  assert.ok(select().target_bitrate_kbps <= 20000);
  assert.match(js, /kind: 'viewer_stream_profile'/);
  assert.doesNotMatch(source, /setRemoteDescription|createOffer|setCodecPreferences|renegotiat/);
});

test('FPS limit is offered independently of image quality on browser and native Viewer', () => {
  const nativeRoot = path.resolve(root, '../../native/viewer/web');
  const nativeHtml = fs.readFileSync(path.join(nativeRoot, 'index.html'), 'utf8');
  const nativeJs = fs.readFileSync(path.join(nativeRoot, 'renderer.js'), 'utf8');
  for (const htmlSource of [html, nativeHtml]) {
    assert.match(htmlSource, /id="viewer-fps-limit"/);
    for (const cap of ['auto', '15', '30', '45', '60'])
      assert.ok(htmlSource.includes('value="' + cap + '"'), cap);
    assert.match(htmlSource, /Actual FPS|actual delivered FPS/);
  }
  for (const source of [js, nativeJs]) {
    assert.match(source, /getElementById\("viewer-fps-limit"\)/);
    assert.match(source, /elFrameRateLimit.*addEventListener\('change'/);
    assert.match(source, /sendViewerStreamProfile\(\)|sendDesktopStreamProfile\(\)/);
  }
  const browserStart = js.indexOf('const VIEWER_QUALITY_PRESETS =');
  const browserEnd = js.indexOf('function syncPerformanceOverlay()', browserStart);
  const prefs = { qualityPreset: 'clarity', fpsLimit: 'auto' };
  const context = { mobilePrefs: prefs, currentSession: { sessionId: 'browser-test' }, mobileAdaptiveState: { tier: 0 }, autoFpsProof: { sessionId: 'browser-test', qualifiedMaxFps: 20 }, mobileStreamProfilePayload: () => ({ preference: 'native', target_fps: 18, target_bitrate_kbps: 4200 }) };
  const choose = vm.runInNewContext(js.slice(browserStart,browserEnd)+'\nselectedViewerStreamProfile;', context);
  assert.equal(choose().target_fps, 20);
  assert.equal(choose().fps_mode, 'quality_preset');
  for (const fps of [15,30,45,60]) {
    prefs.fpsLimit = String(fps);
    assert.equal(choose().target_fps,fps);
    assert.equal(choose().fps_mode,'development_override');
    assert.equal(choose().target_bitrate_kbps,8000);
  }
  prefs.fpsLimit = 'auto';
  assert.equal(choose().target_fps, 20);
  prefs.qualityPreset = 'automatic';
  assert.equal(choose().fps_mode, 'auto');
  context.autoFpsProof.qualifiedMaxFps = 60;
  assert.equal(choose().target_fps, 60, 'qualified session can auto-promote');
  context.mobileAdaptiveState.tier = 2;
  assert.equal(choose().target_fps, 30, 'automatic network adaptation caps qualified FPS');
  context.autoFpsProof.sessionId = 'stale-old-session';
  assert.equal(choose().target_fps, 18, 'stale proof must not promote another Viewer session');
  assert.ok(nativeJs.includes("fps_mode: [15,30,45,60].includes(manualFps) ? 'development_override' : (desktopQualityPreset === 'automatic' ? 'auto' : 'quality_preset')"));
  assert.ok(nativeJs.includes('const manualFps = Number(desktopFpsLimit);'));
  assert.ok(nativeJs.includes("return sendControlObject({ kind: 'viewer_stream_profile'"));
});

test('manual presets cannot be replaced by mobile adaptive rate control', () => {
  assert.match(js, /function applyMobileAdaptiveTier\(nextTier, reason = ''\) \{\s*if \(mobilePrefs\.qualityPreset !== 'automatic'\) return;/);
  assert.match(js, /if \(mobilePrefs\.qualityPreset !== 'automatic'\) return;\s*\/\/ Only sustained Poor quality/);
  assert.match(js, /if \(mobilePrefs\.qualityPreset === 'automatic'\) resetMobileAdaptiveState\(\)/);
  assert.match(js, /function sendViewerStreamProfile\(\)[\s\S]*?const profile = selectedViewerStreamProfile\(\);/);
});

test('viewer statistics distinguish decode time and presentation from network quality', () => {
  for (const token of [
    'requestVideoFrameCallback', 'presentedFrameCount - lastStats.presented',
    'inbound.totalDecodeTime', 'inbound.framesDropped',
    'inbound.jitterBufferDelay', 'packetSampleCount > 0',
    'selectedPair.currentRoundTripTime', 'syncPerformanceOverlay()'
  ]) assert.ok(js.includes(token), token);
  assert.ok(html.includes('Maximum clarity is still lossy.'));
});

test('native desktop viewer exposes the same quality choices and statistics', () => {
  const nativeRoot = path.resolve(root, '../../native/viewer/web');
  const nativeHtml = fs.readFileSync(path.join(nativeRoot, 'index.html'), 'utf8');
  const nativeJs = fs.readFileSync(path.join(nativeRoot, 'renderer.js'), 'utf8');
  for (const id of [
    'viewer-quality-preset', 'viewer-performance-toggle', 'session-performance-panel',
    'perf-codec', 'perf-presented-fps', 'perf-bitrate', 'perf-rtt', 'perf-loss', 'perf-decode',
    'diag-presented-fps', 'diag-frames-dropped', 'diag-jitter', 'diag-jitter-buffer',
    'diag-decode-ms', 'diag-loss-rate'
  ]) {
    assert.ok(nativeHtml.includes('id="' + id + '"'), id);
    assert.ok(nativeJs.includes('getElementById("' + id + '")'), id);
  }
  const start = nativeJs.indexOf('const DESKTOP_QUALITY_PRESETS =');
  const end = nativeJs.indexOf('function syncPerformanceOverlay()', start);
  assert.ok(start >= 0 && end > start, 'native preset policy');
  const preset = vm.runInNewContext(nativeJs.slice(start, end) + '\nDESKTOP_QUALITY_PRESETS', {});
  assert.equal(preset.speed.max_height, 720);
  assert.equal(preset.clarity.target_bitrate_kbps, 8000);
  assert.equal(preset.maximum.target_bitrate_kbps, 12000);
  assert.ok(nativeJs.includes("if(desktopQualityPreset !== 'automatic') return;"));
  assert.ok(nativeJs.includes('const override = DESKTOP_QUALITY_PRESETS[desktopQualityPreset];'));
  assert.ok(nativeJs.includes('elVideo?.getVideoPlaybackQuality?.()'));
  assert.ok(nativeJs.includes('inbound.totalDecodeTime'));
  assert.ok(nativeHtml.includes('Maximum clarity is still lossy.'));
});

