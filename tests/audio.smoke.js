/* =============================================================================
 * tests/audio.smoke.js - Node smoke test for js/audio.js
 * -----------------------------------------------------------------------------
 * Run from the project root:      node tests/audio.smoke.js
 *
 * js/audio.js is a browser classic script (no modules, no deps), so this test
 * installs a mock Web Audio API + mock speechSynthesis on globalThis, evaluates
 * js/audio.js with vm.runInThisContext (window === globalThis), then exercises
 * the whole public surface and asserts:
 *   - no exception escapes any API call (the API is documented as throw-free)
 *   - no invalid AudioParam values/times (the mock enforces the real spec,
 *     e.g. exponentialRampToValueAtTime(0) is a RangeError in browsers)
 *   - zero stop() on a node that was never start()ed, zero double start()
 *   - every sfx name actually schedules audio
 *   - one-shot voice accounting returns to zero (no leaked voices)
 *   - a saturated voice pool drops extras instead of throwing
 *   - each BGM track schedules notes, crossfades, and stops cleanly
 * Exits non-zero on any failure.
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Chinese UI lines are kept as escapes so this test file stays pure ASCII.
const ZH_LANDLORD = '\u53eb\u5730\u4e3b';   // jiao di zhu (call landlord)
const ZH_HELLO = '\u4f60\u597d';            // ni hao

/* ---------------------------------------------------------------- results */
const results = [];
let currentSection = '(none)';
function section(name) { currentSection = name; }
function check(name, ok, detail) {
  results.push({
    section: currentSection,
    name: name,
    ok: !!ok,
    detail: detail === undefined || detail === null ? '' : String(detail)
  });
  return !!ok;
}

/* ------------------------------------------------------- mock bookkeeping */
const violations = [];            // real-spec violations detected by the mock
const allNodes = [];
const allContexts = [];
let startedSources = 0;
function violation(msg) { violations.push(msg); }
function badNumber(v) { return typeof v !== 'number' || !isFinite(v); }

class MockParam {
  constructor(name, value) {
    this.__isParam = true;
    this.__name = name;
    this.value = value;
    this.__events = [];
  }
  setValueAtTime(v, t) {
    if (badNumber(v)) { violation(`${this.__name}.setValueAtTime(${v})`); throw new TypeError('non-finite value'); }
    if (badNumber(t) || t < 0) { violation(`${this.__name}.setValueAtTime at bad time ${t}`); throw new RangeError('bad time'); }
    this.value = v; this.__events.push(['set', v, t]); return this;
  }
  linearRampToValueAtTime(v, t) {
    if (badNumber(v)) { violation(`${this.__name}.linearRamp(${v})`); throw new TypeError('non-finite value'); }
    if (badNumber(t) || t < 0) { violation(`${this.__name}.linearRamp at bad time ${t}`); throw new RangeError('bad time'); }
    this.value = v; this.__events.push(['lin', v, t]); return this;
  }
  exponentialRampToValueAtTime(v, t) {
    if (badNumber(v) || v <= 0) { violation(`${this.__name}.exponentialRamp to ${v} (browsers require finite > 0)`); throw new RangeError('exponentialRamp value must be non-zero'); }
    if (badNumber(t) || t < 0) { violation(`${this.__name}.exponentialRamp at bad time ${t}`); throw new RangeError('bad time'); }
    this.value = v; this.__events.push(['exp', v, t]); return this;
  }
  setTargetAtTime(v, t, c) {
    if (badNumber(v)) { violation(`${this.__name}.setTargetAtTime(${v})`); throw new TypeError('non-finite value'); }
    if (badNumber(t) || t < 0) { violation(`${this.__name}.setTargetAtTime at bad time ${t}`); throw new RangeError('bad time'); }
    this.value = v; this.__events.push(['target', v, t, c]); return this;
  }
  cancelScheduledValues(t) { this.__events.push(['cancel', t]); return this; }
  setValueCurveAtTime(curve, t, d) { this.__events.push(['curve', t, d]); return this; }
}

let nodeSeq = 0;
class MockNode {
  constructor(kind, ctx) {
    this.__kind = kind;
    this.__id = ++nodeSeq;
    this.__ctx = ctx;
    this.__connections = new Set();
    this.__disconnects = 0;
    this.__endedFired = false;
    this.numberOfInputs = 1;
    this.numberOfOutputs = 1;
    this.channelCount = 2;
    this.channelCountMode = 'max';
    this.channelInterpretation = 'speakers';
    allNodes.push(this);
  }
  connect(dest) {
    if (dest === null || dest === undefined) {
      violation(`${this.__kind}#${this.__id}.connect(null)`);
      throw new TypeError('connect: destination is required');
    }
    if (dest instanceof MockParam) { this.__connections.add(dest); return undefined; }
    if (!(dest instanceof MockNode)) {
      violation(`${this.__kind}#${this.__id}.connect(invalid destination)`);
      throw new TypeError('connect: invalid destination');
    }
    this.__connections.add(dest);
    return dest;
  }
  disconnect(dest) {
    this.__disconnects++;
    if (dest === undefined) this.__connections.clear();
    else this.__connections.delete(dest);
  }
}

