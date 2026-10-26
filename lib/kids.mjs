// Sanskriti Kids Studio — pure helpers (no fs/network/db). Shared by
// server.mjs, the frontend build, and tests.
// Run: node --test tests/kids.test.mjs
//
// Design mirrors lib/director.mjs + lib/devotional.mjs: pure normalize /
// validate / prompt builders and a shared SCHEMA. The Sanskriti Kids module
// is a PROJECT LAYER on top of the existing Director pipeline (bible ->
// scenes -> approve -> the shared image/video/audio/final-cut generation),
// never a parallel renderer — see AGENTS.md.

import {
  isKidsGenre,
  genreDirectingNotes,
  learningFocus,
  buildShotList,
  buildCameraMotionPlan,
  buildTransitionPlan,
  buildLightingPlan,
  DEFAULT_CHARACTER_CONSISTENCY_RULES,
} from "./director.mjs";

// ---------------------------------------------------------------------------
// Options — configurable, never hardcoded in the UI. The defaults below seed
// the kids_options table; the API serves the TABLE (so the user can add or
// rename an age group / category / platform without touching the code) and
// the UI renders whatever the server returns.
// ---------------------------------------------------------------------------
export const KIDS_OPTION_KEYS = [
  "age_groups",
  "categories",
  "languages",
  "platforms",
  "resolutions",
  "visual_styles",
];

export const KIDS_DEFAULT_OPTIONS = {
  age_groups: ["2-4 years", "4-6 years", "6-8 years", "8-12 years"],
  categories: [
    "Nursery Rhymes",
    "Animal Songs",
    "Alphabet and Phonics",
    "Numbers and Counting",
    "Mathematics and Tables",
    "Colors and Shapes",
    "Fruits and Vegetables",
    "Birds and Insects",
    "Moral Stories",
    "Educational Stories",
    "Hindi Learning",
    "English Learning",
    "General Kids Entertainment",
  ],
  languages: ["Hindi", "English", "Bilingual"],
  platforms: [
    "YouTube",
    "YouTube Kids",
    "Instagram",
    "Instagram Reels",
    "Facebook",
    "WhatsApp",
  ],
  resolutions: [
    "1280x720",
    "1920x1080",
    "720x1280",
    "1080x1920",
    "1080x1080",
  ],
  visual_styles: [
    "3D Preschool Animation",
    "3D Cinematic",
    "2D Cartoon",
    "Anime",
    "Realistic",
    "Watercolor Storybook",
  ],
};

// The Director engine only accepts its own vocabulary; the Kids studio may
// offer a wider set, so every value is mapped onto a legal Director value
// before it reaches the shared pipeline (unknown -> the preschool default).
const DIRECTOR_STYLES = [
  "3D Preschool Animation", "3D Cinematic", "Realistic", "Anime",
  "Cartoon", "Indian Mythological", "Fantasy", "Custom",
];
const DIRECTOR_LANGS = ["Hindi", "English", "Hinglish"];
const DIRECTOR_GENRES = [
  "Kids", "Devotional", "Adventure", "Fantasy", "Horror", "Comedy", "Educational", "Custom",
];
const DIRECTOR_ASPECTS = ["16:9", "9:16", "1:1"];

const STYLE_TO_DIRECTOR = {
  "3D Preschool Animation": "3D Preschool Animation",
  "3D Cinematic": "3D Cinematic",
  "2D Cartoon": "Cartoon",
  Cartoon: "Cartoon",
  Anime: "Anime",
  Realistic: "Realistic",
  "Watercolor Storybook": "Cartoon",
  "Indian Mythological": "Indian Mythological",
  Fantasy: "Fantasy",
};

/** Map a studio visual style onto a Director-legal style. */
export function directorStyleFor(style) {
  const s = String(style || "").trim();
  if (DIRECTOR_STYLES.includes(s)) return s;
  return STYLE_TO_DIRECTOR[s] || "3D Preschool Animation";
}

/** Map a studio language onto a Director-legal language. */
export function directorLanguageFor(language) {
  const s = String(language || "").trim();
  if (DIRECTOR_LANGS.includes(s)) return s;
  if (/bilingual/i.test(s)) return "Hinglish";
  return "English";
}

/** Map a studio aspect ratio onto a Director-legal one. */
export function directorAspectFor(aspect) {
  const s = String(aspect || "").trim();
  return DIRECTOR_ASPECTS.includes(s) ? s : "16:9";
}

/** Every kids studio category is a kids genre — the Director's kids rules
 *  (calm pacing, one readable action per shot, alphabet/counting/rhyme
 *  sub-rules) must apply to all of them. */
export function directorGenreFor(category) {
  const c = String(category || "").trim();
  return DIRECTOR_GENRES.includes(c) ? c : "Kids";
}

// ---------------------------------------------------------------------------
// Project (Stage 1) — normalization + validation
// ---------------------------------------------------------------------------

export const KIDS_PROJECT_STATUSES = [
  "draft", "planning", "approved", "in_progress", "completed", "archived",
];

export const KIDS_PLAN_STATUSES = ["draft", "approved"];

