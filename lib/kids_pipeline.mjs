// Sanskriti Kids — production pipeline helpers (pure: no fs, no network, no db).
//
// This module carries the WORKFLOW logic of the Sanskriti Kids studio:
// the 16 production stages and their dependencies, the Story Studio document,
// the Song & Lyrics segmentation, the scene timeline, the reusable asset
// library, the quality-control checks and the feedback records.
//
// Everything here is deterministic and unit-tested (tests/kids_pipeline.test.mjs).
// The server owns persistence and the real generation calls; the frontend
// renders what these helpers describe. Nothing in here invents a number:
// every metric is derived from the rows the server passes in.

// ---------------------------------------------------------------------------
// Small helpers (kept local so this file has no dependency besides itself).
// ---------------------------------------------------------------------------
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v, fb = "") => (v == null ? fb : String(v));
const round = (v, p = 2) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** p;
  return Math.round(n * f) / f;
};
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
const strList = (v, max = 60, len = 400) =>
  arr(v).map((x) => str(x).trim().slice(0, len)).filter(Boolean).slice(0, max);
const slugKey = (v, fb = "asset") => {
  const clean = str(v).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
  return clean || fb;
};

// ---------------------------------------------------------------------------
// 1. The production pipeline — 16 stages with their real dependencies.
//
// `engine` names the EXISTING engine that actually performs the work, so the
// studio never invents a second renderer. Stages whose engine is an external
// service report their availability honestly (the server fills `available`).
// ---------------------------------------------------------------------------
export const KIDS_PIPELINE_STAGES = [
  {
    id: "director",
    label: "Kids Director",
    group: "planning",
    deps: [],
    advisory_deps: [],
    engine: "studio",
    input: "story idea / lyrics, age group, language, duration, style",
    description: "Coordinates the whole production: validates the brief and plans the run.",
  },
  {
    id: "story",
    label: "Story Studio",
    group: "planning",
    deps: [],
    advisory_deps: ["director"],
    engine: "llm",
    input: "topic, script or lyrics, age group, learning objective",
    description: "Outline, characters, scene breakdown, dialogue, narration and safety checks.",
  },
  {
    id: "song",
    label: "Song and Lyrics Studio",
    group: "planning",
    deps: [],
    advisory_deps: ["director"],
    engine: "llm",
    input: "pasted lyrics, TXT/document or an audio file",
    description: "Segments the lyrics into verses, choruses, intros and instrumental parts.",
  },
  {
    id: "audio",
    label: "Audio Analysis and Narration",
    group: "planning",
    deps: [],
    advisory_deps: ["director"],
    engine: "ffmpeg+whisper",
    input: "uploaded narration or song audio",
    description: "Measures duration, silence and beats; transcribes when Whisper is configured.",
  },
  {
    id: "characters",
    label: "Character Library",
    group: "library",
    deps: [],
    advisory_deps: ["story"],
    engine: "studio",
    input: "story characters, reference images",
    description: "Reusable characters with a canonical look, a voice and a version history.",
  },
  {
    id: "locations",
    label: "Background and Location Library",
    group: "library",
    deps: [],
    advisory_deps: [],
    engine: "studio",
    input: "locations used by the storyboard",
    description: "Reusable backgrounds so a place never changes between scenes.",
  },
  {
    id: "props",
    label: "Props and Educational Objects",
    group: "library",
    deps: [],
    advisory_deps: [],
    engine: "studio",
    input: "props used by the storyboard",
    description: "Reusable educational objects (toys, books, fruits, vehicles, sports gear).",
  },
  {
    id: "storyboard",
    label: "Storyboard and Scene Timeline",
    group: "production",
    deps: ["story"],
    advisory_deps: [],
    engine: "studio",
    input: "story sections, audio timeline",
    description: "Ordered scenes with timestamps, prompts, references and approval state.",
  },
  {
    id: "images",
    label: "Image Generation",
    group: "production",
    deps: ["storyboard"],
    advisory_deps: ["characters"],
    engine: "comfyui",
    input: "approved references, per-scene image prompts",
    description: "One keyframe per scene through the configured ComfyUI image workflow.",
  },
  {
    id: "video",
    label: "Image-to-Video Generation",
    group: "production",
    deps: ["images"],
    advisory_deps: [],
    engine: "comfyui",
    input: "approved keyframe, motion prompt, camera move",
    description: "Animates the approved still with LTX / Wan (whatever is configured).",
  },
  {
    id: "voice",
    label: "Voice and Lip Sync",
    group: "production",
    deps: ["storyboard"],
    advisory_deps: [],
    engine: "edge-tts+wav2lip",
    input: "dialogue lines, voice mapping",
    description: "Narration and character voices, then lip-sync for eligible scenes.",
  },
  {
    id: "assembly",
    label: "Video Upscaling and Editing",
    group: "finish",
    deps: ["video"],
    advisory_deps: [],
    engine: "ffmpeg",
    input: "clips, music bed, subtitles",
    description: "Trims, mixes, fades, converts aspect ratio and upscales the clips.",
  },
  {
    id: "final",
    label: "Final Video Assembly",
    group: "finish",
    deps: ["assembly"],
    advisory_deps: [],
    engine: "ffmpeg",
    input: "ordered clips, audio track",
    description: "Concatenates the approved clips into the final cut.",
  },
  {
    id: "assets",
    label: "Project Assets and Media Library",
    group: "finish",
    deps: [],
    advisory_deps: ["images"],
    engine: "studio",
    input: "every generated file",
    description: "One place for the real files, their prompts and their model settings.",
  },
  {
    id: "qc",
    label: "Quality Control and Export",
    group: "finish",
    deps: [],
    advisory_deps: ["final"],
    engine: "studio+ffprobe",
    input: "final cut, story, timeline, assets",
    description: "Runs the children's-content checks and records the export.",
  },
  {
    id: "feedback",
    label: "AI Learning and Feedback",
    group: "finish",
    deps: [],
    advisory_deps: [],
    engine: "studio",
    input: "approved outputs",
    description: "Ratings and approvals stored as versioned examples — never auto-trained.",
  },
];

export const KIDS_PIPELINE_STAGE_IDS = KIDS_PIPELINE_STAGES.map((s) => s.id);

/** The stage definition by id (or null). */
export function kidsStage(id) {
  return KIDS_PIPELINE_STAGES.find((s) => s.id === id) || null;
}

/** Stages in dependency order (topological, stable). */
export function kidsPipelineOrder() {
  const out = [];
  const seen = new Set();
  const visit = (id) => {
    if (seen.has(id)) return;
    const stage = kidsStage(id);
    if (!stage) return;
    for (const dep of stage.deps) visit(dep);
    seen.add(id);
    out.push(stage);
  };
  for (const stage of KIDS_PIPELINE_STAGES) visit(stage.id);
  return out;
}

