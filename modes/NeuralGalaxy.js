/**
 * VEIL — Virtual Experiential Interactive Landscape
 * © 2026 Cassidy Howell
 *
 * This file is part of VEIL BETA v1.0.
 * Source is shared for reference only.
 * Unauthorized use, reproduction, or derivative works are prohibited.
 */

// modes/NeuralGalaxy.js
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// VEIL GLOW (Bloom)
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

// Map DNA (headless)
import { buildMapDataFromAudio } from '../MapDNA.js';

/**
 * VEIL — NeuralGalaxy Mode (CURRENT BEST + DANCE RESTORE) — Logistic Blending Restore
 * - Soft (logistic) blending between Bass / Mids / Treble zones (no hard band cuts)
 * - Arms read as MID energy lanes (top view), bounded motion, infinite spin
 * - Preserves deterministic DNA + brightness/color recipe + bloom
 */

const DEFAULTS = {
  renderer: { clearColor: 0x000000, maxDpr: 2, antialias: true },
  camera:   { fov: 75, near: 0.1, far: 2000, startZ: 150 },

  // ======== TUNING ========
  zoning:   { bottomPercentBase: 0.18, topPercentBase: 0.20 },
  vertical: { bassDroopMax: 55, trebleRaiseMax: 45, bassHitDroopExtra: 38, treblePopY: 12 },
  spiral:   { danceStrength: 0.55, twistStrength: 0.35, radialBreathe: 0.22, carrierTide: 0.55 },
  radial:   { bassHitSwell: 0.12, treblePopRadial: 0.10 },
  swim:     { fieldSwim: 0.16, trebleBoost: 0.85 },
  rotation: { autoRotateSpeed: 0.0020 },
  impact:   { bassHitAttack: 0.22, bassHitDecay: 0.86 },

  // Spiral arms “lanes”
  arms: {
    countMin: 3,
    countMax: 7,
    pitch: 0.012,          // spiral advance with radius
    tightness: 0.72,       // arm pull strength (0..1)
    gapStrength: 0.34,     // darkens between arms
    wave: 0.22,            // subtle waviness of arms
    snapMidInfluence: 0.85 // mids amplify arm definition
  },

  // Mid band 3D thickness (side view volume)
  midBand: {
    enabled: true,
    centerR: 115,          // where the mid “donut” lives (world units)
    width: 240,            // shell width (bigger = thicker band)
    thickness: 140,         // max vertical thickness
    falloff: 0.42,         // gaussian sharpness (lower = tighter)
    signSpread: 0.5        // 0..1 randomizes up/down thickness balance per point
  },

  // NEW: Logistic blending (soft transitions between zones)
  blend: {
    // normalized y (0..1) edges, derived from baseline percent thresholds
    bassEdge: 0.22,      // around bottomPercentBase
    trebleEdge: 0.78,    // around 1 - topPercentBase
    softness: 0.08       // k: larger => softer blend
  },

  audio: {
    bassEnd: 0.12, lowMidEnd: 0.35, highMidEnd: 0.70,
    envLerp: 0.035, envHold: 0.965,
    midPulseHold: 0.88, midPulseIn: 0.12,
    sensGainMin: 0.40, sensGainMaxAdd: 2.80
  },

  // VEIL GLOW default recipe
  glow: {
    enabled: true,
    strength: 0.95,
    radius: 0.48,
    threshold: 0.14,
    trebleReactive: true,
    trebleStrengthBoost: 0.60,
    bassThresholdTighten: 0.06
  }
};

const PRESETS = {
  club: {
    spiral:   { danceStrength: 0.62, twistStrength: 0.40, radialBreathe: 0.24, carrierTide: 0.62 },
    vertical: { bassDroopMax: 62, trebleRaiseMax: 52, bassHitDroopExtra: 44, treblePopY: 14 },
    swim:     { fieldSwim: 0.18, trebleBoost: 0.95 },
    glow:     { strength: 1.15, radius: 0.52, threshold: 0.12 },
    arms:     { tightness: 0.78, gapStrength: 0.38 },
    blend:    { softness: 0.09 }
  },
  ambient: {
    spiral:   { danceStrength: 0.42, twistStrength: 0.24, radialBreathe: 0.18, carrierTide: 0.48 },
    vertical: { bassDroopMax: 40, trebleRaiseMax: 36, bassHitDroopExtra: 24, treblePopY: 9 },
    swim:     { fieldSwim: 0.12, trebleBoost: 0.55 },
    glow:     { strength: 0.70, radius: 0.42, threshold: 0.18 },
    arms:     { tightness: 0.62, gapStrength: 0.28 },
    blend:    { softness: 0.11 }
  },
  cinematic: {
    glow:  { strength: 0.95, radius: 0.48, threshold: 0.14 },
    blend: { softness: 0.08 }
  }
};

function mergeDeep(base, patch) {
  const out = { ...base };
  for (const k in patch) {
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = mergeDeep(base[k] || {}, v);
    else out[k] = v;
  }
  return out;
}

class AudioFeatures {
  constructor(analyser, cfg) {
    this.analyser = analyser;
    this.cfg = cfg;
    this.data = new Uint8Array(analyser.frequencyBinCount);

    this.prevLowMid = 0;
    this.prevBass = 0;

    this.bassEnv = 0;
    this.trebleEnv = 0;

    this.midPulse = 0;
    this.bassHit = 0;
  }

