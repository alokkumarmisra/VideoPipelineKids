// Sanskriti Kids Studio — unit tests for the pure helpers.
// Run: node --test tests/kids.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import {
  KIDS_OPTION_KEYS,
  KIDS_DEFAULT_OPTIONS,
  KIDS_SCHEMA,
  KIDS_SQLITE_SCHEMA,
  normalizeKidsProject,
  validateKidsProject,
  normalizeKidsDirectorPlan,
  isPlanSubstantive,
  planEditGuard,
  buildKidsPlanFromBoard,
  buildKidsDirectorPlanPrompt,
  kidsDashboardMetrics,
  kidsSlug,
  hasScript,
  directorStyleFor,
  directorLanguageFor,
  directorAspectFor,
  directorGenreFor,
} from "../lib/kids.mjs";

// ---------------------------------------------------------------- options
test("option lists cover every configurable field and have real values", () => {
  assert.deepEqual(KIDS_OPTION_KEYS, [
    "age_groups", "categories", "languages", "platforms", "resolutions", "visual_styles",
  ]);
  for (const key of KIDS_OPTION_KEYS) {
    assert.ok(Array.isArray(KIDS_DEFAULT_OPTIONS[key]), `${key} must be a list`);
    assert.ok(KIDS_DEFAULT_OPTIONS[key].length > 0, `${key} must not be empty`);
  }
  assert.ok(KIDS_DEFAULT_OPTIONS.age_groups.includes("2-4 years"));
  assert.ok(KIDS_DEFAULT_OPTIONS.categories.includes("Nursery Rhymes"));
});

test("studio values map onto Director-legal values", () => {
  assert.equal(directorStyleFor("3D Preschool Animation"), "3D Preschool Animation");
  assert.equal(directorStyleFor("2D Cartoon"), "Cartoon");
  assert.equal(directorStyleFor("Watercolor Storybook"), "Cartoon");
  assert.equal(directorStyleFor("Something Unknown"), "3D Preschool Animation");
  assert.equal(directorLanguageFor("Bilingual"), "Hinglish");
  assert.equal(directorLanguageFor("Hindi"), "Hindi");
  assert.equal(directorAspectFor("9:16"), "9:16");
  assert.equal(directorAspectFor("4:3"), "16:9");
  // Every category is a kids genre so the Director's kids rules apply.
  assert.equal(directorGenreFor("Nursery Rhymes"), "Kids");
  assert.equal(directorGenreFor("Moral Stories"), "Kids");
});

// ---------------------------------------------------------------- slug
test("project slug is filesystem safe and never empty", () => {
  assert.equal(kidsSlug("A for Apple!"), "a_for_apple");
  assert.equal(kidsSlug("  "), "kids_project");
  assert.equal(kidsSlug("बंदर और कथा"), "kids_project");
  assert.ok(!kidsSlug("../../etc/passwd").includes("/"));
});

// ---------------------------------------------------------------- project
test("normalizeKidsProject keeps the user's values and clamps the duration", () => {
  const p = normalizeKidsProject({
    title: "  A for Apple  ",
    description: "Alphabet song",
    language: "Hindi",
    category: "Alphabet and Phonics",
    age_group: "2-4 years",
    duration_seconds: 99999,
    aspect_ratio: "16:9",
    resolution: "1280x720",
    visual_style: "3D Preschool Animation",
    script: "A for Apple, B for Ball.",
  });
  assert.equal(p.title, "A for Apple");
  assert.equal(p.duration_seconds, 3600, "duration is clamped to the max");
  assert.equal(p.status, "draft");
  assert.deepEqual(p.reference_images, []);
});

test("an unknown option value is kept (the option table is user-editable)", () => {
  const p = normalizeKidsProject({
    title: "T",
    category: "A brand new category the user configured",
    age_group: "3-5 years",
  }, { options: { categories: ["Nursery Rhymes"], age_groups: ["2-4 years"] } });
  assert.equal(p.category, "A brand new category the user configured");
  assert.equal(p.age_group, "3-5 years");
});

test("validation blocks a project without a title or script", () => {
  const empty = validateKidsProject(normalizeKidsProject({}));
  assert.ok(empty.errors.some((e) => /title/i.test(e)));
  assert.ok(empty.errors.some((e) => /script|lyrics/i.test(e)));

  const good = validateKidsProject(normalizeKidsProject({
    title: "A for Apple",
    script: "A for Apple, B for Ball, C for Cat, D for Duck.",
  }));
  assert.equal(good.errors.length, 0);
});

