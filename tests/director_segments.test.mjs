import assert from "node:assert/strict";
import { test } from "node:test";
import { directorSegmentsToSrt, splitWhisperTranscript, validateDirectorSegments } from "../lib/director_segments.mjs";

const sample = {
  text: "We sing this beautiful song, all day long.",
  segments: [{
    start: 0, end: 6.6,
    text: "We sing this beautiful song, all day long.",
    words: [
      ["We", 0, 0.35], [" sing", 0.4, 0.8], [" this", 0.82, 1.05], [" beautiful", 1.08, 1.7],
      [" song,", 1.75, 2.15], [" all", 3.1, 3.35], [" day", 3.4, 3.8], [" long.", 3.85, 4.4],
    ].map(([word, start, end], word_index) => ({ word, start, end, score: 0.98, word_index })),
  }],
};

test("splits at a meaningful pause, keeps original text and word timing, and validates durations", () => {
  const plan = splitWhisperTranscript(sample);
  assert.equal(plan.text_preserved, true);
  assert.equal(plan.transcript, sample.text);
  assert.equal(plan.segments.length, 2);
  assert.equal(plan.segments[0].cut_note, "cut at 0.95s pause");
  assert.equal(plan.segments.map((s) => s.text).join(""), sample.text);
  for (const s of plan.segments) {
    assert.equal(Number((s.end_seconds - s.start_seconds).toFixed(3)), s.duration_seconds);
    assert.equal(s.words.every((w) => w.segment_id === s.segment_id), true);
    assert.equal(s.words.every((w) => Number.isFinite(w.start) && Number.isFinite(w.end)), true);
  }
  assert.deepEqual(validateDirectorSegments(plan.segments), { ok: true, errors: [], segment_count: 2 });
});

test("exports SRT from the same JSON segments and timestamps", () => {
  const plan = splitWhisperTranscript(sample);
  const parsedJson = JSON.parse(JSON.stringify(plan));
  assert.deepEqual(parsedJson.segments, plan.segments);
  const srt = directorSegmentsToSrt(plan.segments);
  const blocks = srt.trimEnd().split(/\r?\n\r?\n/);
  assert.equal(blocks.length, parsedJson.segments.length);
  for (const [i, block] of blocks.entries()) {
    const lines = block.split(/\r?\n/);
    const segment = parsedJson.segments[i];
    assert.equal(lines[0], String(i + 1));
    const stamp = (value) => {
      const ms = Math.round(value * 1000);
      const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, r = ms % 1000;
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(r).padStart(3, "0")}`;
    };
    assert.equal(lines[1], `${stamp(segment.start_seconds)} --> ${stamp(segment.end_seconds)}`);
    assert.equal(lines.slice(2).join("\n"), segment.text);
  }
});

test("merges overlapping adjacent words so exported segments never overlap", () => {
  const plan = splitWhisperTranscript({ segments: [
    { start: 0, end: 2, text: "one two", words: [{ word: "one", start: 0, end: 1.2 }, { word: " two", start: 1, end: 1.5 }] },
    { start: 1.4, end: 3, text: "three", words: [{ word: "three", start: 1.4, end: 2 }] },
  ] });
  assert.equal(plan.segments.length, 1);
  assert.equal(validateDirectorSegments(plan.segments).ok, true);
});
