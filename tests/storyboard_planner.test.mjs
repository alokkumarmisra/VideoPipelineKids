// Storyboard Planner 2.0 — pure adapter / coverage / pre-approval tests.
// Run: node --test tests/storyboard_planner.test.mjs
//
// Acceptance coverage:
//   A devotional song timeline -> 19-track read-only projection
//   B long audio / hundreds of scenes stays honest and fast
//   C stop/resume (missing coverage is recomputed from saved scenes)
//   E character continuity from the last saved scene
//   F audio sync (approved windows exact, no vocals in instrumentals)
//   G Director handoff references the timeline, never copies/rewrites it
import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  STORYBOARD_TRACKS,
  STORYBOARD_PHASES,
  normalizeStoryboardTimeline,
  storyboardBatchContext,
  buildStoryboardPromptBlock,
  auditStoryboardCoverage,
  validateStoryboardForApproval,
  buildDirectorHandoff,
  buildStoryboardView,
} from "../lib/storyboard_planner.mjs";
import { buildScenesPrompt, boardToScenario } from "../lib/director.mjs";
import { planTimelineClips } from "../lib/master_timeline.mjs";

const approvedAt = "2026-11-24T10:00:00.000Z";

function makeMaster({ approved = true } = {}) {
  const master = {
    schema_version: 2,
    duration_seconds: 12,
    language: "hi",
    source: "test-fixture",
    activity: [],
    segments: [
      {
        segment_id: "seg-intro", type: "instrumental", start_seconds: 0, end_seconds: 3,
        duration_seconds: 3, lyric_line_id: null, lyric_text: "", heard_text: "", words: [],
        timing_source: "instrumental", confidence: 1, review_status: "approved",
        character_id: "", speaker: "", action: "the camera drifts over the empty courtyard",
        expression: "", location: "courtyard", props: [], camera: null, notes: ["intro instrumental"],
      },
      {
        segment_id: "seg-lyric-1", type: "singing", start_seconds: 3, end_seconds: 6,
        duration_seconds: 3, lyric_line_id: 1, lyric_text: "हाथ हिलाओ", heard_text: "हाथ हिलाओ",
        words: [{ word: "हाथ", start_seconds: 3.2, end_seconds: 3.8, confidence: 0.99, timing: "whisperx" }],
        timing_source: "whisperx", confidence: 0.99, review_status: "approved",
        character_id: "dog", speaker: "dog", action: "the dog wags its tail", expression: "joyful",
        location: "courtyard", props: [], style_refs: [],
        camera: { shot_type: "Close-Up", angle: "Eye Level", movement: "Static" },
        occurrence: 1, repeat_group: null, notes: [],
      },
      {
        segment_id: "seg-dialogue-2", type: "dialogue", start_seconds: 6, end_seconds: 9,
        duration_seconds: 3, lyric_line_id: 2, lyric_text: "अब बोलो", heard_text: "अब बोलो",
        words: [{ word: "बोलो", start_seconds: 7.1, end_seconds: 7.6, confidence: 0.98, timing: "whisperx" }],
        timing_source: "whisperx", confidence: 0.98, review_status: "approved",
        character_id: "dog", speaker: "dog", action: "the dog turns to the camera", expression: "curious",
        location: "courtyard", props: [], style_refs: [],
        camera: { shot_type: "Medium Shot", angle: "Eye Level", movement: "Static" },
        occurrence: 1, repeat_group: null, notes: [],
      },
      {
        segment_id: "seg-outro", type: "instrumental", start_seconds: 9, end_seconds: 12,
        duration_seconds: 3, lyric_line_id: null, lyric_text: "", heard_text: "", words: [],
        timing_source: "instrumental", confidence: 1, review_status: "approved",
        character_id: "", speaker: "", action: "the dog trots into the sunset", expression: "",
        location: "courtyard", props: [], camera: null, notes: ["outro instrumental"],
      },
    ],
    repeats: [], stats: {}, warnings: [], validation: {},
  };
  if (approved) master.approved = approvedAt;
  master.clips = planTimelineClips(master);
  return master;
}

