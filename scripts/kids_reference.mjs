// Sanskriti Kids — asset library reference generator: ONE still per run.
// Run: node scripts/kids_reference.mjs --prompt "..." --out <file.png>
//      [--workflow flux_reference_image] [--width 1920 --height 1024 --steps 20]
//
// THE PROMPT IS PASSED VERBATIM: the Flux Reference Image workflow is used
// EXACTLY as authored (workflows/TextToImage/Flux_REFERENCE_IMAGE.json) and
// ONLY the prompt node ("6") is replaced. Nothing is appended to the prompt,
// no quality suffix is added, no negative text is invented (that graph's
// negative node stays empty) and no other node is touched.
//
// The workflow is chosen by --workflow (the header dropdown's choice rides on
// the job row):
//   flux | flux_text_image | flux_reference_image
// (see lib/image_workflows.mjs — the size/steps default to that workflow's
// own values unless --width/--height/--steps are given).
//
// Resumable: an existing --out file is kept and reported (never overwritten).
// Emits one [asset] JSON line for the server's log parser, like every other
// generator script in this repo.
import fs from "node:fs";
import path from "node:path";
import { buildFluxGraph, buildFluxTextImageGraph, buildFluxReferenceImageGraph, run, firstImageUrl, download } from "../lib/comfy.mjs";
import { resolveImageWorkflow, DEFAULT_IMAGE_WORKFLOW } from "../lib/image_workflows.mjs";

const args = process.argv.slice(2);
const opt = (k, fb = null) => {
  const i = args.indexOf(k);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fb;
};
// The user's saved prompt — VERBATIM. No suffix, no prefix, no rewriting.
const prompt = String(opt("--prompt", "") ?? "");
// The negative is only used by the Flux 2 Klein graph; the Flux.1-dev
// workflows keep their own empty negative node.
const negative = String(opt("--negative", "") ?? "");
const out = opt("--out", "");
// No --workflow = the library default (the Flux Reference Image workflow).
const wf = resolveImageWorkflow(opt("--workflow", ""), DEFAULT_IMAGE_WORKFLOW);
const width = Math.max(256, Math.min(2048, Number(opt("--width", wf.width)) || wf.width));
const height = Math.max(256, Math.min(2048, Number(opt("--height", wf.height)) || wf.height));
const steps = Math.max(1, Math.min(20, Number(opt("--steps", wf.steps)) || wf.steps));

if (!prompt.trim()) { console.error("missing --prompt"); process.exit(2); }
if (!out) { console.error("missing --out"); process.exit(2); }
if (fs.existsSync(out)) {
  console.log(`[asset] ${JSON.stringify({ kind: "image", file: path.basename(out), stage: "kids", skipped: true })}`);
  console.log(`exists, skipping: ${out}`);
  process.exit(0);
}
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });

const graphOpts = { prompt: prompt.trim(), width, height, prefix: "out/kids", steps };
// The Flux.1-dev workflows (text-to-image / reference-image) are used EXACTLY
// as authored — their negative node stays empty and only the prompt changes.
const graph = wf.id === "flux_reference_image"
  ? buildFluxReferenceImageGraph(graphOpts)
  : wf.id === "flux_text_image"
    ? buildFluxTextImageGraph(graphOpts)
    : buildFluxGraph({
      ...graphOpts,
      ...(String(negative).trim() ? { negative: String(negative).trim() } : {}),
    });
console.log(`workflow: ${wf.id} (${wf.model}) — ${width}x${height} @ ${steps} steps`);
const entry = await run(graph, "kids-reference");
const url = firstImageUrl(entry);
if (!url) throw new Error("Flux returned no image (SaveImage node 9 empty)");
await download(url, out);
console.log(`[asset] ${JSON.stringify({ kind: "image", file: path.basename(out), stage: "kids", workflow: wf.id })}`);
console.log(`saved: ${out}`);
