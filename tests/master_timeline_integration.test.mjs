// Approved-master-timeline → Song Director integration (Story/Song).
// Run: node --test tests/master_timeline_integration.test.mjs (from the repo root)
//
// The workflow requirement: an APPROVED master timeline is the AUTHORITY on
// timing — the existing Song Director scene planning and the approve →
// scenario path must consume it, never plan beside it. Pinned here:
//   * the batch planner prefers the APPROVED segments over the raw stored
//     windows and passes the approved slice into the prompt (server wiring),
//   * the scene prompt carries the timing contract + the approved absolute
//     windows ONLY for boards that have one (all other prompts unchanged),
//   * the approve path snaps drifted scene/shot windows back onto the
//     approved segments (pure) before boardToScenario runs,
//   * repeated lyric occurrences never collapse into each other,
//   * gross mismatches are REPORTED, never silently moved,
//   * absolute → clip-relative times stay derived, never invented.
import assert from "node:assert/strict";
import { test, describe } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyApprovedTimelineToScenes,
  planTimelineClips,
  buildMasterTimeline,
  approveMasterTimeline,
} from "../lib/master_timeline.mjs";
import { buildScenesPrompt } from "../lib/director.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "frontend", "server.mjs"), "utf8");
const storySrc = fs.readFileSync(path.join(ROOT, "frontend", "src", "components", "StoryPage.tsx"), "utf8");
const apiSrc = fs.readFileSync(path.join(ROOT, "frontend", "src", "api.ts"), "utf8");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const promptInput = () => ({
  title: "Test Song",
  genre: "Devotional",
  visualStyle: "3D Cinematic",
  language: "Hindi",
  sceneSeconds: 3,
  song: { durationSeconds: 24, hasLyrics: true },
});

const promptBlueprint = () => ({
  characters: [{ character_id: "moti", name: "Moti", visual_identity_prompt: "a friendly brown dog", role: "main" }],
  locations: [],
  objects: [],
  lyric_lines: [],
  beats: [],
});

// The approved slice the server hands to buildScenesPrompt for batch window
// [0, 12) — instrumental intro, two sung lines, the chorus repeat starts at 12.
const masterSlice = () => ({
  approved_at: "2026-01-01T00:00:00Z",
  duration_seconds: 24,
  from: 0,
  to: 12,
  segments: [
    { segment_id: "gap-0-2", type: "instrumental", start_seconds: 0, end_seconds: 2, lyric_text: "", character_id: "", action: "", repeat_group: null },
    { segment_id: "lbl-1_o1", type: "singing", start_seconds: 2, end_seconds: 6, lyric_text: "इस नदी में दूध है", character_id: "moti", action: "Moti scoops water with paws", repeat_group: null },
    { segment_id: "lbl-2_o1", type: "singing", start_seconds: 6, end_seconds: 9.5, lyric_text: "पीना नहीं", character_id: "moti", action: "Moti shakes his head", repeat_group: null },
  ],
  clips: [{ clip_id: "clip-1", kind: "mixed", start_seconds: 0, end_seconds: 4 }],
});

const approvedMaster = () => ({
  approved: "2026-01-01T00:00:00Z",
  duration_seconds: 24,
  segments: [
    { segment_id: "s1", type: "singing", lyric_line_id: 1, start_seconds: 2, end_seconds: 6, lyric_text: "line one", timing_source: "whisperx-word-alignment" },
    { segment_id: "s2", type: "singing", lyric_line_id: 2, start_seconds: 6, end_seconds: 9.5, lyric_text: "line two", timing_source: "whisperx-alignment-estimate" },
    // Occurrence 2 of line 1 (a repeated chorus line) — a MANUAL correction.
    { segment_id: "s3", type: "singing", lyric_line_id: 1, start_seconds: 12, end_seconds: 16, lyric_text: "line one", timing_source: "manual" },
  ],
});

// ---------------------------------------------------------------------------
// buildScenesPrompt — the timing contract
// ---------------------------------------------------------------------------

