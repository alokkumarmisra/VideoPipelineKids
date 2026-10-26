// Sanskriti Kids Studio — API client.
// Every call hits the dedicated /api/kids/* family, which is backed by the
// `Sanskriti_kids` Postgres database (SQLite fallback). The studio is a
// project layer over the shared Director pipeline — it never renders on its
// own, so there is no generation endpoint here: images, videos, dialogue and
// the final cut all run through the existing workspace / Director engines.

const get = async <T,>(url: string): Promise<T> => {
  const r = await fetch(url);
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(d?.error || `request failed (HTTP ${r.status})`);
  return d as T;
};

const send = async <T,>(url: string, method: string, body?: unknown): Promise<T> => {
  const r = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(d?.error || `request failed (HTTP ${r.status})`);
  return d as T;
};

// ---------------------------------------------------------------- options
// The configurable option lists (age groups, categories, languages,
// platforms, resolutions, visual styles). The server owns them — the UI
// never hardcodes a list.
export type KidsOptionKey =
  | "age_groups" | "categories" | "languages" | "platforms" | "resolutions" | "visual_styles";

export interface KidsOptions {
  age_groups: string[];
  categories: string[];
  languages: string[];
  platforms: string[];
  resolutions: string[];
  visual_styles: string[];
}

export const kidsOptions = () => get<KidsOptions>("/api/kids/options");

export const kidsSaveOptions = (key: KidsOptionKey, values: string[]) =>
  send<KidsOptions>("/api/kids/options", "PUT", { key, values });

// ---------------------------------------------------------------- health
export interface KidsHealth {
  db: { up: boolean; store: string | null; database: string };
  comfy: { up: boolean; error: string | null };
}

export const kidsHealth = () => get<KidsHealth>("/api/kids/health");

// ---------------------------------------------------------------- dashboard
export interface KidsMetrics {
  totalProjects: number;
  draftStories: number;
  characters: number;
  charactersWithProfile: number;
  scenes: number;
  imagesGenerated: number;
  videosGenerated: number;
  completedVideos: number;
  inProgress: number;
  completedProjects: number;
  failedOrPendingJobs: number;
  failedJobs: number;
  totalJobs: number;
}

export interface KidsRecentProject {
  id: string;
  name: string;
  title: string;
  status: string;
  category: string;
  age_group: string;
  language: string;
  duration_seconds: number;
  board_id: string | null;
  scenario_name: string | null;
  updated_at: string | null;
  created_at: string | null;
}

export interface KidsDashboardPayload {
  metrics: KidsMetrics;
  recent: KidsRecentProject[];
  store: string;
}

export const kidsDashboard = () => get<KidsDashboardPayload>("/api/kids/dashboard");

// ---------------------------------------------------------------- projects
export interface KidsProject {
  id: string;
  name: string;
  title: string;
  description: string;
  language: string;
  category: string;
  age_group: string;
  duration_seconds: number;
  aspect_ratio: string;
  resolution: string;
  visual_style: string;
  narration_preferences: string;
  music_preferences: string;
  target_platform: string;
  lyrics: string;
  script: string;
  /** Uploaded narration / song audio handle (director/ file). */
  audio_path: string;
  /** Reference image ids from the shared resource library. */
  reference_images: string[];
  status: string;
  board_id: string | null;
  scenario_name: string | null;
  metadata: Record<string, unknown>;
  created_at: string | null;
  updated_at: string | null;
}

/** The Stage-1 project brief (the fields the user fills in). */
export interface KidsProjectDraft {
  title: string;
  description: string;
  language: string;
  category: string;
  age_group: string;
  duration_seconds: number;
  aspect_ratio: string;
  resolution: string;
  visual_style: string;
  narration_preferences: string;
  music_preferences: string;
  target_platform: string;
  lyrics: string;
  script: string;
  /** Uploaded narration / song audio handle (director/ file). */
  audio_path?: string;
  /** The measured duration of the uploaded audio (seconds). */
  audio_duration_seconds?: number;
  /** Reference image ids from the shared resource library. */
  reference_images?: string[];
}

export interface KidsProjectInput extends Partial<KidsProjectDraft> {
  /** Explicitly unlock an approved plan so it can be edited again. */
  unlock?: boolean;
  /** Reset the Director Plan because the brief changed. */
  reset_plan?: boolean;
  board_id?: string | null;
  scenario_name?: string | null;
}

export const kidsProjects = () => get<KidsProject[]>("/api/kids/projects");

export const kidsCreateProject = (draft: Partial<KidsProjectDraft>) =>
  send<{ project: KidsProject; warnings: string[] }>("/api/kids/projects", "POST", draft);

