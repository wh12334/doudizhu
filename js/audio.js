/* =============================================================================
 * DDZAudio - procedural Web Audio engine for the 斗地主 (Fight the Landlord) game
 * -----------------------------------------------------------------------------
 * Classic <script> global. No ES modules, no fetch, no external assets, no
 * dependencies: every sound (BGM + SFX) is synthesized at runtime with the
 * Web Audio API, so the page works straight off file://.
 *
 * Public API (window.DDZAudio):
 *   ready                 - true once an AudioContext exists
 *   init()                - create context/master chain lazily; idempotent
 *   unlock()              - resume() the context (call from a user gesture)
 *   playBgm(name|null)    - 'lobby' | 'game' | 'tense' | null (crossfade 1.2s)
 *   stopBgm()
 *   setBgmEnabled(on)  setSfxEnabled(on)
 *   setBgmVolume(v)    setSfxVolume(v)        // 0..1
 *   sfx(name, opts)       // one-shot; opts = { n: cardCount, power: 1..3 }
 *   speak(text)           // optional zh-CN line via speechSynthesis
 *   setSpeakEnabled(on)
 *
 * Every method is safe to call at any time and NEVER throws. Before init() and
 * before a user-gesture unlock() the engine is a silent no-op (a suspended
 * AudioContext cannot produce sound), so the UI may call freely.
 *
 * Internal test hooks (documented, not for UI use):
 *   __pump(seconds)   - schedule ahead as if `seconds` of audio time elapsed
 *   __stats           - { notes:{track:count}, steps, dropped, activeVoices }
 *   __info            - track metadata (bpm/key/bars)
 *   __violations      - defensive-call counter (should stay 0)
 *   __shutdown()      - stop scheduler + close context (tests only)
 * ========================================================================== */
