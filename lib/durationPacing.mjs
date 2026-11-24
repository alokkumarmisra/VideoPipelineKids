// ---------------------------------------------------------------------------
// AI Duration & Pacing Intelligence — determines scene/shot segmentation.
// Pure: no fs / network / db. Extension of (not duplicate of) the Director
// timing + lib/master_timeline clip planning. Two authorities:
//   audio-driven: original WAV duration IS the target (sum must match exactly)
//   story-only:   AI estimate from narrative complexity (+ optional override)
// Scene / shot / generation-clip durations are three SEPARATE concepts.
// ---------------------------------------------------------------------------

import { buildMasterClock, quantizeToFrame, DEFAULT_FRAME_RATE } from "./master_clock.mjs";

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => String(v ?? "").trim();
const num = (v, fb = null) => (Number.isFinite(Number(v)) ? Number(v) : fb);

export const GENERATION_CLIP_MIN_S = 3;
export const GENERATION_CLIP_MAX_S = 5;
const MIN_SCENE_MS = 2000;
const MIN_SHOT_MS = 2500;

function boundariesFromTimeline(timeline = {}) {
  const cuts = new Set([0, num(timeline.masterDurationMs, 0)]);
  for (const t of ["music_structure", "lyrics", "narrative_events"]) {
    for (const e of arr(timeline.tracks?.[t])) {
      cuts.add(e.startMs);
      cuts.add(e.endMs);
    }
  }
  return [...cuts].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
}

/** Merge slivers < MIN_SCENE_MS into the neighbor with the closer boundary. */
function toScenes(cuts, timeline, clock) {
  const scenes = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const startMs = cuts[i];
    const endMs = cuts[i + 1];
    if (endMs - startMs < 50) continue;
    scenes.push({ startMs, endMs });
  }
  // merge tiny scenes forward
  const merged = [];
  for (const s of scenes) {
    const prev = merged[merged.length - 1];
    if (prev && s.endMs - s.startMs < MIN_SCENE_MS) {
      prev.endMs = s.endMs;
    } else if (prev && prev.endMs - prev.startMs < MIN_SCENE_MS) {
      prev.endMs = s.endMs;
    } else {
      merged.push({ ...s });
    }
  }
  const out = merged.map((s, i) => {
    const startMs = quantizeToFrame(s.startMs, clock.frameRate);
    const endMs = quantizeToFrame(i === merged.length - 1 ? clock.durationMs : s.endMs, clock.frameRate);
    const sourceEventIds = [];
    for (const t of ["music_structure", "lyrics", "narrative_events"]) {
      for (const e of arr(timeline.tracks?.[t])) {
        if (e.startMs < endMs && e.endMs > startMs) sourceEventIds.push(e.id);
      }
    }
    return {
      sceneId: `scene-${i + 1}`,
      sceneNumber: i + 1,
      startMs, endMs,
      durationMs: Math.max(0, endMs - startMs),
      narrativePurpose: str(arr(timeline.tracks?.music_structure).find((m) => m.startMs < endMs && m.endMs > startMs)?.label) || "narrative development",
      pacing: endMs - startMs > 20000 ? "slow" : endMs - startMs < 8000 ? "fast" : "medium",
      emotionalIntensity: str(arr(timeline.tracks?.emotions).find((m) => m.startMs < endMs && m.endMs > startMs)?.label) || "neutral",
      sourceEventIds: [...new Set(sourceEventIds)],
    };
  });
  // fix rounding drift on the last scene so the sum is EXACT
  const sum = out.reduce((n, s) => n + s.durationMs, 0);
  if (out.length && sum !== clock.durationMs) {
    const last = out[out.length - 1];
    last.endMs = clock.durationMs;
    last.durationMs = Math.max(0, last.endMs - last.startMs);
  }
  return out;
}