class MockSource extends MockNode {
  constructor(kind, ctx) {
    super(kind, ctx);
    this.__started = false;
    this.__stopped = false;
    this.__startCalls = 0;
    this.__stopCalls = 0;
    this.__endQueued = false;
    this.onended = null;
  }
  start(when, offset, duration) {
    if (this.__started) {
      violation(`${this.__kind}#${this.__id}.start() called twice`);
      throw new Error('InvalidStateError: cannot call start more than once');
    }
    if (badNumber(when) || when < 0) { violation(`${this.__kind}#${this.__id}.start at bad time ${when}`); throw new RangeError('bad start time'); }
    if (offset !== undefined && (badNumber(offset) || offset < 0)) { violation(`${this.__kind}#${this.__id}.start bad offset ${offset}`); throw new RangeError('bad offset'); }
    if (duration !== undefined && (badNumber(duration) || duration < 0)) { violation(`${this.__kind}#${this.__id}.start bad duration ${duration}`); throw new RangeError('bad duration'); }
    this.__started = true;
    this.__startCalls++;
    this.__startWhen = when;
    startedSources++;
  }
  stop(when) {
    if (!this.__started) {
      violation(`${this.__kind}#${this.__id}.stop() before start()`);
      throw new Error('InvalidStateError: cannot call stop without start');
    }
    if (badNumber(when) || when < 0) { violation(`${this.__kind}#${this.__id}.stop at bad time ${when}`); throw new RangeError('bad stop time'); }
    this.__stopCalls++;
    this.__stopped = true;
    if (!this.__endQueued) { this.__endQueued = true; this.__ctx.__pendingEnded.push(this); }
  }
}

class MockAudioBuffer {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.__data = [];
    for (let i = 0; i < channels; i++) this.__data.push(new Float32Array(length));
  }
  getChannelData(i) {
    if (!this.__data[i]) this.__data[i] = new Float32Array(this.length);
    return this.__data[i];
  }
}

class MockAudioContext {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.state = 'suspended';
    this.baseLatency = 0.005;
    this.destination = new MockNode('destination', this);
    this.__pendingEnded = [];
    this.__resumeCalls = 0;
    this.__created = {};
    this.__buffers = [];
    this.__closed = false;
    allContexts.push(this);
  }
  __count(kind) { this.__created[kind] = (this.__created[kind] || 0) + 1; return this.__created[kind]; }
  createGain() { this.__count('gain'); const n = new MockNode('gain', this); n.gain = new MockParam('gain', 1); return n; }
  createOscillator() {
    this.__count('oscillator');
    const n = new MockSource('oscillator', this);
    n.frequency = new MockParam('frequency', 440);
    n.detune = new MockParam('detune', 0);
    n.type = 'sine';
    return n;
  }
  createBiquadFilter() {
    this.__count('biquad');
    const n = new MockNode('biquad', this);
    n.frequency = new MockParam('frequency', 350);
    n.detune = new MockParam('detune', 0);
    n.Q = new MockParam('Q', 1);
    n.gain = new MockParam('gain', 0);
    n.type = 'lowpass';
    return n;
  }
  createDelay(maxDelay) {
    this.__count('delay');
    const n = new MockNode('delay', this);
    n.delayTime = new MockParam('delayTime', 0);
    n.maxDelayTime = maxDelay === undefined ? 1 : maxDelay;
    return n;
  }
  createBuffer(channels, length, sampleRate) {
    this.__count('buffer');
    const b = new MockAudioBuffer(channels, length, sampleRate);
    this.__buffers.push(b);
    return b;
  }
  createBufferSource() {
    this.__count('bufferSource');
    const n = new MockSource('bufferSource', this);
    n.buffer = null;
    n.loop = false;
    n.loopStart = 0;
    n.loopEnd = 0;
    n.playbackRate = new MockParam('playbackRate', 1);
    n.detune = new MockParam('detune', 0);
    return n;
  }
  createDynamicsCompressor() {
    this.__count('compressor');
    const n = new MockNode('compressor', this);
    n.threshold = new MockParam('threshold', -24);
    n.knee = new MockParam('knee', 30);
    n.ratio = new MockParam('ratio', 12);
    n.attack = new MockParam('attack', 0.003);
    n.release = new MockParam('release', 0.25);
    n.reduction = 0;
    return n;
  }
  createStereoPanner() {
    this.__count('stereoPanner');
    const n = new MockNode('stereoPanner', this);
    n.pan = new MockParam('pan', 0);
    return n;
  }
  createWaveShaper() {
    this.__count('waveShaper');
    const n = new MockNode('waveShaper', this);
    n.curve = null;
    n.oversample = 'none';
    return n;
  }
  createConvolver() {
    this.__count('convolver');
    const n = new MockNode('convolver', this);
    n.buffer = null;
    n.normalize = true;
    return n;
  }
  createPanner() { this.__count('panner'); return new MockNode('panner', this); }
  createAnalyser() { this.__count('analyser'); const n = new MockNode('analyser', this); n.fftSize = 2048; return n; }
  createChannelMerger() { this.__count('merger'); return new MockNode('merger', this); }
  resume() {
    this.__resumeCalls++;
    // The first call rejects: proves audio.js swallows a rejected resume().
    if (this.__resumeCalls === 1) {
      this.state = 'running';
      return Promise.reject(new Error('mock: resume rejected (must be swallowed)'));
    }
    this.state = 'running';
    return Promise.resolve();
  }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  close() { this.__closed = true; this.state = 'closed'; return Promise.resolve(); }
  __flushEnded() {
    const q = this.__pendingEnded;
    this.__pendingEnded = [];
    let fired = 0;
    for (const n of q) {
      if (typeof n.onended === 'function') {
        const fn = n.onended;
        n.onended = null;
        n.__endedFired = true;
        fired++;
        try { fn(); } catch (e) { violation(`onended handler threw: ${e && e.message}`); }
      }
    }
    return fired;
  }
}

