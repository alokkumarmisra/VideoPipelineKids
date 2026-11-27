// Movie-specific single-shot keyframe renderer. Uses the existing Flux 2
// reference-anchored graph; the packet and output path are prepared by server.
import fs from "node:fs";
import path from "node:path";
import { buildImageGraph, download, firstImageUrl, run, uploadToInput } from "../lib/comfy.mjs";
import { adaptMovieReferenceGraph, addMovieReferenceImages } from "../lib/movie.mjs";

const arg = (key) => {
  const index = process.argv.indexOf(key);
  return index >= 0 ? process.argv[index + 1] : "";
};
const jobFile = arg("--job-file"), output = arg("--out");
if (!jobFile || !output) throw new Error("--job-file and --out are required");
const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
if (job.workflow !== "flux") throw new Error("Movie keyframes require the Flux workflow with a reference image input");
const packets = Array.isArray(job.packets) ? job.packets : job.packet ? [job.packet] : [];
const environmentReferences = Array.isArray(job.environment_references) ? job.environment_references : [];
if (!packets.length && !environmentReferences.length) throw new Error("No approved character, location, or object reference images were supplied");
for (const packet of packets) {
  if (!packet.canonical_face_reference || !fs.existsSync(packet.canonical_face_reference)) throw new Error(`Approved canonical face reference is missing for ${packet.character_name || packet.character_id}`);
}
if (fs.existsSync(output)) throw new Error(`Refusing to overwrite existing keyframe: ${output}`);

const referenceImages = [];
for (const packet of packets) {
  const identity = `${packet.character_id} (${packet.character_name || packet.character_id})`;
  const wardrobeFile = packet.costume_reference || packet.body_reference;
  const wardrobeKind = packet.costume_reference ? "costume" : packet.body_reference ? "full-body" : "";
  const candidates = [
    ["canonical face", packet.canonical_face_reference],
    ...(packet.face_profile_reference ? [[`${String(packet.face_profile_view || "profile").replaceAll("_", " ")} face profile`, packet.face_profile_reference]] : []),
    ...(wardrobeFile ? [[wardrobeKind, wardrobeFile]] : []),
  ];
  for (const [kind, file] of candidates) {
    if (!file) continue;
    if (!fs.existsSync(file)) throw new Error(`Approved ${kind} reference is missing for ${identity}`);
    const image = await uploadToInput(file, `movie_identity_${packet.character_id}`);
    referenceImages.push({ image, label: `${identity} ${kind}` });
  }
}
for (const asset of environmentReferences) {
  if (!asset.reference_path || !fs.existsSync(asset.reference_path)) throw new Error(`Approved ${asset.kind} reference is missing for ${asset.name || asset.asset_id}`);
  const image = await uploadToInput(asset.reference_path, `movie_${asset.kind}_${asset.asset_id}`);
  referenceImages.push({ image, label: `${asset.kind} ${asset.asset_id} (${asset.name || asset.asset_id})` });
}
if (!referenceImages.length) throw new Error("No usable approved Movie reference images were uploaded");
const baseGraph = buildImageGraph("flux", {
  prompt: job.prompt,
  image: referenceImages[0].image,
  width: 1280,
  height: 768,
  steps: 4,
  prefix: job.prefix,
});
// The installed node schema requires resolution_steps; keep the adapter local
// to Movie so shared Director/image workflows and their graphs stay untouched.
const graph = adaptMovieReferenceGraph(addMovieReferenceImages(baseGraph, referenceImages), 1);
const result = await run(graph, `movie-keyframe-${job.job_id}`);
const url = firstImageUrl(result);
if (!url) throw new Error("ComfyUI returned no keyframe image");
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
await download(url, output);
console.log(`[movie] ${JSON.stringify({ job_id: job.job_id, output, workflow: "flux", model: job.model || "flux-2-klein-4b-fp8", character_ids: packets.map((packet) => packet.character_id), environment_asset_ids: environmentReferences.map((asset) => asset.asset_id), reference_images: referenceImages.length })}`);
