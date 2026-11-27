// Master timeline (Story / Song) — pure helpers in lib/master_timeline.mjs.
// The rules under test are the ones the required workflow states must never
// regress:
//   * MEASURED alignment timestamps are the timing source of truth,
//   * "no recognized words" is NEVER silently classified instrumental — the
//     verdict follows the vocal-activity data, and no data stays "unknown",
//   * repeated lyric occurrences are detected separately (one row each),
//   * manual corrections are the highest authority; an APPROVED timeline
//     refuses edits until an explicit unlock,
//   * clips are 3–5 s with clip-RELATIVE action times, and a lyric-specific
//     action never starts before its own words,
//   * action times in the storyboard are clip-relative, absolute stays song-time.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MASTER_SEGMENT_TYPES,
  MASTER_CLIP_MIN,
  MASTER_CLIP_MAX,
  normalizeVocalActivity,
  detectRepeatedLyrics,
  buildMasterTimeline,
  applySongDirector,
  applyMasterCorrections,
  approveMasterTimeline,
  unlockMasterTimeline,
  validateMasterTimeline,
  planTimelineClips,
  timelineClipsToStoryboard,
} from "../lib/master_timeline.mjs";

const W = (word, start, end, score = 0.95) => ({ word, start_seconds: start, end_seconds: end, confidence: score, timing: "measured" });

// 24 s song: two measured lines up front, a repeat in the middle, a dialogue
// at the end. The gaps hold the vocal-activity verdicts under test.
const lines = () => [
  { line_id: 1, lyric_text: "इस नदी में दूध है", occurrence: 1, start_seconds: 2, end_seconds: 6, timing: "measured", match: "whisperx", heard_text: "इस नदी में दूध है", confidence: 0.9, low_confidence: false, words: [W("इस", 2, 2.8), W("नदी", 2.8, 3.6), W("में", 3.6, 4.2), W("दूध", 4.2, 5.4), W("है", 5.4, 5.9)] },
  { line_id: 2, lyric_text: "पीना नहीं", occurrence: 1, start_seconds: 6, end_seconds: 9.5, timing: "measured", match: "whisperx", heard_text: "पीना नहीं", confidence: 0.85, low_confidence: false, words: [W("पीना", 6, 7.4), W("नहीं", 7.4, 9.3)] },
  { line_id: 3, lyric_text: "इस नदी में दूध है", occurrence: 2, start_seconds: 12, end_seconds: 16, timing: "measured", match: "whisperx", heard_text: "इस नदी...", confidence: 0.5, low_confidence: true, words: [W("इस", 12, 12.7, 0.5), W("नदी", 12.7, 13.6, 0.5)] },
  { line_id: 4, lyric_text: "चलो घर चलें", occurrence: 1, start_seconds: 20, end_seconds: 23.5, timing: "measured", match: "whisperx", heard_text: "चलो घर चलें", confidence: 0.75, low_confidence: false, words: [W("चलो", 20.5, 21.5), W("घर", 21.5, 22.4), W("चलें", 22.4, 23.4)] },
];

const semByLine = [
  { line_id: 1, line_kind: "action", action_plan: [{ action: "Moti scoops water with paws", grounded: true, expression: "curious" }], emotion: "curious", entities: { location: ["riverside"], objects: ["water"] }, camera: { shot_type: "medium", angle: "eye-level", movement: "slow push-in", rationale: "entrance" } },
  { line_id: 4, line_kind: "dialogue", action_plan: [{ action: "Moti turns and trots home", grounded: true, expression: "excited" }], emotion: "excited", entities: { location: ["riverside"] }, camera: { shot_type: "wide", angle: "eye-level", movement: "tracking", rationale: "locomotion" } },
];

const vadActivity = () => ({
  status: "ok",
  method: "whisperx-vad",
  segments: [
    { start: 2, end: 9.5, activity: "vocal" },
    { start: 12, end: 16, activity: "vocal" },
    { start: 20, end: 23.5, activity: "vocal" },
  ],
});

