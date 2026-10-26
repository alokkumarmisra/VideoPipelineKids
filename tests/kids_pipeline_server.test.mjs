// Static wiring tests for the Sanskriti Kids production studio.
// Run: node --test tests/kids_pipeline_server.test.mjs (from the repo root)
//
// The studio is a PROJECT LAYER on the existing engines: these tests pin the
// routes, the schema, the shared helpers it must reuse, and the rules that
// must never regress (no fake success, no second LLM client, no second
// audio analyzer, no destructive renames).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KIDS_SCHEMA, KIDS_SQLITE_SCHEMA } from "../lib/kids.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "frontend", "server.mjs"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "frontend", "src", "App.tsx"), "utf8");
const pageSrc = fs.readFileSync(path.join(ROOT, "frontend", "src", "components", "SanskritiKidsPage.tsx"), "utf8");
const panelsSrc = fs.readFileSync(path.join(ROOT, "frontend", "src", "components", "KidsStudioPanels.tsx"), "utf8");
const apiSrc = fs.readFileSync(path.join(ROOT, "frontend", "src", "kidsApi.ts"), "utf8");

describe("kids studio routes (static)", () => {
  const routes = [
    ["/api/kids/pipeline", "the 16-stage pipeline catalog"],
    ["/api/kids/library", "the reusable asset library"],
    ["/api/kids/projects/", "the project workflows"],
  ];
  for (const [route, label] of routes) {
    it(`server exposes ${route} (${label})`, () => {
      assert.ok(serverSrc.includes(`"${route}"`), `${route} missing`);
    });
  }
  for (const [verb, path_] of [
    ["POST", 'rest === "story"'], ["PUT", 'rest === "story"'], ["POST", 'rest === "story/approve"'],
    ["POST", 'rest === "lyrics"'], ["POST", 'rest === "audio-analysis"'], ["GET", 'rest === "timeline"'],
    ["PUT", 'rest === "timeline"'], ["POST", 'rest === "timeline/build"'], ["POST", 'rest === "qc"'],
    ["POST", 'rest === "export"'], ["GET", 'rest === "feedback"'], ["POST", 'rest === "feedback"'],
    ["GET", 'rest === "pipeline"'], ["POST", 'rest === "pipeline"'],
  ]) {
    it(`server registers ${verb} ${path_}`, () => {
      assert.ok(serverSrc.includes(path_), `${path_} missing`);
    });
  }
  it("the library reference still + the job list are routed", () => {
    assert.ok(serverSrc.includes('"/api/kids/library"'), "the library route is missing");
    assert.ok(serverSrc.includes('segs[5] === "generate"'), "the reference generation route is missing");
    assert.ok(serverSrc.includes('segs[5] === "files"'), "the library files route is missing");
    assert.ok(serverSrc.includes('p === "/api/kids/jobs"'), "the studio jobs route is missing");
  });
  it("the reference still is rendered by the KIDS script (the shared analyzer stays untouched)", () => {
    assert.ok(serverSrc.includes("scripts/kids_reference.mjs"), "the kids reference script is not used");
    assert.ok(fs.existsSync(path.join(ROOT, "scripts", "kids_reference.mjs")), "the kids reference script is missing");
  });
  it("the library files are served from the kids folder only", () => {
    assert.ok(serverSrc.includes("function serveKids("), "the kids file route is missing");
    assert.ok(serverSrc.includes('p.startsWith("/kids/")'), "the kids file route is missing");
    assert.ok(serverSrc.includes('p.startsWith("/kids/")) && !authedUser(req)'), "the kids files must be behind the auth gate");
  });
  it("the api routes stay behind the auth gate", () => {
    assert.ok(serverSrc.includes('p.startsWith("/api/")'), "the api auth gate is missing");
  });
});

describe("the studio reuses the existing engines", () => {
  it("the story uses the SHARED llm helper (never a second client)", () => {
    assert.ok(serverSrc.includes("llmChatJsonLive"), "the shared streamed LLM helper is not used");
    assert.ok(serverSrc.includes("buildKidsStoryPrompt"), "the story prompt builder is not used");
  });
  it("the audio analysis uses the SHARED song analyzer (never a second one)", () => {
    assert.ok(serverSrc.includes("analyzeSongAudio"), "the shared song analyzer is not used");
    // The Director route must call the same helper.
    assert.ok(serverSrc.includes("const result = await analyzeSongAudio(body);"),
      "the Director route does not share the analyzer");
  });
  it("the studio never statically imports lib/comfy (process.exit risk)", () => {
    assert.ok(!/^import .* from "\.\.\/lib\/comfy\.mjs";?$/m.test(serverSrc),
      "server must not statically import lib/comfy");
  });
  it("the generation stages are delegated to the shared engines, never faked", () => {
    assert.ok(serverSrc.includes('status: "delegated"'), "the delegated stage marker is missing");
  });
  it("the storyboard keeps all-clip negatives per board (no kids default override)", () => {
    assert.ok(!serverSrc.includes("KIDS_LTX_NEGATIVE"), "the kids negative override is still present");
  });
  it("the kids cast keeps one voice per character (the library decides)", () => {
    assert.ok(serverSrc.includes("buildKidsVoiceMap"), "the kids voice map is not used");
  });
  it("the timeline follows the RENDERED storyboard (the linked Director board)", () => {
    assert.ok(serverSrc.includes("readDirectorBoard(project.board_id)"), "the timeline does not follow the board");
  });
});

