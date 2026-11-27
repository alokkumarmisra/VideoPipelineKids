// Movie-specific character identity contracts. This module is deliberately
// independent of Director and the shared generation graph builders.
import { IMAGE_WORKFLOWS } from "./image_workflows.mjs";

export const IDENTITY_FIELDS = Object.freeze([
  "age", "gender_presentation", "height", "body_type", "skin_tone",
  "facial_structure", "eye_shape_color", "nose_shape", "lips", "jawline",
  "hairstyle", "hair_color", "distinguishing_features",
]);

export function normalizeMovieCharacter(input = {}, previous = {}) {
  const name = String(input.name ?? previous.name ?? "").trim();
  if (!name) throw new Error("Character name is required");
  return {
    name,
    identity: Object.fromEntries(IDENTITY_FIELDS.map((key) => [key,
      String(input.identity?.[key] ?? previous.identity?.[key] ?? "").trim()])),
    personality: String(input.personality ?? previous.personality ?? "").trim(),
    background: String(input.background ?? previous.background ?? "").trim(),
    voice_profile: String(input.voice_profile ?? previous.voice_profile ?? "").trim(),
    relationships: Array.isArray(input.relationships) ? input.relationships : (previous.relationships ?? []),
    description: String(input.description ?? previous.description ?? "").trim(),
  };
}

export function buildMovieReferencePacket({ movieId, character, costume = null, expression = "Neutral", state = {}, shot = {} }) {
  if (!character || character.approval_status !== "approved" || !character.canonical_reference_id) {
    throw new Error(`Character ${character?.character_id ?? "(unknown)"} has no approved canonical identity reference`);
  }
  const approved = (character.references ?? []).filter((ref) => ref.status === "approved" && Number(ref.identity_version) === Number(character.identity_version));
  const canonical = approved.find((ref) => ref.reference_id === character.canonical_reference_id);
  if (!canonical?.file_path) throw new Error("Approved canonical reference file is missing");
  const role = (name) => approved.filter((ref) => ref.view === name).map((ref) => ref.file_path);
  const angle = String(shot.camera_angle ?? shot.camera?.angle ?? "").toLowerCase();
  const profileView = /left/.test(angle) ? "left_profile" : /right/.test(angle) ? "right_profile" : /three.?quarter|3\/4/.test(angle) ? "three_quarter" : "";
  const profile = profileView ? approved.find((ref) => ref.view === profileView) : null;
  const bodyReferences = [...role("full_body_front"), ...role("full_body_side"), ...role("full_body_back")];
  return {
    movie_id: movieId,
    character_id: character.character_id,
    character_name: character.name,
    identity_version: character.identity_version,
    canonical_face_reference: canonical.file_path,
    face_profile_references: [...role("left_profile"), ...role("right_profile"), ...role("three_quarter")],
    face_profile_reference: profile?.file_path ?? null,
    face_profile_view: profile?.view ?? null,
    body_references: bodyReferences,
    body_reference: bodyReferences[0] ?? null,
    costume_id: costume?.costume_id ?? null,
    costume_reference: costume?.reference_path ?? null,
    expression,
    character_state: state,
    shot_action: shot.action ?? "",
    camera: shot.camera ?? {
      angle: shot.camera_angle ?? "",
      movement: shot.camera_movement ?? "",
      shot_size: shot.shot_size ?? "",
    },
  };
}

const mentionKey = (value) => String(value ?? "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const containsMention = (text, phrase) => {
  const haystack = ` ${mentionKey(text)} `, needle = mentionKey(phrase);
  return !!needle && haystack.includes(` ${needle} `);
};

