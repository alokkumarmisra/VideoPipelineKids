// Tests for the pure 19-track timeline VIEW adapter + UI wiring.
// The adapter only maps the real MasterTimelineResponse; it never analyzes
// audio, fabricates events, or mutates the approved timeline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  TIMELINE_VIEW_TRACKS, buildTimelineView, buildRulerTicks, formatTimecode,
  timelineTickStep, visibleEvents,
} from "../lib/timeline_view.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

const word = (w, i, start, end) => ({ word_index: i, word: w, start_seconds: start, end_seconds: end, confidence: 0.9, timing: "measured" });
const fixture = () => ({
  board_id: "b1",
  duration_seconds: 446.8,
  whisperx_audio_url: "/api/director/boards/b1/audio-file",
  timeline: {
    schema_version: 3,
    duration_seconds: 446.8,
    lines: [
      {
        line_id: 9, lyric_text: "हो जाता है", start_seconds: 10, end_seconds: 14,
        timing: "estimated", match: "estimated", language: "hi", occurrence: 1, confidence: 0.5,
        words: [word("हो", 0, 10, 11), word("जाता", 1, 11, 13)],
      },
      {
        line_id: 10, lyric_text: "next line", start_seconds: 20, end_seconds: 24,
        timing: "manual", match: "manual", language: "en", occurrence: 1, confidence: null,
        words: [word("next", 0, 20, 21)],
      },
      { line_id: 11, lyric_text: "no window", start_seconds: null, end_seconds: null, words: [], occurrence: 1 },
    ],
    actions: [{
      line_id: 9, lyric: "हो जाता है", meaning: "becomes", action: "puppy wags tail",
      start_seconds: 12, end_seconds: 13, grounded: true, scene_number: 2, shot_id: "s2-a",
    }],
    scene_map: [
      { line_id: 9, start_seconds: 10, end_seconds: 18, scene_number: 1, shot_id: "s1-a" },
      { line_id: 10, start_seconds: 18, end_seconds: 26, scene_number: 2, shot_id: "s2-a" },
    ],
  },
  master: {
    schema_version: 3, duration_seconds: 446.8, approved: "2026-11-24T10:00:00Z",
    segments: [
      {
        segment_id: "seg1", type: "instrumental", start_seconds: 0, end_seconds: 8,
        lyric_text: "", heard_text: "", words: [], speaker: "", character_id: "", action: "",
        expression: "", camera: null, timing_source: "measured", confidence: 0.9,
      },
      {
        segment_id: "seg2", type: "singing", start_seconds: 10, end_seconds: 14,
        lyric_text: "हो जाता है", heard_text: "ho jata hai",
        words: [word("हो", 0, 10, 11), word("जाता", 1, 11, 13)],
        speaker: "Minku", character_id: "char_minku", action: "wags tail", expression: "joyful",
        camera: { shot_type: "Close Up", angle: "frontal", movement: "static", rationale: "emotion" },
        timing_source: "measured", confidence: 0.8,
      },
      {
        segment_id: "seg3", type: "dialogue", start_seconds: 20, end_seconds: 24,
        lyric_text: "next line", heard_text: "next line", words: [word("next", 0, 20, 21)],
        speaker: "Minku", character_id: "char_minku", action: "", expression: "",
        camera: null, timing_source: "measured", confidence: 0.95,
      },
      { segment_id: "seg4", type: "unknown", start_seconds: 440, end_seconds: 460, words: [], speaker: "", character_id: "", camera: null },
    ],
    clips: [
      { clip_id: "clip1", start_seconds: 0, end_seconds: 4, kind: "instrumental", segment_ids: ["seg1"] },
      { clip_id: "clip2", start_seconds: 4, end_seconds: 8, kind: "instrumental", segment_ids: ["seg1"] },
      { clip_id: "clip3", start_seconds: 10, end_seconds: 14, kind: "singing", segment_ids: ["seg2"] },
    ],
    validation: { ok: true, errors: [], warnings: ["181 of 189 lines keep an estimated window"] },
  },
});