describe("buildScenesPrompt — approved master timeline contract", () => {
  const base = { input: promptInput(), blueprint: promptBlueprint(), beats: [], startNumber: 1, count: 3, styleLock: "cinematic" };

  test("boards without a master timeline get NO timing contract (byte-identical prompt)", () => {
    const out = buildScenesPrompt({ ...base, lyricTiming: [], lineRange: [] });
    assert.ok(!out.includes("APPROVED AUDIO TIMELINE"), "the contract must not render without an approved timeline");
    // The default parameter keeps old callers working.
    const explicit = buildScenesPrompt({ ...base, lyricTiming: [], lineRange: [], masterTimeline: null });
    assert.equal(out, explicit);
  });

  test("an approved slice renders the contract + the batch's approved windows", () => {
    const out = buildScenesPrompt({ ...base, lyricTiming: [], lineRange: [], masterTimeline: masterSlice() });
    assert.ok(out.includes("APPROVED AUDIO TIMELINE"), "the contract is missing");
    assert.ok(out.includes("AUTHORITY on timing"), "the contract must say the approved windows are the authority");
    assert.ok(out.includes("song_start_time\"/\"song_end_time"), "the contract must pin the scene timing fields");
    assert.ok(out.includes("0–2s | instrumental"), "the instrumental window is missing");
    assert.ok(out.includes("2–6s | singing"), "the singing window is missing");
    assert.ok(out.includes("इस नदी में दूध है"), "the lyric text of the approved segment is missing");
    assert.ok(out.includes("Moti scoops water with paws"), "the approved action is missing");
    assert.ok(out.includes("0s–12s"), "the batch window header is missing");
    assert.ok(out.includes("NEVER begins before its own lyric window"), "the no-early-action rule is missing");
    assert.ok(out.includes("NEVER invent vocals, speech or lyrics"), "the instrumental no-vocals rule is missing");
    assert.ok(out.includes("do NOT guess lyrics"), "the uncertain-window rule is missing");
    assert.ok(out.includes("CONTINUES across the cut"), "the cross-clip continuity rule is missing");
  });

  test("a repeated segment is labelled as its OWN occurrence", () => {
    const slice = { ...masterSlice(), segments: [...masterSlice().segments, { segment_id: "lbl-1_o2", type: "singing", start_seconds: 12, end_seconds: 16, lyric_text: "इस नदी में दूध है", character_id: "moti", action: "chorus again", repeat_group: "repeat-1" }] };
    const out = buildScenesPrompt({ ...base, lyricTiming: [], lineRange: [], masterTimeline: slice });
    assert.ok(out.includes("repeat-1"), "the repeat group is missing");
    assert.ok(out.includes("OWN occurrence"), "the separate-occurrence rule is missing");
  });
});

// ---------------------------------------------------------------------------
// applyApprovedTimelineToScenes — the approve-path timing authority
// ---------------------------------------------------------------------------