/** Resolve only explicitly named movie locations and objects; never substitute a fuzzy match. */
export function resolveMovieEnvironmentAssets({ assets = [], scene = {}, shot = {} }) {
  const locationText = String(scene.location || "");
  const objectText = [scene.title, scene.location, scene.summary, scene.continuity_start, scene.continuity_end,
    scene.state_snapshots, shot.action, shot.body_movement, shot.expression, shot.emotion, shot.dialogue,
    shot.composition, shot.continuity].filter(Boolean).map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" ");
  const resolveKind = (kind, text) => {
    const matches = [], aliasOwners = new Map();
    for (const asset of assets.filter((row) => row.kind === kind)) {
      const aliases = [asset.name, ...(Array.isArray(asset.aliases) ? asset.aliases : [])].map(mentionKey).filter(Boolean);
      const found = aliases.filter((alias) => containsMention(text, alias));
      if (found.length) matches.push(asset);
      for (const alias of found) aliasOwners.set(alias, [...(aliasOwners.get(alias) || []), asset]);
    }
    const ambiguous = [...aliasOwners].filter(([, owners]) => new Set(owners.map((asset) => asset.asset_id)).size > 1).map(([alias]) => alias);
    return { matches, ambiguous };
  };
  const locations = resolveKind("location", locationText), objects = resolveKind("object", objectText);
  return {
    locations: locations.matches,
    objects: objects.matches,
    ambiguous: {
      locations: locations.ambiguous.length || locations.matches.length < 2 ? locations.ambiguous : locations.matches.map((asset) => asset.name),
      objects: objects.ambiguous,
    },
  };
}

// The checked-in registry describes workflow metadata only. Installed model
// and node capabilities are reported unknown until ComfyUI inventory is read.
export function movieCapabilityRegistry() {
  return Object.values(IMAGE_WORKFLOWS).map((workflow) => ({
    model_name: workflow.model,
    model_type: "image",
    image_reference_support: workflow.id === "flux" ? "yes — the base graph has one image input; Movie adds a ReferenceLatent input for each approved character/reference image" : "no — this graph has no image input",
    identity_conditioning: workflow.id === "flux" ? "multiple chained ReferenceLatent inputs; not face-specific identity conditioning" : "none in this graph",
    multiple_reference_support: workflow.id === "flux" ? "yes — Movie chains one ReferenceLatent anchor per character/reference image" : "no",
    video_reference_support: "not applicable — image-only workflow; video model support is not inferred",
    resolution: `${workflow.width}x${workflow.height}`,
    workflow: workflow.id,
    limitations: workflow.id === "flux"
      ? "Movie can chain multiple ReferenceLatent image anchors, but they are not face-specific and do not guarantee exact identity or prevent feature blending. No face-ID score is provided."
      : "Text-only workflow; cannot condition on the approved canonical reference.",
  }));
}

export function buildMovieKeyframePrompt({ character, characters = null, costume = null, state = {}, shot = {}, scene = {}, locations = [], objects = [] }) {
  const cast = Array.isArray(characters) ? characters : character ? [{ character, costume, state }] : [];
  if ((!cast.length && !locations.length && !objects.length) || cast.some(({ character: item }) => !item || item.approval_status !== "approved" || !item.identity_locked || !item.canonical_reference_id)) {
    throw new Error("Keyframe generation requires at least one locked, approved character, location, or object reference; every assigned character must have an approved canonical face reference");
  }
  const stateText = (value) => Object.entries(value || {}).filter(([, item]) => item != null && item !== "" && (!Array.isArray(item) || item.length))
    .map(([key, item]) => `${key.replaceAll("_", " ")}: ${Array.isArray(item) ? item.join(", ") : item}`).join("; ");
  const characterBlocks = cast.map(({ character: item, costume: outfit = null, state: characterState = state, secondary_reference_type = "" }) => {
    const identity = Object.entries(item.identity || {}).filter(([, value]) => String(value || "").trim())
      .map(([key, value]) => `${key.replaceAll("_", " ")}: ${value}`).join("; ");
    const currentState = stateText(characterState);
    return [
      `CHARACTER ${item.character_id} — ${item.name || item.character_id}. Match this character only to that character's supplied canonical face reference${item.identity_version ? ` (identity version ${item.identity_version})` : ""}. Preserve this person's face and appearance: ${identity || "follow the approved canonical reference"}. Do not transfer this character's face, hair, skin, or identifying marks to another character.`,
      secondary_reference_type ? `REFERENCE ORDER FOR ${item.character_id}: after the canonical face image, this character's approved ${secondary_reference_type} reference images follow in that order. Use profile views to preserve facial structure and angle; use costume/body views for wardrobe and proportions. Keep the same face identity anchored to the canonical image.` : "",
      outfit ? `COSTUME FOR ${item.character_id} (${item.name || item.character_id}) — ${outfit.costume_id}: ${outfit.name}. ${outfit.description} Color: ${outfit.color}. Fabric: ${outfit.fabric}. Accessories: ${outfit.accessories}.` : `Keep ${item.character_id}'s currently approved costume.`,
      currentState ? `CONTINUITY FOR ${item.character_id}: ${currentState}.` : "",
    ].filter(Boolean).join("\n");
  }).join("\n\n");
  const environmentBlocks = [
    ...locations.map((asset) => `LOCATION ${asset.asset_id} — ${asset.name} (identity version ${asset.identity_version}). Preserve the same geography, landmark placement, architecture, terrain, materials, colors, and recognizable layout from its approved reference. Description: ${asset.description || "follow the approved location reference"}.`),
    ...objects.map((asset) => `OBJECT ${asset.asset_id} — ${asset.name} (identity version ${asset.identity_version}). Keep the same shape, scale, materials, colors, markings, and wear from its approved reference. Description: ${asset.description || "follow the approved object reference"}. Do not duplicate, redesign, or replace it.`),
  ];
  return [
    cast.length ? `CHARACTER IDENTITY LOCK — Render every listed character as a separate, recognizable person. Match each character's face and appearance to that character's own reference; never merge, swap, duplicate, or transfer identities between them. Preserve age, face shape, eyes, nose, lips, jaw, skin tone, hair, body proportions, and identifying marks.\n\n${characterBlocks}` : "No registered movie characters are assigned to this establishing shot.",
    `SCENE ${scene.scene_number ?? ""} — ${scene.title ?? ""}. Location: ${scene.location ?? ""}. ${scene.summary ?? ""}`,
    `SHOT ACTION: ${shot.action ?? ""}. Body movement: ${shot.body_movement ?? ""}. Expression: ${shot.expression ?? ""}. Emotion: ${shot.emotion ?? ""}.`,
    `CAMERA: ${shot.shot_size ?? ""}, ${shot.camera_angle ?? ""}, ${shot.camera_movement ?? ""}. Composition: ${shot.composition ?? ""}. Lighting: ${shot.lighting ?? ""}.`,
    environmentBlocks.length ? `LOCATION AND OBJECT IDENTITY LOCK — These are the approved environment references, in graph order after the character references:\n${environmentBlocks.join("\n")}` : "",
    "Create one cinematic still keyframe. Keep each visible face readable and each character visually distinct. Keep each costume with its assigned character, and keep the approved location and object designs unchanged. Render only the described shot; do not add people, costume changes, scars, props, or story events.",
  ].filter(Boolean).join("\n");
}