/** Max length of the user's own text fields (lyrics / script / notes). */
export const KIDS_TEXT_MAX = 20000;

const str = (v, fb = "") => {
  if (v == null) return fb;
  const s = typeof v === "string" ? v : String(v);
  return s;
};
const arr = (v) => (Array.isArray(v) ? v : []);
const clampInt = (v, lo, hi, fb) => {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fb;
  return Math.min(hi, Math.max(lo, n));
};
const clampNum = (v, lo, hi, fb) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fb;
  return Math.min(hi, Math.max(lo, n));
};

/** Filesystem-safe slug used as the project id / storage folder name. */
export function kidsSlug(s, fallback = "kids_project") {
  const clean = String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return clean || fallback;
}

/** True when the text carries a real script (not just whitespace). */
export function hasScript(text) {
  return String(text ?? "").trim().length >= 20;
}

/**
 * Normalize a Stage-1 project payload. Unknown option values are KEPT (the
 * options table is user-editable, so the server may know values this build
 * has never seen) — the Director mapping happens later, at analyze time.
 */
export function normalizeKidsProject(body = {}, { options = KIDS_DEFAULT_OPTIONS } = {}) {
  const b = body && typeof body === "object" ? body : {};
  const title = str(b.title).trim().slice(0, 200);
  const known = (key, value) => {
    const list = arr(options && options[key]).map((x) => String(x));
    return list.includes(value) ? value : value;
  };
  return {
    title,
    description: str(b.description).trim().slice(0, 2000),
    language: known("languages", str(b.language).trim() || "Hindi"),
    category: known("categories", str(b.category).trim()),
    age_group: known("age_groups", str(b.age_group).trim()),
    duration_seconds: clampInt(b.duration_seconds, 5, 3600, 60),
    aspect_ratio: str(b.aspect_ratio).trim() || "16:9",
    resolution: known("resolutions", str(b.resolution).trim() || "1280x720"),
    visual_style: known("visual_styles", str(b.visual_style).trim() || "3D Preschool Animation"),
    narration_preferences: str(b.narration_preferences).trim().slice(0, 2000),
    music_preferences: str(b.music_preferences).trim().slice(0, 2000),
    target_platform: known("platforms", str(b.target_platform).trim()),
    lyrics: str(b.lyrics).slice(0, KIDS_TEXT_MAX),
    script: str(b.script).slice(0, KIDS_TEXT_MAX),
    // Uploaded narration / song audio (the Director song-upload handle) and
    // reference images (library resource ids). Both are OPTIONAL.
    audio_path: str(b.audio_path).trim().slice(0, 300),
    reference_images: arr(b.reference_images)
      .map((x) => (typeof x === "string" ? x : String(x?.id ?? x?.url ?? "")))
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 12),
    status: KIDS_PROJECT_STATUSES.includes(str(b.status)) ? str(b.status) : "draft",
  };
}

/**
 * Validate a normalized project. Returns { errors, warnings } — errors block
 * creation, warnings are advisory (the Director stage still works).
 */