  _computeBands(dataArray) {
    const len = dataArray.length;
    if (len === 0) return { bass: 0, lowMid: 0, highMid: 0, treble: 0 };

    const bassEnd    = Math.floor(len * this.cfg.audio.bassEnd);
    const lowMidEnd  = Math.floor(len * this.cfg.audio.lowMidEnd);
    const highMidEnd = Math.floor(len * this.cfg.audio.highMidEnd);

    let sumBass = 0, nBass = 0;
    let sumLowMid = 0, nLowMid = 0;
    let sumHighMid = 0, nHighMid = 0;
    let sumTreble = 0, nTreble = 0;

    for (let i = 0; i < len; i++) {
      const v = dataArray[i];
      if (i < bassEnd) { sumBass += v; nBass++; }
      else if (i < lowMidEnd) { sumLowMid += v; nLowMid++; }
      else if (i < highMidEnd) { sumHighMid += v; nHighMid++; }
      else { sumTreble += v; nTreble++; }
    }

    return {
      bass:    (nBass    ? sumBass    / nBass    : 0) / 255,
      lowMid:  (nLowMid  ? sumLowMid  / nLowMid  : 0) / 255,
      highMid: (nHighMid ? sumHighMid / nHighMid : 0) / 255,
      treble:  (nTreble  ? sumTreble  / nTreble  : 0) / 255
    };
  }

  sample(sensNorm, cfg) {
    this.analyser.getByteFrequencyData(this.data);

    const sensGain = cfg.audio.sensGainMin + sensNorm * cfg.audio.sensGainMaxAdd;
    const bands = this._computeBands(this.data);

    const bass   = bands.bass;
    const lowMid = bands.lowMid;
    const highMid = bands.highMid;
    const treble = bands.treble;

    // mid pulse
    const dLowMid = lowMid - this.prevLowMid;
    this.prevLowMid = lowMid;

    const rawPulse = Math.max(0, dLowMid * 9.0);
    this.midPulse  = this.midPulse * cfg.audio.midPulseHold + rawPulse * cfg.audio.midPulseIn;
    this.midPulse  = THREE.MathUtils.clamp(this.midPulse, 0, 1.5);
    const pulseScaled = THREE.MathUtils.clamp(this.midPulse * (0.65 + sensNorm * 1.35), 0, 1.0);

    // envelopes
    const bassTarget   = THREE.MathUtils.clamp(bass   * sensGain, 0, 1);
    const trebleTarget = THREE.MathUtils.clamp(treble * sensGain, 0, 1);

    this.bassEnv   = this.bassEnv   * cfg.audio.envHold + bassTarget   * cfg.audio.envLerp;
    this.trebleEnv = this.trebleEnv * cfg.audio.envHold + trebleTarget * cfg.audio.envLerp;

    // bass hit
    const dBass = bass - this.prevBass;
    this.prevBass = bass;

    const hit = Math.max(0, dBass) * (10.0 + sensNorm * 20.0);
    this.bassHit = this.bassHit * cfg.impact.bassHitDecay + hit * cfg.impact.bassHitAttack;
    this.bassHit = THREE.MathUtils.clamp(this.bassHit, 0, 1.25);

    const loudness = (bass + lowMid + highMid + treble) * 0.25;

    return {
      data: this.data,
      sensGain,
      bands,
      pulseScaled,
      bassEnv: THREE.MathUtils.clamp(this.bassEnv, 0, 1),
      trebleEnv: THREE.MathUtils.clamp(this.trebleEnv, 0, 1),
      bassHit: this.bassHit,
      loudness
    };
  }
}

export class NeuralGalaxy {
  constructor(shared, neuralMapData = null, options = {}) {
    // Shared
    this.shared        = shared;
    this.audioContext  = shared.audioContext;
    this.analyser      = shared.analyser;
    this.gainNode      = shared.gainNode;
    this.sensitivityEl = shared.sensitivityEl;
    this.volumeEl      = shared.volumeEl;
    this.audioHashEl   = shared.audioHashEl;

    const infoBox = document.getElementById('info');
if (infoBox) infoBox.style.display = 'none';

// Song DNA
    this.songHash = shared.songHash || null;

    // Options / config
    const presetName = options.preset || 'cinematic';
    const preset = PRESETS[presetName] || PRESETS.cinematic;
    this.cfg = mergeDeep(DEFAULTS, mergeDeep(preset, options.cfg || {}));

    // Locked arms count for current galaxy
    this.ARMS_COUNT = null;

    // Scene / view
    this.canvas      = document.getElementById('neuralCanvas');
    this.containerEl = document.getElementById('container');
    this.scene       = new THREE.Scene();
    this.camera      = new THREE.PerspectiveCamera(this.cfg.camera.fov, 1, this.cfg.camera.near, this.cfg.camera.far);
    this.renderer    = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: this.cfg.renderer.antialias
    });

    // Controls optional
    this.controls = null;
    if (options.enableControls !== false) {
      this.controls = new OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.05;
    }

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    this.camera.position.set(0, 0, this.cfg.camera.startZ);

    // VEIL GLOW pipeline
    this.composer = null;
    this.renderPass = null;
    this.bloomPass = null;

    // Galaxy data
    this.starGeometry = null;
    this.starMaterial = null;
    this.stars        = null;

    this.baseHues        = null;
    this.baseShapeTiers  = null;
    this.basePositions   = null;
    this.initialYs       = null;
    this.sortedYs        = null;

    this.mapData = Array.isArray(neuralMapData) ? neuralMapData : null;

    // Audio
    this.audioBuffer = shared.lastAudioBuffer || null;
    this.source      = null;
    this.isPlaying   = false;

    // Cached sensitivity
    this._sensNormCached = 0.5;
    this._onSensInput = () => { this._sensNormCached = this._getSensitivityNorm(); };

    // Transport state (true pause / resume)
this.playStartTime = 0;   // audioContext.currentTime when playback started
this.pauseOffset   = 0;   // seconds into track where we paused
this.duration      = 0;   // cached duration of buffer

