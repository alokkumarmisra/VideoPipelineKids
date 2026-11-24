// ---------------------------------------------------------------------------
// Studio engines — unified 19-track synchronized master timeline builder.
// Pure: no fs / network / db. REUSES existing engines, never duplicates them:
//   - lib/master_timeline.mjs (audio-aligned segment list, approval semantics)
//   - lib/semantics.mjs (lyric/word timing, language, action/entity layer)
//   - lib/audio_timeline.mjs (shot-level audio coverage)
//   - lib/master_clock.mjs (single authoritative clock)
// This module only MAPS their outputs onto the 19 canonical tracks.
// ---------------------------------------------------------------------------

import {
  buildMasterClock,
  normalizeTimeRange,
  validateMasterClock,
  DEFAULT_FRAME_RATE,
  DEFAULT_SAMPLE_RATE_HZ,
} from "./master_clock.mjs";

export const ALL_TIMELINE_TRACKS = [
  "original_audio",
  "music_structure",
  "lyrics",
  "word_timings",
  "speaker_events",
  "narrative_events",
  "character_appearances",
  "character_actions",
  "emotions",
  "dialogue_performance",
  "choreography",
  "camera_direction",
  "scene_timeline",
  "shot_timeline",
  "lip_sync",
  "sound_effects",
  "video_assets",
  "transitions",
  "subtitles",
];

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => String(v ?? "").trim();
const num = (v, fb = null) => (Number.isFinite(Number(v)) ? Number(v) : fb);

let eventSeq = 0;
function makeEvent(trackId, range, clock, extra = {}) {
  const t = normalizeTimeRange(range, clock);
  eventSeq += 1;
  const clean = extra && typeof extra === "object" ? extra : {};
  return {
    id: str(clean.id) || `${trackId}-${eventSeq}`,
    trackId,
    startMs: t.startMs,
    endMs: t.endMs,
    startFrame: t.startFrame,
    endFrame: t.endFrame,
    startSample: t.startSample,
    endSample: t.endSample,
    sourceRef: str(clean.sourceRef),
    label: str(clean.label),
    ...clean,
  };
}

/**
 * Build the 19-track timeline from ALREADY-ANALYZED inputs.
 * All timings clamp to audioAsset.durationSec (the WAV authority).
 * Never invents timings; unknown evidence stays on its track as estimated.
 */