test("all 19 canonical tracks are present in the mandated order", () => {
  assert.equal(TIMELINE_VIEW_TRACKS.length, 19);
  assert.deepEqual(TIMELINE_VIEW_TRACKS.map((t) => t.name), [
    "Original Audio", "Music Structure", "Lyrics", "Word Timings", "Speaker Events",
    "Narrative Events", "Character Appearances", "Character Actions", "Emotions",
    "Dialogue Performance", "Choreography", "Camera Direction", "Scene Timeline",
    "Shot Timeline", "Lip-Sync", "Sound Effects", "Video Assets", "Transitions", "Subtitles",
  ]);
  const view = buildTimelineView(fixture(), { hasAudio: true, audioFileName: "song.wav" });
  assert.deepEqual(view.tracks.map((t) => t.id), TIMELINE_VIEW_TRACKS.map((t) => t.id));
  assert.equal(view.tracks.length, 19);
});

test("the master duration is the authority; events clamp to it", () => {
  const view = buildTimelineView(fixture(), { duration: 12, hasAudio: true });
  assert.equal(view.duration, 446.8, "the 12s prop must not override the master clock");
  const all = view.events;
  assert.ok(all.every((e) => e.start >= 0 && e.end <= view.duration && e.end > e.start));
  const runaway = view.events.find((e) => e.id === "music_structure/seg4");
  assert.ok(runaway, "a segment crossing the audio end stays visible, clamped — not dropped");
  assert.equal(runaway.start, 440);
  assert.equal(runaway.end, 446.8);
  const audio = view.tracks.find((t) => t.id === "original_audio");
  assert.equal(audio.count, 1);
  assert.equal(audio.events[0].start, 0);
  assert.equal(audio.events[0].end, 446.8);
});

test("counts and labels come from the real rows, including empty tracks", () => {
  const view = buildTimelineView(fixture(), { hasAudio: true, audioFileName: "song.wav" });
  const count = (id) => view.tracks.find((t) => t.id === id).count;
  assert.equal(count("lyrics"), 2, "lines with no window are not fabricated");
  assert.equal(count("subtitles"), 2);
  assert.equal(count("word_timings"), 3);
  assert.equal(count("music_structure"), 4);
  assert.equal(count("speaker_events"), 2);
  assert.equal(count("dialogue_performance"), 2);
  assert.equal(count("character_appearances"), 1, "one span per distinct character");
  assert.equal(count("character_actions"), 1);
  assert.equal(count("emotions"), 1);
  assert.equal(count("camera_direction"), 1);
  assert.equal(count("lip_sync"), 3, "only word windows of vocal segments");
  assert.equal(count("narrative_events"), 1);
  assert.equal(count("scene_timeline"), 2);
  assert.equal(count("shot_timeline"), 3);
  assert.equal(count("transitions"), 2);
  for (const id of ["choreography", "sound_effects", "video_assets"]) {
    assert.equal(count(id), 0, `${id} stays an honest empty lane`);
  }
  assert.equal(view.totalEvents, view.events.length);
  assert.ok(view.events.some((e) => e.label === "हो जाता है"));
  assert.ok(view.events.some((e) => e.id === "character_actions/seg2" && e.meta.character === "char_minku"));
  assert.ok(view.events.some((e) => e.id === "narrative_events/action-9-1" && e.meta.action === "puppy wags tail"));
});

test("event ids and untouched source rows survive the mapping", () => {
  const response = fixture();
  const original = JSON.stringify(response);
  const view = buildTimelineView(response, { hasAudio: true });
  assert.equal(JSON.stringify(response), original, "the approved timeline is never mutated");
  const seg = view.events.find((e) => e.id === "camera_direction/seg2");
  assert.equal(seg.meta.raw, response.master.segments[1], "raw source object is passed through by reference");
  assert.equal(seg.meta.character, "char_minku");
  assert.equal(seg.meta.camera.shot_type, "Close Up");
  const clip = view.events.find((e) => e.id === "shot_timeline/clip3");
  assert.equal(clip.meta.raw, response.master.clips[2]);
  assert.equal(view.audioUrl, response.whisperx_audio_url);
  assert.equal(view.approved, true);
});

