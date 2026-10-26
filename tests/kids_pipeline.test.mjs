// Sanskriti Kids — the studio data layer (SQLite store) + the pure pipeline.
// Run: node --test tests/kids_pipeline.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { KIDS_SQLITE_SCHEMA } from "../lib/kids.mjs";
import {
  kidsInsertProject, kidsGetProject, kidsDeleteProject,
  kidsSaveStory, kidsGetStory, kidsListStories, kidsApproveStory,
  kidsInsertLibraryAsset, kidsListLibrary, kidsUpdateLibraryAsset, kidsDeleteLibraryAsset,
  kidsInsertLibraryFile, kidsListLibraryFiles, kidsListAllLibraryFiles,
  kidsReplaceLyricSections, kidsListLyricSections,
  kidsReplaceAudioSegments, kidsListAudioSegments,
  kidsReplaceTimeline, kidsListTimeline,
  kidsInsertQcRun, kidsListQcRuns,
  kidsInsertExport, kidsListExports,
  kidsInsertFeedback, kidsListFeedback,
} from "../lib/kids_store.mjs";
import {
  KIDS_PIPELINE_STAGES, kidsStageStatus, kidsRunnableStages, kidsPipelineOrder,
  normalizeKidsStory, validateKidsStory, isKidsStorySubstantive, buildKidsStoryPrompt,
  segmentLyrics, normalizeLyricSections, buildKidsSongPrompt,
  buildKidsAudioTimeline, buildKidsTimeline, validateKidsTimeline,
  normalizeKidsLibraryAsset, buildKidsScenePrompt, runKidsQualityChecks,
  normalizeKidsFeedback, kidsTrainingExamples, KIDS_LIBRARY_KINDS,
  kidsVoiceForCharacter, buildKidsVoiceMap, isTtsVoiceId,
} from "../lib/kids_pipeline.mjs";

const tmpDb = () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kids_store_")), "kids.sqlite");
  const db = new DatabaseSync(file);
  db.exec(KIDS_SQLITE_SCHEMA);
  return db;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------- pipeline
test("the pipeline declares the 16 production stages", () => {
  assert.equal(KIDS_PIPELINE_STAGES.length, 16);
  const ids = KIDS_PIPELINE_STAGES.map((s) => s.id);
  for (const id of ["director", "story", "song", "audio", "characters", "locations", "props",
    "storyboard", "images", "video", "voice", "assembly", "final", "assets", "qc", "feedback"]) {
    assert.ok(ids.includes(id), `${id} missing from the pipeline`);
  }
  // The dependency order is topological.
  const order = kidsPipelineOrder().map((s) => s.id);
  for (const stage of KIDS_PIPELINE_STAGES) {
    for (const dep of stage.deps) {
      assert.ok(order.indexOf(dep) < order.indexOf(stage.id), `${stage.id} must come after ${dep}`);
    }
  }
});

test("a stage is blocked until its dependency produced something", () => {
  const empty = kidsStageStatus({});
  const images = empty.find((s) => s.id === "images");
  assert.equal(images.status, "blocked");
  assert.ok(images.blocked_by.includes("storyboard"));
  // The Director has no dependency — it can start immediately.
  assert.equal(empty.find((s) => s.id === "director").status, "ready");
  // A hard dependency (the story) blocks the storyboard.
  assert.equal(empty.find((s) => s.id === "storyboard").status, "blocked");
  // The song studio only ADVISES the Director plan, so it can run on its own.
  assert.equal(empty.find((s) => s.id === "song").status, "ready");
  assert.ok(kidsRunnableStages(empty).includes("song"));
  assert.ok(!kidsRunnableStages(empty).includes("images"));
});

test("the stage status reflects the real rows", () => {
  const stages = kidsStageStatus({
    plan: { version: 1 },
    story: { version: 1 },
    scenes: [{ scene_number: 1 }],
    images: [{ kind: "image" }],
    videos: [{ kind: "clip" }],
    final: { file: "final.mp4" },
  });
  const by = (id) => stages.find((s) => s.id === id).status;
  assert.equal(by("director"), "done");
  assert.equal(by("story"), "done");
  assert.equal(by("storyboard"), "done");
  assert.equal(by("images"), "done");
  assert.equal(by("video"), "done");
  assert.equal(by("final"), "done");
  assert.equal(by("qc"), "ready");
});