describe("applyApprovedTimelineToScenes", () => {
  test("no approved master → timings pass through unchanged", () => {
    const scenes = [{ scene_number: 1, song_start_time: 2.3, song_end_time: 6.4, duration_seconds: 4.1 }];
    for (const master of [null, {}, { approved: null, segments: approvedMaster().segments }]) {
      const r = applyApprovedTimelineToScenes(scenes, master);
      assert.equal(r.scenes[0].song_start_time, 2.3);
      assert.equal(r.scenes[0].song_end_time, 6.4);
      assert.ok(r.notes.length, "the pass-through must be stated, never silent");
      assert.equal(r.corrections.length, 0);
    }
  });

  test("drift within tolerance snaps to the approved window (+ duration + provenance)", () => {
    const scenes = [{ scene_number: 1, song_start_time: 2.3, song_end_time: 6.4, duration_seconds: 4.1, lyric_line_id: 1 }];
    const r = applyApprovedTimelineToScenes(scenes, approvedMaster());
    assert.equal(r.scenes[0].song_start_time, 2);
    assert.equal(r.scenes[0].song_end_time, 6);
    assert.equal(r.scenes[0].duration_seconds, 4);
    assert.equal(r.scenes[0].timing_source, "approved-master-timeline");
    assert.equal(r.corrections.length, 1);
    assert.deepEqual(r.corrections[0].from, [2.3, 6.4]);
    assert.deepEqual(r.corrections[0].to, [2, 6]);
  });

  test("repeated lines snap to their OWN occurrence (chorus repeat never collapses)", () => {
    // Scene for occurrence 2 of line 1 (the 12–16 s repeat) must NOT move to
    // the 2–6 s occurrence, even though both share lyric_line_id 1.
    const scenes = [{ scene_number: 2, song_start_time: 12.4, song_end_time: 15.9, duration_seconds: 3.5, lyric_line_id: 1 }];
    const r = applyApprovedTimelineToScenes(scenes, approvedMaster());
    assert.equal(r.scenes[0].song_start_time, 12);
    assert.equal(r.scenes[0].song_end_time, 16);
    assert.equal(r.corrections[0].to[0], 12, "the repeat must keep its own occurrence");
  });

  test("a window far from every approved segment is REPORTED, never moved", () => {
    const scenes = [{ scene_number: 3, song_start_time: 8, song_end_time: 14, duration_seconds: 6, lyric_line_id: 1 }];
    const r = applyApprovedTimelineToScenes(scenes, approvedMaster());
    assert.equal(r.scenes[0].song_start_time, 8, "a far mismatch must not be silently moved");
    assert.equal(r.scenes[0].song_end_time, 14);
    assert.equal(r.corrections.length, 0);
    assert.ok(r.notes.some((n) => /NOT moved/.test(n)), "the report must tell the user to fix it in the review panel");
  });

  test("a scene with no overlapping approved segment is left unchanged + noted", () => {
    const scenes = [{ scene_number: 4, song_start_time: 20, song_end_time: 23, duration_seconds: 3, lyric_line_id: 2 }];
    const r = applyApprovedTimelineToScenes(scenes, approvedMaster());
    assert.equal(r.scenes[0].song_start_time, 20);
    assert.equal(r.scenes[0].song_end_time, 23);
    assert.ok(r.notes.some((n) => /no approved segment/.test(n)));
  });

  test("a scene without song windows (story boards) passes through untouched", () => {
    const scenes = [{ scene_number: 5, title: "a story scene", duration_seconds: 3 }];
    const r = applyApprovedTimelineToScenes(scenes, approvedMaster());
    assert.deepEqual(r.corrections, []);
    assert.equal(r.scenes[0].timing_source, undefined);
  });

  test("lyric-carrying shots snap to their own segment; sibling shots re-tile exactly", () => {
    const scenes = [{
      scene_number: 1,
      song_start_time: 4, song_end_time: 8, duration_seconds: 4,
      line_from: 1, line_to: 2,
      shots: [
        { shot_id: "1-A", lyric_line_id: 1, start_time: 0, end_time: 2, duration_seconds: 2 },
        { shot_id: "2-A", lyric_line_id: 2, start_time: 2, end_time: 4, duration_seconds: 2 },
      ],
    }];
    const r = applyApprovedTimelineToScenes(scenes, approvedMaster());
    const sc = r.scenes[0];
    assert.equal(sc.song_start_time, 2);
    assert.equal(sc.song_end_time, 9.5);
    // Shot 1-A (line 1) → its own approved segment 2–6, scene-relative 0–4.
    assert.equal(sc.shots[0].start_time, 0);
    assert.equal(sc.shots[0].end_time, 4);
    // Shot 2-A (line 2) → its own approved segment 6–9.5, scene-relative 4–7.5.
    assert.equal(sc.shots[1].start_time, 4);
    assert.equal(sc.shots[1].end_time, 7.5);
    // The shots still tile the snapped scene EXACTLY (no gap, no overlap).
    assert.equal(sc.shots[1].end_time, +(sc.song_end_time - sc.song_start_time).toFixed(3));
    assert.ok(r.corrections.length === 1);
  });

  test("snapped scenes land INSIDE the approved clip plan (absolute → clip-relative stays derived)", () => {
    const master = buildMasterTimeline({
      lyricTimeline: {
        language: "hi", duration_seconds: 24,
        lines: [
          { line_id: 1, lyric_text: "स्वागत है", occurrence: 1, start_seconds: 2, end_seconds: 6, timing: "measured", match: "whisperx", heard_text: "स्वागत है", confidence: 0.9, low_confidence: false, words: [] },
          { line_id: 2, lyric_text: "मंदिर चलें", occurrence: 1, start_seconds: 6, end_seconds: 9.5, timing: "measured", match: "whisperx", heard_text: "मंदिर चलें", confidence: 0.9, low_confidence: false, words: [] },
        ],
        whisper: { stats: {}, gaps: [], segments: [] },
      },
      vocalActivity: { method: "whisperx-vad", segments: [{ start: 2, end: 9.5, activity: "vocal" }] },
      duration: 24,
      characters: [], style: [], semantics: [],
    });
    const gate = approveMasterTimeline(master);
    assert.equal(gate.approved, true, "fixture must approve cleanly");
    const scenes = [
      { scene_number: 1, song_start_time: 2.2, song_end_time: 6.1, duration_seconds: 3.9, lyric_line_id: 1 },
      { scene_number: 2, song_start_time: 6.2, song_end_time: 9.4, duration_seconds: 3.2, lyric_line_id: 2 },
    ];
    const r = applyApprovedTimelineToScenes(scenes, gate.timeline);
    const clips = planTimelineClips(gate.timeline);
    assert.ok(clips.length > 0, "the approved timeline must plan clips");
    // The clips tile the WHOLE approved duration contiguously; every snapped
    // scene window must lie inside that coverage (clip boundaries are derived
    // from the same approved windows — never invented).
    let coveredTo = 0;
    for (const c of clips) {
      assert.ok(Math.abs(c.start_seconds - coveredTo) < 0.05, `clip ${c.clip_id} must start where the previous ended (${c.start_seconds} vs ${coveredTo})`);
      coveredTo = c.end_seconds;
    }
    for (const sc of r.scenes) {
      const host = clips.find((c) => c.start_seconds - 0.001 <= sc.song_start_time && sc.song_end_time <= c.end_seconds + 0.001)
        || (sc.song_start_time >= clips[0].start_seconds - 0.001 && sc.song_end_time <= coveredTo + 0.001 ? clips[0] : null);
      assert.ok(host, `scene ${sc.scene_number} (${sc.song_start_time}–${sc.song_end_time}) must sit inside the approved clip coverage`);
    }
  });
});