test("an uploaded audio with no analysis still yields 19 visible, empty lanes", () => {
  const view = buildTimelineView(null, { duration: 446.8, hasAudio: true, audioFileName: "a.wav" });
  assert.equal(view.duration, 446.8);
  assert.equal(view.tracks.length, 19);
  assert.equal(view.totalEvents, 1, "only the authoritative audio block exists");
  const withNoAudio = buildTimelineView(null, { duration: 446.8 });
  assert.equal(withNoAudio.totalEvents, 0);
});

test("timecode formatting uses HH:MM:SS.ms from the same axis", () => {
  assert.equal(formatTimecode(0), "00:00:00.000");
  assert.equal(formatTimecode(446.8), "00:07:26.800");
  assert.equal(formatTimecode(3661.005), "01:01:01.005");
  assert.equal(formatTimecode(3661.005, false), "01:01:01");
  assert.equal(formatTimecode(-3), "00:00:00.000");
});

test("ruler ticks adapt to zoom and never exceed the real duration", () => {
  const duration = 446.8;
  for (const pps of [0.5, 3, 10, 60, 400]) {
    const ticks = buildRulerTicks(duration, pps, 1000);
    assert.ok(ticks.length > 1, `ticks exist at ${pps}px/s`);
    assert.equal(ticks[0].time, 0);
    assert.ok(ticks[ticks.length - 1].time <= duration + 1e-6);
    assert.ok(ticks.some((t) => t.major), "major ticks are labelled");
    assert.ok(timelineTickStep(pps, 1000) * pps >= 70, "major spacing stays readable");
  }
  assert.ok(buildRulerTicks(duration, 10, 1000).length < buildRulerTicks(duration, 60, 1000).length + 4000);
});

test("virtualized window only selects intersecting events", () => {
  const events = buildTimelineView(fixture(), { hasAudio: true }).events;
  const windowed = visibleEvents(events, 9, 11, 0.5);
  assert.ok(windowed.length > 0);
  assert.ok(windowed.length < events.length);
  assert.ok(windowed.every((e) => e.end >= 8.5 && e.start <= 11.5));
});

test("UI wiring: DirectorPage feeds the SAME timeline object to the visual studio", () => {
  const director = read("frontend/src/components/DirectorPage.tsx");
  const panel = read("frontend/src/components/AudioIntelligencePanel.tsx");
  const studio = read("frontend/src/components/MasterTimelineStudio.tsx");
  const styles = read("frontend/src/styles.css");

  assert.ok(director.includes("setMasterTimeline(mt)"), "the response is stored in the page state");
  assert.ok((director.match(/masterTimeline=\{masterTimeline\}/g) || []).length >= 1, "the board mount gets it");
  assert.ok(panel.includes("from \"./MasterTimelineStudio\""), "the panel delegates to the visual timeline");
  assert.ok(panel.includes("masterTimeline={masterTimeline}"));
  assert.ok(studio.includes("buildTimelineView(masterTimeline"), "the studio reads only that object through the adapter");
  assert.ok(studio.includes("whisperx_audio_url"), "playback uses the original uploaded audio");
  assert.ok(studio.includes("Analyze Audio &amp; Build 19-Track Timeline"));
  assert.ok(studio.includes("Send Approved Timeline to AI Director"));
  assert.ok(studio.includes("track.color"), "events inherit their lane category colour");
  assert.ok(styles.includes(".daw-scroll") && styles.includes(".daw-ruler") && styles.includes(".daw-playhead"));
});