function scene(n, start, end, { lyric = null, action = "a visible action", dialogue = [], title = null } = {}) {
  const shot = {
    shot_id: `${n}-A`, shot_number: 1, start_time: 0, end_time: end - start,
    duration_seconds: end - start, action, camera: { shot_type: "Medium Shot", angle: "Eye Level", movement: "Static" },
    characters: ["dog"], location: "courtyard", dialogue: [...dialogue],
    image_prompt: "identities + action", video_prompt: "motion only",
  };
  if (lyric) {
    shot.lyric_line_id = lyric;
    shot.parent_line_id = lyric;
    shot.song_start_time = start;
    shot.song_end_time = end;
  }
  return {
    scene_number: n, title: title || `Scene ${n}`, duration_seconds: end - start,
    song_start_time: start, song_end_time: end,
    ...(lyric ? { lyric_line_id: lyric, parent_line_id: lyric } : {}),
    line_from: lyric || 0, line_to: lyric || 0,
    characters: ["dog"], location: "courtyard", objects: [],
    action, emotion: "warm", expression: "calm", body_language: "open",
    camera: { shot_type: "Medium Shot", angle: "Eye Level", movement: "Static" },
    lighting: "soft daylight", environment: "courtyard",
    continuity_from_previous_scene: n === 1 ? "" : `continues from scene ${n - 1}`,
    transition_to_next_scene: "", dialogue: [...dialogue],
    image_prompt: "identities + action", video_prompt: "motion only",
    shots: [shot],
  };
}

function makeBoard(master, { partial = false, drift = false, badSpeaker = false } = {}) {
  const scenes = [
    scene(1, 0, 3, { action: "the camera drifts over the empty courtyard", title: "Intro" }),
    scene(2, drift ? 3.5 : 3, drift ? 6.5 : 6, {
      lyric: 1, action: "the dog wags its tail", title: "Wag",
    }),
    scene(3, 6, 9, {
      lyric: 2, action: "the dog turns to the camera", title: "Speak",
      dialogue: [{ speaker: badSpeaker ? "cat" : "dog", line: "अब बोलो", expression: "curious", emotion: "happy", pitch: "medium" }],
    }),
  ];
  if (!partial) scenes.push(scene(4, 9, 12, { action: "the dog trots into the sunset", title: "Outro" }));
  return {
    id: "board-1", status: partial ? "scenes-partial" : "ready",
    input: { title: "Devotional Dog", targetSeconds: 12, language: "hi", song: { durationSeconds: 12, hasLyrics: true } },
    blueprint: {
      logline: "A dog visits the courtyard",
      characters: [{ character_id: "dog", name: "Dog", species: "dog", appearance: { coat: "short brown fur" }, visual_identity_prompt: "a friendly brown dog with short fur" }],
      locations: [{ location_id: "courtyard", name: "Courtyard", visual_identity_prompt: "a sunlit stone courtyard" }],
      objects: [], beats: [], lyric_lines: [],
    },
    scenes,
    lyric_timeline: { master, lines: [], version: 1 },
  };
}

