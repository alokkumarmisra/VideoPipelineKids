// WhisperX lyric-timeline import (Story / Song) — pure helpers in
// lib/semantics.mjs. The rules under test are the ones that must never
// regress:
//   * the user's own lyric text is authoritative (WhisperX is timing only),
//   * a repeated chorus keeps its own occurrence,
//   * instrumental / silent stretches and long gaps are reported, not hidden,
//   * missing word timestamps degrade to an explicitly ESTIMATED window,
//   * a line crossing a clip/segment boundary takes the outer bounds,
//   * Hindi spelling drift still matches, low-confidence words are flagged,
//   * manual corrections are the highest authority and survive re-imports.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeWhisperImport,
  alignLyricsToWhisper,
  buildLyricPhrases,
  buildLyricActionTimeline,
  assignLyricLinesToScenes,
  validateLyricTimeline,
  applyLyricCorrections,
  buildLyricTimeline,
} from "../lib/semantics.mjs";

const LYRICS = [
  { lyric_line_id: 1, lyric_text: "Twinkle twinkle little star" },
  { lyric_line_id: 2, lyric_text: "How I wonder what you are" },
  { lyric_line_id: 3, lyric_text: "Twinkle twinkle little star" },
];

const W = (word, start, end, score = 0.98) => ({ word, start, end, score });

const songWhisper = () => ({
  segments: [
    { start: 0, end: 2.2, text: "twinkle twinkle little star", words: [W("twinkle", 0.1, 0.5), W("twinkle", 0.6, 1), W("little", 1.1, 1.5), W("star", 1.6, 2)] },
    { start: 4, end: 5, text: "", words: [] }, // instrumental
    { start: 6, end: 9, text: "how i wonder what you are", words: [] }, // no word stamps
    { start: 10, end: 12.2, text: "twinkle twinkle little star", words: [W("twinkle", 10.1, 10.5, 0.31), W("twinkle", 10.6, 11, 0.31), W("little", 11.1, 11.5, 0.31), W("star", 11.6, 12, 0.31)] },
  ],
});

// ---------------------------------------------------------------------------
// normalizeWhisperImport
// ---------------------------------------------------------------------------

test("normalizeWhisperImport keeps segment + word timing", () => {
  const r = normalizeWhisperImport(songWhisper(), { duration: 12.2 });
  assert.equal(r.ok, true);
  assert.equal(r.stats.segments, 4);
  assert.equal(r.stats.words, 14); // 4 measured + 0 + 6 estimated + 4 measured
  assert.equal(r.segments[0].words[0].word, "twinkle");
  assert.equal(r.segments[0].words[0].confidence, 0.98);
  assert.equal(r.segments[0].words[0].timing, "measured");
});

test("normalizeWhisperImport flags instrumental stretches and long gaps", () => {
  const r = normalizeWhisperImport(songWhisper(), { duration: 12.2 });
  assert.equal(r.stats.instrumental_segments, 1);
  const reasons = r.gaps.map((g) => g.reason);
  assert.ok(reasons.includes("instrumental"));
  assert.ok(reasons.includes("silence"));
  const silence = r.gaps.find((g) => g.reason === "silence");
  assert.equal(silence.seconds, 1.8); // 2.2 -> 4.0
});

test("normalizeWhisperImport splits a segment window when word stamps are missing", () => {
  const r = normalizeWhisperImport(songWhisper(), { duration: 12.2 });
  const seg = r.segments[2];
  assert.equal(seg.start_seconds, 6);
  assert.equal(seg.words.length, 6); // how i wonder what you are
  assert.ok(seg.words.every((w) => w.timing === "estimated"));
  assert.equal(seg.words[0].start_seconds, 6);
  assert.equal(seg.words[5].end_seconds, 9);
  assert.ok(r.warnings.some((w) => /no word timestamps/i.test(w)));
});