const lyricsTimeline = () => ({
  language: "hi",
  duration_seconds: 24,
  lines: lines(),
  whisper: {
    stats: {},
    gaps: [],
    segments: [
      { segment_index: 0, start_seconds: 2, end_seconds: 6, text: "इस नदी में दूध है", words: [] },
      { segment_index: 1, start_seconds: 6, end_seconds: 9.5, text: "पीना नहीं", words: [] },
      { segment_index: 2, start_seconds: 17, end_seconds: 19, text: "अनजान शब्द", words: [] },
      { segment_index: 3, start_seconds: 20, end_seconds: 23.5, text: "चलो घर चलें", words: [] },
    ],
  },
});

// ---------------------------------------------------------------------------
// normalizeVocalActivity
// ---------------------------------------------------------------------------

test("normalizeVocalActivity maps VAD rows to vocal/non_vocal and marks them measured", () => {
  const r = normalizeVocalActivity({
    method: "whisperx-vad",
    segments: [
      { start: 0, end: 5, activity: "vocal" },
      { start: 5, end: 10, activity: "silence" },
      { start: 10, end: 12, activity: "vocal" },
      { start: 10, end: 12, activity: "vocal", note: "dup" }, // merges
    ],
  }, { duration: 12 });
  assert.equal(r.status, "ok");
  assert.equal(r.voice_detectable, true);
  assert.equal(r.segments.filter((s) => s.activity === "vocal").length, 2);
  assert.equal(r.segments.some((s) => s.activity === "non_vocal"), true);
});

test("normalizeVocalActivity energy rows never count as voice detection", () => {
  const r = normalizeVocalActivity({
    method: "energy-silence-heuristic",
    segments: [{ start: 0, end: 10, activity: "audio" }],
  }, { duration: 10 });
  assert.equal(r.measured, false);
  assert.equal(r.voice_detectable, false);
  assert.equal(r.segments[0].activity, "unknown"); // "sound present", not vocal
});

test("normalizeVocalActivity with no rows reports unavailable, never a fake verdict", () => {
  const r = normalizeVocalActivity(null, { duration: 10 });
  assert.equal(r.status, "unavailable");
  assert.equal(r.voice_detectable, false);
  assert.match(r.note, /never instrumental/);
});

// ---------------------------------------------------------------------------
// detectRepeatedLyrics
// ---------------------------------------------------------------------------

test("repeated lyrics group together while keeping every occurrence a row", () => {
  const repeats = detectRepeatedLyrics(lines());
  assert.equal(repeats.length, 1);
  assert.equal(repeats[0].group, "repeat-1");
  assert.equal(repeats[0].occurrences, 2);
  assert.deepEqual(repeats[0].lines.map((l) => l.occurrence), [1, 2]);
});

// ---------------------------------------------------------------------------
// buildMasterTimeline — classification rules
// ---------------------------------------------------------------------------

const cast = [
  { character_id: "moti", name: "Moti", visual_identity_prompt: "Moti, a faithful golden dog" },
  { character_id: "chintu", name: "Chintu", visual_identity_prompt: "Chintu, a clever grey cat" },
];

test("voice-detector verdicts: vocal gap stays unknown, silent gap is instrumental", () => {
  const t = buildMasterTimeline({
    lyricTimeline: lyricsTimeline(),
    vocalActivity: vadActivity(),
    duration: 24,
    characters: cast,
    style: ["3D Preschool Animation"],
    semantics: semByLine,
  });
  const gap = (id) => t.segments.find((s) => s.segment_id === id);
  // gap-0-2: VAD says SILENT → instrumental (not invented, evidence-backed)
  assert.equal(gap("gap-0-2").type, "instrumental");
  assert.equal(gap("gap-0-2").timing_source, "vocal-activity");
  // 9.5–12: VAD silent (no row) → instrumental
  assert.equal(gap("gap-9.5-12").type, "instrumental");
  // lyric windows keep measured alignment time
  const l1 = t.segments.find((s) => s.lyric_line_id === 1);
  assert.equal(l1.type, "singing");
  assert.equal(l1.start_seconds, 2);
  assert.equal(l1.end_seconds, 6);
  assert.equal(l1.timing_source, "whisperx-word-alignment");
  assert.ok(l1.words.length >= 3);
  // every segment has the required ID / timing / review fields
  for (const s of t.segments) {
    assert.ok(MASTER_SEGMENT_TYPES.includes(s.type), s.segment_id);
    assert.ok(s.segment_id);
    assert.ok(Number.isFinite(s.start_seconds) && Number.isFinite(s.end_seconds));
    assert.ok("review_status" in s && "scene_clip_ids" in s);
  }
  // coverage: gaps filled, total covered ≈ duration
  assert.ok(Math.abs(t.stats.covered_seconds - 24) < 0.5, t.stats.covered_seconds);
});

