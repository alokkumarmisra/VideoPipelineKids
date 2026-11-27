import test from "node:test";
import assert from "node:assert/strict";
import { resolveSceneAssetRefs } from "../lib/asset_endpoints.mjs";
import { buildScenesPrompt, buildRegenPrompt, buildDirectionRepairPrompt, boardToScenario, compactSceneGenerationDirections } from "../lib/director.mjs";

const assets = [
  { id: "CHAR_001", type: "character", blueprint_id: "shiv", name: "Lord Shiva", prompt: "APPROVED SHIVA DESIGN", reference: "board/characters/CHAR_001/shiva_v1.png", status: "approved" },
  { id: "LOC_001", type: "location", blueprint_id: "kailash", name: "Kailash", prompt: "APPROVED KAILASH DESIGN", reference: "board/locations/LOC_001/kailash_v1.png", status: "approved" },
  { id: "OBJ_001", type: "object", blueprint_id: "trishul", name: "Trishul", prompt: "APPROVED TRISHUL DESIGN", reference: "board/objects/OBJ_001/trishul_v1.png", status: "approved" },
];
const blueprint = {
  characters: [{ character_id: "shiv", name: "Lord Shiva", role: "main_character", visual_identity_prompt: "OLD CHARACTER DESCRIPTION" }],
  locations: [{ location_id: "kailash", name: "Kailash", visual_identity_prompt: "OLD LOCATION DESCRIPTION" }],
  objects: [{ object_id: "trishul", name: "Trishul", visual_identity_prompt: "OLD OBJECT DESCRIPTION" }],
};

test("scene rows resolve bible ids to approved asset ids without copying descriptions", () => {
  const scene = {
    scene_number: 1, characters: ["shiv"], location: "kailash", objects: ["trishul"],
    action: "Shiva raises the trishul", image_prompt: "Action: Shiva raises the trishul",
    video_prompt: "Animate Shiva raising the trishul",
  };
  const result = resolveSceneAssetRefs(scene, { assets });
  compactSceneGenerationDirections(scene);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(scene.asset_refs, { characters: ["SHIV_01"], locations: ["KAIL_01"], objects: ["TRIS_01"] });
  assert.ok(!JSON.stringify(scene).includes("APPROVED SHIVA DESIGN"));
});

test("invalid explicit asset ids are removed and flagged for review", () => {
  const scene = {
    scene_number: 2, characters: ["shiv"], location: "kailash", objects: [],
    asset_refs: { characters: ["CHAR_999"], locations: ["LOC_001"], objects: [] },
  };
  const result = resolveSceneAssetRefs(scene, { assets });
  assert.ok(result.issues.some((issue) => issue.includes("CHAR_999")));
  assert.deepEqual(scene.asset_refs.characters, ["SHIV_01"]);
  assert.ok(scene.asset_reference_issues.length);
});

test("planning prompt sends compact id/name mappings, not full asset prompts", () => {
  const prompt = buildScenesPrompt({
    input: { title: "Test", genre: "Drama", visualStyle: "3D", sceneSeconds: 3 },
    blueprint, beats: [], prevScene: null, startNumber: 1, count: 1, styleLock: "cinematic",
    approvedAssets: assets,
  });
  assert.ok(prompt.includes("SHIV_01=Lord Shiva (v1)"));
  assert.ok(prompt.includes('"asset_refs"'));
  assert.ok(prompt.includes("For EVERY scene and shot, put each visible approved character, location and object in asset_refs using its exact asset ID"));
  assert.ok(prompt.includes("Do not copy asset descriptions, appearance text, prompts, or image paths"));
  assert.ok(prompt.includes('"image_prompt": "", "video_prompt": ""'));
  assert.ok(prompt.includes("leave image_prompt and video_prompt empty because the server composes them"));
  assert.ok(!prompt.includes("paste each required verbatim identity"));
  assert.ok(!prompt.includes("verbatim identity paste + global style"));
  assert.ok(!prompt.includes("APPROVED SHIVA DESIGN"));
  assert.ok(!prompt.includes("OLD CHARACTER DESCRIPTION"));
});

test("boards without approved assets retain self-contained prompt generation", () => {
  const prompt = buildScenesPrompt({
    input: { title: "Test", genre: "Drama", visualStyle: "3D", sceneSeconds: 3 },
    blueprint, beats: [], prevScene: null, startNumber: 1, count: 1, styleLock: "cinematic",
  });
  assert.ok(prompt.includes("self-contained image prompt"));
  assert.ok(prompt.includes('"video_prompt": "MOTION ONLY for THIS scene'));
});

