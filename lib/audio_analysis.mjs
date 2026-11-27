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

/**
 * Frame-level audio ACTIVITY from raw PCM (mono Float32). This is an ENERGY
 * estimator, not a vocal detector: a frame above the noise floor means "sound
 * is present" (voice, singing, OR instruments) and a frame below it means
 * "quiet / silence". It answers exactly one question for the master timeline:
 * "is this stretch of the song audible at all?" — every stronger claim
 * (voice vs instrument) needs a real VAD/voice model, which the WhisperX
 * VAD pass supplies when available.
 *
 * Method: 50ms frames whose RMS clears a robust noise floor
 * (20th-percentile frame energy with a tolerance margin), merged
 * with smoothing so tiny noise flips and consonant/syllable dips do not
 * shatter one sung phrase into slivers. Pure + deterministic, zero dependencies.
 */
export function estimateAudioActivity(pcm, sampleRate = 11025) {
  const total = pcm.length / sampleRate;
  const hop = Math.max(64, Math.round(sampleRate * .05));
  const frame = Math.max(hop, Math.round(sampleRate * .05));
  const energies = [];
  for (let start = 0; start < pcm.length; start += hop) {
    const end = Math.min(pcm.length, start + frame);
    if (end <= start) break;
    let sum = 0;
    for (let i = start; i < end; i++) sum += pcm[i] * pcm[i];
    energies.push({ t: start / sampleRate, rms: Math.sqrt(sum / (end - start)) });
  }
  const sorted = energies.map((f) => f.rms).slice().sort((a, b) => a - b);
  // Quiet tracks: an absolute floor keeps a near-silent recording from
  // mass-classifying as active; a relative floor adapts to loud masters.
  const floor = Math.max(0.012, Math.min(0.35, (sorted[Math.floor(sorted.length * .2)] || 0) * 1.6));
  const frameSeconds = hop / sampleRate;
  const runs = [];
  {
    let at = 0;
    while (at < energies.length) {
      const value = energies[at].rms > floor;
      let cursor = at + 1;
      while (cursor < energies.length && (energies[cursor].rms > floor) === value) cursor += 1;
      runs.push({ value, start: at, end: cursor });
      at = cursor;
    }
  }
  // smoothing: tiny active blobs (<150ms) are noise flips; short low dips
  // (<350ms) inside sound are consonant/syllable breaks, not real gaps.
  const smooth = [
    ...runs.filter((r) => r.value && (r.end - r.start) * frameSeconds < 0.15).map((r) => ({ ...r, value: false })),
    ...runs.filter((r) => !(r.value && (r.end - r.start) * frameSeconds < 0.15)),
  ].sort((a, b) => a.start - b.start);
  const rebuilt = [];
  for (const r of smooth) {
    const prev = rebuilt[rebuilt.length - 1];
    if (prev && prev.value === r.value) { prev.end = r.end; continue; }
    rebuilt.push({ ...r });
  }
  const segments = [];
  for (const [i, r] of rebuilt.entries()) {
    if (!r.value) {
      // A short low dip surrounded by sound is absorbed (syllable/consonant
      // break, not a real gap).
      const before = rebuilt[i - 1];
      const after = rebuilt[i + 1];
      const seconds = (r.end - r.start) * frameSeconds;
      if (seconds < 0.35 && before && before.value && after && after.value) continue;
    }
    const a = Math.round(Math.max(0, r.start * frameSeconds) * 100) / 100;
    const b = Math.round(Math.min(total, r.end * frameSeconds) * 100) / 100;
    if (b - a < 0.05) continue;
    const last = segments[segments.length - 1];
    if (last && last.activity === (r.value ? "audio" : "low") && Math.abs(last.end - a) < 0.011) {
      last.end = b; // contiguous same-activity rows merge into one
      continue;
    }
    segments.push({ start: a, end: b, activity: r.value ? "audio" : "low" });
  }
  const activeSeconds = segments
    .filter((s) => s.activity === "audio")
    .reduce((acc, s) => acc + (s.end - s.start), 0);
  return {
    status: "estimated",
    method: "energy-silence-heuristic",
    note: "Energy/silence estimate from PCM — 'audio' means sound is present (voice OR instruments), not that vocals were detected.",
    active_seconds: Math.round(activeSeconds * 100) / 100,
    total_seconds: Math.round(pcm.length / sampleRate * 100) / 100,
    segments,
  };
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
    // Honest audio-activity estimate (see estimateAudioActivity): answers
    // "is sound present here", never "are these vocals".
    vocalActivity: estimateAudioActivity(pcm, sampleRate),
  };
}