// ---------------------------------------------------------------------------
// Server wiring (static — the same harness as lyric_timeline_server.test.mjs)
// ---------------------------------------------------------------------------

describe("server wiring — the approved timeline drives the REAL workflow", () => {
  test("the batch planner prefers the APPROVED segments over the raw stored windows", () => {
    assert.ok(serverSrc.includes("let approvedApplied = false") && serverSrc.includes("currentLineIds.every((id) => approvedIds.has(id))"), "the approved-coverage gate is missing");
    assert.ok(serverSrc.includes("lyricTiming = approvedTiming"), "the planner never assigns the approved windows");
    assert.ok(serverSrc.includes("approvedApplied"), "the planner cannot tell whether the approved timing was applied");
  });

  test("the batch prompt receives the approved slice at BOTH call sites (real + dry-run)", () => {
    assert.ok(serverSrc.includes("masterTimeline: masterTiming || null"), "the real batch must pass the approved slice");
    assert.ok(serverSrc.includes("masterTimeline: spec.masterTiming || null"), "the prompt-preview must pass the approved slice too");
    assert.ok(serverSrc.includes("masterTiming };"), "the spec must carry the approved slice");
  });

  test("the approve path snaps scene timings to the approved timeline BEFORE boardToScenario", () => {
    const idx = serverSrc.indexOf("applyApprovedTimelineToScenes(board.scenes, approvedMaster)");
    assert.ok(idx > 0, "the approve route never applies the approved timing");
    const before = serverSrc.indexOf("const generationBoard = {", idx);
    assert.ok(before > idx, "the snap must run BEFORE boardToScenario builds the config");
    assert.ok(serverSrc.indexOf("boardToScenario(generationBoard)", before) > before, "the enriched generation board must be assembled after timing snap");
    assert.ok(serverSrc.includes("timing_corrections: timingCorrections"), "the approve response must report the snaps");
    assert.ok(/applyApprovedTimelineToScenes,\s*\}\s*from\s*"\.\.\/lib\/master_timeline\.mjs"/.test(serverSrc), "the import is missing");
  });

  test("the UI surfaces the approved timeline in the planning step + the approve report", () => {
    assert.ok(storySrc.includes("🎼 Approved timeline drives timing"), "the plan header pill is missing");
    assert.ok(storySrc.includes("approveRes.timing_corrections"), "the approve dialog must report snapped windows");
    assert.ok(apiSrc.includes("timing_corrections?:"), "the api client type must carry the approve corrections");
  });

  test("the master-timeline approve gate stays the ONLY door to generation (no bypass)", () => {
    assert.ok(
      serverSrc.includes('if (!view.approved) return json(res, 409, { error: "approve the master timeline before generating clips", approved: false })'),
      "the generate route must refuse unapproved timelines",
    );
  });
});
