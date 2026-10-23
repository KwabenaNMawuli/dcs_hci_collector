/**
 * mp3-encoder.js
 * In-browser MP3 encoder using Web Audio API and lamejs.
 * Converts recorded audio blobs (WebM, WAV, OGG, MP4) directly to standard MP3.
 */

'use strict';

/**
 * Converts any audio Blob to a standard MP3 Blob.
 * @param {Blob} sourceBlob - The raw recorded audio Blob (e.g. from MediaRecorder)
 * @param {number} [kbps=128] - Bitrate in kbps (128 is ideal for voice)
 * @returns {Promise<Blob>} Standard MP3 Blob with MIME type audio/mp3
 */
async function audioBlobToMp3(sourceBlob, kbps = 128) {
  if (!window.lamejs || !window.lamejs.Mp3Encoder) {
    throw new Error('MP3 encoder (lamejs) is not loaded.');
  }

  // 1. Read array buffer
  const arrayBuffer = await sourceBlob.arrayBuffer();

  // 2. Decode into PCM AudioBuffer
  const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
  const audioCtx = new AudioCtxClass();
  let audioBuffer;
  try {
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  } finally {
    try { audioCtx.close(); } catch (_) {}
  }

  // 3. Prepare single channel (mono is optimal for voice)
  const sampleRate = audioBuffer.sampleRate;
  const numChannels = 1;
  const channelData = audioBuffer.getChannelData(0);

  // 4. Convert Float32Array [-1.0, 1.0] to Int16Array [-32768, 32767]
  const samples = new Int16Array(channelData.length);
  for (let i = 0; i < channelData.length; i++) {
    const s = Math.max(-1, Math.min(1, channelData[i]));
    samples[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }

  // 5. Encode PCM to MP3 chunks
  const encoder = new window.lamejs.Mp3Encoder(numChannels, sampleRate, kbps);
  const mp3Data = [];
  const blockSize = 1152; // LAME standard block size

  for (let i = 0; i < samples.length; i += blockSize) {
    const chunk = samples.subarray(i, i + blockSize);
    const mp3buf = encoder.encodeBuffer(chunk);
    if (mp3buf.length > 0) {
      mp3Data.push(mp3buf);
    }
  }

  const flushed = encoder.flush();
  if (flushed.length > 0) {
    mp3Data.push(flushed);
  }

  return new Blob(mp3Data, { type: 'audio/mp3' });
}

window.audioBlobToMp3 = audioBlobToMp3;