/** Add one ReferenceLatent branch per supplied image and chain the conditioning. */
export function addMovieReferenceImages(graph, images) {
  const adapted = structuredClone(graph);
  const refs = Array.isArray(images) ? images.filter((item) => item?.image) : [];
  if (!refs.length) throw new Error("At least one approved character reference image is required");
  for (const id of ["75:75", "75:76", "75:77", "75:78"]) {
    if (!adapted[id]?.inputs) throw new Error(`The Flux graph is missing reference node ${id}`);
  }
  adapted["75:75"].inputs.image = refs[0].image;
  let priorConditioning = ["75:78", 0];
  for (let index = 1; index < refs.length; index += 1) {
    const base = `movie_ref_${index + 1}`;
    const load = `${base}_load`, scale = `${base}_scale`, encode = `${base}_encode`, anchor = `${base}_anchor`;
    adapted[load] = { class_type: "LoadImage", inputs: { image: refs[index].image } };
    adapted[scale] = { class_type: "ImageScaleToTotalPixels", inputs: { image: [load, 0], upscale_method: "lanczos", megapixels: 1, resolution_steps: 1 } };
    adapted[encode] = { class_type: "VAEEncode", inputs: { pixels: [scale, 0], vae: ["75:72", 0] } };
    adapted[anchor] = { class_type: "ReferenceLatent", inputs: { conditioning: priorConditioning, latent: [encode, 0] } };
    priorConditioning = [anchor, 0];
  }
  adapted["75:63"].inputs.positive = priorConditioning;
  return adapted;
}

/** Movie-only compatibility shim for the installed ComfyUI node schema. */
export function adaptMovieReferenceGraph(graph, resolutionSteps = 1) {
  const adapted = structuredClone(graph);
  const node = adapted?.["75:76"];
  if (node?.class_type !== "ImageScaleToTotalPixels" || !node.inputs) {
    throw new Error("The Flux reference graph changed: expected ImageScaleToTotalPixels at node 75:76");
  }
  node.inputs.resolution_steps = Math.max(1, Math.floor(Number(resolutionSteps) || 1));
  return adapted;
}