test("normalizeWhisperImport accepts a bare array and a words-only payload", () => {
  const bare = normalizeWhisperImport([{ start: 0, end: 1, text: "hi there", words: [W("hi", 0, 0.4), W("there", 0.5, 0.9)] }]);
  assert.equal(bare.segments.length, 1);
  assert.equal(bare.stats.words, 2);

  const wordsOnly = normalizeWhisperImport({ words: [W("one", 0, 0.3), W("two", 0.4, 0.8)] });
  assert.equal(wordsOnly.segments.length, 1);
  assert.equal(wordsOnly.stats.words, 2);
  assert.ok(wordsOnly.warnings.some((w) => /no segments/i.test(w)));
});

test("normalizeWhisperImport skips invalid segments and clamps to the duration", () => {
  const r = normalizeWhisperImport({
    segments: [
      { start: 0, end: 1, text: "ok", words: [W("ok", 0, 0.5)] },
      { start: "x", end: 2, text: "bad" },
      { start: 5, end: 5, text: "zero" },
      { start: 8, end: 30, text: "late", words: [W("late", 8, 9)] },
    ],
  }, { duration: 10 });
  assert.equal(r.stats.segments, 2);
  assert.equal(r.segments[1].end_seconds, 10); // clamped
  assert.ok(r.warnings.some((w) => /start and end/i.test(w)));
  assert.ok(r.warnings.some((w) => /zero-length/i.test(w)));
});

test("normalizeWhisperImport reports overlapping segments without deleting audio", () => {
  const r = normalizeWhisperImport({
    segments: [
      { start: 0, end: 3, text: "a", words: [W("a", 0, 2.5)] },
      { start: 2, end: 5, text: "b", words: [W("b", 2.2, 4.5)] },
    ],
  });
  assert.equal(r.segments.length, 2);
  assert.ok(r.warnings.some((w) => /overlap/i.test(w)));
});

test("normalizeWhisperImport returns ok:false (not a throw) for junk", () => {
  const r = normalizeWhisperImport({ nope: true });
  assert.equal(r.ok, false);
  assert.deepEqual(r.segments, []);
});

// ---------------------------------------------------------------------------
// alignLyricsToWhisper
// ---------------------------------------------------------------------------

test("the user's lyric text is never replaced by the transcript", () => {
  const whisper = normalizeWhisperImport({
    segments: [{ start: 0, end: 2, text: "twinkle twinkle little star", words: [W("twinkle", 0.1, 0.5), W("twinkle", 0.6, 1), W("little", 1.1, 1.5), W("star", 1.6, 2)] }],
  });
  const userLine = "Twinkle, twinkle little STAR!";
  const r = alignLyricsToWhisper([{ lyric_line_id: 1, lyric_text: userLine }], whisper);
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].lyric_text, userLine);
  assert.equal(r.lines[0].timing, "measured");
  assert.equal(r.lines[0].start_seconds, 0.1);
  assert.equal(r.lines[0].end_seconds, 2);
});

test("a repeated chorus keeps one entry per occurrence with its own window", () => {
  const whisper = normalizeWhisperImport(songWhisper(), { duration: 12.2 });
  const r = alignLyricsToWhisper(LYRICS, whisper, { duration: 12.2 });
  assert.equal(r.lines.length, 3);
  assert.equal(r.lines[0].occurrence, 1);
  assert.equal(r.lines[2].occurrence, 2);
  assert.equal(r.lines[0].start_seconds, 0.1);
  assert.equal(r.lines[2].start_seconds, 10.1);
  assert.notEqual(r.lines[0].start_seconds, r.lines[2].start_seconds);
  assert.ok(r.lines[2].end_seconds > r.lines[1].end_seconds);
});

test("a line spanning two segments takes the outer bounds", () => {
  const whisper = normalizeWhisperImport({
    segments: [
      { start: 0, end: 1.2, text: "twinkle twinkle", words: [W("twinkle", 0.1, 0.5), W("twinkle", 0.6, 1)] },
      { start: 1.2, end: 2.6, text: "little star", words: [W("little", 1.3, 1.9), W("star", 2, 2.4)] },
    ],
  });
  const r = alignLyricsToWhisper([{ lyric_line_id: 1, lyric_text: "Twinkle twinkle little star" }], whisper);
  assert.equal(r.lines[0].start_seconds, 0.1);
  assert.equal(r.lines[0].end_seconds, 2.4);
  assert.equal(r.lines[0].timing, "measured");
});

