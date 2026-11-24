import test from "node:test";
import assert from "node:assert/strict";
import { buildUnifiedTimeline } from "../lib/studio_engines.mjs";
import {
  DIRECTOR_TIMELINE_TRACKS,
  buildDirectorAudioContext,
  buildDirectorInputEnriched,
  verifyAdapterBackwardCompatibility,
} from "../lib/directorAudioAdapter.mjs";
import {
  unifiedToMasterTimelineArg,
  computeAudioSyncScore,
  scoreDirectorPlan,
  validateStoryBoard,
  verifyAdapterIntegration,
  buildScenesPrompt,
} from "../lib/directorAudioIntegration.mjs";
import { scoreDirectorPlan as realScore, validateStoryBoard as realValidate } from "../lib/director.mjs";

const unified = () => buildUnifiedTimeline({
  productionId: "p1",
  audioAsset: { id: "a1", durationSec: 30 },
  musicSections: [{ label: "instrumental intro", startMs: 0, endMs: 5000 }],
  lyricLines: [{ text: "hello world", startMs: 5000, endMs: 9000 }],
});

test("adapter is a thin layer: single track list, story-only passthrough", () => {
  assert.deepEqual([...DIRECTOR_TIMELINE_TRACKS].sort(), [
    "original_audio", "music_structure", "lyrics", "word_timings", "speaker_events",
    "narrative_events", "character_appearances", "character_actions", "emotions",
    "dialogue_performance", "choreography", "camera_direction", "scene_timeline",
    "shot_timeline", "lip_sync", "sound_effects", "video_assets", "transitions", "subtitles",
  ].sort());
  const base = { title: "story" };
  const enriched = buildDirectorInputEnriched(base, null, null, { enrichFromTimeline: false });
  assert.equal(enriched.input, base);
  assert.equal(enriched.audioContext, null);
  assert.equal(verifyAdapterBackwardCompatibility(base), true);
});

test("adapter reads the unified shape (ms tracks) into seconds context", () => {
  const tl = unified();
  const ctx = buildDirectorAudioContext(tl, { audioAsset: { id: "a1", durationSec: 30 } });
  assert.equal(ctx.durationSec, 30);
  assert.equal(ctx.audioId, "a1");
  const enriched = buildDirectorInputEnriched({ title: "x" }, tl, { audioAsset: { id: "a1", durationSec: 30 } }, { enrichFromTimeline: true });
  assert.equal(enriched.validationContext.timelineStatus, "approved");
  assert.equal(enriched.narrativeContext.lyrics.length, 1);
});

test("integration delegates to the real Director; story-only output untouched", () => {
  const board = { input: { targetSeconds: 30 }, blueprint: { lyric_lines: [] }, scenes: [] };
  assert.deepEqual(scoreDirectorPlan(board, {}), realScore(board, {}));
  const v1 = validateStoryBoard(board, null);
  const v2 = realValidate(board);
  assert.deepEqual(v1.errors, [...(v2.errors || v2.issues || [])]);
  const mt = unifiedToMasterTimelineArg(unified());
  assert.ok(mt.segments.length >= 2);
  assert.equal(computeAudioSyncScore(board, { timeline: unified() }), 100);
  assert.equal(verifyAdapterIntegration({ input: {}, blueprint: {} }), true);
});

test("integration prompt carries the approved timeline only when unified", () => {
  const args = {
    input: { title: "t", language: "Hindi" }, blueprint: { characters: [], locations: [], objects: [] },
    beats: [], startNumber: 1, count: 1,
  };
  const plain = buildScenesPrompt(args, null);
  const enriched = buildScenesPrompt(args, { timeline: unified() });
  assert.ok(!plain.includes("APPROVED AUDIO TIMELINE"));
  assert.ok(enriched.includes("APPROVED AUDIO TIMELINE"));
});
