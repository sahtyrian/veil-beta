/**
 * VEIL — Virtual Experiential Interactive Landscape
 * © 2026 Cassidy Howell
 *
 * This file is part of VEIL BETA v1.0.
 * Source is shared for reference only.
 * Unauthorized use, reproduction, or derivative works are prohibited.
 */

import * as THREE from 'three';

// Headless NeuralMap DNA generator (no rendering, just data)
export function buildMapDataFromAudio(audioBuffer, audioHash = 'seed') {
  const seededRandom = (seed) => {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
    return () => {
      h = (Math.imul(1664525, h) + 1013904223) | 0;
      return (h >>> 0) / 4294967296;
    };
  };

  const maxAbs = (arr) => {
    let m = 0;
    for (let i = 0; i < arr.length; i++) {
      const v = Math.abs(arr[i]);
      if (v > m) m = v;
    }
    return m;
  };

  const extractDominantFrequency = (data) => {
    let zeroCrossings = 0;
    for (let i = 1; i < data.length; i++) {
      if ((data[i - 1] >= 0) !== (data[i] >= 0)) zeroCrossings++;
    }
    return zeroCrossings / data.length;
  };

  const data = audioBuffer.getChannelData(0);
  const rand = seededRandom(audioHash || 'seed');
  const duration = audioBuffer.duration;

  const nodeCount = Math.max(50, Math.min(200, Math.floor(duration * 10)));
  const step = Math.max(1, Math.floor(data.length / nodeCount));

  const nodes = new Array(nodeCount);

  // Nodes
  for (let i = 0; i < nodeCount; i++) {
    const start = i * step;
    const end = Math.min(data.length, (i + 1) * step);
    const slice = data.subarray(start, end);

    const amp = maxAbs(slice);
    const freq = extractDominantFrequency(slice);

    const x = (i / nodeCount - 0.5) * 40 + (rand() - 0.5) * 10;
    const y = (amp - 0.5) * 80 + Math.sin(freq * 0.1) * 20;
    const z = (rand() - 0.5) * 30 + Math.cos(i * 0.001) * 10;

    const hue = (i / nodeCount + amp) % 1;

    nodes[i] = {
      id: i,
      position: new THREE.Vector3(x, y, z),
      freq,
      amp,
      hue,
      connections: []
    };
  }

  // Connections (same rule as Map)
  const maxDist = 8;
  for (let i = 0; i < nodeCount; i++) {
    for (let j = 0; j < nodeCount; j++) {
      if (i === j) continue;
      const dist = nodes[i].position.distanceTo(nodes[j].position);
      if (dist < maxDist && rand() < 0.7) {
        nodes[i].connections.push(j);
      }
    }
  }

  return nodes;
}