/**
 * The state the studio actually holds. Each entry is a COUNT (or a list) of
 * real rows — never a hardcoded status.
 */
export function kidsPipelineState(input = {}) {
  const i = input && typeof input === "object" ? input : {};
  return {
    plan: i.plan || null,
    story: i.story || null,
    lyricSections: arr(i.lyricSections),
    audioSegments: arr(i.audioSegments),
    characters: arr(i.characters),
    locations: arr(i.locations),
    props: arr(i.props),
    scenes: arr(i.scenes),
    timeline: arr(i.timeline),
    images: arr(i.images),
    videos: arr(i.videos),
    voices: arr(i.voices),
    final: i.final || null,
    assets: arr(i.assets),
    qc: i.qc || null,
    feedback: arr(i.feedback),
  };
}

/**
 * Compute the status of every stage from the real state.
 * status: "done" | "ready" | "blocked" | "pending"
 * A stage is "done" when its artefact exists; "ready" when its dependencies
 * are done and the artefact is missing; "blocked" when a dependency is not
 * done yet.
 */
export function kidsStageStatus(stateInput = {}, { available = {} } = {}) {
  const s = kidsPipelineState(stateInput);
  const done = {
    director: Boolean(s.plan),
    story: Boolean(s.story),
    song: s.lyricSections.length > 0,
    audio: s.audioSegments.length > 0,
    characters: s.characters.length > 0,
    locations: s.locations.length > 0,
    props: s.props.length > 0,
    storyboard: s.scenes.length > 0,
    images: s.images.length > 0,
    video: s.videos.length > 0,
    voice: s.voices.length > 0,
    assembly: s.videos.length > 0,
    final: Boolean(s.final),
    assets: s.assets.length > 0,
    qc: Boolean(s.qc),
    feedback: s.feedback.length > 0,
  };
  const order = kidsPipelineOrder();
  const statuses = {};
  for (const stage of order) {
    // A HARD dependency must be DONE before the stage can run; an advisory
    // dependency is only reported (the stage still works without it).
    const hard = (stage.deps || []).filter((d) => statuses[d] !== undefined);
    const unmet = hard.filter((d) => statuses[d] !== "done");
    let status;
    if (done[stage.id]) status = "done";
    else if (unmet.length) status = "blocked";
    else status = "ready";
    statuses[stage.id] = status;
  }
  return order.map((stage) => ({
    ...stage,
    status: statuses[stage.id],
    blocked_by: (stage.deps || []).filter((d) => statuses[d] !== "done" && statuses[d] !== undefined),
    advisory_pending: (stage.advisory_deps || []).filter((d) => statuses[d] !== "done" && statuses[d] !== undefined),
    available: available[stage.id] !== false,
    output_count: {
      director: s.plan ? 1 : 0,
      story: s.story ? 1 : 0,
      song: s.lyricSections.length,
      audio: s.audioSegments.length,
      characters: s.characters.length,
      locations: s.locations.length,
      props: s.props.length,
      storyboard: s.scenes.length,
      images: s.images.length,
      video: s.videos.length,
      voice: s.voices.length,
      assembly: s.videos.length,
      final: s.final ? 1 : 0,
      assets: s.assets.length,
      qc: s.qc ? 1 : 0,
      feedback: s.feedback.length,
    }[stage.id] ?? 0,
  }));
}

/** Which stages may run now (dependency-wise). */
export function kidsRunnableStages(stages) {
  return arr(stages).filter((s) => s.status === "ready").map((s) => s.id);
}

// ---------------------------------------------------------------------------
// 2. Story Studio — the editable story document
// ---------------------------------------------------------------------------

export const KIDS_STORY_STATUSES = ["draft", "approved"];

/** The sections the Story Studio produces, in pipeline order. */
export const KIDS_STORY_SECTIONS = [
  "title", "description", "age_group", "learning_objective",
  "beginning", "middle", "ending",
  "characters", "dialogue", "narration", "scenes",
  "visual_continuity", "backgrounds", "props", "music", "sound_effects", "safety",
];

/** Normalize a story document (AI answer or user edit). */
export function normalizeKidsStory(raw = {}) {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const characters = arr(o.characters).map((c, i) => {
    const x = c && typeof c === "object" ? c : {};
    const name = str(x.name).trim().slice(0, 120);
    return {
      character_id: str(x.character_id).trim().slice(0, 120) || slugKey(name, `character_${i + 1}`),
      name,
      role: str(x.role).trim().slice(0, 80),
      category: str(x.category).trim().slice(0, 80),
      appearance: str(x.appearance).trim().slice(0, 1500),
      clothing: str(x.clothing).trim().slice(0, 800),
      colors: str(x.colors).trim().slice(0, 400),
      personality: str(x.personality).trim().slice(0, 800),
      voice: str(x.voice || x.voice_description).trim().slice(0, 400),
      movement: str(x.movement || x.animation_style).trim().slice(0, 400),
      supporting: x.supporting === true,
    };
  }).filter((c) => c.name || c.character_id);
  const dialogue = arr(o.dialogue).map((d) => {
    const x = d && typeof d === "object" ? d : {};
    return {
      scene_number: clampInt(x.scene_number, 0, 999, 0),
      speaker: str(x.speaker).trim().slice(0, 120),
      line: str(x.line || x.text).trim().slice(0, 2000),
      emotion: str(x.emotion).trim().slice(0, 120),
      delivery: str(x.delivery).trim().slice(0, 200),
    };
  }).filter((d) => d.line);
  const narration = arr(o.narration).map((n) => {
    const x = n && typeof n === "object" ? n : {};
    return {
      scene_number: clampInt(x.scene_number, 0, 999, 0),
      text: str(x.text || x.line).trim().slice(0, 4000),
      emotion: str(x.emotion).trim().slice(0, 120),
      delivery: str(x.delivery).trim().slice(0, 200),
    };
  }).filter((n) => n.text);
  const scenes = arr(o.scenes).map((s, i) => {
    const x = s && typeof s === "object" ? s : {};
    return {
      scene_number: clampInt(x.scene_number, 1, 999, i + 1),
      title: str(x.title).trim().slice(0, 200),
      description: str(x.description || x.synopsis).trim().slice(0, 2000),
      duration_seconds: clampNum(x.duration_seconds, 0, 600, 0),
      characters: strList(x.characters, 16, 120),
      location: str(x.location).trim().slice(0, 200),
      props: strList(x.props || x.objects, 24, 120),
      action: str(x.action).trim().slice(0, 2000),
      emotion: str(x.emotion).trim().slice(0, 200),
      camera_shot: str(x.camera_shot || x.shot_type).trim().slice(0, 80),
      camera_movement: str(x.camera_movement || x.movement).trim().slice(0, 80),
      lighting: str(x.lighting).trim().slice(0, 200),
      image_prompt: str(x.image_prompt).trim().slice(0, 4000),
      video_prompt: str(x.video_prompt).trim().slice(0, 4000),
      negative_prompt: str(x.negative_prompt).trim().slice(0, 2000),
      narration: str(x.narration).trim().slice(0, 2000),
      dialogue: arr(x.dialogue).map((d) => (typeof d === "string" ? d : str(d?.line))).filter(Boolean).slice(0, 12),
    };
  });
  const safety = o.safety && typeof o.safety === "object" ? o.safety : {};
  return {
    version: clampInt(o.version, 1, 999, 1),
    title: str(o.title).trim().slice(0, 200),
    description: str(o.description).trim().slice(0, 2000),
    age_group: str(o.age_group).trim().slice(0, 80),
    learning_objective: str(o.learning_objective || o.teaching_objective).trim().slice(0, 2000),
    beginning: str(o.beginning).trim().slice(0, 3000),
    middle: str(o.middle).trim().slice(0, 3000),
    ending: str(o.ending).trim().slice(0, 3000),
    characters,
    dialogue,
    narration,
    scenes,
    visual_continuity: str(o.visual_continuity).trim().slice(0, 3000),
    backgrounds: strList(o.backgrounds, 24, 200),
    props: strList(o.props, 40, 200),
    music: strList(o.music, 24, 300),
    sound_effects: strList(o.sound_effects, 40, 300),
    safety: {
      age_appropriate: safety.age_appropriate === true,
      notes: str(safety.notes).trim().slice(0, 2000),
      concerns: strList(safety.concerns, 20, 300),
    },
    warnings: strList(o.warnings, 20, 400),
  };
}

