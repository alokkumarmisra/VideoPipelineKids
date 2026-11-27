import test from "node:test";
import assert from "node:assert/strict";
import { adaptMovieReferenceGraph, addMovieReferenceImages, buildMovieReferencePacket, buildMovieKeyframePrompt, movieCapabilityRegistry, normalizeMovieCharacter, resolveMovieEnvironmentAssets } from "../lib/movie.mjs";

test("Movie identity normalization preserves the explicit visual bible fields", () => {
  const character = normalizeMovieCharacter({ name: "Rahul", identity: { skin_tone: "warm brown", hairstyle: "short curls" } });
  assert.equal(character.name, "Rahul");
  assert.equal(character.identity.skin_tone, "warm brown");
  assert.equal(character.identity.hairstyle, "short curls");
  assert.ok(Object.hasOwn(character.identity, "jawline"));
});

test("reference packets require an approved canonical file and resolve approved current-version views", () => {
  const character = {
    character_id: "CHAR_001", approval_status: "approved", identity_version: 2, canonical_reference_id: "r2",
    references: [
      { reference_id: "r1", identity_version: 1, status: "approved", view: "left_profile", file_path: "old.png" },
      { reference_id: "r2", identity_version: 2, status: "approved", view: "canonical_face", file_path: "face.png" },
      { reference_id: "r3", identity_version: 2, status: "review", view: "right_profile", file_path: "pending.png" },
      { reference_id: "r4", identity_version: 2, status: "approved", view: "full_body_front", file_path: "body.png" },
      { reference_id: "r5", identity_version: 2, status: "approved", view: "left_profile", file_path: "left.png" },
    ],
  };
  const packet = buildMovieReferencePacket({ movieId: "MOV_001", character, shot: { action: "turns", camera_angle: "left profile", camera: { size: "medium" } } });
  assert.equal(packet.canonical_face_reference, "face.png");
  assert.deepEqual(packet.face_profile_references, ["left.png"]);
  assert.equal(packet.face_profile_reference, "left.png");
  assert.equal(packet.face_profile_view, "left_profile");
  assert.deepEqual(packet.body_references, ["body.png"]);
  assert.equal(packet.shot_action, "turns");
  assert.throws(() => buildMovieReferencePacket({ movieId: "MOV_001", character: { ...character, canonical_reference_id: null } }), /approved canonical/);
});

test("workflow registry exposes only the conditioning implemented by its graph", () => {
  const rows = movieCapabilityRegistry();
  assert.ok(rows.length > 0);
  const flux = rows.find((row) => row.workflow === "flux");
  assert.ok(flux.image_reference_support.includes("one image input"));
  assert.ok(flux.identity_conditioning.includes("not face-specific"));
  assert.ok(flux.multiple_reference_support.includes("chains one ReferenceLatent anchor per character"));
  assert.ok(rows.some((row) => row.workflow === "flux_text_image" && row.image_reference_support.startsWith("no")));
});

test("keyframe prompts lock the approved identity while carrying shot and continuity direction", () => {
  const prompt = buildMovieKeyframePrompt({
    character: { character_id:"CHAR_001", identity_version:1, approval_status:"approved", identity_locked:true, canonical_reference_id:"ref",
      identity:{ skin_tone:"warm brown", hairstyle:"wavy black hair", distinguishing_features:"scar on right cheek" } },
    costume:{ costume_id:"COST_001", name:"Olive kurta", description:"Faded cotton shirt", color:"olive", fabric:"cotton", accessories:"dark scarf" },
    state:{ wetness:"rain-soaked shoulders" },
    scene:{ scene_number:2, title:"Across the Ridge", location:"ridge trail" },
    shot:{ action:"walks with lantern", body_movement:"shields flame", expression:"focused", camera_angle:"eye level", camera_movement:"tracking", shot_size:"medium" },
  });
  assert.match(prompt, /CHARACTER IDENTITY LOCK/);
  assert.match(prompt, /warm brown/);
  assert.match(prompt, /Olive kurta/);
  assert.match(prompt, /rain-soaked shoulders/);
  assert.match(prompt, /walks with lantern/);
  assert.throws(() => buildMovieKeyframePrompt({ character:{ approval_status:"draft" } }), /locked, approved/);
});

