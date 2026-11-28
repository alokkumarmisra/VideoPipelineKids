// Reference-anchor tests: the generated reference visual must actually
// condition every scene (keyframe) image via Flux img2img.
// Run: node --test tests/   (from the repo root; zero deps, Node >= 18)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// lib/comfy.mjs exits without COMFY_BASE — dummy value is enough: the
// builder tests never touch the network.
process.env.COMFY_BASE ??= "http://localhost:1";
const comfy = await import("../lib/comfy.mjs");
const { buildFluxGraph, buildFluxImg2ImgGraph, hashSeed } = comfy;

describe("buildFluxImg2ImgGraph", () => {
  it("conditions the prompt on the VAE-encoded reference image", () => {
    const g = buildFluxImg2ImgGraph({ prompt: "a knight", image: "ref_123.png" });
    assert.deepEqual(g["75:64"].inputs.latent_image, ["75:66", 0]);
    assert.equal(g["75:75"].class_type, "LoadImage");
    assert.equal(g["75:75"].inputs.image, "ref_123.png");
    assert.equal(g["75:76"].class_type, "ImageScaleToTotalPixels");
    assert.deepEqual(g["75:76"].inputs.image, ["75:75", 0]);
    assert.equal(g["75:77"].class_type, "VAEEncode");
    assert.deepEqual(g["75:77"].inputs.pixels, ["75:76", 0]);
    // Same VAE the decoder uses (no extra models needed).
    assert.deepEqual(g["75:77"].inputs.vae, ["75:72", 0]);
    assert.equal(g["75:78"].class_type, "ReferenceLatent");
    assert.deepEqual(g["75:78"].inputs.conditioning, ["75:74", 0]);
    assert.deepEqual(g["75:78"].inputs.latent, ["75:77", 0]);
    assert.deepEqual(g["75:63"].inputs.positive, ["75:78", 0]);
    assert.ok("75:66" in g, "empty scene latent must remain the sampler canvas");
  });

  it("scales the reference and keeps prompt/seed/prefix", () => {
    const g = buildFluxImg2ImgGraph({
      prompt: "a knight at dawn", image: "r.png", width: 960, height: 512,
      prefix: "scn/seq1", steps: 4,
    });
    assert.equal(g["75:76"].inputs.megapixels, 0.49152);
    // Verbatim prompts: builders send the text exactly as written (no quality tokens).
    assert.equal(g["75:74"].inputs.text, "a knight at dawn");
    assert.equal(g["75:62"].inputs.steps, 4);
    assert.ok(Number.isFinite(g["75:73"].inputs.noise_seed));
    assert.equal(g["9"].inputs.filename_prefix, "scn/seq1");
  });

  it("save=false drops the SaveImage node like buildFluxGraph", () => {
    const g = buildFluxImg2ImgGraph({ prompt: "x", image: "r.png", save: false });
    assert.ok(!("9" in g));
  });

  it("pure t2i removes optional reference conditioning and uses the empty latent", () => {
    buildFluxImg2ImgGraph({ prompt: "anchored", image: "r.png" });
    const t2i = buildFluxGraph({ prompt: "plain" });
    assert.deepEqual(t2i["75:64"].inputs.latent_image, ["75:66", 0]);
    assert.ok("75:66" in t2i);
    assert.ok(!("75:75" in t2i));
    assert.deepEqual(t2i["75:63"].inputs.positive, ["75:74", 0]);
    assert.equal(t2i["75:74"].inputs.text, "plain");
  });
});