test("validation warns (never blocks) on a long video with no age group", () => {
  const { errors, warnings } = validateKidsProject(normalizeKidsProject({
    title: "Long one",
    script: "A for Apple, B for Ball, C for Cat, D for Duck, E for Elephant.",
    duration_seconds: 900,
  }));
  assert.equal(errors.length, 0);
  assert.ok(warnings.length >= 1);
});

test("hasScript needs 20+ characters", () => {
  assert.equal(hasScript("short"), false);
  assert.equal(hasScript("A for Apple, B for Ball, C for Cat."), true);
  assert.equal(hasScript(null), false);
});

// ---------------------------------------------------------------- plan
test("the Director Plan normalizer fills every section", () => {
  const plan = normalizeKidsDirectorPlan({});
  assert.equal(plan.version, 1);
  assert.equal(plan.creative_direction, "");
  assert.deepEqual(plan.characters, []);
  assert.deepEqual(plan.scenes, []);
  assert.deepEqual(plan.camera.shot_types, []);
  assert.deepEqual(plan.audio.sound_effects, []);
  assert.deepEqual(plan.warnings, []);
  assert.equal(plan.narrative.beginning, "");
});

test("the Director Plan keeps the AI's content and trims the overflow", () => {
  const plan = normalizeKidsDirectorPlan({
    creative_direction: "warm and bright",
    objective: { kind: "education", teaching_objective: "teach the alphabet" },
    narrative: { beginning: "A", middle: "B", climax: "C", ending: "D" },
    characters: [{ character_id: "apple", name: "Apple", role: "hero" }],
    scenes: [{ scene_number: 1, title: "A for Apple", duration_seconds: 5 }],
    camera: { shot_types: ["Close-Up"], movements: ["Static"], transitions: ["Cut"] },
    audio: { background_music: "ukulele" },
    warnings: ["check the letterform"],
  });
  assert.equal(plan.creative_direction, "warm and bright");
  assert.equal(plan.objective.teaching_objective, "teach the alphabet");
  assert.equal(plan.characters[0].character_id, "apple");
  assert.equal(plan.scenes[0].duration_seconds, 5);
  assert.deepEqual(plan.camera.shot_types, ["Close-Up"]);
  assert.equal(plan.audio.background_music, "ukulele");
  assert.equal(plan.warnings.length, 1);
});

test("an empty plan is not substantive, a real one is", () => {
  assert.equal(isPlanSubstantive({}), false);
  assert.equal(isPlanSubstantive({ creative_direction: "warm" }), true);
  assert.equal(isPlanSubstantive({ scenes: [{ scene_number: 1 }] }), true);
});

test("an approved plan cannot be edited without an explicit unlock", () => {
  assert.equal(planEditGuard("draft").allowed, true);
  assert.equal(planEditGuard("approved").allowed, false);
  assert.equal(planEditGuard("approved", { unlock: true }).allowed, true);
  assert.match(planEditGuard("approved").error, /unlock/i);
});

// ---------------------------------------------------------------- board
// A real Director board (the shape lib/director.mjs produces).
const board = {
  input: { genre: "Kids", visualStyle: "3D Preschool Animation", targetSeconds: 60 },
  styleLock: "Colorful 3D preschool animation",
  blueprint: {
    analysis: {
      beginning: "Doggy wakes up", middle: "He plays", climax: "A surprise", ending: "Good night",
    },
    characters: [
      { character_id: "doggy", name: "Doggy", role: "main_character", species: "dog", appearance: { fur: "golden" }, clothing: { top: "red" }, visual_identity_prompt: "golden puppy, red collar" },
    ],
    locations: [{ location_id: "park", name: "Park" }],
    objects: [{ object_id: "ball", name: "Ball" }],
    beats: [{ n: 1, title: "Wake up" }],
  },
  scenes: [
    { scene_number: 1, title: "Wake up", story_beat: "Doggy opens his eyes", duration_seconds: 5, camera: { shot_type: "Close-Up", movement: "Static" }, transition_to_next_scene: "Dissolve", image_prompt: "a puppy waking up", characters: ["doggy"] },
    { scene_number: 2, title: "Play", story_beat: "Doggy plays with the ball", duration_seconds: 7, camera: { shot_type: "Wide Shot", movement: "Pan Right" }, transition_to_next_scene: "", image_prompt: "a puppy playing", characters: ["doggy"] },
  ],
};