test("multi-character prompts keep each identity and costume attached to its character id", () => {
  const prompt = buildMovieKeyframePrompt({ characters: [
    { character: { character_id:"CHAR_001", name:"Asha", approval_status:"approved", identity_locked:true, canonical_reference_id:"a", identity:{ hairstyle:"short black curls", nose_shape:"straight" } }, costume:{ costume_id:"COST_001", name:"blue coat" }, secondary_reference_type:"costume" },
    { character: { character_id:"CHAR_002", name:"Dev", approval_status:"approved", identity_locked:true, canonical_reference_id:"b", identity:{ hairstyle:"long brown braid", nose_shape:"broad" } }, costume:{ costume_id:"COST_002", name:"red shawl" }, secondary_reference_type:"full-body" },
  ], shot:{ action:"Asha hands Dev the lantern" } });
  assert.match(prompt, /CHAR_001 — Asha/);
  assert.match(prompt, /COSTUME FOR CHAR_001 \(Asha\).*blue coat/);
  assert.match(prompt, /REFERENCE ORDER FOR CHAR_001: after the canonical face image, this character's approved costume reference images follow/);
  assert.match(prompt, /CHAR_002 — Dev/);
  assert.match(prompt, /COSTUME FOR CHAR_002 \(Dev\).*red shawl/);
  assert.match(prompt, /REFERENCE ORDER FOR CHAR_002: after the canonical face image, this character's approved full-body reference images follow/);
  assert.match(prompt, /never merge, swap, duplicate, or transfer identities/);
});

test("Movie environment assets resolve by exact registered names and aliases", () => {
  const assets = [
    { asset_id:"LOC_1", kind:"location", name:"Ridge Temple", aliases:["old temple"] },
    { asset_id:"OBJ_1", kind:"object", name:"Bronze Bell", aliases:["temple bell"] },
  ];
  const resolved = resolveMovieEnvironmentAssets({ assets, scene:{ location:"Old Temple, upper ridge", summary:"A bronze bell rings" }, shot:{ action:"rings the temple bell" } });
  assert.deepEqual(resolved.locations.map((asset) => asset.asset_id), ["LOC_1"]);
  assert.deepEqual(resolved.objects.map((asset) => asset.asset_id), ["OBJ_1"]);
  const partial = resolveMovieEnvironmentAssets({ assets, scene:{ location:"Ridge" }, shot:{ action:"carries a bell" } });
  assert.equal(partial.locations.length, 0);
  assert.equal(partial.objects.length, 0);
});

test("Movie location resolver flags competing registered locations and environment-only prompts", () => {
  const assets = [
    { asset_id:"LOC_1", kind:"location", name:"North Ridge" },
    { asset_id:"LOC_2", kind:"location", name:"South Ridge" },
    { asset_id:"OBJ_1", kind:"object", name:"Bronze Bell", identity_version:1, description:"green-patinated bronze" },
  ];
  const resolved = resolveMovieEnvironmentAssets({ assets, scene:{ location:"North Ridge and South Ridge" } });
  assert.deepEqual(resolved.ambiguous.locations, ["North Ridge", "South Ridge"]);
  const prompt = buildMovieKeyframePrompt({ objects:[assets[2]], scene:{ location:"Temple" }, shot:{ action:"A bronze bell hangs in the frame" } });
  assert.match(prompt, /OBJECT OBJ_1 — Bronze Bell/);
  assert.match(prompt, /No registered movie characters are assigned/);
});

test("Movie graph chains one ReferenceLatent conditioning node per supplied image", () => {
  const graph = {
    "75:63": { inputs: { positive: ["75:78", 0] } },
    "75:72": { class_type:"VAELoader", inputs:{} },
    "75:75": { class_type:"LoadImage", inputs:{ image:"first.png" } },
    "75:76": { class_type:"ImageScaleToTotalPixels", inputs:{ image:["75:75",0] } },
    "75:77": { class_type:"VAEEncode", inputs:{ pixels:["75:76",0], vae:["75:72",0] } },
    "75:78": { class_type:"ReferenceLatent", inputs:{ conditioning:["75:74",0], latent:["75:77",0] } },
  };
  const result = addMovieReferenceImages(graph, [{ image:"asha.png" }, { image:"asha_body.png" }, { image:"dev.png" }]);
  assert.equal(result["75:75"].inputs.image, "asha.png");
  assert.deepEqual(result.movie_ref_2_anchor.inputs.conditioning, ["75:78",0]);
  assert.deepEqual(result.movie_ref_3_anchor.inputs.conditioning, ["movie_ref_2_anchor",0]);
  assert.deepEqual(result["75:63"].inputs.positive, ["movie_ref_3_anchor",0]);
  assert.equal(graph["75:75"].inputs.image, "first.png", "the source graph is not mutated");
});

test("Movie adapter supplies the installed ImageScaleToTotalPixels required input without mutating shared graphs", () => {
  const shared = { "75:76": { class_type:"ImageScaleToTotalPixels", inputs:{ image:["75:75",0], megapixels:1 } } };
  const movie = adaptMovieReferenceGraph(shared);
  assert.equal(movie["75:76"].inputs.resolution_steps, 1);
  assert.equal(Object.hasOwn(shared["75:76"].inputs, "resolution_steps"), false);
  assert.throws(() => adaptMovieReferenceGraph({}), /graph changed/);
});