describe("Storyboard Planner 2.0 — read-only timeline adapter", () => {
  test("approved master projects onto all 19 tracks without changing a timestamp", () => {
    const master = makeMaster();
    const before = JSON.stringify(master);
    const tl = normalizeStoryboardTimeline({ board: makeBoard(master) });
    assert.equal(JSON.stringify(master), before, "the approved timeline must never be mutated");
    assert.equal(tl.source, "director-master-timeline");
    assert.equal(tl.approved, true);
    assert.equal(tl.readOnly, true);
    assert.equal(tl.durationSec, 12);
    assert.deepEqual(Object.keys(tl.tracks), STORYBOARD_TRACKS);
    assert.equal(tl.tracks.original_audio[0].end, 12);
    assert.deepEqual(
      tl.tracks.lyrics.map((e) => [e.lineId, e.start, e.end]),
      [[1, 3, 6], [2, 6, 9]],
    );
    assert.deepEqual(tl.tracks.word_timings.map((e) => [e.label, e.start, e.end]), [["हाथ", 3.2, 3.8], ["बोलो", 7.1, 7.6]]);
    assert.equal(tl.tracks.lip_sync.length, 1, "only the dialogue window carries lip-sync");
    assert.equal(tl.tracks.lip_sync[0].start, 6);
    assert.equal(tl.tracks.music_structure.length, 2, "instrumental windows are real source events");
    assert.ok(tl.tracks.scene_timeline.length > 0, "linked clips become honest scene-track events");
  });

  test("unapproved timelines fall back honestly — no fabricated tracks", () => {
    const board = makeBoard(makeMaster({ approved: false }));
    const tl = normalizeStoryboardTimeline({ board });
    assert.equal(tl.available, false);
    assert.equal(tl.source, "none");
    assert.equal(tl.tracks.lyrics.length, 0);
    assert.match(tl.note, /story-only planner fallback/);
    assert.equal(buildStoryboardPromptBlock({ available: false, tracks: {} }), null);
  });

  test("an approved unified 19-track timeline wins and keeps its ids/ms timestamps", () => {
    const unified = {
      schema: "kids-19-track/1", timelineId: "tl-19", version: 3, status: "approved",
      masterDurationMs: 12000, masterDurationSec: 12, approved_at: approvedAt,
      tracks: Object.fromEntries(STORYBOARD_TRACKS.map((t) => [t, []])),
    };
    unified.tracks.lyrics.push({ id: "ly-9", trackId: "lyrics", startMs: 2000, endMs: 4500, label: "line", lineId: 9 });
    const before = JSON.stringify(unified);
    const tl = normalizeStoryboardTimeline({ board: makeBoard(makeMaster()), unifiedTimeline: unified });
    assert.equal(tl.source, "unified-19-track");
    assert.equal(tl.id, "tl-19");
    assert.equal(tl.version, 3);
    assert.equal(tl.durationSec, 12);
    assert.deepEqual(tl.tracks.lyrics[0], {
      id: "ly-9", trackId: "lyrics", start: 2, end: 4.5, label: "line", lineId: 9, startMs: 2000, endMs: 4500,
    });
    assert.equal(JSON.stringify(unified), before);
  });

  test("the phase labels cover the full storyboard workflow", () => {
    assert.deepEqual(STORYBOARD_PHASES, [
      "Preparing Story Context", "Reading Approved Audio Timeline", "Analyzing Narrative Events",
      "Planning Scenes", "Generating Shot Breakdown", "Validating Character Continuity",
      "Saving Batch", "Preparing Next Batch", "Generation Complete",
    ]);
  });
});

