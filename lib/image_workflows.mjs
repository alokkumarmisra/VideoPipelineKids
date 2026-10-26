// Image workflow registry — the ONE place that maps a workflow id to the
// ComfyUI graph that runs it, the model behind it, its default resolution and
// its default sampler steps.
//
// The header dropdown (the "Main" image dropdown in the menu header) offers
// exactly these ids and the choice travels to EVERY image generation:
//   - the project pipeline  -> --image-mode <id>  (scripts/character_sequence*.mjs)
//   - the Devotional Library -> job.workflow      (scripts/devotional_reference.mjs)
//   - devotional project scenes -> job.workflow    (same pump)
//
// PURE module (no fs / env / network): frontend/server.mjs imports it safely.
// lib/comfy.mjs must NEVER be imported by the server (it exits without
// COMFY_BASE) — the graph builders live there, the table lives here.
export const IMAGE_WORKFLOWS = {
  // Flux 2 Klein (9B fp8) — the fast draft graph (workflows/TextToImage/flux-t2i.json).
  // "flux" is the ONLY mode that can anchor on an existing image (img2img).
  flux: {
    id: "flux",
    label: "Flux t2i",
    workflow: "flux-t2i",
    model: "flux-2-klein-9b-fp8",
    file: "TextToImage/flux-t2i.json",
    width: 1280,
    height: 768,
    steps: 4,
  },
  // Flux.1-dev GGUF (workflows/TextToImage/Flux_Text_to_image.json) — 20 steps
  // (cfg 1, euler/simple). Pure text-to-image: that graph has no image input.
  flux_text_image: {
    id: "flux_text_image",
    label: "Flux Text to Image",
    workflow: "flux_text_image",
    model: "flux1-dev-Q8_0.gguf",
    file: "TextToImage/Flux_Text_to_image.json",
    width: 960,
    height: 544,
    steps: 20,
  },
  // Flux.1-dev GGUF REFERENCE IMAGE graph
  // (workflows/TextToImage/Flux_REFERENCE_IMAGE.json) — the devotional
  // reference-image workflow: the same Flux.1-dev graph the user authored for
  // the library's reference stills. Pure text-to-image (no image input in
  // that graph either).
  // THE WORKFLOW IS USED EXACTLY AS AUTHORED: its own latent size
  // (EmptySD3LatentImage 1920x1024), its own 20 steps, its own guidance
  // (3.5), cfg 1 and its random seed. Nothing is overridden here — only the
  // prompt text changes. (The 9:16 cut is the one exception: it reuses the
  // cut's own canvas, like every other mode.)
  flux_reference_image: {
    id: "flux_reference_image",
    label: "Flux Reference Image",
    workflow: "flux_reference_image",
    model: "flux1-dev-Q8_0.gguf",
    file: "TextToImage/Flux_REFERENCE_IMAGE.json",
    width: 1920,
    height: 1024,
    steps: 20,
  },
};

export const IMAGE_WORKFLOW_IDS = Object.keys(IMAGE_WORKFLOWS);

// Older job/file rows carry the workflow FILE name ("flux-t2i") instead of a
// registry id — they still resolve to the same graph.
export const LEGACY_ALIASES = {
  "flux-t2i": "flux",
  "flux_text_to_image": "flux_text_image",
  "Flux_REFERENCE_IMAGE": "flux_reference_image",
};

// The Devotional Library renders every asset with the Flux Reference Image
// workflow unless the caller (the header dropdown) picks another one.
export const DEFAULT_IMAGE_WORKFLOW = "flux_reference_image";

/** Exact lookup (null for an unknown id). */
export function imageWorkflow(id) {
  const key = String(id ?? "").trim();
  return IMAGE_WORKFLOWS[key] ?? IMAGE_WORKFLOWS[LEGACY_ALIASES[key]] ?? null;
}

/** Lookup with a fallback — never returns null. */
export function resolveImageWorkflow(id, fallback = DEFAULT_IMAGE_WORKFLOW) {
  return imageWorkflow(id) ?? imageWorkflow(fallback) ?? IMAGE_WORKFLOWS.flux;
}

/** The id list the server accepts from a client (body.workflow). */
export function isImageWorkflowId(id) {
  return !!imageWorkflow(id);
}
