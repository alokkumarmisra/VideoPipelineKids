// Sanskriti KIDS — Director Audio Adapter (thin compatibility layer).
//
// AUTHORITY MAP (spec Part 21 — no engine overrides another):
//   - Timing truth: lib/master_clock.mjs (the WAV clock) + lib/studio_engines.mjs
//     (the single 19-track builder). This file NEVER invents timings.
//   - Cinematic truth: lib/director.mjs (the one AI Director).
// This module only CONVERTS the unified 19-track shape into the seconds-based
// Director context the Director already consumes. It keeps the historical
// export names so existing imports and the frontend .d.ts keep working.
//
// Accepts BOTH shapes:
//   - unified: { tracks: {...}, masterDurationMs, frameRate, ... } (current)
//   - legacy:  flat events array + duration seconds (pre-unification callers)

import { ALL_TIMELINE_TRACKS } from "./studio_engines.mjs";
import { buildMasterClock } from "./master_clock.mjs";

export const DIRECTOR_TIMELINE_TRACKS = ALL_TIMELINE_TRACKS;

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => String(v ?? "").trim();
const num = (v, fb = null) => (Number.isFinite(Number(v)) ? Number(v) : fb);
const msToSec = (ms) => Math.round((Number(ms) / 1000) * 1000) / 1000;

/** Flatten a unified timeline (or pass through a legacy flat event list). */
function flatEvents(timelineOrEvents) {
  if (Array.isArray(timelineOrEvents)) return timelineOrEvents;
  const tracks = timelineOrEvents?.tracks;
  if (tracks && typeof tracks === "object") return Object.values(tracks).flat();
  return arr(timelineOrEvents?.events);
}

function eventWindow(e, durationSec) {
  const startSec = Math.max(0, Math.min(num(e.startSec ?? (e.startMs != null ? e.startMs / 1000 : 0), 0), durationSec));
  const endSec = Math.max(0, Math.min(num(e.endSec ?? (e.endMs != null ? e.endMs / 1000 : 0), 0), durationSec));
  return { startSec, endSec };
}

export function buildDirectorAudioContext(masterTimeline, production, options = {}) {
  const audio = production?.audioAsset || {};
  const analysis = production?.audioAnalysis || {};
  const unified = masterTimeline && typeof masterTimeline === "object" && !Array.isArray(masterTimeline)
    ? masterTimeline : null;
  const durationSec = num(
    audio.durationSec ?? audio.durationSeconds ?? unified?.masterDurationSec / 1000 ?? unified?.masterDurationSec,
    0,
  );
  const clock = buildMasterClock(Math.max(0, durationSec), {
    frameRate: num(unified?.frameRate, 30),
    sampleRateHz: num(audio.sampleRateHz, 48000),
  });
  return {
    audioId: audio.id ?? unified?.audioAssetId ?? null,
    audioFilename: audio.originalFilename ?? audio.original_filename ?? null,
    durationSec: clock.durationSec,
    sampleRateHz: clock.sampleRateHz,
    frameRate: clock.frameRate,
    bpm: num(analysis.bpm ?? options.bpm, 120),
    totalBeats: num(analysis.totalBeats ?? options.beatPositionsSec?.length, 0),
    beatPositionsSec: arr(analysis.beatPositionsSec ?? options.beatPositionsSec),
  };
}

export function buildDirectorNarrativeContext(masterTimelineEvents, masterDurationSec, options = { clampToMaster: true }) {
  const events = flatEvents(masterTimelineEvents);
  const durationSec = options.clampToMaster ? Math.max(0, num(masterDurationSec, 0)) : Infinity;
  const by = (trackId) => events.filter((e) => e && e.trackId === trackId);
  const win = (e) => eventWindow(e, durationSec);
  const text = (e) => str(e.label || e.narrativeMeaning || e.text);

  const lyrics = by("lyrics").concat(by("subtitles")).map((e) => ({ id: e.id, text: text(e), ...win(e) }))
    .sort((a, b) => a.startSec - b.startSec);
  const narrativeEvents = by("narrative_events").map((e) => ({ id: e.id, text: text(e), ...win(e) }))
    .sort((a, b) => a.startSec - b.startSec);
  const speakerEvents = by("speaker_events").map((e) => ({
    id: e.id, label: text(e) || "SPEAKER", characterId: str(e.characterId), ...win(e),
  }));
  const dialoguePerformances = by("dialogue_performance").map((e) => ({
    id: e.id, characterId: str(e.characterId), text: text(e),
    visibleSpeaker: e.lipSyncRequired !== false, lipSyncRequired: e.lipSyncRequired ?? false, ...win(e),
  }));
  const characterAppearances = by("character_appearances").map((e) => ({ id: e.id, characterId: str(e.characterId), ...win(e) }));
  const characterActions = by("character_actions").map((e) => ({
    id: e.id, action: str(e.action) || text(e) || "character action", characterId: str(e.characterId),
    grounded: e.grounded !== false, ...win(e),
  }));
  const emotions = by("emotions").map((e) => ({ id: e.id, emotion: text(e) || "peaceful", ...win(e) }));
  const choreography = by("choreography").map((e) => ({
    id: e.id, characterName: text(e) || "character", actionType: str(e.action) || text(e) || "motion", ...win(e),
  }));
  const cameraDirections = by("camera_direction").map((e) => {
    const parts = str(e.cameraInstructions || e.label).split("·").map((s) => s.trim()).filter(Boolean);
    return {
      id: e.id, shotType: parts[0] || "Medium Shot", cameraMovement: parts[1] || "Static", ...win(e),
    };
  });
  return {
    lyrics, narrativeEvents, speakerEvents, dialoguePerformances, characterAppearances,
    characterActions, emotions, choreography, cameraDirections,
  };
}