// Animation control
    this.isActive  = true;
    this.rafId     = null;
    this._onResize = this.sizeToContainer.bind(this);
    // Per-point smoothing caches (prevents herky-jerky / reversal on snaps)
    this._phiCache = null;
    this._rCache   = null;
    this._lastNow  = 0;

    // Audio features
    this.features = new AudioFeatures(this.analyser, this.cfg);

    this.init();
  }

  // ---------- INIT ----------
  init() {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.cfg.renderer.maxDpr));
    this.sizeToContainer();
    this.renderer.setClearColor(this.cfg.renderer.clearColor);
    window.addEventListener('resize', this._onResize);

    // Cache sensitivity changes
    if (this.sensitivityEl) {
      this._sensNormCached = this._getSensitivityNorm();
      this.sensitivityEl.addEventListener('input', this._onSensInput);
    }

    // Build VEIL glow pipeline
    if (this.cfg.glow.enabled) this._initGlowPipeline();

    if (this.audioBuffer && !this.songHash) {
      this.songHash = this.computeAudioHash(this.audioBuffer);
      this.shared.songHash = this.songHash;
    }
    if (this.songHash && this.audioHashEl) this.audioHashEl.textContent = `Hash: ${this.songHash}`;

    // ✅ Always build galaxy from Map DNA (deterministic per song)
