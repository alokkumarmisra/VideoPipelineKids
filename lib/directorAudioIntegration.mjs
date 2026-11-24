// Sanskriti KIDS — Director unification layer (thin extension, never a second Director).
//
// Every function here DELEGATES to the real engine in lib/director.mjs with the
// exact historical arguments, then adds the unified-production context
// (approved 19-track timeline + pacing blueprint) as additive metadata.
// Story-only calls (no `unified`) return the real engine's output untouched.
//
// `unified` shape: { timeline?, blueprint?, snapshot? } where timeline is the
// unified 19-track object from lib/studio_engines.mjs and blueprint is the
// Duration & Pacing blueprint from lib/durationPacing.mjs.

import {
  buildStoryPlan as directorBuildStoryPlan,
  buildScenesPrompt as directorBuildScenesPrompt,
  validateStoryBoard as directorValidateStoryBoard,
  scoreDirectorPlan as directorScoreDirectorPlan,
} from "./director.mjs";
import { validateUnifiedTimeline } from "./studio_engines.mjs";
import { validateDurationBlueprint } from "./durationPacing.mjs";
import { ALL_TIMELINE_TRACKS } from "./studio_engines.mjs";

export const DIRECTOR_TIMELINE_TRACKS = ALL_TIMELINE_TRACKS;

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => String(v ?? "").trim();

/** Convert unified tracks into the {segments, from, to} shape the real prompt builder consumes. */
export function unifiedToMasterTimelineArg(timeline) {
  if (!timeline || typeof timeline !== "object" || !timeline.tracks) return null;
  const segments = [];
  for (const e of arr(timeline.tracks.lyrics)) {
    segments.push({
      start_seconds: (e.startMs ?? 0) / 1000, end_seconds: (e.endMs ?? 0) / 1000,
      type: "singing", lyric_text: str(e.label),
    });
  }
  for (const e of arr(timeline.tracks.music_structure)) {
    segments.push({
      start_seconds: (e.startMs ?? 0) / 1000, end_seconds: (e.endMs ?? 0) / 1000,
      type: /instrumental|intro|outro|break|interlude/i.test(str(e.label)) ? "instrumental" : str(e.label) || "section",
    });
  }
  segments.sort((a, b) => a.start_seconds - b.start_seconds);
  if (!segments.length) return null;
  return { segments, from: segments[0].start_seconds, to: segments[segments.length - 1].end_seconds };
}

export function buildStoryPlan(args, unified = null) {
  const plan = directorBuildStoryPlan(args);
  if (!unified) return plan;
  return {
    ...plan,
    _unifiedRef: {
      timelineId: unified.timeline?.timelineId ?? null,
      timelineVersion: unified.timeline?.version ?? null,
      blueprintVersion: unified.blueprint?.version ?? null,
      snapshotId: unified.snapshot?.snapshotId ?? unified.snapshot?.id ?? null,
      audioDriven: unified.timeline != null,
    },
  };
}

export function buildScenesPrompt(args, unified = null) {
  if (!unified?.timeline) return directorBuildScenesPrompt(args);
  return directorBuildScenesPrompt({
    ...args,
    masterTimeline: unifiedToMasterTimelineArg(unified.timeline) ?? args.masterTimeline ?? null,
  });
}

/**
 * Audio-sync sub-score (0–100): timing inside the WAV clock, Part 12.3
 * (zero lip-sync over instrumentals), visible speakers covered. The total
 * blends it at 20% over the real engine's score — the real scorer stays the
 * authority on everything else.
 */
export function computeAudioSyncScore(board, unified) {
  const timeline = unified?.timeline;
  if (!timeline?.tracks) return 100;
  let score = 0;
  const durationMs = timeline.masterDurationMs ?? 0;
  const scenes = arr(board?.scenes);
  const withinClock = scenes.every((s) =>
    (s.song_start_time ?? 0) >= 0 && (s.song_end_time ?? 0) <= durationMs / 1000 + 0.05);
  if (withinClock) score += 40;
  const instrumental = arr(timeline.tracks.music_structure).filter((m) =>
    /instrumental|intro|outro|break|interlude/i.test(str(m.label)));
  const lipClash = arr(timeline.tracks.lip_sync).some((l) =>
    instrumental.some((m) => l.startMs < m.endMs && l.endMs > m.startMs));
  const plannedLipClash = scenes.some((s) => arr(s.shots).some((sh) =>
    sh.lip_sync_required === true && instrumental.some((m) =>
      (sh.song_start_time ?? 0) * 1000 < m.endMs && (sh.song_end_time ?? 0) * 1000 > m.startMs)));
  if (!lipClash && !plannedLipClash) score += 35;
  const speakers = new Set(arr(timeline.tracks.speaker_events).map((s) => str(s.speaker || s.label)).filter(Boolean));
  const covered = new Set();
  for (const s of scenes) {
    for (const d of arr(s.dialogue)) if (str(d.speaker)) covered.add(str(d.speaker));
    for (const sh of arr(s.shots)) for (const d of arr(sh.dialogue)) if (str(d.speaker)) covered.add(str(d.speaker));
  }
  if (!speakers.size || [...speakers].every((sp) => covered.has(sp))) score += 25;
  return Math.min(100, score);
}

export function scoreDirectorPlan(board, opts = {}, unified = null) {
  const base = directorScoreDirectorPlan(board, opts);
  if (!unified?.timeline) return base;
  const audioSync = computeAudioSyncScore(board, unified);
  return {
    ...base,
    score: Math.round(base.score * 0.8 + audioSync * 0.2),
    breakdown: { ...base.breakdown, audioSync },
  };
}

export function validateStoryBoard(board, unified = null) {
  const base = directorValidateStoryBoard(board);
  const errors = [...(base.errors || base.issues || [])];
  const warnings = [...(base.warnings || [])];
  if (!unified?.timeline) return { valid: errors.length === 0, errors, warnings };
  const check = validateUnifiedTimeline(unified.timeline);
  errors.push(...check.errors);
  warnings.push(...check.warnings);
  if (unified.blueprint) {
    const bp = validateDurationBlueprint(
      unified.blueprint.blueprint || unified.blueprint,
      { mode: unified.blueprint.productionMode || unified.blueprint.production_mode },
    );
    errors.push(...bp.errors);
    warnings.push(...bp.warnings);
  }
  const scenes = arr(board?.scenes);
  for (const s of scenes) {
    if (!arr(s.sourceEventIds || s.source_event_ids).length && unified.timeline) {
      warnings.push(`scene ${s.scene_number}: no source-event linkage to the approved timeline`);
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}

export function verifyAdapterIntegration(sampleArgs) {
  try {
    const planA = directorBuildStoryPlan(sampleArgs);
    const planB = buildStoryPlan(sampleArgs, null);
    return JSON.stringify(planA) === JSON.stringify(planB);
  } catch {
    return false;
  }
}
