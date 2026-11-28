// AI Story Director — pure helpers (prompt building, schema, JSON
// reliability, board -> scenario mapping). No network, no fs: fully
// unit-testable. The LLM calls live in frontend/server.mjs and reuse the
// exact llama-server convention as the craft endpoints
// (model "local", chat_template_kwargs { enable_thinking: false }).
//
// Pipeline: story input -> bible call (analysis + characters + locations +
// objects) -> scene-batch calls (strict per-scene schema) ->
// approve (boardToScenario -> existing saveScenario -> existing workspace
// generation). Image/video/merge/progress/resume are 100% the existing
// character-sequence pipeline; the director only authors the scenario.
//
// The MEANING-AWARE layer (lib/semantics.mjs) is pure too: it analyses every
// source line (Hindi / English / Hinglish), turns the important verbs into
// visible actions, plans the camera from the narrative meaning and validates
// that a scene really shows its line. The import is one-way (semantics.mjs
// never imports this file) so there is no cycle.

import { buildSemanticContext, outputLanguageRule } from "./semantics.mjs";
import { assetVersionId } from "./asset_service.mjs";

/** True for an abstract opening that has not yet introduced a visible subject or place. */
export function isAbstractOpeningSource(lines, locations = []) {
  const opening = arr(lines).slice(0, 6).map((line) => str(line?.lyric_text ?? line?.text ?? line?.line ?? line)).join(" ").toLowerCase();
  if (!opening.trim()) return false;
  const abstract = /(?:नाम|भाव|शांति|शान्ति|भय|करुणा|शक्ति|अस्तित्व|अनंत|अनन्त|अंतहीन|समय|सृष्टि|चेतना|तत्व|महिमा|रहस्य|शांत|शान्त|आदि|असीम|cosmic|infinite|eternal|peace|compassion|awe|power|mystery|essence|existence|emotion|feeling)/u.test(opening);
  if (!abstract) return false;
  const knownPlace = arr(locations).some((place) => {
    const name = str(place?.name).trim();
    return name.length >= 3 && opening.includes(name.toLowerCase());
  });
  const concreteAction = /(?:बैठते|बैठा|बैठे|ध्यान में|चलता|चलती|चलते|नाचता|नाचती|नृत्य|तांडव|दौड़ता|दौड़ती|भागता|उतरता|उतरती|चढ़ता|चढ़ती|बजाता|बजाती|प्रकट होता|प्रकट होती|sits? |meditates?|walks?|dances?|runs?|descends?|climbs?|plays? |appears?)/u.test(opening);
  return !knownPlace && !concreteAction;
}

// Optional director prompt rules are editable in the app's Prompt Settings.
// The non-optional schema, asset-reference and anatomy contracts remain in
// code so user customization cannot make generated boards structurally unsafe.
export const DIRECTOR_PROMPT_RULES = [
  {
    id: "action_motion",
    scope: "director",
    title: "Separate action and motion",
    description: "Ask for the story event and its physical movement as distinct shot fields.",
    defaultEnabled: true,
    text: "Keep action and motion distinct: action = the story event; motion = the visible physical movement/change across the clip (ordered if multi-step). Name the moving character through the characters IDs/asset_refs; motion describes what that character does, not how they look. Use a restrained explicit motion even for mostly still shots only when supported by the scene.",
  },
  {
    id: "avoid_repetition",
    scope: "director",
    title: "Avoid repeated staging",
    description: "Reduce repeated location/action combinations across consecutive scenes.",
    defaultEnabled: true,
    text: "ANTI-REPEAT: no two scenes in this batch may share the same (location + action); every scene must advance its covered source lines. Avoid repeating the same staging from recent scenes unless the story explicitly calls for a refrain or repeated event.",
  },
  {
    id: "camera_variety",
    scope: "director",
    title: "Vary camera framing",
    description: "Append camera variety and movement guidance to the scene planner.",
    defaultEnabled: true,
    text: "Vary shot types and angles across consecutive scenes when the story supports it. Keep camera movement simple unless the story needs it; choose movement to clarify the action and never conflict with the approved timeline.",
  },
  {
    id: "location_selection",
    scope: "director",
    title: "Match locations to the story",
    description: "Change locations when the source moves; avoid carrying a previous setting into a new place.",
    defaultEnabled: true,
    text: "Choose each scene's location from its assigned source lines. Change location when the source moves somewhere new; reuse the previous location only when the source stays there. Use the exact location ID from the supplied list.",
  },
  {
    id: "story_relevant_props",
    scope: "director",
    title: "Use only story-relevant props",
    description: "Show objects when the current story supports them instead of forcing every library item into scenes.",
    defaultEnabled: true,
    text: "Select props that are visibly relevant to the current source lines. Show story-relevant objects where the narrative supports them, and do not insert unrelated props just to use the library. Keep every object in the objects field or asset_refs.objects, never in a location field.",
  },
  {
    id: "prompt_concision",
    scope: "director",
    title: "Keep prompts concise",
    description: "Reduce repeated or overlong image and video prompt prose.",
    defaultEnabled: true,
    text: "Keep image and video prompts concise and specific to this scene or shot. Avoid repeating the same identity, action, setting, or motion detail.",
  },
  {
    id: "devotional_visuals",
    scope: "director",
    title: "Devotional visual symbolism",
    description: "Append this direction when the selected genre is devotional or mythological.",
    defaultEnabled: true,
    text: "For devotional lines, use respectful Indian-mythological symbolism: divine power protecting devotees, never flat literal or modern imagery.",
  },
  {
    id: "kids_clear_action",
    scope: "kids",
    title: "One clear action per Kids scene",
    description: "Keep each scene readable for the selected age group.",
    defaultEnabled: true,
    text: "Give each scene one clear, concrete action that a preschool-age viewer can follow. Avoid combining several unrelated actions in one scene.",
  },
  {
    id: "kids_gentle_camera",
    scope: "kids",
    title: "Gentle Kids camera movement",
    description: "Avoid fast or disorienting camera moves in Kids plans.",
    defaultEnabled: true,
    text: "Use gentle camera movement such as Static, Slow Push-In, or a gentle Pan. Avoid whip moves and fast cuts.",
  },
  {
    id: "kids_learning_visuals",
    scope: "kids",
    title: "Make learning visuals exact",
    description: "Preserve exact letterforms and counts in educational scenes.",
    defaultEnabled: true,
    text: "For alphabet content, show the requested letterform large and clearly. For counting content, depict the exact requested count; never add or omit countable items.",
  },
  {
    id: "kids_self_contained_prompts",
    scope: "kids",
    title: "Self-contained Kids image prompts",
    description: "Make each scene prompt understandable on its own.",
    defaultEnabled: true,
    text: "Every scene image prompt must be self-contained: identify who is on screen, where they are, what they do, and the mood.",
  },
  {
    id: "documentary_visual_variety",
    scope: "documentary",
    title: "Vary documentary shot grammar",
    description: "Avoid repetitive compositions and follow narration changes.",
    defaultEnabled: true,
    text: "Vary shot grammar in response to the narration. Avoid repetitive compositions; use a different visual approach when the narration changes subject, action, or scale.",
  },
  {
    id: "documentary_historical_accuracy",
    scope: "documentary",
    title: "Avoid anachronisms",
    description: "Keep modern objects out of historical or ancient settings.",
    defaultEnabled: true,
    text: "Do not place modern objects, clothing, architecture, or technology in ancient or historical scenes unless the source explicitly calls for them.",
  },
];

export function normalizeDirectorPromptSettings(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const inputRules = source.rules && typeof source.rules === "object" ? source.rules : {};
  const rules = {};
  for (const definition of DIRECTOR_PROMPT_RULES) {
    const value = inputRules[definition.id] && typeof inputRules[definition.id] === "object" ? inputRules[definition.id] : {};
    rules[definition.id] = {
      enabled: typeof value.enabled === "boolean" ? value.enabled : definition.defaultEnabled,
      text: typeof value.text === "string" ? value.text.slice(0, 4000) : definition.text,
    };
  }
  const custom = source.custom && typeof source.custom === "object" ? source.custom : {};
  return {
    rules,
    custom: {
      enabled: custom.enabled === true,
      text: typeof custom.text === "string" ? custom.text.slice(0, 4000) : "",
    },
  };
}

export function promptAddonsForWorkflow(raw = {}, scope = "director") {
  const settings = normalizeDirectorPromptSettings(raw);
  const blocks = DIRECTOR_PROMPT_RULES
    .filter((rule) => rule.scope === scope && settings.rules[rule.id].enabled && settings.rules[rule.id].text.trim())
    .map((rule) => `${rule.title.toUpperCase()}:\n${settings.rules[rule.id].text.trim()}`);
  if (settings.custom.enabled && settings.custom.text.trim()) blocks.push(`CUSTOM WORKFLOW INSTRUCTIONS:\n${settings.custom.text.trim()}`);
  return blocks.length ? `OPTIONAL PROMPT ADD-ONS (selected in Prompt Settings for this workflow):\n${blocks.join("\n\n")}` : "";
}

export const directorPromptAddons = (raw = {}) => promptAddonsForWorkflow(raw, "director");
export const kidsPromptAddons = (raw = {}) => promptAddonsForWorkflow(raw, "kids");
export const documentaryPromptAddons = (raw = {}) => promptAddonsForWorkflow(raw, "documentary");

export const SCENE_BATCH = 20;
// User-selectable planning batch size: the AI Story Director UI dropdown runs
// SCENE_BATCH_MIN..SCENE_BATCH_MAX, and the server default batch when the user
// has not chosen one is SCENE_BATCH. SCENE_BATCH_MAX is the largest batch a
// user can pick (the old silent planner ceiling); MAX_SCENES below is only the
// runaway-board safety ceiling (see its comment).
export const SCENE_BATCH_MIN = 1;
export const SCENE_BATCH_MAX = 20;
// Safety ceiling only (prevents runaway 1000+ scene boards from a 3600s
// custom target at 1s/scene). The plan itself is purely story + time driven:
// sceneCount = round(targetSeconds / sceneSeconds), never clamped to a small
// fixed number.
export const MAX_SCENES = 300;

// Target duration / scene duration -> scene count. Deterministic (the AI
// distributes beats across exactly N scenes rather than inventing a count).
// Purely story + time driven: round(target / scene), with only the MAX_SCENES
// safety ceiling above.
export function sceneCountFor(targetSeconds, sceneSeconds) {
  const t = Number(targetSeconds);
  const s = Number(sceneSeconds);
  if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(s) || s <= 0) return 0;
  return Math.min(MAX_SCENES, Math.max(1, Math.round(t / s)));
}

const STYLE_LOCKS = {
  "3D Preschool Animation":
    "Colorful 3D preschool animation, cute rounded characters, big expressive eyes, warm lighting, clean simple backgrounds, soft cinematic rendering",
  "3D Cinematic":
    "High-end 3D cinematic animation, detailed characters, dramatic lighting, rich textures, film-quality rendering",
  Realistic:
    "Ultra photorealistic highly detailed 8k uhd cinematic film still, natural skin texture, detailed expressive eyes, sharp focus, intricate details, realistic lighting and shadows, volumetric lighting, rich colors, shallow depth of field, no cartoon, no painting, no illustration, no blur",
  Anime:
    "Vibrant anime style, clean cel shading, expressive large eyes, dynamic composition, detailed backgrounds",
  Cartoon:
    "Classic 2D cartoon style, bold outlines, bright flat colors, playful squash-and-stretch feel",
  "Indian Mythological":
    "Ultra photorealistic Indian mythological cinematic film still, highly detailed 8k uhd, divine glowing palette, lifelike faces with natural skin texture and detailed expressive eyes, ornate traditional costumes and jewelry with intricate fabric detail, volumetric temple lighting, sharp focus, epic realistic backgrounds, no cartoon, no painting, no illustration, no blur",
  Fantasy:
    "Epic fantasy illustration style, magical glowing accents, lush detailed environments, cinematic atmosphere",
};

// Universal image-quality lock: every keyframe renders 8k + highly clear +
// undistorted, whatever the visual style (cartoon stays cartoon-styled, but
// sharp and well-formed). Enforced server-side in boardToScenario so a
// forgetful model cannot drop it.
export const QUALITY_IMAGE_LOCK =
  "ultra-detailed 8k uhd, highly clear, sharp focus, intricate details, professional cinematic lighting, no distortion, no distorted faces, no deformed faces, no extra limbs, no missing limbs, no blurry, no low quality, no watermark";

/** Append the quality lock unless the prompt already carries it. */
export function withQualityLock(prompt) {
  const t = String(prompt || "").trim();
  if (!t) return QUALITY_IMAGE_LOCK;
  return /8k uhd|ultra-detailed 8k|highly clear/i.test(t) && /no distortion|no distorted/i.test(t)
    ? t
    : `${t}, ${QUALITY_IMAGE_LOCK}`;
}

// Species body-plan integrity: image models invent legs/ears for limbless
// characters (seen on real snake boards) whenever the identity prompt only
// hints at the absence ("none ears" buried in a comma list is ignored) or
// the staged action implies limbs ("walks", "dances", "waves hands").
// The per-character lock below states the exclusion EXPLICITLY
// ("no legs, no arms, ...") and is enforced server-side in boardToScenario
// (image prompts + reference) so a forgetful model cannot drop it — the same
// pattern as the quality/style locks. Funny/cute styling stays allowed, but
// only within the species' real body plan: essential parts stay, extra parts
// are forbidden.
// Matches species names/identities of limbless serpentine characters
// (transliterations like saanp/saamp included — LLM species fields vary).
export const LIMBLESS_SPECIES_RE = /snake|serpent|python|cobra|viper|anaconda|worm|eel|saan?p|sapoo|साँप|सांप|नाग|केंचुआ|इल/i;
// Species naming legged animals — never limbless, even if the species string
// itself got polluted with a pasted snake template (poisoned-bible guard).
export const LEGGED_SPECIES_RE = /dog|puppy|pup\b|cat|kitten|bird|parrot|sparrow|duck|human|child|children|kid|boy|girl|man|woman|baby|toddler|rabbit|hare|lion|tiger|elephant|buffalo|hippo|rhino|monkey|horse|cow|bear|wolf|fox|deer|goat|sheep|frog|mouse|rat|squirrel|कुत्त|बिल्ली|चिड़िया|पक्षी|बतख|बच्च|लड़का|लड़की|इंसान|खरगोश|शेर|बाघ|हाथी|भैंस|घोड़ा|गाय|भालू|बंदर|हिरण|बकरी|भेड़|मेंढक|चूहा/i;

/** Explicit anatomy exclusion for one bible character, or null when the
 * species needs no special lock (other boards pass through untouched,
 * so legacy boardToScenario output stays byte-identical). */
export function anatomyLockFor(c) {
  const o = c && typeof c === "object" ? c : {};
  const app = o.appearance && typeof o.appearance === "object" ? o.appearance : {};
  const hay = [str(o.species), str(o.name), ...Object.values(app).map((v) => str(v)), str(o.visual_identity_prompt)].join(" ");
  // Poisoned-bible guard: a species naming a legged animal is NEVER limbless,
  // even when a latched model pasted "serpentine / no legs" into its species
  // string (seen on a real dog board). The lock refuses to cement the poison
  // at approve time; validateBibleAnatomy flags the bible for repair.
  if (LEGGED_SPECIES_RE.test(hay)) return null;
  const limbless = LIMBLESS_SPECIES_RE.test(str(o.species)) || /limbless serpentine/i.test(hay);
  const earless = /^\s*none\s*$/i.test(str(app.ears)) || /no(nes?)?\s+ears?|none\s+ears?/i.test(hay);
  if (!limbless && !earless) return null;
  const bits = [];
  if (limbless) bits.push("limbless serpentine snake body: one continuous elongated smooth coiled body, no legs, no arms, no hands, no feet, no wings");
  if (earless) bits.push("no ears, no external ears");
  bits.push(limbless ? "anatomically correct snake, no extra limbs, no extra body parts" : "anatomically correct, no extra limbs, no extra body parts");
  return bits.join(", ");
}

/** Append each character's anatomy lock unless the prompt already carries
 * it. Idempotent; prompts without limbless/earless cast are returned as-is. */
export function withAnatomyLock(prompt, chars) {
  let t = String(prompt || "");
  for (const c of arr(chars)) {
    const lock = anatomyLockFor(c);
    if (!lock) continue;
    const probe = lock.slice(0, 24).toLowerCase();
    if (probe && !t.toLowerCase().includes(probe)) t = t ? `${t}, ${lock}` : lock;
  }
  return t;
}

// Bible-level anatomy sanity: flags legged characters whose body plan got
// the limbless-snake template (the latched-model failure seen on a real dog
// board — dog, children AND bird all recorded "limbless serpentine, no
// legs", which scenes then paste verbatim). Also flags wrong SKIN COVERING:
// fur on scaled/feathered/bare-skinned animals (snake/lizard/fish/turtle =
// scales, birds = feathers, elephant/buffalo/human = bare skin) and missing
// fur on furry ones (lion/dog/cat/rabbit). Advisory warnings for the
// validate panel; Approve stays unblocked. Pure — unit-tested.
const SCALES_SPECIES_RE = /snake|serpent|python|cobra|viper|anaconda|lizard|gecko|chameleon|crocodil|alligator|turtle|tortoise|fish|shark|saan?p|साँप|सांप|नाग|छिपकल|गिरगिट|मगरमच्छ|कछुआ|मछली/i;
const FEATHERS_SPECIES_RE = /bird|parrot|sparrow|pigeon|duck|hen|rooster|peacock|eagle|owl|penguin|crow|dove|चिड़िया|पक्षी|तोता|गौरैया|कबूतर|बतख|मुर्ग|मोर|उल्लू|कौआ/i;
const BARESKIN_SPECIES_RE = /elephant|buffalo|hippo|rhino|human|child|children|kid|boy|girl|man|woman|baby|pig\b|boar|हाथी|भैंस|दरियाई घोड़ा|गैंडा|इंसान|बच्च|लड़का|लड़की|सूअर/i;
const FURRED_SPECIES_RE = /lion|tiger|dog|puppy|cat|kitten|rabbit|hare|bear|monkey|wolf|fox|deer|goat|sheep|mouse|rat|squirrel|शेर|बाघ|कुत्त|बिल्ली|खरगोश|भालू|बंदर|भेड़िया|लोमड़ी|हिरण|बकरी|भेड़|चूहा/i;
export function validateBibleAnatomy(blueprint) {
  const out = [];
  for (const c of arr(blueprint && blueprint.characters)) {
    const o = c && typeof c === "object" ? c : {};
    const app = o.appearance && typeof o.appearance === "object" ? o.appearance : {};
    const hay = [str(o.species), str(o.name), ...Object.values(app).map((v) => str(v)), str(o.visual_identity_prompt)].join(" ");
    const who = `Character "${str(o.name) || "?"}"`;
    const knownSpecies = `${str(o.species)} ${str(o.name)}`;
    if (LEGGED_SPECIES_RE.test(knownSpecies) && /limbless|serpentine/i.test(hay)) {
      out.push(`${who} is a legged animal but its body plan says limbless/serpentine — the bible latched onto the snake template. Re-analyze the story (or fix the character) and re-plan scenes; clips from this bible would render a snake.`);
      continue;
    }
    const sp = knownSpecies;
    const positive = hay.toLowerCase()
      .replace(/\b(?:no|never|without)\s+(?:any\s+)?(?:fur|feathers?|scales?)(?:\s+(?:or|and)\s+(?:fur|feathers?|scales?))*/g, "")
      .replace(/\b(?:furless|featherless|scaleless)\b/g, "");
    if (SCALES_SPECIES_RE.test(sp) && /fur|feather/i.test(positive)) {
      out.push(`${who} should have SCALES, but its description mentions fur/feathers — fix the covering before generating.`);
    } else if (FEATHERS_SPECIES_RE.test(sp) && /fur|scale/i.test(positive)) {
      out.push(`${who} should have FEATHERS, but its description mentions fur/scales — fix the covering before generating.`);
    } else if (BARESKIN_SPECIES_RE.test(sp) && /fur/i.test(positive)) {
      out.push(`${who} should have BARE SKIN, but its description mentions fur — fix the covering before generating.`);
    } else if (FURRED_SPECIES_RE.test(sp) && /no fur|fur none|furless|without fur|bare skin/i.test(hay)) {
      out.push(`${who} should have FUR, but its description says otherwise — fix the covering before generating.`);
    }
  }
  return out.slice(0, 8);
}

// Scene-level anatomy/covering check removed — scene prompts are
// plan-time text the user can review; no kids-scene gate railroads them.

// Strip connected-movie handoff language from a prompt (used when Connected
// is OFF so approved scenarios carry independent shots): removes
// "continuing from previous shot: ..." clauses and "seamless continuation
// from the previous shot's last frame ..." sentences, then tidies punctuation.
// Aggressive mode (default) also eats a multi-comma clause to the first
// period/end — safe at approve time, where context/style/quality are
// re-grounded right after. Conservative mode (server-side stored-board scrub)
// skips that pass so trailing style/context tokens in the saved prompt survive;
// approve-time stripping still neutralizes any paraphrased remainder.
export function stripContinuityText(prompt, { aggressive = true } = {}) {
  let t = String(prompt || "");
  // Long "continuing from previous shot: <clause>" first (clauses often hold
  // commas): consume to the first period or the end of the string. Exact
  // known-value removal happens before this in boardToScenario/the server
  // scrub; this generic pass is for paraphrased leftovers.
  if (aggressive) {
    t = t.replace(/,?\s*continuing from previous shot\s*:.*?(?=\.|$)/gi, "");
  }
  // Short-clause remainder (no commas): up to the next comma/period/end.
  t = t.replace(/,?\s*continuing from previous shot\s*:[^,.]*(?=[,.]|$)/gi, "");
  // Full chain sentence ("... last frame — hold the exact same character,
  // ..., no cut, no scene jump, smooth continuous motion forward"): commas
  // inside must not terminate the match, so consume up to the first period
  // or the end of the string.
  t = t.replace(/,?\s*seamless continuation from the previous shot's last frame\s*[—–-]\s*hold the exact same character[^.]*(\.|$)/gi, (m) =>
    /^\s*,/.test(m) ? "," : "");
  // Short/paraphrased variants without the em-dash sentence.
  t = t.replace(/,?\s*seamless continuation from the previous shot[^,.]*[,.]?/gi, (m) =>
    /^\s*,/.test(m) ? "," : "");
  return t.replace(/\s{2,}/g, " ").replace(/,\s*,/g, ",").replace(/\s+,/g, ",")
    .replace(/,\s*\./g, ".").trim().replace(/^[,.]+\s*/, "").replace(/\s*,+\s*$/, "");
}

// Motion fidelity lock appended server-side to every video (i2v) prompt so
// the clip only ANIMATES its own scene keyframe: the character, face,
// clothing, colors, lighting and background must stay exactly as the input
// image — at 8k clarity, never distorted/morphed/redesigned.
export const MOTION_FIDELITY_LOCK =
  "Keep the exact character, face, clothing, colors, lighting and background from the input image — do not redesign, restyle or change anything; animate natural motion only, highly clear 8k uhd quality, smooth natural motion, stable character and background, no distortion, no distorted faces, no deformed faces, no morphing, no flicker, no extra limbs, no blurry, no low quality";

// Short probe used to detect whether a motion prompt already carries the lock.
export function motionKeyFor() {
  return "animate natural motion only";
}

// Global style lock text appended server-side to every image prompt so no
// scene can drift off-style even if the model forgets it. A non-empty
// `masterPrompt` (the UI's editable Master Prompt, auto-filled from the
// style preset) wins over everything — the user's explicit text is the lock.
export function styleLockFor(visualStyle, customText, masterPrompt) {
  const mp = String(masterPrompt || "").trim();
  if (mp) return mp;
  if (visualStyle === "Custom") {
    const t = String(customText || "").trim();
    return t || "Consistent cinematic animation style, high detail";
  }
  return STYLE_LOCKS[visualStyle] || STYLE_LOCKS["3D Preschool Animation"];
}

// Short style key used to detect whether a prompt already carries the lock.
export function styleKeyFor(visualStyle, customText, masterPrompt) {
  const mp = String(masterPrompt || "").trim();
  if (mp) return mp.slice(0, 40);
  if (visualStyle === "Custom") return String(customText || "").trim().slice(0, 40) || "consistent style";
  return String(visualStyle || "").toLowerCase();
}

export const DIRECTOR_SYSTEM = `You are the AI Director of Sanskriti AI Studio, a professional film director.
Your job is to transform a user's story into a coherent visual movie.
You are not merely a prompt writer. Think like a filmmaker: understand the
complete story first, then convert important story events into visually
meaningful scenes. Do not blindly split paragraphs into scenes.
Work as an integrated production team before drafting each scene: the story
editor identifies the source meaning, subtext, emotional turn and chronology;
the director chooses the dramatic purpose, visible performance and blocking;
the cinematographer chooses framing, angle, composition, lighting and camera
movement to serve that purpose; the production designer grounds locations and
props in the source; the motion artist plans feasible subject and camera
movement from the keyframe; and the editor shapes pacing, continuity and the
transition to the next beat. Make these decisions concrete in the returned
scene and shot fields rather than returning generic role labels.
SOURCE AUTHORITY: the user's actual story/narration lines are the authority
for chronology and meaning. Generated summaries, bible descriptions, asset
references and later story events are supporting context only; they must not
override or pull later locations, actions, poses, or characters into an
earlier beat. A character named in voiceover is not automatically visible.
APPROVED ASSET RULE: whenever an approved reference asset is visibly present
in a scene or shot, attach its exact approved asset ID in that scene/shot's
asset_refs. Scene-level refs are the union of visible assets across its shots;
shot-level refs include only assets visible in that shot. Keep the bible ID
in characters/location/objects as requested and the approved asset ID in
asset_refs. Never omit an available reference for a depicted asset, and never
attach an asset whose subject is not visible (including abstract openings).
WORK ORDER: complete Phase 1 analysis of the full story and available audio
before any scene planning. Save the chronological story/bible analysis first.
Only then perform Phase 2 scene planning in successive duration-sized
batches, using the Phase 1 analysis as orientation and the exact source lines
and approved timing for each batch as the authority. Never plan scenes before
the analysis exists, and never treat an estimated timing window as measured.
Maintain strict CHARACTER CONSISTENCY, location consistency, object
consistency, visual style consistency and chronological continuity.
CHARACTER CONSISTENCY RULE: every scene's image_prompt MUST contain the
exact visual_identity_prompt verbatim for each character on screen —
copy-paste, never paraphrase, never shorten, never restyle.
CONTEXT RULE: every image_prompt is self-contained scene context — verbatim
character/location/object identities + the scene's action, expression,
body language, camera, lighting and environment. Never write a generic
prompt that could belong to any scene.
SAME-SCENE LINKAGE RULE: each scene's video_prompt animates THAT scene's
own keyframe image only — describe MOTION ONLY (what moves and how), never
looks, face, clothing, colors or style, so the clip keeps the keyframe's
character exactly instead of generating a different character.
QUALITY RULES (mandatory, every prompt): images are ultra-detailed 8k uhd,
highly clear, sharp focus — never distorted, deformed, blurry, low-quality
or watermarked (no distorted faces, no extra/missing limbs). Videos are
highly clear 8k uhd quality with smooth natural motion and a stable
character/background — never distorted, morphed, flickering or redesigned.
Never change an established character's face, body, species, clothing or
colors unless the story explicitly requires it. Keep every character's
species body plan exact — a snake is one continuous body without limbs;
funny/cute styling never adds body parts the species lacks. Stage only
physically possible actions (snakes slither, coil, wiggle, sway
rhythmically, bob the head, flick the tongue/tail — never walk, run, stand,
dance on legs, wave hands, or grow ears).
Never invent major plot
events that contradict the story; minor visual details for cinematic
presentation are allowed. Turn abstract emotions into visible actions
(happy -> smiling, jumping, clapping; sad -> lowered head, teary eyes;
surprised -> widened eyes, open mouth; angry -> tightened fists;
scared -> stepping backward, trembling; excited -> energetic movement).
Video prompts describe MOTION ONLY (what moves and how) — never looks,
face, clothing, colors or style, so clips animate the locked keyframe
without redesigning the character.
 LYRIC SEMANTIC MODE (song boards): one lyric line is NEVER automatically one
 scene. Deeply analyze every meaningful word/phrase of each line (subject,
 action, object, location, emotion, cause/effect, symbolism) and split the
 line into as many visual shots as its semantic complexity needs (1 for a
 simple line, up to ~5 for a line with several distinct actions/events) —
 never one shot per word, never a generic summary of the whole line. Every
 shot maps to a meaningful lyric segment and carries its lyric linkage
 (lyric_line_id, lyric_segment, semantic_meaning, visual_event, shot_id like
  "12-A", parent_line_id) plus a continuity decision (continuity_required +
  reference_source: NONE | CHARACTER_REFERENCE | LOCATION_REFERENCE |
  PREVIOUS_IMAGE | PREVIOUS_VIDEO_LAST_FRAME | MULTIPLE_REFERENCES). Prefer
  the previous shot's end state when the same character/location/action
  continues; set continuity_required false for fresh establishing shots.
  (When the batch brief orders INDEPENDENT SCENES, every shot uses
  continuity_required false + reference_source NONE instead.)
 Devotional lyrics get respectful Indian-mythological symbolism, never flat
 literal or modern readings.
 MULTI-SHOT SCENES (songs AND stories): when one lyric line or story sentence
 covers several distinct persons, objects or locations, NEVER cram them all
 into a single image. Split the scene into timed shots (2-5) INSIDE the same
 scene — one shot per entity or moment — each with its own segment text,
 cast, location, prompts and dialogue. Size every shot by pronounceable
 length (words in its segment + spoken lines: ~2.5 words/sec, Devanagari
 ~2.2 words/sec, +0.35s pause between lines) so the shot durations sum
 EXACTLY to the scene's duration_seconds, with cumulative boundaries from 0
 (shot 1: 0-1.4s, shot 2: 1.4-2.5s, ...). Single-entity scenes use exactly 1
 shot.
 DYNAMIC SCENE PLANNING: analyze the source LINE BY LINE, in order — you
 decide how many scenes the batch needs, where each scene starts/ends
 (line_from/line_to, covering every line, skipping none), each scene's own
 duration_seconds from content weight, and its shots. Never pad to a fixed
 scene count and never copy example durations — every duration comes from
 pronounceable length + action complexity.
Do not expose internal reasoning. Return ONLY valid JSON matching the
requested schema. No markdown fences, no commentary outside the JSON.
OUTPUT LANGUAGE (mandatory — obey strictly): write all story text, dialogue,
narration, titles, summaries and analysis in the requested LANGUAGE (Hindi =
Devanagari script, Hinglish = Latin-script Hindi mixed with English, English
= English only). Write all image/video generation prompts (image_prompt,
video_prompt, visual_identity_prompt) in English. NEVER write Chinese
(Simplified or Traditional), Japanese, Korean or any other language — NEVER
use Han characters, kana or hangul.`;