(function (global) {
  'use strict';

  /* ==========================================================================
   * 1. Small utilities
   * ======================================================================== */

  function clamp(v, lo, hi) {
    v = +v;
    if (!isFinite(v)) return lo;
    return v < lo ? lo : (v > hi ? hi : v);
  }
  function clamp01(v) { return clamp(v, 0, 1); }
  function oneShotTime() {
    // small constant offset so nothing is scheduled in the past
    return ctx.currentTime + 0.006;
  }
  function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  var NOTE_BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  var noteMidiCache = {};
  // "D4" / "F#3" / "Bb2" / "A1" -> MIDI number (C4 == 60)
  function noteToMidi(name) {
    if (typeof name !== 'string') return 0;
    var cached = noteMidiCache[name];
    if (cached !== undefined) return cached;
    var m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(name);
    var v = 0;
    if (m) {
      v = NOTE_BASE[m[1].toUpperCase()] +
          (m[2] === '#' ? 1 : (m[2] === 'b' ? -1 : 0)) +
          (parseInt(m[3], 10) + 1) * 12;
    }
    noteMidiCache[name] = v;
    return v;
  }
  function noteToFreq(name) { return midiToFreq(noteToMidi(name)); }

  // Pentatonic scales ------------------------------------------------------
  var PENT_MAJOR = [0, 2, 4, 7, 9];   // D E F# A B   (key of D major pentatonic)
  var PENT_MINOR = [0, 3, 5, 7, 10];  // A C  D E G   (key of A minor pentatonic)
  // scale degree -> MIDI, octave-wrapping every 5 degrees (degree 5 == root+octave)
  function degToMidi(deg, base, pent) {
    var oct = Math.floor(deg / 5);
    var idx = deg - oct * 5;
    return base + pent[idx] + 12 * oct;
  }

  // Deterministic RNG (xorshift32) - music variation must be reproducible so a
  // long session sounds alive without ever sounding random.
  function makeRng(seed) {
    var s = (seed >>> 0) || 0x9e3779b9;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;  s >>>= 0;
      return s / 4294967296;
    };
  }
  function once(fn) {
    var done = false;
    return function () { if (done) return; done = true; fn(); };
  }

  /* ==========================================================================
   * 2. Musical data
   * --------------------------------------------------------------------------
   * Melodies are [scaleDegree, stepInBar(0..15)] pairs over a pentatonic scale;
   * bass lines are [noteName, stepInBar] pairs; pads are chord voicings per bar.
   * Note length is derived from the gap to the next onset (capped per track),
   * which keeps lines legato/natural without hand-writing durations.
   * ======================================================================== */

  /* --- 'lobby' : 76 BPM, 8 bars, D major pentatonic, I-vi-IV-V-I-vi-V-I ---- */
  var LOBBY_LEAD = [   // degrees: 0=D 1=E 2=F# 3=A 4=B 5=D' 6=E' 7=F#' 8=A' 9=B'
    [[0, 0], [2, 2], [4, 4], [2, 6], [1, 8], [2, 10], [0, 12]],                    // D
    [[4, 0], [5, 2], [2, 4], [5, 6], [4, 8], [3, 10], [2, 12]],                    // Bm
    [[5, 0], [4, 2], [3, 4], [4, 6], [5, 8], [4, 10], [3, 12]],                    // G
    [[3, 0], [1, 2], [2, 4], [1, 6], [4, 8], [3, 10], [2, 12], [1, 14]],           // A
    [[2, 0], [4, 2], [5, 4], [4, 6], [2, 8], [1, 10], [0, 12]],                    // D
    [[5, 0], [4, 2], [2, 4], [4, 6], [5, 8], [6, 10], [5, 12], [4, 14]],           // Bm
    [[1, 0], [3, 2], [4, 4], [3, 6], [2, 8], [1, 10], [0, 12]],                    // A
    [[0, 0], [2, 2], [4, 4], [2, 6], [0, 8]]                                       // D (breathe)
  ];
  var LOBBY_BASS = [
    [['D2', 0], ['A2', 8]],
    [['B2', 0], ['F#2', 8]],
    [['G2', 0], ['D3', 8]],
    [['A2', 0], ['E3', 8]],
    [['D2', 0], ['A2', 8]],
    [['B2', 0], ['D3', 8]],
    [['A2', 0], ['E3', 8]],
    [['D2', 0], ['A2', 8]]
  ];
  var LOBBY_PAD = [
    ['D3', 'A3', 'D4'], ['B2', 'F#3', 'D4'], ['G2', 'D3', 'B3'], ['A2', 'E3', 'C#4'],
    ['D3', 'A3', 'D4'], ['B2', 'D3', 'F#3'], ['A2', 'E3', 'A3'], ['D3', 'F#3', 'A3']
  ];
  var LOBBY_WOOD = [[0], [8], [4], [8], [0], [8], [4, 12], [8]];

  /* --- 'game' : 104 BPM, 16-bar A/B loop, D major pentatonic -------------- */
  var GAME_LEAD = [
    [[4, 0], [5, 2], [7, 4], [5, 6], [4, 8], [2, 10], [4, 12], [5, 14]],           // D   A
    [[7, 0], [5, 2], [4, 4], [5, 6], [7, 8], [8, 10], [7, 12], [5, 14]],           // Bm
    [[8, 0], [7, 2], [5, 4], [7, 6], [8, 8], [9, 10], [8, 12], [7, 14]],           // G
    [[7, 0], [4, 2], [2, 4], [4, 6], [7, 8], [6, 10], [4, 12], [2, 14]],           // A
    [[5, 0], [7, 2], [9, 4], [7, 6], [5, 8], [4, 10], [5, 12], [7, 14]],           // D
    [[5, 0], [4, 2], [2, 4], [4, 6], [5, 8], [7, 10], [5, 12], [4, 14]],           // Bm
    [[4, 0], [6, 2], [7, 4], [6, 6], [4, 8], [2, 10], [1, 12]],                    // A
    [[2, 0], [0, 2], [2, 4], [4, 6], [2, 8], [0, 12]],                             // D cadence
    [[9, 0], [8, 2], [7, 4], [8, 6], [9, 8], [7, 10], [5, 12]],                    // G   B
    [[6, 0], [4, 2], [2, 4], [4, 6], [6, 8], [7, 10], [6, 12], [4, 14]],           // A
    [[7, 0], [5, 2], [4, 4], [5, 6], [7, 8], [5, 10], [4, 12], [2, 14]],           // Bm
    [[4, 0], [2, 2], [1, 4], [2, 6], [4, 8], [6, 10], [7, 12], [6, 14]],           // A
    [[5, 0], [7, 2], [8, 4], [7, 6], [5, 8], [4, 10], [5, 12]],                    // G
    [[7, 0], [6, 2], [4, 4], [6, 6], [7, 8], [9, 10], [7, 12], [6, 14]],           // A
    [[4, 0], [2, 2], [0, 4], [2, 6], [4, 8], [5, 10], [4, 12], [2, 14]],           // D
    [[0, 0], [2, 4], [4, 8], [0, 12]]                                              // D turnaround
  ];
  var GAME_BASS = [
    [['D2', 0], ['A2', 4], ['D3', 8], ['A2', 12]],
    [['B2', 0], ['F#2', 4], ['B2', 8], ['D3', 12]],
    [['G2', 0], ['D3', 4], ['G2', 8], ['B2', 12]],
    [['A2', 0], ['E3', 4], ['A2', 8], ['C#3', 12]],
    [['D2', 0], ['A2', 4], ['D3', 8], ['F#3', 12]],
    [['B2', 0], ['F#2', 4], ['B2', 8], ['D3', 12]],
    [['A2', 0], ['E3', 4], ['A2', 8], ['G2', 12]],
    [['D2', 0], ['A2', 4], ['D2', 8], ['D3', 12]],
    [['G2', 0], ['D3', 4], ['G2', 8], ['B2', 12]],
    [['A2', 0], ['E3', 4], ['A2', 8], ['C#3', 12]],
    [['B2', 0], ['F#2', 4], ['B2', 8], ['D3', 12]],
    [['A2', 0], ['E3', 4], ['A2', 8], ['C#3', 12]],
    [['G2', 0], ['D3', 4], ['G2', 8], ['B2', 12]],
    [['A2', 0], ['E3', 4], ['A2', 8], ['C#3', 12]],
    [['D2', 0], ['A2', 4], ['D3', 8], ['A2', 12]],
    [['D2', 0], ['A2', 4], ['D2', 8], ['A2', 12]]
  ];
  var GAME_PAD = [
    ['D3', 'A3', 'D4'], ['B2', 'F#3', 'D4'], ['G2', 'D3', 'G3'], ['A2', 'E3', 'A3'],
    ['D3', 'A3', 'D4'], ['B2', 'F#3', 'D4'], ['A2', 'E3', 'C#4'], ['D3', 'A3', 'D4'],
    ['G2', 'D3', 'G3'], ['A2', 'E3', 'A3'], ['B2', 'F#3', 'B3'], ['A2', 'E3', 'C#4'],
    ['G2', 'D3', 'G3'], ['A2', 'E3', 'A3'], ['D3', 'A3', 'D4'], ['D3', 'A3', 'D4']
  ];
  // 5 interchangeable light "drum + woodblock" groove cells, cycled per bar.
  // k=kick s=rim/snare h=hat w=woodblock (16th-note step indices)
  var GAME_DRUM_PATS = [
    { k: [0, 8], s: [4, 12], h: [2, 6, 10, 14], w: [7] },
    { k: [0, 8, 14], s: [4, 12], h: [2, 6, 10, 15], w: [3] },
    { k: [0, 6, 8], s: [4, 12], h: [2, 10, 14], w: [11] },
    { k: [0, 8], s: [4, 12], h: [2, 6, 10, 14], w: [6, 11] },
    { k: [0, 3, 8, 14], s: [4, 12], h: [2, 6, 10, 15], w: [] }
  ];
  var GAME_DRUM_ORDER = [0, 1, 0, 2, 0, 1, 3, 2, 0, 1, 0, 2, 4, 1, 3, 2];

  /* --- 'tense' : 132 BPM, 8 bars, A minor pentatonic (Am-F-G) ------------- */
  var TENSE_LEAD = [   // degrees: 0=A 1=C 2=D 3=E 4=G 5=A' 6=C' 7=D' 8=E' 9=G' 10=A''
    [[0, 0], [0, 2], [2, 4], [0, 6], [4, 8], [3, 10], [2, 12], [0, 14]],           // Am
    [[5, 0], [7, 2], [5, 4], [4, 6], [3, 8], [4, 10], [2, 12], [0, 14]],           // Am
    [[4, 0], [1, 2], [3, 4], [1, 6], [4, 8], [5, 10], [4, 12], [1, 14]],           // F
    [[7, 0], [4, 2], [7, 4], [9, 6], [7, 8], [4, 10], [2, 12]],                    // G
    [[0, 0], [2, 2], [4, 4], [5, 6], [4, 8], [3, 10], [2, 12], [1, 14]],           // Am
    [[5, 0], [4, 2], [3, 4], [1, 6], [3, 8], [4, 10], [5, 12], [7, 14]],           // F
    [[9, 0], [7, 2], [9, 4], [10, 6], [9, 8], [7, 10], [5, 12], [4, 14]],          // G
    [[5, 0], [4, 2], [2, 4], [0, 8], [0, 12]]                                      // Am (loop point)
  ];
  // driving octave bass: root on every 8th
  function drive(low, high) {
    return [[low, 0], [high, 2], [low, 4], [high, 6], [low, 8], [high, 10], [low, 12], [high, 14]];
  }
  var TENSE_BASS = [
    drive('A1', 'A2'), drive('A1', 'A2'), drive('F1', 'F2'), drive('G1', 'G2'),
    drive('A1', 'A2'), drive('F1', 'F2'), drive('G1', 'G2'),
    [['A1', 0], ['A2', 2], ['A1', 4], ['A2', 6], ['A1', 8], ['A2', 10], ['E2', 12], ['F2', 14]]
  ];
  var TENSE_PAD = [   // tremolo string voicings (root + fifth + octave)
    ['A2', 'E3', 'A3'], ['A2', 'E3', 'A3'], ['F2', 'C3', 'F3'], ['G2', 'D3', 'G3'],
    ['A2', 'E3', 'A3'], ['F2', 'C3', 'F3'], ['G2', 'D3', 'G3'], ['A2', 'E3', 'A3']
  ];
  var TENSE_TAIKO = [   // T = strong taiko hit, g = ghost hit (step indices)
    { T: [0, 6, 12], g: [3, 10] },
    { T: [0, 6, 12], g: [3, 8, 10, 14] },
    { T: [0, 4, 8, 12], g: [6, 10, 14] },
    { T: [0, 6, 10, 14], g: [3, 8, 12] }
  ];
  var TENSE_TAIKO_ORDER = [0, 1, 0, 2, 0, 1, 3, 2];
  var TENSE_HATS = { h: [2, 6, 10, 14] };

  var TRACKS = {
    lobby: {
      bpm: 76, bars: 8, stepsPerBar: 16,
      key: 'D major pentatonic', name: 'Lobby',
      lead: { pat: LOBBY_LEAD, base: 62, pent: PENT_MAJOR, gain: 0.30, maxGate: 4, gateScale: 1.0, grace: 0.03, pan: 0.28 },
      bass: { pat: LOBBY_BASS, gain: 0.34, durSteps: 7.4 },
      pad: { chords: LOBBY_PAD, gain: 0.055, atk: 0.35, rel: 0.9 },
      wood: LOBBY_WOOD, woodGain: 0.20,
      seed: 0x10BB1
    },
    game: {
      bpm: 104, bars: 16, stepsPerBar: 16,
      key: 'D major pentatonic', name: 'Game',
      lead: { pat: GAME_LEAD, base: 62, pent: PENT_MAJOR, gain: 0.26, maxGate: 3, gateScale: 0.85, grace: 0.10, pan: 0.34 },
      bass: { pat: GAME_BASS, gain: 0.30, durSteps: 3.3 },
      pad: { chords: GAME_PAD, gain: 0.040, atk: 0.22, rel: 0.55 },
      drums: GAME_DRUM_PATS, drumOrder: GAME_DRUM_ORDER,
      drumGain: { k: 0.50, s: 0.30, h: 0.13, w: 0.24 },
      seed: 0x2AAB3
    },
    tense: {
      bpm: 132, bars: 8, stepsPerBar: 16,
      key: 'A minor pentatonic', name: 'Tense',
      lead: { pat: TENSE_LEAD, base: 57, pent: PENT_MINOR, gain: 0.22, maxGate: 2, gateScale: 0.6, grace: 0.05, pan: 0.22 },
      bass: { pat: TENSE_BASS, gain: 0.42, durSteps: 1.7 },
      pad: { chords: TENSE_PAD, gain: 0.075, atk: 0.30, rel: 0.35, trem: true, tremRate: 11.5, tremDepth: 0.5 },
      taiko: TENSE_TAIKO, taikoOrder: TENSE_TAIKO_ORDER, hats: TENSE_HATS,
      drumGain: { T: 0.55, g: 0.22, h: 0.11 },
      seed: 0x3CCD7
    }
  };

  /* ==========================================================================
   * 3. Engine state
   * ======================================================================== */

  var MUSIC_LEVEL = 0.22;    // ~ -13 dB relative to the SFX bus (which sits at 0.85)
  var CROSSFADE = 1.2;       // seconds
  var LOOKAHEAD = 0.15;      // seconds of audio scheduled ahead
  var TICK_MS = 25;          // scheduler tick
  var MAX_SFX_VOICES = 24;   // concurrent one-shot cap

  var ctx = null;
  var master = null, comp = null, shaper = null;
  var sfxBus = null, sfxSend = null;
  var reverbIn = null, reverbWet = null;
  var noiseBuf = null;

  var instances = [];        // active (or fading) BGM track instances
  var currentName = null;    // track that is playing / fading in
  var desiredName = null;    // last requested track (used by setBgmEnabled)
  var bgmEnabled = true, sfxEnabled = true, speakEnabled = false;
  var bgmVolume = 0.8, sfxVolume = 0.85;
  var unlocked = false;
  var schedTimer = null;
  var voiceCount = 0;
  var seedCounter = 1;
  var pendingTimers = [];

  var stats = {
    notes: { lobby: 0, game: 0, tense: 0 },
    steps: 0,
    dropped: 0,
    activeVoices: 0,
    reset: function () {
      this.notes.lobby = 0; this.notes.game = 0; this.notes.tense = 0;
      this.steps = 0; this.dropped = 0;
    }
  };
  var internalViolations = 0;
  function violate() { internalViolations++; }

  // Timers that must not keep a Node test process alive, and must be clearable.
  function later(fn, ms) {
    var id = setTimeout(function () {
      var i = pendingTimers.indexOf(id);
      if (i >= 0) pendingTimers.splice(i, 1);
      try { fn(); } catch (e) { /* never throw out of a timer */ }
    }, ms);
    if (id && typeof id.unref === 'function') id.unref();
    pendingTimers.push(id);
    return id;
  }

  /* ==========================================================================
   * 4. Node helpers (defensive: one bad call must never break the game)
   * ======================================================================== */

  function stopSrc(src, when) {
    if (!src || typeof src.stop !== 'function') return;
    try { src.stop(when); } catch (e) { violate(); }
  }
  function startSrc(src, when, offset) {
    if (!src || typeof src.start !== 'function') return false;
    try {
      if (offset !== undefined) src.start(when, offset);
      else src.start(when);
      return true;
    } catch (e) { violate(); return false; }
  }
  // Disconnect everything once `tail` has finished; optionally release a voice
  // slot. Called for every voice so long sessions do not leak nodes.
  function finish(tail, nodes, release) {
    if (!tail) {
      var i;
      for (i = 0; i < nodes.length; i++) { try { nodes[i].disconnect(); } catch (e) {} }
      if (release) release();
      return;
    }
    tail.onended = function () {
      tail.onended = null;
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i] && nodes[i] !== tail) { try { nodes[i].disconnect(); } catch (e) {} }
      }
      try { tail.disconnect(); } catch (e) {}
      if (release) release();
    };
  }
  function setParam(p, v, t) {
    if (!p) return;
    try {
      if (t === undefined || typeof p.setValueAtTime !== 'function') p.value = v;
      else p.setValueAtTime(v, t);
    } catch (e) { violate(); }
  }
  function expTo(p, v, t) {
    if (!p) return;
    if (!(v > 0)) v = 0.0001;
    if (!(t > 0)) t = 0.0001;
    if (typeof p.exponentialRampToValueAtTime !== 'function') { try { p.value = v; } catch (e) {} return; }
    try { p.exponentialRampToValueAtTime(v, t); } catch (e) { violate(); }
  }
  function linTo(p, v, t) {
    if (!p) return;
    if (typeof p.linearRampToValueAtTime !== 'function') { try { p.value = v; } catch (e) {} return; }
    try { p.linearRampToValueAtTime(v, t); } catch (e) { violate(); }
  }
  function connect(a, b) {
    if (!a || !b || typeof a.connect !== 'function') { violate(); return; }
    try { a.connect(b); } catch (e) { violate(); }
  }
  function gainNode(v) {
    var g = ctx.createGain();
    setParam(g.gain, v);
    return g;
  }
  function filt(type, freq, q) {
    var f = ctx.createBiquadFilter();
    f.type = type;
    setParam(f.frequency, freq);
    if (q !== undefined) setParam(f.Q, q);
    return f;
  }

  /* ==========================================================================
   * 5. Master chain + reverb
   * --------------------------------------------------------------------------
   * sources -> bus gain -> master -> compressor -> soft-clip -> destination
   * ======================================================================== */

  function softClipCurve() {
    var n = 1024, curve = new Float32Array(n), i, x;
    for (i = 0; i < n; i++) {
      x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * 1.45) / Math.tanh(1.45);
    }
    return curve;
  }

  function buildReverb() {
    reverbIn = gainNode(1);
    reverbWet = gainNode(0.5);
    connect(reverbWet, master);
    // two damped feedback-delay lines = small warm room
    var spec = [[0.113, 0.34, 2600, 0.55], [0.191, 0.28, 1900, 0.42]];
    for (var i = 0; i < spec.length; i++) {
      var d = ctx.createDelay(1.0);
      setParam(d.delayTime, spec[i][0]);
      var lp = filt('lowpass', spec[i][2], 0.5);
      var fb = gainNode(spec[i][1]);
      var out = gainNode(spec[i][3]);
      connect(reverbIn, d); connect(d, lp); connect(lp, fb); connect(fb, d);
      connect(d, out); connect(out, reverbWet);
    }
  }

  function buildChain() {
    master = gainNode(0.9);
    comp = ctx.createDynamicsCompressor();
    var p;
    p = comp.threshold; setParam(p, -12);
    p = comp.knee;      setParam(p, 16);
    p = comp.ratio;     setParam(p, 4);
    p = comp.attack;    setParam(p, 0.004);
    p = comp.release;   setParam(p, 0.25);
    shaper = ctx.createWaveShaper();
    try { shaper.curve = softClipCurve(); shaper.oversample = '2x'; } catch (e) {}
    connect(master, comp); connect(comp, shaper); connect(shaper, ctx.destination);

    sfxBus = gainNode(0.85 * sfxVolume);
    connect(sfxBus, master);
    sfxSend = gainNode(0.10);
    connect(sfxBus, sfxSend);

    buildReverb();
    connect(sfxSend, reverbIn);

    // one shared white-noise buffer (2 s), reused by every noise voice
    try {
      var sr = ctx.sampleRate || 44100;
      noiseBuf = ctx.createBuffer(1, Math.max(1024, Math.floor(sr * 2)), sr);
      var data = noiseBuf.getChannelData(0);
      var rng = makeRng(0x51F7A3);
      for (var i = 0; i < data.length; i++) data[i] = rng() * 2 - 1;
    } catch (e) { noiseBuf = null; }
  }

  /* ==========================================================================
   * 6. Voices - music
   * ======================================================================== */

  // --- Karplus-Strong plucked string, rendered into an AudioBuffer and cached.
  // noise burst -> delay line (period) -> one-pole lowpass -> feedback, with
  // frequency-independent decay time and a de-clicked head/tail.
  var ksCache = {};
  var ksCount = 0;
  function getKSBuffer(freq) {
    if (!ctx || !freq || freq <= 20 || freq > 5000) return null;
    var key = (freq * 2 | 0);
    var hit = ksCache[key];
    if (hit) return hit;
    if (typeof ctx.createBuffer !== 'function') return null;
    try {
      var sr = ctx.sampleRate || 44100;
      var tau = 1.15;                       // seconds to -60 dB
      var dur = 1.9;
      var len = Math.max(256, Math.floor(dur * sr));
      var buf = ctx.createBuffer(1, len, sr);
      var out = buf.getChannelData(0);
      var N = Math.max(2, Math.round(sr / freq));
      var line = new Float32Array(N);
      var i;
      var rng = makeRng(key * 2654435761);
      for (i = 0; i < N; i++) line[i] = rng() * 2 - 1;
      var damp = Math.exp(-1 / (sr * tau));
      var idx = 0, prev = 0, s, v;
      for (i = 0; i < len; i++) {
        s = line[idx];
        out[i] = s;
        v = 0.5 * (s + prev);               // one-pole lowpass -> high partials die first
        prev = s;
        line[idx] = v * damp;
        idx++; if (idx >= N) idx = 0;
      }
      // de-click head/tail + gain trim
      var head = Math.max(2, Math.floor(sr * 0.0016));
      for (i = 0; i < head; i++) out[i] *= i / head;
      var tailN = Math.max(2, Math.floor(sr * 0.05));
      for (i = 0; i < tailN; i++) out[len - 1 - i] *= i / tailN;
      for (i = 0; i < len; i++) out[i] *= 0.62;
      // A delay line of N whole samples can only sound at sr/N, so carry the
      // fractional-delay correction as a playback rate: the note ends up exactly
      // in tune (worst case here is ~15 cents flat at the top of the range).
      var entry = { buf: buf, rate: freq / (sr / N) };
      if (ksCount > 320) { ksCache = {}; ksCount = 0; }
      ksCache[key] = entry; ksCount++;
      return entry;
    } catch (e) { return null; }
  }

  // Plucked-string voice: cached Karplus-Strong body + a short pick transient,
  // through a lowpass whose cutoff closes as the note decays.
  function voicePluck(dest, freq, t, dur, amp, pan) {
    if (!ctx || !(freq > 0) || !(amp > 0)) return;
    var nodes = [];
    var gate = Math.max(0.055, dur);
    var g = ctx.createGain(); nodes.push(g);
    setParam(g.gain, 0.0001, t);
    linTo(g.gain, amp, t + 0.004);
    expTo(g.gain, 0.0001, t + gate);
    var lp = filt('lowpass', Math.min(9500, freq * 9 + 800), 0.8);
    nodes.push(lp);
    try {
      lp.frequency.setValueAtTime(Math.min(9500, freq * 9 + 800), t);
      lp.frequency.exponentialRampToValueAtTime(Math.max(320, freq * 2.6), t + gate);
    } catch (e) {}
    connect(lp, g);
    if (pan && typeof ctx.createStereoPanner === 'function') {
      var pn = ctx.createStereoPanner(); nodes.push(pn);
      setParam(pn.pan, clamp(pan, -1, 1));
      connect(g, pn); connect(pn, dest);
    } else {
      connect(g, dest);
    }

    var body = getKSBuffer(freq);
    var tail = null, tailEnd = t + gate;
    if (body) {
      var src = ctx.createBufferSource(); nodes.push(src);
      src.buffer = body.buf;
      setParam(src.playbackRate, body.rate);   // fractional-delay tuning fix
      connect(src, lp);
      if (startSrc(src, t)) { tail = src; tailEnd = t + Math.max(gate, 1.3); stopSrc(src, tailEnd); }
    } else {
      // 2-oscillator fallback pluck (still musical if buffers are unavailable)
      var o1 = ctx.createOscillator(); nodes.push(o1);
      o1.type = 'triangle';
      setParam(o1.frequency, freq, t);
      var o2 = ctx.createOscillator(); nodes.push(o2);
      o2.type = 'sine';
      setParam(o2.frequency, freq * 2, t);
      var g2 = gainNode(0.28); nodes.push(g2);
      connect(o1, lp); connect(o2, g2); connect(g2, lp);
      startSrc(o1, t); startSrc(o2, t);
      tailEnd = t + gate + 0.02;
      stopSrc(o1, tailEnd); stopSrc(o2, tailEnd);
      tail = o1;
    }
    // pick transient
    if (noiseBuf) {
      var nz = ctx.createBufferSource(); nodes.push(nz);
      nz.buffer = noiseBuf;
      var nf = filt('bandpass', Math.min(6000, freq * 4 + 1200), 1.1); nodes.push(nf);
      var ng = ctx.createGain(); nodes.push(ng);
      setParam(ng.gain, 0.0001, t);
      linTo(ng.gain, amp * 0.32, t + 0.0015);
      expTo(ng.gain, 0.0001, t + 0.022);
      connect(nz, nf); connect(nf, ng); connect(ng, dest);
      if (startSrc(nz, t, Math.abs((freq * 0.137) % 1.5))) stopSrc(nz, t + 0.04);
    }
    finish(tail, nodes, null);
  }

  // Soft bass: triangle + sine, lowpassed, gentle attack.
  function voiceBass(dest, freq, t, dur, amp) {
    if (!ctx || !(freq > 0) || !(amp > 0)) return;
    var nodes = [];
    var d = Math.max(0.12, dur);
    var g = ctx.createGain(); nodes.push(g);
    setParam(g.gain, 0.0001, t);
    linTo(g.gain, amp, t + 0.014);
    expTo(g.gain, amp * 0.55, t + 0.09);
    expTo(g.gain, 0.0001, t + d);
    var lp = filt('lowpass', Math.min(1400, freq * 6 + 220), 0.7); nodes.push(lp);
    connect(lp, g); connect(g, dest);
    var o1 = ctx.createOscillator(); nodes.push(o1);
    o1.type = 'triangle'; setParam(o1.frequency, freq, t);
    var o2 = ctx.createOscillator(); nodes.push(o2);
    o2.type = 'sine'; setParam(o2.frequency, freq, t); setParam(o2.detune, -7);
    var g2 = gainNode(0.6); nodes.push(g2);
    connect(o1, lp); connect(o2, g2); connect(g2, lp);
    startSrc(o1, t); startSrc(o2, t);
    stopSrc(o1, t + d + 0.02); stopSrc(o2, t + d + 0.02);
    finish(o1, nodes, null);
  }

  // Pad / tremolo strings: 2 detuned saws per chord tone -> lowpass (+ LFO) and
  // a slow amplitude envelope. `trem` adds a fast amplitude tremolo.
  function voicePad(dest, freqs, t, dur, amp, opts) {
    if (!ctx || !freqs || !freqs.length || !(amp > 0)) return;
    opts = opts || {};
    var nodes = [];
    var atk = opts.atk !== undefined ? opts.atk : 0.3;
    var rel = opts.rel !== undefined ? opts.rel : 0.7;
    var g = ctx.createGain(); nodes.push(g);
    setParam(g.gain, 0.0001, t);
    linTo(g.gain, amp, t + atk);
    setParam(g.gain, amp * 0.85, t + Math.max(atk, dur));
    expTo(g.gain, 0.0001, t + dur + rel);
    var lp = filt('lowpass', opts.cutoff || 1500, 0.4); nodes.push(lp);
    connect(lp, g); connect(g, dest);
    // slow filter movement
    var lfo = ctx.createOscillator(); nodes.push(lfo);
    lfo.type = 'sine';
    setParam(lfo.frequency, opts.lfoRate || 0.11);
    var lfoG = gainNode(opts.lfoDepth || 320); nodes.push(lfoG);
    connect(lfo, lfoG); connect(lfoG, lp.frequency);
    startSrc(lfo, t); stopSrc(lfo, t + dur + rel + 0.05);
    if (opts.trem) {   // tremolo strings on the tense track
      // The LFO is *added* to the envelope automation on g.gain, so its depth
      // must be relative to this voice's amplitude (never an absolute gain).
      var depth = Math.min(0.5, (opts.tremDepth === undefined ? 0.45 : opts.tremDepth)) * amp * 0.85;
      var tg = gainNode(depth); nodes.push(tg);
      var tl = ctx.createOscillator(); nodes.push(tl);
      tl.type = 'sine';
      setParam(tl.frequency, opts.tremRate || 11);
      connect(tl, tg); connect(tg, g.gain);
      startSrc(tl, t); stopSrc(tl, t + dur + rel + 0.05);
    }
    var tail = null, end = t + dur + rel + 0.02;
    for (var i = 0; i < freqs.length; i++) {
      var f = freqs[i];
      var pairs = [[0, 'sawtooth', 0.30], [6, 'sawtooth', 0.30], [-5, 'triangle', 0.5]];
      for (var k = 0; k < pairs.length; k++) {
        var o = ctx.createOscillator(); nodes.push(o);
        o.type = pairs[k][1];
        setParam(o.frequency, f, t);
        setParam(o.detune, pairs[k][0]);
        var og = gainNode(pairs[k][2]); nodes.push(og);
        connect(o, og); connect(og, lp);
        startSrc(o, t);
        stopSrc(o, end);
        if (!tail) tail = o;
      }
    }
    finish(tail, nodes, null);
  }

  /* --- percussion ------------------------------------------------------- */
  function noiseSource(t, offset) {
    if (!noiseBuf) return null;
    var s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    // loop + explicit stop() means a sweep longer than the buffer still works
    try { s.loop = true; } catch (e) {}
    if (!startSrc(s, t, offset === undefined ? 0.37 : offset)) return null;
    return s;
  }

  function voiceKick(dest, t, amp) {
    var nodes = [];
    var o = ctx.createOscillator(); nodes.push(o);
    o.type = 'sine';
    setParam(o.frequency, 140, t);
    try {
      o.frequency.setValueAtTime(140, t);
      o.frequency.exponentialRampToValueAtTime(46, t + 0.13);
    } catch (e) {}
    var g = ctx.createGain(); nodes.push(g);
    setParam(g.gain, 0.0001, t);
    linTo(g.gain, amp, t + 0.005);
    expTo(g.gain, 0.0001, t + 0.26);
    connect(o, g); connect(g, dest);
    startSrc(o, t); stopSrc(o, t + 0.28);
    finish(o, nodes, null);
  }
  function voiceSnare(dest, t, amp) {
    var nodes = [];
    var s = noiseSource(t, ((t * 3.7) % 1.4)); if (!s) return; nodes.push(s);
    var bp = filt('bandpass', 1900, 1.0); nodes.push(bp);
    var g = ctx.createGain(); nodes.push(g);
    setParam(g.gain, 0.0001, t);
    linTo(g.gain, amp, t + 0.003);
    expTo(g.gain, 0.0001, t + 0.11);
    connect(s, bp); connect(bp, g); connect(g, dest);
    stopSrc(s, t + 0.13);
    finish(s, nodes, null);
  }
  function voiceHat(dest, t, amp) {
    var nodes = [];
    var s = noiseSource(t, ((t * 5.1) % 1.4)); if (!s) return; nodes.push(s);
    var hp = filt('highpass', 7200, 0.7); nodes.push(hp);
    var g = ctx.createGain(); nodes.push(g);
    setParam(g.gain, 0.0001, t);
    linTo(g.gain, amp, t + 0.002);
    expTo(g.gain, 0.0001, t + 0.042);
    connect(s, hp); connect(hp, g); connect(g, dest);
    stopSrc(s, t + 0.05);
    finish(s, nodes, null);
  }
  function voiceWoodblock(dest, t, amp) {
    var nodes = [];
    var o = ctx.createOscillator(); nodes.push(o);
    o.type = 'triangle';
    setParam(o.frequency, 1180, t);
    var o2 = ctx.createOscillator(); nodes.push(o2);
    o2.type = 'square';
    setParam(o2.frequency, 1770, t);
    var lp = filt('bandpass', 2100, 2.2); nodes.push(lp);
    var g = ctx.createGain(); nodes.push(g);
    setParam(g.gain, 0.0001, t);
    linTo(g.gain, amp, t + 0.002);
    expTo(g.gain, 0.0001, t + 0.075);
    var g2 = gainNode(0.25); nodes.push(g2);
    connect(o, lp); connect(o2, g2); connect(g2, lp); connect(lp, g); connect(g, dest);
    startSrc(o, t); startSrc(o2, t);
    stopSrc(o, t + 0.09); stopSrc(o2, t + 0.09);
    finish(o, nodes, null);
  }
  function voiceTaiko(dest, t, amp) {
    var nodes = [];
    var o = ctx.createOscillator(); nodes.push(o);
    o.type = 'sine';
    setParam(o.frequency, 150, t);
    try {
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(52, t + 0.22);
    } catch (e) {}
    var g = ctx.createGain(); nodes.push(g);
    setParam(g.gain, 0.0001, t);
    linTo(g.gain, amp, t + 0.004);
    expTo(g.gain, 0.0001, t + 0.42);
    connect(o, g); connect(g, dest);
    startSrc(o, t); stopSrc(o, t + 0.45);
    var s = noiseSource(t, ((t * 2.3) % 1.4));
    if (s) {
      nodes.push(s);
      var lpn = filt('lowpass', 420, 0.7); nodes.push(lpn);
      var gn = ctx.createGain(); nodes.push(gn);
      setParam(gn.gain, 0.0001, t);
      linTo(gn.gain, amp * 0.55, t + 0.003);
      expTo(gn.gain, 0.0001, t + 0.16);
      connect(s, lpn); connect(lpn, gn); connect(gn, dest);
      stopSrc(s, t + 0.18);
    }
    finish(o, nodes, null);
  }

  /* ==========================================================================
   * 7. BGM: lookahead scheduler, track instances, crossfade
   * ======================================================================== */

  function TrackInstance(name) {
    var def = TRACKS[name];
    this.name = name;
    this.def = def;
    this.kind = 'music';
    this.step = 0;
    this.nextTime = ctx.currentTime + 0.09;
    this.stopAt = 0;
    this.dead = false;
    this.notes = 0;
    this.rng = makeRng(def.seed + (seedCounter++) * 7919);

    this.bus = ctx.createGain();
    setParam(this.bus.gain, 0.0001, ctx.currentTime);
    var target = MUSIC_LEVEL * bgmVolume * (bgmEnabled ? 1 : 0);
    linTo(this.bus.gain, Math.max(0.0001, target), ctx.currentTime + CROSSFADE);
    connect(this.bus, master);
    this.send = gainNode(0.34);
    connect(this.bus, this.send);
    connect(this.send, reverbIn);
  }
  TrackInstance.prototype.fade = function (to, secs) {
    var now = ctx.currentTime;
    try {
      if (typeof this.bus.gain.cancelScheduledValues === 'function') this.bus.gain.cancelScheduledValues(now);
    } catch (e) {}
    setParam(this.bus.gain, Math.max(0.0001, this.lastGain === undefined ? MUSIC_LEVEL * bgmVolume : this.lastGain), now);
    linTo(this.bus.gain, Math.max(0.0001, to), now + Math.max(0.05, secs));
    this.lastGain = to;
  };
  TrackInstance.prototype.retire = function () {
    this.dead = true;
    try { this.bus.disconnect(); } catch (e) {}
    try { this.send.disconnect(); } catch (e) {}
  };
  TrackInstance.prototype.level = function () {
    return MUSIC_LEVEL * bgmVolume * (bgmEnabled ? 1 : 0);
  };

  function leadGate(pat, i, maxGate) {
    var step = pat[i][1];
    var next = (i + 1 < pat.length) ? pat[i + 1][1] : 16;
    var gap = next - step;
    if (!(gap > 0)) gap = maxGate;
    return Math.min(gap, maxGate);
  }

  function scheduleStep(inst, step, t, stepDur) {
    var def = inst.def;
    var spb = def.stepsPerBar;
    var bar = Math.floor(step / spb) % def.bars;
    var beat = step % spb;
    var rng = inst.rng;
    var notes = 0;
    var i, ev, amp, tj;

    // ---- plucked-string lead (with humanized timing/velocity + grace notes)
    if (def.lead) {
      var pat = def.lead.pat[bar];
      if (pat) {
        for (i = 0; i < pat.length; i++) {
          if (pat[i][1] !== beat) continue;
          var midi = degToMidi(pat[i][0], def.lead.base, def.lead.pent);
          var gate = leadGate(pat, i, def.lead.maxGate) * stepDur * def.lead.gateScale;
          amp = def.lead.gain * (0.86 + rng() * 0.28);
          tj = t + (rng() * 2 - 1) * 0.009;
          var pan = def.lead.pan ? ((beat % 4 === 0 ? -1 : 1) * def.lead.pan * (0.5 + rng() * 0.6)) : 0;
          voicePluck(inst.bus, midiToFreq(midi), tj, gate, amp, pan);
          notes++;
          // decoration only: an occasional grace note a 16th before the beat
          if (def.lead.grace && rng() < def.lead.grace) {
            var gi = pat[i][0] + (rng() < 0.5 ? 1 : -1);
            voicePluck(inst.bus, midiToFreq(degToMidi(gi, def.lead.base, def.lead.pent)),
              Math.max(inst.nextTime - 0.03, tj - stepDur * 0.5), stepDur * 0.5, amp * 0.4, pan * 0.5);
          }
        }
      }
    }

    // ---- bass
    if (def.bass) {
      var bp = def.bass.pat[bar] || [];
      for (i = 0; i < bp.length; i++) {
        if (bp[i][1] !== beat) continue;
        voiceBass(inst.bus, noteToFreq(bp[i][0]), t, def.bass.durSteps * stepDur,
          def.bass.gain * (0.9 + rng() * 0.16));
        notes++;
      }
    }

    // ---- pad / tremolo strings (one event per bar, on beat 0)
    if (beat === 0 && def.pad) {
      var chord = def.pad.chords[bar] || [];
      var freqs = [];
      for (i = 0; i < chord.length; i++) freqs.push(noteToFreq(chord[i]));
      var barDur = stepDur * spb;
      voicePad(inst.bus, freqs, t, barDur * 0.96, def.pad.gain, {
        atk: def.pad.atk, rel: def.pad.rel, trem: def.pad.trem,
        tremRate: def.pad.tremRate, tremDepth: def.pad.tremDepth,
        cutoff: def.pad.trem ? 2100 : 1500
      });
      notes++;
    }

    // ---- percussion (each instrument's pattern is a list of 16th steps, so
    //      the same code serves every step of the bar)
    var dr = null;
    if (def.drums) dr = def.drums[def.drumOrder[bar] % def.drums.length];
    var tg = def.drumGain || {};
    if (dr) {
      for (i = 0; i < dr.k.length; i++) if (dr.k[i] === beat) { voiceKick(inst.bus, t, tg.k * (0.9 + rng() * 0.2)); notes++; }
      for (i = 0; i < dr.s.length; i++) if (dr.s[i] === beat) { voiceSnare(inst.bus, t, tg.s); notes++; }
      for (i = 0; i < dr.h.length; i++) if (dr.h[i] === beat) { voiceHat(inst.bus, t, tg.h * (0.8 + rng() * 0.35)); notes++; }
      for (i = 0; i < dr.w.length; i++) if (dr.w[i] === beat) { voiceWoodblock(inst.bus, t, tg.w); notes++; }
    }
    var tk = def.taiko ? def.taiko[def.taikoOrder[bar] % def.taiko.length] : null;
    if (tk) {
      for (i = 0; i < tk.T.length; i++) if (tk.T[i] === beat) { voiceTaiko(inst.bus, t, tg.T); notes++; }
      for (i = 0; i < tk.g.length; i++) if (tk.g[i] === beat) { voiceTaiko(inst.bus, t, tg.g); notes++; }
    }
    if (def.hats) {
      for (i = 0; i < def.hats.h.length; i++) if (def.hats.h[i] === beat) { voiceHat(inst.bus, t, tg.h * (0.8 + rng() * 0.3)); notes++; }
    }
    if (def.wood) {
      var w = def.wood[bar] || [];
      for (i = 0; i < w.length; i++) if (w[i] === beat) { voiceWoodblock(inst.bus, t, def.woodGain); notes++; }
    }

    inst.notes += notes;
    stats.notes[inst.name] = (stats.notes[inst.name] || 0) + notes;
  }

  function scheduleInstance(inst, target) {
    var stepDur = 60 / inst.def.bpm / 4;   // one 16th note
    var guard = 0;
    while (!inst.dead && inst.nextTime < target && guard < 2048) {
      scheduleStep(inst, inst.step, inst.nextTime, stepDur);
      inst.step++;
      inst.nextTime += stepDur;
      stats.steps++;
      guard++;
    }
    return guard;
  }

  // Retire tracks whose crossfade-out has finished (driven by the audio clock,
  // so no per-track timers and no drift).
  function reap() {
    if (!ctx) return;
    for (var i = instances.length - 1; i >= 0; i--) {
      var inst = instances[i];
      if (!inst.dead && inst.stopAt && ctx.currentTime >= inst.stopAt) {
        inst.retire();
        instances.splice(i, 1);
      }
    }
  }

  // Test hook: schedule as if `seconds` of audio time had elapsed.
  function pump(seconds) {
    if (!ctx) return 0;
    reap();
    var target = ctx.currentTime + (typeof seconds === 'number' && isFinite(seconds) ? seconds : 0) + LOOKAHEAD;
    var total = 0;
    for (var i = instances.length - 1; i >= 0; i--) {
      var inst = instances[i];
      if (!inst.dead) total += scheduleInstance(inst, target);
    }
    return total;
  }

  function tick() {
    if (!ctx) return;
    try {
      reap();
      pump(0);
    } catch (e) { /* scheduler must never throw */ }
  }

  function startScheduler() {
    if (schedTimer !== null || typeof setInterval !== 'function') return;
    schedTimer = setInterval(tick, TICK_MS);
    if (schedTimer && typeof schedTimer.unref === 'function') schedTimer.unref();
  }
  function stopScheduler() {
    if (schedTimer === null) return;
    try { clearInterval(schedTimer); } catch (e) {}
    schedTimer = null;
  }

  function playBgm(name) {
    try {
      if (name === null || name === undefined || name === '' || name === 'none' || name === 'stop') {
        desiredName = null;
        stopBgm();
        return;
      }
      if (!TRACKS[name]) return;              // unknown track: ignore, never throw
      desiredName = name;
      if (!ctx) return;
      if (!bgmEnabled) return;
      if (currentName === name) {
        // starting the same track twice must not double-schedule it
        var existing = findInstance(name);
        if (existing && !existing.dead) {
          existing.fade(existing.level(), 0.25);
          return;
        }
      }
      // crossfade out everything else
      for (var i = 0; i < instances.length; i++) {
        var old = instances[i];
        if (old.dead) continue;
        old.fade(0, CROSSFADE);
        old.stopAt = ctx.currentTime + CROSSFADE + 0.05;
      }
      currentName = name;
      var inst = new TrackInstance(name);
      instances.push(inst);
      startScheduler();
      pump(0);
    } catch (e) { /* never throw */ }
  }

  function findInstance(name) {
    for (var i = 0; i < instances.length; i++) {
      if (!instances[i].dead && instances[i].name === name) return instances[i];
    }
    return null;
  }

  function stopBgm() {
    try {
      if (!ctx) { currentName = null; return; }
      currentName = null;
      for (var i = 0; i < instances.length; i++) {
        var inst = instances[i];
        if (inst.dead) continue;
        inst.fade(0, CROSSFADE);
        inst.stopAt = ctx.currentTime + CROSSFADE + 0.05;
      }
    } catch (e) { /* never throw */ }
  }

  /* ==========================================================================
   * 8. SFX: primitives
   * --------------------------------------------------------------------------
   * Every node created while a scope is open is registered and torn down
   * together in onended, so a long session cannot leak nodes.
   * ======================================================================== */

  var CUR = null;   // { nodes: [], parts: [] }

  function N(node) {
    if (CUR && node) CUR.nodes.push(node);
    return node;
  }
  function part(src, end) {
    if (CUR && src) CUR.parts.push({ src: src, end: end });
    return src;
  }
  function openScope() { CUR = { nodes: [], parts: [] }; }
  function closeScope(release) {
    var sc = CUR;
    CUR = null;
    if (!sc) { if (release) release(); return; }
    var best = null;
    for (var i = 0; i < sc.parts.length; i++) {
      if (!best || sc.parts[i].end > best.end) best = sc.parts[i];
    }
    if (best && best.src) {
      stopSrc(best.src, best.end + 0.2);   // small silent tail so envelopes finish
      finish(best.src, sc.nodes, release);
    } else {
      for (var j = 0; j < sc.nodes.length; j++) { try { sc.nodes[j].disconnect(); } catch (e) {} }
      if (release) release();
    }
  }

  // filtered noise burst / sweep
  function nz(t, dur, amp, type, f0, q, f1) {
    if (!ctx || !(amp > 0)) return null;
    var g = N(ctx.createGain());
    setParam(g.gain, 0.0001, t);
    linTo(g.gain, amp, t + Math.min(0.02, Math.max(0.001, dur * 0.25)));
    expTo(g.gain, 0.0001, t + dur);
    connect(g, sfxBus);
    var f = N(filt(type, f0, q));
    if (f1) {
      try {
        f.frequency.setValueAtTime(f0, t);
        f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
      } catch (e) {}
    }
    connect(f, g);
    var s = noiseSource(t, ((t * 1.7) % 1.5));
    if (!s) return null;
    N(s);
    connect(s, f);
    stopSrc(s, t + dur + 0.02);
    part(s, t + dur + 0.02);
    return s;
  }

  // pitched blip / sweep with exponential decay
  function osc1(t, dur, amp, f0, f1, type, atk) {
    if (!ctx || !(amp > 0)) return null;
    var o = N(ctx.createOscillator());
    o.type = type || 'sine';
    setParam(o.frequency, f0, t);
    if (f1 && f1 !== f0) {
      try {
        o.frequency.setValueAtTime(f0, t);
        o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
      } catch (e) {}
    }
    var g = N(ctx.createGain());
    var a = atk === undefined ? Math.min(0.006, dur * 0.3) : atk;
    setParam(g.gain, 0.0001, t);
    linTo(g.gain, amp, t + Math.max(0.001, a));
    expTo(g.gain, 0.0001, t + dur);
    connect(o, g); connect(g, sfxBus);
    if (!startSrc(o, t)) return null;
    stopSrc(o, t + dur + 0.02);
    part(o, t + dur + 0.02);
    return o;
  }

  // bell / gong: partials with inharmonic ratios
  function bell(t, freq, amp, dur, bright) {
    if (!ctx || !(amp > 0)) return null;
    var nodes = [];
    var ratios = [1, 2.01, 3.04, 4.72];
    var gains = [1, bright ? 0.5 : 0.3, bright ? 0.28 : 0.14, 0.07];
    var out = N(ctx.createGain());
    setParam(out.gain, 0.0001, t);
    linTo(out.gain, amp, t + 0.004);
    expTo(out.gain, 0.0001, t + dur);
    connect(out, sfxBus);
    var tail = null, tailEnd = t + dur;
    for (var i = 0; i < ratios.length; i++) {
      var o = N(ctx.createOscillator());
      o.type = i === 0 ? 'sine' : (bright ? 'triangle' : 'sine');
      setParam(o.frequency, freq * ratios[i], t);
      var g = N(ctx.createGain());
      setParam(g.gain, gains[i]);
      connect(o, g); connect(g, out);
      var d = dur * (i === 0 ? 1 : 0.6 / (1 + i * 0.5));
      if (startSrc(o, t)) {
        stopSrc(o, t + d + 0.02);
        if (tailEnd <= t + d + 0.02) { tailEnd = t + d + 0.02; tail = o; }
      }
    }
    // metallic strike transient
    var strike = nz(t, 0.02, amp * 0.5, 'bandpass', freq * 6, 1.5);
    if (strike) part(strike, t + 0.04);
    part(tail, tailEnd + 0.2);
    return tail;
  }

  // sub-bass drop
  function boom(t, amp, dur, f0, f1) {
    if (!ctx || !(amp > 0)) return null;
    var o = N(ctx.createOscillator());
    o.type = 'sine';
    setParam(o.frequency, f0, t);
    try {
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(18, f1), t + dur);
    } catch (e) {}
    var g = N(ctx.createGain());
    setParam(g.gain, 0.0001, t);
    linTo(g.gain, amp, t + 0.008);
    expTo(g.gain, 0.0001, t + dur);
    connect(o, g); connect(g, sfxBus);
    if (!startSrc(o, t)) return null;
    stopSrc(o, t + dur + 0.05);
    part(o, t + dur + 0.05);
    return o;
  }

  // card snap: a crisp flick of noise + a tiny pitched tick
  function snap(t, amp, pitch) {
    var s = nz(t, 0.045, amp, 'bandpass', pitch, 1.4, pitch * 0.45);
    if (s) part(s, t + 0.07);
    var o = osc1(t, 0.03, amp * 0.35, pitch * 1.5, pitch * 0.8, 'triangle');
    if (o) part(o, t + 0.05);
    return s;
  }

  // card flick whoosh (hand movement / dealing)
  function flick(t, amp, dur, f0, f1) {
    var s = nz(t, dur, amp, 'bandpass', f0, 0.9, f1);
    if (s) part(s, t + dur + 0.02);
    return s;
  }

  /* ==========================================================================
   * 9. SFX definitions - one recognizable sound per card type
   * ======================================================================== */

  function PENT_RUN(n) {   // ascending D-major-pentatonic MIDI run
    var out = [], i;
    for (i = 0; i < n; i++) out.push(midiToFreq(degToMidi(i, 62, PENT_MAJOR)));
    return out;
  }

  var SFX = {
    /* --- UI ------------------------------------------------------------- */
    click: function (t) {
      var s = nz(t, 0.035, 0.20, 'bandpass', 2500, 1.3, 1800);
      if (s) part(s, t + 0.05);
      var o = osc1(t, 0.028, 0.10, 1500, 900, 'triangle');
      if (o) part(o, t + 0.05);
    },
    hint: function (t) {
      var o = osc1(t, 0.11, 0.20, 720, 1180, 'sine');
      if (o) part(o, t + 0.13);
      var o2 = osc1(t + 0.03, 0.09, 0.09, 1440, 2360, 'sine');
      if (o2) part(o2, t + 0.15);
    },
    select: function (t) {
      var o = osc1(t, 0.10, 0.16, 640, 620, 'triangle');
      if (o) part(o, t + 0.12);
      var s = nz(t, 0.02, 0.10, 'bandpass', 3600, 1.6);
      if (s) part(s, t + 0.04);
    },

    /* --- dealing / table ------------------------------------------------- */
    deal: function (t, o) {
      var n = o.n, i, tt;
      for (i = 0; i < n; i++) {
        tt = t + i * 0.048;
        flick(tt, 0.16, 0.07, 3200 + (i % 3) * 500, 900);
        snap(tt + 0.03, 0.09, 2300 + (i % 4) * 180);
      }
    },
    flip: function (t) {
      flick(t, 0.30, 0.20, 4200, 620);
      snap(t + 0.16, 0.22, 2800);
      var o = osc1(t + 0.16, 0.10, 0.10, 900, 500, 'triangle');
      if (o) part(o, t + 0.28);
    },

    /* --- bidding --------------------------------------------------------- */
    bid: function (t, o) {
      var p = o.power;                                  // 1..3
      var f = 523.25 * Math.pow(1.122, p - 1) * (p >= 3 ? 1.06 : 1);
      bell(t, f, 0.42, 1.1 + p * 0.35, true);
      bell(t + 0.02, f * 2, 0.16 + p * 0.05, 0.8 + p * 0.3, true);
      if (p >= 2) boom(t, 0.30 + p * 0.06, 0.7 + p * 0.25, 120, 44);
      if (p >= 3) {
        osc1(t + 0.10, 0.35, 0.16, f * 3, f * 4.5, 'sine');
        nz(t + 0.06, 0.5, 0.16, 'highpass', 2600, 0.7, 4200);
      }
    },
    nobid: function (t) {
      var s = nz(t, 0.26, 0.26, 'lowpass', 700, 0.8, 260);
      if (s) part(s, t + 0.29);
      var o = osc1(t, 0.24, 0.22, 320, 150, 'sine');
      if (o) part(o, t + 0.27);
    },
    pass: function (t) {
      var a = osc1(t, 0.075, 0.19, 900, 860, 'triangle');
      if (a) part(a, t + 0.10);
      var b = osc1(t + 0.115, 0.09, 0.17, 690, 660, 'triangle');
      if (b) part(b, t + 0.22);
      var s = nz(t, 0.02, 0.07, 'bandpass', 2200, 1.4);
      if (s) part(s, t + 0.04);
    },

    /* --- card combinations ------------------------------------------------ */
    single: function (t) { snap(t, 0.34, 1900); },
    pair: function (t) {
      snap(t, 0.32, 1750);
      snap(t + 0.075, 0.30, 2150);
    },
    triple: function (t) {
      snap(t, 0.30, 1550);
      snap(t + 0.065, 0.31, 1800);
      snap(t + 0.13, 0.32, 2080);
    },
    triple_single: function (t) {
      snap(t, 0.28, 1500);
      snap(t + 0.06, 0.29, 1720);
      snap(t + 0.12, 0.30, 1980);
      var o = osc1(t + 0.19, 0.14, 0.16, 1180, 900, 'triangle');
      if (o) part(o, t + 0.35);
    },
    triple_pair: function (t) {
      snap(t, 0.27, 1460);
      snap(t + 0.06, 0.28, 1680);
      snap(t + 0.12, 0.29, 1930);
      // trailing two-note chord
      bell(t + 0.20, 587.33, 0.22, 0.55, true);
      bell(t + 0.20, 880.00, 0.18, 0.55, true);
    },
    straight: function (t, o) {
      var n = Math.max(5, Math.min(12, o.n));
      var freqs = PENT_RUN(n);
      var acc = 0, gap = 0.078;
      for (var i = 0; i < n; i++) {
        var oo = osc1(t + acc, 0.20, 0.24, freqs[i], freqs[i], 'triangle');
        if (oo) part(oo, t + acc + 0.22);
        var s = nz(t + acc, 0.022, 0.09, 'bandpass', freqs[i] * 3.2, 1.5);
        if (s) part(s, t + acc + 0.04);
        acc += gap;
        gap = Math.max(0.052, gap * 0.955);            // slight accelerando
      }
      bell(t + acc, freqs[n - 1] * 2, 0.26, 0.75, true);   // bright ping
    },
    straight_pair: function (t, o) {
      var pairs = Math.max(3, Math.min(6, Math.round(o.n / 2)));
      var freqs = PENT_RUN(pairs * 2);
      var acc = 0;
      for (var i = 0; i < pairs; i++) {
        for (var k = 0; k < 2; k++) {
          var f = freqs[i * 2 + k];
          var oo = osc1(t + acc, 0.11, 0.23, f, f, 'triangle');
          if (oo) part(oo, t + acc + 0.13);
          var s = nz(t + acc, 0.02, 0.08, 'bandpass', f * 3.4, 1.5);
          if (s) part(s, t + acc + 0.04);
          acc += 0.062;
        }
        acc += 0.022;
      }
      bell(t + acc, freqs[freqs.length - 1] * 2, 0.22, 0.6, true);
    },
    plane: function (t) {
      // rising whoosh + low rumble + jet sweep
      flick(t, 0.32, 0.55, 420, 2600);
      nz(t, 0.85, 0.30, 'lowpass', 220, 0.9, 420);
      nz(t + 0.05, 0.6, 0.22, 'bandpass', 700, 2.4, 3400);
      osc1(t + 0.5, 0.45, 0.20, 180, 90, 'sine');
      boom(t + 0.62, 0.30, 0.6, 140, 52);
    },
    plane_single: function (t, o) {
      SFX.plane(t);
      var n = Math.max(2, Math.min(6, o.n));
      for (var i = 0; i < n; i++) flick(t + 0.55 + i * 0.055, 0.13, 0.06, 3000 + i * 200, 1100);
    },
    plane_pair: function (t, o) {
      SFX.plane(t);
      var n = Math.max(2, Math.min(8, o.n));
      for (var i = 0; i < n; i++) {
        var tt = t + 0.52 + i * 0.07;
        flick(tt, 0.13, 0.055, 3000 + i * 160, 1100);
        flick(tt + 0.028, 0.11, 0.05, 2600 + i * 160, 1000);
      }
    },
    four_two: function (t) {
      for (var i = 0; i < 4; i++) {
        var tt = t + i * 0.085;
        boom(tt, 0.42, 0.34, 150, 52);
        nz(tt, 0.16, 0.20, 'lowpass', 900, 0.8, 300);
      }
      osc1(t + 0.36, 0.16, 0.18, 500, 380, 'triangle');
      osc1(t + 0.50, 0.16, 0.17, 420, 320, 'triangle');
    },
    four_two_pair: function (t) {
      SFX.four_two(t);
      var base = t + 0.40;
      for (var i = 0; i < 2; i++) {
        var tt = base + i * 0.14;
        osc1(tt, 0.13, 0.15, 560, 470, 'triangle');
        osc1(tt + 0.035, 0.13, 0.14, 660, 540, 'triangle');
      }
    },

    /* --- bombs ----------------------------------------------------------- */
    bomb: function (t) {
      // short pre-silence "gap" (a nearly inaudible riser), then the impact
      nz(t, 0.075, 0.05, 'bandpass', 200, 1.2, 1400);
      var hit = t + 0.085;
      boom(hit, 0.95, 1.15, 165, 27);                      // sub-bass drop
      nz(hit, 0.85, 0.75, 'lowpass', 1600, 0.7, 200);      // explosion body
      nz(hit + 0.01, 0.28, 0.5, 'bandpass', 900, 0.8, 200);
      // metallic debris
      var d = [0.05, 0.12, 0.17, 0.25, 0.34, 0.46];
      for (var i = 0; i < d.length; i++) {
        nz(hit + d[i], 0.10, 0.16 / (1 + i * 0.25), 'bandpass', 1400 + i * 620, 8, 900 + i * 400);
        osc1(hit + d[i], 0.09, 0.07 / (1 + i * 0.3), 2600 + i * 500, 1800 + i * 300, 'triangle');
      }
      // debris tail shimmer
      nz(hit + 0.3, 0.9, 0.06, 'highpass', 3000, 0.8, 1800);
    },
    rocket: function (t) {
      // rising rocket whoosh ... then the biggest hit of the game
      nz(t, 0.75, 0.28, 'bandpass', 300, 3.0, 6000);
      nz(t + 0.05, 0.7, 0.16, 'highpass', 1200, 0.8, 7000);
      osc1(t + 0.05, 0.7, 0.10, 220, 2600, 'sawtooth');
      var hit = t + 0.78;
      SFX.bomb(hit);
      boom(hit + 0.30, 0.85, 1.5, 120, 24);                // boom tail
      osc1(hit + 0.02, 0.9, 0.14, 1800, 300, 'sine');      // falling whistle
      bell(hit + 0.06, 1046.5, 0.24, 1.4, true);
    },

    /* --- scoring ---------------------------------------------------------- */
    spring: function (t) {
      // triumphant major-triad fanfare (D) + bell
      var notes = [587.33, 739.99, 880.00, 1174.66, 1479.98, 1760.00];
      var acc = 0;
      for (var i = 0; i < notes.length; i++) {
        var o = osc1(t + acc, 0.30, 0.26, notes[i], notes[i], 'triangle');
        if (o) part(o, t + acc + 0.32);
        var s = nz(t + acc, 0.03, 0.10, 'bandpass', notes[i] * 2.6, 1.4);
        if (s) part(s, t + acc + 0.05);
        acc += (i < 3 ? 0.10 : 0.085);
      }
      bell(t + acc, 1760, 0.34, 1.6, true);
      bell(t + acc + 0.02, 880, 0.22, 1.4, true);
      for (var k = 0; k < 3; k++) bell(t + acc + 0.25 + k * 0.16, 2349.3 + k * 200, 0.12, 0.7, true);
    },
    anti_spring: function (t) {
      // ironic/darker mirror of the fanfare: minor triad, sour detune
      var notes = [587.33, 698.46, 830.61, 1108.73, 1396.91, 1661.22];
      var acc = 0;
      for (var i = 0; i < notes.length; i++) {
        var o = osc1(t + acc, 0.30, 0.24, notes[i], notes[i], 'sawtooth');
        if (o) part(o, t + acc + 0.32);
        var o2 = osc1(t + acc, 0.30, 0.10, notes[i] * 1.006, notes[i] * 1.006, 'triangle');
        if (o2) part(o2, t + acc + 0.32);
        var s = nz(t + acc, 0.03, 0.08, 'lowpass', notes[i] * 1.2, 1.2);
        if (s) part(s, t + acc + 0.05);
        acc += 0.105;
      }
      // wry descending slide
      osc1(t + acc, 0.55, 0.20, 830.61, 311.13, 'sawtooth');
      bell(t + acc + 0.10, 622.25, 0.20, 1.3, false);
    },
    win: function (t) {
      var freqs = PENT_RUN(6);
      for (var i = 0; i < freqs.length; i++) {
        var o = osc1(t + i * 0.115, 0.34, 0.24, freqs[i], freqs[i], 'triangle');
        if (o) part(o, t + i * 0.115 + 0.36);
      }
      bell(t + 0.70, freqs[5], 0.30, 1.5, true);
      bell(t + 0.70, freqs[4], 0.18, 1.2, false);
      bell(t + 0.95, freqs[5] * 2, 0.14, 1.0, true);
      nz(t + 0.68, 0.5, 0.10, 'highpass', 5000, 0.8, 7000);
    },
    lose: function (t) {
      // minor descending, softened
      var freqs = [midiToFreq(69), midiToFreq(67), midiToFreq(64), midiToFreq(62), midiToFreq(57)];
      for (var i = 0; i < freqs.length; i++) {
        var tt = t + i * 0.30;
        var o = osc1(tt, 0.55, 0.20, freqs[i], freqs[i], 'triangle');
        if (o) part(o, tt + 0.58);
        var o2 = osc1(tt, 0.55, 0.10, freqs[i] * 0.5, freqs[i] * 0.5, 'sine');
        if (o2) part(o2, tt + 0.58);
      }
      var s = nz(t, 1.6, 0.07, 'lowpass', 700, 0.7, 260);
      if (s) part(s, t + 1.7);
      boom(t + 1.2, 0.26, 0.9, 140, 44);
      bell(t + 1.20, midiToFreq(45), 0.20, 1.6, false);
    },
    landlord: function (t) {
      // confident gong + rising fifth
      var g = bell(t, 130.81, 0.45, 2.2, false);
      if (g) part(g, t + 2.4);
      bell(t + 0.02, 196.00, 0.22, 1.8, false);
      nz(t, 0.08, 0.30, 'lowpass', 1200, 0.8, 400);
      var a = osc1(t + 0.10, 0.5, 0.22, 587.33, 587.33, 'triangle');
      if (a) part(a, t + 0.62);
      var b = osc1(t + 0.34, 0.7, 0.24, 880.00, 880.00, 'triangle');
      if (b) part(b, t + 1.06);
      bell(t + 0.36, 880, 0.20, 1.2, true);
    },

    /* --- timers ---------------------------------------------------------- */
    tick: function (t) {
      var o = osc1(t, 0.045, 0.22, 1000, 980, 'sine');
      if (o) part(o, t + 0.07);
      var s = nz(t, 0.02, 0.08, 'bandpass', 2400, 1.5);
      if (s) part(s, t + 0.04);
    },
    warn: function (t) {
      var o = osc1(t, 0.05, 0.30, 1600, 1560, 'square', 0.002);
      if (o) part(o, t + 0.075);
      var o2 = osc1(t + 0.09, 0.05, 0.26, 1600, 1560, 'square', 0.002);
      if (o2) part(o2, t + 0.17);
      var s = nz(t, 0.025, 0.10, 'bandpass', 3600, 1.6);
      if (s) part(s, t + 0.05);
    },
    ready: function (t) {
      var a = osc1(t, 0.14, 0.20, 440, 442, 'sine');
      if (a) part(a, t + 0.16);
      var b = osc1(t + 0.14, 0.22, 0.22, 587.33, 587.33, 'sine');
      if (b) part(b, t + 0.38);
      bell(t + 0.14, 587.33, 0.12, 0.7, false);
    },
    go: function (t) {
      var fs = [587.33, 739.99, 880.00];
      for (var i = 0; i < fs.length; i++) {
        var o = osc1(t + i * 0.075, 0.22, 0.24, fs[i], fs[i], 'triangle');
        if (o) part(o, t + i * 0.075 + 0.24);
      }
      snap(t + 0.22, 0.26, 2400);
      bell(t + 0.23, 880, 0.20, 1.0, true);
    }
  };

  function normalizeOpts(opts) {
    opts = opts || {};
    var n = Math.round(clamp(opts.n === undefined ? 1 : opts.n, 1, 20));
    var power = Math.round(clamp(opts.power === undefined ? 1 : opts.power, 1, 3));
    return { n: n, power: power };
  }

  // Names whose sound is important enough to survive a saturated voice pool.
  var FORCE_SFX = { bomb: 1, rocket: 1, win: 1, lose: 1, spring: 1, anti_spring: 1, landlord: 1, bid: 1 };

  function sfx(name, opts) {
    if (typeof name !== 'string') return;
    if (!ctx || !sfxEnabled) return;
    if (!unlocked && ctx.state !== 'running') return;   // silent no-op until unlock()
    var fn = SFX[name];
    if (!fn) return;
    var o = normalizeOpts(opts);
    var force = !!FORCE_SFX[name];
    if (voiceCount >= MAX_SFX_VOICES && !force) { stats.dropped++; return; }
    if (voiceCount >= MAX_SFX_VOICES * 2) { stats.dropped++; return; }

    var release = once(function () {
      voiceCount--;
      if (voiceCount < 0) voiceCount = 0;
      stats.activeVoices = voiceCount;
    });
    voiceCount++;
    stats.activeVoices = voiceCount;
    openScope();
    var t = oneShotTime();
    var end = 0;
    try {
      fn(t, o);
      // composers report every source they start through the scope; the tail is
      // the longest one. Used only for the safety-net release below.
      if (CUR) {
        for (var i = 0; i < CUR.parts.length; i++) {
          if (CUR.parts[i].end - t > end) end = CUR.parts[i].end - t;
        }
      }
    } catch (e) {
      // never throw out of sfx()
    } finally {
      // closeScope() releases the voice slot in the tail node's onended
      closeScope(release);
      later(release, Math.max(1500, end * 1000 + 1200));   // safety net
    }
  }

  /* ==========================================================================
   * 10. Speech
   * ======================================================================== */

  function speak(text) {
    try {
      if (!speakEnabled) return;
      var synth = global.speechSynthesis || (global.window && global.window.speechSynthesis);
      if (!synth || typeof synth.speak !== 'function') return;
      var Utter = global.SpeechSynthesisUtterance ||
                  (global.window && global.window.SpeechSynthesisUtterance);
      if (!Utter) return;
      var s = String(text === undefined || text === null ? '' : text).slice(0, 120);
      if (!s) return;
      if (typeof synth.cancel === 'function') synth.cancel();
      var u = new Utter(s);
      u.lang = 'zh-CN';
      u.rate = 1.05;
      u.pitch = 1.0;
      u.volume = 1.0;
      try {
        var voices = typeof synth.getVoices === 'function' ? synth.getVoices() : null;
        if (voices && voices.length) {
          for (var i = 0; i < voices.length; i++) {
            var lang = (voices[i] && voices[i].lang) || '';
            if (/^zh/i.test(lang)) { u.voice = voices[i]; break; }
          }
        }
      } catch (e) {}
      synth.speak(u);
    } catch (e) { /* never throw */ }
  }

  /* ==========================================================================
   * 11. Public API
   * ======================================================================== */

  function init() {
    if (ctx) { API.ready = true; return true; }
    try {
      var Ctor = global.AudioContext || global.webkitAudioContext ||
                 (global.window && (global.window.AudioContext || global.window.webkitAudioContext));
      if (!Ctor) return false;
      ctx = new Ctor();
      if (!ctx || typeof ctx.createGain !== 'function') { ctx = null; return false; }
      unlocked = (ctx.state === 'running');
      buildChain();
      API.ready = true;
      return true;
    } catch (e) {
      ctx = null;
      API.ready = false;
      return false;
    }
  }

  function unlock() {
    try {
      if (!ctx) init();
      if (!ctx) return;
      var p = null;
      if (typeof ctx.resume === 'function') p = ctx.resume();
      if (p && typeof p.then === 'function') {
        p.then(function () { unlocked = true; }, function () { /* swallow */ });
      }
      if (p && typeof p.catch === 'function') p.catch(function () { /* swallow rejection */ });
      // A resume() from a user gesture resolves almost immediately; treat the
      // context as unlocked right away so UI feedback is not lost.
      if (ctx.state === 'running' || !ctx.state) unlocked = true;
      else later(function () { if (ctx && ctx.state === 'running') unlocked = true; }, 120);
      // if the UI asked for music before the context existed, start it now
      if (unlocked && desiredName && !findInstance(desiredName) && bgmEnabled) {
        currentName = null;
        playBgm(desiredName);
      }
    } catch (e) { /* never throw */ }
  }

  function setBgmVolume(v) {
    bgmVolume = clamp01(v === undefined ? bgmVolume : v);
    refreshBuses();
  }
  function setSfxVolume(v) {
    sfxVolume = clamp01(v === undefined ? sfxVolume : v);
    if (ctx && sfxBus) {
      try { sfxBus.gain.setTargetAtTime(0.85 * sfxVolume, ctx.currentTime, 0.05); }
      catch (e) { setParam(sfxBus.gain, 0.85 * sfxVolume); }
    }
  }
  function refreshBuses() {
    if (!ctx) return;
    for (var i = 0; i < instances.length; i++) {
      var inst = instances[i];
      if (inst.dead) continue;
      inst.fade(inst.level(), 0.2);
    }
  }
  function setBgmEnabled(on) {
    var was = bgmEnabled;
    bgmEnabled = !!on;
    try {
      if (!ctx) return;
      if (!bgmEnabled) {
        for (var i = 0; i < instances.length; i++) {
          if (instances[i].dead) continue;
          instances[i].fade(0, CROSSFADE);
          instances[i].stopAt = ctx.currentTime + CROSSFADE + 0.05;
        }
      } else if (!was) {
        var want = desiredName || currentName;
        if (want && want !== currentName) { currentName = null; playBgm(want); }
        else refreshBuses();
      }
    } catch (e) { /* never throw */ }
  }
  function setSfxEnabled(on) { sfxEnabled = !!on; }
  function setSpeakEnabled(on) {
    speakEnabled = !!on;
    if (!speakEnabled) {
      try {
        var synth = global.speechSynthesis || (global.window && global.window.speechSynthesis);
        if (synth && typeof synth.cancel === 'function') synth.cancel();
      } catch (e) {}
    }
  }

  function shutdown() {
    try {
      stopScheduler();
      for (var i = 0; i < pendingTimers.length; i++) { try { clearTimeout(pendingTimers[i]); } catch (e) {} }
      pendingTimers.length = 0;
      for (var k = 0; k < instances.length; k++) { try { instances[k].retire(); } catch (e) {} }
      instances.length = 0;
      currentName = null;
      if (ctx && typeof ctx.close === 'function') { try { ctx.close(); } catch (e) {} }
      ctx = null; master = null; comp = null; shaper = null; sfxBus = null; sfxSend = null;
      reverbIn = null; reverbWet = null; noiseBuf = null;
      ksCache = {}; ksCount = 0;
      voiceCount = 0; stats.activeVoices = 0;
      unlocked = false;
      API.ready = false;
    } catch (e) { /* never throw */ }
  }

  var API = {
    ready: false,

    init: init,
    unlock: unlock,

    playBgm: playBgm,
    stopBgm: stopBgm,
    setBgmEnabled: setBgmEnabled,
    setSfxEnabled: setSfxEnabled,
    setBgmVolume: setBgmVolume,
    setSfxVolume: setSfxVolume,
    sfx: sfx,
    speak: speak,
    setSpeakEnabled: setSpeakEnabled,

    /* ---- internal hooks (tests / debugging) ---- */
    __pump: pump,
    __stats: stats,
    __info: (function () {
      var info = {};
      for (var k in TRACKS) {
        if (!Object.prototype.hasOwnProperty.call(TRACKS, k)) continue;
        info[k] = {
          bpm: TRACKS[k].bpm, bars: TRACKS[k].bars,
          key: TRACKS[k].key, stepsPerBar: TRACKS[k].stepsPerBar
        };
      }
      return info;
    })(),
    __violations: function () { return internalViolations; },
    __sfxNames: function () { var a = [], k; for (k in SFX) if (Object.prototype.hasOwnProperty.call(SFX, k)) a.push(k); return a; },
    __state: function () {
      return {
        ready: !!ctx, unlocked: unlocked, bgmEnabled: bgmEnabled, sfxEnabled: sfxEnabled,
        speakEnabled: speakEnabled, current: currentName, desired: desiredName,
        instances: instances.length, voices: voiceCount,
        ctxState: ctx ? ctx.state : null
      };
    },
    __shutdown: shutdown
  };

  global.DDZAudio = API;
  if (global.window && global.window !== global) global.window.DDZAudio = API;

})(typeof window !== 'undefined' ? window : this);