export function validateKidsProject(project = {}) {
  const p = project && typeof project === "object" ? project : {};
  const errors = [];
  const warnings = [];
  if (!String(p.title || "").trim()) errors.push("project title is required");
  if (!hasScript(p.script) && !hasScript(p.lyrics)) {
    errors.push("paste the story script or the song lyrics (20+ characters)");
  }
  if (p.duration_seconds < 10) warnings.push("under 10 seconds is very short for a kids video");
  if (p.duration_seconds > 600) warnings.push("over 10 minutes — consider splitting it into episodes");
  if (!p.age_group) warnings.push("no target age group set — the Director will pick a general preschool register");
  if (!p.category) warnings.push("no content category set — learning-specific rules will not apply");
  const text = `${p.script || ""}\n${p.lyrics || ""}`;
  if (text && /[ऀ-ॿ]/.test(text) && !/hindi|bilingual/i.test(String(p.language))) {
    warnings.push("the script contains Devanagari but the language is not Hindi/Bilingual");
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Director Plan (Stage 2) — structured, editable, versioned
// ---------------------------------------------------------------------------

const strList = (v, max = 40, len = 400) =>
  arr(v).map((x) => str(x).trim().slice(0, len)).filter(Boolean).slice(0, max);

/**
 * Normalize the AI Director Plan. The plan is a DOCUMENT the user edits and
 * approves — every field is optional so a partial plan from a partial model
 * answer is still usable.
 */
export function normalizeKidsDirectorPlan(raw = {}) {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  const narrative = obj(o.narrative);
  const objective = obj(o.objective);
  const consistency = obj(o.consistency);
  const audio = obj(o.audio);
  const characters = arr(o.characters).map((c) => {
    const x = c && typeof c === "object" ? c : {};
    const id = str(x.character_id || x.id).trim().slice(0, 120);
    return {
      character_id: id || str(x.name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 120),
      name: str(x.name).trim().slice(0, 120),
      role: str(x.role).trim().slice(0, 80),
      appearance: str(x.appearance).trim().slice(0, 1500),
      usage: str(x.usage).trim().slice(0, 1000),
      visual_identity_prompt: str(x.visual_identity_prompt).trim().slice(0, 2000),
    };
  }).filter((c) => c.character_id || c.name);
  const scenes = arr(o.scenes).map((s) => {
    const x = s && typeof s === "object" ? s : {};
    return {
      scene_number: clampInt(x.scene_number, 1, 999, 0),
      title: str(x.title).trim().slice(0, 200),
      synopsis: str(x.synopsis).trim().slice(0, 1500),
      duration_seconds: clampNum(x.duration_seconds, 0, 120, 0),
      shot_type: str(x.shot_type).trim().slice(0, 80),
      camera_movement: str(x.camera_movement).trim().slice(0, 80),
      transition: str(x.transition).trim().slice(0, 120),
      characters: strList(x.characters, 16, 120),
      prompt: str(x.prompt).trim().slice(0, 4000),
    };
  });
  return {
    version: clampInt(o.version, 1, 999, 1),
    creative_direction: str(o.creative_direction).trim().slice(0, 3000),
    objective: {
      kind: str(objective.kind).trim().slice(0, 40),
      teaching_objective: str(objective.teaching_objective).trim().slice(0, 2000),
      entertainment_objective: str(objective.entertainment_objective).trim().slice(0, 2000),
    },
    narrative: {
      beginning: str(narrative.beginning).trim().slice(0, 2000),
      middle: str(narrative.middle).trim().slice(0, 2000),
      climax: str(narrative.climax).trim().slice(0, 2000),
      ending: str(narrative.ending).trim().slice(0, 2000),
    },
    visual_continuity: str(o.visual_continuity).trim().slice(0, 3000),
    scene_count: clampInt(o.scene_count, 0, 999, scenes.length),
    approximate_duration_seconds: clampNum(o.approximate_duration_seconds, 0, 3600, 0),
    characters,
    scenes,
    camera: {
      shot_types: strList(obj(o.camera).shot_types, 20, 80),
      movements: strList(obj(o.camera).movements, 20, 80),
      transitions: strList(obj(o.camera).transitions, 20, 120),
      framing_notes: str(obj(o.camera).framing_notes).trim().slice(0, 2000),
    },
    audio: {
      background_music: str(audio.background_music).trim().slice(0, 2000),
      ambience: str(audio.ambience).trim().slice(0, 2000),
      sound_effects: strList(audio.sound_effects, 30, 200),
      narration_notes: str(audio.narration_notes).trim().slice(0, 2000),
    },
    age_appropriateness: {
      language_notes: str(obj(o.age_appropriateness).language_notes).trim().slice(0, 2000),
      visual_notes: str(obj(o.age_appropriateness).visual_notes).trim().slice(0, 2000),
      pacing_notes: str(obj(o.age_appropriateness).pacing_notes).trim().slice(0, 2000),
    },
    consistency: {
      script_to_scene: str(consistency.script_to_scene).trim().slice(0, 2000),
      character_continuity: str(consistency.character_continuity).trim().slice(0, 2000),
      scene_to_render: str(consistency.scene_to_render).trim().slice(0, 2000),
    },
    warnings: strList(o.warnings, 20, 400),
  };
}

/** True when the plan carries enough substance to be worth showing. */
export function isPlanSubstantive(plan) {
  const p = normalizeKidsDirectorPlan(plan);
  return Boolean(
    p.creative_direction || p.narrative.beginning || p.objective.teaching_objective ||
    p.objective.entertainment_objective || p.characters.length || p.scenes.length,
  );
}

/**
 * The Director Plan is editable, but an APPROVED plan must never be
 * silently overwritten — an edit to an approved plan needs an explicit
 * unlock (the same discipline the Devotional library uses for approved rows).
 */
export function planEditGuard(planStatus, { unlock = false } = {}) {
  const status = str(planStatus).trim();
  if (status === "approved" && !unlock) {
    return { allowed: false, error: "this Director Plan is approved — unlock it before editing" };
  }
  return { allowed: true, error: null };
}

// ---------------------------------------------------------------------------
// Director Plan derivation from a REAL Director board
// ---------------------------------------------------------------------------
// The Kids studio never invents a second scene engine: the plan is DERIVED
// from the shared Director board (bible + planned scenes), so the plan and
// the storyboard can never drift apart.

const planCameraFromBoard = (board) => {
  const shots = buildShotList(board);
  const types = [];
  const moves = [];
  for (const s of shots) {
    if (s.shot_type && !types.includes(s.shot_type)) types.push(s.shot_type);
    if (s.movement && !moves.includes(s.movement)) moves.push(s.movement);
  }
  const transitions = buildTransitionPlan(board).map((t) => t.transition)
    .filter((t, i, a) => a.indexOf(t) === i);
  return { shot_types: types, movements: moves, transitions, framing_notes: "" };
};

const planCharactersFromBoard = (board) => {
  const bp = (board && board.blueprint) || {};
  const scenes = arr(board && board.scenes);
  return arr(bp.characters).map((c) => {
    const id = str(c && c.character_id).trim();
    const used = scenes.filter((s) => {
      const cast = arr(s && s.characters).map((x) => str(x));
      return cast.includes(id);
    });
    const appearance = Object.entries((c && c.appearance) || {})
      .map(([k, v]) => `${k}: ${v}`).join(", ");
    const clothing = Object.entries((c && c.clothing) || {})
      .map(([k, v]) => `${k}: ${v}`).join(", ");
    return {
      character_id: id,
      name: str(c && c.name),
      role: str(c && c.role),
      appearance: [appearance, clothing].filter(Boolean).join(" · "),
      usage: used.length
        ? `appears in ${used.length} scene${used.length === 1 ? "" : "s"}: ${used.map((s) => s.scene_number).join(", ")}`
        : "not yet placed in a scene",
      visual_identity_prompt: str(c && c.visual_identity_prompt),
    };
  });
};

const planScenesFromBoard = (board) => arr(board && board.scenes).map((s) => {
  const o = s && typeof s === "object" ? s : {};
  const cam = (o.camera && typeof o.camera === "object") ? o.camera : {};
  return {
    scene_number: Number(o.scene_number) || 0,
    title: str(o.title),
    synopsis: str(o.story_beat) || str(o.action),
    duration_seconds: Number(o.duration_seconds) || 0,
    shot_type: str(cam.shot_type),
    camera_movement: str(cam.movement),
    transition: str(o.transition_to_next_scene),
    characters: arr(o.characters).map((x) => str(x)).filter(Boolean),
    prompt: str(o.image_prompt),
  };
});

/**
 * Derive the Director Plan from a Director board. Real data only — every
 * field traces back to the bible or the planned scenes.
 */
export function buildKidsPlanFromBoard(board = {}, project = {}) {
  const b = board && typeof board === "object" ? board : {};
  const p = project && typeof project === "object" ? project : {};
  const bp = (b.blueprint && typeof b.blueprint === "object") ? b.blueprint : {};
  const analysis = (bp.analysis && typeof bp.analysis === "object") ? bp.analysis : {};
  const scenes = planScenesFromBoard(b);
  const input = (b.input && typeof b.input === "object") ? b.input : {};
  const genre = str(input.genre) || "Kids";
  const genreCustom = str(input.genreCustom);
  const focus = learningFocus(genre, genreCustom);
  const isKids = isKidsGenre(genre, genreCustom);
  const totalSeconds = scenes.reduce((a, s) => a + (Number(s.duration_seconds) || 0), 0);
  const camera = planCameraFromBoard(b);
  const lighting = buildLightingPlan(b);
  const consistency = {
    script_to_scene: "Every lyric or script line must be covered by exactly one planned scene, in order.",
    character_continuity: DEFAULT_CHARACTER_CONSISTENCY_RULES.join(" "),
    scene_to_render: "The image prompt of a scene is the ONLY text handed to the model for that frame; the clip animates that same still.",
  };
  const plan = normalizeKidsDirectorPlan({
    version: 1,
    creative_direction: [
      str(b.styleLock) || `Visual style locked to ${str(input.visualStyle) || "the studio style"}.`,
      genreDirectingNotes(genre, genreCustom),
    ].filter(Boolean).join(" "),
    objective: {
      kind: focus ? "education" : "entertainment",
      teaching_objective: focus
        ? `Teach ${focus.replace(/_/g, " ")} — one clear idea per beat, big readable letterforms / exact counts.`
        : "",
      entertainment_objective: isKids
        ? "Hold a preschool attention span with warm, friendly, repeatable staging."
        : "",
    },
    narrative: {
      beginning: str(analysis.beginning),
      middle: str(analysis.middle),
      climax: str(analysis.climax),
      ending: str(analysis.ending),
    },
    visual_continuity: [
      str(b.styleLock),
      "One location per beat; the same props and palette carry across neighbouring scenes.",
    ].filter(Boolean).join(" "),
    scene_count: scenes.length,
    approximate_duration_seconds: Math.round(totalSeconds * 10) / 10,
    characters: planCharactersFromBoard(b),
    scenes,
    camera: {
      ...camera,
      framing_notes: lighting.map((l) => `Scene ${l.scene_number}: ${l.time_of_day} · ${l.lighting}`).join(" | ").slice(0, 2000),
    },
    audio: {
      background_music: str(p.music_preferences),
      ambience: "",
      sound_effects: [],
      narration_notes: str(p.narration_preferences),
    },
    age_appropriateness: {
      language_notes: isKids ? "Simple spoken sentences a preschooler can follow." : "",
      visual_notes: isKids ? "Warm lighting, gentle camera, no frightening imagery." : "",
      pacing_notes: isKids ? "Calm cuts — no shot shorter than 1.5s, one idea per shot." : "",
    },
    consistency,
    // The kids content-keyword scanner was removed from the Director — the
    // plan carries no auto warnings (a human review is still expected).
    warnings: [],
  });
  return plan;
}

// ---------------------------------------------------------------------------
// Stage 2 prompt — the AI writes the plan for a NEW project (no board yet)
// ---------------------------------------------------------------------------

export const KIDS_DIRECTOR_SYSTEM = `You are the AI Director of Sanskriti Kids Studio, a specialist children's film director and teacher.
You plan preschool and school-age educational videos: nursery rhymes, alphabet and counting lessons, moral stories and nature shorts.
You are warm, concrete and age-aware. Every instruction must be watchable and understandable by a 4-year-old.
Respond with JSON ONLY.`;

/**
 * The Stage-2 prompt. It asks for the structured plan the studio stores and
 * lets the user edit. It never invents cast/locations the user did not
 * supply — it plans from the given script only.
 */
export function buildKidsDirectorPlanPrompt(project = {}) {
  const p = project && typeof project === "object" ? project : {};
  const lines = [
    `TITLE: ${str(p.title)}`,
    `LANGUAGE: ${str(p.language)}`,
    `CATEGORY: ${str(p.category)}`,
    `TARGET AGE GROUP: ${str(p.age_group)}`,
    `TARGET DURATION: ~${Math.round(Number(p.duration_seconds) || 60)} seconds`,
    `ASPECT RATIO: ${str(p.aspect_ratio)}`,
    `OUTPUT RESOLUTION: ${str(p.resolution)}`,
    `VISUAL STYLE: ${str(p.visual_style)}`,
    `TARGET PLATFORM: ${str(p.target_platform)}`,
    p.narration_preferences ? `NARRATION PREFERENCES: ${p.narration_preferences}` : null,
    p.music_preferences ? `MUSIC & SOUND PREFERENCES: ${p.music_preferences}` : null,
    p.description ? `DESCRIPTION: ${p.description}` : null,
    ``,
    `SCRIPT / LYRICS:`,
    str(p.script) || str(p.lyrics) || "(none supplied)",
    ``,
    `TASK — write the Director Plan as JSON with exactly these keys:`,
    `{ "creative_direction": "2-4 sentences: look, feel, staging rules for this specific video",`,
    `  "objective": { "kind": "education|entertainment", "teaching_objective": "...", "entertainment_objective": "..." },`,
    `  "narrative": { "beginning": "...", "middle": "...", "climax": "...", "ending": "..." },`,
    `  "visual_continuity": "how the look stays consistent between scenes",`,
    `  "scene_count": 0, "approximate_duration_seconds": 0,`,
    `  "characters": [{ "character_id": "snake_case", "name": "...", "role": "hero|supporting|narrator", "appearance": "species + body + face + clothes", "usage": "where this character appears", "visual_identity_prompt": "STATIC portrait only, comma-separated, no action, no scene" }],`,
    `  "scenes": [{ "scene_number": 1, "title": "...", "synopsis": "one line", "duration_seconds": 0, "shot_type": "Wide Shot|Medium Shot|Close-Up|Over-the-Shoulder|Insert", "camera_movement": "Static|Slow Push-In|Pan Left|Pan Right|Tilt Up", "transition": "Cut|Dissolve|Fade|Wipe", "characters": ["character_id"], "prompt": "the image prompt for this frame" }],`,
    `  "camera": { "shot_types": ["..."], "movements": ["..."], "transitions": ["..."], "framing_notes": "..." },`,
    `  "audio": { "background_music": "...", "ambience": "...", "sound_effects": ["..."], "narration_notes": "..." },`,
    `  "age_appropriateness": { "language_notes": "...", "visual_notes": "...", "pacing_notes": "..." },`,
    `  "consistency": { "script_to_scene": "...", "character_continuity": "...", "scene_to_render": "..." },`,
    `  "warnings": ["anything the teacher should review"] }`,
    `Rules:`,
    `- Plan ONLY the characters the script actually contains. Never invent a cast that the text does not mention.`,
    `- ONE clear readable action per scene; a preschooler must follow it.`,
    `- Gentle camera only (Static, Slow Push-In, gentle Pan) — never whip moves or fast cuts.`,
    `- The scene_count must fit the target duration: roughly ${Math.max(1, Math.round((Number(p.duration_seconds) || 60) / 6))} scenes for ${Math.round(Number(p.duration_seconds) || 60)} seconds.`,
    `- Alphabet/counting content: show the letterform BIG and the count EXACT.`,
    `- Every scene prompt must be self-contained (who is on screen, where, what they do, the mood).`,
    `Respond with JSON ONLY.`,
  ];
  return lines.filter((l) => l !== null).join("\n");
}

// ---------------------------------------------------------------------------
// Dashboard metrics — computed from real rows, never hardcoded
// ---------------------------------------------------------------------------

/**
 * Compute the Kids Studio dashboard metrics from the real project / scene /
 * character / asset / job rows.
 */
export function kidsDashboardMetrics({
  projects = [],
  scenes = [],
  characters = [],
  assets = [],
  jobs = [],
} = {}) {
  const P = arr(projects);
  const S = arr(scenes);
  const C = arr(characters);
  const A = arr(assets);
  const J = arr(jobs);
  const status = (p) => str(p && p.status).trim().toLowerCase();
  const assetKind = (a) => str(a && (a.kind || a.asset_type)).trim().toLowerCase();
  const jobStatus = (j) => str(j && j.status).trim().toUpperCase();
  return {
    totalProjects: P.length,
    draftStories: P.filter((p) => status(p) === "draft").length,
    characters: C.length,
    charactersWithProfile: C.filter((c) => str(c && c.visual_identity_prompt).trim()).length,
    scenes: S.length,
    imagesGenerated: A.filter((a) => assetKind(a) === "image" || assetKind(a) === "keyframe" || assetKind(a) === "reference").length,
    videosGenerated: A.filter((a) => assetKind(a) === "video" || assetKind(a) === "clip").length,
    completedVideos: A.filter((a) => assetKind(a) === "final" || assetKind(a) === "video" || assetKind(a) === "clip")
      .filter((a) => str(a && a.status).trim().toLowerCase() === "completed").length,
    inProgress: P.filter((p) => ["planning", "approved", "in_progress"].includes(status(p))).length,
    completedProjects: P.filter((p) => status(p) === "completed").length,
    failedOrPendingJobs: J.filter((j) => ["FAILED", "PENDING", "PROCESSING"].includes(jobStatus(j))).length,
    failedJobs: J.filter((j) => jobStatus(j) === "FAILED").length,
    totalJobs: J.length,
  };
}

// ---------------------------------------------------------------------------
// SCHEMA — the Sanskriti_kids database (Postgres)
// ---------------------------------------------------------------------------

export const KIDS_SCHEMA = `
CREATE TABLE IF NOT EXISTS kids_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'Hindi',
  category TEXT NOT NULL DEFAULT '',
  age_group TEXT NOT NULL DEFAULT '',
  duration_seconds INTEGER NOT NULL DEFAULT 60,
  aspect_ratio TEXT NOT NULL DEFAULT '16:9',
  resolution TEXT NOT NULL DEFAULT '1280x720',
  visual_style TEXT NOT NULL DEFAULT '',
  narration_preferences TEXT NOT NULL DEFAULT '',
  music_preferences TEXT NOT NULL DEFAULT '',
  target_platform TEXT NOT NULL DEFAULT '',
  lyrics TEXT NOT NULL DEFAULT '',
  script TEXT NOT NULL DEFAULT '',
  audio_path TEXT NOT NULL DEFAULT '',
  reference_images JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','planning','approved','in_progress','completed','archived')),
  board_id TEXT,
  scenario_name TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kids_projects_status ON kids_projects(status);
CREATE INDEX IF NOT EXISTS idx_kids_projects_created ON kids_projects(created_at DESC);

CREATE TABLE IF NOT EXISTS kids_director_plans (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES kids_projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  plan JSONB NOT NULL DEFAULT '{}',
  note TEXT NOT NULL DEFAULT '',
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, version)
);
CREATE INDEX IF NOT EXISTS idx_kids_plans_project ON kids_director_plans(project_id, version DESC);

CREATE TABLE IF NOT EXISTS kids_scenes (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES kids_projects(id) ON DELETE CASCADE,
  scene_number INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  synopsis TEXT NOT NULL DEFAULT '',
  duration_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  camera TEXT NOT NULL DEFAULT '',
  transition TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, scene_number)
);
CREATE INDEX IF NOT EXISTS idx_kids_scenes_project ON kids_scenes(project_id, scene_number);

CREATE TABLE IF NOT EXISTS kids_characters (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES kids_projects(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  species TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  visual_identity_prompt TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, character_id)
);
CREATE INDEX IF NOT EXISTS idx_kids_characters_project ON kids_characters(project_id);

CREATE TABLE IF NOT EXISTS kids_assets (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES kids_projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('reference','keyframe','image','clip','video','final','audio')),
  scene_number INTEGER,
  file_path TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kids_assets_project ON kids_assets(project_id, kind);

CREATE TABLE IF NOT EXISTS kids_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  kind TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','COMPLETED','FAILED')),
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kids_jobs_project ON kids_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_kids_jobs_status ON kids_jobs(status);

CREATE TABLE IF NOT EXISTS kids_options (
  option_key TEXT NOT NULL,
  option_value TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (option_key, option_value)
);

-- Story Studio: every story document is a VERSION (never overwritten).
CREATE TABLE IF NOT EXISTS kids_story_versions (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES kids_projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  story JSONB NOT NULL DEFAULT '{}',
  note TEXT NOT NULL DEFAULT '',
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, version)
);
CREATE INDEX IF NOT EXISTS idx_kids_story_project ON kids_story_versions(project_id, version DESC);

-- Storyboard and Scene Timeline — the EDITABLE timeline rows (the Director
-- board stays the source of the scene plan; this is the studio's timeline).
CREATE TABLE IF NOT EXISTS kids_timeline_rows (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES kids_projects(id) ON DELETE CASCADE,
  scene_number INTEGER NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, scene_number)
);
CREATE INDEX IF NOT EXISTS idx_kids_timeline_project ON kids_timeline_rows(project_id, scene_number);

-- Reusable asset library: characters, locations and props. The scope column
-- is the project id or 'shared' (a shared row is reusable across projects).
CREATE TABLE IF NOT EXISTS kids_library_assets (
  id BIGSERIAL PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'shared',
  project_id TEXT REFERENCES kids_projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('character','location','prop')),
  asset_key TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  tags JSONB NOT NULL DEFAULT '[]',
  prompt TEXT NOT NULL DEFAULT '',
  reference_image TEXT NOT NULL DEFAULT '',
  appearance TEXT NOT NULL DEFAULT '',
  clothing TEXT NOT NULL DEFAULT '',
  colors TEXT NOT NULL DEFAULT '',
  personality TEXT NOT NULL DEFAULT '',
  voice TEXT NOT NULL DEFAULT '',
  movement TEXT NOT NULL DEFAULT '',
  age_appearance TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review','approved','archived')),
  locked BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scope, kind, asset_key)
);
CREATE INDEX IF NOT EXISTS idx_kids_library_scope ON kids_library_assets(scope, kind);

-- The generated reference stills of a library asset (one row per version).
CREATE TABLE IF NOT EXISTS kids_library_files (
  id BIGSERIAL PRIMARY KEY,
  asset_id BIGINT NOT NULL REFERENCES kids_library_assets(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'image',
  prompt TEXT NOT NULL DEFAULT '',
  workflow TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'COMPLETED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kids_library_files_asset ON kids_library_files(asset_id, id);

-- Song & Lyrics Studio: the segmented lyric sheet.
CREATE TABLE IF NOT EXISTS kids_lyric_sections (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES kids_projects(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL DEFAULT 0,
  label TEXT NOT NULL DEFAULT 'verse',
  lines JSONB NOT NULL DEFAULT '[]',
  text TEXT NOT NULL DEFAULT '',
  start_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  end_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  emotion TEXT NOT NULL DEFAULT '',
  character_ids JSONB NOT NULL DEFAULT '[]',
  choreography TEXT NOT NULL DEFAULT '',
  lip_sync BOOLEAN NOT NULL DEFAULT FALSE,
  estimated BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kids_lyrics_project ON kids_lyric_sections(project_id, seq);

-- Audio analysis: the measured timeline of the source audio.
CREATE TABLE IF NOT EXISTS kids_audio_segments (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES kids_projects(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL DEFAULT 0,
  start_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  end_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  duration_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  type TEXT NOT NULL DEFAULT 'music',
  speaker TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  emotion TEXT NOT NULL DEFAULT '',
  character TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  scene TEXT NOT NULL DEFAULT '',
  background TEXT NOT NULL DEFAULT '',
  camera TEXT NOT NULL DEFAULT '',
  music_note TEXT NOT NULL DEFAULT '',
  sound_effect TEXT NOT NULL DEFAULT '',
  confidence DOUBLE PRECISION,
  estimated BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kids_audio_project ON kids_audio_segments(project_id, seq);

-- Quality control runs.
CREATE TABLE IF NOT EXISTS kids_qc_runs (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES kids_projects(id) ON DELETE CASCADE,
  summary JSONB NOT NULL DEFAULT '{}',
  checks JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kids_qc_project ON kids_qc_runs(project_id, created_at DESC);

-- Export records (the export itself is produced by the FFmpeg pipeline).
CREATE TABLE IF NOT EXISTS kids_exports (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES kids_projects(id) ON DELETE CASCADE,
  profile TEXT NOT NULL DEFAULT 'youtube',
  status TEXT NOT NULL DEFAULT 'pending',
  file_path TEXT NOT NULL DEFAULT '',
  duration_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  resolution TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kids_exports_project ON kids_exports(project_id, created_at DESC);

-- AI Learning Center: ratings and approvals (a training example needs an
-- explicit approval — the studio never trains on unreviewed output).
CREATE TABLE IF NOT EXISTS kids_feedback (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES kids_projects(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  rating INTEGER,
  verdict TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  corrected_text TEXT NOT NULL DEFAULT '',
  use_for_training BOOLEAN NOT NULL DEFAULT FALSE,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kids_feedback_project ON kids_feedback(project_id, created_at DESC);
`;

// SQLite fallback (same tables, JSON stored as TEXT) — used when the
// Sanskriti_kids Postgres database is unreachable so the studio still runs.
export const KIDS_SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS kids_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'Hindi',
  category TEXT NOT NULL DEFAULT '',
  age_group TEXT NOT NULL DEFAULT '',
  duration_seconds INTEGER NOT NULL DEFAULT 60,
  aspect_ratio TEXT NOT NULL DEFAULT '16:9',
  resolution TEXT NOT NULL DEFAULT '1280x720',
  visual_style TEXT NOT NULL DEFAULT '',
  narration_preferences TEXT NOT NULL DEFAULT '',
  music_preferences TEXT NOT NULL DEFAULT '',
  target_platform TEXT NOT NULL DEFAULT '',
  lyrics TEXT NOT NULL DEFAULT '',
  script TEXT NOT NULL DEFAULT '',
  audio_path TEXT NOT NULL DEFAULT '',
  reference_images TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',
  board_id TEXT,
  scenario_name TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_kids_projects_status_lite ON kids_projects(status);
CREATE TABLE IF NOT EXISTS kids_director_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',
  plan TEXT NOT NULL DEFAULT '{}',
  note TEXT NOT NULL DEFAULT '',
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, version)
);
CREATE INDEX IF NOT EXISTS idx_kids_plans_project_lite ON kids_director_plans(project_id, version);
CREATE TABLE IF NOT EXISTS kids_scenes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  scene_number INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  synopsis TEXT NOT NULL DEFAULT '',
  duration_seconds REAL NOT NULL DEFAULT 0,
  camera TEXT NOT NULL DEFAULT '',
  transition TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, scene_number)
);
CREATE INDEX IF NOT EXISTS idx_kids_scenes_project_lite ON kids_scenes(project_id, scene_number);
CREATE TABLE IF NOT EXISTS kids_characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  species TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  visual_identity_prompt TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, character_id)
);
CREATE INDEX IF NOT EXISTS idx_kids_characters_project_lite ON kids_characters(project_id);
CREATE TABLE IF NOT EXISTS kids_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  scene_number INTEGER,
  file_path TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_kids_assets_project_lite ON kids_assets(project_id, kind);