describe("Storyboard Planner 2.0 — batch context and resume", () => {
  test("a batch window separates hard timing from advisory creative guidance", () => {
    const board = makeBoard(makeMaster());
    const ctx = storyboardBatchContext({ board, from: 3, to: 6 });
    assert.equal(ctx.available, true);
    assert.equal(ctx.from, 3);
    assert.equal(ctx.to, 6);
    assert.deepEqual(ctx.tracks.lyrics.map((e) => [e.start, e.end]), [[3, 6]]);
    assert.equal(ctx.tracks.lyrics[0].lineId, 1);
    assert.equal(ctx.instrumentals.length, 0, "the intro ends before this window");
    const block = buildStoryboardPromptBlock(ctx);
    assert.match(block, /HARD TIMING CONSTRAINTS/);
    assert.match(block, /CREATIVE VISUAL GUIDANCE/);
    assert.match(block, /3–6s|3-6s/);
    assert.match(block, /APPROVED LYRIC WINDOWS — exact, never moved/);
    assert.match(block, /WORD-LEVEL TIMINGS — lip-sync authority/);
    assert.match(block, /Instrumental windows:/);
  });

  test("Continue recomputes uncovered approved events from the scenes already saved", () => {
    const master = makeMaster();
    const partial = makeBoard(master, { partial: true });
    const full = makeBoard(master);
    const ctxPartial = storyboardBatchContext({ board: partial, from: 0, to: 12 });
    assert.deepEqual(ctxPartial.uncoveredLyrics.map((l) => l.lineId), [], "both planned lyrics are covered");
    assert.ok(ctxPartial.uncoveredNarrative.length === 0);
    // A board that saved only the first batch reports the remaining lyric.
    const oneScene = { ...partial, scenes: [partial.scenes[0], partial.scenes[1]] };
    const ctxResume = storyboardBatchContext({ board: oneScene, from: 0, to: 12 });
    assert.deepEqual(ctxResume.uncoveredLyrics.map((l) => l.lineId), [2]);
    assert.match(buildStoryboardPromptBlock(ctxResume), /L2 @ 6s/);
    assert.equal(storyboardBatchContext({ board: full, from: 0, to: 12 }).uncoveredLyrics.length, 0);
  });

  test("continuity context is read from the last saved scene, not invented", () => {
    // The resume window is planned after the first batch (3 saved scenes).
    const board = makeBoard(makeMaster(), { partial: true });
    const ctx = storyboardBatchContext({ board, from: 9, to: 12 });
    assert.equal(ctx.continuity.sceneNumber, 3);
    assert.equal(ctx.continuity.lastLine, "अब बोलो");
    assert.deepEqual(ctx.continuity.characters, ["dog"]);
    assert.equal(ctx.continuity.location, "courtyard");
    const block = buildStoryboardPromptBlock(ctx);
    assert.match(block, /CONTINUITY FROM SCENE 3/);
    assert.match(block, /no teleports, wardrobe changes or dropped props/);
  });

  test("the optional prompt block is inert when the caller does not pass it", () => {
    const args = {
      input: { title: "T", genre: "Devotional", visualStyle: "3D Cinematic", language: "hi", sceneSeconds: 3 },
      blueprint: { characters: [], locations: [], objects: [], beats: [], lyric_lines: [] },
      beats: [], prevScene: null, startNumber: 1, count: 1, styleLock: "style",
    };
    const before = buildScenesPrompt(args);
    const after = buildScenesPrompt({ ...args, cinematicContext: null });
    assert.equal(before, after);
    assert.equal(before.includes("CINEMATIC STORYBOARD CONTEXT"), false);
    const ctx = storyboardBatchContext({ board: makeBoard(makeMaster()), from: 0, to: 12 });
    const enriched = buildScenesPrompt({ ...args, cinematicContext: buildStoryboardPromptBlock(ctx) });
    assert.match(enriched, /CINEMATIC STORYBOARD CONTEXT/);
  });
});