/* --------------------------------------------------- mock speechSynthesis */
const spoken = [];
const mockSynth = {
  cancelCalls: 0,
  speakCalls: 0,
  speaking: false,
  cancel() { this.cancelCalls++; this.speaking = false; },
  speak(u) { this.speakCalls++; this.speaking = true; spoken.push(u); },
  pause() {}, resume() {},
  getVoices() {
    return [
      { name: 'English (US)', lang: 'en-US', default: true, localService: true },
      { name: 'Microsoft Xiaoxiao', lang: 'zh-CN', default: false, localService: true }
    ];
  },
  addEventListener() {}, removeEventListener() {}
};
class MockUtterance {
  constructor(text) { this.text = text; this.lang = ''; this.rate = 1; this.pitch = 1; this.volume = 1; this.voice = null; }
}

/* --------------------------------------------------------------- install */
globalThis.window = globalThis;
globalThis.AudioContext = MockAudioContext;
globalThis.speechSynthesis = mockSynth;
globalThis.SpeechSynthesisUtterance = MockUtterance;

const AUDIO_PATH = path.join(__dirname, '..', 'js', 'audio.js');
const CODE = fs.readFileSync(AUDIO_PATH, 'utf8');

/* --------------------------------------------------------------- helpers */
const REQUIRED_SFX = [
  'click', 'hint', 'select', 'deal', 'flip', 'bid', 'nobid', 'pass',
  'single', 'pair', 'triple', 'triple_single', 'triple_pair',
  'straight', 'straight_pair', 'plane', 'plane_single', 'plane_pair',
  'four_two', 'four_two_pair', 'bomb', 'rocket', 'spring', 'anti_spring',
  'win', 'lose', 'landlord', 'tick', 'warn', 'ready', 'go'
];
const REQUIRED_API = ['init', 'unlock', 'playBgm', 'stopBgm', 'setBgmEnabled', 'setSfxEnabled',
  'setBgmVolume', 'setSfxVolume', 'sfx', 'speak', 'setSpeakEnabled'];

const escaped = [];
function call(label, fn) {
  try { return fn(); } catch (e) {
    escaped.push(`${label}: ${(e && e.message) || e}`);
    return undefined;
  }
}

// the context the module is currently using = newest context that is not closed
function mockCtx() {
  for (let i = allContexts.length - 1; i >= 0; i--) {
    if (!allContexts[i].__closed) return allContexts[i];
  }
  return allContexts[allContexts.length - 1] || null;
}
function drive(audio, seconds, inc) {
  const c = mockCtx();
  const step = inc || 0.25;
  let left = seconds;
  while (left > 0) {
    c.currentTime += Math.min(step, left);
    left -= step;
    audio.__pump(0);
    c.__flushEnded();
  }
}