/** True when the story carries enough substance to be worth saving. */
export function isKidsStorySubstantive(story) {
  const s = normalizeKidsStory(story);
  return Boolean(s.title || s.beginning || s.scenes.length || s.characters.length || s.narration.length);
}

/** Validate a story document. Errors block approval, warnings are advisory. */
export function validateKidsStory(story = {}) {
  const s = normalizeKidsStory(story);
  const errors = [];
  const warnings = [];
  if (!s.title) errors.push("the story needs a title");
  if (!s.beginning && !s.scenes.length) errors.push("the story needs an outline or at least one scene");
  if (!s.age_group) warnings.push("no target age group set");
  if (!s.learning_objective) warnings.push("no learning objective set");
  if (!s.characters.length) warnings.push("no characters planned");
  if (!s.scenes.length) warnings.push("no scene breakdown yet");
  const ids = s.characters.map((c) => c.character_id);
  if (new Set(ids).size !== ids.length) warnings.push("two characters share the same character_id");
  for (const scene of s.scenes) {
    if (!scene.image_prompt) warnings.push(`scene ${scene.scene_number} has no image prompt`);
    if (scene.duration_seconds <= 0) warnings.push(`scene ${scene.scene_number} has no estimated duration`);
    for (const c of scene.characters) {
      if (!ids.includes(c)) warnings.push(`scene ${scene.scene_number} uses the unknown character "${c}"`);
    }
  }
  const total = s.scenes.reduce((a, x) => a + (Number(x.duration_seconds) || 0), 0);
  if (total > 0 && total > 900) warnings.push(`the planned runtime (${Math.round(total)}s) is very long for a kids video`);
  if (s.safety.concerns.length) warnings.push(`the story reports ${s.safety.concerns.length} safety concern(s) to review`);
  return { errors, warnings };
}

/** The Story Studio prompt (the AI writes the story document). */
export function buildKidsStoryPrompt(project = {}, { audioContext = "" } = {}) {
  const p = project && typeof project === "object" ? project : {};
  const lines = [
    `TITLE: ${str(p.title)}`,
    `LANGUAGE: ${str(p.language)}`,
    `CATEGORY: ${str(p.category)}`,
    `TARGET AGE GROUP: ${str(p.age_group)}`,
    `TARGET DURATION: ~${Math.round(Number(p.duration_seconds) || 60)} seconds`,
    `VISUAL STYLE: ${str(p.visual_style)}`,
    p.description ? `USER BRIEF: ${str(p.description)}` : null,
    p.narration_preferences ? `NARRATION PREFERENCES: ${str(p.narration_preferences)}` : null,
    p.music_preferences ? `MUSIC PREFERENCES: ${str(p.music_preferences)}` : null,
    audioContext ? `AUDIO CONTEXT (measured facts only): ${audioContext}` : null,
    ``,
    `SCRIPT / LYRICS:`,
    str(p.script) || str(p.lyrics) || "(none supplied)",
    ``,
    `TASK — write the story document as JSON with exactly these keys:`,
    `{ "title": "...", "description": "one short paragraph",`,
    `  "age_group": "...", "learning_objective": "one sentence a teacher can check",`,
    `  "beginning": "...", "middle": "...", "ending": "...",`,
    `  "characters": [{ "character_id": "snake_case", "name": "...", "role": "hero|supporting|narrator", "category": "child|parent|teacher|animal|bird|fantasy|mascot", "appearance": "species + body + face", "clothing": "...", "colors": "...", "personality": "...", "voice": "one line describing the voice", "movement": "how this character moves" }],`,
    `  "dialogue": [{ "scene_number": 1, "speaker": "character name", "line": "...", "emotion": "..." }],`,
    `  "narration": [{ "scene_number": 1, "text": "...", "emotion": "..." }],`,
    `  "scenes": [{ "scene_number": 1, "title": "...", "description": "...", "duration_seconds": 0,`,
    `              "characters": ["character_id"], "location": "...", "props": ["..."], "action": "one readable action",`,
    `              "emotion": "...", "camera_shot": "Wide Shot|Medium Shot|Close-Up", "camera_movement": "Static|Slow Push-In|Pan Left",`,
    `              "lighting": "...", "image_prompt": "self-contained image prompt", "video_prompt": "motion prompt",`,
    `              "negative_prompt": "...", "narration": "..." }],`,
    `  "visual_continuity": "how the look stays consistent between scenes",`,
    `  "backgrounds": ["..."], "props": ["..."], "music": ["..."], "sound_effects": ["..."],`,
    `  "safety": { "age_appropriate": true, "notes": "...", "concerns": [] },`,
    `  "warnings": ["anything the teacher should review"] }`,
    `Rules:`,
    `- Plan ONLY the characters the script actually contains.`,
    `- ONE clear readable action per scene. Gentle camera only — no whip pans, no fast cuts.`,
    `- scene_count must fit the target duration: roughly ${Math.max(1, Math.round((Number(p.duration_seconds) || 60) / 6))} scenes.`,
    `- Alphabet / counting content: the letterform or the count must be exact.`,
    `- The narration must cover the supplied script or lyrics in order — do not skip a line.`,
    `- Never include frightening, violent or adult content in a children's video.`,
    `- Keep the JSON COMPACT: at most 4 characters, 10 scenes, one line per text field, no commentary.`,
    `Respond with JSON ONLY.`,
  ];
  return lines.filter((l) => l !== null).join("\n");
}

