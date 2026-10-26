import test from "node:test";
import assert from "node:assert/strict";
import { buildAudioTimeline, syncAudioTimelineToScenes, validateAudioTimeline } from "../lib/audio_timeline.mjs";

test("audio timeline covers exact source duration and exposes honest analysis-only gaps", () => {
  const board = {
    input: { song: { fileName: "song.wav", durationSeconds: 12 }, targetSeconds: 12,
      songAnalysis: { transcript: { segments: [{ start: 2, end: 4, text: "hello" }] }, measured: { signal: { bpm: 120, beatTimes: [2, 2.5, 3] } } } },
    scenes: [],
  };
  const timeline = buildAudioTimeline(board);
  assert.equal(timeline.shots[0].start_seconds, 0);
  assert.equal(timeline.shots.at(-1).end_seconds, 12);
  assert.ok(timeline.shots.some(s => s.lyrics_or_dialogue === "hello" && s.audio_type === "vocal"));
  assert.deepEqual(validateAudioTimeline(timeline, 12), []);
  assert.ok(timeline.warnings.some(w => /diarization/i.test(w)));
});

test("planned scene shots are represented with existing prompts and mapped characters", () => {
  const timeline = buildAudioTimeline({
    input: { song: { fileName: "song.mp3", durationSeconds: 4 }, targetSeconds: 4 },
    scenes: [{ scene_number: 1, duration_seconds: 4, characters: ["CHAR_1"], action: "wave", image_prompt: "child waving", video_prompt: "arm waves", shots: [] }],
  });
  const shot = timeline.shots[0];
  assert.deepEqual(shot.character_ids, ["CHAR_1"]);
  assert.equal(shot.action, "wave");
  assert.equal(shot.image_generation_prompt, "child waving");
  assert.equal(shot.video_motion_prompt, "arm waves");
  assert.equal(shot.end_seconds, 4);
  assert.equal(shot.source_scene_number, 1);
  assert.equal(shot.source_shot_index, null);
});

test("source length retains sub-second precision and phrase splits have stable unique IDs", () => {
  const timeline = buildAudioTimeline({
    input: { song: { fileName: "song.wav", durationSeconds: 6.137 }, targetSeconds: 6.137,
      songAnalysis: { transcript: { segments: [{ start: 2, end: 5, text: "one phrase" }] } } },
    scenes: [{ scene_number: 1, song_start_time: 3, song_end_time: 4, duration_seconds: 1, action: "scene action" }],
  });
  assert.equal(timeline.shots.at(-1).end_seconds, 6.137);
  assert.equal(new Set(timeline.shots.map(s => s.shot_id)).size, timeline.shots.length);
  assert.ok(timeline.shots.some(s => s.source_scene_number === 1));
  assert.deepEqual(validateAudioTimeline(timeline, 6.137), []);
});

test("timeline validator rejects gaps/overlaps and a wrong ending", () => {
  const timeline = { shots: [{ start_seconds: 0, end_seconds: 2 }, { start_seconds: 3, end_seconds: 5 }] };
  assert.match(validateAudioTimeline(timeline, 5).join(" "), /gap or overlap/);
  assert.match(validateAudioTimeline({ shots: [{ start_seconds: 0, end_seconds: 6.14 }] }, 6.137).join(" "), /expected 6.137s/);
});

test("a transcript phrase split around a planned scene gets unique shot IDs", () => {
  const timeline = buildAudioTimeline({
    input: { song: { fileName: "song.wav", durationSeconds: 6 }, targetSeconds: 6,
      songAnalysis: { transcript: { segments: [{ start: 2, end: 5, text: "one phrase" }] } } },
    scenes: [{ scene_number: 1, song_start_time: 3, song_end_time: 4, duration_seconds: 1, action: "scene action" }],
  });
  const ids = timeline.shots.map(s => s.shot_id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(validateAudioTimeline(timeline, 6), []);
});

test("saving a one-to-one timeline edit syncs timing and visuals to its storyboard scene", () => {
  const scenes = [{ scene_number: 1, duration_seconds: 5, action: "old", image_prompt: "old image", video_prompt: "old motion" }];
  const timeline = buildAudioTimeline({ input: { song: { durationSeconds: 5 } }, scenes });
  timeline.shots[0].action = "dog dances";
  timeline.shots[0].image_generation_prompt = "same dog dancing in garden";
  timeline.shots[0].video_motion_prompt = "tail wags; camera pushes in";
  const result = syncAudioTimelineToScenes(scenes, timeline, { shotFloor: 1.5, sceneFloor: 4 });
  assert.equal(result.synced, true);
  assert.equal(scenes[0].action, "dog dances");
  assert.equal(scenes[0].image_prompt, "same dog dancing in garden");
  assert.equal(scenes[0].song_end_time, 5);
});

test("analysis-only intervals are never falsely reported as storyboard-synced", () => {
  const scenes = [{ scene_number: 1, duration_seconds: 4 }];
  const timeline = buildAudioTimeline({ input: { song: { durationSeconds: 6 } }, scenes });
  assert.equal(syncAudioTimelineToScenes(scenes, timeline).synced, false);
});
