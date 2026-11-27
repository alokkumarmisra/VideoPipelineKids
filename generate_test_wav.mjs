// Generate a test WAV file (440Hz sine wave, 2 seconds, 16kHz, 16-bit mono)
import { writeFileSync } from 'fs';
import { resolve } from 'path';

function generateSineWav(frequency, duration, sampleRate = 16000, amplitude = 0.5) {
  const numSamples = sampleRate * duration;
  const pcmData = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    pcmData[i] = amplitude * Math.sin(2 * Math.PI * frequency * t);
  }
  
  // Convert Float32 to 16-bit PCM
  const numBytes = numSamples * 2;
  const pcmBuffer = Buffer.alloc(numBytes);
  for (let i = 0; i < numSamples; i++) {
    const intSample = Math.max(-1, Math.min(1, pcmData[i])) * 32767;
    pcmBuffer.writeInt16BE(intSample, i * 2);
  }
  
  // WAV header (44 bytes) - build directly
  const totalSize = 36 + numBytes;
  const wav = Buffer.alloc(totalSize);
  
  // RIFF chunk descriptor
  wav.write('RIFF', 0, 4, 'ascii');
  wav.writeUInt32LE(totalSize - 8, 4, true); // file size - 8
  wav.write('WAVE', 8, 4, 'ascii');
  
  // fmt sub-chunk
  wav.write('fmt ', 12, 4, 'ascii');
  wav.writeUInt32LE(16, 16, true); // sub-chunk size
  wav.writeUInt16LE(1, 20, true); // audio format (PCM)
  wav.writeUInt16LE(1, 22, true); // channels (mono)
  wav.writeUInt32LE(sampleRate, 24, true); // sample rate
  wav.writeUInt32LE(sampleRate * 2, 28, true); // byte rate
  wav.writeUInt16LE(2, 32, true); // block align
  wav.writeUInt16LE(16, 34, true); // bits per sample
  
  // data sub-chunk
  wav.write('data', 40, 4, 'ascii');
  wav.writeUInt32LE(numBytes, 44, true);
  
  // PCM data
  wav.fill(0, 44, totalSize);
  
  // Write PCM samples - interleave left/right for mono (just copy)
  for (let i = 0; i < numSamples; i++) {
    const intSample = Math.max(-1, Math.min(1, pcmData[i])) * 32767;
    wav.writeInt16BE(intSample, 44 + i * 2);
  }
  
  return wav;
}

const wavBuffer = generateSineWav(440, 2, 16000);
writeFileSync(resolve('test_audio.wav'), wavBuffer);
console.log('Generated test_audio.wav, size:', wavBuffer.length, 'bytes');

// Also generate lyrics that match the audio
const lyrics = 'हेरा रे हीरा रे होला रे';
writeFileSync(resolve('test_lyrics.txt'), lyrics);
console.log('Generated test lyrics:', lyrics);