// ---------------------------------------------------------------- story
test("the story document is normalized and validated", () => {
  const story = normalizeKidsStory({
    title: "A for Apple",
    characters: [{ name: "Puppy", role: "hero" }],
    scenes: [{ scene_number: 1, title: "Wake up", duration_seconds: 5, image_prompt: "a puppy wakes" }],
    safety: { age_appropriate: true },
  });
  assert.equal(story.characters[0].character_id, "puppy");
  assert.ok(isKidsStorySubstantive(story));
  const check = validateKidsStory(story);
  assert.equal(check.errors.length, 0);
  assert.ok(check.warnings.some((w) => w.includes("learning objective")));
  // A missing title is an error.
  assert.ok(validateKidsStory({ scenes: [] }).errors.length > 0);
});

test("the story prompt carries the brief and the safety rules", () => {
  const prompt = buildKidsStoryPrompt({
    title: "Counting to 5", language: "Hindi", category: "Numbers and Counting",
    age_group: "4-6 years", duration_seconds: 60, visual_style: "3D Preschool Animation",
    script: "Ek, do, teen...",
  });
  assert.ok(prompt.includes("Counting to 5"));
  assert.ok(prompt.includes("4-6 years"));
  assert.ok(prompt.includes("safety"));
  assert.ok(prompt.includes("Never include frightening"));
});

// ---------------------------------------------------------------- lyrics
test("the lyrics are segmented into labelled sections", () => {
  const sections = segmentLyrics("[Verse 1]\nEk do teen\n[Chorus]\nEk do teen\nEk do teen");
  assert.equal(sections.length, 2);
  assert.equal(sections[0].label, "verse");
  assert.equal(sections[1].label, "chorus");
  assert.ok(sections[0].estimated, "a label without a marker is an estimate");
});

test("a repeated stanza is detected as the chorus", () => {
  const sections = segmentLyrics("la la la\n\nla la la");
  assert.equal(sections.length, 2);
  assert.equal(sections[1].label, "chorus");
  assert.ok(sections[1].repeated);
});

test("the lyric sections get a timing (marked as estimated)", () => {
  const sections = normalizeLyricSections(
    [{ label: "verse", text: "aaaa" }, { label: "chorus", text: "bbbb" }],
    { totalDuration: 60 });
  assert.equal(sections[0].start_seconds, 0);
  assert.equal(sections[1].end_seconds, 60);
  assert.ok(sections.every((s) => s.estimated));
});

test("the song prompt asks for the timing and the choreography", () => {
  const prompt = buildKidsSongPrompt({ title: "Twinkle" }, { lyrics: "twinkle twinkle" });
  assert.ok(prompt.includes("choreography"));
  assert.ok(prompt.includes("lip_sync"));
});

// ---------------------------------------------------------------- audio
test("the audio timeline is gapless and honest about the silence", () => {
  const rows = buildKidsAudioTimeline(
    [{ start_seconds: 2, end_seconds: 5, type: "singing", text: "hello" }],
    { duration: 10 });
  assert.equal(rows[0].type, "silence");
  assert.equal(rows[0].start_seconds, 0);
  assert.equal(rows[0].end_seconds, 2);
  assert.equal(rows[1].type, "singing");
  assert.equal(rows[rows.length - 1].end_seconds, 10);
  let cursor = 0;
  for (const row of rows) {
    assert.ok(Math.abs(row.start_seconds - cursor) < 0.001, "the timeline must not have gaps");
    cursor = row.end_seconds;
  }
});

// ---------------------------------------------------------------- timeline
test("the timeline follows the measured audio segments", () => {
  const timeline = buildKidsTimeline({
    scenes: [{ scene_number: 1, title: "A" }, { scene_number: 2, title: "B" }],
    segments: [
      { start_seconds: 0, end_seconds: 4, type: "singing", text: "one" },
      { start_seconds: 4, end_seconds: 9, type: "singing", text: "two" },
    ],
  });
  assert.equal(timeline[0].start_seconds, 0);
  assert.equal(timeline[0].end_seconds, 4);
  assert.equal(timeline[1].end_seconds, 9);
  assert.equal(timeline[0].timing, "measured");
  assert.equal(timeline[0].text, "one");
});

test("the timeline falls back to the estimated scene durations", () => {
  const timeline = buildKidsTimeline({
    scenes: [{ scene_number: 1, duration_seconds: 5 }, { scene_number: 2, duration_seconds: 7 }],
  });
  assert.equal(timeline[0].timing, "estimated");
  assert.equal(timeline[1].start_seconds, 5);
  assert.equal(timeline[1].end_seconds, 12);
});

