// Image-workflow registry + the Flux Reference Image graph.
//
// The header dropdown ("Main" image dropdown) picks ONE workflow for every
// generated image: the project keyframes (--image-mode) and the Devotional
// Library's reference stills (job.workflow). This test pins the registry
// (ids, labels, models, sizes) and the new Flux.1-dev reference-image graph
// so a renamed workflow can never silently break the dropdown.
//
// Run: node --test tests/image_workflows.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// lib/comfy.mjs exits without COMFY_BASE — a dummy is enough, nothing here
// touches the network.
process.env.COMFY_BASE ??= "http://localhost:1";
const { buildFluxReferenceImageGraph, buildFluxTextImageGraph, buildImageGraph } = await import("../lib/comfy.mjs");
const { IMAGE_WORKFLOWS, IMAGE_WORKFLOW_IDS, DEFAULT_IMAGE_WORKFLOW, imageWorkflow, resolveImageWorkflow } =
  await import("../lib/image_workflows.mjs");

describe("image workflow registry", () => {
  it("offers the three dropdown options", () => {
    assert.deepEqual(IMAGE_WORKFLOW_IDS, ["flux", "flux_text_image", "flux_reference_image"]);
  });
  it("labels every workflow for the dropdown", () => {
    for (const id of IMAGE_WORKFLOW_IDS) {
      assert.ok(IMAGE_WORKFLOWS[id].label, `${id} needs a label`);
      assert.ok(IMAGE_WORKFLOWS[id].model, `${id} needs a model`);
      assert.ok(IMAGE_WORKFLOWS[id].steps >= 1, `${id} needs steps`);
      assert.ok(IMAGE_WORKFLOWS[id].width >= 256 && IMAGE_WORKFLOWS[id].height >= 256, `${id} needs a size`);
    }
  });
  it("points every workflow at an existing workflow file", () => {
    for (const id of IMAGE_WORKFLOW_IDS) {
      const file = path.join(ROOT, "workflows", IMAGE_WORKFLOWS[id].file);
      assert.ok(fs.existsSync(file), `${id} workflow file missing: ${file}`);
    }
  });
  it("defaults the Devotional Library to the Flux Reference Image workflow", () => {
    assert.equal(DEFAULT_IMAGE_WORKFLOW, "flux_reference_image");
    assert.equal(resolveImageWorkflow(undefined).id, "flux_reference_image");
    assert.equal(resolveImageWorkflow("nope").id, "flux_reference_image");
  });
  it("resolves the legacy workflow file name to its registry id", () => {
    assert.equal(imageWorkflow("flux-t2i").id, "flux");
    assert.equal(resolveImageWorkflow("flux-t2i").id, "flux");
  });
  it("returns null for an unknown id", () => {
    assert.equal(imageWorkflow("nope"), null);
  });
});