describe("the kids schema carries the studio tables", () => {
  for (const table of [
    "kids_projects", "kids_director_plans", "kids_scenes", "kids_characters", "kids_assets",
    "kids_jobs", "kids_options", "kids_story_versions", "kids_library_assets",
    "kids_lyric_sections", "kids_audio_segments", "kids_timeline_rows",
    "kids_qc_runs", "kids_exports", "kids_feedback", "kids_library_files",
  ]) {
    it(`schema creates ${table}`, () => {
      assert.ok(KIDS_SCHEMA.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `${table} missing in the pg schema`);
      assert.ok(KIDS_SQLITE_SCHEMA.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `${table} missing in the sqlite schema`);
    });
  }
  it("the story versions are unique per project (never overwritten)", () => {
    assert.ok(KIDS_SCHEMA.includes("UNIQUE (project_id, version)"), "the story version uniqueness is missing");
  });
  it("the library row is unique per scope + kind + key", () => {
    assert.ok(KIDS_SCHEMA.includes("UNIQUE (scope, kind, asset_key)"), "the library uniqueness is missing");
  });
  it("the sqlite fallback migrates the columns an old file is missing", () => {
    assert.ok(serverSrc.includes("ALTER TABLE ${table} ADD COLUMN"), "the sqlite column migration is missing");
  });
  it("the studio never renames or drops the existing tables", () => {
    assert.ok(!/DROP TABLE (IF EXISTS )?kids_/i.test(serverSrc), "a kids table is dropped");
    assert.ok(!/ALTER TABLE kids_\w+ RENAME/i.test(serverSrc), "a kids table is renamed");
  });
});

describe("the frontend is wired to the studio", () => {
  it("the sidenav calls the module Sanskriti Kids", () => {
    assert.ok(appSrc.includes("Sanskriti Kids"), "the module label is missing");
    assert.ok(!/>Kids Director</.test(appSrc), "the old 'Kids Director' nav label is still there");
    assert.ok(appSrc.includes("nav-sanskriti-kids"), "the kids nav entry is missing");
  });
  it("the kids workflows are seeded from the studio brief (no lock)", () => {
    assert.ok(!pageSrc.includes("kidsOnly"), "the studio still locks the story workflow to Kids");
    assert.ok(appSrc.includes("KidsDirectorPage"), "the kids director page is not embedded");
    const kidsPage = fs.readFileSync(path.join(ROOT, "frontend", "src", "components", "KidsDirectorPage.tsx"), "utf8");
    assert.ok(kidsPage.includes('const GENRES = ["Kids"'), "the kids director genre select lost its options");
    assert.ok(!kidsPage.includes("KIDS_GENRES"), "the kids director genre select is still pinned");
  });
  it("the studio page exposes every workflow tab", () => {
    for (const tab of ["pipeline", "story_studio", "song_studio", "audio_studio", "library", "storyboard", "qc", "feedback"]) {
      assert.ok(pageSrc.includes(`"${tab}"`), `the ${tab} tab is missing`);
    }
  });
  it("the panels call the real API (no fake progress)", () => {
    for (const call of [
      "kidsPipeline", "kidsRunPipeline", "kidsStory", "kidsGenerateStory", "kidsApproveStory",
      "kidsAnalyzeLyrics", "kidsRunAudioAnalysis", "kidsTimeline", "kidsBuildTimeline",
      "kidsSaveTimeline", "kidsLibrary", "kidsCreateLibraryAsset", "kidsRunQc",
      "kidsRecordExport", "kidsSaveFeedback", "kidsGenerateReference", "kidsJobs",
    ]) {
      assert.ok(panelsSrc.includes(call), `${call} is not used`);
      assert.ok(apiSrc.includes(call), `${call} is not in the api client`);
    }
  });
  it("the api client points at the /api/kids routes", () => {
    assert.ok(apiSrc.includes("/api/kids/pipeline"), "the pipeline route is missing in the client");
    assert.ok(apiSrc.includes("/api/kids/library"), "the library route is missing in the client");
  });
});