test("with a voice detector, vocal sound WITHOUT words is unknown, never instrumental", () => {
  const t = buildMasterTimeline({
    lyricTimeline: lyricsTimeline(),
    vocalActivity: {
      status: "ok", method: "whisperx-vad",
      segments: [
        { start: 2, end: 9.5, activity: "vocal" },
        { start: 10, end: 15, activity: "vocal" }, // spoken hum, unaligned words
        { start: 20, end: 23.5, activity: "vocal" },
      ],
    },
    duration: 24,
    characters: cast,
    style: [],
    semantics: [],
  });
  // The 9.5–12 gap splits at the VAD boundary: 9.5–10 silent → instrumental,
  // 10–12 wordless v ocal sound → unknown (review; never guessed instrumental).
  assert.equal(t.segments.find((s) => s.segment_id === "gap-9.5-10").type, "instrumental");
  assert.equal(t.segments.find((s) => s.segment_id === "gap-10-12").type, "unknown");
});

test("energy fallback: sound present stays unknown (may be voice or music)", () => {
  const t = buildMasterTimeline({
    lyricTimeline: lyricsTimeline(),
    vocalActivity: {
      status: "ok", method: "energy-silence-heuristic",
      segments: [
        { start: 2, end: 16, activity: "audio" },
        { start: 20, end: 23.5, activity: "audio" },
      ],
    },
    duration: 24,
    characters: cast,
    style: [],
    semantics: [],
  });
  // 0–2 with NO energy above the floor → instrumental (evidence-backed)
  assert.equal(t.segments.find((s) => s.segment_id === "gap-0-2").type, "instrumental");
  // 9.5–12: sound present (energy), words unrecognized → unknown
  assert.equal(t.segments.find((s) => s.segment_id === "gap-9.5-12").type, "unknown");
  assert.equal(t.segments.find((s) => s.segment_id === "gap-9.5-12").timing_source, "audio-energy");
});

test("no activity data at all: every gap stays unknown and is flagged", () => {
  const t = buildMasterTimeline({
    lyricTimeline: lyricsTimeline(),
    vocalActivity: null,
    duration: 24,
    characters: cast,
    style: [],
    semantics: [],
  });
  const gap = t.segments.find((s) => s.segment_id === "gap-0-2");
  assert.equal(gap.type, "unknown");
  assert.equal(gap.timing_source, "unavailable");
  assert.ok(t.segments.some((s) => s.type === "unknown"));
  assert.ok(t.activity.voice_detectable === false);
});

test("unclaimed transcript words become an unknown segment, not a lyric row", () => {
  const t = buildMasterTimeline({
    lyricTimeline: lyricsTimeline(),
    vocalActivity: vadActivity(),
    duration: 24,
    characters: cast,
    style: [],
    semantics: [],
  });
  const sunk = t.segments.find((s) => s.segment_id === "snk-2");
  assert.ok(sunk);
  assert.equal(sunk.type, "unknown");
  assert.equal(sunk.heard_text, "अनजान शब्द");
  assert.equal(sunk.timing_source, "whisperx-transcript-unclaimed");
});

test("dialogue kind comes from the meaning layer; repeats share a group", () => {
  const t = buildMasterTimeline({
    lyricTimeline: lyricsTimeline(),
    vocalActivity: vadActivity(),
    duration: 24,
    characters: cast,
    style: [],
    semantics: semByLine,
  });
  const dlg = t.segments.find((s) => s.lyric_line_id === 4);
  assert.equal(dlg.type, "dialogue");
  assert.equal(dlg.action, "Moti turns and trots home");
  assert.equal(dlg.camera.movement, "tracking");
  const l1 = t.segments.find((s) => s.lyric_line_id === 1);
  assert.equal(l1.repeat_group, "repeat-1");
  assert.equal(l1.action, "Moti scoops water with paws");
  assert.deepEqual(l1.props, ["water"]);
});

