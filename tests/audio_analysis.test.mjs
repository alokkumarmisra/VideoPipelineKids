import test from "node:test";
import assert from "node:assert/strict";
import { analyzePcm } from "../lib/audio_analysis.mjs";
import { buildBiblePrompt, timeLinesFromTranscript } from "../lib/director.mjs";

test("audio analysis reports bounded seconds-based estimates and does not fabricate voice detection", () => {
  const rate = 11025;
  const pcm = new Float32Array(rate * 4);
  for (let t = 0; t < 4; t += 0.5) {
    const start = Math.floor(t * rate);
    for (let i = 0; i < 180; i++) pcm[start + i] = Math.sin(i * 0.17) * 0.7;
  }
  const result = analyzePcm(pcm, rate);
  assert.equal(result.durationSeconds, 4);
  assert.ok(result.bpm === null || (result.bpm >= 60 && result.bpm <= 180));
  assert.ok(result.beatTimes.every(t => t >= 0 && t <= 4));
  assert.equal(result.vocalActivity.status, "not_estimated");
  assert.ok(result.keyEstimate.confidence >= 0 && result.keyEstimate.confidence <= 1);
});

test("silence yields no confident beat estimate", () => {
  const result = analyzePcm(new Float32Array(11025 * 3), 11025);
  assert.equal(result.bpm, null);
  assert.equal(result.beatTimes.length, 0);
});

test("Kids song story prompt receives measured analysis as context", () => {
  const prompt = buildBiblePrompt({ title: "Rhyme", language: "Hindi", genre: "Kids", visualStyle: "Cartoon", targetSeconds: 10, story: "lyrics", song: { fileName: "rhyme.wav", durationSeconds: 10, hasLyrics: true }, songAnalysis: { mood: "gentle", measured: { signal: { bpm: 92, beatTimes: [0.1, 0.75] } } } });
  assert.match(prompt, /AUDIO ANALYSIS/);
  assert.match(prompt, /"bpm":92/);
});

test("narration audio keeps story-director framing separate from song rules", () => {
  const prompt = buildBiblePrompt({ title: "Narrated tale", language: "Hindi", genre: "Kids", visualStyle: "Cartoon", targetSeconds: 20, story: "A child finds a lost puppy and returns it home.", sourceAudio: { fileName: "narration.wav", durationSeconds: 20 }, songAnalysis: { mood: "gentle", narrationStyle: "warm" } });
  assert.match(prompt, /SOURCE AUDIO: SPOKEN NARRATION \/ DIALOGUE/);
  assert.doesNotMatch(prompt, /SOURCE: SONG \(music video/);
});

test("Whisper phrase timestamps drive matched lyric-line windows; mismatch safely falls back", () => {
  const lines = [{ lyric_line_id: 1, lyric_text: "पहली पंक्ति" }, { lyric_line_id: 2, lyric_text: "दूसरी पंक्ति" }];
  const timed = timeLinesFromTranscript(lines, [{ start: 1.25, end: 4.5 }, { start: 4.8, end: 8 }], 10);
  assert.deepEqual(timed.map(x => [x.song_start_time, x.song_end_time]), [[1.25, 4.5], [4.8, 8]]);
  assert.deepEqual(timeLinesFromTranscript(lines, [{ start: 0, end: 2 }], 10), []);
  assert.deepEqual(timeLinesFromTranscript(lines, [{ start: 0, end: 2 }, { start: 2, end: 20 }], 10), []);
});
