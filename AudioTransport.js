/**
 * VEIL — Virtual Experiential Interactive Landscape
 * © 2026 Cassidy Howell
 *
 * This file is part of VEIL BETA v1.0.
 * Source is shared for reference only.
 * Unauthorized use, reproduction, or derivative works are prohibited.
 */

export class AudioTransport {
    constructor(audioContext, analyser) {
      this.audioContext = audioContext;
      this.analyser = analyser;
  
      this.audioBuffer = null;
      this.source = null;
  
      this.isPlaying = false;
      this.playStartTime = 0;
      this.pauseOffset = 0;
      this.duration = 0;
  
      this.onEnded = null;
    }
  
    async loadFile(file) {
      // Stop anything currently playing
      this.pause();
  
      const buf = await file.arrayBuffer();
      this.audioBuffer = await this.audioContext.decodeAudioData(buf);
  
      this.duration = this.audioBuffer.duration || 0;
      this.pauseOffset = 0;
      this.playStartTime = 0;
    }
  
    async play() {
      if (!this.audioBuffer || this.isPlaying) return;
  
      if (this.audioContext.state === 'suspended') {
        try { await this.audioContext.resume(); } catch {}
      }
  
      // Kill old source if any
      if (this.source) {
        try { this.source.stop(0); } catch {}
        try { this.source.disconnect(); } catch {}
        this.source = null;
      }
  
      const d = this.duration || this.audioBuffer.duration || 0;
      this.pauseOffset = Math.min(Math.max(0, this.pauseOffset), Math.max(0, d - 0.01));
  
      this.source = this.audioContext.createBufferSource();
      this.source.buffer = this.audioBuffer;
      this.source.connect(this.analyser);
  
      this.playStartTime = this.audioContext.currentTime - this.pauseOffset;
      this.source.start(0, this.pauseOffset);
  
      this.isPlaying = true;
  
      this.source.onended = () => {
        this.isPlaying = false;
        this.pauseOffset = 0;
        this.playStartTime = 0;
        if (this.onEnded) this.onEnded();
      };
    }
  
    pause() {
      if (this.isPlaying) {
        this.pauseOffset = Math.max(
          0,
          this.audioContext.currentTime - this.playStartTime
        );
      }
  
      if (this.source) {
        try { this.source.stop(0); } catch {}
        try { this.source.disconnect(); } catch {}
        this.source = null;
      }
  
      this.isPlaying = false;
    }
  
    reset() {
      this.pause();
      this.pauseOffset = 0;
      this.playStartTime = 0;
    }
  
    getCurrentTime() {
      if (!this.audioBuffer) return 0;
      if (this.isPlaying) {
        return Math.max(0, this.audioContext.currentTime - this.playStartTime);
      }
      return this.pauseOffset;
    }
  }
  