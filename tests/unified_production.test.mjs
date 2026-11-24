import test from "node:test";
import assert from "node:assert/strict";
import { buildMasterClock, normalizeTimeRange, quantizeToFrame, validateMasterClock } from "../lib/master_clock.mjs";
import { buildUnifiedTimeline, validateUnifiedTimeline, freezeTimeline, ALL_TIMELINE_TRACKS } from "../lib/studio_engines.mjs";
import { buildDurationPacingBlueprint, validateDurationBlueprint, generationClipsForShot } from "../lib/durationPacing.mjs";
import { resolveProductionMode, canRunDirector, buildDirectorInputSnapshot, isSnapshotStale } from "../lib/production_modes.mjs";

test("master clock is the single authority: clamps + frame-quantizes", () => {
  const clock = buildMasterClock(240, { frameRate: 30, sampleRateHz: 48000 });
  assert.equal(clock.durationMs, 240000);
  assert.equal(clock.totalFrames, 7200);
  assert.deepEqual(validateMasterClock(clock), []);
  const t = normalizeTimeRange({ startMs: -500, endMs: 9999999 }, clock);
  assert.equal(t.startMs, 0);
  assert.equal(t.endMs, 240000);
  assert.equal(t.startMs, quantizeToFrame(t.startMs, 30));
});

test("19-track builder covers all tracks, clamps to WAV, Part 12.3 instrumental guard", () => {
  const tl = buildUnifiedTimeline({
    productionId: "p1",
    audioAsset: { id: "a1", originalFilename: "song.wav", durationSec: 60 },
    musicSections: [{ id: "m1", label: "instrumental intro", startMs: 0, endMs: 10000 }],
    lyricLines: [{ id: "l1", text: "hello world", startMs: 10000, endMs: 15000, words: [{ text: "hello", startMs: 10000, endMs: 12000 }] }],
  });
  assert.deepEqual(Object.keys(tl.tracks).sort(), [...ALL_TIMELINE_TRACKS].sort());
  assert.equal(tl.masterDurationMs, 60000);
  assert.equal(tl.tracks.original_audio[0].endMs, 60000);
  assert.ok(validateUnifiedTimeline(tl).errors.length === 0);
  // lip-sync injected into an instrumental interval must fail validation
  const bad = JSON.parse(JSON.stringify(tl));
  bad.tracks.lip_sync.push({ id: "lip-1", trackId: "lip_sync", startMs: 1000, endMs: 2000 });
  assert.match(validateUnifiedTimeline(bad).errors.join(" "), /instrumental/);
  const handoff = freezeTimeline(tl, { status: "approved" });
  assert.equal(handoff.approvalStatus, "approved");
});

test("audio-driven pacing: exact sum, variable scenes, shots tile scenes", () => {
  const tl = buildUnifiedTimeline({
    productionId: "p2",
    audioAsset: { id: "a2", durationSec: 30 },
    musicSections: [
      { label: "intro", startMs: 0, endMs: 5000 },
      { label: "verse", startMs: 5000, endMs: 20000 },
      { label: "chorus", startMs: 20000, endMs: 30000 },
    ],
    lyricLines: [{ text: "line one here", startMs: 6000, endMs: 9000 }],
  });
  const bp = buildDurationPacingBlueprint({ productionMode: "audio_driven", productionId: "p2", audioDurationMs: 30000, timeline: tl });
  assert.equal(bp.totalTargetDurationMs, 30000);
  assert.equal(bp.durationSource, "master_audio");
  assert.deepEqual(bp.validation.errors, []);
  const sum = bp.scenes.reduce((n, s) => n + s.durationMs, 0);
  assert.equal(sum, 30000);
  // shots tile each scene; generation clips tile each shot in 3-5s windows
  for (const s of bp.scenes) {
    assert.equal(s.shots.reduce((n, sh) => n + sh.durationMs, 0), s.durationMs);
    for (const sh of s.shots) {
      const clips = generationClipsForShot(sh);
      assert.equal(clips.reduce((n, c) => n + c.durationMs, 0), sh.durationMs);
      for (const c of clips.slice(0, -1)) assert.ok(c.durationMs <= 5000);
    }
  }
});

test("story-only pacing: AI estimate + user override, no audio required", () => {
  const est = buildDurationPacingBlueprint({
    productionMode: "story_only", productionId: "p3",
    narrativeEvents: [{ id: "n1", text: "a brave rabbit hops through the forest" }, { id: "n2", text: "meets lion" }],
  });
  assert.equal(est.durationSource, "ai_story_estimate");
  assert.ok(est.totalTargetDurationMs >= 20000);
  assert.deepEqual(est.validation.errors, []);
  const over = buildDurationPacingBlueprint({ productionMode: "story_only", productionId: "p3", userOverrideMs: 45000, narrativeEvents: [{ text: "a" }] });
  assert.equal(over.totalTargetDurationMs, 45000);
  assert.equal(over.durationSource, "user_override");
});

test("generation clips tile without short tails (6s shot becomes 3+3s)", () => {
  const clips = generationClipsForShot({ shotId: "s1-shot-1", startMs: 0, endMs: 6000 });
  assert.equal(clips.reduce((n, c) => n + c.durationMs, 0), 6000);
  for (const c of clips) assert.ok(c.durationMs >= 2900 && c.durationMs <= 5000, `clip ${c.durationMs}ms out of range`);
  const long = generationClipsForShot({ shotId: "s2-shot-1", startMs: 0, endMs: 11000 });
  assert.equal(long.reduce((n, c) => n + c.durationMs, 0), 11000);
  for (const c of long) assert.ok(c.durationMs <= 5000);
});

test("production modes gate the Director and snapshots detect staleness", () => {
  assert.equal(resolveProductionMode({ audioAsset: { durationSec: 10 } }), "audio_driven");
  assert.equal(resolveProductionMode({}), "story_only");
  assert.equal(canRunDirector({ productionMode: "story_only" }).ok, true);
  const blocked = canRunDirector({ productionMode: "audio_driven", timelineApprovalStatus: "pending" });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.blockers.join(" ").match(/timeline/i));
  const snap = buildDirectorInputSnapshot({ productionId: "p1", productionMode: "audio_driven", masterTimelineVersion: 3 });
  assert.equal(isSnapshotStale(snap, { masterTimelineVersion: 3 }).stale, false);
  assert.equal(isSnapshotStale(snap, { masterTimelineVersion: 4 }).stale, true);
});