test("repair and single-scene regeneration keep approved asset context compact", () => {
  const scene = { scene_number: 1, title: "Raise the trishul", duration_seconds: 3, characters: ["shiv"], location: "kailash", objects: ["trishul"], image_prompt: "Action: raise it" };
  const input = { title: "Test", genre: "Drama", visualStyle: "3D", language: "English", chainContinuity: false };
  const regen = buildRegenPrompt({ input, blueprint, scene, styleLock: "cinematic", approvedAssets: assets });
  const repair = buildDirectionRepairPrompt({ input, blueprint, scenes: [scene], issues: ["scene 1: missing camera"], approvedAssets: assets });
  for (const prompt of [regen, repair]) {
    assert.ok(prompt.includes("SHIV_01=Lord Shiva (v1)"));
    assert.ok(!prompt.includes("APPROVED SHIVA DESIGN"));
    assert.ok(!prompt.includes("OLD CHARACTER DESCRIPTION"));
  }
});

test("prompt assembly expands approved assets after planning and carries their refs", () => {
  const scene = {
    scene_number: 1, title: "Shiva raises the trishul", duration_seconds: 3,
    characters: ["shiv"], asset_refs: { characters: ["SHIV_01"], locations: ["KAIL_01"], objects: ["TRIS_01"] },
    location: "kailash", objects: ["trishul"], action: "Shiva raises the trishul",
    emotion: "determined", expression: "focused", body_language: "raises one arm",
    camera: { shot_type: "Medium Shot", angle: "Low Angle", movement: "Dolly In" },
    lighting: "blue light", environment: "snowy mountain", image_prompt: "Action: Shiva raises the trishul",
    video_prompt: "Animate the raised arm", dialogue: [], shots: [],
  };
  const board = {
    input: { title: "Test", visualStyle: "3D Cinematic", sceneSeconds: 3 },
    blueprint: { ...blueprint, logline: "A divine story" },
    assetProduction: { assets }, styleLock: "cinematic light lock", scenes: [scene],
  };
  const config = boardToScenario(board);
  const beat = config.sequence[0];
  for (const text of ["APPROVED SHIVA DESIGN", "APPROVED KAILASH DESIGN", "APPROVED TRISHUL DESIGN"]) {
    assert.ok(beat.image.includes(text), `missing assembled asset prompt: ${text}`);
  }
  assert.equal(beat.reference_images.length, 3);
  assert.deepEqual(scene.asset_refs.characters, ["SHIV_01"]);
  assert.ok(!scene.image_prompt.includes("APPROVED SHIVA DESIGN"));
});

test("version IDs resolve to their exact saved image and prompt", () => {
  const versioned = [{
    ...assets[0], version: 2, reference_id: "SHIV_02",
    image_versions: [
      { version: 1, reference_id: "SHIV_01", reference: "board/characters/CHAR_001/shiva_v1.png", prompt: "SHIVA V1 PROMPT" },
      { version: 2, reference_id: "SHIV_02", reference: "board/characters/CHAR_001/shiva_v2.png", prompt: "SHIVA V2 PROMPT" },
    ],
  }];
  const scene = {
    scene_number: 2, title: "Shiva v1", duration_seconds: 3, characters: ["shiv"],
    asset_refs: { characters: ["SHIV_01"], locations: [], objects: [] },
    action: "Shiva watches", emotion: "calm", camera: { shot_type: "Medium Shot", angle: "Eye Level", movement: "Static" },
    image_prompt: "Composition: Shiva watches", video_prompt: "Animate: stillness", dialogue: [], shots: [],
  };
  const resolved = resolveSceneAssetRefs(scene, { assets: versioned });
  assert.deepEqual(resolved.issues, []);
  assert.deepEqual(scene.asset_refs.characters, ["SHIV_01"]);
  const config = boardToScenario({
    input: { title: "Test", visualStyle: "3D Cinematic", sceneSeconds: 3 },
    blueprint, assetProduction: { assets: versioned }, scenes: [scene],
  });
  assert.ok(config.sequence[0].image.includes("SHIVA V1 PROMPT"));
  assert.equal(config.sequence[0].reference_images[0].path, "board/characters/CHAR_001/shiva_v1.png");
  assert.equal(config.sequence[0].reference_images[0].reference_id, "SHIV_01");
});