// Strip markdown fences / prose and return the first top-level JSON
// object (or array when allowArray). Throws with a useful message.
export function stripJson(text, { allowArray = false } = {}) {
  const t = String(text || "").trim();
  if (!t) throw new Error("LLM returned an empty response");
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const body = fence ? fence[1].trim() : t;
  const start = allowArray ? body.search(/[{[]/) : body.indexOf("{");
  if (start < 0) throw new Error("LLM returned no JSON object");
  const slice = body.slice(start);
  // Balanced scan from the first opener so trailing prose never corrupts
  // the parse (a greedy regex would swallow it and fail).
  const open = slice[0];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < slice.length; i++) {
    const c = slice[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0 && slice[0] === open && c === close) {
        const candidate = slice.slice(0, i + 1);
        try {
          return JSON.parse(candidate);
        } catch (e) {
          throw new Error(`LLM JSON parse failed: ${e.message}`);
        }
      }
    }
  }
  throw new Error("LLM JSON is truncated or unbalanced");
}

// Salvage complete scene objects from a batch response whose tail was cut
// off (model hit max_tokens / context mid-array). Scans the "scenes" array
// and JSON-parses each balanced {...} object; the trailing partial object
// is skipped, everything before it is kept. Returns [] when nothing usable
// exists. Pure — lets the server bind finished scenes instead of 500ing.
export function extractPartialScenes(text) {
  const t = String(text || "");
  const m = t.search(/"scenes"\s*:/);
  if (m < 0) return [];
  const arrStart = t.indexOf("[", m);
  if (arrStart < 0) return [];
  const out = [];
  let i = arrStart + 1;
  while (i < t.length) {
    while (i < t.length && /[\s,]/.test(t[i])) i++;
    if (i >= t.length || t[i] === "]") break;
    if (t[i] !== "{") { i++; continue; }
    let depth = 0;
    let inStr = false;
    let esc = false;
    let j = i;
    for (; j < t.length; j++) {
      const c = t[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) break; // truncated object — stop, keep what we have
    try {
      const obj = JSON.parse(t.slice(i, j + 1));
      if (obj && typeof obj === "object") out.push(obj);
    } catch { /* skip one corrupt object, continue with the next */ }
    i = j + 1;
  }
  return out;
}

const str = (v, fb = "") => (v == null ? fb : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);
// Bible-id-safe string: only string/number primitives survive — model output
// like objects/arrays in id slots would otherwise stringify to garbage refs
// ("[object Object]" characters seen on real boards) that match no bible
// entry and silently break identity grounding downstream.
const idStr = (v) => (typeof v === "string" || typeof v === "number" ? str(v).trim() : "");

// Pre-defined CHARACTER CONSISTENCY rules shipped by default for every
// character. The UI popup lets the user toggle/edit/reset these per
// character at any time (stored as character.consistency_rules).
export const DEFAULT_CHARACTER_CONSISTENCY_RULES = [
  "Keep the exact same face: shape, eyes, nose, lips, jawline and skin tone in every scene.",
  "Keep the exact same body, species traits and proportions in every scene.",
  "Keep the exact species body plan — never add legs, arms, hands, feet, ears, wings or human parts the species lacks; stage only physically possible actions.",
  "Keep the exact same clothing, colors and accessories unless the story explicitly changes them.",
  "Paste the visual_identity_prompt verbatim into every image_prompt — never paraphrase or shorten it.",
  "Keep the same art style and rendering for this character across all scenes.",
  "Stage speaking scenes front-facing so the face stays clearly visible.",
];

// Effective rules for one character: stored custom rules win, otherwise the
// pre-defined defaults (so old boards without the field get defaults too).
export function characterConsistencyRules(c) {
  const o = c && typeof c === "object" ? c : {};
  if (Array.isArray(o.consistency_rules)) {
    return o.consistency_rules.map((x) => str(x)).filter(Boolean);
  }
  return [...DEFAULT_CHARACTER_CONSISTENCY_RULES];
}

// Normalize one bible character (missing keys become empty, never crash).
// Ids derive from the name when absent so references stay stable/readable.
const slugId = (v, fb) => str(v, fb).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || fb;
export function normalizeCharacter(c, i) {
  const o = c && typeof c === "object" ? c : {};
  const app = o.appearance && typeof o.appearance === "object" ? o.appearance : {};
  const clo = o.clothing && typeof o.clothing === "object" ? o.clothing : {};
  return {
    character_id: slugId(o.character_id || o.name, `character_${i + 1}`),
    name: str(o.name, `Character ${i + 1}`),
    role: str(o.role, "supporting"),
    species: str(o.species),
    age: str(o.age),
    appearance: Object.fromEntries(Object.entries(app).map(([k, v]) => [k, str(v)])),
    clothing: Object.fromEntries(Object.entries(clo).map(([k, v]) => [k, str(v)])),
    personality: arr(o.personality).map((x) => str(x)).filter(Boolean),
    visual_identity_prompt: str(o.visual_identity_prompt),
    consistency_rules: characterConsistencyRules(o),
  };
}

export function normalizeLocation(l, i) {
  const o = l && typeof l === "object" ? l : {};
  return {
    location_id: slugId(o.location_id || o.name, `location_${i + 1}`),
    name: str(o.name, `Location ${i + 1}`),
    description: str(o.description),
    visual_identity_prompt: str(o.visual_identity_prompt),
    time_of_day: str(o.time_of_day),
    lighting: str(o.lighting),
    color_palette: str(o.color_palette),
  };
}

export function normalizeObject(ob, i) {
  const o = ob && typeof ob === "object" ? ob : {};
  return {
    object_id: slugId(o.object_id || o.name, `object_${i + 1}`),
    name: str(o.name, `Object ${i + 1}`),
    description: str(o.description),
    visual_identity_prompt: str(o.visual_identity_prompt),
  };
}

// Normalize the bible-call payload into a strict blueprint. The legacy
// `beats` field is retained only when reading older saved boards; new bible
// prompts do not request it and scene planning never consumes it.
export function normalizeBlueprint(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const a = o.analysis && typeof o.analysis === "object" ? o.analysis : {};
  return {
    logline: str(o.logline),
    analysis: {
      plot: str(a.plot),
      beginning: str(a.beginning),
      middle: str(a.middle),
      climax: str(a.climax),
      ending: str(a.ending),
      main_character: str(a.main_character),
      supporting_characters: arr(a.supporting_characters).map((x) => str(x)).filter(Boolean),
      antagonist: a.antagonist == null ? null : str(a.antagonist),
      objects: arr(a.objects).map((x) => str(x)).filter(Boolean),
      locations: arr(a.locations).map((x) => str(x)).filter(Boolean),
      events: arr(a.events).map((x) => str(x)).filter(Boolean),
      relationships: str(a.relationships),
      emotional_progression: str(a.emotional_progression),
      timeline: str(a.timeline),
      visual_moments: arr(a.visual_moments).map((x) => str(x)).filter(Boolean),
    },
    characters: arr(o.characters).map(normalizeCharacter),
    locations: arr(o.locations).map(normalizeLocation),
    objects: arr(o.objects).map(normalizeObject),
    // Song-mode lyric decomposition (bible call): one entry per lyric line
    // with its semantic analysis + planned shot count. Empty on story boards.
    lyric_lines: arr(o.lyric_lines).map(normalizeLyricLine),
    beats: arr(o.beats).map((b, i) => {
      const x = b && typeof b === "object" ? b : {};
      // Legacy saved-board field only; new scene planning uses the source
      // lines and bible asset registry directly.
      const beatObjs = arr(x.objects).map((y) => idStr(y)).filter(Boolean).slice(0, 6);
      const out = { n: Number(x.n) || i + 1, title: str(x.title, `Beat ${i + 1}`), summary: str(x.summary) };
      if (idStr(x.location)) out.location = idStr(x.location);
      if (beatObjs.length) out.objects = beatObjs;
      return out;
    }),
  };
}

// Which beats does a scene range cover? Proportional mapping so every batch
// plans only its own share of the story: scene i (1-based) of N total maps
// to beat floor((i-1) * B / N). A batch covering scenes [start, start+count)
// gets beats [floor((start-1)*B/N), ceil((start+count-1)*B/N)) — at least one.
// Without this every batch saw ALL beats and re-planned the opening, which is
// what produced the same dialogue line copied across dozens of scenes.
export function beatsForSceneRange(beats, startNumber, count, totalScenes) {
  const list = arr(beats);
  if (!list.length) return [];
  const n = Math.max(1, Number(totalScenes) || list.length);
  const start = Math.max(1, Number(startNumber) || 1);
  const c = Math.max(1, Number(count) || 1);
  const from = Math.min(list.length - 1, Math.floor(((start - 1) * list.length) / n));
  const to = Math.min(list.length, Math.max(from + 1, Math.ceil(((start + c - 1) * list.length) / n)));
  return list.slice(Math.max(0, from), to);
}

// True when two dialogue lines are the same text (case/space/punctuation
// insensitive) — used to drop LLM repeats, never to merge distinct lines.
export function sameLine(a, b) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\u0900-\u097f]+/g, " ").trim();
  const x = norm(a);
  const y = norm(b);
  return !!x && x === y;
}

// Valid reference sources for the continuity decision (§7–8 of the lyric
// plan). NONE = fresh shot (e.g. an establishing aerial after a close-up).
export const REFERENCE_SOURCES = [
  "NONE",
  "CHARACTER_REFERENCE",
  "LOCATION_REFERENCE",
  "PREVIOUS_IMAGE",
  "PREVIOUS_VIDEO_LAST_FRAME",
  "MULTIPLE_REFERENCES",
];