// ---------------------------------------------------------------------------
// 3. Song and Lyrics Studio — deterministic lyrics segmentation
// ---------------------------------------------------------------------------

export const KIDS_LYRIC_LABELS = ["intro", "verse", "chorus", "bridge", "instrumental", "outro"];

const LABEL_ALIASES = {
  intro: "intro", introduction: "intro", prelude: "intro", opening: "intro",
  verse: "verse", "v1": "verse", "v2": "verse", "v3": "verse", part: "verse",
  chorus: "chorus", refrain: "chorus", hook: "chorus", "pre-chorus": "chorus", "post-chorus": "chorus",
  bridge: "bridge", interlude: "instrumental", instrumental: "instrumental", music: "instrumental",
  solo: "instrumental", break: "instrumental",
  outro: "outro", ending: "outro", finale: "outro", coda: "outro",
};

const normLabel = (raw) => {
  const s = str(raw).toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim();
  if (!s) return "";
  if (LABEL_ALIASES[s]) return LABEL_ALIASES[s];
  const stripped = s.replace(/\s*\d+\s*$/, "").trim();
  if (stripped && LABEL_ALIASES[stripped]) return LABEL_ALIASES[stripped];
  if (/^(?:part|scene|section)\s*\d+$/.test(s)) return "verse";
  return LABEL_ALIASES[s.replace(/[\s-]+/g, "")] || "";
};

/**
 * Segment a lyric sheet into labelled sections. Deterministic and offline:
 * explicit markers win, otherwise the stanzas are used and a repeated stanza
 * is detected as the chorus.
 */
