/**
 * wav-encoder.js
 * DCS HCI Audio Collector — Lossless PCM WAV Audio Recorder & Encoder
 * Captures microphone stream directly to standard 16-bit uncompressed WAV format.
 * Fully compatible with all mobile devices (iOS Safari, Android Chrome) and desktop browsers.
 */

'use strict';

(function (window) {
  /**
   * Encodes Float32Array PCM samples into a standard 16-bit Mono WAV Blob.
   * @param {Float32Array} samples - Raw audio samples between -1.0 and 1.0
   * @param {number} sampleRate - Audio sample rate in Hz (e.g. 44100 or 48000)
   * @returns {Blob} Standard audio/wav Blob
   */
  function encodeWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    function writeString(offset, string) {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    }

    const numChannels = 1; // Mono is optimal for speech collection
    const bytesPerSample = 2; // 16-bit
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = samples.length * bytesPerSample;

    // RIFF identifier
    writeString(0, 'RIFF');
    // RIFF chunk length
    view.setUint32(4, 36 + dataSize, true);
    // RIFF type
    writeString(8, 'WAVE');
    // Format chunk identifier
    writeString(12, 'fmt ');
    // Format chunk length (16 for PCM)
    view.setUint32(16, 16, true);
    // Audio format (1 = Linear PCM)
    view.setUint16(20, 1, true);
    // Channel count
    view.setUint16(22, numChannels, true);
    // Sample rate
    view.setUint32(24, sampleRate, true);
    // Byte rate
    view.setUint32(28, byteRate, true);
    // Block align
    view.setUint16(32, blockAlign, true);
    // Bits per sample
    view.setUint16(34, 16, true);
    // Data chunk identifier
    writeString(36, 'data');
    // Data chunk length
    view.setUint32(40, dataSize, true);

    // Write 16-bit PCM samples with clipping protection
    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      const int16 = s < 0 ? s * 0x8000 : s * 0x7fff;
      view.setInt16(offset, int16, true);
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  /**
   * Fallback converter: converts any audio Blob into a WAV Blob using Web Audio API.
   * @param {Blob} sourceBlob
   * @returns {Promise<Blob>}
   */
  async function audioBlobToWav(sourceBlob) {
    if (!sourceBlob) throw new Error('No audio blob provided');

    // If it is already a WAV file, return it directly
    if (sourceBlob.type && sourceBlob.type.includes('wav')) {
      return sourceBlob;
    }

    const arrayBuffer = await sourceBlob.arrayBuffer();
    const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioCtxClass();

    try {
      // Decode audio data into AudioBuffer (cloned buffer to prevent Safari detachment)
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
      const channelData = audioBuffer.getChannelData(0);
      return encodeWav(channelData, audioBuffer.sampleRate);
    } finally {
      try { audioCtx.close(); } catch (_) {}
    }
  }

  /**
   * Direct PCM Microphone Recorder.
   * Collects raw audio samples directly from the Web Audio graph.
   * Guarantees 100% valid WAV files without MediaRecorder container issues.
   */
  class WavRecorder {
    constructor() {
      this.audioCtx = null;
      this.micSource = null;
      this.processor = null;
      this.chunks = [];
      this.sampleRate = 44100;
      this.isRecording = false;
    }

    start(stream) {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioCtxClass();
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }

      this.sampleRate = this.audioCtx.sampleRate || 44100;
      this.chunks = [];
      this.isRecording = true;

      this.micSource = this.audioCtx.createMediaStreamSource(stream);
      // Buffer size 4096 gives smooth real-time capture
      this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);

      this.processor.onaudioprocess = (e) => {
        if (!this.isRecording) return;
        const inputData = e.inputBuffer.getChannelData(0);
        // Clone input data chunk
        this.chunks.push(new Float32Array(inputData));
      };

      this.micSource.connect(this.processor);
      this.processor.connect(this.audioCtx.destination);
    }

    stop() {
      this.isRecording = false;

      if (this.processor) {
        try { this.processor.disconnect(); } catch (_) {}
        this.processor.onaudioprocess = null;
        this.processor = null;
      }
      if (this.micSource) {
        try { this.micSource.disconnect(); } catch (_) {}
        this.micSource = null;
      }
      if (this.audioCtx) {
        try { this.audioCtx.close(); } catch (_) {}
        this.audioCtx = null;
      }

      // Merge all recorded Float32Array chunks
      let totalLength = 0;
      for (let i = 0; i < this.chunks.length; i++) {
        totalLength += this.chunks[i].length;
      }

      const mergedSamples = new Float32Array(totalLength);
      let offset = 0;
      for (let i = 0; i < this.chunks.length; i++) {
        mergedSamples.set(this.chunks[i], offset);
        offset += this.chunks[i].length;
      }
      this.chunks = [];

      return encodeWav(mergedSamples, this.sampleRate);
    }
  }

  window.encodeWav = encodeWav;
  window.audioBlobToWav = audioBlobToWav;
  window.WavRecorder = WavRecorder;

})(typeof window !== 'undefined' ? window : this);