export function buildDirectorVisualContext(masterTimelineEvents, masterDurationSec) {
  const events = flatEvents(masterTimelineEvents);
  const durationSec = Math.max(0, num(masterDurationSec, 0));
  const by = (trackId) => events.filter((e) => e && e.trackId === trackId);
  const win = (e) => eventWindow(e, durationSec);
  const text = (e) => str(e.label || e.narrativeMeaning || e.text);
  const sceneTimeline = by("scene_timeline").map((e) => ({ id: e.id, title: text(e) || `Scene ${str(e.sceneId) || "?"}`, ...win(e) }));
  const shotTimeline = by("shot_timeline").map((e) => ({
    id: e.id, sceneId: str(e.sceneId), shotNumber: Number(str(e.shotId).split("-")[1]) || 1,
    title: text(e) || `Shot ${str(e.shotId) || "?"}`, ...win(e),
  }));
  const transitions = by("transitions").map((e) => ({ id: e.id, transition: text(e) || str(e.action) || "Cut", ...win(e) }));
  const videoAssets = by("video_assets").map((e) => ({ id: e.id, videoAssetUrl: e.generationRef ?? null, ...win(e) }));
  const subtitles = by("subtitles").map((e) => ({ id: e.id, text: text(e), ...win(e) }));
  return { sceneTimeline, shotTimeline, transitions, videoAssets, subtitles };
}

export function buildDirectorInputEnriched(baseInput, masterTimeline, production, options = { enrichFromTimeline: false }) {
  const enrich = options.enrichFromTimeline === true && masterTimeline != null;
  if (!enrich) {
    return {
      input: baseInput,
      audioContext: null,
      narrativeContext: {
        lyrics: [], narrativeEvents: [], speakerEvents: [], characterAppearances: [],
        characterActions: [], emotions: [], dialoguePerformances: [], choreography: [], cameraDirections: [],
      },
      visualContext: { sceneTimeline: [], shotTimeline: [], transitions: [], videoAssets: [], subtitles: [] },
      validationContext: {
        timelineStatus: "not_generated", approvalStatus: "pending", timelineVersion: 0,
        warnings: ["No approved timeline — Director running in story-only mode (audio context unavailable)"],
      },
    };
  }
  const unified = masterTimeline;
  const durationSec = num(
    production?.audioAsset?.durationSec ?? unified?.masterDurationMs / 1000 ?? unified?.masterDurationSec, 0,
  );
  const audioContext = buildDirectorAudioContext(unified, production, options);
  const narrativeContext = buildDirectorNarrativeContext(unified, durationSec, { clampToMaster: true });
  const visualContext = buildDirectorVisualContext(unified, durationSec);
  const events = flatEvents(unified);
  const needsReview = events.filter((e) => e && e.approvalStatus && e.approvalStatus !== "approved");
  const instrumentalWithLipSync = events.filter(
    (e) => e && e.trackId === "lip_sync" && events.some(
      (m) => m && m.trackId === "music_structure" && /instrumental|intro|outro|break|interlude/i.test(str(m.label))
        && e.startMs < m.endMs && e.endMs > m.startMs,
    ),
  );
  const warnings = [
    ...needsReview.slice(0, 10).map((e) => `Track ${e.trackId}: ${e.label || e.id} requires review`),
    ...(instrumentalWithLipSync.length
      ? [`${instrumentalWithLipSync.length} instrumental section(s) have lip-sync events — Part 12.3 rule violation`] : []),
  ];
  return {
    input: baseInput,
    audioContext,
    narrativeContext,
    visualContext,
    validationContext: {
      timelineStatus: "approved",
      approvalStatus: needsReview.length ? "pending" : "approved",
      warnings,
      timelineVersion: num(unified?.version, 1),
    },
  };
}

export function verifyAdapterBackwardCompatibility(baseInput) {
  const enriched = buildDirectorInputEnriched(baseInput, null, null, { enrichFromTimeline: false });
  return enriched.audioContext === null
    && enriched.input === baseInput
    && enriched.validationContext.timelineStatus === "not_generated";
}