function shotsForScene(scene, timeline, clock) {
  const span = scene.endMs - scene.startMs;
  // target ~5s shots, never below MIN_SHOT_MS, never more than 4 per scene here
  const count = Math.max(1, Math.min(4, Math.round(span / 5000) || 1));
  const shots = [];
  let cursor = scene.startMs;
  for (let i = 0; i < count; i++) {
    const isLast = i === count - 1;
    const end = isLast ? scene.endMs : quantizeToFrame(scene.startMs + Math.round((span * (i + 1)) / count), clock.frameRate);
    const word = arr(timeline.tracks?.word_timings).find((w) => w.startMs < end && w.endMs > cursor);
    shots.push({
      shotId: `${scene.sceneId}-shot-${i + 1}`,
      startMs: cursor,
      endMs: end,
      durationMs: Math.max(0, end - cursor),
      cinematicPurpose: i === 0 ? "establish scene" : "develop action",
      action: str(word?.label ? `perform: ${word.label}` : scene.narrativePurpose),
    });
    cursor = end;
  }
  return shots;
}

/** Generation clips tile a shot into ~3–5 s model-friendly windows (continuity preserved). */
export function generationClipsForShot(shot = {}) {
  const total = Math.max(0, Number(shot.endMs ?? 0) - Number(shot.startMs ?? 0));
  if (total <= 50) return [];
  // Even split around a 4 s centre: avoids the naive 5+1 s tail problem
  // (e.g. a 6 s shot becomes 3+3 s, not 5+1 s). Single short shots stay one clip.
  let n = Math.max(1, Math.round(total / 4000));
  if (total / n > GENERATION_CLIP_MAX_S * 1000) n = Math.ceil(total / (GENERATION_CLIP_MAX_S * 1000));
  if (n > 1 && total / n < GENERATION_CLIP_MIN_S * 1000 && total <= GENERATION_CLIP_MAX_S * 1000) n = 1;
  const clips = [];
  let cursor = Number(shot.startMs ?? 0);
  for (let i = 0; i < n; i++) {
    const isLast = i === n - 1;
    const end = isLast ? Number(shot.endMs) : cursor + total / n;
    const len = Math.max(0, end - cursor);
    if (len <= 0) continue;
    clips.push({ clipId: `${shot.shotId}-clip-${i + 1}`, startMs: cursor, endMs: isLast ? Number(shot.endMs) : end, durationMs: len });
    cursor = end;
  }
  return clips;
}

function estimateStoryMs({ story = {}, lyricLines = [], narrativeEvents = [] }) {
  const text = str(story.text || story.script || story.summary);
  const words = text ? text.split(/\s+/).length : 0;
  const beats = Math.max(1, narrativeEvents.length || lyricLines.length || 3);
  // ~150 wpm narration + 4 s cinematic overhead per beat, clamped 20 s – 5 min.
  const ms = Math.round((words / 2.5) * 1000 + beats * 4000);
  return Math.min(300000, Math.max(20000, ms));
}

/**
 * Build the Duration & Pacing Blueprint (spec Part 7/8 contract).
 * Audio-driven: totalTargetDurationMs === audio duration; scenes tile it exactly.
 * Story-only: AI estimate unless userOverrideMs is provided.
 */