if (this.audioBuffer) {
  this.mapData = buildMapDataFromAudio(this.audioBuffer, this.songHash);
  this.createGalaxyFromNeuralMap(this.mapData);

  const playBtn  = document.getElementById('playBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  if (playBtn && pauseBtn) { playBtn.disabled = false; pauseBtn.disabled = true; }
}

this.animate();

  }

  _initGlowPipeline() {
    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(1, 1),
      this.cfg.glow.strength,
      this.cfg.glow.radius,
      this.cfg.glow.threshold
    );
    this.composer.addPass(this.bloomPass);
  }

  sizeToContainer() {
    const rect = this.containerEl.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));

    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();

    if (this.composer) this.composer.setSize(w, h);
    if (this.bloomPass) this.bloomPass.setSize(w, h);
  }

  onNewAudio(audioBuffer) {
    this.audioBuffer = audioBuffer;
    this.shared.lastAudioBuffer = audioBuffer;
  
    if (this.audioBuffer && !this.songHash) {
      this.songHash = this.computeAudioHash(this.audioBuffer);
      this.shared.songHash = this.songHash;
    } else if (this.audioBuffer) {
      this.songHash = this.computeAudioHash(this.audioBuffer);
      this.shared.songHash = this.songHash;
    }
  
    if (this.songHash && this.audioHashEl) {
      this.audioHashEl.textContent = `Hash: ${this.songHash}`;
    }
  
    // rebuild galaxy deterministically
    this.mapData = buildMapDataFromAudio(this.audioBuffer, this.songHash);
    this.createGalaxyFromNeuralMap(this.mapData);
  
    // UI state: ready to play
    const playBtn  = document.getElementById('playBtn');
    const pauseBtn = document.getElementById('pauseBtn');
    if (playBtn && pauseBtn) { playBtn.disabled = false; pauseBtn.disabled = true; }
  }
  
  async play() {
    if (this.shared?.transport) await this.shared.transport.play();
    const playBtn  = document.getElementById('playBtn');
    const pauseBtn = document.getElementById('pauseBtn');
    if (playBtn && pauseBtn) { playBtn.disabled = true; pauseBtn.disabled = false; }
  }
  
  pause() {
    if (this.shared?.transport) this.shared.transport.pause();
    const playBtn  = document.getElementById('playBtn');
    const pauseBtn = document.getElementById('pauseBtn');
    if (playBtn && pauseBtn) { playBtn.disabled = false; pauseBtn.disabled = true; }
  }
  
  reset() {
    if (this.shared?.transport) this.shared.transport.reset();
    const playBtn  = document.getElementById('playBtn');
    const pauseBtn = document.getElementById('pauseBtn');
    if (playBtn && pauseBtn) { playBtn.disabled = false; pauseBtn.disabled = true; }
  }
  
  // ---------- HELPERS ----------
  computeAudioHash(buffer) {
    const data = buffer.getChannelData(0);
    let hash = 0;
    for (let i = 0; i < data.length; i += 1000) {
      hash = Math.imul(31, hash) + ((data[i] * 100000) | 0);
    }
    return Math.abs(hash).toString(16);
  }

  seededRandomFromHash(hash) {
    let h = 0;
    for (let i = 0; i < hash.length; i++) {
      h = Math.imul(31, h) + hash.charCodeAt(i) | 0;
    }
    return () => {
      h = Math.imul(1664525, h) + 1013904223 | 0;
      return (h >>> 0) / 4294967296;
    };
  }

  _hash01(i) {
    const s = this.songHash || 'veil';
    let h = 2166136261 | 0;
    for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 16777619);
    h = Math.imul(h ^ (i + 1), 16777619);
    h ^= h >>> 13; h = Math.imul(h, 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  _getSensitivityNorm() {
    const el = this.sensitivityEl;
    const v   = parseFloat(el?.value ?? '1');
    const min = parseFloat(el?.min ?? '0');
    const max = parseFloat(el?.max ?? '12');
    const n = (max !== min) ? (v - min) / (max - min) : 0.5;
    return THREE.MathUtils.clamp(n, 0, 1);
  }

  _smoothstep(edge0, edge1, x) {
    const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  _angleDist(a, b) {
    const d = Math.atan2(Math.sin(a - b), Math.cos(a - b));
    return Math.abs(d);
  }

  _sigmoid(x) {
    return 1 / (1 + Math.exp(-x));
  }

  _logisticWindow(y, a, b, k) {
    const s1 = this._sigmoid((y - a) / k);
    const s2 = this._sigmoid((y - b) / k);
    return Math.max(0, s1 - s2);
  }

  _cacheBaselines(positions, shapeTiers) {
    const N = positions.length / 3;

    this.basePositions  = new Float32Array(positions);
    this.baseShapeTiers = new Float32Array(shapeTiers);

    this.initialYs = new Float32Array(N);
    for (let i = 0; i < N; i++) this.initialYs[i] = this.basePositions[i * 3 + 1];

    this.sortedYs = Array.from(this.initialYs).sort((a, b) => a - b);
  }

  _chooseArmsCount(rand) {
    const a = this.cfg.arms;
    const min = Math.max(1, a.countMin | 0);
    const max = Math.max(min, a.countMax | 0);
    const n = min + Math.floor(rand() * (max - min + 1));
    this.ARMS_COUNT = n;
    return n;
  }

  // ---------- BUILDERS ----------
  createGalaxyFromNeuralMap(data) {
    const N = Math.min(4000, Math.max(900, data.length * 10));
    if (!Array.isArray(data) || data.length === 0) return this.createNeutralSpiral(N);

    const rand = this.seededRandomFromHash(this.songHash || String(data.length));
    const armsCount = this._chooseArmsCount(rand);

    const positions  = new Float32Array(N * 3);
    const colors     = new Float32Array(N * 3);
    const shapeTiers = new Float32Array(N);
    this.baseHues    = new Float32Array(N);

    const c = new THREE.Color();

    for (let i = 0; i < N; i++) {
      const node = data[i % data.length];
      const posV = node.position;
      const amp  = node.amp ?? 0.2;
      const freq = node.freq ?? 0.1;
      const hue  = (node.hue ?? (i / N)) % 1;

      const armIdx   = (i % armsCount) / armsCount;
      const armAngle = armIdx * Math.PI * 2;

      const t = i / N;
      const radiusBase = posV.length() * 1.4 + amp * 90 + rand() * 20;

      const swirl = (t * 7.0 + freq * 1.5) * Math.PI;
      const angle = (hue * Math.PI * 2) + armAngle + swirl + Math.sin(freq * 20 + i * 0.1) * 0.6;

      // --- SPHERICAL WRAP by node freq (bass bottom -> treble top) ---
const u   = THREE.MathUtils.clamp(freq * 8.0, 0, 1); // 0..1-ish
const phi = (1.0 - u) * Math.PI;                    // bottom: PI, top: 0
const lat = Math.sin(phi);

const ripple = (Math.sin(freq * 18 + t * 10) * 10) + (rand() - 0.5) * 7;
const R = Math.max(1e-3, radiusBase + ripple);

const x = Math.cos(angle) * (R * lat);
const z = Math.sin(angle) * (R * lat);
const y = Math.cos(phi) * R;


      positions[i * 3 + 0] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;

      const baseHue = (hue + freq * 0.30) % 1;
      this.baseHues[i] = baseHue;
      c.setHSL(baseHue, 1.0, 0.58);
      colors[i * 3 + 0] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;

      const fNorm = THREE.MathUtils.clamp(freq * 8.0, 0, 1);
      shapeTiers[i] = (fNorm < 0.33) ? 0.0 : (fNorm < 0.66) ? 1.0 : 2.0;
    }

    this._cacheBaselines(positions, shapeTiers);
    this._commitStars(positions, colors, shapeTiers);
  }

  createGalaxyFromAudio(buffer) {
    const ch  = buffer.getChannelData(0);
    const len = ch.length;

    const samples = 1024;
    const stride  = Math.max(1, Math.floor(len / samples));

    const amps  = new Float32Array(samples);
    const freqs = new Float32Array(samples);
    const hues  = new Float32Array(samples);

    let hueSeed = 0;
    for (let i = 0; i < samples; i++) {
      const start = i * stride;
      const end   = Math.min(len, start + stride);

      let maxAbs = 0, zc = 0;
      let prev = ch[start];

      for (let j = start + 1; j < end; j++) {
        const v = ch[j];
        if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
        if ((prev >= 0) !== (v >= 0)) zc++;
        prev = v;
      }
      const segLen = Math.max(1, end - start);
      const freq   = zc / segLen;

      amps[i]  = maxAbs;
      freqs[i] = freq;

      hueSeed = (hueSeed + maxAbs * 0.09) % 1;
      hues[i] = hueSeed;
    }

    const N = Math.min(4000, Math.max(1000, samples * 4));
    const rand = this.seededRandomFromHash(this.songHash || String(len));
    const armsCount = this._chooseArmsCount(rand);

    const positions  = new Float32Array(N * 3);
    const colors     = new Float32Array(N * 3);
    const shapeTiers = new Float32Array(N);
    this.baseHues    = new Float32Array(N);

    const c = new THREE.Color();

    for (let i = 0; i < N; i++) {
      const k    = i % samples;
      const amp  = amps[k];
      const freq = freqs[k];
      const hue  = hues[k];

      const armIdx   = (i % armsCount) / armsCount;
      const armAngle = armIdx * Math.PI * 2;

      const t = i / N;
      const radius = (k / samples) * 220 + amp * 95 + rand() * 22;

      const swirl = (t * 7.4 + freq * 1.6) * Math.PI;
      const angle = hue * Math.PI * 2 + armAngle + swirl + Math.sin(freq * 22 + i * 0.11) * 0.55;

      // --- SPHERICAL WRAP by frequency index (bass bottom -> treble top) ---
const u   = (samples > 1) ? (k / (samples - 1)) : 0.0; // 0..1
const phi = (1.0 - u) * Math.PI;                       // bottom: PI, top: 0
const lat = Math.sin(phi);

// keep your existing density/energy radius, but add a small cymatic ripple
const ripple = (Math.sin(freq * 20 + t * 11) * 12) + (rand() - 0.5) * 8;
const R = Math.max(1e-3, radius + ripple);

const x = Math.cos(angle) * (R * lat);
const z = Math.sin(angle) * (R * lat);
const y = Math.cos(phi) * R;


      positions[i * 3 + 0] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;

      const baseHue = (hue + freq * 0.35) % 1;
      this.baseHues[i] = baseHue;
      c.setHSL(baseHue, 1.0, 0.58);
      colors[i * 3 + 0] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;

      const fNorm = THREE.MathUtils.clamp(freq * 8.0, 0, 1);
      shapeTiers[i] = (fNorm < 0.33) ? 0.0 : (fNorm < 0.66) ? 1.0 : 2.0;
    }

    this._cacheBaselines(positions, shapeTiers);
    this._commitStars(positions, colors, shapeTiers);
  }

  createNeutralSpiral(N) {
    const rand = this.seededRandomFromHash(this.songHash || String(N));
    const armsCount = this._chooseArmsCount(rand);

    const positions  = new Float32Array(N * 3);
    const colors     = new Float32Array(N * 3);
    const shapeTiers = new Float32Array(N);
    this.baseHues    = new Float32Array(N);
    const c = new THREE.Color();

    for (let i = 0; i < N; i++) {
      const t = i / N;
      const radius = 50 + t * 200;

      const armIdx   = (i % armsCount) / armsCount;
      const armAngle = armIdx * Math.PI * 2;

      const angle  = t * Math.PI * 6 + armAngle * 0.35;

      // --- SPHERICAL WRAP by t (bottom -> top) ---
const u   = THREE.MathUtils.clamp(t, 0, 1);
const phi = (1.0 - u) * Math.PI;   // bottom: PI, top: 0
const lat = Math.sin(phi);

const ripple = (Math.sin(angle * 2.0) * 10) + (rand() - 0.5) * 6;
const R = Math.max(1e-3, radius + ripple);

const x = Math.cos(angle) * (R * lat);
const z = Math.sin(angle) * (R * lat);
const y = Math.cos(phi) * R;


      positions[i * 3 + 0] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;

      const baseHue = (0.6 + t * 0.4) % 1;
      this.baseHues[i] = baseHue;
      c.setHSL(baseHue, 1.0, 0.58);
      colors[i * 3 + 0] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;

      shapeTiers[i] = 1.0;
    }

    this._cacheBaselines(positions, shapeTiers);
    this._commitStars(positions, colors, shapeTiers);
  }

  // ---------- COMMIT STARS ----------
  _commitStars(positions, colors, shapeTiers) {
    this.clearStars();

    this.starGeometry = new THREE.BufferGeometry();
    this.starGeometry.setAttribute('position',  new THREE.BufferAttribute(positions, 3));
    this.starGeometry.setAttribute('color',     new THREE.BufferAttribute(colors, 3));
    this.starGeometry.setAttribute('shapeTier', new THREE.BufferAttribute(shapeTiers, 1));

    this.starMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uSize:      { value: 2.2 },
        uMidPulse:  { value: 0.0 },
        uBassEnv:   { value: 0.0 },
        uBassHit:   { value: 0.0 },
      },
      vertexShader: `
        attribute float shapeTier;
        attribute vec3  color;

        varying vec3  vColor;
        varying float vShapeTier;

        uniform float uSize;
        uniform float uMidPulse;
        uniform float uBassEnv;
        uniform float uBassHit;

        void main() {
          vColor     = color;
          vShapeTier = shapeTier;

          float t = clamp(vShapeTier, 0.0, 2.0);
          vec3 pos = position;

          // syrupy mid bulge (works best when t is continuous)
          float midCenter = 1.0;
          float midRange  = 0.9;
          float midWeight = 1.0 - clamp(abs(t - midCenter) / midRange, 0.0, 1.0);

          float rawPulse   = clamp(uMidPulse, 0.0, 1.0);
          float easedPulse = pow(rawPulse, 0.42);
          float radialPulse = 1.0 + midWeight * easedPulse * 1.15;
          pos *= radialPulse;

          vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);

          float size = uSize * (300.0 / -mvPosition.z);

          // bass size boost (tier 0)
          float bassBoost = smoothstep(1.2, 0.0, t);
          float bassScale = 1.0 + bassBoost * 4.0;

          // sustained “weight”
          bassScale *= (1.0 + bassBoost * uBassEnv * 0.8);

          // impact “punch”
          bassScale *= (1.0 + bassBoost * uBassHit * 1.75);

          size *= bassScale;

          gl_PointSize = size;
          gl_Position  = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying vec3  vColor;
        varying float vShapeTier;

        float hexDist(vec2 p) {
          p = abs(p);
          return max(dot(p, vec2(0.8660254, 0.5)), p.y);
        }

        void main() {
          vec2 uv = gl_PointCoord * 2.0 - 1.0;
          float r = length(uv);

          // Tier 0: blob
          float blob = smoothstep(1.0, 0.6, r);

          // Tier 1: hexagon
          float hd = hexDist(uv);
          float hex = smoothstep(1.0, 0.62, hd);

          // Tier 2: 4-point star
          float ang = atan(uv.y, uv.x);
          float spikes = abs(cos(ang * 4.0));
          float star = smoothstep(1.1, 0.4, r * (0.6 + 0.7 * spikes));

          float t = clamp(vShapeTier, 0.0, 2.0);

          float midMask = mix(blob, hex,  smoothstep(0.0, 1.0, t));
          float mask    = mix(midMask, star, smoothstep(1.0, 2.0, t));

          if (mask < 0.01) discard;

          // bloom feed: upper tiers “hotter”
          float glowBoost = 0.75 + 0.65 * smoothstep(1.0, 2.0, t);
          vec3  col = vColor * glowBoost;

          gl_FragColor = vec4(col, mask);
        }
      `
    });

    this.stars = new THREE.Points(this.starGeometry, this.starMaterial);
    this.scene.add(this.stars);
  }

  clearStars() {
    if (!this.stars) return;
    this.scene.remove(this.stars);
    this.starGeometry?.dispose();
    this.starMaterial?.dispose();
    this.stars        = null;
    this.starGeometry = null;
    this.starMaterial = null;
  }

