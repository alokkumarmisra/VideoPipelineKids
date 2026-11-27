// Camera-only duplication guard (pure + wiring). Run:
//   node --test tests/scene_variation.test.mjs
//
// The Shiva board produced several scenes with the SAME identity paste,
// action, expression and body language, changing only the camera. These tests
// pin the two additive fixes: a gated meaning-variation prompt block for
// abstract/ungrounded lines, and a non-blocking repeat-staging warning that
// also feeds the existing repair path. Boards without semantic data are inert.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  analyzeLine,
  attachSemantics,
  buildSemanticVariationContext,
  validateSceneSemantics,
} from "../lib/semantics.mjs";
import {
  buildScenesPrompt,
  flagRepeatStaging,
  normalizeScene,
} from "../lib/director.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const IDENTITY = "Full body portrait of Lord Shiva, pale ash-gray skin, tiger skin shawl, glowing crescent moon, matted hair with the Ganga, serpent Vasuki around the neck, ultra photorealistic, 8k uhd";

const abstractRow = (text, id) => analyzeLine(text, { index: id - 1 });

const stagedScene = (n, lineId, camera, extra = {}) => {
  const row = abstractRow(["cosmic stillness", "अनंतता", "mystery", "eternal consciousness"][lineId - 1], lineId);
  return normalizeScene(attachSemantics({
    scene_number: n,
    title: `Moment ${n}`,
    action: "शिव योग मुद्रा में स्थिर बैठे हैं। शरीर से कोई गति नहीं है।",
    emotion: "शांत, दिव्य, अनंत",
    expression: "मुस्कुराती हुई शांति, गहरी आँखें",
    body_language: "कौंधे हुए शरीर, ध्यान में लीन हाथ",
    characters: ["shiva"],
    location: "kailash",
    camera,
    image_prompt: `${IDENTITY}. ${camera.shot_type}, ${camera.movement}.`,
    video_prompt: "The figure remains static in meditation pose; camera only.",
    duration_seconds: 3,
    ...extra,
  }, row), n, 3);
};

describe("meaning variation for abstract lines", () => {
  it("is empty for grounded rows and renders only the flagged lines", () => {
    const abstract = abstractRow("cosmic stillness", 1);
    const hindi = abstractRow("अनंतता", 2);
    const grounded = analyzeLine("The dog runs to the child", { index: 2 });
    assert.equal(abstract.abstract, true);
    assert.equal(abstract.action_plan[0].grounded, false);
    assert.equal(grounded.action_plan[0].grounded, true);

    assert.equal(buildSemanticVariationContext([]), "");
    assert.equal(buildSemanticVariationContext([grounded]), "");
    const block = buildSemanticVariationContext([abstract, grounded, hindi]);
    assert.match(block, /MEANING VARIATION/);
    assert.match(block, /Line 1: "cosmic stillness"/);
    assert.match(block, /Line 2: "अनंतता"/);
    assert.ok(!block.includes("The dog runs to the child"), "grounded lines stay out of the block");
    assert.match(block, /NEVER copy a placeholder/);
    assert.match(block, /different source lines require different visible actions/i);
    assert.match(block, /dramatic_purpose/);
  });

  it("keeps buildScenesPrompt byte-identical without the optional context", () => {
    const args = {
      input: { title: "T", genre: "Devotional", visualStyle: "3D Cinematic", language: "hi", sceneSeconds: 3 },
      blueprint: { characters: [], locations: [], objects: [], beats: [], lyric_lines: [] },
      beats: [], prevScene: null, startNumber: 1, count: 1, styleLock: "style",
    };
    const before = buildScenesPrompt(args);
    assert.equal(before, buildScenesPrompt({ ...args, semanticVariationContext: null }));
    assert.ok(!before.includes("MEANING VARIATION"));
    const block = buildSemanticVariationContext([abstractRow("cosmic stillness", 1)]);
    const after = buildScenesPrompt({ ...args, semanticVariationContext: block });
    assert.match(after, /MEANING VARIATION/);
    assert.ok(after.includes(block.trim()));
  });

  it("an ungrounded action is no longer reported as 'specified'", () => {
    const row = abstractRow("cosmic stillness", 1);
    const scene = attachSemantics({
      scene_number: 1, action: "the action described in the line", image_prompt: IDENTITY,
      video_prompt: "camera holds", duration_seconds: 6, characters: ["shiva"],
      camera: { shot_type: "Medium Shot", angle: "Eye Level", movement: "Static" },
      continuity_from_previous_scene: "start of film",
    }, row);
    const check = validateSceneSemantics(scene, row);
    assert.equal(check.mainActionSpecified, false);
    assert.match(check.errors.join(" | "), /no grounded visible action/);
    assert.ok(!check.errors.join(" | ").includes("the visible action is specified"));
  });
});