export interface KidsScene {
  id: number;
  project_id: string;
  scene_number: number;
  title: string;
  synopsis: string;
  duration_seconds: number;
  camera: string;
  transition: string;
  prompt: string;
  status: string;
}

export interface KidsCharacter {
  id: number;
  project_id: string;
  character_id: string;
  name: string;
  role: string;
  species: string;
  description: string;
  visual_identity_prompt: string;
}

export interface KidsAsset {
  id: number;
  project_id: string;
  kind: string;
  scene_number: number | null;
  file_path: string;
  prompt: string;
  status: string;
}

export interface KidsJob {
  id: string;
  project_id: string | null;
  kind: string;
  status: string;
  error_message: string | null;
  metadata: Record<string, unknown>;
  created_at: string | null;
  updated_at: string | null;
}

// ---------------------------------------------------------------- plan
export interface KidsPlanCharacter {
  character_id: string;
  name: string;
  role: string;
  appearance: string;
  usage: string;
  visual_identity_prompt: string;
}

export interface KidsPlanScene {
  scene_number: number;
  title: string;
  synopsis: string;
  duration_seconds: number;
  shot_type: string;
  camera_movement: string;
  transition: string;
  characters: string[];
  prompt: string;
}

export interface KidsDirectorPlan {
  version: number;
  creative_direction: string;
  objective: {
    kind: string;
    teaching_objective: string;
    entertainment_objective: string;
  };
  narrative: { beginning: string; middle: string; climax: string; ending: string };
  visual_continuity: string;
  scene_count: number;
  approximate_duration_seconds: number;
  characters: KidsPlanCharacter[];
  scenes: KidsPlanScene[];
  camera: {
    shot_types: string[];
    movements: string[];
    transitions: string[];
    framing_notes: string;
  };
  audio: {
    background_music: string;
    ambience: string;
    sound_effects: string[];
    narration_notes: string;
  };
  age_appropriateness: {
    language_notes: string;
    visual_notes: string;
    pacing_notes: string;
  };
  consistency: {
    script_to_scene: string;
    character_continuity: string;
    scene_to_render: string;
  };
  warnings: string[];
}

