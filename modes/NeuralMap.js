/**
 * VEIL — Virtual Experiential Interactive Landscape
 * © 2026 Cassidy Howell
 *
 * This file is part of VEIL BETA v1.0.
 * Source is shared for reference only.
 * Unauthorized use, reproduction, or derivative works are prohibited.
 */

// modes/NeuralMap.js
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * VEIL — NeuralMap Mode
 * Micro-level algorithmic framework (neuron layer)
 * Exports node data to NeuralGalaxy when switching modes.
 */

export class NeuralMap {
  constructor(shared) {
    this.shared       = shared;
    this.audioContext = shared.audioContext;
    this.analyser     = shared.analyser;
    this.gainNode     = shared.gainNode;

    // UI
    this.canvas        = document.getElementById('neuralCanvas');
    this.containerEl   = document.getElementById('container');
    this.playBtn       = document.getElementById('playBtn');
    this.pauseBtn      = document.getElementById('pauseBtn');
    this.sensitivityEl = shared.sensitivityEl;
    this.volumeEl      = shared.volumeEl;
    this.audioHashEl   = shared.audioHashEl;
    this.nodeInfoEl    = document.getElementById('nodeInfo');

    // Three.js core
    this.scene    = new THREE.Scene();
    this.camera   = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    // Audio
    this.audioBuffer = shared.lastAudioBuffer || null; // <-- hydrate from shared
    this.source      = null;
    this.isPlaying   = false;

    // Data
    this.nodes       = [];
    this.connections = [];
    this.nodeGroup   = new THREE.Group();
    this.audioHash   = '';

    // Interaction
    this.raycaster = new THREE.Raycaster();
    this.pointer   = new THREE.Vector2();
    
    const infoBox = document.getElementById('info');
    if (infoBox) infoBox.style.display = '';

    // Transport state (true pause / resume)
this.playStartTime = 0;   // audioContext.currentTime when playback started
this.pauseOffset   = 0;   // seconds into track where we paused
this.duration      = 0;   // cached duration of buffer

// Animation control
    this.isActive = true;
    this.rafId    = null;

    // Bound handlers (so we can remove them on dispose)
    this._onResize      = this.sizeToContainer.bind(this);
    this._onPointerDown = this.onPointerDown.bind(this);

    this.init();
  }

  // ---------- INIT ----------
  init() {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.sizeToContainer();
    this.renderer.setClearColor(0x000000);
    this.camera.position.set(0, 0, 50);

    this.scene.add(new THREE.AmbientLight(0x404040, 0.4));
    const light1 = new THREE.PointLight(0x00ff88, 1, 100);
    light1.position.set(20, 20, 20);
    this.scene.add(light1);
    const light2 = new THREE.PointLight(0x00aaff, 1, 100);
    light2.position.set(-20, -20, -20);
    this.scene.add(light2);
    this.scene.add(this.nodeGroup);

    window.addEventListener('resize', this._onResize);
    this.canvas.addEventListener('pointerdown', this._onPointerDown);

    // If a song was already loaded (coming back from Galaxy), rebuild immediately
    if (this.audioBuffer) {
      this.audioHash = this.computeAudioHash(this.audioBuffer);
      if (this.audioHashEl) {
        this.audioHashEl.textContent = `Hash: ${this.audioHash}`;
      }
      this.clearNetwork();
      this.buildNetFromAudio(this.audioBuffer);

      if (this.playBtn && this.pauseBtn) {
        this.playBtn.disabled  = false;
        this.pauseBtn.disabled = true;
      }
    }

    this.animate();
  }

