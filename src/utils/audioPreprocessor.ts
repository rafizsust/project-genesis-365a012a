/**
 * Audio Preprocessor for Whisper Transcription
 * 
 * Industry-standard preprocessing pipeline optimized for Whisper accuracy:
 * 1. Volume normalization to -3dB peak (CRITICAL - fixes missing quiet speech)
 * 2. Resampling to 16kHz mono (Whisper's native format - reduces artifacts)
 * 3. High-pass filter at 80Hz (removes rumble/hum that causes hallucinations)
 * 
 * Based on OpenAI docs, HuggingFace, Groq docs, and GitHub discussions 2024-2025.
 * 
 * DO NOT add aggressive noise reduction - research shows Whisper is robust to noise
 * and heavy denoising distorts speech frequencies, hurting accuracy.
 */

const TARGET_SAMPLE_RATE = 16000;
const TARGET_PEAK_AMPLITUDE = 0.7;  // -3dB
const HIGH_PASS_CUTOFF_HZ = 80;
const MAX_AMPLITUDE = 0.95;  // Headroom to prevent clipping

/**
 * Preprocess audio for optimal Whisper transcription accuracy.
 * 
 * @param audioBlob - Raw audio blob from recording
 * @returns Preprocessed WAV blob optimized for Whisper
 */
export async function preprocessAudioForWhisper(audioBlob: Blob): Promise<Blob> {
  console.log(`[audioPreprocessor] Starting preprocessing (${(audioBlob.size / 1024).toFixed(1)}KB input)`);

  try {
    // Step 1: Decode audio to AudioBuffer
    const audioContext = new AudioContext();
    const arrayBuffer = await audioBlob.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    console.log(`[audioPreprocessor] Decoded: ${audioBuffer.duration.toFixed(2)}s, ${audioBuffer.sampleRate}Hz, ${audioBuffer.numberOfChannels}ch`);

    // Step 2: Resample to 16kHz using OfflineAudioContext
    const targetLength = Math.ceil(audioBuffer.duration * TARGET_SAMPLE_RATE);
    const offlineContext = new OfflineAudioContext(1, targetLength, TARGET_SAMPLE_RATE);

    const source = offlineContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineContext.destination);
    source.start(0);

    const resampledBuffer = await offlineContext.startRendering();
    console.log(`[audioPreprocessor] Resampled to ${TARGET_SAMPLE_RATE}Hz (${resampledBuffer.length} samples)`);

    // Step 3: Convert to mono (already mono from OfflineAudioContext)
    // Copy to a new Float32Array to ensure proper type
    const channelData = resampledBuffer.getChannelData(0);
    const monoSamples = new Float32Array(channelData.length);
    monoSamples.set(channelData);

    // Step 4: Apply high-pass filter at 80Hz (removes rumble)
    const filteredSamples = applyHighPassFilter(monoSamples, TARGET_SAMPLE_RATE, HIGH_PASS_CUTOFF_HZ);
    console.log(`[audioPreprocessor] Applied ${HIGH_PASS_CUTOFF_HZ}Hz high-pass filter`);

    // Step 5: Normalize volume to -3dB peak (0.7 amplitude) - CRITICAL
    const normalizedSamples = normalizeVolume(filteredSamples);

    // Step 6: Encode to 16-bit PCM WAV
    const wavBlob = encodeToWav(normalizedSamples, TARGET_SAMPLE_RATE);
    console.log(`[audioPreprocessor] Output: ${(wavBlob.size / 1024).toFixed(1)}KB WAV`);

    await audioContext.close();

    return wavBlob;
  } catch (err) {
    console.warn('[audioPreprocessor] Preprocessing failed, returning original:', err);
    return audioBlob;
  }
}

/**
 * Apply first-order RC high-pass filter to remove low-frequency rumble.
 * This removes AC hum, mic handling noise, and low-frequency rumble that causes hallucinations.
 */
function applyHighPassFilter(samples: Float32Array, sampleRate: number, cutoffHz: number): Float32Array {
  const RC = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / sampleRate;
  const alpha = RC / (RC + dt);

  const output = new Float32Array(samples.length);

  let prevInput = samples[0] || 0;
  let prevOutput = 0;

  for (let i = 0; i < samples.length; i++) {
    const input = samples[i];
    output[i] = alpha * (prevOutput + input - prevInput);
    prevInput = input;
    prevOutput = output[i];
  }

  return output;
}

/**
 * Normalize volume to -3dB peak (0.7 amplitude).
 * This ensures quiet speech at the start isn't missed by Whisper.
 */
function normalizeVolume(samples: Float32Array): Float32Array {
  // Find peak amplitude
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) peak = abs;
  }

  console.log(`[audioPreprocessor] Peak amplitude: ${peak.toFixed(4)}`);

  // If peak is below 0.5 (quiet audio), normalize to target
  if (peak > 0 && peak < 0.5) {
    const gain = TARGET_PEAK_AMPLITUDE / peak;
    console.log(`[audioPreprocessor] Normalizing with gain: ${gain.toFixed(2)}x`);

    const normalized = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      // Apply gain and clamp to prevent clipping
      const amplified = samples[i] * gain;
      normalized[i] = Math.max(-MAX_AMPLITUDE, Math.min(MAX_AMPLITUDE, amplified));
    }
    return normalized;
  }

  // Audio is already at reasonable level, just ensure no clipping
  if (peak > MAX_AMPLITUDE) {
    const gain = MAX_AMPLITUDE / peak;
    console.log(`[audioPreprocessor] Reducing to prevent clipping, gain: ${gain.toFixed(2)}x`);

    const normalized = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      normalized[i] = samples[i] * gain;
    }
    return normalized;
  }

  return samples;
}

/**
 * Encode Float32 samples to 16-bit PCM WAV.
 */
function encodeToWav(samples: Float32Array, sampleRate: number): Blob {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataLength = samples.length * bytesPerSample;
  const headerLength = 44;
  const totalLength = headerLength + dataLength;

  const arrayBuffer = new ArrayBuffer(totalLength);
  const view = new DataView(arrayBuffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  // WAV header
  writeString(0, 'RIFF');
  view.setUint32(4, totalLength - 8, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);  // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataLength, true);

  // Write samples as 16-bit PCM
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(offset, intSample, true);
    offset += 2;
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}