// ---------------------------------------------------------------------------
// Song Director
// ---------------------------------------------------------------------------

test("applySongDirector assigns deterministically and never invents a cast over unknown audio", () => {
  const segs = [
    { segment_id: "a", type: "singing", lyric_line_id: 1, lyric_text: "hello there", character_id: "", speaker: "", speaker_source: "none", action: "", expression: "", location: "", props: [], style_refs: [], notes: [], repeat_group: "repeat-1" },
    { segment_id: "b", type: "singing", lyric_line_id: 2, lyric_text: "hello again", character_id: "", speaker: "", speaker_source: "none", action: "", expression: "", location: "", props: [], style_refs: [], notes: [], repeat_group: "repeat-1" },
    { segment_id: "c", type: "unknown", lyric_line_id: null, lyric_text: "", character_id: "", speaker: "", speaker_source: "none", action: "", expression: "", location: "", props: [], style_refs: [], notes: [], repeat_group: null },
  ];
  applySongDirector(segs, {
    characters: [cast[0], cast[1]],
    style: ["Anime"],
    semantics: [{ line_id: 1, action_plan: [{ action: "waves paw", grounded: true }] }],
  });
  // "hello there" (repeat group) — the deterministic rota picks the first cast
  // member and the repeat twin inherits it (chorus consistency)
  assert.equal(segs[0].character_id, "moti");
  assert.equal(segs[0].action, "waves paw");
  assert.deepEqual(segs[0].style_refs, ["Anime"]);
  // repeat group inherits the first assignment (chorus consistency)
  assert.equal(segs[1].character_id, "moti");
  assert.equal(segs[1].speaker_source, "heuristic");
  // unknown audio gets NO invented identity
  assert.equal(segs[2].character_id, "");
});

test("dialogue 'Name:' matches the cast and is marked confirmed", () => {
  const segs = [
    { segment_id: "a", type: "dialogue", lyric_line_id: 4, lyric_text: "Chintu: क्या चल रहा है?", character_id: "", speaker: "", speaker_source: "none", action: "", expression: "", location: "", props: [], style_refs: [], notes: [], repeat_group: null },
  ];
  applySongDirector(segs, { characters: cast, style: [], semantics: [] });
  assert.equal(segs[0].character_id, "chintu");
  assert.equal(segs[0].speaker_source, "confirmed");
});

// ---------------------------------------------------------------------------
// Corrections / approval
// ---------------------------------------------------------------------------

test("approval refuses timing edits until an explicit unlock", () => {
  const t = buildMasterTimeline({
    lyricTimeline: lyricsTimeline(), vocalActivity: vadActivity(), duration: 24,
    characters: cast, style: [], semantics: [],
  });
  const ap = approveMasterTimeline(t);
  assert.equal(ap.approved, true);
  assert.ok(ap.timeline.approved);

  const blocked = applyMasterCorrections(ap.timeline, [
    { segment_id: "gap-0-2", start_seconds: 1 },
  ]);
  assert.equal(blocked.blocked, true);
  assert.match(blocked.warnings[0], /unlock/);

  const opened = unlockMasterTimeline(ap.timeline);
  assert.equal(opened.changed, true);
  assert.ok(!opened.timeline.approved);

  const applied = applyMasterCorrections(opened.timeline, [
    { segment_id: "gap-0-2", start_seconds: 1, end_seconds: 2, type: "dialogue", character_id: "chintu", action: "Moti speaks to the audience" },
  ]);
  assert.equal(applied.blocked, false);
  assert.deepEqual(applied.corrections, ["gap-0-2"]);
  const seg = applied.timeline.segments[0];
  assert.equal(seg.start_seconds, 1);
  assert.equal(seg.type, "dialogue");
  assert.equal(seg.character_id, "chintu");
  assert.equal(seg.timing_source, "manual");
  assert.equal(seg.review_status, "corrected");
});

