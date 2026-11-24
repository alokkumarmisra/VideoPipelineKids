// ---------------------------------------------------------------------------
// Master clock — the SINGLE authoritative time source for Kids Studio.
// Pure: no fs / network / db. All 19-track events, scenes and shots derive
// their timing from the original WAV duration via these helpers.
// ---------------------------------------------------------------------------

export const DEFAULT_FRAME_RATE = 30;
export const DEFAULT_SAMPLE_RATE_HZ = 48000;

const num = (v, fb = null) => (Number.isFinite(Number(v)) ? Number(v) : fb);

export function buildMasterClock(durationSeconds, opts = {}) {
  const durationMs = Math.max(0, Math.round(num(durationSeconds, 0) * 1000));
  const frameRate = num(opts.frameRate, DEFAULT_FRAME_RATE) || DEFAULT_FRAME_RATE;
  const sampleRateHz = num(opts.sampleRateHz, DEFAULT_SAMPLE_RATE_HZ) || DEFAULT_SAMPLE_RATE_HZ;
  const totalFrames = Math.round((durationMs / 1000) * frameRate);
  const totalSamples = Math.round((durationMs / 1000) * sampleRateHz);
  return { durationMs, durationSec: durationMs / 1000, frameRate, sampleRateHz, totalFrames, totalSamples };
}

export function msToFrames(ms, frameRate = DEFAULT_FRAME_RATE) {
  return Math.round((num(ms, 0) / 1000) * frameRate);
}

export function framesToMs(frames, frameRate = DEFAULT_FRAME_RATE) {
  return Math.round((num(frames, 0) / frameRate) * 1000);
}

export function msToSamples(ms, sampleRateHz = DEFAULT_SAMPLE_RATE_HZ) {
  return Math.round((num(ms, 0) / 1000) * sampleRateHz);
}

/** Snap a millisecond timestamp to the nearest frame boundary. */
export function quantizeToFrame(ms, frameRate = DEFAULT_FRAME_RATE) {
  return framesToMs(msToFrames(ms, frameRate), frameRate);
}

export function clampToDuration(ms, durationMs) {
  if (!Number.isFinite(Number(ms))) return 0;
  return Math.min(Math.max(0, Math.round(Number(ms))), Math.max(0, Math.round(Number(durationMs))));
}

/**
 * Clamp + frame-quantize a [start, end) range to the master clock.
 * Returns { startMs, endMs, startFrame, endFrame, startSample, endSample, clamped, quantized }.
 * Never invents time outside [0, durationMs].
 */
export function normalizeTimeRange(range = {}, clock = {}) {
  const durationMs = Math.max(0, Math.round(num(clock.durationMs ?? clock.durationSec * 1000, 0)));
  const frameRate = num(clock.frameRate, DEFAULT_FRAME_RATE) || DEFAULT_FRAME_RATE;
  const sampleRateHz = num(clock.sampleRateHz, DEFAULT_SAMPLE_RATE_HZ) || DEFAULT_SAMPLE_RATE_HZ;
  let startMs = clampToDuration(range.startMs ?? range.start_seconds * 1000 ?? range.start ?? 0, durationMs);
  let endMs = clampToDuration(range.endMs ?? range.end_seconds * 1000 ?? range.end ?? 0, durationMs);
  const clamped = startMs !== Math.round(Number(range.startMs ?? range.start ?? startMs)) ||
    endMs !== Math.round(Number(range.endMs ?? range.end ?? endMs));
  startMs = quantizeToFrame(startMs, frameRate);
  endMs = quantizeToFrame(endMs, frameRate);
  if (endMs < startMs) endMs = startMs;
  if (endMs === startMs && endMs < durationMs) {
    endMs = Math.min(durationMs, quantizeToFrame(startMs + 1000 / frameRate, frameRate));
    if (endMs === startMs) endMs = Math.min(durationMs, startMs + 1);
  }
  return {
    startMs, endMs,
    startFrame: msToFrames(startMs, frameRate),
    endFrame: msToFrames(endMs, frameRate),
    startSample: msToSamples(startMs, sampleRateHz),
    endSample: msToSamples(endMs, sampleRateHz),
    clamped, quantized: true,
  };
}

export function validateMasterClock(clock = {}) {
  const errors = [];
  if (!(num(clock.durationMs, 0) > 0)) errors.push("master clock requires a positive durationMs (original WAV authority)");
  if (!(num(clock.frameRate, 0) > 0)) errors.push("master clock requires a positive frameRate");
  if (!(num(clock.sampleRateHz, 0) > 0)) errors.push("master clock requires a positive sampleRateHz");
  return errors;
}