describe("camera-only repeat guard", () => {
  const cameras = [
    { shot_type: "Medium Shot", angle: "Eye Level", movement: "Static" },
    { shot_type: "Extreme Wide Shot", angle: "Low Angle", movement: "Dolly Out" },
    { shot_type: "Close-Up", angle: "Eye Level", movement: "Static" },
  ];

  it("flags consecutive scenes that repeat staging for different lines", () => {
    const notes = flagRepeatStaging([
      stagedScene(1, 1, cameras[0]),
      stagedScene(2, 2, cameras[1]),
      stagedScene(3, 3, cameras[2]),
    ]);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /Scene 1, Scene 2, Scene 3/);
    assert.match(notes[0], /only the camera framing changes/);
    assert.match(notes[0], /distinct visible actions/);
  });

  it("never flags legacy scenes without semantic fields", () => {
    const legacy = [1, 2, 3].map((n) => normalizeScene({
      scene_number: n, title: `S${n}`, action: "the same action",
      image_prompt: IDENTITY, video_prompt: "camera holds", duration_seconds: 3,
      camera: cameras[n - 1],
    }, n, 3));
    assert.deepEqual(flagRepeatStaging(legacy), []);
  });

  it("ignores shots of the same line and scenes with genuinely different staging", () => {
    assert.deepEqual(flagRepeatStaging([
      stagedScene(1, 1, cameras[0]), stagedScene(2, 1, cameras[1]),
    ]), []);
    assert.deepEqual(flagRepeatStaging([
      stagedScene(1, 1, cameras[0]),
      stagedScene(2, 2, cameras[1], { action: "शिव अपनी आँखें खोलते हैं, तीसरा नेत्र जागता है" }),
    ]), []);
  });
});

describe("meaning-variation server wiring", () => {
  const server = src("frontend/server.mjs");
  const director = src("lib/director.mjs");
  const semantics = src("lib/semantics.mjs");

  it("the real batch and prompt-preview derive the SAME gated block", () => {
    assert.ok(server.includes("semanticVariationContext: semanticVariationForBatch(board, spec.lineRange)"), "prompt-preview missing the block");
    assert.ok(server.includes("const semanticVariationContext = semanticVariationForBatch(board, lineRange, semanticRows);"), "real batch missing the block");
    assert.ok(server.includes("buildSemanticVariationContext(picked);"));
    assert.ok(server.includes("semanticVariationContext,"), "the real LLM call does not pass the block");
    assert.ok(director.includes("semanticVariationContext = null"));
    assert.ok(director.includes("variationBlock ? `\\n${variationBlock}\\n` : \"\""));
    assert.ok(semantics.includes("export function buildSemanticVariationContext"));
  });

  it("the repeat guard feeds both the visible warning and the repair path", () => {
    assert.ok(server.includes("for (const note of flagRepeatStaging(board.scenes).slice(0, 3)) warnBits.push(note);"));
    assert.ok(server.includes("for (const note of flagRepeatStaging(arr(board && board.scenes))) issues.push(note);"));
    assert.ok(server.includes("flagRepeatStaging,"), "server does not import the guard");
  });

  it("the meaning rule no longer tells the model to copy ungrounded actions", () => {
    assert.ok(semantics.includes("Use the GROUNDED \"visible action\" verbatim"));
    assert.ok(semantics.includes("An ungrounded placeholder is NOT a visible action"));
  });
});