test("the timeline validation reports gaps and missing prompts", () => {
  const bad = validateKidsTimeline([
    { scene_number: 1, start_seconds: 0, end_seconds: 4, image_prompt: "x" },
    { scene_number: 2, start_seconds: 9, end_seconds: 12 },
  ]);
  assert.ok(bad.warnings.some((w) => w.includes("does not start where")));
  assert.ok(bad.warnings.some((w) => w.includes("no image prompt")));
  assert.ok(validateKidsTimeline([]).errors.length > 0);
});

// ---------------------------------------------------------------- library
test("a library asset keeps a stable key and a canonical prompt", () => {
  const asset = normalizeKidsLibraryAsset({
    kind: "character", name: "Puppy Mascot", category: "Educational Mascot",
    prompt: "a small golden puppy with a red bandana, 3d preschool animation",
    reference_image: "res_1.png",
  });
  assert.equal(asset.asset_key, "puppy_mascot");
  assert.equal(asset.status, "draft");
  assert.equal(asset.locked, false);
  assert.equal(normalizeKidsLibraryAsset({ kind: "nope" }, { kind: "character" }).kind, "character");
});

test("the scene prompt is composed from the CANONICAL library assets", () => {
  const characters = [{ character_id: "puppy", name: "Puppy", prompt: "golden puppy, red bandana" }];
  const locations = [{ asset_key: "garden", name: "Garden", prompt: "sunny green garden" }];
  const props = [{ asset_key: "apple", name: "Apple", prompt: "a shiny red apple" }];
  const out = buildKidsScenePrompt({
    scene: { characters: ["puppy"], location: "garden", props: ["apple"], action: "waving" },
    characters, locations, props, style: "3D Preschool Animation",
  });
  assert.ok(out.prompt.includes("golden puppy, red bandana"));
  assert.ok(out.prompt.includes("sunny green garden"));
  assert.ok(out.prompt.includes("a shiny red apple"));
  assert.deepEqual(out.characters_used, ["Puppy"]);
  assert.ok(out.used_canonical_assets);
});

// ---------------------------------------------------------------- quality
test("the quality checks report problems instead of claiming safety", () => {
  const result = runKidsQualityChecks({
    project: { lyrics: "ek do teen", aspect_ratio: "9:16", resolution: "1920x1080" },
    story: { title: "Counting", learning_objective: "count to three" },
    timeline: [{ scene_number: 1, start_seconds: 0, end_seconds: 5, characters: ["ghost"], image_prompt: "x" }],
    library: { characters: [{ character_id: "puppy" }] },
    media: { peak_volume_db: 0, audio_duration_seconds: 30 },
  });
  const ids = result.checks.map((c) => c.id);
  assert.ok(ids.includes("character_consistency"));
  assert.ok(ids.includes("export_settings"));
  assert.ok(ids.includes("duration_mismatch"));
  assert.equal(result.summary.passed, false);
  assert.ok(result.checks.some((c) => c.message.includes("human review")
    || c.message.includes("teacher") || c.suggestion.includes("teacher")));
});

test("a clean project only reports informational findings", () => {
  const result = runKidsQualityChecks({
    project: { aspect_ratio: "9:16", resolution: "1080x1920" },
    story: { title: "A", learning_objective: "count to three" },
    timeline: [{ scene_number: 1, start_seconds: 0, end_seconds: 5, characters: ["puppy"], image_prompt: "x" }],
    library: { characters: [{ character_id: "puppy" }] },
    media: { peak_volume_db: -6, audio_duration_seconds: 5 },
  });
  assert.equal(result.summary.errors, 0);
});

// ---------------------------------------------------------------- feedback
test("only an approved output may become a training example", () => {
  const rejected = normalizeKidsFeedback({ target_kind: "image", target_id: "1", verdict: "reject", use_for_training: true });
  assert.ok(rejected.errors.length > 0);
  const approved = normalizeKidsFeedback({ target_kind: "image", target_id: "1", verdict: "approve", use_for_training: true, rating: 5 });
  assert.equal(approved.errors.length, 0);
  assert.equal(approved.use_for_training, true);
  assert.equal(normalizeKidsFeedback({ target_kind: "nope", verdict: "approve" }).errors.length, 1);
  assert.equal(kidsTrainingExamples([approved]).length, 1);
});

// =====================================================================
// The kids clip negative + the kids voice map
// =====================================================================

