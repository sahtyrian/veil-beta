/**
 * VEIL — Virtual Experiential Interactive Landscape
 * © 2026 Cassidy Howell
 *
 * This file is part of VEIL BETA v1.0.
 * Source is shared for reference only.
 * Unauthorized use, reproduction, or derivative works are prohibited.
 */

// main.js
import { AudioTransport } from './AudioTransport.js';
import { NeuralMap } from './modes/NeuralMap.js';
import { NeuralGalaxy } from './modes/NeuralGalaxy.js';

const infoBox = document.getElementById('info');

// Available modes
const modes = {
  neuralMap: NeuralMap,
  neuralGalaxy: NeuralGalaxy,
};

let currentVisualizer = null;
let lastMapData = null;

// Shared audio + UI
const shared = {
  audioContext: new (window.AudioContext || window.webkitAudioContext)(),
  analyser: null,
  gainNode: null,
  sensitivityEl: document.getElementById('sensitivity'),
  volumeEl: document.getElementById('volume'),
  audioHashEl: document.getElementById('audioHash'),
  lastAudioBuffer: null,
  songHash: null,
  transport: null,
};

// --- Audio graph ---
shared.analyser = shared.audioContext.createAnalyser();
shared.analyser.fftSize = 256;
shared.analyser.smoothingTimeConstant = 0.8;

shared.gainNode = shared.audioContext.createGain();
shared.analyser.connect(shared.gainNode);
shared.gainNode.connect(shared.audioContext.destination);

// --- Transport (single global playback owner) ---
shared.transport = new AudioTransport(shared.audioContext, shared.analyser);

// --- UI refs ---
const playBtn  = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');
const resetBtn = document.getElementById('resetBtn');
const audioInput = document.getElementById('audioInput');

function setTransportButtonsState(isPlaying) {
  if (!playBtn || !pauseBtn) return;
  playBtn.disabled  = isPlaying || !shared.transport.audioBuffer;
  pauseBtn.disabled = !isPlaying || !shared.transport.audioBuffer;
}

shared.transport.onEnded = () => {
  setTransportButtonsState(false);
};

// --- Volume wiring ---
if (shared.volumeEl) {
  const initialVol = parseFloat(shared.volumeEl.value || '0.8');
  shared.gainNode.gain.value = isNaN(initialVol) ? 0.8 : initialVol;

  shared.volumeEl.addEventListener('input', () => {
    const v = parseFloat(shared.volumeEl.value);
    shared.gainNode.gain.value = isNaN(v) ? 0.8 : v;
  });
}

// --- Transport buttons ---
function wireTransportButtons() {
  if (playBtn) {
    playBtn.onclick = async () => {
      await shared.transport.play();
      setTransportButtonsState(true);
    };
  }

  if (pauseBtn) {
    pauseBtn.onclick = () => {
      shared.transport.pause();
      setTransportButtonsState(false);
    };
  }

  if (resetBtn) {
    resetBtn.onclick = () => {
      shared.transport.reset();
      setTransportButtonsState(false);

      // optional: let the mode reset visuals if it wants
      if (currentVisualizer && typeof currentVisualizer.onTransportReset === 'function') {
        currentVisualizer.onTransportReset();
      }
    };
  }

  // initial state
  setTransportButtonsState(shared.transport.isPlaying);
}

// --- File input ---
function wireFileInput() {
  if (!audioInput) return;

  audioInput.onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const wasPlaying = shared.transport.isPlaying;

    await shared.transport.loadFile(file);

    // keep shared pointer updated for constructors / mode switches
    shared.lastAudioBuffer = shared.transport.audioBuffer;

    // tell current mode “new audio arrived”
    if (currentVisualizer && typeof currentVisualizer.onNewAudio === 'function') {
      currentVisualizer.onNewAudio(shared.lastAudioBuffer);
    }

    // enable play, disable pause (until you hit play)
    setTransportButtonsState(false);

    if (wasPlaying) {
      await shared.transport.play();
      setTransportButtonsState(true);
    }

    // allow re-selecting the same file
    e.target.value = '';
  };
}

// --- Core loader ---
function loadVisualizer(modeName) {
  // Save state from current visualizer (if any)
  if (currentVisualizer) {
    try {
      if (typeof currentVisualizer.exportNetwork === 'function') {
        lastMapData = currentVisualizer.exportNetwork();
      }
      if (typeof currentVisualizer.dispose === 'function') {
        currentVisualizer.dispose();
      }
    } catch (err) {
      console.error('[loadVisualizer] dispose failed:', err);
    }
    currentVisualizer = null;
  }

  const VisualizerClass = modes[modeName];
  if (!VisualizerClass) return;

  // New mode instance gets shared + lastMapData
  currentVisualizer = new VisualizerClass(shared, lastMapData);

  // If audio already loaded, hydrate the new mode immediately
if (shared.lastAudioBuffer && typeof currentVisualizer.onNewAudio === 'function') {
  currentVisualizer.onNewAudio(shared.lastAudioBuffer);
}

  // If audio already loaded, hydrate the new mode immediately
  if (shared.lastAudioBuffer && typeof currentVisualizer.onNewAudio === 'function') {
    currentVisualizer.onNewAudio(shared.lastAudioBuffer);
  }

  // Rewire controls
  wireFileInput();
  wireTransportButtons();
}

// Mode dropdown
const modeSelect = document.getElementById('modeSelect');
if (modeSelect) {
  modeSelect.addEventListener('change', (e) => loadVisualizer(e.target.value));
}

// Boot
loadVisualizer('neuralMap');
wireFileInput();
wireTransportButtons();