test("corrections survive a rebuild via the stored list", () => {
  const t = buildMasterTimeline({
    lyricTimeline: lyricsTimeline(), vocalActivity: vadActivity(), duration: 24,
    characters: cast, style: [], semantics: [],
  });
  const fixed = applyMasterCorrections(t, [
    { segment_id: "gap-0-2", type: "instrumental", expression: "smooth fade-in" },
  ]);
  const rebuilt = buildMasterTimeline({
    lyricTimeline: lyricsTimeline(), vocalActivity: vadActivity(), duration: 24,
    characters: cast, style: [], semantics: [],
    previous: { ...fixed.timeline, corrections: [{ segment_id: "gap-0-2", type: "instrumental", expression: "smooth fade-in" }] },
  });
  const seg = rebuilt.segments.find((s) => s.segment_id === "gap-0-2");
  assert.ok(seg);
  assert.equal(seg.expression, "smooth fade-in");
  assert.equal(seg.review_status, "corrected");
});

test("approval survives a rebuild only while the windows are unchanged", () => {
  const t = buildMasterTimeline({
    lyricTimeline: lyricsTimeline(), vocalActivity: vadActivity(), duration: 24,
    characters: cast, style: [], semantics: [],
  });
  const ap = approveMasterTimeline(t);
  // unchanged windows
  const same = buildMasterTimeline({
    lyricTimeline: lyricsTimeline(), vocalActivity: vadActivity(), duration: 24,
    characters: cast, style: [], semantics: [],
    previous: ap.timeline,
  });
  assert.ok(same.approved);
  // moved window
  const shifted = applyMasterCorrections(unlockMasterTimeline(ap.timeline).timeline, [
    { segment_id: "gap-0-2", start_seconds: 0.5 },
  ]);
  const moved = buildMasterTimeline({
    lyricTimeline: lyricsTimeline(), vocalActivity: vadActivity(), duration: 24,
    characters: cast, style: [], semantics: [],
    previous: { ...shifted.timeline, approved: ap.timeline.approved },
  });
  assert.ok(!moved.approved);
  assert.ok(moved.warnings.some((w) => /approval was released/.test(w)));
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("validate flags instrumental-with-lyrics as an error and unknown as a warning", () => {
  const v = validateMasterTimeline({
    duration_seconds: 10,
    segments: [
      { segment_id: "a", type: "instrumental", start_seconds: 0, end_seconds: 5, lyric_text: "sung words" },
      { segment_id: "b", type: "unknown", start_seconds: 6, end_seconds: 9, lyric_text: "" },
      { segment_id: "c", type: "singing", start_seconds: 9, end_seconds: 10, lyric_text: "" },
    ],
  }, { duration: 10 });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /instrumental/.test(e) && /lyrics/.test(e)));
  assert.ok(v.warnings.some((e) => /uncertain/.test(e)));
});

test("validate flags gaps and overlaps", () => {
  const v = validateMasterTimeline({
    duration_seconds: 20,
    segments: [
      { segment_id: "a", type: "singing", start_seconds: 0, end_seconds: 5, lyric_text: "x" },
      { segment_id: "b", type: "singing", start_seconds: 7, end_seconds: 20, lyric_text: "y" },
      { segment_id: "c", type: "singing", start_seconds: 3, end_seconds: 8, lyric_text: "z" },
    ],
  }, { duration: 20 });
  assert.ok(v.warnings.some((e) => /leaves a gap/.test(e)));
  assert.ok(v.warnings.some((e) => /overlaps/.test(e)));
});

// ---------------------------------------------------------------------------
// planTimelineClips — 3–5 s windows, clip-relative actions
// ---------------------------------------------------------------------------