test("a kids character gets a matching voice (never the default for a boy)", () => {
  assert.equal(kidsVoiceForCharacter("Munna", "Hindi"), "hi-IN-MadhurNeural");
  assert.equal(kidsVoiceForCharacter("Bachcho", "Hindi"), "hi-IN-MadhurNeural");
  assert.equal(kidsVoiceForCharacter("Gudi", "Hindi"), "hi-IN-SwaraNeural");
  assert.equal(kidsVoiceForCharacter("Puppy", "Hindi"), "hi-IN-SwaraNeural");
  assert.equal(kidsVoiceForCharacter("Munna", "English"), "en-IN-PrabhatNeural");
  // Every returned value is a licensed Edge-TTS voice id.
  for (const name of ["Munna", "Gudi", "Puppy", "Teacher"]) {
    assert.ok(isTtsVoiceId(kidsVoiceForCharacter(name, "Hindi")), `${name} must get a real voice id`);
  }
});

test("the voice map keeps an explicit voice id and never overwrites the user's mapping", () => {
  const map = buildKidsVoiceMap([
    { name: "Munna", voice: "" },
    { name: "Gudi", voice: "en-IN-NeerjaNeural" },
    { name: "Bachcho", voice: "" },
  ], { language: "Hindi", existing: { bachcho: "hi-IN-MadhurNeural" } });
  assert.equal(map.munna, "hi-IN-MadhurNeural");
  assert.equal(map.gudi, "en-IN-NeerjaNeural"); // the explicit id wins
  assert.equal(map.bachcho, undefined); // the user's own mapping is never overwritten
});

// =====================================================================
// The library reference still (the Flux Reference Image workflow)
// =====================================================================

test("the kids reference script passes the saved prompt verbatim", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "kids_reference.mjs"), "utf8");
  // The prompt is used as it is — no suffix is appended to it.
  assert.ok(src.includes('prompt: prompt.trim()'), "the prompt must be passed trimmed, not rewritten");
  assert.ok(!src.includes("withQualityImage"), "the kids reference must not add a quality suffix");
  assert.ok(!src.includes("QUALITY_IMAGE_SUFFIX"), "the kids reference must not add a quality suffix");
  // The Flux Reference Image workflow is the default (the graph builder only
  // replaces the prompt node).
  assert.ok(src.includes("DEFAULT_IMAGE_WORKFLOW"), "the library default workflow is missing");
  assert.ok(src.includes("buildFluxReferenceImageGraph"), "the reference-image graph is not used");
  // No negative is invented for the Flux.1-dev workflows.
  assert.ok(src.includes('wf.id === "flux_reference_image"'), "the reference-image branch is missing");
});

test("the Flux Reference Image graph changes ONLY the prompt node", async () => {
  process.env.COMFY_BASE ??= "http://localhost:1";
  const { buildFluxReferenceImageGraph } = await import("../lib/comfy.mjs");
  const prompt = "a small golden puppy with a red bandana, 3d preschool animation";
  const g = buildFluxReferenceImageGraph({ prompt });
  assert.equal(g["6"].inputs.text, prompt); // the prompt, verbatim
  assert.equal(g["33"].inputs.text, ""); // the negative stays empty
  assert.equal(g["27"].inputs.width, 1920); // the workflow's own canvas
  assert.equal(g["27"].inputs.height, 1024);
  assert.equal(g["31"].inputs.steps, 20);
  assert.equal(g["31"].inputs.cfg, 1);
  assert.equal(g["35"].inputs.guidance, 3.5);
  // Nothing else was touched: the node set is the authored one.
  assert.deepEqual(Object.keys(g).sort(), ["27", "31", "33", "35", "38", "39", "40", "6", "8", "9"]);
});

