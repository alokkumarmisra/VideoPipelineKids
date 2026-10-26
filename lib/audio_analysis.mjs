// Small dependency-free audio feature analysis. Input is mono Float32 PCM.
// Estimates are deliberately labelled as such; this is not source separation.
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function goertzel(samples, sampleRate, frequency) {
  const omega = 2 * Math.PI * frequency / sampleRate;
  const coeff = 2 * Math.cos(omega);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    s0 = samples[i] + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2);
}

function estimateKey(pcm, sampleRate) {
  const size = 4096, chroma = Array(12).fill(0);
  let blocks = 0;
  for (let start = 0; start + size <= pcm.length; start += size * 4) {
    const frame = pcm.subarray(start, start + size);
    for (let note = 0; note < 12; note++) {
      let energy = 0;
      for (let octave = 2; octave <= 6; octave++) {
        const hz = 440 * 2 ** ((note - 9 + (octave - 4) * 12) / 12);
        if (hz < 60 || hz > sampleRate * .45) continue;
        energy += goertzel(frame, sampleRate, hz);
      }
      chroma[note] += energy;
    }
    blocks++;
  }
  if (!blocks) return { key: null, confidence: 0, method: "goertzel-chroma-estimate" };
  const major = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const minor = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const total = chroma.reduce((a, b) => a + b, 0) || 1;
  const profile = chroma.map(x => x / total);
  const scores = [];
  for (let root = 0; root < 12; root++) for (const [mode, tpl] of [["major", major], ["minor", minor]]) {
    let score = 0;
    for (let i = 0; i < 12; i++) score += profile[(i + root) % 12] * tpl[i];
    scores.push({ root, mode, score });
  }
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0], gap = (best.score - scores[1].score) / (Math.abs(best.score) || 1);
  return { key: gap >= .025 ? `${NOTE_NAMES[best.root]} ${best.mode}` : null, confidence: Math.round(clamp(gap * 4, 0, 1) * 100) / 100, method: "goertzel-chroma-estimate" };
}

export function analyzePcm(pcm, sampleRate = 11025) {
  if (!(pcm instanceof Float32Array) || !pcm.length) throw new Error("decoded audio is empty");
  const durationSeconds = pcm.length / sampleRate;
  const hop = Math.max(256, Math.round(sampleRate * .1));
  const rms = [];
  for (let start = 0; start < pcm.length; start += hop) {
    const end = Math.min(pcm.length, start + hop);
    let sum = 0;
    for (let i = start; i < end; i++) sum += pcm[i] * pcm[i];
    rms.push(Math.sqrt(sum / (end - start)));
  }
  const onset = rms.map((v, i) => Math.max(0, v - (rms[i - 1] || 0)));
  const energies = onset.filter(x => x > 0).sort((a, b) => a - b);
  const threshold = energies[Math.floor(energies.length * .65)] || 0;
  const novelty = onset.map(x => Math.max(0, x - threshold));
  const scores = [];
  for (let bpm = 60; bpm <= 180; bpm++) {
    const lag = Math.round(600 / bpm);
    let score = 0, norm = 0;
    for (let i = lag; i < novelty.length; i++) { score += novelty[i] * novelty[i - lag]; norm += novelty[i] * novelty[i]; }
    scores.push({ bpm, score: score / (norm || 1) });
  }
  scores.sort((a, b) => b.score - a.score);
  const peakScore = scores[0].score;
  // Pulse autocorrelation often has equally strong half/double-tempo peaks.
  // In that ambiguity, prefer the double-time candidate when its score is
  // essentially tied. Keep the raw winner otherwise.
  let winner = scores[0];
  if (winner.bpm < 90) {
    const double = scores.find(x => x.bpm === winner.bpm * 2);
    if (double && double.score >= peakScore * .90) winner = double;
  }
  const runner = scores.find(x => Math.abs(x.bpm - winner.bpm) > 8) || { score: 0 };
  const confidence = clamp((winner.score - runner.score) / (winner.score || 1), 0, 1);
  const beats = [];
  if (winner.score > .01 && confidence > .035) {
    const period = 60 / winner.bpm;
    let first = 0, max = 0;
    for (let i = 0; i < novelty.length; i++) if (novelty[i] > max) { max = novelty[i]; first = i * hop / sampleRate; }
    for (let t = first; t < durationSeconds; t += period) beats.push(Math.round(t * 100) / 100);
  }
  let squares = 0, peak = 0;
  for (const value of pcm) { squares += value * value; peak = Math.max(peak, Math.abs(value)); }
  return {
    durationSeconds: Math.round(durationSeconds * 100) / 100,
    bpm: confidence > .035 ? winner.bpm : null,
    bpmConfidence: Math.round(confidence * 100) / 100,
    beatTimes: beats,
    keyEstimate: estimateKey(pcm, sampleRate),
    rms: Math.round(Math.sqrt(squares / pcm.length) * 10000) / 10000,
    peak: Math.round(peak * 10000) / 10000,
    // Energy in a broad speech band is only a weak vocal-presence clue.
    // Do not present it as transcription or reliable source separation.
    vocalActivity: { status: "not_estimated", note: "Requires a vocal detector/source-separation model." },
  };
}