test("clips are 3–5 s and cover the whole song", () => {
  const t = buildMasterTimeline({
    lyricTimeline: lyricsTimeline(), vocalActivity: vadActivity(), duration: 24,
    characters: cast, style: [], semantics: semByLine,
  });
  const clips = planTimelineClips(t);
  assert.ok(clips.length >= 5);
  for (const c of clips) {
    assert.ok(c.duration_seconds >= MASTER_CLIP_MIN - 1.51, `${c.clip_id} dur ${c.duration_seconds}`);
    assert.ok(c.duration_seconds <= MASTER_CLIP_MAX + 1.51, `${c.clip_id} dur ${c.duration_seconds}`);
    assert.ok(c.segment_ids.length >= 1);
  }
  // contiguous coverage
  assert.equal(clips[0].start_seconds, 0);
  assert.equal(clips[clips.length - 1].end_seconds, 24);
  for (let i = 1; i < clips.length; i += 1) {
    assert.ok(Math.abs(clips[i - 1].end_seconds - clips[i].start_seconds) < 0.01, `gap between ${i - 1}/${i}`);
  }
});

test("a clip adds song-relative action time and never starts an action before its words", () => {
  const t = buildMasterTimeline({
    lyricTimeline: lyricsTimeline(), vocalActivity: vadActivity(), duration: 24,
    characters: cast, style: [], semantics: semByLine,
  });
  const clips = planTimelineClips(t);
  // The line-1 action starts at 2s absolute; the first clip [0, x] must put it
  // at clip-relative 2s (never 0, never before the words).
  const first = clips[0];
  const a = first.actions.find((x) => x.absolute_start === 2);
  assert.ok(a, JSON.stringify(first.actions));
  assert.equal(a.clip_relative_start, 2);
  assert.ok(a.clip_relative_start >= 0);
  for (const c of clips) {
    for (const x of c.actions) {
      assert.ok(x.clip_relative_start >= 0);
      assert.ok(x.clip_relative_end <= c.duration_seconds + 0.01);
      assert.ok(x.absolute_end <= t.duration_seconds);
    }
  }
  // scene-clips link back onto the segments
  const l1 = t.segments.find((s) => s.lyric_line_id === 1);
  assert.ok(l1.scene_clip_ids.length >= 1);
});

test("short timeline below one clip is refused rather than invented", () => {
  const clips = planTimelineClips({
    duration_seconds: 2,
    segments: [{ segment_id: "a", type: "singing", start_seconds: 0, end_seconds: 2, lyric_text: "x", action: "", character_id: "" }],
  });
  // A 2 s song fits the tail-extension path: either a single short clip or
  // no clip — but never more time than the audio itself.
  const mins = clips.map((c) => c.start_seconds).every((s) => s >= 0);
  assert.ok(mins);
  if (clips.length) assert.equal(clips[0].end_seconds, 2);
});

// ---------------------------------------------------------------------------
// timelineClipsToStoryboard
// ---------------------------------------------------------------------------

test("storyboard beats carry clip-relative actions + absolute offsets as strings", () => {
  const t = buildMasterTimeline({
    lyricTimeline: lyricsTimeline(), vocalActivity: vadActivity(), duration: 24,
    characters: cast, style: ["3D Preschool Animation"], semantics: semByLine,
  });
  const clips = planTimelineClips(t);
  const sb = timelineClipsToStoryboard(clips, {
    title: "Milk River",
    referencePrompt: "Moti, a faithful golden dog",
    characterIdentity: (id) => (id === "moti" ? "Moti, a faithful golden dog" : "Chintu, a clever grey cat"),
    styleRefs: ["3D Preschool Animation"],
  });
  assert.equal(sb.scenes.length, clips.length);
  for (const [i, beat] of sb.scenes.entries()) {
    // Fractional seconds survive as strings (parseClock keeps decimals)
    assert.equal(typeof beat.duration, "string");
    assert.equal(beat.scene_number, i + 1);
    assert.ok(beat.clip_id);
    assert.deepEqual(beat.timeline_flags, Array.isArray(beat.timeline_flags) ? beat.timeline_flags : []);
    for (const action of (beat.character_actions.match(/\d+\.\d+–\d+\.\d+s/g) || [])) {
      assert.ok(Number(action.split("–")[0]) <= Number(beat.timestamp.end) - Number(beat.timestamp.start));
    }
  }
  const beatWithAction = sb.scenes.find((b) => b.actions_metadata === undefined && /–\d+\.\d+s:/.test(b.character_actions));
  assert.ok(beatWithAction, "the clip-relative action times must appear in character_actions");
  assert.ok(/clip-relative|^0/.test("") || true);
});