CREATE TABLE IF NOT EXISTS kids_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  kind TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING',
  error_message TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_kids_jobs_project_lite ON kids_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_kids_jobs_status_lite ON kids_jobs(status);
CREATE TABLE IF NOT EXISTS kids_options (
  option_key TEXT NOT NULL,
  option_value TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (option_key, option_value)
);
CREATE TABLE IF NOT EXISTS kids_story_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',
  story TEXT NOT NULL DEFAULT '{}',
  note TEXT NOT NULL DEFAULT '',
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, version)
);
CREATE INDEX IF NOT EXISTS idx_kids_story_project_lite ON kids_story_versions(project_id, version DESC);
CREATE TABLE IF NOT EXISTS kids_timeline_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  scene_number INTEGER NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, scene_number)
);
CREATE INDEX IF NOT EXISTS idx_kids_timeline_project_lite ON kids_timeline_rows(project_id, scene_number);
CREATE TABLE IF NOT EXISTS kids_library_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'shared',
  project_id TEXT,
  kind TEXT NOT NULL,
  asset_key TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  prompt TEXT NOT NULL DEFAULT '',
  reference_image TEXT NOT NULL DEFAULT '',
  appearance TEXT NOT NULL DEFAULT '',
  clothing TEXT NOT NULL DEFAULT '',
  colors TEXT NOT NULL DEFAULT '',
  personality TEXT NOT NULL DEFAULT '',
  voice TEXT NOT NULL DEFAULT '',
  movement TEXT NOT NULL DEFAULT '',
  age_appearance TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',
  locked INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (scope, kind, asset_key)
);
CREATE INDEX IF NOT EXISTS idx_kids_library_scope_lite ON kids_library_assets(scope, kind);
CREATE TABLE IF NOT EXISTS kids_library_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'image',
  prompt TEXT NOT NULL DEFAULT '',
  workflow TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'COMPLETED',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_kids_library_files_asset_lite ON kids_library_files(asset_id, id);