/* ------------------------------------------- waveform analysis (real DSP) */
// The Karplus-Strong plucked-string bodies are 1.9 s long; the shared noise
// buffer is 2 s, which is how they are told apart.
function ksBuffersFrom(ctx, fromIndex) {
  return ctx.__buffers.slice(fromIndex).filter(b =>
    b.numberOfChannels === 1 && Math.abs(b.length / ctx.sampleRate - 1.9) < 0.0005);
}
function rms(data, sr, t0, t1) {
  const a = Math.max(0, Math.floor(t0 * sr));
  const b = Math.min(data.length, Math.floor(t1 * sr));
  let s = 0;
  for (let i = a; i < b; i++) s += data[i] * data[i];
  return Math.sqrt(s / Math.max(1, b - a));
}
function estimateF0(data, sr) {
  const w = 8192;
  const lagMin = Math.floor(sr / 1400);
  const lagMax = Math.floor(sr / 200);
  let mean = 0;
  for (let i = 0; i < w; i++) mean += data[i];
  mean /= w;
  const rs = [];
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let s = 0, e1 = 0, e2 = 0;
    for (let i = 0; i < w; i++) {
      const x = data[i] - mean, y = data[i + lag] - mean;
      s += x * y; e1 += x * x; e2 += y * y;
    }
    rs.push(s / Math.sqrt(e1 * e2 + 1e-12));
  }
  let best = -1e9, bestI = 0;
  for (let i = 0; i < rs.length; i++) if (rs[i] > best) { best = rs[i]; bestI = i; }
  // prefer the first nearly-as-strong local peak (avoids octave-down errors)
  let chosen = -1;
  for (let i = 1; i < rs.length - 1; i++) {
    if (rs[i] >= 0.9 * best && rs[i] >= rs[i - 1] && rs[i] >= rs[i + 1]) { chosen = i; break; }
  }
  if (chosen < 0) chosen = bestI;
  return { f0: sr / (lagMin + chosen), clarity: best };
}
function centsOffPitchClass(f0, allowedPcs) {
  const midi = 69 + 12 * Math.log2(f0 / 440);
  const pc = ((midi % 12) + 12) % 12;
  let bestCents = 1e9, bestPc = -1;
  for (const a of allowedPcs) {
    let d = Math.abs(pc - a);
    if (d > 6) d = 12 - d;
    if (d * 100 < bestCents) { bestCents = d * 100; bestPc = a; }
  }
  return { cents: bestCents, pc: bestPc, midi: midi };
}
const PCS_D_MAJOR_PENT = [2, 4, 6, 9, 11];   // D E F# A B
const PCS_A_MINOR_PENT = [9, 0, 2, 4, 7];    // A C  D  E G

function checkPluckPhrase(label, bufs, allowedPcs, keyName) {
  check(`${label}: Karplus-Strong bodies were generated`, bufs.length > 0, `${bufs.length} buffers`);
  if (!bufs.length) return;
  const sr = mockCtx().sampleRate;
  const data = bufs[0].getChannelData(0);
  let peak = 0, finite = true;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!isFinite(v)) { finite = false; break; }
    if (Math.abs(v) > peak) peak = Math.abs(v);
  }
  check(`${label}: plucked-string waveform is finite and unclipped`, finite && peak > 0.02 && peak < 1,
    `peak=${peak.toFixed(3)}`);
  const r1 = rms(data, sr, 0.01, 0.1), r2 = rms(data, sr, 0.4, 0.5), r3 = rms(data, sr, 1.0, 1.1);
  check(`${label}: string decays naturally (head > mid > tail)`, r1 > r2 && r2 > r3 && r3 > 0,
    `${r1.toFixed(4)} > ${r2.toFixed(4)} > ${r3.toFixed(4)}`);
  const est = estimateF0(data, sr);
  check(`${label}: pitch estimate is confident (periodic, not noise)`, est.clarity > 0.5, `clarity=${est.clarity.toFixed(2)}`);
  let worst = 0, worstInfo = '';
  const sample = bufs.slice(0, 8);
  for (const b of sample) {
    const d = b.getChannelData(0);
    const e = estimateF0(d, sr);
    const off = centsOffPitchClass(e.f0, allowedPcs);
    if (off.cents > worst) { worst = off.cents; worstInfo = `${e.f0.toFixed(1)} Hz (pc ${off.pc})`; }
  }
  check(`${label}: all ${sample.length} sampled notes are in key (${keyName})`, worst < 25,
    `worst ${worst.toFixed(1)} cents off, ${worstInfo}`);
}