export function buildDurationPacingBlueprint(input = {}) {
  const mode = input.productionMode === "audio_driven" ? "audio_driven" : "story_only";
  const frameRate = num(input.frameRate, DEFAULT_FRAME_RATE) || DEFAULT_FRAME_RATE;
  let totalTargetDurationMs;
  let durationSource;
  if (mode === "audio_driven") {
    totalTargetDurationMs = Math.round(num(input.audioDurationMs, 0));
    if (!(totalTargetDurationMs > 0)) throw new Error("audio-driven pacing requires audioDurationMs (WAV authority)");
    durationSource = "master_audio";
  } else if (num(input.userOverrideMs, 0) > 0) {
    totalTargetDurationMs = Math.round(num(input.userOverrideMs, 0));
    durationSource = "user_override";
  } else {
    totalTargetDurationMs = estimateStoryMs(input);
    durationSource = "ai_story_estimate";
  }
  const clock = buildMasterClock(totalTargetDurationMs / 1000, { frameRate });

  let scenes;
  if (mode === "audio_driven") {
    const cuts = boundariesFromTimeline(input.timeline || { masterDurationMs: clock.durationMs, tracks: {} });
    scenes = toScenes(cuts.length >= 2 ? cuts : [0, clock.durationMs], input.timeline || { tracks: {} }, clock);
    if (!scenes.length) {
      scenes = [{ sceneId: "scene-1", sceneNumber: 1, startMs: 0, endMs: clock.durationMs, durationMs: clock.durationMs, narrativePurpose: "full song", pacing: "medium", emotionalIntensity: "neutral", sourceEventIds: [] }];
    }
  } else {
    // story-only: distribute the estimate across narrative beats (variable, never equal-count-fixed)
    const beats = arr(input.narrativeEvents).length ? arr(input.narrativeEvents) : arr(input.lyricLines).length ? arr(input.lyricLines) : [{}, {}, {}];
    const weights = beats.map((b) => {
      const o = b && typeof b === "object" ? b : {};
      return Math.max(1, str(o.text || o.label || o.line).split(/\s+/).filter(Boolean).length + 8);
    });
    const total = weights.reduce((n, w) => n + w, 0);
    let cursor = 0;
    scenes = weights.map((w, i) => {
      const isLast = i === weights.length - 1;
      const end = isLast ? clock.durationMs : quantizeToFrame(cursor + Math.round((clock.durationMs * w) / total), frameRate);
      const s = {
        sceneId: `scene-${i + 1}`, sceneNumber: i + 1, startMs: cursor, endMs: end, durationMs: Math.max(0, end - cursor),
        narrativePurpose: str(beats[i]?.text || beats[i]?.label) || `beat ${i + 1}`,
        pacing: "medium", emotionalIntensity: "neutral",
        sourceEventIds: str(beats[i]?.id) ? [str(beats[i].id)] : [],
      };
      cursor = end;
      return s;
    });
  }

  const scenesWithShots = scenes.map((s) => ({ ...s, shots: shotsForScene(s, input.timeline || { tracks: {} }, clock) }));
  const shotCount = scenesWithShots.reduce((n, s) => n + s.shots.length, 0);
  const validation = validateDurationBlueprint({ scenes: scenesWithShots, totalTargetDurationMs }, { mode, frameRate });
  return {
    productionId: str(input.productionId),
    productionMode: mode,
    totalTargetDurationMs,
    totalAudioDurationMs: mode === "audio_driven" ? totalTargetDurationMs : undefined,
    durationSource,
    sceneCount: scenesWithShots.length,
    shotCount,
    scenes: scenesWithShots,
    validation,
  };
}

export function validateDurationBlueprint(blueprint = {}, opts = {}) {
  const errors = [];
  const warnings = [];
  const scenes = arr(blueprint.scenes);
  const total = num(blueprint.totalTargetDurationMs, 0);
  if (!(total > 0)) errors.push("blueprint requires totalTargetDurationMs");
  if (!scenes.length) errors.push("blueprint has no scenes");
  const sum = scenes.reduce((n, s) => n + num(s.durationMs, 0), 0);
  if (opts.mode === "audio_driven" && sum !== total) {
    errors.push(`scene durations sum to ${sum}ms, expected audio duration ${total}ms`);
  }
  if (opts.mode !== "audio_driven" && Math.abs(sum - total) > 1000 / (opts.frameRate || DEFAULT_FRAME_RATE) + 1) {
    errors.push(`story scenes sum to ${sum}ms, expected target ${total}ms`);
  }
  let cursor = 0;
  for (const s of scenes) {
    if (s.startMs !== cursor) errors.push(`${s.sceneId}: starts at ${s.startMs}ms, expected ${cursor}ms (gap/overlap)`);
    const shotSum = arr(s.shots).reduce((n, sh) => n + num(sh.durationMs, 0), 0);
    if (shotSum !== s.durationMs) errors.push(`${s.sceneId}: shots sum to ${shotSum}ms, scene is ${s.durationMs}ms`);
    if (s.durationMs < MIN_SCENE_MS) warnings.push(`${s.sceneId}: very short scene (${s.durationMs}ms)`);
    cursor = s.endMs;
  }
  if (cursor !== total) errors.push(`last scene ends at ${cursor}ms, expected ${total}ms`);
  // flag suspicious equal-duration scenes (spec: never arbitrarily equal)
  if (scenes.length > 2) {
    const uniq = new Set(scenes.map((s) => s.durationMs));
    if (uniq.size === 1) warnings.push("all scenes have identical durations — pacing should be narrative-driven");
  }
  return { timingValid: errors.length === 0, coverageValid: errors.length === 0, errors, warnings };
}