describe("sequence wiring", () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

  it("genKeyframe uses only beat-specific anchors and passes the saved prompt", () => {
    const src = read("lib/sequence.mjs");
    assert.match(src, /uploadToInput\(anchorPath/);
    assert.match(src, /keyframePromptFor\(seq\[i\]\.image\)/);
    assert.match(src, /buildKeyframe\(kfPrompt, i, refInputs/);
    assert.doesNotMatch(src, /runRef \?\? resolveRefForRun/);
  });

  it("approved Director asset references are the only keyframe image anchors", () => {
    const src = read("lib/sequence.mjs");
    assert.match(src, /seq\[i\]\.reference_images/);
    assert.match(src, /approved scene assets/);
    assert.match(src, /setKeyframeRefFrom\(outDir, n, refMain\)/);
  });

  it("per-scene reference changes can mark a keyframe stale", () => {
    const src = read("lib/sequence.mjs");
    assert.match(src, /getKeyframeRefFrom/);
    assert.match(src, /setKeyframeRefFrom/);
  });

  it("excludes Generate Reference data from ordinary scene runs", () => {
    const src = read("lib/sequence.mjs");
    assert.doesNotMatch(src, /await genRef\(\)/);
    assert.doesNotMatch(src, /runRef/);
    assert.match(src, /project Generate Reference data is excluded/);
    assert.match(src, /every clip animates its own keyframe/);
  });

  it("keyframes use only their saved image prompt, not Generate Reference text", async () => {
    const seq = await import("../lib/sequence.mjs");
    const cfg = { character: "a brave rabbit in blue kurta", referencePrompt: "cinematic key visual of the rabbit" };
    const out = seq.keyframePromptFor("the rabbit jumps", cfg);
    assert.equal(out, "the rabbit jumps");
    assert.doesNotMatch(out, /brave rabbit|cinematic key visual/);
  });

  it("clips carry the fidelity lock (animate the keyframe, never redesign)", async () => {
    const seq = await import("../lib/sequence.mjs");
    const out = seq.motionPromptFor("slow push-in");
    assert.match(out, /slow push-in/);
    assert.match(out, /animate natural motion only/);
    assert.match(out, /8k uhd quality/);
    assert.match(out, /no distortion/);
    assert.equal(seq.motionPromptFor(out), out);
    assert.match(seq.motionPromptFor(""), /animate natural motion only/);
    const src = read("lib/sequence.mjs");
    assert.match(src, /motionPromptFor\(beat\.motion\)/);
  });

  it("clips always animate their own keyframe (same-scene linkage, verbatim keyframes)", async () => {
    const seq = await import("../lib/sequence.mjs");
    const src = read("lib/sequence.mjs");
    // No cross-scene pixel chaining: beat N never starts from beat N-1's frame.
    assert.doesNotMatch(src, /chained from clip/);
    assert.doesNotMatch(src, /chain_last/);
    assert.match(src, /from own keyframe/);
    // Keyframes render scene context verbatim (no auto-appended quality tokens).
    assert.equal(seq.keyframePromptFor("a forest chase", {}), "a forest chase");
    // Builders pass the prompt through untouched.
    const g = buildFluxImg2ImgGraph({ prompt: "x", image: "r.png" });
    assert.equal(g["75:74"].inputs.text, "x");
  });

  it("a freshly generated version becomes main (regen v4 beats picked v1/v2/v3)", () => {
    const src = read("lib/sequence.mjs");
    // Each generator records the just-written file and prefers it over the
    // previously selected main; skips (no new file) keep the old selection.
    // genKeyframe + genClip follow newFile ?? resolveMain; genRef is
    // explicit-only (a fresh ref NEVER auto-selects, only a user pick does).
    const hits = src.match(/newFile \?\? (?:path\.basename\()?resolveMain\(/g) || [];
    assert.equal(hits.length, 2, "genKeyframe + genClip must select the fresh file (ref stays explicit-only)");
    assert.match(src, /newFile = path\.basename\(dest\)/);
    // A deselected ref skip records nothing (no silent re-enable).
    assert.match(src, /deselected, skipping/);
  });

  it("keyframe seeds are deterministic per beat+version (character stability)", () => {
    const src = read("lib/sequence.mjs");
    // Same inputs reproduce; a new version takes a fresh take — faces drift
    // less between scenes than with pure random seeds.
    assert.match(src, /hashSeed\(`\$\{prefix\}:kf\$\{n\}:v\$\{v\}`\)/);
    // The seed is pinned through pinSeed() — Flux 2 Klein on node "75:73"
    // (noise_seed). The Flux.1-dev workflows keep their own random seed:
    // their graphs are used exactly as authored.
    assert.match(src, /pinSeed\(kfGraph, hashSeed\(/);
    assert.match(src, /graph\["75:73"\].*noise_seed = seed/);
    assert.ok(!/graph\["31"\]/.test(src), "the Flux.1-dev sampler seed must stay untouched");
  });

  it("hashSeed is stable and version-sensitive", () => {
    assert.equal(hashSeed("p:kf1:v1"), hashSeed("p:kf1:v1"));
    assert.notEqual(hashSeed("p:kf1:v1"), hashSeed("p:kf1:v2"));
    assert.notEqual(hashSeed("p:kf1:v1"), hashSeed("p:kf2:v1"));
    const s = hashSeed("p:kf1:v1");
    assert.ok(Number.isInteger(s) && s >= 0 && s <= 0xffffffff);
  });

  it("both runners build img2img keyframes when a ref input exists", () => {
    for (const f of ["scripts/character_sequence.mjs", "scripts/character_sequence_wan.mjs"]) {
      const src = read(f);
      // The runners pick the graph through the shared dispatcher
      // (buildImageGraph) — it routes the "flux" mode to the img2img anchor
      // builder and the Flux.1-dev workflows to pure text-to-image.
      assert.match(src, /buildImageGraph/, `${f} must use the shared image-graph dispatcher`);
      assert.match(src, /\(prompt, i, refImage\)/, `${f} must accept the ref input`);
      assert.match(src, /image: refImage/, `${f} must hand the ref input to the dispatcher`);
    }
    // The dispatcher keeps the anchor (img2img) for the "flux" mode.
    const dispatcher = read("lib/comfy.mjs");
    assert.match(dispatcher, /buildFluxImg2ImgGraph\(\{ prompt, image/);
  });
});