test("a line with no transcript match is kept with an estimated window", () => {
  const whisper = normalizeWhisperImport({
    segments: [{ start: 0, end: 4, text: "totally different words here", words: [W("totally", 0, 1), W("different", 1, 2), W("words", 2, 3), W("here", 3, 4)] }],
  });
  const r = alignLyricsToWhisper(LYRICS, whisper, { duration: 12 });
  assert.equal(r.lines.length, 3);
  assert.equal(r.lines[0].match, "estimated");
  assert.equal(r.lines[0].timing, "estimated");
  assert.ok(r.lines.every((l) => Number.isFinite(l.start_seconds) && Number.isFinite(l.end_seconds)));
  assert.ok(r.warnings.some((w) => /could not be matched/i.test(w)));
});

test("Hindi spelling drift still aligns (3-character stem rule)", () => {
  const whisper = normalizeWhisperImport({
    segments: [{
      start: 0, end: 3, text: "बच्चें खुश हो गए",
      words: [W("बच्चें", 0.1, 0.6), W("खुश", 0.7, 1.2), W("हो", 1.3, 1.6), W("गए", 1.7, 2.2)],
    }],
  });
  const userText = "बच्चे खुश हो गए";
  const r = alignLyricsToWhisper([{ lyric_line_id: 1, lyric_text: userText }], whisper);
  assert.equal(r.lines[0].match, "whisperx");
  assert.equal(r.lines[0].lyric_text, userText); // never the ASR spelling
  assert.equal(r.lines[0].heard_text, "बच्चें खुश हो गए");
  assert.equal(r.language, "hi");
});

test("low-confidence words flag the line without changing its text", () => {
  const whisper = normalizeWhisperImport(songWhisper(), { duration: 12.2 });
  const r = alignLyricsToWhisper(LYRICS, whisper, { duration: 12.2 });
  assert.equal(r.lines[2].low_confidence, true);
  assert.equal(r.lines[2].lyric_text, LYRICS[2].lyric_text);
});

test("alignment without any whisper data degrades to estimated windows", () => {
  const r = alignLyricsToWhisper(LYRICS, { segments: [], words: [] }, { duration: 9 });
  assert.equal(r.lines.length, 3);
  assert.ok(r.lines.every((l) => l.timing === "estimated"));
  assert.equal(r.lines[0].start_seconds, 0);
  assert.equal(r.lines[2].end_seconds, 9);
});

test("alignment refuses to invent lyrics from a transcript when the board has none", () => {
  const whisper = normalizeWhisperImport(songWhisper());
  const r = alignLyricsToWhisper([], whisper, { duration: 12 });
  assert.deepEqual(r.lines, []);
  assert.ok(r.warnings.some((w) => /never used as lyrics/i.test(w)));
});

// ---------------------------------------------------------------------------
// phrases / actions / scene map
// ---------------------------------------------------------------------------

test("buildLyricPhrases splits on punctuation and caps chunk length", () => {
  const phrases = buildLyricPhrases([
    { line_id: 1, lyric_text: "one two, three four five six seven eight", start_seconds: 0, end_seconds: 8, timing: "estimated", words: [], occurrence: 1 },
  ]);
  assert.equal(phrases[0].text, "one two,");
  assert.ok(phrases.length >= 2);
  assert.ok(phrases.every((p) => p.start_seconds <= p.end_seconds));
});

test("buildLyricActionTimeline attaches the meaning action and scene", () => {
  const lines = [{ line_id: 1, lyric_text: "बच्चे खुश हो गए", heard_text: "", start_seconds: 0, end_seconds: 3, timing: "measured", occurrence: 1 }];
  const semantics = [{ line_id: 1, line_kind: "lyric", interpretation: "the children become happy", action_plan: [{ action: "children smile and clap", grounded: true }], camera: { shot_type: "close-up" }, beats: [] }];
  const scenes = [{ scene_number: 1, duration_seconds: 3, shots: [{ shot_id: "1_a", duration_seconds: 3 }] }];
  const actions = buildLyricActionTimeline(lines, semantics, { scenes });
  assert.equal(actions[0].action, "children smile and clap");
  assert.equal(actions[0].scene_number, 1);
  assert.equal(actions[0].shot_id, "1_a");
});