export function segmentLyrics(text = "") {
  const src = str(text).replace(/\r\n/g, "\n");
  const lines = src.split("\n");
  const blocks = [];
  let current = null;
  const push = () => {
    if (current && current.lines.length) blocks.push(current);
    current = null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    const marker = line.match(/^\s*[\[\(]?\s*([A-Za-z0-9][A-Za-z0-9\s-]{0,24}?)\s*[\]\)]?\s*[:\-–—]?\s*$/);
    const label = marker ? normLabel(marker[1]) : "";
    if (marker && label) {
      push();
      current = { label, lines: [] };
      continue;
    }
    if (!line) { push(); continue; }
    if (!current) current = { label: "", lines: [] };
    current.lines.push(line);
  }
  push();
  if (!blocks.length) return [];
  // A repeated stanza is the chorus (the label is a guess — the caller must
  // report it as estimated).
  const counts = new Map();
  for (const b of blocks) {
    const key = b.lines.join("\n").toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const sections = blocks.map((b, i) => {
    const key = b.lines.join("\n").toLowerCase();
    const repeated = counts.get(key) > 1;
    const label = b.label || (repeated ? "chorus" : "verse");
    return {
      index: i + 1,
      label,
      lines: b.lines.slice(0, 40),
      text: b.lines.join("\n"),
      character_count: b.lines.join("\n").length,
      estimated: true,
      repeated,
    };
  });
  return sections;
}

/** Normalize an LLM lyric-section answer into the canonical shape. */
export function normalizeLyricSections(raw = [], { totalDuration = 0 } = {}) {
  const list = arr(raw).map((s, i) => {
    const x = s && typeof s === "object" ? s : {};
    const label = normLabel(x.label) || "verse";
    const lines = arr(x.lines).map((l) => str(l).trim()).filter(Boolean).slice(0, 40);
    const text = str(x.text).trim() || lines.join("\n");
    return {
      index: i + 1,
      label: KIDS_LYRIC_LABELS.includes(label) ? label : "verse",
      lines: lines.length ? lines : (text ? text.split("\n").filter(Boolean).slice(0, 40) : []),
      text,
      start_seconds: clampNum(x.start_seconds, 0, 86400, null),
      end_seconds: clampNum(x.end_seconds, 0, 86400, null),
      emotion: str(x.emotion).trim().slice(0, 120),
      character_ids: strList(x.characters || x.character_ids, 12, 120),
      choreography: str(x.choreography || x.action).trim().slice(0, 800),
      lip_sync: x.lip_sync === true,
      estimated: x.estimated === true,
    };
  });
  // Fill the timing from the character counts when the model did not give it.
  const totalChars = list.reduce((a, s) => a + (s.text.length || 0), 0);
  let cursor = 0;
  const duration = Number(totalDuration) || 0;
  for (const s of list) {
    if (s.start_seconds == null || s.end_seconds == null) {
      const share = totalChars > 0 ? s.text.length / totalChars : 1 / Math.max(1, list.length);
      s.start_seconds = round(cursor);
      s.end_seconds = round(cursor + share * duration);
      s.estimated = true;
    }
    cursor = Math.max(cursor, Number(s.end_seconds) || cursor);
  }
  return list;
}

/** The Song Studio prompt (structure + choreography + timing recommendations). */
export function buildKidsSongPrompt(project = {}, { lyrics = "", measured = null } = {}) {
  const p = project && typeof project === "object" ? project : {};
  const lines = [
    `TITLE: ${str(p.title)}`,
    `LANGUAGE: ${str(p.language)}`,
    `CATEGORY: ${str(p.category)}`,
    `TARGET AGE GROUP: ${str(p.age_group)}`,
    `TARGET DURATION: ~${Math.round(Number(p.duration_seconds) || 60)} seconds`,
    measured ? `MEASURED AUDIO FACTS (use as facts, never invent more): ${JSON.stringify(measured)}` : null,
    ``,
    `LYRICS:`,
    str(lyrics) || str(p.lyrics) || "(none supplied)",
    ``,
    `TASK — analyse the song as JSON with exactly these keys:`,
    `{ "mood": "...", "structure": "verse-chorus | call-and-response | story | ...",`,
    `  "tempo": "slow|medium|fast", "educational_focus": "...", "visual_style": "...",`,
    `  "sections": [{ "label": "intro|verse|chorus|bridge|instrumental|outro", "lines": ["..."],`,
    `                "start_seconds": 0, "end_seconds": 0, "emotion": "...",`,
    `                "characters": ["character_id"], "choreography": "the action/dance for this part",`,
    `                "lip_sync": true }],`,
    `  "warnings": ["anything the teacher should review"] }`,
    `Rules:`,
    `- Use the measured section boundaries when they exist; mark the rest as approximate.`,
    `- Do not invent words that are not in the lyrics.`,
    `- Choreography must be simple, repeatable and readable by a small child.`,
    `Respond with JSON ONLY.`,
  ];
  return lines.filter((l) => l !== null).join("\n");
}

// ---------------------------------------------------------------------------
// 4. Audio analysis — the structured timeline of the source audio
// ---------------------------------------------------------------------------

export const KIDS_AUDIO_TYPES = ["music", "narration", "dialogue", "singing", "silence", "sound_effect"];

/** Normalize one analyzed audio segment. */
export function normalizeAudioSegment(raw = {}, { index = 0, duration = 0 } = {}) {
  const o = raw && typeof raw === "object" ? raw : {};
  const start = clampNum(o.start_seconds ?? o.start, 0, 86400, 0);
  const end = clampNum(o.end_seconds ?? o.end, 0, 86400, start);
  const type = str(o.type || o.audio_type).trim().toLowerCase();
  return {
    index: index + 1,
    start_seconds: round(start),
    end_seconds: round(end, 3),
    duration_seconds: round(Math.max(0, end - start), 3),
    type: KIDS_AUDIO_TYPES.includes(type) ? type : "music",
    speaker: str(o.speaker).trim().slice(0, 120),
    text: str(o.text || o.transcript || o.lyrics).trim().slice(0, 4000),
    emotion: str(o.emotion).trim().slice(0, 120),
    character: str(o.character).trim().slice(0, 120),
    action: str(o.action).trim().slice(0, 1000),
    scene: str(o.scene).trim().slice(0, 200),
    background: str(o.background).trim().slice(0, 200),
    camera: str(o.camera).trim().slice(0, 200),
    music_note: str(o.music_note || o.music).trim().slice(0, 400),
    sound_effect: str(o.sound_effect).trim().slice(0, 400),
    confidence: clampNum(o.confidence, 0, 1, null),
    estimated: o.estimated === true,
  };
}

/**
 * Build the audio timeline rows from the measured segments. Gaps between
 * segments are NOT invented — they are labelled as silence so the timeline
 * stays gapless and honest.
 */
export function buildKidsAudioTimeline(segments = [], { duration = 0 } = {}) {
  const total = Math.max(Number(duration) || 0, 0);
  const rows = arr(segments)
    .map((s, i) => normalizeAudioSegment(s, { index: i, duration: total }))
    .filter((s) => s.duration_seconds > 0)
    .sort((a, b) => a.start_seconds - b.start_seconds);
  if (!rows.length) return [];
  const out = [];
  let cursor = 0;
  for (const row of rows) {
    if (row.start_seconds > cursor + 0.01) {
      out.push(normalizeAudioSegment({
        start_seconds: cursor, end_seconds: row.start_seconds, type: "silence", estimated: true,
      }, { index: out.length }));
    }
    out.push({ ...row, index: out.length + 1 });
    cursor = Math.max(cursor, row.end_seconds);
  }
  if (total > cursor + 0.01) {
    out.push(normalizeAudioSegment({
      start_seconds: cursor, end_seconds: total, type: "silence", estimated: true,
    }, { index: out.length }));
  }
  return out.map((r, i) => ({ ...r, index: i + 1 }));
}

// ---------------------------------------------------------------------------
// 5. Storyboard and scene timeline
// ---------------------------------------------------------------------------

/**
 * Build the scene timeline. When the audio analysis produced segments the
 * scene boundaries follow the MEASURED segments (timing: "measured");
 * otherwise the scene durations are used (timing: "estimated").
 */
export function buildKidsTimeline({
  scenes = [],
  segments = [],
  duration = 0,
  characters = [],
  locations = [],
  props = [],
} = {}) {
  const list = arr(scenes).map((s, i) => {
    const x = s && typeof s === "object" ? s : {};
    return {
      scene_number: clampInt(x.scene_number, 1, 999, i + 1),
      title: str(x.title).trim().slice(0, 200),
      start_seconds: clampNum(x.start_seconds, 0, 86400, null),
      end_seconds: clampNum(x.end_seconds, 0, 86400, null),
      duration_seconds: clampNum(x.duration_seconds, 0, 3600, 0),
      audio_type: str(x.audio_type).trim().slice(0, 40),
      text: str(x.text || x.narration || x.lyrics).trim().slice(0, 4000),
      characters: strList(x.characters, 16, 120),
      location: str(x.location).trim().slice(0, 200),
      props: strList(x.props || x.objects, 24, 120),
      action: str(x.action).trim().slice(0, 2000),
      emotion: str(x.emotion).trim().slice(0, 200),
      // The dialogue lines of the scene — the audio that gets voiced.
      dialogue: arr(x.dialogue).map((d) => (typeof d === "string" ? d : str(d?.line))).filter(Boolean).slice(0, 12),
      camera_shot: str(x.camera_shot || x.shot_type).trim().slice(0, 80),
      camera_movement: str(x.camera_movement || x.movement).trim().slice(0, 80),
      lighting: str(x.lighting).trim().slice(0, 200),
      image_prompt: str(x.image_prompt).trim().slice(0, 4000),
      video_prompt: str(x.video_prompt).trim().slice(0, 4000),
      negative_prompt: str(x.negative_prompt).trim().slice(0, 2000),
      reference_assets: strList(x.reference_assets, 24, 200),
      generation_status: str(x.generation_status || x.status).trim().slice(0, 40) || "planned",
      approval: str(x.approval).trim().slice(0, 40) || "pending",
    };
  });
  const segs = arr(segments).filter((s) => Number(s?.end_seconds) > Number(s?.start_seconds));
  if (segs.length && list.length) {
    // Pair the scenes with the measured segments by position (the audio is the
    // clock). A scene that has no segment keeps its own duration.
    let cursor = 0;
    list.forEach((scene, i) => {
      const seg = segs[i] || null;
      if (seg) {
        scene.start_seconds = round(Number(seg.start_seconds));
        scene.end_seconds = round(Number(seg.end_seconds));
        scene.duration_seconds = round(Number(seg.end_seconds) - Number(seg.start_seconds), 3);
        scene.timing = "measured";
        if (!scene.text && seg.text) scene.text = str(seg.text).slice(0, 4000);
        if (!scene.audio_type && seg.type) scene.audio_type = str(seg.type);
      } else {
        const d = scene.duration_seconds > 0 ? scene.duration_seconds : 5;
        scene.start_seconds = round(cursor);
        scene.end_seconds = round(cursor + d);
        scene.duration_seconds = round(d, 3);
        scene.timing = "estimated";
      }
      cursor = scene.end_seconds;
    });
  } else {
    let cursor = 0;
    for (const scene of list) {
      const d = scene.duration_seconds > 0 ? scene.duration_seconds : 5;
      scene.start_seconds = round(cursor);
      scene.end_seconds = round(cursor + d);
      scene.duration_seconds = round(d, 3);
      scene.timing = "estimated";
      cursor = scene.end_seconds;
    }
  }
  // Resolve the library references (ids only — the names are looked up by the
  // caller so a scene never carries a stale free-text name).
  const charIds = new Set(arr(characters).map((c) => str(c?.character_id || c?.id)));
  const locIds = new Set(arr(locations).map((l) => str(l?.asset_key || l?.id)));
  const propIds = new Set(arr(props).map((p) => str(p?.asset_key || p?.id)));
  for (const scene of list) {
    scene.character_refs = scene.characters.filter((c) => charIds.has(c));
    scene.location_ref = locIds.has(scene.location) ? scene.location : "";
    scene.prop_refs = scene.props.filter((p) => propIds.has(p));
  }
  return list;
}

/** Validate a timeline (gaps, overlaps, empty prompts). */
export function validateKidsTimeline(timeline = [], { duration = 0 } = {}) {
  const rows = arr(timeline);
  const errors = [];
  const warnings = [];
  if (!rows.length) {
    errors.push("the timeline has no scenes");
    return { errors, warnings };
  }
  let cursor = null;
  for (const [i, row] of rows.entries()) {
    const start = Number(row.start_seconds);
    const end = Number(row.end_seconds);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      errors.push(`scene ${i + 1} has invalid timing`);
      continue;
    }
    if (cursor != null && Math.abs(start - cursor) > 0.05) {
      warnings.push(`scene ${i + 1} does not start where scene ${i} ended (${round(start, 3)}s vs ${round(cursor, 3)}s)`);
    }
    cursor = end;
    if (!row.image_prompt) warnings.push(`scene ${row.scene_number ?? i + 1} has no image prompt`);
  }
  const total = Number(duration) || 0;
  if (total > 0 && cursor != null && Math.abs(cursor - total) > 0.5) {
    warnings.push(`the timeline ends at ${round(cursor, 3)}s but the audio is ${round(total, 3)}s long`);
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// 6. The reusable asset library (characters, locations, props)
// ---------------------------------------------------------------------------

export const KIDS_LIBRARY_KINDS = ["character", "location", "prop"];

// ---------------------------------------------------------------------------
// The kids voice map — every kids character keeps ONE voice across the scenes.
//
// The voice ids are the EXISTING licensed Edge-TTS voices (lib/tts.mjs): no
// voice is ever cloned and a real child's voice is never used. A character
// whose library row carries an explicit voice id keeps it verbatim.
// ---------------------------------------------------------------------------
export const KIDS_VOICE_IDS = {
  hindi_female: "hi-IN-SwaraNeural",
  hindi_male: "hi-IN-MadhurNeural",
  english_female: "en-IN-NeerjaNeural",
  english_male: "en-IN-PrabhatNeural",
};

// The kids archetypes: a boy must not be voiced by the default female voice.
const KIDS_MALE = /bachcho|bachcha|beta|boy|chhota|larka|man\b|son|munna|raju|arjun|bal\b|mohan|karan|ravi|shyam|amit|raj\b|kumar|sher|lion|tiger|bagh|bhalu|hathi|elephant|king|raja|father|dad/i;
const KIDS_FEMALE = /gudi|chhoti|beti|girl|ladki|priya|meera|neha|rani|princess|mother|mom|maa|sita|girl|bunny|rabbit|mouse|chiku|minku|bird|parrot|kedi|billi|kutta|puppy|cat\b/i;
const KIDS_NEUTRAL = /teacher|teacher|teacher|dadi|nani|uncle|aunty|doctor|nurse|panda|koala|frog|mouse|donkey|horse|ghoda|duck|geese/i;

/** True when the text already is a TTS voice id (used as-is). */
export const isTtsVoiceId = (text) => /Neural$/i.test(String(text || "").trim());

/**
 * The voice for one kids character. Returns a TTS voice id — never a clone
 * and never a real child's voice.
 */
export function kidsVoiceForCharacter(name, language = "Hindi") {
  const key = String(name || "").trim();
  const english = /^(en|english)(?:[-_]|$)/i.test(String(language || ""));
  const female = english ? KIDS_VOICE_IDS.english_female : KIDS_VOICE_IDS.hindi_female;
  const male = english ? KIDS_VOICE_IDS.english_male : KIDS_VOICE_IDS.hindi_male;
  if (!key) return female;
  if (KIDS_MALE.test(key)) return male;
  if (KIDS_FEMALE.test(key)) return female;
  if (KIDS_NEUTRAL.test(key)) return female;
  return female;
}

/**
 * Build the per-cast voice map for a kids storyboard from the library rows.
 * An explicit voice id in the library wins; a voice the user already mapped
 * on the board is never overwritten.
 */
export function buildKidsVoiceMap(characters = [], { language = "Hindi", existing = {} } = {}) {
  const out = {};
  const current = existing && typeof existing === "object" ? existing : {};
  for (const c of arr(characters)) {
    const x = c && typeof c === "object" ? c : {};
    const name = str(x.name).trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (current[key]) continue; // the user's own mapping wins
    const explicit = str(x.voice).trim();
    out[key] = isTtsVoiceId(explicit) ? explicit : kidsVoiceForCharacter(name, language);
  }
  return out;
}

export const KIDS_LIBRARY_STATUSES = ["draft", "review", "approved", "archived"];

/** Suggested categories (the library is user-editable — these are seeds). */
export const KIDS_LIBRARY_CATEGORIES = {
  character: ["Child", "Parent", "Teacher", "Animal", "Bird", "Fantasy Creature", "Educational Mascot"],
  location: [
    "Home and Bedroom", "School and Classroom", "Playground", "Garden and Farm", "Forest and Jungle",
    "Beach and Underwater", "Space and Fantasy", "Market and Neighborhood",
  ],
  prop: [
    "Educational Toys", "Books and School Supplies", "Musical Instruments", "Fruits and Vegetables",
    "Vehicles", "Sports Equipment", "Household Objects", "Counting and Shape Objects",
  ],
};

/** Normalize a library asset (character / location / prop). */
export function normalizeKidsLibraryAsset(raw = {}, { kind = "character" } = {}) {
  const o = raw && typeof raw === "object" ? raw : {};
  const k = KIDS_LIBRARY_KINDS.includes(o.kind) ? o.kind : kind;
  const name = str(o.name).trim().slice(0, 160);
  return {
    kind: k,
    asset_key: slugKey(o.asset_key || name, `${k}_asset`).slice(0, 80),
    name,
    category: str(o.category).trim().slice(0, 120),
    description: str(o.description).trim().slice(0, 4000),
    tags: strList(o.tags, 24, 60),
    // The APPROVED visual prompt — the only text handed to the image model.
    prompt: str(o.prompt || o.visual_identity_prompt).trim().slice(0, 4000),
    reference_image: str(o.reference_image).trim().slice(0, 400),
    // Character-specific fields (kept for every kind so one table serves all).
    appearance: str(o.appearance).trim().slice(0, 2000),
    clothing: str(o.clothing).trim().slice(0, 1000),
    colors: str(o.colors).trim().slice(0, 500),
    personality: str(o.personality).trim().slice(0, 1000),
    voice: str(o.voice || o.voice_description).trim().slice(0, 600),
    movement: str(o.movement || o.animation_style).trim().slice(0, 600),
    age_appearance: str(o.age_appearance || o.age_group).trim().slice(0, 200),
    version: clampInt(o.version, 1, 999, 1),
    status: KIDS_LIBRARY_STATUSES.includes(str(o.status)) ? str(o.status) : "draft",
    locked: o.locked === true,
    metadata: o.metadata && typeof o.metadata === "object" ? o.metadata : {},
  };
}

/**
 * Compose the image prompt for a scene from the CANONICAL library assets.
 * A character keeps its approved look in every scene — the prompt is built
 * from the library row, never from a per-scene free-text description.
 */
export function buildKidsScenePrompt({
  scene = {},
  characters = [],
  locations = [],
  props = [],
  style = "",
  negative = "",
} = {}) {
  const s = scene && typeof scene === "object" ? scene : {};
  const charMap = new Map(arr(characters).map((c) => [str(c?.character_id || c?.asset_key), c]));
  const locMap = new Map(arr(locations).map((l) => [str(l?.asset_key || l?.id), l]));
  const propMap = new Map(arr(props).map((p) => [str(p?.asset_key || p?.id), p]));
  const parts = [];
  const usedCharacters = [];
  for (const id of arr(s.characters)) {
    const c = charMap.get(str(id));
    if (!c) continue;
    usedCharacters.push(str(c.name || c.character_id));
    const look = str(c.prompt || c.appearance || c.description).trim();
    if (look) parts.push(`${str(c.name || c.character_id)}: ${look}`);
  }
  const location = locMap.get(str(s.location));
  if (location) {
    const look = str(location.prompt || location.description).trim();
    if (look) parts.push(`Location: ${look}`);
  }
  for (const id of arr(s.props)) {
    const p = propMap.get(str(id));
    if (!p) continue;
    const look = str(p.prompt || p.description).trim();
    if (look) parts.push(`${str(p.name || p.asset_key)}: ${look}`);
  }
  if (str(s.action).trim()) parts.push(`Action: ${str(s.action).trim()}`);
  if (str(s.emotion).trim()) parts.push(`Mood: ${str(s.emotion).trim()}`);
  if (str(s.camera_shot).trim()) parts.push(`Shot: ${str(s.camera_shot).trim()}`);
  if (str(s.lighting).trim()) parts.push(`Lighting: ${str(s.lighting).trim()}`);
  if (str(style).trim()) parts.push(`Style: ${str(style).trim()}`);
  const explicit = str(s.image_prompt).trim();
  const prompt = explicit || parts.join(", ");
  return {
    prompt,
    negative: str(negative).trim() || str(s.negative_prompt).trim(),
    characters_used: usedCharacters,
    used_canonical_assets: Boolean(location || usedCharacters.length || parts.length),
  };
}

// ---------------------------------------------------------------------------
// 7. Quality control for children's content
// ---------------------------------------------------------------------------

export const KIDS_QC_SEVERITIES = ["error", "warning", "info"];

const finding = (id, severity, message, suggestion) => ({ id, severity, message, suggestion });

/**
 * Run the children's-content quality checks. Every check reports what it
 * looked at — a check that could not run says so instead of passing.
 */
export function runKidsQualityChecks({
  project = {},
  story = {},
  timeline = [],
  assets = [],
  segments = [],
  library = {},
  media = {},
} = {}) {
  const p = project && typeof project === "object" ? project : {};
  const s = normalizeKidsStory(story);
  const rows = arr(timeline);
  const checks = [];
  const A = arr(assets);

  // --- age appropriateness --------------------------------------------------
  // The Director's keyword content scanner was removed (it can false-positive
  // and is not a safety guarantee) — the QC reports honestly that NO automatic
  // content check ran and a human teacher review is required.
  checks.push(finding("age_appropriate", "info",
    "no automatic content scan ran — a teacher must review every line before the video is exported"));

  // --- educational accuracy (structure only — never a correctness claim) ---
  if (!s.learning_objective) {
    checks.push(finding("educational_accuracy", "warning", "no learning objective was set",
      "add one objective (one idea) the video teaches"));
  } else if (!rows.length) {
    checks.push(finding("educational_accuracy", "warning", "the learning objective has no scene to land in",
      "build the scene breakdown"));
  } else {
    checks.push(finding("educational_accuracy", "info",
      `the objective is stated and ${rows.length} scene(s) exist — the CONTENT is not machine-verified`,
      "a teacher checks the teaching claim before export"));
  }

  // --- character consistency ---------------------------------------------
  const libChars = arr(library?.characters);
  const known = new Set(libChars.map((c) => str(c?.character_id || c?.asset_key)));
  const used = new Set(rows.flatMap((r) => arr(r.characters)));
  const unknown = [...used].filter((c) => known.size && !known.has(c));
  if (unknown.length) {
    checks.push(finding("character_consistency", "error",
      `${unknown.length} scene character(s) are not in the library: ${unknown.slice(0, 6).join(", ")}`,
      "add them to the character library so every scene uses the canonical look"));
  } else if (known.size) {
    checks.push(finding("character_consistency", "info",
      `every scene character resolves to a library entry (${known.size} in the library)`,
      "approve a canonical reference image for each character"));
  } else {
    checks.push(finding("character_consistency", "warning", "the character library is empty",
      "create the characters so their look never drifts between scenes"));
  }

  // --- lyrics / narration coverage ---------------------------------------
  const lyricText = str(p.lyrics).trim();
  if (lyricText) {
    const storyText = [s.beginning, s.middle, s.ending, ...s.narration.map((n) => n.text),
      ...rows.map((r) => r.text)].join("\n").toLowerCase();
    const lines = lyricText.split("\n").map((l) => l.trim()).filter((l) => l.length > 3);
    const missing = lines.filter((l) => !storyText.includes(l.toLowerCase().slice(0, 40)));
    if (missing.length) {
      checks.push(finding("lyrics_coverage", "warning",
        `${missing.length} lyric line(s) do not appear in the story or timeline`,
        `first missing: "${str(missing[0]).slice(0, 80)}"`));
    } else {
      checks.push(finding("lyrics_coverage", "info", "every lyric line is covered by the story/timeline", ""));
    }
  }

  // --- audio level --------------------------------------------------------
  const peak = Number(media?.peak_volume_db);
  if (Number.isFinite(peak) && peak > -1) {
    checks.push(finding("audio_clipping", "warning",
      `the master audio peaks at ${peak} dBFS — it may clip`,
      "lower the narration/music mix by 2-3 dB before export"));
  } else if (Number.isFinite(peak)) {
    checks.push(finding("audio_clipping", "info", `the master audio peaks at ${peak} dBFS`, ""));
  } else {
    checks.push(finding("audio_clipping", "info", "no measured audio level is available", "run the audio analysis stage"));
  }

  // --- missing scenes / assets -------------------------------------------
  if (rows.length) {
    const missingImage = rows.filter((r) => !A.some((a) => str(a?.kind) === "image" && Number(a?.scene_number) === Number(r.scene_number)));
    if (missingImage.length) {
      checks.push(finding("missing_assets", "warning",
        `${missingImage.length} scene(s) have no generated image`,
        "generate the missing keyframes"));
    }
  }
  const expected = Math.max(1, rows.length);
  const clips = A.filter((a) => str(a?.kind) === "clip" || str(a?.kind) === "video");
  if (rows.length && clips.length && clips.length < expected) {
    checks.push(finding("missing_assets", "warning",
      `${clips.length} clip(s) for ${expected} scene(s)`,
      "generate the missing clips"));
  }
  if (!A.length) {
    checks.push(finding("missing_assets", "info", "no generated assets are linked to this project yet", ""));
  }

  // --- audio / video duration mismatch ------------------------------------
  const audioDuration = Number(media?.audio_duration_seconds) || 0;
  if (audioDuration > 0 && rows.length) {
    const timelineEnd = Math.max(...rows.map((r) => Number(r.end_seconds) || 0));
    if (Math.abs(timelineEnd - audioDuration) > 0.75) {
      checks.push(finding("duration_mismatch", "warning",
        `the timeline ends at ${round(timelineEnd, 2)}s but the audio is ${round(audioDuration, 2)}s`,
        "re-sync the timeline to the audio before exporting"));
    }
  }

  // --- black frames / corrupted clips -------------------------------------
  const blackFrames = arr(media?.black_frames);
  if (blackFrames.length) {
    checks.push(finding("black_frames", "error",
      `${blackFrames.length} clip(s) contain black frames: ${blackFrames.slice(0, 4).join(", ")}`,
      "regenerate those clips"));
  } else if (media?.probed) {
    checks.push(finding("black_frames", "info", "every probed clip decoded and none was fully black", ""));
  }

  // --- subtitles ----------------------------------------------------------
  if (media?.subtitles_supported === false) {
    checks.push(finding("subtitles", "info", "this build has no subtitle renderer configured", "add an SRT in the editing stage"));
  } else if (arr(media?.subtitle_cues).length) {
    const cues = arr(media.subtitle_cues);
    const bad = cues.filter((c) => Number(c?.start) >= Number(c?.end));
    checks.push(finding("subtitles", bad.length ? "warning" : "info",
      bad.length ? `${bad.length} subtitle cue(s) end before they start` : `${cues.length} subtitle cue(s) are timed`,
      "fix the cue times"));
  }

  // --- export settings ----------------------------------------------------
  const res = str(p.resolution).trim();
  const aspect = str(p.aspect_ratio).trim();
  const expectedAspect = aspect === "9:16" ? "1080x1920" : aspect === "1:1" ? "1080x1080" : "1920x1080";
  if (res && aspect) {
    const [w, h] = res.split("x").map(Number);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      const target = expectedAspect.split("x").map(Number);
      const current = w / h;
      const wanted = target[0] / target[1];
      if (Math.abs(current - wanted) > 0.08) {
        checks.push(finding("export_settings", "warning",
          `the resolution ${res} does not match the ${aspect} aspect ratio`,
          `use ${expectedAspect} for a ${aspect} export`));
      } else {
        checks.push(finding("export_settings", "info", `the resolution ${res} matches the ${aspect} aspect ratio`, ""));
      }
    }
  }

  const summary = {
    errors: checks.filter((c) => c.severity === "error").length,
    warnings: checks.filter((c) => c.severity === "warning").length,
    infos: checks.filter((c) => c.severity === "info").length,
  };
  summary.passed = summary.errors === 0;
  return { checks, summary, reviewed_by_human: false };
}

// ---------------------------------------------------------------------------
// 8. Feedback / learning records
// ---------------------------------------------------------------------------

export const KIDS_FEEDBACK_TARGETS = ["story", "plan", "prompt", "image", "scene", "narration", "video", "final"];
export const KIDS_FEEDBACK_VERDICTS = ["approve", "reject", "edit"];

/** Normalize a feedback record. A training example needs an explicit flag. */
export function normalizeKidsFeedback(raw = {}) {
  const o = raw && typeof raw === "object" ? raw : {};
  const target = str(o.target_kind).trim().toLowerCase();
  const verdict = str(o.verdict).trim().toLowerCase();
  const errors = [];
  if (!KIDS_FEEDBACK_TARGETS.includes(target)) errors.push(`unknown feedback target "${target}"`);
  if (!KIDS_FEEDBACK_VERDICTS.includes(verdict)) errors.push(`unknown verdict "${verdict}"`);
  const rating = Number(o.rating);
  const useForTraining = o.use_for_training === true && verdict === "approve";
  if (o.use_for_training === true && verdict !== "approve") {
    errors.push("only an APPROVED output may be stored as a training example");
  }
  return {
    id: str(o.id).trim().slice(0, 120),
    target_kind: target,
    target_id: str(o.target_id).trim().slice(0, 200),
    rating: Number.isFinite(rating) ? Math.min(5, Math.max(1, Math.round(rating))) : null,
    verdict,
    note: str(o.note).trim().slice(0, 2000),
    corrected_text: str(o.corrected_text).trim().slice(0, 8000),
    use_for_training: useForTraining,
    payload: o.payload && typeof o.payload === "object" ? o.payload : {},
    errors,
  };
}

/** Retrieval helper: the approved training examples for a kind. */
export function kidsTrainingExamples(feedback = [], { target_kind = "", limit = 50 } = {}) {
  return arr(feedback)
    .filter((f) => f && f.use_for_training === true)
    .filter((f) => !target_kind || str(f.target_kind) === target_kind)
    .slice(0, limit);
}