test("the Director Plan is derived from the real storyboard", () => {
  const plan = buildKidsPlanFromBoard(board, {});
  assert.equal(plan.scenes.length, 2);
  assert.equal(plan.scene_count, 2);
  assert.equal(plan.approximate_duration_seconds, 12);
  assert.equal(plan.characters.length, 1);
  assert.equal(plan.characters[0].name, "Doggy");
  assert.match(plan.characters[0].usage, /scene/i);
  assert.equal(plan.narrative.beginning, "Doggy wakes up");
  assert.ok(plan.camera.shot_types.includes("Close-Up"));
  assert.ok(plan.camera.shot_types.includes("Wide Shot"));
  assert.ok(plan.camera.movements.includes("Pan Right"));
  assert.ok(plan.camera.transitions.includes("Dissolve"));
  assert.ok(plan.creative_direction.includes("3D preschool"));
});

test("the derived plan never invents a cast the bible does not have", () => {
  const plan = buildKidsPlanFromBoard(board, {});
  assert.deepEqual(plan.characters.map((c) => c.character_id), ["doggy"]);
});

test("the Director Plan prompt asks for the structured sections", () => {
  const prompt = buildKidsDirectorPlanPrompt({
    title: "A for Apple",
    language: "Hindi",
    category: "Alphabet and Phonics",
    age_group: "2-4 years",
    duration_seconds: 60,
    aspect_ratio: "16:9",
    resolution: "1280x720",
    visual_style: "3D Preschool Animation",
    target_platform: "YouTube Kids",
    script: "A for Apple, B for Ball.",
  });
  for (const key of [
    "creative_direction", "teaching_objective", "narrative", "visual_continuity",
    "scene_count", "characters", "scenes", "camera", "audio",
    "age_appropriateness", "consistency",
  ]) {
    assert.ok(prompt.includes(key), `the prompt must ask for ${key}`);
  }
  assert.ok(prompt.includes("A for Apple"));
  assert.ok(prompt.includes("2-4 years"));
});

// ---------------------------------------------------------------- metrics
test("the dashboard metrics are computed from the real rows", () => {
  const m = kidsDashboardMetrics({
    projects: [
      { status: "draft" }, { status: "planning" }, { status: "completed" }, { status: "draft" },
    ],
    scenes: [{ scene_number: 1 }, { scene_number: 2 }, { scene_number: 3 }],
    characters: [
      { visual_identity_prompt: "golden puppy" },
      { visual_identity_prompt: "" },
    ],
    assets: [
      { kind: "image", status: "COMPLETED" },
      { kind: "image", status: "COMPLETED" },
      { kind: "video", status: "COMPLETED" },
      { kind: "final", status: "COMPLETED" },
    ],
    jobs: [
      { status: "FAILED" }, { status: "PENDING" }, { status: "COMPLETED" },
    ],
  });
  assert.equal(m.totalProjects, 4);
  assert.equal(m.draftStories, 2);
  assert.equal(m.characters, 2);
  assert.equal(m.charactersWithProfile, 1);
  assert.equal(m.scenes, 3);
  assert.equal(m.imagesGenerated, 2);
  assert.equal(m.videosGenerated, 1);
  assert.equal(m.completedVideos, 2);
  assert.equal(m.inProgress, 1);
  assert.equal(m.completedProjects, 1);
  assert.equal(m.failedOrPendingJobs, 2);
  assert.equal(m.failedJobs, 1);
  assert.equal(m.totalJobs, 3);
});

test("empty inputs give zeroed metrics (never NaN)", () => {
  const m = kidsDashboardMetrics({});
  assert.equal(m.totalProjects, 0);
  assert.equal(m.imagesGenerated, 0);
  assert.equal(m.failedOrPendingJobs, 0);
});

// ---------------------------------------------------------------- schema
test("the schema creates every studio table in both backends", () => {
  for (const table of [
    "kids_projects", "kids_director_plans", "kids_scenes",
    "kids_characters", "kids_assets", "kids_jobs", "kids_options",
  ]) {
    assert.ok(KIDS_SCHEMA.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `pg schema needs ${table}`);
    assert.ok(KIDS_SQLITE_SCHEMA.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `sqlite schema needs ${table}`);
  }
  // The project id is the primary key and the name is unique (the folder).
  assert.match(KIDS_SCHEMA, /id TEXT PRIMARY KEY/);
  assert.match(KIDS_SCHEMA, /name TEXT NOT NULL UNIQUE/);
  // The plan keeps its history: one row per version.
  assert.match(KIDS_SCHEMA, /UNIQUE \(project_id, version\)/);
});