export interface KidsPlan {
  id: number;
  project_id: string;
  version: number;
  status: "draft" | "approved";
  plan: KidsDirectorPlan;
  note: string;
  approved_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface KidsProjectDetail {
  project: KidsProject;
  plan: KidsPlan | null;
  planHistory: KidsPlan[];
  scenes: KidsScene[];
  characters: KidsCharacter[];
  assets: KidsAsset[];
  jobs: KidsJob[];
  /** The Story Studio document (a version, never an overwrite). */
  story: KidsStoryVersion | null;
  storyHistory: KidsStoryVersion[];
  /** The segmented lyric sheet. */
  lyricSections: KidsLyricSection[];
  /** The measured audio timeline. */
  audioSegments: KidsAudioSegment[];
  /** The editable scene timeline. */
  timeline: KidsTimelineRow[];
  /** The reusable asset library (project rows + shared rows). */
  library: { characters: KidsLibraryAsset[]; locations: KidsLibraryAsset[]; props: KidsLibraryAsset[] };
  feedback: KidsFeedback[];
  qcRuns: KidsQcRun[];
  exports: KidsExport[];
}

export const kidsProject = (id: string) =>
  get<KidsProjectDetail>(`/api/kids/projects/${encodeURIComponent(id)}`);

export const kidsUpdateProject = (id: string, patch: KidsProjectInput) =>
  send<{ project: KidsProject; warnings: string[]; errors: string[] }>(
    `/api/kids/projects/${encodeURIComponent(id)}`, "PUT", patch);

export const kidsDeleteProject = (id: string) =>
  send<{ ok: boolean }>(`/api/kids/projects/${encodeURIComponent(id)}`, "DELETE");

/** Ask the AI Director to write a fresh Director Plan for this project. */
export const kidsGeneratePlan = (id: string) =>
  send<{ plan: KidsPlan }>(`/api/kids/projects/${encodeURIComponent(id)}/plan`, "POST", {});

/** Save an edited plan as a new version (an approved plan needs unlock). */
export const kidsSavePlan = (id: string, plan: KidsDirectorPlan, opts: { unlock?: boolean; note?: string } = {}) =>
  send<{ plan: KidsPlan }>(`/api/kids/projects/${encodeURIComponent(id)}/plan`, "PUT", {
    plan, unlock: opts.unlock === true, note: opts.note || "",
  });

/** Approve the current plan — it locks against silent edits afterwards. */
export const kidsApprovePlan = (id: string) =>
  send<{ plan: KidsPlan }>(`/api/kids/projects/${encodeURIComponent(id)}/plan/approve`, "POST", {});

/**
 * Link the project to a Director storyboard and mirror its scenes +
 * characters into the studio. The Director owns the storyboard; the studio
 * only mirrors it so the plan and the storyboard never drift apart.
 */
export const kidsLinkBoard = (id: string, boardId: string) =>
  send<{ project: KidsProject; plan: KidsPlan; scenes: KidsScene[]; characters: KidsCharacter[] }>(
    `/api/kids/projects/${encodeURIComponent(id)}/board`, "PUT", { board_id: boardId });

/** Re-mirror the linked storyboard (after new scenes were planned). */
export const kidsSyncBoard = (id: string) =>
  send<{ project: KidsProject; plan: KidsPlan; scenes: KidsScene[]; characters: KidsCharacter[] }>(
    `/api/kids/projects/${encodeURIComponent(id)}/sync`, "POST", {});

// =====================================================================
// The production pipeline (16 stages)
// =====================================================================

export type KidsStageStatus = "done" | "ready" | "blocked";

export interface KidsStage {
  id: string;
  label: string;
  group: string;
  engine: string;
  input: string;
  description: string;
  deps: string[];
  advisory_deps: string[];
  status: KidsStageStatus;
  blocked_by: string[];
  advisory_pending: string[];
  available: boolean;
  output_count: number;
}

export interface KidsPipelineServices {
  llm: { up: boolean; model?: string; error?: string | null };
  comfyui: { up: boolean; error?: string | null };
  whisper: { up: boolean; note?: string };
  tts: { up: boolean; note?: string };
  lipsync: { up: boolean; note?: string };
  ffmpeg: { up: boolean };
}

export const kidsPipelineCatalog = () =>
  get<{ stages: KidsStage[]; services: KidsPipelineServices }>("/api/kids/pipeline");

export const kidsPipeline = (id: string) =>
  get<{ stages: KidsStage[]; runnable: string[] }>(
    `/api/kids/projects/${encodeURIComponent(id)}/pipeline`);

export interface KidsPipelineRunResult {
  stage: string;
  status: "completed" | "failed" | "blocked" | "delegated" | "unknown";
  message: string;
}

export const kidsRunPipeline = (id: string, stages: string[]) =>
  send<{ results: KidsPipelineRunResult[]; stages: KidsStage[]; runnable: string[] }>(
    `/api/kids/projects/${encodeURIComponent(id)}/pipeline`, "POST", { stages });

// =====================================================================
// Story Studio
// =====================================================================

export interface KidsStoryCharacter {
  character_id: string;
  name: string;
  role: string;
  category: string;
  appearance: string;
  clothing: string;
  colors: string;
  personality: string;
  voice: string;
  movement: string;
  supporting: boolean;
}

export interface KidsStoryScene {
  scene_number: number;
  title: string;
  description: string;
  duration_seconds: number;
  characters: string[];
  location: string;
  props: string[];
  action: string;
  emotion: string;
  camera_shot: string;
  camera_movement: string;
  lighting: string;
  image_prompt: string;
  video_prompt: string;
  negative_prompt: string;
  narration: string;
  dialogue: string[];
}

export interface KidsStory {
  version: number;
  title: string;
  description: string;
  age_group: string;
  learning_objective: string;
  beginning: string;
  middle: string;
  ending: string;
  characters: KidsStoryCharacter[];
  dialogue: { scene_number: number; speaker: string; line: string; emotion: string; delivery: string }[];
  narration: { scene_number: number; text: string; emotion: string; delivery: string }[];
  scenes: KidsStoryScene[];
  visual_continuity: string;
  backgrounds: string[];
  props: string[];
  music: string[];
  sound_effects: string[];
  safety: { age_appropriate: boolean; notes: string; concerns: string[] };
  warnings: string[];
}

export interface KidsStoryVersion {
  id: number;
  project_id: string;
  version: number;
  status: "draft" | "approved";
  story: KidsStory;
  note: string;
  approved_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export const kidsStory = (id: string) =>
  get<{ story: KidsStoryVersion | null; history: KidsStoryVersion[]; job?: KidsJob | null }>(
    `/api/kids/projects/${encodeURIComponent(id)}/story`);

export const kidsGenerateStory = (id: string, body: Record<string, unknown> = {}) =>
  send<{ job: { id: string; kind: string; status: string }; message: string }>(
    `/api/kids/projects/${encodeURIComponent(id)}/story`, "POST", body);

export const kidsSaveStory = (id: string, story: KidsStory, opts: { unlock?: boolean; note?: string } = {}) =>
  send<{ story: KidsStoryVersion; warnings: string[]; errors: string[] }>(
    `/api/kids/projects/${encodeURIComponent(id)}/story`, "PUT", {
      story, unlock: opts.unlock === true, note: opts.note || "",
    });

export const kidsApproveStory = (id: string) =>
  send<{ story: KidsStoryVersion; warnings: string[] }>(
    `/api/kids/projects/${encodeURIComponent(id)}/story/approve`, "POST", {});

// =====================================================================
// Song & Lyrics Studio
// =====================================================================

export interface KidsLyricSection {
  id?: number;
  seq: number;
  label: string;
  lines: string[];
  text: string;
  start_seconds: number;
  end_seconds: number;
  emotion: string;
  character_ids: string[];
  choreography: string;
  lip_sync: boolean;
  estimated: boolean;
}

export const kidsLyrics = (id: string) =>
  get<{ sections: KidsLyricSection[] }>(`/api/kids/projects/${encodeURIComponent(id)}/lyrics`);

export const kidsAnalyzeLyrics = (id: string, body: Record<string, unknown> = {}) =>
  send<{ sections: KidsLyricSection[]; source: string; analysis: Record<string, unknown> | null }>(
    `/api/kids/projects/${encodeURIComponent(id)}/lyrics`, "POST", body);

// =====================================================================
// Audio Analysis and Narration
// =====================================================================

export interface KidsAudioSegment {
  id?: number;
  seq: number;
  start_seconds: number;
  end_seconds: number;
  duration_seconds: number;
  type: string;
  speaker: string;
  text: string;
  emotion: string;
  character: string;
  action: string;
  scene: string;
  background: string;
  camera: string;
  music_note: string;
  sound_effect: string;
  confidence: number | null;
  estimated: boolean;
}

export const kidsAudioAnalysis = (id: string) =>
  get<{ segments: KidsAudioSegment[] }>(`/api/kids/projects/${encodeURIComponent(id)}/audio-analysis`);

export const kidsRunAudioAnalysis = (id: string, body: Record<string, unknown> = {}) =>
  send<{
    segments: KidsAudioSegment[];
    analysis: {
      mood?: string; structure?: string; narration_style?: string; educational_focus?: string;
      source?: string; duration_seconds?: number; measured?: Record<string, unknown>;
      transcript?: { status?: string; note?: string } | null;
    };
  }>(`/api/kids/projects/${encodeURIComponent(id)}/audio-analysis`, "POST", body);

// =====================================================================
// Storyboard and Scene Timeline
// =====================================================================

export interface KidsTimelineRow {
  scene_number: number;
  title: string;
  start_seconds: number;
  end_seconds: number;
  duration_seconds: number;
  timing?: "measured" | "estimated";
  audio_type?: string;
  text: string;
  characters: string[];
  location: string;
  props: string[];
  action: string;
  emotion: string;
  camera_shot: string;
  camera_movement: string;
  lighting: string;
  image_prompt: string;
  video_prompt: string;
  negative_prompt: string;
  reference_assets: string[];
  generation_status: string;
  approval: string;
  characters_used?: string[];
  character_refs?: string[];
  location_ref?: string;
  prop_refs?: string[];
  /** The dialogue lines of the scene (the audio that gets voiced). */
  dialogue?: string[];
}

export const kidsTimeline = (id: string) =>
  get<{ timeline: KidsTimelineRow[]; saved?: boolean }>(
    `/api/kids/projects/${encodeURIComponent(id)}/timeline`);

export const kidsBuildTimeline = (id: string) =>
  send<{ timeline: KidsTimelineRow[] }>(
    `/api/kids/projects/${encodeURIComponent(id)}/timeline/build`, "POST", {});

export const kidsSaveTimeline = (id: string, timeline: KidsTimelineRow[]) =>
  send<{ timeline: KidsTimelineRow[]; warnings: string[]; errors: string[] }>(
    `/api/kids/projects/${encodeURIComponent(id)}/timeline`, "PUT", { timeline });

// =====================================================================
// The reusable asset library
// =====================================================================

export interface KidsLibraryFile {
  id: number;
  asset_id: number;
  file_path: string;
  kind: string;
  prompt: string;
  workflow: string;
  model: string;
  status: string;
  created_at: string | null;
}

export interface KidsLibraryAsset {
  id: number;
  scope: string;
  project_id: string | null;
  kind: "character" | "location" | "prop";
  asset_key: string;
  name: string;
  category: string;
  description: string;
  tags: string[];
  prompt: string;
  reference_image: string;
  appearance: string;
  clothing: string;
  colors: string;
  personality: string;
  voice: string;
  movement: string;
  age_appearance: string;
  version: number;
  status: "draft" | "review" | "approved" | "archived";
  locked: boolean;
  metadata: Record<string, unknown>;
  /** The generated reference stills (the files under kids/). */
  files?: KidsLibraryFile[];
}

/** The public URL of a generated library file. */
export const kidsFileUrl = (filePath: string) => `/kids/${String(filePath || "").replace(/^\/+/, "")}`;

export const kidsLibrary = (params: { scope?: string; kind?: string } = {}) =>
  get<{ assets: KidsLibraryAsset[]; kinds: string[]; categories: Record<string, string[]> }>(
    `/api/kids/library${params.kind || params.scope ? `?${new URLSearchParams(
      Object.entries(params).filter(([, v]) => v) as [string, string][]).toString()}` : ""}`);

export const kidsCreateLibraryAsset = (body: Record<string, unknown>) =>
  send<{ asset: KidsLibraryAsset }>("/api/kids/library", "POST", body);

export const kidsUpdateLibraryAsset = (id: number, body: Record<string, unknown>) =>
  send<{ asset: KidsLibraryAsset }>(`/api/kids/library/${id}`, "PUT", body);

export const kidsDeleteLibraryAsset = (id: number) =>
  send<{ ok: boolean }>(`/api/kids/library/${id}`, "DELETE");

/**
 * Queue the reference still. The SAVED PROMPT is passed verbatim — the Flux
 * Reference Image workflow is used exactly as authored and only its prompt
 * node changes (nothing is appended, no negative is invented).
 */
export const kidsGenerateReference = (id: number, body: Record<string, unknown> = {}) =>
  send<{ job: { id: string; kind: string; status: string }; message: string }>(
    `/api/kids/library/${id}/generate`, "POST", body);

export const kidsLibraryFiles = (id: number) =>
  get<{ files: KidsLibraryFile[] }>(`/api/kids/library/${id}/files`);

// ---------------------------------------------------------------- jobs
/** The studio jobs (story, lyrics, audio analysis, reference stills). */
export const kidsJobs = (params: { project_id?: string; kind?: string } = {}) =>
  get<{ jobs: KidsJob[] }>(
    `/api/kids/jobs${params.project_id || params.kind ? `?${new URLSearchParams(
      Object.entries(params).filter(([, v]) => v) as [string, string][]).toString()}` : ""}`);

// =====================================================================
// Quality control, export and feedback
// =====================================================================

export interface KidsQcCheck {
  id: string;
  severity: "error" | "warning" | "info";
  message: string;
  suggestion: string;
}

export interface KidsQcRun {
  id: number;
  summary: { errors: number; warnings: number; infos: number; passed?: boolean };
  checks: KidsQcCheck[];
  created_at: string | null;
}

export const kidsQc = (id: string) =>
  get<{ runs: KidsQcRun[]; latest: KidsQcRun | null }>(`/api/kids/projects/${encodeURIComponent(id)}/qc`);

export const kidsRunQc = (id: string) =>
  send<{
    checks: KidsQcCheck[];
    summary: { errors: number; warnings: number; infos: number; passed: boolean };
    run_id: number;
    media: Record<string, unknown>;
    note: string;
  }>(`/api/kids/projects/${encodeURIComponent(id)}/qc`, "POST", {});

export interface KidsExport {
  id: number;
  project_id: string;
  profile: string;
  status: string;
  file_path: string;
  duration_seconds: number;
  resolution: string;
  notes: string;
  created_at: string | null;
}

export const kidsExports = (id: string) =>
  get<{ exports: KidsExport[] }>(`/api/kids/projects/${encodeURIComponent(id)}/exports`);

export const kidsRecordExport = (id: string, body: Record<string, unknown>) =>
  send<{ export: KidsExport; message: string }>(
    `/api/kids/projects/${encodeURIComponent(id)}/export`, "POST", body);

export interface KidsFeedback {
  id: string;
  project_id: string | null;
  target_kind: string;
  target_id: string;
  rating: number | null;
  verdict: string;
  note: string;
  corrected_text: string;
  use_for_training: boolean;
  payload: Record<string, unknown>;
  created_at: string | null;
}

export const kidsFeedbackList = (id: string) =>
  get<{ feedback: KidsFeedback[]; training_examples: KidsFeedback[] }>(
    `/api/kids/projects/${encodeURIComponent(id)}/feedback`);

export const kidsSaveFeedback = (id: string, body: Record<string, unknown>) =>
  send<{ feedback: KidsFeedback }>(`/api/kids/projects/${encodeURIComponent(id)}/feedback`, "POST", body);