export function normalizeReferenceSource(v) {
  const t = String(v || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  return REFERENCE_SOURCES.includes(t) ? t : "NONE";
}

// Lyric lines for coverage/scoring (spec §3/§12): the bible decomposition
// when present; otherwise the song's pasted lines (song boards whose bible
// predates lyric_lines). Story boards have no lyric lines — coverage is
// trivially complete there. Pure — shared by the coverage/validate/repair
// routes so all three agree.
export function boardLyricLines(board) {
  const b = board && typeof board === "object" ? board : {};
  const bp = b.blueprint && b.blueprint.lyric_lines;
  if (Array.isArray(bp) && bp.length) return bp;
  if (b.input && b.input.song) return parseLyricLines(b.input.story);
  return [];
}
// Split pasted lyrics into numbered singable lines. Section headers
// ("[Verse 1]", "Chorus:", "(Bridge)" ...) and blank lines are dropped —
// only actual lyric text gets an id. Pasted formatting is tolerated:
// markdown-bold headers ("**[Chorus]**"), "# " headings and trailing emojis
// ("बाय-बाय! 🎵") are cleaned so headers never become phantom lyric lines
// and pictographs never leak into bible/prompts. Pure + deterministic.
const LYRIC_EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{2060}]/gu;
export function parseLyricLines(story) {
  const out = [];
  for (const raw of String(story || "").split("\n")) {
    // Unwrap pasted markdown: "**[Verse 1]**" -> "[Verse 1]", "## Chorus" ->
    // "Chorus" — BEFORE the header tests so formatted headers still drop.
    // Bold markers are stripped globally (a "**a** and **b**" line keeps both
    // halves); single * / _ are left alone as possible lyric text.
    const line = raw.trim()
      .replace(/^(#{1,4}\s+)/, "")
      .replace(/\*\*/g, "")
      .replace(/__/g, "")
      .trim();
    if (!line) continue;
    if (/^\[.*\]$/.test(line)) continue; // [Verse 1], [Chorus], ...
    if (/^\(.*\)$/.test(line) && line.length < 40) continue; // (Bridge) ...
    if (/^(verse|chorus|bridge|intro|outro|pre[-\s]?chorus|hook|refrain)\s*[:\d.\s-]*$/i.test(line)) continue;
    // Strip emojis/pictographs (variation selectors + ZWJ included) —
    // Devanagari letters and dandas are untouched.
    const text = line.replace(LYRIC_EMOJI_RE, "").replace(/[ \t]+/g, " ").trim();
    if (!text) continue; // emoji-only line (e.g. a "🎵" bar)
    out.push({ lyric_line_id: out.length + 1, lyric_text: text });
  }
  return out;
}

// Lines whose estimated window overlaps [fromSec, toSec) — the source slice
// one planning batch must cover line by line. Pure. Windows come from
// estimateLyricTiming (songs) or the same word-proportional estimate over
// story lines; boundaries touch (>= from, < to, plus any line straddling
// the start so no line is ever skipped between batches).
export function linesForTimeWindow(timedLines, fromSec, toSec) {
  const list = arr(timedLines);
  const from = Number(fromSec);
  const to = Number(toSec);
  if (!list.length || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  return list.filter((l) => {
    const s = Number(l.song_start_time);
    const e = Number(l.song_end_time);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return false;
    return e > from && s < to;
  });
}

// Verify an AI-declared plan completion (trust-but-verify: small models emit
// complete=true mid-story, which once shrank a 100-scene plan to 7 scenes at
// 33s of a 300s target). Complete only when the last source line is covered
// (max line_to / lyric linkage across scenes >= total lines) AND the planned
// seconds reach the target (within tolerance). Without the flag, completion
// is purely timeline-driven. Pure — unit-tested, used by the server loop.
export function verifyPlanComplete(scenes, { targetSeconds = null, totalLines = 0, flag = false } = {}) {
  const list = arr(scenes);
  if (!list.length) return false;
  const target = Number(targetSeconds);
  const hasTarget = Number.isFinite(target) && target > 0;
  const prog = planProgress(list, hasTarget ? target : null);
  if (!flag) return prog.done;
  const maxCover = list.reduce((a, s) => {
    const cands = [Number(s.line_to), Number(s.line_from), Number(s.lyric_line_id), Number(s.parent_line_id)]
      .filter((v) => Number.isFinite(v) && v > 0);
    // Multi-shot scenes stage their line coverage per shot — the scene row
    // alone can under-report the true frontier, so scan shots too.
    for (const sh of arr(s && s.shots)) {
      for (const v of [Number(sh.parent_line_id), Number(sh.lyric_line_id)]) {
        if (Number.isFinite(v) && v > 0) cands.push(v);
      }
    }
    return cands.length ? Math.max(a, ...cands) : a;
  }, 0);
  const total = Number(totalLines);
  const coversEnd = !(total > 0) || maxCover >= total;
  const timeOk = !hasTarget || (target - prog.plannedSeconds) <= Math.max(2, target * 0.02);
  return coversEnd && timeOk;
}

// Planning progress in seconds: how much story time the planned scenes
// cover vs the target. Pure — the server loop uses it to stop when the
// timeline is covered (AI decides scene counts/durations dynamically).
export function planProgress(scenes, targetSeconds) {
  const list = arr(scenes);
  const target = Number(targetSeconds);
  const plannedSeconds = Math.round(list.reduce((a, s) => a + (Number(s.duration_seconds) || 0), 0) * 10) / 10;
  const remaining = Number.isFinite(target) && target > 0 ? Math.round((target - plannedSeconds) * 10) / 10 : null;
  return {
    plannedSeconds,
    remaining,
    done: remaining != null ? remaining <= 0 : false,
  };
}

// Distribute the song duration across lyric lines proportional to word
// count (denser lines take longer to sing). Returns the same lines with
// song_start_time / song_end_time (seconds, 1 decimal). Pure fallback for
// when no word/line timestamps exist — the LLM refines per-shot timing.
export function estimateLyricTiming(lines, totalSeconds) {
  const list = arr(lines).map((l) => (l && typeof l === "object" ? { ...l } : { lyric_text: str(l) }));
  const total = Number(totalSeconds);
  if (!list.length || !Number.isFinite(total) || total <= 0) return list;
  const weights = list.map((l) => Math.max(1, String(l.lyric_text || "").split(/\s+/).filter(Boolean).length));
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  let cursor = 0;
  return list.map((l, i) => {
    const dur = i === list.length - 1
      ? Math.round((total - cursor) * 10) / 10
      : Math.round(((weights[i] / sum) * total) * 10) / 10;
    const start = Math.round(cursor * 10) / 10;
    cursor += dur;
    return { ...l, song_start_time: start, song_end_time: Math.round(cursor * 10) / 10 };
  });
}

// Apply Whisper phrase windows to the matching source lyric lines. Timing is
// accepted only for a one-to-one segment/line mapping; a mismatch falls back
// to the word-proportional estimate instead of silently shifting lyrics.
export function timeLinesFromTranscript(lines, transcriptSegments, totalSeconds) {
  const source = arr(lines);
  const segments = arr(transcriptSegments);
  const total = Number(totalSeconds);
  if (!source.length || source.length !== segments.length || !Number.isFinite(total) || total <= 0) return [];
  const timed = source.map((line, i) => {
    const rawStart = Number(segments[i]?.start);
    const rawEnd = Number(segments[i]?.end);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawStart < 0 || rawEnd <= rawStart || rawStart > total + 1 || rawEnd > total + 1) return null;
    const start = Math.min(total, rawStart);
    const end = Math.min(total, rawEnd);
    if (end <= start) return null;
    return { ...line, song_start_time: start, song_end_time: end };
  });
  return timed.every(Boolean) ? timed : [];
}

// Normalize one lyric-line entry of the blueprint (bible call, song mode).
export function normalizeLyricLine(l, i) {
  const o = l && typeof l === "object" ? l : {};
  const id = Number(o.lyric_line_id) || i + 1;
  return {
    lyric_line_id: id,
    lyric_text: str(o.lyric_text || o.text),
    semantic_analysis: str(o.semantic_analysis || o.meaning),
    visual_complexity: /^(low|medium|high)$/i.test(str(o.visual_complexity)) ? str(o.visual_complexity).toLowerCase() : "medium",
    planned_shots: Math.min(5, Math.max(1, Math.round(Number(o.planned_shots) || 1))),
  };
}

// Final validation checklist (§21) as a pure function: returns an array of
// human-readable issue strings (empty = plan looks coherent). Non-blocking
// by design — the server logs these as warnings, never rejects a plan.
export function validateLyricPlan(scenes, lyricLines, totalSeconds) {
  const issues = [];
  const list = arr(scenes);
  const lines = arr(lyricLines);
  if (!list.length) return ["no scenes planned"];
  // 1–3. Every lyric line analyzed and visually represented.
  if (lines.length) {
    const covered = new Set();
    for (const s of list) {
      const id = Number(s.lyric_line_id ?? s.parent_line_id);
      if (Number.isFinite(id) && id > 0) covered.add(id);
    }
    for (const l of lines) {
      if (!covered.has(Number(l.lyric_line_id))) {
        issues.push(`lyric line ${l.lyric_line_id} has no visual shot: "${str(l.lyric_text).slice(0, 60)}"`);
      }
    }
  }
  // 4. Shot timing fits the song timeline.
  if (Number.isFinite(Number(totalSeconds)) && Number(totalSeconds) > 0) {
    const sum = list.reduce((a, s) => a + (Number(s.duration_seconds) || 0), 0);
    if (Math.abs(sum - Number(totalSeconds)) > Math.max(5, Number(totalSeconds) * 0.15)) {
      issues.push(`shot durations sum to ~${Math.round(sum)}s but the song is ~${Math.round(Number(totalSeconds))}s`);
    }
  }
  // 8–9. Continuity references point at real earlier shots.
  const shotIds = new Set(list.map((s) => str(s.shot_id)).filter(Boolean));
  for (const s of list) {
    const rs = normalizeReferenceSource(s.reference_source);
    if (s.continuity_required && rs === "NONE") {
      issues.push(`scene ${s.scene_number}: continuity_required but reference_source is NONE`);
    }
    for (const ref of arr(s.continuity_refs)) {
      if (ref && !shotIds.has(str(ref))) issues.push(`scene ${s.scene_number}: continuity_ref "${ref}" matches no shot_id`);
    }
  }
  // 9–10. Image and video prompts differ; video prompts carry motion.
  const MOTION_RE = /mov|pan|tilt|dolly|track|orbit|crane|zoom|walk|run|fly|dance|turn|nod|gestur|wav|blink|smile|flow|drift|rise|fall|sway|orbit|glid|camera|slow/i;
  for (const s of list) {
    if (str(s.image_prompt) && str(s.image_prompt) === str(s.video_prompt)) {
      issues.push(`scene ${s.scene_number}: image_prompt and video_prompt are identical`);
    }
    if (str(s.video_prompt) && !MOTION_RE.test(str(s.video_prompt))) {
      issues.push(`scene ${s.scene_number}: video_prompt describes no motion`);
    }
  }
  // 11. No exact-duplicate shots.
  const seenAct = new Set();
  for (const s of list) {
    const key = `${str(s.lyric_segment)}||${str(s.action)}`.toLowerCase();
    if (key.length > 6) {
      if (seenAct.has(key)) issues.push(`scene ${s.scene_number}: duplicates an earlier shot's segment+action`);
      else seenAct.add(key);
    }
  }
  // 12. Multi-shot scenes tile their duration; shot ids stay unique.
  const seenShotIds = new Set(list.map((s) => str(s.shot_id)).filter(Boolean));
  for (const s of list) {
    const shots = arr(s.shots);
    for (const sh of shots) {
      const id = str(sh.shot_id);
      if (id) {
        if (seenShotIds.has(id)) issues.push(`scene ${s.scene_number}: duplicate shot_id "${id}"`);
        else seenShotIds.add(id);
      }
    }
    if (shots.length > 1) {
      const sum = shots.reduce((a, x) => a + (Number(x.duration_seconds) || 0), 0);
      if (Math.abs(sum - (Number(s.duration_seconds) || 0)) > 0.2) {
        issues.push(`scene ${s.scene_number}: shots sum to ~${Math.round(sum * 10) / 10}s but the scene is ${s.duration_seconds}s`);
      }
    }
  }
  // 13. Consecutive scenes should advance the source lines, not re-cover
  // the same range (a batch re-planning the opening instead of continuing).
  // Deliberate refrains are NOT stalls: kids choruses repeat the same words
  // later in the song, so a backward jump to a range whose text matches an
  // EARLIER (non-adjacent) range word-for-word is an intentional refrain.
  // Only an exact repeat of the immediately previous range, or a backward
  // jump to different words, still flags. Story boards (no lyric text)
  // keep the old strict behaviour.
  const covered = [];
  for (const s of list) {
    const a = Number(s.line_from);
    const b = Number(s.line_to);
    if (Number.isFinite(a) && a > 0 && Number.isFinite(b) && b > 0) covered.push([s.scene_number, a, b]);
  }
  const lineText = new Map(arr(lines).map((l) => [Number(l.lyric_line_id), str(l.lyric_text || l.text)]));
  const rangeText = (a, b) => {
    const parts = [];
    for (let n = a; n <= b && parts.length < 80; n++) {
      const t = lineText.get(n);
      if (t == null) return null;
      parts.push(t);
    }
    return parts.join("\n");
  };
  for (let i = 1; i < covered.length; i++) {
    if (covered[i][1] <= covered[i - 1][1]) {
      const cur = rangeText(covered[i][1], covered[i][2]);
      const refrain = cur != null && covered.slice(0, Math.max(0, i - 1)).some(([, a, b]) => {
        const prev = rangeText(a, b);
        return prev != null && sameLine(cur, prev);
      });
      if (!refrain) {
        issues.push(`scene ${covered[i][0]}: re-covers lines ${covered[i][1]}–${covered[i][2]} already covered at scene ${covered[i - 1][0]} (plan stalls instead of advancing)`);
      }
    }
  }
  return issues;
}

// Story QA (§21) as a shared pure validator: the Story page and the
// server approve gate use the same checklist, so the client never passes a
// board the server would reject. Returns { errors, warnings } — errors block
// Approve, warnings are advisory. Never throws (garbage input yields errors).
export function validateStoryBoard(board) {
  const errors = [];
  const warnings = [];
  const b = board && typeof board === "object" ? board : {};
  const chars = arr(b.blueprint && b.blueprint.characters);
  const scenes = arr(b.scenes);
  const approvedAssetRows = arr(b.assetProduction && b.assetProduction.assets)
    .filter((a) => a && a.status === "approved" && a.reference);
  const approvedAssetKinds = new Map();
  for (const asset of approvedAssetRows) {
    approvedAssetKinds.set(str(asset.id), str(asset.type)); // stable legacy id
    approvedAssetKinds.set(str(asset.reference_id || assetVersionId(asset)), str(asset.type));
    for (const v of arr(asset.image_versions)) {
      if (v?.reference_id && v.reference) approvedAssetKinds.set(str(v.reference_id), str(asset.type));
    }
    for (const job of arr(b.assetProduction && b.assetProduction.jobs)) {
      if (job?.asset_id === asset.id && Number(job?.metadata?.version) > 0) {
        approvedAssetKinds.set(assetVersionId(asset, Number(job.metadata.version)), str(asset.type));
      }
    }
  }
  if (!b.blueprint) errors.push("No story analysis yet — press Analyze Story first.");
  if (!chars.length) errors.push("No characters in the registry — regenerate the analysis.");
  if (!scenes.length) errors.push("No scenes planned yet — press Generate Scenes.");
  if (!errors.length) {
    // Registry: stable ids + continuity canon (visual_identity_prompt).
    const ids = new Set();
    const names = new Map();
    chars.forEach((c, i) => {
      const o = c && typeof c === "object" ? c : {};
      const id = slugId(o.character_id || o.name, `character_${i + 1}`);
      const nm = str(o.name).trim().toLowerCase();
      if (id) ids.add(id);
      if (nm && !names.has(nm)) names.set(nm, id);
      if (!str(o.visual_identity_prompt).trim()) {
        warnings.push(`Character "${str(o.name, id)}" has no visual identity — appearance may drift between scenes.`);
      }
    });
    const normKey = (v) => str(v).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const known = (v) => {
      const k = normKey(v);
      return !k || ids.has(k) || names.has(str(v).trim().toLowerCase());
    };
    // Scene order: numbers unique and strictly increasing in plan order.
    const seenNums = new Set();
    let prevNum = 0;
    scenes.forEach((s, si) => {
      const label = `Scene ${s && s.scene_number ? s.scene_number : si + 1}`;
      const checkAssetRefs = (row, where) => {
        for (const issue of arr(row && row.asset_reference_issues)) errors.push(`${where}: ${str(issue)}`);
        const refs = row && row.asset_refs && typeof row.asset_refs === "object" ? row.asset_refs : {};
        for (const [key, kind] of [["characters", "character"], ["locations", "location"], ["objects", "object"]]) {
          for (const assetId of arr(refs[key])) {
            if (!approvedAssetKinds.has(str(assetId))) errors.push(`${where} references missing or unapproved asset ${str(assetId)}.`);
            else if (approvedAssetKinds.get(str(assetId)) !== kind) errors.push(`${where} uses ${str(assetId)} in the wrong asset category (expected ${kind}).`);
          }
        }
      };
      checkAssetRefs(s, label);
      const n = Number(s && s.scene_number);
      if (!Number.isFinite(n) || n <= 0) {
        errors.push(`${label} has no valid scene_number.`);
      } else {
        if (seenNums.has(n)) errors.push(`${label} reuses scene_number ${n} — plan order is ambiguous.`);
        seenNums.add(n);
        if (n <= prevNum) errors.push(`${label} is out of order (scene_number ${n} after ${prevNum}).`);
        prevNum = Math.max(prevNum, n);
      }
      for (const cid of arr(s && s.characters)) {
        if (!known(cid)) errors.push(`${label} references unknown character "${idStr(cid)}" (not in the registry).`);
      }
      for (const sh of arr(s && s.shots)) {
        checkAssetRefs(sh, `${label} shot ${str(sh && sh.shot_id)}`);
        for (const cid of arr(sh && sh.characters)) {
          if (!known(cid)) errors.push(`${label} shot ${str(sh.shot_id)} references unknown character "${idStr(cid)}".`);
        }
      }
    });
    // Dialogue: ownership (exactly one valid speaker), text, emotion,
    // expression; the same line under two speakers = multi-owner accident.
    const lineOwners = new Map();
    const normLine = (t) => str(t).toLowerCase().replace(/[^a-z0-9\u0900-\u097f]+/g, " ").trim();
    const checkDialogue = (dlg, where) => {
      arr(dlg).forEach((d, di) => {
        const at = `${where} dialogue ${di + 1}`;
        const o = d && typeof d === "object" ? d : {};
        const line = str(o.line).trim();
        const speaker = str(o.speaker).trim();
        if (!line) { errors.push(`${at} has no text.`); return; }
        if (!speaker) { errors.push(`${at} ("${line.slice(0, 40)}…") has no speaker.`); return; }
        if (!known(speaker)) {
          errors.push(`${at} speaker "${speaker}" is not a registered character.`);
          return;
        }
        if (!str(o.emotion).trim()) errors.push(`${at} (${speaker}) is missing emotion.`);
        if (!str(o.expression).trim()) errors.push(`${at} (${speaker}) is missing expression.`);
        const nl = normLine(line);
        if (nl) {
          const key = normKey(speaker);
          if (lineOwners.has(nl) && lineOwners.get(nl) !== `${where}::${key}` && lineOwners.get(nl).split("::")[1] !== key) {
            const [first] = lineOwners.get(nl).split("::");
            errors.push(`${at} repeats the line from ${first} under a different speaker — dialogue belongs to exactly one character.`);
          } else if (!lineOwners.has(nl)) {
            lineOwners.set(nl, `${where}::${key}`);
          } else if (lineOwners.get(nl).split("::")[0] === where) {
            warnings.push(`${at} repeats a line from the same scene — possible AI duplication.`);
          }
        }
      });
    };
    scenes.forEach((s, si) => {
      const label = `Scene ${s.scene_number || si + 1}`;
      checkDialogue(s.dialogue, label);
      arr(s.shots).forEach((sh) => {
        if (arr(sh.dialogue).length) checkDialogue(sh.dialogue, `${label} shot ${str(sh.shot_id)}`);
      });
    });
  }
  return { errors, warnings };
}

// Safe automatic repairs for validateStoryBoard errors: fills missing
// emotion/expression with neutral defaults, drops unknown character refs
// (mirroring canonicalizeSceneRefs) and empty dialogue lines, renumbers
// scenes 1..N in plan order. Returns { board, fixed } (fixed = notes shown
// to the user). Pure — the caller persists via PUT when fixed.length > 0.
export function autoFixStoryBoard(board) {
  const fixed = [];
  const b = board && typeof board === "object" ? board : {};
  const chars = arr(b.blueprint && b.blueprint.characters);
  const ids = new Set(chars.map((c, i) => {
    const o = c && typeof c === "object" ? c : {};
    return slugId(o.character_id || o.name, `character_${i + 1}`);
  }));
  const names = new Set(chars.map((c) => str(c && c.name).trim().toLowerCase()).filter(Boolean));
  const normKey = (v) => str(v).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const known = (v) => {
    const k = normKey(v);
    return k && (ids.has(k) || names.has(str(v).trim().toLowerCase()));
  };
  const fixDlg = (dlg, where) => {
    let changed = false;
    const out = arr(dlg).map((d) => {
      const o = d && typeof d === "object" ? { ...d } : {};
      if (!str(o.line).trim()) { changed = true; return null; }
      if (!str(o.emotion).trim()) { o.emotion = "neutral"; changed = true; fixed.push(`${where}: filled missing emotion with "neutral".`); }
      if (!str(o.expression).trim()) { o.expression = "calm, natural expression"; changed = true; fixed.push(`${where}: filled missing expression with a calm default.`); }
      if (o.speaker && !known(o.speaker)) { changed = true; fixed.push(`${where}: dropped dialogue by unknown speaker "${str(o.speaker)}".`); return null; }
      return o;
    }).filter(Boolean);
    return { out, changed };
  };
  const scenes = arr(b.scenes).map((s, si) => {
    const o = s && typeof s === "object" ? { ...s } : {};
    const label = `Scene ${o.scene_number || si + 1}`;
    const keptChars = arr(o.characters).filter((c) => known(c));
    if (keptChars.length !== arr(o.characters).length) {
      fixed.push(`${label}: dropped unknown character refs.`);
    }
    o.characters = keptChars;
    const r = fixDlg(o.dialogue, label);
    if (r.changed) o.dialogue = r.out;
    if (Array.isArray(o.shots)) {
      o.shots = o.shots.map((sh) => {
        const so = sh && typeof sh === "object" ? { ...sh } : {};
        so.characters = arr(so.characters).filter((c) => known(c));
        const sr = fixDlg(so.dialogue, `${label} shot ${str(so.shot_id)}`);
        if (sr.changed) so.dialogue = sr.out;
        return so;
      });
    }
    if (Number(o.scene_number) !== si + 1) {
      fixed.push(`${label}: renumbered to scene ${si + 1}.`);
      o.scene_number = si + 1;
    }
    return o;
  });
  return { board: { ...b, scenes }, fixed: [...new Set(fixed)] };
}

const CAMERA_DEFAULT = { shot_type: "Medium Shot", angle: "Eye Level", movement: "Static" };

// Normalize one scene: defaults for missing keys, enforced numbering and
// duration clamp. Style lock is appended by boardToScenario (single place).
// dialogue = [{ speaker (character_id), line (speakable text),
//   expression (facial expression while speaking, e.g. "wide happy smile"),
//   emotion (delivery feeling, e.g. "joyful"), pitch (voice pitch hint:
//   "low"|"medium"|"high") }] — voiced per character (Edge-TTS, rate/pitch
// shaped by expression/emotion in lib/tts.mjs) and lip-synced
// (Easy-Wav2lip) downstream; the clip length for the beat always grows to
// fit the spoken audio (estimateDialogueDuration pre-plan, exact wav after).
export function normalizeDialogue(d) {
  return arr(d).map((x) => {
    const o = x && typeof x === "object" ? x : {};
    const out = { speaker: slugId(idStr(o.speaker), ""), line: str(o.line) };
    const expr = str(o.expression).trim();
    const emo = str(o.emotion).trim();
    const pitch = str(o.pitch).trim().toLowerCase();
    if (expr) out.expression = expr.slice(0, 120);
    if (emo) out.emotion = emo.slice(0, 80);
    if (["low", "medium", "high"].includes(pitch)) out.pitch = pitch;
    return out;
  }).filter((x) => x.line.trim());
}
// Floor for one timed shot inside a multi-shot scene (seconds). Shots are
// sized by pronounceable length, never shorter than this.
export const MIN_SHOT_SECONDS = 0.5;

// Split a scene's total seconds across pronounceable segments (the shot
// timeline). Pure: word-count proportional (denser segments take longer —
// the same rule as estimateLyricTiming), each shot >= the floor
// (opts.minShotSeconds, default MIN_SHOT_SECONDS),
// 1-decimal timings that sum EXACTLY to the total (the last shot absorbs
// rounding). Missing/blank segments share evenly. Never throws — degenerate
// input yields even splits.
export function splitSceneTimeline(segments, totalSeconds, { minShotSeconds = MIN_SHOT_SECONDS } = {}) {
  const segs = arr(segments).map((x) =>
    str(x && typeof x === "object" ? (x.lyric_segment ?? x.segment ?? x.text ?? x.line ?? "") : x));
  const total = Number(totalSeconds);
  const k = segs.length;
  if (!k || !Number.isFinite(total) || total <= 0) return [];
  const weights = segs.map((t) => Math.max(1, t.split(/\s+/).filter(Boolean).length));
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  // Reserve the floor per shot first so tiny segments never vanish; split
  // only the remainder proportionally.
  const minShot = Number(minShotSeconds) > 0 ? Number(minShotSeconds) : MIN_SHOT_SECONDS;
  const floor = Math.min(minShot, total / k);
  const rest = Math.max(0, total - floor * k);
  let cursor = 0;
  return segs.map((t, i) => {
    let dur;
    if (i === k - 1) {
      dur = Math.round((total - cursor) * 10) / 10;
    } else {
      dur = Math.max(0.1, Math.round((floor + (weights[i] / sum) * rest) * 10) / 10);
    }
    const start = Math.round(cursor * 10) / 10;
    cursor = Math.round((cursor + dur) * 10) / 10;
    return { duration_seconds: dur, start_time: start, end_time: cursor };
  });
}

// Normalize one timed sub-shot (same prompt fields as a scene — a shot
// flattens to exactly one generation beat at approve time). Ids default to
// "<scene>-<letter>" (e.g. "7-A"); timings are repaired by normalizeShots,
// so a missing/garbage duration here never breaks the scene timeline.
export function normalizeShot(sh, sceneNumber, shotIdx) {
  const o = sh && typeof sh === "object" ? sh : {};
  const cam = o.camera && typeof o.camera === "object" ? o.camera : {};
  const letter = String.fromCharCode(65 + Math.max(0, shotIdx));
  const dur = Number(o.duration_seconds);
  const t0 = Number(o.start_time);
  const t1 = Number(o.end_time);
  const parentLine = Number(o.parent_line_id ?? o.lyric_line_id);
  return {
    shot_id: str(o.shot_id) || `${sceneNumber}-${letter}`,
    shot_number: Math.max(1, Math.round(Number(o.shot_number) || 0) || shotIdx + 1),
    lyric_segment: str(o.lyric_segment || o.segment),
    semantic_meaning: str(o.semantic_meaning || o.meaning),
    visual_event: str(o.visual_event),
    identity_free: o.identity_free === true,
    characters: castIdsOf(o.characters),
    objects: arr(o.objects ?? o.object_ids).map((x) => idStr(x)).filter(Boolean).slice(0, 12),
    asset_refs: normalizeAssetRefs(o.asset_refs),
    characters_detailed: arr(o.characters_detailed).map(normalizeCastEntry).filter(Boolean),
    dramatic_purpose: str(o.dramatic_purpose ?? o.dramaticPurpose).slice(0, 500),
    location: str(o.location),
    time_of_day: str(o.time_of_day),
    action: str(o.action),
    motion: str(o.motion),
    emotion: str(o.emotion),
    expression: str(o.expression),
    body_language: str(o.body_language),
    camera: {
      shot_type: str(cam.shot_type, CAMERA_DEFAULT.shot_type),
      angle: str(cam.angle, CAMERA_DEFAULT.angle),
      movement: str(cam.movement, CAMERA_DEFAULT.movement),
    },
    lighting: str(o.lighting),
    environment: str(o.environment),
    continuity_from_previous_scene: str(o.continuity_from_previous_scene),
    transition_to_next_scene: str(o.transition_to_next_scene),
    dialogue: normalizeDialogue(o.dialogue),
    image_prompt: str(o.image_prompt),
    video_prompt: str(o.video_prompt),
    duration_seconds: Number.isFinite(dur) && dur > 0 ? Math.min(30, dur) : NaN,
    start_time: Number.isFinite(t0) && t0 >= 0 ? Math.round(t0 * 10) / 10 : null,
    end_time: Number.isFinite(t1) && t1 > 0 ? Math.round(t1 * 10) / 10 : null,
    lyric_line_id: Number.isFinite(parentLine) && parentLine > 0 ? parentLine : null,
    parent_line_id: Number.isFinite(parentLine) && parentLine > 0 ? parentLine : null,
    lyric_text: str(o.lyric_text),
    song_start_time: null,
    song_end_time: null,
    continuity_required: o.continuity_required === true,
    reference_source: normalizeReferenceSource(o.reference_source),
    continuity_refs: arr(o.continuity_refs).map((x) => idStr(x)).filter(Boolean).slice(0, 4),
  };
}

function normalizeAssetRefs(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const list = (v) => arr(v).map((x) => str(typeof x === "object" ? (x.asset_id || x.id) : x).trim()).filter(Boolean).slice(0, 32);
  return { characters: list(o.characters), locations: list(o.locations), objects: list(o.objects) };
}

// Bible-id grounding for one normalized scene (+ its shots): resolve every
// characters/location entry against the bible (exact id OR display name,
// case-insensitive) and canonicalize to the id, so downstream grounding
// (boardToScenario's charById/locById lookups) actually hits. Repairs:
// - location naming an OBJECT (seen on real boards: "apple_tree" as the
//   scene location) moves to continuity_refs (so it still grounds the frame)
//   and the location is cleared to unknown rather than kept as a miss;
// - unknown character refs (hallucinated names, "children") are dropped —
//   keeping them would stage ungroundable faces no pipeline step can anchor;
// - unresolvable free-text locations are KEPT as-is (status quo) and
//   reported, since dropping them would genericize the background.
// Returns { scene, repairs } (repairs = human-readable notes, [] when clean).
// Pure — the server aggregates repairs into board.warn.
export function canonicalizeSceneRefs(s, blueprint) {
  const repairs = [];
  // Lossless moves (an object id parked in the wrong slot) are reported
  // here, NOT in repairs: they change nothing on screen, so they are
  // server-logged only and never raise the storyboard ⚠️ hint.
  const notes = [];
  const b = blueprint && typeof blueprint === "object" ? blueprint : {};
  const byIdName = (list, idKey) => {
    const m = new Map();
    for (const e of arr(list)) {
      if (!e || typeof e !== "object") continue;
      const id = idStr(e[idKey]);
      const name = str(e.name).trim().toLowerCase();
      if (id) {
        m.set(id.toLowerCase(), id);
        if (name && !m.has(name)) m.set(name, id);
      } else if (name && !m.has(name)) {
        m.set(name, str(e.name).trim());
      }
    }
    return m;
  };
  const chars = byIdName(b.characters, "character_id");
  const locs = byIdName(b.locations, "location_id");
  const objs = byIdName(b.objects, "object_id");
  const fixCast = (list, where, refs) => {
    const out = [];
    for (const c of arr(list)) {
      const key = idStr(c).toLowerCase();
      if (!key) continue; // artifact already filtered by normalize, belt-and-braces
      if (chars.has(key)) {
        out.push(chars.get(key));
      } else if (objs.has(key)) {
        // Bible object in the cast slot (the classic "flower"/"eyes" case):
        // not a person, but still staged — keep it visible instead of
        // dropping it, mirroring the location-slot repair below.
        const oid = objs.get(key);
        if (!refs.includes(oid) && refs.length < 4) refs.push(oid);
        notes.push(`${where}: "${idStr(c)}" is an object, not a character — moved to visible objects`);
      } else {
        repairs.push(`${where}: dropped unknown character "${idStr(c)}" (not in the bible)`);
      }
    }
    return out;
  };
  const fixLocation = (loc, where, refs) => {
    const key = str(loc).trim().toLowerCase();
    if (!key) return "";
    if (locs.has(key)) return locs.get(key);
    if (objs.has(key)) {
      const oid = objs.get(key);
      if (!refs.includes(oid) && refs.length < 4) refs.push(oid);
      notes.push(`${where}: "${str(loc).trim()}" is an object, not a location — moved to visible objects`);
      return "";
    }
    repairs.push(`${where}: unknown location "${str(loc).trim()}" kept as text (no bible match)`);
    return str(loc);
  };
  if (!Array.isArray(s.continuity_refs)) s.continuity_refs = [];
  s.characters = fixCast(s.characters, `scene ${s.scene_number}`, s.continuity_refs);
  s.location = fixLocation(s.location, `scene ${s.scene_number}`, s.continuity_refs);
  const fixObjects = (list, where) => {
    const out = [];
    for (const value of arr(list)) {
      const key = idStr(value).toLowerCase();
      if (!key) continue;
      if (objs.has(key)) {
        const id = objs.get(key);
        if (!out.includes(id)) out.push(id);
      } else repairs.push(`${where}: dropped unknown object "${idStr(value)}" (not in the bible)`);
    }
    return out.slice(0, 12);
  };
  s.objects = fixObjects(s.objects, `scene ${s.scene_number}`);
  for (const sh of arr(s.shots)) {
    if (!sh || typeof sh !== "object") continue;
    const tag = `shot ${sh.shot_id || `${s.scene_number}-?`}`;
    if (!Array.isArray(sh.continuity_refs)) sh.continuity_refs = [];
    sh.characters = fixCast(sh.characters, tag, sh.continuity_refs);
    sh.location = fixLocation(sh.location, tag, sh.continuity_refs);
    sh.objects = fixObjects(sh.objects, tag);
  }
  return { scene: s, repairs, notes };
}

// Drop exact-duplicate scenes (same normalized title + action — the "same
// scene generated twice" defect), keeping the first occurrence. Pure — the
// server applies it to each landed batch against the already-planned scenes
// and reports the count in board.warn instead of storing wasted scenes.
export function dedupeScenes(existing, incoming) {
  const keyOf = (s) => `${str(s.title).toLowerCase().replace(/\s+/g, " ").trim()}||${str(s.action).toLowerCase().replace(/\s+/g, " ").trim()}`;
  const seen = new Set(arr(existing).map(keyOf));
  const kept = [];
  let dropped = 0;
  for (const s of arr(incoming)) {
    const k = keyOf(s);
    if (k.length > 3 && seen.has(k)) {
      dropped++;
      continue;
    }
    seen.add(k);
    kept.push(s);
  }
  return { kept, dropped };
}

// Camera-only variation guard (pure, warning-only). Scenes whose source LINES
// differ must also differ in visible action/pose — changing shot_type/angle is
// not a new moment. This was observed on abstract narration boards: the same
// character identity was pasted into every prompt (mandatory) while the staged
// action/expression/body_language stayed identical and only the camera moved.
// The guard needs semantic fields on BOTH neighbours, so legacy boards keep
// their exact behaviour; it never drops a scene (dropping would leave a line
// uncovered) — it produces a visible ⚠️ note and feeds the existing repair.
export function flagRepeatStaging(scenes = []) {
  const rows = arr(scenes);
  const norm = (v) => str(v).toLowerCase().replace(/\s+/g, " ").trim();
  const hasSemantics = (s) => Boolean(s && typeof s === "object"
    && (Number(s.source_line_id) > 0 || norm(s.source_line))
    && norm(s.semantic_meaning));
  const lineKey = (s) => Number(s.source_line_id) > 0
    ? `id:${Math.round(Number(s.source_line_id))}`
    : `text:${norm(s.source_line)}`;
  const stagingKey = (s) => [
    norm(s.action), norm(s.expression), norm(s.body_language),
    arr(s.characters).map(norm).join(","), norm(s.location),
  ].join("||");
  const cameraKey = (s) => JSON.stringify(s.camera && typeof s.camera === "object" ? s.camera : {});
  const notes = [];
  let run = [];
  const flush = () => {
    if (run.length > 1 && new Set(run.map((r) => r.line)).size > 1) {
      const nums = run.map((r) => r.n);
      const label = nums.slice(0, 6).map((n) => `Scene ${n}`).join(", ")
        + (nums.length > 6 ? ` and ${nums.length - 6} more` : "");
      const cameras = new Set(run.map((r) => r.camera));
      notes.push(`${label} repeat the same staged action/pose for different source lines${cameras.size > 1 ? " — only the camera framing changes" : ""}; regenerate with distinct visible actions and dramatic purposes`);
    }
    run = [];
  };
  rows.forEach((s, i) => {
    if (!hasSemantics(s)) { flush(); return; }
    const key = stagingKey(s);
    if (!key.replace(/\|/g, "").trim()) { flush(); return; }
    const entry = {
      line: lineKey(s), camera: cameraKey(s),
      n: Number(s.scene_number) > 0 ? Math.round(Number(s.scene_number)) : i + 1,
    };
    if (run.length && run[run.length - 1].key === key) {
      run.push({ ...entry, key });
    } else {
      flush();
      run = [{ ...entry, key }];
    }
  });
  flush();
  return notes;
}

// Normalize a scene's shots so they tile duration_seconds EXACTLY (no gaps,
// no overlaps). When every AI timing is present and sums within tolerance,
// the lengths are trusted and only boundaries are re-derived cumulatively;
// otherwise durations are redistributed by pronounceable length via
// splitSceneTimeline. A shot under opts.minShotSeconds also forces
// redistribution. Empty/missing shots array -> [] (legacy
// single-image scenes normalize exactly as before).
export function normalizeShots(rawShots, sceneNumber, sceneTotal, { minShotSeconds = MIN_SHOT_SECONDS } = {}) {
  const minShot = Number(minShotSeconds) > 0 ? Number(minShotSeconds) : MIN_SHOT_SECONDS;
  const list = arr(rawShots);
  if (!list.length) return [];
  const total = Number.isFinite(Number(sceneTotal)) && Number(sceneTotal) > 0 ? Number(sceneTotal) : 3;
  const shots = list.slice(0, 8).map((sh, i) => normalizeShot(sh, sceneNumber, i));
  const valid = shots.every((x) => Number.isFinite(x.duration_seconds) && x.duration_seconds > 0);
  const sum = shots.reduce((a, x) => a + (Number.isFinite(x.duration_seconds) ? x.duration_seconds : 0), 0);
  const tiny = shots.some((x) => Number.isFinite(x.duration_seconds) && x.duration_seconds < minShot);
  const repair = tiny || !valid || Math.abs(sum - total) > Math.max(0.15, total * 0.05);
  const timeline = repair
    ? splitSceneTimeline(shots.map((x) => x.lyric_segment || x.visual_event || x.action), total, { minShotSeconds: minShot })
    : null;
  let cursor = 0;
  shots.forEach((x, i) => {
    const d = timeline
      ? timeline[i].duration_seconds
      : Math.max(0.1, Math.round(x.duration_seconds * 10) / 10);
    x.duration_seconds = d;
    x.start_time = Math.round(cursor * 10) / 10;
    cursor = Math.round((cursor + d) * 10) / 10;
    x.end_time = cursor;
  });
  // Absorb float dust into the last shot so the strip sums exactly.
  const dust = Math.round((total - cursor) * 10) / 10;
  if (shots.length && dust !== 0) {
    const last = shots[shots.length - 1];
    last.duration_seconds = Math.max(0.1, Math.round((last.duration_seconds + dust) * 10) / 10);
    last.end_time = Math.round((last.start_time + last.duration_seconds) * 10) / 10;
  }
  return shots;
}

export function normalizeScene(s, n, sceneSeconds, opts = {}) {
  const o = s && typeof s === "object" ? s : {};
  const cam = o.camera && typeof o.camera === "object" ? o.camera : {};
  const dur = Number(o.duration_seconds);
  // Lyric linkage: parent_line_id / lyric_line_id group the shots of one
  // lyric line (shot_id "12-A", shot_number 1..K). All optional — story
  // boards and old scenes normalize exactly as before.
  const parentLine = Number(o.parent_line_id ?? o.lyric_line_id);
  const shotNum = Math.max(1, Math.round(Number(o.shot_number) || 0) || 1);
  const t0 = Number(o.song_start_time);
  const t1 = Number(o.song_end_time);
  // Source-line coverage (line-by-line planning): which numbered story/lyric
  // lines this scene covers. Optional — old scenes normalize to null.
  const lf = Number(o.line_from);
  const lt = Number(o.line_to);
  // Timed sub-shots (multi-shot scenes). The scene total is authoritative:
  // shots always tile it exactly (see normalizeShots).
  const minScene = Number(opts && opts.minSceneSeconds) > 0 ? Math.min(30, Number(opts.minSceneSeconds)) : 1;
  const minShot = Number(opts && opts.minShotSeconds) > 0 ? Number(opts.minShotSeconds) : MIN_SHOT_SECONDS;
  const shotCount = Math.min(8, arr(o.shots).length);
  // Make the kids' shot floor feasible rather than silently weakening it:
  // a 5s scene cannot contain five 1.5s shots, so lengthen that scene to 7.5s.
  const feasibleSceneFloor = opts && Number(opts.minSceneSeconds) > 0
    ? Math.min(30, minShot * Math.max(1, shotCount))
    : minScene;
  const requested = Number.isFinite(dur) ? Math.round(dur) : (Number(sceneSeconds) || minScene);
  const baseDur = Math.min(30, Math.max(minScene, feasibleSceneFloor, requested));
  const rawShots = arr(o.shots);
  const sceneObjects = arr(o.objects ?? o.object_ids).map((x) => idStr(x)).filter(Boolean).slice(0, 12);
  const shots = normalizeShots(rawShots, n, baseDur, opts);
  shots.forEach((shot, i) => {
    const raw = rawShots[i] && typeof rawShots[i] === "object" ? rawShots[i] : {};
    if (!Array.isArray(raw.objects) && !Array.isArray(raw.object_ids)) shot.objects = [...sceneObjects];
  });
  const totalDur = shots.length
    ? Math.round(shots.reduce((a, x) => a + x.duration_seconds, 0) * 10) / 10
    : baseDur;
  return {
    scene_number: n,
    identity_free: o.identity_free === true,
    title: str(o.title, `Scene ${n}`),
    story_beat: str(o.story_beat),
    duration_seconds: totalDur,
    characters: castIdsOf(o.characters),
    asset_refs: normalizeAssetRefs(o.asset_refs),
    // Rich per-character direction (spec §5/§11): normalized objects with
    // role/emotion/gaze/action/state. [] on legacy scenes — string-id casts
    // keep working exactly as before via `characters` above.
    characters_detailed: arr(o.characters_detailed).map(normalizeCastEntry).filter(Boolean),
    // Dramatic purpose (spec §4/§11): why this shot exists. "" on legacy.
    dramatic_purpose: str(o.dramatic_purpose ?? o.dramaticPurpose).slice(0, 500),
    location: str(o.location),
    objects: sceneObjects,
    time_of_day: str(o.time_of_day),
    action: str(o.action),
    motion: str(o.motion),
    emotion: str(o.emotion),
    expression: str(o.expression),
    body_language: str(o.body_language),
    // Exact source narration assigned to this scene. Optional for legacy
    // boards and dialogue-first stories; kept alongside (not synthesized as)
    // character dialogue so narration-driven videos retain their script.
    narration: str(o.narration),
    camera: {
      shot_type: str(cam.shot_type, CAMERA_DEFAULT.shot_type),
      angle: str(cam.angle, CAMERA_DEFAULT.angle),
      movement: str(cam.movement, CAMERA_DEFAULT.movement),
    },
    lighting: str(o.lighting),
    environment: str(o.environment),
    continuity_from_previous_scene: str(o.continuity_from_previous_scene),
    transition_to_next_scene: str(o.transition_to_next_scene),
    dialogue: normalizeDialogue(o.dialogue),
    image_prompt: str(o.image_prompt),
    video_prompt: str(o.video_prompt),
    // Lyric-semantic shot fields (song boards; "" / defaults on story boards).
    lyric_line_id: Number.isFinite(parentLine) && parentLine > 0 ? parentLine : null,
    parent_line_id: Number.isFinite(parentLine) && parentLine > 0 ? parentLine : null,
    lyric_text: str(o.lyric_text),
    lyric_segment: str(o.lyric_segment),
    semantic_meaning: str(o.semantic_meaning || o.meaning),
    visual_event: str(o.visual_event),
    shot_id: str(o.shot_id) || null,
    shot_number: shotNum,
    song_start_time: Number.isFinite(t0) && t0 >= 0 ? Math.round(t0 * 10) / 10 : null,
    song_end_time: Number.isFinite(t1) && t1 > 0 ? Math.round(t1 * 10) / 10 : null,
    continuity_required: o.continuity_required === true,
    reference_source: normalizeReferenceSource(o.reference_source),
    continuity_refs: arr(o.continuity_refs).map((x) => idStr(x)).filter(Boolean).slice(0, 4),
    // Source-line coverage (line-by-line planning). Null on old scenes.
    line_from: Number.isFinite(lf) && lf > 0 ? Math.round(lf) : null,
    line_to: Number.isFinite(lt) && lt > 0 ? Math.round(lt) : null,
    // Meaning-aware direction (lib/semantics.mjs): the ORIGINAL source line,
    // its interpretation, the visible action plan, the camera rationale and
    // the timed beats. Every field is optional — a legacy scene (or a board
    // analysed before the semantic layer existed) normalizes exactly as before.
    source_line: str(o.source_line),
    source_line_id: Number.isFinite(Number(o.source_line_id)) && Number(o.source_line_id) > 0
      ? Math.round(Number(o.source_line_id)) : null,
    language: str(o.language),
    semantic_meaning: str(o.semantic_meaning),
    line_kind: str(o.line_kind),
    action_plan: arr(o.action_plan).map((a) => {
      const x = a && typeof a === "object" ? a : {};
      return {
        action: str(x.action).slice(0, 400),
        body_part: str(x.body_part).slice(0, 80),
        start_pose: str(x.start_pose).slice(0, 300),
        end_pose: str(x.end_pose).slice(0, 300),
        motion: str(x.motion).slice(0, 600),
        grounded: x.grounded !== false,
      };
    }).slice(0, 8),
    camera_rationale: str(o.camera_rationale).slice(0, 400),
    beats: arr(o.beats).map((b) => {
      const x = b && typeof b === "object" ? b : {};
      return {
        start_seconds: Number(x.start_seconds) || 0,
        end_seconds: Number(x.end_seconds) || 0,
        action: str(x.action).slice(0, 400),
        start_pose: str(x.start_pose).slice(0, 300),
        end_pose: str(x.end_pose).slice(0, 300),
        secondary: str(x.secondary).slice(0, 300),
        estimated: x.estimated !== false,
      };
    }).slice(0, 12),
    semantic_warnings: arr(o.semantic_warnings).map((w) => str(w).slice(0, 300)).slice(0, 10),
    // Timed sub-shots that tile duration_seconds exactly (see normalizeShots).
    // [] = legacy single-image scene (normalizes + approves exactly as before).
    shots,
  };
}

/** Store only scene direction on approved-asset boards. Full identities and
 * reference paths are resolved later by boardToScenario's prompt assembler. */
export function compactSceneGenerationDirections(scene) {
  const direction = (row, motion = false) => {
    const camera = row && row.camera && typeof row.camera === "object" ? row.camera : {};
    const pieces = motion
      ? [row.motion ? `Animate: ${row.motion}` : row.action && `Animate: ${row.action}`,
        row.motion && row.action && str(row.motion).trim() !== str(row.action).trim() ? `Action: ${row.action}` : "",
        row.body_language, row.expression,
        camera.movement && !/^(static|locked)$/i.test(str(camera.movement)) ? `${camera.movement} camera move` : ""]
      : [row.action && `Action: ${row.action}`, row.emotion && `Emotion: ${row.emotion}`,
        row.expression && `Expression: ${row.expression}`, row.body_language && `Body language: ${row.body_language}`,
        row.environment && `Setting: ${row.environment}`, row.lighting && `Lighting: ${row.lighting}`,
        [camera.shot_type, camera.angle, camera.movement].filter(Boolean).join(", ")];
    return pieces.map((piece) => str(piece)).filter(Boolean).join("; ").slice(0, 1400);
  };
  if (!scene || typeof scene !== "object") return scene;
  scene.image_prompt = direction(scene, false);
  scene.video_prompt = direction(scene, true);
  for (const shot of arr(scene.shots)) {
    shot.image_prompt = direction(shot, false) || scene.image_prompt;
    shot.video_prompt = direction(shot, true) || scene.video_prompt;
  }
  return scene;
}

// Compact identity strings: the only per-call context scenes need (§26 —
// never resend the whole story or full bible per batch).
export function identityContext(blueprint) {
  const b = blueprint || {};
  const chars = arr(b.characters).map((c) =>
    `- ${c.name} (${c.character_id}): ${c.visual_identity_prompt || describeFallback(c)}`).join("\n");
  const locs = arr(b.locations).map((l) =>
    `- ${l.name} (${l.location_id}): ${l.visual_identity_prompt || l.description}`).join("\n");
  const objs = arr(b.objects).map((o) =>
    `- ${o.name} (${o.object_id}): ${o.visual_identity_prompt || o.description}`).join("\n");
  return { chars, locs, objs };
}

function describeFallback(c) {
  const app = Object.entries(c.appearance || {}).map(([k, v]) => `${k}: ${v}`).join(", ");
  const clo = Object.entries(c.clothing || {}).map(([k, v]) => `${k}: ${v}`).join(", ");
  return [c.species, app, clo].filter(Boolean).join("; ");
}

// Per-character consistency rules context: the popup-editable rules that
// travel with the scene-batch + regen prompts so user edits actually steer
// the AI. Falls back to the pre-defined defaults for old boards.
export function consistencyRulesContext(blueprint) {
  return arr(blueprint && blueprint.characters)
    .map((c) => {
      const rules = characterConsistencyRules(c).filter(Boolean);
      if (!rules.length) return null;
      return `${c.name} (${c.character_id}):\n${rules.map((r) => `- ${r}`).join("\n")}`;
    })
    .filter(Boolean)
    .join("\n");
}

// Kids-content genres (rhymes, preschool/nursery, learning songs, storytelling
// for children): true for the Kids/Educational picks and Custom genres naming
// them — in English, Hinglish AND Hindi (Devanagari), since stories arrive
// in all three. Pure predicate — the Sanskriti Kids studio uses it for its
// plan/objective display; no engine prompt or gate branches on it.
export function isKidsGenre(genre, custom = "") {
  const g = `${String(genre || "")} ${String(custom || "")}`.toLowerCase();
  return /kid|preschool|pre-school|nursery|rhyme|toddler|children|learn|educat|story\s*time|bedtime|moral|panchatantra|bacho|bacch|lori|balgeet|ginti|akshar|बच्च|बाल|शिशु|नन्ह|लोरी|नर्सरी|अक्षर|वर्णमाला|गिनती|संख्या|जानवर|पशु|तुकबंदी|पंचतंत्र|नैतिक/.test(g);
}

// Bible-call user message (analysis + asset bible, compact by design). Song
// mode: when input.song is present ({ durationSeconds, fileName }),
// the "story" is song lyrics — the prompt asks for a music-video reading
// (verse/chorus structure -> visual arcs, lip-sync-free staging since no
// dialogue audio is generated, scenes paced to the exact song length).
export function buildBiblePrompt(input) {
  const song = input.song && typeof input.song === "object" ? input.song : null;
  const sourceAudio = input.sourceAudio && typeof input.sourceAudio === "object" ? input.sourceAudio : null;
  const songHeader = song ? [
    `SOURCE: SONG (music video — the final cut will play over the uploaded song audio)`,
    `SONG FILE: ${song.fileName || "(uploaded audio)"} · DURATION: ~${Math.round(Number(song.durationSeconds) || input.targetSeconds)} seconds`,
    song.hasLyrics === false
      ? `LYRICS: not provided — infer mood/structure from the title and invent a matching visual story (chorus = recurring visual motif, verses = story progression).`
      : null,
    input.songAnalysis ? `AUDIO ANALYSIS (use as context; measured facts are authoritative, do not invent additional measurements): ${JSON.stringify(input.songAnalysis).slice(0, 5000)}` : null,
  ] : [];
  const sourceAudioHeader = sourceAudio ? [
    `SOURCE AUDIO: SPOKEN NARRATION / DIALOGUE — ${sourceAudio.fileName || "uploaded audio"}, ~${Math.round(Number(sourceAudio.durationSeconds) || input.targetSeconds)} seconds. Preserve the transcript/story meaning and order. The original audio is an analysis source, not a music-video instruction.`,
    input.songAnalysis ? `AUDIO ANALYSIS (interpretive style plus measured facts; do not invent measurements): ${JSON.stringify(input.songAnalysis).slice(0, 5000)}` : null,
  ] : [];
  const lines = [
    `STORY TITLE: ${input.title}`,
    `LANGUAGE: ${input.language}`,
    `GENRE: ${input.genre}${input.genreCustom ? ` (${input.genreCustom})` : ""}`,
    `VISUAL STYLE: ${input.visualStyle}${input.visualStyle === "Custom" ? ` (${input.styleCustom})` : ""}`,
    `TARGET DURATION: ~${input.targetSeconds} seconds`,
    ...songHeader,
    ...sourceAudioHeader,
    ``,
    `WORK ORDER — PHASE 1 ONLY: analyze the complete story/narration and available audio before any storyboard is generated. Identify whether the source is a song or spoken narration from the supplied mode; analyze its full chronological arc, emotional progression, meaningful visual events, recurring motifs, characters, locations and props. Use the supplied audio duration as the total runtime. Use measured audio/transcript facts only when provided; otherwise mark timing as estimated and do not fabricate measurements. Return the analysis and asset bible in the requested schema; do not generate the scene batch in this phase.`,
    `STORY:`,
    input.story,
    ``,
    `PROFESSIONAL STORY ANALYSIS (mandatory): read the complete source before building the bible. Trace the actual opening, progression, turning point and ending in source order. Distinguish voiceover that names a person or expresses an abstract idea from narration that places that person on screen or gives them a visible action. Do not move a later setting or action into the opening. The source text outranks assumptions, genre conventions, generated summaries and character/location bibles. Do not invent plot or physical action to fill an abstract passage. For songs, preserve and analyze every lyric line in order. For spoken narration, preserve the narrator's meaning and chronology without turning it into character dialogue.`,
    ...(song && song.hasLyrics !== false && parseLyricLines(input.story).length
      ? [`LYRIC MODE: the STORY above is song lyrics. Add a "lyric_lines" array with one entry per lyric line:`,
        `{ "lyric_lines": [{ "lyric_line_id": 1, "lyric_text": "the exact line", "semantic_analysis": "subject, characters, actions, objects, location, emotion, cause/effect, symbolism — every meaningful word/phrase decoded, never a generic summary", "visual_complexity": "low|medium|high", "planned_shots": 1-5 }], ... }`,
        `Rule: 1 shot for a simple line, 2 for a moderately complex line, 3-5 for a line with several distinct actions/events (e.g. a line with mission-giving AND travel AND burning = multiple shots). Never one shot per word. Scene planning will follow the lyric order so every line gets visual coverage.`]
      : []),
    `Return JSON ONLY with this exact structure:`,
    `{ "logline": "...", "analysis": { "plot": "...", "beginning": "...", "middle": "...", "climax": "...", "ending": "...", "main_character": "...", "supporting_characters": ["..."], "antagonist": "... or null", "objects": ["..."], "locations": ["..."], "events": ["..."], "relationships": "...", "emotional_progression": "...", "timeline": "...", "visual_moments": ["..."] },`,
    `  "characters": [{ "character_id": "snake_case", "name": "...", "role": "main_character|supporting|antagonist", "species": "...", "age": "...", "appearance": { "body": "...", "fur": "...", "eyes": "...", "ears": "..." }, "clothing": { "top": "...", "bottom": "..." }, "personality": ["..."], "visual_identity_prompt": "STATIC portrait only: species + body + face + eyes + colors + clothing, comma-separated, no action, no pose, no scene, no emotion" }],`,
    `  "locations": [{ "location_id": "snake_case", "name": "...", "description": "...", "visual_identity_prompt": "one self-contained look prompt", "time_of_day": "...", "lighting": "...", "color_palette": "..." }],`,
    `  "objects": [{ "object_id": "snake_case", "name": "...", "description": "...", "visual_identity_prompt": "one self-contained look prompt" }] }`,
    `Register every character, location and object the source actually names or needs. Write every visual_identity_prompt so it can be pasted into an image prompt verbatim.`,
    // Anatomy integrity: the species body plan is recorded ONCE in the bible
    // and every scene batch then stages only actions that body can perform.
    // The rule is CONDITIONAL — the limbless template is for genuinely
    // limbless species only; a legged animal must never inherit it (a real
    // dog board once recorded "limbless serpentine body, no legs" for the
    // dog, the children AND a bird).
    `ANATOMY INTEGRITY RULE (mandatory): every character keeps its REAL species body plan in "species", "appearance" and "visual_identity_prompt".`,
    `- Limbless species ONLY (snake/serpent/worm/eel): write the limbless serpentine body ("one continuous elongated smooth body, no legs, no arms, no ears, no wings"). NEVER write legs, arms, hands, feet, ears or wings on such a character.`,
    `- For EVERY OTHER species: record its actual anatomy — the real number of legs/arms and the correct skin covering (fur / feathers / scales / bare skin exactly as that species has it). NEVER write "limbless", "serpentine", "no legs" or "no arms" for a legged character: copy the body plan that belongs to that species, never a template from another animal.`,
    input.instructions ? `DIRECTOR INSTRUCTIONS: ${input.instructions}` : null,
    outputLanguageRule(input.language),
  ];
  return lines.filter((l) => l !== null).join("\n");
}

// Scene-batch user message. The original source lines, bible identities,
// approved assets, timing and previous-scene continuity are the planning
// inputs. No pre-generated story-beat outline can override the source.
export function buildScenesPrompt({ input, blueprint, prevScene, startNumber, count, styleLock, totalScenes = null, priorDialogue = [], lyricLines = [], lyricTiming = [], lineRange = [], budgetSeconds = null, plannedSeconds = 0, targetSeconds = null, totalLines = null, compact = false, semantics = [], masterTimeline = null, cinematicContext = null, semanticVariationContext = null, approvedAssets = [], promptAddons = "" }) {
  const approvedById = new Map(arr(approvedAssets).map((a) => [str(a && a.blueprint_id), a]).filter(([id]) => id));
  const identityRows = (items, idKey, fallbackText) => arr(items).map((item) => {
    const id = str(item && item[idKey]);
    const approved = approvedById.get(id);
    return approved
      ? `- ${str(item.name)} (${id}; asset ${str(approved.id)}): approved asset — reference by asset id`
      : fallbackText(item);
  }).join("\n");
  const chars = identityRows(blueprint && blueprint.characters, "character_id", (c) => `- ${c.name} (${c.character_id}): ${c.visual_identity_prompt || describeFallback(c)}`);
  const locs = identityRows(blueprint && blueprint.locations, "location_id", (l) => `- ${l.name} (${l.location_id}): ${l.visual_identity_prompt || l.description}`);
  const objs = identityRows(blueprint && blueprint.objects, "object_id", (o) => `- ${o.name} (${o.object_id}): ${o.visual_identity_prompt || o.description}`);
  // Voice hints derived from THIS story's bible — never a hardcoded example
  // cast (a past "Rabbit Chiku / Lion Shera" example leaked those names and
  // voices into unrelated stories).
  const cast = arr(blueprint && blueprint.characters).map((c) => {
    const traits = [...arr(c.personality), str(c.role)].filter(Boolean).join(", ");
    return `${c.name} (${c.character_id})${traits ? ` — ${traits}` : ""}`;
  }).join("; ");
  const analysis = blueprint && blueprint.analysis && typeof blueprint.analysis === "object"
    ? blueprint.analysis : {};
  const arcRows = [
    ["Logline", blueprint && blueprint.logline],
    ["Plot", analysis.plot],
    ["Beginning", analysis.beginning],
    ["Middle", analysis.middle],
    ["Climax", analysis.climax],
    ["Ending", analysis.ending],
    ["Emotional progression", analysis.emotional_progression],
    ["Timeline", analysis.timeline],
  ].filter(([, value]) => str(value).trim()).map(([label, value]) => `- ${label}: ${str(value).trim().slice(0, 700)}`);
  const narrativeArcBlock = arcRows.length
    ? `PHASE 1 STORY ANALYSIS (whole-story orientation; source lines always win if a summary conflicts):\n${arcRows.join("\n")}`
    : null;
  // Valid id lists: the ONLY legal values for scene/shot characters/location
  // slots (exact ids — free text, display names and translations silently
  // break grounding downstream, so they are forbidden, not tolerated).
  const validCharIds = arr(blueprint && blueprint.characters).map((c) => str(c.character_id)).filter(Boolean);
  const validLocIds = arr(blueprint && blueprint.locations).map((l) => str(l.location_id)).filter(Boolean);
  const validObjIds = arr(blueprint && blueprint.objects).map((o) => str(o.object_id)).filter(Boolean);
  const assetRows = arr(approvedAssets).filter((a) => a && a.reference && a.status !== "skipped");
  const assetIds = (type) => assetRows.filter((a) => a.type === type)
    .map((a) => `${str(a.reference_id || assetVersionId(a))}=${str(a.name)} (v${Number(a.version) || 1})`).filter(Boolean);
  const assetExampleList = (type, fallback) => {
    const asset = assetRows.find((row) => row.type === type);
    if (asset) return `["${str(asset.reference_id || assetVersionId(asset))}"]`;
    return assetRows.length ? "[]" : `["${fallback}"]`;
  };
  const validIdsLine = (label, ids) => `${label}: ${ids.length ? ids.join(", ") : "(none)"}`;
  // Dialogue opt-out: input.includeDialogue === false means a silent film —
  // the model must emit "dialogue": [] on every scene (no voice, no lip-sync,
  // clips stay at their planned length). Default (true/undefined) = voiced.
  const wantDialogue = input.includeDialogue !== false;
  // Connected movie: input.chainContinuity === true means every scene visually
  // continues the previous shot's end state (same characters/location, matched
  // framing) via TEXT continuity carried in the prompts. Generation pixels
  // always stay per-scene (every keyframe anchors on the reference, every
  // clip animates its own keyframe) — chainContinuity never chains pixels.
  // When false/undefined, every scene is an independent fresh shot.
  const wantChain = input.chainContinuity === true;
  const used = arr(priorDialogue).map((x) => str(typeof x === "string" ? x : x.line)).filter(Boolean).slice(-40);
  const rulesCtx = consistencyRulesContext(blueprint);
  // Lyric-semantic mode: only for song boards with real lyric lines. Gives
  // the model the timed line list so shots map to lyric segments and their
  // durations sum to the song timeline.
  const timed = arr(lyricTiming).length ? arr(lyricTiming) : arr(lyricLines);
  // Lyric mode ONLY for song boards with real lyric lines — story boards
  // keep the lean pre-lyric prompt so batches stay small enough to parse.
  const lyricMode = timed.length > 0 && input.song && typeof input.song === "object" && input.song.hasLyrics !== false;
  // If compact mode, skip the full lyric analysis and use a simplified line list
  const effectiveLyricMode = compact ? false : lyricMode;
  // Line-by-line source slice for THIS batch (numbered story/lyric lines with
  // estimated song windows). The server slices the full line list to the
  // batch's time window; when absent we fall back to the full timed list
  // (songs) or nothing (stories) so old callers keep working.
  const lineSlice = compact ? arr(lineRange).slice(0, Math.min(arr(lineRange).length, 3)) : (arr(lineRange).length ? arr(lineRange) : timed);
  const abstractOpening = Number(startNumber) === 1 && isAbstractOpeningSource(lineSlice, blueprint && blueprint.locations);
  const lineNoOf = (l, i) => Number(l.lyric_line_id) || Number(l.line_id) || i + 1;
  const lineTextOf = (l) => str(l.lyric_text ?? l.text ?? l.line);
  const lineWinOf = (l) => (l.song_start_time != null && l.song_end_time != null
    ? ` [${l.song_start_time}s–${l.song_end_time}s]` : "");
  // Time budget for this batch (seconds of story it must cover). Falls back
  // to count × sceneSeconds so old callers without pacing info keep working.
  const perScene = Math.max(1, Number(input.sceneSeconds) || 3);
  const budget = Number.isFinite(Number(budgetSeconds)) && Number(budgetSeconds) > 0
    ? Math.round(Number(budgetSeconds) * 10) / 10
    : Math.round(count * perScene * 10) / 10;
  const planned = Math.max(0, Math.round(Number(plannedSeconds) * 10) / 10 || 0);
  const target = Number.isFinite(Number(targetSeconds)) && Number(targetSeconds) > 0
    ? Math.round(Number(targetSeconds)) : null;
  // Hard batch scope: which lines this batch owns out of how many total.
  // Stated explicitly because models otherwise plan past their window and
  // declare the story complete mid-way (complete=true is verified
  // server-side by coverage + timeline — see verifyPlanComplete).
  const totalN = Number.isFinite(Number(totalLines)) && Number(totalLines) > 0 ? Math.round(Number(totalLines)) : null;
  const firstN = lineSlice.length ? lineNoOf(lineSlice[0], 0) : null;
  const lastN = lineSlice.length ? lineNoOf(lineSlice[lineSlice.length - 1], lineSlice.length - 1) : null;
  const scopeLine = lineSlice.length && firstN != null && lastN != null
    ? (totalN != null
      ? `SCOPE: lines ${firstN}–${lastN} of ${totalN} total. Cover ONLY these lines — NEVER plan beyond line ${lastN}. Set "complete": true ONLY if line ${totalN} (the LAST line) is covered AND the story truly ends here; otherwise "complete": false.`
      : `SCOPE: lines ${firstN}–${lastN}. Cover ONLY these lines — NEVER plan beyond line ${lastN}. Set "complete": false (the story continues after this batch).`)
    : null;
  // Previous-scene bridge (EVERY batch, connected or not): a slim reminder
  // of what just happened so the batch continues the story forward instead
  // of restarting it. The full end-state JSON stays chain-only (visual
  // continuation needs framing detail; story understanding needs one line).
  const prevChars = prevScene
    ? arr(prevScene.characters).map((c) => str(typeof c === "string" ? c : (c.character_id || c.name))).filter(Boolean).join(", ") : "";
  const prevLastLine = prevScene && Array.isArray(prevScene.dialogue) && prevScene.dialogue.length
    ? (() => { const d = prevScene.dialogue[prevScene.dialogue.length - 1] || {}; return str(d.speaker || d.line) ? `${str(d.speaker)}: ${str(d.line).slice(0, 120)}` : ""; })() : "";
  const prevSummaryLine = prevScene && typeof prevScene === "object"
    ? `PREVIOUS SCENE (what just happened — continue the story FORWARD from here, never repeat or restart it): Scene ${Number(prevScene.scene_number) || Math.max(1, startNumber - 1)} "${str(prevScene.title).slice(0, 80)}" — ${str(prevScene.action).slice(0, 220)}${prevChars ? ` (chars: ${prevChars.slice(0, 160)})` : ""}${prevLastLine ? ` Last line — ${prevLastLine}` : ""}`
    : null;
  // Slim per-shot lyric keys: the server derives parent_line_id (=
  // lyric_line_id) and joins lyric_text from the timed line list, and the
  // action field already carries the visible event — so the model emits no
  // redundant echoes. Every dropped echo saves ~25-50 tokens × scenes.
  const lyricBlock = effectiveLyricMode
    ? [
      `LYRIC-SEMANTIC SHOT SPLITTING (this board is a SONG — obey strictly):`,
      ...(abstractOpening ? [`OPENING SCENE GUARD (hard constraint): the opening lines describe abstract qualities before any visible action/place. Scene 1 and its first shot MUST be identity-free symbolic imagery. Set identity_free=true, characters=[], characters_detailed=[], asset_refs={characters:[],locations:[],objects:[]}, location="", objects=[]. Do not show or imply Shiva, any deity/person/face/silhouette, Kailash/mountain/snow, meditation pose, Ganga, or any character reference image. Keep the image prompt limited to source-grounded abstract light, darkness, or cosmic forms. This scene must not inherit the bible's lead character or location.`] : []),
      `- One lyric line may become 1 shot (simple) or up to 5 shots (several distinct actions/events). Decide from meaning, never 1 line = 1 scene by default, never 1 shot per word.`,
      `- WORD-BY-WORD MEANING CHECK: account for every meaningful word and phrase in each source line (who, what, action, direction, object, number, emotion, cause/effect). Preserve their relationships and order. Put the exact source phrase in a shot's lyric_segment and show its meaning with a concrete visible action; a phrase may share a shot with another phrase only when the same action clearly explains both. Do not make filler shots for grammatical words.`,
      `- For each shot output ONLY these lyric keys (nothing else): "lyric_line_id" (number), "lyric_segment" (the exact words this shot visualizes), "semantic_meaning" (what the segment really means), "shot_id" ("<line>-<letter>", e.g. "12-A"), "shot_number" (1..K within the line), "song_start_time" + "song_end_time" (seconds within the song; sibling shots split their line's window).`,
      wantChain
        ? `- Continuity decision per shot: "continuity_required" true/false + "reference_source" (one of: NONE, CHARACTER_REFERENCE, LOCATION_REFERENCE, PREVIOUS_IMAGE, PREVIOUS_VIDEO_LAST_FRAME, MULTIPLE_REFERENCES). Use the previous shot's end state when the same character/location/action continues (standing -> leap -> flight); use NONE for fresh establishing shots.`
        : `- Continuity decision per shot (Connected OFF — independent shots): ALWAYS "continuity_required": false + "reference_source": "NONE". Never reference the previous shot's end state.`,
      assetRows.length
        ? `- IMAGE prompt = composition and scene direction ONLY. Put every visible approved character/location/object in asset_refs by its exact asset ID; never restate its identity or appearance. VIDEO prompt = MOTION ONLY. The server resolves approved descriptions and reference images after planning.`
        : `- IMAGE prompt = full composition (identities + action + camera + lighting + emotion + style). VIDEO prompt = MOTION ONLY (starting position, movement, camera move, ending position) — complementary, never a copy.`,
      `TIMED LYRIC LINES (analyze line by line, in order — every scene states line_from/line_to covering these, skipping none):`,
      ...(scopeLine ? [scopeLine] : []),
      ...lineSlice.map((l, i) => {
        const cx = l.visual_complexity ? ` (${l.visual_complexity}, ~${l.planned_shots ?? 1} shots)` : "";
        return `Line ${lineNoOf(l, i)}${lineWinOf(l)}${cx}: ${lineTextOf(l)}`;
      }),
      `MEANINGFUL PHRASE CHECKLIST (every listed phrase must be visibly explained by one or more shots; retain exact phrase text in lyric_segment):`,
      ...lineSlice.map((l, i) => `- Line ${lineNoOf(l, i)}: ${extractMeaningfulPhrases(lineTextOf(l)).map((p) => `“${p.text}”`).join(" · ") || `“${lineTextOf(l)}”`}`),
    ]
    : [];
// Story boards: the same numbered line list (no song windows) so the AI
// analyzes the story line by line. Story lines are the authoritative source;
// the Bible never substitutes for missing source text.
  const storyBlock = !effectiveLyricMode && lineSlice.length
    ? [
      `STORY LINES FOR THIS BATCH (analyze line by line, in order — every scene states line_from/line_to covering these, skipping none):`,
      ...(scopeLine ? [scopeLine] : []),
      ...lineSlice.map((l, i) => `Line ${lineNoOf(l, i)}: ${lineTextOf(l)}`),
      ...(abstractOpening ? [`OPENING SCENE GUARD (hard constraint): the opening lines describe abstract qualities before any visible action/place. Scene 1 and its first shot MUST be identity-free symbolic imagery. Set identity_free=true, characters=[], characters_detailed=[], asset_refs={characters:[],locations:[],objects:[]}, location="", objects=[]. Do not show or imply Shiva, any deity/person/face/silhouette, Kailash/mountain/snow, meditation pose, Ganga, or any character reference image. Keep the image prompt limited to source-grounded abstract light, darkness, or cosmic forms. This scene must not inherit the bible's lead character or location.`] : []),
    `SOURCE-LED SCENE BOUNDARIES (mandatory): build the scene sequence directly from the supplied narration or lyric lines. Group adjacent lines when they describe the same continuous idea or visual moment; split when the subject, visible action, location, or meaning changes. Do not force one scene per sentence or merge distinct events into a vague montage. Cover every supplied line exactly once and in order. Treat the chosen scene duration as a pacing target, not a reason to omit source events; a long story can produce hundreds of scenes across multiple batches.`,
      `SOURCE-GROUNDED VISUALS (mandatory): derive each scene's visible action, setting, and composition from the exact narration lines assigned to it. A character, location, or pose introduced later in the narration must NOT be pulled into an earlier scene just because it is the main character or the bible's most detailed location. In particular, abstract opening lines about qualities, emotions, or cosmic existence must remain an abstract/symbolic opening; do not default them to the character's canonical location or signature pose. A concrete location must be established by the covered source narration or an explicit user-authored scene plan; a generated summary or the character bible alone is not evidence that a location belongs in that scene. If no physical location is established, set location to an empty string and describe the symbolic environment in environment/image_prompt. Do not invent an action (such as sitting in meditation) merely because it suits the character.`,
      `MEANINGFUL PHRASE CHECKLIST (every phrase must be explained by a visible action in the scene/shot that covers it; retain the exact phrase in lyric_segment):`,
      ...lineSlice.map((l, i) => `- Line ${lineNoOf(l, i)}: ${extractMeaningfulPhrases(lineTextOf(l)).map((p) => `“${p.text}”`).join(" · ") || `“${lineTextOf(l)}”`}`),
      `NARRATION PRESERVATION (mandatory for spoken narration): for each scene, copy the exact original Hindi/source text for the source lines covered by line_from–line_to into a separate "narration" field. Preserve wording and order verbatim; do not translate, paraphrase, shorten, or turn narrator text into character dialogue. Use dialogue only for character speech explicitly present in the source. If this is a dialogue script rather than narration, set narration to "" and preserve explicit dialogue in dialogue.`,
    ]
    : [];
  // APPROVED AUDIO TIMELINE contract (Story/Song boards with a reviewed
  // master timeline): the approved segments are the AUTHORITY on every
  // timing decision — the user reviewed and locked those windows. The block
  // renders ONLY the segments inside this batch's time window, so the
  // contract rides the same batching mechanism as everything else. Absent
  // for every other board — the prompt stays byte-identical.
  const masterBlock = compact ? null : (() => {
    const mt = masterTimeline && typeof masterTimeline === "object" ? masterTimeline : null;
    const segs = arr(mt && mt.segments)
      .filter((s) => Number.isFinite(Number(s && s.start_seconds)) && Number(s && s.end_seconds) > Number(s && s.start_seconds));
    if (!mt || !segs.length) return null;
    const segLines = segs.map((s) => {
      const a = Math.round(Number(s.start_seconds) * 10) / 10;
      const b = Math.round(Number(s.end_seconds) * 10) / 10;
      return `- ${a}–${b}s | ${str(s.type)}${s.character_id ? ` | character ${str(s.character_id)}` : ""}${str(s.lyric_text) ? ` | lyric "${str(s.lyric_text).slice(0, 80)}"` : ""}${str(s.action) ? ` | action: ${str(s.action).slice(0, 120)}` : ""}${s.repeat_group ? ` | ${str(s.repeat_group)} — a REPEATED line, this is its OWN occurrence` : ""}`;
    });
    const from = Number.isFinite(Number(mt.from)) ? Math.round(Number(mt.from) * 10) / 10 : 0;
    const to = Number.isFinite(Number(mt.to)) ? Math.round(Number(mt.to) * 10) / 10 : null;
    const narrationTimeline = !input.song && Boolean(input.sourceAudio);
    return [
      `${narrationTimeline ? "APPROVED NARRATION TIMELINE" : "APPROVED AUDIO TIMELINE"} (the AUTHORITY on timing — the user reviewed and locked these windows; do not invent or move timestamps):`,
      `- Every scene/shot MUST set "song_start_time"/"song_end_time" inside the approved window of the segment it visualizes. Never shift, stretch, merge or re-order approved windows.`,
      ...(narrationTimeline ? [`- This is spoken narration, not a song: narration lines are the source of meaning. Never label any span as instrumental, invent lyrics/singing, or turn a quiet/unknown span into song direction. Keep the exact original narration attached to its scene.`] : [`- A lyric-specific action NEVER begins before its own lyric window starts — no singing, no mouth movement, no lyric-driven gesture before the first word.`, `- Instrumental windows: stage pure visuals (performance, dance, scenery, camera moves) — NEVER invent vocals, speech or lyrics.`, `- Uncertain windows ("unknown"): stage neutral visual storytelling — do NOT guess lyrics; those sections stay for human review.`]),
      ...(!narrationTimeline ? [`- A repeated line (the same words sung again) is its OWN occurrence: each occurrence gets its own scene/shot at its own window; vary the staging, keep cast and wardrobe consistent.`] : []),
      `- An action crossing a clip boundary CONTINUES across the cut (same motion direction and energy) — never restart it in the next scene.`,
      ...(to != null ? [`APPROVED SEGMENTS IN THIS BATCH'S WINDOW (${from}s–${to}s):`, ...segLines] : segLines),
    ].join("\n");
  })();
  // Storyboard Planner 2.0 (additive): a compact 19-track batch context built
  // by lib/storyboard_planner.mjs from the SAME approved timeline. It separates
  // hard timing constraints from creative visual suggestions and is INERT when
  // absent — every existing caller keeps a byte-identical prompt.
  const cinematicBlock = compact ? null : (() => {
    const block = cinematicContext && typeof cinematicContext === "string"
      ? cinematicContext.trim() : "";
    return block || null;
  })();
  // Meaning-variation guard (opt-in, built from abstract/ungrounded lines by
  // lib/semantics.mjs). Without it the model copies the ungrounded placeholder
  // action into every scene and changes only the camera. Absent => no text.
  const variationBlock = compact ? null : (() => {
    const block = semanticVariationContext && typeof semanticVariationContext === "string"
      ? semanticVariationContext.trim() : "";
    return block || null;
  })();
  // The MEANING-AWARE context (lib/semantics.mjs): what each line actually
  // means and what can be SEEN. It is injected when the semantic analysis ran
  // (the board carries it) — old boards keep the exact historical prompt.
  const semanticBlock = compact ? "" : (arr(semantics).length
    ? buildSemanticContext(arr(semantics))
    : "");
  // The lyric tail joins the scene schema in lyric mode only — story boards
  // get the exact historical schema so their batches stay parseable.
  const lyricTail = lyricMode
    ? `, "lyric_line_id": 0, "lyric_segment": "exact words visualized", "semantic_meaning": "...", "shot_id": "12-A", "shot_number": 1, "song_start_time": 0, "song_end_time": 0, "continuity_required": false, "reference_source": ${wantChain ? `"NONE|CHARACTER_REFERENCE|LOCATION_REFERENCE|PREVIOUS_IMAGE|PREVIOUS_VIDEO_LAST_FRAME|MULTIPLE_REFERENCES"` : `"NONE"`}`
    : ``;
  const imagePromptExample = assetRows.length
    ? ""
    : `self-contained image prompt: verbatim character/location/object identities + action + expression/body_language${wantChain ? " + continuity_from_previous_scene (same framing as the previous shot's end state)" : " (fresh independent framing — never continue the previous shot)"} + ${styleLock}`;
  const shotImagePromptExample = assetRows.length
    ? ""
    : "self-contained image prompt for THIS shot only, with verbatim identities";
  // Multi-shot scenes (songs AND stories): one scene holds timed shots that
  // tile its duration. The schema tail is identical for every board — story
  // sentences split on clauses/entities exactly like lyric lines split on
  // segments.
  const shotVideoPromptExample = assetRows.length ? "" : "MOTION ONLY for this shot";
  const sceneVideoPromptExample = assetRows.length ? "" : "MOTION ONLY for THIS scene's own keyframe; no appearance description";
  const detailedImagePromptRule = [
    assetRows.length
      ? `VISUAL DIRECTION QUALITY (mandatory): make every scene and shot's structured direction production-ready and visually specific. Specify exact subject(s), visible pose/action and expression, foreground/midground/background composition, location details, framing and camera angle, depth, lighting direction and quality, atmosphere, and palette. The server composes image prompts from these fields, so keep image_prompt empty as instructed below. Use concrete visual language faithful to the assigned source lines.`
      : `IMAGE PROMPT QUALITY (mandatory): write a production-ready, self-contained cinematic image prompt for every scene and shot, not a label or a short summary. Specify the exact subject(s) and bible identity, their visible pose/action and expression, foreground/midground/background composition, location details, framing and camera angle, depth, lighting direction and quality, atmosphere, and palette. Make the frame easy to visualize and keep it faithful to the assigned source lines. Use concrete visual language; avoid generic phrases such as "epic scene" without describing what is actually visible.`,
    `VIDEO PROMPT QUALITY: describe only the visible movement over time (starting state, physical motion, camera motion, ending state); do not repeat appearance or image composition.`,
  ];
  const shotTail = `, "shots": [ { "shot_id": "${startNumber}-A", "shot_number": 1, "lyric_segment": "exact words/clause this shot visualizes", "semantic_meaning": "what the segment really means", "dramatic_purpose": "why this shot matters to the story", "characters": ["<character_id from CAST — exact id only>"], "location": "<location_id from LOCATIONS — exact id only>", "objects": ["<object_id from VALID OBJECTS — exact id only>"], "asset_refs": { "characters": ${assetExampleList("character", "CHAR_001")}, "locations": ${assetExampleList("location", "LOC_001")}, "objects": ${assetExampleList("object", "OBJ_001")} }, "action": "ONE visible action on screen", "motion": "specific physical movement over time; describe what moves and how it changes; no appearance", "emotion": "...", "expression": "...", "body_language": "...", "camera": { "shot_type": "...", "angle": "...", "movement": "..." }, "lighting": "...", "environment": "...", "dialogue": [{ "speaker": "character_id", "line": "...", "expression": "...", "emotion": "...", "pitch": "low|medium|high" }], "image_prompt": "${shotImagePromptExample}", "video_prompt": "${shotVideoPromptExample}", "duration_seconds": 1.4 } ]`;
  // Location/object rotation + anti-repeat: the observed failure mode is 90%
  // of scenes parked in one location with free-text places while bible
  // objects never appear, plus verbatim repeat scenes within a batch.
  const rotationBlock = [
    `LOCATION, CHARACTER & OBJECT IDS (required):`,
    `- Scene and shot "location" take ONLY an id from VALID LOCATIONS below (exact spelling — never a display name, translation, description or invented place), OR an empty string when the covered source lines establish no physical location. Never assign the bible's default/main location to an abstract line without source support. "characters" takes ONLY ids from VALID CHARACTERS. Inventing a character, place or name not in these lists is FORBIDDEN — stage the lines with the listed cast instead.`,
    assetRows.length
      ? `- Put selected approved prop IDs in scene/shot asset_refs.objects and their bible ids in objects. Do not copy asset appearance text into prompts. An object ID NEVER goes in a location slot.`
      : `- Put visible prop bible IDs in the scene/shot objects arrays. An object ID NEVER goes in a location slot.`,
    `- Always output an "objects" array on every scene and shot (use [] when no bible prop is visibly present). Never substitute a prop's name in the location or character fields.`,
    validIdsLine(`VALID CHARACTERS`, validCharIds),
    validIdsLine(`VALID LOCATIONS`, validLocIds),
    validIdsLine(`VALID OBJECTS`, validObjIds),
    ...(assetRows.length ? [
      `ASSET IDS (approved library; use only these exact ids in asset_refs):`,
      `CHARACTERS: ${assetIds("character").join(", ") || "(none)"}`,
      `LOCATIONS: ${assetIds("location").join(", ") || "(none)"}`,
      `OBJECTS: ${assetIds("object").join(", ") || "(none)"}`,
    ] : []),
  ];
  // Generate Assets stage (additive, INERT when absent): approved master stills
  // are a TEXT lock for the scene planner, not a pixel anchor (the Flux.1-dev
  // reference workflow is pure text-to-image). Existing callers keep the exact
  // same prompt; a board that approved masters gets their briefs by bible id.
  const approvedAssetBlock = assetRows.length
    ? `APPROVED REFERENCE ASSETS (mandatory, scene AND shot level): whenever an approved asset is visible, attach its exact approved asset ID from the matching CHARACTERS/LOCATIONS/OBJECTS list in asset_refs. Keep the corresponding bible ID in characters/location/objects too. At scene level, asset_refs must be the union of approved assets actually visible in any shot of that scene. At shot level, asset_refs must include every approved asset visible in that exact frame and no invisible asset. Never substitute a name, bible ID, or another asset ID for the approved asset ID. Do not copy asset descriptions, appearance text, prompts, or image paths into scene output. Leave scene- and shot-level image_prompt and video_prompt empty: the server composes them from the structured direction fields and resolves the approved IDs to their prompts and reference images after planning. A symbolic/abstract shot with no depicted asset must use empty asset_refs even if that character is named in the narration.`
    : null;
  const shotBlock = [
    `MULTI-SHOT SCENES (mandatory — songs and stories alike):`,
    `- When ONE line/sentence covers 2+ distinct persons, objects or locations, NEVER cram them into one image. Split the scene into 2-5 SHOTS inside the SAME scene ("shots" array) — one shot per entity or moment, each with its own segment, cast, location, camera, prompts and dialogue.`,
    `- Size every shot by PRONOUNCEABLE LENGTH: words in its segment + spoken lines at ~2.5 words/sec (Devanagari ~2.2 words/sec), +0.35s pause between dialogue lines. Shot durations MUST sum EXACTLY to the scene's duration_seconds, with cumulative boundaries from 0 (shot 1: 0-1.4s, shot 2: 1.4-2.5s, shot 3: 2.5-3s for a 3s scene).`,
    assetRows.length
      ? `- shot_id "<scene>-<letter>" (e.g. "${startNumber}-A", "${startNumber}-B"). Each shot's asset_refs lists every approved reference ID for the visible character/location/prop in that frame; include the matching scene-level reference even if the shot's prose prompt is empty. Do not include assets that are absent from the frame. Leave image_prompt and video_prompt empty because the server composes them from the structured direction fields. Never paste asset identity text. motion must describe the visible physical change during the clip; use "still, breathing gently" when no larger movement is intended. Single-entity scenes use exactly 1 shot covering 0 to the full scene duration.`
      : `- shot_id "<scene>-<letter>" (e.g. "${startNumber}-A", "${startNumber}-B"). Each shot's image_prompt carries ONLY that shot's entity (verbatim identity paste + global style); video_prompt is MOTION ONLY for that shot. Single-entity scenes use exactly 1 shot covering 0 to the full scene duration.`,
  ];
  const anatomyBlock = [
  `ANATOMY-SAFE STAGING (mandatory): every action, body_language and video_prompt must be physically possible for the character's species body plan. Characters without limbs (snake/serpent/worm/eel) NEVER walk, run, stand, dance on legs, wave hands, or grow ears — they slither, coil, wiggle, sway rhythmically, bob the head, flick the tongue/tail. Funny/cute expressions stay within the real body plan; extra legs, arms, hands, feet, ears or wings are FORBIDDEN in prompts and frames.`,
  assetRows.length
    ? `For approved assets, preserve anatomy through the referenced asset identity; do not copy appearance or exclusion text into scene prompts. Video direction describes only physically possible motion.`
    : `Image prompts for characters without limbs always restate the exclusion ("limbless serpentine body, no legs, no arms, no ears, no wings"); video prompts describe only motion of the real parts (body/head/tail/tongue), never limbs.`,
  ];
  // Dynamic planning brief: the AI decides scene count, boundaries and
  // durations within this batch's time budget (target-driven, never padded
  // to a fixed count). sceneSeconds survives only as a scale hint.
  const budgetLine = target != null
    ? `TIME BUDGET: this batch covers ~${budget}s of story (${planned}s of ~${target}s planned so far). YOU decide how many scenes (1..${count}), where each starts/ends, each scene's own duration_seconds from content weight, and its shots — the batch's scene durations MUST sum to ~${budget}s.`
    : `TIME BUDGET: this batch covers ~${budget}s of story. YOU decide how many scenes (1..${count}), where each starts/ends, each scene's own duration_seconds from content weight, and its shots — the batch's scene durations MUST sum to ~${budget}s.`;
  const productionAnalysisBlock = [
    `PROFESSIONAL PRODUCTION BREAKDOWN (mandatory; use this analysis to make scene decisions, but return only the requested JSON):`,
    `1. STORY EDITOR: decode the exact covered narration, its literal meaning, metaphor, emotional change, and place in the full arc. Keep narration order and distinguish what is said from what is visibly happening.`,
    `2. DIRECTOR: give each scene a clear dramatic_purpose; choose the visible subject, action, performance, gaze, and blocking that communicate the source meaning. A named character is not automatically on screen, and do not invent a pose or action for an abstract line.`,
    `3. CINEMATOGRAPHER: choose shot size, angle, composition, depth, light, palette, and camera movement for a reason tied to that scene's dramatic purpose. Vary shot grammar when the meaning or scale changes; avoid default close-ups and repeated compositions.`,
    `4. PRODUCTION DESIGNER: use only source-supported locations and props. The narration lines assigned to this scene outrank the generated synopsis, bible, asset list, and locations from later lines. Preserve cultural and visual continuity without importing later elements early.`,
    `5. MOTION ARTIST: describe a feasible starting state, visible subject movement, camera movement, and ending state for the scene duration. Animate the approved keyframe; do not add an action that the source does not support.`,
    `6. EDITOR: pace the scene to the narration's weight, keep adjacent scenes visually distinct while maintaining continuity, and make the transition serve the next source moment.`,
    `Translate those decisions into dramatic_purpose, action, motion, expression, body_language, camera, lighting, environment, image_prompt and video_prompt. Do not output private reasoning or these role notes.`,
  ].join("\n");
  // Compact mode: last resort for models with a tiny output window (the
  // batch keeps getting cut off mid-scene with zero usable scenes). Same
  // JSON schema — brief values only, so the result still normalizes and
  // grounds exactly like a full batch.
  const compactBlock = compact
    ? `COMPACT MODE (hard output limit — obey strictly or the batch is discarded): plan exactly 1 scene with at most 2 shots. ${assetRows.length ? "Use approved asset IDs in asset_refs; do not paste identity/appearance descriptions; leave scene and shot image_prompt/video_prompt empty for server composition." : "Paste each required verbatim identity ONCE."} Keep EVERY other value terse: ${assetRows.length ? "" : "image_prompt max 60 words, video_prompt max 40 words, "}action/environment/lighting/camera one short phrase each, dialogue at most 1 short line, no continuity prose.`
    : null;
  return [
    `TASK 2/2 — SCENE PLAN (batch from scene ${startNumber}, UP TO ${count} scenes — YOU decide the count). Analyze the source lines below LINE BY LINE, in order; continue the story forward, never restart it.`,
    `STORY TITLE: ${input.title} | GENRE: ${input.genre} | STYLE: ${input.visualStyle}`,
    `PHASE 2 — PLAN THIS BATCH ONLY. Use the completed Phase 1 analysis to understand the full arc, then direct the exact source lines and time window below. Do not regenerate or contradict the analysis; if it conflicts with the narration, the narration wins. The whole audio runtime is ${Math.round(Number(input.song && input.song.durationSeconds) || Number(input.sourceAudio && input.sourceAudio.durationSeconds) || Number(input.whisperxAudio && input.whisperxAudio.durationSeconds) || Number(input.targetSeconds) || 0)} seconds.`,
    narrativeArcBlock,
    budgetLine,
    productionAnalysisBlock,
    compactBlock,
    promptAddons || null,
    `TYPICAL SCENE: ~${perScene}s (scale hint ONLY — DO NOT copy example durations; every duration_seconds comes from pronounceable length + action weight).`,
    wantDialogue
      ? `DIALOGUE (voice + lip-sync): use "dialogue": [{ "speaker": "<character_id>", "line": "...", "expression": "facial expression while speaking", "emotion": "delivery feeling", "pitch": "low|medium|high" }] ONLY for character speech explicitly present in the source. A narration/voiceover is not character dialogue: keep it verbatim in "narration" and do not invent character lines to accompany it. ` +
        `The speaker MUST be a character who is on screen in that scene${cast ? ` (cast: ${cast})` : ""}; keep each voice in character. ` +
        `Fill "expression" from the STORY whenever the story gives one (crying, smiling, shouting, whispering, scared trembling...) — otherwise infer it from the line's feeling; "emotion" is the delivery (joyful, sad, angry, scared, excited, calm) and "pitch" follows it (high = excited/happy/young, low = angry/sad/older, medium = calm/neutral). ` +
        `Preserve explicit source dialogue exactly; do not paraphrase it. Action-only and narration-only scenes use empty dialogue []. ` +
        `When a character speaks, stage them FRONT-FACING and clearly visible (Close-Up or Medium Close-Up, Eye Level, Static) — ` +
        `the lip-sync pass needs the speaker's face in frame for every frame.`
      : `DIALOGUE DISABLED (silent film — user opted out): emit "dialogue": [] on EVERY scene, no exceptions. No spoken lines, no speaker, no voice — the video plays silent over visuals/music only. Stage scenes for pure visual storytelling.`,
    wantDialogue && used.length ? `LINES ALREADY USED (do not repeat any of these verbatim or in paraphrase):\n${used.map((l) => `- ${l}`).join("\n")}` : null,
    wantChain
      ? `CONNECTED SCENES (visual continuity — mandatory): every scene STARTS from the previous scene's end state — same character(s) in the same clothing, matched framing. Describe continuity_from_previous_scene concretely (e.g. "same forest clearing, Minku mid-run from the last frame, camera holds the Medium Shot") and transition_to_next_scene as the handoff. Keep time_of_day/lighting identical across consecutive scenes unless the story explicitly changes time.`
      : `INDEPENDENT SCENES (user turned Connected OFF — mandatory): every scene is a FRESH independent shot — new framing chosen for THIS scene's own action, never a continuation of the previous shot. Set "continuity_from_previous_scene": "" and "transition_to_next_scene": "" on EVERY scene, always. Never write "continuing from previous shot", "same framing as the previous shot" or any handoff language anywhere.`,
    input.song && typeof input.song === "object"
      ? `MUSIC-VIDEO PACING: scenes must total ~${Math.round(Number(input.song.durationSeconds) || input.targetSeconds)}s to match the song; favor performance/movement shots that cut on the beat, no lip-sync close-ups held longer than one scene.`
      : null,
    ...lyricBlock,
    ...storyBlock,
    ...detailedImagePromptRule,
    masterBlock,
    cinematicBlock,
    semanticBlock ? `\n${semanticBlock}\n` : "",
    variationBlock ? `\n${variationBlock}\n` : "",
    prevSummaryLine,
    ...shotBlock,
    ...anatomyBlock,
    ...rotationBlock,
    approvedAssetBlock,
    input.instructions ? `DIRECTOR INSTRUCTIONS: ${input.instructions}` : null,
    outputLanguageRule(input.language),
    ``,
    approvedById.size
      ? `CHARACTER CONSISTENCY: select characters by exact bible id. Approved master identities are added verbatim by the server after planning; do not spend output tokens repeating the long identity text. Keep action, pose and camera consistent with the approved look.`
      : `CHARACTER CONSISTENCY (TEXT LOCK — mandatory): for every character listed in a scene's "characters", paste that character's exact visual_identity_prompt into "image_prompt" VERBATIM (copy-paste, word for word). Never paraphrase, shorten, or restyle it. Never change face, body, species, clothing or colors. Action/pose/camera go AROUND the pasted identity, never inside it.`,
    chars || "(none)",
    rulesCtx ? `\nPER-CHARACTER CONSISTENCY RULES (obey for the named character):\n${rulesCtx}` : null,
    ``,
    approvedById.size ? `LOCATIONS (approved identity text is added by the server; select the correct exact id):` : `LOCATIONS (paste the exact visual_identity_prompt for the scene location the same way):`,
    locs || "(none)",
    ``,
    approvedById.size ? `OBJECTS (approved identity text is added by the server; select relevant visible objects by exact id):` : `OBJECTS (paste the exact visual_identity_prompt for every object visible in the scene the same way):`,
    objs || "(none)",
    ``,
    assetRows.length
      ? `GLOBAL STYLE (the server adds this to final generation prompts after planning; do not repeat it in scene asset references): ${styleLock}`
      : `GLOBAL STYLE (append to every image_prompt verbatim): ${styleLock}`,
    ``,
    prevScene && wantChain ? `\nPREVIOUS SCENE (end state — continue from it, do not repeat it):\n${JSON.stringify(prevScene)}` : ``,
    ``,
    `Return JSON: { "scenes": [ { "scene_number": ${startNumber}, "title": "...", "line_from": 1, "line_to": 2, "narration": "exact source narration for these lines, or empty string for non-narrated dialogue scripts", "dramatic_purpose": "why this scene matters to the story", "duration_seconds": ${input.sceneSeconds}, "characters": ["<character_id from VALID CHARACTERS — exact id only>"], "location": "<valid location id, or empty string if the source establishes no physical location>", "objects": ["<object_id from VALID OBJECTS — exact id only>"], "asset_refs": { "characters": ${assetExampleList("character", "CHAR_001")}, "locations": ${assetExampleList("location", "LOC_001")}, "objects": ${assetExampleList("object", "OBJ_001")} }, "time_of_day": "...", "action": "visible physical behavior, not feelings", "motion": "what visibly moves/changes over time; no appearance", "emotion": "...", "expression": "...", "body_language": "...", "camera": { "shot_type": "one of: Extreme Wide Shot, Wide Shot, Establishing Shot, Medium Shot, Medium Close-Up, Close-Up, Extreme Close-Up, Over-the-Shoulder, Two Shot", "angle": "one of: Low Angle, High Angle, Eye Level, Top Down", "movement": "one of: Static, Pan, Tilt, Dolly In, Dolly Out, Tracking Shot, Orbit, Crane" }, "lighting": "...", "environment": "...", ${wantChain ? `"continuity_from_previous_scene": "...", "transition_to_next_scene": "...",` : `"continuity_from_previous_scene": "", "transition_to_next_scene": "",`} ${wantDialogue ? `"dialogue": [{ "speaker": "character_id", "line": "only explicit character speech from the source", "expression": "face while speaking", "emotion": "delivery feeling", "pitch": "low|medium|high" }]` : `"dialogue": []`}, "image_prompt": "${imagePromptExample}", "video_prompt": "${sceneVideoPromptExample}"${lyricTail}${shotTail} } ], "complete": false } — complete=true ONLY when the LAST source line is covered and the story ends.`,
    `Plan UP TO ${count} scenes numbered from ${startNumber} (fewer is fine — cover the batch lines with YOUR scene boundaries/durations, nothing more). Every scene states line_from/line_to, its own duration_seconds, and "shots" tiling it exactly (single-entity scenes: 1 shot, 0 to full duration). ${assetRows.length ? "Set compact asset_refs using only approved CHAR_/LOC_/OBJ_ ids; do not repeat asset descriptions. The server assembles prompts after planning." : "When prompt fields are supplied, keep them aligned with the structured scene and shot direction."} Include the global style. Respond with JSON ONLY.`,
  ].filter((l) => l !== null).join("\n");
}

// Add-one-bible-entry message (Add Character / Add Location / Add Object).
// The model re-reads the master input (title + story/lyrics + genre/style +
// instructions + song) plus the ALREADY generated bible, then invents exactly
// ONE new entry that the story still needs and appends it server-side —
// nothing existing is rewritten. `hint` is an optional user nudge
// ("a wise old turtle", "night market", ...) that the model must honor.
export function buildAddEntryPrompt({ input, blueprint, kind, hint }) {
  const k = String(kind || "").toLowerCase();
  const label = k === "location" ? "LOCATION" : k === "object" ? "OBJECT" : "CHARACTER";
  const b = blueprint && typeof blueprint === "object" ? blueprint : {};
  const existing = arr(
    k === "location" ? b.locations : k === "object" ? b.objects : b.characters,
  ).map((x) => `- ${x.name || x.character_id || x.location_id || x.object_id}`).join("\n") || "(none yet)";
  const song = input && typeof input.song === "object" ? input.song : null;
  const shape =
    k === "location"
      ? `{ "location": { "location_id": "snake_case", "name": "...", "description": "...", "visual_identity_prompt": "one self-contained look prompt", "time_of_day": "...", "lighting": "...", "color_palette": "..." } }`
      : k === "object"
        ? `{ "object": { "object_id": "snake_case", "name": "...", "description": "...", "visual_identity_prompt": "one self-contained look prompt" } }`
        : `{ "character": { "character_id": "snake_case", "name": "...", "role": "main_character|supporting|antagonist", "species": "...", "age": "...", "appearance": { "body": "...", "fur": "...", "eyes": "...", "ears": "..." }, "clothing": { "top": "...", "bottom": "..." }, "personality": ["..."], "visual_identity_prompt": "STATIC portrait only: species + body + face + eyes + colors + clothing, comma-separated, no action, no pose, no scene, no emotion — written so it can be pasted into every image_prompt verbatim" } }`;
  return [
    `ADD ONE ${label} to this storyboard's bible. Read the full story/lyrics + master settings below and the already-generated bible — invent exactly ONE new ${k} the story still needs (a mentioned-but-missing cast member, an unlisted place the action needs, or a key prop). Never duplicate or rename an existing entry; the new name/ids must be unique.`,
    `STORY TITLE: ${input.title} | LANGUAGE: ${input.language} | GENRE: ${input.genre}${input.genreCustom ? ` (${input.genreCustom})` : ""} | VISUAL STYLE: ${input.visualStyle}${input.visualStyle === "Custom" ? ` (${input.styleCustom})` : ""}`,
    song ? `SOURCE: SONG "${song.fileName || ""}" (~${Math.round(Number(song.durationSeconds) || input.targetSeconds)}s)${song.hasLyrics === false ? " — no lyrics, infer from the title" : ""}` : null,
    input.instructions ? `DIRECTOR INSTRUCTIONS: ${input.instructions}` : null,
    hint ? `USER REQUEST: ${String(hint).slice(0, 300)} — honor this when inventing the new ${k}.` : null,
    ``,
    `STORY/LYRICS:`,
    input.story,
    ``,
    `EXISTING ${label}S (do not repeat any of these):`,
    existing,
    `EXISTING CAST: ${arr(b.characters).map((c) => c.name).filter(Boolean).join(", ") || "(none)"}`,
    `EXISTING LOCATIONS: ${arr(b.locations).map((l) => l.name).filter(Boolean).join(", ") || "(none)"}`,
    `EXISTING OBJECTS: ${arr(b.objects).map((o) => o.name).filter(Boolean).join(", ") || "(none)"}`,
    ``,
    `Write the visual_identity_prompt so it can be pasted into an image prompt verbatim (same ${input.visualStyle} style as the bible). Return JSON ONLY in exactly this shape: ${shape}`,
    outputLanguageRule(input.language),
  ].filter((l) => l !== null).join("\n");
}

// Rewrite-one-bible-entry message (per-card regenerate icon). The model
// re-reads the master input (title + story/lyrics + genre/style +
// instructions + song) plus the full bible, then rewrites ONLY the selected
// entry — richer, more story-true description + identity prompt. The id
// (character_id / location_id / object_id) MUST be kept verbatim so scene
// references never break; only the descriptive fields are refreshed.
export function buildRegenEntryPrompt({ input, blueprint, kind, entry }) {
  const k = String(kind || "").toLowerCase();
  const label = k === "location" ? "LOCATION" : k === "object" ? "OBJECT" : "CHARACTER";
  const b = blueprint && typeof blueprint === "object" ? blueprint : {};
  const song = input && typeof input.song === "object" ? input.song : null;
  const idKey = k === "location" ? "location_id" : k === "object" ? "object_id" : "character_id";
  const idVal = entry && typeof entry === "object" ? entry[idKey] : "";
  const shape =
    k === "location"
      ? `{ "location": { "location_id": "${idVal}", "name": "...", "description": "...", "visual_identity_prompt": "one self-contained look prompt", "time_of_day": "...", "lighting": "...", "color_palette": "..." } }`
      : k === "object"
        ? `{ "object": { "object_id": "${idVal}", "name": "...", "description": "...", "visual_identity_prompt": "one self-contained look prompt" } }`
        : `{ "character": { "character_id": "${idVal}", "name": "...", "role": "main_character|supporting|antagonist", "species": "...", "age": "...", "appearance": { "body": "...", "fur": "...", "eyes": "...", "ears": "..." }, "clothing": { "top": "...", "bottom": "..." }, "personality": ["..."], "visual_identity_prompt": "STATIC portrait only: species + body + face + eyes + colors + clothing, comma-separated, no action, no pose, no scene, no emotion — written so it can be pasted into every image_prompt verbatim" } }`;
  return [
    `REGENERATE ONE ${label} in this storyboard's bible. Read the full story/lyrics + master settings + bible below, then rewrite ONLY the selected ${k} — keep its role in the story but make the description and visual_identity_prompt richer, more specific and more story-true (same ${input.visualStyle} style).`,
    `CRITICAL: keep "${idKey}": "${idVal}" EXACTLY (scene references use it — never rename the id). Keep the name unless the story demands otherwise.`,
    `STORY TITLE: ${input.title} | LANGUAGE: ${input.language} | GENRE: ${input.genre}${input.genreCustom ? ` (${input.genreCustom})` : ""} | VISUAL STYLE: ${input.visualStyle}${input.visualStyle === "Custom" ? ` (${input.styleCustom})` : ""}`,
    song ? `SOURCE: SONG "${song.fileName || ""}" (~${Math.round(Number(song.durationSeconds) || input.targetSeconds)}s)${song.hasLyrics === false ? " — no lyrics, infer from the title" : ""}` : null,
    input.instructions ? `DIRECTOR INSTRUCTIONS: ${input.instructions}` : null,
    ``,
    `STORY/LYRICS:`,
    input.story,
    ``,
    `FULL BIBLE CONTEXT — CAST: ${arr(b.characters).map((c) => c.name).filter(Boolean).join(", ") || "(none)"} | LOCATIONS: ${arr(b.locations).map((l) => l.name).filter(Boolean).join(", ") || "(none)"} | OBJECTS: ${arr(b.objects).map((o) => o.name).filter(Boolean).join(", ") || "(none)"}`,
    ``,
    `SELECTED ${label} (rewrite this):`,
    JSON.stringify(entry),
    ``,
    `Write the visual_identity_prompt so it can be pasted into an image prompt verbatim. Return JSON ONLY in exactly this shape: ${shape}`,
    outputLanguageRule(input.language),
  ].filter((l) => l !== null).join("\n");
}

// Single-scene regeneration message (target scene + neighbors for continuity).
export function buildRegenPrompt({ input, blueprint, scene, prevScene, nextScene, styleLock, approvedAssets = [], promptAddons = "" }) {
  const approvedByBlueprint = new Map(arr(approvedAssets).filter((a) => a && a.blueprint_id)
    .map((a) => [str(a.blueprint_id), a]));
  const compactRows = (items, idKey, fallback) => arr(items).map((x) => {
    const id = str(x && x[idKey]);
    const a = approvedByBlueprint.get(id);
    return a ? `- ${str(x.name)} (${id}; asset ${str(a.reference_id || assetVersionId(a))}; v${Number(a.version) || 1})` : fallback(x);
  }).join("\n");
  const chars = compactRows(blueprint && blueprint.characters, "character_id", (x) => `- ${x.name} (${x.character_id}): ${x.visual_identity_prompt || describeFallback(x)}`);
  const locs = compactRows(blueprint && blueprint.locations, "location_id", (x) => `- ${x.name} (${x.location_id}): ${x.visual_identity_prompt || x.description}`);
  const objs = compactRows(blueprint && blueprint.objects, "object_id", (x) => `- ${x.name} (${x.object_id}): ${x.visual_identity_prompt || x.description}`);
  const rulesCtx = consistencyRulesContext(blueprint);
  return [
    `REGENERATE ONE SCENE (scene ${scene.scene_number}, "${scene.title}"). Keep its place in the story; create fresh staging for the same assigned source lines and meaning.`,
    `Regenerate ONLY this scene — keep its lyric linkage (lyric_line_id, lyric_segment, shot_id, parent_line_id, song timing) and its place between the neighbors; never renumber sibling scenes. Keep the scene's "shots" array (shot_ids, per-shot timings); when re-staging into several shots, their durations MUST tile the scene's duration_seconds exactly with cumulative boundaries from 0.${input.chainContinuity === true ? " If the new ending composition changes, update continuity_refs/continuity_from_previous_scene thinking so the next shot still flows." : " Write no continuity_refs/continuity_from_previous_scene handoff thinking — this board stages independent shots."}`,
    approvedByBlueprint.size
      ? `ASSET CONSISTENCY: use compact approved asset IDs in asset_refs. Do not copy asset descriptions or image paths into the scene; the server assembles them after planning. Stage only physically possible actions.`
      : `CHARACTER CONSISTENCY (TEXT LOCK — mandatory): paste the exact visual_identity_prompt verbatim for every character/location/object in the scene — copy-paste, never paraphrase or restyle. Stage only physically possible actions.`,
    input.includeDialogue === false
      ? `DIALOGUE DISABLED on this board (silent film): keep "dialogue": [] — do not invent spoken lines.`
      : null,
    input.chainContinuity === true
      ? `CONNECTED SCENES on this board: the new staging must START from the previous scene's end state (same clothing/location/lighting/framing) and hand off cleanly to the next scene.`
      : `INDEPENDENT SCENES on this board (Connected OFF): stage this scene as a FRESH independent shot — never continue the previous scene's framing or hand off to the next. Set "continuity_from_previous_scene": "" and "transition_to_next_scene": "" and write no handoff language anywhere.`,
    `STYLE: ${input.visualStyle} — GLOBAL STYLE (append to image_prompt verbatim): ${styleLock}`,
    input.instructions ? `DIRECTOR INSTRUCTIONS: ${input.instructions}` : null,
    promptAddons || null,
    ``,
    `CHARACTER IDENTITIES:\n${chars || "(none)"}`,
    rulesCtx ? `PER-CHARACTER CONSISTENCY RULES (obey for the named character):\n${rulesCtx}` : null,
    `LOCATIONS:\n${locs || "(none)"}`,
    `OBJECTS:\n${objs || "(none)"}`,
    ...(approvedByBlueprint.size ? [`APPROVED ASSET IDS: ${arr(approvedAssets).map((a) => `${a.reference_id || assetVersionId(a)}=${a.name} (v${Number(a.version) || 1})`).join(", ")}`] : []),
    prevScene && input.chainContinuity === true ? `\nPREVIOUS SCENE (continue from its end state):\n${JSON.stringify(prevScene)}` : ``,
    prevScene && input.chainContinuity !== true ? `\nPREVIOUS SCENE (story context only — do NOT continue its framing, composition or action):\n${JSON.stringify(prevScene)}` : ``,
    nextScene && input.chainContinuity === true ? `\nNEXT SCENE (must still flow into it):\n${JSON.stringify(nextScene)}` : ``,
    nextScene && input.chainContinuity !== true ? `\nNEXT SCENE (story context only — the new staging must stand alone, not hand off into it):\n${JSON.stringify(nextScene)}` : ``,
    ``,
    `CURRENT SCENE (rewrite this):\n${JSON.stringify(scene)}`,
    ``,
    `Return JSON: { "scene": { ...same scene schema as the scene plan..., "scene_number": ${scene.scene_number}, "duration_seconds": ${scene.duration_seconds} } }. Respond with JSON ONLY.`,
    outputLanguageRule(input.language),
  ].filter((l) => l !== null).join("\n");
}

// Board -> existing scenario config (the approve handoff). Beats become
// pipeline beats (title/image/motion); the reference prompt anchors the key
// visual on the main character + primary location + style lock. Style lock
// AND every appearing character's visual identity are enforced server-side
// (appended when missing) so a forgetful model cannot drop grounding —
// text identity is what keeps non-anchored cast members consistent, since
// the image pipeline anchors pixels only on the single main reference.
export function boardToScenario(board, { preservePrompts = false } = {}) {
  const input = board.input || {};
  const bp = board.blueprint || {};
  // Scene ORDER guarantee: generation assets are keyed by the flat beat
  // index, so the flattened sequence MUST follow the storyboard's scene
  // numbering — the order the AI Story Director created the scenes in.
  // Batches can land out of order, so a fully-numbered board is stably
  // sorted by scene_number here (a no-op for already-ordered boards —
  // output stays byte-identical). Boards with unnumbered scenes pass
  // through untouched.
  const rawScenes = Array.isArray(board.scenes) ? board.scenes : [];
  const allNumbered = rawScenes.every((s) => Number(s && s.scene_number) > 0);
  const scenes = allNumbered
    ? [...rawScenes].sort((a, b) => Number(a.scene_number) - Number(b.scene_number))
    : rawScenes;
  const lock = styleLockFor(input.visualStyle, input.styleCustom, input.masterPrompt);
  const key = styleKeyFor(input.visualStyle, input.styleCustom, input.masterPrompt);
  const chars = arr(bp.characters);
  const charById = new Map(chars.map((c) => [c.character_id, c]));
  const approvedAssets = arr(board.assetProduction && board.assetProduction.assets)
    .filter((a) => a && a.status === "approved" && a.reference);
  const assetById = new Map(approvedAssets.map((a) => [str(a.id), a]));
  const assetByBlueprint = new Map(approvedAssets.filter((a) => a.blueprint_id).map((a) => [str(a.blueprint_id), a]));
  const assetByReferenceId = new Map();
  for (const asset of approvedAssets) {
    assetByReferenceId.set(str(asset.reference_id || assetVersionId(asset)), { asset, version: null });
    for (const version of arr(asset.image_versions)) {
      if (version && version.reference_id && version.reference) {
        assetByReferenceId.set(str(version.reference_id), { asset, version });
      }
    }
  }
  const assetFor = (kind, id, refs = []) => {
    const versioned = arr(refs).map((ref) => assetByReferenceId.get(str(ref))).find((entry) => entry?.asset?.type === kind);
    if (versioned) return {
      ...versioned.asset,
      prompt: str(versioned.version?.prompt || versioned.asset.prompt),
      reference: str(versioned.version?.reference || versioned.asset.reference),
      reference_id: str(versioned.version?.reference_id || versioned.asset.reference_id || assetVersionId(versioned.asset)),
      version: Number(versioned.version?.version || versioned.asset.version) || 1,
    };
    const direct = assetById.get(str(id));
    const byBible = assetByBlueprint.get(str(id));
    const byRef = arr(refs).map((x) => assetById.get(str(x)))
      .find((a) => a && a.type === kind && (!id || !a.blueprint_id || str(a.blueprint_id) === str(id)));
    return direct && direct.type === kind ? direct
      : byBible && byBible.type === kind ? byBible
        : byRef || null;
  };
  const resolvedRefs = (s) => {
    if (s && s.identity_free === true) return { asset_refs: { characters: [], locations: [], objects: [] }, reference_images: [] };
    const explicit = s && s.asset_refs && typeof s.asset_refs === "object" ? s.asset_refs : {};
    const characterAssets = (arr(explicit.characters).length ? arr(explicit.characters) : arr(s && s.characters))
      .map((id) => assetFor("character", id, [id])).filter(Boolean);
    const locationAsset = arr(explicit.locations).length
      ? assetFor("location", explicit.locations[0], explicit.locations)
      : assetFor("location", s && s.location);
    const objectIds = arr(explicit.objects).length ? arr(explicit.objects) : [...arr(s && s.objects), ...arr(s && s.continuity_refs)];
    const objectAssets = objectIds.map((id) => assetFor("object", id, [id])).filter(Boolean);
    return {
      asset_refs: {
        characters: [...new Set(characterAssets.map((a) => a.reference_id || assetVersionId(a)))],
        locations: locationAsset ? [locationAsset.reference_id || assetVersionId(locationAsset)] : [],
        objects: [...new Set(objectAssets.map((a) => a.reference_id || assetVersionId(a)))],
      },
      reference_images: [...new Map([...characterAssets, ...(locationAsset ? [locationAsset] : []), ...objectAssets]
        .map((a) => [a.id, a])).values()]
        .filter((a) => a.reference)
        .map((a) => ({ asset_id: a.id, reference_id: a.reference_id || assetVersionId(a), version: Number(a.version) || 1, type: a.type, path: a.reference })),
    };
  };
  // "Minku (minku)" artifacts from identity strings carry no signal for the
  // image model — strip parentheticals that match a known bible id.
  const ids = [...charById.keys(),
    ...arr(bp.locations).map((l) => l.location_id),
    ...arr(bp.objects).map((o) => o.object_id)].filter(Boolean);
  const stripIds = (t) => {
    let out = String(t || "");
    for (const id of ids) {
      out = out.split(` (${id})`).join("").split(`(${id})`).join("");
    }
    return out.replace(/\s{2,}/g, " ").trim();
  };
  const identityOf = (c) => str(c.visual_identity_prompt) ||
    [c.name, Object.values(c.appearance || {}).join(", "), Object.values(c.clothing || {}).join(", ")]
      .filter(Boolean).join(", ");
  // Lyric-shot metadata passthrough: only non-empty values ride along so
  // story boards and old scenes produce byte-identical scenario configs.
  const lyricMeta = (s) => {
    const m = {};
    const o = s && typeof s === "object" ? s : {};
    for (const k of ["lyric_line_id", "parent_line_id", "lyric_text", "lyric_segment",
      "semantic_meaning", "visual_event", "shot_id", "shot_number",
      "song_start_time", "song_end_time", "continuity_required",
      "reference_source", "continuity_refs", "objects"]) {
      const v = o[k];
      if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
      m[k] = v;
    }
    return m;
  };
  // Motion must never re-describe the character (appearance words in an i2v
  // prompt invite the video model to redesign the face/outfit). Strip id
  // artifacts and enforce the fidelity lock so the clip only adds motion to
  // the keyframe that already carries the locked identity. Speaking beats
  // gain a frontal speaking-motion suffix (from the dialogue expression when
  // the model forgot one) so the face stays visible for lip-sync.
  const motionKey = motionKeyFor().toLowerCase();
  const withMotionLock = (s) => {
    let t = stripIds(String(s.video_prompt || "").trim());
    const explicitMotion = stripIds(str(s.motion).trim());
    if (explicitMotion && !t.toLowerCase().includes(explicitMotion.slice(0, 24).toLowerCase())) {
      t = t ? `${t}, Motion: ${explicitMotion}` : explicitMotion;
    }
    // Connected OFF = independent shots: drop any stored handoff language so
    // the clip prompt can't stage a continuation of the previous shot.
    if (!wantChain) t = stripContinuityText(t);
    const dlg = wantDialogue ? normalizeDialogue(s.dialogue) : [];
    if (dlg.length && !/speaking|talking|lip-?sync|mouth moving/i.test(t)) {
      const expr = dlg.map((d) => d.expression).find(Boolean) || str(s.expression).trim();
      t = t ? `${t}, ${expr ? `${expr} while speaking` : "speaking"}, mouth moving, clear face visible for lip-sync`
        : "speaking, mouth moving, clear face visible for lip-sync";
    }
    // Action-master pass: per-character motion from the rich direction block
    // (action + gaze shifts only — never looks, clothing or style, so the
    // clip animates the keyframe instead of redesigning it). Each piece is
    // probed separately so a present action never blocks a missing gaze
    // shift. Legacy scenes carry no characters_detailed and pass through
    // untouched.
    for (const c of arr(s.characters_detailed)) {
      const o = c && typeof c === "object" ? c : {};
      const gaze = str(o.gaze_target ?? o.gazeTarget).trim();
      const pieces = [str(o.action).trim(), gaze ? `turns to look at ${gaze}` : ""]
        .filter(Boolean);
      for (const bit of pieces) {
        if (bit && !t.toLowerCase().includes(bit.slice(0, 20).toLowerCase())) {
          t = t ? `${t}, ${bit}` : bit;
        }
      }
    }
    // Cinematographer pass: a non-static camera move must be IN the motion
    // prompt or the clip renders locked-off against the plan. Appended only
    // when the movement is non-static and no camera word is present.
    try {
      const cam = s && s.camera && typeof s.camera === "object" ? s.camera : {};
      const mv = str(cam.movement).trim();
      if (mv && !/^(static|locked)$/i.test(mv) && !/camera|pan|tilt|dolly|track|orbit|crane|push|pull|zoom/i.test(t)) {
        t = t ? `${t}, ${mv} camera move` : `${mv} camera move`;
      }
    } catch { /* camera assist is best-effort */ }
    // Same-scene linkage + quality: motion animates this scene's own
    // keyframe at 8k clarity with no distortion/morphing (never a redesign).
    if (!t) return MOTION_FIDELITY_LOCK;
    const hasFidelity = t.toLowerCase().includes(motionKey);
    const hasQuality = /8k uhd quality|no distortion|no morphing/i.test(t);
    if (hasFidelity && hasQuality) return t;
    if (hasFidelity) {
      return /8k uhd quality/i.test(t) ? t : `${t}, highly clear 8k uhd quality, smooth natural motion, stable character and background, no distortion, no morphing, no flicker, no blurry, no low quality`;
    }
    return `${t}, ${MOTION_FIDELITY_LOCK}`;
  };
  const withCastAndLock = (s, { referenceAnchored = false } = {}) => {
    let t = stripIds(s.image_prompt);
    if (s && s.identity_free === true) return t;
    // Connected OFF = independent shots: strip handoff language FIRST, before
    // context grounding re-appends identities/style/quality (the aggressive
    // generic strip may eat trailing tokens, which are all re-added below).
    if (!wantChain) {
      const cont = str(s.continuity_from_previous_scene).trim();
      if (cont) t = t.split(`continuing from previous shot: ${cont}`).join("");
      t = stripContinuityText(t);
    }
    const locById = new Map(arr(bp.locations).map((l) => [l.location_id, l]));
    const objById = new Map(arr(bp.objects).map((o) => [o.object_id, o]));
    for (const cid of [...arr(s.characters), ...arr(s.asset_refs && s.asset_refs.characters)]) {
      const c = charById.get(cid);
      const approved = assetFor("character", cid, s.asset_refs && s.asset_refs.characters);
      if (!c && !approved) continue;
      const ident = approved ? str(approved.prompt || approved.description) : identityOf(c);
      if (referenceAnchored && approved && approved.reference) {
        if (ident) t = t.split(ident).join("");
        continue;
      }
      // A bare name is not grounding — append the full identity unless its
      // head is already present. Anchor on the name when nothing richer
      // exists.
      const probe = (ident || c.name || "").slice(0, 24).toLowerCase();
      if (probe && !t.toLowerCase().includes(probe)) {
        t = t ? `${t}, ${ident || c.name}` : String(ident || c.name);
      }
    }
    // Location + object grounding: the model often drops these even though
    // the schema asked for verbatim paste — enforce server-side like the
    // cast, so backgrounds/props stop drifting between scenes.
    const loc = locById.get(s.location);
    const locAsset = assetFor("location", s.location, s.asset_refs && s.asset_refs.locations);
    const locIdent = locAsset ? str(locAsset.prompt || locAsset.description)
      : loc ? (str(loc.visual_identity_prompt) || str(loc.description)) : "";
    if (referenceAnchored && locAsset && locAsset.reference) {
      if (locIdent) t = t.split(locIdent).join("");
    } else if (locIdent) {
      const probe = locIdent.slice(0, 24).toLowerCase();
      if (probe && !t.toLowerCase().includes(probe)) t = t ? `${t}, ${locIdent}` : locIdent;
    }
    for (const ref of [...arr(s.objects), ...arr(s.continuity_refs), ...arr(s.asset_refs && s.asset_refs.objects)]) {
      const o = objById.get(ref);
      const objAsset = assetFor("object", ref, s.asset_refs && s.asset_refs.objects);
      const oi = objAsset ? str(objAsset.prompt || objAsset.description)
        : o ? (str(o.visual_identity_prompt) || str(o.description)) : "";
      if (referenceAnchored && objAsset && objAsset.reference) {
        if (oi) t = t.split(oi).join("");
      } else if (oi && !t.toLowerCase().includes(oi.slice(0, 24).toLowerCase())) t = t ? `${t}, ${oi}` : oi;
    }
    // Render the story expression in the keyframe: the image model never sees
    // the dialogue lines, so the scene/expression fields must travel in the
    // pixels (smiling, crying, shouting...). Appended only when missing so a
    // careful model is never double-described.
    const exprBits = [str(s.expression).trim(), str(s.emotion).trim(), str(s.body_language).trim()]
      .filter(Boolean).join(", ");
    if (exprBits && !t.toLowerCase().includes(exprBits.slice(0, 20).toLowerCase())) {
      t = t ? `${t}, ${exprBits}` : exprBits;
    }
    // Per-line dialogue expressions missing from the scene-level fields still
    // reach the frame (first one wins — one scene stays one moment).
    if (!exprBits) {
      const lineExpr = normalizeDialogue(s.dialogue).map((d) => d.expression).find(Boolean);
      if (lineExpr && !t.toLowerCase().includes(lineExpr.slice(0, 20).toLowerCase())) {
        t = t ? `${t}, ${lineExpr}` : lineExpr;
      }
    }
    // Action-master pass: per-character staging from the rich direction block
    // (physical action + gaze target + per-character expression). This is the
    // interaction choreography — who does what to whom while looking where —
    // and the image model never sees the structured fields, so it must travel
    // in the pixels. Each piece is probed separately so a present action
    // never blocks a missing gaze or expression. Legacy scenes carry no
    // characters_detailed and pass through untouched.
    for (const c of arr(s.characters_detailed)) {
      const o = c && typeof c === "object" ? c : {};
      const gaze = str(o.gaze_target ?? o.gazeTarget).trim();
      const pieces = [str(o.action).trim(), gaze ? `looking at ${gaze}` : "", str(o.expression).trim()]
        .filter(Boolean);
      for (const bit of pieces) {
        if (bit && !t.toLowerCase().includes(bit.slice(0, 20).toLowerCase())) {
          t = t ? `${t}, ${bit}` : bit;
        }
      }
    }
    // Cinematographer pass: a deliberately chosen non-default framing must be
    // IN the image prompt or the keyframe renders against the plan. Injected
    // only when non-default and no camera word is present, so legacy scenes
    // (Medium Shot / Eye Level / Static defaults) stay byte-identical.
    try {
      const cam = s && s.camera && typeof s.camera === "object" ? s.camera : {};
      const st = str(cam.shot_type).trim();
      const an = str(cam.angle).trim();
      const mv = str(cam.movement).trim();
      const hasCamWord = /shot|close-up|wide|aerial|over-the-shoulder|two shot|establishing|pov|angle|eye level|low angle|high angle|top down|static|pan|tilt|dolly|track|orbit|crane/i.test(t);
      if (!hasCamWord && (st || an || mv)) {
        const parts = [];
        if (st && !/^medium shot$/i.test(st)) parts.push(st);
        if (an && !/^eye level$/i.test(an)) parts.push(an);
        if (mv && !/^(static|locked)$/i.test(mv)) parts.push(`${mv} camera`);
        if (parts.length) t = t ? `${t}, ${parts.join(", ")}` : parts.join(", ");
      }
    } catch { /* camera assist is best-effort */ }
    // Continuity handoff (Connected ON only): the image model never sees
    // the continuity_from_previous_scene field, so append it (same clearing,
    // same framing, character mid-action from the last frame) unless the
    // prompt already carries it. When Connected is OFF the field is ignored
    // (handoff language was already stripped above, before grounding).
    if (wantChain) {
      const cont = str(s.continuity_from_previous_scene).trim();
      if (cont && !t.toLowerCase().includes(cont.slice(0, 24).toLowerCase())) {
        t = t ? `${t}, continuing from previous shot: ${cont}` : cont;
      }
    }
    // Anatomy integrity: the species body plan survives even when the model
    // forgot it (snake boards once rendered legs/ears). Per-character and
    // idempotent — boards without limbless/earless cast pass through
    // untouched, so legacy output stays byte-identical.
    {
      const sceneChars = arr(s.characters).map((cid) => charById.get(cid)).filter(Boolean);
      if (sceneChars.length) t = withAnatomyLock(t, sceneChars);
    }
    // Context + style + quality: the image prompt always carries the full
    // scene context above, the global style lock, AND the 8k/no-distortion
    // quality lock (idempotent — never doubled).
    if (!t) return withQualityLock(lock);
    let out = t.toLowerCase().includes(key.toLowerCase()) ? t : `${t}, ${lock}`;
    return withQualityLock(out);
  };
  // Director-to-project imports can preserve the saved scene directions
  // verbatim. This intentionally bypasses identity/style/quality suffixes and
  // motion fidelity additions; the project receives exactly the stored text.
  const imageFor = (s) => preservePrompts ? str(s.image_prompt) : withCastAndLock(s);
  const motionFor = (s) => preservePrompts ? str(s.video_prompt) : withMotionLock(s);
  const wantDialogue = input.includeDialogue !== false;
  const wantChain = input.chainContinuity === true;
  const main = chars.find((c) => /main/i.test(c.role || "")) || chars[0] || null;
  const locs = arr(bp.locations);
  const mainAsset = main && assetFor("character", main.character_id);
  const primaryLocAsset = locs[0] && assetFor("location", locs[0].location_id);
  const refParts = approvedAssets.length
    ? [lock]
    : [
      mainAsset ? (mainAsset.prompt || mainAsset.description) : main ? (main.visual_identity_prompt || main.name) : null,
      primaryLocAsset ? (primaryLocAsset.prompt || primaryLocAsset.description) : locs[0] ? (locs[0].visual_identity_prompt || locs[0].description) : null,
      lock,
    ].filter(Boolean);
  return {
    description: str(input.title) + (bp.logline ? ` — ${bp.logline}` : ""),
    ...(preservePrompts ? { directorPromptMode: "verbatim" } : {}),
    duration: Number(input.sceneSeconds) || 3,
    referencePrompt: withQualityLock(withAnatomyLock(stripIds(refParts.join(", ")), main ? [main] : [])),
    // Silent-film boards carry no dialogue into the pipeline (even if an old
    // scene still has lines, they are dropped here so Generate stays silent).
    // Connected boards keep TEXT continuity only (chainContinuity wording);
    // pixels stay strictly per-scene: every keyframe anchors on the
    // reference, every clip animates its own keyframe.
    ...(wantChain ? { chainContinuity: true } : {}),
    ...(input.song && typeof input.song === "object" && input.song.file
      ? {
        song: {
          file: str(input.song.file),
          fileName: str(input.song.fileName || "song.mp3"),
          durationSeconds: Math.round((Number(input.song.durationSeconds) || 0) * 1000) / 1000 || null,
        },
      }
      : {}),
    ...(input.sourceAudio && typeof input.sourceAudio === "object" && input.sourceAudio.file
      ? {
        sourceAudio: {
          file: str(input.sourceAudio.file),
          fileName: str(input.sourceAudio.fileName || "narration.wav"),
          durationSeconds: Math.round((Number(input.sourceAudio.durationSeconds) || 0) * 1000) / 1000 || null,
        },
      }
      : {}),
    // Multi-shot scenes flatten to one generation beat PER SHOT (each shot
    // is its own keyframe image + video clip at its own timed duration, so
    // one scene covering several entities renders as several connected
    // clips). Scenes without shots map 1:1 exactly as before — their beat
    // shape is byte-identical to the pre-shots output.
    sequence: scenes.flatMap((s, i) => {
      const sceneSlug = str(s.title, `scene${i + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || `scene${i + 1}`;
      const sceneDialogue = wantDialogue ? normalizeDialogue(s.dialogue) : [];
      const shots = Array.isArray(s.shots) && s.shots.length ? s.shots : null;
      if (!shots) {
        return [{
          title: sceneSlug,
          image: imageFor(s),
          // Flux 2 Klein uses the approved image itself to preserve identity;
          // this alternate keeps the scene direction/style while omitting
          // repeated descriptions for assets covered by real reference files.
          image_reference: preservePrompts ? str(s.image_prompt) : withCastAndLock(s, { referenceAnchored: true }),
          motion: motionFor(s),
          // Per-scene clip length (dialogue beats grow to fit the voice at
          // generation time — see beatTargetDuration/estimateDialogueDuration in
          // lib/tts.mjs). Emotion/expression ride along so TTS rate/pitch and the
          // lip-sync staging stay story-true without re-reading the board.
          duration: Number(s.duration_seconds) || Number(input.sceneSeconds) || 3,
          emotion: str(s.emotion),
          expression: str(s.expression),
          body_language: str(s.body_language),
          dialogue: sceneDialogue,
          // Scene location id (informational for the workspace UI/timeline;
          // every clip starts from its own keyframe regardless of location).
          location: str(s.location),
          identity_free: s.identity_free === true,
          ...resolvedRefs(s),
          // Lyric-shot metadata for the workspace UI (grouping, timeline,
          // continuity). The generation pipeline reads title/image/motion/
          // duration/dialogue unchanged — these keys are informational only.
          ...lyricMeta(s),
        }];
      }
      return shots.map((sh, k) => {
        const o = sh && typeof sh === "object" ? sh : {};
        const letter = String.fromCharCode(97 + Math.max(0, k)); // a, b, c...
        // Shot wins; the scene fills whatever the shot leaves blank. An
        // empty shot cast inherits the scene cast so grounding never drops
        // to nothing. Scene-level dialogue rides on the FIRST shot only —
        // later shots speak their own lines.
        const chars = arr(o.characters).length ? o.characters : s.characters;
        const dlg = wantDialogue
          ? (arr(o.dialogue).length ? normalizeDialogue(o.dialogue) : (k === 0 ? sceneDialogue : []))
          : [];
        // Rich per-character direction rides the same inheritance as the cast:
        // an empty shot-level list falls back to the scene's direction so the
        // interaction choreography is never silently dropped at flatten time.
        const dirDetail = arr(o.characters_detailed).length ? o.characters_detailed : s.characters_detailed;
        const merged = {
          ...s, ...o,
          characters: chars,
          characters_detailed: dirDetail,
          location: str(o.location) || str(s.location),
          dialogue: dlg,
        };
        // Song-absolute timing for the shot: the scene's song window plus
        // the shot's scene-relative offset (drives the song-synced UI and
        // any future per-shot mux alignment).
        const meta = { ...lyricMeta(s), ...lyricMeta(o) };
        const sceneSongStart = Number(s.song_start_time);
        const relStart = Number(o.start_time);
        const relEnd = Number(o.end_time);
        if (Number.isFinite(sceneSongStart) && Number.isFinite(relStart)) {
          meta.song_start_time = Math.round((sceneSongStart + relStart) * 10) / 10;
        }
        if (Number.isFinite(sceneSongStart) && Number.isFinite(relEnd)) {
          meta.song_end_time = Math.round((sceneSongStart + relEnd) * 10) / 10;
        }
        return {
          title: `${sceneSlug}_${letter}`,
          image: imageFor(merged),
          image_reference: preservePrompts ? str(merged.image_prompt) : withCastAndLock(merged, { referenceAnchored: true }),
          motion: motionFor(merged),
          duration: Number(o.duration_seconds) || Number(s.duration_seconds) || Number(input.sceneSeconds) || 3,
          emotion: str(merged.emotion),
          expression: str(merged.expression),
          body_language: str(merged.body_language),
          dialogue: dlg,
          location: str(merged.location),
          identity_free: merged.identity_free === true || o.identity_free === true,
          ...resolvedRefs(merged),
          // Scene/shot linkage for the workspace UI (grouping, timeline).
          scene_number: s.scene_number,
          shot_id: str(o.shot_id) || `${s.scene_number}-${String.fromCharCode(65 + Math.max(0, k))}`,
          shot_number: Number(o.shot_number) || k + 1,
          start_time: Number.isFinite(relStart) ? relStart : null,
          end_time: Number.isFinite(relEnd) ? relEnd : null,
          ...meta,
        };
      });
    }),
    // Language-aware voice defaults with explicit per-project/per-cast
    // overrides preserved. Unknown speakers use the matching language's
    // female default; known male/female archetypes are paired by voiceFor.
    tts: {
      ...(input.tts && typeof input.tts === "object" ? input.tts : {}),
      language: str(input.tts && input.tts.language || input.language || "Hindi"),
      defaultVoice: str(input.tts && input.tts.defaultVoice || (/^(en|english)/i.test(str(input.language)) ? "en-IN-NeerjaNeural" : "hi-IN-SwaraNeural")),
      voices: input.tts && input.tts.voices && typeof input.tts.voices === "object" ? input.tts.voices : {},
    },
  };
}

// ---------------------------------------------------------------------------
// Intelligent Director upgrade (backward-compatible extensions).
//
// Everything below ADDS new pure helpers without changing any existing export
// behaviour above: string-id casts keep working, old scenes normalize exactly
// as before, and boardToScenario output is byte-identical for legacy boards.
// New fields (character direction objects, dramatic purpose, continuity links,
// validation) ride along only when present.
// ---------------------------------------------------------------------------

// Logical pipeline stages (spec §15): persisted step by step so a failed
// stage never forces a full restart. The existing routes already map onto
// stages 1/3/6-8 (analyze/scenes/approve+generation); the new coverage +
// validate routes cover stage 5, and the builders below cover 2/4.
export const DIRECTOR_STAGES = [
  "story-analysis",
  "lyric-semantics",
  "scene-breakdown",
  "shot-direction",
  "coverage-validation",
  "image-generation",
  "video-motion",
  "final-assembly",
];

// Reasoning-engine model name. The transport stays the existing
// OpenAI-compatible llama-server convention (LLM_BASE); only the model id is
// pluggable so Muse Spark 1.3 can be used wherever the deployment points
// LLM_BASE at it (e.g. LLM_BASE=<spark endpoint> + LLM_MODEL=muse-spark-1.3).
// Defaults to the historical literal "local" — byte-identical behaviour.
export function llmModelName() {
  try {
    const v = process.env && process.env.LLM_MODEL;
    const t = String(v || "").trim();
    return t || "local";
  } catch { return "local"; }
}

// Genre-aware directing notes (spec §2): kids = clear friendly readable
// actions; devotional = respectful iconography, no slapstick/modern parody.
// Custom genre text is honoured when the board uses Genre = Custom.
export function genreDirectingNotes(genre, custom = "") {
  const g = `${String(genre || "")} ${String(custom || "")}`.toLowerCase();
  if (g.includes("devotional") || g.includes("myth")) {
    return "Devotional register: respectful iconography, serene expressions, traditional settings; never parody, slapstick, horror or modern-ironic readings of sacred figures.";
  }
  return "Cinematic register: observable filmable actions with clear cause and effect.";
}

// Learning-board specialty: which preset-style teaching the
// board does. 'kids' = generic kids content, null = not a kids board at all.
// Pure — drives the review checklist + OCR verification below.
export function learningFocus(genre, custom = "") {
  if (!isKidsGenre(genre, custom)) return null;
  const g = `${String(genre || "")} ${String(custom || "")}`.toLowerCase();
  if (/abc|alphabet|letter|phonics|अक्षर|वर्णमाला|akshar|varnamala/.test(g)) return "alphabet";
  if (/number|count|math|गिनती|संख्या|अंक|ginti/.test(g)) return "counting";
  if (/animal|जानवर|पशु|janwar|pashu/.test(g)) return "animals";
  if (/rhyme|nursery|lullaby|bedtime|लोरी|नर्सरी|तुकबंदी|lori/.test(g)) return "rhyme";
  return "kids";
}

// Number words for count extraction (English one–twenty + Hindi एक–बीस).
const COUNT_WORDS_EN = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
const COUNT_WORDS_HI = { एक: 1, दो: 2, तीन: 3, चार: 4, "पाँच": 5, पांच: 5, छह: 6, "छः": 6, सात: 7, आठ: 8, नौ: 9, दस: 10, ग्यारह: 11, बारह: 12, तेरह: 13, चौदह: 14, पंद्रह: 15, सोलह: 16, सत्रह: 17, अठारह: 18, उन्नीस: 19, बीस: 20 };
// Time/quantity words that follow a number word without meaning a visible
// count ("one day", "एक दिन") — excluded so the checklist stays signal.
const COUNT_STOP = /^(day|days|morning|night|time|times|thing|things|more|another|side|दिन|बार|साथ|तरफ|बात)$/i;
const DEVA_DIGIT = { "०": "0", "१": "1", "२": "2", "३": "3", "४": "4", "५": "5", "६": "6", "७": "7", "८": "8", "९": "9" };
const devaToLatin = (t) => String(t || "").replace(/[०-९]/g, (d) => DEVA_DIGIT[d]);

// Extract what one scene promises to TEACH from its texts (titles, actions,
// lyric segments, dialogue). focus gates the patterns: 'alphabet' finds
// hero letters (A for Apple, letter B, अक्षर अ, अ से अनार), 'counting'
// finds visible counts (5 ducks, five stars, ५ तारे, number 5). Returns
// sorted unique { letters, counts }. Pure — unit-tested.
export function extractLearningExpectations(texts, focus) {
  const letters = new Set();
  const counts = new Set();
  const lines = arr(texts).map((x) => str(x)).filter(Boolean);
  if (focus === "alphabet") {
    const pats = [
      /\bletter\s+([A-Za-z])/gi,
      /\b([A-Z])\s+for\s+[A-Za-z\u0900-\u097F]/g,
      /\b([A-Z])\s*[-–:]\s*[A-Za-z]/g,
      /अक्षर\s*([A-Za-z\u0900-\u097F])/g,
      /([अ-ह])\s+से\s/g,
    ];
    for (const line of lines) {
      for (const re of pats) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line))) {
          const c = m[1];
          if (/^[A-Za-z]$/.test(c)) letters.add(c.toUpperCase());
          else if (/^[अ-ह]$/.test(c)) letters.add(c);
        }
      }
    }
  }
  if (focus === "counting") {
    const enWord = Object.keys(COUNT_WORDS_EN).join("|");
    const hiWord = Object.keys(COUNT_WORDS_HI).join("|");
    for (const line of lines) {
      const lat = devaToLatin(line);
      let m;
      const digitRe = /(\d{1,2})\s+[A-Za-z\u0900-\u097F]+/g;
      digitRe.lastIndex = 0;
      while ((m = digitRe.exec(lat))) {
        const n = Number(m[1]);
        if (n >= 1 && n <= 99) counts.add(n);
      }
      const numRe = /(?:number|संख्या|नंबर|no\.?)\s*:?\s*(\d{1,2})/gi;
      numRe.lastIndex = 0;
      while ((m = numRe.exec(lat))) {
        const n = Number(m[1]);
        if (n >= 1 && n <= 99) counts.add(n);
      }
      const wordRe = new RegExp(`\\b(${enWord})\\s+([A-Za-z\u0900-\u097F]+)`, "gi");
      wordRe.lastIndex = 0;
      while ((m = wordRe.exec(line))) {
        if (COUNT_STOP.test(m[2])) continue;
        counts.add(COUNT_WORDS_EN[m[1].toLowerCase()]);
      }
      const hiRe = new RegExp(`(${hiWord})\\s+([A-Za-z\u0900-\u097F]+)`, "g");
      hiRe.lastIndex = 0;
      while ((m = hiRe.exec(line))) {
        if (COUNT_STOP.test(m[2])) continue;
        const n = COUNT_WORDS_HI[m[1]];
        if (n) counts.add(n);
      }
    }
  }
  return { letters: [...letters].sort(), counts: [...counts].sort((a, b) => a - b) };
}

// All teach-relevant texts of one board scene (scene + shot level).
export function sceneLearningTexts(s) {
  const o = s && typeof s === "object" ? s : {};
  const out = [o.title, o.action, o.visual_event, o.lyric_segment];
  for (const d of arr(o.dialogue)) out.push(d && d.line);
  for (const sh of arr(o.shots)) {
    const x = sh && typeof sh === "object" ? sh : {};
    out.push(x.action, x.lyric_segment, x.visual_event);
    for (const d of arr(x.dialogue)) out.push(d && d.line);
  }
  return out.map((x) => str(x)).filter(Boolean);
}

// Advisory pre-generation checklist for alphabet/counting boards: what each
// scene must SHOW (hero letterforms, exact counts + numerals) so a human —
// or scripts/verify_learning.mjs — confirms keyframes BEFORE clips render.
// [] for all other boards. Capped at 12. Pure — surfaced in validate warnings.
export function learningReviewChecklist(board) {
  const b = board && typeof board === "object" ? board : {};
  const input = b.input && typeof b.input === "object" ? b.input : {};
  const focus = learningFocus(input.genre, input.genreCustom);
  if (focus !== "alphabet" && focus !== "counting") return [];
  const out = [];
  arr(b.scenes).forEach((s, i) => {
    if (out.length >= 12 || !s || typeof s !== "object") return;
    const label = `Scene ${s.scene_number || i + 1}`;
    const exp = extractLearningExpectations(sceneLearningTexts(s), focus);
    if (focus === "alphabet") {
      if (!exp.letters.length) out.push(`${label}: no hero letter detected in the plan — confirm what this scene teaches before generating clips.`);
      for (const L of exp.letters) out.push(`${label}: must show letter "${L}" BIG, centered and perfectly formed — verify the keyframe (scripts/verify_learning.mjs) before clips.`);
    } else {
      if (!exp.counts.length) out.push(`${label}: no countable group detected in the plan — confirm what this scene counts before generating clips.`);
      for (const n of exp.counts) out.push(`${label}: must show exactly ${n} countable objects beside numeral ${n} — verify count + numeral on the keyframe before clips.`);
    }
  });
  return out.slice(0, 12);
}

// Compare Tesseract OCR text of a keyframe against expectations. Letters
// must appear as standalone characters (a "B" inside "Ball" still counts —
// the hero letter is what matters); counts must appear as numeral tokens
// (Devanagari digits normalized). Pure — unit-tested.
export function verifyOcrText(expected, ocrText) {
  const exp = expected && typeof expected === "object" ? expected : {};
  const t = devaToLatin(str(ocrText));
  const missingLetters = [];
  for (const L of arr(exp.letters)) {
    const c = str(L);
    if (!c) continue;
    const found = /^[A-Za-z]$/.test(c)
      ? t.split(/[^A-Za-z]+/).some((token) => token.toUpperCase() === c.toUpperCase())
      : t.split(/[^\u0900-\u097F]+/).some((token) => token === c);
    if (!found) missingLetters.push(c);
  }
  const missingCounts = [];
  const tokens = t.split(/[^0-9]+/).filter(Boolean);
  for (const n of arr(exp.counts)) {
    if (!tokens.includes(String(Number(n)))) missingCounts.push(Number(n));
  }
  return { ok: !missingLetters.length && !missingCounts.length, missingLetters, missingCounts };
}

// Split one lyric line into meaningful phrases (spec §3). Deterministic:
// punctuation split first, then length-based split on conjunctions so long
// lines yield 2-4 phrases without inventing words. Offsets are char ranges.
export function extractMeaningfulPhrases(lyricText) {
  const t = String(lyricText || "").trim();
  if (!t) return [];
  const parts = t
    .split(/[|;—–:!?()\[\]"“”'']+/)
    .flatMap((p) => String(p).split(/,/))
    .map((p) => p.trim())
    .filter((p) => p.length > 1);
  const base = parts.length ? parts : [t];
  const out = [];
  for (const p of base) {
    const sub = String(p).split(/\s+(?:and|or|then|aur|or|phir|और|फिर)\s+/i)
      .map((x) => x.trim()).filter((x) => x.length > 1);
    const picks = sub.length > 1 && p.length > 40 ? sub : [p];
    for (const q of picks) {
      const start = t.indexOf(q, out.length ? out[out.length - 1].end : 0);
      out.push({ text: q, start: start >= 0 ? start : 0, end: (start >= 0 ? start : 0) + q.length });
    }
  }
  return out.slice(0, 6);
}

// Normalize one cast entry: string ids pass through as before; rich direction
// objects (spec §5/§11) normalize to a stable shape. Never throws.
export function normalizeCastEntry(c) {
  if (typeof c === "string" || typeof c === "number") {
    const id = idStr(c);
    return id ? { character_id: id, role: "", emotion: "", gaze_target: "", starting_state: "", action: "", ending_state: "", expression: "" } : null;
  }
  const o = c && typeof c === "object" ? c : null;
  if (!o) return null;
  const id = slugId(o.characterId ?? o.character_id ?? o.id ?? o.name, "");
  if (!id) return null;
  const s = (v, n = 140) => str(v).slice(0, n);
  return {
    character_id: id,
    role: /^(active|reacting|supporting|observing)$/i.test(str(o.role)) ? str(o.role).toLowerCase() : "",
    emotion: s(o.emotion, 60),
    gaze_target: s(o.gazeTarget ?? o.gaze_target, 80),
    starting_state: s(o.startingState ?? o.starting_state),
    action: s(o.action, 300),
    ending_state: s(o.endingState ?? o.ending_state),
    expression: s(o.expression, 120),
  };
}

// Id list for any mixed cast array (backward-compat bridge used by grounding).
export function castIdsOf(list) {
  return arr(list).map((c) => {
    if (typeof c === "string" || typeof c === "number") return idStr(c);
    const n = normalizeCastEntry(c);
    return n ? n.character_id : "";
  }).filter(Boolean);
}

// Rich per-character direction for one scene/shot (spec §5): [] when none.
export function characterDirectionsOf(s) {
  const o = s && typeof s === "object" ? s : {};
  const raw = Array.isArray(o.characters_detailed) && o.characters_detailed.length
    ? o.characters_detailed
    : arr(o.characters);
  return raw.map(normalizeCastEntry).filter(Boolean);
}

// Shot-type / camera vocabulary (spec §6). normalizeCamera maps free text to
// the controlled vocabulary, keeping the raw text as fallback (never drops).
export const SHOT_TYPES = [
  "establishing shot", "wide shot", "medium shot", "medium close-up",
  "close-up", "reaction shot", "point-of-view shot", "over-the-shoulder shot",
  "tracking shot", "insert shot", "detail shot", "action shot", "transition shot",
];
export const CAMERA_MOVEMENTS = [
  "static", "pan", "tilt", "dolly", "tracking", "crane", "orbit",
  "gentle tracking", "slow push-in", "slow pull-back",
];
export function normalizeCamera(cam) {
  const o = cam && typeof cam === "object" ? cam : {};
  const pick = (v, vocab, fb) => {
    const t = str(v).trim();
    if (!t) return fb;
    const low = t.toLowerCase();
    const hit = vocab.find((x) => low.includes(x));
    return hit || t.slice(0, 60);
  };
  return {
    shot_type: pick(o.shot_type ?? o.shotType, SHOT_TYPES, "Medium Shot"),
    angle: str(o.angle || "Eye Level").slice(0, 40) || "Eye Level",
    movement: pick(o.movement, CAMERA_MOVEMENTS, "Static"),
    composition: str(o.composition).slice(0, 200),
  };
}

// Per-shot direction quality (spec §4/§12): flags vague/decorative direction.
// Returns issue strings (empty = clear filmable action).
const ACTION_VERBS = /notic|look|gaze|stare|point|hop|jump|walk|run|pick|lift|hold|eat|give|take|hand|offer|open|close|dance|sing|speak|turn|nod|bow|smile|cry|laugh|trembl|step|reach|touch|carry|bring|chase|follow|sit|stand|kneel|fly|swim|play|cook|pray|bless|dekh|uth|kha|chal|daud|nach|gaa|नाच|गा|दौड़|दौड|चल|देख|उठ|खा|हँस|रो|निहार|उछल|कूद|बैठ|खड़ा|उड़|तैर|पूजा|प्रार्थना|आशीर्वाद/i;
const VAGUE_PAT = /^(happy|sad|beautiful|nice|good|amazing|wonderful|lovely|great|fun|magical)\b/i;
// Single-word decorative action that carries no filmable movement — shared by
// the direction validator and the coverage evidence check so both agree on
// what counts as a real staged action.
export function isVagueActionText(t) {
  const s = String(t || "").trim();
  return !!s && VAGUE_PAT.test(s) && s.split(/\s+/).length < 6;
}
export function validateShotDirection(s) {
  const o = s && typeof s === "object" ? s : {};
  const issues = [];
  const action = str(o.action || o.visual_event || o.visualEvent);
  const img = str(o.image_prompt || o.imagePrompt);
  const vid = str(o.video_prompt || o.videoPrompt);
  if (!action && !img) issues.push("no action or visual event described");
  else if (isVagueActionText(action)) {
    issues.push(`vague action ("${action.slice(0, 60)}") — describe observable movement`);
  } else if (action && !ACTION_VERBS.test(action) && action.length < 140) {
    issues.push("action has no filmable verb — say what the character physically does");
  }
  if (img && vid && img.trim() === vid.trim()) issues.push("image and video prompts are identical");
  if (vid && !/mov|pan|tilt|dolly|track|orbit|crane|zoom|walk|run|fly|dance|turn|nod|gestur|wav|blink|smile|flow|drift|rise|fall|sway|glid|camera|slow|push|pull|static/i.test(vid)) {
    issues.push("video prompt describes no motion");
  }
  const cam = o.camera && typeof o.camera === "object" ? o.camera : {};
  if (/locked|static/i.test(str(cam.movement)) && /track|dolly|orbit|crane/i.test(vid)) {
    issues.push("contradictory camera: static framing with a tracking move");
  }
  return issues;
}

// Lyric Coverage Map (spec §3 + §12): every meaningful phrase -> covering shots.
// A phrase counts as covered ONLY when a scene/shot both links to the line
// (lyric id match or segment text match) AND stages an identifiable visible
// action for it (lyric_segment / visual_event / action present). An id link
// alone with no action is not coverage — it is flagged uncovered so the
// validator forces a real staging instead of a bare id reference.
export function buildLyricCoverageMap(scenes, lyricLines) {
  const list = arr(scenes);
  const lines = arr(lyricLines);
  const flat = [];
  for (const s of list) {
    flat.push(s);
    for (const sh of arr(s && s.shots)) flat.push({ ...sh, _parent: s });
  }
  return lines.map((l, i) => {
    const id = Number(l.lyric_line_id) || i + 1;
    const text = str(l.lyric_text || l.text);
    const phrases = extractMeaningfulPhrases(text);
    const segs = phrases.map((p) => {
      const needle = p.text.toLowerCase();
      const hits = [];
      for (const s of flat) {
        const o = s && typeof s === "object" ? s : {};
        const lid = Number(o.lyric_line_id ?? o.parent_line_id);
        const hay = `${str(o.lyric_segment)} ${str(o.semantic_meaning)} ${str(o.visual_event)} ${str(o.action)} ${str(o.lyric_text)}`.toLowerCase();
        const idHit = Number.isFinite(lid) && lid === id;
        // Text fallback is best-effort only: require a non-trivial haystack
        // so empty/generic scenes never claim coverage of every phrase.
        const hayTrim = hay.trim();
        const textHit = needle.length > 3 && hayTrim.length > 3
          && (hay.includes(needle.slice(0, Math.min(24, needle.length))) || needle.includes(hayTrim.slice(0, 24)));
        // Visible-action evidence (§12): the shot must stage something
        // filmable for the line — a bare lyric_line_id with an empty or
        // decorative action ("happy") never counts as coverage.
        const evidence = `${str(o.lyric_segment)} ${str(o.visual_event)} ${str(o.action)}`.trim();
        const hasEvidence = evidence.length >= 4 && !isVagueActionText(evidence);
        if ((idHit || textHit) && hasEvidence) {
          hits.push({
            scene_id: o.scene_number != null ? o.scene_number : (o._parent ? o._parent.scene_number : null),
            shot_id: str(o.shot_id) || null,
          });
        }
      }
      const covered = hits.length > 0;
      return {
        text: p.text, meaning: "", startMs: null, endMs: null,
        coveredByShot: covered, coverage: covered ? "covered" : "uncovered",
        sceneIds: [...new Set(hits.map((h) => h.scene_id).filter((v) => v != null))],
        shotIds: hits.map((h) => h.shot_id).filter(Boolean),
      };
    });
    const coveredCount = segs.filter((s) => s.coveredByShot).length;
    return {
      lyric_line_id: id, lyric_text: text, phrases: segs,
      status: !segs.length ? "empty" : coveredCount === segs.length ? "covered" : coveredCount === 0 ? "uncovered" : "partial",
    };
  });
}

export function coverageSummary(map) {
  const m = arr(map);
  let total = 0, covered = 0;
  for (const l of m) for (const p of arr(l.phrases)) { total++; if (p.coveredByShot) covered++; }
  return { totalPhrases: total, coveredPhrases: covered, pct: total ? Math.round((covered / total) * 100) : 100 };
}

// Continuity contradictions (spec §8): deterministic, text-based, advisory.
// Detects location jumps without a transition, abrupt emotion flips for the
// same character, and dropped object refs. Returns issue strings.
const EMOTION_FLIP_PAIRS = new Set([
  "happy→sad", "sad→happy", "happy→angry", "angry→happy",
  "joyful→crying", "crying→joyful", "laughing→crying", "crying→laughing",
  "calm→angry", "angry→calm", "excited→scared", "scared→excited",
  "happy→crying", "crying→happy", "joyful→sad", "sad→joyful",
  "calm→sad", "sad→calm", "excited→sad", "sad→excited",
]);
export function detectContinuityIssues(scenes) {
  const issues = [];
  const list = arr(scenes);
  const dirOf = (s) => characterDirectionsOf(s);
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1] && typeof list[i - 1] === "object" ? list[i - 1] : {};
    const b = list[i] && typeof list[i] === "object" ? list[i] : {};
    const la = str(a.location).trim(), lb = str(b.location).trim();
    if (la && lb && la.toLowerCase() !== lb.toLowerCase()) {
      const bridged = str(a.transition_to_next_scene).trim() || str(b.continuity_from_previous_scene).trim()
        || (b.continuity_required === true);
      if (!bridged) issues.push(`scene ${b.scene_number || i + 1}: location jumps "${la}" → "${lb}" with no transition`);
    }
    const ea = new Map(dirOf(a).map((c) => [c.character_id, c.emotion.toLowerCase()]));
    for (const c of dirOf(b)) {
      const prev = ea.get(c.character_id);
      const cur = c.emotion.toLowerCase();
      if (prev && cur && EMOTION_FLIP_PAIRS.has(`${prev}→${cur}`)) {
        issues.push(`scene ${b.scene_number || i + 1}: ${c.character_id} flips ${prev} → ${cur} with no narrative bridge`);
      }
    }
    const refsA = new Set(arr(a.continuity_refs).map((x) => String(x).toLowerCase()));
    const refsB = new Set(arr(b.continuity_refs).map((x) => String(x).toLowerCase()));
    for (const r of refsA) {
      if (r && !refsB.has(r) && !str(b.action).toLowerCase().includes(r) && !str(b.visual_event).toLowerCase().includes(r)) {
        issues.push(`scene ${b.scene_number || i + 1}: object "${r}" staged before but dropped with no resolve`);
        break;
      }
    }
  }
  return [...new Set(issues)];
}

// Configurable 0–100 quality score (spec §12): explicit rules, never bare AI
// confidence. Weights overridable via the second arg.
export function scoreDirectorPlan(board, opts = {}) {
  const b = board && typeof board === "object" ? board : {};
  const scenes = arr(b.scenes);
  const lines = arr(b.blueprint && b.blueprint.lyric_lines);
  const target = Number(b.input && (b.input.targetSeconds ?? b.input.target_seconds));
  const w = { lyric: 30, action: 20, continuity: 15, timing: 15, prompts: 20, ...(opts.weights || {}) };
  const issues = [];
  // Lyric coverage (30).
  let lyricScore = 100;
  if (lines.length) {
    const map = buildLyricCoverageMap(scenes, lines);
    const sum = coverageSummary(map);
    lyricScore = sum.pct;
    for (const l of map) {
      if (l.status === "uncovered") issues.push(`lyric line ${l.lyric_line_id} has no visual shot: "${l.lyric_text.slice(0, 60)}"`);
      else if (l.status === "partial") issues.push(`lyric line ${l.lyric_line_id} is only partially covered`);
    }
  } else if (!scenes.length) { lyricScore = 0; issues.push("no scenes planned"); }
  // Action clarity (20).
  let vague = 0, checked = 0;
  for (const s of scenes) {
    checked++;
    const iss = validateShotDirection(s);
    if (iss.length) { vague++; issues.push(`scene ${s.scene_number}: ${iss[0]}`); }
    for (const sh of arr(s.shots)) {
      checked++;
      const si = validateShotDirection(sh);
      if (si.length) { vague++; issues.push(`shot ${sh.shot_id || s.scene_number}: ${si[0]}`); }
    }
  }
  const actionScore = checked ? Math.round(((checked - vague) / checked) * 100) : 100;
  // Continuity (15).
  const contIssues = [...detectContinuityIssues(scenes)];
  for (const s of scenes) {
    if (s.continuity_required === true && normalizeReferenceSource(s.reference_source) === "NONE") {
      contIssues.push(`scene ${s.scene_number}: continuity_required but reference_source is NONE`);
    }
  }
  for (const c of contIssues) issues.push(c);
  const continuityScore = Math.max(0, 100 - contIssues.length * 12);
  // Timing (15).
  let timingScore = 100;
  if (Number.isFinite(target) && target > 0 && scenes.length) {
    const sum = scenes.reduce((x, s) => x + (Number(s.duration_seconds) || 0), 0);
    const drift = Math.abs(sum - target) / target;
    timingScore = drift <= 0.05 ? 100 : drift <= 0.15 ? 80 : drift <= 0.3 ? 55 : 25;
    if (drift > 0.15) issues.push(`shot durations sum to ~${Math.round(sum)}s but the target is ~${Math.round(target)}s`);
  }
  for (const s of scenes) {
    if (arr(s.shots).length > 1) {
      const sum = arr(s.shots).reduce((x, q) => x + (Number(q.duration_seconds) || 0), 0);
      if (Math.abs(sum - (Number(s.duration_seconds) || 0)) > 0.2) {
        issues.push(`scene ${s.scene_number}: shots do not tile the scene duration`);
        timingScore = Math.min(timingScore, 60);
      }
    }
  }
  // Prompt completeness (20).
  let missing = 0, total = 0;
  for (const s of scenes) {
    total++;
    if (!str(s.image_prompt).trim() || !str(s.video_prompt).trim()) { missing++; issues.push(`scene ${s.scene_number}: missing image or video prompt`); }
  }
  const promptScore = total ? Math.round(((total - missing) / total) * 100) : 0;
  const wSum = w.lyric + w.action + w.continuity + w.timing + w.prompts || 1;
  const score = Math.round((lyricScore * w.lyric + actionScore * w.action + continuityScore * w.continuity + timingScore * w.timing + promptScore * w.prompts) / wSum);
  return {
    score,
    breakdown: { lyricCoverage: lyricScore, actionClarity: actionScore, continuity: continuityScore, timing: timingScore, promptCompleteness: promptScore },
    issues: [...new Set(issues)],
    coverage: lines.length ? coverageSummary(buildLyricCoverageMap(scenes, lines)) : { totalPhrases: 0, coveredPhrases: 0, pct: 100 },
  };
}

// Staged repair prompt (spec §15.9): asks the reasoning engine to fix ONLY
// the flagged scenes/shots, preserving ids and approved neighbours.
export function buildDirectionRepairPrompt({ input, blueprint, scenes, issues, semantics = [], approvedAssets = [], promptAddons = "" }) {
  const b = blueprint || {};
  const approvedByBlueprint = new Map(arr(approvedAssets).filter((a) => a && a.blueprint_id)
    .map((a) => [str(a.blueprint_id), a]));
  const identityRows = (rows, key, fallback) => arr(rows).map((x) => {
    const id = str(x && x[key]);
    const asset = approvedByBlueprint.get(id);
    return asset ? `- ${str(x.name)} (${id}; asset ${str(asset.id)})` : fallback(x);
  }).join("\n");
  const ctx = {
    chars: identityRows(b.characters, "character_id", (x) => `- ${x.name} (${x.character_id}): ${x.visual_identity_prompt || describeFallback(x)}`),
    locs: identityRows(b.locations, "location_id", (x) => `- ${x.name} (${x.location_id}): ${x.visual_identity_prompt || x.description}`),
    objs: identityRows(b.objects, "object_id", (x) => `- ${x.name} (${x.object_id}): ${x.visual_identity_prompt || x.description}`),
  };
  // The meaning of the flagged scenes: a repair must restore the LINE's
  // meaning, not just the flag.
  const semanticRows = arr(semantics);
  const meaning = semanticRows.length
    ? `\nMEANING OF THE LINES (the repaired scene MUST show this — the source line, its interpretation and the visible action):\n${semanticRows.map((r) => {
      const acts = arr(r.action_plan).map((a) => `${a.action} [${a.body_part}]`).join("; ");
      return `- Line ${r.line_id}: ${str(r.source_text)}\n    meaning: ${str(r.interpretation)}\n    visible action: ${acts || "(state it explicitly)"}\n    camera: ${r.camera ? `${str(r.camera.shot_type)} / ${str(r.camera.angle)} / ${str(r.camera.movement)}` : "(choose one that follows the meaning)"}`;
    }).join("\n")}`
    : "";
  return [
    `You are the repair director. Fix ONLY the flagged shots below. Keep every scene_number/shot_id unchanged, keep unflagged scenes byte-identical, keep the same JSON schema as the scene plan.`,
    `Genre note: ${genreDirectingNotes(input && input.genre, input && input.genreCustom)}.`,
    approvedByBlueprint.size
      ? `ASSET IDS (the server resolves approved prompts after planning; do not copy descriptions into scenes): ${arr(approvedAssets).map((a) => `${a.reference_id || assetVersionId(a)}=${a.name} (v${Number(a.version) || 1})`).join(", ")}`
      : null,
    `CHARACTER IDENTITIES:\n${ctx.chars || "(none)"}`,
    `LOCATIONS:\n${ctx.locs || "(none)"}`,
    `OBJECTS:\n${ctx.objs || "(none)"}`,
    `ISSUES:\n${arr(issues).map((x) => `- ${x}`).join("\n") || "(none)"}`,
    meaning,
    promptAddons || null,
    `SCENES TO REPAIR:\n${JSON.stringify(arr(scenes), null, 1).slice(0, 9000)}`,
    `Return JSON: { "scenes": [ ...fixed scenes... ] }. Respond with JSON ONLY.`,
    outputLanguageRule(input && input.language),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Chief Director orchestration (film-production departments 1+7): the Story
// Plan is the authoritative source every downstream stage traces back to.
// Pure — the server persists via PUT, the storyboard renders read-only.
// A Story Plan carries: narrative outline (beginning/development/climax/
// resolution), character roster with motivations, lyric coverage expectations,
// production tasks with stage dependencies, recorded uncertainties (missing
// narrative info), and per-stage approvals. Never throws.
// ---------------------------------------------------------------------------
export const STORY_PLAN_VERSION = 1;

const PLAN_TASK_DEFS = [
  { id: "analyze-story", label: "Analyze story + asset bible", stage: "story-analysis", dependsOn: [] },
  { id: "lyric-semantics", label: "Decompose lyrics into singable lines", stage: "lyric-semantics", dependsOn: ["analyze-story"] },
  { id: "scene-breakdown", label: "Plan scene breakdown covering all lines", stage: "scene-breakdown", dependsOn: ["lyric-semantics"] },
  { id: "shot-direction", label: "Direct every shot (camera + action + prompts)", stage: "shot-direction", dependsOn: ["scene-breakdown"] },
  { id: "coverage-check", label: "Check lyric coverage + quality score", stage: "coverage-validation", dependsOn: ["shot-direction"] },
  { id: "repair-flagged", label: "Repair flagged shots", stage: "coverage-validation", dependsOn: ["coverage-check"] },
  { id: "approve-plan", label: "Approve plan for production", stage: "coverage-validation", dependsOn: ["repair-flagged"] },
  { id: "generate-keyframes", label: "Generate keyframes (image stage)", stage: "image-generation", dependsOn: ["approve-plan"] },
  { id: "generate-clips", label: "Generate clips (video/motion stage)", stage: "video-motion", dependsOn: ["generate-keyframes"] },
  { id: "assemble-final", label: "Assemble + validate final cut", stage: "final-assembly", dependsOn: ["generate-clips"] },
];

export function normalizeStoryPlan(raw) {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const struct = o.structure && typeof o.structure === "object" ? o.structure : {};
  const task = (t, i) => {
    const x = t && typeof t === "object" ? t : {};
    const id = idStr(x.id) || `task_${i + 1}`;
    const def = PLAN_TASK_DEFS.find((d) => d.id === id);
    const deps = arr(x.dependsOn).map(idStr).filter(Boolean).slice(0, 4);
    return {
      id,
      label: str(x.label, def ? def.label : id),
      stage: DIRECTOR_STAGES.includes(x.stage) ? x.stage : (def ? def.stage : DIRECTOR_STAGES[0]),
      status: ["pending", "ready", "done", "approved"].includes(x.status) ? x.status : "pending",
      dependsOn: deps.length ? deps : (def && def.dependsOn ? [...def.dependsOn] : []),
    };
  };
  const roster = (r) => {
    const x = r && typeof r === "object" ? r : {};
    const id = idStr(x.character_id ?? x.id ?? x.name);
    if (!id) return null;
    return {
      character_id: id,
      name: str(x.name, id),
      role: str(x.role).slice(0, 80),
      motivation: str(x.motivation).slice(0, 300),
    };
  };
  const ap = o.approvals && typeof o.approvals === "object" && !Array.isArray(o.approvals) ? o.approvals : {};
  const approvals = {};
  for (const s of DIRECTOR_STAGES) {
    if (typeof ap[s] === "string" && ap[s]) approvals[s] = ap[s].slice(0, 40);
  }
  return {
    version: STORY_PLAN_VERSION,
    logline: str(o.logline).slice(0, 500),
    theme: str(o.theme).slice(0, 500),
    structure: {
      beginning: str(struct.beginning).slice(0, 800),
      development: str(struct.development).slice(0, 800),
      climax: str(struct.climax).slice(0, 800),
      resolution: str(struct.resolution).slice(0, 800),
    },
    narrativeOutline: arr(o.narrativeOutline ?? o.narrative_outline).map((x) => str(x).slice(0, 300)).filter(Boolean).slice(0, 40),
    characterRoster: arr(o.characterRoster ?? o.character_roster).map(roster).filter(Boolean).slice(0, 40),
    uncertainties: arr(o.uncertainties).map((x) => str(x).slice(0, 300)).filter(Boolean).slice(0, 20),
    productionTasks: (arr(o.productionTasks ?? o.production_tasks).map(task).filter((t) => t.id) || []).slice(0, 40),
    approvals,
    revisions: Math.max(0, Number(o.revisions) || 0),
    // Department artefacts (Phase 1+): opaque but normalized so every
    // department traces back to the Story Plan. Absent on legacy plans.
    visualGuide: str(o.visualGuide ?? o.visual_guide).slice(0, 2000),
    cinematography: str(o.cinematography).slice(0, 2000),
    motionPlan: str(o.motionPlan ?? o.motion_plan).slice(0, 2000),
    audioSync: str(o.audioSync ?? o.audio_sync).slice(0, 2000),
    editPlan: str(o.editPlan ?? o.edit_plan).slice(0, 2000),
  };
}

// Chief Director approval checkpoint: sign off one DIRECTOR_STAGES stage.
// Validates stage id + dependency order via stageStatus(); user overrides
// allowed with { force: true }. Returns { plan, error }. Pure.
export function chiefApproveStage(board, stage, { force = false } = {}) {
  const b = board && typeof board === "object" ? board : {};
  if (!DIRECTOR_STAGES.includes(stage)) return { plan: normalizeStoryPlan(b.storyPlan), error: `unknown stage "${str(stage)}"` };
  const statuses = stageStatus(b);
  const idx = DIRECTOR_STAGES.indexOf(stage);
  const depMet = idx === 0 || statuses[idx - 1].status === "done" || statuses[idx - 1].status === "approved";
  if (!depMet && !force) {
    return { plan: normalizeStoryPlan(b.storyPlan), error: `stage "${stage}" blocked: complete "${DIRECTOR_STAGES[idx - 1]}" first` };
  }
  const prev = normalizeStoryPlan(b.storyPlan);
  const plan = normalizeStoryPlan({
    ...prev,
    approvals: { ...prev.approvals, [stage]: new Date().toISOString().slice(0, 19) + "Z" },
    revisions: prev.revisions + 1,
  });
  return { plan, error: null };
}

// Lyric coverage gate for the Chief Director: phrases still uncovered,
// enriched with estimated timing when available. Pure.
export function uncoveredPhrases(board) {
  const b = board && typeof board === "object" ? board : {};
  const lines = boardLyricLines(b);
  const timed = estimateLyricTiming(lines, Number(b.input && (b.input.targetSeconds ?? b.input.target_seconds)) || 0);
  const timeById = new Map(timed.map((l) => [Number(l.lyric_line_id), l]));
  const map = buildLyricCoverageMap(arr(b.scenes), lines);
  const out = [];
  for (const l of map) {
    const t = timeById.get(Number(l.lyric_line_id)) || {};
    const s0 = Number(t.song_start_time);
    const e0 = Number(t.song_end_time);
    for (const p of arr(l.phrases)) {
      if (!p.coveredByShot) {
        out.push({
          lyric_line_id: l.lyric_line_id,
          lyric_text: l.lyric_text,
          phrase: p.text,
          song_start_time: Number.isFinite(s0) ? s0 : null,
          song_end_time: Number.isFinite(e0) ? e0 : null,
          timing_confidence: "estimated",
        });
      }
    }
  }
  return out;
}

// Derive the initial Story Plan from a fresh bible: analysis becomes the
// narrative outline, characters gain roster slots with motivations taken
// from the analysis relationships text, and the ten production tasks start
// pending. Pure — the caller persists.
export function buildStoryPlan({ input, blueprint }) {
  const bp = blueprint && typeof blueprint === "object" ? blueprint : {};
  const a = bp.analysis && typeof bp.analysis === "object" ? bp.analysis : {};
  const chars = arr(bp.characters);
  const outline = [str(a.beginning), str(a.middle), str(a.climax), str(a.ending)]
    .map((x) => x.slice(0, 300)).filter(Boolean).slice(0, 40);
  const roster = chars.map((c) => {
    const o = c && typeof c === "object" ? c : {};
    const id = idStr(o.character_id ?? o.name);
    if (!id) return null;
    return { character_id: id, name: str(o.name, id), role: str(o.role).slice(0, 80), motivation: "" };
  }).filter(Boolean);
  const uncertainties = [];
  if (!roster.length) uncertainties.push("No characters registered — the cast is unknown.");
  if (!str(a.climax) && !str(a.ending)) uncertainties.push("Climax/resolution not stated — the ending is undecided.");
  return normalizeStoryPlan({
    logline: str(bp.logline),
    theme: str(a.emotional_progression),
    structure: {
      beginning: str(a.beginning),
      development: str(a.middle),
      climax: str(a.climax),
      resolution: str(a.ending),
    },
    narrativeOutline: outline,
    characterRoster: roster,
    uncertainties,
    productionTasks: PLAN_TASK_DEFS.map((d) => ({ ...d, status: "pending" })),
    approvals: {},
    revisions: 0,
  });
}

// ---------------------------------------------------------------------------
// Phase 3 — Cinematography & shot planning (pure). Every shot carries
// dramatic purpose, source lyric linkage, framing, movement, blocking,
// lighting, start/end composition and the transition into the next shot.
// Helpers derive read-only plans from the board; the storyboard renders them
// and the generate path consumes approved shots unchanged. Never throws.
// ---------------------------------------------------------------------------

// Flattened shot list: one entry per generation beat (shots tile scenes;
// shot-less scenes map 1:1). Each entry traces scene_number/shot_id,
// lyric linkage, dramatic purpose, camera, blocking and timing.
export function buildShotList(board = {}) {
  const b = board && typeof board === "object" ? board : {};
  const out = [];
  for (const s of arr(b.scenes)) {
    const o = s && typeof s === "object" ? s : {};
    const shots = arr(o.shots);
    if (!shots.length) {
      out.push({
        scene_number: Number(o.scene_number) || out.length + 1,
        shot_id: str(o.shot_id) || `scene-${Number(o.scene_number) || out.length + 1}`,
        lyric_line_id: Number(o.lyric_line_id ?? o.parent_line_id) || null,
        lyric_segment: str(o.lyric_segment),
        dramatic_purpose: str(o.dramatic_purpose),
        shot_type: str(o.camera && o.camera.shot_type),
        movement: str(o.camera && o.camera.movement),
        duration_seconds: Number(o.duration_seconds) || 0,
      });
    } else {
      for (const sh of shots) {
        const x = sh && typeof sh === "object" ? sh : {};
        out.push({
          scene_number: Number(o.scene_number) || 0,
          shot_id: str(x.shot_id),
          lyric_line_id: Number(x.parent_line_id ?? x.lyric_line_id) || null,
          lyric_segment: str(x.lyric_segment),
          dramatic_purpose: str(x.dramatic_purpose),
          shot_type: str(x.camera && x.camera.shot_type),
          movement: str(x.camera && x.camera.movement),
          duration_seconds: Number(x.duration_seconds) || 0,
        });
      }
    }
  }
  return out;
}

// Camera motion plan: per-shot movement + inferred speed (slow for
// gentle/push-in/pull-back, static for locked, medium otherwise) + start/end
// composition notes from continuity fields.
export function buildCameraMotionPlan(board = {}) {
  return buildShotList(board).map((s) => {
    const mv = String(s.movement || "").toLowerCase();
    const speed = /static|locked/.test(mv) ? "static" : /slow|gentle|push-in|pull-back/.test(mv) ? "slow" : /fast|rapid|whip/.test(mv) ? "fast" : "medium";
    return { shot_id: s.shot_id, movement: s.movement || "Static", speed, shot_type: s.shot_type || "Medium Shot" };
  });
}

// Lighting plan: per-scene time_of_day + lighting + visual emphasis (emotion
// or dramatic purpose, truncated). Stable order by scene_number.
export function buildLightingPlan(board = {}) {
  const b = board && typeof board === "object" ? board : {};
  return arr(b.scenes).map((s, i) => {
    const o = s && typeof s === "object" ? s : {};
    return {
      scene_number: Number(o.scene_number) || i + 1,
      time_of_day: str(o.time_of_day),
      lighting: str(o.lighting),
      emphasis: str(o.dramatic_purpose || o.emotion).slice(0, 160),
    };
  });
}

// Character blocking plan: per-shot cast with gaze, starting/ending states
// and action. Uses characters_detailed when present, else plain ids.
export function buildBlockingPlan(board = {}) {
  const b = board && typeof board === "object" ? board : {};
  const out = [];
  for (const s of arr(b.scenes)) {
    const o = s && typeof s === "object" ? s : {};
    const rows = arr(o.shots).length ? arr(o.shots) : [o];
    for (const r of rows) {
      const x = r && typeof r === "object" ? r : {};
      out.push({
        shot_id: str(x.shot_id) || `scene-${o.scene_number}`,
        cast: characterDirectionsOf(x).map((c) => ({
          character_id: c.character_id,
          gaze_target: c.gaze_target,
          starting_state: c.starting_state,
          action: c.action,
          ending_state: c.ending_state,
        })),
      });
    }
  }
  return out;
}

// Transition plan: how each scene hands off to the next (explicit fields
// win; otherwise a location/cast change implies a cut).
export function buildTransitionPlan(board = {}) {
  const b = board && typeof board === "object" ? board : {};
  const scenes = arr(b.scenes);
  return scenes.map((s, i) => {
    const o = s && typeof s === "object" ? s : {};
    const nxt = scenes[i + 1] && typeof scenes[i + 1] === "object" ? scenes[i + 1] : null;
    const explicit = str(o.transition_to_next_scene) || (nxt ? str(nxt.continuity_from_previous_scene) : "");
    let kind = "cut";
    if (explicit) kind = explicit.slice(0, 120);
    else if (nxt && str(nxt.location) && str(o.location) && str(nxt.location) !== str(o.location)) kind = "cut (location change)";
    return { scene_number: Number(o.scene_number) || i + 1, transition: kind || "cut" };
  });
}

// Cinematography validation: arbitrary/contradictory moves, missing dramatic
// purpose, monotonous coverage (all shots the same type). Returns issues.
export function validateCinematography(board = {}) {
  const issues = [];
  const list = buildShotList(board);
  for (const s of list) {
    if (!s.dramatic_purpose) issues.push(`shot ${s.shot_id}: no dramatic purpose — say why this shot exists`);
    if (/static/i.test(s.movement) && /tracking|dolly|orbit|crane/i.test(s.shot_type)) {
      issues.push(`shot ${s.shot_id}: static move with a motion shot type`);
    }
  }
  const types = new Set(list.map((s) => s.shot_type.toLowerCase()).filter(Boolean));
  if (list.length >= 4 && types.size <= 1) issues.push("all shots share one framing — vary wide/medium/close-up/reaction/insert by story need");
  return [...new Set(issues)];
}

// ---------------------------------------------------------------------------
// Phase 4 — Acting, motion & audio sync (pure). Character behavior is staged
// as motivated Notice→React→Approach→Interact→Respond→Resolve only when the
// story needs it — never mechanically. Measured audio timing (board.audioTiming
// / input.song.timing) always wins over estimates; the two are never mixed.
// ---------------------------------------------------------------------------

// Per-character action plan: stable id + approved reference name, start/end
// states, orientation/gaze, emotion/expression, primary action + gestures.
export function buildCharacterActionPlan(board = {}) {
  const b = board && typeof board === "object" ? board : {};
  const bp = b.blueprint && typeof b.blueprint === "object" ? b.blueprint : {};
  const refName = new Map();
  for (const c of arr(bp.characters)) {
    const ref = str(c && c.visual_identity_prompt).slice(0, 80);
    // characterDirectionsOf ids are slugId-normalized; bible ids may carry
    // original case — index both so mixed-case registries still resolve.
    for (const k of [slugId(c && (c.character_id ?? c.name)), idStr(c && (c.character_id ?? c.name))]) {
      if (k && !refName.has(k)) refName.set(k, ref);
    }
  };
  const out = [];
  for (const s of arr(b.scenes)) {
    const o = s && typeof s === "object" ? s : {};
    const rows = arr(o.shots).length ? arr(o.shots) : [o];
    for (const r of rows) {
      for (const c of characterDirectionsOf(r)) {
        out.push({
          shot_id: str((r && r.shot_id)) || `scene-${o.scene_number}`,
          character_id: c.character_id,
          reference: refName.get(c.character_id) || "",
          starting_state: c.starting_state,
          gaze_target: c.gaze_target,
          emotion: c.emotion,
          expression: c.expression,
          action: c.action,
          ending_state: c.ending_state,
          role: c.role,
        });
      }
    }
  }
  return out;
}

// Multi-character interaction: initiator (role=active or first mover),
// responders, target (gaze/object) and cause→effect text per shot.
export function buildInteractionPlan(board = {}) {
  const b = board && typeof board === "object" ? board : {};
  const out = [];
  for (const s of arr(b.scenes)) {
    const o = s && typeof s === "object" ? s : {};
    const rows = arr(o.shots).length ? arr(o.shots) : [o];
    for (const r of rows) {
      const x = r && typeof r === "object" ? r : {};
      const cast = characterDirectionsOf(x);
      if (cast.length < 2 && !arr(x.continuity_refs).length) continue;
      const initiator = cast.find((c) => c.role === "active") || cast[0];
      if (!initiator) continue;
      out.push({
        shot_id: str(x.shot_id) || `scene-${o.scene_number}`,
        initiator: initiator.character_id,
        responders: cast.filter((c) => c.character_id !== initiator.character_id).map((c) => c.character_id),
        target: initiator.gaze_target || arr(x.continuity_refs)[0] || "",
        cause_effect: str(x.action || x.visual_event).slice(0, 200),
      });
    }
  }
  return out;
}

// Motion timeline: ordered movement phases per shot with start/end offsets
// from the shot's own timings (fallback: even split of the scene duration).
export function buildMotionTimeline(board = {}) {
  const b = board && typeof board === "object" ? board : {};
  const out = [];
  for (const s of arr(b.scenes)) {
    const o = s && typeof s === "object" ? s : {};
    const shots = arr(o.shots);
    const rows = shots.length ? shots : [{ ...o, shot_id: o.shot_id || `scene-${o.scene_number}` }];
    rows.forEach((r, i) => {
      const x = r && typeof r === "object" ? r : {};
      const rawDur = Number(x.duration_seconds);
      const sceneDur = Number(o.duration_seconds);
      const dur = Number.isFinite(rawDur) && rawDur > 0 ? rawDur
        : Number.isFinite(sceneDur) && sceneDur > 0 ? Math.round((sceneDur / rows.length) * 10) / 10 : 0;
      const rawT0 = Number(x.start_time);
      const t0 = Number.isFinite(rawT0) && rawT0 >= 0 ? rawT0 : Math.round(i * dur * 10) / 10;
      out.push({
        shot_id: str(x.shot_id),
        start_time: t0,
        end_time: Math.round((t0 + dur) * 10) / 10,
        phases: [str(x.action || x.visual_event).slice(0, 200)].filter(Boolean),
        camera_movement: str(x.camera && x.camera.movement),
      });
    });
  }
  return out;
}

// Audio timing map: measured entries (board.audioTiming[] or
// input.song.timing[]) win; everything else is word-proportional estimated.
// Never mixes the two — each line carries timing_confidence.
export function buildAudioTimingMap(board = {}) {
  const b = board && typeof board === "object" ? board : {};
  const lines = boardLyricLines(b);
  const target = Number(b.input && (b.input.targetSeconds ?? b.input.target_seconds)) || 0;
  const measuredRaw = arr(b.audioTiming).concat(arr(b.input && b.input.song && b.input.song.timing));
  const measured = new Map();
  for (const m of measuredRaw) {
    const o = m && typeof m === "object" ? m : {};
    const id = Number(o.lyric_line_id);
    if (Number.isFinite(id) && id > 0 && Number.isFinite(Number(o.start)) && Number.isFinite(Number(o.end))) {
      measured.set(id, { start: Number(o.start), end: Number(o.end) });
    }
  }
  const estimated = new Map(estimateLyricTiming(lines, target).map((l) => [Number(l.lyric_line_id), l]));
  return lines.map((l, i) => {
    const id = Number(l.lyric_line_id) || i + 1;
    if (measured.has(id)) {
      const m = measured.get(id);
      return { lyric_line_id: id, lyric_text: str(l.lyric_text), start_time: m.start, end_time: m.end, timing_confidence: "measured" };
    }
    const e = estimated.get(id) || {};
    const es = Number(e.song_start_time);
    const ee = Number(e.song_end_time);
    return { lyric_line_id: id, lyric_text: str(l.lyric_text), start_time: Number.isFinite(es) ? es : null, end_time: Number.isFinite(ee) ? ee : null, timing_confidence: "estimated" };
  });
}

// Action↔lyric sync: each shot's staged action against its lyric window.
export function buildActionSyncPlan(board = {}) {
  const b = board && typeof board === "object" ? board : {};
  const timing = new Map(buildAudioTimingMap(b).map((t) => [t.lyric_line_id, t]));
  const actionByShot = new Map();
  for (const s of arr(b.scenes)) {
    const o = s && typeof s === "object" ? s : {};
    const rows = arr(o.shots).length ? arr(o.shots) : [o];
    for (const r of rows) {
      const x = r && typeof r === "object" ? r : {};
      const id = str(x.shot_id) || `scene-${o.scene_number}`;
      if (!actionByShot.has(id)) actionByShot.set(id, str(x.action || x.visual_event).slice(0, 200));
    }
  }
  return buildShotList(b).map((s) => {
    const t = timing.get(Number(s.lyric_line_id)) || {};
    const ts = Number(t.start_time);
    const te = Number(t.end_time);
    return { shot_id: s.shot_id, lyric_line_id: s.lyric_line_id, lyric_segment: s.lyric_segment, action: actionByShot.get(s.shot_id) || "", start_time: Number.isFinite(ts) ? ts : null, end_time: Number.isFinite(te) ? te : null, timing_confidence: t.timing_confidence || "estimated" };
  });
}

// Lip-sync instructions: per dialogue line with word-count estimated seconds
// (exact wav durations win at generate time via beatTargetDuration — the
// estimate here only sizes the plan, never the clip).
export function buildLipSyncInstructions(board = {}) {
  const b = board && typeof board === "object" ? board : {};
  const out = [];
  const est = (line) => {
    const words = String(line || "").split(/\s+/).filter(Boolean).length;
    const dev = /[\u0900-\u097F]/.test(String(line || ""));
    return Math.round(((words / (dev ? 2.2 : 2.5)) + 0.35) * 10) / 10;
  };
  for (const s of arr(b.scenes)) {
    const o = s && typeof s === "object" ? s : {};
    const rows = arr(o.shots).length ? arr(o.shots) : [o];
    for (const r of rows) {
      for (const d of arr((r && r.dialogue)) ) {
        const x = d && typeof d === "object" ? d : {};
        if (!str(x.line).trim()) continue;
        out.push({ shot_id: str((r && r.shot_id)) || `scene-${o.scene_number}`, speaker: str(x.speaker), line: str(x.line), estimated_seconds: est(x.line), timing_confidence: "estimated" });
      }
    }
  }
  return out;
}

// Motion-prompt validation: starting/ending state present, ordered phases,
// contradictory moves (static camera + tracking action already covered in
// validateShotDirection — here: opposite body moves in one shot).
export function validateMotionPrompts(board = {}) {
  const issues = [];
  const b = board && typeof board === "object" ? board : {};
  for (const s of arr(b.scenes)) {
    const o = s && typeof s === "object" ? s : {};
    const rows = arr(o.shots).length ? arr(o.shots) : [o];
    for (const r of rows) {
      const x = r && typeof r === "object" ? r : {};
      const id = str(x.shot_id) || `scene-${o.scene_number}`;
      const vid = str(x.video_prompt);
      if (vid && /stand up.*sit down|sit down.*stand up|enter.*exit|exit.*enter|stand.*lie.*stand/i.test(vid) && vid.length < 400) {
        issues.push(`shot ${id}: contradictory motion in one shot — split into ordered phases`);
      }
    }
  }
  return [...new Set(issues)];
}

// ---------------------------------------------------------------------------
// Phase 5 — Image/video prompt generation (pure preview). Assembles
// per-approved-shot prompts from the SAME bible identities + locks the
// generate path enforces (style/quality/anatomy/motion fidelity), so the
// preview matches what Flux (t2i) / LTX-Wan (i2v) actually receive.
// Model-specific settings stay inside lib/comfy.mjs adapters — prompts here
// carry no node IDs, input names or workflow parameters. Never throws.
// ---------------------------------------------------------------------------

function promptBibleMaps(blueprint) {
  const bp = blueprint && typeof blueprint === "object" ? blueprint : {};
  // Bible ids may carry original case while scene refs arrive slug-normalized
  // (and vice versa) — index both spellings so identity grounding never misses
  // on case alone. First writer wins (canonical registry order).
  const indexBoth = (list, key) => {
    const m = new Map();
    for (const e of arr(list)) {
      const raw = e && typeof e === "object" ? (e[key] ?? e.name) : null;
      for (const k of [idStr(raw), slugId(raw)]) {
        if (k && !m.has(k)) m.set(k, e);
      }
    }
    return m;
  };
  return {
    chars: indexBoth(bp.characters, "character_id"),
    locs: indexBoth(bp.locations, "location_id"),
    objs: indexBoth(bp.objects, "object_id"),
  };
}

// Canonical image prompt for one shot: identity + pose/expression/gaze +
// props/environment + framing + lighting/style + continuity. Idempotent wrt
// existing locks (never doubles them).
export function buildImagePromptFor(shot = {}, board = {}) {
  const b = board && typeof board === "object" ? board : {};
  const { chars, locs, objs } = promptBibleMaps(b.blueprint);
  const x = shot && typeof shot === "object" ? shot : {};
  const bits = [];
  const base = str(x.image_prompt).trim();
  if (base) bits.push(base);
  for (const cid of castIdsOf(x.characters)) {
    const c = chars.get(cid) || chars.get(slugId(cid));
    const ident = c ? (str(c.visual_identity_prompt) || str(c.name)) : cid;
    if (ident && !bits.join(" ").toLowerCase().includes(ident.slice(0, 24).toLowerCase())) bits.push(ident);
  }
  const dir = characterDirectionsOf(x);
  const pose = dir.map((c) => [c.starting_state, c.action, c.expression, c.gaze_target ? `gazing at ${c.gaze_target}` : ""].filter(Boolean).join(", ")).filter(Boolean);
  if (pose.length) bits.push(pose.join(" | "));
  if (x.location) {
    const l = locs.get(slugId(x.location)) || locs.get(idStr(x.location));
    bits.push(str((l && l.visual_identity_prompt)) || str(x.location));
  }
  for (const ref of arr(x.continuity_refs)) {
    const o = objs.get(slugId(ref)) || objs.get(idStr(ref));
    if (o && str(o.visual_identity_prompt)) bits.push(str(o.visual_identity_prompt));
  }
  if (x.environment) bits.push(str(x.environment));
  const cam = x.camera && typeof x.camera === "object" ? x.camera : {};
  const framing = [cam.shot_type, cam.angle].filter(Boolean).join(", ");
  if (framing) bits.push(framing);
  if (x.lighting) bits.push(str(x.lighting));
  const lock = styleLockFor(b.input && (b.input.visualStyle || b.input.style), b.input && b.input.styleCustom, b.input && b.input.masterPrompt);
  if (lock && !bits.join(" ").toLowerCase().includes(lock.slice(0, 24).toLowerCase())) bits.push(lock);
  return withQualityLock(withAnatomyLock(bits.filter(Boolean).join(", "), [...new Set(chars.values())]));
  }

// Motion-only video prompt for one shot: starting state → ordered phases →
// ending state + body/facial motion + camera + continuity + fidelity lock.
// Never restates looks/clothing/style (the keyframe owns those).
export function buildVideoPromptFor(shot = {}, board = {}) {
  const x = shot && typeof shot === "object" ? shot : {};
  const bits = [];
  const base = str(x.video_prompt).trim();
  if (base) bits.push(base);
  const explicitMotion = str(x.motion).trim();
  if (explicitMotion && !bits.join(" ").toLowerCase().includes(explicitMotion.slice(0, 24).toLowerCase())) bits.push(`Motion: ${explicitMotion}`);
  for (const c of characterDirectionsOf(x)) {
    if (c.action && !bits.join(" ").toLowerCase().includes(c.action.slice(0, 20).toLowerCase())) bits.push(c.action);
    if (c.gaze_target && !bits.join(" ").toLowerCase().includes(`look at ${c.gaze_target}`.slice(0, 24).toLowerCase())) bits.push(`turns to look at ${c.gaze_target}`);
  }
  const cam = x.camera && typeof x.camera === "object" ? x.camera : {};
  if (cam.movement && !/^(static|locked)$/i.test(str(cam.movement)) && !bits.join(" ").toLowerCase().includes(str(cam.movement).slice(0, 12).toLowerCase())) {
    bits.push(`${str(cam.movement)} camera move`);
  }
  const t = bits.filter(Boolean).join(", ");
  if (!t) return MOTION_FIDELITY_LOCK;
  return t.toLowerCase().includes(motionKeyFor().toLowerCase()) ? t : `${t}, ${MOTION_FIDELITY_LOCK}`;
}

// Checklist validation for generated prompts (spec §13). Returns issues.
export function validateImagePrompt(p) {
  const t = String(p || "");
  const issues = [];
  if (t.length < 40) issues.push("too short to stage identity + framing + lighting");
  if (!/8k uhd|ultra-detailed/i.test(t)) issues.push("missing quality lock");
  return issues;
}
export function validateVideoPrompt(p) {
  const t = String(p || "");
  const issues = [];
  if (!/mov|pan|tilt|dolly|track|orbit|crane|zoom|camera|static|push|pull|walk|run|hop|dance|nod|blink|smile|gestur|sway/i.test(t)) issues.push("describes no motion");
  if (!/animate natural motion only/i.test(t)) issues.push("missing motion-fidelity lock");
  return issues;
}

// Per-shot prompt preview for the whole board (dry run — no ComfyUI call).
export function buildShotPrompts(board = {}) {
  const b = board && typeof board === "object" ? board : {};
  const out = [];
  for (const s of arr(b.scenes)) {
    const o = s && typeof s === "object" ? s : {};
    const rows = arr(o.shots).length ? arr(o.shots) : [{ ...o, shot_id: o.shot_id || `scene-${o.scene_number}` }];
    for (const r of rows) {
      const image_prompt = buildImagePromptFor(r, b);
      const video_prompt = buildVideoPromptFor(r, b);
      out.push({
        shot_id: str((r && r.shot_id)) || `scene-${o.scene_number}`,
        image_prompt,
        video_prompt,
        image_issues: validateImagePrompt(image_prompt),
        video_issues: validateVideoPrompt(video_prompt),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phase 7 — Editing, assembly & QC (pure). Approved shots become an edit
// decision list, a song-absolute assembly timeline, a resumable render job
// spec (existing sequence pipeline consumes it unchanged) and a gated QC
// report. Failed stages never destroy approved outputs: the render job skips
// assets already on disk and selective beats filter to exactly the shots
// needing regeneration. Never throws.
// ---------------------------------------------------------------------------

// Approved edit plan: ordered beats with durations, transitions and audio
// cues (dialogue/song). Only structurally valid scenes enter the cut.
export function buildEditPlan(board = {}) {
  const b = board && typeof board === "object" ? board : {};
  const transitions = new Map(buildTransitionPlan(b).map((t) => [t.scene_number, t.transition]));
  const out = [];
  for (const s of arr(b.scenes)) {
    const o = s && typeof s === "object" ? s : {};
    const sn = Number(o.scene_number) || out.length + 1;
    const rows = arr(o.shots).length ? arr(o.shots) : [{ ...o }];
    rows.forEach((r, i) => {
      const x = r && typeof r === "object" ? r : {};
      out.push({
        order: out.length + 1,
        scene_number: sn,
        shot_id: str(x.shot_id) || `${sn}-${String.fromCharCode(65 + i)}`,
        duration_seconds: Number(x.duration_seconds) || 0,
        transition_in: i === 0 ? (transitions.get(sn) || "cut") : "cut",
        has_dialogue: arr(x.dialogue).length > 0,
      });
    });
  }
  return out;
}

// Assembly timeline: cumulative song-absolute start/end per beat (1-decimal,
// tiling exactly like splitSceneTimeline). Powers the final mux + reel-cut.
export function buildAssemblyTimeline(board = {}) {
  let cursor = 0;
  return buildEditPlan(board).map((e) => {
    const dur = Math.max(0, Number(e.duration_seconds) || 0);
    const start = Math.round(cursor * 10) / 10;
    cursor = Math.round((cursor + dur) * 10) / 10;
    return { ...e, start_time: start, end_time: cursor };
  });
}

// Render job spec for the existing sequence pipeline: beat ids in cut order,
// target cut (YOUTUBE/INSTAGRAM), resumable skip-existing + selective beats
// filter. The runner keeps its missing-only resume; this spec only selects.
export function buildRenderJob(board = {}, { format = "YOUTUBE", beats = null } = {}) {
  const timeline = buildAssemblyTimeline(board);
  const want = Array.isArray(beats) && beats.length ? new Set(beats.map((x) => String(x))) : null;
  const items = timeline.filter((t) => !want || want.has(String(t.shot_id)) || want.has(String(t.scene_number)));
  const total = Math.round(timeline.reduce((a, t) => a + (Number(t.duration_seconds) || 0), 0) * 10) / 10;
  return {
    format: format === "INSTAGRAM" ? "INSTAGRAM" : "YOUTUBE",
    beats: items.map((t) => t.shot_id),
    total_seconds: total,
    resumable: true,
    selective: want ? [...want] : [],
  };
}

// Gated QC report aggregating every validator: score, coverage, continuity,
// cinematography, motion, prompts + pass/fail against floors + the exact
// regen targets (scenes named in issues). approveGate errors always fail.
export function buildQCReport(board = {}, { minScore = 60 } = {}) {
  const b = board && typeof board === "object" ? board : {};
  const gate = approveGate(b);
  const cine = validateCinematography(b);
  const mot = validateMotionPrompts(b);
  const prompts = buildShotPrompts(b);
  const promptIssues = prompts.flatMap((p) => [...p.image_issues.map((m) => `${p.shot_id}: ${m}`), ...p.video_issues.map((m) => `${p.shot_id}: ${m}`)]);
  const issues = [...gate.warnings, ...cine, ...mot, ...promptIssues].slice(0, 60);
  const targets = [...new Set(issues.map((m) => {
    const hit = String(m).match(/scene (\d+)/i) || String(m).match(/shot (\d+)-/i);
    return hit ? Number(hit[1]) : null;
  }).filter((n) => Number.isFinite(n)))].slice(0, 20);
  const pass = gate.errors.length === 0 && (gate.score == null || gate.score >= minScore);
  return { score: gate.score, errors: gate.errors, issues, regenTargets: targets, pass };
}

// Per-stage pipeline status for a board: done when the artefact exists,
// ready when its dependency is met, blocked otherwise. approved overlays
// the Chief Director's explicit sign-off from storyPlan.approvals.
export function stageStatus(board) {
  const b = board && typeof board === "object" ? board : {};
  const scenes = arr(b.scenes);
  const bp = b.blueprint && typeof b.blueprint === "object" ? b.blueprint : {};
  const plan = normalizeStoryPlan(b.storyPlan);
  const hasBible = arr(bp.characters).length > 0 || arr(bp.locations).length > 0
    || arr(bp.objects).length > 0 || Boolean(str(bp.logline));
  const lyricLines = boardLyricLines(b);
  // Story boards carry no lyrics — lyric-semantics is vacuously satisfied
  // once the bible exists (otherwise story projects stall at blocked
  // scene-breakdown with no lyric stage to complete). Song boards still
  // require real lyric lines.
  const isSong = !!(b.input && b.input.song);
  const lyricDone = lyricLines.length > 0 || (hasBible && !isSong);
  const fullyPlanned = scenes.length > 0 && scenes.length >= (Number(b.sceneCount) || scenes.length);
  const directed = scenes.length > 0 && scenes.every((s) => {
    const o = s && typeof s === "object" ? s : {};
    if (!str(o.image_prompt).trim() || !str(o.video_prompt).trim()) return false;
    return !arr(o.shots).length || arr(o.shots).every((sh) => str(sh && (sh.image_prompt || sh.imagePrompt)).trim() || str(sh && (sh.video_prompt || sh.videoPrompt)).trim());
  });
  const approved = plan.approvals["coverage-validation"] || b.status === "approved" || b.status === "approved-partial";
  const facts = {
    "story-analysis": hasBible,
    "lyric-semantics": lyricDone,
    "scene-breakdown": fullyPlanned,
    "shot-direction": directed && fullyPlanned,
    "coverage-validation": !!approved,
    "image-generation": !!approved,
    "video-motion": !!approved,
    "final-assembly": b.status === "approved" && !plan.uncertainties.length,
  };
  return DIRECTOR_STAGES.map((stage, i) => {
    const depMet = i === 0 || facts[DIRECTOR_STAGES[i - 1]];
    const done = !!facts[stage];
    return {
      stage,
      status: plan.approvals[stage] ? "approved" : done ? "done" : depMet ? "ready" : "blocked",
      approvedAt: plan.approvals[stage] || null,
      detail:
        stage === "scene-breakdown" && scenes.length
          ? `${scenes.length}/${Number(b.sceneCount) || scenes.length} scenes`
          : stage === "lyric-semantics" && lyricLines.length
            ? `${lyricLines.length} lines`
            : "",
    };
  });
}

// Single approve gate: structural errors block, everything else (lyric
// warnings, quality issues below the floor) is advisory. Same blocking
// semantics as the previous inline QA — centralized so the storyboard,
// repair flow and approve route all agree.
export function approveGate(board, { minScore = 0 } = {}) {
  const qa = validateStoryBoard(board);
  const errors = [...arr(qa.errors)];
  const warnings = [...arr(qa.warnings)];
  try {
    const b = board && typeof board === "object" ? board : {};
    const lines = boardLyricLines(b);
    const target = b.input && b.input.song && b.input.song.durationSeconds
      ? Number(b.input.song.durationSeconds)
      : Number(b.input && b.input.targetSeconds) || null;
    for (const w of validateLyricPlan(arr(b.scenes), lines, target)) warnings.push(w);
    const scored = scoreDirectorPlan({ ...b, blueprint: { ...(b.blueprint || {}), lyric_lines: lines } });
    for (const i of scored.issues.slice(0, 20)) warnings.push(i);
    if (Number(minScore) > 0 && scored.score < Number(minScore)) {
      errors.push(`quality score ${scored.score}/100 is below the approval floor ${Number(minScore)} — repair flagged shots first`);
    }
    return { errors: [...new Set(errors)], warnings: [...new Set(warnings)].slice(0, 40), score: scored.score };
  } catch {
    return { errors, warnings, score: null };
  }
}