// ---------- AUDIO HANDOFF ----------
onNewAudio(buffer) {
  if (!buffer) return;

  // sync local reference (visual-only)
  this.audioBuffer = buffer;

  // reset visual-time state
  this.pauseOffset   = 0;
  this.playStartTime = 0;
  this.duration      = buffer.duration || 0;

  // compute deterministic DNA
  this.songHash = this.computeAudioHash(buffer);
  this.shared.songHash = this.songHash;

  if (this.audioHashEl) {
    this.audioHashEl.textContent = `Hash: ${this.songHash}`;
  }

  // ALWAYS rebuild from Map DNA
  this.mapData = buildMapDataFromAudio(buffer, this.songHash);
  this.createGalaxyFromNeuralMap(this.mapData);

  // UI state
  const playBtn  = document.getElementById('playBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  if (playBtn && pauseBtn) {
    playBtn.disabled  = false;
    pauseBtn.disabled = true;
  }
}

  // ---------- ANIMATION / REACTIVITY ----------
  updateStars() {
    if (!this.stars || !this.analyser || !this.starGeometry || !this.basePositions || !this.sortedYs || this.sortedYs.length < 2) return;

    const posAttr   = this.starGeometry.attributes.position;
    const colAttr   = this.starGeometry.attributes.color;
    const shapeAttr = this.starGeometry.attributes.shapeTier;

    const positions = posAttr.array;
    const colors    = colAttr.array;
    const tiers     = shapeAttr.array;

    const count = positions.length / 3;

    // Ensure smoothing caches match point count
    if (!this._phiCache || this._phiCache.length !== count) this._phiCache = new Float32Array(count);
    if (!this._rCache   || this._rCache.length   !== count) this._rCache   = new Float32Array(count);

    const sensNorm = this._sensNormCached;
    const F = this.features.sample(sensNorm, this.cfg);

    // uniforms
    if (this.starMaterial?.uniforms?.uMidPulse) this.starMaterial.uniforms.uMidPulse.value = F.pulseScaled;
    if (this.starMaterial?.uniforms?.uBassEnv)  this.starMaterial.uniforms.uBassEnv.value  = F.bassEnv;
    if (this.starMaterial?.uniforms?.uBassHit) {
      this.starMaterial.uniforms.uBassHit.value = THREE.MathUtils.clamp(
        F.bassHit * (0.85 + sensNorm * 0.55),
        0, 1.35
      );
    }

    // Bloom reacts to audio (subtle)
    if (this.bloomPass && this.cfg.glow.trebleReactive) {
      const treble = F.bands.treble;
      const bass   = F.bands.bass;

      this.bloomPass.strength = this.cfg.glow.strength * (0.85 + treble * this.cfg.glow.trebleStrengthBoost);

      this.bloomPass.threshold = THREE.MathUtils.clamp(
        this.cfg.glow.threshold + bass * this.cfg.glow.bassThresholdTighten,
        0.02, 0.95
      );

      this.bloomPass.radius = THREE.MathUtils.clamp(
        this.cfg.glow.radius * (0.95 + treble * 0.12 + F.pulseScaled * 0.08),
        0.0, 1.0
      );
    }

    const now = performance.now();
    const t0  = now * 0.001;

    // Frame delta (seconds) for smoothing
    const dt = Math.min(0.05, Math.max(0.001, (now - (this._lastNow || now)) * 0.001));
    this._lastNow = now;

    // carrier tide
    const tide = Math.sin(t0 * 0.55) * 0.6 + Math.sin(t0 * 0.21) * 0.4;
    const carrier = this.cfg.spiral.carrierTide * (0.65 + 0.55 * sensNorm) * tide;

    const c = NeuralGalaxy._tmpColor || (NeuralGalaxy._tmpColor = new THREE.Color());

    // mid energy driver
    const midEnergyGlobal = THREE.MathUtils.clamp(
      (F.bands.lowMid * 0.55 + F.bands.highMid * 0.45) * F.sensGain,
      0, 1
    );

    const armsCount = this.ARMS_COUNT || 5;

    const yMin = this.sortedYs[0];
    const yMax = this.sortedYs[this.sortedYs.length - 1];

    // logistic blend parameters
    const bassEdgeN   = THREE.MathUtils.clamp(this.cfg.blend?.bassEdge ?? 0.22, 0.02, 0.48);
    const trebleEdgeN = THREE.MathUtils.clamp(this.cfg.blend?.trebleEdge ?? 0.78, 0.52, 0.98);
    const k           = THREE.MathUtils.clamp(this.cfg.blend?.softness ?? 0.08, 0.015, 0.25);

    for (let i = 0; i < count; i++) {
      const bi = i * 3;

      const bx = this.basePositions[bi + 0];
      const by = this.basePositions[bi + 1];
      const bz = this.basePositions[bi + 2];

      const seed  = this._hash01(i);
      const phase = seed * Math.PI * 2;

      // normalized y -> 0..1
      const yNorm = THREE.MathUtils.clamp((by - yMin) / Math.max(1e-6, (yMax - yMin)), 0, 1);

      // logistic weights (sum->1)
      const trebleW = this._sigmoid((yNorm - trebleEdgeN) / k);
      const bassW   = 1.0 - this._sigmoid((yNorm - bassEdgeN) / k);
      let midW      = this._logisticWindow(yNorm, bassEdgeN, trebleEdgeN, k);

      const sumW = Math.max(1e-6, bassW + midW + trebleW);
      const wB = bassW / sumW;
      const wM = midW / sumW;
      const wT = trebleW / sumW;

      // continuous tier for shader morph (0..2)
      tiers[i] = 0.0 * wB + 1.0 * wM + 2.0 * wT;

      const fIndex    = Math.floor((i / count) * F.data.length);
      const intensity = (F.data[fIndex] / 255);

      // sphere-aware warp (replaces the old polar warp block)
      const rBase = Math.sqrt(bx * bx + by * by + bz * bz) + 1e-6;
      const r0    = rBase; // keep name used later (midBand, etc.)
      
      // spherical coords from base position
      const theta0 = Math.atan2(bz, bx);
      const phi0   = Math.acos(THREE.MathUtils.clamp(by / rBase, -1, 1)); // 0..PI (top..bottom)
      
      const midWeight = wM;
      const breath = (F.pulseScaled * this.cfg.spiral.radialBreathe) * (0.35 + 0.65 * midWeight);
      
      const flow = this.cfg.spiral.danceStrength * (0.35 + 0.65 * sensNorm);
      const flowWave = Math.sin(t0 * 0.28 + rBase * 0.022 + phase) * (0.35 + intensity);
      
      const twistAudio =
        (this.cfg.spiral.twistStrength * F.sensGain) *
        ((wT * F.bands.treble * 0.9) - (wB * F.bands.bass * 0.45)) *
        (0.35 + intensity);
      
      const tideTheta = carrier * 0.12;
      
      let theta = theta0 + flow * flowWave * 0.35 + twistAudio * 0.18 + tideTheta;
      
      // Arm lane attraction (MID-locked) — FORWARD-ONLY (no snap-back)
// NOTE: use `let spiralBase` because we may wrap it forward
const armId    = i % armsCount;
const armAngle = (armId / armsCount) * Math.PI * 2;
let spiralBase = armAngle + rBase * this.cfg.arms.pitch;

const snapBoost = (0.25 + 0.75 * midEnergyGlobal) * (0.55 + 0.45 * sensNorm);
const armAssert = THREE.MathUtils.clamp(
  this.cfg.arms.tightness * snapBoost * (0.55 + 0.45 * intensity) * (0.20 + 0.80 * wM),
  0, 1
);

// Wrap spiralBase so it's the nearest equivalent angle AHEAD of theta (prevents reverse)
while (spiralBase < theta) spiralBase += Math.PI * 2;

// Lerp cannot pull backward now
theta = THREE.MathUtils.lerp(theta, spiralBase, armAssert);
theta += Math.sin(t0 * 0.35 + rBase * 0.02 + phase) * this.cfg.arms.wave * armAssert;
      
      // radial: mid breath + bass hit swell + treble pop swell
      const bassSwell = wB * F.bassHit * this.cfg.radial.bassHitSwell * (0.45 + 0.55 * sensNorm);
      const treblePop = wT * (F.bands.treble * F.sensGain) * this.cfg.radial.treblePopRadial * (0.35 + 0.65 * sensNorm);
      
      const r = rBase * (1.0 + breath + bassSwell + treblePop)
        + Math.sin(t0 * 0.45 + theta0 * 3.0 + phase) * (0.55 + intensity) * flow;
      
      // vertical lives in phi (KEEP STABLE): treble can gently lift toward top pole
// bass "snap" must be RADIAL, not phi, to avoid inward/backward recoil on the sphere.

const phiTrebleLift = (wT) * (F.trebleEnv * (0.08 + 0.10 * sensNorm)); // subtle
const phiTarget = THREE.MathUtils.clamp(
  phi0 - phiTrebleLift,
  0.02, Math.PI - 0.02
);

// Exponential smoothing per-point (keeps it silky)
const aPhi = 1.0 - Math.exp(-dt * (10.0 + 18.0 * sensNorm));
const prevPhi = this._phiCache[i] ?? phi0;
const phi = prevPhi + (phiTarget - prevPhi) * aPhi;
this._phiCache[i] = phi;

// --- RADIAL "SPLASH" (OUTWARD SNAP) ---
// Bass hit expands the sphere outward. No sign flips, no latitude shrink.
const radialSplash =
  (wB) *
  (F.bassHit * (0.14 + 0.18 * sensNorm) * (0.55 + 0.45 * intensity));

// optional: add a little sustained bass "weight" outward too
const radialWeight =
  (wB) *
  (F.bassEnv * (0.04 + 0.08 * sensNorm));

// target radius (your existing r already includes breath/swell/pop; we ADD splash here)
const rTarget = r * (1.0 + radialWeight + radialSplash);

// Smooth radius too (dancy, no herky-jerk)
const aR = 1.0 - Math.exp(-dt * (8.0 + 14.0 * sensNorm));
const prevR = this._rCache[i] ?? rBase;
const rS = prevR + (rTarget - prevR) * aR;
this._rCache[i] = rS;

// back to xyz (sphere-consistent)
let x = rS * Math.sin(phi) * Math.cos(theta);
let z = rS * Math.sin(phi) * Math.sin(theta);
const yBase = rS * Math.cos(phi);

      // --- GALACTIC TIDE (sphere-friendly, no jitter, no reversal) ---
// Tangent direction around Y-axis at the current theta (counterclockwise flow)
const tx = -Math.sin(theta);
const tz =  Math.cos(theta);

// Base tide strength (smooth)
const tideBase = this.cfg.swim.fieldSwim * (0.25 + 0.75 * intensity) * F.sensGain;

// Gentle multi-rate carrier for “liquid” feel
const tidePhase = (t0 * 0.75) + (phase * 0.35) + (rBase * 0.004);
const tideMod   = 0.65 + 0.35 * Math.sin(tidePhase);

// Treble adds shimmer (still tangential)
const tTide = this.cfg.swim.trebleBoost * wT * (0.20 + 0.80 * intensity) * F.sensGain;
const tMod  = 0.55 + 0.45 * Math.sin(t0 * 1.35 + phase + rBase * 0.006);

// Bass adds slow undercurrent (still tangential)
const bTide = wB * (0.20 + 0.80 * intensity) * (0.55 + 0.45 * sensNorm);
const bMod  = 0.55 + 0.45 * Math.sin(t0 * 0.42 + phase + rBase * 0.003);

// Apply tangential drift (this reads as “current” instead of wobble)
x += tx * (tideBase * tideMod + tTide * tMod + bTide * bMod);
z += tz * (tideBase * tideMod + tTide * tMod + bTide * bMod);


      // vertical blend (soft)

      // NOTE: phi already handles most vertical motion on the sphere; keep extra Y offsets subtle
      const sphereVertMix = 0.35;
      const droopBase = -this.cfg.vertical.bassDroopMax * F.bassEnv * wB * sphereVertMix;
      const droopHit  = -(this.cfg.vertical.bassHitDroopExtra * F.bassHit) * wB * (0.55 + 0.45 * sensNorm) * sphereVertMix;

      const liftBase  =  this.cfg.vertical.trebleRaiseMax * F.trebleEnv * wT * sphereVertMix;
      const liftPop   =  (this.cfg.vertical.treblePopY * F.bands.treble * F.sensGain) * wT * (0.35 + 0.65 * intensity) * sphereVertMix;

      const yShimmer = Math.sin(now * 0.00085 + i * 0.007 + phase) * (0.18 + intensity) * F.sensGain;

      // Mid band thickness (bell) blended by wM
      let yMidVolume = 0;
      if (this.cfg.midBand.enabled) {
        const dr = (rBase - this.cfg.midBand.centerR) / Math.max(1e-6, this.cfg.midBand.width);
        const sharp = 1.0 / Math.max(1e-6, this.cfg.midBand.falloff);
        const midShell = Math.exp(-dr * dr * sharp);

        const midEnergy = THREE.MathUtils.clamp(
          midEnergyGlobal * (0.55 + 0.45 * intensity),
          0, 1
        );

        const thick = this.cfg.midBand.thickness * midEnergy * midShell * (0.55 + 0.95 * sensNorm);

        const signRand = (seed < this.cfg.midBand.signSpread) ? -1 : 1;
        yMidVolume = signRand * thick * (0.50 + 0.50 * midWeight) * wM;
      }

      const y = yBase + droopBase + droopHit + liftBase + liftPop + yShimmer + carrier * 0.55 + yMidVolume;

      positions[bi + 0] = x;
      positions[bi + 1] = y;
      positions[bi + 2] = z;

      // Arm gap contrast (structure through glow), also MID-weighted
      const dArm = this._angleDist(theta, spiralBase);
      const armLane = 1.0 - this._smoothstep(0.18, 0.55, dArm);
      const laneContrast = 1.0 - (1.0 - armLane) * this.cfg.arms.gapStrength * (0.30 + 0.70 * wM);

      // color
      const baseHue = this.baseHues ? this.baseHues[i] : 0.6;
      const hue = (baseHue + F.bands.treble * 0.06 + intensity * 0.03 + wT * 0.015) % 1.0;

      const sat = THREE.MathUtils.clamp(0.35 + sensNorm * 0.65, 0.0, 1.0);

      let energy = THREE.MathUtils.clamp(
        0.12 + (intensity * 0.70 + F.loudness * 0.55)
          + (wT * F.bands.treble * 0.18)
          + (wB * F.bands.bass * 0.10),
        0.0, 1.0
      );

      energy = THREE.MathUtils.clamp(energy * laneContrast, 0, 1);

      const lumMin = 0.10 + sensNorm * 0.18;
      const lumMax = 0.26 + sensNorm * 0.44;
      const lum    = THREE.MathUtils.lerp(lumMin, lumMax, energy);

      c.setHSL(hue, sat, lum);

      colors[bi + 0] = c.r;
      colors[bi + 1] = c.g;
      colors[bi + 2] = c.b;
    }

    posAttr.needsUpdate   = true;
    colAttr.needsUpdate   = true;
    shapeAttr.needsUpdate = true;

  }

  animate() {
    if (!this.isActive) return;
    this.rafId = requestAnimationFrame(() => this.animate());

    if (this.controls) this.controls.update();

    if (this.stars) this.stars.rotation.y += this.cfg.rotation.autoRotateSpeed;

    this.updateStars();

    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  // ---------- LIFECYCLE ----------
  dispose() {
    this.isActive = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);

    this.clearStars();

    window.removeEventListener('resize', this._onResize);

    if (this.sensitivityEl) {
      this.sensitivityEl.removeEventListener('input', this._onSensInput);
    }

    if (this.controls) {
      this.controls.dispose();
      this.controls = null;
    }

    this.composer?.dispose();
    this.composer = null;
    this.renderPass = null;
    this.bloomPass = null;

    this.renderer.dispose();
  }
}