test("assignLyricLinesToScenes maps windows to the scene that owns the larger share", () => {
  const scenes = [
    { scene_number: 1, duration_seconds: 5 },
    { scene_number: 2, duration_seconds: 5 },
  ];
  const map = assignLyricLinesToScenes([
    { line_id: 1, start_seconds: 0.5, end_seconds: 2 },
    { line_id: 2, start_seconds: 4.9, end_seconds: 7 },
    { line_id: 3, start_seconds: 7, end_seconds: 9 },
  ], scenes);
  assert.equal(map[0].scene_number, 1);
  assert.equal(map[1].scene_number, 2);
  assert.equal(map[2].scene_number, 2);
  // A window that straddles the cut is still owned by the larger share, but
  // the crossing is reported instead of being hidden.
  assert.deepEqual(map[0].scene_numbers, [1]);
  assert.equal(map[0].crosses_scenes, false);
  assert.deepEqual(map[1].scene_numbers, [1, 2]);
  assert.equal(map[1].crosses_scenes, true);
});

test("a line crossing two scenes is flagged on its scene_map row", () => {
  const scenes = [
    { scene_number: 1, duration_seconds: 2.5 },
    { scene_number: 2, duration_seconds: 5 },
    { scene_number: 3, duration_seconds: 4.7 },
  ];
  const t = buildLyricTimeline({
    lyrics: LYRICS,
    whisper: songWhisper(),
    duration: 12.2,
    scenes,
  });
  const crossing = t.scene_map.filter((m) => m.crosses_scenes);
  assert.ok(crossing.length > 0, "expected at least one line to straddle a cut");
  assert.ok(crossing.every((m) => m.scene_numbers.length > 1));
  // The flag is fully derived from the scene plan (recomputed on every read),
  // so it never becomes a stale import-time warning.
  const rederived = assignLyricLinesToScenes(t.lines, scenes);
  assert.deepEqual(rederived.map((m) => m.crosses_scenes), t.scene_map.map((m) => m.crosses_scenes));
});

// ---------------------------------------------------------------------------
// validation + corrections
// ---------------------------------------------------------------------------

test("validateLyricTimeline reports ordering and bounds problems", () => {
  const v = validateLyricTimeline({
    duration_seconds: 10,
    lines: [
      { line_id: 1, start_seconds: 4, end_seconds: 6, timing: "measured" },
      { line_id: 2, start_seconds: 2, end_seconds: 3, timing: "estimated" },
      { line_id: 3, start_seconds: 9, end_seconds: 20, timing: "estimated" },
      { line_id: 4, start_seconds: 5, end_seconds: 5, timing: "estimated" },
    ],
  }, { duration: 10 });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /must be after start/.test(e)));
  assert.ok(v.warnings.some((w) => /overlap/.test(w)));
  assert.ok(v.warnings.some((w) => /after the audio/.test(w)));
});

test("applyLyricCorrections is the highest authority and marks the line manual", () => {
  const base = {
    duration_seconds: 12,
    lines: [
      { line_id: 1, lyric_text: "first", start_seconds: 0, end_seconds: 2, timing: "measured", match: "whisperx", words: [] },
      { line_id: 2, lyric_text: "second", start_seconds: 2, end_seconds: 4, timing: "measured", match: "whisperx", words: [] },
    ],
    warnings: [],
  };
  const out = applyLyricCorrections(base, [
    { line_id: 1, start_seconds: 0.5, end_seconds: 2.5 },
    { line_id: 2, lyric_text: "second, corrected" },
    { line_id: 99, start_seconds: 1 },
  ]);
  assert.equal(out.lines[0].timing, "manual");
  assert.equal(out.lines[0].start_seconds, 0.5);
  assert.equal(out.lines[1].lyric_text, "second, corrected");
  assert.equal(out.lines[1].edited, true);
  assert.ok(out.warnings.some((w) => /unknown line/i.test(w)));
  // the original object is not mutated
  assert.equal(base.lines[0].start_seconds, 0);
});