// =====================================================================
// The store (SQLite branch)
// =====================================================================
test("the store keeps the story, the library, the lyrics, the audio, the timeline, the QC runs and the feedback", async () => {
  const db = tmpDb();
  const project = await kidsInsertProject("sqlite", db, {
    id: "p1", name: "p1", title: "A for Apple", description: "", language: "Hindi",
    category: "Alphabet", age_group: "4-6 years", duration_seconds: 60, aspect_ratio: "16:9",
    resolution: "1280x720", visual_style: "3D Preschool Animation", narration_preferences: "",
    music_preferences: "", target_platform: "YouTube", lyrics: "A for Apple", script: "A for Apple",
    audio_path: "", reference_images: [], status: "draft", board_id: null, scenario_name: null,
    metadata: {},
  });
  assert.equal(project.id, "p1");
  assert.ok(await kidsGetProject("sqlite", db, "p1"));

  // Story versions
  const story = await kidsSaveStory("sqlite", db, "p1", { title: "A for Apple", scenes: [{ scene_number: 1 }] }, { status: "draft", note: "AI" });
  assert.equal(story.version, 1);
  const story2 = await kidsSaveStory("sqlite", db, "p1", { title: "A for Apple 2" }, { status: "draft" });
  assert.equal(story2.version, 2);
  assert.equal((await kidsListStories("sqlite", db, "p1")).length, 2);
  const approved = await kidsApproveStory("sqlite", db, "p1", story2.version);
  assert.equal(approved.status, "approved");
  assert.equal((await kidsGetStory("sqlite", db, "p1")).version, 2);

  // Library
  const lib = await kidsInsertLibraryAsset("sqlite", db, {
    scope: "p1", project_id: "p1", kind: "character", asset_key: "puppy", name: "Puppy",
    category: "Animal", description: "", tags: ["dog"], prompt: "golden puppy", reference_image: "",
    appearance: "", clothing: "", colors: "", personality: "", voice: "", movement: "",
    age_appearance: "", version: 1, status: "draft", locked: false, metadata: {},
  });
  assert.equal(lib.asset_key, "puppy");
  assert.deepEqual(lib.tags, ["dog"]);
  const listed = await kidsListLibrary("sqlite", db, { kind: "character" });
  assert.equal(listed.length, 1);
  const updated = await kidsUpdateLibraryAsset("sqlite", db, lib.id, { status: "approved", locked: true });
  assert.equal(updated.status, "approved");
  assert.equal(updated.locked, true);

  // The generated reference stills of a library asset.
  await kidsInsertLibraryFile("sqlite", db, {
    asset_id: lib.id, file_path: `${lib.scope}/Characters/${lib.asset_key}/reference.png`,
    kind: "image", prompt: "golden puppy, red bandana", workflow: "flux_reference_image",
    model: "flux1-dev-Q8_0.gguf", status: "COMPLETED",
  });
  const files = await kidsListLibraryFiles("sqlite", db, lib.id);
  assert.equal(files.length, 1);
  assert.equal(files[0].workflow, "flux_reference_image");
  assert.equal((await kidsListAllLibraryFiles("sqlite", db)).length, 1);

  // Lyrics
  await kidsReplaceLyricSections("sqlite", db, "p1", [
    { seq: 0, label: "verse", lines: ["A"], text: "A", start_seconds: 0, end_seconds: 3, emotion: "", character_ids: [], choreography: "", lip_sync: false, estimated: true },
  ]);
  const lyrics = await kidsListLyricSections("sqlite", db, "p1");
  assert.equal(lyrics.length, 1);
  assert.equal(lyrics[0].label, "verse");
  assert.equal(lyrics[0].estimated, true);

  // Audio segments
  await kidsReplaceAudioSegments("sqlite", db, "p1", [
    { seq: 0, start_seconds: 0, end_seconds: 4, duration_seconds: 4, type: "singing", speaker: "", text: "A for apple", emotion: "", character: "", action: "", scene: "", background: "", camera: "", music_note: "", sound_effect: "", confidence: null, estimated: false },
  ]);
  const audio = await kidsListAudioSegments("sqlite", db, "p1");
  assert.equal(audio.length, 1);
  assert.equal(audio[0].type, "singing");

  // Timeline
  await kidsReplaceTimeline("sqlite", db, "p1", [
    { scene_number: 1, payload: { scene_number: 1, start_seconds: 0, end_seconds: 4, image_prompt: "a puppy" } },
  ]);
  const timeline = await kidsListTimeline("sqlite", db, "p1");
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].payload.image_prompt, "a puppy");

  // QC + exports + feedback
  const qc = await kidsInsertQcRun("sqlite", db, "p1", { errors: 0 }, [{ id: "x" }]);
  assert.ok(qc.id > 0);
  assert.equal((await kidsListQcRuns("sqlite", db, "p1")).length, 1);
  await kidsInsertExport("sqlite", db, {
    project_id: "p1", profile: "youtube", status: "recorded", file_path: "outputs/x/final.mp4",
    duration_seconds: 12, resolution: "1280x720", notes: "",
  });
  assert.equal((await kidsListExports("sqlite", db, "p1")).length, 1);
  await kidsInsertFeedback("sqlite", db, {
    id: "fb1", project_id: "p1", target_kind: "scene", target_id: "1", rating: 5,
    verdict: "approve", note: "good", corrected_text: "", use_for_training: true, payload: {},
  });
  const feedback = await kidsListFeedback("sqlite", db, "p1");
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].use_for_training, true);

  // Deleting the project removes its children (SQLite has no FK enforcement).
  await kidsDeleteProject("sqlite", db, "p1");
  assert.equal((await kidsListLyricSections("sqlite", db, "p1")).length, 0);
  assert.equal((await kidsListTimeline("sqlite", db, "p1")).length, 0);
  assert.equal((await kidsListFeedback("sqlite", db, "p1")).length, 0);
});
