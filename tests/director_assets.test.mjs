import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  blueprintAssetSignature,
  buildAssetReferenceMap,
  buildBoardAssetState,
  buildVisualStyleGuide,
  assetVersionId,
  extractAssetsFromBlueprint,
  findDuplicateAssets,
  validateAssetContinuity,
} from "../lib/asset_service.mjs";
import {
  approveAssets,
  getBoardAssetState,
  isValidAssetId,
  skipAssets,
} from "../lib/asset_endpoints.mjs";
import { buildScenesPrompt } from "../lib/director.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const blueprint = () => ({
  characters: [{
    character_id: "minku", name: "Minku", description: "a small rabbit",
    visual_identity_prompt: "small brown rabbit, grey ears, green scarf",
  }],
  locations: [{
    location_id: "forest", name: "Forest", description: "a green forest",
    visual_identity_prompt: "sunlit green forest, tall trees",
  }],
  objects: [{
    object_id: "basket", name: "Basket", description: "a wicker basket",
    visual_identity_prompt: "small round wicker basket",
  }],
});

test("blueprint assets get stable ids and the saved identity prompt", () => {
  const assets = extractAssetsFromBlueprint(blueprint());
  assert.deepEqual(assets.map((a) => a.id), ["CHAR_001", "LOC_001", "OBJ_001"]);
  assert.equal(assets[0].prompt, "small brown rabbit, grey ears, green scarf");
  assert.equal(assets[0].status, "pending");
  assert.ok(assets.every((a) => a.reference === null && a.version === 0));
});

test("asset reference IDs use the name stem and image version", () => {
  assert.equal(assetVersionId({ name: "Lord Shiva", blueprint_id: "shiv", version: 1 }), "SHIV_01");
  assert.equal(assetVersionId({ name: "मां पार्वती", blueprint_id: "parvati", version: 2 }), "PARV_02");
  assert.equal(assetVersionId({ name: "Trishul", blueprint_id: "trishul", version: 3 }), "TRIS_03");
});

test("a blueprint with no identity text is flagged, never auto-filled", () => {
  const bp = blueprint();
  bp.characters[0].visual_identity_prompt = "";
  bp.characters[0].description = "";
  const assets = extractAssetsFromBlueprint(bp);
  assert.equal(assets[0].status, "no-prompt");
  assert.equal(assets[0].prompt, "");
});

test("rebuilding the same bible keeps a rendered-but-unapproved still", () => {
  const first = buildBoardAssetState(blueprint());
  first.assets[0] = { ...first.assets[0], status: "review", reference: "b/characters/CHAR_001/reference.png", version: 1 };
  const again = buildBoardAssetState(blueprint(), first);
  assert.equal(again.sourceSignature, first.sourceSignature);
  assert.equal(again.assets[0].status, "review");
  assert.equal(again.assets[0].reference, "b/characters/CHAR_001/reference.png");
  assert.equal(again.assets[0].version, 1);
});

test("a changed blueprint can be rebuilt without losing approved masters", () => {
  const state = buildBoardAssetState(blueprint());
  state.assets[0] = { ...state.assets[0], status: "approved", reference: "x.png", approvedAt: "now" };
  const bp = blueprint();
  bp.locations[0].name = "Dark Forest";
  const rebuilt = buildBoardAssetState(bp, state);
  assert.notEqual(rebuilt.sourceSignature, state.sourceSignature);
  assert.equal(rebuilt.assets[0].status, "approved");
  assert.equal(rebuilt.assets[1].status, "pending");
  assert.equal(rebuilt.status, "idle"); // the changed bible needs a fresh approval pass
});

test("approve only locks rendered stills; skip is an honest explicit bypass", () => {
  const state = buildBoardAssetState(blueprint());
  state.assets.forEach((a, i) => {
    state.assets[i] = { ...a, status: "review", reference: `${a.id}.png` };
  });
  const partial = approveAssets(state, ["CHAR_001"]);
  assert.equal(partial.changed, 1);
  assert.equal(partial.state.assets[0].status, "approved");
  assert.equal(partial.state.status, "idle");
  const all = approveAssets(state);
  assert.equal(all.state.status, "approved");
  const skipped = skipAssets(state);
  assert.equal(skipped.status, "approved");
  assert.equal(skipped.skipped, true);
  assert.ok(skipped.assets.every((a) => a.status === "skipped"));
});