test("applyLyricCorrections recomputes the line stats (a manual window is neither measured nor estimated)", () => {
  const base = {
    stats: { segments: 4, words: 14, lines: 2, measured: 2, estimated: 0, matched: 2 },
    lines: [
      { line_id: 1, lyric_text: "first", start_seconds: 0, end_seconds: 2, timing: "measured", match: "whisperx", words: [] },
      { line_id: 2, lyric_text: "second", start_seconds: 2, end_seconds: 4, timing: "measured", match: "whisperx", words: [] },
    ],
    warnings: [],
  };
  const out = applyLyricCorrections(base, [{ line_id: 1, start_seconds: 0.5, end_seconds: 2.5 }]);
  assert.equal(out.stats.measured, 1);
  assert.equal(out.stats.manual, 1);
  assert.equal(out.stats.estimated, 0);
  assert.equal(out.stats.matched, 1);
  assert.equal(out.stats.words, 14, "whisper stats survive the correction");
});

test("a re-import keeps the user's manual corrections (they outrank the transcript)", () => {
  const first = applyLyricCorrections(
    { duration_seconds: 12.2, lines: alignLyricsToWhisper(LYRICS, normalizeWhisperImport(songWhisper(), { duration: 12.2 }), { duration: 12.2 }).lines, warnings: [] },
    [
      { line_id: 2, start_seconds: 1.5, end_seconds: 3.5 },
      { line_id: 3, lyric_text: "Twinkle twinkle little star (my line)" },
    ],
  );
  const reimported = buildLyricTimeline({
    lyrics: LYRICS,
    whisper: songWhisper(),
    duration: 12.2,
    previous: first,
  });
  const two = reimported.lines.find((l) => l.line_id === 2);
  const three = reimported.lines.find((l) => l.line_id === 3);
  assert.equal(two.start_seconds, 1.5);
  assert.equal(two.end_seconds, 3.5);
  assert.equal(two.timing, "manual");
  assert.equal(three.lyric_text, "Twinkle twinkle little star (my line)");
  assert.equal(three.manual, true);
  assert.ok(reimported.warnings.some((w) => /manual correction/i.test(w)));
  assert.equal(reimported.validation.ok, true);
});

test("a re-import without manual corrections keeps the fresh transcript timing", () => {
  const first = buildLyricTimeline({ lyrics: LYRICS, whisper: songWhisper(), duration: 12.2 });
  const again = buildLyricTimeline({ lyrics: LYRICS, whisper: songWhisper(), duration: 12.2, previous: first });
  assert.equal(again.lines.filter((l) => l.manual).length, 0);
  assert.equal(again.lines[0].start_seconds, 0.1);
  assert.ok(!again.warnings.some((w) => /manual correction/i.test(w)));
});

// ---------------------------------------------------------------------------
// end-to-end
// ---------------------------------------------------------------------------

test("buildLyricTimeline wires normalization, alignment, actions and validation", () => {
  const out = buildLyricTimeline({
    lyrics: LYRICS,
    whisper: songWhisper(),
    duration: 12.2,
    language: "en",
    semantics: [],
    scenes: [{ scene_number: 1, duration_seconds: 12.2 }],
  });
  assert.equal(out.schema_version, 1);
  assert.equal(out.language, "en");
  assert.equal(out.lines.length, 3);
  assert.equal(out.phrases.length >= 3, true);
  assert.equal(out.actions.length, 3);
  assert.equal(out.scene_map.length, 3);
  assert.equal(out.stats.segments, 4);
  assert.equal(out.validation.ok, true);
  assert.ok(out.whisper.gaps.length >= 1);
  // every line keeps the user's text
  for (const [i, line] of out.lines.entries()) {
    assert.equal(line.lyric_text, LYRICS[i].lyric_text);
  }
});

test("buildLyricTimeline is deterministic for the same input", () => {
  const a = buildLyricTimeline({ lyrics: LYRICS, whisper: songWhisper(), duration: 12.2 });
  const b = buildLyricTimeline({ lyrics: LYRICS, whisper: songWhisper(), duration: 12.2 });
  assert.deepEqual(a.lines.map((l) => [l.line_id, l.start_seconds, l.end_seconds]), b.lines.map((l) => [l.line_id, l.start_seconds, l.end_seconds]));
});
