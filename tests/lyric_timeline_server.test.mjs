// Static wiring tests for the Story/Song lyric timeline (WhisperX import).
// Run: node --test tests/lyric_timeline_server.test.mjs (from the repo root)
//
// These pin the integration — the pure rules live in
// tests/lyric_timeline.test.mjs. What must never regress:
//   * the three board-scoped routes exist,
//   * the import stores on the board JSON (no schema migration),
//   * the scene planner prefers the reviewed timeline over the estimate,
//   * the UI exposes the Lyric tab, the WhisperX import and the correction save,
//   * the nav/breadcrumb say "Story/Song" and the view id is story_song,
//   * Create Song (the separate renderer view) is untouched.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "frontend", "server.mjs"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "frontend", "src", "App.tsx"), "utf8");
const apiSrc = fs.readFileSync(path.join(ROOT, "frontend", "src", "api.ts"), "utf8");
const storySrc = fs.readFileSync(path.join(ROOT, "frontend", "src", "components", "StoryPage.tsx"), "utf8");
const semanticsSrc = fs.readFileSync(path.join(ROOT, "lib", "semantics.mjs"), "utf8");

describe("lyric timeline routes (static)", () => {
  it("server registers the lyric-timeline read + correction routes", () => {
    assert.ok(
      serverSrc.includes("/^\\/api\\/director\\/boards\\/[^/]+\\/lyric-timeline$/"),
      "the lyric-timeline route is missing",
    );
    assert.ok(serverSrc.includes('req.method === "GET"'), "the GET branch is missing");
    assert.ok(serverSrc.includes('req.method === "PUT"'), "the PUT branch is missing");
  });

  it("server registers the WhisperX import route", () => {
    assert.ok(
      serverSrc.includes("/^\\/api\\/director\\/boards\\/[^/]+\\/whisper-import$/"),
      "the whisper-import route is missing",
    );
  });

  it("the import is board-scoped and stored on the board JSON (no schema migration)", () => {
    assert.ok(serverSrc.includes("board.lyric_timeline = timeline"), "the timeline is not stored on the board");
    assert.ok(
      !/CREATE TABLE[^`;]*lyric_timeline/i.test(serverSrc),
      "the lyric timeline must not add a table",
    );
  });

  it("the scene planner prefers the reviewed timeline over the plain estimate", () => {
    assert.ok(serverSrc.includes("board.lyric_timeline && board.lyric_timeline.lines"), "the planner ignores the timeline");
    assert.ok(serverSrc.includes("storedTiming.length"), "the planner does not branch on stored timing");
  });

  it("the planner uses the stored timeline ONLY while it covers the current lines", () => {
    assert.ok(serverSrc.includes("let storedCoversCurrent = false") && serverSrc.includes("storedCoversCurrent = storedTiming.length > 0"), "the coverage gate is missing");
    assert.ok(
      serverSrc.includes("currentLineIds.every((id) => storedTiming.some((l) => l.lyric_line_id === id))"),
      "coverage must check every current line id",
    );
    assert.ok(serverSrc.includes("if (storedCoversCurrent && storedTiming.length)"), "the planner does not honour the coverage gate");
  });

  it("staleness is computed once and reported by every lyric route", () => {
    assert.ok(serverSrc.includes("const lyricTimelineStale = (board, timeline)"), "the stale helper is missing");
    assert.ok(serverSrc.includes("const lyricTimelineSourceLines = (board)"), "the shared line source is missing");
    const reads = serverSrc.match(/stale: lyricTimelineStale\([^)]*\)/g) || [];
    assert.ok(reads.length >= 3, `expected stale on GET + import + PUT, found ${reads.length}`);
  });

  it("a re-import preserves manual corrections and the read derives the scene map", () => {
    assert.ok(serverSrc.includes("previous: board.lyric_timeline"), "the import route must pass the stored timeline");
    assert.ok(
      serverSrc.includes("scene_map: assignLyricLinesToScenes(board.lyric_timeline.lines, board.scenes || [])"),
      "the read route must recompute the scene map from the current scenes",
    );
  });

  it("the import never writes lyric text (the user's text is authoritative)", () => {
    const route = serverSrc.slice(serverSrc.indexOf("whisper-import$/"), serverSrc.indexOf("whisper-import$/") + 4000);
    assert.ok(!/\.lyric_text\s*=/.test(route), "the import route must not assign lyric text");
  });

  it("the shared pure helpers are imported (no parallel implementation)", () => {
    for (const fn of ["buildLyricTimeline", "applyLyricCorrections", "validateLyricTimeline"]) {
      assert.ok(serverSrc.includes(fn), `${fn} is not imported`);
      assert.ok(semanticsSrc.includes(`export function ${fn}`), `${fn} is not exported by lib/semantics.mjs`);
    }
  });
});

describe("master timeline routes (static)", () => {
  it("server registers the master-timeline read + approve/unlock/generate + audio routes", () => {
    for (const pat of [
      "master-timeline$/",
      "master-timeline\\/approve$",
      "master-timeline\\/unlock$",
      "master-timeline\\/generate$",
      "audio-file$",
    ]) {
      assert.ok(serverSrc.includes(pat), `route pattern missing: ${pat}`);
    }
  });

  it("the master view is derived from the lyric timeline (never a second source of truth)", () => {
    assert.ok(serverSrc.includes("masterViewForBoard"), "the derive helper is missing");
    assert.ok(serverSrc.includes("buildMasterTimeline"), "the pure builder is not wired");
    assert.ok(serverSrc.includes("master.corrections"), "the corrections list is not persisted");
  });

  it("an approved timeline refuses corrections unless explicitly unlocked (silence guard)", () => {
    assert.ok(serverSrc.includes('"this master timeline is approved — unlock it before correcting it"'), "the approval 409 is missing");
    assert.ok(serverSrc.includes("unlock: true"), "the unlock flag plumbing is missing");
  });

  it("clip generation requires the explicit approval gate first", () => {
    const route = serverSrc.slice(serverSrc.indexOf("master-timeline\\/generate$"), serverSrc.indexOf("master-timeline\\/generate$") + 3000);
    assert.ok(route.includes("approve the master timeline before generating clips"), "the approve gate is missing");
    assert.ok(route.includes("storyboardToScenario"), "generation must reuse the canonical import path");
  });

  it("the shared master helpers are imported (no parallel implementation)", () => {
    for (const fn of ["buildMasterTimeline", "planTimelineClips", "applyMasterCorrections", "approveMasterTimeline", "unlockMasterTimeline", "timelineClipsToStoryboard"]) {
      assert.ok(serverSrc.includes(fn), `${fn} is not wired in the server`);
      assert.ok(
        fs.readFileSync(path.join(ROOT, "lib", "master_timeline.mjs"), "utf8").includes(`export function ${fn}`),
        `${fn} is not exported by lib/master_timeline.mjs`,
      );
    }
  });
});

describe("master timeline client + UI (static)", () => {
  it("api.ts exposes the master calls with the correct routes", () => {
    for (const fn of ["directorMasterTimeline", "saveMasterCorrections", "approveMasterTimeline", "unlockMasterTimeline", "generateMasterTimelineClips", "directorBoardAudioUrl"]) {
      assert.ok(apiSrc.includes(`export const ${fn}`), `${fn} missing in api.ts`);
    }
    assert.ok(apiSrc.includes("/master-timeline`"), "the master-timeline path is missing");
    assert.ok(apiSrc.includes("/audio-file`"), "the audio-file path is missing");
  });

  it("the StoryPage master panel edits segments, seeks the player and gates generation", () => {
    assert.ok(storySrc.includes("fillMasterDrafts"), "the master draft filler is missing");
    assert.ok(storySrc.includes("saveMasterEdits"), "the master correction save is missing");
    assert.ok(storySrc.includes("approveMaster"), "the approve handler is missing");
    assert.ok(storySrc.includes("generateMasterClips"), "the generate handler is missing");
    assert.ok(storySrc.includes("seekMaster"), "the click-to-seek handler is missing");
    assert.ok(storySrc.includes("onAudioTime"), "the player sync is missing");
    assert.ok(storySrc.includes("Save segment corrections"), "the master save button is missing");
    assert.ok(storySrc.includes("Generate clips (3–5 s)"), "the generate button is missing");
  });
});

describe("lyric timeline client + UI (static)", () => {
  it("api.ts exposes the three calls with the correct route", () => {
    assert.ok(apiSrc.includes("export const directorLyricTimeline"), "directorLyricTimeline missing");
    assert.ok(apiSrc.includes("export const importWhisperTimeline"), "importWhisperTimeline missing");
    assert.ok(apiSrc.includes("export const saveLyricCorrections"), "saveLyricCorrections missing");
    assert.ok(apiSrc.includes("/lyric-timeline`"), "the lyric-timeline path is missing");
    assert.ok(apiSrc.includes("/whisper-import`"), "the whisper-import path is missing");
  });

  it("the StoryPage has a Lyric tab with import + review + save", () => {
    assert.ok(storySrc.includes('"lyric"'), "the lyric tab id is missing");
    assert.ok(storySrc.includes("onWhisperFile"), "the WhisperX file picker is missing");
    assert.ok(storySrc.includes("runWhisperImport"), "the import handler is missing");
    assert.ok(storySrc.includes("saveLyricEdits"), "the correction save handler is missing");
    assert.ok(storySrc.includes("Save corrections"), "the correction button is missing");
  });

  it("the panel surfaces a stale timeline instead of using old windows", () => {
    assert.ok(apiSrc.includes("stale?: boolean"), "the API type lost the stale flag");
    assert.ok(storySrc.includes("lyricStale"), "the StoryPage does not track staleness");
    assert.ok(storySrc.includes("Timeline out of date"), "the stale hint is missing");
    assert.ok(storySrc.includes("setLyricStale(!!r.stale)"), "the responses do not update staleness");
  });

  it("the nav and breadcrumb read Story/Song and the view id is story_song", () => {
    assert.ok(appSrc.includes('"story_song"'), "the story_song view id is missing");
    assert.ok(appSrc.includes("Story/Song"), "the Story/Song label is missing");
    assert.ok(!appSrc.includes('setView("story")'), "the old story view id is still set");
    assert.ok(!appSrc.includes('view === "story"'), "the old story view id is still compared");
  });

  it("Create Song stays a separate view (the rename never merges the renderers)", () => {
    assert.ok(appSrc.includes('"song"'), "the song view id is missing");
    assert.ok(appSrc.includes("<CreateSongPage"), "the Create Song page is no longer rendered");
  });
});