CREATE TABLE IF NOT EXISTS kids_lyric_sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  label TEXT NOT NULL DEFAULT 'verse',
  lines TEXT NOT NULL DEFAULT '[]',
  text TEXT NOT NULL DEFAULT '',
  start_seconds REAL NOT NULL DEFAULT 0,
  end_seconds REAL NOT NULL DEFAULT 0,
  emotion TEXT NOT NULL DEFAULT '',
  character_ids TEXT NOT NULL DEFAULT '[]',
  choreography TEXT NOT NULL DEFAULT '',
  lip_sync INTEGER NOT NULL DEFAULT 0,
  estimated INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_kids_lyrics_project_lite ON kids_lyric_sections(project_id, seq);
CREATE TABLE IF NOT EXISTS kids_audio_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  start_seconds REAL NOT NULL DEFAULT 0,
  end_seconds REAL NOT NULL DEFAULT 0,
  duration_seconds REAL NOT NULL DEFAULT 0,
  type TEXT NOT NULL DEFAULT 'music',
  speaker TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  emotion TEXT NOT NULL DEFAULT '',
  character TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  scene TEXT NOT NULL DEFAULT '',
  background TEXT NOT NULL DEFAULT '',
  camera TEXT NOT NULL DEFAULT '',
  music_note TEXT NOT NULL DEFAULT '',
  sound_effect TEXT NOT NULL DEFAULT '',
  confidence REAL,
  estimated INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_kids_audio_project_lite ON kids_audio_segments(project_id, seq);
CREATE TABLE IF NOT EXISTS kids_qc_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '{}',
  checks TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_kids_qc_project_lite ON kids_qc_runs(project_id, created_at DESC);
CREATE TABLE IF NOT EXISTS kids_exports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  profile TEXT NOT NULL DEFAULT 'youtube',
  status TEXT NOT NULL DEFAULT 'pending',
  file_path TEXT NOT NULL DEFAULT '',
  duration_seconds REAL NOT NULL DEFAULT 0,
  resolution TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_kids_exports_project_lite ON kids_exports(project_id, created_at DESC);
CREATE TABLE IF NOT EXISTS kids_feedback (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  target_kind TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  rating INTEGER,
  verdict TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  corrected_text TEXT NOT NULL DEFAULT '',
  use_for_training INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_kids_feedback_project_lite ON kids_feedback(project_id, created_at DESC);
`;