  sizeToContainer() {
    const rect   = this.containerEl.getBoundingClientRect();
    const width  = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  // ---------- UTILITIES ----------
  seededRandom(seed) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) {
      h = Math.imul(31, h) + seed.charCodeAt(i) | 0;
    }
    return () => {
      h = Math.imul(1664525, h) + 1013904223 | 0;
      return (h >>> 0) / 4294967296;
    };
  }

  computeAudioHash(buffer) {
    const data = buffer.getChannelData(0);
    let hash = 0;
    for (let i = 0; i < data.length; i += 1000) {
      hash = Math.imul(31, hash) + (data[i] * 100000 | 0);
    }
    return Math.abs(hash).toString(16);
  }

  onNewAudio(audioBuffer) {
    this.audioBuffer = audioBuffer;
    this.shared.lastAudioBuffer = audioBuffer;
  
    this.audioHash = this.computeAudioHash(audioBuffer);
    this.shared.songHash = this.audioHash;
  
    if (this.audioHashEl) {
      this.audioHashEl.textContent = `Hash: ${this.audioHash}`;
    }
  
    this.clearNetwork();
    this.buildNetFromAudio(this.audioBuffer);
  
    if (this.playBtn && this.pauseBtn) {
      this.playBtn.disabled  = false;
      this.pauseBtn.disabled = true;
    }
  }

  async play() {
    if (this.shared?.transport) await this.shared.transport.play();
    if (this.playBtn && this.pauseBtn) { this.playBtn.disabled = true; this.pauseBtn.disabled = false; }
  }
  
  pause() {
    if (this.shared?.transport) this.shared.transport.pause();
    if (this.playBtn && this.pauseBtn) { this.playBtn.disabled = false; this.pauseBtn.disabled = true; }
  }
  
  reset() {
    if (this.shared?.transport) this.shared.transport.reset();
    if (this.playBtn && this.pauseBtn) { this.playBtn.disabled = false; this.pauseBtn.disabled = true; }
  }
  

  clearNetwork() {
    this.nodes.forEach(n => {
      this.nodeGroup.remove(n);
      n.geometry?.dispose();
      n.material?.dispose();
    });
    this.connections.forEach(c => {
      this.nodeGroup.remove(c.line);
      c.line.geometry?.dispose();
      c.line.material?.dispose();
    });
    this.nodes = [];
    this.connections = [];
  }

  buildNetFromAudio(buffer) {
    const data      = buffer.getChannelData(0);
    const rand      = this.seededRandom(this.audioHash || 'seed');
    const duration  = buffer.duration;
    const nodeCount = Math.max(50, Math.min(200, Math.floor(duration * 10)));
    const step      = Math.max(1, Math.floor(data.length / nodeCount));

    for (let i = 0; i < nodeCount; i++) {
      const slice = data.slice(i * step, (i + 1) * step);
      const amp   = this.maxAbs(slice);
      const freq  = this.extractDominantFrequency(slice);

      const x = (i / nodeCount - 0.5) * 40 + (rand() - 0.5) * 10;
      const y = (amp - 0.5) * 80 + Math.sin(freq * 0.1) * 20;
      const z = (rand() - 0.5) * 30 + Math.cos(i * 0.001) * 10;

      const hue   = (i / nodeCount + amp) % 1;
      const color = new THREE.Color().setHSL(hue, 0.7, 0.5);
      const geometry = new THREE.SphereGeometry(0.2 + amp * 0.3, 16, 16);
      const material = new THREE.MeshPhongMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.4,
      });

      const node = new THREE.Mesh(geometry, material);
      node.position.set(x, y, z);
      node.userData = { id: i, amp, freq, hue, connections: [], baseY: y };

      this.nodes.push(node);
      this.nodeGroup.add(node);
    }

    const maxDist = 8;
    this.nodes.forEach((a, i) => {
      this.nodes.forEach((b, j) => {
        if (i === j) return;
        const dist = a.position.distanceTo(b.position);
        if (dist < maxDist && rand() < 0.7) {
          const line = this.createConnection(a, b);
          this.connections.push(line);
          a.userData.connections.push(j);
        }
      });
    });
  }

  createConnection(a, b) {
    const points   = [a.position, b.position];
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: 0x00ff88,
      opacity: 0.3,
      transparent: true,
    });
    const line = new THREE.Line(geometry, material);
    this.nodeGroup.add(line);
    return { line, a, b };
  }

  maxAbs(arr) {
    return arr.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  }

  extractDominantFrequency(data) {
    let zeroCrossings = 0;
    for (let i = 1; i < data.length; i++) {
      if ((data[i - 1] >= 0) !== (data[i] >= 0)) zeroCrossings++;
    }
    return zeroCrossings / data.length;
  }

  // ---------- EXPORT BRIDGE ----------
  exportNetwork() {
    return this.nodes.map(n => ({
      id:          n.userData.id,
      position:    n.position.clone(),
      freq:        n.userData.freq,
      amp:         n.userData.amp,
      hue:         n.userData.hue,
      connections: n.userData.connections,
    }));
  }
  
  
  // ---------- UPDATE LOOP ----------
  update() {
    if (!this.analyser || this.nodes.length === 0) return;

    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(dataArray);
    const sensitivity = parseFloat(this.sensitivityEl?.value || '1');

    this.nodes.forEach((node, i) => {
      const fIndex  = Math.floor((i / this.nodes.length) * dataArray.length);
      const freqVal = dataArray[fIndex] / 255;
      const scale   = 1 + freqVal * sensitivity * 2;
      node.scale.setScalar(scale);
      node.material.emissiveIntensity = 0.3 + freqVal * 2;
    });
  }

  onPointerDown(e) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const intersects = this.raycaster.intersectObjects(this.nodes);
    if (intersects.length > 0) {
      const node = intersects[0].object;
      if (this.nodeInfoEl) {
        this.nodeInfoEl.textContent =
          `Neuron ID: ${node.userData.id}\nConnections: ${node.userData.connections.length}`;
      }
    }
  }

  animate() {
    if (!this.isActive) return;
    this.rafId = requestAnimationFrame(() => this.animate());
    this.controls.update();
    this.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.isActive = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);

    window.removeEventListener('resize', this._onResize);
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);

    this.scene.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
        else o.material.dispose();
      }
    });
    this.renderer.dispose();
  }
}