test("the read-only reference map reports real scene usage and honest issues", () => {
  const board = {
    styleLock: "STYLE LOCK", input: { visualStyle: "3D Cinematic", aspect: "16:9" },
    blueprint: blueprint(),
    scenes: [{
      scene_number: 1, characters: ["minku"], location: "forest",
      objects: [], lighting: "golden hour",
      shots: [{ shot_id: "A", characters: ["minku"], location: "forest" }],
    }],
  };
  const map = buildAssetReferenceMap(board);
  assert.deepEqual(map.characters[0].scenes, [1]);
  assert.deepEqual(map.characters[0].shots, ["1-A"]);
  assert.deepEqual(map.locations[0].scenes, [1]);
  assert.equal(buildVisualStyleGuide(board).style, "STYLE LOCK");
  assert.deepEqual(validateAssetContinuity(board), []);

  const broken = { ...board, scenes: [{ ...board.scenes[0], characters: ["ghost"] }] };
  assert.ok(validateAssetContinuity(broken).some((x) => x.includes("unknown character")));
  const dupes = findDuplicateAssets([
    { character_id: "a", name: "Minku" }, { character_id: "b", name: "minku" },
  ]);
  assert.equal(dupes.length, 1);
  assert.deepEqual(dupes[0].ids, ["a", "b"]);
});

test("asset ids are validated", () => {
  assert.ok(isValidAssetId("CHAR_001"));
  assert.ok(isValidAssetId("LOC_009"));
  assert.ok(!isValidAssetId("../etc/passwd"));
  assert.ok(!isValidAssetId("rabbit"));
});

test("a legacy board has empty asset state", () => {
  const s = getBoardAssetState({ id: "legacy", blueprint: blueprint() });
  assert.equal(s.status, "idle");
  assert.deepEqual(s.assets, []);
  assert.deepEqual(s.jobs, []);
});

const sceneArgs = {
  input: { title: "Minku", genre: "Kids", visualStyle: "3D Cinematic", language: "English", sceneSeconds: 3 },
  blueprint: blueprint(), beats: [], prevScene: null, startNumber: 1, count: 1, styleLock: "STYLE LOCK",
};

test("approved assets change the scene prompt only when supplied", () => {
  const before = buildScenesPrompt(sceneArgs);
  assert.equal(before, buildScenesPrompt({ ...sceneArgs, approvedAssets: null }));
  const after = buildScenesPrompt({
    ...sceneArgs,
    approvedAssets: [{
      id: "CHAR_001", blueprint_id: "minku", name: "Minku", type: "character", status: "approved",
      visualBrief: "small brown rabbit, green scarf", reference: "x.png",
    }],
  });
  assert.ok(after.includes("ASSET IDS (approved library"));
  assert.ok(after.includes("MINK_01=Minku (v1)"));
  assert.ok(after.includes("The prompt assembler resolves IDs to approved descriptions and reference images after scene planning"));
  assert.ok(!after.includes("small brown rabbit, green scarf"));
});

test("compact mode keeps its short prompt even with approved assets", () => {
  const compactArgs = {
    ...sceneArgs, compact: true,
    approvedAssets: [{ id: "CHAR_001", name: "Minku", visualBrief: "rabbit" }],
  };
  assert.ok(!buildScenesPrompt(compactArgs).includes("APPROVED MASTER ASSETS"));
});

test("the server exposes real asset routes, a serial pump and gated file serving", () => {
  const srv = read("frontend/server.mjs");
  assert.ok(srv.includes("assets\\/(generate|approve|skip|regenerate)$"));
  assert.ok(srv.includes("directorAssetPumpJobs()"));
  assert.ok(srv.includes("scripts/kids_reference.mjs"));
  assert.ok(srv.includes("serveDirectorAssets(res, rel)"));
  assert.match(srv, /p\.startsWith\("\/director-assets\/"\)[\s\S]{0,120}!authedUser\(req\)/);
  // The old fabricated stubs (inert, inside a catch block) are gone.
  assert.ok(!srv.includes("assetGenerationState"));
  assert.ok(!srv.includes('status: "started", message: "Asset generation started'));
  assert.ok(srv.includes("getBoardAssetState(board)"));
});

test("the Director plan shows the whole pipeline and a real asset stage", () => {
  const page = read("frontend/src/components/DirectorPage.tsx");
  for (const label of [
    "Analyze story", "Generate assets", "Approve & save assets",
    "Generate scenes", "Video generation", "Visual references",
    "Generate assets",
  ]) assert.ok(page.includes(label), `missing UI label: ${label}`);
  assert.match(page, /disabled=\{busy != null \|\| \(assetProduction != null && assetProduction\.status !== "approved"\)\}/);
});

test("the client can drive every stage action", () => {
  const api = read("frontend/src/api.ts");
  for (const fn of [
    "directorGenerateAssets", "directorRegenerateAsset", "directorApproveAssets",
    "directorSkipAssets", "directorAssetFileUrl",
  ]) assert.ok(api.includes(`export const ${fn}`), `missing client function: ${fn}`);
});