describe("Flux Reference Image graph (workflows/TextToImage/Flux_REFERENCE_IMAGE.json)", () => {
  it("sends the prompt verbatim on the CLIPTextEncode node", () => {
    const g = buildFluxReferenceImageGraph({ prompt: "Lord Krishna with a flute" });
    assert.equal(g["6"].inputs.text, "Lord Krishna with a flute");
  });
  it("keeps the negative node empty (the workflow is used as authored)", () => {
    const g = buildFluxReferenceImageGraph({ prompt: "x", negative: "blurry, watermark" });
    assert.equal(g["33"].inputs.text, "");
  });
  it("renders the workflow's own model + sampler settings", () => {
    const g = buildFluxReferenceImageGraph({ prompt: "x" });
    assert.equal(g["38"].inputs.unet_name, "flux1-dev-Q8_0.gguf");
    assert.equal(g["40"].inputs.vae_name, "flux_vae.safetensors");
    assert.equal(g["31"].inputs.cfg, 1);
    assert.equal(g["31"].inputs.steps, 20);
    assert.equal(g["35"].inputs.guidance, 3.5);
  });
  it("uses the workflow's own latent size (1920x1024) and a random seed", () => {
    const g = buildFluxReferenceImageGraph({ prompt: "x" });
    assert.equal(g["27"].inputs.width, 1920);
    assert.equal(g["27"].inputs.height, 1024);
    assert.ok(Number.isFinite(g["31"].inputs.seed));
  });
  it("matches the shipped workflow file node for node", () => {
    // The API graph must be the workflow as authored — same node classes,
    // same sampler settings, same latent size; only the prompt text differs.
    const shipped = JSON.parse(
      fs.readFileSync(path.join(ROOT, "workflows", "TextToImage", "Flux_REFERENCE_IMAGE.json"), "utf8"));
    const byType = (wf) => Object.fromEntries(wf.nodes.map((n) => [n.type, n.widgets_values]));
    const shippedWidgets = byType(shipped);
    const g = buildFluxReferenceImageGraph({ prompt: "x" });
    assert.equal(g["38"].inputs.unet_name, shippedWidgets.UnetLoaderGGUF[0]);
    assert.equal(g["39"].inputs.clip_name1, shippedWidgets.DualCLIPLoader[0]);
    assert.equal(g["39"].inputs.clip_name2, shippedWidgets.DualCLIPLoader[1]);
    assert.equal(g["40"].inputs.vae_name, shippedWidgets.VAELoader[0]);
    assert.equal(g["31"].inputs.steps, shippedWidgets.KSampler[2]);
    assert.equal(g["31"].inputs.cfg, shippedWidgets.KSampler[3]);
    assert.equal(g["31"].inputs.sampler_name, shippedWidgets.KSampler[4]);
    assert.equal(g["31"].inputs.scheduler, shippedWidgets.KSampler[5]);
    assert.equal(g["35"].inputs.guidance, shippedWidgets.FluxGuidance[0]);
    assert.equal(g["27"].inputs.width, shippedWidgets.EmptySD3LatentImage[0]);
    assert.equal(g["27"].inputs.height, shippedWidgets.EmptySD3LatentImage[1]);
  });
  it("is pure text-to-image (no image input node)", () => {
    const g = buildFluxReferenceImageGraph({ prompt: "x" });
    assert.equal(g["27"].class_type, "EmptySD3LatentImage");
    assert.ok(!Object.values(g).some((n) => n.class_type === "LoadImage"));
  });
  it("saves through SaveImage with the caller's prefix", () => {
    const g = buildFluxReferenceImageGraph({ prompt: "x", prefix: "devotional/asset" });
    assert.equal(g["9"].class_type, "SaveImage");
    assert.equal(g["9"].inputs.filename_prefix, "devotional/asset");
  });
});

describe("buildImageGraph (the dropdown dispatcher)", () => {
  it("routes flux_reference_image to the reference-image graph", () => {
    const g = buildImageGraph("flux_reference_image", { prompt: "x" });
    assert.equal(g["38"].inputs.unet_name, "flux1-dev-Q8_0.gguf");
    assert.equal(g["27"].inputs.width, IMAGE_WORKFLOWS.flux_reference_image.width);
  });
  it("routes flux_text_image to the text-to-image graph", () => {
    const g = buildImageGraph("flux_text_image", { prompt: "x" });
    assert.equal(g["27"].inputs.width, IMAGE_WORKFLOWS.flux_text_image.width);
  });
  it("keeps the Flux 2 Klein graph for the flux mode and anchors on a reference", () => {
    const g = buildImageGraph("flux", { prompt: "x", image: "ref.png" });
    assert.equal(g["75:74"].inputs.text, "x");
    assert.ok(g["ref:load"], "the flux mode must keep its img2img anchor");
  });
  it("never anchors on a reference for the Flux.1-dev workflows", () => {
    for (const id of ["flux_text_image", "flux_reference_image"]) {
      const g = buildImageGraph(id, { prompt: "x", image: "ref.png" });
      assert.ok(!g["ref:load"], `${id} must stay pure text-to-image`);
    }
  });
  it("falls back to the flux graph for an unknown mode", () => {
    const g = buildImageGraph("nope", { prompt: "x" });
    assert.equal(g["75:74"].inputs.text, "x");
  });
  it("keeps the two Flux.1-dev graphs structurally identical (same workflow)", () => {
    const a = buildFluxTextImageGraph({ prompt: "x" });
    const b = buildFluxReferenceImageGraph({ prompt: "x" });
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
    for (const k of Object.keys(a)) {
      assert.equal(a[k].class_type, b[k].class_type, `node ${k} differs`);
    }
  });
});