describe("Storyboard Planner 2.0 — honest coverage and pre-approval gate", () => {
  test("full board: every lyric, narrative event, instrumental and the ending are covered", () => {
    const board = makeBoard(makeMaster());
    const audit = auditStoryboardCoverage({ board });
    assert.equal(audit.coveragePercent, 100);
    assert.equal(audit.complete, true);
    assert.equal(audit.unplannedDuration, 0);
    assert.equal(audit.endingCovered, true);
    assert.equal(audit.instrumentalCoverage.covered, 2);
    const gate = validateStoryboardForApproval({ board, audit });
    assert.equal(gate.canApprove, true);
    assert.deepEqual(gate.errors, []);
    assert.equal(gate.checks.approvedTimestampsPreserved, true);
    assert.equal(gate.checks.dialogueAssigned, true);
  });

  test("partial board: gaps, missing ending and unplanned instrumentals are reported", () => {
    const board = makeBoard(makeMaster(), { partial: true });
    const audit = auditStoryboardCoverage({ board });
    assert.equal(audit.complete, false);
    assert.equal(audit.endingCovered, false);
    assert.equal(audit.unplannedDuration, 3);
    const gate = validateStoryboardForApproval({ board, audit });
    assert.equal(gate.canApprove, false);
    const codes = gate.errors.map((e) => e.code);
    assert.ok(codes.includes("INCOMPLETE_AUDIO_COVERAGE"));
    assert.ok(codes.includes("ENDING_UNCOVERED"));
    assert.ok(codes.includes("INSTRUMENTAL_UNPLANNED"));
  });

  test("moved approved windows are critical errors, never silently accepted", () => {
    const board = makeBoard(makeMaster(), { drift: true });
    const gate = validateStoryboardForApproval({ board });
    assert.ok(gate.errors.some((e) => e.code === "APPROVED_TIMING_CHANGED"));
    assert.equal(gate.canApprove, false);
    assert.equal(gate.checks.approvedTimestampsPreserved, false);
  });

  test("no invented vocals in instrumentals and no wrong speaker in dialogue", () => {
    const instrumentalDialogue = makeBoard(makeMaster());
    const badVocal = { ...instrumentalDialogue, scenes: instrumentalDialogue.scenes.map((s, i) => i === 0
      ? { ...s, dialogue: [{ speaker: "dog", line: "no" }] } : s) };
    assert.ok(validateStoryboardForApproval({ board: badVocal }).errors
      .some((e) => e.code === "SINGING_IN_INSTRUMENTAL"));
    const wrongSpeaker = makeBoard(makeMaster(), { badSpeaker: true });
    assert.ok(validateStoryboardForApproval({ board: wrongSpeaker }).errors
      .some((e) => e.code === "SPEAKER_MISMATCH"));
  });

  test("long audio: hundreds of scenes are audited in linear time", () => {
    const N = 300;
    const segments = Array.from({ length: N }, (_, i) => ({
      segment_id: `seg-${i + 1}`, type: "instrumental", start_seconds: i, end_seconds: i + 1,
      duration_seconds: 1, lyric_line_id: null, lyric_text: "", heard_text: "", words: [],
      timing_source: "instrumental", notes: [], review_status: "approved",
    }));
    const master = { duration_seconds: N, segments, approved: approvedAt, source: "test" };
    const board = {
      id: "long", input: { title: "Long", targetSeconds: N },
      blueprint: { characters: [], locations: [], objects: [], beats: [] },
      scenes: Array.from({ length: N }, (_, i) => scene(i + 1, i, i + 1, { title: `Beat ${i + 1}` })),
      lyric_timeline: { master },
    };
    const started = Date.now();
    const audit = auditStoryboardCoverage({ board });
    assert.equal(audit.sceneCount, N);
    assert.equal(audit.shotCount, N);
    assert.equal(audit.totalAudioDuration, N);
    assert.equal(audit.complete, true);
    assert.ok(Date.now() - started < 3000, "coverage audit must remain linear/fast");
  });
});

describe("Storyboard Planner 2.0 — Director handoff and workspace view", () => {
  test("handoff carries references + plan, not a copy of the source timeline", () => {
    const board = makeBoard(makeMaster());
    const h = buildDirectorHandoff({ board });
    assert.equal(h.schema, "storyboard-handoff/1");
    assert.equal(h.timeline_reference.id, null);
    assert.equal(h.timeline_reference.durationSec, 12);
    assert.equal(h.timeline_reference.readOnly, true);
    assert.equal(h.scene_timeline.length, 4);
    assert.deepEqual(h.scene_timeline[1].source_line_ids, [1], "one source line stays one id");
    assert.equal(h.scene_timeline[2].shots[0].lip_sync_required, true);
    assert.equal(h.lip_sync_requirements.length, 1);
    assert.equal(JSON.stringify(h).includes('"segments"'), false);
    // The handoff is advisory — approve still uses the unchanged engine.
    const config = boardToScenario(board);
    assert.equal(config.sequence.length, 4);
  });

  test("workspace view exposes 19 lanes, scene cards, coverage and phases", () => {
    const board = makeBoard(makeMaster());
    const view = buildStoryboardView({ board });
    assert.equal(view.schema, "storyboard-view/1");
    assert.equal(Object.keys(view.timeline.tracks).length, 19);
    assert.equal(view.scenes.length, 4);
    assert.equal(view.coverage.complete, true);
    assert.equal(view.phases.length, 9);
    assert.equal(view.timeline.readOnly, true);
  });
});