/* ================================================================ the run */
(async function main() {

  section('load');
  check('js/audio.js read from disk', CODE.length > 1000, `${CODE.length} bytes`);
  let loaded = true;
  try {
    vm.runInThisContext(CODE, { filename: 'js/audio.js' });
  } catch (e) {
    loaded = false;
    check('js/audio.js evaluates in a browser-like global', false, (e && e.stack) || e);
  }
  if (loaded) check('js/audio.js evaluates in a browser-like global', true);

  const audio = globalThis.DDZAudio;
  check('window.DDZAudio exists (classic script global)', !!audio);
  if (!audio) return report();

  section('api surface');
  check('ready === false before init()', audio.ready === false, `ready=${audio.ready}`);
  for (const m of REQUIRED_API) check(`DDZAudio.${m} is a function`, typeof audio[m] === 'function');
  check("sfx() before init() is a silent no-op", call('sfx pre-init', () => audio.sfx('bomb', { n: 8, power: 3 })) === undefined);
  check('playBgm() before init() does not throw', call('playBgm pre-init', () => audio.playBgm('lobby')) === undefined);
  check('stopBgm() before init() does not throw', call('stopBgm pre-init', () => audio.stopBgm()) === undefined);
  check('speak() before init() does not throw', call('speak pre-init', () => audio.speak(ZH_HELLO)) === undefined);
  check('setters before init() do not throw', call('setters pre-init', () => {
    audio.setBgmVolume(0.5); audio.setSfxVolume(0.5); audio.setBgmEnabled(true);
    audio.setSfxEnabled(true); audio.setSpeakEnabled(true); audio.setSpeakEnabled(false);
    return true;
  }) === true);
  check('no audio nodes created before init()', allNodes.length === 0, `${allNodes.length} nodes`);

  section('init / unlock');
  check('init() returned true', call('init()', () => audio.init()) === true);
  check('exactly one AudioContext was created', allContexts.length === 1, `${allContexts.length}`);
  check('ready === true after init()', audio.ready === true);
  check('init() is idempotent (safe to call repeatedly)',
    call('init() x3', () => { audio.init(); audio.init(); return audio.init(); }) === true);
  check('still exactly one AudioContext after repeated init()', allContexts.length === 1, `${allContexts.length}`);
  const c0 = mockCtx();
  check('master chain: 1 DynamicsCompressorNode', c0.__created.compressor === 1, `compressor=${c0.__created.compressor}`);
  check('master chain: soft-clip WaveShaperNode present', c0.__created.waveShaper === 1);
  check('reverb implemented with DelayNodes', (c0.__created.delay || 0) >= 2, `delay=${c0.__created.delay}`);
  check('white-noise buffer cached at init', (c0.__created.buffer || 0) >= 1, `buffers=${c0.__created.buffer}`);
  check('Karplus-Strong buffers are not built eagerly', (c0.__created.buffer || 0) < 4, `buffers=${c0.__created.buffer}`);
  check('unlock() swallows a rejected resume()', call('unlock()', () => audio.unlock()) === undefined);
  check('context reached state "running"', mockCtx().state === 'running', mockCtx().state);
  check('second unlock() is safe', call('unlock() again', () => { audio.unlock(); return true; }) === true);

  section('sfx sweep: every required name');
  const names = call('__sfxNames()', () => audio.__sfxNames()) || [];
  const missing = REQUIRED_SFX.filter(n => names.indexOf(n) < 0);
  const extra = names.filter(n => REQUIRED_SFX.indexOf(n) < 0);
  check('all required sfx names are implemented', missing.length === 0, missing.join(', '));
  check('no undocumented extra sfx names', extra.length === 0, extra.join(', '));

  const nodesBefore = allNodes.length;
  const silentNames = [];
  for (const n of REQUIRED_SFX) {
    const before = startedSources;
    call(`sfx('${n}')`, () => audio.sfx(n, { n: 8, power: 3 }));
    mockCtx().__flushEnded();
    if (startedSources === before) silentNames.push(n);
  }
  check('every sfx name started at least one source node', silentNames.length === 0, silentNames.join(', '));
  check('sfx sweep built a substantial node graph', allNodes.length - nodesBefore > 200, `${allNodes.length - nodesBefore} nodes`);
  check('sfx created no extra AudioContext', allContexts.length === 1, `${allContexts.length}`);
  check('all one-shot voices released once tails ended', audio.__stats.activeVoices === 0, `activeVoices=${audio.__stats.activeVoices}`);
  check('no sfx were dropped during the sweep', audio.__stats.dropped === 0, `dropped=${audio.__stats.dropped}`);

  section('sfx options / edge cases');
  check("sfx('straight', {n:12}) works (long combination)",
    call("sfx straight n=12", () => { audio.sfx('straight', { n: 12, power: 1 }); mockCtx().__flushEnded(); return true; }) === true);
  check("sfx('deal', {n:17}) works (big deal burst)",
    call("sfx deal n=17", () => { audio.sfx('deal', { n: 17 }); mockCtx().__flushEnded(); return true; }) === true);
  check('sfx with no opts is safe', call("sfx('single')", () => { audio.sfx('single'); return true; }) === true);
  check('sfx with garbage opts does not throw',
    call("sfx('bomb', {n:'x', power:NaN})", () => { audio.sfx('bomb', { n: 'x', power: NaN }); return true; }) === true);
  check('unknown sfx name is a safe no-op', call("sfx('nope')", () => { audio.sfx('nope', { n: 3 }); return true; }) === true);
  check('sfx(null) is a safe no-op', call('sfx(null)', () => { audio.sfx(null); return true; }) === true);
  check('setSfxEnabled(false) makes sfx a no-op', call('setSfxEnabled(false)', () => { audio.setSfxEnabled(false); return true; }) === true);
  const beforeDisabled = startedSources;
  call('sfx while disabled', () => audio.sfx('bomb', { n: 8, power: 3 }));
  check('disabled sfx started no nodes', startedSources === beforeDisabled);
  call('setSfxEnabled(true)', () => audio.setSfxEnabled(true));
  check('setSfxEnabled(true) restores sfx', (() => {
    const b = startedSources;
    audio.sfx('single');
    mockCtx().__flushEnded();
    return startedSources > b;
  }));
  check('setSfxVolume clamps out-of-range input', call('setSfxVolume', () => {
    audio.setSfxVolume(5); audio.setSfxVolume(-3); audio.setSfxVolume('x'); audio.setSfxVolume(0.7);
    return true;
  }) === true);

  section('sfx voice cap (24 concurrent one-shots)');
  mockCtx().__flushEnded();
  const droppedBefore = audio.__stats.dropped;
  for (let i = 0; i < 60; i++) audio.sfx('single', { n: 1 });      // no flush: voices stay held
  const droppedNow = audio.__stats.dropped - droppedBefore;
  check('saturated voice pool drops extras instead of throwing', droppedNow > 0, `dropped=${droppedNow}`);
  check('concurrent one-shots are capped near 24', audio.__stats.activeVoices > 0 && audio.__stats.activeVoices <= 24, `activeVoices=${audio.__stats.activeVoices}`);
  const flushed = mockCtx().__flushEnded();
  check('voice slots are released when tails end', audio.__stats.activeVoices === 0, `activeVoices=${audio.__stats.activeVoices} (flushed ${flushed})`);
  for (let i = 0; i < 30; i++) audio.sfx('single');
  const bombBefore = startedSources;
  call("sfx('bomb') into a saturated pool", () => audio.sfx('bomb', { n: 8, power: 3 }));
  check('important sfx (bomb) still plays in a saturated pool', startedSources > bombBefore);
  mockCtx().__flushEnded();

  section('BGM');
  const info = call('__info', () => audio.__info) || {};
  check("'lobby' metadata: 76 BPM, 8 bars, D major pentatonic",
    !!info.lobby && info.lobby.bpm === 76 && info.lobby.bars === 8 && /D major pentatonic/.test(info.lobby.key), JSON.stringify(info.lobby));
  check("'game' metadata: 104 BPM, 16-bar A/B loop",
    !!info.game && info.game.bpm === 104 && info.game.bars === 16, JSON.stringify(info.game));
  check("'tense' metadata: 132 BPM, 8 bars, A minor pentatonic",
    !!info.tense && info.tense.bpm === 132 && info.tense.bars === 8 && /A minor pentatonic/.test(info.tense.key), JSON.stringify(info.tense));

  const lobbyNotes0 = audio.__stats.notes.lobby;
  check("playBgm('lobby') does not throw", call("playBgm('lobby')", () => { audio.playBgm('lobby'); return true; }) === true);
  check('one track instance is live', audio.__state().instances === 1, JSON.stringify(audio.__state()));
  drive(audio, 6);                                                 // ~1.5 bars @ 76 BPM
  check("'lobby' scheduled notes", audio.__stats.notes.lobby > lobbyNotes0, `notes=${audio.__stats.notes.lobby}`);
  check('16th-note clock advanced', audio.__stats.steps > 16, `steps=${audio.__stats.steps}`);
  check("starting 'lobby' twice does not double-schedule it", call("playBgm('lobby') x2", () => {
    audio.playBgm('lobby'); audio.playBgm('lobby');
    return audio.__state().instances === 1;
  }), JSON.stringify(audio.__state()));
  const lobbySteps = audio.__stats.steps;
  drive(audio, 1);
  check("the same track keeps its single step clock (no drift/duplication)",
    audio.__stats.steps - lobbySteps > 0 && audio.__state().instances === 1, `steps +${audio.__stats.steps - lobbySteps}`);

  const gameNotes0 = audio.__stats.notes.game;
  check("crossfade to 'game'", call("playBgm('game')", () => { audio.playBgm('game'); return true; }) === true);
  check('both tracks are alive during the crossfade', audio.__state().instances === 2, JSON.stringify(audio.__state()));
  drive(audio, 2.2);
  check('old track retired after the 1.2 s crossfade', audio.__state().instances === 1, JSON.stringify(audio.__state()));
  check("'game' scheduled notes", audio.__stats.notes.game > gameNotes0, `notes=${audio.__stats.notes.game}`);

  const tenseNotes0 = audio.__stats.notes.tense;
  check("crossfade to 'tense'", call("playBgm('tense')", () => { audio.playBgm('tense'); return true; }) === true);
  drive(audio, 3.2);
  check("'tense' scheduled notes", audio.__stats.notes.tense > tenseNotes0, `notes=${audio.__stats.notes.tense}`);
  check('only the requested track remains', audio.__state().instances === 1 && audio.__state().current === 'tense', JSON.stringify(audio.__state()));

  check('unknown track name is ignored', call("playBgm('nope')", () => {
    audio.playBgm('nope');
    return audio.__state().current === 'tense';
  }), JSON.stringify(audio.__state()));
  check('playBgm(null) stops the music', call('playBgm(null)', () => { audio.playBgm(null); return true; }) === true);
  drive(audio, 2);
  check('all instances retired after playBgm(null)', audio.__state().instances === 0, JSON.stringify(audio.__state()));
  const tenseAtStop = audio.__stats.notes.tense;
  drive(audio, 2);
  check('no notes scheduled after the stop fade completes', audio.__stats.notes.tense === tenseAtStop, `${tenseAtStop} -> ${audio.__stats.notes.tense}`);

  check('setBgmEnabled(false) is safe', call('setBgmEnabled(false)', () => { audio.setBgmEnabled(false); return true; }) === true);
  check('playBgm while BGM disabled schedules nothing', call("playBgm('game') while disabled", () => {
    audio.playBgm('game');
    const inst = audio.__state().instances;
    audio.setBgmEnabled(true);
    return inst === 0;
  }), JSON.stringify(audio.__state()));
  check('re-enabling BGM resumes the requested track', audio.__state().instances === 1, JSON.stringify(audio.__state()));
  check('setBgmVolume clamps out-of-range input', call('setBgmVolume', () => {
    audio.setBgmVolume(2); audio.setBgmVolume(-1); audio.setBgmVolume('bad'); audio.setBgmVolume(0.6);
    return true;
  }) === true);
  check('stopBgm() is safe and repeatable', call('stopBgm() x3', () => { audio.stopBgm(); audio.stopBgm(); audio.stopBgm(); return true; }) === true);
  drive(audio, 2);
  check('stopBgm() retires every instance', audio.__state().instances === 0, JSON.stringify(audio.__state()));
  check('stopBgm() clears the current track name', audio.__state().current === null, String(audio.__state().current));

  section('speech (zh-CN)');
  check('setSpeakEnabled(true) is safe', call('setSpeakEnabled(true)', () => { audio.setSpeakEnabled(true); return true; }) === true);
  mockSynth.cancelCalls = 0; mockSynth.speakCalls = 0; spoken.length = 0;
  call('speak(ZH_LANDLORD)', () => audio.speak(ZH_LANDLORD));
  check('speak() called speechSynthesis.speak once', mockSynth.speakCalls === 1, `speakCalls=${mockSynth.speakCalls}`);
  check('speak() cancelled any in-flight utterance first', mockSynth.cancelCalls === 1, `cancelCalls=${mockSynth.cancelCalls}`);
  check('utterance lang is zh-CN', !!spoken[0] && spoken[0].lang === 'zh-CN', spoken[0] && spoken[0].lang);
  check('utterance rate is ~1.05', !!spoken[0] && Math.abs(spoken[0].rate - 1.05) < 0.001, spoken[0] && spoken[0].rate);
  check('a Chinese voice was selected', !!(spoken[0] && spoken[0].voice && /^zh/i.test(spoken[0].voice.lang)), spoken[0] && spoken[0].voice && spoken[0].voice.name);
  check('empty speak() text is ignored', call("speak('')", () => {
    audio.speak(''); audio.speak(null); audio.speak(undefined);
    return mockSynth.speakCalls === 1;
  }));
  check('setSpeakEnabled(false) cancels speech', call('setSpeakEnabled(false)', () => {
    audio.setSpeakEnabled(false);
    return mockSynth.cancelCalls === 2;
  }), `cancelCalls=${mockSynth.cancelCalls}`);
  call('speak while disabled', () => audio.speak('ignored'));
  check('speak() is a no-op while disabled', mockSynth.speakCalls === 1, `speakCalls=${mockSynth.speakCalls}`);
  const savedSynth = globalThis.speechSynthesis;
  globalThis.speechSynthesis = undefined;
  audio.setSpeakEnabled(true);
  check('speak() is safe when speechSynthesis is unavailable', call('speak w/o speechSynthesis', () => { audio.speak(ZH_HELLO); return true; }) === true);
  globalThis.speechSynthesis = savedSynth;
  audio.setSpeakEnabled(false);

  section('lifecycle: shutdown / re-init / deferred unlock');
  check('stopBgm + shutdown is clean', call('__shutdown()', () => { audio.stopBgm(); audio.__shutdown(); return true; }) === true);
  check('context was closed by __shutdown()', mockCtx().__closed === true);
  check('ready === false after shutdown', audio.ready === false);
  check('post-shutdown sfx is a silent no-op', call('sfx after shutdown', () => { audio.sfx('bomb', { n: 8, power: 3 }); return true; }) === true);
  check('post-shutdown playBgm/stopBgm/speak/setters are safe', call('post-shutdown calls', () => {
    audio.playBgm('lobby'); audio.stopBgm(); audio.speak('x');
    audio.setBgmVolume(0.5); audio.setSfxVolume(0.5);
    audio.setBgmEnabled(true); audio.setSfxEnabled(true); audio.setSpeakEnabled(false);
    return true;
  }) === true);
  check('playBgm before unlock() is remembered', call('playBgm while locked', () => {
    audio.playBgm('tense');
    return audio.__state().desired === 'tense' && audio.__state().instances === 0;
  }), JSON.stringify(audio.__state()));
  check('init() after shutdown works', call('init() again', () => audio.init()) === true);
  check('a fresh AudioContext was created', allContexts.length === 2, `${allContexts.length}`);
  check('fresh context is suspended until unlock()', mockCtx().state === 'suspended', mockCtx().state);
  const forbidden = startedSources;
  call('sfx while still locked', () => audio.sfx('bomb', { n: 8, power: 3 }));
  check('sfx is a silent no-op until unlock()', startedSources === forbidden);
  check('unlock() is safe', call('unlock()', () => { audio.unlock(); return true; }) === true);
  const tenseRemembered = audio.__stats.notes.tense;
  drive(audio, 3);
  check('the track requested before unlock() starts playing after it',
    audio.__state().instances === 1 && audio.__stats.notes.tense > tenseRemembered,
    `${JSON.stringify(audio.__state())} notes=${audio.__stats.notes.tense}`);

  section('real setInterval lookahead scheduler');
  const stepsBeforeAsync = audio.__stats.steps;
  const ticker = setInterval(() => { mockCtx().currentTime += 0.08; }, 4);
  try {
    await new Promise(r => setTimeout(r, 200));
  } finally {
    clearInterval(ticker);
  }
  mockCtx().__flushEnded();
  check('the 25 ms tick advances on its own (no __pump)', audio.__stats.steps > stepsBeforeAsync,
    `steps ${stepsBeforeAsync} -> ${audio.__stats.steps}`);

  section('spec violations (mock-enforced browser parity)');
  const stoppedUnstarted = allNodes.filter(n => (n.__stopCalls || 0) > 0 && !n.__started);
  check('zero stop() on nodes that were never start()ed', stoppedUnstarted.length === 0,
    stoppedUnstarted.slice(0, 5).map(n => `${n.__kind}#${n.__id}`).join(', '));
  const startedTwice = allNodes.filter(n => (n.__startCalls || 0) > 1);
  check('zero double start() calls', startedTwice.length === 0,
    startedTwice.slice(0, 5).map(n => `${n.__kind}#${n.__id}`).join(', '));
  const badParams = violations.filter(v => /exponentialRamp|non-finite|bad (time|start|stop|offset|duration)/.test(v));
  check('no invalid AudioParam values or negative times', badParams.length === 0, badParams.slice(0, 5).join(' | '));
  check('no mock-detected spec violations at all', violations.length === 0, violations.slice(0, 6).join(' | '));
  check('audio.js internal defensive counter is 0', audio.__violations() === 0, `__violations=${audio.__violations()}`);

  section('resource hygiene');
  call('stopBgm before hygiene checks', () => audio.stopBgm());
  drive(audio, 2);
  const leaked = allNodes.filter(n => n.__endedFired && n.__disconnects === 0);
  check('every ended voice tail was disconnected (no node leaks)', leaked.length === 0,
    leaked.slice(0, 5).map(n => `${n.__kind}#${n.__id}`).join(', '));
  const startedFinal = startedSources;
  drive(audio, 1);
  check('nothing is scheduled after all music stopped', startedSources === startedFinal, `+${startedSources - startedFinal}`);

  section('teardown');
  call('final shutdown', () => audio.__shutdown());
  check('final __shutdown() closed the context', mockCtx().__closed === true);
  check('final ready === false', audio.ready === false);

  return report();

  /* ----------------------------------------------------------- reporting */
  function report() {
    const failed = results.filter(r => !r.ok);
    let lastSection = null;
    for (const r of results) {
      if (r.section !== lastSection) { console.log(`\n[${r.section}]`); lastSection = r.section; }
      if (r.ok) console.log(`  PASS  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
      else console.log(`  FAIL  ${r.name}${r.detail ? `  -> ${r.detail}` : ''}`);
    }
    if (escaped.length) {
      console.log('\n[exceptions escaped the API]');
      for (const t of escaped) console.log(`  FAIL  ${t}`);
    }
    const total = results.length + escaped.length;
    const bad = failed.length + escaped.length;
    console.log('\n--------------------------------------------------------------');
    console.log(`sfx names exercised : ${REQUIRED_SFX.length}`);
    console.log(`notes scheduled     : lobby=${audio.__stats.notes.lobby} game=${audio.__stats.notes.game} tense=${audio.__stats.notes.tense}`);
    console.log(`scheduler steps     : ${audio.__stats.steps}`);
    console.log(`audio nodes built   : ${allNodes.length}   sources started: ${startedSources}`);
    console.log(`checks              : ${total - bad}/${total} passed`);
    console.log(`mock violations     : ${violations.length}`);
    console.log(bad === 0 ? '\nRESULT: PASS - DDZAudio smoke test clean' : `\nRESULT: FAIL - ${bad} problem(s)`);
    console.log('--------------------------------------------------------------');
    process.exitCode = bad === 0 ? 0 : 1;
    // if some stray handle keeps the loop alive, force the exit code through
    setTimeout(() => process.exit(bad === 0 ? 0 : 1), 1500).unref();
  }
})().catch(err => {
  console.log('\nRESULT: FAIL - unhandled error in the test harness itself');
  console.log(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