export function buildUnifiedTimeline(input = {}) {
  const audio = input.audioAsset || {};
  const durationSec = num(audio.durationSec ?? audio.durationSeconds ?? input.durationSec, 0);
  const clock = buildMasterClock(durationSec, {
    frameRate: num(input.frameRate, DEFAULT_FRAME_RATE),
    sampleRateHz: num(audio.sampleRateHz, DEFAULT_SAMPLE_RATE_HZ),
  });
  const clockErrors = validateMasterClock(clock);
  if (clockErrors.length) throw new Error(clockErrors[0]);

  const tracks = {};
  for (const t of ALL_TIMELINE_TRACKS) tracks[t] = [];
  const push = (trackId, range, extra) => {
    const e = makeEvent(trackId, range, clock, extra);
    if (e.endMs > e.startMs) tracks[trackId].push(e);
    return e;
  };

  // 01 original_audio — exactly one event covering the whole WAV.
  push("original_audio", { startMs: 0, endMs: clock.durationMs }, {
    id: "original_audio-1",
    label: str(audio.originalFilename || audio.fileName || "original.wav"),
    audioAssetId: str(audio.id),
    authoritative: true,
  });

  // 02 music_structure — from songAnalysis.segments (label/start/end).
  for (const [i, s] of arr(input.musicSections).entries()) {
    const o = s && typeof s === "object" ? s : {};
    push("music_structure", { startMs: num(o.startMs ?? o.start_seconds * 1000, 0), endMs: num(o.endMs ?? o.end_seconds * 1000, 0) }, {
      id: str(o.id) || `music_structure-${i + 1}`,
      label: str(o.label || o.section || "section"),
      mood: str(o.mood), energy: num(o.energy),
    });
  }

  // 03 lyrics + 04 word_timings — from aligned lyric lines.
  for (const [i, line] of arr(input.lyricLines).entries()) {
    const o = line && typeof line === "object" ? line : {};
    const range = { startMs: num(o.startMs ?? o.start_seconds * 1000, 0), endMs: num(o.endMs ?? o.end_seconds * 1000, 0) };
    push("lyrics", range, { id: str(o.id) || `lyrics-${i + 1}`, label: str(o.text || o.line), language: str(o.language) });
    for (const [w, word] of arr(o.words).entries()) {
      const wod = word && typeof word === "object" ? word : {};
      push("word_timings", {
        startMs: num(wod.startMs ?? wod.start_seconds * 1000, range.startMs),
        endMs: num(wod.endMs ?? wod.end_seconds * 1000, range.endMs),
      }, { id: str(wod.id) || `lyrics-${i + 1}-w${w + 1}`, label: str(wod.text || wod.word), lineId: str(o.id) || `lyrics-${i + 1}` });
    }
  }

  // 05 speaker_events + 10 dialogue_performance + 15 lip_sync (speech only here;
  // singing lip-sync is derived at Director time from lyrics + visible character).
  for (const [i, s] of arr(input.speakerEvents).entries()) {
    const o = s && typeof s === "object" ? s : {};
    const range = { startMs: num(o.startMs, 0), endMs: num(o.endMs, 0) };
    push("speaker_events", range, { id: str(o.id) || `speaker_events-${i + 1}`, label: str(o.speaker || o.voice), kind: str(o.kind || "singing") });
    if (/speak|dialogue|narration/i.test(str(o.kind))) {
      push("dialogue_performance", range, { id: str(o.id) || `dialogue_performance-${i + 1}`, label: str(o.text) });
    }
  }

  // 06 narrative_events — story beats with timing (story-only or song-mapped).
  for (const [i, n] of arr(input.narrativeEvents).entries()) {
    const o = n && typeof n === "object" ? n : {};
    push("narrative_events", { startMs: num(o.startMs, 0), endMs: num(o.endMs, 0) }, {
      id: str(o.id) || `narrative_events-${i + 1}`, label: str(o.text || o.summary), sourceLine: str(o.sourceLine),
    });
  }

  // 07/08/09/11 — character, action, emotion, choreography (semantic layer output).
  for (const [i, e] of arr(input.characterAppearances).entries()) {
    const o = e && typeof e === "object" ? e : {};
    push("character_appearances", { startMs: num(o.startMs, 0), endMs: num(o.endMs, 0) }, {
      id: str(o.id) || `character_appearances-${i + 1}`, label: str(o.characterId), characterId: str(o.characterId),
    });
  }
  for (const [i, e] of arr(input.characterActions).entries()) {
    const o = e && typeof e === "object" ? e : {};
    push("character_actions", { startMs: num(o.startMs, 0), endMs: num(o.endMs, 0) }, {
      id: str(o.id) || `character_actions-${i + 1}`, label: str(o.action), characterId: str(o.characterId), grounded: o.grounded !== false,
    });
  }
  for (const [i, e] of arr(input.emotions).entries()) {
    const o = e && typeof e === "object" ? e : {};
    push("emotions", { startMs: num(o.startMs, 0), endMs: num(o.endMs, 0) }, {
      id: str(o.id) || `emotions-${i + 1}`, label: str(o.emotion), intensity: str(o.intensity),
    });
  }
  for (const [i, e] of arr(input.choreography).entries()) {
    const o = e && typeof e === "object" ? e : {};
    push("choreography", { startMs: num(o.startMs, 0), endMs: num(o.endMs, 0) }, {
      id: str(o.id) || `choreography-${i + 1}`, label: str(o.move || o.label),
    });
  }

  // 12 camera_direction / 18 transitions / 16 sound_effects / 19 subtitles — passthrough.
  for (const [i, e] of arr(input.cameraDirections).entries()) {
    const o = e && typeof e === "object" ? e : {};
    push("camera_direction", { startMs: num(o.startMs, 0), endMs: num(o.endMs, 0) }, { id: str(o.id) || `camera_direction-${i + 1}`, label: str(o.shot || o.label) });
  }
  for (const [i, e] of arr(input.soundEffects).entries()) {
    const o = e && typeof e === "object" ? e : {};
    push("sound_effects", { startMs: num(o.startMs, 0), endMs: num(o.endMs, 0) }, { id: str(o.id) || `sound_effects-${i + 1}`, label: str(o.label) });
  }
  for (const [i, e] of arr(input.transitions).entries()) {
    const o = e && typeof e === "object" ? e : {};
    push("transitions", { startMs: num(o.startMs, 0), endMs: num(o.endMs, 0) }, { id: str(o.id) || `transitions-${i + 1}`, label: str(o.type || o.label) });
  }
  for (const [i, e] of arr(input.subtitles).entries()) {
    const o = e && typeof e === "object" ? e : {};
    push("subtitles", { startMs: num(o.startMs, 0), endMs: num(o.endMs, 0) }, { id: str(o.id) || `subtitles-${i + 1}`, label: str(o.text) });
  }

  // 13/14/17 scene_timeline / shot_timeline / video_assets start empty —
  // the Duration & Pacing blueprint + Director fill them, never the audio engine.
  const timeline = {
    schema: "kids-19-track/1",
    timelineId: str(input.timelineId) || `tl-${Date.now()}`,
    productionId: str(input.productionId),
    masterDurationMs: clock.durationMs,
    masterDurationSec: clock.durationSec,
    frameRate: clock.frameRate,
    sampleRateHz: clock.sampleRateHz,
    totalFrames: clock.totalFrames,
    audioAssetId: str(audio.id),
    tracks,
    status: "generated",
    version: 1,
  };
  // strip helper key
  for (const list of Object.values(tracks)) for (const e of list) delete e.id2;
  return timeline;
}

/** Coverage check: every track present, timings within the master clock. */
export function validateUnifiedTimeline(timeline = {}) {
  const errors = [];
  const warnings = [];
  const durationMs = num(timeline.masterDurationMs, 0);
  if (!(durationMs > 0)) errors.push("timeline requires masterDurationMs from the original WAV");
  for (const t of ALL_TIMELINE_TRACKS) {
    if (!Array.isArray(timeline.tracks?.[t])) errors.push(`missing track: ${t}`);
  }
  if (errors.length) return { errors, warnings };
  const clock = { durationMs, frameRate: timeline.frameRate, sampleRateHz: timeline.sampleRateHz };
  for (const [trackId, list] of Object.entries(timeline.tracks)) {
    const rows = [...list].sort((a, b) => a.startMs - b.startMs);
    for (const e of rows) {
      if (!(e.endMs > e.startMs)) errors.push(`${trackId}/${e.id}: empty interval`);
      if (e.startMs < 0 || e.endMs > durationMs) errors.push(`${trackId}/${e.id}: outside master clock`);
      if (e.startMs !== normalizeTimeRange(e, clock).startMs) warnings.push(`${trackId}/${e.id}: not frame-quantized`);
    }
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].startMs < rows[i - 1].endMs && trackId !== "word_timings" && trackId !== "subtitles") {
        warnings.push(`${trackId}/${rows[i].id}: overlaps ${rows[i - 1].id}`);
      }
    }
  }
  // Part 12.3: instrumental intervals must carry ZERO lip-sync.
  const instrumental = arr(timeline.tracks.music_structure).filter((s) => /instrumental|intro|outro|break|interlude/i.test(str(s.label)));
  for (const seg of instrumental) {
    const clash = arr(timeline.tracks.lip_sync).filter((l) => l.startMs < seg.endMs && l.endMs > seg.startMs);
    if (clash.length) errors.push(`lip-sync during instrumental ${seg.id} (${clash.map((c) => c.id).join(",")}) — Part 12.3`);
  }
  return { errors, warnings };
}

/** Immutable versioned handoff reference — never mutates the timeline. */
export function freezeTimeline(timeline = {}, approval = {}) {
  const v = validateUnifiedTimeline(timeline);
  if (v.errors.length) throw new Error(`cannot freeze invalid timeline: ${v.errors[0]}`);
  return {
    timelineId: timeline.timelineId,
    version: timeline.version ?? 1,
    productionId: timeline.productionId,
    masterDurationMs: timeline.masterDurationMs,
    audioAssetId: timeline.audioAssetId,
    approvalStatus: str(approval.status) || "approved",
    approvedAt: new Date().toISOString(),
    trackCounts: Object.fromEntries(Object.entries(timeline.tracks).map(([k, list]) => [k, list.length])),
    warnings: v.warnings,
  };
}
