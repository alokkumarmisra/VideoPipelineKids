// Backend for the character-sequence frontend. Zero deps, Node >= 18.
// Serves the built React app (dist/) + a small JSON API that drives
// scripts/character_sequence.mjs. Run: node server.mjs  (PORT env, default 8790)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { normalizeMovieCharacter, movieCapabilityRegistry, buildMovieReferencePacket, buildMovieKeyframePrompt, resolveMovieEnvironmentAssets } from "../lib/movie.mjs";
import { movieDb, movieFilesDir, listMovieProjects, getMovieProject, getMovieCharacter, createMovieProject, addMovieCharacter, updateMovieCharacter, saveMovieProduction, setCharacterApproval, addCharacterReference, importMovieCharacterReference, reviewCharacterReference, setCanonicalReference, addMovieCostume, reviewCostume, addMovieEnvironmentAsset, updateMovieEnvironmentAsset, setMovieEnvironmentReference, reviewMovieEnvironmentReference, setMovieEnvironmentLock, createMovieJob, updateMovieJob, addMovieShotAsset, listMovieJobs, getMovieShotAsset, deleteMovieShotAsset, reviewMovieShotAsset } from "./movieStore.mjs";

const movieGenerationProcesses = new Map();

function resolveMoviePacketFiles(packet) {
  const resolve = (rel) => {
    const full = path.resolve(ROOT, String(rel || ""));
    const allowed = [movieFilesDir, DIRECTOR_ASSETS_DIR].some((dir) => full.startsWith(path.resolve(dir) + path.sep));
    if (!allowed || !fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error(`Approved reference file is missing: ${rel}`);
    return full;
  };
  return {
    ...packet,
    canonical_face_reference: resolve(packet.canonical_face_reference),
    face_profile_references: packet.face_profile_references.map(resolve),
    face_profile_reference: packet.face_profile_reference ? resolve(packet.face_profile_reference) : null,
    body_references: packet.body_references.map(resolve),
    body_reference: packet.body_reference ? resolve(packet.body_reference) : null,
    ...(packet.costume_reference ? { costume_reference: resolve(packet.costume_reference) } : {}),
  };
}
function findMovieShot(shotId) {
  for (const row of listMovieProjects()) {
    const project = getMovieProject(row.movie_id);
    for (const scene of project.scenes) {
      const shot = scene.shots.find((item) => item.shot_id === shotId);
      if (shot) return { project, scene, shot };
    }
  }
  return null;
}
function moviePacketsForShot(project, scene, shot) {
  if (!shot.character_ids?.length) return [];
  if (new Set(shot.character_ids).size !== shot.character_ids.length) throw new Error("This shot lists the same character more than once; remove the duplicate cast assignment");
  const packets = shot.character_ids.map((characterId) => {
    const character = project.characters.find((row) => row.character_id === characterId);
    if (!character) throw new Error(`Shot character ${characterId} is not in this movie`);
    const snapshot = scene.state_snapshots.filter((row) => row.character_id === characterId && row.approved)
      .sort((a, b) => Number(b.version) - Number(a.version))[0];
    const baseState = { ...(scene.continuity_start || {}) };
    delete baseState.characters;
    for (const row of project.characters) delete baseState[row.character_id];
    const scopedState = scene.continuity_start?.characters?.[characterId] ?? scene.continuity_start?.[characterId] ?? {};
    const state = { ...baseState, ...(scopedState && typeof scopedState === "object" ? scopedState : {}), ...(snapshot?.state || {}) };
    const assignedCostumeId = shot.costume_ids.find((id) => character.costumes.some((item) => item.costume_id === id));
    const costumeId = assignedCostumeId || state.costume_id;
    const costume = costumeId ? character.costumes.find((item) => item.costume_id === costumeId) : null;
    if (costumeId && (!costume || costume.approval_status !== "approved")) throw new Error(`Approve costume ${costumeId} before generating this shot`);
    const packet = resolveMoviePacketFiles(buildMovieReferencePacket({ movieId: project.movie_id, character, costume,
      expression: shot.expression, state, shot }));
    return { character, costume, state, packet };
  });
  const canonicalOwners = new Map();
  for (const entry of packets) {
    const canonicalPath = path.resolve(entry.packet.canonical_face_reference).toLowerCase();
    const owner = canonicalOwners.get(canonicalPath);
    if (owner) throw new Error(`${owner} and ${entry.character.name} use the same canonical face image; assign separate approved references for a multi-character shot`);
    canonicalOwners.set(canonicalPath, entry.character.name);
  }
  return packets;
}
function movieEnvironmentForShot(project, scene, shot) {
  const matched = resolveMovieEnvironmentAssets({ assets: project.environment_assets || [], scene, shot });
  if (matched.ambiguous.locations.length) throw new Error(`The scene location matches multiple registered locations (${matched.ambiguous.locations.join(", ")}); edit the location text or make the registered names/aliases unambiguous`);
  if (matched.ambiguous.objects.length) throw new Error(`The shot text matches multiple registered objects through alias “${matched.ambiguous.objects[0]}”; make that alias unique`);
  const resolve = (asset) => {
    if (!asset.identity_locked || asset.approval_status !== "approved" || asset.reference_status !== "approved" || !asset.reference_path)
      throw new Error(`The mentioned ${asset.kind} “${asset.name}” needs an approved reference and identity lock before keyframe generation`);
    const full = path.resolve(ROOT, asset.reference_path);
    const allowed = [movieFilesDir, DIRECTOR_ASSETS_DIR].some((dir) => full.startsWith(path.resolve(dir) + path.sep));
    if (!allowed || !fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error(`Approved ${asset.kind} reference is missing: ${asset.name}`);
    return { ...asset, reference_path: full };
  };
  const selectedLocations = new Set((shot.location_ids || []).map(String));
  const selectedObjects = new Set((shot.object_ids || []).map(String));
  const locations = [...new Map([...matched.locations, ...(project.environment_assets || []).filter((asset) => selectedLocations.has(asset.asset_id))].map((asset) => [asset.asset_id, asset])).values()];
  const objects = [...new Map([...matched.objects, ...(project.environment_assets || []).filter((asset) => selectedObjects.has(asset.asset_id))].map((asset) => [asset.asset_id, asset])).values()];
  return { locations: locations.map(resolve), objects: objects.map(resolve) };
}
import { versionMap, setMain, clearRefMain, nextVersion } from "../lib/sequence_state.mjs";
import {
  normalizeFormat, outDirName, cfgNameForDir, prefixForDir, engineForDir,
  allDirsFor, folderSlug, fileSlug, configSlug,
} from "../lib/variant.mjs";
import {
  planDelta,
  latestVersionOf,
  resolveEffective,
  shotColumns,
  EFFECTIVE_ASSETS_SQL,
  EXACT_VERSION_SQL,
} from "../lib/project_versioning.mjs";
import {
  GetAvailablePresets,
  GetPresetById,
  GetPresetContent,
  resolvePresetId,
} from "../lib/presets.mjs";
import { applyMasterToBeats } from "../lib/master_prompt.mjs";
import { audioDuration, dialogueWavFile } from "../lib/tts.mjs";
import { FFMPEG, FFPROBE } from "../lib/ffmpeg.mjs";
import { analyzePcm } from "../lib/audio_analysis.mjs";
import { resolveImageWorkflow, DEFAULT_IMAGE_WORKFLOW, isImageWorkflowId } from "../lib/image_workflows.mjs";
import {
  buildBoardAssetState, blueprintAssetSignature, assetVersionId,
  findDuplicateAssets, buildAssetReferenceMap, buildVisualStyleGuide, validateAssetContinuity,
} from "../lib/asset_service.mjs";
import {
  getBoardAssetState, findAsset, isValidAssetId, approveAssets, skipAssets, compactIndex, resolveSceneAssetRefs,
} from "../lib/asset_endpoints.mjs";
import { buildAudioTimeline, audioTimelineDuration, validateAudioTimeline, syncAudioTimelineToScenes } from "../lib/audio_timeline.mjs";
import {
  SEMANTIC_SYSTEM,
  analyzeLine,
  buildSemanticAnalysisPrompt,
  mergeModelSemantics,
  buildSemanticContext,
  buildSemanticVariationContext,
  attachSemantics,
  validateSceneSemantics,
  repairSceneSemantics,
  buildEnglishVisualInstruction,
  buildNarrationVisuals,
  alignSemanticsToTiming,
  buildLyricActionPlan,
  detectLanguage,
  buildLyricTimeline,
  applyLyricCorrections,
  validateLyricTimeline,
  buildLyricActionTimeline,
  assignLyricLinesToScenes,
  findCJKViolations,
} from "../lib/semantics.mjs";
import {
  MASTER_SEGMENT_TYPES,
  MASTER_CLIP_MIN,
  MASTER_CLIP_MAX,
  buildMasterTimeline,
  planTimelineClips,
  timelineClipsToStoryboard,
  detectRepeatedLyrics,
  applyMasterCorrections,
  approveMasterTimeline,
  unlockMasterTimeline,
  validateMasterTimeline,
  applyApprovedTimelineToScenes,
} from "../lib/master_timeline.mjs";
import { splitWhisperTranscript, directorSegmentsToSrt } from "../lib/director_segments.mjs";
import {
  beatDialogueStatus,
  lineWavFile,
  planDialogueTiming,
  dialogueTotal,
  needsSegmentation,
    ttsProviderName,
    lipSyncProviderName,
    musetalkWorkflowReady,
  } from "../lib/dialogue_pipeline.mjs";
import {
  SCENE_BATCH,
  SCENE_BATCH_MIN,
  SCENE_BATCH_MAX,
  sceneCountFor,
  styleLockFor,
  DIRECTOR_SYSTEM,
  DIRECTOR_PROMPT_RULES,
  normalizeDirectorPromptSettings,
  directorPromptAddons,
  kidsPromptAddons,
  documentaryPromptAddons,
  stripJson,
  normalizeBlueprint,
  normalizeDialogue,
  normalizeScene,
  isAbstractOpeningSource,
  compactSceneGenerationDirections,
  canonicalizeSceneRefs,
  dedupeScenes,
  flagRepeatStaging,
  sameLine,
  buildBiblePrompt,
  buildScenesPrompt,
  buildRegenPrompt,
  buildAddEntryPrompt,
  buildRegenEntryPrompt,
  normalizeCharacter,
  normalizeLocation,
  normalizeObject,
  boardToScenario,
  stripContinuityText,
  parseLyricLines,
  estimateLyricTiming,
  timeLinesFromTranscript,
  linesForTimeWindow,
  planProgress,
  verifyPlanComplete,
  validateLyricPlan,
  extractPartialScenes,
  boardLyricLines,
  validateBibleAnatomy,
  normalizeStoryPlan,
  buildStoryPlan,
  approveGate,
} from "../lib/director.mjs";
import {
  STORYBOARD_PHASES,
  normalizeStoryboardTimeline,
  storyboardBatchContext,
  buildStoryboardPromptBlock,
} from "../lib/storyboard_planner.mjs";
import { storyboardToScenario } from "../lib/project_import.mjs";
import {
  KIDS_SCHEMA,
  KIDS_SQLITE_SCHEMA,
  KIDS_OPTION_KEYS,
  KIDS_DEFAULT_OPTIONS,
  KIDS_PROJECT_STATUSES,
  normalizeKidsProject,
  validateKidsProject,
  normalizeKidsDirectorPlan,
  isPlanSubstantive,
  planEditGuard,
  buildKidsPlanFromBoard,
  buildKidsDirectorPlanPrompt,
  KIDS_DIRECTOR_SYSTEM,
  kidsDashboardMetrics,
  kidsSlug,
  hasScript,
  directorStyleFor,
  directorLanguageFor,
  directorAspectFor,
  directorGenreFor,
} from "../lib/kids.mjs";
import {
  kidsOptions,
  kidsSetOptions,
  kidsListProjects,
  kidsGetProject,
  kidsProjectNameExists,
  kidsInsertProject,
  kidsUpdateProject,
  kidsDeleteProject,
  kidsGetPlan,
  kidsListPlans,
  kidsSavePlan,
  kidsApprovePlan,
  kidsListScenes,
  kidsReplaceScenes,
  kidsListCharacters,
  kidsReplaceCharacters,
  kidsListAssets,
  kidsUpsertAsset,
  kidsListJobs,
  kidsUpsertJob,
  kidsDashboard,
  kidsGetStory,
  kidsListStories,
  kidsSaveStory,
  kidsApproveStory,
  kidsListLibrary,
  kidsGetLibraryAsset,
  kidsInsertLibraryAsset,
  kidsUpdateLibraryAsset,
  kidsDeleteLibraryAsset,
  kidsListLibraryFiles,
  kidsInsertLibraryFile,
  kidsListAllLibraryFiles,
  kidsJobRow,
  kidsListLyricSections,
  kidsReplaceLyricSections,
  kidsListAudioSegments,
  kidsReplaceAudioSegments,
  kidsListTimeline,
  kidsReplaceTimeline,
  kidsInsertQcRun,
  kidsListQcRuns,
  kidsInsertExport,
  kidsListExports,
  kidsInsertFeedback,
  kidsListFeedback,
  kidsInsertAudioAsset,
  kidsListAudioAssets,
  kidsSaveTimeline as kidsSaveUnifiedTimeline,
  kidsListTimelines,
  kidsApproveTimeline,
  kidsSaveBlueprint,
  kidsListBlueprints,
  kidsApproveBlueprint,
  kidsSaveSnapshot,
  kidsListSnapshots,
} from "../lib/kids_store.mjs";
import {
  KIDS_PIPELINE_STAGES,
  kidsStageStatus,
  kidsRunnableStages,
  normalizeKidsStory,
  validateKidsStory,
  isKidsStorySubstantive,
  buildKidsStoryPrompt,
  segmentLyrics,
  normalizeLyricSections,
  buildKidsSongPrompt,
  buildKidsAudioTimeline,
  buildKidsTimeline,
  validateKidsTimeline,
  normalizeKidsLibraryAsset,
  buildKidsScenePrompt,
  runKidsQualityChecks,
  normalizeKidsFeedback,
  kidsTrainingExamples,
  KIDS_LIBRARY_KINDS,
  KIDS_LIBRARY_CATEGORIES,
  buildKidsVoiceMap,
} from "../lib/kids_pipeline.mjs";
import { buildUnifiedTimeline, validateUnifiedTimeline } from "../lib/studio_engines.mjs";
import { buildDurationPacingBlueprint } from "../lib/durationPacing.mjs";
import {
  resolveProductionMode,
  canRunDirector,
  buildDirectorInputSnapshot,
  isSnapshotStale,
} from "../lib/production_modes.mjs";
import {
  DOC_STATUSES,  validateDocBrief,
  normalizeDocCharacter,
  normalizeDocLocation,
  normalizeDocShot,
  normalizeDocSequence,
  normalizeDocChapter,
  reindexBoardShots,
  countBoardShots,
  boardNarrationSeconds,
  DOCUMENTARY_DIRECTOR_SYSTEM,
  buildDocBiblePrompt,
  buildDocShotsPrompt,
  buildDocBriefDetectPrompt,
  normalizeDocDetectedBrief,
  fillDocBriefAuto,
  heuristicDetectBrief,
  heuristicEstimateDuration,
  heuristicTopicText,
  buildDocAnalysisPrompt,
  normalizeDocAnalysis,
  normalizeDocStageApprovals,
  snapshotDocStages,
  DOC_HISTORY_CAP,
  heuristicAnalyze,
  docAnalysisContext,
  heuristicPlan,
  splitNarrationForShots,
  boardToScenario as docBoardToScenario,
  buildTimeline as docBuildTimeline,
  subtitlesFromBoard as docSubtitles,
  buildExportManifest as docExportManifest,
  boardStats as docBoardStats,
  chaptersForDuration as docChaptersFor,
  shotsForDuration as docShotsFor,
  withDevotionalRealism,
  isDevotionalBrief,
} from "../lib/documentary.mjs";
// Reject path traversal / absolute / separator-carrying segments (used by the
// auth-gated binary servers — e.g. serveKids). Mirrors lib/devotional.mjs's
// helper of the same name.
function isSafeSegment(s) {
  return typeof s === "string" && s.length > 0 && s.length <= 120 &&
    !s.includes("..") && !s.includes("/") && !s.includes("\\") && !s.startsWith(".");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIRECTOR_PROMPT_SETTINGS_FILE = path.join(ROOT, "data", "director_prompt_settings.json");
const readDirectorPromptSettings = () => {
  try { return normalizeDirectorPromptSettings(JSON.parse(fs.readFileSync(DIRECTOR_PROMPT_SETTINGS_FILE, "utf8"))); }
  catch { return normalizeDirectorPromptSettings(); }
};
const writeDirectorPromptSettings = (raw) => {
  const normalized = normalizeDirectorPromptSettings(raw);
  fs.mkdirSync(path.dirname(DIRECTOR_PROMPT_SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(DIRECTOR_PROMPT_SETTINGS_FILE, JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
};

// Same tiny .env loader as lib/comfy.mjs (real env vars always win).
{
  const envFile = path.join(ROOT, ".env");
  if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    if (!(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["'](.*)["']$/, "$1");
  }
}
const PROMPTS = path.join(ROOT, "prompts");
const OUTPUTS = path.join(ROOT, "outputs");
const FAVS = path.join(ROOT, "favorites.json");
const readFavs = () => {
  try { return JSON.parse(fs.readFileSync(FAVS, "utf8")).names; }
  catch { return []; }
};
// UI theme persisted in a file (data/theme.json) so the chosen mode + button
// colors + background colors survive reloads, restarts and browsers —
// localStorage is only a cache.
// Shape: { mode: "dark" | "light", color: "" | "#rrggbb" (active accent,
// legacy), darkColor?: "" | "#rrggbb", lightColor?: "" | "#rrggbb",
// darkBg?: "" | "#rrggbb", lightBg?: "" | "#rrggbb" }.
// Empty = factory default (dark theme, default backgrounds, red buttons).
const THEME_FILE = path.join(ROOT, "data", "theme.json");
const cleanColor = (c) =>
  typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c) ? c : "";
const readThemeFile = () => {
  try {
    const t = JSON.parse(fs.readFileSync(THEME_FILE, "utf8"));
    const mode = t.mode === "light" ? "light" : "dark";
    const color = cleanColor(t.color);
    // New per-mode button colors; fall back to the legacy single color so
    // previously saved picks keep working in both modes.
    const darkColor = cleanColor(t.darkColor) || color;
    const lightColor = cleanColor(t.lightColor) || color;
    const darkBg = cleanColor(t.darkBg);
    const lightBg = cleanColor(t.lightBg);
    return { mode, color: mode === "dark" ? darkColor : lightColor, darkColor, lightColor, darkBg, lightBg };
  } catch { return { mode: "dark", color: "", darkColor: "", lightColor: "", darkBg: "", lightBg: "" }; }
};
const writeThemeFile = (t) => {
  fs.mkdirSync(path.dirname(THEME_FILE), { recursive: true });
  fs.writeFileSync(THEME_FILE, JSON.stringify(t, null, 2));
};
// ---------------------------------------------------------------- scenarios store
// Scenario configs live in Postgres (scenarios table) by default — SQLite is
// NOT used unless explicitly enabled. Set USE_SQLITE=true in the root .env to
// use the legacy SQLite store instead (data/scenarios.sqlite, canonical for
// the UI, mirrored to Postgres). Requires a server restart to take effect.
// On save we ALSO export the JSON to prompts/<name>.json so the CLI runners
// (director.mjs, ...), which read prompts/<scenario>.json, keep working
// unchanged — in either mode.
const USE_SQLITE = ["1", "true", "yes", "on"].includes(String(process.env.USE_SQLITE || "").trim().toLowerCase());
const DATA_DIR = path.join(ROOT, "data");
const DB = path.join(DATA_DIR, "scenarios.sqlite");
let db = null;
if (USE_SQLITE) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  {
    const init = new DatabaseSync(DB);
    init.exec(`CREATE TABLE IF NOT EXISTS scenarios (
      name TEXT PRIMARY KEY,
      config TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    // One-time migration: import any prompts/*.json not yet in the DB.
    // The dir may have been wiped — ensure it exists instead of crashing boot.
    fs.mkdirSync(PROMPTS, { recursive: true });
    const insert = init.prepare("INSERT OR IGNORE INTO scenarios (name, config, updated_at) VALUES (?, ?, ?)");
    for (const f of fs.readdirSync(PROMPTS).filter((f) => f.endsWith(".json"))) {
      const name = f.replace(/\.json$/, "");
      if (!init.prepare("SELECT 1 FROM scenarios WHERE name = ?").get(name)) {
        insert.run(name, fs.readFileSync(path.join(PROMPTS, f), "utf8"), fs.statSync(path.join(PROMPTS, f)).mtimeMs);
      }
    }
    init.close();
  }
  db = new DatabaseSync(DB);
  console.log("[db] scenario store: sqlite (data/scenarios.sqlite)");
} else {
  console.log("[db] scenario store: postgres (sqlite disabled — set USE_SQLITE=true to use it)");
}
// Async in both modes so callers don't care which store is active. PG rows
// are shaped like the old SQLite ones: { name, config (JSON text), updated_at (ms) }.
const dbListScenarios = async () => {
  if (USE_SQLITE) return db.prepare("SELECT name, config, updated_at FROM scenarios ORDER BY updated_at DESC").all();
  if (!pgUp) throw new Error("database unavailable");
  const r = await pgPool.query(
    "SELECT name, config::text AS config, updated_at_ms AS updated_at FROM scenarios ORDER BY updated_at_ms DESC");
  return r.rows;
};
const dbGetScenario = async (name) => {
  if (USE_SQLITE) return db.prepare("SELECT config FROM scenarios WHERE name = ?").get(name)?.config ?? null;
  if (!pgUp) return null;
  const r = await pgPool.query("SELECT config::text AS config FROM scenarios WHERE name = $1", [name]);
  return r.rows[0]?.config ?? null;
};
const dbSaveScenario = async (name, cfg) => {
  if (USE_SQLITE) {
    // folder_name rides inside the config JSON (SQLite has no projects
    // table); the PUT route stamps the immutable value before calling here.
    if (cfg && typeof cfg === "object" && !cfg.folder_name) {
      cfg = { ...cfg, folder_name: folderName(name) };
    }
    db.prepare(`INSERT INTO scenarios (name, config, updated_at) VALUES (?, ?, ?)
               ON CONFLICT(name) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`)
      .run(name, JSON.stringify(cfg), Date.now());
    return;
  }
  // PostgreSQL: folder claiming happens in the PUT route (unique + frozen);
  // here we only persist the scenario row. The projects.folder_name backfill
  // below covers rows that predate the folder column.
  await pgPool.query(
    `INSERT INTO scenarios (name, config, updated_at_ms) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (name) DO UPDATE SET config = EXCLUDED.config, updated_at_ms = EXCLUDED.updated_at_ms`,
    [name, JSON.stringify(cfg), Date.now()]);
  if (pgUp && cfg && typeof cfg === "object" && cfg.folder_name) {
    await pgPool.query(
      `UPDATE projects SET folder_name = $2 WHERE name = $1 AND (folder_name IS NULL OR folder_name = '')`,
      [name, cfg.folder_name]
    );
  }
};
const dbDeleteScenario = async (name) => {
  if (USE_SQLITE) { db.prepare("DELETE FROM scenarios WHERE name = ?").run(name); return; }
  await pgPool.query("DELETE FROM scenarios WHERE name = $1", [name]);
};
// Escape LIKE wildcards in user-chosen names (spaces, %, _ … are all legal).
const pgLike = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
// Display-name rename across the name-keyed catalog rows. Storage
// (outputs dirs, filenames, assets/project_assets paths, folder_name) is
// IMMUTABLE and intentionally untouched here — that is what keeps images,
// thumbnails and videos resolving after a project is renamed or edited.
async function pgRenameRows(oldName, newName) {
  const now = Date.now();
  await pgPool.query("UPDATE scenarios SET name = $2, updated_at_ms = $3 WHERE name = $1", [oldName, newName, now]);
  await pgPool.query("UPDATE scenario_versions SET name = $2 WHERE name = $1", [oldName, newName]);
  await pgPool.query("UPDATE projects SET name = $2, updated_at = now() WHERE name = $1", [oldName, newName]);
  await pgPool.query("UPDATE project_songs SET name = $2, updated_at = now() WHERE name = $1", [oldName, newName]);
}
async function dbRenameScenario(oldName, newName) {
  if (USE_SQLITE) {
    // SQLite mode only has the scenarios table (versions/catalog are PG-only).
    db.prepare("UPDATE scenarios SET name = ?, updated_at = ? WHERE name = ?").run(newName, Date.now(), oldName);
    return;
  }
  if (!pgUp) throw new Error("database unavailable");
  await pgRenameRows(oldName, newName);
}
async function pgRenameScenarioMirror(oldName, newName) {
  if (!pgUp) return;
  await pgRenameRows(oldName, newName);
}
// Swap a leading filename prefix ("<old>_" -> "<new>_"); anything else
// (state.json, foreign files) passes through untouched.
const swapPrefix = (file, oldPrefix, newPrefix) =>
  (typeof file === "string" && file.startsWith(oldPrefix)) ? newPrefix + file.slice(oldPrefix.length) : file;
// Move outputs/<oldBase>[engines x formats] to outputs/<newBase>, swapping
// the embedded leading filename prefix and state.json mains (generated files
// are namespaced "<base>_" / "<base>_wan_" / ...). Variants whose target dir
// already exists are MERGED file-by-file (collisions keep the target file);
// missing source variants are skipped. Returns moved [oldDir, newDir] pairs.
// Shared by legacy storage migration (display-name dirs -> folder dirs).
// (Prompts JSON is keyed by display name and is NOT moved here.)
function moveOutputDirs(oldBase, newBase) {
  const moved = [];
  for (const suffix of ["", "_wan", "_vertical", "_wan_vertical"]) {
    const oldDir = path.join(OUTPUTS, oldBase + suffix);
    if (!fs.existsSync(oldDir)) continue;
    const newDir = path.join(OUTPUTS, newBase + suffix);
    const from = oldBase + suffix + "_";
    const to = newBase + suffix + "_";
    if (fs.existsSync(newDir)) {
      // Merge: relocate non-colliding files, then drop the empty shell.
      for (const f of fs.readdirSync(oldDir)) {
        const swapped = swapPrefix(f, from, to);
        if (swapped !== f && fs.existsSync(path.join(newDir, swapped))) continue; // keep target
        const dest = swapped !== f ? path.join(newDir, swapped) : path.join(newDir, f);
        try { fs.renameSync(path.join(oldDir, f), dest); } catch { /* keep going */ }
      }
      // Fold the old state.json mains into the surviving one when it lacks them.
      mergeStateMains(newDir, oldDir, from, to);
      try {
        if (!fs.readdirSync(oldDir).filter((f) => f !== "state.json").length) {
          if (fs.existsSync(path.join(oldDir, "state.json"))) {
            try { fs.unlinkSync(path.join(oldDir, "state.json")); } catch { /* keep */ }
          }
          fs.rmdirSync(oldDir);
        }
      } catch { /* leftover shell stays — harmless */ }
      moved.push([oldBase + suffix, newBase + suffix]);
      continue;
    }
    for (const f of fs.readdirSync(oldDir)) {
      const swapped = swapPrefix(f, from, to);
      if (swapped !== f) fs.renameSync(path.join(oldDir, f), path.join(oldDir, swapped));
    }
    // state.json mains reference filenames — swap the same prefix. A corrupt
    // file is left alone (versionMap falls back to latest-on-disk).
    rewriteStatePrefixes(oldDir, from, to);
    fs.renameSync(oldDir, newDir);
    moved.push([oldBase + suffix, newBase + suffix]);
  }
  return moved;
}
// Rewrite state.json mains with a filename mapping (old file -> new file).
// Used by storage migration after slug renames; unknown values pass through.
function rewriteStateFiles(dir, renameMap) {
  const sf = path.join(dir, "state.json");
  if (!fs.existsSync(sf)) return;
  try {
    const st = JSON.parse(fs.readFileSync(sf, "utf8"));
    if (!st || typeof st !== "object") return;
    const swap = (v) => (typeof v === "string" && renameMap.has(v) ? renameMap.get(v) : v);
    if (st.ref) st.ref = swap(st.ref);
    if (st.final) st.final = swap(st.final);
    if (st.beats && typeof st.beats === "object") {
      for (const k of Object.keys(st.beats)) {
        const b = st.beats[k];
        if (b && typeof b === "object") {
          if (b.keyframe) b.keyframe = swap(b.keyframe);
          if (b.clip) b.clip = swap(b.clip);
        }
      }
    }
    fs.writeFileSync(sf, JSON.stringify(st, null, 2));
  } catch { /* keep old mains */ }
}
function rewriteStatePrefixes(dir, from, to) {
  const sf = path.join(dir, "state.json");
  if (!fs.existsSync(sf)) return;
  try {
    const st = JSON.parse(fs.readFileSync(sf, "utf8"));
    if (st && typeof st === "object") {
      if (st.ref) st.ref = swapPrefix(st.ref, from, to);
      if (st.final) st.final = swapPrefix(st.final, from, to);
      if (st.beats && typeof st.beats === "object") {
        for (const k of Object.keys(st.beats)) {
          const b = st.beats[k];
          if (b && typeof b === "object") {
            if (b.keyframe) b.keyframe = swapPrefix(b.keyframe, from, to);
            if (b.clip) b.clip = swapPrefix(b.clip, from, to);
          }
        }
      }
      fs.writeFileSync(sf, JSON.stringify(st, null, 2));
    }
  } catch { /* keep old mains */ }
}
// Fold an absorbed state.json's mains into the surviving dir's state when the
// survivor has no main recorded for that asset (pins from the surviving file
// always win — they are the newer deliberate choice).
function mergeStateMains(surviveDir, absorbedDir, from, to) {
  const a = path.join(absorbedDir, "state.json");
  const s = path.join(surviveDir, "state.json");
  if (!fs.existsSync(a)) return;
  try {
    const oldSt = JSON.parse(fs.readFileSync(a, "utf8"));
    let newSt = {};
    try { if (fs.existsSync(s)) newSt = JSON.parse(fs.readFileSync(s, "utf8")) || {}; } catch { newSt = {}; }
    const pick = (v) => (typeof v === "string" ? swapPrefix(v, from, to) : v);
    if (!newSt.ref && oldSt && oldSt.ref) newSt.ref = pick(oldSt.ref);
    if (!newSt.final && oldSt && oldSt.final) newSt.final = pick(oldSt.final);
    const beats = (oldSt && oldSt.beats && typeof oldSt.beats === "object") ? oldSt.beats : {};
    newSt.beats = { ...(newSt.beats || {}) };
    for (const k of Object.keys(beats)) {
      const b = beats[k] || {};
      const cur = newSt.beats[k] || {};
      newSt.beats[k] = {
        ...cur,
        ...(!cur.keyframe && b.keyframe ? { keyframe: pick(b.keyframe) } : {}),
        ...(!cur.clip && b.clip ? { clip: pick(b.clip) } : {}),
      };
    }
    fs.writeFileSync(s, JSON.stringify(newSt, null, 2));
  } catch { /* survivor keeps its state */ }
}
// Legacy rename entry point (prompts JSON only — outputs dirs are immutable
// storage now and move exclusively via moveOutputDirs during migration).
// Prompts files are SPACE-FREE (slug names): the old file may exist under the
// legacy raw display name OR the slug — either source moves to the new slug.
function renameScenarioFiles(oldName, newName) {
  const dst = promptsSlugFile(newName);
  for (const src of [promptsLegacyFile(oldName), promptsSlugFile(oldName)]) {
    if (!fs.existsSync(src) || src === dst) continue;
    try { fs.renameSync(src, dst); break; } catch { /* best-effort */ }
  }
}
// Slugify legacy filenames inside one output dir using the CURRENT config
// beat titles: "<prefix>_{seq,clip}<n>_<raw title>[(_vN)].<ext>" ->
// "<prefix>_{seq,clip}<n>_<slug title>[(_vN)].<ext>". Returns the old->new
// filename map (for state.json + DB path rewrites). Collisions are skipped.
function slugifyDirFilenames(dir, prefix, seq) {
  const renamed = new Map();
  if (!fs.existsSync(dir) || !Array.isArray(seq)) return renamed;
  const kinds = [["seq", ".png"], ["clip", ".mp4"]];
  seq.forEach((s, i) => {
    const n = i + 1;
    const raw = String(s?.title ?? "");
    const slug = fileSlug(raw);
    if (!raw || raw === slug) return;
    for (const [kind, ext] of kinds) {
      const rawBase = `${prefix}_${kind}${n}_${raw}`;
      const slugBase = `${prefix}_${kind}${n}_${slug}`;
      let files = [];
      try {
        files = fs.readdirSync(dir).filter((f) =>
          f === rawBase + ext || (f.startsWith(rawBase + "_v") && f.endsWith(ext)));
      } catch { files = []; }
      for (const f of files) {
        const rest = f.slice(rawBase.length, -ext.length); // "" | "_vN"
        if (rest && !/^_v\d+$/.test(rest)) continue;
        const dest = slugBase + rest + ext;
        if (fs.existsSync(path.join(dir, dest))) continue; // never clobber
        try {
          fs.renameSync(path.join(dir, f), path.join(dir, dest));
          renamed.set(f, dest);
        } catch { /* keep going */ }
      }
    }
  });
  return renamed;
}
// One-time legacy migration for a project: claim its immutable folder,
// relocate display-name output dirs to folder dirs (prefix swap), slugify
// legacy spaced filenames, and rewrite state.json + DB paths from the exact
// rename map. Safe no-op when already canonical. Returns the folder.
async function migrateProjectStorage(displayName) {
  const stored = pgUp ? await getFolderNameFromRow(displayName) : null;
  // Stable folder claim WITHOUT a project row: reuse the slug dir when it
  // is absent or already holds this scenario's own files (prefix match) — so
  // every run for the same unsaved scenario lands in the SAME folder. Only a
  // genuinely foreign collision (dir exists with other files) mints a fresh
  // _N folder. (Previously every row-less run minted +1 merely because the
  // previous run's dir existed, scattering one project's assets across
  // minku_story_2_2, _3, … and emptying its gallery forever.)
  let folder = stored;
  if (!folder) {
    const base = folderName(displayName);
    let ours = false;
    try {
      const dir = path.join(OUTPUTS, base);
      if (!fs.existsSync(dir)) ours = true; // fresh — claim base
      else {
        const prefix = prefixForDir(base);
        ours = fs.readdirSync(dir).some((f) =>
          f === "state.json" || f === "concat_list.txt" || f.startsWith(`${prefix}_`));
      }
    } catch { ours = false; }
    folder = ours ? base : (pgUp ? await ensureUniqueFolder(displayName, displayName) : base);
  }
  if (pgUp && !stored) {
    try {
      await pgPool.query(
        "UPDATE projects SET folder_name = $2 WHERE name = $1 AND (folder_name IS NULL OR folder_name = '')",
        [displayName, folder]);
    } catch { /* row may not exist yet — claimed on next save */ }
  }
  // Slug pass over canonical dirs (fixes spaced beat-title filenames even
  // when the folder already matches the name).
  const renameMap = new Map(); // "dir/file" -> new file
  try {
    const raw = await dbGetScenario(displayName);
    const cfg = raw ? JSON.parse(raw) : null;
    const seq = Array.isArray(cfg?.sequence) ? cfg.sequence : [];
    for (const suffix of ["", "_wan", "_vertical", "_wan_vertical"]) {
      const dir = path.join(OUTPUTS, folder + suffix);
      if (!fs.existsSync(dir)) continue;
      const prefix = prefixForDir(folder + suffix);
      for (const [oldF, newF] of slugifyDirFilenames(dir, prefix, seq)) {
        renameMap.set(`${folder + suffix}/${oldF}`, `${folder + suffix}/${newF}`);
      }
    }
  } catch { /* config unreadable — skip slug pass */ }
  // Relocate legacy display-name dirs (different base only).
  let moved = [];
  if (folder !== displayName) {
    try { moved = moveOutputDirs(displayName, folder); }
    catch (e) { console.warn(`[migrate] dir move failed for ${displayName}:`, e.message); moved = []; }
    // Slug pass over freshly moved dirs (old prefix, raw titles).
    try {
      const raw = await dbGetScenario(displayName);
      const cfg = raw ? JSON.parse(raw) : null;
      const seq = Array.isArray(cfg?.sequence) ? cfg.sequence : [];
      for (const [, newBase] of moved) {
        const dir = path.join(OUTPUTS, newBase);
        const prefix = prefixForDir(newBase);
        for (const [oldF, newF] of slugifyDirFilenames(dir, prefix, seq)) {
          renameMap.set(`${newBase}/${oldF}`, `${newBase}/${newF}`);
        }
      }
    } catch { /* skip */ }
  }
  // Rewrite state.json mains from the exact rename map.
  if (renameMap.size) {
    const byDir = new Map();
    for (const [from, to] of renameMap) {
      const slash = from.indexOf("/");
      const dir = from.slice(0, slash), oldF = from.slice(slash + 1), newF = to.slice(to.indexOf("/") + 1);
      if (!byDir.has(dir)) byDir.set(dir, new Map());
      byDir.get(dir).set(oldF, newF);
    }
    for (const [dir, map] of byDir) rewriteStateFiles(path.join(OUTPUTS, dir), map);
  }
  if (pgUp && (moved.length || renameMap.size)) {
    // project_assets: exact-match path rewrites + frozen folder stamp.
    try {
      const pid = await pgProjectId(displayName);
      if (pid != null) {
        await pgPool.query("UPDATE project_assets SET folder_name = $2 WHERE project_id = $1", [pid, folder]);
        for (const [from, to] of renameMap) {
          const oldP = `outputs/${from}`, newP = `outputs/${to}`;
          await pgPool.query(
            "UPDATE project_assets SET file_path = $3 WHERE project_id = $1 AND file_path = $2",
            [pid, oldP, newP]);
          const oldF = from.slice(from.indexOf("/") + 1), newF = to.slice(to.indexOf("/") + 1);
          await pgPool.query(
            `UPDATE project_assets SET metadata = jsonb_set(metadata, '{file}', to_jsonb($3::text))
             WHERE project_id = $1 AND metadata->>'file' = $2`,
            [pid, oldF, newF]);
        }
        for (const suffix of ["", "_wan", "_vertical", "_wan_vertical"]) {
          try { await pgRefreshProjectFiles(displayName, folder + suffix); } catch { /* no dir */ }
        }
      }
    } catch (e) { console.warn(`[migrate] project_assets fixup failed for ${displayName}:`, e.message); }
    // project_references: moved dirs change output_dir; renames change
    // file_path + metadata.file (exact matches from the rename map).
    try {
      const pid = await pgProjectId(displayName);
      if (pid != null) {
        for (const [oldBase, newBase] of moved) {
          await pgPool.query(
            "UPDATE project_references SET output_dir = $3 WHERE project_id = $1 AND output_dir = $2",
            [pid, oldBase, newBase]);
        }
        for (const [from, to] of renameMap) {
          const oldP = `outputs/${from}`, newP = `outputs/${to}`;
          await pgPool.query(
            "UPDATE project_references SET file_path = $3 WHERE project_id = $1 AND file_path = $2",
            [pid, oldP, newP]);
          const oldF = from.slice(from.indexOf("/") + 1), newF = to.slice(to.indexOf("/") + 1);
          await pgPool.query(
            `UPDATE project_references SET metadata = jsonb_set(metadata, '{file}', to_jsonb($3::text))
             WHERE project_id = $1 AND metadata->>'file' = $2`,
            [pid, oldF, newF]);
        }
      }
    } catch (e) { console.warn(`[migrate] references fixup failed for ${displayName}:`, e.message); }
  }
  return folder;
}

// ---------------------------------------------------------------- pg catalog
// Every finished generation is tracked in Postgres `video_generator`
// (binaries stay in outputs/ — the DB is the catalog):
//   project_assets     — keyframe / clip / final rows per version
//   project_references — reference visuals, one row per generation/upload
// The gallery file list and dashboard coverage are derived from disk
// (outputs/ dirs are the source of truth for files). If Postgres is down
// the server keeps working from disk (pgUp === false).
const pgPool = new Pool({
  host: process.env.PG_HOST || "localhost",
  port: Number(process.env.PG_PORT || 5432),
  database: process.env.PG_DATABASE || "video_generator",
  user: process.env.PG_USER || "postgres",
  password: process.env.PG_PASSWORD || "",
  connectionTimeoutMillis: 3000,
});
let pgUp = false;
// NOTE: the old `/api/story/*` audio-analysis scaffolding (an Express-style
// handler — `req.body` / `res.status().json()` / `require()` — inside this
// zero-dependency ESM server) crashed with "Unexpected end of JSON input" on
// the client. Story audio analysis now rides the REAL WhisperX board flow:
// POST /api/director/boards/:id/audio-upload → POST .../whisperx/analyze →
// GET .../master-timeline (review + approve). No parallel store.
// ---------------------------------------------------------------- kids studio store
// The Sanskriti Kids Studio is a PROJECT LAYER on top of the existing
// Director pipeline — it never renders on its own. Its own tables live in a
// DEDICATED Postgres database (`Sanskriti_kids` by default, override with
// PG_KIDS_DATABASE) so the studio's project/plan/scene/asset/job rows never
// mix with the main catalog (video_generator). When that database is not
// reachable the studio falls back to a local SQLite file
// (data/kids.sqlite) with the same tables, so the module always works.
const KIDS_DB_NAME = process.env.PG_KIDS_DATABASE || "Sanskriti_kids";
const kidsPool = new Pool({
  host: process.env.PG_HOST || "localhost",
  port: Number(process.env.PG_PORT || 5432),
  database: KIDS_DB_NAME,
  user: process.env.PG_USER || "postgres",
  password: process.env.PG_PASSWORD || "",
  connectionTimeoutMillis: 3000,
});
let kidsPgUp = false;
const KIDS_SQLITE_FILE = path.join(DATA_DIR, "kids.sqlite");
let kidsDb = null;
// Which store answers a kids query: "pg" | "sqlite" | null (none available).
const kidsStore = () => (kidsPgUp ? "pg" : (kidsDb ? "sqlite" : null));
// JSON columns arrive as objects from node-pg and as TEXT from SQLite.
const kidsJson = (v, fb) => {
  if (v == null) return fb;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return fb; }
};
const kidsNow = () => new Date().toISOString();
// ---------------------------------------------------------------- kids sqlite fallback
// The Kids Studio works without Postgres: when the dedicated `Sanskriti_kids`
// database is unreachable every kids route uses this local SQLite store
// instead (data/kids.sqlite, same tables). Same discipline as the Devotional
// Studio: the studio is always usable, Postgres is the canonical store when
// it is up.
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  kidsDb = new DatabaseSync(KIDS_SQLITE_FILE);
  kidsDb.exec(KIDS_SQLITE_SCHEMA);
  // A PROCESSING job cannot survive a server restart (the child process is
  // gone); close it as a visible failure instead of leaving the UI polling.
  try {
    kidsDb.prepare(
      "UPDATE kids_jobs SET status='FAILED', error_message='server restarted while job was processing', updated_at=? WHERE status='PROCESSING'",
    ).run(kidsNow());
  } catch { /* first boot/schema race */ }
  // An EXISTING fallback database keeps its old columns (CREATE TABLE IF NOT
  // EXISTS never changes a table). Every column the studio added later is
  // ALTERed in here — the same discipline the Postgres branch uses.
  const kidsSqliteColumns = {
    kids_projects: {
      audio_path: "TEXT NOT NULL DEFAULT ''",
      reference_images: "TEXT NOT NULL DEFAULT '[]'",
      metadata: "TEXT NOT NULL DEFAULT '{}'",
      board_id: "TEXT",
      scenario_name: "TEXT",
    },
    kids_jobs: {
      metadata: "TEXT NOT NULL DEFAULT '{}'",
      error_message: "TEXT",
    },
    kids_assets: {
      prompt: "TEXT NOT NULL DEFAULT ''",
      status: "TEXT NOT NULL DEFAULT 'PENDING'",
      scene_number: "INTEGER",
    },
  };
  for (const [table, cols] of Object.entries(kidsSqliteColumns)) {
    let have = new Set();
    try {
      have = new Set(kidsDb.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
    } catch { continue; /* the table does not exist in this file */ }
    for (const [name, ddl] of Object.entries(cols)) {
      if (have.has(name)) continue;
      try { kidsDb.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`); }
      catch (e) { console.warn(`[kids] sqlite migration ${table}.${name} failed:`, e.message); }
    }
  }
  // Seed the configurable option lists (age groups, categories, languages,
  // platforms, resolutions, visual styles) at startup so the UI always has
  // defaults even when the Postgres Sanskriti_kids database is unreachable.
  // This mirrors what kidsInit() does for the PG branch, but uses SQLite
  // prepared statements so it works independently of the PG connection.
  try {
    for (const key of KIDS_OPTION_KEYS) {
      const defaults = KIDS_DEFAULT_OPTIONS[key] || [];
      // Check if options already exist (idempotent on restart).
      const existingRows = kidsDb.prepare(
        "SELECT option_key, option_value FROM kids_options WHERE option_key = ?").all(key);
      if (existingRows.length > 0) continue; // already seeded
      let order = 0;
      for (const value of defaults) {
        kidsDb.prepare(
          "INSERT INTO kids_options (option_key, option_value, sort_order) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
          .run(key, String(value).trim(), order++);
      }
    }
  } catch (e) {
    console.warn("[kids] option seeding failed:", e.message);
  }
} catch (e) {
  console.warn("[kids] sqlite fallback unavailable:", e.message);
  kidsDb = null;
}
const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS scenarios (
  name TEXT PRIMARY KEY,
  config JSONB NOT NULL,
  updated_at_ms BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS scenario_versions (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  version INT NOT NULL,
  config JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);
CREATE INDEX IF NOT EXISTS scenario_versions_name_idx ON scenario_versions (name);
CREATE TABLE IF NOT EXISTS projects (
  project_id SERIAL UNIQUE,
  name TEXT PRIMARY KEY,
  folder_name TEXT,
  description TEXT,
  duration INT,
  beats INT NOT NULL DEFAULT 0,
  master_prompt TEXT,
  project_type TEXT NOT NULL DEFAULT 'VIDEO' CHECK (project_type IN ('VIDEO', 'AUDIO')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS project_assets (
  id BIGSERIAL NOT NULL,
  project_id INTEGER NOT NULL,
  folder_name TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  scene_id INTEGER,
  beat_index INTEGER NOT NULL DEFAULT 0,
  beat_title TEXT,
  -- Director shot linkage (multi-shot scenes flatten to one beat per shot
  -- at approve time; each keyframe/clip row records which scene + shot it
  -- belongs to). All NULL for legacy single-shot beats and FINAL rows.
  scene_number INTEGER,
  shot_id TEXT,
  shot_number INTEGER,
  start_time DOUBLE PRECISION,
  end_time DOUBLE PRECISION,
  asset_type TEXT NOT NULL,
  video_type TEXT NOT NULL DEFAULT 'YOUTUBE',
  status TEXT NOT NULL DEFAULT 'PENDING',
  prompt TEXT,
  negative_prompt TEXT,
  file_path TEXT,
  model TEXT,
  workflow TEXT,
  seed BIGINT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  error_message TEXT,
  metadata JSONB,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT project_assets_pkey PRIMARY KEY (id),
  CONSTRAINT project_assets_project_fkey FOREIGN KEY (project_id)
    REFERENCES public.projects(project_id) ON DELETE CASCADE,
  CONSTRAINT project_assets_asset_type_check CHECK (
    asset_type IN ('REFERENCE', 'IMAGE', 'KEYFRAME', 'VIDEO', 'FINAL')),
  CONSTRAINT project_assets_video_type_check CHECK (
    video_type IN ('YOUTUBE', 'INSTAGRAM')),
  CONSTRAINT project_assets_status_check CHECK (
    status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'SKIPPED')),
  CONSTRAINT project_assets_version_check CHECK (version > 0),
  CONSTRAINT project_assets_beat_index_check CHECK (beat_index >= 0),
  CONSTRAINT project_assets_attempts_check CHECK (
    attempts >= 0 AND max_retries >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS project_assets_project_version_type_beat_key
  ON public.project_assets(project_id, version, asset_type, beat_index, video_type);
CREATE INDEX IF NOT EXISTS idx_project_assets_project_id ON public.project_assets(project_id);
CREATE INDEX IF NOT EXISTS idx_project_assets_scene_id ON public.project_assets(scene_id);
CREATE INDEX IF NOT EXISTS idx_project_assets_project_version_beat ON public.project_assets(project_id, version, beat_index);
CREATE INDEX IF NOT EXISTS idx_project_assets_asset_type ON public.project_assets(asset_type);
CREATE INDEX IF NOT EXISTS idx_project_assets_status ON public.project_assets(project_id, status);
CREATE INDEX IF NOT EXISTS idx_project_assets_metadata ON public.project_assets USING GIN (metadata);
CREATE OR REPLACE FUNCTION public.update_project_assets_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;
DROP TRIGGER IF EXISTS trg_project_assets_updated_at ON public.project_assets;
CREATE TRIGGER trg_project_assets_updated_at BEFORE UPDATE ON public.project_assets
FOR EACH ROW EXECUTE FUNCTION public.update_project_assets_updated_at();
-- Reference visuals live in their own table (a project has MANY master
-- prompts / reference images over time — one row per generation or upload).
-- project_assets no longer stores asset_type='REFERENCE' rows. is_main marks
-- the record selected as main on the UI (one per project + output dir);
-- pinned marks a deliberate user pick (manual select / upload) that keeps
-- winning over later auto generations.
CREATE TABLE IF NOT EXISTS project_references (
  id BIGSERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES public.projects(project_id) ON DELETE CASCADE,
  output_dir TEXT NOT NULL,
  version INTEGER,
  prompt TEXT,
  negative_prompt TEXT,
  file_path TEXT,
  model TEXT,
  workflow TEXT,
  seed BIGINT,
  attempts INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'generated' CHECK (source IN ('generated', 'upload')),
  video_type TEXT NOT NULL DEFAULT 'YOUTUBE',
  is_main BOOLEAN NOT NULL DEFAULT FALSE,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS project_references_one_main
  ON public.project_references(project_id, output_dir) WHERE is_main;
ALTER TABLE project_references DROP CONSTRAINT IF EXISTS project_references_video_type_check;
ALTER TABLE project_references ADD CONSTRAINT project_references_video_type_check
  CHECK (video_type IN ('YOUTUBE', 'INSTAGRAM'));
CREATE INDEX IF NOT EXISTS idx_project_references_project ON public.project_references(project_id);
-- Lyrics-to-song form data (Create Song tab, ACE-Step). One row per AUDIO
-- project (UNIQUE project_id, cascades with the project): the exact fields
-- the user filled in, so re-selecting the project restores the whole form.
-- The generated mp3s themselves stay on disk in outputs/<folder>/ and are
-- listed via GET /api/project/:name/songs.
CREATE TABLE IF NOT EXISTS project_songs (
  id BIGSERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL UNIQUE REFERENCES public.projects(project_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  folder_name TEXT,
  description TEXT,
  tags TEXT,
  lyrics TEXT,
  duration INTEGER,
  bpm INTEGER,
  language TEXT,
  keyscale TEXT,
  timesignature TEXT,
  seed BIGINT,
  steps INTEGER,
  -- Latest generated take (outputs/<folder>/<file>), refreshed on every
  -- save and the moment a song take finishes generating.
  file_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_project_songs_project ON public.project_songs(project_id);
-- AI Story Director boards (Saved Storyboards section). One row per board:
-- the full board JSON is canonical in the board column (upserted on every
-- write), the scalar columns are denormalized for cheap list reads.
-- director/*.json files remain on disk as the offline fallback / debug trail.
CREATE TABLE IF NOT EXISTS director_boards (
  board_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT,
  scene_count INTEGER,
  scenes_done INTEGER,
  -- Timed shots planned so far (sum over scenes of max(1, shots.length);
  -- one generation beat per shot at approve time). Denormalized like
  -- scene_count/scenes_done; the full shots live in the board JSONB.
  shot_count INTEGER,
  scenario_name TEXT,
  -- Approved storyboard -> generated project link. Set when the approved
  -- project is saved (Approve only returns a name+config; the client PUT
  -- creates the projects row, see pgLinkDirectorBoards). ON DELETE CASCADE
  -- so deleting a project removes its storyboard with it.
  project_id INTEGER REFERENCES projects(project_id) ON DELETE CASCADE,
  board JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_director_boards_updated ON director_boards(updated_at DESC);
-- Documentary Mode boards (separate from storyboards: chapters -> sequences
-- -> shots + narration + bibles). One row per documentary; the full board
-- JSON is canonical in the board column (upserted on every write), scalars
-- are denormalized for cheap list reads. documentary/*.json files remain as
-- the offline fallback / debug trail (same pattern as director_boards).
CREATE TABLE IF NOT EXISTS documentary_boards (
  board_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT,
  target_seconds INTEGER,
  shots_done INTEGER,
  shots_total INTEGER,
  scenario_name TEXT,
  project_id INTEGER REFERENCES projects(project_id) ON DELETE CASCADE,
  board JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_documentary_boards_updated ON documentary_boards(updated_at DESC);`;
/* NOTE: idx_director_boards_project is created in pgInit() AFTER the
   project_id ADD COLUMN migration — it must NOT live in this batch: on
   pre-existing installs the table exists without the column and the index
   build would throw (aborting all of pgInit before the migration runs). */
// NOTE: project_assets uses the narrow canonical DDL above (one row per
// asset: KEYFRAME / VIDEO / FINAL (+ IMAGE for ad-hoc stills), with a
// single status/prompt/file_path per row; scene_id is the INTEGER scene
// number (N = beat N). Reference visuals are NOT stored here anymore — they
// live in project_references (one row per generation/upload, is_main marks
// the UI-selected main). A TEXT scene_id from the previous
// revision is auto-migrated in pgInit(); the old wide table still needs a
// one-time DROP TABLE public.project_assets; to be recreated.
async function pgProbe() {
  // SQLite mode is fully standalone (see USE_SQLITE above): never touch
  // Postgres, so /api/health + /api/db polling can't spam warnings.
  if (USE_SQLITE) { pgUp = false; return false; }
  try { await pgPool.query("SELECT 1"); pgUp = true; }
  catch (e) {
    pgUp = false;
    const detail = String((e && e.message) || e || "").trim() || "connection failed";
    console.warn(`[pg] unreachable: ${detail} — gallery falls back to disk`);
  }
  return pgUp;
}
// Final-cut filename -> 1-based stitch version:
//   <prefix>_final.mp4 -> 1, <prefix>_final_vN.mp4 -> N, anything else -> null.
// A FINAL project_assets row is stored per stitch with beat_index = this
// version, so every Stitch click inserts a NEW row (the UNIQUE key is
// (project_id, version, asset_type, beat_index)).
function finalCutVersion(file) {
  const m = String(file || "").match(/_final(?:_v(\d+))?\.mp4$/);
  return m ? (m[1] ? Number(m[1]) : 1) : null;
}
// Full backfill on boot (scenarios / versions / projects for files created
// while the server was down). File lists always come from disk.
async function syncAllToPg() {
  if (!USE_SQLITE) {
    // Fresh Postgres: import any prompts/*.json once (mirrors the legacy
    // SQLite boot import) so existing CLI scenarios show up in the UI.
    try {
      const c = await pgPool.query("SELECT count(*)::int AS n FROM scenarios");
      if (c.rows[0].n === 0 && fs.existsSync(PROMPTS)) {
        for (const f of fs.readdirSync(PROMPTS).filter((f) => f.endsWith(".json"))) {
          try {
            const cfgText = fs.readFileSync(path.join(PROMPTS, f), "utf8");
            JSON.parse(cfgText); // skip invalid JSON
            await pgPool.query(
              `INSERT INTO scenarios (name, config, updated_at_ms) VALUES ($1, $2::jsonb, $3)
               ON CONFLICT (name) DO NOTHING`,
              [f.replace(/\.json$/, ""), cfgText, Math.round(fs.statSync(path.join(PROMPTS, f)).mtimeMs)]);
          } catch { /* skip unreadable prompt files */ }
        }
      }
    } catch (e) { console.warn("[pg] prompts import failed:", e.message); }
  }
  for (const r of await dbListScenarios()) {
    await pgPool.query(
      `INSERT INTO scenarios (name, config, updated_at_ms) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (name) DO UPDATE SET config = EXCLUDED.config, updated_at_ms = EXCLUDED.updated_at_ms`,
      [r.name, String(r.config), Math.round(Number(r.updated_at))]);
  }
  // Seed v1 for projects saved before versioning existed.
  await pgPool.query(
    `INSERT INTO scenario_versions (name, version, config)
     SELECT name, 1, config FROM scenarios s
     WHERE NOT EXISTS (SELECT 1 FROM scenario_versions v WHERE v.name = s.name)`);
  // Backfill projects + their latest version's asset rows. Delta-safe: only
  // snapshot when the project has NO asset rows at all (fresh/legacy
  // project); never backfill into an existing version, or unchanged scenes
  // would be duplicated into the latest delta version.
  const latest = await pgPool.query(
    "SELECT name, max(version) AS version FROM scenario_versions GROUP BY name");
  for (const { name, version } of latest.rows) {
    const raw = await dbGetScenario(name);
    if (raw === null) continue;
    try {
      const pid = await pgProjectId(name);
      if (pid != null) {
        const has = await pgPool.query(
          "SELECT 1 FROM project_assets WHERE project_id = $1 LIMIT 1", [pid]);
        if (has.rowCount) continue;
      }
      const cfg = JSON.parse(raw);
      // Backfill against the canonical folder (migrates legacy raw dirs
      // first so mains resolve from real files, not empty dirs).
      const folder = await migrateProjectStorage(name);
      await pgSaveProject(name, cfg, Number(version), mainsFor(folder, cfg), folder);
      // Reference mains (all four dirs) into project_references — skipped
      // when the project already has reference rows.
      await pgBackfillReferences(name, folder, cfg);
    } catch (e) { console.warn(`[pg] project backfill failed for ${name}:`, e.message); }
  }
  // Link pre-existing approved storyboards to their projects (installs that
  // predate director_boards.project_id). Name-matched only; later
  // saves/approves keep it exact via pgLinkDirectorBoards.
  try {
    const linked = await pgPool.query(
      `UPDATE director_boards b SET project_id = p.project_id,
         board = jsonb_set(b.board, '{project_id}', to_jsonb(p.project_id))
       FROM projects p
       WHERE b.scenario_name = p.name AND b.project_id IS NULL
       RETURNING b.board_id`);
    if (linked.rowCount) console.log(`[pg] director boards linked: ${linked.rowCount}`);
  } catch (e) { console.warn("[pg] director board backfill failed:", e.message); }
  console.log(`[pg] projects backfilled`);
}
async function pgSaveScenarioMirror(name, cfg) {
  if (!pgUp) return;
  await pgPool.query(
    `INSERT INTO scenarios (name, config, updated_at_ms) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (name) DO UPDATE SET config = EXCLUDED.config, updated_at_ms = EXCLUDED.updated_at_ms`,
    [name, JSON.stringify(cfg), Date.now()]);
}
async function pgDeleteScenarioMirror(name) {
  if (!pgUp) return;
  await pgPool.query("DELETE FROM scenarios WHERE name = $1", [name]);
  await pgPool.query("DELETE FROM scenario_versions WHERE name = $1", [name]);
  // Delete the project by its integer project_id (cascades to project_assets).
  const idRow = await pgPool.query("SELECT project_id FROM projects WHERE name = $1", [name]);
  const pid = idRow.rows[0]?.project_id;
  if (pid != null) await pgPool.query("DELETE FROM projects WHERE project_id = $1", [pid]); // cascades to project_assets
  else await pgPool.query("DELETE FROM projects WHERE name = $1", [name]); // pre-migration fallback
}
// Resolve a project's integer project_id from its name (all project_assets
// CRUD keys off project_id, never the name).
async function pgProjectId(name) {
  const r = await pgPool.query("SELECT project_id FROM projects WHERE name = $1", [name]);
  return r.rows[0]?.project_id ?? null;
}
// Project kind (projects.project_type): VIDEO = normal video project,
// AUDIO = saved from the Create Song tab (audio generation). New rows
// default to VIDEO; an existing row keeps its value unless an explicit type
// is passed (so a plain re-save never flips AUDIO back to VIDEO).
const PROJECT_TYPES = new Set(["VIDEO", "AUDIO"]);
const normalizeProjectType = (v) => {
  const s = String(v ?? "").trim().toUpperCase();
  return PROJECT_TYPES.has(s) ? s : null;
};
const explicitProjectType = (cfg) =>
  cfg && typeof cfg === "object" ? normalizeProjectType(cfg.project_type) : null;
// Upsert one row in projects and return its project_id. This is what "Craft
// scenario saves to projects" means: the project exists from the moment it
// is crafted, before any version/asset rows. Save Scenario later reuses the
// same project_id for its project_assets rows (see pgSaveProject).
// folder_name is set ONCE on INSERT and never updated on subsequent saves.
async function pgEnsureProject(name, cfg, projectType = undefined) {
  const seq = Array.isArray(cfg.sequence) ? cfg.sequence : [];
  // folder_name is minted ONCE (unique) and then frozen — re-saves and
  // renames never change it, so output dirs and DB paths stay stable.
  let fn = await getFolderNameFromRow(name);
  if (!fn) fn = await ensureUniqueFolder(name, name);
  // Explicit type wins (Create Song saves AUDIO); otherwise a new row
  // defaults to VIDEO and an existing row keeps whatever it already has.
  const pt = normalizeProjectType(projectType ?? explicitProjectType(cfg));
  const proj = await pgPool.query(
    `INSERT INTO projects (name, folder_name, description, duration, beats, master_prompt, project_type, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'VIDEO'), now())
     ON CONFLICT (name) DO UPDATE SET
        folder_name = COALESCE(NULLIF(projects.folder_name, ''), EXCLUDED.folder_name),
       description = EXCLUDED.description, duration = EXCLUDED.duration, beats = EXCLUDED.beats,
       master_prompt = COALESCE(EXCLUDED.master_prompt, projects.master_prompt),
       project_type = COALESCE($7, projects.project_type, 'VIDEO'),
       updated_at = now()
     RETURNING project_id`,
    [name, fn, cfg.description ?? null,
     Number.isFinite(Number(cfg.duration)) ? Number(cfg.duration) : null, seq.length,
     cfg.referencePrompt ?? null, pt]);
  const projectId = proj.rows[0]?.project_id;
  if (projectId == null) throw new Error(`pgEnsureProject: no project_id for ${name}`);
  return projectId;
}
// Latest generated song take in an output folder: <prefix>_song.mp3 (v1),
// <prefix>_song_vN.mp3 (v2+) — highest version wins. Returns the stored
// relative path (outputs/<folder>/<file>) or null when nothing rendered yet.
function latestSongFile(folder) {
  try {
    const dir = path.join(OUTPUTS, folder);
    if (!folder || !fs.existsSync(dir)) return null;
    const prefix = prefixForDir(folder);
    let best = null;
    for (const f of fs.readdirSync(dir)) {
      if (!SONG_FILE_RE.test(f)) continue;
      const stem = f.slice(0, -".mp3".length);
      const m = stem.match(/_song_v(\d+)$/);
      const v = m ? Number(m[1]) : (stem === `${prefix}_song` ? 1 : 0);
      if (!v) continue;
      if (!best || v > best.v) best = { file: f, v };
    }
    return best ? `outputs/${folder}/${best.file}` : null;
  } catch { return null; }
}
// Upsert the Create Song form fields into project_songs (one row per
// project). Called on every AUDIO save carrying an `audio` block, so the
// Lyrics-to-song workspace can restore the exact form later via
// GET /api/project/:name/song. No-op for non-audio configs.
async function pgUpsertProjectSong(name, cfg, projectId, folder) {
  const a = cfg && typeof cfg === "object" && cfg.audio && typeof cfg.audio === "object" ? cfg.audio : null;
  if (!a || projectId == null) return;
  const num = (v, fb) => (Number.isFinite(Number(v)) ? Number(v) : fb);
  const songFile = latestSongFile(folder);
  await pgPool.query(
    `INSERT INTO project_songs (project_id, name, folder_name, description, tags, lyrics,
      duration, bpm, language, keyscale, timesignature, seed, steps, file_path,
      song_preset, song_vocal, cfg_scale, temperature, song_model, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, now())
     ON CONFLICT (project_id) DO UPDATE SET
       name = EXCLUDED.name, folder_name = EXCLUDED.folder_name,
       description = EXCLUDED.description, tags = EXCLUDED.tags, lyrics = EXCLUDED.lyrics,
       duration = EXCLUDED.duration, bpm = EXCLUDED.bpm, language = EXCLUDED.language,
       keyscale = EXCLUDED.keyscale, timesignature = EXCLUDED.timesignature,
       seed = EXCLUDED.seed, steps = EXCLUDED.steps,
       file_path = COALESCE(EXCLUDED.file_path, project_songs.file_path),
       song_preset = EXCLUDED.song_preset, song_vocal = EXCLUDED.song_vocal,
       cfg_scale = EXCLUDED.cfg_scale, temperature = EXCLUDED.temperature,
       song_model = EXCLUDED.song_model,
       updated_at = now()`,
    [projectId, name, folder ?? null,
     typeof cfg.description === "string" ? cfg.description : null,
     typeof a.tags === "string" ? a.tags : null,
     typeof a.lyrics === "string" ? a.lyrics : null,
     num(a.duration, null), num(a.bpm, null),
     typeof a.language === "string" ? a.language : null,
     typeof a.keyscale === "string" ? a.keyscale : null,
     typeof a.timesignature === "string" ? a.timesignature : null,
     num(a.seed, null), num(a.steps, null), songFile,
     typeof a.songPreset === "string" ? a.songPreset : null,
     typeof a.songVocal === "string" ? a.songVocal : null,
     num(a.cfgScale, null), num(a.temperature, null),
     a.songModel === "ace-step" || a.songModel === "minimax" ? a.songModel : null]);
}
// Mirror an AI Story Director board into Postgres (director_boards, one row
// per board). Called on every board write, so the Saved Storyboards section
// is DB-backed; file writes continue as the offline fallback. No-op when the
// DB is down or the board has no id.
async function pgUpsertDirectorBoard(board) {
  if (!pgUp || !board || typeof board !== "object" || !board.id) return;
  const scenes = Array.isArray(board.scenes) ? board.scenes.length : 0;
  // Timed shots planned so far (one generation beat per shot at approve).
  const shots = Array.isArray(board.scenes)
    ? board.scenes.reduce((a, s) => a + Math.max(1, Array.isArray(s.shots) ? s.shots.length : 0), 0)
    : 0;
  const pid = Number.isInteger(board.project_id) ? board.project_id : null;
  await pgPool.query(
    `INSERT INTO director_boards (board_id, title, status, scene_count, scenes_done,
      shot_count, scenario_name, project_id, board, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, COALESCE($10::timestamptz, now()), now())
     ON CONFLICT (board_id) DO UPDATE SET
       title = EXCLUDED.title, status = EXCLUDED.status,
       scene_count = EXCLUDED.scene_count, scenes_done = EXCLUDED.scenes_done,
       shot_count = EXCLUDED.shot_count,
       scenario_name = EXCLUDED.scenario_name, board = EXCLUDED.board,
       updated_at = now(),
       -- Never unlink via a stale board object: only a non-null incoming id
       -- overwrites (linking flows always carry the id; plain board edits
       -- round-trip it through the board JSON).
       project_id = COALESCE(EXCLUDED.project_id, director_boards.project_id)`,
    [String(board.id),
     String((board.input && board.input.title) || board.id),
     board.status ?? null,
     Number.isFinite(Number(board.sceneCount)) ? Number(board.sceneCount) : null,
     scenes,
     shots,
     board.scenarioName ?? null,
     pid,
     JSON.stringify(board),
     board.createdAt ?? null]);
}
// Link every storyboard approved as project `name` to its projects row.
// Approve only returns a name+config (the client PUT creates the row), so
// the link is applied on save — plus at approve time when the row exists
// (re-approve / migrate-remaining) and once at boot for older installs.
// Column, DB JSON and the offline-fallback file are updated together so a
// later board edit (which upserts the whole object) can never unlink it.
async function pgLinkDirectorBoards(name, pid) {
  if (!pgUp || !name || pid == null) return;
  try {
    await pgPool.query(
      `UPDATE director_boards SET project_id = $2,
         board = jsonb_set(board, '{project_id}', to_jsonb($2::int))
       WHERE scenario_name = $1 AND (project_id IS NULL OR project_id <> $2)`,
      [name, pid]);
    const r = await pgPool.query(
      "SELECT board_id FROM director_boards WHERE scenario_name = $1", [name]);
    for (const row of r.rows) {
      const f = path.join(DIRECTOR, `${row.board_id}.json`);
      try {
        if (fs.existsSync(f)) {
          const b = JSON.parse(fs.readFileSync(f, "utf8"));
          if (b.project_id !== pid) {
            b.project_id = pid;
            fs.writeFileSync(f, JSON.stringify(b, null, 2));
          }
        }
      } catch { /* file patch is best-effort; the DB row is canonical */ }
    }
  } catch (e) { console.warn("[pg] director board link failed:", e.message); }
}
// Delete a director board row (called alongside the file delete).
async function pgDeleteDirectorBoard(id) {
  if (!pgUp) return;
  await pgPool.query("DELETE FROM director_boards WHERE board_id = $1", [String(id)]);
}
// Follow a project rename on its linked storyboards (scenario_name is the
// human label; project_id never changes since projects rows keep their id).
async function renameDirectorBoardsForProject(oldName, newName) {
  if (pgUp) {
    try {
      await pgPool.query(
        `UPDATE director_boards SET scenario_name = $2,
           board = jsonb_set(board, '{scenarioName}', to_jsonb($2::text))
         WHERE scenario_name = $1 OR project_id = (SELECT project_id FROM projects WHERE name = $2)`,
        [oldName, newName]);
    } catch (e) { console.warn("[pg] director boards rename failed:", e.message); }
  }
  // Offline-fallback files (and SQLite mode, which has no director table).
  try {
    fs.mkdirSync(DIRECTOR, { recursive: true });
    for (const f of fs.readdirSync(DIRECTOR).filter((f) => f.endsWith(".json") && !f.startsWith("_raw"))) {
      try {
        const full = path.join(DIRECTOR, f);
        const b = JSON.parse(fs.readFileSync(full, "utf8"));
        if (b && typeof b === "object" && b.scenarioName === oldName) {
          b.scenarioName = newName;
          fs.writeFileSync(full, JSON.stringify(b, null, 2));
          if (pgUp) pgUpsertDirectorBoard(b).catch(() => {});
        }
      } catch { /* skip corrupt files */ }
    }
  } catch { /* best-effort */ }
}
// Remove every storyboard tied to a deleted project: linked rows (also
// covered by the ON DELETE CASCADE FK — this is belt-and-braces plus the
// scenario_name-matched leftovers) and their JSON files, so a deleted
// project can never resurrect its board through the file backfill.
// Unapproved drafts (no scenarioName/project) are untouched.
async function deleteDirectorBoardsForProject(name) {
  const ids = new Set();
  if (pgUp) {
    try {
      const r = await pgPool.query(
        `SELECT board_id FROM director_boards
          WHERE scenario_name = $1 OR project_id = (SELECT project_id FROM projects WHERE name = $1)`,
        [name]);
      for (const row of r.rows) ids.add(String(row.board_id));
    } catch (e) { console.warn("[pg] director boards lookup failed:", e.message); }
  }
  try {
    fs.mkdirSync(DIRECTOR, { recursive: true });
    for (const f of fs.readdirSync(DIRECTOR).filter((f) => f.endsWith(".json") && !f.startsWith("_raw"))) {
      try {
        const b = JSON.parse(fs.readFileSync(path.join(DIRECTOR, f), "utf8"));
        if (b && b.id && (ids.has(String(b.id)) || b.scenarioName === name)) ids.add(String(b.id));
      } catch { /* skip corrupt files */ }
    }
  } catch { /* best-effort */ }
  for (const id of ids) {
    try { fs.rmSync(path.join(DIRECTOR, `${id}.json`), { force: true }); } catch { /* keep going */ }
  }
  if (pgUp && ids.size) {
    try { await pgPool.query("DELETE FROM director_boards WHERE board_id = ANY($1)", [[...ids]]); }
    catch (e) { console.warn("[pg] director boards delete failed:", e.message); }
  }
  return ids.size;
}
// ---- Documentary Mode mirrors (documentary_boards, one row per board) ----
// Same pattern as pgUpsertDirectorBoard: every board write upserts the full
// JSON (canonical) plus scalar columns for cheap list reads. Files in
// documentary/*.json remain the offline fallback.
async function pgUpsertDocBoard(board) {
  if (!pgUp || !board || typeof board !== "object" || !board.id) return;
  const total = countBoardShots(board);
  const pid = Number.isInteger(board.project_id) ? board.project_id : null;
  await pgPool.query(
    `INSERT INTO documentary_boards (board_id, title, status, target_seconds, shots_done, shots_total,
      scenario_name, project_id, board, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, COALESCE($10::timestamptz, now()), now())
     ON CONFLICT (board_id) DO UPDATE SET
       title = EXCLUDED.title, status = EXCLUDED.status,
       target_seconds = EXCLUDED.target_seconds, shots_done = EXCLUDED.shots_done,
       shots_total = EXCLUDED.shots_total, scenario_name = EXCLUDED.scenario_name,
       board = EXCLUDED.board, updated_at = now(),
       project_id = COALESCE(EXCLUDED.project_id, documentary_boards.project_id)`,
    [String(board.id),
     String((board.brief && board.brief.title) || board.id),
     board.status ?? null,
     Number.isFinite(Number(board.brief && board.brief.targetSeconds)) ? Number(board.brief.targetSeconds) : null,
     Array.isArray(board.chapters) ? board.chapters.reduce((a, c) => a + (Array.isArray(c.sequences) ? c.sequences.reduce((x, q) => x + (Array.isArray(q.shots) ? q.shots.length : 0), 0) : 0), 0) : 0,
     total,
     board.scenarioName ?? null,
     pid,
     JSON.stringify(board),
     board.createdAt ?? null]);
}
async function pgLinkDocBoards(name, pid) {
  if (!pgUp || !name || pid == null) return;
  try {
    await pgPool.query(
      `UPDATE documentary_boards SET project_id = $2,
         board = jsonb_set(board, '{project_id}', to_jsonb($2::int))
       WHERE scenario_name = $1 AND (project_id IS NULL OR project_id <> $2)`,
      [name, pid]);
  } catch (e) { console.warn("[pg] documentary board link failed:", e.message); }
}
async function pgDeleteDocBoard(id) {
  if (!pgUp) return;
  await pgPool.query("DELETE FROM documentary_boards WHERE board_id = $1", [String(id)]);
}
// Explicit Save = new version of the same project (v1, v2, …). Never overwrites.
async function pgSaveVersion(name, cfg) {
  const r = await pgPool.query(
    `INSERT INTO scenario_versions (name, version, config)
     VALUES ($1, COALESCE((SELECT max(version) FROM scenario_versions WHERE name = $1), 0) + 1, $2::jsonb)
     RETURNING version`,
    [name, JSON.stringify(cfg)]);
  return r.rows[0].version;
}
// Current main files for a project (nulls when nothing generated yet).
function mainsFor(dirName, cfg) {
  const out = { ref: null, beats: {}, final: null, finalV: null };
  try {
    const dir = path.join(OUTPUTS, dirName);
    if (!fs.existsSync(dir)) return out;
    const seq = Array.isArray(cfg.sequence) ? cfg.sequence : [];
    const vm = versionMap(dir, prefixFor(dirName), seq);
    out.ref = vm.refMain ?? null;
    out.beats = vm.beats ?? {};
    out.final = vm.finalMain ?? null;
    out.finalV = (vm.final || []).find((x) => x.file === out.final)?.v ?? null;
  } catch { /* unversionable dir — mains stay null */ }
  return out;
}
// ---------------------------------------------------------------- project_assets mapping
// Canonical table: public.project_assets (narrow DDL — one row per asset).
//   asset_type='KEYFRAME',  beat_index=N -> beat N Flux keyframe (b.image)
//   asset_type='VIDEO',     beat_index=N -> beat N i2v clip (b.motion)
//   asset_type='FINAL',     beat_index=V -> stitch V of the final cut
//     (v1 = <prefix>_final.mp4, vN = <prefix>_final_vN.mp4; one NEW row per
//     stitch, scene_id 0, workflow 'ffmpeg-concat')
// Reference visuals are NOT rows here — they live in project_references
// (one row per generation/upload, is_main = UI-selected main).
// ('IMAGE' is valid for ad-hoc stills; this pipeline writes KEYFRAME.)
// Each row has its own prompt/status/file_path/model/workflow/attempts/
// metadata/started_at/completed_at. Size/dims live inside metadata JSONB.
const REF_MODEL = "flux-2-klein-4b-fp8";
const IMG_MODEL = "flux-2-klein-4b-fp8";
const LTX_MODEL = "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot";
const WAN_MODEL = "wan2.1-i2v-14b-480p-Q4_K_M.gguf";
const REF_WORKFLOW = "flux-t2i";
const IMG_WORKFLOW = "flux-t2i";
const LTX_WORKFLOW = "ltx2_5_i2v";
const WAN_WORKFLOW = "image_to_video_wan";
const mimeFor = (file) => {
  const e = path.extname(String(file || "")).toLowerCase();
  if (e === ".png") return "image/png";
  if (e === ".jpg" || e === ".jpeg") return "image/jpeg";
  if (e === ".webp") return "image/webp";
  if (e === ".mp4") return "video/mp4";
  if (e === ".wav") return "audio/wav";
  return null;
};
// Best-effort PNG dimensions (IHDR) — null when unreadable/non-PNG.
function pngDims(fullPath) {
  try {
    const fd = fs.openSync(fullPath, "r");
    const buf = Buffer.alloc(26);
    const n = fs.readSync(fd, buf, 0, 26, 0);
    fs.closeSync(fd);
    if (n < 26) return null;
    if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch { return null; }
}
// Disk facts for one output file (nulls when the file is missing — the row
// still records prompts/status, file columns stay NULL).
function diskFacts(outputFolder, file) {
  if (!file) return { bytes: null, mime: null, w: null, h: null };
  try {
    const full = path.join(OUTPUTS, outputFolder, file);
    const st = fs.statSync(full);
    if (!st.isFile()) return { bytes: null, mime: null, w: null, h: null };
    const dims = file.toLowerCase().endsWith(".png") ? pngDims(full) : null;
    return { bytes: st.size, mime: mimeFor(file), w: dims?.w ?? null, h: dims?.h ?? null };
  } catch { return { bytes: null, mime: null, w: null, h: null }; }
}
const engineForFolder = (folder) => engineForDir(folder);
// Project info row + that version's asset rows (prompts + current main files).
// SNAPSHOT path — used ONLY for version 1 and for backfilling projects that
// have no project_assets rows yet. For v2+ use pgSaveVersionDelta() below,
// which inserts ONLY the changed scenes (delta-based versioning).
// Narrow schema: ONE ROW PER ASSET —
//   asset_type='KEYFRAME',  beat_index=N        -> beat N Flux keyframe (b.image)
//   asset_type='VIDEO',     beat_index=N        -> beat N i2v clip (b.motion)
// ('IMAGE' stays valid for ad-hoc single stills; this pipeline writes
// KEYFRAME for beat images. Reference visuals live in project_references.)
// Each row carries its own prompt/status/
// file_path/model/workflow/attempts/metadata/timing. Size/dims live inside
// metadata (no width/height columns in the narrow DDL).
// Existing COMPLETED rows are never downgraded back to PENDING.
// Seed INSTAGRAM (vertical Reel cut) rows from an existing vertical output
// dir: one COMPLETED row per beat that already has a main file on disk, plus
// the vertical FINAL when stitched. Landscape saves stay YOUTUBE-only;
// vertical generations fill rows via pgMarkAssetComplete. `query` is a
// (text, params) function (pool or transaction client).
async function pgSeedInstagramRows(query, projectId, folder, engine, cfg, version) {
  try {
    const seq = Array.isArray(cfg.sequence) ? cfg.sequence : [];
    if (!seq.length) return 0;
    const vdir = outDirName(folder, engine, "vertical");
    if (!fs.existsSync(path.join(OUTPUTS, vdir))) return 0;
    const vm = versionMap(path.join(OUTPUTS, vdir), prefixForDir(vdir), seq);
    const UPSERT_IG = `INSERT INTO project_assets (
      project_id, folder_name, version, scene_id, beat_index, beat_title,
      scene_number, shot_id, shot_number, start_time, end_time,
      asset_type, video_type, status, prompt, negative_prompt, file_path,
      model, workflow, attempts, max_retries, metadata, started_at, completed_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'INSTAGRAM', $13, $14, $15, $16, $17, $18, $19, 3, $20::jsonb,
      $21::timestamptz, $22::timestamptz
    )
    ON CONFLICT (project_id, version, asset_type, beat_index, video_type) DO UPDATE SET
      folder_name = EXCLUDED.folder_name,
      scene_id = EXCLUDED.scene_id, beat_title = EXCLUDED.beat_title,
      scene_number = EXCLUDED.scene_number, shot_id = EXCLUDED.shot_id,
      shot_number = EXCLUDED.shot_number, start_time = EXCLUDED.start_time,
      end_time = EXCLUDED.end_time,
      prompt = EXCLUDED.prompt, negative_prompt = EXCLUDED.negative_prompt,
      file_path = COALESCE(EXCLUDED.file_path, project_assets.file_path),
      model = EXCLUDED.model, workflow = EXCLUDED.workflow,
      attempts = GREATEST(project_assets.attempts, EXCLUDED.attempts),
      metadata = COALESCE(EXCLUDED.metadata, project_assets.metadata),
      status = CASE WHEN EXCLUDED.file_path IS NOT NULL THEN 'COMPLETED' ELSE project_assets.status END,
      started_at = CASE WHEN EXCLUDED.file_path IS NOT NULL AND project_assets.started_at IS NULL THEN now() ELSE project_assets.started_at END,
      completed_at = CASE WHEN EXCLUDED.file_path IS NOT NULL THEN now() ELSE project_assets.completed_at END`;
    const nowISO = new Date().toISOString();
    const negative = cfg.negative ?? null;
    const videoModel = engine === "wan" ? WAN_MODEL : LTX_MODEL;
    const videoWorkflow = engine === "wan" ? WAN_WORKFLOW : LTX_WORKFLOW;
    const relPath = (file) => (file ? `outputs/${vdir}/${file}` : null);
    let seeded = 0;
    for (let i = 0; i < seq.length; i++) {
      const b = seq[i] || {};
      const n = i + 1;
      const bv = (vm.beats && vm.beats[String(n)]) || {};
      const kf = bv.keyframeMain ?? null;
      const cl = bv.clipMain ?? null;
      const [scNum, shId, shNum, t0, t1] = shotColumns(b);
      if (kf) {
        await query(UPSERT_IG, [projectId, folder, version, n, n, b.title ?? null,
          scNum, shId, shNum, t0, t1, "KEYFRAME",
          "COMPLETED", b.image ?? null, negative, relPath(kf), IMG_MODEL, IMG_WORKFLOW, 1,
          JSON.stringify({ engine, format: "vertical", video_type: "INSTAGRAM", file: kf, beat: n, ...diskFacts(vdir, kf) }), nowISO, nowISO]);
        seeded++;
      }
      if (cl) {
        await query(UPSERT_IG, [projectId, folder, version, n, n, b.title ?? null,
          scNum, shId, shNum, t0, t1, "VIDEO",
          "COMPLETED", b.motion ?? null, negative, relPath(cl), videoModel, videoWorkflow, 1,
          JSON.stringify({ engine, format: "vertical", video_type: "INSTAGRAM", file: cl, beat: n, ...diskFacts(vdir, cl) }), nowISO, nowISO]);
        seeded++;
      }
    }
    const finals = [...(vm.final ?? [])].sort((a, b) => a.v - b.v);
    const fin = finals.length ? finals[finals.length - 1].file : null;
    if (fin) {
      const finalV = finalCutVersion(fin) ?? 1;
      await query(UPSERT_IG, [projectId, folder, version, 0, finalV, null, "FINAL",
        "COMPLETED", null, negative, relPath(fin), null, "ffmpeg-concat", 1,
        JSON.stringify({ engine, format: "vertical", video_type: "INSTAGRAM", file: fin, final_version: finalV, ...diskFacts(vdir, fin) }), nowISO, nowISO]);
      seeded++;
    }
    return seeded;
  } catch (e) {
    console.warn("[pg] instagram seed failed:", e.message);
    return 0;
  }
}
async function pgSaveProject(name, cfg, version, mains, outputFolder = null) {
  // Fail fast with a clear message instead of a cryptic
  // project_assets_version_check violation deep in the loop below.
  if (latestVersionOf(version) == null)
    throw new Error(`pgSaveProject: refusing phantom version ${JSON.stringify(version)} for ${name} (must be >= 1)`);
  // Asset rows carry the STORED immutable folder (a rename must not rewrite
  // history paths). outputFolder defaults to it when the caller passes none.
  const folderSlug = (await getFolderNameFromRow(name)) || folderName(name);
  const seq = Array.isArray(cfg.sequence) ? cfg.sequence : [];
  const projectId = await pgEnsureProject(name, cfg);
  const folder = outputFolder ?? folderSlug;
  const engine = engineForFolder(folder);
  const videoModel = engine === "wan" ? WAN_MODEL : LTX_MODEL;
  const videoWorkflow = engine === "wan" ? WAN_WORKFLOW : LTX_WORKFLOW;
  const videoFps = engine === "wan" ? 16 : 24;
  const videoDur = Number.isFinite(Number(cfg.duration)) ? Number(cfg.duration) : null;
  const negative = cfg.negative ?? null;
  const done = (file) => (file ? "COMPLETED" : "PENDING");
  // scene_id is the integer scene number from the AI breakdown: 0 for the
  // reference visual, N for beat N (its KEYFRAME + VIDEO rows share it).
  const sceneId = (beat) => beat;
  const relPath = (file) => (file ? `outputs/${folder}/${file}` : null);
  const UPSERT = `INSERT INTO project_assets (
    project_id, folder_name, version, scene_id, beat_index, beat_title,
    scene_number, shot_id, shot_number, start_time, end_time,
    asset_type, video_type, status, prompt, negative_prompt, file_path,
    model, workflow, attempts, max_retries, metadata, started_at, completed_at
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'YOUTUBE', $13, $14, $15, $16, $17, $18, $19, 3, $20::jsonb,
    $21::timestamptz, $22::timestamptz
  )
  ON CONFLICT (project_id, version, asset_type, beat_index, video_type) DO UPDATE SET
    folder_name = EXCLUDED.folder_name,
    scene_id = EXCLUDED.scene_id, beat_title = EXCLUDED.beat_title,
    scene_number = EXCLUDED.scene_number, shot_id = EXCLUDED.shot_id,
    shot_number = EXCLUDED.shot_number, start_time = EXCLUDED.start_time,
    end_time = EXCLUDED.end_time,
    prompt = EXCLUDED.prompt, negative_prompt = EXCLUDED.negative_prompt,
    file_path = COALESCE(EXCLUDED.file_path, project_assets.file_path),
    model = EXCLUDED.model, workflow = EXCLUDED.workflow,
    attempts = GREATEST(project_assets.attempts, EXCLUDED.attempts),
    metadata = COALESCE(EXCLUDED.metadata, project_assets.metadata),
    status = CASE WHEN EXCLUDED.file_path IS NOT NULL THEN 'COMPLETED' ELSE project_assets.status END,
    started_at = CASE WHEN EXCLUDED.file_path IS NOT NULL AND project_assets.started_at IS NULL THEN now() ELSE project_assets.started_at END,
    completed_at = CASE WHEN EXCLUDED.file_path IS NOT NULL THEN now() ELSE project_assets.completed_at END`;
  const nowISO = new Date().toISOString();
  // No REFERENCE row here — reference visuals live in project_references
  // (one row per generation/upload, recorded on completion).
  for (let i = 0; i < seq.length; i++) {
    const b = seq[i] || {};
    const n = i + 1;
    const bm = (mains.beats && mains.beats[String(n)]) || {};
    const kf = bm.keyframeMain ?? null;
    const cl = bm.clipMain ?? null;
    const kfFacts = diskFacts(folder, kf);
    const clFacts = diskFacts(folder, cl);
    const [scNum, shId, shNum, t0, t1] = shotColumns(b);
    await pgPool.query(UPSERT, [projectId, folderSlug, version, sceneId(n), n, b.title ?? null,
      scNum, shId, shNum, t0, t1,
      "KEYFRAME", done(kf), b.image ?? null, negative,
      relPath(kf), IMG_MODEL, IMG_WORKFLOW, kf ? 1 : 0,
      kf ? JSON.stringify({ engine, video_type: "YOUTUBE", file: kf, beat: n, ...kfFacts }) : null,
      kf ? nowISO : null, kf ? nowISO : null]);
    const img = cfg.image; // optional still from AI Craft
    if (img) {
      await pgPool.query(UPSERT, [projectId, folderSlug, version, sceneId(n), n, null,
        null, null, null, null, null,
        "IMAGE", done(img), cfg.imagePrompt ?? null, null, relPath(img),
        IMG_MODEL, IMG_WORKFLOW, img ? 1 : 0,
        img ? JSON.stringify({ engine, file: img }) : null,
        nowISO, nowISO]);
    }
    await pgPool.query(UPSERT, [projectId, folderSlug, version, sceneId(n), n, b.title ?? null,
      scNum, shId, shNum, t0, t1,
      "VIDEO", done(cl), b.motion ?? null, negative,
      relPath(cl), videoModel, videoWorkflow, cl ? 1 : 0,
      cl ? JSON.stringify({ engine, video_type: "YOUTUBE", file: cl, beat: n, fps: videoFps, duration: videoDur, ...clFacts }) : null,
      cl ? nowISO : null, cl ? nowISO : null]);
  }
  // Stitched final cut (one row per stitch; beat_index = stitch version).
  if (mains.final) {
    const finalV = mains.finalV ?? finalCutVersion(mains.final) ?? 1;
    const ff = diskFacts(folder, mains.final);
    await pgPool.query(UPSERT, [projectId, folderSlug, version, 0, finalV, null,
      null, null, null, null, null,
      "FINAL", "COMPLETED", null, negative,
      relPath(mains.final), null, "ffmpeg-concat", 1,
      JSON.stringify({ engine, video_type: "YOUTUBE", file: mains.final, final_version: finalV, ...ff }),
      nowISO, nowISO]);
  }
  // Mirror any already-rendered vertical cut into INSTAGRAM rows (same beats).
  await pgSeedInstagramRows((t, p) => pgPool.query(t, p), projectId, folder, engine, cfg, version);
  return projectId;
}
// ---------------------------------------------------------------- delta versioning
// Delta-based save: version = logical revision, asset row = only the
// change generated at that revision. Unchanged scenes keep resolving to
// their previous rows via EFFECTIVE_ASSETS_SQL (latest row per
// (beat_index, asset_type) with version <= requested).
//
// Runs in ONE transaction: insert scenario_versions row, then insert ONLY
// PENDING rows for changed scenes (file_path NULL — generation fills them
// later via pgMarkAssetComplete, which never bumps the version). New delta
// rows never copy old file_paths, and unchanged beats get zero rows.
// Retries/status/progress updates never call this — only an actual
// prompt/scene change does.
async function pgSaveVersionDelta(name, prevCfg, cfg, projectType = undefined) {
  const client = await pgPool.connect();
  try {
    await client.query("BEGIN");
    const vRow = await client.query(
      `INSERT INTO scenario_versions (name, version, config)
       VALUES ($1, COALESCE((SELECT max(version) FROM scenario_versions WHERE name = $1), 0) + 1, $2::jsonb)
       RETURNING version`,
      [name, JSON.stringify(cfg)]);
    const version = vRow.rows[0].version;
    const seq = Array.isArray(cfg.sequence) ? cfg.sequence : [];
    // Immutable storage folder for every row/version written below — the
    // stored one when the project exists, else a freshly minted unique one.
    // Never recomputed from the (possibly renamed) display name per row.
    let folder;
    try {
      const fRow = await client.query("SELECT folder_name FROM projects WHERE name = $1", [name]);
      folder = fRow.rows[0]?.folder_name || null;
    } catch { folder = null; }
    folder ||= await ensureUniqueFolder(name, name);
    // Same project_type rule as pgEnsureProject: explicit wins, new rows
    // default to VIDEO, existing rows are otherwise preserved.
    const deltaPt = normalizeProjectType(projectType ?? explicitProjectType(cfg));
    const proj = await client.query(
      `INSERT INTO projects (name, folder_name, description, duration, beats, master_prompt, project_type, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'VIDEO'), now())
       ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description,
         duration = EXCLUDED.duration, beats = EXCLUDED.beats,
         master_prompt = COALESCE(EXCLUDED.master_prompt, projects.master_prompt),
         project_type = COALESCE($7, projects.project_type, 'VIDEO'),
         updated_at = now()
       RETURNING project_id`,
      [name, folder, cfg.description ?? null,
        Number.isFinite(Number(cfg.duration)) ? Number(cfg.duration) : null, seq.length,
        cfg.referencePrompt ?? null, deltaPt]);
    const projectId = proj.rows[0]?.project_id;
    if (projectId == null) throw new Error(`pgSaveVersionDelta: no project_id for ${name}`);
    const previousVersion = Number(version) - 1;
    const plan = planDelta(prevCfg, cfg);
    const negative = cfg.negative ?? null;
    const INSERT = `INSERT INTO project_assets (
      project_id, folder_name, version, scene_id, beat_index, beat_title,
      scene_number, shot_id, shot_number, start_time, end_time,
      asset_type, video_type, status, prompt, negative_prompt, file_path,
      model, workflow, attempts, max_retries, metadata
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'YOUTUBE', 'PENDING', $13, $14, NULL, $15, $16, 0, 3, $17::jsonb
    )
    ON CONFLICT (project_id, version, asset_type, beat_index, video_type) DO UPDATE SET
      folder_name = EXCLUDED.folder_name,
      scene_id = EXCLUDED.scene_id, beat_title = EXCLUDED.beat_title,
      scene_number = EXCLUDED.scene_number, shot_id = EXCLUDED.shot_id,
      shot_number = EXCLUDED.shot_number, start_time = EXCLUDED.start_time,
      end_time = EXCLUDED.end_time,
      prompt = EXCLUDED.prompt, negative_prompt = EXCLUDED.negative_prompt,
      model = EXCLUDED.model, workflow = EXCLUDED.workflow,
      metadata = COALESCE(EXCLUDED.metadata, project_assets.metadata)`;
    const insertedIds = [];
    const changedScenes = [];
    const changedAssetTypes = [];
    if (Number(version) === 1) {
      // v1 = full snapshot: every scene gets its row (with current main
      // files, as pgSaveProject does). Reference visuals are NOT snapshotted
      // here — they live in project_references (one row per generation).
      // `folder` is the transaction-resolved immutable storage folder above.
      const mains = mainsFor(folder, cfg);
      const engine = engineForFolder(folder);
      const full = async (sceneId, beat, title, type, prompt, model, workflow, file, meta, shot = null) => {
      const [scNum, shId, shNum, t0, t1] = shot || [null, null, null, null, null];
      const r = await client.query(
        `${INSERT} RETURNING id`,
        [projectId, folder, version, sceneId, beat, title ?? null,
          scNum, shId, shNum, t0, t1, type, prompt ?? null,
          negative, model, workflow,
          file ? JSON.stringify({ engine, file, version, ...meta }) : null]);
      insertedIds.push(r.rows[0].id);
        changedScenes.push(sceneId);
        changedAssetTypes.push(type);
        if (file) {
          const nowISO = new Date().toISOString();
          await client.query(
            `UPDATE project_assets SET file_path = $1, status = 'COMPLETED',
               attempts = 1, started_at = $2::timestamptz, completed_at = $2::timestamptz
             WHERE id = $3`,
            [`outputs/${folder}/${file}`, nowISO, r.rows[0].id]);
        }
      };
      for (let i = 0; i < seq.length; i++) {
        const b = seq[i] || {};
        const n = i + 1;
        const bm = (mains.beats && mains.beats[String(n)]) || {};
        const kf = bm.keyframeMain ?? null;
        const cl = bm.clipMain ?? null;
        await full(n, n, b.title ?? null, "KEYFRAME", b.image ?? null, IMG_MODEL, IMG_WORKFLOW,
          kf, { ...diskFacts(folder, kf), beat: n }, shotColumns(b));
        await full(n, n, b.title ?? null, "VIDEO", b.motion ?? null,
          engine === "wan" ? WAN_MODEL : LTX_MODEL,
          engine === "wan" ? WAN_WORKFLOW : LTX_WORKFLOW,
          cl, { ...diskFacts(folder, cl), beat: n }, shotColumns(b));
      }
      // Stitched final cut (one row per stitch; beat_index = stitch version).
      if (mains.final) {
        const finalV = mains.finalV ?? finalCutVersion(mains.final) ?? 1;
        await full(0, finalV, null, "FINAL", null, null, "ffmpeg-concat",
          mains.final, { ...diskFacts(folder, mains.final), final_version: finalV });
      }
      // Mirror any already-rendered vertical cut into INSTAGRAM rows.
      await pgSeedInstagramRows((t, p) => client.query(t, p), projectId, folder, engine, cfg, version);
    } else {
      // v2+ = delta only: insert PENDING rows for changed scenes, nothing else.
      // Reference prompt changes do NOT create rows here — the next generated
      // or uploaded reference is recorded in project_references instead.
      // `folder` is the transaction-resolved immutable storage folder above.
      const engine = engineForFolder(folder);
      for (const [beatStr, types] of Object.entries(plan.beats)) {
        const n = Number(beatStr);
        const b = seq[n - 1] || {};
        for (const type of types) {
          const prompt = type === "KEYFRAME" ? (b.image ?? null) : (b.motion ?? null);
          const model = type === "KEYFRAME" ? IMG_MODEL : (engine === "wan" ? WAN_MODEL : LTX_MODEL);
          const workflow = type === "KEYFRAME" ? IMG_WORKFLOW : (engine === "wan" ? WAN_WORKFLOW : LTX_WORKFLOW);
    const r = await client.query(
      `${INSERT} RETURNING id`,
      [projectId, folder, version, n, n, b.title ?? null, ...shotColumns(b), type, prompt,
        negative, model, workflow, JSON.stringify({ engine, beat: n })]);
          insertedIds.push(r.rows[0].id);
          changedScenes.push(n);
          changedAssetTypes.push(type);
        }
      }
    }
    await client.query("COMMIT");
    console.log(`[version] ${JSON.stringify({
      project: name, projectId, previousVersion, newVersion: version,
      changedScenes, changedAssetTypes, insertedAssetIds: insertedIds,
    })}`);
    return { version, projectId, changedScenes, changedAssetTypes, insertedIds };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* already closed */ }
    throw e;
  } finally {
    client.release();
  }
}
// ---------------------------------------------------------------- in-place save
// Save Scenario updates the CURRENT project in place: the scenarios row, the
// prompts JSON, the projects row and the LATEST scenario_versions config are
// overwritten, and only the changed scenes' project_assets rows AT THAT SAME
// version are upserted (prompt columns refreshed, file linkage reset to
// PENDING so the next run regenerates them). No new version row and no new
// project row are ever created here — v1 (full snapshot via
// pgSaveVersionDelta) is the only version-creating save. History readers
// (EFFECTIVE_ASSETS_SQL, per-scene pills) keep working: they simply resolve
// against a version count that no longer grows on save.
async function pgSaveVersionInPlace(name, latestVersion, prevCfg, cfg, projectType = undefined) {
  // Total guard: latestVersion must be a real existing version (>= 1). A
  // phantom 0/NaN (e.g. max(version) over zero rows — Number(null) is 0)
  // would violate project_assets_version_check on the first asset INSERT.
  // Fall back to the delta path, which mints the correct next version
  // (COALESCE(max, 0) + 1 = 1 when empty). Checked before BEGIN so no
  // transaction is opened for the delegated save.
  if (latestVersionOf(latestVersion) == null) {
    const saved = await pgSaveVersionDelta(name, prevCfg, cfg);
    return { ...saved, updated: true };
  }
  const client = await pgPool.connect();
  try {
    await client.query("BEGIN");
    const version = Number(latestVersion);
    // Overwrite the latest prompt config (never a new row).
    await client.query(
      "UPDATE scenario_versions SET config = $2::jsonb WHERE name = $1 AND version = $3",
      [name, JSON.stringify(cfg), version]);
    // Immutable storage folder (same rule as the delta path).
    let folder;
    try {
      const fRow = await client.query("SELECT folder_name FROM projects WHERE name = $1", [name]);
      folder = fRow.rows[0]?.folder_name || null;
    } catch { folder = null; }
    folder ||= await ensureUniqueFolder(name, name);
    const seq = Array.isArray(cfg.sequence) ? cfg.sequence : [];
    // Same project_type rule as pgEnsureProject: explicit wins, new rows
    // default to VIDEO, existing rows are otherwise preserved.
    const inPlacePt = normalizeProjectType(projectType ?? explicitProjectType(cfg));
    const proj = await client.query(
      `INSERT INTO projects (name, folder_name, description, duration, beats, master_prompt, project_type, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'VIDEO'), now())
       ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description,
         duration = EXCLUDED.duration, beats = EXCLUDED.beats,
         master_prompt = COALESCE(EXCLUDED.master_prompt, projects.master_prompt),
         project_type = COALESCE($7, projects.project_type, 'VIDEO'),
         updated_at = now()
       RETURNING project_id`,
      [name, folder, cfg.description ?? null,
        Number.isFinite(Number(cfg.duration)) ? Number(cfg.duration) : null, seq.length,
        cfg.referencePrompt ?? null, inPlacePt]);
    const projectId = proj.rows[0]?.project_id;
    if (projectId == null) throw new Error(`pgSaveVersionInPlace: no project_id for ${name}`);
    // Refresh ONLY changed scenes at the same version (delta plan, same
    // per-type granularity as the old versioned path). Unchanged scenes are
    // untouched; removed beats produce no rows; added beats are inserted.
    // Reference prompt changes create no rows (project_references owns them).
    const plan = planDelta(prevCfg, cfg);
    const engine = engineForFolder(folder);
    const negative = cfg.negative ?? null;
    const UPSERT = `INSERT INTO project_assets (
      project_id, folder_name, version, scene_id, beat_index, beat_title,
      scene_number, shot_id, shot_number, start_time, end_time,
      asset_type, video_type, status, prompt, negative_prompt, file_path,
      model, workflow, attempts, max_retries, metadata
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'YOUTUBE', 'PENDING', $13, $14, NULL, $15, $16, 0, 3, $17::jsonb
    )
    ON CONFLICT (project_id, version, asset_type, beat_index, video_type) DO UPDATE SET
      folder_name = EXCLUDED.folder_name,
      scene_id = EXCLUDED.scene_id, beat_title = EXCLUDED.beat_title,
      scene_number = EXCLUDED.scene_number, shot_id = EXCLUDED.shot_id,
      shot_number = EXCLUDED.shot_number, start_time = EXCLUDED.start_time,
      end_time = EXCLUDED.end_time,
      prompt = EXCLUDED.prompt, negative_prompt = EXCLUDED.negative_prompt,
      model = EXCLUDED.model, workflow = EXCLUDED.workflow,
      status = 'PENDING', file_path = NULL, error_message = NULL,
      started_at = NULL, completed_at = NULL,
      metadata = EXCLUDED.metadata`;
    const changedScenes = [];
    const changedAssetTypes = [];
    for (const [beatStr, types] of Object.entries(plan.beats)) {
      const n = Number(beatStr);
      const b = seq[n - 1] || {};
      for (const type of types) {
        const prompt = type === "KEYFRAME" ? (b.image ?? null) : (b.motion ?? null);
        const model = type === "KEYFRAME" ? IMG_MODEL : (engine === "wan" ? WAN_MODEL : LTX_MODEL);
        const workflow = type === "KEYFRAME" ? IMG_WORKFLOW : (engine === "wan" ? WAN_WORKFLOW : LTX_WORKFLOW);
        await client.query(UPSERT,
          [projectId, folder, version, n, n, b.title ?? null, ...shotColumns(b), type, prompt,
            negative, model, workflow, JSON.stringify({ engine, beat: n })]);
        changedScenes.push(n);
        changedAssetTypes.push(type);
      }
    }
    await client.query("COMMIT");
    console.log(`[save] ${JSON.stringify({
      project: name, projectId, version, updated: true,
      changedScenes, changedAssetTypes,
    })}`);
    return { version, projectId, changedScenes, changedAssetTypes, updated: true };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* already closed */ }
    throw e;
  } finally {
    client.release();
  }
}
// ---------------------------------------------------------------- project_references
// Reference visuals (master-prompt images) live here — one row per
// generation or upload, since a project accumulates MANY master prompts and
// reference images over time. project_assets carries no REFERENCE rows.
// is_main marks the record selected as main on the UI (one per project +
// output dir, enforced by a partial unique index); pinned marks a deliberate
// user pick (manual select / upload) that keeps winning over later auto
// generations (mirrors the state.json pin semantics the pipeline reads).
// Parse "V2" out of "<prefix>_ref_v2.png" (v1 = no suffix), else 1.
const refVersionOf = (file) => {
  const m = String(file || "").match(/_v(\d+)\.png$/i);
  return m ? Number(m[1]) : 1;
};
// Reference rows for one project dir, oldest first: [{ id, file, v, prompt,
// source, is_main, pinned, model, created_at }].
async function pgReferenceList(projectId, dir) {
  const r = await pgPool.query(
    `SELECT id, prompt, file_path, metadata, source, video_type, is_main, pinned, model,
            version, created_at
     FROM project_references WHERE project_id = $1 AND output_dir = $2
     ORDER BY created_at ASC, id ASC`,
    [projectId, dir]);
  return r.rows.map((x) => ({
    id: Number(x.id),
    file: x.metadata?.file ?? String(x.file_path || "").split("/").pop() ?? null,
    v: refVersionOf(x.metadata?.file ?? x.file_path),
    prompt: x.prompt ?? null,
    source: x.source,
    video_type: x.video_type ?? null,
    is_main: !!x.is_main,
    pinned: !!x.pinned,
    model: x.model ?? null,
    version: x.version ?? null,
    created_at: x.created_at ? new Date(x.created_at).toISOString() : null,
  })).filter((x) => x.file);
}
// Record a finished reference generation (or upload) as a NEW row and make
// it the dir's main — unless a pinned pick already holds main (pins survive
// auto generations). Uploads/selects pass pinned=true and always take main.
async function pgAddReference({ projectId, dir, file, prompt, engine, source = "generated" }) {
  const filePath = `outputs/${dir}/${file}`;
  const facts = diskFacts(dir, file);
  const nowISO = new Date().toISOString();
  const client = await pgPool.connect();
  try {
    await client.query("BEGIN");
    const ver = await client.query(
      "SELECT max(version) AS v FROM scenario_versions WHERE name = (SELECT name FROM projects WHERE project_id = $1)",
      [projectId]);
    const version = ver.rows[0]?.v ?? null;
    // Reference input is explicit-only (checkbox / click / upload): a fresh
    // generation NEVER takes main by itself. Only uploads (a deliberate file
    // choice, never a render) flip the main onto themselves.
    const takeMain = source !== "generated";
    if (takeMain) {
      await client.query(
        `UPDATE project_references SET is_main = FALSE, pinned = FALSE
         WHERE project_id = $1 AND output_dir = $2`,
        [projectId, dir]);
    }
    const ins = await client.query(
      `INSERT INTO project_references (
         project_id, output_dir, version, prompt, file_path,
         model, workflow, attempts, source, video_type, is_main, pinned, metadata,
         started_at, completed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $10, $11, $12::jsonb, $13::timestamptz, $13::timestamptz)
       RETURNING id`,
      [projectId, dir, version, prompt ?? null, filePath, REF_MODEL, REF_WORKFLOW,
        source, /_vertical$/.test(dir) ? "INSTAGRAM" : "YOUTUBE", takeMain, source !== "generated",
        JSON.stringify({ engine, file, ...facts }), nowISO]);
    await client.query("COMMIT");
    return ins.rows[0].id;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* already closed */ }
    throw e;
  } finally {
    client.release();
  }
}
// UI "set as main" for a reference file: flip is_main (+pinned, it's a
// deliberate pick) onto its row, clearing the dir scope. Unknown files
// (legacy, recorded nowhere) are inserted first so the pick sticks.
// file == null/"" clears instead: every row in the dir loses is_main, so no
// reference is served as input until the next explicit pick.
async function pgSetReferenceMain({ projectId, dir, file, prompt, engine }) {
  const client = await pgPool.connect();
  try {
    await client.query("BEGIN");
    if (file == null || file === "") {
      await client.query(
        "UPDATE project_references SET is_main = FALSE, pinned = FALSE WHERE project_id = $1 AND output_dir = $2",
        [projectId, dir]);
      await client.query("COMMIT");
      return;
    }
    const filePath = `outputs/${dir}/${file}`;
    const hit = await client.query(
      `SELECT id FROM project_references
       WHERE project_id = $1 AND output_dir = $2
         AND (file_path = $3 OR metadata->>'file' = $4) LIMIT 1`,
      [projectId, dir, filePath, file]);
    await client.query(
      "UPDATE project_references SET is_main = FALSE, pinned = FALSE WHERE project_id = $1 AND output_dir = $2",
      [projectId, dir]);
    if (hit.rowCount) {
      await client.query(
        "UPDATE project_references SET is_main = TRUE, pinned = TRUE, updated_at = now() WHERE id = $1",
        [hit.rows[0].id]);
    } else {
      const facts = diskFacts(dir, file);
      const nowISO = new Date().toISOString();
      const ver = await client.query(
        "SELECT max(version) AS v FROM scenario_versions WHERE name = (SELECT name FROM projects WHERE project_id = $1)",
        [projectId]);
      await client.query(
        `INSERT INTO project_references (
           project_id, output_dir, version, prompt, file_path,
           model, workflow, attempts, source, video_type, is_main, pinned, metadata,
           started_at, completed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'generated', $8, TRUE, TRUE, $9::jsonb, $10::timestamptz, $10::timestamptz)`,
        [projectId, dir, ver.rows[0]?.v ?? null, prompt ?? null, filePath,
          REF_MODEL, REF_WORKFLOW, /_vertical$/.test(dir) ? "INSTAGRAM" : "YOUTUBE",
          JSON.stringify({ engine, file, ...facts }), nowISO]);
    }
    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* already closed */ }
    throw e;
  } finally {
    client.release();
  }
}
// Backfill the references table from on-disk ref mains (one row per dir).
// Skips projects that already have rows — never duplicates.
async function pgBackfillReferences(name, folder, cfg) {
  if (!pgUp) return;
  try {
    const pid = await pgProjectId(name);
    if (pid == null) return;
    const has = await pgPool.query(
      "SELECT 1 FROM project_references WHERE project_id = $1 LIMIT 1", [pid]);
    if (has.rowCount) return;
    const v = await pgPool.query("SELECT max(version) AS v FROM scenario_versions WHERE name = $1", [name]);
    const version = v.rows[0]?.v ?? null;
    for (const suffix of ["", "_wan", "_vertical", "_wan_vertical"]) {
      const dir = folder + suffix;
      const full = path.join(OUTPUTS, dir);
      if (!fs.existsSync(full)) continue;
      try {
        const seq = Array.isArray(cfg?.sequence) ? cfg.sequence : [];
        const vm = versionMap(full, prefixForDir(dir), seq);
        if (!vm.refMain) continue;
        const filePath = `outputs/${dir}/${vm.refMain}`;
        const dup = await pgPool.query(
          "SELECT 1 FROM project_references WHERE project_id = $1 AND file_path = $2 LIMIT 1",
          [pid, filePath]);
        if (dup.rowCount) continue;
        const facts = diskFacts(dir, vm.refMain);
        const nowISO = new Date().toISOString();
        await pgPool.query(
          `INSERT INTO project_references (
             project_id, output_dir, version, prompt, file_path,
             model, workflow, attempts, source, video_type, is_main, pinned, metadata,
             started_at, completed_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'generated', $8, TRUE, $9, $10::jsonb, $11::timestamptz, $11::timestamptz)`,
          [pid, dir, version, cfg?.referencePrompt ?? null, filePath,
            REF_MODEL, REF_WORKFLOW, /_vertical$/.test(dir) ? "INSTAGRAM" : "YOUTUBE", !!vm.refPinned,
            JSON.stringify({ engine: engineForDir(dir), file: vm.refMain, ...facts }), nowISO]);
      } catch (e) { console.warn(`[pg] reference backfill failed for ${dir}:`, e.message); }
    }
  } catch (e) { console.warn("[pg] reference backfill failed:", e.message); }
}
// Mark ONE asset row COMPLETED the moment its file finishes generating
// (called per [asset] event, so rows flip one by one).
// RETRY SAFE: a failed generation retried via --regen only re-runs the
// single asset and UPDATEs its existing row here — it never inserts a new
// project version (versions are created only by pgSaveVersionDelta on an
// actual prompt/scene change). Status/progress/error updates likewise stay
// on the same row.
// asset: { file, stage: 'reference'|'keyframe'|'clip'|'final', index? }
// Stage -> (asset_type, beat_index): keyframe -> (KEYFRAME, N),
// clip -> (VIDEO, N), final -> (FINAL, V) where V is the 1-based stitch
// version — every stitch INSERTs a new FINAL row. Reference visuals skip
// project_assets entirely (they live in project_references, one row per
// generation — see the reference branch below).
// UPDATE first; when the row does not exist yet (e.g. never saved), INSERT
// it as COMPLETED.
async function pgMarkAssetComplete(projectName, asset, opts = {}) {
  if (!pgUp) return;
  try {
    const projectId = await pgProjectId(projectName);
    if (projectId == null) return; // project row not saved yet
    const v = await pgPool.query("SELECT max(version) AS v FROM scenario_versions WHERE name = $1", [projectName]);
    const version = v.rows[0]?.v;
    if (!version) return; // never saved — rows are created on the next Save
    const engine = opts.engine || "ltx";
    const format = normalizeFormat(opts.format);
    // Folder-based storage (immutable); callers pass the run's outputFolder
    // explicitly — this fallback only serves direct callers.
    const outputFolder = opts.outputFolder || outDirName(await folderFor(projectName), engine, format);
    // Reference completion -> project_references (never project_assets).
    // Each generation is a NEW row carrying its own master prompt; it takes
    // main unless a pinned pick already holds it. Vertical cuts record into
    // their own dir scope so the landscape main stays canonical.
    if (asset.stage === "reference") {
      let prompt = null;
      try {
        const raw = await dbGetScenario(projectName);
        prompt = raw ? JSON.parse(raw).referencePrompt ?? null : null;
      } catch { prompt = null; }
      await pgAddReference({
        projectId, dir: outputFolder, file: asset.file, prompt, engine, source: "generated",
      });
      return;
    }
    // Song take finished -> point the project's song row at the new file
    // (scripts/generate_song.mjs emits stage "song" per finished take).
    if (asset.stage === "song") {
      const filePath = `outputs/${outputFolder}/${asset.file}`;
      await pgPool.query(
        `UPDATE project_songs SET file_path = $2, updated_at = now()
         WHERE project_id = $1`,
        [projectId, filePath]);
      return;
    }
    const facts = diskFacts(outputFolder, asset.file);
    const filePath = `outputs/${outputFolder}/${asset.file}`;
    // Director shot linkage for the completed beat (all-NULL for legacy
    // single-shot beats and FINAL rows).
    let shot = [null, null, null, null, null];
    if (asset.stage === "keyframe" || asset.stage === "clip") {
      try {
        const rawCfg = await dbGetScenario(projectName);
        const seqCfg = rawCfg ? JSON.parse(rawCfg).sequence : null;
        const beatCfg = Array.isArray(seqCfg) ? seqCfg[(asset.index ?? 1) - 1] : null;
        if (beatCfg) shot = shotColumns(beatCfg);
      } catch { /* shot linkage stays NULL; never blocks completion */ }
    }
    let target = null;
    if (asset.stage === "keyframe") {
      const beat = asset.index ?? 0;
      target = { type: "KEYFRAME", beat, model: IMG_MODEL, workflow: IMG_WORKFLOW,
        meta: { engine, file: asset.file, beat, ...facts } };
    } else if (asset.stage === "clip") {
      const beat = asset.index ?? 0;
      target = { type: "VIDEO", beat, model: engine === "wan" ? WAN_MODEL : LTX_MODEL,
        workflow: engine === "wan" ? WAN_WORKFLOW : LTX_WORKFLOW,
        meta: { engine, file: asset.file, beat, ...facts } };
    } else if (asset.stage === "final") {
      // Stitched final cut: one NEW row per stitch (beat_index = 1-based
      // stitch version parsed from the filename), same COMPLETED/file_path/
      // attempts/metadata mechanics as every other asset.
      const finalV = finalCutVersion(asset.file) ?? 1;
      target = { type: "FINAL", beat: finalV, scene: 0, model: null, workflow: "ffmpeg-concat",
        meta: { engine, file: asset.file, final_version: finalV, ...facts } };
    } else {
      return;
    }
    const sceneId = target.scene ?? target.beat;
    // Cut dimension: landscape runs record YOUTUBE rows, vertical (Instagram
    // Reel) runs record INSTAGRAM rows — both cuts keep a full per-scene set
    // under the wider unique key (project, version, type, beat, video_type).
    // file_path already points at the run's own output dir (outputFolder).
    const videoType = format === "vertical" ? "INSTAGRAM" : "YOUTUBE";
    target.meta.video_type = videoType;
    const upd = await pgPool.query(
      `UPDATE project_assets SET file_path = $1, status = 'COMPLETED', error_message = NULL,
         attempts = attempts + 1,
         model = COALESCE(model, $5), workflow = COALESCE(workflow, $6),
         metadata = COALESCE(metadata, $7::jsonb),
         scene_number = COALESCE(scene_number, $10), shot_id = COALESCE(shot_id, $11),
         shot_number = COALESCE(shot_number, $12), start_time = COALESCE(start_time, $13),
         end_time = COALESCE(end_time, $14),
         started_at = COALESCE(started_at, now()), completed_at = now()
       WHERE project_id = $2 AND version = $3 AND asset_type = $4 AND beat_index = $8 AND video_type = $9`,
      [filePath, projectId, version, target.type, target.model, target.workflow,
       JSON.stringify(target.meta), target.beat, videoType, ...shot]);
    if (upd.rowCount === 0) {
      await pgPool.query(
        `INSERT INTO project_assets (
           project_id, version, scene_id, beat_index, asset_type, video_type, status,
           scene_number, shot_id, shot_number, start_time, end_time,
           file_path, model, workflow, attempts, metadata, started_at, completed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'COMPLETED',
           $7, $8, $9, $10, $11,
           $12, $13, $14, 1, $15::jsonb, now(), now())
         ON CONFLICT (project_id, version, asset_type, beat_index, video_type) DO UPDATE SET
           file_path = EXCLUDED.file_path, status = 'COMPLETED', error_message = NULL,
           scene_number = COALESCE(project_assets.scene_number, EXCLUDED.scene_number),
           shot_id = COALESCE(project_assets.shot_id, EXCLUDED.shot_id),
           shot_number = COALESCE(project_assets.shot_number, EXCLUDED.shot_number),
           start_time = COALESCE(project_assets.start_time, EXCLUDED.start_time),
           end_time = COALESCE(project_assets.end_time, EXCLUDED.end_time),
           attempts = project_assets.attempts + 1, completed_at = now()`,
        [projectId, version, sceneId, target.beat, target.type, videoType, ...shot, filePath,
         target.model, target.workflow, JSON.stringify(target.meta)]);
    }
  } catch (e) { console.warn("[pg] mark complete failed:", e.message); }
}
// Refresh the current version's project_assets file names from the output
// dir's main versions (called after every generation + on run exit, so the
// table always lists the actual image/video files on disk).
// Delta-safe: UPDATE ONLY rows that already exist in the current version.
// Never inserts missing rows — otherwise a refresh would backfill unchanged
// scenes into the new version and destroy delta versioning. Single-asset
// completion (pgMarkAssetComplete) is what fills a row's file_path.
async function pgRefreshProjectFiles(projectName, outputFolder) {
  if (!pgUp) return;
  try {
    const raw = await dbGetScenario(projectName);
    if (raw === null) return;
    const cfg = JSON.parse(raw);
    const v = await pgPool.query("SELECT max(version) AS v FROM scenario_versions WHERE name = $1", [projectName]);
    const version = v.rows[0]?.v;
    if (!version) return; // never saved — files are recorded on the next Save
    const pid = await pgProjectId(projectName);
    if (pid == null) return;
    // Refresh only the cut being refreshed: a vertical dir touches INSTAGRAM
    // rows, anything else the YOUTUBE rows — never cross-write the other cut.
    const videoType = /_vertical$/.test(outputFolder || "") ? "INSTAGRAM" : "YOUTUBE";
    const mains = mainsFor(outputFolder, cfg);
    const seq = Array.isArray(cfg.sequence) ? cfg.sequence : [];
    const existing = await pgPool.query(
      "SELECT asset_type, beat_index FROM project_assets WHERE project_id = $1 AND version = $2 AND video_type = $3",
      [pid, Number(version), videoType]);
    const has = new Set(existing.rows.map((r) => `${r.asset_type}:${r.beat_index}`));
    const relPath = (file) => (file ? `outputs/${outputFolder}/${file}` : null);
    const touch = async (type, beat, file) => {
      if (!file || !has.has(`${type}:${beat}`)) return; // delta: no backfill
      await pgPool.query(
        `UPDATE project_assets SET file_path = COALESCE(file_path, $1),
           status = CASE WHEN file_path IS NOT NULL OR $1 IS NOT NULL THEN 'COMPLETED' ELSE status END,
           completed_at = CASE WHEN file_path IS NOT NULL OR $1 IS NOT NULL THEN COALESCE(completed_at, now()) ELSE completed_at END
         WHERE project_id = $2 AND version = $3 AND asset_type = $4 AND beat_index = $5 AND video_type = $6`,
        [relPath(file), pid, Number(version), type, beat, videoType]);
    };
    // Reference mains are NOT refreshed here — project_references is the
    // record (appended on generation/upload, flipped on UI select).
    for (let i = 0; i < seq.length; i++) {
      const n = i + 1;
      const bm = (mains.beats && mains.beats[String(n)]) || {};
      await touch("KEYFRAME", n, bm.keyframeMain ?? null);
      await touch("VIDEO", n, bm.clipMain ?? null);
    }
    // Latest stitched final cut (update-only, like everything else here —
    // the row itself is created by pgMarkAssetComplete on each stitch).
    if (mains.final) {
      await touch("FINAL", mains.finalV ?? finalCutVersion(mains.final) ?? 1, mains.final);
    }
  } catch (e) { console.warn("[pg] project files refresh failed:", e.message); }
}
// Storage slug for a project display name (single source of truth lives in
// lib/variant.mjs — server, scripts and lib share the exact same rule).
// Immutable after project creation — never updated on edits/renames, so
// output dirs, filenames and DB paths stay stable and media keeps resolving.
const folderName = folderSlug;

// INTERNAL KEY vs DISPLAY NAME: the user may type "Pyari billi" in the UI;
// the application stores and routes everything by a SPACE-FREE key
// ("pyari_billi" — configSlug, same rule as the storage folder). The key is
// the scenarios/projects identity: /api/scenario/<key>/... URLs, output
// dirs, image/video/reference file names all derive from it and never carry
// a space. The typed name rides along as cfg.display_name for UI labels;
// the UI falls back to the key when a project has none.
const spaceFreeName = configSlug;

// Prompts-JSON paths: SPACE-FREE file names like every other storage name.
// Writers always use the slug (`pyari_billi.json`); readers resolve the slug
// first and fall back to the legacy raw display-name file so exports written
// before slugification keep loading. configName (what the CLI runners get via
// --config-name) stays the display name — the runners do the same fallback.
const promptsSlugFile = (name) => path.join(PROMPTS, `${configSlug(name)}.json`);
const promptsLegacyFile = (name) => path.join(PROMPTS, `${String(name ?? "")}.json`);
function promptsReadFile(name) {
  const slugF = promptsSlugFile(name);
  if (fs.existsSync(slugF)) return slugF;
  const rawF = promptsLegacyFile(name);
  return fs.existsSync(rawF) ? rawF : slugF;
}

// Get existing folder_name from the database row for a given project.
const getFolderNameFromRow = async (name) => {
  if (!pgUp) return null;
  const r = await pgPool.query("SELECT folder_name FROM projects WHERE name = $1", [name]);
  return r.rows[0]?.folder_name ?? null;
};

  // Storage folder for a project display name: the stored immutable
  // folder_name when the project row exists, else the slug of the name
  // (legacy rows / PG-down fallback). Never contains spaces.

const folderFor = async (name) =>
  (await getFolderNameFromRow(name)) || folderName(name);

// Storage folder guaranteed unique across projects AND existing output dirs
// ("my_video", "my_video_2", ...). excludeName skips the caller's own row
// (edits must keep their folder, never mint a new one).
async function ensureUniqueFolder(base, excludeName = null) {
  let candidate = folderName(base);
  for (let i = 2; ; i++) {
    let taken = false;
    if (pgUp) {
      try {
        const r = await pgPool.query(
          "SELECT 1 FROM projects WHERE folder_name = $1 AND name <> $2 LIMIT 1",
          [candidate, excludeName]);
        taken = r.rowCount > 0;
      } catch { /* treat as free — insert path re-checks */ }
    }
    if (!taken && allDirsFor(candidate).some((d) => fs.existsSync(path.join(OUTPUTS, d)))) {
      // A stray output dir (deleted project, CLI run) already owns it.
      // Own dirs of the caller's previous folder don't count — but the
      // caller passes a NEW base here, so any hit means taken.
      taken = true;
    }
    if (!taken) return candidate;
    candidate = `${folderName(base).slice(0, 97)}_${i}`;
  }
}

// Split an output dir into its storage-folder base + engine/format suffix.
const splitDirSuffix = (dir) => {
  let base = String(dir || ""), suffix = "";
  if (base.endsWith("_vertical")) { base = base.slice(0, -"_vertical".length); suffix = "_vertical"; }
  if (base.endsWith("_wan")) { base = base.slice(0, -"_wan".length); suffix = "_wan" + suffix; }
  return { base, suffix };
};

// Translate any output dir (folder- OR legacy display-name-based) to its
// canonical storage dir. Falls back to the input when the folder is unknown
// or the canonical dir doesn't exist yet but the given one does (legacy).
async function storageDirFor(dir) {
  const { base, suffix } = splitDirSuffix(dir);
  if (!base) return dir;
  let folder = null;
  if (pgUp) {
    try {
      // Base may already BE the folder, or a display name with a stored folder.
      const hit = await pgPool.query(
        "SELECT folder_name FROM projects WHERE folder_name = $1 OR name = $1 LIMIT 1", [base]);
      folder = hit.rows[0]?.folder_name ?? null;
    } catch { folder = null; }
  }
  folder ||= folderName(base);
  const canonical = folder + suffix;
  if (canonical === dir) return dir;
  if (fs.existsSync(path.join(OUTPUTS, canonical))) return canonical;
  if (fs.existsSync(path.join(OUTPUTS, dir))) return dir; // legacy dir still on disk
  return canonical; // canonical going forward (migration creates it on demand)
}

// Display name that owns a storage folder base (reverse of folderFor).
// Falls back to the base itself for legacy/unknown folders.
async function displayNameForFolder(folderBase) {
  if (pgUp) {
    try {
      const r = await pgPool.query("SELECT name FROM projects WHERE folder_name = $1 LIMIT 1", [folderBase]);
      if (r.rows[0]?.name) return r.rows[0].name;
    } catch { /* fall through */ }
  }
  return folderBase;
}

async function pgInit() {
  if (!(await pgProbe())) return;
  try {
    await pgPool.query(PG_SCHEMA);
    // Legacy `assets` catalog is retired (project_assets + project_references
    // + disk are canonical) — drop it on existing installs.
    await pgPool.query(`DROP TABLE IF EXISTS public.assets`);
    await pgPool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_id SERIAL UNIQUE`);
    await pgPool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS folder_name TEXT`);
    await pgPool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS master_prompt TEXT`);
    // Project kind: VIDEO (normal video project) vs AUDIO (saved from the
    // Create Song tab). New column — every existing row is a video project.
    await pgPool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_type TEXT NOT NULL DEFAULT 'VIDEO'`);
    await pgPool.query(`UPDATE projects SET project_type = 'VIDEO' WHERE project_type IS NULL`);
    try {
      await pgPool.query(`ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_project_type_check`);
      await pgPool.query(`ALTER TABLE projects ADD CONSTRAINT projects_project_type_check
        CHECK (project_type IN ('VIDEO', 'AUDIO'))`);
    } catch (e) { console.warn("[pg] projects project_type check migration failed:", e.message); }
    // Director boards -> approved project link (existing installs predate the
    // column). CASCADE so deleting a project removes its storyboard rows;
    // the board JSON files are removed alongside (see project DELETE).
    await pgPool.query(`ALTER TABLE director_boards ADD COLUMN IF NOT EXISTS project_id INTEGER`)
      .catch(() => {});
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_director_boards_project ON director_boards(project_id)`)
      .catch(() => {});
    try {
      const fk = await pgPool.query(
        `SELECT 1 FROM pg_constraint WHERE conrelid = 'public.director_boards'::regclass AND contype = 'f'`);
      if (!fk.rowCount) {
        // Backfill orphans first: a stale project_id can never survive a
        // restore, so null it before the FK is enforced.
        await pgPool.query(
          `UPDATE director_boards b SET project_id = NULL
            WHERE project_id IS NOT NULL AND NOT EXISTS
              (SELECT 1 FROM projects p WHERE p.project_id = b.project_id)`);
        await pgPool.query(
          `ALTER TABLE director_boards ADD CONSTRAINT director_boards_project_fk
            FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE`);
      }
    } catch (e) { console.warn("[pg] director_boards project_fk migration failed:", e.message); }
    // Director shot counts (existing installs predate the column): timed
    // shots planned so far per board, backfilled from the board JSONB.
    await pgPool.query(`ALTER TABLE director_boards ADD COLUMN IF NOT EXISTS shot_count INTEGER`)
      .catch(() => {});
    try {
      await pgPool.query(
        `UPDATE director_boards SET shot_count = (
           SELECT COALESCE(SUM(GREATEST(1,
             CASE WHEN jsonb_typeof(s.value->'shots') = 'array'
               THEN jsonb_array_length(s.value->'shots') ELSE 0 END)), 0)::int
           FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(board->'scenes') = 'array' THEN board->'scenes' ELSE '[]'::jsonb END
           ) AS s
         ) WHERE shot_count IS NULL`);
    } catch (e) { console.warn("[pg] director_boards shot_count backfill failed:", e.message); }
    // Shot linkage lookup: per-scene/shot asset rows for one project.
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_project_assets_scene_shot
        ON project_assets(project_id, scene_number)`)
      .catch(() => {});
    // Documentary boards index (table itself is created in PG_SCHEMA above).
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_documentary_boards_project ON documentary_boards(project_id)`)
      .catch(() => {});
    // Song form table + its generated-take pointer (existing installs predate both).
    await pgPool.query(`ALTER TABLE project_songs ADD COLUMN IF NOT EXISTS file_path TEXT`)
      .catch(() => {});
    // Song mode preset + advanced ACE-Step sampling (set internally per mode).
    await pgPool.query(`ALTER TABLE project_songs ADD COLUMN IF NOT EXISTS song_preset TEXT`)
      .catch(() => {});
    await pgPool.query(`ALTER TABLE project_songs ADD COLUMN IF NOT EXISTS song_vocal TEXT`)
      .catch(() => {});
    await pgPool.query(`ALTER TABLE project_songs ADD COLUMN IF NOT EXISTS cfg_scale DOUBLE PRECISION`)
      .catch(() => {});
    await pgPool.query(`ALTER TABLE project_songs ADD COLUMN IF NOT EXISTS temperature DOUBLE PRECISION`)
      .catch(() => {});
    // Audio model for sung takes (Create Song tab dropdown): "ace-step" |
    // "minimax". Older rows predate the column and read back as null (= ace-step).
    await pgPool.query(`ALTER TABLE project_songs ADD COLUMN IF NOT EXISTS song_model TEXT`)
      .catch(() => {});
    // Backfill folder_name for existing projects that don't have one.
    await pgPool.query(
      `UPDATE projects SET folder_name = substr(regexp_replace(regexp_replace(lower(name), '[^a-z0-9]+', '_', 'g'), '^_+|_+$', ''), 1, 100) WHERE folder_name IS NULL OR folder_name = ''`);
    // References moved to project_references: drop legacy REFERENCE rows
    // (superseded by the per-dir mains backfilled into the new table below).
    try {
      const del = await pgPool.query("DELETE FROM project_assets WHERE asset_type = 'REFERENCE'");
      if (del.rowCount) console.log(`[pg] removed ${del.rowCount} legacy REFERENCE project_assets rows`);
    } catch (e) { console.warn("[pg] reference rows cleanup failed:", e.message); }
    // --- narrow project_assets schema: ensure every column/index exists ---
    // Fresh installs get the exact DDL from PG_SCHEMA above; a pre-existing
    // table (created from the same DDL by hand) gains any missing narrow
    // columns here. The old WIDE table (kind/reference_*/image_*/video_*)
    // is NOT migrated — drop it once (DROP TABLE public.project_assets;)
    // and let boot recreate it.
    const NARROW_COLS = [
      `project_id INTEGER NOT NULL`,
      `folder_name TEXT`,
      `version INTEGER NOT NULL DEFAULT 1`,
      `scene_id INTEGER`,
      `beat_index INTEGER NOT NULL DEFAULT 0`,
      `beat_title TEXT`,
      // Director shot linkage: which scene + shot each keyframe/clip row
      // belongs to (multi-shot scenes flatten to one beat per shot).
      `scene_number INTEGER`,
      `shot_id TEXT`,
      `shot_number INTEGER`,
      `start_time DOUBLE PRECISION`,
      `end_time DOUBLE PRECISION`,
      `asset_type TEXT NOT NULL`,
      `video_type TEXT NOT NULL DEFAULT 'YOUTUBE'`,
      `status TEXT NOT NULL DEFAULT 'PENDING'`,
      `prompt TEXT`,
      `negative_prompt TEXT`,
      `file_path TEXT`,
      `model TEXT`,
      `workflow TEXT`,
      `seed BIGINT`,
      `attempts INTEGER NOT NULL DEFAULT 0`,
      `max_retries INTEGER NOT NULL DEFAULT 3`,
      `error_message TEXT`,
      `metadata JSONB`,
      `started_at TIMESTAMPTZ`,
      `completed_at TIMESTAMPTZ`,
      `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    ];
    for (const def of NARROW_COLS) {
      const col = def.split(" ")[0];
      try { await pgPool.query(`ALTER TABLE project_assets ADD COLUMN IF NOT EXISTS ${col} ${def.slice(col.length + 1)}`); }
      catch (e) { console.warn(`[pg] add column ${col} failed:`, e.message); }
    }
    // Migrate a TEXT-typed scene_id (previous revision) to INTEGER. Old
    // string values ("<name>:v<version>:ref|beatN:<type>") carry no numeric
    // meaning, so fall back to beat_index (= the scene number); pure-numeric
    // strings cast straight through.
    try {
      const t = await pgPool.query(
        `SELECT data_type FROM information_schema.columns
          WHERE table_name = 'project_assets' AND column_name = 'scene_id'`);
      if ((t.rows[0]?.data_type || "").toLowerCase() !== "integer") {
        await pgPool.query(
          `UPDATE project_assets SET scene_id = beat_index::text
            WHERE scene_id IS NULL OR scene_id !~ '^[0-9]+$'`);
        await pgPool.query(
          `ALTER TABLE project_assets ALTER COLUMN scene_id TYPE INTEGER USING scene_id::integer`);
      }
    } catch (e) { console.warn("[pg] scene_id type migration failed:", e.message); }
    // Widen the asset_type CHECK to admit 'FINAL' (stitched final-cut rows).
    // Drops any pre-existing asset_type CHECK (whatever its constraint name)
    // and re-adds the canonical one — fresh installs already get it from
    // PG_SCHEMA above.
    try {
      const cons = await pgPool.query(
        `SELECT conname FROM pg_constraint WHERE conrelid = 'public.project_assets'::regclass AND contype = 'c'`);
      for (const r of cons.rows) {
        const defR = await pgPool.query(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE conrelid = 'public.project_assets'::regclass AND conname = $1`, [r.conname]);
        if (/asset_type/i.test(defR.rows[0]?.def || "")) {
          await pgPool.query(`ALTER TABLE project_assets DROP CONSTRAINT "${String(r.conname).replace(/"/g, '""')}"`);
        }
      }
      await pgPool.query(`ALTER TABLE project_assets DROP CONSTRAINT IF EXISTS project_assets_asset_type_check`);
      await pgPool.query(`ALTER TABLE project_assets ADD CONSTRAINT project_assets_asset_type_check
        CHECK (asset_type IN ('REFERENCE', 'IMAGE', 'KEYFRAME', 'VIDEO', 'FINAL'))`);
    } catch (e) { console.warn("[pg] asset_type check migration failed:", e.message); }
    // video_type cut dimension: fresh installs get the 5-column UNIQUE key
    // from PG_SCHEMA above; pre-existing installs carry the 4-column index
    // under the same name — drop it first so the recreate below actually
    // takes effect (otherwise INSTAGRAM rows would collide with YOUTUBE rows).
    // ADD COLUMN DEFAULT 'YOUTUBE' already stamped every existing row, so the
    // wider key stays duplicate-free.
    try {
      await pgPool.query(`ALTER TABLE project_assets DROP CONSTRAINT IF EXISTS project_assets_video_type_check`);
      await pgPool.query(`ALTER TABLE project_assets ADD CONSTRAINT project_assets_video_type_check
        CHECK (video_type IN ('YOUTUBE', 'INSTAGRAM'))`);
    } catch (e) { console.warn("[pg] video_type check migration failed:", e.message); }
    try {
      await pgPool.query(`DROP INDEX IF EXISTS project_assets_project_version_type_beat_key`);
      await pgPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS project_assets_project_version_type_beat_key
        ON public.project_assets(project_id, version, asset_type, beat_index, video_type)`);
      await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_project_assets_project_id ON public.project_assets(project_id)`);
      await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_project_assets_scene_id ON public.project_assets(scene_id)`);
      await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_project_assets_project_version_beat ON public.project_assets(project_id, version, beat_index)`);
      await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_project_assets_asset_type ON public.project_assets(asset_type)`);
      await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_project_assets_status ON public.project_assets(project_id, status)`);
      await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_project_assets_metadata ON public.project_assets USING GIN (metadata)`);
    } catch (e) { console.warn("[pg] project_assets index ensure failed:", e.message); }
    try {
      await pgPool.query(
        `UPDATE projects SET project_id = nextval(pg_get_serial_sequence('projects', 'project_id'))
         WHERE project_id IS NULL`);
    } catch (e) { console.warn("[pg] projects id backfill failed:", e.message); }
    // Retired brief fields: Song/Topic + Lyrics/Requirements no longer exist
    // in the UI or the Scenario model. Drop the columns and strip the keys
    // from every stored config so no stale data lingers.
    try {
      await pgPool.query(`ALTER TABLE projects DROP COLUMN IF EXISTS topic`);
      await pgPool.query(`ALTER TABLE projects DROP COLUMN IF EXISTS requirements`);
    } catch (e) { console.warn("[pg] projects topic/requirements drop failed:", e.message); }
    try {
      await pgPool.query(`UPDATE scenarios SET config = (config - 'topic' - 'requirements') WHERE config ?| ARRAY['topic','requirements']`);
      await pgPool.query(`UPDATE scenario_versions SET config = (config - 'topic' - 'requirements') WHERE config ?| ARRAY['topic','requirements']`);
    } catch (e) { console.warn("[pg] scenario topic/requirements strip failed:", e.message); }
    // Materialize INSTAGRAM rows for vertical files previously recorded only
    // inside landscape-row metadata (format='vertical' + vertical_file): one
    // INSTAGRAM row per (project, version, type, beat) so both cuts keep all
    // scenes. Idempotent (unique key + DO NOTHING).
    try {
      const vr = await pgPool.query(
        `SELECT project_id, folder_name, version, scene_id, beat_index, beat_title,
                scene_number, shot_id, shot_number, start_time, end_time,
                asset_type, status, prompt, negative_prompt, model, workflow,
                attempts, error_message, metadata, started_at, completed_at,
                metadata->>'engine' AS eng, metadata->>'vertical_file' AS vfile
           FROM project_assets
          WHERE metadata->>'format' = 'vertical' AND metadata->>'vertical_file' IS NOT NULL`);
      let seeded = 0;
      for (const r of vr.rows) {
        if (!r.folder_name || !r.vfile) continue;
        const vdir = outDirName(r.folder_name, r.eng || "ltx", "vertical");
        const meta = { ...(r.metadata || {}), video_type: "INSTAGRAM" };
        const ins = await pgPool.query(
          `INSERT INTO project_assets (
             project_id, folder_name, version, scene_id, beat_index, beat_title,
             scene_number, shot_id, shot_number, start_time, end_time,
             asset_type, video_type, status, prompt, negative_prompt, file_path,
             model, workflow, attempts, max_retries, error_message, metadata,
             started_at, completed_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'INSTAGRAM',$13,$14,$15,$16,$17,$18,$19,3,$20,$21::jsonb,$22,$23
           )
           ON CONFLICT (project_id, version, asset_type, beat_index, video_type) DO NOTHING`,
          [r.project_id, r.folder_name, r.version, r.scene_id, r.beat_index, r.beat_title,
           r.scene_number, r.shot_id, r.shot_number, r.start_time, r.end_time,
           r.asset_type, r.status, r.prompt, r.negative_prompt,
           `outputs/${vdir}/${r.vfile}`, r.model, r.workflow, r.attempts ?? 0,
           r.error_message, JSON.stringify(meta), r.started_at, r.completed_at]);
        if (ins.rowCount) seeded++;
      }
      if (seeded) console.log(`[pg] seeded ${seeded} INSTAGRAM asset rows from vertical metadata`);
    } catch (e) { console.warn("[pg] instagram backfill failed:", e.message); }
    // video_type on project_references (cut dimension for the reference
    // catalog, derived from the output dir — vertical dirs are INSTAGRAM).
    // No data loss: plain ADD COLUMN + UPDATE, never DROP TABLE.
    try {
      await pgPool.query(`ALTER TABLE project_references ADD COLUMN IF NOT EXISTS video_type TEXT NOT NULL DEFAULT 'YOUTUBE'`);
      await pgPool.query(`ALTER TABLE project_references DROP CONSTRAINT IF EXISTS project_references_video_type_check`);
      await pgPool.query(`ALTER TABLE project_references ADD CONSTRAINT project_references_video_type_check
        CHECK (video_type IN ('YOUTUBE', 'INSTAGRAM'))`);
      await pgPool.query(
        `UPDATE project_references SET video_type = CASE WHEN output_dir LIKE '%_vertical' THEN 'INSTAGRAM' ELSE 'YOUTUBE' END`);
    } catch (e) { console.warn("[pg] references video_type migration failed:", e.message); }
    await syncAllToPg();
  } catch (e) { console.warn("[pg] init failed:", e.message); }
}
pgInit();

// Kids Studio: connect to its dedicated Postgres database and create the
// studio tables. Independent of the main catalog's USE_SQLITE switch — the
// studio owns `Sanskriti_kids` outright, and falls back to the local SQLite
// file when that database is unreachable (so the module always works).
async function kidsInit() {
  try {
    await kidsPool.query("SELECT 1");
    kidsPgUp = true;
  } catch (e) {
    kidsPgUp = false;
    console.warn(`[kids] database "${KIDS_DB_NAME}" unreachable: ${String(e.message || e)} — using the local SQLite store`);
    return;
  }
  try {
    await kidsPool.query(KIDS_SCHEMA);
    // Existing installs predate the optional audio + reference-image columns.
    try { await kidsPool.query(`ALTER TABLE kids_projects ADD COLUMN IF NOT EXISTS audio_path TEXT NOT NULL DEFAULT ''`); }
    catch (e) { console.warn("[kids] audio_path migration failed:", e.message); }
    try { await kidsPool.query(`ALTER TABLE kids_projects ADD COLUMN IF NOT EXISTS reference_images JSONB NOT NULL DEFAULT '[]'`); }
    catch (e) { console.warn("[kids] reference_images migration failed:", e.message); }
    // Seed the configurable option lists once (age groups, categories,
    // languages, platforms, resolutions, visual styles). The user can edit
    // them afterwards through the API — the UI never hardcodes them.
    for (const key of KIDS_OPTION_KEYS) {
      const defaults = KIDS_DEFAULT_OPTIONS[key] || [];
      const existing = await kidsPool.query(
        "SELECT count(*)::int AS n FROM kids_options WHERE option_key = $1", [key]);
      if (existing.rows[0]?.n) continue;
      let order = 0;
      for (const value of defaults) {
        await kidsPool.query(
          "INSERT INTO kids_options (option_key, option_value, sort_order) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
          [key, value, order++]);
      }
    }
    console.log(`[kids] store: postgres (${KIDS_DB_NAME})`);
  } catch (e) {
    kidsPgUp = false;
    console.warn("[kids] schema init failed:", e.message);
  }
}
kidsInit();

const DIST = path.join(__dirname, "dist");
const PORT = Number(process.env.PORT || 8790);
const LLM_BASE = (process.env.LLM_BASE || "").replace(/\/+$/, "");
// Reasoning-engine model id for the OpenAI-compatible chat endpoint above.
// Points at Muse Spark 1.3 where the deployment serves it (e.g.
// LLM_BASE=<spark-compatible endpoint> + LLM_MODEL=muse-spark-1.3); defaults
// to the historical literal "local" (LM Studio / llama-server) so existing
// setups behave byte-identically.
const LLM_MODEL = String(process.env.LLM_MODEL || "").trim() || "local";
// Maximum timeout for ALL requests (LLM + ComfyUI + probes): 30 min.
const REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

// LLM retry policy: the local backend (LM Studio / llama-server, reached over
// a tunnel here) can drop long generations mid-flight — LM Studio logs
// "[LM STUDIO SERVER] Client disconnected. Stopping generation..." and our
// fetch fails with a transport error AFTER minutes of compute. Every
// chat-completions POST below goes through llmPostChat, which transparently
// re-issues the SAME request on transport failures and gets the data instead
// of surfacing the drop. Retried ONLY on transport failures (reset / hang
// up / refused / 429 / 502 / 503 / 504) — never on our own timeout
// (AbortError: the model may still be working through the first request, and
// stacking a second full generation behind it would pile up load) and never
// on 4xx/model errors (those are meaningful, not drops). Chat completions
// are side-effect-free from our side (compute only), so re-issuing is safe.
// Tuning via env: LLM_RETRIES (extra attempts after the first, default 3),
// LLM_RETRY_BASE_MS (backoff base, default 2000).
const LLM_RETRIES = Math.max(0, Math.min(10, parseInt(process.env.LLM_RETRIES || "3", 10) || 0));
const LLM_RETRY_BASE_MS = Math.max(250, Number(process.env.LLM_RETRY_BASE_MS) || 2000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LLM_RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const LLM_RETRYABLE_CODE = /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|EHOSTUNREACH|ENETRESET|UND_ERR_SOCKET|UND_ERR_CONNECT|UND_ERR_CLOSED)$/;
function llmRetryableFetchError(e) {
  if (!e || e.name === "AbortError") return false;
  const code = String((e.cause && e.cause.code) || e.code || "");
  if (code && LLM_RETRYABLE_CODE.test(code)) return true;
  return /fetch failed|socket hang ?up|terminated|disconnected|network|connection|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN/i
    .test(`${String((e.cause && e.cause.message) || "")} ${String(e.message || e)}`);
}
// POST one OpenAI-compatible chat-completions body with transparent retries.
// Returns the parsed JSON. Throws the last transport error annotated with the
// attempt count, or the caller's domain error for non-retryable cases.
async function llmPostChat(url, payload, { timeoutMs = REQUEST_TIMEOUT_MS, tag = "llm" } = {}) {
  if (!LLM_BASE) throw new Error("LLM_BASE not set — set it in the project root .env or environment.");
  const attempts = 1 + LLM_RETRIES;
  let lastErr = null;
  for (let n = 1; n <= attempts; n++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        method: "POST",
        signal: ctl.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const err = new Error(`LLM HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
        if (!LLM_RETRYABLE_STATUS.has(r.status)) throw err;
        lastErr = err;
        if (n >= attempts) break; // exhausted — fall through to the annotated throw below
      } else {
        return await r.json();
      }
    } catch (e) {
      if (e?.name === "AbortError") throw e; // our own timeout — meaningful, never retry
      if (!llmRetryableFetchError(e)) throw e;
      lastErr = e;
      if (n >= attempts) break; // exhausted — fall through to the annotated throw below
    } finally { clearTimeout(t); }
    const wait = Math.min(30000, LLM_RETRY_BASE_MS * 2 ** (n - 1)) + Math.floor(Math.random() * 1000);
    console.warn(`[llm:${tag}] attempt ${n}/${attempts} failed (${String((lastErr && lastErr.message) || lastErr).slice(0, 160)}) — retrying in ${wait}ms`);
    await sleep(wait);
  }
  const err = lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  // Tag connectivity failures so the UI can pop an "LLM API offline" alert
  // window instead of a generic failure: transport drops (refused / reset /
  // hang up) and 502/503/504 from the local backend mean the AI service is
  // down. 429 (rate limit) and 4xx/model errors keep their plain LLM prefix.
  const offline = llmRetryableFetchError(lastErr) ||
    /LLM HTTP (502|503|504)\b/.test(String((lastErr && lastErr.message) || lastErr || ""));
  err.message = `${offline ? "LLM API offline: " : ""}${err.message} (after ${attempts} attempts)`;
  throw err;
}

// Director live stream (read-only LLM progress view): per-board rolling
// buffer of the CURRENT scene-batch's raw streamed tokens. The streamed LLM
// request is identical to the non-streamed one except stream:true (same
// prompt, same tokens, same compute — deltas are only flushed over the wire
// as they generate). Polling GET .../live reads this Node-side buffer only,
// never the model, so the live view cannot impact planning. Cleared when the
// batch finishes (success, salvage or error).
const directorLive = new Map(); // boardId -> { active, phase, batchFrom, batchTo, startedAt, text }
const liveBegin = (id, info) => {
  directorLive.set(id, { active: true, startedAt: Date.now(), text: "", reasoning: "", llmStartedAt: null, llmAttempts: [], ...info });
};
const liveAppend = (id, chunk) => {
  const st = directorLive.get(id);
  if (st && st.active) st.text += chunk;
};
// Thinking models stream their reasoning as a separate delta field — kept in
// its own buffer slot so the live view can show activity during the (often
// long) thinking phase without polluting the parsed response text.
const liveAppendReasoning = (id, chunk) => {
  const st = directorLive.get(id);
  if (st && st.active) st.reasoning = (st.reasoning || "") + chunk;
};
const liveReset = (id, note) => {
  const st = directorLive.get(id);
  if (st) { st.text = note ? `${note}\n` : ""; st.reasoning = ""; }
};
// Storyboard Planner 2.0 phase labels: updates only the LABEL in the existing
// read-only buffer. It never resets tokens, changes polling, or calls the LLM.
const livePhase = (id, phase) => {
  const st = directorLive.get(id);
  if (st && st.active) st.phase = phase;
};
const liveLlmStart = (id, attempt) => {
  const st = directorLive.get(id);
  if (st && st.active) { st.llmStartedAt = Date.now(); st.currentAttempt = attempt; }
};
const liveLlmEnd = (id, attempt) => {
  const st = directorLive.get(id);
  if (!st || !st.active || !st.llmStartedAt) return;
  st.llmAttempts.push({ attempt, durationMs: Date.now() - st.llmStartedAt });
  st.llmStartedAt = null;
};
const liveEnd = (id) => { directorLive.delete(id); };
// Streaming twin of llmChatJson for director scene batches: same payload +
// stream:true, same retry policy (transport drops re-issue the whole request,
// exactly like the non-streamed path), same stripJson + rawTag outcome.
// Only the director scenes route uses this — every other caller keeps the
// untouched llmPostChat/llmChatJson above.
// Shared LLM call reusing the craft-endpoint convention (LLM_MODEL,
// thinking disabled). Parse failures save the raw response for debugging
// and throw a useful error — nothing is silently discarded.
// MODULE LEVEL on purpose: the Sanskriti Kids studio helpers need the SAME
// helper (never a second LLM client).
async function llmChatJson({ system, user, maxTokens = 8000, temperature = 0.7, timeoutMs = REQUEST_TIMEOUT_MS, rawTag = null }) {
  const base = (process.env.LLM_BASE || "").replace(/\/+$/, "");
  if (!base) throw new Error("LLM_BASE not set — the director needs the local LLM (LM Studio / llama-server).");
  // Tag retries per batch file so the server log shows which plan step
  // dropped and reconnected (e.g. [llm:story_scenes_1]).
  const tag = rawTag ? String(rawTag).replace(/^_raw_/, "").replace(/\.log$/, "").slice(0, 60) : "director";
  try {
    const d = await llmPostChat(`${base}/v1/chat/completions`, {
      model: LLM_MODEL,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature,
      max_tokens: maxTokens,
      chat_template_kwargs: { enable_thinking: false },
    }, { timeoutMs, tag });
    const text = String(d.choices?.[0]?.message?.content ?? "");
    try {
      return stripJson(text);
    } catch (e) {
      if (rawTag) {
        try {
          fs.mkdirSync(DIRECTOR, { recursive: true });
          fs.writeFileSync(path.join(DIRECTOR, rawTag), text);
        } catch { /* raw save is best-effort */ }
      }
      throw new Error(`${e.message}${rawTag ? ` (raw response saved to director/${rawTag})` : ""}`);
    }
  } catch (e) {
    if (e?.name === "AbortError") throw new Error("LLM timed out — the model may still be loading; the story is kept, try again.");
    throw e;
  }
}

// The studio is Hindi / English / Hinglish ONLY. Some chat models default to
// Chinese when the prompt does not pin the language, so every director JSON
// payload is scanned for CJK / kana / hangul before it is saved. A leak
// fails honestly (with the offending field paths) instead of persisting
// Chinese text into the board — retrying usually returns the correct language
// now that every prompt carries an explicit OUTPUT LANGUAGE rule.
function assertNoCJK(value, what = "the model response") {
  const hits = findCJKViolations(value, "", 5);
  if (hits.length) {
    throw new Error(
      `${what} came back in Chinese/Japanese/Korean (fields: ${hits.join(", ")}) — ` +
      `the studio supports Hindi, English and Hinglish only. Try again; the prompt now pins the output language explicitly.`
    );
  }
}

async function llmChatJsonLive({ system, user, maxTokens = 16000, temperature = 0.5, timeoutMs = REQUEST_TIMEOUT_MS, rawTag = null, liveId = null, tag = "director" }) {
  const base = (process.env.LLM_BASE || "").replace(/\/+$/, "");
  if (!base) throw new Error("LLM_BASE not set — the director needs the local LLM (LM Studio / llama-server).");
  const attempts = 1 + LLM_RETRIES;
  let lastErr = null;
  for (let n = 1; n <= attempts; n++) {
    if (n > 1 && liveId) liveReset(liveId, `(retry ${n}/${attempts} — reconnected, stream restarted)`);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        signal: ctl.signal,
        headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
        body: JSON.stringify({
          model: LLM_MODEL,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          temperature,
          max_tokens: maxTokens,
          stream: true,
          chat_template_kwargs: { enable_thinking: false },
        }),
      });
      if (!r.ok) {
        const err = new Error(`LLM HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
        if (!LLM_RETRYABLE_STATUS.has(r.status)) throw err;
        lastErr = err;
        if (n >= attempts) break; // exhausted — fall through to the annotated throw below
      } else {
        let text = "";
        // Thinking-model bookkeeping (see the delta loop below): when the
        // stream ends with an EMPTY content but a non-empty reasoning buffer,
        // the model spent its whole output budget thinking (LM Studio does
        // not honor enable_thinking:false / reasoning_budget:0 for qwen3.5)
        // and the error should say THAT, not the generic "empty response".
        let reasoningBuf = "";
        let finishReason = "";
        const ct = String(r.headers.get("content-type") || "");
        if (ct.includes("text/event-stream") && r.body) {
          // OpenAI-compatible SSE: "data: {...}" per token-batch, "data: [DONE]" at the end.
          let buf = "";
          for await (const chunk of r.body) {
            buf += Buffer.from(chunk).toString("utf8");
            const lines = buf.split("\n");
            buf = lines.pop();
            for (const line of lines) {
              const m = line.match(/^\s*data:\s*(.*)\s*$/);
              if (!m || m[1] === "[DONE]") continue;
              let payload = null;
              try { payload = JSON.parse(m[1]); } catch { continue; }
              const delta = payload?.choices?.[0]?.delta?.content
                ?? payload?.choices?.[0]?.message?.content ?? "";
              if (delta) {
                text += delta;
                if (liveId) liveAppend(liveId, String(delta));
              }
              // Thinking models (qwen3.5…) stream reasoning as
              // delta.reasoning_content FIRST — often for minutes before the
              // real content starts. Surface it in the live buffer so the
              // live view shows activity during thinking; `text` (what gets
              // parsed) keeps ONLY the content.
              const think = String(payload?.choices?.[0]?.delta?.reasoning_content || "");
              if (think) {
                reasoningBuf += think;
                if (liveId) liveAppendReasoning(liveId, think);
              }
              const fr = payload?.choices?.[0]?.finish_reason;
              if (fr) finishReason = String(fr);
            }
          }
        } else {
          // Backend ignored stream:true and answered one-shot — same content.
          const d = await r.json();
          text = String(d.choices?.[0]?.message?.content ?? "");
          if (liveId && text) { liveReset(liveId); liveAppend(liveId, text); }
        }
        if (!String(text).trim() && reasoningBuf.trim()) {
          throw new Error(
            `LLM returned an empty response — the model streamed ONLY reasoning (finish_reason: ${finishReason || "unknown"}) and produced no JSON content. The output limit is spent inside the thinking phase: turn OFF "Thinking" for this model in LM Studio (or raise its output limit), then retry.`,
          );
        }
        try {
          return stripJson(text);
        } catch (e) {
          if (rawTag) {
            try {
              fs.mkdirSync(DIRECTOR, { recursive: true });
              fs.writeFileSync(path.join(DIRECTOR, rawTag), text);
            } catch { /* raw save is best-effort */ }
          }
          throw new Error(`${e.message}${rawTag ? ` (raw response saved to director/${rawTag})` : ""}`);
        }
      }
    } catch (e) {
      if (e?.name === "AbortError") throw new Error("LLM timed out — the model may still be loading; the story is kept, try again.");
      const msg = String((e && e.message) || "");
      // Treat empty response the same as truncation — the model likely hit its
      // context window limit. The scenes route will halve the batch size and retry.
      const isOutputLimit = /LLM returned an empty response|truncated|unbalanced|parse failed|no JSON/i.test(msg);
      // Parse/save errors (output-limit) are meaningful — the scenes route
      // runs its salvage path on them. Transport drops retry the whole
      // request, exactly like the non-streamed path.
      if (!isOutputLimit && !llmRetryableFetchError(e)) throw e;
      lastErr = e;
      if (n >= attempts) break; // exhausted — fall through to the annotated throw below
    } finally { clearTimeout(t); }
    // `msg` above is catch-block scoped — computing the retry log line from
    // lastErr (same rule as llmPostChat) instead avoids a ReferenceError that
    // used to crash the retry path itself as "msg is not defined".
    const wait = Math.min(30000, LLM_RETRY_BASE_MS * 2 ** (n - 1)) + Math.floor(Math.random() * 1000);
    console.warn(`[llm:${tag}] attempt ${n}/${attempts} failed (${String((lastErr && lastErr.message) || lastErr).slice(0, 160)}) — retrying in ${wait}ms`);
    await sleep(wait);
  }
  const err = lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  const offline = llmRetryableFetchError(lastErr) ||
    /LLM HTTP (502|503|504)\b/.test(String((lastErr && lastErr.message) || lastErr || ""));
  err.message = `${offline ? "LLM API offline: " : ""}${err.message} (after ${attempts} attempts)`;
  throw err;
}

// ---------------------------------------------------------------- resources
// User-uploaded images/videos library (the Resource page). Files live in
// resources/ (gitignored); resources/meta.json is the sidecar index so the
// library works with or without Postgres. Each entry carries an AI prompt:
// auto-captioned on upload when a vision model is loaded in the local LLM
// backend, otherwise generated on demand via POST /api/resources/:id/caption.
// "Use in project" wires an entry into the exact Project workflow: a new
// project is created with the caption as Master Prompt and the image (or the
// video's middle frame) installed as the pinned reference visual — from
// there AI Craft + Generate behave like any other project.
const RESOURCES = path.join(ROOT, "resources");
const RES_META = path.join(RESOURCES, "meta.json");
const WHISPERX_UPLOADS = path.join(DATA_DIR, "whisperx-uploads");
const WHISPERX_JOBS = path.join(DATA_DIR, "whisperx-jobs");
const WAV_ANALYSIS_DIR = path.join(ROOT, "WavAnalysis");
fs.mkdirSync(WHISPERX_UPLOADS, { recursive: true });
fs.mkdirSync(WHISPERX_JOBS, { recursive: true });
// AI Story Director boards (file-persisted JSON, one per story — resumable,
// debuggable, works with or without Postgres like prompts/*.json).
const DIRECTOR = path.join(ROOT, "director");
// Documentary Mode boards (same pattern: documentary/*.json offline fallback,
// documentary_boards table canonical when Postgres is up).
const DOCUMENTARY = path.join(ROOT, "documentary");
const resReadMeta = () => {
  try {
    const m = JSON.parse(fs.readFileSync(RES_META, "utf8"));
    return Array.isArray(m) ? m : [];
  } catch { return []; }
};
const resWriteMeta = (rows) => {
  fs.mkdirSync(RESOURCES, { recursive: true });
  fs.writeFileSync(RES_META, JSON.stringify(rows, null, 2));
};
const resMimeExt = (mime) => ({
  "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif",
  "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
}[String(mime || "").toLowerCase()] ?? null);
const newResId = () => `res_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}`;
// Shell out to ffmpeg/ffprobe (same binaries the stitch path relies on).
// The bare names are resolved through lib/ffmpeg.mjs so a machine without
// ffmpeg on PATH uses the static build / FFMPEG_PATH override instead of
// dying with ENOENT.
const runCmd = (cmd, args, timeoutMs = 60000) => new Promise((res, rej) => {
  const bin = cmd === "ffmpeg" ? FFMPEG : cmd === "ffprobe" ? FFPROBE : cmd;
  const p = spawn(bin, args, { windowsHide: true });
  let out = "", err = "";
  const t = setTimeout(() => { try { p.kill(); } catch { /* already dead */ } rej(new Error(`${cmd} timed out`)); }, timeoutMs);
  p.stdout.on("data", (c) => (out += c));
  p.stderr.on("data", (c) => (err += c));
  p.on("error", (e) => { clearTimeout(t); rej(e); });
  p.on("close", (code) => { clearTimeout(t); code === 0 ? res(out || err) : rej(new Error(`${cmd} exited ${code}: ${err.slice(0, 300)}`)); });
});

const runCmdStream = (cmd, args, { timeoutMs = 600000, onStderr } = {}) => new Promise((res, rej) => {
  const p = spawn(cmd, args, { windowsHide: true });
  let out = "", err = "";
  const t = timeoutMs > 0 ? setTimeout(() => { try { p.kill(); } catch { /* already dead */ } rej(new Error(`${cmd} timed out`)); }, timeoutMs) : null;
  p.stdout.on("data", (c) => { out += c.toString(); });
  p.stderr.on("data", (c) => { const s = c.toString(); err += s; if (typeof onStderr === "function") try { onStderr(s); } catch {} });
  p.on("error", (e) => { if (t) clearTimeout(t); rej(e); });
  p.on("close", (code) => { if (t) clearTimeout(t); code === 0 ? res({ out, err, code }) : rej(new Error(`${cmd} exited ${code}: ${err.slice(0, 500)}`)); });
});

const whisperxJobs = new Map(); // jobId -> { proc, boardId, cancelled, ... }

// WhisperX owns the same GPU the render queue uses. Two large-v2 jobs at once
// starve VRAM and look like "analysis failed" to the user, so only ONE may run.
// In-memory jobs are the authority here: a job is active from creation until
// its close/error handler clears it (the brief window before `proc` is set is
// still active — checking `proc` used to let a second click through).
const whisperxActiveJob = () => [...whisperxJobs.values()].find((j) =>
  (j.status === "pending" || j.status === "running") && !j.cancelled);

// A server restart kills the spawned python but leaves job.json saying
// "running". Recover those honestly instead of polling a dead job forever.
for (const name of fs.readdirSync(WHISPERX_JOBS)) {
  const file = path.join(WHISPERX_JOBS, name, "job.json");
  if (!fs.existsSync(file)) continue;
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (j.status === "pending" || j.status === "running") {
      j.status = "failed";
      j.error = "server restarted while this WhisperX job was running — run the analysis again";
      j.proc = undefined;
      fs.writeFileSync(file, JSON.stringify(j, null, 2));
    }
  } catch { /* a corrupt job.json is never a reason to fail boot */ }
}

const whisperxConfig = () => ({
  python: process.env.WHISPERX_PYTHON || process.env.PYTHON || "python",
  whisperxCmd: process.env.WHISPERX_CMD || null,
  model: process.env.WHISPERX_MODEL || "large-v2",
  device: process.env.WHISPERX_DEVICE || "cuda",
  batchSize: process.env.WHISPERX_BATCH_SIZE || "16",
  computeType: process.env.WHISPERX_COMPUTE_TYPE || "float16",
});

const whisperxPreflightCheck = async () => {
  const checks = {};
  const python = process.env.WHISPERX_PYTHON || process.env.PYTHON || "python";
  const whisperxCmd = process.env.WHISPERX_CMD || "whisperx";
  try {
    const r = await runCmd(python, ["--version"], 10000).catch(() => null);
    checks.python = { ok: !!r, message: r ? String(r).trim() : "not found" };
  } catch (e) {
    checks.python = { ok: false, message: e.message };
  }
  try {
    // try to import whisperx
    const r = await runCmd(python, ["-c", "import whisperx; print('ok')"], 15000).catch((e) => null);
    checks.whisperx = { ok: !!r, message: r ? "available" : "not importable" };
  } catch (e) {
    checks.whisperx = { ok: false, message: e.message };
  }
  try {
    const r = await runCmd("ffmpeg", ["-version"], 10000).catch(() => null);
    checks.ffmpeg = { ok: !!r, message: r ? "ok" : "not found" };
  } catch (e) {
    checks.ffmpeg = { ok: false, message: e.message };
  }
  checks.writable = { ok: fs.existsSync(WHISPERX_UPLOADS) && fs.existsSync(WHISPERX_JOBS), message: "ok" };
  const ok = checks.python?.ok && checks.whisperx?.ok && checks.ffmpeg?.ok && checks.writable?.ok;
  // Report WHICH interpreter is used — the dedicated venv (C:\WhisperX-env by
  // default via .env) is the common source of confusion when a job misbehaves.
  return { ok, checks, config: whisperxConfig() };
};

async function videoDurationSec(full) {
  try {
    const out = await runCmd("ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", full], 30000);
    const n = Number(String(out).trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}
async function analyzeDirectorAudio(full) {
  // Decode to low-rate mono float PCM so the analysis remains bounded even
  // for longer songs. The upload itself is never modified.
  const cacheFile = `${full}.features-v2.json`;
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    // v2 carries the audio-activity estimate (v1 was shapeless vocalActivity) —
    // an old v1 cache is treated as stale, never served.
    if (cached && cached.version === 2) return cached.analysis;
  } catch { /* first analysis or stale/corrupt cache */ }
  const sampleRate = 11025;
  const child = spawn(FFMPEG, ["-v", "error", "-i", full, "-vn", "-ac", "1", "-ar", String(sampleRate), "-f", "f32le", "pipe:1"], { windowsHide: true });
  const chunks = [];
  let bytes = 0, stderr = "";
  const timeout = setTimeout(() => { try { child.kill(); } catch {} }, 240000);
  child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > 240 * 1024 * 1024) child.kill(); else chunks.push(chunk); });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`FFmpeg audio decode failed (${code}): ${stderr.slice(-500)}`)));
  }).finally(() => clearTimeout(timeout));
  const pcmBuffer = Buffer.concat(chunks);
  const aligned = pcmBuffer.length - (pcmBuffer.length % 4);
  const pcm = new Float32Array(aligned / 4);
  for (let i = 0; i < pcm.length; i++) pcm[i] = pcmBuffer.readFloatLE(i * 4);
  const analysis = analyzePcm(pcm, sampleRate);
  try { fs.writeFileSync(cacheFile, JSON.stringify({ version: 2, analysis }), "utf8"); } catch { /* cache is best-effort */ }
  return analysis;
}
// One song / narration analysis for BOTH the Director and the Sanskriti Kids
// Song & Audio studios (the studio must never build a second analyzer).
// Measures duration, silence and beats, transcribes with local Whisper when
// it is configured, then asks the local LLM for the section structure. The
// heuristic fallback keeps the studio usable when the model is offline.
async function analyzeSongAudio(body = {}) {
  const title = String(body.title || "Untitled Song").slice(0, 120);
  let lyrics = String(body.lyrics || "").trim();
  const genre = String(body.genre || "Kids");
  const language = String(body.language || "English");
  const audioMode = body.audioMode === "story" ? "story" : "song";
  const durationSeconds = Number(body.durationSeconds) || 0;
  let hasLyrics = lyrics.length >= 20;
  let transcript = { status: "not_configured", text: "", segments: [], note: "Configure WHISPER_CPP_BIN and WHISPER_MODEL to enable local Whisper transcription." };
  let measured = { meanVolumeDb: null, peakVolumeDb: null, silenceRanges: [], source: "ffmpeg", signal: null };
  const audioName = String(body.file || "");
  if (isSafe(audioName) && /\.(mp3|wav|m4a)$/i.test(audioName)) {
    const audioPath = path.join(DIRECTOR, audioName);
    if (fs.existsSync(audioPath)) {
      try {
        measured.signal = await analyzeDirectorAudio(audioPath);
        const output = await runCmd("ffmpeg", ["-hide_banner", "-i", audioPath, "-af", "volumedetect,silencedetect=n=-35dB:d=0.35", "-f", "null", "-"], 180000);
        const text = String(output);
        const mean = text.match(/mean_volume:\s*(-?[\d.]+)\s*dB/i);
        const peak = text.match(/max_volume:\s*(-?[\d.]+)\s*dB/i);
        const starts = [...text.matchAll(/silence_start:\s*([\d.]+)/g)].map(m => Number(m[1]));
        const ends = [...text.matchAll(/silence_end:\s*([\d.]+)/g)].map(m => Number(m[1]));
        measured.meanVolumeDb = mean ? Number(mean[1]) : null;
        measured.peakVolumeDb = peak ? Number(peak[1]) : null;
        measured.silenceRanges = starts.map((start, i) => ({ start: Math.round(start * 10) / 10, end: Math.round((ends[i] ?? durationSeconds) * 10) / 10 }));
      } catch (e) { measured.source = "unavailable"; measured.warning = e.message; }
    }
  }
  const whisperBin = String(process.env.WHISPER_CPP_BIN || "").trim();
  const whisperModel = String(process.env.WHISPER_MODEL || "").trim();
  const transcriptAudio = path.join(DIRECTOR, audioName);
  if (isSafe(audioName) && /\.(mp3|wav|m4a)$/i.test(audioName) && fs.existsSync(transcriptAudio)) {
    const tempBase = path.join(DIRECTOR, `_whisper_${crypto.randomUUID()}`);
    try {
      let result;
      let engine;
      if (whisperBin && whisperModel) {
        const wav = `${tempBase}.wav`;
        await runCmd("ffmpeg", ["-y", "-v", "error", "-i", transcriptAudio, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], 180000);
        const whisperLang = ({ Hindi: "hi", English: "en", Hinglish: "auto" })[language] || "auto";
        await new Promise((resolve, reject) => {
          const proc = spawn(whisperBin, ["-m", whisperModel, "-f", wav, "-l", whisperLang, "-oj", "-of", tempBase, "-np"], { windowsHide: true });
          let err = "";
          const timer = setTimeout(() => { try { proc.kill(); } catch {} reject(new Error("Whisper transcription timed out")); }, 900000);
          proc.stderr.on("data", c => { err = (err + c.toString()).slice(-3000); });
          proc.on("error", e => { clearTimeout(timer); reject(e); });
          proc.on("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Whisper exited ${code}: ${err}`)); });
        });
        const jsonPath = `${tempBase}.json`;
        if (!fs.existsSync(jsonPath)) throw new Error("whisper.cpp completed without JSON output");
        result = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
        engine = "whisper.cpp";
      }
      if (result) {
        const segments = Array.isArray(result.transcription) ? result.transcription : Array.isArray(result.segments) ? result.segments : [];
        transcript = {
          status: "complete",
          text: String(result.text || segments.map(s => s.text || "").join(" ")).trim(),
          segments: segments.map(s => ({ start: Number(s.offsets?.from ?? s.start ?? 0) / (s.offsets?.from != null ? 1000 : 1), end: Number(s.offsets?.to ?? s.end ?? 0) / (s.offsets?.to != null ? 1000 : 1), text: String(s.text || "").trim() })).filter(s => s.text),
          note: `${engine} transcript — review and edit before story planning.`,
        };
      }
    } catch (e) { transcript = { status: "unavailable", text: "", segments: [], note: e.message }; }
    finally { for (const suffix of [".wav", ".json", ".txt", ".srt", ".vtt"]) try { fs.unlinkSync(`${tempBase}${suffix}`); } catch {} }
  }
  if (!hasLyrics && transcript.status === "complete" && transcript.text.length >= 20) {
    lyrics = transcript.text;
    hasLyrics = true;
  }

  const heuristic = () => {
    // Rough structure guess: split duration into 3-4 equal segments.
    const n = durationSeconds > 0 ? Math.min(4, Math.max(2, Math.round(durationSeconds / 20))) : 2;
    const segDur = Math.round(durationSeconds / n) || 30;
    const segments = [];
    let cursor = 0;
    for (let i = 0; i < n; i++) {
      const end = i === n - 1 ? durationSeconds : cursor + segDur;
      segments.push({
        start: cursor,
        end: Math.min(end, durationSeconds),
        label: i === 0 ? "Intro" : i === n - 1 ? "Outro" : `Part ${i + 1}`,
        mood: "cheerful",
        action: "scene develops",
      });
      cursor = end;
    }
    return {
      mood: "cheerful, gentle, child-friendly",
      structure: "verse-chorus with repeating motifs",
      narrationStyle: "warm, expressive, clear pronunciation",
      visualStyle: "bright, colorful, simple shapes",
      educationalFocus: "learning through repetition",
      segments,
      source: "heuristic",
      measured,
      transcript,
    };
  };

  if (!durationSeconds || durationSeconds <= 0) {
    return { error: "song duration required — upload the audio first", status: 400 };
  }

  try {
    const raw = await llmChatJson({
      system: audioMode === "story"
        ? `Analyze uploaded spoken narration/dialogue for a children's story video. Reply JSON only. Use transcript and measured facts provided: infer narration delivery, emotional tone, pauses and broad story-audio sections; do not invent words or measurements and do not impose music/beat-cut rules. Return mood, structure, narrationStyle, visualStyle, educationalFocus and 2-6 segments (start/end seconds, label, mood, action) covering 0-${durationSeconds}s. Write everything in English. NEVER write Chinese, Japanese or Korean.`
        : `You analyze children's songs for AI video generation. Reply with JSON only. Given title, lyrics, duration, genre/language and measured audio features, infer mood, likely narrative/song style and visual recommendations. Do not claim audio measurements. When measured beat times exist, use them as anchors and return 2-6 broad musical sections with approximate boundaries; do not claim verse/chorus as certain without lyric evidence. Return mood, structure, narrationStyle, visualStyle, educationalFocus and segments (start/end seconds, label, mood, action). Segment times must cover 0-${durationSeconds}s. Write everything in English. NEVER write Chinese, Japanese or Korean.`,
      user: JSON.stringify({
        title,
        lyrics: hasLyrics ? lyrics.slice(0, 4000) : "(no lyrics — instrumental)",
        genre,
        language,
        durationSeconds,
        hasLyrics,
        audioMode,
        measuredAudio: measured,
      }),
      maxTokens: 800,
      temperature: 0.3,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    const segs = Array.isArray(raw.segments) ? raw.segments : [];
    const cleanSegments = segs.map((s, i) => ({
      start: Number.isFinite(Number(s.start)) ? Math.max(0, Math.round(Number(s.start) * 10) / 10) : Math.round((i / Math.max(1, segs.length)) * durationSeconds * 10) / 10,
      end: Number.isFinite(Number(s.end)) ? Math.min(durationSeconds, Math.round(Number(s.end) * 10) / 10) : Math.round(((i + 1) / Math.max(1, segs.length)) * durationSeconds * 10) / 10,
      label: String(s.label || `Part ${i + 1}`).slice(0, 40),
      mood: String(s.mood || "cheerful").slice(0, 60),
      action: String(s.action || "scene develops").slice(0, 80),
    }));
    // Ensure segments cover 0 to durationSeconds with no gaps.
    if (cleanSegments.length) {
      cleanSegments[0].start = 0;
      cleanSegments[cleanSegments.length - 1].end = durationSeconds;
      for (let i = 1; i < cleanSegments.length; i++) {
        if (cleanSegments[i].start < cleanSegments[i - 1].end) cleanSegments[i].start = cleanSegments[i - 1].end;
      }
    }

    return {
      title,
      durationSeconds,
      mood: String(raw.mood || "cheerful, gentle, child-friendly").slice(0, 120),
      structure: String(raw.structure || "verse-chorus").slice(0, 160),
      narrationStyle: String(raw.narrationStyle || "warm, expressive, clear").slice(0, 160),
      visualStyle: String(raw.visualStyle || "bright, colorful, simple").slice(0, 160),
      educationalFocus: String(raw.educationalFocus || "learning through repetition").slice(0, 160),
      segments: cleanSegments,
      source: "llm",
      hasLyrics,
      measured,
      transcript,
      lyrics: hasLyrics ? lyrics : "",
    };
  } catch (e) {
    console.warn("[director/analyze-song] LLM failed, heuristic fallback:", e.message);
    return { ...heuristic(), lyrics: hasLyrics ? lyrics : "" };
  }
}

// ---------------------------------------------------------------------------
// The MEANING-AWARE semantic analysis (lib/semantics.mjs).
//
// Every source line of a board is analysed BEFORE the scenes are planned:
// the language is detected, the important verbs are turned into visible
// actions, the camera is chosen from the narrative meaning and the line's
// meaning is recorded. The deterministic pass always runs (offline, instant);
// the configured local model enriches it (subject/target disambiguation,
// cultural context, arbitrary verbs) and a malformed answer never loses the
// deterministic reading.
// ---------------------------------------------------------------------------

/** The numbered source lines a board plans from (lyric lines or story lines). */
function directorSourceLines(board) {
  const b = board && typeof board === "object" ? board : {};
  const lyric = boardLyricLines(b);
  if (Array.isArray(lyric) && lyric.length) {
    return lyric.map((l, i) => ({
      id: Number(l.lyric_line_id || l.line_id) || i + 1,
      text: String(l.lyric_text ?? l.text ?? l.line ?? ""),
    })).filter((l) => l.text);
  }
  const story = String((b.input && b.input.story) || "");
  return story.split(/\n+/).map((t) => t.trim()).filter(Boolean)
    .map((text, i) => ({ id: i + 1, text }));
}

// Array guard used by the semantics wrappers below (same helper as
// lib/semantics.mjs — defined here because those wrappers are server-local).
const arr = (v) => (Array.isArray(v) ? v : []);

/** The deterministic analysis of a set of lines (no model, no network). */
function analyzeLinesDeterministic(lines, { language = "auto", bible = null, genre = "" } = {}) {
  return arr(lines).map((l, i) => analyzeLine(l.text, {
    index: i,
    language,
    bible,
    genre,
    duration: Number(l.duration_seconds) || 5,
  }));
}

/**
 * The model-assisted pass. The ORIGINAL text always comes from the source
 * lines — the model can only enrich the reading, never replace the line.
 */
async function enrichSemanticsWithModel(lines, { language = "auto", bible = null, genre = "", styleLock = "", timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const src = arr(lines);
  if (!src.length) return { rows: [], source: "none" };
  try {
    const raw = await llmChatJsonLive({
      system: SEMANTIC_SYSTEM,
      user: buildSemanticAnalysisPrompt(src, { language, genre, bible, styleLock }),
      maxTokens: 6000,
      temperature: 0.2,
      timeoutMs,
      rawTag: `_raw_semantics_${Date.now().toString(36)}.log`,
      liveId: null,
      tag: "semantics",
    });
    try {
      assertNoCJK(raw, "the semantic analysis");
    } catch (e) {
      return { rows: [], source: "offline", warning: `${e.message} — the deterministic analysis is used` };
    }
    const merged = mergeModelSemantics(raw, src, { language, genre });
    if (!Array.isArray(merged) || merged.length !== src.length) {
      return { rows: [], source: "malformed", warning: "the model returned an unexpected number of lines — the deterministic analysis is used" };
    }
    return { rows: merged, source: "llm" };
  } catch (e) {
    return { rows: [], source: "offline", warning: `the model could not enrich the meaning (${String(e.message || e).slice(0, 160)}) — the deterministic analysis is used` };
  }
}

/**
 * Attach the meaning to the scenes: the scene that covers a line carries that
 * line's source text, interpretation, action plan, camera rationale and
 * beats. A scene that misses the meaning is REPAIRED deterministically and
 * flagged — never silently accepted.
 */
function attachSemanticsToScenes(board, semantics) {
  const rows = arr(semantics && semantics.lines);
  if (!rows.length) return { attached: 0, repaired: 0, issues: [] };
  const byId = new Map();
  rows.forEach((r) => byId.set(Number(r.line_id), r));
  let attached = 0;
  let repaired = 0;
  const issues = [];
  for (const scene of arr(board.scenes)) {
    // The scene names the line it covers (line_from/line_to); the first
    // covered line is its source line.
    const from = Number(scene.line_from) || 0;
    const to = Number(scene.line_to) || from;
    let sem = from ? byId.get(from) : null;
    if (!sem) {
      // Fall back to the first line whose number is covered by the scene.
      for (const [id, r] of byId.entries()) {
        if (!from || (id >= from && id <= to)) { sem = r; break; }
      }
    }
    if (!sem) continue;
    attachSemantics(scene, sem);
    attached += 1;
    const check = validateSceneSemantics(scene, sem);
    if (!check.ok) {
      issues.push(`Scene ${scene.scene_number}: ${check.errors.slice(0, 2).join("; ")}`);
      // The deterministic repair fills the camera, the action plan and the
      // beats from the meaning — it never invents a new action.
      repairSceneSemantics(scene, sem);
      repaired += 1;
    }
  }
  return { attached, repaired, issues };
}

/** The semantic issues of a board (the validate route + the repair prompt). */
function boardSemanticIssues(board) {
  const rows = arr(board && board.semantics && board.semantics.lines);
  if (!rows.length) return [];
  const byId = new Map(rows.map((r) => [Number(r.line_id), r]));
  const issues = [];
  for (const scene of arr(board && board.scenes)) {
    const from = Number(scene.line_from) || 0;
    const sem = from ? byId.get(from) : null;
    if (!sem) continue;
    const check = validateSceneSemantics(scene, sem);
    for (const e of check.errors.slice(0, 3)) issues.push(`Scene ${scene.scene_number}: ${e}`);
    for (const w of (check.warnings || []).slice(0, 2)) issues.push(`Scene ${scene.scene_number}: ${w}`);
  }
  // Camera-only repeats feed the SAME staged repair as the per-scene issues.
  // Each note names its scene numbers so the repair route auto-targets them.
  for (const note of flagRepeatStaging(arr(board && board.scenes))) issues.push(note);
  return issues;
}

/** The scene prompt needs the meaning of the lines it plans from. */
function semanticsForBatch(board, batchLines) {
  const rows = arr(board && board.semantics && board.semantics.lines);
  if (!rows.length) return [];
  const wanted = new Set(arr(batchLines).map((l) => Number(l.lyric_line_id || l.line_id)).filter(Boolean));
  if (!wanted.size) return rows.slice(0, 12);
  const picked = rows.filter((r) => wanted.has(Number(r.line_id)));
  return picked.length ? picked : rows.slice(0, 12);
}

/**
 * Meaning-variation guard for THIS batch only. Reads the same stored semantic
 * rows the real batch just wrote, so Show prompt (prompt-preview) and the real
 * Generate / Continue call render the identical block. Strict line-id filters
 * (never the fallback in semanticsForBatch) keep unrelated lines out.
 */
function semanticVariationForBatch(board, batchLines, freshRows = null) {
  const ids = new Set(arr(batchLines)
    .map((l) => Number(l && (l.lyric_line_id || l.line_id))).filter((n) => n > 0));
  const texts = new Set(arr(batchLines)
    .map((l) => String((l && (l.lyric_text ?? l.text ?? l.line)) ?? "")).filter(Boolean));
  if (!ids.size && !texts.size) return "";
  const stored = arr(board && board.semantics && board.semantics.lines);
  const rows = arr(freshRows).length ? arr(freshRows) : stored;
  const picked = rows.filter((r) => r && (ids.has(Number(r.line_id))
    || texts.has(String(r.source_text ?? r.text ?? ""))));
  return buildSemanticVariationContext(picked);
}

// ---------------------------------------------------------------------------
// Sanskriti Kids — the studio workflow helpers.
//
// They orchestrate the EXISTING engines (the local LLM, the shared song
// analyzer, the FFmpeg pipeline) and persist through the kids store. The
// studio never renders on its own: images, clips, voices and the final cut
// stay in the workspace / Director engines.
// ---------------------------------------------------------------------------

const kidsFail = (message, status = 400) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

// The story job gives up after 8 minutes: a local model on a big document can
// take minutes, but a job must never hang forever.
const KIDS_STORY_TIMEOUT_MS = Number(process.env.KIDS_STORY_TIMEOUT_MS || 8 * 60 * 1000);

// ---------------------------------------------------------------- kids library
// The Sanskriti Kids asset library stores its generated reference stills under
// kids/<scope>/<Kind>/<key>/ (gitignored working storage, like devotional/).
const KIDS_DIR = process.env.KIDS_DIR
  ? path.resolve(process.env.KIDS_DIR)
  : path.join(ROOT, "kids");
const KIDS_LIB_KIND_DIR = { character: "Characters", location: "Locations", prop: "Props" };
// One generator at a time — the ComfyUI queue is serial.
let kidsPumping = false;
const kidsProcs = new Map();

/** The folder that holds one library asset's files. */
function kidsAssetDir(asset) {
  const scope = String(asset?.scope || "shared").replace(/[^A-Za-z0-9_-]/g, "_") || "shared";
  const kindDir = KIDS_LIB_KIND_DIR[String(asset?.kind)] || "Assets";
  const key = String(asset?.asset_key || "asset").replace(/[^A-Za-z0-9_-]/g, "_") || "asset";
  return path.join(KIDS_DIR, scope, kindDir, key);
}

/**
 * The library reference pump: renders ONE still per job with the Flux
 * Reference Image workflow. THE PROMPT IS PASSED VERBATIM — only the prompt
 * node of the workflow changes; nothing is appended to the prompt and no
 * negative text is invented.
 */
async function kidsPumpJobs() {
  const store = kidsStore();
  if (kidsPumping || !store) return;
  kidsPumping = true;
  const db = store === "pg" ? kidsPool : kidsDb;
  try {
    if ([...kidsProcs.values()].some((p) => p.exitCode === null)) return;
    let job = null;
    if (store === "pg") {
      const q = await kidsPool.query(
        "SELECT * FROM kids_jobs WHERE status = 'PENDING' AND kind = 'library_reference' ORDER BY created_at LIMIT 1"
      ).catch(() => null);
      job = q?.rows?.[0] ?? null;
    } else if (kidsDb) {
      job = kidsDb.prepare(
        "SELECT * FROM kids_jobs WHERE status = 'PENDING' AND kind = 'library_reference' ORDER BY created_at LIMIT 1",
      ).get();
    }
    if (!job) return;
    job = kidsJobRow(job);
    const meta = job.metadata && typeof job.metadata === "object" ? job.metadata : {};
    const assetId = Number(meta.asset_id) || 0;
    const asset = assetId ? await kidsGetLibraryAsset(store, db, assetId) : null;
    if (!asset) {
      await kidsUpsertJob(store, db, {
        id: job.id, project_id: job.project_id, kind: job.kind, status: "FAILED",
        error_message: "the library asset was deleted", metadata: meta,
      });
      return;
    }
    // THE SAVED PROMPT — verbatim, exactly as the user stored it.
    const prompt = String(asset.prompt || "").trim();
    if (!prompt) {
      await kidsUpsertJob(store, db, {
        id: job.id, project_id: job.project_id, kind: job.kind, status: "FAILED",
        error_message: "this asset has no saved prompt — write one first", metadata: meta,
      });
      return;
    }
    const dir = kidsAssetDir(asset);
    fs.mkdirSync(dir, { recursive: true });
    let file = "reference.png", n = 2;
    while (fs.existsSync(path.join(dir, file))) file = `reference_v${n++}.png`;
    const outFile = path.join(dir, file);
    const rel = path.relative(KIDS_DIR, outFile).split(path.sep).join("/");
    // The image workflow for this job (the header dropdown's choice rides on
    // the job row). The library default is the Flux Reference Image workflow.
    const imageWf = resolveImageWorkflow(String(meta.workflow || ""), DEFAULT_IMAGE_WORKFLOW);
    await kidsUpsertJob(store, db, {
      id: job.id, project_id: job.project_id, kind: job.kind, status: "PROCESSING",
      error_message: null, metadata: { ...meta, file, rel },
    });
    // ONLY the prompt is passed — no negative, no extra text.
    const procArgs = ["scripts/kids_reference.mjs", "--workflow", imageWf.id,
      "--prompt", prompt, "--out", outFile,
      "--width", String(imageWf.width), "--height", String(imageWf.height),
      "--steps", String(imageWf.steps)];
    const proc = spawn(process.execPath, procArgs, { cwd: ROOT, env: process.env, windowsHide: true });
    kidsProcs.set(job.id, proc);
    let log = "";
    proc.stdout?.on("data", (d) => (log += d.toString()));
    proc.stderr?.on("data", (d) => (log += d.toString()));
    proc.on("close", async (code) => {
      kidsProcs.delete(job.id);
      try {
        if (code === 0 && fs.existsSync(outFile)) {
          await kidsInsertLibraryFile(store, db, {
            asset_id: asset.id, file_path: rel, kind: "image", prompt,
            workflow: imageWf.workflow, model: imageWf.model, status: "COMPLETED",
          });
          // The generated still becomes the asset's reference image and the
          // asset moves to "review" — the user still has to approve it.
          await kidsUpdateLibraryAsset(store, db, asset.id, {
            reference_image: rel,
            status: asset.status === "approved" ? "approved" : "review",
          });
          await kidsUpsertJob(store, db, {
            id: job.id, project_id: job.project_id, kind: job.kind, status: "COMPLETED",
            error_message: null, metadata: { ...meta, file: rel, workflow: imageWf.id },
          });
        } else {
          try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch { /* orphan cleanup */ }
          const msg = `reference generation failed: ${String(log).trim().slice(-500) || `exit ${code}`} — check COMFY_BASE and retry`;
          await kidsUpsertJob(store, db, {
            id: job.id, project_id: job.project_id, kind: job.kind, status: "FAILED",
            error_message: msg, metadata: meta,
          });
        }
      } catch (e) { console.warn("[kids] reference job finish failed:", e.message); }
      void kidsPumpJobs(); // chain the next PENDING job
    });
  } catch (e) {
    console.warn("[kids] pump failed:", e.message);
  } finally {
    kidsPumping = false;
  }
}

/**
 * The Story Studio feeds the asset library: every character, location and
 * prop the story names becomes a library row (draft, never auto-approved)
 * so the look can be approved once and reused in every scene.
 */
async function syncLibraryFromStory(store, db, project, story) {
  const s = normalizeKidsStory(story);
  const scope = project.id;
  const make = (kind, key, name, category, prompt, extra = {}) => ({
    scope, project_id: scope, kind,
    asset_key: key, name, category,
    description: extra.description || "",
    tags: extra.tags || [],
    prompt: prompt || extra.description || "",
    reference_image: extra.reference_image || "",
    appearance: extra.appearance || "",
    clothing: extra.clothing || "",
    colors: extra.colors || "",
    personality: extra.personality || "",
    voice: extra.voice || "",
    movement: extra.movement || "",
    age_appearance: extra.age_appearance || "",
    version: 1, status: "draft", locked: false, metadata: {},
  });
  for (const c of s.characters) {
    const key = String(c.character_id || c.name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
    if (!key) continue;
    const prompt = [c.appearance, c.clothing, c.colors].filter(Boolean).join(", ");
    await kidsInsertLibraryAsset(store, db, make("character", key, c.name || key, c.category || c.role || "Character",
      prompt, {
        appearance: c.appearance, clothing: c.clothing, colors: c.colors,
        personality: c.personality, voice: c.voice, movement: c.movement,
        description: c.appearance,
      }));
  }
  const locations = new Set();
  const props = new Set();
  for (const scene of s.scenes) {
    if (scene.location) locations.add(scene.location);
    for (const p of scene.props) props.add(p);
  }
  for (const loc of locations) {
    const key = String(loc).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
    if (!key) continue;
    await kidsInsertLibraryAsset(store, db, make("location", key, loc, "Location", loc, { description: loc }));
  }
  for (const prop of props) {
    const key = String(prop).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
    if (!key) continue;
    await kidsInsertLibraryAsset(store, db, make("prop", key, prop, "Prop", prop, { description: prop }));
  }
}

/** The Story Studio: the AI writes the story document, the store versions it. */async function generateKidsStory(store, db, project, body = {}) {
  const options = await kidsOptions(store, db);
  const draft = normalizeKidsProject({ ...project, ...body }, { options });
  if (!hasScript(draft.script) && !hasScript(draft.lyrics)) {
    throw kidsFail("the project needs a script or lyrics before the story can be written");
  }
  let story;
  try {
    // STREAMED: a local model needs minutes for a story document and a
    // one-shot request would hit the HTTP client's headers timeout. The
    // shared streamed helper returns the same parsed JSON.
    const raw = await llmChatJsonLive({
      system: KIDS_DIRECTOR_SYSTEM,
      user: buildKidsStoryPrompt(draft),
      maxTokens: 4000,
      temperature: 0.7,
      timeoutMs: KIDS_STORY_TIMEOUT_MS,
      rawTag: `_raw_${project.id}_kids_story.log`,
      liveId: null,
      tag: "kids_story",
    });
    assertNoCJK(raw, "the kids story");
    story = normalizeKidsStory(raw);
  } catch (e) {
    throw kidsFail(`the story could not be written: ${String(e.message || e).slice(0, 300)}`, 502);
  }
  if (!isKidsStorySubstantive(story)) {
    throw kidsFail("the model returned an empty story — try again", 502);
  }
  const saved = await kidsSaveStory(store, db, project.id, story, { status: "draft", note: "AI generated" });
  // The story feeds the character / location / prop library.
  try { await syncLibraryFromStory(store, db, project, story); }
  catch (e) { console.warn("[kids] library sync failed:", e.message); }
  return saved;
}

/** The Song & Lyrics Studio: segment the lyrics (deterministic + AI). */
async function analyzeKidsLyrics(store, db, project, body = {}) {
  const lyrics = String(body.lyrics || project.lyrics || project.script || "").trim();
  if (!lyrics) throw kidsFail("paste the lyrics first");
  const duration = Number(body.duration_seconds) || Number(project.duration_seconds) || 0;
  // The deterministic segmentation always works (offline, no model needed).
  const fallback = segmentLyrics(lyrics);
  let sections = fallback.map((s) => ({ label: s.label, lines: s.lines, text: s.text }));
  let source = "deterministic";
  let analysis = null;
  // The deterministic segmentation is the default (fast + offline). The AI
  // labelling is opt-in because a local model needs minutes.
  if (body.use_llm === true) {
    try {
      const raw = await llmChatJsonLive({
        system: "You segment children's song lyrics into verse / chorus / intro / outro / instrumental sections and propose simple, repeatable choreography for children. Reply JSON only.",
        user: buildKidsSongPrompt(project, { lyrics, measured: body.measured || null }),
        maxTokens: 2500,
        temperature: 0.4,
        timeoutMs: REQUEST_TIMEOUT_MS,
        rawTag: `_raw_${project.id}_kids_song.log`,
        liveId: null,
        tag: "kids_song",
      });
      const ai = Array.isArray(raw.sections) ? raw.sections : [];
      if (ai.length) {
        sections = ai.map((s) => ({
          label: s.label,
          lines: Array.isArray(s.lines) ? s.lines : [],
          text: String(s.text || (Array.isArray(s.lines) ? s.lines.join("\n") : "")),
          emotion: s.emotion,
          character_ids: s.characters || s.character_ids || [],
          choreography: s.choreography || s.action || "",
          lip_sync: s.lip_sync === true,
        }));
        source = "llm";
      }
      analysis = {
        mood: String(raw.mood || "").slice(0, 200),
        structure: String(raw.structure || "").slice(0, 200),
        educational_focus: String(raw.educationalFocus || "").slice(0, 200),
        visual_style: String(raw.visualStyle || "").slice(0, 200),
        warnings: Array.isArray(raw.warnings) ? raw.warnings.map(String).slice(0, 10) : [],
      };
    } catch (e) {
      analysis = {
        warnings: [
          `the model could not label the song (${String(e.message || e).slice(0, 160)}) — the deterministic segmentation is used instead`,
        ],
      };
    }
  }
  const canonical = normalizeLyricSections(sections, { totalDuration: duration });
  const rows = canonical.map((s, i) => ({
    seq: i,
    label: s.label,
    lines: s.lines,
    text: s.text,
    start_seconds: s.start_seconds,
    end_seconds: s.end_seconds,
    emotion: s.emotion,
    character_ids: s.character_ids,
    choreography: s.choreography,
    lip_sync: s.lip_sync,
    estimated: s.estimated,
  }));
  const saved = await kidsReplaceLyricSections(store, db, project.id, rows);
  await kidsUpsertJob(store, db, {
    id: `kids_lyrics_${project.id}_${Date.now().toString(36)}`,
    project_id: project.id, kind: "lyrics", status: "COMPLETED",
    error_message: null, metadata: { sections: saved.length, source },
  });
  return { sections: saved, source, analysis, lyrics };
}

/** The Audio Analysis studio: measure the source audio into a timeline. */
async function analyzeKidsAudio(store, db, project, body = {}) {
  const file = String(body.file || project.audio_path || "").trim();
  if (!file) throw kidsFail("no audio file is attached to this project — upload one first");
  const meta = project.metadata && typeof project.metadata === "object" ? project.metadata : {};
  const metaAudio = meta.audio && typeof meta.audio === "object" ? meta.audio : {};
  const duration = Number(body.duration_seconds) || Number(metaAudio.duration_seconds) || 0;
  const audioMode = body.audioMode === "story" ? "story" : "song";
  const result = await analyzeSongAudio({
    title: project.title,
    lyrics: body.lyrics || project.lyrics || project.script || "",
    genre: "Kids",
    language: project.language,
    audioMode,
    durationSeconds: duration,
    file,
  });
  if (result && result.error) throw kidsFail(result.error, result.status || 400);
  const total = Number(result.durationSeconds) || duration;
  const transcript = (result.transcript && result.transcript.segments) || [];
  const windows = transcript
    .map((w) => ({
      start: Number(w.start) || 0,
      end: Number(w.end) || 0,
      text: String(w.text || "").trim(),
    }))
    .filter((w) => w.text && w.end > w.start)
    .sort((a, b) => a.start - b.start);
  const sections = (result.segments || [])
    .map((s) => ({
      start: Number(s.start) || 0,
      end: Number(s.end) || 0,
      label: String(s.label || "").slice(0, 60),
      mood: String(s.mood || "").slice(0, 60),
      action: String(s.action || "").slice(0, 200),
    }))
    .filter((s) => s.end > s.start);
  const raw = [];
  const fill = (from, to) => {
    if (to - from < 0.05) return;
    const inSection = sections.find((s) => s.start <= from + 0.01 && s.end >= to - 0.01);
    raw.push({
      start_seconds: from,
      end_seconds: to,
      type: "music",
      text: "",
      emotion: inSection ? inSection.mood : "",
      music_note: inSection ? inSection.label : "Instrumental passage",
      action: inSection ? inSection.action : "",
      estimated: !inSection,
    });
  };
  let cursor = 0;
  for (const w of windows) {
    fill(cursor, w.start);
    raw.push({
      start_seconds: w.start,
      end_seconds: w.end,
      type: audioMode === "story" ? "narration" : "singing",
      text: w.text,
      emotion: "",
      music_note: "",
      estimated: false,
    });
    cursor = Math.max(cursor, w.end);
  }
  fill(cursor, total);
  const rows = buildKidsAudioTimeline(raw, { duration: total });
  const saved = await kidsReplaceAudioSegments(store, db, project.id, rows.map((r, i) => ({
    seq: i,
    start_seconds: r.start_seconds,
    end_seconds: r.end_seconds,
    duration_seconds: r.duration_seconds,
    type: r.type,
    speaker: r.speaker,
    text: r.text,
    emotion: r.emotion,
    character: r.character,
    action: r.action,
    scene: r.scene,
    background: r.background,
    camera: r.camera,
    music_note: r.music_note,
    sound_effect: r.sound_effect,
    confidence: r.confidence,
    estimated: r.estimated,
  })));
  // The measured facts are kept with the project so the QC stage can use them.
  const meta2 = project.metadata && typeof project.metadata === "object" ? project.metadata : {};
  const measured = (result.measured && typeof result.measured === "object") ? result.measured : {};
  await kidsUpdateProject(store, db, project.id, {
    metadata: {
      ...meta2,
      audio: {
        duration_seconds: total,
        measured,
        mood: result.mood || "",
        structure: result.structure || "",
        source: result.source || "",
        transcript_status: (result.transcript && result.transcript.status) || "not_configured",
        analyzed_at: new Date().toISOString(),
      },
    },
  });
  await kidsUpsertJob(store, db, {
    id: `kids_audio_${project.id}_${Date.now().toString(36)}`,
    project_id: project.id, kind: "audio_analysis", status: "COMPLETED",
    error_message: null, metadata: { segments: saved.length, source: result.source },
  });
  return {
    segments: saved,
    analysis: {
      mood: result.mood || "",
      structure: result.structure || "",
      narration_style: result.narrationStyle || "",
      educational_focus: result.educationalFocus || "",
      source: result.source || "",
      duration_seconds: total,
      measured,
      transcript: result.transcript || null,
    },
  };
}

/** The Storyboard: build the editable scene timeline from the real rows. */
async function buildKidsTimelineForProject(store, db, project) {
  const [scenes, segments, library, storyRow] = await Promise.all([
    kidsListScenes(store, db, project.id),
    kidsListAudioSegments(store, db, project.id),
    kidsListLibrary(store, db, {}),
    kidsGetStory(store, db, project.id),
  ]);
  const mine = (kind) => library.filter((a) => a.kind === kind && (a.scope === "shared" || a.scope === project.id));
  const characters = mine("character");
  const locations = mine("location");
  const props = mine("prop");
  // The storyboard that actually gets RENDERED is the Director board — when
  // one is linked the timeline follows it (never the story's plan, so the two
  // can never drift). Without a board the studio's story is the plan.
  let boardScenes = [];
  if (project.board_id) {
    try {
      const board = readDirectorBoard(project.board_id);
      boardScenes = (board.scenes || []).map((s) => {
        const o = s && typeof s === "object" ? s : {};
        const cam = o.camera && typeof o.camera === "object" ? o.camera : {};
        const shots = Array.isArray(o.shots) ? o.shots : [];
        return {
          scene_number: Number(o.scene_number) || 0,
          title: String(o.title || ""),
          duration_seconds: Number(o.duration_seconds) || 0,
          text: String(o.lyric_segment || o.lyric_text || o.narration || ""),
          characters: (Array.isArray(o.characters) ? o.characters : []).map((x) => String(x)),
          location: String(o.location || ""),
          props: (Array.isArray(o.objects) ? o.objects : []).map((x) => String(x)),
          action: String(o.action || o.story_beat || ""),
          emotion: String(o.expression || o.emotion || ""),
          camera_shot: String(cam.shot_type || ""),
          camera_movement: String(cam.movement || ""),
          lighting: String(o.lighting || ""),
          image_prompt: String(o.image_prompt || ""),
          video_prompt: String(o.video_prompt || ""),
          negative_prompt: String(o.negative_prompt || ""),
          dialogue: (Array.isArray(o.dialogue) ? o.dialogue : []).map((d) => `${String(d.speaker || "")}: ${String(d.line || "")}`),
          shots: shots.length,
        };
      });
    } catch { boardScenes = []; }
  }
  const storyScenes = (storyRow && storyRow.story && Array.isArray(storyRow.story.scenes)) ? storyRow.story.scenes : [];
  const source = boardScenes.length
    ? boardScenes
    : storyScenes.length
      ? storyScenes.map((s) => ({
        scene_number: s.scene_number,
        title: s.title,
        duration_seconds: s.duration_seconds,
        text: s.narration,
        characters: s.characters,
        location: s.location,
        props: s.props,
        action: s.action,
        emotion: s.emotion,
        camera_shot: s.camera_shot,
        camera_movement: s.camera_movement,
        lighting: s.lighting,
        image_prompt: s.image_prompt,
        video_prompt: s.video_prompt,
        negative_prompt: s.negative_prompt,
      }))
      : scenes.map((s) => ({
        scene_number: s.scene_number,
        title: s.title,
        duration_seconds: s.duration_seconds,
        text: s.synopsis,
        camera_shot: s.camera,
        image_prompt: s.prompt,
      }));
  const timeline = buildKidsTimeline({ scenes: source, segments, characters, locations, props });
  // Every scene prompt is composed from the CANONICAL library assets so a
  // character's look never drifts between scenes.
  const withPrompts = timeline.map((row) => {
    const composed = buildKidsScenePrompt({
      scene: row,
      characters,
      locations,
      props,
      style: project.visual_style || "",
    });
    return {
      ...row,
      image_prompt: row.image_prompt || composed.prompt,
      negative_prompt: row.negative_prompt || composed.negative,
      characters_used: composed.characters_used,
    };
  });
  await kidsReplaceTimeline(store, db, project.id, withPrompts.map((row, i) => ({
    scene_number: Number(row.scene_number) || i + 1,
    payload: row,
  })));
  return withPrompts;
}

/** The Quality Control stage: the children's-content checks + export record. */
async function runKidsQc(store, db, project) {
  const [storyRow, timelineRows, segments, assets, library] = await Promise.all([
    kidsGetStory(store, db, project.id),
    kidsListTimeline(store, db, project.id),
    kidsListAudioSegments(store, db, project.id),
    kidsListAssets(store, db, project.id),
    kidsListLibrary(store, db, {}),
  ]);
  const mine = (kind) => library.filter((a) => a.kind === kind && (a.scope === "shared" || a.scope === project.id));
  const characters = mine("character");
  const locations = mine("location");
  const props = mine("prop");
  let timeline = timelineRows.map((r) => r.payload);
  if (!timeline.length) timeline = await buildKidsTimelineForProject(store, db, project);
  // The media facts: the measured audio and the real final cut on disk.
  const meta = project.metadata && typeof project.metadata === "object" ? project.metadata : {};
  const audio = meta.audio && typeof meta.audio === "object" ? meta.audio : {};
  const measured = audio.measured && typeof audio.measured === "object" ? audio.measured : {};
  const media = {
    audio_duration_seconds: Number(audio.duration_seconds) || 0,
    peak_volume_db: Number.isFinite(Number(measured.peakVolumeDb)) ? Number(measured.peakVolumeDb) : null,
    subtitles_supported: false,
    probed: false,
    black_frames: [],
  };
  let final = null;
  if (project.scenario_name) {
    const dirs = allDirsFor(folderSlug(project.scenario_name));
    for (const dir of dirs) {
      const full = path.join(OUTPUTS, dir);
      if (!fs.existsSync(full)) continue;
      let vm = null;
      try { vm = versionMap(full, prefixFor(dir), []); } catch { vm = null; }
      if (!vm || !vm.finalMain) continue;
      final = { dir, file: vm.finalMain, path: path.join(full, vm.finalMain) };
      break;
    }
  }
  if (final) {
    media.probed = true;
    try {
      const out = await runCmd("ffmpeg", ["-hide_banner", "-i", final.path, "-vf", "blackdetect=d=0.5:pix_th=0.10", "-f", "null", "-"], 120000);
      const hits = [...String(out).matchAll(/black_start:([\d.]+)/g)].map((m) => Math.round(Number(m[1]) * 10) / 10);
      media.black_frames = hits;
    } catch { /* ffmpeg could not probe — the media facts stay honest */ }
  }
  const result = runKidsQualityChecks({
    project,
    story: (storyRow && storyRow.story) || {},
    timeline,
    assets,
    segments,
    library: { characters, locations, props },
    media,
  });
  const run = await kidsInsertQcRun(store, db, project.id, result.summary, result.checks);
  await kidsUpsertJob(store, db, {
    id: `kids_qc_${project.id}_${Date.now().toString(36)}`,
    project_id: project.id, kind: "quality_control", status: "COMPLETED",
    error_message: null, metadata: result.summary,
  });
  return {
    ...result,
    run_id: run.id,
    media,
    note: "these are automated checks — a teacher still reviews the content before it is published",
  };
}
// Middle frame of a video as a JPEG (grid thumbnail + vision-caption source
// + reference visual when a video seeds a project).
async function extractMiddleFrame(videoFull, jpgFull) {
  const dur = await videoDurationSec(videoFull);
  const ss = dur != null ? String(Math.max(0, dur / 2)) : "1";
  await runCmd("ffmpeg", ["-y", "-ss", ss, "-i", videoFull, "-frames:v", "1", jpgFull], 60000);
}
// The local LLM backend serves only the loaded model (LM Studio /
// llama-server, OpenAI-compatible). Force vision with LLM_VISION=1.
const LLM_VISION_FORCE = ["1", "true", "yes", "on"].includes(String(process.env.LLM_VISION || "").trim().toLowerCase());
let llmModelCache = { at: 0, id: null };
async function llmModelId() {
  if (Date.now() - llmModelCache.at < 30000 && llmModelCache.id) return llmModelCache.id;
  const base = (process.env.LLM_BASE || "").replace(/\/+$/, "");
  if (!base) return null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    const r = await fetch(`${base}/v1/models`, { signal: ctl.signal });
    clearTimeout(t);
    const d = await r.json().catch(() => null);
    const id = d?.data?.[0]?.id ?? null;
    if (id) llmModelCache = { at: Date.now(), id: String(id) };
    return id;
  } catch { return llmModelCache.id; }
}
const looksVision = (id) => /vl|vision|llava|moondream|pixtral|gemma[-_ ]?[34]|qwenvl/i.test(String(id || ""));
// Describe an image (data URL) as an image-generation prompt via the local
// vision model. Throws a human-readable error when no vision model is loaded.
async function captionImageWithVision(dataUrl) {
  const base = (process.env.LLM_BASE || "").replace(/\/+$/, "");
  if (!base) throw new Error("LLM_BASE not set — captioning unavailable.");
  const novision = new Error("vision-unavailable");
  if (!LLM_VISION_FORCE) {
    const id = await llmModelId();
    if (!looksVision(id)) {
      novision.detail =
        `The loaded LLM ("${id || "unknown"}") cannot read images. ` +
        `In LM Studio load a vision model (Qwen3-VL-4B/8B is already downloaded), ` +
        `then Generate prompt again.`;
      throw novision;
    }
  }
  try {
    const d = await llmPostChat(`${base}/v1/chat/completions`, {
      model: LLM_MODEL,
      messages: [
        {
          role: "system",
          content: "You describe a reference photo for an AI image generator. Output ONLY one detailed static-scene prompt: subject identity and appearance, clothing, pose, setting, lighting, colors, medium and quality tags. No quotes, no preamble, no trailing commentary.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image as an image-generation prompt." },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      temperature: 0.4,
      max_tokens: 800,
      chat_template_kwargs: { enable_thinking: false },
    }, { tag: "caption" });
    const text = String(d.choices?.[0]?.message?.content ?? "").trim();
    if (!text) throw new Error("The vision model returned an empty caption.");
    return text;
  } catch (e) {
    if (e?.name === "AbortError") throw new Error("Caption timed out (180s) — the vision model may still be loading; try again.");
    throw e;
  }
}
// Data URL the vision model reads for a resource entry (original image, or
// the video's extracted middle frame).
function resCaptionSource(entry) {
  const full = path.join(RESOURCES, entry.file);
  if (entry.kind === "image") {
    if (!fs.existsSync(full)) throw new Error("resource file missing — re-upload it.");
    const buf = fs.readFileSync(full);
    if (buf.length > 25 * 1024 * 1024) throw new Error("image over 25MB — downscale it and re-upload to caption.");
    return `data:${mimeFor(entry.file) || "image/png"};base64,${buf.toString("base64")}`;
  }
  const thumbFull = path.join(RESOURCES, entry.thumb || "");
  if (!entry.thumb || !fs.existsSync(thumbFull)) throw new Error("video thumbnail missing — re-upload the video.");
  return `data:image/jpeg;base64,${fs.readFileSync(thumbFull).toString("base64")}`;
}
async function captionResource(entry) {
  const prompt = await captionImageWithVision(resCaptionSource(entry));
  return { ...entry, prompt, captionError: null };
}
function serveResource(res, file) {
  const p = path.join(RESOURCES, file);
  if (!isSafe(file) || !fs.existsSync(p) || !fs.statSync(p).isFile()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": MIME[path.extname(p).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(p).pipe(res);
}

// The Sanskriti Kids asset library files (the generated reference stills).
function serveKids(res, rel) {
  const parts = String(rel || "").split("/");
  if (parts.some((s) => !isSafeSegment(s))) { res.writeHead(400); return res.end(); }
  const p = path.join(KIDS_DIR, ...parts);
  if (!p.startsWith(KIDS_DIR) || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
    res.writeHead(404); return res.end();
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(p).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(p).pipe(res);
}

// ------------------------------------------- Director master asset renders
// Master reference stills for the Director "Generate Assets" stage. Board JSON
// is the source of truth (no schema migration); binaries live here and are
// served auth-gated under /director-assets/... . Renders reuse the Kids
// reference script — it already sends the saved prompt verbatim and accepts an
// arbitrary --out path. The pump is serial and shares the ComfyUI queue with
// the main run + Kids pumps.
const DIRECTOR_ASSETS_DIR = process.env.DIRECTOR_ASSETS_DIR
  ? path.resolve(process.env.DIRECTOR_ASSETS_DIR)
  : path.join(ROOT, "director_assets");
const DIRECTOR_ASSET_KIND_DIR = { character: "characters", location: "locations", object: "objects" };
let directorAssetPumping = false;
const directorAssetProcs = new Map();

function serveDirectorAssets(res, rel) {
  const parts = String(rel || "").split("/");
  if (parts.some((s) => !isSafeSegment(s))) { res.writeHead(400); return res.end(); }
  const p = path.join(DIRECTOR_ASSETS_DIR, ...parts);
  if (!p.startsWith(DIRECTOR_ASSETS_DIR) || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
    res.writeHead(404); return res.end();
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(p).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(p).pipe(res);
}

function directorAssetBoardFile(id) {
  if (!isSafe(id)) return null;
  return path.join(DIRECTOR, `${id}.json`);
}
function directorAssetReadBoard(id) {
  const f = directorAssetBoardFile(id);
  return f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
}
async function directorComfyProbe() {
  const base = String(process.env.COMFY_BASE || "").replace(/\/+$/, "");
  if (!base) return { up: false, error: "COMFY_BASE is not set" };
  try {
    const response = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(1800) });
    if (!response.ok) return { up: false, error: `ComfyUI returned HTTP ${response.status}` };
    return { up: true, error: null };
  } catch (e) {
    return { up: false, error: String(e?.message || e || "ComfyUI is unreachable") };
  }
}
function directorAssetFailQueuedJobs(reason) {
  if (!fs.existsSync(DIRECTOR)) return;
  for (const file of fs.readdirSync(DIRECTOR)) {
    if (!file.endsWith(".json")) continue;
    let board;
    try { board = directorAssetReadBoard(path.basename(file, ".json")); }
    catch { continue; }
    const state = board?.assetProduction;
    if (!state || !Array.isArray(state.jobs)) continue;
    let changed = false;
    for (const job of state.jobs) {
      if (!job || (job.status !== "PENDING" && job.status !== "PROCESSING")) continue;
      const message = String(reason || "ComfyUI is unavailable").slice(-600);
      job.status = "FAILED";
      job.error = message;
      job.updated_at = new Date().toISOString();
      const asset = (state.assets || []).find((row) => row.id === job.asset_id);
      if (asset) { asset.status = "pending"; asset.error = message; }
      changed = true;
    }
    if (!changed) continue;
    state.status = (state.assets || []).some((asset) => asset.reference) ? "review" : "idle";
    state.updatedAt = new Date().toISOString();
    directorAssetWriteBoard(board);
  }
}
function directorAssetWriteBoard(board) {
  const f = directorAssetBoardFile(board && board.id);
  if (!f) throw new Error("bad board id");
  fs.mkdirSync(DIRECTOR, { recursive: true });
  board.updatedAt = new Date().toISOString();
  fs.writeFileSync(f, JSON.stringify(board, null, 2));
  // Same best-effort mirror the Director routes use — the file write already
  // succeeded, so a DB hiccup must never fail a generation.
  void pgUpsertDirectorBoard(board).catch((e) => console.warn("[pg] director asset board mirror failed:", e.message));
  return board;
}
function directorAssetRelPath(boardId, asset, version) {
  const kind = DIRECTOR_ASSET_KIND_DIR[asset.type] || "objects";
  const name = isSafe(asset.id) ? asset.id : "asset";
  const stem = String(asset.name || asset.id || "asset")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 72) || name.toLowerCase();
  return `${boardId}/${kind}/${name}/${stem}_v${Math.max(1, Number(version) || 1)}.png`;
}
const directorAssetVersionsCache = new Map();
function directorAssetWithVersions(boardId, state) {
  const assets = state.assets || [];
  const stamp = `${String(state.updatedAt || "")}|${assets.map((a) => [a.id, a.status, a.version, a.reference, a.prompt].join("\u0001")).join("\u0002")}`;
  const cached = directorAssetVersionsCache.get(boardId);
  if (cached && cached.stamp === stamp) {
    directorAssetVersionsCache.delete(boardId);
    directorAssetVersionsCache.set(boardId, cached);
    return { ...state, assets: cached.assets };
  }
  const versionedAssets = assets.map((asset) => {
    const current = String(asset.reference || "").replace(/\\/g, "/");
    const currentDir = path.dirname(path.join(DIRECTOR_ASSETS_DIR, ...directorAssetRelPath(boardId, asset, 1).split("/")));
    const files = new Map();
    try {
      for (const file of fs.readdirSync(currentDir)) {
        if (!file.toLowerCase().endsWith(".png")) continue;
        let version = null;
        if (file === "reference.png") version = 1;
        else if (/^reference_v(\d+)\.png$/i.test(file)) version = Number(file.match(/^reference_v(\d+)\.png$/i)?.[1]);
        else {
          const stem = path.basename(file, path.extname(file));
          const found = stem.match(/_v(\d+)$/i);
          if (found) version = Number(found[1]);
        }
        if (!Number.isInteger(version) || version < 1) continue;
        const rel = `${boardId}/${DIRECTOR_ASSET_KIND_DIR[asset.type] || "objects"}/${isSafe(asset.id) ? asset.id : "asset"}/${file}`;
        const existing = files.get(version);
        const preferred = current === rel || !existing
          || (existing.reference !== current && path.basename(existing.reference) === "reference.png" && file !== "reference.png");
        if (preferred) files.set(version, { version, reference: rel });
      }
    } catch { /* no render folder yet */ }
    if (current && ![...files.values()].some((item) => item.reference === current)) {
      const inferred = Number(current.match(/_v(\d+)\.png$/i)?.[1]) || Number(asset.version) || 1;
      files.set(inferred, { version: inferred, reference: current });
    }
    const currentVersion = [...files.values()].find((item) => item.reference === current)?.version
      || Number(asset.version) || [...files.keys()].sort((a, b) => b - a)[0] || 1;
    const versionPrompts = new Map((state.jobs || [])
      .filter((job) => job?.asset_id === asset.id && Number(job?.metadata?.version) > 0 && job?.metadata?.prompt)
      .map((job) => [Number(job.metadata.version), String(job.metadata.prompt)]));
    const image_versions = [...files.values()].sort((a, b) => a.version - b.version).map((item) => ({
      ...item,
      reference_id: assetVersionId(asset, item.version),
      prompt: versionPrompts.get(item.version) || (item.version === currentVersion ? asset.prompt : ""),
    }));
    return { ...asset, version: currentVersion, reference_id: assetVersionId(asset, currentVersion), image_versions };
  });
  directorAssetVersionsCache.set(boardId, { stamp, assets: versionedAssets });
  // Bound the process cache when a user opens many boards in one session.
  while (directorAssetVersionsCache.size > 48) {
    directorAssetVersionsCache.delete(directorAssetVersionsCache.keys().next().value);
  }
  return { ...state, assets: versionedAssets };
}
// Approved masters ride the SCENE prompt as a compact visual index. This is a
// text lock, not a pixel anchor: the Flux.1-dev reference workflow is pure
// text-to-image. Skipped stages contribute nothing (nothing was rendered).
function directorApprovedAssets(board, stateOverride = null) {
  const state = stateOverride || directorAssetWithVersions(board.id, getBoardAssetState(board));
  if (state.status !== "approved" || state.skipped) return [];
  return compactIndex(state).filter((a) => a.reference);
}

// Bind approved visual references deterministically after planning. The model
// still decides which bible entities are visible in each scene/shot; whenever
// it selects one, its matching approved asset ID is guaranteed to travel with
// that scene/shot to the image pipeline.
function bindApprovedSceneAssetRefs(scene, approvedAssets = []) {
  const byBible = new Map();
  for (const asset of arr(approvedAssets)) {
    const kind = String(asset && asset.type || "");
    const bibleId = String(asset && asset.blueprint_id || "");
    const ref = String(asset && (asset.reference_id || asset.id) || "");
    if (kind && bibleId && ref) byBible.set(`${kind}:${bibleId}`, ref);
  }
  const bind = (node, fallback = {}) => {
    const current = node && node.asset_refs && typeof node.asset_refs === "object" ? node.asset_refs : {};
    const visibleCharacters = arr(node && node.characters).length ? arr(node.characters) : arr(fallback.characters);
    const visibleObjects = arr(node && node.objects);
    const visibleLocation = String(node && node.location || fallback.location || "");
    const collect = (kind, existing, ids) => [...new Set([
      ...arr(existing).map((x) => String(x || "")).filter(Boolean),
      ...arr(ids).map((id) => byBible.get(`${kind}:${String(id || "")}`) || "").filter(Boolean),
    ])];
    node.asset_refs = {
      characters: collect("character", current.characters, visibleCharacters),
      locations: collect("location", current.locations, visibleLocation ? [visibleLocation] : []),
      objects: collect("object", current.objects, visibleObjects),
    };
    return node.asset_refs;
  };
  const sceneRefs = bind(scene);
  const shots = arr(scene && scene.shots);
  const shotRefs = shots.map((shot) => bind(shot, {
    characters: arr(scene && scene.characters),
    location: String(scene && scene.location || ""),
    objects: arr(scene && scene.objects),
  }));
  if (shots.length) {
    for (const kind of ["characters", "locations", "objects"]) {
      scene.asset_refs[kind] = [...new Set([...sceneRefs[kind], ...shotRefs.flatMap((refs) => refs[kind])])];
    }
  }
  return scene;
}

// Resolve compact asset references only at approval time. Scene board rows
// keep ids and direction; the existing generation scenario receives the
// approved prompts plus safe local reference paths as ephemeral generation
// data. The sequence runner can pixel-anchor those references in Flux 2 mode.
function attachDirectorAssetGenerationData(config) {
  const root = path.resolve(DIRECTOR_ASSETS_DIR);
  for (const beat of Array.isArray(config?.sequence) ? config.sequence : []) {
    const missing = [];
    const files = (Array.isArray(beat.reference_images) ? beat.reference_images : []).flatMap((item) => {
      const rel = String(item?.path || "").replace(/\\/g, "/");
      const parts = rel.split("/");
      if (!rel || parts.some((part) => !isSafeSegment(part))) {
        missing.push(`${String(item?.asset_id || "asset")}: invalid reference path`);
        return [];
      }
      const absolute = path.resolve(root, ...parts);
      if (!(absolute === root || absolute.startsWith(`${root}${path.sep}`)) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
        missing.push(`${String(item?.asset_id || "asset")}: reference image is missing from storage`);
        return [];
      }
      return [{ ...item, path: absolute }];
    });
    beat.reference_images = files;
    if (missing.length) beat.asset_reference_issues = [...new Set([...(beat.asset_reference_issues || []), ...missing])];
    const preferred = files.find((x) => x.type === "character")
      || files.find((x) => x.type === "location") || files.find((x) => x.type === "object");
    if (preferred) beat.reference_image_path = preferred.path;
  }
  return config;
}

async function directorAssetPumpJobs() {
  if (directorAssetPumping || !fs.existsSync(DIRECTOR)) return;
  // One ComfyUI job at a time across ALL generators (the queue is serial).
  if ([...directorAssetProcs.values()].some((p) => p && p.exitCode === null)) return;
  if (typeof runs !== "undefined" && [...runs.values()].some((r) => r.status === "running")) return;
  if (typeof kidsProcs !== "undefined" && [...kidsProcs.values()].some((p) => p && p.exitCode === null)) return;
  directorAssetPumping = true;
  try {
    let picked = null;
    for (const file of fs.readdirSync(DIRECTOR)) {
      if (!file.endsWith(".json")) continue;
      let board;
      try { board = directorAssetReadBoard(path.basename(file, ".json")); }
      catch (e) { console.warn(`[director-assets] skipping unreadable board ${file}:`, e.message); continue; }
      const jobs = board?.assetProduction?.jobs;
      if (!Array.isArray(jobs)) continue;
      const job = jobs.find((j) => j && (j.status === "PENDING" || j.status === "PROCESSING"));
      if (job) { picked = { board, job }; break; }
    }
    if (!picked) return;
    const { board, job } = picked;
    const comfy = await directorComfyProbe();
    if (!comfy.up) {
      directorAssetFailQueuedJobs(`ComfyUI is unavailable: ${comfy.error}. Start ComfyUI and retry asset generation.`);
      return;
    }
    const assets = board.assetProduction.assets || [];
    const asset = assets.find((a) => a.id === job.asset_id);
    if (!asset) throw new Error(`asset ${job.asset_id} is missing from this board`);
    const savedPrompt = String(asset.prompt || "").trim();
    if (!savedPrompt) throw new Error(`asset ${asset.id} has no saved generation prompt — write one first`);

    const version = Number(asset.version || 0) + 1;
    const rel = directorAssetRelPath(board.id, asset, version);
    const outFile = path.join(DIRECTOR_ASSETS_DIR, ...rel.split("/"));
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const wf = resolveImageWorkflow(String(job.workflow || "flux_text_image"), DEFAULT_IMAGE_WORKFLOW);

    job.status = "PROCESSING";
    job.updated_at = new Date().toISOString();
    job.metadata = { ...(job.metadata || {}), file: rel, workflow: wf.id, version, prompt: savedPrompt };
    asset.status = "generating";
    asset.error = null;
    board.assetProduction.status = "generating";
    board.assetProduction.updatedAt = new Date().toISOString();
    directorAssetWriteBoard(board);

    const args = [
      "scripts/kids_reference.mjs", "--workflow", wf.id,
      "--prompt", savedPrompt, "--out", outFile,
      "--width", String(wf.width), "--height", String(wf.height),
      "--steps", String(wf.steps),
    ];
    const proc = spawn(process.execPath, args, { cwd: ROOT, env: process.env, windowsHide: true });
    directorAssetProcs.set(job.id, proc);
    let log = "";
    proc.stdout.on("data", (d) => { log += String(d); });
    proc.stderr.on("data", (d) => { log += String(d); });
    proc.on("error", (e) => { log += `\n${e && e.message ? e.message : String(e)}`; });
    proc.on("close", (code) => {
      directorAssetProcs.delete(job.id);
      // Re-read: the board may have been edited while the render was running.
      const fresh = directorAssetReadBoard(board.id);
      if (!fresh || !fresh.assetProduction) return void directorAssetPumpJobs();
      const freshJob = (fresh.assetProduction.jobs || []).find((j) => j.id === job.id);
      const freshAsset = (fresh.assetProduction.assets || []).find((a) => a.id === asset.id);
      const ok = code === 0 && fs.existsSync(outFile);
      if (ok && freshJob && freshAsset) {
        freshJob.status = "COMPLETED";
        freshJob.updated_at = new Date().toISOString();
        freshAsset.reference = rel;
        freshAsset.version = version;
        freshAsset.status = "review";
        freshAsset.error = null;
        freshAsset.workflow = wf.id;
        freshAsset.model = wf.model;
        fresh.assetProduction.status = "review";
      } else {
        try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch { /* ignore */ }
        if (freshJob) {
          freshJob.status = "FAILED";
          freshJob.error = (log || "").slice(-600) || `render exited with code ${code}`;
          freshJob.updated_at = new Date().toISOString();
        }
        if (freshAsset) {
          freshAsset.status = "pending";
          freshAsset.error = (log || "").slice(-600) || `render exited with code ${code}`;
        }
      }
      fresh.assetProduction.updatedAt = new Date().toISOString();
      directorAssetWriteBoard(fresh);
      void directorAssetPumpJobs();
    });
  } catch (e) {
    console.error("[director-assets] pump failed:", e && e.message);
    directorAssetFailQueuedJobs(`Asset generation could not start: ${e?.message || String(e)}`);
  } finally {
    directorAssetPumping = false;
  }
}

// ---------------------------------------------------------------- auth
// Single-user login. Credentials come from env (video_test/.env or real env);
// defaults are admin / admin — override for anything non-local.
const AUTH_USER = process.env.LOGIN_USER || "admin";
const AUTH_PASS = process.env.LOGIN_PASS || "admin";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const COOKIE_NAME = "ss_session";

const sessions = new Map(); // token -> { user, exp }
function pruneSessions() {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.exp <= now) sessions.delete(t);
}
function cookieValue(req) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE_NAME) return decodeURIComponent(v.join("="));
  }
  return null;
}
function authedUser(req) {
  const token = cookieValue(req);
  if (!token) return null;
  const s = sessions.get(token);
  if (!s || s.exp <= Date.now()) { sessions.delete(token); return null; }
  return s.user;
}
function sessionCookie(token, maxAgeSec) {
  const attrs = [`${COOKIE_NAME}=${token}`, "HttpOnly", "SameSite=Lax", "Path=/"];
  if (maxAgeSec != null) attrs.push(`Max-Age=${maxAgeSec}`);
  else attrs.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  return attrs.join("; ");
}

// ---------------------------------------------------------------- helpers
const isSafe = (name) => typeof name === "string" && name.length > 0 && !name.includes("..") && !name.includes("/") && !name.includes("\\");
// Path segments arrive percent-encoded (spaces stay %20 in u.pathname), so
// decode before any DB/FS use — plain-text project names must work
// end-to-end. Runs AFTER isSafe-relevant checks happen on the decoded value.
// Malformed sequences decode to "" (rejected by isSafe).
const pathName = (seg) => {
  try { return decodeURIComponent(seg || ""); }
  catch { return ""; }
};
const json = (res, code, data) => {
  // Never let the browser cache API JSON (a cached empty gallery list from
  // before a fix/backfill would otherwise keep rendering "No outputs yet").
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
};
const readJson = (req) => new Promise((res, rej) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => { try { res(JSON.parse(b)); } catch { rej(new Error("bad json")); } });
});

// ---------------------------------------------------------------- runs
// One run = one spawned `node scripts/character_sequence{,_wan}.mjs <folder>`
// (repeated `opts.count` times for batch reference generation).
// Storage runs on the IMMUTABLE folder (outputs/<folder>/…): `scenario` is
// the display name (prompts/<scenario>.json via --config-name), `folder`
// (opts.storageFolder, resolved by the route via migrateProjectStorage) is
// what the script writes to — so renames never orphan generations.
// engine: "ltx" (default) or "wan" — picks the i2v backend script.
// format: "landscape" (default) or "vertical" — the vertical (9:16 Instagram
//   Reel) cut regenerates every asset into outputs/<folder>[_wan]_vertical/.
// opts.stitch   -> --stitch (re-stitch final from selected mains only)
// opts.regen    -> --regen <ref|keyframe|clip> [beat] (regenerate one asset, keeps old versions)
// opts.count    -> repeat a `ref` regen this many times (each pass writes a new
//                  _vN version to pick from); anything else always runs once.
const runs = new Map(); // id -> { scenario, folder, status, log, startedAt, proc, subs:Set<res> }
// Boards with a scene-planning LLM call in flight. A second POST while one
// is running is rejected (409) so two overlapping batches can never append
// duplicate scenes — the client retries/continues from scenes.length.
const directorPlanning = new Set();

function startRun(scenario, opts = {}) {
  const { stitch = false, regen = null, engine = "ltx" } = opts;
  // Accept both { format: "vertical" } and the legacy { vertical: true }.
  const format = normalizeFormat(opts.format ?? (opts.vertical ? "vertical" : "landscape"));
  const count = regen?.kind === "ref" ? Math.min(8, Math.max(1, Number(opts.count) || 1)) : 1;
  if ([...runs.values()].some((r) => r.status === "running"))
    throw new Error("another run is still active (ComfyUI queue is serial)");
  // Storage identity: immutable folder for dirs/prefixes, display name only
  // for the prompts JSON. Callers resolve the folder; the slug fallback keeps
  // direct/CLI-style calls working when the DB is unreachable.
  const folder = opts.storageFolder || folderName(scenario);
  const configName = opts.configName || scenario;
  // Dialogue mode: voice + lip-sync beats via scripts/dialogue_lipsync.mjs
  // (local Edge-TTS + Easy-Wav2Lip, no ComfyUI queue needed but still serial
  // with other runs since it rewrites clip mains + re-stitches the final).
  // Song mode: lyrics -> full song via scripts/generate_song.mjs (selected
  // audio model on ComfyUI — ACE-Step 1.5 XL Turbo or MiniMax Music 3 —
  // versioned mp3s in outputs/<folder>/).
  const mode = opts.mode === "dialogue" ? "dialogue" : opts.mode === "song" ? "song" : "generate";
  const script = mode === "dialogue"
    ? "scripts/dialogue_lipsync.mjs"
    : mode === "song"
      ? "scripts/generate_song.mjs"
      : engine === "wan" ? "scripts/character_sequence_wan.mjs" : "scripts/character_sequence.mjs";
  const argv = [script, folder];
  if (configName !== folder) argv.push("--config-name", configName);
  if (mode === "song" && (opts.songModel === "ace-step" || opts.songModel === "minimax"))
    argv.push("--song-model", opts.songModel);
    if (mode === "dialogue") {
      if (opts.beats) argv.push("--beats", String(opts.beats));
      if (opts.lipsync === "wav2lip" || opts.lipsync === "musetalk-comfy") argv.push("--lipsync", opts.lipsync);
      if (opts.skipTts) argv.push("--skip-tts");
    if (opts.skipLipsync) argv.push("--skip-lipsync");
    // Per-scene check flow: voice+sync the clip but leave the final cut
    // alone (merge later with Stitch).
    if (opts.noStitch) argv.push("--no-stitch");
    if (engine === "wan") argv.push("--wan");
  } else {
    if (opts.imageMode) argv.push("--image-mode", opts.imageMode);
    if (stitch) argv.push("--stitch");
    if (opts.noDialogue) argv.push("--no-dialogue");
    // Connected movie: beat N>1 carries "seamless continuation" TEXT
    // wording (independent pixels — every clip still animates its own
    // keyframe). Devotional boards also set cfg.chainContinuity, so the
    // flag is only needed to force the wording on.
    if (opts.chain) argv.push("--chain");
    if (regen) {
      argv.push("--regen", regen.kind, ...(regen.index ? [String(regen.index)] : []));
    }
  }
  if (format === "vertical" && mode !== "song") argv.push("--vertical");
  const id = Date.now().toString(36);
  // Run shape (stitch/regen/count/format) is stored on the record — not just
  // the argv — so a fresh page can reattach after a refresh: GET /api/runs
  // reveals the active run and the SSE log endpoint replays its log + asset
  // events, letting the client rebuild progress and button state from the
  // real stream instead of guessing.
  const run = { id, scenario, folder, engine, format, stitch, regen, count, mode, beats: opts.beats || null, lipsync: opts.lipsync || null, chain: !!opts.chain, status: "running", log: "", assets: [], startedAt: Date.now(), proc: null, subs: new Set(), cancelled: false, total: count, pass: 0 };
  runs.set(id, run);
  let lineBuf = "";
  const push = (chunk) => {
    run.log += chunk;
    for (const s of run.subs) s.write(`data: ${JSON.stringify({ line: chunk })}\n\n`);
    // Detect structured `[asset] {...}` lines (script emits one per finished file).
    lineBuf += chunk;
    let nl;
    while ((nl = lineBuf.indexOf("\n")) >= 0) {
      const line = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      const m = line.match(/^\[asset\] (\{.*\})\s*$/);
      if (m) {
        const asset = JSON.parse(m[1]);
        run.assets.push(asset);
        for (const s of run.subs) s.write(`event: asset\ndata: ${JSON.stringify(asset)}\n\n`);
        // Record every finished generation (project_references for reference
        // visuals, project_assets row -> COMPLETED for keyframes/clips/finals).
        // Dirs are folder-based (immutable storage); the project link stays
        // the display name.
        const dirName = outDirName(run.folder, run.engine, run.format);
        pgMarkAssetComplete(run.scenario, asset, { engine: run.engine, format: run.format, outputFolder: dirName })
          .catch((e) => console.warn("[pg] catalog failed:", e.message));
      }
    }
  };
  const finish = (status) => {
    run.status = status;
    push(`\n[${status}]\n`);
    for (const s of run.subs) { s.write("event: close\ndata: " + JSON.stringify({ status: run.status }) + "\n\n"); s.end(); }
    run.subs.clear();
    // Refresh the current version's project_assets file names from the
    // run's output dir (catches final.mp4 + anything missed).
    const dirName = outDirName(run.folder, run.engine, run.format);
    pgRefreshProjectFiles(run.scenario, dirName)
      .catch((e) => console.warn("[pg] sync failed:", e.message));
  };
  const launch = () => {
    run.pass += 1;
    if (run.total > 1) push(`\n[reference ${run.pass}/${run.total}]\n`);
    const proc = spawn("node", argv, {
      cwd: ROOT, env: process.env,
    });
    run.proc = proc;
    proc.stdout.on("data", (d) => push(d.toString()));
    proc.stderr.on("data", (d) => push(d.toString()));
    proc.on("close", (code) => {
      push(`\n[exit ${code}]\n`);
      if (code !== 0) return finish("error");
      if (run.pass < run.total && !run.cancelled) return launch();
      finish(run.cancelled ? "error" : "done");
    });
  };
  launch();
  return run;
}

// ---------------------------------------------------------------- comfy status
async function comfyStatus() {
  const base = (process.env.COMFY_BASE || "").replace(/\/+$/, "");
  if (!base) return { up: false, error: "COMFY_BASE not set" };
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    let stats, queue;
    try {
      [stats, queue] = await Promise.all([
        fetch(`${base}/system_stats`, { signal: ctl.signal }).then((r) => r.json()),
        fetch(`${base}/queue`, { signal: ctl.signal }).then((r) => r.json()),
      ]);
    } finally { clearTimeout(t); }
    return { up: true, stats, queue };
  } catch (e) {
    return { up: false, error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------- LLM status
async function llmStatus() {
  const base = (process.env.LLM_BASE || "").replace(/\/+$/, "");
  if (!base) return { up: false, error: "LLM_BASE not set" };
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    let r;
    try { r = await fetch(`${base}/v1/models`, { signal: ctl.signal }); }
    finally { clearTimeout(t); }
    if (!r.ok) return { up: false, error: `HTTP ${r.status}` };
    return { up: true };
  } catch (e) {
    return { up: false, error: String(e?.message || e).slice(0, 120) };
  }
}

// ---------------------------------------------------------------- dashboard
// Home-page payload: project list + real per-project progress, aggregated
// with a fixed number of queries (no N+1):
//   scenarios (1) + asset coverage GROUP BY (1) + latest image DISTINCT ON (1)
//   + project created dates (1).
// When Postgres is down the scenario list falls back to prompts/*.json and
// coverage falls back to a disk scan, so the Home page still renders — AI
// services being offline never blocks project data either (health is a
// separate endpoint). Error details stay server-side (logs), the client only
// gets "dashboard unavailable".
const newCoverage = () => ({ ref: false, kf: new Set(), clips: new Set(), final: false, thumb: null, songs: 0 });

// Versioned song files written by scripts/generate_song.mjs:
// <prefix>_song.mp3 (v1), <prefix>_song_vN.mp3 (v2+). Dialogue voice wavs
// (<prefix>_dlg*..wav) are NOT songs and must never count here.
const SONG_FILE_RE = /_song(?:_v\d+)?\.mp3$/i;

// Disk coverage for a project's dirs (folder dirs first, legacy display-name
// dirs after). Prefers the landscape ltx dir, then _wan, then vertical cuts;
// thumbnail = highest-beat keyframe main, else the reference main.
function diskCoverageFor(dirs, cfg) {
  const seq = Array.isArray(cfg?.sequence) ? cfg.sequence : [];
  const cov = newCoverage();
  for (const dir of dirs) {
    const full = path.join(OUTPUTS, dir);
    if (!fs.existsSync(full)) continue;
    let vm = null;
    try { vm = versionMap(full, prefixFor(dir), seq); } catch { vm = null; }
    if (!vm) continue;
    if (vm.refMain) {
      cov.ref = true;
      cov.thumb ||= { dir, file: vm.refMain };
    }
    for (const [n, b] of Object.entries(vm.beats || {})) {
      if (b.keyframeMain) {
        cov.kf.add(Number(n));
        cov.thumb = { dir, file: b.keyframeMain }; // beats iterate ascending — last wins = highest beat
      }
      if (b.clipMain) cov.clips.add(Number(n));
    }
    if (vm.finalMain) cov.final = true;
    // Generated songs (ACE-Step mp3s) — the completion signal for AUDIO projects.
    try {
      for (const f of fs.readdirSync(full)) {
        if (SONG_FILE_RE.test(f)) cov.songs += 1;
      }
    } catch { /* unreadable dir — songs stay 0 */ }
    if (cov.thumb && cov.thumb.dir === dir && cov.kf.size) break; // ltx dir already has keyframes
  }
  return cov;
}

async function dashboardPayload() {
  // 1) Project list — the projects TABLE is canonical for Recent Projects
  // (name, folder_name, description, dates, project_id all come from it).
  // FULL OUTER JOIN keeps scenarios that have no project row yet (legacy /
  // pre-save drafts) so no project ever vanishes from Home; prompts/*.json
  // is the last-resort fallback when PG is down.
  let rows;
  if (pgUp) {
    try {
      const r = await pgPool.query(
        `SELECT COALESCE(p.name, s.name) AS name,
                p.project_id, p.folder_name, p.description AS pdesc,
                p.project_type,
                p.created_at, p.updated_at AS pupdated,
                s.config::text AS config, s.updated_at_ms
         FROM projects p FULL OUTER JOIN scenarios s ON s.name = p.name
         ORDER BY COALESCE(s.updated_at_ms, (extract(epoch from p.updated_at) * 1000)::bigint) DESC NULLS LAST`);
      rows = r.rows.map((x) => ({
        name: x.name,
        project_id: x.project_id != null ? Number(x.project_id) : null,
        folder_name: x.folder_name ?? null,
        pdesc: x.pdesc ?? null,
        project_type: x.project_type ?? "VIDEO",
        created_at: x.created_at ? new Date(x.created_at).getTime() : null,
        pupdated: x.pupdated ? new Date(x.pupdated).getTime() : null,
        configText: x.config != null ? String(x.config) : null,
        updated_at: x.updated_at_ms != null ? Number(x.updated_at_ms) : null,
      }));
    } catch (e) { console.warn("[dashboard] projects query failed:", e.message); rows = null; }
  } else { rows = null; }
  if (!rows) {
    try {
      rows = (await dbListScenarios()).map((r) => ({
        name: r.name, project_id: null, folder_name: null, pdesc: null,
        project_type: "VIDEO",
        created_at: null, pupdated: null,
        configText: String(r.config), updated_at: Number(r.updated_at),
      }));
    } catch (e) {
      console.warn("[dashboard] scenario store unreachable, falling back to prompts/*.json");
      rows = [];
      try {
        fs.mkdirSync(PROMPTS, { recursive: true });
        for (const f of fs.readdirSync(PROMPTS).filter((f) => f.endsWith(".json"))) {
          const full = path.join(PROMPTS, f);
          try {
            rows.push({
              name: f.replace(/\.json$/, ""), project_id: null, folder_name: null,
              pdesc: null, project_type: "VIDEO", created_at: null, pupdated: null,
              configText: fs.readFileSync(full, "utf8"), updated_at: Math.round(fs.statSync(full).mtimeMs),
            });
          } catch { /* skip unreadable prompt files */ }
        }
      } catch { /* no prompts dir — empty list */ }
    }
  }
  const cfgs = new Map();
  for (const r of rows) {
    // Config for scene counts/thumbs: scenario row first, prompts JSON copy
    // as fallback (a project row can exist before its first Save).
    let text = r.configText;
    if (text == null) {
      try { text = fs.readFileSync(promptsReadFile(r.name), "utf8"); }
      catch { text = null; }
    }
    try { cfgs.set(r.name, text != null ? JSON.parse(text) : null); }
    catch { cfgs.set(r.name, null); }
  }
  const names = rows.map((r) => r.name);
  // Immutable storage folder per project (stored folder_name, else the slug).
  // Coverage, thumbs, running-state and the payload all key off it. Legacy
  // display-name dirs are unioned in for reads so assets generated before
  // folder-immutability keep rendering.
  const fnames = new Map(rows.map((r) => [r.name, r.folder_name ?? null]));
  const folderOf = (n) => fnames.get(n) || folderName(n);
  const dirsOf = (n) => {
    const f = folderOf(n);
    const dirs = allDirsFor(f);
    if (f !== n) for (const d of allDirsFor(n)) if (!dirs.includes(d)) dirs.push(d);
    return dirs;
  };
  // Heal legacy storage on view (one-time move to folder dirs; no-op after).
  for (const n of names) {
    try { await migrateProjectStorage(n); } catch { /* never break the dashboard */ }
  }
  // 2) Coverage from disk (outputs/ dirs are the source of truth for files).
  const covs = new Map(); // name -> coverage
  for (const n of names) covs.set(n, diskCoverageFor(dirsOf(n), cfgs.get(n)));
  const thumbs = new Map();

  // 3) Identity/dates already resolved per row in section 1 (projects
  // table first) — no extra query. Row maps for the payload below.
  const created = new Map(rows.map((r) => [r.name, r.created_at ?? null]));
  const pids = new Map(rows.map((r) => [r.name, r.project_id ?? null]));
  const pdescs = new Map(rows.map((r) => [r.name, r.pdesc ?? null]));
  const pupdates = new Map(rows.map((r) => [r.name, r.pupdated ?? null]));

  // 4) Currently generating (in-memory runs — ComfyUI queue is serial).
  const runningByScenario = new Map();
  for (const r of runs.values()) {
    if (r.status === "running" && !runningByScenario.has(r.scenario)) {
      runningByScenario.set(r.scenario, r);
      // Runs write to folder dirs but are keyed by display name — match both
      // (plus every engine/format variant) so all dashboard keys resolve.
      for (const base of new Set([r.scenario, r.folder])) {
        if (!base) continue;
        for (const dir of allDirsFor(base)) runningByScenario.set(dir, r);
      }
    }
  }
  const generating = new Set(runningByScenario.keys());

  const projects = rows.map((r) => {
    const cfg = cfgs.get(r.name);
    const seq = Array.isArray(cfg?.sequence) ? cfg.sequence : [];
    const beats = seq.length;
    const c = covs.get(r.name) || newCoverage();
    const isAudio = (r.project_type ?? "VIDEO") === "AUDIO";
    const total = 1 + 2 * beats; // reference + keyframe + clip per beat
    // AUDIO projects complete one song (not scenes): a finished song counts
    // as the project's done unit so the card reaches 100%.
    const done = (c.ref ? 1 : 0) + c.kf.size + c.clips.size + (c.songs > 0 ? 1 : 0);
    const progress = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    const status = c.final || (isAudio && c.songs > 0)
      ? "completed"
      : (done > 0 ? "in_progress" : "draft");
    // Thumbnail: PG catalog pick, else disk pick; must exist on disk.
    // Landscape dirs win over the vertical cuts (main video is canonical).
    // Dirs are folder-based (immutable storage) with legacy name dirs after.
    const thumbDirs = dirsOf(r.name);
    let thumbFile = c.thumb?.file ?? null;
    let thumbDir = c.thumb?.dir ?? thumbDirs[0];
    for (const dir of thumbDirs) {
      if (thumbs.has(dir)) { thumbFile = thumbs.get(dir); thumbDir = dir; break; }
    }
    if (thumbFile && !fs.existsSync(path.join(OUTPUTS, thumbDir, thumbFile))) {
      thumbFile = c.thumb && fs.existsSync(path.join(OUTPUTS, c.thumb.dir, c.thumb.file)) ? c.thumb.file : null;
      if (thumbFile) thumbDir = c.thumb.dir;
    }
    return {
      name: r.name,
      project_id: pids.get(r.name) ?? null,
      folder_name: folderOf(r.name),
      // Project kind: VIDEO (normal video project) vs AUDIO (Create Song).
      project_type: r.project_type ?? "VIDEO",
      // Description from the projects TABLE first (the stored project data),
      // scenario config as fallback.
      description: pdescs.get(r.name) ?? (typeof cfg?.description === "string" ? cfg.description : ""),
      status,
      generating: thumbDirs.some((dir) => generating.has(dir)),
      startedAt: thumbDirs.map((dir) => runningByScenario.get(dir)?.startedAt).find((t) => t != null) ?? null,
      progress,
      sceneCount: beats,
      imageCount: c.kf.size,
      videoCount: c.clips.size,
      refDone: c.ref,
      hasFinal: c.final,
      // Generated songs (ACE-Step mp3s) — the deliverable of AUDIO projects.
      songCount: c.songs,
      hasSong: c.songs > 0,
      thumbnailUrl: thumbFile ? `/outputs/${thumbDir}/${thumbFile}` : null,
      createdAt: created.get(r.name) ?? null,
      // Freshness: scenario save first, project-row update as fallback.
      updatedAt: Number.isFinite(r.updated_at) ? r.updated_at : (pupdates.get(r.name) ?? null),
    };
  }).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  const statistics = {
    total: projects.length,
    active: projects.filter((p) => p.generating).length,
    inProgress: projects.filter((p) => p.status === "in_progress").length,
    completed: projects.filter((p) => p.status === "completed").length,
  };
  return { statistics, projects };
}

// ---------------------------------------------------------------- LLM craft
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "scenario";

// Canonical JSON stringify (sorted keys) for comparing configs regardless of key order.
const canonical = (v) => {
  const obj = typeof v === "string" ? JSON.parse(v) : v;
  const sort = (x) =>
    Array.isArray(x) ? x.map(sort)
    : (x && typeof x === "object"
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])]))
      : x);
  return JSON.stringify(sort(obj));
};

/**
 * Ask the local LLM (llama-server, OpenAI-compatible) to craft a
 * character-sequence scenario JSON from a description + master prompt.
 * Format reference is resolved without any file dependency: an existing
 * prompts/*.json or any scenario already in the store (SQLite or Postgres).
 * May be null on a fresh install — craftScenario() then relies on the system
 * schema/rules alone.
 */
async function loadCraftReference() {
  // 1) Preferred: prompts/anime_sequence.json (legacy location).
  try {
    const f = path.join(PROMPTS, "anime_sequence.json");
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch { /* fall through */ }
  // 2) Any other prompts/*.json still on disk.
  try {
    if (fs.existsSync(PROMPTS)) {
      const any = fs.readdirSync(PROMPTS).filter((f) => f.endsWith(".json")).sort();
      if (any.length) return JSON.parse(fs.readFileSync(path.join(PROMPTS, any[0]), "utf8"));
    }
  } catch { /* fall through */ }
  // 3) Any scenario already saved in the store.
  try {
    if (USE_SQLITE) {
      const row = db.prepare("SELECT config FROM scenarios LIMIT 1").get();
      if (row?.config) {
        const cfg = JSON.parse(row.config);
        if (cfg?.referencePrompt && Array.isArray(cfg?.sequence) && cfg.sequence.length) return cfg;
      }
    } else if (pgUp) {
      const r = await pgPool.query("SELECT config FROM scenarios LIMIT 1");
      const cfg = r.rows[0]?.config;
      if (cfg?.referencePrompt && Array.isArray(cfg?.sequence) && cfg.sequence.length) return cfg;
    }
  } catch { /* fall through */ }
  // Nothing on disk or in the store — no reference (fresh install). The caller
  // falls back to the system schema/rules alone.
  return null;
}
/**
 * Load a stored project's brief for the "View Prompt" popup / craft calls:
 * database first (canonical store), prompts/*.json fallback (CLI export).
 * Returns { config, from } with from = "database" | "json", or null.
 */
async function loadStoredBrief(name) {
  if (!isSafe(name)) return null;
  try {
    const raw = await dbGetScenario(name);
    if (raw) return { config: JSON.parse(raw), from: "database" };
  } catch { /* fall through to the JSON export */ }
  try {
    const f = promptsReadFile(name);
    if (fs.existsSync(f)) return { config: JSON.parse(fs.readFileSync(f, "utf8")), from: "json" };
  } catch { /* no stored brief */ }
  return null;
}
/**
 * Resolve the craft brief (Description + Master prompt + video-type rules +
 * reference example) into the EXACT LLM messages a craft would send. Shared
 * by craftScenario() and the POST /api/craft-preview endpoint, so the
 * "View Prompt" popup shows byte-for-byte what the LLM receives.
 */
async function buildCraftPreview({ description = "", masterPrompt = "", topic = "", requirements = "", presetId, presetRules, rulesDisabled, target }) {
  // Legacy callers sent { topic, requirements }; current UI sends
  // { description, masterPrompt }. Accept both — topic/requirements are NOT
  // persisted anywhere, they only seed the LLM prompt. presetId selects a
  // predefined video-type preset (system-owned presets/*.md rules); unknown
  // or missing ids fall back to the default (cinematic) — existing saved
  // projects without one keep working unchanged. presetRules is an optional
  // per-project override: when non-empty it REPLACES the preset's .md
  // content for this project only (the .md files are never modified).
  // rulesDisabled (AI Craft "Disable rules") skips the video-type rules
  // entirely: the LLM prompt carries only Description + Master prompt, and
  // the crafted config stores no preset.
  // target (open project): empty request fields fall back to the STORED
  // project brief — database first, prompts/*.json fallback. Typed box
  // edits always win; the popup therefore shows persisted data, not just
  // whatever happens to be in the boxes.
  let stored = null;
  let storedFrom = null;
  if (typeof target === "string" && target) {
    const hit = await loadStoredBrief(target);
    if (hit && hit.config && typeof hit.config === "object") {
      stored = hit.config;
      storedFrom = hit.from;
    }
  }
  const pick = (val, fallback) => {
    const s = String(val ?? "").trim();
    return s ? s : String(fallback ?? "").trim();
  };
  const idea = pick(description || topic, stored && (stored.description || stored.topic));
  const details = pick(masterPrompt || requirements, stored && stored.referencePrompt);
  if (!idea) throw new Error("description required");
  const noRules = !!rulesDisabled;
  const preset = noRules ? null : resolvePresetId(pick(presetId, stored && stored.presetId) || undefined);
  // Missing preset file = fail loudly, never silently craft off-brief —
  // unless the caller supplied custom rules, which stand on their own.
  // (Rule-free crafts skip preset resolution altogether.)
  const customRules = noRules ? "" : pick(presetRules, stored && stored.presetRules);
  let presetMeta;
  let presetContent;
  if (noRules) {
    presetMeta = null;
    presetContent = "";
  } else if (customRules) {
    presetMeta = GetPresetById(preset) ?? { id: preset, name: preset };
    presetContent = customRules;
  } else {
    ({ meta: presetMeta, content: presetContent } = GetPresetContent(preset));
  }
  const reference = await loadCraftReference();
  const system = [
    "You write ComfyUI video-generation scenario configs. Output ONLY a JSON object, no prose, no markdown fences.",
    "Schema: { description: string, character: string, referencePrompt: string, duration: number,",
    '  sequence: [ { title: snake_case_file_safe, image: string, motion: string } ] }',
    "Rules: character = one consistent subject description reused verbatim in referencePrompt and every image prompt.",
    "referencePrompt = cinematic key-visual of the character (static).",
    "sequence = 4 story beats in chronological order; each image = static keyframe prompt for Flux t2i (include the character block);",
    "each motion = 1-2 sentences of motion + camera direction for LTX image-to-video (no cuts, no new characters).",
    "duration = seconds per clip (2-5). Titles must be unique, short, snake_case.",
  ].join(" ");
  // Prompt layers, in documented priority order (per presets.mjs):
//   System / Safety Rules → Selected Preset → Project Master Prompt → Scene Prompt
// The preset establishes the visual language; the Master Prompt is the project-level
// visual direction; the Description provides the story/content. Empty layers are skipped.
// Rule-free crafts (rulesDisabled) omit the preset block entirely.
  const briefParts = [];
  // Preset rules (video-type) — highest priority system rules
  if (presetContent) {
    briefParts.push(`Video-type rules (preset "${presetMeta.name}") — follow these for the referencePrompt and every image + motion prompt:\n${presetContent}`);
  }
  // Project Master Prompt — visual direction from the project
  if (details && String(details).trim()) {
    briefParts.push(`Master prompt / visual direction: ${details}`);
  }
  // Description — the user's story/brief (always included when present)
  if (idea && String(idea).trim()) {
    briefParts.push(`Description: ${idea}`);
  }
  const user = reference
    ? `Reference example (match its style and level of detail, NOT its subject):\n${JSON.stringify(reference, null, 2)}\n\nNew scenario to craft:\n${briefParts.join("\n\n")}`
    : `New scenario to craft:\n${briefParts.join("\n\n")}`;
  return { idea, details, noRules, preset, customRules, presetMeta, presetContent, system, user, briefFrom: storedFrom };
}
async function craftScenario({ description = "", masterPrompt = "", topic = "", requirements = "", name, presetId, presetRules, rulesDisabled, userPrompt, target }) {
  // userPrompt (from the "View Prompt" popup) replaces the auto-built user
  // message verbatim — the brief is still resolved for validation + preset
  // persistence, but the LLM receives exactly what was previewed/edited.
  const brief = await buildCraftPreview({ description, masterPrompt, topic, requirements, presetId, presetRules, rulesDisabled, target });
  const { idea, details, noRules, preset, customRules, system } = brief;
  const user = String(userPrompt ?? "").trim() ? String(userPrompt).trim() : brief.user;
  const d = await llmPostChat(`${LLM_BASE}/v1/chat/completions`, {
    model: LLM_MODEL,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    temperature: 0.7,
    max_tokens: 8000,
    chat_template_kwargs: { enable_thinking: false },
  }, { tag: "craft" });
  let text = d.choices?.[0]?.message?.content || "";
  text = text.replace(/^\s*```(?:json)?\s*/, "").replace(/\s*```\s*$/, "").trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("LLM returned no JSON object");
  const cfg = JSON.parse(m[0]);
  if (!cfg.referencePrompt || !Array.isArray(cfg.sequence) || !cfg.sequence.length)
    throw new Error("crafted config missing referencePrompt/sequence");
  cfg.duration = Number(cfg.duration) || 3;
  if (!cfg.description && idea) cfg.description = idea;
  if (details && !cfg.referencePrompt) cfg.referencePrompt = details;
  // Never persist legacy brief fields even if the LLM echoes them back.
  delete cfg.topic;
  delete cfg.requirements;
  // The preset travels with the project (id only — resolved to presets/*.md
  // at generation time, unless the project carries its own presetRules
  // override), so Save persists it via the normal config path. Rule-free
  // crafts store no preset at all.
  if (noRules) {
    delete cfg.presetId;
    delete cfg.presetRules;
  } else {
    cfg.presetId = preset;
    if (customRules) cfg.presetRules = customRules;
    else delete cfg.presetRules;
  }
  cfg.sequence = cfg.sequence.map((b, i) => {
    const out = {
      title: slug(b.title) || `beat${i + 1}`,
      image: String(b.image || ""),
      motion: String(b.motion || ""),
    };
    // Preserve per-scene dialogue + clip length when the LLM returns them
    // (director-approved projects always carry them; dropping them here is
    // what used to blank-or-duplicate dialogue in the Scenario Editor).
    const dur = Number(b.duration);
    if (Number.isFinite(dur) && dur > 0) out.duration = Math.min(30, Math.max(1, Math.round(dur)));
    if (Array.isArray(b.dialogue)) {
      const dlg = b.dialogue
        .filter((x) => x && typeof x === "object")
        .map((x) => ({ speaker: String(x.speaker || "").trim(), line: String(x.line || "").trim() }))
        .filter((x) => x.line);
      if (dlg.length) out.dialogue = dlg;
    }
    return out;
  });
  // Master Prompt fan-out: whatever was written in Master Prompt is appended
  // to every crafted scene's keyframe image prompt (blank = untouched, so
  // only the AI prompt is sent for generation; motion is never touched).
  cfg.sequence = applyMasterToBeats(cfg.sequence, details);
  const scenarioName = slug(name || idea);
  return { name: scenarioName, config: cfg };
}

/**
 * Ask the local LLM to extend a scenario with the NEXT beat in the story.
 * Context = the scenario JSON itself (description / character / referencePrompt
 * + existing beats), so the new beat continues chronologically from the last
 * existing beat and keeps the same character and visual style.
 */
async function craftNextBeat(cfg, presetContent = "") {
  const existing = (cfg.sequence || []).map((b, i) => ({
    n: i + 1,
    title: b.title,
    image: b.image,
    motion: b.motion,
    ...(Number.isFinite(Number(b.duration)) && Number(b.duration) > 0 ? { duration: Number(b.duration) } : {}),
    ...(Array.isArray(b.dialogue) && b.dialogue.length ? { dialogue: b.dialogue } : {}),
  }));
  const system = [
    "You extend a ComfyUI video-generation scenario with exactly ONE next beat.",
    "The story must continue chronologically from the last existing beat — pick the natural next moment in the arc.",
    "Rules: title = short snake_case_file_safe and unique among existing titles;",
    "image = static keyframe prompt for Flux t2i (reuse the character block VERBATIM, keep the same visual style, new moment/pose/setting detail);",
    "motion = 1-2 sentences of motion + camera direction for LTX image-to-video (no cuts, no new characters).",
    "dialogue = 0-2 NEW speakable lines for THIS beat only as [{ speaker, line }] (speaker = on-screen character, each line under ~15 words) — NEVER copy a line from the existing beats; action-only beats use [].",
    "duration = clip length in seconds for this beat (1-30, usually the project default).",
    "Output ONLY a JSON object { title, image, motion, dialogue, duration } — no prose, no markdown fences.",
    // Same priority as craftScenario: the project's preset keeps the visual
    // language; the new beat only supplies the next story moment.
    ...(presetContent ? [`Visual language: the new beat MUST follow these preset rules:\n${presetContent}`] : []),
  ].join(" ");
  const user = `Scenario context:
${JSON.stringify({
    description: cfg.description || "",
    character: cfg.character || "",
    referencePrompt: cfg.referencePrompt || "",
    existingBeats: existing,
  }, null, 2)}

Write the next beat (beat ${existing.length + 1}).`;
  const d = await llmPostChat(`${LLM_BASE}/v1/chat/completions`, {
    model: LLM_MODEL,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    temperature: 0.7,
    max_tokens: 2000,
    chat_template_kwargs: { enable_thinking: false },
  }, { tag: "craft-beat" });
  let text = d.choices?.[0]?.message?.content || "";
  text = text.replace(/^\s*```(?:json)?\s*/, "").replace(/\s*```\s*$/, "").trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("LLM returned no JSON object");
  const b = JSON.parse(m[0]);
  if (!b.image || !b.motion) throw new Error("crafted beat missing image/motion");
  let title = slug(b.title) || `beat${existing.length + 1}`;
  const taken = new Set(existing.map((x) => x.title));
  if (taken.has(title)) title = `${title}_next`;
  const out = { title, image: String(b.image), motion: String(b.motion) };
  const dur = Number(b.duration);
  if (Number.isFinite(dur) && dur > 0) out.duration = Math.min(30, Math.max(1, Math.round(dur)));
  if (Array.isArray(b.dialogue)) {
    const dlg = b.dialogue
      .filter((x) => x && typeof x === "object")
      .map((x) => ({ speaker: String(x.speaker || "").trim(), line: String(x.line || "").trim() }))
      .filter((x) => x.line);
    // Never carry a copied line forward: drop any line that already appears
    // in an earlier beat (the "same text in every scene" defect).
    const seen = new Set(
      (cfg.sequence || []).flatMap((eb) => (Array.isArray(eb.dialogue) ? eb.dialogue : []))
        .map((x) => String(x && x.line || "").toLowerCase().replace(/[^a-z0-9\u0900-\u097f]+/g, " ").trim())
        .filter(Boolean)
    );
    const fresh = dlg.filter((x) => {
      const k = x.line.toLowerCase().replace(/[^a-z0-9\u0900-\u097f]+/g, " ").trim();
      if (k && seen.has(k)) return false;
      if (k) seen.add(k);
      return true;
    });
    if (fresh.length) out.dialogue = fresh;
  }
  return out;
}

/** Generate `count` consecutive beats; each call continues from the previous one. */
async function craftNextBeats(cfg, count) {
  // Preset continuity: beats inherit the project's visual language
  // (cfg.presetId, defaulting to cinematic for older saved projects).
  // A per-project cfg.presetRules override wins over the preset file.
  const customRules = String(cfg?.presetRules ?? "").trim();
  let presetContent;
  if (customRules) {
    presetContent = customRules;
  } else {
    const preset = resolvePresetId(cfg.presetId);
    ({ content: presetContent } = GetPresetContent(preset));
  }
  const beats = [];
  const cur = { ...cfg, sequence: [...(cfg.sequence || [])] };
  for (let i = 0; i < count; i++) {
    const b = await craftNextBeat(cur, presetContent);
    beats.push(b);
    cur.sequence.push(b);
  }
  // Master Prompt fan-out: the stored master (referencePrompt) is appended
  // to every new beat's keyframe image prompt (blank = untouched, AI prompt
  // only; motion is never touched).
  return applyMasterToBeats(beats, cfg.referencePrompt);
}

/**
 * Ask the local LLM for publishing metadata (title, description, hashtags)
 * for a finished scenario. Context = the scenario JSON itself (description /
 * character / referencePrompt + beat titles + prompts), so the copy matches
 * the actual story and visuals. Output is NOT persisted anywhere — the UI
 * keeps it per project in localStorage.
 */
async function craftVideoMeta(cfg) {
  if (!cfg || !Array.isArray(cfg.sequence) || !cfg.sequence.length)
    throw new Error("config with sequence required");
  const beats = (cfg.sequence || []).map((b, i) => ({
    n: i + 1,
    title: b.title,
    image: b.image,
    motion: b.motion,
  }));
  const system = [
    "You write publishing copy for a short AI-generated video (YouTube / Instagram).",
    "Output ONLY a JSON object { title, description, hashtags } — no prose, no markdown fences.",
    "Rules: title = one catchy, click-worthy YouTube-style line under 100 characters: plain Title Case words separated by single spaces (no quotes, no hashtags, no underscores, no snake_case, no hyphens joining words);",
    "description = 2-4 engaging sentences about THIS video's story and visuals, then one blank line, then a 'Watch' line naming the project;",
    "hashtags = 8-12 relevant tags WITHOUT the # prefix, lowercase, no spaces (use camelCase or underscores), ordered most-specific first.",
  ].join(" ");
  const user = `Video project context:
${JSON.stringify({
    project: cfg.description || "",
    character: cfg.character || "",
    referenceVisual: cfg.referencePrompt || "",
    beats,
  }, null, 2)}

Write the publishing metadata.`;
  const d = await llmPostChat(`${LLM_BASE}/v1/chat/completions`, {
    model: LLM_MODEL,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    temperature: 0.7,
    max_tokens: 1000,
    chat_template_kwargs: { enable_thinking: false },
  }, { tag: "craft-meta" });
  let text = d.choices?.[0]?.message?.content || "";
  text = text.replace(/^\s*```(?:json)?\s*/, "").replace(/\s*```\s*$/, "").trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("LLM returned no JSON object");
  const meta = JSON.parse(m[0]);
  if (!meta.title || !meta.description) throw new Error("crafted metadata missing title/description");
  // Normalize hashtags: accept an array or a whitespace/comma-separated
  // string; strip stray #/punctuation, force the # prefix at serve time.
  const rawTags = Array.isArray(meta.hashtags)
    ? meta.hashtags
    : String(meta.hashtags || "").split(/[\s,]+/);
  const tags = [];
  for (const t of rawTags) {
    const clean = String(t || "").replace(/^#+/, "").replace(/[^\w]/g, "").slice(0, 40);
    if (clean && !tags.includes(clean) && tags.length < 15) tags.push(clean);
  }
  return {
    title: toYouTubeTitle(meta.title).slice(0, 140),
    description: String(meta.description).trim().slice(0, 2000),
    hashtags: tags,
  };
}

/**
 * Ask the local LLM for a single Master Prompt (cinematic key-visual of the
 * main character) from a Description + the chosen Video Type (presetId /
 * presetRules). Stateless — nothing persisted; the Create New Project dialog
 * fills its Master Prompt box with the result.
 */
async function craftMasterPrompt({ description = "", presetId, presetRules } = {}) {
  const idea = String(description ?? "").trim();
  if (!idea) throw new Error("description required");
  // Video-type rules shape the master prompt's visual language. Per-project
  // custom rules win over the preset file; a missing/unreadable preset file
  // falls back to no-rules instead of failing the whole call.
  const customRules = String(presetRules ?? "").trim();
  let presetMeta = null;
  let presetContent = "";
  if (customRules) {
    const preset = resolvePresetId(presetId);
    presetMeta = GetPresetById(preset) ?? { id: preset, name: preset };
    presetContent = customRules;
  } else {
    try {
      const preset = resolvePresetId(presetId);
      const got = GetPresetContent(preset);
      presetMeta = got.meta;
      presetContent = got.content;
    } catch (e) {
      console.warn("[master-prompt] preset unavailable, continuing without rules:", e.message);
    }
  }
  const system = [
    "You write a single cinematic key-visual prompt for AI image generation (Flux text-to-image).",
    "Output ONLY the prompt text — 2-4 dense sentences, no JSON, no quotes, no markdown, no preamble.",
    "Rules: describe ONE consistent main character (age, look, outfit) + art style + lighting + mood + setting detail,",
    "keep it reusable as a prefix for every scene's keyframe prompt. No camera motion, no cuts, no story beats.",
  ].join(" ");
  const user = [
    `Video description:\n${idea}`,
    `Video type: ${presetMeta ? presetMeta.name : "general"}`,
    ...(presetContent
      ? [`Video-type rules — the Master Prompt MUST follow this visual language:\n${presetContent}`]
      : []),
    "Write the Master Prompt (cinematic key-visual of the main character).",
  ].join("\n\n");
  const d = await llmPostChat(`${LLM_BASE}/v1/chat/completions`, {
    model: LLM_MODEL,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    temperature: 0.7,
    max_tokens: 800,
    chat_template_kwargs: { enable_thinking: false },
  }, { tag: "craft-master" });
  let text = String(d.choices?.[0]?.message?.content || "").trim();
  // Strip fences/quotes if the model adds them despite the instructions.
  text = text.replace(/^\s*```(?:\w+)?\s*/, "").replace(/\s*```\s*$/, "").trim();
  text = text.replace(/^["“”']+|["“”']+$/g, "").trim();
  // Collapse to a single prompt: first JSON string value, or first paragraph.
  if (/^\s*\{/.test(text)) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const o = JSON.parse(m[0]);
        const cand = o.masterPrompt || o.referencePrompt || o.prompt || o.text;
        if (cand) text = String(cand).trim();
      } catch { /* keep raw text */ }
    }
  }
  text = text.split(/\n\s*\n/)[0].trim().replace(/\s+/g, " ");
  if (!text) throw new Error("LLM returned an empty master prompt");
  return { masterPrompt: text.slice(0, 2000) };
}

/**
 * AI merge of one Master Prompt addition into one scene's keyframe image
 * prompt. Stateless — used by the "Apply to All Scenes" popup, which calls
 * it once per scene so the popup can show per-scene progress.
 *
 * - Verbatim fast path: scene already contains the master text -> unchanged.
 * - Otherwise the local LLM decides placement: character traits go next to
 *   the character mention, style/lighting tokens at the end, objects or
 *   locations where the scene mentions them. Scene specifics are never
 *   dropped; motion is never touched (caller only sends/uses `image`).
 * - Returns { image, changed, skipped, reason }. On LLM failure the caller
 *   falls back to the naive append (same rule as applyMasterToBeats).
 */
async function mergeMasterIntoScene(master, beat) {
  const m = String(master ?? "").trim();
  const img = String(beat?.image ?? "");
  if (!m) return { image: img, changed: false, skipped: true, reason: "empty master" };
  if (!img.trim()) return { image: m, changed: true, skipped: false, reason: "empty scene prompt — master used as-is" };
  if (img.includes(m)) return { image: img.trim(), changed: false, skipped: true, reason: "master already present verbatim" };
  const system = [
    "You edit Flux text-to-image keyframe prompts. Output ONLY a JSON object, no prose, no markdown fences.",
    'Schema: { "image": string, "changed": boolean, "reason": string }.',
    "Rules:",
    "- `image` = the FULL updated keyframe prompt (one dense paragraph).",
    "- First check whether every visual detail of the master addition is ALREADY in the scene prompt (exact words OR a clear paraphrase, e.g. 'crimson beak' covers 'red beak'). If yes, return the scene prompt unchanged with changed=false.",
    "- If not, insert ONLY the missing detail(s) at the natural place: character traits (e.g. 'parrot red beak') right after that character/subject is mentioned, style/lighting/mood tokens at the end, objects/locations where the scene mentions them.",
    "- Never drop or paraphrase the scene's own action, setting, or composition. Never invent new characters or story beats. Never touch motion/camera (not provided).",
    "- Keep it one paragraph, comma-joined, no trailing period required.",
  ].join(" ");
  const user = JSON.stringify({
    master_addition: m.slice(0, 2000),
    scene_title: String(beat?.title ?? "").slice(0, 120),
    scene_image_prompt: img.slice(0, 4000),
  });
  const d = await llmPostChat(`${LLM_BASE}/v1/chat/completions`, {
    model: LLM_MODEL,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    temperature: 0.2,
    max_tokens: 2000,
    chat_template_kwargs: { enable_thinking: false },
  }, { tag: "apply-master-scene" });
  let text = String(d.choices?.[0]?.message?.content || "").trim();
  text = text.replace(/^\s*```(?:json)?\s*/, "").replace(/\s*```\s*$/, "").trim();
  const mt = text.match(/\{[\s\S]*\}/);
  if (!mt) throw new Error("LLM returned no JSON object");
  const out = JSON.parse(mt[0]);
  const nextImg = String(out.image ?? "").trim();
  if (!nextImg) throw new Error("LLM returned an empty image prompt");
  const changed = out.changed !== false && nextImg !== img.trim();
  return {
    image: nextImg.slice(0, 4000),
    changed,
    skipped: !changed,
    reason: String(out.reason || (changed ? "merged missing detail" : "already present")).slice(0, 300),
  };
}

// ---------------------------------------------------------------------------
function toYouTubeTitle(s) {
  let t = String(s || "").replace(/^["“”']+|["“”']+$/g, "").trim();
  t = t.replace(/#\S+/g, " "); // never keep hashtags inside the title
  t = t.replace(/[_]+/g, " ").replace(/[-–—]+/g, " ").replace(/\s+/g, " ").trim();
  t = t.split(" ").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  return t;
}

// ---------------------------------------------------------------- static files
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".flac": "audio/flac", ".ico": "image/x-icon" };
function serveStatic(req, res, urlPath) {
  let file = path.normalize(path.join(DIST, urlPath));
  if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, "index.html");
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end("not found"); }
  const headers = { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" };
  if (path.basename(file) === "index.html") headers["Cache-Control"] = "no-store"; // never serve a stale UI
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}
function serveOutput(res, scenario, file) {
  const p = path.join(OUTPUTS, scenario, file);
  if (!isSafe(scenario) || !isSafe(file) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(p).pipe(res);
}

// ---------------------------------------------------------------- outputs (versions + mains)
// Output dir name -> scenario config name (Wan runs use outputs/<scenario>_wan;
// vertical Instagram Reel cuts use outputs/<scenario>[_wan]_vertical/).
const cfgNameFor = (dirName) => cfgNameForDir(dirName);
const prefixFor = (dirName) => prefixForDir(dirName);

/**
 * List output files + versioned assets for a scenario output dir.
 * versions: { ref: [{file,v}], beats: { n: { keyframe: [...], clip: [...] } } }
 * mains:    { ref: file|null,    beats: { n: { keyframe: file|null, clip: file|null } } }
 */
async function outputsPayload(name) {
  const dir = path.join(OUTPUTS, name);
  const onDisk = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => !f.startsWith(".")).sort()
    : [];
  // File list comes from disk (outputs/ dirs are the source of truth).
  // Deleted files simply vanish from the listing — never broken media.
  const files = [...onDisk]
    .filter((f) => fs.existsSync(path.join(dir, f)));
  const versions = { ref: [], beats: {}, final: [] };
  const mains = { ref: null, beats: {}, final: null, pinned: { ref: false, beats: {} } };
  // Config for version mapping: prompts JSON first, store copy as fallback
  // (a scenario can live in the store while its JSON is missing/renamed).
  // Dirs are folder-based; the config is keyed by DISPLAY name, resolved
  // from the owning project row (legacy dirs fall back to suffix-stripping).
  let cfg = null;
  const { base: folderBase } = splitDirSuffix(name);
  const cfgName = (pgUp ? await displayNameForFolder(folderBase) : null) || cfgNameFor(name);
  // SPACE-FREE prompts files: resolve the slug-named export first, legacy
  // raw display-name file second (see promptsReadFile).
  const cfgPath = promptsReadFile(cfgName);
  try {
    if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch { cfg = null; }
  if (!cfg) {
    try {
      const raw = await dbGetScenario(cfgName);
      if (raw) cfg = JSON.parse(raw);
    } catch { cfg = null; }
  }
  if (!cfg) {
    try {
      // Folder-keyed fallback: the config may live only in the store under a
      // legacy display name whose slug IS this folder ("Pyari billi_2" ->
      // "pyari_billi_2"). Slug-matching finds it in SQLite mode too (where
      // the projects table can't map folder -> display name).
      const rows = await dbListScenarios();
      const hit = rows.find((r) => configSlug(r.name) === configSlug(folderBase));
      if (hit) cfg = JSON.parse(hit.config);
    } catch { cfg = null; }
  }
  if (files.length && cfg?.referencePrompt && Array.isArray(cfg?.sequence)) {
    const vm = versionMap(dir, prefixFor(name), cfg.sequence);
    mains.ref = vm.refMain;
    mains.pinned.ref = !!vm.refPinned;
    // Explicit deselect (gallery main toggled off): no reference is main, so
    // nothing below may fall back to latest — keyframes run text-only.
    mains.refOff = !!vm.refOff;
    for (const [n, b] of Object.entries(vm.beats)) {
      versions.beats[n] = { keyframe: b.keyframe, clip: b.clip };
      mains.beats[n] = { keyframe: b.keyframeMain, clip: b.clipMain };
      mains.pinned.beats[n] = { keyframe: !!b.keyframePinned, clip: !!b.clipPinned };
    }
    versions.ref = vm.ref;
    versions.final = vm.final ?? [];
    mains.final = vm.finalMain ?? null;
  }
  // Reference section is served from project_references (one row per
  // generation/upload, is_main = UI-selected main), unioned with the
  // on-disk versions so files without a row yet (CLI runs, backfill gaps)
  // still render. DB order/metadata win; missing files are filtered so
  // deleted renders never show. Disk stays the fallback (drafts, PG down,
  // never-recorded legacy files).
  let refMeta = {};
  if (pgUp) {
    try {
      const pid = await pgProjectId(cfgName);
      if (pid != null) {
        const refs = (await pgReferenceList(pid, name)).filter((r) =>
          fs.existsSync(path.join(dir, r.file)));
        if (refs.length) {
          const byFile = new Map(versions.ref.map((v) => [v.file, v.v]));
          for (const r of refs) byFile.set(r.file, r.v);
          versions.ref = [...byFile.entries()]
            .map(([file, v]) => ({ file, v }))
            .sort((a, b) => a.v - b.v || (a.file < b.file ? -1 : 1));
          if (mains.refOff) {
            // Deselected: keep mains.ref null even though rows exist.
            mains.ref = null;
            mains.pinned.ref = false;
          } else {
            // Explicit-only: an is_main row or nothing — never auto-latest.
            const main = refs.find((r) => r.is_main) ?? null;
            mains.ref = main ? main.file : null;
            mains.pinned.ref = !!main?.pinned;
          }
          refMeta = Object.fromEntries(refs.map((r) => [r.file, {
            prompt: r.prompt, source: r.source, pinned: r.pinned,
          }]));
        }
      }
    } catch (e) { console.warn("[outputs] reference overlay failed:", e.message); }
  }
  return { files, versions, mains, refMeta };
}

// ---------------------------------------------------------------- router
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  try {
    if (p === "/api/login" && req.method === "POST") {
      const body = await readJson(req);
      const ok = String(body.username || "") === AUTH_USER && String(body.password || "") === AUTH_PASS;
      if (!ok) return json(res, 401, { error: "invalid credentials" });
      pruneSessions();
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(token, { user: AUTH_USER, exp: Date.now() + SESSION_TTL_MS });
      res.setHeader("Set-Cookie", sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)));
      return json(res, 200, { user: AUTH_USER });
    }
    if (p === "/api/logout" && req.method === "POST") {
      const token = cookieValue(req);
      if (token) sessions.delete(token);
      res.setHeader("Set-Cookie", sessionCookie("", 0));
      return json(res, 200, { ok: true });
    }
    if (p === "/api/me" && req.method === "GET") {
      const user = authedUser(req);
      // Session bootstrap is a normal unauthenticated state, not an API
      // failure. Returning null avoids noisy 401s in the browser console.
      return json(res, 200, { user: user ?? null });
    }
    // Public read so the login screen + first paint already use the saved
    // theme (writes stay behind auth below).
    if (p === "/api/theme" && req.method === "GET") {
      return json(res, 200, readThemeFile());
    }

    // Everything below (API + generated outputs) requires a session.
    if ((p.startsWith("/api/") || p.startsWith("/outputs/") || p.startsWith("/resources/") || p.startsWith("/kids/") || p.startsWith("/director-assets/")) && !authedUser(req))
      return json(res, 401, { error: "unauthorized" });

    // Movie module: isolated identity records and reference files. These
    // routes do not touch Director boards, assets, prompts, or workflows.
    if (p === "/api/movie/capabilities" && req.method === "GET") {
      const base = String(process.env.COMFY_BASE || "").replace(/\/+$/, "");
      let inventory = { status: "not-configured", detail: "COMFY_BASE is not configured" };
      if (base) {
        try {
          const [nodeResponse, modelResponse] = await Promise.all([
            fetch(`${base}/object_info`, { signal: AbortSignal.timeout(2500) }),
            fetch(`${base}/models/checkpoints`, { signal: AbortSignal.timeout(2500) }),
          ]);
          if (!nodeResponse.ok) throw new Error(`ComfyUI node inventory returned HTTP ${nodeResponse.status}`);
          const nodes = await nodeResponse.json();
          const models = modelResponse.ok ? await modelResponse.json() : [];
          const names = Object.keys(nodes || {});
          inventory = { status: "available", node_count: names.length,
            identity_reference_nodes: names.filter((name) => /ip.?adapter|instant.?id|pulid|reactor|face.?ip|referencelatent|reference.*(image|embed)|.*reference.*video/i.test(name)),
            checkpoint_models: Array.isArray(models) ? models : [],
            model_inventory_status: modelResponse.ok ? "available" : `unavailable (HTTP ${modelResponse.status})` };
        } catch (e) { inventory = { status: "unavailable", detail: String(e?.message || e) }; }
      }
      return json(res, 200, { workflows: movieCapabilityRegistry(), inventory });
    }
    if (p === "/api/movie/director-references" && req.method === "GET") {
      const results = [];
      if (fs.existsSync(DIRECTOR)) for (const file of fs.readdirSync(DIRECTOR).filter((name) => name.endsWith(".json"))) {
        const boardId = path.basename(file, ".json");
        let board;
        try { board = directorAssetReadBoard(boardId); } catch { continue; }
        if (!board) continue;
        for (const asset of getBoardAssetState(board).assets || []) {
          if (!["character", "location", "object"].includes(asset.type) || asset.status !== "approved" || !asset.reference) continue;
          const rel = String(asset.reference).replaceAll("\\", "/");
          if (rel.split("/").some((part) => part === ".." || part === "")) continue;
          const full = path.resolve(DIRECTOR_ASSETS_DIR, ...rel.split("/"));
          if (!full.startsWith(path.resolve(DIRECTOR_ASSETS_DIR) + path.sep) || !fs.existsSync(full)) continue;
          results.push({ board_id: boardId, asset_id: asset.id, blueprint_id: asset.blueprint_id || "", type: asset.type, name: asset.name,
            prompt: asset.prompt || "", description: asset.description || asset.prompt || "", reference: rel, preview_url: `/director-assets/${rel.split("/").map(encodeURIComponent).join("/")}` });
        }
      }
      return json(res, 200, results);
    }
    if (p === "/api/movie/projects" && req.method === "GET") return json(res, 200, listMovieProjects());
    if (p === "/api/movie/projects" && req.method === "POST") {
      const body = await readJson(req);
      if (!String(body.title || "").trim()) return json(res, 400, { error: "Movie title is required" });
      return json(res, 201, createMovieProject(String(body.title).trim()));
    }
    const movieProjectMatch = p.match(/^\/api\/movie\/projects\/([^/]+)$/);
    const movieProductionMatch = p.match(/^\/api\/movie\/projects\/([^/]+)\/production$/);
    if (movieProductionMatch && req.method === "GET") {
      const project = getMovieProject(decodeURIComponent(movieProductionMatch[1]));
      return project ? json(res, 200, { screenplay: project.screenplay, scenes: project.scenes }) : json(res, 404, { error: "Movie not found" });
    }
    if (movieProductionMatch && req.method === "PUT") {
      try {
        const movieId = decodeURIComponent(movieProductionMatch[1]), body = await readJson(req), project = getMovieProject(movieId);
        if (!project) return json(res, 404, { error: "Movie not found" });
        if (!Array.isArray(body.scenes) || body.scenes.some((scene) => !Number.isInteger(Number(scene.scene_number)) || !Array.isArray(scene.shots))) return json(res, 400, { error: "Production data needs numbered scenes with shot arrays" });
        const characterIds = new Set(project.characters.map((character) => character.character_id));
        const environmentAssets = new Map((project.environment_assets || []).map((asset) => [asset.asset_id, asset]));
        for (const scene of body.scenes) for (const shot of scene.shots) {
          for (const characterId of shot.character_ids || []) if (!characterIds.has(String(characterId)))
            return json(res, 409, { error: `Shot ${shot.shot_id} references unresolved character ${characterId}` });
          for (const [kind, ids] of [["location", shot.location_ids || []], ["object", shot.object_ids || []]]) for (const id of ids) {
            const asset = environmentAssets.get(String(id));
            if (!asset || asset.kind !== kind) return json(res, 409, { error: `Shot ${shot.shot_id} references an unresolved ${kind} ${id}` });
          }
        }
        return json(res, 200, saveMovieProduction(movieId, body.screenplay || {}, body.scenes));
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    const movieJobsMatch = p.match(/^\/api\/movie\/projects\/([^/]+)\/jobs$/);
    if (movieJobsMatch && req.method === "GET") {
      const movieId = decodeURIComponent(movieJobsMatch[1]);
      if (!getMovieProject(movieId)) return json(res, 404, { error: "Movie not found" });
      // Jobs are persisted, but their renderer processes are in-memory. After a
      // server restart an old queued/running row would otherwise keep the UI
      // showing "Generating keyframe…" forever even though no render exists.
      const stranded = movieDb.prepare("SELECT job_id FROM movie_generation_jobs WHERE movie_id=? AND status IN ('queued','running')").all(movieId)
        .filter(({ job_id }) => !movieGenerationProcesses.has(job_id));
      for (const { job_id } of stranded) updateMovieJob(job_id, { status: "failed", error: "Renderer process is no longer active. Retry keyframe generation." });
      return json(res, 200, listMovieJobs(movieId));
    }
    const movieShotAction = p.match(/^\/api\/movie\/shots\/([^/]+)\/(keyframe|reference-packets|assets)$/);
    if (movieShotAction && req.method === "POST" && movieShotAction[2] === "keyframe") {
      const shotId = decodeURIComponent(movieShotAction[1]), found = findMovieShot(shotId);
      if (!found) return json(res, 404, { error: "Movie shot not found" });
      const { project, scene, shot } = found;
      try {
        const characterPackets = moviePacketsForShot(project, scene, shot);
        const environment = movieEnvironmentForShot(project, scene, shot);
        if (!characterPackets.length && !environment.locations.length && !environment.objects.length)
          return json(res, 409, { error: "Assign a locked character or add a named, locked location/object reference for this shot before generating." });
        const comfy = await directorComfyProbe();
        if (!comfy.up) return json(res, 503, { error: `ComfyUI is unavailable: ${comfy.error}` });
        const active = movieDb.prepare("SELECT job_id FROM movie_generation_jobs WHERE shot_id=? AND kind='keyframe' AND status IN ('queued','running')").get(shotId);
        if (active) return json(res, 409, { error: "A keyframe is already generating for this shot", job_id: active.job_id });
        const inventoryResponse = await fetch(`${String(process.env.COMFY_BASE).replace(/\/+$/, "")}/object_info`, { signal: AbortSignal.timeout(2500) });
        if (!inventoryResponse.ok) return json(res, 503, { error: "Could not inspect the ComfyUI node inventory; keyframe generation was not queued." });
        const inventory = await inventoryResponse.json();
        const requiredReferenceNodes = ["ReferenceLatent", "ImageScaleToTotalPixels", "LoadImage", "VAEEncode"];
        const missingReferenceNodes = requiredReferenceNodes.filter((node) => !inventory[node]);
        if (missingReferenceNodes.length) return json(res, 503, { error: `The installed ComfyUI is missing Movie reference nodes: ${missingReferenceNodes.join(", ")}.` });
        const prompt = buildMovieKeyframePrompt({ characters: characterPackets.map(({ character, costume, state, packet }) => ({ character, costume, state,
          secondary_reference_type: [packet.face_profile_view?.replaceAll("_", " ") || "", packet.costume_reference ? "costume" : packet.body_reference ? "full-body" : ""].filter(Boolean).join(" then ") })),
          locations: environment.locations, objects: environment.objects, shot, scene });
        const workflow = resolveImageWorkflow("flux", "flux");
        const job = createMovieJob({ movie_id: project.movie_id, shot_id: shotId, kind: "keyframe", prompt, workflow: workflow.id, model: workflow.model });
        const safeMovie = project.movie_id.replace(/[^A-Za-z0-9_-]/g, "_");
        const safeShot = shotId.replace(/[^A-Za-z0-9_-]/g, "_");
        const version = Number(movieDb.prepare("SELECT COALESCE(MAX(version),0)+1 AS n FROM movie_shot_assets WHERE shot_id=? AND kind='keyframe'").get(shotId).n);
        const movieRoot = path.dirname(movieFilesDir);
        const output = path.join(movieRoot, "Movies", safeMovie, "Scenes", String(scene.scene_number), "Shots", safeShot, `keyframe_v${version}_${job.job_id}.png`);
        const relativeOutput = path.relative(ROOT, output).replaceAll("\\", "/");
        const jobDir = path.join(movieRoot, "jobs"); fs.mkdirSync(jobDir, { recursive: true });
        const jobFile = path.join(jobDir, `${job.job_id}.json`);
        const environment_references = [...environment.locations, ...environment.objects].map(({ asset_id, kind, name, description, identity_version, reference_path }) => ({ asset_id, kind, name, description, identity_version, reference_path }));
        fs.writeFileSync(jobFile, JSON.stringify({ job_id: job.job_id, prompt, packets: characterPackets.map((entry) => entry.packet), environment_references, workflow: workflow.id, model: workflow.model,
          prefix: `movie/${safeMovie}/scene_${scene.scene_number}/${safeShot}/${job.job_id}` }, null, 2));
        updateMovieJob(job.job_id, { status: "running" });
        let proc;
        try {
          proc = spawn(process.execPath, [path.join(ROOT, "scripts/movie_keyframe.mjs"), "--job-file", jobFile, "--out", output],
            { cwd: ROOT, env: process.env, windowsHide: true });
        } catch (error) {
          movieGenerationProcesses.delete(job.job_id);
          updateMovieJob(job.job_id, { status: "failed", error: `Could not start Movie keyframe renderer: ${String(error.message || error).slice(-900)}` });
          return json(res, 500, { error: "Could not start the keyframe renderer. The job was marked failed; retry generation." });
        }
        movieGenerationProcesses.set(job.job_id, proc);
        let log = "";
        proc.stdout?.on("data", (chunk) => { log = `${log}${chunk}`.slice(-12000); });
        proc.stderr?.on("data", (chunk) => { log = `${log}${chunk}`.slice(-12000); });
        proc.on("error", (error) => {
          movieGenerationProcesses.delete(job.job_id);
          updateMovieJob(job.job_id, { status: "failed", error: String(error.message || error).slice(-1000) });
        });
        proc.on("close", (code) => {
          movieGenerationProcesses.delete(job.job_id);
          if (code === 0 && fs.existsSync(output)) {
            addMovieShotAsset({ shot_id: shotId, job_id: job.job_id, kind: "keyframe", version, file_path: relativeOutput,
              prompt, workflow: workflow.id, model: workflow.model });
            updateMovieJob(job.job_id, { status: "review", asset_path: relativeOutput });
          } else updateMovieJob(job.job_id, { status: "failed", error: (log || `renderer exited with code ${code}`).slice(-1000) });
        });
        return json(res, 202, { job, workflow: workflow.id, model: workflow.model, message: `Keyframe generation started with ${characterPackets.length} character packet(s), ${environment.locations.length} location reference(s), and ${environment.objects.length} object reference(s). The result will appear here for review when rendering completes.` });
      } catch (e) { return json(res, 409, { error: e.message }); }
    }
    if (movieShotAction && req.method === "GET" && movieShotAction[2] === "assets") {
      const found = findMovieShot(decodeURIComponent(movieShotAction[1]));
      if (!found) return json(res, 404, { error: "Movie shot not found" });
      return json(res, 200, { assets: movieDb.prepare("SELECT * FROM movie_shot_assets WHERE shot_id=? ORDER BY kind,version DESC").all(found.shot.shot_id),
        jobs: movieDb.prepare("SELECT * FROM movie_generation_jobs WHERE shot_id=? ORDER BY created_at DESC").all(found.shot.shot_id) });
    }
    const movieShotPacketMatch = p.match(/^\/api\/movie\/shots\/([^/]+)\/reference-packets$/);
    if (movieShotPacketMatch && req.method === "GET") {
      const shotId = decodeURIComponent(movieShotPacketMatch[1]);
      const project = listMovieProjects().map((row) => getMovieProject(row.movie_id)).find((row) => row.scenes.some((scene) => scene.shots.some((shot) => shot.shot_id === shotId)));
      const scene = project?.scenes.find((row) => row.shots.some((shot) => shot.shot_id === shotId));
      const shot = scene?.shots.find((row) => row.shot_id === shotId);
      if (!project || !scene || !shot) return json(res, 404, { error: "Movie shot not found" });
      try {
        const packets = moviePacketsForShot(project, scene, shot).map((entry) => entry.packet);
        const environment = movieEnvironmentForShot(project, scene, shot);
        return json(res, 200, { movie_id: project.movie_id, scene_id: scene.scene_id, shot_id: shot.shot_id, packets, environment });
      } catch (e) { return json(res, 409, { error: e.message }); }
    }
    if (movieProjectMatch && req.method === "GET") {
      const project = getMovieProject(decodeURIComponent(movieProjectMatch[1]));
      return project ? json(res, 200, project) : json(res, 404, { error: "Movie not found" });
    }
    const movieCharacterMatch = p.match(/^\/api\/movie\/projects\/([^/]+)\/characters$/);
    if (movieCharacterMatch && req.method === "POST") {
      try {
        const body = await readJson(req);
        return json(res, 201, addMovieCharacter(decodeURIComponent(movieCharacterMatch[1]), normalizeMovieCharacter(body)));
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    const characterRoute = p.match(/^\/api\/movie\/characters\/([^/]+)(?:\/(approve|unlock|references|canonical|costumes|packet))?$/);
    if (characterRoute) {
      const id = decodeURIComponent(characterRoute[1]), action = characterRoute[2];
      if (!action && req.method === "PUT") {
        try { const body = await readJson(req); const old = getMovieCharacter(id); if (!old) return json(res, 404, { error: "Character not found" });
          return json(res, 200, updateMovieCharacter(id, normalizeMovieCharacter(body, old), body.create_identity_version === true));
        } catch (e) { return json(res, 409, { error: e.message }); }
      }
      if (action === "approve" && req.method === "POST") {
        try { return json(res, 200, setCharacterApproval(id, "approved")); } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (action === "unlock" && req.method === "POST") {
        try { return json(res, 200, setCharacterApproval(id, "draft")); } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (action === "references" && req.method === "POST") {
        try {
          const body = await readJson(req), match = String(body.data_url || "").match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
          if (!match) return json(res, 400, { error: "Upload a PNG, JPEG, or WebP image" });
          const bytes = Buffer.from(match[2], "base64");
          if (bytes.length > 12 * 1024 * 1024) return json(res, 413, { error: "Reference image must be under 12 MB" });
          const ref = addCharacterReference(id, String(body.view || "canonical"), "");
          const ext = match[1] === "jpeg" ? "jpg" : match[1], file = `${ref.reference_id}.${ext}`, full = path.join(movieFilesDir, file);
          fs.writeFileSync(full, bytes);
          const relative = path.relative(ROOT, full).replaceAll("\\", "/");
          movieDb.prepare("UPDATE movie_character_references SET file_path=? WHERE reference_id=?").run(relative, ref.reference_id);
          return json(res, 201, { ...ref, file_path: relative });
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (action === "references" && req.method === "PUT") {
        try {
          const body = await readJson(req), boardId = String(body.board_id || ""), assetId = String(body.asset_id || "");
          if (!isSafe(boardId)) return json(res, 400, { error: "Invalid Director board id" });
          const board = directorAssetReadBoard(boardId);
          if (!board) return json(res, 404, { error: "Director board not found" });
          const asset = (getBoardAssetState(board).assets || []).find((row) => row.id === assetId && row.type === "character" && row.status === "approved" && row.reference);
          if (!asset) return json(res, 409, { error: "Select an approved Director character reference" });
          const rel = String(asset.reference).replaceAll("\\", "/");
          if (rel.split("/").some((part) => part === ".." || part === "")) return json(res, 400, { error: "Invalid Director reference path" });
          const full = path.resolve(DIRECTOR_ASSETS_DIR, ...rel.split("/"));
          if (!full.startsWith(path.resolve(DIRECTOR_ASSETS_DIR) + path.sep) || !fs.existsSync(full)) return json(res, 404, { error: "Approved Director reference file is missing" });
          return json(res, 200, importMovieCharacterReference(id, "canonical_face", path.relative(ROOT, full).replaceAll("\\", "/"), boardId, assetId));
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (action === "canonical" && req.method === "PUT") {
        try { const body = await readJson(req); return json(res, 200, setCanonicalReference(id, body.reference_id)); } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (action === "costumes" && req.method === "POST") {
        try {
          const body = await readJson(req);
          if (!String(body.name || "").trim()) return json(res, 400, { error: "Costume name is required" });
          let reference_path = null;
          if (body.reference_data_url) {
            const match = String(body.reference_data_url).match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
            if (!match) return json(res, 400, { error: "Upload a PNG, JPEG, or WebP costume image" });
            const bytes = Buffer.from(match[2], "base64");
            if (bytes.length > 12 * 1024 * 1024) return json(res, 413, { error: "Costume reference must be under 12 MB" });
            const ext = match[1] === "jpeg" ? "jpg" : match[1];
            const full = path.join(movieFilesDir, `costume_${crypto.randomBytes(8).toString("hex")}.${ext}`);
            fs.writeFileSync(full, bytes); reference_path = path.relative(ROOT, full).replaceAll("\\", "/");
          }
          return json(res, 201, addMovieCostume(id, { ...body, reference_path }));
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (action === "packet" && req.method === "POST") {
        try {
          const body = await readJson(req), project = getMovieProject(body.movie_id);
          const character = project?.characters.find((row) => row.character_id === id);
          if (!character) return json(res, 404, { error: "Movie character not found" });
          const costume = character.costumes.find((row) => row.costume_id === body.costume_id && row.approval_status === "approved") ?? null;
          const packet = buildMovieReferencePacket({ movieId: project.movie_id, character, costume, expression: body.expression, state: body.state, shot: body.shot });
          return json(res, 200, resolveMoviePacketFiles(packet));
        } catch (e) { return json(res, 409, { error: e.message }); }
      }
    }
    const refReview = p.match(/^\/api\/movie\/references\/([^/]+)\/(approve|reject|image)$/);
    if (refReview && req.method === "POST" && refReview[2] !== "image") {
      try { return json(res, 200, reviewCharacterReference(decodeURIComponent(refReview[1]), refReview[2] === "approve" ? "approved" : "rejected")); } catch (e) { return json(res, 404, { error: e.message }); }
    }
    if (refReview && req.method === "GET" && refReview[2] === "image") {
      const ref = movieDb.prepare("SELECT file_path FROM movie_character_references WHERE reference_id=?").get(decodeURIComponent(refReview[1]));
      if (!ref?.file_path) return json(res, 404, { error: "Image not found" });
      const full = path.resolve(ROOT, ref.file_path);
      const withinAllowedStore = [movieFilesDir, DIRECTOR_ASSETS_DIR].some((dir) => full.startsWith(path.resolve(dir) + path.sep));
      if (!withinAllowedStore || !fs.existsSync(full)) return json(res, 404, { error: "Image not found" });
      res.writeHead(200, { "Content-Type": full.endsWith(".png") ? "image/png" : full.endsWith(".webp") ? "image/webp" : "image/jpeg", "Cache-Control": "private, max-age=60" });
      return fs.createReadStream(full).pipe(res);
    }
    const costumeImage = p.match(/^\/api\/movie\/costumes\/([^/]+)\/image$/);
    if (costumeImage && req.method === "GET") {
      const row = movieDb.prepare("SELECT reference_path FROM movie_costumes WHERE costume_id=?").get(decodeURIComponent(costumeImage[1]));
      if (!row?.reference_path) return json(res, 404, { error: "Costume image not found" });
      const full = path.resolve(ROOT, row.reference_path);
      if (!full.startsWith(path.resolve(movieFilesDir) + path.sep) || !fs.existsSync(full)) return json(res, 404, { error: "Costume image not found" });
      res.writeHead(200, { "Content-Type": full.endsWith(".png") ? "image/png" : full.endsWith(".webp") ? "image/webp" : "image/jpeg", "Cache-Control": "private, max-age=60" });
      return fs.createReadStream(full).pipe(res);
    }
    const costumeReview = p.match(/^\/api\/movie\/costumes\/([^/]+)\/approve$/);
    if (costumeReview && req.method === "POST") {
      try { return json(res, 200, reviewCostume(decodeURIComponent(costumeReview[1]), "approved")); } catch (e) { return json(res, 404, { error: e.message }); }
    }
    const movieEnvironmentProject = p.match(/^\/api\/movie\/projects\/([^/]+)\/environment-assets$/);
    const movieEnvironmentDirectorImport = p.match(/^\/api\/movie\/projects\/([^/]+)\/environment-assets\/director-reference$/);
    if (movieEnvironmentDirectorImport && req.method === "POST") {
      try {
        const movieId = decodeURIComponent(movieEnvironmentDirectorImport[1]);
        if (!getMovieProject(movieId)) return json(res, 404, { error: "Movie not found" });
        const body = await readJson(req), boardId = String(body.board_id || ""), assetId = String(body.asset_id || "");
        if (!isSafe(boardId) || !assetId) return json(res, 400, { error: "Choose an approved Director location or object reference" });
        const board = directorAssetReadBoard(boardId);
        const asset = (board && getBoardAssetState(board).assets || []).find((row) => row.id === assetId && ["location", "object"].includes(row.type) && row.status === "approved" && row.reference);
        if (!asset) return json(res, 409, { error: "Select an approved Director location or object reference" });
        const rel = String(asset.reference).replaceAll("\\", "/");
        if (rel.split("/").some((part) => part === ".." || part === "")) return json(res, 400, { error: "Invalid Director reference path" });
        const full = path.resolve(DIRECTOR_ASSETS_DIR, ...rel.split("/"));
        if (!full.startsWith(path.resolve(DIRECTOR_ASSETS_DIR) + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile())
          return json(res, 404, { error: "Approved Director reference file is missing" });
        const kind = asset.type === "location" ? "location" : "object";
        const imported = addMovieEnvironmentAsset(movieId, { kind, name: String(asset.name || asset.id), description: String(asset.description || asset.prompt || "") });
        setMovieEnvironmentReference(imported.asset_id, path.relative(ROOT, full).replaceAll("\\", "/"));
        reviewMovieEnvironmentReference(imported.asset_id, "approved");
        return json(res, 201, setMovieEnvironmentLock(imported.asset_id, true));
      } catch (e) { return json(res, 409, { error: e.message }); }
    }
    if (movieEnvironmentProject && req.method === "POST") {
      try {
        const body = await readJson(req);
        const aliases = Array.isArray(body.aliases) ? body.aliases : String(body.aliases || "").split(",");
        return json(res, 201, addMovieEnvironmentAsset(decodeURIComponent(movieEnvironmentProject[1]), { ...body, aliases }));
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    const movieEnvironmentRoute = p.match(/^\/api\/movie\/environment-assets\/([^/]+)(?:\/(reference(?:\/approve)?|lock|unlock|image))?$/);
    if (movieEnvironmentRoute) {
      const id = decodeURIComponent(movieEnvironmentRoute[1]), action = movieEnvironmentRoute[2];
      if (!action && req.method === "PUT") {
        try {
          const body = await readJson(req), aliases = Array.isArray(body.aliases) ? body.aliases : String(body.aliases || "").split(",");
          return json(res, 200, updateMovieEnvironmentAsset(id, { ...body, aliases }));
        } catch (e) { return json(res, 409, { error: e.message }); }
      }
      if (action === "reference" && req.method === "POST") {
        try {
          const body = await readJson(req), match = String(body.data_url || "").match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
          if (!match) return json(res, 400, { error: "Upload a PNG, JPEG, or WebP reference image" });
          const bytes = Buffer.from(match[2], "base64");
          if (bytes.length > 12 * 1024 * 1024) return json(res, 413, { error: "Reference image must be under 12 MB" });
          const ext = match[1] === "jpeg" ? "jpg" : match[1], filename = `${id}_${crypto.randomBytes(6).toString("hex")}.${ext}`;
          const full = path.join(movieFilesDir, filename); fs.writeFileSync(full, bytes);
          const relative = path.relative(ROOT, full).replaceAll("\\", "/");
          return json(res, 200, setMovieEnvironmentReference(id, relative));
        } catch (e) { return json(res, 409, { error: e.message }); }
      }
      if (action === "reference/approve" && req.method === "POST") {
        try { return json(res, 200, reviewMovieEnvironmentReference(id, "approved")); } catch (e) { return json(res, 409, { error: e.message }); }
      }
      if (action === "lock" && req.method === "POST") {
        try { return json(res, 200, setMovieEnvironmentLock(id, true)); } catch (e) { return json(res, 409, { error: e.message }); }
      }
      if (action === "unlock" && req.method === "POST") {
        try { return json(res, 200, setMovieEnvironmentLock(id, false)); } catch (e) { return json(res, 409, { error: e.message }); }
      }
      if (action === "image" && req.method === "GET") {
        const row = movieDb.prepare("SELECT reference_path FROM movie_environment_assets WHERE asset_id=?").get(id);
        if (!row?.reference_path) return json(res, 404, { error: "Environment reference image not found" });
        const full = path.resolve(ROOT, row.reference_path);
        if (!full.startsWith(path.resolve(movieFilesDir) + path.sep) || !fs.existsSync(full)) return json(res, 404, { error: "Environment reference image not found" });
        res.writeHead(200, { "Content-Type": full.endsWith(".png") ? "image/png" : full.endsWith(".webp") ? "image/webp" : "image/jpeg", "Cache-Control": "private, max-age=60" });
        return fs.createReadStream(full).pipe(res);
      }
    }
    const movieShotAssetRoute = p.match(/^\/api\/movie\/shot-assets\/([^/]+)\/(approve|reject|image|media|delete)$/);
    if (movieShotAssetRoute && req.method === "POST" && !["image", "media", "delete"].includes(movieShotAssetRoute[2])) {
      try { return json(res, 200, reviewMovieShotAsset(decodeURIComponent(movieShotAssetRoute[1]), movieShotAssetRoute[2])); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (movieShotAssetRoute && req.method === "DELETE" && movieShotAssetRoute[2] === "delete") {
      const asset = getMovieShotAsset(decodeURIComponent(movieShotAssetRoute[1]));
      if (!asset) return json(res, 404, { error: "Shot media not found" });
      const full = path.resolve(ROOT, asset.file_path), movieOutputRoot = path.resolve(path.dirname(movieFilesDir), "Movies");
      if (!full.startsWith(movieOutputRoot + path.sep)) return json(res, 404, { error: "Shot media not found" });
      try {
        if (fs.existsSync(full)) fs.unlinkSync(full);
        const deleted = deleteMovieShotAsset(asset.asset_id);
        return json(res, 200, { deleted: true, asset_id: deleted.asset_id });
      } catch (e) { return json(res, 500, { error: `Could not delete Movie media: ${e.message}` }); }
    }
    if (movieShotAssetRoute && req.method === "GET" && ["image", "media"].includes(movieShotAssetRoute[2])) {
      const asset = getMovieShotAsset(decodeURIComponent(movieShotAssetRoute[1]));
      if (!asset) return json(res, 404, { error: "Shot media not found" });
      const full = path.resolve(ROOT, asset.file_path), movieOutputRoot = path.resolve(path.dirname(movieFilesDir), "Movies");
      if (!full.startsWith(movieOutputRoot + path.sep) || !fs.existsSync(full)) return json(res, 404, { error: "Shot media not found" });
      const ext = path.extname(full).toLowerCase();
      const contentType = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime" })[ext];
      if (!contentType) return json(res, 415, { error: "Unsupported Movie media format" });
      const size = fs.statSync(full).size, range = req.headers.range;
      if (range && contentType.startsWith("video/")) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) return json(res, 416, { error: "Invalid media range" });
        const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
        const end = match[1] ? Math.min(Number(match[2] || size - 1), size - 1) : size - 1;
        if (start >= size || end < start) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); return res.end(); }
        res.writeHead(206, { "Content-Type": contentType, "Cache-Control": "private, max-age=60", "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
        return fs.createReadStream(full, { start, end }).pipe(res);
      }
      res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "private, max-age=60", "Accept-Ranges": "bytes", "Content-Length": size });
      return fs.createReadStream(full).pipe(res);
    }

    if (p === "/api/settings/director-prompts" && req.method === "GET") {
      const settings = readDirectorPromptSettings();
      return json(res, 200, {
        catalog: DIRECTOR_PROMPT_RULES.map(({ id, scope, title, description, defaultEnabled, text }) => ({ id, scope, title, description, defaultEnabled, defaultText: text })),
        settings,
        appendedText: directorPromptAddons(settings),
        appendedTextByWorkflow: {
          director: directorPromptAddons(settings),
          kids: kidsPromptAddons(settings),
          documentary: documentaryPromptAddons(settings),
        },
      });
    }
    if (p === "/api/settings/director-prompts" && req.method === "PUT") {
      let body;
      try { body = await readJson(req); }
      catch { return json(res, 400, { error: "bad json" }); }
      const settings = writeDirectorPromptSettings(body);
      return json(res, 200, {
        catalog: DIRECTOR_PROMPT_RULES.map(({ id, scope, title, description, defaultEnabled, text }) => ({ id, scope, title, description, defaultEnabled, defaultText: text })),
        settings,
        appendedText: directorPromptAddons(settings),
        appendedTextByWorkflow: {
          director: directorPromptAddons(settings),
          kids: kidsPromptAddons(settings),
          documentary: documentaryPromptAddons(settings),
        },
      });
    }

    if (p === "/api/scenarios" && req.method === "GET") {
      const favs = readFavs();
      let rows;
      try { rows = await dbListScenarios(); }
      catch (e) { return json(res, 503, { error: "database unavailable" }); }
      // Integer project ids + immutable storage folders for the sidebar
      // (desc sort + #id chip + output-dir resolution). Both live on the
      // projects table; the scenarios store itself has neither column.
      // Null in SQLite mode / pre-migration rows (callers fall back to slug).
      let pidMap = new Map();
      let folderMap = new Map();
      let typeMap = new Map();
      let createdMap = new Map();
      if (pgUp) {
        try {
          const pr = await pgPool.query("SELECT name, project_id, folder_name, project_type, created_at FROM projects");
          pidMap = new Map(pr.rows.map((x) => [x.name, Number(x.project_id)]));
          folderMap = new Map(pr.rows.map((x) => [x.name, x.folder_name ?? null]));
          typeMap = new Map(pr.rows.map((x) => [x.name, x.project_type ?? null]));
          createdMap = new Map(pr.rows.map((x) => [x.name, x.created_at ? new Date(x.created_at).getTime() : null]));
        } catch { /* ids/folders/types stay null — sidebar falls back to mtime order/slug/VIDEO */ }
      }
      return json(res, 200, rows.map((r) => {
        const c = JSON.parse(r.config);
        return {
          name: r.name,
          // The user-typed project name ("Pyari billi") — the identity `name`
          // is the space-free internal KEY ("pyari_billi"). UI labels prefer
          // display_name and fall back to the key.
          display_name: (c && typeof c === "object" && typeof c.display_name === "string" && c.display_name.trim()) || null,
          // A character-sequence project = has a sequence array. The Master
          // Prompt is optional (blank = AI prompt only), so it must not
          // gate listing — otherwise master-less projects vanish.
          isSequence: Array.isArray(c.sequence),
          // node-pg returns BIGINT as string — coerce so the UI gets a real
          // epoch-ms number (a string renders as NaN-undefined-NaN).
          mtimeMs: Number(r.updated_at),
          favorite: favs.includes(r.name),
          project_id: pidMap.has(r.name) ? pidMap.get(r.name) : null,
          folder_name: folderMap.get(r.name) ?? null,
          project_type: typeMap.get(r.name) ?? "VIDEO",
          createdAt: createdMap.has(r.name) ? createdMap.get(r.name) : null,
        };
      }).sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || b.mtimeMs - a.mtimeMs)); // favorites first, then latest edited
    }
    // Import an external storyboard/project JSON file as a first-class
    // project. Body: { project: {...raw storyboard...}, name?: "override",
    // overwrite?: true }. The converter (lib/project_import.mjs) maps
    // scenes[] (scene_number/name/timestamp/camera_angle/visual_assets/
    // character_actions/on_screen_text/audio_cues + any extra keys) into a
    // canonical Scenario; every storyboard field is kept verbatim on the
    // beat / top-level config (JSONB columns), so unknown extras survive
    // with NO schema change. Persistence then follows the exact same path
    // as PUT /api/scenario/:name (scenarios row + prompts JSON + projects
    // row + versioned project_assets rows).
    if (p === "/api/scenarios/import" && req.method === "POST") {
      let body;
      try { body = await readJson(req); }
      catch { return json(res, 400, { error: "bad json" }); }
      const raw = body && typeof body === "object" && body.project && typeof body.project === "object"
        ? body.project
        : body;
      let converted;
      try { converted = storyboardToScenario(raw); }
      catch (e) { return json(res, 400, { error: e instanceof Error ? e.message : "invalid project JSON" }); }
      const wantedRaw = body && typeof body.name === "string" && body.name.trim() ? body.name.trim() : converted.name;
      // INTERNAL KEY: the import name becomes a space-free scenario key; the
      // typed name rides along as display_name for UI labels.
      const wanted = spaceFreeName(wantedRaw);
      if (!isSafe(wanted)) return json(res, 400, { error: "bad name" });
      if (converted.config && typeof converted.config === "object" && !converted.config.display_name) {
        converted.config.display_name = wantedRaw;
      }
      const overwrite = !!(body && body.overwrite);
      let prevRaw = null;
      try { prevRaw = await dbGetScenario(wanted); }
      catch (e) { return json(res, 503, { error: "database unavailable" }); }
      if (prevRaw !== null && !overwrite) {
        return json(res, 409, { error: `project "${wanted}" already exists`, exists: true, name: wanted });
      }
      const cfg = converted.config;
      const explicitType = explicitProjectType(cfg);
      if (cfg && typeof cfg === "object") delete cfg.project_type;
      if (cfg && typeof cfg === "object") { delete cfg.topic; delete cfg.requirements; }
      const storedFolder = pgUp ? await getFolderNameFromRow(wanted) : null;
      let folder = storedFolder;
      if (!folder && pgUp) {
        folder = await ensureUniqueFolder(wanted, wanted);
        try {
          await pgPool.query(
            "UPDATE projects SET folder_name = $2 WHERE name = $1 AND (folder_name IS NULL OR folder_name = '')",
            [wanted, folder]);
        } catch { /* row may not exist yet — claimed on version save */ }
      }
      if (typeof cfg === "object" && cfg) {
        if (!storedFolder || !cfg.folder_name) cfg.folder_name = folder || folderName(wanted);
      }
      if (USE_SQLITE) {
        await dbSaveScenario(wanted, cfg);
        fs.writeFileSync(promptsSlugFile(wanted), JSON.stringify(cfg, null, 2));
        pgSaveScenarioMirror(wanted, cfg).catch((e) => console.warn("[pg] scenario mirror failed:", e.message));
      } else {
        if (!pgUp) return json(res, 503, { error: "database unavailable" });
        await dbSaveScenario(wanted, cfg);
        fs.writeFileSync(promptsSlugFile(wanted), JSON.stringify(cfg, null, 2));
      }
      let version = null;
      let project_id = null;
      if (pgUp) {
        try {
          let prevCfg = null;
          try { prevCfg = prevRaw != null ? JSON.parse(prevRaw) : null; }
          catch { prevCfg = null; }
          const latestRow = await pgPool.query(
            "SELECT max(version) AS v FROM scenario_versions WHERE name = $1", [wanted]);
          const latest = latestVersionOf(latestRow.rows[0]?.v);
          if (latest == null) {
            const saved = await pgSaveVersionDelta(wanted, prevCfg, cfg, explicitType);
            version = saved.version;
            project_id = saved.projectId;
          } else {
            const saved = await pgSaveVersionInPlace(wanted, latest, prevCfg, cfg, explicitType);
            version = saved.version;
            project_id = saved.projectId;
          }
          try { await pgUpsertProjectSong(wanted, cfg, project_id, folder); }
          catch (e) { console.warn("[pg] song upsert failed:", e.message); }
          try { await pgLinkDirectorBoards(wanted, project_id); }
          catch (e) { console.warn("[pg] director board link failed:", e.message); }
          try { await pgLinkDocBoards(wanted, project_id); }
          catch (e) { console.warn("[pg] documentary board link failed:", e.message); }
        } catch (e) { console.warn("[pg] version save failed:", e.message); }
      }
      return json(res, 200, {
        ok: true, name: wanted, version, project_id,
        scenes: Array.isArray(cfg.sequence) ? cfg.sequence.length : 0,
        duration: cfg.duration ?? null,
        warnings: converted.warnings ?? [],
        overwritten: prevRaw !== null,
      });
    }
    if (p === "/api/favorites" && req.method === "POST") {
      const { name, on } = await readJson(req);
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      let favs = readFavs();
      favs = on ? (favs.includes(name) ? favs : [...favs, name]) : favs.filter((n) => n !== name);
      fs.writeFileSync(FAVS, JSON.stringify({ names: favs }, null, 2));
      return json(res, 200, { ok: true, names: favs });
    }
    if (p === "/api/theme" && (req.method === "PUT" || req.method === "POST")) {
      let body;
      try { body = await readJson(req); }
      catch { return json(res, 400, { error: "bad json" }); }
      const mode = body.mode === "light" ? "light" : "dark";
      // Per-mode button colors (each picker); legacy single `color` still
      // accepted as a fallback that applies to both modes.
      const legacy = cleanColor(body.color);
      const darkColor = cleanColor(body.darkColor) || legacy;
      const lightColor = cleanColor(body.lightColor) || legacy;
      const darkBg = cleanColor(body.darkBg);
      const lightBg = cleanColor(body.lightBg);
      const t = { mode, color: mode === "dark" ? darkColor : lightColor, darkColor, lightColor, darkBg, lightBg };
      writeThemeFile(t);
      return json(res, 200, t);
    }
    if (p.startsWith("/api/scenario/") && req.method === "GET" && p.split("/")[4] === "versions") {
      const parts = p.split("/");
      const name = pathName(parts[3]);
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      // Version history exists only in the Postgres catalog. When it is
      // unavailable (or SQLite mode is active), keep the current disk-backed
      // project usable and report an empty history for list requests.
      if (!pgUp) return parts.length >= 6 && parts[5]
        ? json(res, 503, { error: "version history unavailable" })
        : json(res, 200, []);
      if (parts.length >= 6 && parts[5]) {
        const v = Number(parts[5]);
        if (!Number.isInteger(v)) return json(res, 400, { error: "bad version" });
        const r = await pgPool.query("SELECT config, created_at FROM scenario_versions WHERE name = $1 AND version = $2", [name, v]);
        if (!r.rows.length) return json(res, 404, { error: "no such version" });
        return json(res, 200, { name, version: v, config: r.rows[0].config, created_at: r.rows[0].created_at });
      }
      const r = await pgPool.query("SELECT version, config, created_at FROM scenario_versions WHERE name = $1 ORDER BY version DESC", [name]);
      // Attach a per-version change summary so the UI can show "v2: beat 3
      // changed" instead of implying all scenes were regenerated. v1 lists
      // every scene (full snapshot); v2+ lists only the diff vs the previous
      // version. Purely additive — old clients ignore the extra field.
      const asc = [...r.rows].reverse();
      const withChanges = asc.map((row, i) => {
        let changes = null;
        try {
          if (i === 0) {
            const n = Array.isArray(row.config?.sequence) ? row.config.sequence.length : 0;
            changes = {
              refChanged: true,
              beats: Array.from({ length: n }, (_, k) => k + 1),
            };
          } else {
            const plan = planDelta(asc[i - 1].config, row.config);
            changes = {
              refChanged: plan.ref,
              beats: Object.keys(plan.beats).map(Number).sort((a, b) => a - b),
            };
          }
        } catch { changes = null; }
        return { version: row.version, created_at: row.created_at, changes };
      });
      return json(res, 200, withChanges.reverse());
    }
    // length === 4 guard: sub-paths like /versions/1 must never fall through
    // to a whole-scenario route (an old client hitting a new path wiped a
    // scenario that way once).
    if (p.startsWith("/api/scenario/") && req.method === "GET" && p.split("/").length === 4) {
      const name = pathName(p.split("/")[3]);
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      let raw;
      try { raw = await dbGetScenario(name); }
      catch (e) { return json(res, 503, { error: "database unavailable" }); }
      if (raw === null) return json(res, 404, { error: "no such scenario" });
      // Project kind for callers that preserve it across saves (duplicate).
      let project_type = null;
      if (pgUp) {
        try {
          const pr = await pgPool.query("SELECT project_type FROM projects WHERE name = $1", [name]);
          project_type = pr.rows[0]?.project_type ?? null;
        } catch { /* type stays null — caller falls back to VIDEO */ }
      }
      return json(res, 200, { name, config: JSON.parse(raw), ...(project_type ? { project_type } : {}) });
    }
    if (p.startsWith("/api/scenario/") && req.method === "PUT" && p.split("/").length === 4) {
      let name = pathName(p.split("/")[3]);
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      // INTERNAL KEY: a NEW project whose URL name is a display name (spaces/
      // caps) is stored under its space-free key ("Pyari billi" ->
      // "pyari_billi") so /api/scenario/<key>/... URLs never need %20. A
      // legacy row saved under the raw spelling keeps working untouched
      // (renaming it migrates it).
      if (/\s/.test(name)) {
        const legacy = await dbGetScenario(name).catch(() => null);
        if (legacy == null) name = spaceFreeName(name);
      }
      const cfg = await readJson(req);
      // project_type is a projects-TABLE column (VIDEO/AUDIO), not scenario
      // content: extract it as the save signal, then strip it so it never
      // lands in scenarios / versions / prompts JSON (or the no-change hash).
      // Explicit AUDIO (Create Song saves) wins; absent = new rows default to
      // VIDEO, existing rows keep their value.
      const explicitType = explicitProjectType(cfg);
      if (cfg && typeof cfg === "object") delete cfg.project_type;
      // folder_name is minted ONCE (unique) and frozen: creation stamps it
      // from the project name, edits/renames never change it — output dirs,
      // filenames and DB paths stay stable so media keeps resolving.
      const storedFolder = pgUp ? await getFolderNameFromRow(name) : null;
      let folder = storedFolder;
      if (!folder && pgUp) {
        folder = await ensureUniqueFolder(name, name);
        try {
          await pgPool.query(
            "UPDATE projects SET folder_name = $2 WHERE name = $1 AND (folder_name IS NULL OR folder_name = '')",
            [name, folder]);
        } catch { /* row may not exist yet — claimed on version save */ }
      }
      if (typeof cfg === "object" && cfg) {
        // A fresh claim always wins — never inherit another project's folder
        // from a duplicated/copied config. A stored folder is never
        // overwritten, only backfilled when the config lacks it.
        if (!storedFolder || !cfg.folder_name) cfg.folder_name = folder || folderName(name);
      }
      // Retired fields — never persist even if an old client/draft sends them.
      if (cfg && typeof cfg === "object") { delete cfg.topic; delete cfg.requirements; }
      // No-change save = no-op: an identical config must not stack a duplicate version.
      let prevRaw;
      try { prevRaw = await dbGetScenario(name); }
      catch (e) { return json(res, 503, { error: "database unavailable" }); }
      let same = false;
      try { same = prevRaw !== null && canonical(prevRaw) === canonical(cfg); }
      catch { same = false; }
      if (same) {
        let version = null;
        let project_id = null;
        if (pgUp) {
          try {
            const r = await pgPool.query("SELECT max(version) AS v FROM scenario_versions WHERE name = $1", [name]);
            version = r.rows[0]?.v ?? null;
            // No-change save still guarantees the project row exists (and
            // applies an explicit type change, e.g. a type-only AUDIO save).
            project_id = await pgEnsureProject(name, cfg, explicitType);
            // Keep the song form row in sync even on a no-change save.
            try { await pgUpsertProjectSong(name, cfg, project_id, folder); }
            catch (e) { console.warn("[pg] song upsert failed:", e.message); }
            // An approved storyboard waiting on this project links now.
            try { await pgLinkDirectorBoards(name, project_id); }
            catch (e) { console.warn("[pg] director board link failed:", e.message); }
            // An approved documentary waiting on this project links now.
            try { await pgLinkDocBoards(name, project_id); }
            catch (e) { console.warn("[pg] documentary board link failed:", e.message); }
          } catch (e) { console.warn("[pg] version lookup failed:", e.message); }
        }
        return json(res, 200, { ok: true, version, project_id, unchanged: true });
      }
      if (USE_SQLITE) {
        await dbSaveScenario(name, cfg);
        // Keep the JSON export for the CLI runners.
        fs.writeFileSync(promptsSlugFile(name), JSON.stringify(cfg, null, 2));
        pgSaveScenarioMirror(name, cfg).catch((e) => console.warn("[pg] scenario mirror failed:", e.message));
      } else {
        // Postgres is the canonical store: persist first, fail loudly when down.
        if (!pgUp) return json(res, 503, { error: "database unavailable" });
        await dbSaveScenario(name, cfg);
        // Keep the JSON export for the CLI runners.
        fs.writeFileSync(promptsSlugFile(name), JSON.stringify(cfg, null, 2));
      }
      // Explicit save updates the CURRENT project in place — never a new
      // project row and never a new version row. The scenarios row, the
      // prompts JSON, the projects row and the LATEST scenario_versions
      // config are overwritten; only changed scenes' project_assets rows at
      // that same version are refreshed (see pgSaveVersionInPlace).
      // First save of a project still mints v1 (full snapshot via
      // pgSaveVersionDelta) so per-scene pills and the gallery have a base.
      let version = null;
      let project_id = null;
      if (pgUp) {
        try {
          let prevCfg = null;
          try { prevCfg = prevRaw != null ? JSON.parse(prevRaw) : null; }
          catch { prevCfg = null; }
          const latestRow = await pgPool.query(
            "SELECT max(version) AS v FROM scenario_versions WHERE name = $1", [name]);
          // max() is NULL with zero version rows (all versions deleted, or a
          // project row created without versions) — latestVersionOf maps that
          // to null so the first save mints v1 via the delta path. A bare
          // Number(null) is 0 and used to route into pgSaveVersionInPlace at
          // v0, violating project_assets_version_check (version > 0).
          const latest = latestVersionOf(latestRow.rows[0]?.v);
          if (latest == null) {
            const saved = await pgSaveVersionDelta(name, prevCfg, cfg, explicitType);
            version = saved.version;
            project_id = saved.projectId;
          } else {
            const saved = await pgSaveVersionInPlace(name, latest, prevCfg, cfg, explicitType);
            version = saved.version;
            project_id = saved.projectId;
          }
          // Persist the Create Song form fields for AUDIO projects.
          try { await pgUpsertProjectSong(name, cfg, project_id, folder); }
          catch (e) { console.warn("[pg] song upsert failed:", e.message); }
          // An approved storyboard waiting on this project links now.
          try { await pgLinkDirectorBoards(name, project_id); }
          catch (e) { console.warn("[pg] director board link failed:", e.message); }
          // An approved documentary waiting on this project links now.
          try { await pgLinkDocBoards(name, project_id); }
          catch (e) { console.warn("[pg] documentary board link failed:", e.message); }
        }
        catch (e) { console.warn("[pg] version save failed:", e.message); }
      }
      return json(res, 200, { ok: true, version, project_id, updated: true, name });
    }
    // Rename a project (POST /api/scenario/:name/rename { newName }).
    // DISPLAY NAME ONLY: scenarios, scenario_versions, projects.name,
    // prompts JSON and favorites move. Storage (outputs dirs, filenames,
    // assets/project_assets paths, folder_name) is IMMUTABLE by design —
    // nothing moves on disk, so images, thumbnails and videos keep
    // resolving on Home and the Project page after a rename. Blocked while
    // a run for the project is active (run records key off the name).
    if (p.startsWith("/api/scenario/") && req.method === "POST" && p.split("/").length === 5 && p.split("/")[4] === "rename") {
      const oldName = pathName(p.split("/")[3]);
      let body;
      try { body = await readJson(req); }
      catch { return json(res, 400, { error: "bad json" }); }
      // SPACE-FREE: the new name is stored without whitespace (underscore),
      // so the renamed project's URLs never carry %20. Renaming a legacy
      // space-named project to its own name migrates it to the clean spelling.
      const newName = spaceFreeName(String(body.newName || "").trim());
      if (!isSafe(oldName) || !isSafe(newName)) return json(res, 400, { error: "bad name" });
      if (oldName === newName) return json(res, 200, { ok: true, name: newName });
      let oldRaw;
      try { oldRaw = await dbGetScenario(oldName); }
      catch (e) { return json(res, 503, { error: "database unavailable" }); }
      if (oldRaw === null) return json(res, 404, { error: "no such scenario" });
      let newRaw;
      try { newRaw = await dbGetScenario(newName); }
      catch (e) { return json(res, 503, { error: "database unavailable" }); }
      if (newRaw !== null) return json(res, 409, { error: "a project with that name already exists" });
      if ([...runs.values()].some((r) => r.status === "running" && r.scenario === oldName))
        return json(res, 409, { error: "stop the active run before renaming" });
      try {
        await dbRenameScenario(oldName, newName);
        renameScenarioFiles(oldName, newName);
        // Keep the display name in sync with what the user typed (the KEY is
        // the slug; display_name carries the raw text for UI labels).
        try {
          const moved = await dbGetScenario(newName);
          if (moved != null) {
            const movedCfg = JSON.parse(moved);
            if (typeof movedCfg === "object" && movedCfg) {
              movedCfg.display_name = String(body.newName || "").trim() || movedCfg.display_name;
              await dbSaveScenario(newName, movedCfg);
            }
          }
        } catch { /* display sync is best-effort */ }
        try { await renameDirectorBoardsForProject(oldName, newName); }
        catch (e) { console.warn("[pg] director boards rename failed:", e.message); }
        const favs = readFavs();
        if (favs.includes(oldName))
          fs.writeFileSync(FAVS, JSON.stringify({ names: favs.map((n) => (n === oldName ? newName : n)) }, null, 2));
        if (USE_SQLITE) pgRenameScenarioMirror(oldName, newName).catch((e) => console.warn("[pg] rename mirror failed:", e.message));
      } catch (e) { return json(res, 500, { error: String(e.message || e) }); }
      return json(res, 200, { ok: true, name: newName });
    }
    // Delete ONE saved version (prompt config), not the scenario. Deleting the
    // latest rolls the current config back to the new latest so "Latest" never
    // points at a deleted version. Generated outputs are untouched.
    // NOTE: must sit before the whole-scenario DELETE (same prefix).
    if (p.startsWith("/api/scenario/") && req.method === "DELETE" && p.split("/")[4] === "versions") {
      const parts = p.split("/");
      const name = pathName(parts[3]);
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      const v = Number(parts[5]);
      if (!Number.isInteger(v)) return json(res, 400, { error: "bad version" });
      if (!pgUp) return json(res, 503, { error: "database unavailable" });
      const cur = await pgPool.query("SELECT max(version) AS max FROM scenario_versions WHERE name = $1", [name]);
      const max = cur.rows[0]?.max ?? null;
      const del = await pgPool.query("DELETE FROM scenario_versions WHERE name = $1 AND version = $2 RETURNING version", [name, v]);
      if (!del.rowCount) return json(res, 404, { error: "no such version" });
      const pid = await pgProjectId(name);
      if (pid != null) await pgPool.query("DELETE FROM project_assets WHERE project_id = $1 AND version = $2", [pid, v]);
      // No project row (pre-save craft deleted?) — nothing to delete.
      let latest = max === v ? null : max;
      if (max === v) {
        const nxt = await pgPool.query("SELECT version, config FROM scenario_versions WHERE name = $1 ORDER BY version DESC LIMIT 1", [name]);
        if (nxt.rows.length) {
          const cfg = nxt.rows[0].config;
          latest = nxt.rows[0].version;
          await dbSaveScenario(name, cfg);
          fs.writeFileSync(promptsSlugFile(name), JSON.stringify(cfg, null, 2));
          if (USE_SQLITE) pgSaveScenarioMirror(name, cfg).catch((e) => console.warn("[pg] scenario mirror failed:", e.message));
        }
      }
      return json(res, 200, { ok: true, deleted: v, latest });
    }
    if (p.startsWith("/api/scenario/") && req.method === "DELETE" && p.split("/").length === 4) {
      const name = pathName(p.split("/")[3]);
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      if ([...runs.values()].some((r) => r.status === "running" && r.scenario === name))
        return json(res, 409, { error: "stop the active run before deleting" });
      let raw;
      try { raw = await dbGetScenario(name); }
      catch (e) { return json(res, 503, { error: "database unavailable" }); }
      if (raw === null) return json(res, 404, { error: "no such scenario" });
      await dbDeleteScenario(name);
      // Remove the slug-named export AND any legacy raw display-name file.
      for (const f of [promptsSlugFile(name), promptsLegacyFile(name)]) {
        try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* best-effort */ }
      }
      // Linked storyboards go with the project (DB rows cascade via the FK;
      // files are removed here so the file backfill can't resurrect them).
      try {
        const n = await deleteDirectorBoardsForProject(name);
        if (n) console.log(`[pg] deleted ${n} director board(s) with project ${name}`);
      } catch (e) { console.warn("[pg] director boards cleanup failed:", e.message); }
      // Storage is folder-based (immutable) — remove folder dirs plus any
      // legacy display-name dirs left from before folder-immutability.
      const delFolder = (pgUp ? await getFolderNameFromRow(name) : null) || folderName(name);
      const delDirs = new Set([...allDirsFor(delFolder), ...allDirsFor(name)]);
      for (const dir of delDirs) {
        const full = path.join(OUTPUTS, dir);
        if (fs.existsSync(full)) fs.rmSync(full, { recursive: true, force: true });
      }
      try {
        await pgDeleteScenarioMirror(name);
      } catch (e) { console.warn("[pg] scenario unmirror failed:", e.message); }
      return json(res, 200, { ok: true });
    }
    if (p === "/api/runs" && req.method === "POST") {
      const body = await readJson(req);
      if (typeof body.scenario !== "string" || !isSafe(body.scenario))
        return json(res, 400, { error: "bad scenario" });
      try {
        // Resolve (and heal) immutable storage before spawning: the script
        // writes to outputs/<folder>/ while reading prompts/<scenario>.json.
        const folder = await migrateProjectStorage(body.scenario);
        const run = startRun(body.scenario, {
          stitch: !!body.stitch,
          engine: body.engine || "ltx",
          format: body.format ?? (body.vertical ? "vertical" : undefined),
          regen: body.regen || null,
          count: body.count,
          mode: body.mode === "dialogue" || body.mode === "song" ? body.mode : undefined,
          beats: typeof body.beats === "string" ? body.beats : undefined,
            skipTts: !!body.skipTts,
            skipLipsync: !!body.skipLipsync,
            noStitch: !!body.noStitch,
            noDialogue: !!body.noDialogue,
            chain: !!body.chain,
            lipsync: body.lipsync === "musetalk-comfy" || body.lipsync === "musetalk" ? "musetalk-comfy"
              : body.lipsync === "wav2lip" ? "wav2lip" : undefined,
          songModel: body.songModel === "ace-step" || body.songModel === "minimax" ? body.songModel : undefined,
          imageMode: typeof body.imageMode === "string" ? body.imageMode : undefined,
          storageFolder: folder,
          configName: body.scenario,
        });
        return json(res, 200, { id: run.id, folder });
      } catch (e) {
        return json(res, 409, { error: String(e.message || e) });
      }
    }
    if (p === "/api/runs" && req.method === "GET")
      return json(res, 200, [...runs.values()].map(({ proc, subs, ...r }) => r).reverse());
    if (p.startsWith("/api/runs/") && req.method === "GET") {
      const run = runs.get(p.split("/")[3]);
      if (!run) return json(res, 404, { error: "no run" });
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(`data: ${JSON.stringify({ line: run.log })}\n\n`);
      // Backlog replay for clients (re)attaching mid-run: flagged replay so
      // the client restores counts/gallery without stamping them "now" —
      // their real completion times are unknown, and fake timestamps corrupt
      // the Time Remaining ETA + the persisted pace after every refresh.
      for (const a of run.assets) res.write(`event: asset\ndata: ${JSON.stringify({ ...a, replay: true })}\n\n`);
      run.subs.add(res);
      req.on("close", () => run.subs.delete(res));
      return;
    }
    if (p.startsWith("/api/runs/") && req.method === "DELETE") {
      const run = runs.get(p.split("/")[3]);
      if (run && run.status === "running") {
        run.cancelled = true; // stop a batch loop after the current pass
        run.proc?.kill("SIGTERM");
      }
      return json(res, 200, { ok: true });
    }
    if (p === "/api/outputs" && req.method === "GET") {
      const name = u.searchParams.get("scenario");
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      // Dirs are folder-based storage; legacy display-name dirs translate,
      // and viewing heals legacy storage so old media reappears.
      const dir = await storageDirFor(name);
      if (dir !== name) {
        try {
          const { base } = splitDirSuffix(name);
          await migrateProjectStorage((pgUp ? await displayNameForFolder(base) : null) || base);
        } catch { /* read anyway */ }
      }
      return json(res, 200, await outputsPayload(dir));
    }
    if (p === "/api/outputs/select" && req.method === "POST") {
      const body = await readJson(req);
      const { scenario, kind, index, file } = body;
      if (!isSafe(scenario) || (typeof file !== "string" && file != null)) return json(res, 400, { error: "bad body" });
      const storDir = await storageDirFor(scenario);
      const dir = path.join(OUTPUTS, storDir);
      if (!fs.existsSync(dir)) return json(res, 404, { error: "no outputs" });
      // Empty file on a ref clears the main (toggle off): keyframes generate
      // from text only until the next explicit pick. Other kinds always need
      // a file (their auto-latest fallback has no "none" state).
      const clearing = kind === "ref" && (file == null || file === "");
      if (clearing) {
        clearRefMain(dir);
      } else {
        if (typeof file !== "string" || !file) return json(res, 400, { error: "bad body" });
        // A manual pick is explicit-only and pins the main: only a picked
        // reference is ever served as input (fresh generations never take
        // main by themselves).
        setMain(dir, prefixFor(storDir), kind, kind === "ref" ? 0 : index, null, file, { pinned: true });
      }
      // Reference picks also flip the project_references main (+pin), which
      // is what the Reference section displays. A clear flips every row off.
      if (kind === "ref" && pgUp) {
        try {
          const { base } = splitDirSuffix(scenario);
          const owner = (await displayNameForFolder(base)) || cfgNameFor(scenario);
          const pid = await pgProjectId(owner);
          if (pid != null) await pgSetReferenceMain({ projectId: pid, dir: storDir, file: clearing ? null : file, engine: engineForDir(storDir) });
        } catch (e) { console.warn("[pg] reference main flip failed:", e.message); }
      }
      return json(res, 200, await outputsPayload(storDir));
    }
    if (p === "/api/upload/ref" && req.method === "POST") {
      // Upload an image as the scenario's reference (browse / drag-drop / clipboard).
      // Stored as the next ref version in outputs/<folder>/ and selected as main,
      // so the pipeline skips Flux ref generation and uses the uploaded image.
      const body = await readJson(req);
      const scenario = String(body.scenario || "");
      if (!isSafe(scenario)) return json(res, 400, { error: "bad scenario" });
      if (typeof body.data !== "string") return json(res, 400, { error: "data (base64) required" });
      const m = body.data.match(/^data:image\/\w+;base64,(.+)$/s);
      if (!m) return json(res, 400, { error: "expected a data:image base64 payload" });
      const buf = Buffer.from(m[1], "base64");
      if (!buf.length) return json(res, 400, { error: "empty image" });
      const storDir = await storageDirFor(scenario);
      const outDir = path.join(OUTPUTS, storDir);
      fs.mkdirSync(outDir, { recursive: true });
      const prefix = prefixFor(storDir);
      const v = nextVersion(outDir, prefix, "ref", 0, ".png");
      const file = v === 1 ? `${prefix}_ref.png` : `${prefix}_ref_v${v}.png`;
      fs.writeFileSync(path.join(outDir, file), buf);
      // An upload is a deliberate choice — pin it as main.
      setMain(outDir, prefix, "ref", 0, null, file, { pinned: true });
      const { base: refBase } = splitDirSuffix(scenario);
      const refOwner = (pgUp ? await displayNameForFolder(refBase) : null) || cfgNameFor(scenario);
      pgRefreshProjectFiles(refOwner, storDir)
        .catch((e) => console.warn("[pg] catalog failed:", e.message));
      // Uploaded references are recorded (pinned main) in project_references.
      if (pgUp) {
        pgProjectId(refOwner).then(async (pid) => {
          if (pid == null) return;
          let prompt = null;
          try {
            const raw = await dbGetScenario(refOwner);
            prompt = raw ? JSON.parse(raw).referencePrompt ?? null : null;
          } catch { prompt = null; }
          await pgAddReference({
            projectId: pid, dir: storDir, file, prompt,
            engine: engineForDir(storDir), source: "upload",
          });
        }).catch((e) => console.warn("[pg] reference record failed:", e.message));
      }
      return json(res, 200, await outputsPayload(storDir));
    }
    // Resource library (the Resource page): upload images/videos, AI-caption
    // them with the local vision model, and wire them into the Project
    // workflow (new project or an existing project's reference).
    if (p === "/api/resources" && req.method === "GET") {
      return json(res, 200, resReadMeta().slice().reverse());
    }
    if (p === "/api/resources" && req.method === "POST") {
      const body = await readJson(req);
      if (typeof body.data !== "string") return json(res, 400, { error: "data (base64) required" });
      const m = body.data.match(/^data:((?:image|video)\/[\w.+-]+);base64,(.+)$/s);
      if (!m) return json(res, 400, { error: "expected a data:image/* or data:video/* base64 payload" });
      const ext = resMimeExt(m[1]);
      if (!ext) return json(res, 400, { error: `unsupported media type ${m[1]}` });
      const buf = Buffer.from(m[2], "base64");
      if (!buf.length) return json(res, 400, { error: "empty file" });
      const id = newResId();
      const file = id + ext;
      const kind = m[1].startsWith("video/") ? "video" : "image";
      fs.mkdirSync(RESOURCES, { recursive: true });
      fs.writeFileSync(path.join(RESOURCES, file), buf);
      const entry = {
        id, file, kind, thumb: null, prompt: null,
        captionError: null, novision: false, created_at: new Date().toISOString(),
      };
      if (kind === "video") {
        entry.thumb = `${id}_thumb.jpg`;
        try {
          await extractMiddleFrame(path.join(RESOURCES, file), path.join(RESOURCES, entry.thumb));
        } catch (e) {
          entry.thumb = null;
          entry.captionError = `thumbnail failed: ${e.message}`;
        }
      }
      if (!entry.captionError) {
        // Auto-caption on upload (best effort — the file is kept either way).
        try {
          Object.assign(entry, await captionResource(entry));
        } catch (e) {
          entry.prompt = null;
          entry.captionError = e.detail || String(e.message || e);
          entry.novision = e.message === "vision-unavailable";
        }
      }
      const rows = resReadMeta();
      rows.push(entry);
      resWriteMeta(rows);
      return json(res, 200, entry);
    }
    if (p.startsWith("/api/resources/") && req.method === "POST" && p.endsWith("/caption")) {
      const id = pathName(p.split("/")[3]);
      const rows = resReadMeta();
      const entry = rows.find((r) => r.id === id);
      if (!entry) return json(res, 404, { error: "no such resource" });
      try {
        const next = await captionResource(entry);
        resWriteMeta(rows.map((r) => (r.id === id ? { ...next, novision: false } : r)));
        return json(res, 200, { ...next, novision: false });
      } catch (e) {
        if (e.message === "vision-unavailable") return json(res, 409, { error: e.detail, vision: false });
        return json(res, 502, { error: String(e.message || e) });
      }
    }
    if (p.startsWith("/api/resources/") && req.method === "PUT" && p.split("/").length === 4) {
      const id = pathName(p.split("/")[3]);
      const body = await readJson(req);
      if (typeof body.prompt !== "string") return json(res, 400, { error: "prompt required" });
      const rows = resReadMeta();
      if (!rows.some((r) => r.id === id)) return json(res, 404, { error: "no such resource" });
      const next = rows.map((r) => (r.id === id
        ? { ...r, prompt: body.prompt.trim() || null, captionError: null }
        : r));
      resWriteMeta(next);
      return json(res, 200, next.find((r) => r.id === id));
    }
    if (p.startsWith("/api/resources/") && req.method === "DELETE" && p.split("/").length === 4) {
      const id = pathName(p.split("/")[3]);
      const rows = resReadMeta();
      const entry = rows.find((r) => r.id === id);
      if (!entry) return json(res, 404, { error: "no such resource" });
      for (const f of [entry.file, entry.thumb]) {
        if (!f) continue;
        try { fs.unlinkSync(path.join(RESOURCES, f)); } catch { /* already gone */ }
      }
      resWriteMeta(rows.filter((r) => r.id !== id));
      return json(res, 200, { ok: true, deleted: id });
    }
    if (p.startsWith("/api/resources/") && req.method === "POST" && p.endsWith("/use")) {
      const id = pathName(p.split("/")[3]);
      const entry = resReadMeta().find((r) => r.id === id);
      if (!entry) return json(res, 404, { error: "no such resource" });
      const body = await readJson(req);
      // Source pixels: the image itself, or the video's middle frame.
      const srcFile = entry.kind === "image" ? entry.file : entry.thumb;
      if (!srcFile || !fs.existsSync(path.join(RESOURCES, srcFile)))
        return json(res, 400, { error: "source image missing — re-upload the resource" });
      const srcBuf = fs.readFileSync(path.join(RESOURCES, srcFile));
      const refPrompt = entry.prompt ?? "";
      if (body.mode === "ref") {
        // Pinned reference of an EXISTING project (same mechanics as
        // POST /api/upload/ref, sourced from the library).
        const project = String(body.project || "");
        if (!isSafe(project)) return json(res, 400, { error: "project required" });
        let raw;
        try { raw = await dbGetScenario(project); }
        catch { return json(res, 503, { error: "database unavailable" }); }
        if (raw === null) return json(res, 404, { error: "no such project" });
        const storDir = await storageDirFor(project);
        const outDir = path.join(OUTPUTS, storDir);
        fs.mkdirSync(outDir, { recursive: true });
        const prefix = prefixFor(storDir);
        const v = nextVersion(outDir, prefix, "ref", 0, ".png");
        const file = v === 1 ? `${prefix}_ref.png` : `${prefix}_ref_v${v}.png`;
        fs.writeFileSync(path.join(outDir, file), srcBuf);
        // An upload is a deliberate choice — pin it as main.
        setMain(outDir, prefix, "ref", 0, null, file, { pinned: true });
        const { base: refBase } = splitDirSuffix(project);
        const refOwner = (pgUp ? await displayNameForFolder(refBase) : null) || cfgNameFor(project);
        pgRefreshProjectFiles(refOwner, storDir)
          .catch((e) => console.warn("[pg] catalog failed:", e.message));
        if (pgUp) {
          pgProjectId(refOwner).then(async (pid) => {
            if (pid == null) return;
            await pgAddReference({
              projectId: pid, dir: storDir, file, prompt: refPrompt || null,
              engine: engineForDir(storDir), source: "upload",
            });
          }).catch((e) => console.warn("[pg] reference record failed:", e.message));
        }
        return json(res, 200, { ok: true, mode: "ref", project, file });
      }
      // New project FROM this resource: the caption becomes the Master
      // Prompt and the pixels become the pinned reference visual — then the
      // exact Project workflow takes over (AI Craft beats, Generate).
      // INTERNAL KEY: the resource title (which may contain spaces) becomes
      // the space-free scenario key; the typed title rides along as
      // display_name for UI labels.
      const rawName = String(body.name || body.project || "").trim();
      const newName = spaceFreeName(rawName);
      if (!isSafe(newName)) return json(res, 400, { error: "project name required" });
      let taken = false;
      try { taken = (await dbGetScenario(newName)) !== null; }
      catch { return json(res, 503, { error: "database unavailable" }); }
      if (taken) return json(res, 409, { error: "a project with that name already exists" });
      if (pgUp) {
        try {
          const r = await pgPool.query("SELECT 1 FROM projects WHERE name = $1", [newName]);
          if (r.rowCount > 0) return json(res, 409, { error: "a project with that name already exists" });
        } catch { /* row check best-effort — the scenario check above governs */ }
      }
      const cfg = { description: "", referencePrompt: refPrompt, duration: 3, sequence: [], ...(rawName ? { display_name: rawName } : {}) };
      if (pgUp) {
        try {
          await pgEnsureProject(newName, cfg);
          const claimed = await getFolderNameFromRow(newName);
          if (claimed) cfg.folder_name = claimed;
        } catch (e) { console.warn("[pg] resource project ensure failed:", e.message); }
      }
      if (!cfg.folder_name) cfg.folder_name = folderName(newName);
      await dbSaveScenario(newName, cfg);
      fs.writeFileSync(promptsSlugFile(newName), JSON.stringify(cfg, null, 2));
      let project_id = null;
      if (pgUp) {
        try {
          const saved = await pgSaveVersionDelta(newName, null, cfg);
          project_id = saved.projectId;
        } catch (e) { console.warn("[pg] resource project save failed:", e.message); }
      }
      const folder = cfg.folder_name;
      const outDir = path.join(OUTPUTS, folder);
      fs.mkdirSync(outDir, { recursive: true });
      const prefix = prefixFor(folder);
      const file = `${prefix}_ref.png`;
      fs.writeFileSync(path.join(outDir, file), srcBuf);
      setMain(outDir, prefix, "ref", 0, null, file, { pinned: true });
      if (pgUp) {
        try {
          const pid = project_id ?? await pgProjectId(newName);
          if (pid != null) {
            await pgAddReference({
              projectId: pid, dir: folder, file, prompt: refPrompt || null,
              engine: engineForDir(folder), source: "upload",
            });
          }
        } catch (e) { console.warn("[pg] resource reference record failed:", e.message); }
      }
      return json(res, 200, { ok: true, mode: "new", name: newName });
    }
    if (p === "/api/resources/build-project" && req.method === "POST") {
      // Save the WHOLE Resource Library as one project: one beat per
      // resource (oldest upload first), each resource's AI prompt as its
      // scene image prompt, the first prompt as Master Prompt — through the
      // SAME project save path as every other project (scenarios row +
      // prompts JSON + projects row + one KEYFRAME/VIDEO project_assets row
      // per scene). Media is installed under the pipeline's own filename
      // pattern (<prefix>_seqN_<slug>.png / <prefix>_clipN_<slug>.mp4 /
      // <prefix>_ref.png) so Keyframes → clips, Story Board and Rendered
      // Clip resolve them by name with no frontend/path changes.
      let body;
      try { body = await readJson(req); }
      catch { return json(res, 400, { error: "bad json" }); }
      const name = String(body.name || "").trim();
      if (!isSafe(name)) return json(res, 400, { error: "project name required" });
      let taken = false;
      try { taken = (await dbGetScenario(name)) !== null; }
      catch { return json(res, 503, { error: "database unavailable" }); }
      if (taken) return json(res, 409, { error: "a project with that name already exists" });
      if (pgUp) {
        try {
          const r = await pgPool.query("SELECT 1 FROM projects WHERE name = $1", [name]);
          if (r.rowCount > 0) return json(res, 409, { error: "a project with that name already exists" });
        } catch { /* the scenario check above governs */ }
      }
      const entries = resReadMeta()
        .filter((r) => r && r.file && fs.existsSync(path.join(RESOURCES, r.file)))
        .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
      if (!entries.length)
        return json(res, 400, { error: "no resources yet — upload images/videos first" });
      if (!pgUp && !USE_SQLITE) return json(res, 503, { error: "database unavailable" });
      const beats = entries.map((e, i) => ({
        title: `Scene ${i + 1}`,
        image: String(e.prompt ?? "").trim(),
        motion: "",
      }));
      const cfg = {
        description: `Built from Resource Library (${entries.length} item${entries.length === 1 ? "" : "s"})`,
        referencePrompt: String(entries[0].prompt ?? "").trim(),
        duration: 3,
        presetId: "cinematic",
        sequence: beats,
      };
      // Claim the immutable storage folder FIRST (pgEnsureProject mints it
      // into the projects row; sqlite falls back to the slug) so media and
      // every DB path below agree on one folder.
      let folder;
      if (pgUp) {
        await pgEnsureProject(name, cfg);
        folder = await getFolderNameFromRow(name);
      } else {
        folder = folderName(name);
      }
      cfg.folder_name = folder;
      if (USE_SQLITE) {
        await dbSaveScenario(name, cfg);
        fs.writeFileSync(promptsSlugFile(name), JSON.stringify(cfg, null, 2));
        pgSaveScenarioMirror(name, cfg).catch((e) => console.warn("[pg] scenario mirror failed:", e.message));
      } else {
        await dbSaveScenario(name, cfg);
        fs.writeFileSync(promptsSlugFile(name), JSON.stringify(cfg, null, 2));
      }
      // Install every resource's pixels under the pipeline filename pattern.
      // Images convert to real PNG via ffmpeg (the keyframe scanner only
      // matches .png); videos install as the beat clip (.mp4, remuxed or
      // transcoded when the upload isn't mp4) with their middle frame as the
      // beat keyframe. Byte-copy fallbacks keep a viewable file even when
      // ffmpeg is unavailable.
      const outDir = path.join(OUTPUTS, folder);
      fs.mkdirSync(outDir, { recursive: true });
      const prefix = prefixFor(folder);
      const warnings = [];
      const toPng = async (srcFull, dstFull, what) => {
        if (srcFull.toLowerCase().endsWith(".png")) {
          fs.copyFileSync(srcFull, dstFull);
          return;
        }
        try {
          await runCmd("ffmpeg", ["-y", "-i", srcFull, dstFull], 60000);
        } catch (e) {
          fs.copyFileSync(srcFull, dstFull);
          warnings.push(`${what}: PNG convert failed (${e.message}) — kept original bytes.`);
        }
      };
      const toMp4 = async (srcFull, dstFull, what) => {
        if (srcFull.toLowerCase().endsWith(".mp4")) {
          fs.copyFileSync(srcFull, dstFull);
          return;
        }
        try {
          await runCmd("ffmpeg", ["-y", "-i", srcFull, "-c", "copy", dstFull], 120000);
        } catch {
          try {
            await runCmd("ffmpeg", ["-y", "-i", srcFull,
              "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", dstFull], 300000);
          } catch (e) {
            fs.copyFileSync(srcFull, dstFull);
            warnings.push(`${what}: MP4 convert failed (${e.message}) — kept original bytes.`);
          }
        }
      };
      const installedKf = {};
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const n = i + 1;
        const slug = fileSlug(beats[i].title);
        try {
          if (e.kind === "image") {
            const kf = `${prefix}_seq${n}_${slug}.png`;
            await toPng(path.join(RESOURCES, e.file), path.join(outDir, kf), `Scene ${n}`);
            setMain(outDir, prefix, "seq", n, beats[i].title, kf, { pinned: true });
            installedKf[n] = kf;
          } else {
            const cl = `${prefix}_clip${n}_${slug}.mp4`;
            await toMp4(path.join(RESOURCES, e.file), path.join(outDir, cl), `Scene ${n}`);
            setMain(outDir, prefix, "clip", n, beats[i].title, cl, { pinned: true });
            let thumb = e.thumb && fs.existsSync(path.join(RESOURCES, e.thumb)) ? e.thumb : null;
            if (!thumb) {
              try {
                const fresh = `${e.id}_thumb.jpg`;
                await extractMiddleFrame(path.join(RESOURCES, e.file), path.join(RESOURCES, fresh));
                if (fs.existsSync(path.join(RESOURCES, fresh))) {
                  thumb = fresh;
                  resWriteMeta(resReadMeta().map((r) => (r.id === e.id ? { ...r, thumb } : r)));
                }
              } catch { thumb = null; }
            }
            if (thumb) {
              const kf = `${prefix}_seq${n}_${slug}.png`;
              await toPng(path.join(RESOURCES, thumb), path.join(outDir, kf), `Scene ${n}`);
              setMain(outDir, prefix, "seq", n, beats[i].title, kf, { pinned: true });
              installedKf[n] = kf;
            } else {
              warnings.push(`Scene ${n}: no keyframe still (video thumbnail unavailable) — clip only.`);
            }
          }
        } catch (err) {
          warnings.push(`Scene ${n}: media install failed — ${err.message}`);
        }
      }
      // Pinned reference = Scene 1's keyframe pixels (same source the
      // per-card "Start project" flow installs, without re-converting).
      let refInstalled = null;
      if (installedKf[1]) {
        try {
          const refFile = `${prefix}_ref.png`;
          fs.copyFileSync(path.join(outDir, installedKf[1]), path.join(outDir, refFile));
          setMain(outDir, prefix, "ref", 0, null, refFile, { pinned: true });
          refInstalled = refFile;
        } catch (err) {
          warnings.push(`Reference install failed — ${err.message}`);
        }
      } else {
        warnings.push("Reference skipped — Scene 1 has no keyframe image.");
      }
      // Projects row already exists (pgEnsureProject above); the v1 full
      // snapshot adds one KEYFRAME + one VIDEO project_assets row per scene
      // (COMPLETED with file paths, since mains are on disk) and refreshes
      // the projects row. The reference gets its project_references row.
      let version = null;
      let project_id = null;
      if (pgUp) {
        try {
          const saved = await pgSaveVersionDelta(name, null, cfg);
          version = saved.version;
          project_id = saved.projectId;
        } catch (e) {
          warnings.push(`version snapshot failed: ${e.message}`);
          console.warn("[pg] build-project version save failed:", e.message);
        }
        if (project_id == null) {
          try { project_id = await pgProjectId(name); }
          catch { project_id = null; }
        }
        if (refInstalled && project_id != null) {
          try {
            await pgAddReference({
              projectId: project_id, dir: folder, file: refInstalled,
              prompt: cfg.referencePrompt || null,
              engine: engineForDir(folder), source: "upload",
            });
          } catch (e) {
            warnings.push(`reference record skipped: ${e.message}`);
            console.warn("[pg] build-project reference record failed:", e.message);
          }
        }
      }
      return json(res, 200, {
        ok: true, name, folder, scenes: entries.length,
        version, project_id, warnings,
      });
    }
    if (p === "/api/upload/keyframe" && req.method === "POST") {
      // Upload an image as beat N's keyframe. Stored as the next keyframe
      // version in outputs/<folder>/ and selected as main, so a later
      // clip (re)generation runs i2v from the uploaded image instead of the
      // Flux keyframe. Same versioning mechanics as every other asset.
      const body = await readJson(req);
      const scenario = String(body.scenario || "");
      const n = Number(body.index);
      if (!isSafe(scenario)) return json(res, 400, { error: "bad scenario" });
      if (!Number.isInteger(n) || n < 1) return json(res, 400, { error: "index (1-based beat) required" });
      if (typeof body.data !== "string") return json(res, 400, { error: "data (base64) required" });
      const m = body.data.match(/^data:image\/\w+;base64,(.+)$/s);
      if (!m) return json(res, 400, { error: "expected a data:image base64 payload" });
      const buf = Buffer.from(m[1], "base64");
      if (!buf.length) return json(res, 400, { error: "empty image" });
      const storDir = await storageDirFor(scenario);
      const outDir = path.join(OUTPUTS, storDir);
      if (!fs.existsSync(outDir)) return json(res, 404, { error: "no outputs" });
      // Beat title feeds the versioned filename — resolve it from the
      // prompts JSON first, stored scenario copy as fallback. The title is
      // slugified into the filename (space-free); the raw title stays in
      // state.json lookups + DB beat_title.
      const { base: kfBase } = splitDirSuffix(scenario);
      const kfOwner = (pgUp ? await displayNameForFolder(kfBase) : null) || cfgNameFor(scenario);
      let title = null;
      const cfgPath = promptsReadFile(kfOwner);
      try {
        if (fs.existsSync(cfgPath)) {
          const seq = JSON.parse(fs.readFileSync(cfgPath, "utf8")).sequence;
          title = Array.isArray(seq) ? seq[n - 1]?.title ?? null : null;
        }
      } catch { title = null; }
      if (title == null) {
        try {
          const raw = await dbGetScenario(kfOwner);
          const seq = raw ? JSON.parse(raw).sequence : null;
          title = Array.isArray(seq) ? seq[n - 1]?.title ?? null : null;
        } catch { title = null; }
      }
      if (title == null) return json(res, 400, { error: `no beat ${n}` });
      const prefix = prefixFor(storDir);
      const slugTitle = fileSlug(title);
      const v = nextVersion(outDir, prefix, "seq", n, ".png", title);
      const file = v === 1 ? `${prefix}_seq${n}_${slugTitle}.png` : `${prefix}_seq${n}_${slugTitle}_v${v}.png`;
      fs.writeFileSync(path.join(outDir, file), buf);
      // An upload is a deliberate choice — pin it as main.
      setMain(outDir, prefix, "seq", n, title, file, { pinned: true });
      pgMarkAssetComplete(kfOwner,
        { file, stage: "keyframe", index: n },
        { engine: engineForFolder(storDir), outputFolder: storDir })
        .then(() => pgRefreshProjectFiles(kfOwner, storDir))
        .catch((e) => console.warn("[pg] catalog failed:", e.message));
      return json(res, 200, await outputsPayload(storDir));
    }
    // ------------------------------------------------- AI Story Director
    // Story-to-Video workflow on top of the existing pipeline: the director
    // authors a storyboard (analysis -> asset bible -> source-grounded scenes) via the
    // local LLM; APPROVE hands a standard scenario config to the EXISTING
    // save/generation pipeline (client calls saveScenario, then opens the
    // workspace). No separate image/video implementation exists here.
    // Shared LLM call reusing the craft-endpoint convention (LLM_MODEL,
    // thinking disabled) — llmChatJson is defined at MODULE level above so
    // the Sanskriti Kids studio helpers use the SAME client.
    const directorBoardFile = (id) => path.join(DIRECTOR, `${id}.json`);
    const readDirectorBoard = (id) => {
      if (!isSafe(id)) throw new Error("bad board id");
      const f = directorBoardFile(id);
      if (!fs.existsSync(f)) throw new Error("board not found");
      return JSON.parse(fs.readFileSync(f, "utf8"));
    };
    const writeDirectorBoard = (board) => {
      fs.mkdirSync(DIRECTOR, { recursive: true });
      board.updatedAt = new Date().toISOString();
      fs.writeFileSync(directorBoardFile(board.id), JSON.stringify(board, null, 2));
      // Mirror into Postgres — Saved Storyboards are DB-backed for the UI
      // (fire-and-forget; the file write above already succeeded).
      pgUpsertDirectorBoard(board).catch((e) => console.warn("[pg] director board mirror failed:", e.message));
      return board;
    };
    // The audio length a lyric timeline is measured against: the uploaded song
    // wins (that IS the audio), then the Story/Song workspace's own WAV upload
    // (`whisperxAudio` — its duration is measured at upload time), then the
    // planned story duration, else unknown.
    const lyricTimelineDuration = (board) => {
      const song = board && board.input && board.input.song;
      const wx = board && board.input && board.input.whisperxAudio;
      const d = Number(song && song.durationSeconds) || Number(wx && wx.durationSeconds)
        || Number(board && board.input && board.input.targetSeconds) || 0;
      return d > 0 ? d : 0;
    };
    // The lyric lines the CURRENT board would align against: the bible's own
    // lyric lines when analyzed, else the pasted story. The import, the stale
    // check and the scene planner all read this ONE list so they can never
    // disagree about which lines the timeline is supposed to cover.
    const lyricTimelineSourceLines = (board) => {
      const lines = boardLyricLines(board);
      return lines.length ? lines : parseLyricLines((board.input && board.input.story) || "");
    };
    const wavAnalysisSlug = (board) => configSlug(
      board.wav_analysis_project_slug || board.scenarioName || board.input?.title || board.id || "project",
    ) || "project";
    const srtTime = (seconds) => {
      const ms = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
      const hh = String(Math.floor(ms / 3600000)).padStart(2, "0");
      const mm = String(Math.floor(ms / 60000) % 60).padStart(2, "0");
      const ss = String(Math.floor(ms / 1000) % 60).padStart(2, "0");
      return `${hh}:${mm}:${ss},${String(ms % 1000).padStart(3, "0")}`;
    };
    const vttTime = (seconds) => srtTime(seconds).replace(",", ".");
    const timelineSrt = (rows, textOf) => arr(rows).filter((r) => Number.isFinite(Number(r.start_seconds)) && Number.isFinite(Number(r.end_seconds)) && Number(r.end_seconds) > Number(r.start_seconds))
      .map((r, i) => `${i + 1}\n${srtTime(r.start_seconds)} --> ${srtTime(r.end_seconds)}\n${textOf(r) || ""}`).join("\n\n") + "\n";
    const persistWavAnalysis = (board, rawWhisper = null) => {
      const timeline = board.lyric_timeline;
      if (!timeline?.whisper?.segments?.length) return null;
      const slug = wavAnalysisSlug(board);
      board.wav_analysis_project_slug ||= slug;
      timeline.analysis_id ||= `analysis_${String(timeline.imported_at || Date.now()).replace(/[^a-zA-Z0-9]/g, "")}`;
      const root = path.join(WAV_ANALYSIS_DIR, slug);
      const run = path.join(root, "runs", configSlug(timeline.analysis_id) || "analysis");
      fs.mkdirSync(run, { recursive: true });
      const whisperData = rawWhisper && typeof rawWhisper === "object" ? rawWhisper : timeline.whisper;
      const transcriptSegments = arr(whisperData?.segments).filter((s) => typeof (s.text || "") === "string").map((s) => ({
        start_seconds: Number(s.start_seconds ?? s.start), end_seconds: Number(s.end_seconds ?? s.end), text: String(s.text || "").trim(),
      })).filter((s) => Number.isFinite(s.start_seconds) && Number.isFinite(s.end_seconds) && s.end_seconds > s.start_seconds);
      const whisperSrt = timelineSrt(transcriptSegments, (s) => s.text);
      const whisperVtt = "WEBVTT\n\n" + transcriptSegments.map((s, i) => `${i + 1}\n${vttTime(s.start_seconds)} --> ${vttTime(s.end_seconds)}\n${s.text}`).join("\n\n") + "\n";
      const whisperTsv = ["start\tend\ttext", ...transcriptSegments.map((s) => `${Math.round(s.start_seconds * 1000)}\t${Math.round(s.end_seconds * 1000)}\t${s.text.replace(/[\r\n\t]+/g, " ")}`)].join("\n") + "\n";
      let directorSegments = null;
      try { directorSegments = splitWhisperTranscript({ segments: timeline.whisper.segments }); } catch { /* transcript artifact remains available */ }
      const lyricJson = { board_id: board.id, project_slug: slug, analysis_id: timeline.analysis_id, timeline, master: timeline.master || null };
      const masterRows = arr(timeline.master?.segments);
      const artifacts = {
        "whisperx.json": JSON.stringify(whisperData, null, 2),
        "whisperx_raw.json": JSON.stringify(whisperData, null, 2),
        "whisperx.srt": whisperSrt,
        "whisperx.tsv": whisperTsv,
        "whisperx.txt": transcriptSegments.map((s) => s.text).join("\n") + "\n",
        "whisperx.vtt": whisperVtt,
        "original_lyrics_alignment.json": JSON.stringify(lyricJson, null, 2),
        "original_lyrics_alignment.srt": timelineSrt(timeline.lines, (l) => l.lyric_text),
        "master_timeline.json": JSON.stringify({ board_id: board.id, project_slug: slug, analysis_id: timeline.analysis_id, master: timeline.master || null }, null, 2),
        "master_timeline.srt": timelineSrt(masterRows, (s) => s.lyric_text || `[${s.type || "instrumental"}]`),
      };
      if (directorSegments) {
        artifacts["director_segments.json"] = JSON.stringify(directorSegments, null, 2);
        artifacts["director_segments.srt"] = directorSegmentsToSrt(directorSegments.segments);
      }
      const manifest = {
        board_id: board.id, project_slug: slug, project_name: board.scenarioName || board.input?.title || board.id,
        analysis_id: timeline.analysis_id, exported_at: new Date().toISOString(), duration_seconds: timeline.duration_seconds,
        audio_file: board.input?.whisperxAudio?.fileName || board.input?.sourceAudio?.fileName || null,
        artifacts: [...Object.keys(artifacts), "analysis_manifest.json"],
      };
      artifacts["analysis_manifest.json"] = JSON.stringify(manifest, null, 2);
      for (const [name, content] of Object.entries(artifacts)) {
        for (const folder of [root, run]) {
          const target = path.join(folder, name);
          const temp = `${target}.${process.pid}.tmp`;
          fs.writeFileSync(temp, content, "utf8");
          fs.renameSync(temp, target);
        }
      }
      const audio = board.input?.whisperxAudio;
      if (audio?.file) {
        const source = path.join(WHISPERX_UPLOADS, path.basename(audio.file));
        if (fs.existsSync(source)) {
          const ext = path.extname(source) || ".wav";
          const target = path.join(run, `source_audio${ext}`);
          if (!fs.existsSync(target)) fs.copyFileSync(source, target);
        }
      }
      return { folder: path.relative(ROOT, root).replace(/\\/g, "/"), run_folder: path.relative(ROOT, run).replace(/\\/g, "/"), artifacts: manifest.artifacts };
    };
    // A stored lyric timeline is STALE when the board's current lines no longer
    // match it (the story was edited/rewritten after the import): the measured
    // windows no longer belong to these lines, so the planner falls back to the
    // honest estimate and the Lyric panel asks for a re-import instead of
    // silently timing new scenes with old audio.
    const lyricTimelineStale = (board, timeline) => {
      const storedRows = arr(timeline && timeline.lines).filter((l) => Number.isFinite(Number(l.line_id)));
      if (!storedRows.length) return false;
      const currentRows = lyricTimelineSourceLines(board).filter((l) => Number.isFinite(Number(l.lyric_line_id)));
      const current = currentRows.map((l) => Number(l.lyric_line_id));
      if (!current.length) return false;
      const byId = new Map(storedRows.map((l) => [Number(l.line_id), l]));
      const normalizeText = (value) => String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
      return currentRows.some((line) => {
        const prior = byId.get(Number(line.lyric_line_id));
        return !prior || normalizeText(prior.lyric_text) !== normalizeText(line.lyric_text ?? line.text);
      });
    };
    // Ask the configured local model to match uncertain lyric lines to spans
    // in measured WhisperX words. It can cite word indices only; the server
    // derives timestamps and never accepts replacement lyric text.
    if (p.match(/^\/api\/director\/boards\/[^/]+\/lyric-timeline\/ai-correct$/) && req.method === "POST") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      const board = readDirectorBoard(id);
      const timeline = board.lyric_timeline;
      if (!timeline?.lines?.length || !timeline?.whisper?.segments?.length) return json(res, 409, { error: "analyze audio with WhisperX before running AI correction" });
      if (lyricTimelineStale(board, timeline)) return json(res, 409, { error: "the board lyrics changed after this audio analysis — re-import WhisperX before auto-correcting" });
      if (timeline.master?.approved) return json(res, 409, { error: "unlock the approved master timeline before AI correction" });
      const words = arr(timeline.whisper.segments).flatMap((s) => arr(s.words)).sort((a, b) => Number(a.start_seconds) - Number(b.start_seconds))
        .map((w, word_index) => ({ word_index, word: String(w.word || ""), start_seconds: Number(w.start_seconds), end_seconds: Number(w.end_seconds), confidence: Number.isFinite(Number(w.confidence)) ? Number(w.confidence) : null }));
      if (!words.length) return json(res, 409, { error: "WhisperX has no word-level timings; AI correction needs word timings" });
      const targets = arr(timeline.lines).filter((l) => !l.manual && l.timing !== "manual" && (l.start_seconds == null || l.timing !== "measured" || l.low_confidence || Number(l.match_score) < 0.62));
      if (!targets.length) return json(res, 200, { board_id: id, corrected: 0, needs_review: [], message: "all lyric lines already have confident measured timing", timeline });
      const proposals = await llmChatJson({
        system: "Align user-provided lyric lines to the existing WhisperX transcript. Return JSON only: {\"matches\":[{\"line_id\":number,\"start_word\":number,\"end_word\":number,\"confidence\":number}]}. Indices refer to the supplied words array. Select only a contiguous span in audio order that corresponds to the complete lyric line. Omit uncertain lines. Never invent indices, timestamps, words, or modify lyrics. Repeated lines use distinct occurrences in chronological order.",
        user: JSON.stringify({ lyrics: targets.map((l) => ({ line_id: l.line_id, occurrence: l.occurrence, lyric_text: l.lyric_text })), words }),
        maxTokens: Math.min(8000, Math.max(1200, targets.length * 100)), temperature: 0, rawTag: id + "_lyric_ai_correct_raw.log",
      });
      const matches = arr(proposals?.matches);
      const targetById = new Map(targets.map((l) => [Number(l.line_id), l]));
      const targetIds = new Set(targets.map((l) => Number(l.line_id)));
      const token = (v) => String(v || "").normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
      const lyricTokens = (v) => String(v || "").split(/\s+/).map(token).filter(Boolean);
      const equivalent = (a, b) => a === b || (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a)));
      const lockedWords = new Set();
      for (const line of arr(timeline.lines)) if (!targetIds.has(Number(line.line_id)) && (line.timing === "measured" || line.timing === "manual")) {
        for (const w of arr(line.words)) if (Number.isInteger(Number(w.word_index))) lockedWords.add(Number(w.word_index));
      }
      const accepted = [], needsReview = [], seen = new Set();
      const matchById = new Map(matches.map((m) => [Number(m?.line_id), m]));
      let priorAcceptedEnd = -1;
      for (const line of targets) {
        const m = matchById.get(Number(line.line_id));
        if (!m) { needsReview.push({ line_id: line.line_id, occurrence: line.occurrence, reason: "AI found no safe transcript match" }); continue; }
        const lineId = Number(m?.line_id), startWord = Number(m?.start_word), endWord = Number(m?.end_word);
        if (seen.has(lineId)) continue;
        seen.add(lineId);
        const confidence = Number(m.confidence);
        if (!Number.isInteger(startWord) || !Number.isInteger(endWord) || startWord < 0 || endWord < startWord || endWord >= words.length || !Number.isFinite(confidence) || confidence < 0.82) {
          needsReview.push({ line_id: lineId, occurrence: line.occurrence, reason: "AI confidence or word span was not strong enough" }); continue;
        }
        const span = words.slice(startWord, endWord + 1), source = lyricTokens(line.lyric_text), heard = span.map((w) => token(w.word)).filter(Boolean);
        const coverage = source.length ? source.filter((t) => heard.some((h) => equivalent(t, h))).length / source.length : 0;
        const spanDuration = span.at(-1).end_seconds - span[0].start_seconds;
        if (coverage < 0.75 || !(spanDuration > 0 && spanDuration <= 30) || span.some((w) => !Number.isFinite(w.start_seconds) || !Number.isFinite(w.end_seconds))) {
          needsReview.push({ line_id: lineId, occurrence: line.occurrence, reason: "transcript words do not sufficiently cover the original lyric" }); continue;
        }
        const indexes = Array.from({ length: endWord - startWord + 1 }, (_, i) => startWord + i);
        if (startWord <= priorAcceptedEnd || indexes.some((n) => lockedWords.has(n)) || accepted.some((a) => indexes.some((n) => n >= a.start_word && n <= a.end_word))) {
          needsReview.push({ line_id: lineId, occurrence: line.occurrence, reason: "proposed words overlap another line's measured match" }); continue;
        }
        accepted.push({ line_id: lineId, start_seconds: span[0].start_seconds, end_seconds: span.at(-1).end_seconds, start_word: startWord, end_word: endWord, confidence, coverage });
        priorAcceptedEnd = endWord;
      }
      if (accepted.length) {
        const corrected = applyLyricCorrections(timeline, accepted);
        const acceptedIds = new Set(accepted.map((a) => a.line_id));
        corrected.lines = corrected.lines.map((l) => {
          const match = accepted.find((a) => a.line_id === Number(l.line_id));
          if (!match || !acceptedIds.has(Number(l.line_id))) return l;
          const span = words.slice(match.start_word, match.end_word + 1);
          return { ...l, words: span.map((w) => ({ word_index: w.word_index, word: w.word, start_seconds: w.start_seconds, end_seconds: w.end_seconds, confidence: w.confidence, timing: "measured" })), heard_text: span.map((w) => w.word).join(" "), match_score: match.coverage, timing: "measured", match: "whisperx", manual: false, ai_corrected: true, ai_match_confidence: match.confidence };
        });
        corrected.stats = { ...corrected.stats, measured: corrected.lines.filter((l) => l.timing === "measured").length, manual: corrected.lines.filter((l) => l.timing === "manual" || l.manual === true).length, estimated: corrected.lines.filter((l) => l.timing === "estimated").length };
        corrected.validation = validateLyricTimeline(corrected, { duration: lyricTimelineDuration(board) });
        corrected.actions = buildLyricActionTimeline(corrected.lines, (board.semantics && board.semantics.lines) || [], { scenes: board.scenes || [] });
        corrected.scene_map = assignLyricLinesToScenes(corrected.lines, board.scenes || []);
        const input = board.input || {};
        const master = buildMasterTimeline({
          lyricTimeline: corrected,
          vocalActivity: corrected.vocal_activity || input.whisperxAudio?.activity || null,
          duration: lyricTimelineDuration(board),
          characters: arr(board.blueprint?.characters),
          style: [input.visualStyle, input.artStyle, input.style].filter((v) => typeof v === "string" && v.trim()),
          semantics: (board.semantics && board.semantics.lines) || [],
          previous: corrected.master || null,
        });
        if (master) { master.approved = false; master.corrections = arr(timeline.master?.corrections); corrected.master = master; }
        board.lyric_timeline = corrected;
        const exportInfo = persistWavAnalysis(board);
        writeDirectorBoard(board);
        return json(res, 200, { board_id: id, corrected: accepted.length, auto_corrected: accepted, needs_review: needsReview, timeline: board.lyric_timeline, export: exportInfo });
      }
      return json(res, 200, { board_id: id, corrected: 0, auto_corrected: [], needs_review: needsReview, timeline, message: "no suggestions passed the evidence checks" });
    }

    // ---- Master timeline (audio-aligned chronological segments) -----------
    // DERIVED from the stored lyric timeline + the board's current cast and
    // meaning layer, so it can never drift from them; the stored `master`
    // object only carries the manual corrections and the approval state.
    const mstr = (v) => String(v ?? "").trim();
    const boardVisualStyles = (board) => {
      const input = (board && board.input) || {};
      return [input.visualStyle, input.artStyle, input.style].filter((v) => typeof v === "string" && v.trim());
    };
    const castForBoard = (board) => arr(board && board.blueprint && board.blueprint.characters);
    const characterIdentityOf = (board) => {
      const cast = castForBoard(board);
      const map = new Map(cast.map((c) => {
        const id = mstr(c.character_id ?? c.name ?? c.id);
        const identity = mstr(c.visual_identity_prompt || c.identity || c.description).slice(0, 300)
          || mstr(c.name || id);
        return [id, identity];
      }));
      return (id) => (id && map.get(mstr(id))) || "";
    };
    const masterViewForBoard = (board, timeline = (board && board.lyric_timeline) || null) => {
      if (!timeline || !Array.isArray(timeline.lines) || !timeline.lines.length) return null;
      const duration = lyricTimelineDuration(board);
      const view = buildMasterTimeline({
        lyricTimeline: timeline,
        vocalActivity: timeline.vocal_activity || (board.input && board.input.whisperxAudio && board.input.whisperxAudio.activity) || null,
        duration,
        characters: castForBoard(board),
        style: boardVisualStyles(board),
        semantics: (board.semantics && board.semantics.lines) || [],
        previous: timeline.master || null,
      });
      return view;
    };
    const persistMaster = (board, view) => {
      // The corrections list lives on the stored object so every later rebuild
      // (GET) re-applies it — the derivation itself stays pure.
      board.lyric_timeline.master = view;
      persistWavAnalysis(board);
      writeDirectorBoard(board);
      return view;
    };
    // Connected-OFF scrub: a normalized scene (or shot) on a board with
    // chainContinuity !== true must carry no handoff state — clear the
    // continuity fields and strip any stored handoff sentences from the
    // prompts so Approve generates independent shots. Mutates in place.
    const scrubSceneContinuity = (s) => {
      if (!s || typeof s !== "object") return s;
      // Exact removal first: the stored field value is known, and its clauses
      // may contain commas that the generic sentence-stripper cannot span.
      const cont = typeof s.continuity_from_previous_scene === "string"
        ? s.continuity_from_previous_scene.trim() : "";
      if (cont) {
        const needle = `continuing from previous shot: ${cont}`;
        if (typeof s.image_prompt === "string") s.image_prompt = s.image_prompt.split(needle).join("");
        if (typeof s.video_prompt === "string") s.video_prompt = s.video_prompt.split(needle).join("");
      }
      s.continuity_from_previous_scene = "";
      s.transition_to_next_scene = "";
      s.continuity_required = false;
      s.reference_source = "NONE";
      s.continuity_refs = [];
      // Conservative strip here: exact + short-clause removal preserve the
      // saved prompt's trailing style/context tokens. Any paraphrased
      // remainder is neutralized at approve time (aggressive strip +
      // re-grounding in boardToScenario).
      const conservative = { aggressive: false };
      if (typeof s.image_prompt === "string") s.image_prompt = stripContinuityText(s.image_prompt, conservative);
      if (typeof s.video_prompt === "string") s.video_prompt = stripContinuityText(s.video_prompt, conservative);
      if (Array.isArray(s.shots)) {
        for (const sh of s.shots) {
          if (!sh || typeof sh !== "object") continue;
          sh.continuity_required = false;
          sh.reference_source = "NONE";
          sh.continuity_refs = [];
          if (typeof sh.image_prompt === "string") sh.image_prompt = stripContinuityText(sh.image_prompt, conservative);
          if (typeof sh.video_prompt === "string") sh.video_prompt = stripContinuityText(sh.video_prompt, conservative);
        }
      }
      return s;
    };
    const directorBoardMeta = (b) => ({
      id: b.id,
      title: b.input?.title ?? b.id,
      status: b.status,
      scenes: Array.isArray(b.scenes) ? b.scenes.length : 0,
      sceneCount: b.sceneCount ?? 0,
      // Timed shots planned so far (mirrors the shot_count scalar; computed
      // here from the board JSON the list endpoint already reads).
      shots: Array.isArray(b.scenes)
        ? b.scenes.reduce((a, s) => a + Math.max(1, Array.isArray(s.shots) ? s.shots.length : 0), 0)
        : 0,
      scenarioName: b.scenarioName ?? null,
      // Approved storyboard -> generated project link (integer projects id).
      project_id: Number.isInteger(b.project_id) ? b.project_id : null,
      updatedAt: b.updatedAt ?? null,
      // Card fields for the Saved Storyboards grid.
      createdAt: b.createdAt ?? null,
      genre: b.input?.genre ?? null,
      visualStyle: b.input?.visualStyle ?? null,
      language: b.input?.language ?? null,
      aspectRatio: b.input?.aspectRatio ?? null,
      targetSeconds: b.input?.targetSeconds ?? null,
      logline: b.blueprint?.logline ?? null,
    });
    const DIRECTOR_GENRES = ["Kids", "Devotional", "Adventure", "Fantasy", "Horror", "Comedy", "Educational", "Custom"];
    const DIRECTOR_STYLES = ["3D Preschool Animation", "3D Cinematic", "Realistic", "Anime", "Cartoon", "Indian Mythological", "Fantasy", "Custom"];
    const DIRECTOR_LANGS = ["Hindi", "English", "Hinglish"];
    const DIRECTOR_ASPECTS = ["16:9", "9:16", "1:1"];
    const DIRECTOR_AUDIO_EXTS = { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4" };
    function directorValidateInput(body) {
      const b = body && typeof body === "object" ? body : {};
      const title = String(b.title || "").trim();
      let story = String(b.story || "").trim();
      if (!title) throw new Error("story title is required");
      // Optional song attachment (uploaded via POST /api/director/song-upload):
      // { file, fileName, durationSeconds, hasLyrics }. The song duration
      // drives the timeline (music-video mode); lyrics ride in `story`.
      let song = null;
      if (b.song && typeof b.song === "object") {
        const sf = String(b.song.file || "");
        if (!isSafe(sf) || !/\.(mp3|wav|m4a)$/i.test(sf) || !fs.existsSync(path.join(DIRECTOR, sf)))
          throw new Error("song file missing — re-upload the mp3");
        const dur = Math.round((Number(b.song.durationSeconds) || 0) * 1000) / 1000;
        song = {
          file: sf,
          fileName: String(b.song.fileName || "song.mp3").slice(0, 120),
          durationSeconds: dur > 0 ? dur : null,
          hasLyrics: b.song.hasLyrics !== false,
        };
      }
      let sourceAudio = null;
      if (b.sourceAudio && typeof b.sourceAudio === "object") {
        const af = String(b.sourceAudio.file || "");
        if (!isSafe(af) || !/\.(mp3|wav|m4a)$/i.test(af) || !fs.existsSync(path.join(DIRECTOR, af)))
          throw new Error("narration audio file missing — re-upload the audio");
        sourceAudio = {
          file: af,
          fileName: String(b.sourceAudio.fileName || "narration.wav").slice(0, 120),
          durationSeconds: Math.max(0.001, Math.round((Number(b.sourceAudio.durationSeconds) || 0) * 1000) / 1000),
          ...(b.sourceAudio.transcript && typeof b.sourceAudio.transcript === "object" ? { transcript: String(b.sourceAudio.transcript.text || "").slice(0, 20000) } : {}),
        };
      }
      if (song && !song.hasLyrics && story.length < 3)
        story = `[Instrumental song "${title}" — no lyrics provided; direct a matching visual story]`;
      if (story.length < 20 && sourceAudio?.transcript?.length >= 20) story = sourceAudio.transcript;
      if (story.length < 20) throw new Error(song
        ? "paste the song lyrics (20+ characters), or leave them empty for an instrumental visual story"
        : "story is too short — paste the full story");
      const language = DIRECTOR_LANGS.includes(b.language) ? b.language : "English";
      const genre = DIRECTOR_GENRES.includes(b.genre) ? b.genre : "Adventure";
      const visualStyle = DIRECTOR_STYLES.includes(b.visualStyle) ? b.visualStyle : "3D Cinematic";
      const aspectRatio = DIRECTOR_ASPECTS.includes(b.aspectRatio) ? b.aspectRatio : "16:9";
      // Song mode: the timeline IS the song length (rounded, clamped).
      const audioDuration = song?.durationSeconds || sourceAudio?.durationSeconds;
      const wantedTarget = audioDuration
        ? Math.max(0.001, Math.min(3600, audioDuration))
        : Math.max(15, Math.min(3600, Math.floor(Number(b.targetSeconds)) || 60));
      const targetSeconds = wantedTarget;
      const sceneSeconds = Math.max(1, Math.min(30, Math.floor(Number(b.sceneSeconds)) || 3));
      const sceneCount = sceneCountFor(targetSeconds, sceneSeconds);
      if (!sceneCount) throw new Error("could not derive a scene count from the durations");
      return {
        title,
        story,
        analyzerType: ["story_director", "song_director", "story_from_song_director", "kids_director", "devotional_director"].includes(String(b.analyzerType || ""))
          ? String(b.analyzerType) : "story_director",
        language,
        // The language of the SOURCE TEXT for the meaning analysis
        // (auto | hi | en | hinglish) — the spoken language stays separate.
        semanticsLanguage: ["auto", "hi", "en", "hinglish"].includes(String(b.semanticsLanguage || "").trim().toLowerCase())
          ? String(b.semanticsLanguage || "auto").trim().toLowerCase()
          : "auto",
        genre,
        genreCustom: genre === "Custom" ? String(b.genreCustom || "").trim() : "",
        visualStyle,
        styleCustom: visualStyle === "Custom" ? String(b.styleCustom || "").trim() : "",
        // Master Prompt: the UI auto-fills it from the analyzer directive +
        // visual-style preset and the user may edit it — a non-empty value
        // becomes THE style lock (styleLockFor prefers it over the
        // preset/custom text). 20000 chars: the sectioned Song Director
        // directive is ~12k and must reach the model complete.
        masterPrompt: String(b.masterPrompt || "").trim().slice(0, 20000),
        directorTemplate: b.directorTemplate === "mahadev_devotional" ? "mahadev_devotional" : "standard",
        targetSeconds,
        sceneSeconds,
        aspectRatio,
        instructions: String(b.instructions || "").trim(),
        // Silent film opt-out (default ON = voiced): when false the scene
        // batches emit dialogue [] and approve strips any stray lines.
        includeDialogue: b.includeDialogue !== false,
        // Connected movie (default ON): scenes continue the previous shot's
        // end state via TEXT continuity in the prompts
        // (cfg.chainContinuity -> runSequence chain wording). Generation
        // pixels always stay per-scene (own keyframe per clip).
        chainContinuity: b.chainContinuity !== false,
        ...(sourceAudio ? { sourceAudio } : {}),
        ...(b.songAnalysis && typeof b.songAnalysis === "object" ? { songAnalysis: {
          mood: String(b.songAnalysis.mood || "").slice(0, 200),
          structure: String(b.songAnalysis.structure || "").slice(0, 300),
          narrationStyle: String(b.songAnalysis.narrationStyle || "").slice(0, 200),
          segments: Array.isArray(b.songAnalysis.segments) ? b.songAnalysis.segments.slice(0, 12).map(s => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, label: String(s.label || "").slice(0, 40), mood: String(s.mood || "").slice(0, 60) })) : [],
          transcript: b.songAnalysis.transcript && typeof b.songAnalysis.transcript === "object" ? {
            status: String(b.songAnalysis.transcript.status || ""),
            segments: Array.isArray(b.songAnalysis.transcript.segments) ? b.songAnalysis.transcript.segments.slice(0, 500).map(s => ({
              start: Math.max(0, Number(s.start) || 0),
              end: Math.min(targetSeconds, Math.max(0, Number(s.end) || 0)),
              text: String(s.text || "").trim().slice(0, 600),
            })).filter(s => s.text && s.end > s.start) : [],
          } : null,
          measured: b.songAnalysis.measured && typeof b.songAnalysis.measured === "object" ? {
            meanVolumeDb: b.songAnalysis.measured.meanVolumeDb != null && Number.isFinite(Number(b.songAnalysis.measured.meanVolumeDb)) ? Number(b.songAnalysis.measured.meanVolumeDb) : null,
            signal: b.songAnalysis.measured.signal && typeof b.songAnalysis.measured.signal === "object" ? {
              bpm: b.songAnalysis.measured.signal.bpm != null && Number.isFinite(Number(b.songAnalysis.measured.signal.bpm)) ? Number(b.songAnalysis.measured.signal.bpm) : null,
              bpmConfidence: Number(b.songAnalysis.measured.signal.bpmConfidence) || 0,
              beatTimes: Array.isArray(b.songAnalysis.measured.signal.beatTimes) ? b.songAnalysis.measured.signal.beatTimes.slice(0, 600) : [],
              keyEstimate: b.songAnalysis.measured.signal.keyEstimate || null,
            } : null,
          } : null,
        } } : {}),
        ...(song ? { song } : {}),
      };
    }
    // Song upload for the Director's music-video mode: base64 audio -> file
    // in director/ + ffprobe duration (drives the storyboard timeline).
    // No transcription here (the local LLM is text-only) — lyrics come from
    // the pasted text field, or the board runs instrumental from the title.
    if (p === "/api/director/song-upload" && req.method === "POST") {
      const body = await readJson(req);
      if (typeof body.data !== "string") return json(res, 400, { error: "data (base64) required" });
      const m = body.data.match(/^data:(audio\/[\w.+-]+);base64,(.+)$/s);
      if (!m) return json(res, 400, { error: "expected a data:audio/* base64 payload (mp3 or wav)" });
      const mime = m[1].toLowerCase();
      const ext = mime.includes("wav") ? ".wav" : mime.includes("mp4") || mime.includes("m4a") ? ".m4a"
        : mime.includes("mpeg") || mime.includes("mp3") ? ".mp3" : null;
      if (!ext) return json(res, 400, { error: `unsupported audio type ${mime} — upload mp3 or wav` });
      const buf = Buffer.from(m[2], "base64");
      if (!buf.length) return json(res, 400, { error: "empty file" });
      const file = `song_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}${ext}`;
      fs.mkdirSync(DIRECTOR, { recursive: true });
      fs.writeFileSync(path.join(DIRECTOR, file), buf);
      const durationSeconds = await videoDurationSec(path.join(DIRECTOR, file));
      if (durationSeconds == null) {
        try { fs.unlinkSync(path.join(DIRECTOR, file)); } catch { /* already gone */ }
        return json(res, 400, { error: "could not read audio duration — is it a valid mp3/wav?" });
      }
      const originalName = String(body.fileName || "song").slice(0, 120) || "song";
      return json(res, 200, {
        file, fileName: originalName, durationSeconds: Math.round(durationSeconds * 1000) / 1000,
        sizeBytes: buf.length,
      });
    }
    // Serve uploaded director audio (preview player + mux source).
    if (p.startsWith("/api/director/audio/") && req.method === "GET") {
      const file = decodeURIComponent(p.split("/")[4] || "");
      if (!isSafe(file) || !/\.(mp3|wav|m4a)$/i.test(file))
        return json(res, 400, { error: "bad audio file" });
      const full = path.join(DIRECTOR, file);
      if (!fs.existsSync(full)) return json(res, 404, { error: "audio not found" });
      const ctype = DIRECTOR_AUDIO_EXTS[path.extname(full).toLowerCase()] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": ctype, "Cache-Control": "no-store" });
      fs.createReadStream(full).pipe(res);
      return;
    }
    // Lay the board's uploaded song over an output dir's latest final cut:
    // <prefix>_with_song.mp4 (video stream-copied, song as the audio track,
    // -shortest so the file ends with whichever is shorter). Overwrites the
    // same file on repeat muxes — no version sprawl.
    if (p.match(/^\/api\/director\/boards\/[^/]+\/mux-song$/) && req.method === "POST") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      const board = readDirectorBoard(id);
      const songFile = board?.input?.song?.file;
      if (!songFile) throw new Error("this board has no uploaded song");
      const songFull = path.join(DIRECTOR, songFile);
      if (!fs.existsSync(songFull)) throw new Error("song file missing — re-upload the mp3");
      const body = await readJson(req).catch(() => ({}));
      if (!isSafe(body.dir)) return json(res, 400, { error: "bad dir" });
      const full = path.join(OUTPUTS, body.dir);
      let st = null;
      try { st = fs.statSync(full); } catch { st = null; }
      if (!st || !st.isDirectory()) return json(res, 404, { error: "unknown outputs dir" });
      const prefix = prefixForDir(body.dir);
      const vm = versionMap(full, prefix, []);
      const finals = [...(vm.final ?? [])].sort((a, b) => a.v - b.v);
      const from = finals.length ? finals[finals.length - 1].file : vm.finalMain;
      if (!from) return json(res, 400, { error: "no final cut yet — generate and stitch the video first" });
      const out = `${prefix}_with_song.mp4`;
      await runCmd("ffmpeg", ["-y", "-v", "error",
        "-i", path.join(full, from), "-i", songFull,
        "-c:v", "copy", "-map", "0:v:0", "-map", "1:a:0", "-shortest",
        path.join(full, out)], 120000);
      const songDur = await videoDurationSec(songFull);
      const finalDur = await videoDurationSec(path.join(full, from));
      return json(res, 200, { file: out, from, songDuration: songDur, finalDuration: finalDur });
    }
    // WhisperX preflight
    if (p === "/api/whisperx/preflight" && req.method === "GET") {
      try {
        const resPre = await whisperxPreflightCheck();
        return json(res, 200, resPre);
      } catch (e) {
        return json(res, 200, { ok: false, checks: { error: { ok: false, message: e.message } } });
      }
    }

    if (p === "/api/director/boards" && req.method === "GET") {
      fs.mkdirSync(DIRECTOR, { recursive: true });
      // DB-first: every board write is mirrored into director_boards.
      const seen = new Map();
      if (pgUp) {
        try {
          const r = await pgPool.query("SELECT board_id, board FROM director_boards");
          for (const row of r.rows) {
            try {
              const b = typeof row.board === "string" ? JSON.parse(row.board) : row.board;
              if (b && b.id) seen.set(String(b.id), directorBoardMeta(b));
            } catch { /* skip corrupt rows */ }
          }
        } catch (e) { console.warn("[pg] director boards list failed:", e.message); }
      }
      // Files fill the gaps (boards saved while the DB was down) and are
      // backfilled into the DB on the spot.
      for (const f of fs.readdirSync(DIRECTOR).filter((f) => f.endsWith(".json") && !f.startsWith("_raw"))) {
        try {
          const b = JSON.parse(fs.readFileSync(path.join(DIRECTOR, f), "utf8"));
          if (b && b.id && !seen.has(String(b.id))) {
            seen.set(String(b.id), directorBoardMeta(b));
            if (pgUp) pgUpsertDirectorBoard(b).catch((e) => console.warn("[pg] director board backfill failed:", e.message));
          }
        } catch { /* skip corrupt board files */ }
      }
      const list = [...seen.values()];
      list.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
      return json(res, 200, list);
    }
    // Prompt preview for the "Show Prompt" popup: returns EXACTLY the user
    // prompt the analyze (bible) call will send — no model call, no cost.
    // The user can edit it there and send the edited text via promptOverride.
    if (p === "/api/director/prompt-preview" && req.method === "POST") {
      const bodyRaw = await readJson(req);
      const input = directorValidateInput(bodyRaw);
      return json(res, 200, { prompt: buildBiblePrompt(input) });
    }
    // Optimize Prompt (Show Prompt popup): the LLM tightens the generated or
    // user-edited bible prompt — clearer, less redundant, every constraint
    // kept — and returns it alongside token counts so the user can compare
    // with the main prompt before applying. Stateless — nothing is saved.
    // Token counts use the same chars/4 approximation as the board prompt
    // preview; real optimize-call usage is reported too when the backend
    // provides it.
    if (p === "/api/director/optimize-prompt" && req.method === "POST") {
      const body = await readJson(req);
      const prompt = String(body.prompt || "").trim();
      if (prompt.length < 40) return json(res, 400, { error: "nothing to optimize — the prompt is empty or too short" });
      if (prompt.length > 60000) return json(res, 400, { error: "prompt too long to optimize (60000 character cap)" });
      const title = String(body.title || "").trim().slice(0, 120);
      const est = (t) => Math.round(String(t).length / 4);
      const base = (process.env.LLM_BASE || "").replace(/\/+$/, "");
      if (!base) throw new Error("LLM_BASE not set — the director needs the local LLM (LM Studio / llama-server).");
      const d = await llmPostChat(`${base}/v1/chat/completions`, {
        model: LLM_MODEL,
        messages: [
          { role: "system", content: "You are a prompt-optimization assistant for an AI video director. Optimize the given directing prompt: make it clearer, better structured and free of redundancy so a local LLM follows it more reliably. STRICT RULES: keep EVERY constraint, id list, JSON-shape instruction, style lock, duration and placeholder exactly as given; never invent new story details, characters or requirements; never answer the prompt yourself; keep the same language(s). The optimized_prompt value MUST stay PLAIN TEXT in the SAME format as the original prompt — never convert it to JSON, YAML, a table or a summary, never shorten it below half its length, and never wrap the whole prompt in a new data structure. Reply with JSON only: { \"optimized_prompt\": \"<the complete optimized prompt>\" }." },
          { role: "user", content: JSON.stringify({ ...(title ? { title } : {}), prompt }) },
        ],
        temperature: 0.3,
        max_tokens: 8000,
        chat_template_kwargs: { enable_thinking: false },
      }, { tag: "optimize-prompt" });
      const text = String(d.choices?.[0]?.message?.content ?? "");
      // Preferred: structured JSON. Fallback: usable plain-text (fences and a
      // leading label stripped) so a non-JSON reply is never discarded.
      let optimized = "";
      try {
        const raw = stripJson(text);
        optimized = String(raw.optimized_prompt || raw.optimizedPrompt || raw.prompt || "").trim();
      } catch {
        let s = text.trim();
        const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        if (fence) s = fence[1].trim();
        optimized = s.replace(/^optimized[_ ]?prompt\s*:\s*/i, "").trim();
      }
      if (!optimized) throw new Error("the optimizer returned an empty prompt — try again");
      // Guard: a weak model sometimes "optimizes" by converting the prompt
      // into a JSON data structure (the original is plain text). That output
      // would break the storyboard if applied — refuse it honestly instead.
      const originalIsJson = prompt.startsWith("{");
      const optimizedIsJson = optimized.startsWith("{") && /"\s*:\s*["{[]/.test(optimized.slice(0, 400));
      if (!originalIsJson && optimizedIsJson)
        throw new Error("the optimizer converted the prompt into a data structure instead of plain text — try again (or optimize manually)");
      return json(res, 200, {
        optimized: optimized.slice(0, 60000),
        tokens: { original: est(prompt), optimized: est(optimized) },
        usage: d.usage && typeof d.usage === "object"
          ? { prompt_tokens: Number(d.usage.prompt_tokens) || null, completion_tokens: Number(d.usage.completion_tokens) || null }
          : null,
      });
    }
    // Story audio analysis rides the REAL WhisperX board flow:
    // POST /api/director/boards/:id/audio-upload → .../whisperx/analyze →
    // .../master-timeline (see AGENTS.md). The old /api/story/* stub routes
    // were removed — they were Express-style handlers inside this zero-dep
    // server and returned an empty body (client: "Unexpected end of JSON
    // input").
    if (p === "/api/director/analyze" && req.method === "POST") {
      const bodyRaw = await readJson(req);
      const input = directorValidateInput(bodyRaw);
      // promptOverride: the user-edited bible prompt from the Show Prompt
      // popup — sent VERBATIM to the model in place of the generated prompt
      // (the system prompt, normalization and every downstream stage are
      // unchanged). Empty/missing = the default generated prompt.
      const promptOverride = String(bodyRaw?.promptOverride || "").trim();
      // liveId: client-generated request id — when present the bible call
      // streams (same payload, stream:true) into a Node-side buffer served
      // read-only by GET /api/director/analyze-live/:id so the form can show
      // the backend response live while it generates.
      const liveId = String(bodyRaw?.liveId || "").trim().slice(0, 64).replace(/[^a-zA-Z0-9._-]/g, "") || null;
      if (liveId) liveBegin(liveId, { phase: "bible" });
      let raw;
      try {
        const bibleArgs = {
          system: DIRECTOR_SYSTEM,
          user: promptOverride || buildBiblePrompt(input),
          maxTokens: 16000,
          temperature: 0.7,
          timeoutMs: REQUEST_TIMEOUT_MS,
          rawTag: `_raw_${slug(input.title)}_bible.log`,
        };
        raw = liveId
          ? await llmChatJsonLive({ ...bibleArgs, liveId, tag: "bible" })
          : await llmChatJson(bibleArgs);
      } finally {
        if (liveId) liveEnd(liveId);
      }
      assertNoCJK(raw, "the director bible");
      const blueprint = normalizeBlueprint(raw);
      if (!blueprint.characters.length && !blueprint.locations.length && !blueprint.objects.length
        && !blueprint.logline && !Object.values(blueprint.analysis || {}).some((value) => Array.isArray(value) ? value.length : Boolean(value)))
        throw new Error("director returned an empty blueprint — try again");
      const id = slug(input.title) || `story_${Date.now().toString(36)}`;
      // The MEANING pass runs right after the bible: every source line is
      // analysed (language, meaning, visible action, camera) BEFORE any scene
      // is planned. The deterministic pass is instant; the model enrichment
      // runs per scene batch (see the /scenes route) so the story is never
      // blocked by a slow local model.
      const sourceLines = directorSourceLines({ input, blueprint });
      const semanticRows = analyzeLinesDeterministic(sourceLines, {
        language: String(input.semanticsLanguage || "auto"),
        bible: blueprint,
        genre: input.genre,
      });
      const board = writeDirectorBoard({
        id,
        input,
        status: "analyzed",
        blueprint,
        semantics: {
          language: String(input.semanticsLanguage || "auto"),
          source: "deterministic",
          lines: semanticRows,
          created_at: new Date().toISOString(),
        },
        // Chief Director Story Plan: derived from the fresh bible so every
        // downstream stage traces to this authoritative narrative source.
        storyPlan: buildStoryPlan({ input, blueprint }),
        scenes: [],
        sceneCount: sceneCountFor(input.targetSeconds, input.sceneSeconds),
        styleLock: styleLockFor(input.visualStyle, input.styleCustom, input.masterPrompt),
        scenarioName: null,
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return json(res, 200, board);
    }
    {
      const mAudioTimeline = p.match(/^\/api\/director\/boards\/([^/]+)\/timeline$/);
      if (mAudioTimeline && ["GET", "PUT"].includes(req.method)) {
        const id = decodeURIComponent(mAudioTimeline[1]);
        const board = readDirectorBoard(id);
        const signature = () => crypto.createHash("sha256").update(JSON.stringify({
          scenes: board.scenes || [], story: board.input?.story || "", song: board.input?.song || null,
          sourceAudio: board.input?.sourceAudio || null, transcript: board.input?.songAnalysis?.transcript?.segments || [],
        })).digest("hex");
        if (req.method === "GET") {
          if (!board.audioTimeline || board.audioTimeline.schema_version !== 2 || board.audioTimeline.source_signature !== signature()) {
            board.audioTimeline = buildAudioTimeline(board);
            board.audioTimeline.source_signature = signature();
            writeDirectorBoard(board);
          }
          return json(res, 200, board.audioTimeline);
        }
        const incoming = await readJson(req);
        const expectedDuration = audioTimelineDuration(board);
        if (Number(incoming.duration_seconds) !== Number(board.audioTimeline?.duration_seconds || expectedDuration))
          return json(res, 400, { error: "timeline duration is locked to the source audio" });
        const shots = Array.isArray(incoming.shots) ? incoming.shots : [];
        const ids = new Set();
        const normalized = shots.map((shot, index) => {
          const shotId = String(shot.shot_id || `shot-${index + 1}`).slice(0, 80);
          if (ids.has(shotId)) throw new Error(`duplicate shot_id: ${shotId}`);
          ids.add(shotId);
          const start = Math.max(0, Number(shot.start_seconds) || 0);
          const end = Number(shot.end_seconds);
          return {
            ...shot, shot_id: shotId,
            start_seconds: Math.round(start * 1000) / 1000,
            end_seconds: Math.round(end * 1000) / 1000,
            duration_seconds: Math.round((end - start) * 1000) / 1000,
            audio_type: ["instrumental", "vocal", "dialogue", "mixed"].includes(shot.audio_type) ? shot.audio_type : "mixed",
            voice_ids: Array.isArray(shot.voice_ids) ? shot.voice_ids.map(x => String(x).trim().slice(0, 80)).filter(Boolean).slice(0, 8) : [],
            character_ids: Array.isArray(shot.character_ids) ? shot.character_ids.map(x => String(x).trim().slice(0, 120)).filter(Boolean).slice(0, 16) : [],
            character_reference_ids: Array.isArray(shot.character_reference_ids) ? shot.character_reference_ids.map(x => String(x).trim().slice(0, 120)).filter(Boolean).slice(0, 16) : [],
            lyrics_or_dialogue: String(shot.lyrics_or_dialogue || "").slice(0, 4000),
            aligned_vocal_cues: String(shot.lyrics_or_dialogue || "").trim() ? [{
              start_seconds: Math.round(start * 1000) / 1000,
              end_seconds: Math.round(end * 1000) / 1000,
              text: String(shot.lyrics_or_dialogue || "").trim().slice(0, 4000),
              voice_ids: Array.isArray(shot.voice_ids) ? shot.voice_ids.map(x => String(x).trim()).filter(Boolean).slice(0, 8) : [],
            }] : [],
            action: String(shot.action || "").slice(0, 1500),
            image_generation_prompt: String(shot.image_generation_prompt || "").slice(0, 5000),
            video_motion_prompt: String(shot.video_motion_prompt || "").slice(0, 5000),
            lip_sync_required: shot.lip_sync_required === true,
          };
        });
        const timeline = {
          ...incoming,
          director_mode: board.input?.song ? "music_video" : "story_video",
          duration_seconds: expectedDuration,
          coverage: { start_seconds: 0, end_seconds: expectedDuration, complete: true },
          shots: normalized, source_signature: signature(), status: "review",
        };
        const errors = validateAudioTimeline(timeline, expectedDuration);
        if (errors.length) return json(res, 400, { error: errors.join("; "), validation: errors });
        const syncResult = syncAudioTimelineToScenes(board.scenes, timeline, {
          shotFloor: 0.5,
          sceneFloor: 1,
        });
        const storyboardSync = syncResult.synced;
        board.audioTimeline = timeline;
        timeline.storyboard_sync = storyboardSync ? "synced" : "timeline_only";
        const syncWarning = syncResult.reason;
        if (!storyboardSync && !(timeline.warnings || []).includes(syncWarning)) timeline.warnings = [...(timeline.warnings || []), syncWarning];
        if (storyboardSync) timeline.warnings = (timeline.warnings || []).filter(w => w !== syncWarning);
        timeline.source_signature = signature();
        writeDirectorBoard(board);
        return json(res, 200, timeline);
      }
    }
    {
      // Board-scoped routes: GET/PUT/DELETE /api/director/boards/:id (board id
      // never contains slashes — isSafe enforced on read).
      const mBoard = p.match(/^\/api\/director\/boards\/([^/]+)$/);
      if (mBoard) {
        const id = decodeURIComponent(mBoard[1]);
        if (req.method === "GET") {
          // DB-first, file fallback (missing DB rows are backfilled).
          if (pgUp) {
            try {
              const r = await pgPool.query("SELECT board FROM director_boards WHERE board_id = $1", [id]);
              if (r.rows[0]?.board) {
                const b = typeof r.rows[0].board === "string" ? JSON.parse(r.rows[0].board) : r.rows[0].board;
                return json(res, 200, b);
              }
            } catch (e) { console.warn("[pg] director board read failed:", e.message); }
          }
          return json(res, 200, readDirectorBoard(id));
        }
        if (req.method === "DELETE") {
          readDirectorBoard(id); // throws when missing
          fs.rmSync(directorBoardFile(id));
          try { await pgDeleteDirectorBoard(id); }
          catch (e) { console.warn("[pg] director board delete failed:", e.message); }
          return json(res, 200, { ok: true });
        }
        if (req.method === "PUT") {
          const board = readDirectorBoard(id);
          const patch = await readJson(req);
          // Rename the board (the approve target follows the board title, so
          // the created project is named exactly what the user entered).
          if (patch.input && typeof patch.input === "object") {
            const nt = String(patch.input.title || "").trim().slice(0, 120);
            if (nt) board.input.title = nt;
            // Full input view/edit from the storyboard UI (📝 Inputs popup on
            // the open board + saved cards). Story/style/durations only steer
            // FUTURE scene batches — already-planned bible entries and scenes
            // are kept as-is (regenerate per scene, or re-analyze for a fresh
            // bible). Song attachment itself is never edited here (read-only).
            if (typeof patch.input.story === "string") {
              const st = patch.input.story.trim().slice(0, 10000);
              if (st.length >= 3) board.input.story = patch.input.story.trim().slice(0, 10000);
            }
            if (typeof patch.input.language === "string" && DIRECTOR_LANGS.includes(patch.input.language))
              board.input.language = patch.input.language;
            if (typeof patch.input.analyzerType === "string" && ["story_director", "song_director", "story_from_song_director", "kids_director", "devotional_director"].includes(patch.input.analyzerType))
              board.input.analyzerType = patch.input.analyzerType;
            if (typeof patch.input.genre === "string" && DIRECTOR_GENRES.includes(patch.input.genre))
              board.input.genre = patch.input.genre;
            if (typeof patch.input.genreCustom === "string")
              board.input.genreCustom = patch.input.genreCustom.trim().slice(0, 40);
            if (typeof patch.input.visualStyle === "string" && DIRECTOR_STYLES.includes(patch.input.visualStyle)) {
              board.input.visualStyle = patch.input.visualStyle;
              // Keep the server-side style lock in step so future batches
              // ground on the newly chosen style.
              try { board.styleLock = styleLockFor(board.input.visualStyle, board.input.styleCustom); } catch { /* keep old lock */ }
            }
            if (typeof patch.input.styleCustom === "string") {
              board.input.styleCustom = patch.input.styleCustom.trim().slice(0, 120);
              try { board.styleLock = styleLockFor(board.input.visualStyle, board.input.styleCustom, board.input.masterPrompt); } catch { /* keep old lock */ }
            }
            if (typeof patch.input.masterPrompt === "string") {
              board.input.masterPrompt = patch.input.masterPrompt.trim().slice(0, 20000);
              // The Master Prompt is THE style lock when set — refresh so
              // future batches ground on the edited text.
              try { board.styleLock = styleLockFor(board.input.visualStyle, board.input.styleCustom, board.input.masterPrompt); } catch { /* keep old lock */ }
            }
            // Song boards lock their timeline to the uploaded song length —
            // ignore target edits there (scene pacing stays editable).
            const hasSong = !!(board.input.song && board.input.song.durationSeconds);
            if (!hasSong && patch.input.targetSeconds != null) {
              const t = Math.floor(Number(patch.input.targetSeconds));
              if (Number.isFinite(t)) board.input.targetSeconds = Math.max(15, Math.min(3600, t));
            }
            if (patch.input.sceneSeconds != null) {
              const s = Math.floor(Number(patch.input.sceneSeconds));
              if (Number.isFinite(s)) board.input.sceneSeconds = Math.max(1, Math.min(30, s));
            }
            if (typeof patch.input.aspectRatio === "string" && DIRECTOR_ASPECTS.includes(patch.input.aspectRatio))
              board.input.aspectRatio = patch.input.aspectRatio;
            if (typeof patch.input.instructions === "string")
              board.input.instructions = patch.input.instructions.trim().slice(0, 2000);
            // Fresh estimate boards (no scenes yet) follow duration edits so
            // the "x/y scenes" cap never shows a stale total.
            if (!board.scenes.length) {
              try {
                const nc = sceneCountFor(board.input.targetSeconds, board.input.sceneSeconds);
                if (nc) board.sceneCount = nc;
              } catch { /* keep old cap */ }
            }
            // Board-level toggles from the storyboard header (dialogues on/off,
            // connected scenes on/off). Old boards without the keys gain them
            // here so approve/prompt behaviour stays explicit.
            if (typeof patch.input.includeDialogue === "boolean")
              board.input.includeDialogue = patch.input.includeDialogue;
            if (typeof patch.input.chainContinuity === "boolean")
              board.input.chainContinuity = patch.input.chainContinuity;
            // Turning Connected OFF takes effect immediately: scrub handoff
            // state from already-planned scenes so Approve generates
            // independent shots without requiring a per-scene regenerate.
            if (patch.input.chainContinuity === false && Array.isArray(board.scenes)) {
              for (const s of board.scenes) scrubSceneContinuity(s);
            }
          }
          // Full-array merges for bible/scene edits from the storyboard UI.
          // Deleted scenes renumber the plan and shrink its total.
          if (patch.blueprint && typeof patch.blueprint === "object") {
            const nb = normalizeBlueprint({ ...board.blueprint, ...patch.blueprint });
            board.blueprint = nb;
          }
          // Intelligent Director story plan (spec §2/§15): staged analysis
          // artefacts (story summary, lyric semantics, coverage snapshots)
          // persist on the board JSON so a failed stage never forces a full
          // restart. Merged (not replaced) so persisting stage N never drops
          // the artefacts of earlier stages. The canonical scenes above
          // remain the executable source of truth. Approvals accumulate per
          // stage; any other plan edit bumps the revision counter.
          if (patch.storyPlan && typeof patch.storyPlan === "object" && !Array.isArray(patch.storyPlan)) {
            const prev = (board.storyPlan && typeof board.storyPlan === "object") ? board.storyPlan : {};
            const prevNorm = normalizeStoryPlan(prev);
            const merged = normalizeStoryPlan({
              ...prevNorm, ...patch.storyPlan,
              structure: { ...prevNorm.structure, ...((patch.storyPlan.structure && typeof patch.storyPlan.structure === "object") ? patch.storyPlan.structure : {}) },
              approvals: { ...prevNorm.approvals, ...((patch.storyPlan.approvals && typeof patch.storyPlan.approvals === "object") ? patch.storyPlan.approvals : {}) },
            });
            merged.revisions = prevNorm.revisions + 1;
            board.storyPlan = merged;
          }
          // Full-array replace for bible edits from the storyboard UI:
          // the client sends the complete next array, so deletes (shorter
          // array) and appends (longer array) both persist. Entries are
          // re-normalized so ids/defaults never break scene references.
          for (const k of ["characters", "locations", "objects"]) {
            if (Array.isArray(patch[k])) {
              board.blueprint[k] = patch[k].map((x, i) =>
                k === "characters" ? normalizeCharacter(x, i)
                  : k === "locations" ? normalizeLocation(x, i)
                    : normalizeObject(x, i));
            }
          }
          if (Array.isArray(patch.scenes)) {
            board.scenes = patch.scenes.map((s, i) => normalizeScene(s, i + 1, board.input.sceneSeconds));
            // Scene edits saved onto an independent-shots board stay
            // independent even if the edited text reintroduces handoffs.
            if (board.input.chainContinuity !== true) {
              for (const s of board.scenes) scrubSceneContinuity(s);
            }
            if (board.scenes.length) {
              board.sceneCount = board.scenes.length;
            } else {
              // Deleting all scenes resets planning to the full duration-based
              // cap; zero would make the next Generate Scenes call a no-op.
              const target = Number(board.input?.song?.durationSeconds)
                || Number(board.input?.targetSeconds)
                || Number(board.input?.sourceAudio?.durationSeconds)
                || 0;
              board.sceneCount = sceneCountFor(target, board.input?.sceneSeconds);
            }
          }
          board.status = board.scenes.length ? "ready" : (board.blueprint ? "analyzed" : board.status);
          board.error = null;
          // Manual edits supersede the last batch's grounding report.
          board.warn = null;
          return json(res, 200, writeDirectorBoard(board));
        }
      }
    }
    // Director live stream (read-only): what the backend LLM is writing RIGHT
    // NOW for this board's running scene batch — completed scenes so far
    // (scene by scene) plus the trailing in-progress fragment (word by word).
    // Polls a Node-side buffer only; the model is never touched, so planning
    // is unaffected. { active:false } when no batch is running.
    if (p.match(/^\/api\/director\/boards\/[^/]+\/live$/) && req.method === "GET") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      const st = directorLive.get(id);
      if (!st || !st.active) return json(res, 200, { active: false, scenes: [], tail: "" });
      const scenes = extractPartialScenes(st.text).slice(-SCENE_BATCH).map((s) => ({
        scene_number: Number(s.scene_number) || 0,
        title: String(s.title || "").slice(0, 120),
        action: String(s.action || "").slice(0, 200),
        shots: Array.isArray(s.shots) ? s.shots.slice(0, 8).map((sh) => ({
          shot_id: String((sh && sh.shot_id) || ""),
          text: String((sh && (sh.lyric_segment || sh.action)) || "").slice(0, 160),
        })) : [],
        dialogue: Array.isArray(s.dialogue) ? s.dialogue.slice(0, 4).map((d) => ({
          speaker: String((d && d.speaker) || ""),
          line: String((d && d.line) || "").slice(0, 160),
        })) : [],
      }));
      // Thinking models (qwen3.5 on LM Studio — enable_thinking:false and
      // reasoning_budget:0 are both ignored) stream delta.reasoning_content
      // for the WHOLE thinking phase before the first content token, so
      // st.text stays empty and the LIVE row would show nothing while the
      // model is visibly generating. Surface the reasoning buffer too.
      const reasoning = String(st.reasoning || "");
      return json(res, 200, {
        active: true,
        phase: st.phase || "scenes",
        batchFrom: st.batchFrom ?? null,
        batchTo: st.batchTo ?? null,
        startedAt: st.startedAt,
        elapsedMs: Math.max(0, Date.now() - st.startedAt),
        llmElapsedMs: st.llmStartedAt ? Math.max(0, Date.now() - st.llmStartedAt) : null,
        currentAttempt: st.currentAttempt || null,
        llmAttempts: st.llmAttempts || [],
        chars: st.text.length,
        thinking: !st.text && !!reasoning,
        reasoning: reasoning.slice(-4000),
        scenes,
        tail: st.text.slice(-900),
      });
    }
    // Analyze live stream (read-only): the bible LLM response streaming RIGHT
    // NOW for a pre-board Generate request (no board exists yet, so the
    // buffer is keyed by the client-generated liveId sent in the analyze
    // body). Same rules as the board live view — polls a Node-side buffer
    // only; the model is never touched. { active:false } when idle/unknown.
    if (p.match(/^\/api\/director\/analyze-live\/[^/]+$/) && req.method === "GET") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      const st = directorLive.get(id);
      if (!st || !st.active) return json(res, 200, { active: false, text: "" });
      // Combined view: the model's streaming reasoning (thinking phase) then
      // the real response — so the live textarea shows activity from the
      // first token, not minutes of silence while a thinking model thinks.
      const combined = st.reasoning
        ? `${st.reasoning}\n\n――― response ―――\n\n${st.text}`
        : st.text;
      return json(res, 200, { active: true, text: combined.slice(-20000) });
    }
    // Shared batch planner: computes EXACTLY what the next Continue would
    // send to the LLM (same count, budget, line window, prior dialogue) —
    // used by POST .../scenes for the real call and by GET
    // .../prompt-preview for the dry-run popup. No model call here.
    // Returns { ready:true, board, write } when planning is done (answer
    // immediately), else { ready:false, ...spec } for the LLM call.
    const nextSceneBatchSpec = (board, countOverride, id) => {
      // A batch that finished while this request was queued already advanced
      // scenes.length — continuing from the fresh count skips duplicates
      // instead of re-planning the same range.
      const done = board.scenes.length;
      // Duration-driven planning: the timeline (not the scene cap) is the
      // source of truth. Close enough counts as covered so a 299.5s plan
      // never spawns another scene for half a second.
      const measuredAudioTarget = Number(board.input && board.input.song && board.input.song.durationSeconds)
        || Number(board.input && board.input.sourceAudio && board.input.sourceAudio.durationSeconds)
        || Number(board.input && board.input.whisperxAudio && board.input.whisperxAudio.durationSeconds)
        || 0;
      const planTarget = Math.round(measuredAudioTarget || Number(board.input.targetSeconds)) || 0;
      const prog = planProgress(board.scenes, planTarget);
      const avgScene = Math.max(1, Number(board.input.sceneSeconds) || 3);
      const DONE_TOL = Math.max(1, avgScene / 2);
      const timeCovered = planTarget > 0 && (planTarget - prog.plannedSeconds) <= DONE_TOL;
      // Old/empty boards can have sceneCount=0 (for example, saving an empty
      // scene array). Recover the duration-based cap before the ready check;
      // otherwise Continue immediately returns an empty board forever.
      if (!done && !(Number(board.sceneCount) > 0)) {
        const recoveredCount = sceneCountFor(planTarget, avgScene);
        if (recoveredCount > 0) {
          board.sceneCount = recoveredCount;
          console.warn(`[director:${id}] recovered empty scene cap as ${recoveredCount} from ${planTarget}s / ${avgScene}s`);
        }
      }
      let remaining = board.sceneCount - done;
      if (timeCovered) {
        board.sceneCount = board.scenes.length;
        board.status = board.scenes.length ? "ready" : (board.blueprint ? "analyzed" : board.status);
        board.error = null;
        return { ready: true, board, write: true };
      }
      if (remaining <= 0) {
        if (!board.scenes.length) return { ready: true, board, write: false };
        // Recovery: finalized early by a premature complete=true (now
        // verified by verifyPlanComplete) while still owing timeline —
        // extend the cap from the remaining seconds instead of dead-ending
        // at x/x ready.
        const owed = Math.max(avgScene, planTarget > 0 ? planTarget - prog.plannedSeconds : avgScene);
        board.sceneCount = board.scenes.length + sceneCountFor(owed, avgScene);
        remaining = board.sceneCount - done;
        console.warn(`[director:${id}] reopened early-finalized plan (${done} scenes, ${prog.plannedSeconds}s/${planTarget || "?"}s) — cap extended to ${board.sceneCount}`);
        if (remaining <= 0) return { ready: true, board, write: false };
      }
      // planBatchHint: after a total stall the board remembers a small batch
      // size, so the next Continue goes straight to small batches instead of
      // failing a full batch again. Cleared on the next clean batch.
      const hinted = Math.floor(Number(board.planBatchHint));
      const hintCap = hinted >= 1 ? Math.min(hinted, SCENE_BATCH_MAX) : SCENE_BATCH;
      const wanted = Math.floor(Number(countOverride));
      // User-chosen batch size (AI Story Director UI dropdown): 1..SCENE_BATCH_MAX,
      // still capped by what is left of the plan. Falls back to the board's
      // stall hint, then to the default SCENE_BATCH when nothing was chosen.
      const n = Number.isFinite(wanted) && wanted >= SCENE_BATCH_MIN
        ? Math.min(wanted, SCENE_BATCH_MAX, remaining)
        : Math.min(hintCap, remaining);
      // This batch's time slice: cover ~n average-scenes worth of story,
      // never budgeting far past the remaining timeline.
      const remainingSecs = planTarget > 0 ? Math.max(0, planTarget - prog.plannedSeconds) : n * avgScene;
      const budget = planTarget > 0
        ? Math.max(avgScene, Math.min(n * avgScene, remainingSecs + avgScene / 2))
        : n * avgScene;
      const prevScene = done > 0 ? board.scenes[done - 1] : null;
      // Prior spoken lines so the prompt can forbid verbatim repeats (late
      // batches used to re-plan the opening and copy scene-1 dialogue).
      // Multi-shot scenes speak per shot, so shot lines count too.
      const priorDialogue = [];
      for (const s of board.scenes) {
        for (const d of (s.dialogue || [])) {
          if (d && d.line) priorDialogue.push(String(d.line));
        }
        for (const sh of (s.shots || [])) {
          for (const d of (sh.dialogue || [])) {
            if (d && d.line) priorDialogue.push(String(d.line));
          }
        }
      }
      // Line-by-line context: timed line list so the scene batch analyzes
      // its source lines in order. Songs use the lyric timing; stories get
      // the same word-proportional estimate over their story lines. The
      // batch receives only the lines overlapping its time window.
      let lyricTiming = [];
      let lineRange = [];
      // The approved-master slice for this batch (null without an approved
      // timeline) — declared out here so the return below sees it even when
      // the timing derivation above throws (it is best-effort).
      let masterTiming = null;
      let approvedApplied = false;
      let storedTimingUsable = false;
      // Storyboard Planner 2.0: the richer read-only 19-track context. Built
      // from the SAME approved master (never a second clock) and sliced to the
      // identical batch window as masterTiming above. Null => old prompt.
      let cinematicContext = null;
      try {
        const song = board.input && board.input.song;
        const transcriptSegments = Array.isArray(board.input?.songAnalysis?.transcript?.segments)
          ? board.input.songAnalysis.transcript.segments : [];
        const withWhisperTimes = (lines) => timeLinesFromTranscript(lines, transcriptSegments, planTarget);
        // A reviewed WhisperX import wins: it is the ONLY word-accurate,
        // user-approved timing on the board (a manual correction is marked
        // `manual` and must never be replaced by the plain estimate). It is
        // used ONLY while it still covers every line of the CURRENT story —
        // an edited story would otherwise be timed by stale windows, so it
        // falls back to the honest estimate instead (the Lyric panel flags
        // the stale timeline and asks for a re-import).
        // OPTIMIZATION: When an approved master timeline is present and covers
        // the current lines, skip the stored timing analysis entirely since
        // the approved master is the authoritative timing reference.
        const masterStored = board.lyric_timeline && board.lyric_timeline.master;
        const timingFresh = !lyricTimelineStale(board, board.lyric_timeline);
        const approvedMaster = timingFresh && masterStored && masterStored.approved
          && Array.isArray(masterStored.segments) && masterStored.segments.length
          ? masterStored : null;
        const currentLineIds = lyricTimelineSourceLines(board)
          .map((l) => Number(l.lyric_line_id)).filter((n) => Number.isFinite(n));
        let storedTiming = [];
        let storedCoversCurrent = false;
        storedTimingUsable = false;
        if (approvedMaster) {
          const approvedTiming = approvedMaster.segments
            .filter((s) => Number(s.lyric_line_id) > 0 && Number.isFinite(Number(s.start_seconds)) && Number(s.end_seconds) > Number(s.start_seconds))
            .map((s) => ({
              lyric_line_id: Number(s.lyric_line_id),
              lyric_text: String(s.lyric_text || ""),
              song_start_time: Number(s.start_seconds),
              song_end_time: Number(s.end_seconds),
              timing: s.timing_source === "manual" ? "manual" : "whisperx",
            }));
          const approvedIds = new Set(approvedTiming.map((l) => l.lyric_line_id));
          approvedApplied = currentLineIds.length > 0
            && currentLineIds.every((id) => approvedIds.has(id));
          if (!approvedApplied) {
            console.warn(`[director:${id}] approved master timeline does not cover every current source line; scene batches will use complete source-line timing instead`);
          }
          if (approvedApplied && approvedTiming.length) {
            lyricTiming = approvedTiming;
          }
        }
        if (!approvedApplied) {
          // Fall back to stored timeline analysis
          const storedTimeline = timingFresh && Array.isArray(board.lyric_timeline && board.lyric_timeline.lines)
            ? board.lyric_timeline.lines : [];
          storedTiming = storedTimeline
            .filter((l) => Number.isFinite(Number(l.start_seconds)) && Number.isFinite(Number(l.end_seconds)))
            .map((l) => ({
              lyric_line_id: Number(l.line_id) || 0,
              lyric_text: String(l.lyric_text || ""),
              song_start_time: Number(l.start_seconds),
              song_end_time: Number(l.end_seconds),
              timing: String(l.timing || "estimated"),
            }))
            .filter((l) => l.song_end_time > l.song_start_time);
          storedCoversCurrent = storedTiming.length > 0 && currentLineIds.length > 0
            && currentLineIds.every((id) => storedTiming.some((l) => l.lyric_line_id === id));
          const sourceOrderedTiming = [...storedTiming].sort((a, b) => a.lyric_line_id - b.lyric_line_id);
          const chronological = sourceOrderedTiming.every((line, i) => i === 0
            || line.song_start_time + 0.25 >= sourceOrderedTiming[i - 1].song_start_time);
          storedTimingUsable = storedCoversCurrent && chronological;
          if (storedCoversCurrent && !chronological) {
            console.warn(`[director:${id}] stored WhisperX line windows run backward in source order; using ordered source-line timing estimates`);
          }
          if (storedTimingUsable) {
            lyricTiming = storedTiming;
          }
        }
        // An APPROVED master timeline outranks even the raw stored windows:
        // the user reviewed and locked those segments (manual corrections
        // included), so they are the authoritative timing reference for scene
        // planning (priority: user-approved > validated alignment > estimate).
        // Its lyric-carrying segments become the timed line list, and the
        // batch prompt receives the approved slice (segments + clips) for
        // this batch's time window so the scenes are planned ON the timeline.
        // (lyricTiming and approvedApplied already set above)
        const winFrom = prog.plannedSeconds;
        const winTo = prog.plannedSeconds + budget;
        const inWin = (t) => Number(t.end_seconds ?? t.end) > winFrom - 0.001
          && Number(t.start_seconds ?? t.start) < winTo + 0.001;
        // A partial approved timeline cannot drive batching: otherwise the
        // scene planner may receive only the covered subset (or conflicting
        // instrumental/unknown labels) while omitting source lines. It is an
        // authority only when every current source line is represented.
        if (approvedApplied && approvedMaster) {
          const slimSegs = approvedMaster.segments.filter(inWin).map((s) => ({
            segment_id: s.segment_id, type: s.type,
            start_seconds: Number(s.start_seconds), end_seconds: Number(s.end_seconds),
            lyric_text: s.lyric_text, character_id: s.character_id, action: s.action,
            repeat_group: s.repeat_group || null,
          }));
          if (slimSegs.length) {
            masterTiming = {
              approved_at: approvedMaster.approved || null,
              duration_seconds: Number(approvedMaster.duration_seconds) || null,
              from: winFrom, to: winTo,
              segments: slimSegs,
              clips: arr(approvedMaster.clips).filter(inWin).map((c) => ({
                clip_id: c.clip_id, kind: c.kind,
                start_seconds: Number(c.start_seconds), end_seconds: Number(c.end_seconds),
              })),
            };
          }
        }
        if (approvedApplied) {
          // Complete approved timelines are the exact timing authority.
        } else if (storedTimingUsable) {
          lyricTiming = storedTiming;
        } else if (song && song.hasLyrics !== false) {
          const parsed = parseLyricLines(board.input.story);
          if (parsed.length) {
            // Prefer the bible's own line analysis when present; fall back
            // to the parsed lines so timing always exists.
            const bibleLines = Array.isArray(board.blueprint.lyric_lines) && board.blueprint.lyric_lines.length
              ? board.blueprint.lyric_lines
              : parsed;
            const timedBible = withWhisperTimes(bibleLines);
            const timedParsed = timedBible.length ? timedBible : withWhisperTimes(parsed);
            lyricTiming = timedParsed.length ? timedParsed : estimateLyricTiming(
              bibleLines,
              song.durationSeconds || board.input.targetSeconds);
          }
        } else if (planTarget > 0) {
          const storyLines = parseLyricLines(board.input.story || "");
          if (storyLines.length) {
            const timedStory = withWhisperTimes(storyLines);
            lyricTiming = timedStory.length ? timedStory : estimateLyricTiming(storyLines, planTarget);
          }
        }
        if (lyricTiming.length && planTarget > 0) {
          lineRange = linesForTimeWindow(lyricTiming, prog.plannedSeconds, prog.plannedSeconds + budget);
          if (!lineRange.length) lineRange = lyricTiming.slice();
        }
      } catch { /* line timing is best-effort; the batch runs without it */ }
      // Best-effort additive context: a board WITHOUT an approved timeline
      // keeps the historical prompt byte-for-byte (normalize is read-only).
      try {
        const sbTimeline = normalizeStoryboardTimeline({ board });
        if (sbTimeline.available) {
          const ctx = storyboardBatchContext({
            board,
            timeline: sbTimeline,
            from: prog.plannedSeconds,
            to: prog.plannedSeconds + budget,
          });
          cinematicContext = buildStoryboardPromptBlock(ctx);
        }
      } catch (e) {
        console.warn(`[director:${id}] cinematic context skipped: ${String(e?.message || e).slice(0, 160)}`);
      }
      // masterTiming stays the LAST field: existing wiring tests pin that
      // exact tail, and the planning engine still reads it the same way.
      return { ready: false, done, planTarget, prog, avgScene, remaining, n, budget, prevScene, priorDialogue, lyricTiming, lineRange, cinematicContext, masterTiming };
    };
    // -----------------------------------------------------------------------
    // Storyboard Planner 2.0 — READ-ONLY views over the SAME board and the
    // SAME approved timeline. No route here writes the board, moves a window,
    // approves anything, or starts a run. They power the cinematic workspace
    // without giving it a second planning engine.
    // -----------------------------------------------------------------------
    // Canonical asset map used by the Characters & World panel.
    if (p.match(/^\/api\/director\/boards\/[^/]+\/assets$/) && req.method === "GET") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      const board = readDirectorBoard(id);
      const bp = board.blueprint || {};
      const dupes = [ ...findDuplicateAssets(bp.characters), ...findDuplicateAssets(bp.locations), ...findDuplicateAssets(bp.objects) ];
      return json(res, 200, {
        board_id: id, map: buildAssetReferenceMap(board), duplicates: dupes,
        styleGuide: buildVisualStyleGuide(board), issues: validateAssetContinuity(board),
        production: directorAssetWithVersions(id, getBoardAssetState(board)),
      });
    }    // ---- WhisperX lyric timeline (Story / Song) -------------------------
    // The transcript is ANNOTATIVE: it supplies MEASURED timing for the audio,
    // while the user's own lyric text stays authoritative and is never
    // replaced by what the model heard. Stored on the board JSON (no schema
    // migration), exactly like `semantics`, so it survives reloads and rides
    // the normal board mirror.
    //
    // GET  -> the stored timeline (+ the board's own parsed lyric lines)
    // POST -> import a WhisperX export { segments:[{start,end,text,words}] }
    // PUT  -> apply the review panel's manual corrections
    if ((p.match(/^\/api\/director\/boards\/[^/]+\/master-timeline$/) || p.match(/^\/api\/director\/boards\/[^/]+\/lyric-timeline$/)) && req.method === "GET") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      const board = readDirectorBoard(id);
      // Scene ownership (and the action link) is DERIVED from the CURRENT
      // scene plan + semantics, so it is recomputed on read — a board that was
      // re-planned after the import must not show a stale scene map.
      const timeline = board.lyric_timeline && Array.isArray(board.lyric_timeline.lines)
        ? {
          ...board.lyric_timeline,
          actions: buildLyricActionTimeline(
            board.lyric_timeline.lines,
            (board.semantics && board.semantics.lines) || [],
            { scenes: board.scenes || [] },
          ),
          scene_map: assignLyricLinesToScenes(board.lyric_timeline.lines, board.scenes || []),
        }
        : null;
      const duration = lyricTimelineDuration(board);
      const lyricLines = lyricTimelineSourceLines(board);
      const master = masterViewForBoard(board, board.lyric_timeline);
      if (master) master.clips = planTimelineClips(master);
      let directorSegments = null;
      let directorSegmentsError = null;
      if (timeline?.whisper?.segments?.length) {
        try { directorSegments = splitWhisperTranscript({ segments: timeline.whisper.segments }); }
        catch (e) { directorSegmentsError = String(e?.message || e); }
      }
      return json(res, 200, {
        board_id: id,
        timeline,
        lyric_lines: lyricLines,
        // The master timeline: chronological segments + clips covering the WHOLE
        // audio (null until the board has an analyzed lyric timeline).
        master,
        segment_types: MASTER_SEGMENT_TYPES,
        clip_bounds: { min: MASTER_CLIP_MIN, max: MASTER_CLIP_MAX },
        characters: castForBoard(board).map((c) => ({
          character_id: mstr(c.character_id ?? c.id ?? c.name),
          name: mstr(c.name),
          visual_identity_prompt: mstr(c.visual_identity_prompt),
        })),
        // The panel must say so honestly when the stored windows no longer
        // belong to the current story (the planner ignores them too).
        stale: lyricTimelineStale(board, timeline),
        duration_seconds: duration,
        whisperx_audio_url: board.input?.whisperxAudio?.file
          ? `/api/director/boards/${encodeURIComponent(id)}/audio-file`
          : null,
        validation: timeline
          ? validateLyricTimeline(timeline, { duration })
          : { ok: true, errors: [], warnings: [], stats: {} },
        director_segments: directorSegments,
        director_segments_error: directorSegmentsError,
      });
    }
    if (p.match(/^\/api\/director\/boards\/[^/]+\/whisperx\/director-segments$/) && req.method === "GET") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      const board = readDirectorBoard(id);
      const source = board.lyric_timeline?.whisper;
      if (!source || !Array.isArray(source.segments) || !source.segments.length) {
        return json(res, 409, { error: "complete WhisperX analysis before exporting director segments" });
      }
      const plan = splitWhisperTranscript(source);
      if (!plan.validation.ok || !plan.text_preserved) {
        return json(res, 422, { error: "segment validation failed", validation: plan.validation });
      }
      const format = new URL(req.url, `http://${req.headers.host || "localhost"}`).searchParams.get("format") || "json";
      if (format === "srt") {
        res.writeHead(200, {
          "Content-Type": "application/x-subrip; charset=utf-8",
          "Content-Disposition": `attachment; filename="${id}_director_segments.srt"`,
          "Cache-Control": "no-store",
        });
        res.end(directorSegmentsToSrt(plan.segments));
        return;
      }
      if (format !== "json") return json(res, 400, { error: "format must be json or srt" });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${id}_director_segments.json"`,
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(plan, null, 2));
      return;
    }
    if ((p.match(/^\/api\/director\/boards\/[^/]+\/whisper-import$/) || p.match(/^\/api\/director\/boards\/[^/]+\/import-whisper$/) || p.match(/^\/api\/director\/boards\/[^/]+\/master-timeline\/import$/)) && req.method === "POST") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      const board = readDirectorBoard(id);
      const body = await readJson(req).catch(() => ({}));
      const payload = body && (body.whisper || body.data || body);
      if (!payload || typeof payload !== "object") {
        return json(res, 400, { error: "expected a WhisperX JSON object ({ segments: [...] })" });
      }
      // Lyrics come from the board (bible analysis, else the pasted story) —
      // the import NEVER writes lyric text.
      const lines = lyricTimelineSourceLines(board);
      if (!lines.length) {
        return json(res, 400, { error: "this board has no lyrics/story lines to align — paste them and analyze the story first" });
      }
      const duration = lyricTimelineDuration(board);
      const language = String(body.language || (board.input && board.input.semanticsLanguage) || "auto");
      const timeline = buildLyricTimeline({
        lyrics: lines,
        whisper: payload,
        duration,
        language,
        semantics: (board.semantics && board.semantics.lines) || [],
        scenes: board.scenes || [],
        // Manual corrections already on the board outrank the fresh import.
        previous: board.lyric_timeline || null,
      });
      if (!timeline.whisper.stats.segments) {
        return json(res, 400, { error: "the WhisperX payload has no usable segments", warnings: timeline.warnings });
      }
      timeline.analysis_id = "import_" + Date.now().toString(36) + "_" + crypto.randomUUID().slice(0, 8);
      board.lyric_timeline = timeline;
      // The master timeline: derived rows + the vocal-activity source it used.
      try {
        const master = masterViewForBoard(board, timeline);
        if (master) board.lyric_timeline.master = master;
      } catch (e) { console.warn("[master-timeline] derive failed:", e.message); }
      const exportInfo = persistWavAnalysis(board, payload);
      const saved = writeDirectorBoard(board);
      return json(res, 200, {
        board_id: id,
        timeline: saved.lyric_timeline,
        master: saved.lyric_timeline.master || null,
        stale: lyricTimelineStale(saved, saved.lyric_timeline),
        validation: saved.lyric_timeline.validation,
        warnings: saved.lyric_timeline.warnings,
        export: exportInfo,
      });
    }
    if ((p.match(/^\/api\/director\/boards\/[^/]+\/master-timeline$/) || p.match(/^\/api\/director\/boards\/[^/]+\/lyric-timeline$/)) && req.method === "PUT") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      const board = readDirectorBoard(id);
      const current = board.lyric_timeline;
      if (!current || !Array.isArray(current.lines)) {
        return json(res, 409, { error: "import a WhisperX timeline first" });
      }
      const body = await readJson(req).catch(() => ({}));
      const corrections = Array.isArray(body.corrections) ? body.corrections : [];
      const segCorrections = Array.isArray(body.segment_corrections)
        ? body.segment_corrections
        : corrections.filter((c) => c && typeof c === "object" && mstr(c.segment_id));
      const lineCorrections = corrections.filter((c) => !(c && typeof c === "object" && c.segment_id));
      const unlock = body.unlock === true;
      const existing = current.master || null;
      const approved = existing && existing.approved;
      if (!corrections.length && !segCorrections.length) {
        return json(res, 400, { error: "no corrections supplied" });
      }
      // An approved timeline refuses corrections until an explicit unlock —
      // approved timings are never silently modified.
      if (approved && segCorrections.length && !unlock) {
        return json(res, 409, {
          error: "this master timeline is approved — unlock it before correcting it",
          approved: approved,
        });
      }
      const duration = lyricTimelineDuration(board);
      const timeline = lineCorrections.length
        ? applyLyricCorrections(current, lineCorrections)
        : current;
      timeline.validation = validateLyricTimeline(timeline, { duration });
      // Manual timing changes scene ownership — recompute the Director link.
      timeline.actions = buildLyricActionTimeline(timeline.lines, (board.semantics && board.semantics.lines) || [], { scenes: board.scenes || [] });
      timeline.scene_map = assignLyricLinesToScenes(timeline.lines, board.scenes || []);
      // Master: rebuild from the corrected lyric timeline, re-apply ALL stored
      // segment corrections, then apply the fresh ones on top.
      let master = masterViewForBoard({ ...board, lyric_timeline: timeline }, timeline) || null;
      if (segCorrections.length && master) {
        // `approved + unlock` releases the approval inside the same call —
        // correcting an unlocked approved timeline is an explicit re-open.
        const applied = applyMasterCorrections(
          master,
          [...arr(existing && existing.corrections).filter(Boolean), ...segCorrections],
          { approved: Boolean(approved), unlock: true },
        );
        // Rebuild carries the corrections forward: the stored list re-applies
        // on every later GET.
        master = applied.timeline;
        master.corrections = [...arr(existing && existing.corrections).filter(Boolean), ...segCorrections];
      } else if (master && existing) {
        master.corrections = arr(existing.corrections).filter(Boolean);
      }
      if (master) {
        if (approved && !unlock) {
          master.approved = approved;
        }
        master.validation = validateMasterTimeline(master, { duration });
        master.clips = planTimelineClips(master);
        board.lyric_timeline = { ...timeline, master };
      } else {
        board.lyric_timeline = timeline;
      }
      persistWavAnalysis(board);
      const saved = writeDirectorBoard(board);
      return json(res, 200, {
        board_id: id,
        timeline: saved.lyric_timeline,
        master: saved.lyric_timeline.master,
        clips: saved.lyric_timeline.master ? saved.lyric_timeline.master.clips : null,
        stale: lyricTimelineStale(saved, saved.lyric_timeline),
        validation: saved.lyric_timeline.validation,
      });
    }

    // ---- Master timeline: approval gate ------------------------------------
    // Explicit approve BEFORE any clip generation; explicit unlock to edit.
    if (p.match(/^\/api\/director\/boards\/[^/]+\/master-timeline\/approve$/) && req.method === "POST") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      const board = readDirectorBoard(id);
      const view = masterViewForBoard(board);
      if (!view) return json(res, 409, { error: "no master timeline to approve — analyze the audio first" });
      const gate = approveMasterTimeline(view);
      if (!gate.approved) {
        return json(res, 400, { error: gate.error || "timeline validation failed", errors: gate.errors });
      }
      gate.timeline.clips = planTimelineClips(gate.timeline);
      persistMaster(board, gate.timeline);
      return json(res, 200, { board_id: id, approved: true, approved_at: gate.timeline.approved, master: gate.timeline, clips: gate.timeline.clips });
    }
    if (p.match(/^\/api\/director\/boards\/[^/]+\/master-timeline\/unlock$/) && req.method === "POST") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      const board = readDirectorBoard(id);
      const current = board.lyric_timeline && board.lyric_timeline.master;
      if (!current || !current.approved) return json(res, 409, { error: "the timeline is not approved" });
      const opened = unlockMasterTimeline(current);
      persistMaster(board, opened.timeline);
      return json(res, 200, { board_id: id, approved: false, master: opened.timeline });
    }

    // ---- Master timeline: scene-clip generation ----------------------------
    // From the APPROVED timeline only: 3–5 s clips with clip-relative action
    // times → the canonical scenario config → the user saves + starts the
    // standard pipeline run (resumable, per-beat). Timing arrives pre-filled.
    if (p.match(/^\/api\/director\/boards\/[^/]+\/master-timeline\/generate$/) && req.method === "POST") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      const board = readDirectorBoard(id);
      const view = masterViewForBoard(board);
      if (!view) return json(res, 409, { error: "no master timeline — analyze the audio first" });
      if (!view.approved) return json(res, 409, { error: "approve the master timeline before generating clips", approved: false });
      const clips = planTimelineClips(view);
      if (!clips.length) return json(res, 400, { error: "the timeline produced no clips (empty or sub-min length)" });
      const identityOf = characterIdentityOf(board);
      const styles = view.segments.map((s) => arr(s.style_refs)).flat();
      const styleRefs = [...new Set(styles)].filter(Boolean);
      const firstIdentity = clips.map((c) => identityOf(c.character_id)).filter(Boolean)[0] || "";
      const raw = timelineClipsToStoryboard(clips, {
        title: mstr(board.input && board.input.title).slice(0, 100) || "Song Timeline",
        description: mstr(board.input && board.input.story).slice(0, 600),
        referencePrompt: firstIdentity
          ? `${firstIdentity}. main character of "${mstr(board.input && board.input.title) || "the song"}"`
          : "main character of the song timeline",
        characterIdentity: identityOf,
        styleRefs,
      });
      // The canonical config via the SAME import path the board approve uses.
      const config = storyboardToScenario(raw);
      const approveTitle = mstr(board.input && board.input.title).slice(0, 120);
      let target = board.scenarioName || spaceFreeName(approveTitle) || id;
      if (approveTitle) config.display_name = approveTitle;
      if (!board.scenarioName) {
        try {
          const taken = new Set((await dbListScenarios()).map((r) => r.name));
          if (taken.has(target)) {
            for (let i = 2; ; i++) {
              if (!taken.has(`${target}_${i}`)) { target = `${target}_${i}`; break; }
            }
          }
        } catch { /* name check is best-effort; save enforces uniqueness */ }
      }
      try {
        const pid = await pgProjectId(target);
        board.project_id = pid;
      } catch { /* link is best-effort */ }
      board.error = null;
      board.scenarioName = target;
      board.timelineScenario = target;
      writeDirectorBoard(board);
      return json(res, 200, {
        name: target,
        config,
        clips,
        clip_count: clips.length,
        note: "the client saves this config via the standard scenario PUT and starts the run — no timestamps to enter by hand",
      });
    }

    // ---- Master timeline: the uploaded audio, served back for the player ---
    if (p.match(/^\/api\/director\/boards\/[^/]+\/audio-file$/) && req.method === "GET") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      const board = readDirectorBoard(id);
      const file = board.input && board.input.whisperxAudio && board.input.whisperxAudio.file;
      if (!file || !/\.wav$|\.mp3$|\.m4a$/i.test(file)) return json(res, 404, { error: "no uploaded audio" });
      const full = path.join(WHISPERX_UPLOADS, file);
      if (!fs.existsSync(full)) return json(res, 404, { error: "audio file missing" });
      res.writeHead(200, {
        "Content-Type": file.toLowerCase().endsWith(".wav") ? "audio/wav" : "audio/mpeg",
        "Cache-Control": "no-store",
      });
      fs.createReadStream(full).pipe(res);
      return;
    }

    // WhisperX audio upload for a board
    if (p.match(/^\/api\/director\/boards\/[^/]+\/audio-upload$/) && req.method === "POST") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      const board = readDirectorBoard(id);
      const body = await readJson(req);
      if (typeof body.data !== "string") return json(res, 400, { error: "data (base64) required" });
      const m = body.data.match(/^data:(audio\/[\w.+-]+);base64,(.+)$/s);
      if (!m) return json(res, 400, { error: "expected a data:audio/* base64 payload (mp3 or wav)" });
      const mime = m[1].toLowerCase();
      const ext = mime.includes("wav") ? ".wav" : mime.includes("mp4") || mime.includes("m4a") ? ".m4a"
        : mime.includes("mpeg") || mime.includes("mp3") ? ".mp3" : null;
      if (!ext) return json(res, 400, { error: `unsupported audio type ${mime} — upload mp3 or wav` });
      const buf = Buffer.from(m[2], "base64");
      if (!buf.length) return json(res, 400, { error: "empty file" });
      // validate WAV if wav
      if (ext === ".wav") {
        // basic RIFF/WAVE check
        if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
          return json(res, 400, { error: "invalid WAV file" });
        }
      }
      fs.mkdirSync(WHISPERX_UPLOADS, { recursive: true });
      const file = `wx_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}${ext}`;
      const full = path.join(WHISPERX_UPLOADS, file);
      fs.writeFileSync(full, buf);
      const durationSeconds = await videoDurationSec(full);
      if (durationSeconds == null) {
        try { fs.unlinkSync(full); } catch {}
        return json(res, 400, { error: "could not read audio duration — is it a valid audio file?" });
      }
      // attach to board
      board.input = board.input || {};
      board.input.whisperxAudio = {
        file,
        fileName: String(body.fileName || "audio").slice(0, 120),
        durationSeconds: Math.round(durationSeconds * 1000) / 1000,
        uploadedAt: new Date().toISOString(),
      };
      // The same source audio is also the final soundtrack for Story/Song.
      // Keep the WhisperX working copy in its own directory and a safe handle
      // in director/ so the shared scenario renderer can mux it at final stitch.
      fs.mkdirSync(DIRECTOR, { recursive: true });
      const soundtrackFile = `wx_master_${crypto.randomUUID().replace(/-/g, "")}${ext}`;
      fs.copyFileSync(full, path.join(DIRECTOR, soundtrackFile));
      board.input.sourceAudio = {
        file: soundtrackFile,
        fileName: String(body.fileName || "audio").slice(0, 120),
        durationSeconds: Math.round(durationSeconds * 1000) / 1000,
      };
      // A new recording invalidates any previous alignment and becomes the
      // timing target for the storyboard that will be planned from it.
      delete board.lyric_timeline;
      board.input.targetSeconds = Math.max(0.001, Math.min(3600, durationSeconds));
      board.sceneCount = Math.max(board.scenes?.length || 0, sceneCountFor(board.input.targetSeconds, board.input.sceneSeconds));
      writeDirectorBoard(board);
      return json(res, 200, {
        file,
        fileName: String(body.fileName || "audio").slice(0, 120),
        durationSeconds: Math.round(durationSeconds * 1000) / 1000,
        sizeBytes: buf.length,
        valid: true,
        soundtrackAttached: true,
      });
    }

    // Start WhisperX analysis
    if (p.match(/^\/api\/director\/boards\/[^/]+\/whisperx\/analyze$/) && req.method === "POST") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      const board = readDirectorBoard(id);
      const body = await readJson(req).catch(() => ({}));
      const audio = board.input?.whisperxAudio;
      if (!audio || !audio.file) return json(res, 400, { error: "upload audio first" });
      const audioPath = path.join(WHISPERX_UPLOADS, audio.file);
      if (!fs.existsSync(audioPath)) return json(res, 400, { error: "audio file missing" });
      const active = whisperxActiveJob();
      if (active && active.boardId === id) {
        // Idempotent: a second Analyze click ATTACHES to the job already
        // transcribing this board instead of spawning a competing process
        // (which used to surface as a bare HTTP 409 in the browser console).
        return json(res, 200, {
          jobId: active.id,
          status: active.status,
          alreadyRunning: true,
          stage: active.stage || "queued",
        });
      }
      if (active) return json(res, 409, {
        error: `WhisperX analysis already running on another board (job ${active.id}, ${active.stage || "queued"}) — wait for it to finish or cancel it first.`,
        jobId: active.id,
      });
      const jobId = `wx_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
      const jobDir = path.join(WHISPERX_JOBS, jobId);
      fs.mkdirSync(jobDir, { recursive: true });
      const job = {
        id: jobId,
        boardId: id,
        status: "pending",
        progress: 0,
        stage: "queued",
        message: "queued",
        createdAt: Date.now(),
        cancelled: false,
        proc: null,
      };
      whisperxJobs.set(jobId, job);
      fs.writeFileSync(path.join(jobDir, "job.json"), JSON.stringify({ ...job, proc: undefined }, null, 2));

      // Start async job
      setImmediate(async () => {
        try {
          job.status = "running";
          job.stage = "preflight";
          job.progress = 5;
          const pf = await whisperxPreflightCheck();
          if (!pf.ok) {
            job.status = "failed";
            job.error = "WhisperX preflight failed";
            job.message = JSON.stringify(pf.checks);
            fs.writeFileSync(path.join(jobDir, "job.json"), JSON.stringify({ ...job, proc: undefined }, null, 2));
            return;
          }
          job.stage = "transcribing";
          job.progress = 20;
          fs.writeFileSync(path.join(jobDir, "job.json"), JSON.stringify({ ...job, proc: undefined }, null, 2));
          const python = process.env.WHISPERX_PYTHON || process.env.PYTHON || "python";
          const model = process.env.WHISPERX_MODEL || "large-v2";
          const device = process.env.WHISPERX_DEVICE || "cuda";
          const batchSize = process.env.WHISPERX_BATCH_SIZE || "16";
          const computeType = process.env.WHISPERX_COMPUTE_TYPE || "float16";
          const language = body.language || board.input?.semanticsLanguage || "auto";
          const outJson = path.join(jobDir, "result.json");
          // Try to call whisperx CLI if configured, else use python module via
          // ONE embedded script. The script also runs a separate VOICE-ACTIVITY
          // pass (whisperx's own VAD when importable) so the master timeline
          // never derives instrumental-versus-vocal from the transcript words.
          const whisperxCmd = process.env.WHISPERX_CMD;
          let args = [];
          let script = null;
          if (whisperxCmd) {
            args = [audioPath, "--model", model, "--device", device, "--batch_size", batchSize, "--compute_type", computeType, "--output_dir", jobDir, "--output_format", "json"];
            if (language && language !== "auto") args.push("--language", language);
          }
          if (!whisperxCmd) {
            script = `
import json,sys,os
sys.stdout.reconfigure(encoding="utf-8", errors="replace")   # Windows 'charmap' stdout cannot encode Devanagari transcript lines
sys.stderr.reconfigure(encoding="utf-8", errors="replace")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")  # our own [wx] lines replace hf's bar spam
import warnings
# pyannote's optional torchcodec decoder is NOT used here: WhisperX decodes via
# ffmpeg and VAD gets a preloaded waveform. Its missing native DLLs are noise.
warnings.filterwarnings("ignore", category=UserWarning, module="pyannote.audio.core.io")
warnings.filterwarnings("ignore", category=UserWarning, module="lightning")
warnings.filterwarnings("ignore", message="TensorFloat-32")
warnings.filterwarnings("ignore", message="Xet Storage is enabled")
warnings.filterwarnings("ignore", message=".*cache-system uses symlinks")
def say(msg):
  # flushed immediately so the node-side job log streams it live to the UI
  print(msg, flush=True)
def transcribe_batched(model, audio, batch_size, lang):
  # A big batch can exhaust VRAM on the shared GPU. Halve it on an OOM instead
  # of failing the whole analysis — the audio clock/timings stay identical.
  bs = max(1, int(batch_size))
  while True:
    try:
      return model.transcribe(audio, batch_size=bs, language=None if lang == 'auto' else lang)
    except Exception as e:
      msg = str(e).lower()
      retryable = ('out of memory' in msg or 'alloc_failed' in msg
                   or 'cuda error' in msg or 'bad_alloc' in msg)
      if not retryable or bs <= 1:
        raise
      say('[wx] batch %d hit a memory error — retrying at batch %d' % (bs, max(1, bs // 2)))
      bs = max(1, bs // 2)
def prefetch_progress(model_name, say):
  # Best-effort PRE-DOWNLOAD of the model with live progress lines: hf_hub's
  # own tqdm bars are disabled on non-TTY pipes, so a first-run download
  # otherwise looks like a silent hang. On ANY failure we fall back silently —
  # load_model below downloads/loads exactly as before.
  try:
    import threading, time, glob
    import huggingface_hub as hfhub
    repo = "Systran/faster-whisper-" + model_name
    info = hfhub.HfApi().repo_info(repo, files_metadata=True)
    total = sum((s.size or 0) for s in (info.siblings or []))
    if not total:
      return
    state = {"err": None}
    def dl():
      try:
        hfhub.snapshot_download(repo_id=repo)
      except Exception as e:
        state["err"] = str(e)
    t = threading.Thread(target=dl, daemon=True)
    t.start()
    blobs = os.path.join(hfhub.constants.HF_HUB_CACHE, "models--" + repo.replace("/", "--"), "blobs")
    def got_bytes():
      got = 0
      for fn in os.listdir(blobs):
        try:
          got += os.path.getsize(os.path.join(blobs, fn))
        except OSError:
          pass
      return got
    time.sleep(1)
    if not t.is_alive() and not state["err"]:
      say("[wx] model %s already cached" % model_name)
      return
    lastp = -5
    while t.is_alive():
      time.sleep(3)
      pct = int(100 * got_bytes() / total)
      if pct >= lastp + 2:
        lastp = pct
        say("[wx] downloading model %s: %d%% (%.1f / %.1f GB)" % (model_name, min(99, pct), got_bytes()/1e9, total/1e9))
    if state["err"]:
      say("[wx] model prefetch failed, load_model will retry: " + state["err"][:200])
    else:
      say("[wx] model download complete")
  except Exception as e:
    say("[wx] download progress unavailable: " + str(e)[:200])
try:
  import whisperx
  audio=sys.argv[1]; model_name=sys.argv[2]; device=sys.argv[3]; batch_size=int(sys.argv[4]); compute_type=sys.argv[5]; outdir=sys.argv[6]; lang=sys.argv[7]
  say("[wx] loading model "+model_name+" on "+device+" ...")
  prefetch_progress(model_name, say)
  model=whisperx.load_model(model_name,device=device,compute_type=compute_type)
  say("[wx] decoding audio ...")
  audio_loaded=whisperx.load_audio(audio)
  say("[wx] transcribing (batch "+str(batch_size)+") ...")
  res=transcribe_batched(model,audio_loaded,batch_size,lang)
  segs=list(res.get("segments") or [])
  say("[wx] transcript: "+str(len(segs))+" segments")
  for s in segs:
    txt=" ".join(str(s.get("text","")).split())
    if txt:
      say("[wx] %s - %ss  %s" % (round(float(s.get("start",0)),1), round(float(s.get("end",0)),1), txt))
  say("[wx] aligning words ...")
  model_a,metadata=whisperx.load_align_model(language_code=res["language"],device=device)
  res=whisperx.align(res["segments"],model_a,metadata,audio_loaded,device,return_char_alignments=False)
  # Voice-activity pass, SEPARATE from the transcript: whisperx's VAD model
  # (silero/pyannote) when importable. Served feedback on failure — the
  # node-side energy fallback covers the rest, so "vocal vs instrumental"
  # evidence is never faked here.
  va={"status":"unavailable","method":"none","segments":[],"note":""}
  try:
    from whisperx import vad as wx_vad
    import torch
    vad_model = wx_vad.load_vad_model(torch.device(device), use_auth_token=None)
    wav16 = whisperx.load_audio(audio, sr=16000)
    chunks = vad_model({"waveform": wav16, "sample_rate": 16000}).get("chunks", [])
    va={"status":"ok","method":"whisperx-vad","segments":[
      {"start":float(c.get("start",0)),"end":float(c.get("end",0)),"activity":"vocal"} for c in chunks if "start" in c and "end" in c
    ]}
  except Exception as _ve:
    va["note"]=str(_ve)[:300]
  res["vocal_activity"]=va
  os.makedirs(outdir,exist_ok=True)
  say("[wx] writing result ...")
  with open(os.path.join(outdir,'result.json'),'w',encoding='utf-8') as f:
    json.dump(res,f,ensure_ascii=False)
  say("done")
except Exception as e:
  import traceback
  lines = traceback.format_exc().strip().splitlines()
  reason = lines[-1] if lines else str(e)
  print('ERR %s: %s' % (type(e).__name__, reason[:400]), flush=True)
  sys.exit(1)
`;
          }
          job.progress = 40;
          fs.writeFileSync(path.join(jobDir, "job.json"), JSON.stringify({ ...job, proc: undefined }, null, 2));
          const spawnArgs = whisperxCmd
            ? args
            : ["-c", script, audioPath, model, device, batchSize, computeType, jobDir, language];
          const proc = spawn(whisperxCmd || python, spawnArgs, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
          job.proc = proc;
          // A wrong WHISPERX_PYTHON path emits 'error' (ENOENT). Without this
          // listener Node treats it as unhandled and the whole API dies — the
          // HTTP 500 the UI showed. Fail the JOB honestly instead.
          proc.on("error", (e) => {
            job.status = "failed";
            job.error = `WhisperX could not start: ${e.message} (interpreter: ${whisperxCmd || python})`;
            job.proc = null;
            try { fs.writeFileSync(path.join(jobDir, "job.json"), JSON.stringify({ ...job, proc: undefined }, null, 2)); } catch {}
          });
          let out = "", err = "";
          // Rolling process log (stdout + stderr) streamed live to the status
          // poll — the UI renders it under the analyzing progress bar.
          job.log = "";
          const appendLog = (d) => { job.log = ((job.log || "") + d.toString()).slice(-8000); };
          proc.stdout.on("data", (d) => { out += d.toString(); appendLog(d); job.message = out.slice(-200);
            // A model download line maps its percent onto the 10–40% band so
            // the bar moves during a first-run download instead of sitting still.
            const m = out.match(/downloading model \S+: (\d+)%/g);
            if (m) {
              const pct = parseInt(m[m.length - 1].match(/(\d+)%/)[1], 10);
              job.progress = Math.max(job.progress, 10 + Math.round(pct * 0.3));
            } else {
              job.progress = Math.min(90, job.progress + 5);
            }
          });
          proc.stderr.on("data", (d) => { err += d.toString(); appendLog(d); job.message = err.slice(-200); });
          proc.on("close", async (code) => {
            job.proc = null;
            if (job.status === "failed") return; // spawn 'error' already reported it
            if (job.cancelled) {
              job.status = "cancelled";
              fs.writeFileSync(path.join(jobDir, "job.json"), JSON.stringify({ ...job, proc: undefined }, null, 2));
              return;
            }
            if (code !== 0) {
              job.status = "failed";
              // Prefer the script's own "ERR <reason>" line; otherwise the last
              // real exception line. A stderr tail of warnings is NOT a reason.
              const lines = (out + "\n" + err).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
              const errLine = lines.filter((l) => l.startsWith("ERR ")).pop()
                || lines.filter((l) => /^(RuntimeError|OutOfMemoryError|AssertionError|CUDA|ValueError|KeyError|TypeError|ModuleNotFoundError|OSError|subprocess\.CalledProcessError|torch\.)/.test(l)).pop();
              job.error = (errLine || err.slice(-500) || `WhisperX exited ${code}`).slice(0, 500);
              fs.writeFileSync(path.join(jobDir, "job.json"), JSON.stringify({ ...job, proc: undefined }, null, 2));
              return;
            }
            try {
              job.stage = "importing";
              job.progress = 95;
              if (!fs.existsSync(outJson)) {
                const cliJson = fs.readdirSync(jobDir).filter((name) => name.toLowerCase().endsWith(".json") && name !== "job.json").sort()[0];
                if (cliJson) fs.copyFileSync(path.join(jobDir, cliJson), outJson);
              }
              if (!fs.existsSync(outJson)) throw new Error("WhisperX completed but did not produce a JSON transcript");
              const result = JSON.parse(fs.readFileSync(outJson, "utf8"));
              // import into board
              const lines = lyricTimelineSourceLines(board);
              if (!lines.length) throw new Error("no lyrics/story lines on board");
              const duration = lyricTimelineDuration(board);
              const timeline = buildLyricTimeline({
                lyrics: lines,
                whisper: result,
                duration,
                language,
                semantics: (board.semantics && board.semantics.lines) || [],
                scenes: board.scenes || [],
                previous: board.lyric_timeline || null,
              });
              timeline.analysis_id = jobId;
              // Vocal activity: the WhisperX VAD pass when the script emitted
              // it, else the honest node-side energy/silence estimate decoded
              // locally (never derived from the transcript words).
              let activity = result && result.vocal_activity
                && Array.isArray(result.vocal_activity.segments)
                && result.vocal_activity.segments.length ? result.vocal_activity : null;
              if (!activity) {
                try {
                  const measured = await analyzeDirectorAudio(audioPath);
                  activity = measured && measured.vocalActivity && measured.vocalActivity.segments
                    && measured.vocalActivity.segments.length ? measured.vocalActivity : null;
                } catch (e) { console.warn("[whisperx] audio activity fallback failed:", e.message); }
              }
              timeline.vocal_activity = activity || null;
              board.lyric_timeline = timeline;
              try {
                const master = masterViewForBoard(board, timeline);
                if (master) board.lyric_timeline.master = master;
              } catch (e) { console.warn("[master-timeline] derive failed:", e.message); }
              job.export = persistWavAnalysis(board, result);
              writeDirectorBoard(board);
              job.status = "succeeded";
              job.progress = 100;
              job.timeline = timeline;
              job.message = "done";
            } catch (e) {
              job.status = "failed";
              job.error = e.message;
            }
            fs.writeFileSync(path.join(jobDir, "job.json"), JSON.stringify({ ...job, proc: undefined }, null, 2));
          });
        } catch (e) {
          job.status = "failed";
          job.error = e.message;
          fs.writeFileSync(path.join(jobDir, "job.json"), JSON.stringify({ ...job, proc: undefined }, null, 2));
        }
      });

      return json(res, 200, { jobId, status: "pending" });
    }

    // Get job status
    if (p.match(/^\/api\/director\/boards\/[^/]+\/whisperx\/jobs\/[^/]+$/) && req.method === "GET") {
      const parts = p.split("/");
      const jobId = decodeURIComponent(parts[7]);
      const job = whisperxJobs.get(jobId);
      if (!job) {
        // try to read from disk
        try {
          const jobDir = path.join(WHISPERX_JOBS, jobId);
          if (fs.existsSync(path.join(jobDir, "job.json"))) {
            const j = JSON.parse(fs.readFileSync(path.join(jobDir, "job.json"), "utf8"));
            return json(res, 200, { jobId, ...j });
          }
        } catch {}
        return json(res, 404, { error: "job not found" });
      }
      return json(res, 200, {
        jobId: job.id,
        status: job.status,
        progress: job.progress,
        stage: job.stage,
        message: job.message,
        log: job.log || null,
        error: job.error,
        timeline: job.timeline,
        export: job.export || null,
      });
    }

    // Cancel job
    if (p.match(/^\/api\/director\/boards\/[^/]+\/whisperx\/jobs\/[^/]+\/cancel$/) && req.method === "POST") {
      const parts = p.split("/");
      const jobId = decodeURIComponent(parts[7]);
      const job = whisperxJobs.get(jobId);
      if (job) {
        job.cancelled = true;
        try { if (job.proc) job.proc.kill(); } catch {}
        job.status = "cancelled";
      }
      return json(res, 200, { ok: true });
    }
    if (p.match(/^\/api\/director\/boards\/[^/]+\/prompt-preview$/) && req.method === "GET") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      const board = readDirectorBoard(id);
      if (!board.blueprint) return json(res, 400, { error: "analyze the story first" });
      const anatomyErrors = validateBibleAnatomy(board.blueprint);
      if (anatomyErrors.length) return json(res, 400, { error: anatomyErrors[0], errors: anatomyErrors });
      const countQ = Number(u.searchParams.get("count"));
      const spec = nextSceneBatchSpec(board, Number.isFinite(countQ) ? countQ : undefined, id);
      if (spec.ready) {
        return json(res, 200, {
          ready: true, scenes: board.scenes.length, sceneCount: board.sceneCount,
          note: "plan complete — Continue would send nothing",
        });
      }
      const user = buildScenesPrompt({
        input: board.input, blueprint: board.blueprint, prevScene: spec.prevScene,
        startNumber: spec.done + 1, count: spec.n, styleLock: board.styleLock,
        totalScenes: board.sceneCount, priorDialogue: spec.priorDialogue,
        lyricLines: Array.isArray(board.blueprint.lyric_lines) ? board.blueprint.lyric_lines : [],
        lyricTiming: spec.lyricTiming,
        lineRange: spec.lineRange, budgetSeconds: spec.budget,
        plannedSeconds: spec.prog.plannedSeconds, targetSeconds: spec.planTarget || null,
        totalLines: spec.lyricTiming.length || null,
        // The approved master timeline rides the dry-run popup EXACTLY like
        // the real batch — Show prompt must show the timing contract too.
        masterTimeline: spec.masterTiming || null,
        cinematicContext: spec.cinematicContext || null,
        // Same gated abstract-line guidance the real batch sends (derived from
        // the board's stored meaning for this line window).
        semanticVariationContext: semanticVariationForBatch(board, spec.lineRange),
        // Approved master assets ride the prompt exactly like the real batch —
        // Show prompt must be byte-identical to what the model receives.
        approvedAssets: directorApprovedAssets(board),
        promptAddons: directorPromptAddons(readDirectorPromptSettings()),
      });
      return json(res, 200, {
        ready: false,
        system: DIRECTOR_SYSTEM,
        user,
        startNumber: spec.done + 1,
        count: spec.n,
        batchSeconds: spec.budget,
        systemChars: DIRECTOR_SYSTEM.length,
        userChars: user.length,
        approxTokens: Math.round((DIRECTOR_SYSTEM.length + user.length) / 4),
      });
    }
    if (p.match(/^\/api\/director\/boards\/[^/]+\/scenes$/) && req.method === "POST") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      if (directorPlanning.has(id)) {
        return json(res, 409, { error: "scene planning already running for this board — wait for it to finish, then Continue" });
      }
      directorPlanning.add(id);
      try {
        const board = readDirectorBoard(id);
        if (!board.blueprint) throw new Error("analyze the story first");
        const sceneAssetState = directorAssetWithVersions(id, getBoardAssetState(board));
        const approvedSceneAssets = directorApprovedAssets(board, sceneAssetState);
        const anatomyErrors = validateBibleAnatomy(board.blueprint);
        if (anatomyErrors.length) {
          return json(res, 400, { error: anatomyErrors[0], errors: anatomyErrors });
        }
        const body = await readJson(req).catch(() => ({}));
        const spec = nextSceneBatchSpec(board, body.count, id);
        if (spec.ready) return json(res, 200, spec.write ? writeDirectorBoard(spec.board) : spec.board);
        const { done, planTarget, prog, avgScene, remaining, n, budget, prevScene, priorDialogue, lyricTiming, lineRange, masterTiming, cinematicContext } = spec;
        const scenesRawTag = `_raw_${id}_scenes_${done + 1}.log`;
        const batchStartedAt = Date.now();
        const batchLlmAttempts = [];
        const promptAddons = directorPromptAddons(readDirectorPromptSettings());
        // Read-only phase labels for the storyboard workspace. Same buffer,
        // same SSE/LLM call — the UI merely names the step it is watching.
        liveBegin(id, { phase: STORYBOARD_PHASES[0], batchFrom: done + 1, batchTo: done + n });
        if (masterTiming || cinematicContext) livePhase(id, STORYBOARD_PHASES[1]);
        // The MEANING pass for THIS batch is deterministic by default. A
        // second LLM round trip is available only when explicitly requested;
        // scene planning already receives the complete line-by-line context.
        const batchLines = arr(lineRange).length ? arr(lineRange) : arr(lyricTiming);
        livePhase(id, STORYBOARD_PHASES[2]);
        const semanticLanguage = String((board.input && board.input.semanticsLanguage) || "auto");
        const deterministicRows = analyzeLinesDeterministic(
          batchLines.map((l) => ({
            id: Number(l.lyric_line_id || l.line_id) || 0,
            text: String(l.lyric_text ?? l.text ?? l.line ?? ""),
          })).filter((l) => l.text),
          { language: semanticLanguage, bible: board.blueprint, genre: board.input && board.input.genre },
        );
        let semanticRows = deterministicRows;
        if (deterministicRows.length && body.useModel === true) {
          const enriched = await enrichSemanticsWithModel(
            deterministicRows.map((r) => ({ id: r.line_id, text: r.source_text })),
            {
              language: semanticLanguage, bible: board.blueprint,
              genre: board.input && board.input.genre, styleLock: board.styleLock || "",
            },
          );
          if (enriched.rows.length) semanticRows = enriched.rows;
        }
        // The board keeps the enriched meaning (the UI shows it, the next
        // batch reuses it).
        if (arr(board.semantics && board.semantics.lines).length) {
          const known = new Map(board.semantics.lines.map((r) => [Number(r.line_id), r]));
          for (const row of semanticRows) known.set(Number(row.line_id), row);
          board.semantics = {
            ...board.semantics,
            lines: [...known.values()].sort((a, b) => Number(a.line_id) - Number(b.line_id)),
          };
        } else {
          board.semantics = {
            language: semanticLanguage,
            source: semanticRows.length ? "deterministic" : "none",
            lines: semanticRows,
            created_at: new Date().toISOString(),
          };
        }
        // The abstract/unresolved lines of THIS batch get one explicit,
        // distinct visible action each — never the placeholder that used to
        // make every scene identical except for its camera fields.
        const semanticVariationContext = semanticVariationForBatch(board, lineRange, semanticRows);
        // Huge batches can get cut off mid-array (model hits max_tokens /
        // context). Salvage path: bind every COMPLETED scene from the raw
        // text and continue the plan from there, instead of 500ing with
        // zero progress after minutes of generation. When NOTHING usable
        // arrives (cut off inside the first scene object), step down twice —
        // halved batch, then ONE compact scene with terse prompts — because
        // a small local model often dies partway through a 10-scene
        // completion but finishes a small one cleanly.
        let raw = null;
        let salvageNote = null;
        // Dynamic planning: the AI decides scene boundaries, counts and
        // durations inside this batch's time budget and reports complete=true
        // when the story ends (salvage path never counts as complete).
        let batchComplete = false;
        // Live view: stream the batch tokens into the per-board buffer so the
        // storyboard can show scene-by-scene progress (GET .../live polls it).
        // Same prompt/tokens/compute as before — only flushed over the wire.
        let attemptN = n;
        let attemptTag = scenesRawTag;
        let attemptCompact = false;
        livePhase(id, STORYBOARD_PHASES[3]);
        for (let attempt = 1; attempt <= 2; attempt++) {
        const llmAttemptStartedAt = Date.now();
        liveLlmStart(id, attempt);
        try {
          raw = await llmChatJsonLive({
            system: DIRECTOR_SYSTEM,
            user: buildScenesPrompt({
              input: board.input, blueprint: board.blueprint, prevScene,
              startNumber: done + 1, count: attemptN, styleLock: board.styleLock,
              totalScenes: board.sceneCount, priorDialogue,
              lyricLines: Array.isArray(board.blueprint.lyric_lines) ? board.blueprint.lyric_lines : [],
              lyricTiming,
              lineRange, budgetSeconds: budget,
              plannedSeconds: prog.plannedSeconds, targetSeconds: planTarget || null,
              totalLines: lyricTiming.length || null,
              compact: attemptCompact,
              // The meaning of the lines this batch covers (the scenes are
              // planned FROM the meaning, not from the raw line).
              semantics: semanticRows,
              // The APPROVED master timeline slice for this batch's window:
              // the timing contract the LLM must plan against (absolute
              // windows, instrumental/unknown rules, repeat occurrences).
              masterTimeline: masterTiming || null,
              cinematicContext: cinematicContext || null,
              semanticVariationContext,
              // The approved Generate Assets stage feeds the scene planner a
              // compact visual index keyed by bible id (text lock, not pixels).
              approvedAssets: approvedSceneAssets,
              promptAddons,
            }),
            maxTokens: 16000,
            temperature: 0.5,
            timeoutMs: REQUEST_TIMEOUT_MS,
            rawTag: attemptTag,
            liveId: id,
            tag: `story_scenes_${done + 1}`,
          });
          const attemptDurationMs = Date.now() - llmAttemptStartedAt;
          batchLlmAttempts.push({ attempt, startedAt: new Date(llmAttemptStartedAt).toISOString(), durationMs: attemptDurationMs, outcome: "success", requestedScenes: attemptN });
          liveLlmEnd(id, attempt);
          batchComplete = raw && raw.complete === true;
          assertNoCJK(raw, "the scene plan");
          livePhase(id, STORYBOARD_PHASES[4]);
          break;
        } catch (e) {
          const attemptDurationMs = Date.now() - llmAttemptStartedAt;
          batchLlmAttempts.push({ attempt, startedAt: new Date(llmAttemptStartedAt).toISOString(), durationMs: attemptDurationMs, outcome: "failed", requestedScenes: attemptN });
          liveLlmEnd(id, attempt);
          const msg = String((e && e.message) || "");
          // Always log the real cause: the stall error below is generic and
          // otherwise masks transport/timeout failures (no raw file is even
          // written for those, so the log line is the only diagnosis).
          console.warn(`[director:${id}] scene batch attempt ${attempt} failed: ${msg.slice(0, 300)}`);
          let salvaged = [];
          if (/truncated|unbalanced|parse failed|no JSON/i.test(msg)) {
            try {
              const rawText = fs.readFileSync(path.join(DIRECTOR, attemptTag), "utf8");
              salvaged = extractPartialScenes(rawText);
            } catch { /* raw re-read is best-effort */ }
          }
          if (salvaged.length) {
            console.warn(`[director:${id}] truncated batch — salvaged ${salvaged.length}/${attemptN} scenes, resume continues from scene ${done + salvaged.length + 1}`);
            raw = { scenes: salvaged };
            salvageNote = `Partial batch: kept ${salvaged.length} of ${attemptN} scenes (the AI output was cut off) — press Continue to plan the rest.`;
            break;
          }
          if (attempt === 1 && attemptN > 1 && (/truncated|unbalanced|empty response|msg is not defined/i.test(msg))) {
            attemptN = Math.max(1, Math.floor(attemptN / 2));
            attemptTag = scenesRawTag.replace(/\.log$/, `_retry${attemptN}.log`);
            console.warn(`[director:${id}] batch of ${n} truncated/empty with 0 usable scenes — retrying with ${attemptN} (raw kept at director/${scenesRawTag})`);
            liveReset(id, `(batch of ${n} was cut off/empty with nothing usable — retrying with ${attemptN} scenes)`);
            continue;
          }
          if (attempt === 2 && attemptN > 1 && (/truncated|unbalanced|empty response|msg is not defined/i.test(msg))) {
            // Last resort: exactly one scene with terse prompts — fits even a
            // tiny output window. Same schema, so it normalizes/grounds equally.
            attemptN = 1;
            attemptCompact = true;
            attemptTag = scenesRawTag.replace(/\.log$/, `_compact1.log`);
            console.warn(`[director:${id}] batch of ${n} truncated again with 0 usable scenes — retrying one compact scene (raw kept at director/${attemptTag})`);
            liveReset(id, `(still cut off — retrying a single compact scene)`);
            continue;
          }
          // Total stall: remember a small batch size AND persist the note, so
          // the next Continue resumes small (instead of failing 12 again).
          // Report the REAL cause: output-limit text only fits parse/cut-off
          // failures — transport/timeout errors (which write no raw file) keep
          // their own message so the UI doesn't mislead.
          board.planBatchHint = 1;
          if (/truncated|unbalanced|parse failed|no JSON|empty response/i.test(msg)) {
            board.error = `Scene planning stalled at scene ${done + 1}: the model output was unusable (${msg.slice(0, 120)}; raw: director/${attemptTag}). The output limit is on the LLM side — raise Context Length / Max Tokens in LM Studio (or load a larger model), then press Continue.`;
          } else {
            board.error = `Scene planning stalled at scene ${done + 1}: ${msg.slice(0, 250)} — partial scenes are kept, fix the cause and press Continue.`;
          }
          try { writeDirectorBoard(board); } catch { /* error text is best-effort */ }
          throw new Error(board.error);
        }
        }
        const postLlmStartedAt = Date.now();
        const got = Array.isArray(raw.scenes) ? raw.scenes : (Array.isArray(raw) ? raw : []);
        if (!got.length) throw new Error("director returned no scenes — try again");
        assertNoCJK(got, "the scene plan");
      // Dedupe guard: the LLM sometimes repeats an earlier line verbatim
      // across batches. A repeated line carries no story value and is exactly
      // the "scene 1 copied to scene 45" report — drop the repeat so every
      // stored scene keeps only its own actual dialogue (action-only scenes
      // keep empty dialogue instead of filler).
      const seen = new Set(priorDialogue.map((l) => String(l || "").toLowerCase().replace(/[^a-z0-9\u0900-\u097f]+/g, " ").trim()).filter(Boolean));
      // Landed scenes of THIS batch (numbered sequentially from done+1).
      // Grounding + exact-dupe guards run before anything is stored, so a
      // batch can never persist hallucinated cast, free-text places that
      // break grounding, or verbatim repeat scenes.
      const landed = [];
      const groundNotes = [];
      // Narration text is reconstructed from the saved source, never trusted
      // from model output. Scene line ranges are global across the board, so
      // this also keeps later batches (e.g. scenes 40–60) anchored to the
      // correct section of a long narration.
      const sourceNarrationLines = board.input.song ? [] : parseLyricLines(board.input.story || "");
      const openingSourceLines = board.input.song ? lyricTiming : sourceNarrationLines;
      for (let i = 0; i < got.length && done + landed.length < board.sceneCount; i++) {
        const normed = normalizeScene(got[i], done + landed.length + 1, board.input.sceneSeconds);
        if (normed.scene_number === 1 && isAbstractOpeningSource(openingSourceLines, board.blueprint && board.blueprint.locations)) {
          const sourceCount = Math.max(1, Math.min(6, openingSourceLines.length || 1));
          const duration = Number(normed.duration_seconds) || Number(board.input.sceneSeconds) || 3;
          const abstractImage = "An abstract cosmic opening before any deity is shown: deep indigo-black space, faint celestial glow slowly emerging from darkness, subtle shifting patterns of light suggesting peace, compassion, awe, and immeasurable power. No person, deity, face, silhouette, recognizable mountain, snow, temple, Ganga, meditation pose, or character attributes. Grand devotional cinema, restrained atmospheric light, reverent and enigmatic mood.";
          const abstractMotion = "The faint glow gradually emerges from darkness; subtle light patterns shift slowly. Slow gradual camera push. No figure or recognizable place appears.";
          normed.identity_free = true;
          normed.line_from = 1;
          normed.line_to = sourceCount;
          normed.title = "A Presence Beyond Form";
          normed.dramatic_purpose = "Introduce the narration's abstract qualities through symbolic light before revealing any deity or place.";
          normed.characters = [];
          normed.characters_detailed = [];
          normed.asset_refs = { characters: [], locations: [], objects: [] };
          normed.reference_images = [];
          normed.location = "";
          normed.objects = [];
          normed.action = "A faint celestial glow emerges from darkness as subtle patterns of light suggest the narration's abstract emotions and power.";
          normed.motion = abstractMotion;
          normed.environment = "Deep indigo-black cosmic space with restrained, shifting light; no identifiable physical location.";
          normed.lighting = "A faint celestial glow slowly emerges from darkness, softly illuminating abstract drifting patterns.";
          normed.camera = { shot_type: "Wide Shot", angle: "Eye Level", movement: "Slow Push-In" };
          normed.image_prompt = abstractImage;
          normed.video_prompt = abstractMotion;
          normed.dialogue = [];
          if (!board.input.song) normed.narration = sourceNarrationLines.slice(0, sourceCount).map((line) => String(line.lyric_text || "")).join("\n");
          normed.shots = (normed.shots.length ? normed.shots : [normalizeScene({ duration_seconds: duration }, 1, duration).shots[0]]).slice(0, 1).map((shot) => ({
            ...shot,
            identity_free: true,
            characters: [], characters_detailed: [], asset_refs: { characters: [], locations: [], objects: [] },
            location: "", objects: [], dialogue: [],
            action: normed.action, motion: abstractMotion, environment: normed.environment,
            lighting: normed.lighting, camera: normed.camera,
            image_prompt: abstractImage, video_prompt: abstractMotion,
          }));
        }
        bindApprovedSceneAssetRefs(normed, approvedSceneAssets);
        if (!board.input.song) {
          const from = Number(normed.line_from);
          const to = Number(normed.line_to);
          normed.narration = Number.isInteger(from) && Number.isInteger(to) && from >= 1 && to >= from
            ? sourceNarrationLines.slice(from - 1, to).map((line) => String(line.lyric_text || "")).join("\n")
            : "";
        }
        // Silent-film board: the model sometimes still emits lines despite the
        // DISABLED instruction — strip them server-side so Generate stays
        // silent (no voice, no lip-sync, no clip growth).
        if (board.input.includeDialogue === false) normed.dialogue = [];
        // Independent-shots board: the model sometimes still emits handoff
        // fields despite the INDEPENDENT instruction — scrub them server-side
        // so Approve generates fresh shots instead of continuations.
        if (board.input.chainContinuity !== true) scrubSceneContinuity(normed);
        // The batch schema omits lyric_text to save tokens — join it back
        // from the timed line list so the UI can show Line -> shots.
        if (normed.lyric_line_id && !normed.lyric_text && lyricTiming.length) {
          const line = lyricTiming.find((l) => Number(l.lyric_line_id) === Number(normed.lyric_line_id));
          if (line && line.lyric_text) normed.lyric_text = String(line.lyric_text);
        }
        if (Array.isArray(normed.dialogue) && normed.dialogue.length) {
          const fresh = [];
          for (const d of normed.dialogue) {
            const key = String(d.line || "").toLowerCase().replace(/[^a-z0-9\u0900-\u097f]+/g, " ").trim();
            let dup = key && seen.has(key);
            if (!dup && key) {
              for (const s of board.scenes) {
                for (const pd of (s.dialogue || [])) {
                  if (pd && pd.line && sameLine(pd.line, d.line)) { dup = true; break; }
                }
                if (dup) break;
                for (const psh of (s.shots || [])) {
                  for (const pd of (psh.dialogue || [])) {
                    if (pd && pd.line && sameLine(pd.line, d.line)) { dup = true; break; }
                  }
                  if (dup) break;
                }
                if (dup) break;
              }
            }
            if (dup) continue;
            fresh.push(d);
            if (key) seen.add(key);
          }
          normed.dialogue = normalizeDialogue(fresh);
        }
        // Multi-shot scenes: the same verbatim-repeat guard applies per
        // shot, so a line planned in an earlier shot never echoes inside a
        // later shot of the same batch.
        if (Array.isArray(normed.shots)) {
          for (const sh of normed.shots) {
            if (!Array.isArray(sh.dialogue) || !sh.dialogue.length) continue;
            // The batch schema omits lyric_text to save tokens — join it back
            // from the timed line list, same as scene-level linkage below.
            if (sh.lyric_line_id && !sh.lyric_text && lyricTiming.length) {
              const line = lyricTiming.find((l) => Number(l.lyric_line_id) === Number(sh.lyric_line_id));
              if (line && line.lyric_text) sh.lyric_text = String(line.lyric_text);
            }
            const fresh = [];
            for (const d of sh.dialogue) {
              const key = String(d.line || "").toLowerCase().replace(/[^a-z0-9\u0900-\u097f]+/g, " ").trim();
              let dup = key && seen.has(key);
              if (!dup && key) {
                for (const s of board.scenes) {
                  for (const pd of (s.dialogue || [])) {
                    if (pd && pd.line && sameLine(pd.line, d.line)) { dup = true; break; }
                  }
                  if (dup) break;
                  for (const psh of (s.shots || [])) {
                    for (const pd of (psh.dialogue || [])) {
                      if (pd && pd.line && sameLine(pd.line, d.line)) { dup = true; break; }
                    }
                    if (dup) break;
                  }
                  if (dup) break;
                }
              }
              if (dup) continue;
              fresh.push(d);
              if (key) seen.add(key);
            }
            sh.dialogue = normalizeDialogue(fresh);
          }
        }
        // Bible-id grounding: canonicalize characters/location (+ shots) to
        // exact bible ids — free-text places, objects parked in the location
        // slot, and hallucinated cast are repaired/dropped here so every
        // stored scene actually grounds downstream (see canonicalizeSceneRefs).
        livePhase(id, STORYBOARD_PHASES[5]);
        try {
          const { repairs, notes } = canonicalizeSceneRefs(normed, board.blueprint);
          for (const r of repairs.slice(0, 3)) {
            if (groundNotes.length < 6) groundNotes.push(r);
          }
          // Lossless object moves change nothing on screen — server log only,
          // never the storyboard ⚠️ hint.
          for (const note of (notes || []).slice(0, 3)) console.warn(`[director:${id}] grounding note: ${note}`);
        } catch (e) {
          console.warn(`[director:${id}] grounding failed for batch scene ${normed.scene_number}: ${e && e.message ? e.message : e}`);
        }
        const assetRefs = resolveSceneAssetRefs(normed, sceneAssetState);
        for (const issue of assetRefs.issues) {
          if (groundNotes.length < 12) groundNotes.push(issue);
          console.warn(`[director:${id}] asset reference: ${issue}`);
        }
        if (approvedSceneAssets.length) compactSceneGenerationDirections(normed);
        landed.push(normed);
        }
        // Exact-duplicate scene guard (same title + action as an
        // already-planned scene — the "same scene generated twice" defect):
        // repeats are skipped, never stored, so the plan advances.
        const { kept, dropped } = dedupeScenes(board.scenes, landed);
        for (const s of kept) board.scenes.push(s);
        // Visible grounding report for the storyboard UI (board.warn renders
        // as a ⚠️ hint; overwritten every batch, null when the batch is
        // clean). Manual PUT edits clear it (see the PUT route).
        const warnBits = [];
        if (dropped > 0) warnBits.push(`${dropped} repeat scene${dropped === 1 ? "" : "s"} skipped (same title + action as an earlier scene)`);
        if (groundNotes.length) warnBits.push(...groundNotes);
        // Meaning-aware repeat guard: different source lines staged with the
        // same action/pose (only the camera changes) are reported, never
        // dropped — dropping would leave a line uncovered.
        for (const note of flagRepeatStaging(board.scenes).slice(0, 3)) warnBits.push(note);
        // The MEANING lands on the scenes: every scene carries its source
        // line, the interpretation, the visible action plan, the camera
        // rationale and the source line. A scene that does not show its line is
        // repaired deterministically and reported (never silently accepted).
        const semanticAttach = attachSemanticsToScenes(board, board.semantics);
        for (const issue of semanticAttach.issues.slice(0, 4)) {
          console.warn(`[director:${id}] meaning: ${issue}`);
          if (warnBits.length < 5) warnBits.push(issue);
        }
        if (warnBits.length > 4) warnBits.splice(4, warnBits.length - 4, `…and ${warnBits.length - 4} more grounding notes (see server log)`);
        if (warnBits.length) {
          for (const w of warnBits) console.warn(`[director:${id}] grounding: ${w}`);
          board.warn = `Grounding fixes in the latest batch — ${warnBits.join("; ")}. Regenerate flagged scenes if the staging looks off.`;
        } else {
          board.warn = null;
        }
        // Defensive dedupe: keep the first scene per scene_number and renumber
        // sequentially, so no duplicate records can ever be stored or migrated.
        const seenNums = new Set();
        board.scenes = board.scenes.filter((s) => {
          if (seenNums.has(s.scene_number)) return false;
          seenNums.add(s.scene_number);
          return true;
        });
        board.scenes.forEach((s, i) => { s.scene_number = i + 1; });
        // Lyric-plan self-check (§21): warnings only, never blocks the batch.
        try {
          const lines = Array.isArray(board.blueprint.lyric_lines) && board.blueprint.lyric_lines.length
            ? board.blueprint.lyric_lines
            : (board.input.song ? parseLyricLines(board.input.story) : []);
          const issues = validateLyricPlan(
            board.scenes, lines,
            board.input.song ? (board.input.song.durationSeconds || board.input.targetSeconds) : null);
          for (const issue of issues.slice(0, 8)) console.warn(`[director:${id}] plan check: ${issue}`);
        } catch { /* validation is best-effort */ }
        // Duration-driven completion, VERIFIED: the AI's complete=true is
        // only honored when the last source line is actually covered and the
        // planned seconds reach the target (small models declare completion
        // mid-story). The pure-timeline path uses the same DONE_TOL close-
        // enough rule as the route top. Otherwise planning continues; the cap
        // only shrinks to what was truly planned so the UI reads x/x.
        // (Same close-enough rule as nextSceneBatchSpec above; DONE_TOL lives
        // in that closure's scope, so recompute it here from avgScene.)
        const DONE_TOL = Math.max(1, avgScene / 2);
        const nowCovered = planTarget > 0 &&
          (planTarget - planProgress(board.scenes, planTarget).plannedSeconds) <= DONE_TOL;
        const completeOk = verifyPlanComplete(board.scenes, {
          targetSeconds: planTarget, totalLines: lyricTiming.length, flag: batchComplete,
        }) || nowCovered;
        if (batchComplete && !completeOk) {
          const cov = board.scenes.reduce((a, s) => {
            const c = [Number(s.line_to), Number(s.lyric_line_id), Number(s.parent_line_id)]
              .filter((v) => Number.isFinite(v) && v > 0);
            return c.length ? Math.max(a, ...c) : a;
          }, 0);
          const plannedNow = planProgress(board.scenes, planTarget).plannedSeconds;
          console.warn(`[director:${id}] premature complete=true ignored (covers line ${cov}/${lyricTiming.length || "?"} at ${plannedNow}s/${planTarget || "?"}s) — planning continues`);
        }
        if (completeOk && board.scenes.length) {
          board.sceneCount = board.scenes.length;
        }
        board.status = board.scenes.length >= board.sceneCount ? "ready" : "scenes-partial";
        // A salvaged partial batch keeps its note so the UI explains why the
        // plan stopped short; clean batches clear any stale error.
        board.error = salvageNote || null;
        // A clean full batch proves the model handles this size again —
        // drop the stall hint so planning returns to full batches.
        if (!salvageNote) board.planBatchHint = null;
        const llmMs = batchLlmAttempts.reduce((sum, item) => sum + item.durationMs, 0);
        const scenePlanningMetrics = board.scenePlanningMetrics && typeof board.scenePlanningMetrics === "object"
          ? board.scenePlanningMetrics : { batches: [] };
        scenePlanningMetrics.batches = Array.isArray(scenePlanningMetrics.batches) ? scenePlanningMetrics.batches : [];
        scenePlanningMetrics.batches.push({
          from: done + 1,
          requested: n,
          received: got.length,
          accepted: kept.length,
          attempts: batchLlmAttempts,
          preparationMs: Math.max(0, (batchLlmAttempts[0] ? Date.parse(batchLlmAttempts[0].startedAt) : postLlmStartedAt) - batchStartedAt),
          llmMs,
          postLlmMs: Math.max(0, Date.now() - postLlmStartedAt),
          totalMs: Math.max(0, Date.now() - batchStartedAt),
          recordedAt: new Date().toISOString(),
        });
        if (scenePlanningMetrics.batches.length > 100) scenePlanningMetrics.batches.splice(0, scenePlanningMetrics.batches.length - 100);
        scenePlanningMetrics.updatedAt = new Date().toISOString();
        board.scenePlanningMetrics = scenePlanningMetrics;
        livePhase(id, STORYBOARD_PHASES[6]);
        const savedBoard = writeDirectorBoard(board);
        livePhase(id, completeOk ? STORYBOARD_PHASES[8] : STORYBOARD_PHASES[7]);
        return json(res, 200, savedBoard);
      } finally {
        liveEnd(id);
        directorPlanning.delete(id);
      }
    }
    // AI append: generate exactly ONE new bible entry (character | location |
    // object) from the master input (title + story/lyrics + genre/style +
    // instructions + song) plus the ALREADY generated bible, then append it.
    if (p.match(/^\/api\/director\/boards\/[^/]+\/add-entry$/) && req.method === "POST") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      const board = readDirectorBoard(id);
      if (!board.blueprint) throw new Error("analyze the story first");
      const body = await readJson(req).catch(() => ({}));
      const kind = String(body.kind || "").toLowerCase();
      if (!["character", "location", "object"].includes(kind))
        return json(res, 400, { error: "kind must be character, location or object" });
      const hint = String(body.hint || "").slice(0, 300);
      const raw = await llmChatJson({
        system: DIRECTOR_SYSTEM,
        user: buildAddEntryPrompt({ input: board.input, blueprint: board.blueprint, kind, hint }),
        maxTokens: 2000,
        temperature: 0.7,
        timeoutMs: REQUEST_TIMEOUT_MS,
        rawTag: `_raw_${id}_add_${kind}.log`,
      });
      const node = raw[kind] && typeof raw[kind] === "object" ? raw[kind] : raw;
      if (kind === "character") {
        const next = normalizeCharacter(node, board.blueprint.characters.length);
        if (!next.name) throw new Error("director returned an empty character — try again");
        // Unique ids/names: suffix when the model repeats an existing one.
        const taken = new Set([
          ...board.blueprint.characters.map((c) => String(c.character_id || "").toLowerCase()),
          ...board.blueprint.characters.map((c) => String(c.name || "").toLowerCase()),
        ]);
        let n = 2;
        while (taken.has(String(next.character_id || "").toLowerCase()) || taken.has(String(next.name || "").toLowerCase())) {
          next.character_id = `${String(next.character_id || "character").replace(/_\d+$/, "")}_${n}`;
          next.name = `${next.name} ${n}`;
          n++;
        }
        board.blueprint.characters.push(next);
      } else if (kind === "location") {
        const next = normalizeLocation(node, board.blueprint.locations.length);
        if (!next.name) throw new Error("director returned an empty location — try again");
        const taken = new Set([
          ...board.blueprint.locations.map((l) => String(l.location_id || "").toLowerCase()),
          ...board.blueprint.locations.map((l) => String(l.name || "").toLowerCase()),
        ]);
        let n = 2;
        while (taken.has(String(next.location_id || "").toLowerCase()) || taken.has(String(next.name || "").toLowerCase())) {
          next.location_id = `${String(next.location_id || "location").replace(/_\d+$/, "")}_${n}`;
          next.name = `${next.name} ${n}`;
          n++;
        }
        board.blueprint.locations.push(next);
      } else {
        const next = normalizeObject(node, board.blueprint.objects.length);
        if (!next.name) throw new Error("director returned an empty object — try again");
        const taken = new Set([
          ...board.blueprint.objects.map((o) => String(o.object_id || "").toLowerCase()),
          ...board.blueprint.objects.map((o) => String(o.name || "").toLowerCase()),
        ]);
        let n = 2;
        while (taken.has(String(next.object_id || "").toLowerCase()) || taken.has(String(next.name || "").toLowerCase())) {
          next.object_id = `${String(next.object_id || "object").replace(/_\d+$/, "")}_${n}`;
          next.name = `${next.name} ${n}`;
          n++;
        }
        board.blueprint.objects.push(next);
      }
      board.error = null;
      return json(res, 200, writeDirectorBoard(board));
    }
    // AI rewrite: regenerate exactly ONE bible entry (character | location |
    // object) in place. The model re-reads the master input + full bible and
    // returns a richer rewrite of the selected entry; the id is pinned
    // server-side so scene references never break.
    if (p.match(/^\/api\/director\/boards\/[^/]+\/regen-entry$/) && req.method === "POST") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      const board = readDirectorBoard(id);
      if (!board.blueprint) throw new Error("analyze the story first");
      const body = await readJson(req).catch(() => ({}));
      const kind = String(body.kind || "").toLowerCase();
      if (!["character", "location", "object"].includes(kind))
        return json(res, 400, { error: "kind must be character, location or object" });
      const index = Math.floor(Number(body.index));
      const list = kind === "character" ? board.blueprint.characters
        : kind === "location" ? board.blueprint.locations : board.blueprint.objects;
      if (!Array.isArray(list) || !Number.isInteger(index) || index < 0 || index >= list.length)
        return json(res, 400, { error: "bad entry index" });
      const current = list[index];
      const raw = await llmChatJson({
        system: DIRECTOR_SYSTEM,
        user: buildRegenEntryPrompt({ input: board.input, blueprint: board.blueprint, kind, entry: current }),
        maxTokens: 2000,
        temperature: 0.7,
        timeoutMs: REQUEST_TIMEOUT_MS,
        rawTag: `_raw_${id}_regen_${kind}_${index}.log`,
      });
      const node = raw[kind] && typeof raw[kind] === "object" ? raw[kind] : raw;
      if (kind === "character") {
        const next = normalizeCharacter(node, index);
        if (!next.name && !next.visual_identity_prompt) throw new Error("director returned an empty character — try again");
        // Pin the id + keep the user's custom consistency rules when the
        // model omits them, so scene references and popup edits survive.
        next.character_id = current.character_id || next.character_id;
        if (!node.consistency_rules && Array.isArray(current.consistency_rules)) {
          next.consistency_rules = current.consistency_rules.map((x) => String(x ?? "")).filter(Boolean);
        }
        if (!next.name) next.name = current.name;
        list[index] = next;
      } else if (kind === "location") {
        const next = normalizeLocation(node, index);
        if (!next.name && !next.visual_identity_prompt) throw new Error("director returned an empty location — try again");
        next.location_id = current.location_id || next.location_id;
        if (!next.name) next.name = current.name;
        list[index] = next;
      } else {
        const next = normalizeObject(node, index);
        if (!next.name && !next.visual_identity_prompt) throw new Error("director returned an empty object — try again");
        next.object_id = current.object_id || next.object_id;
        if (!next.name) next.name = current.name;
        list[index] = next;
      }
      board.error = null;
      return json(res, 200, writeDirectorBoard(board));
    }
    if (p.match(/^\/api\/director\/boards\/[^/]+\/regenerate-scene$/) && req.method === "POST") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      const board = readDirectorBoard(id);
      const body = await readJson(req);
      const index = Math.floor(Number(body.index));
      if (!Number.isInteger(index) || index < 0 || index >= board.scenes.length)
        throw new Error("bad scene index");
      const scene = board.scenes[index];
      const sceneAssetState = directorAssetWithVersions(id, getBoardAssetState(board));
      const approvedSceneAssets = directorApprovedAssets(board, sceneAssetState);
      const raw = await llmChatJson({
        system: DIRECTOR_SYSTEM,
        user: buildRegenPrompt({
          input: board.input, blueprint: board.blueprint, scene,
          prevScene: index > 0 ? board.scenes[index - 1] : null,
          nextScene: index < board.scenes.length - 1 ? board.scenes[index + 1] : null,
          styleLock: board.styleLock,
          approvedAssets: approvedSceneAssets,
          promptAddons: directorPromptAddons(readDirectorPromptSettings()),
        }),
        maxTokens: 4000,
        temperature: 0.6,
        timeoutMs: REQUEST_TIMEOUT_MS,
        rawTag: `_raw_${id}_regen_${scene.scene_number}.log`,
      });
      const fresh = raw.scene && typeof raw.scene === "object" ? raw.scene : raw;
      board.scenes[index] = normalizeScene(fresh, scene.scene_number, scene.duration_seconds);
      try { canonicalizeSceneRefs(board.scenes[index], board.blueprint); } catch { /* best-effort legacy grounding */ }
      const assetRefs = resolveSceneAssetRefs(board.scenes[index], sceneAssetState);
      if (assetRefs.issues.length) board.scenes[index].asset_reference_issues = assetRefs.issues;
      if (approvedSceneAssets.length) compactSceneGenerationDirections(board.scenes[index]);
      if (board.input.includeDialogue === false) board.scenes[index].dialogue = [];
      if (board.input.chainContinuity !== true) scrubSceneContinuity(board.scenes[index]);
      board.error = null;
      return json(res, 200, writeDirectorBoard(board));
    }
    // Duplicate a board as a fresh version (copy characters, locations,
    // objects + scene prompts exactly; drop the linked project so
    // images/videos regenerate from scratch on approve). The new title is
    // auto-versioned: "<base> v2", then v3, ... — computed as max+1 across
    // the whole "<base>" family so re-copying v1 after v2 exists still
    // yields v3, never a second v2.
    if (p.match(/^\/api\/director\/boards\/[^\/]+\/duplicate$/) && req.method === "POST") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      const duplicateOptions = await readJson(req).catch(() => ({}));
      const requestedTitle = String(duplicateOptions.title || "").trim().slice(0, 120);
      const requestedImports = Array.isArray(duplicateOptions.imports)
        ? [...new Set(duplicateOptions.imports.map((x) => String(x || "")).filter((x) => ["brief", "audio", "assets", "storyboard", "review", "scenes"].includes(x)))]
        : null;
      // DB-first read (file fallback) — mirrors GET /api/director/boards/:id.
      let src = null;
      if (pgUp) {
        try {
          const r = await pgPool.query("SELECT board FROM director_boards WHERE board_id = $1", [id]);
          if (r.rows[0]?.board) {
            src = typeof r.rows[0].board === "string" ? JSON.parse(r.rows[0].board) : r.rows[0].board;
          }
        } catch (e) { console.warn("[pg] director board read failed:", e.message); }
      }
      if (!src) src = readDirectorBoard(id);
      if (!src || !src.input) throw new Error("board not found");
      const stripVersion = (t) => String(t || "").trim().replace(/\s+v\d+\s*$/i, "").trim();
      const base = stripVersion(src.input.title || src.id) || "story";
      // Collect every existing board title (DB + files) to find the family's
      // max version. Base itself counts as v1.
      const titles = [];
      if (pgUp) {
        try {
          const r = await pgPool.query("SELECT board FROM director_boards");
          for (const row of r.rows) {
            try {
              const b = typeof row.board === "string" ? JSON.parse(row.board) : row.board;
              const t = b?.input?.title;
              if (t) titles.push(String(t));
            } catch { /* skip corrupt rows */ }
          }
        } catch (e) { console.warn("[pg] director boards list failed:", e.message); }
      }
      try {
        fs.mkdirSync(DIRECTOR, { recursive: true });
        for (const f of fs.readdirSync(DIRECTOR).filter((f) => f.endsWith(".json") && !f.startsWith("_raw"))) {
          try {
            const b = JSON.parse(fs.readFileSync(path.join(DIRECTOR, f), "utf8"));
            const t = b?.input?.title;
            if (t && !titles.includes(String(t))) titles.push(String(t));
          } catch { /* skip corrupt board files */ }
        }
      } catch { /* titles stay DB-only */ }
      const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const verRe = new RegExp(`^${esc(base)}\\s+v(\\d+)\\s*$`, "i");
      let max = 0;
      for (const t of titles) {
        const s = String(t).trim();
        if (s.toLowerCase() === base.toLowerCase()) max = Math.max(max, 1);
        else {
          const m = s.match(verRe);
          if (m) max = Math.max(max, Number(m[1]) || 0);
        }
      }
      let next = Math.max(2, max + 1);
      const boardIdTaken = async (cid) => {
        try {
          if (fs.existsSync(directorBoardFile(cid))) return true;
        } catch { /* ignore */ }
        if (pgUp) {
          try {
            const r = await pgPool.query("SELECT 1 FROM director_boards WHERE board_id = $1", [cid]);
            if (r.rows.length) return true;
          } catch { /* treat as free */ }
        }
        return false;
      };
      let newTitle = requestedTitle || `${base} v${next}`.slice(0, 120);
      if (requestedTitle && titles.some((t) => String(t).trim().toLowerCase() === requestedTitle.toLowerCase())) {
        return json(res, 409, { error: `A Director board named "${requestedTitle}" already exists. Choose a different project name.` });
      }
      let newId = slug(newTitle) || `story_${Date.now().toString(36)}`;
      // Id collision guard (e.g. a manually created same-slug board): bump
      // the version until both the title and the id are free.
      // eslint-disable-next-line no-await-in-loop
      while (!requestedTitle && (titles.some((t) => String(t).toLowerCase() === newTitle.toLowerCase()) || await boardIdTaken(newId))) {
        next += 1;
        newTitle = `${base} v${next}`.slice(0, 120);
        newId = slug(newTitle) || `story_${Date.now().toString(36)}`;
        if (next > max + 100) throw new Error("could not find a free versioned title");
      }
      if (requestedTitle && await boardIdTaken(newId)) {
        return json(res, 409, { error: `The project name "${requestedTitle}" conflicts with an existing board key. Choose a different name.` });
      }
      const now = new Date().toISOString();
      const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
      const imported = requestedImports == null ? null : new Set(requestedImports);
      const importTab = (tab) => imported == null || imported.has(tab);
      // A selected downstream stage brings the data it depends on so the new
      // board stays usable (scenes need the source and asset bible).
      const importedTabs = new Set(imported || []);
      if (importedTabs.has("scenes")) for (const dep of ["brief", "assets", "storyboard"]) importedTabs.add(dep);
      if (importedTabs.has("storyboard")) for (const dep of ["brief", "assets"]) importedTabs.add(dep);
      if (importedTabs.has("review")) for (const dep of ["brief", "assets", "storyboard"]) importedTabs.add(dep);
      if (importedTabs.has("assets") || importedTabs.has("audio")) importedTabs.add("brief");
      const copyBrief = importedTabs.has("brief") || imported == null;
      const copyAudio = importTab("audio");
      const copyAssets = importedTabs.has("assets") || imported == null;
      const copyStoryboard = importedTabs.has("storyboard") || imported == null;
      const copyReview = importTab("review");
      const copyScenes = importedTabs.has("scenes") || imported == null;
      const sourceInput = clone(src.input) || {};
      const newInput = { ...sourceInput, title: newTitle };
      if (!copyBrief) newInput.story = "";
      if (!copyAudio) {
        delete newInput.song;
        delete newInput.sourceAudio;
        delete newInput.whisperxAudio;
        delete newInput.songAnalysis;
      }
      const sourceBlueprint = clone(src.blueprint);
      const blueprint = sourceBlueprint && (copyBrief || copyAssets || copyStoryboard || copyReview)
        ? {
            ...sourceBlueprint,
            analysis: copyBrief ? sourceBlueprint.analysis : {},
            logline: copyBrief ? sourceBlueprint.logline : "",
            characters: copyAssets ? (sourceBlueprint.characters || []) : [],
            locations: copyAssets ? (sourceBlueprint.locations || []) : [],
            objects: copyAssets ? (sourceBlueprint.objects || []) : [],
            beats: [],
            lyric_lines: copyAudio || copyBrief ? (sourceBlueprint.lyric_lines || []) : [],
          }
        : null;
      const scenes = copyScenes && Array.isArray(src.scenes) ? clone(src.scenes) : [];
      const importedTabList = imported == null ? [] : [...importedTabs];
      const nb = {
        id: newId,
        input: newInput,
        status: scenes.length >= (src.sceneCount || 0) && (src.sceneCount || 0) > 0
          ? "ready"
          : scenes.length ? "scenes-partial" : "analyzed",
        blueprint,
        scenes,
        sceneCount: copyScenes ? (src.sceneCount || scenes.length) : (copyBrief ? sceneCountFor(newInput.targetSeconds, newInput.sceneSeconds) : 0),
        styleLock: copyBrief || copyScenes ? src.styleLock : "",
        processedTabs: importedTabList,
        ...(copyAudio ? {
          audioTimeline: clone(src.audioTimeline),
          lyric_timeline: clone(src.lyric_timeline),
        } : {}),
        ...(copyReview ? {
          storyPlan: clone(src.storyPlan),
          semantics: clone(src.semantics),
        } : {}),
        ...(copyAssets && src.assetProduction ? {
          assetProduction: {
            ...clone(src.assetProduction),
            jobs: [],
            status: src.assetProduction.status === "approved" ? "approved" : "review",
          },
        } : {}),
        ...(copyScenes ? { scenePlanningMetrics: clone(src.scenePlanningMetrics) } : {}),
        // Fresh version = no linked project: approving mints a NEW project
        // (newTitle), so images/videos generate from scratch. Nothing binary
        // is copied — boards only carry prompts; outputs/ stays untouched.
        scenarioName: null,
        project_id: null,
        migratedScenes: 0,
        error: null,
        createdAt: now,
        updatedAt: now,
      };
      // Preserve the exact planning config (scene length etc.) from the source.
      if (nb.input && typeof nb.input === "object") {
        if (copyBrief && src.input.sceneSeconds != null) nb.input.sceneSeconds = src.input.sceneSeconds;
        if (copyBrief && src.input.targetSeconds != null) nb.input.targetSeconds = src.input.targetSeconds;
      }
      return json(res, 200, writeDirectorBoard(nb));
    }
    if (p.match(/^\/api\/director\/boards\/[^/]+\/approve$/) && req.method === "POST") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      const board = readDirectorBoard(id);
      if (!Array.isArray(board.scenes) || !board.scenes.length) throw new Error("nothing to approve — generate scenes first");
      // Anatomical bible failures are generation-blocking (unlike ordinary
      // quality/safety warnings): scene prompts paste character identity
      // verbatim, so a poisoned dog/elephant bible guarantees the wrong
      // rendered body. Require Analyze/review repair before keyframes/clips.
      const anatomyErrors = validateBibleAnatomy(board.blueprint);
      if (anatomyErrors.length) {
        return json(res, 400, {
          error: `character bible anatomy failed: ${anatomyErrors[0]}`,
          errors: anatomyErrors,
          warnings: [],
        });
      }
      // Story QA gate (§21 + Chief Director approveGate): same checklist as
      // the Story page client, so a board with unknown speakers, missing
      // emotion/expression or broken scene order cannot reach
      // boardToScenario/generation. Structural errors block; lyric/quality
      // findings are advisory warnings returned alongside.
      try {
        const gate = approveGate(board);
        if (gate && Array.isArray(gate.errors) && gate.errors.length) {
          return json(res, 400, { error: `story QA failed: ${gate.errors[0]}`, errors: gate.errors.slice(0, 20), warnings: (gate.warnings || []).slice(0, 20), score: gate.score });
        }
      } catch { /* validator never blocks on internal failure — approve proceeds */ }
      // The APPROVED master timeline is the authority on timing: scenes that
      // drifted from the approved windows are snapped back BEFORE the config
      // is built (priority: user-approved > validated alignment > estimate).
      // Story boards and boards without an approved timeline pass through
      // untouched; a snap beyond tolerance is reported, never moved.
      let timingCorrections = [];
      try {
        const approvedMaster = board.lyric_timeline && board.lyric_timeline.master;
        if (approvedMaster && approvedMaster.approved) {
          const applied = applyApprovedTimelineToScenes(board.scenes, approvedMaster);
          board.scenes = applied.scenes;
          timingCorrections = applied.corrections;
          for (const n of applied.notes.slice(0, 4)) console.warn(`[director:${id}] approve timing: ${n}`);
          if (timingCorrections.length) {
            console.warn(`[director:${id}] approve: ${timingCorrections.length} scene window(s) snapped to the approved master timeline`);
          }
        }
      } catch (e) {
        console.warn(`[director:${id}] approve timing snap failed: ${e && e.message ? e.message : e}`);
      }
      const generationBoard = {
        ...board,
        assetProduction: directorAssetWithVersions(id, getBoardAssetState(board)),
      };
      const config = attachDirectorAssetGenerationData(boardToScenario(generationBoard));
      // Partial-migration flow: the first approve claims a project name (the
      // story title as a space-free KEY, _2-suffixed on collision); every
      // later "migrate remaining" re-approve reuses board.scenarioName so the
      // rest of the scenes land in the SAME project (client PUTs = overwrite,
      // and generation is resumable, so already-built scenes are kept).
      // INTERNAL KEY: the story title becomes the space-free scenario key
      // ("Pyari billi" -> "pyari_billi") — /api/scenario/<key>/... URLs,
      // output dirs and file names all use it; the typed title rides along
      // as config.display_name for UI labels.
      const approveTitle = String(board.input.title || "").trim().slice(0, 120);
      let target = board.scenarioName || spaceFreeName(approveTitle) || id;
      if (approveTitle) config.display_name = approveTitle;
      if (!board.scenarioName) {
        try {
          const taken = new Set((await dbListScenarios()).map((r) => r.name));
          if (taken.has(target)) {
            for (let i = 2; ; i++) {
              if (!taken.has(`${target}_${i}`)) { target = `${target}_${i}`; break; }
            }
          }
        } catch { /* name check is best-effort; save enforces uniqueness */ }
      }
      const partial = board.scenes.length < board.sceneCount;
      board.status = partial ? "approved-partial" : "approved";
      board.scenarioName = target;
      // Re-approve / migrate-remaining: the projects row already exists, so
      // the storyboard links to it immediately. First approve links later at
      // PUT save (pgLinkDirectorBoards), once the client-created row exists.
      try {
        const pid = await pgProjectId(target);
        board.project_id = pid;
        if (pid != null) await pgLinkDirectorBoards(target, pid);
      } catch { /* link is best-effort; the PUT save links too */ }
      board.migratedScenes = board.scenes.length;
      board.error = null;
      writeDirectorBoard(board);
      // The CLIENT persists via the existing saveScenario (PUT
      // /api/scenario/:name) — identical semantics to the Scenario Editor
      // Save — then opens the workspace for standard generation.
      return json(res, 200, { name: target, config, partial, migrated: board.scenes.length, sceneCount: board.sceneCount, timing_corrections: timingCorrections });
    }
    // ------------------------------------------------- Sanskriti Kids Studio
    // A PROJECT LAYER on top of the EXISTING pipeline (never a parallel
    // renderer): the studio owns the kids-specific data (project brief,
    // Director Plan, mirrored scenes/characters, assets, jobs) in its own
    // `Sanskriti_kids` database, while story analysis, scene planning,
    // approval, image/video generation, dialogue and the final cut all run
    // through the shared Director + workspace engines unchanged.
    const kidsDbFor = (store) => (store === "pg" ? kidsPool : kidsDb);
    if (p === "/api/kids/health" && req.method === "GET") {
      const store = kidsStore();
      let comfy = { up: false };
      try { comfy = await comfyStatus(); } catch (e) { comfy = { up: false, error: String(e.message || e) }; }
      return json(res, 200, {
        db: { up: !!store, store: store || null, database: KIDS_DB_NAME },
        comfy: { up: !!comfy.up, error: comfy.error || null },
      });
    }
    if (p === "/api/kids/dashboard" && req.method === "GET") {
      const store = kidsStore();
      if (!store) return json(res, 503, { error: "database unavailable" });
      const payload = await kidsDashboard(store, kidsDbFor(store));
      // Images / videos / completed cuts are counted from the REAL generated
      // files on disk (the same source the Home dashboard uses) for every
      // kids project that was approved into a scenario — never a guess.
      const projects = await kidsListProjects(store, kidsDbFor(store));
      const assets = [];
      for (const project of projects) {
        if (!project.scenario_name) continue;
        const dirs = allDirsFor(folderSlug(project.scenario_name));
        const cov = diskCoverageFor(dirs, null);
        for (const n of cov.kf) assets.push({ kind: "image", status: "COMPLETED", project_id: project.id });
        for (const n of cov.clips) assets.push({ kind: "video", status: "COMPLETED", project_id: project.id });
        if (cov.final) assets.push({ kind: "final", status: "COMPLETED", project_id: project.id });
        if (cov.ref) assets.push({ kind: "reference", status: "COMPLETED", project_id: project.id });
      }
      payload.metrics = kidsDashboardMetrics({
        projects,
        scenes: payload.scenes || [],
        characters: payload.characters || [],
        assets,
        jobs: payload.jobs || [],
      });
      return json(res, 200, payload);
    }
    if (p === "/api/kids/options" && req.method === "GET") {
      const store = kidsStore();
      if (!store) return json(res, 503, { error: "database unavailable" });
      return json(res, 200, await kidsOptions(store, kidsDbFor(store)));
    }
    if (p === "/api/kids/options" && req.method === "PUT") {
      const store = kidsStore();
      if (!store) return json(res, 503, { error: "database unavailable" });
      const body = await readJson(req);
      const key = String(body.key || "");
      if (!KIDS_OPTION_KEYS.includes(key)) return json(res, 400, { error: `unknown option list "${key}"` });
      const values = Array.isArray(body.values) ? body.values : [];
      if (!values.length) return json(res, 400, { error: "the option list cannot be empty" });
      await kidsSetOptions(store, kidsDbFor(store), key, values);
      return json(res, 200, await kidsOptions(store, kidsDbFor(store)));
    }
    if (p === "/api/kids/projects" && req.method === "GET") {
      const store = kidsStore();
      if (!store) return json(res, 503, { error: "database unavailable" });
      return json(res, 200, await kidsListProjects(store, kidsDbFor(store)));
    }
    if (p === "/api/kids/projects" && req.method === "POST") {
      const store = kidsStore();
      if (!store) return json(res, 503, { error: "database unavailable" });
      const body = await readJson(req);
      const options = await kidsOptions(store, kidsDbFor(store));
      const project = normalizeKidsProject(body, { options });
      const check = validateKidsProject(project);
      if (check.errors.length) return json(res, 400, { error: check.errors[0], errors: check.errors });
      const id = kidsSlug(project.title, `kids_${Date.now().toString(36)}`);
      const name = `${id}${await kidsProjectNameExists(store, kidsDbFor(store), id) ? `_${Date.now().toString(36)}` : ""}`;
      // The measured duration of the uploaded audio rides along in the
      // metadata — the audio stage needs it (ffprobe may be unavailable).
      const audioDuration = Number(body.audio_duration_seconds);
      const metadata = body.audio_duration_seconds
        ? { audio: { duration_seconds: audioDuration, uploaded_at: new Date().toISOString() } }
        : {};
      const row = await kidsInsertProject(store, kidsDbFor(store), {
        id: name, name, ...project, board_id: null, scenario_name: null, metadata,
      });
      return json(res, 200, { project: row, warnings: check.warnings });
    }
    // The studio jobs (story, lyrics, audio analysis, reference stills) — the
    // panels poll this to show the real progress of a running stage.
    if (p === "/api/kids/jobs" && req.method === "GET") {
      const store = kidsStore();
      if (!store) return json(res, 503, { error: "database unavailable" });
      const q = Object.fromEntries(new URL(req.url, "http://x").searchParams.entries());
      const rows = await kidsListJobs(store, kidsDbFor(store), q.project_id ? String(q.project_id) : null);
      const kind = q.kind ? String(q.kind) : "";
      return json(res, 200, { jobs: kind ? rows.filter((j) => j.kind === kind) : rows });
    }
    // --- The production pipeline catalog ---------------------------------
    // The 16 stages with their REAL dependencies plus the honest availability
    // of every service the stage depends on (an offline Whisper or a missing
    // lip-sync engine is reported as unavailable, never assumed).
    if (p === "/api/kids/pipeline" && req.method === "GET") {      const [llm, comfy] = await Promise.all([
        llmStatus().catch(() => ({ up: false })),
        comfyStatus().catch(() => ({ up: false })),
      ]);
      const whisperReady = Boolean(String(process.env.WHISPER_CPP_BIN || "").trim()
        && String(process.env.WHISPER_MODEL || "").trim());
      const lipsyncReady = Boolean(String(process.env.EASY_WAV2LIP_DIR || "").trim()
        || String(process.env.EASY_WAV2LIP_PYTHON || "").trim());
      return json(res, 200, {
        stages: KIDS_PIPELINE_STAGES,
        services: {
          llm: { up: !!(llm && llm.up), model: LLM_MODEL, error: (llm && llm.error) || null },
          comfyui: { up: !!(comfy && comfy.up), error: (comfy && comfy.error) || null },
          whisper: { up: whisperReady, note: whisperReady ? "local whisper.cpp" : "set WHISPER_CPP_BIN and WHISPER_MODEL for transcription" },
          tts: { up: true, note: "edge-tts voices" },
          lipsync: { up: lipsyncReady, note: lipsyncReady ? "Easy-Wav2Lip" : "set EASY_WAV2LIP_DIR / EASY_WAV2LIP_PYTHON" },
          ffmpeg: { up: true },
        },
      });
    }
    // --- The reusable asset library (characters, locations, props) --------
    if (p === "/api/kids/library" && req.method === "GET") {
      const store = kidsStore();
      if (!store) return json(res, 503, { error: "database unavailable" });
      const q = Object.fromEntries(new URL(req.url, "http://x").searchParams.entries());
      const rows = await kidsListLibrary(store, kidsDbFor(store), {
        scope: q.scope ? String(q.scope) : null,
        kind: q.kind ? String(q.kind) : null,
      });
      // The generated reference stills travel with the rows (one query).
      const allFiles = await kidsListAllLibraryFiles(store, kidsDbFor(store));
      const byAsset = new Map();
      for (const f of allFiles) {
        if (!byAsset.has(f.asset_id)) byAsset.set(f.asset_id, []);
        byAsset.get(f.asset_id).push(f);
      }
      return json(res, 200, {
        assets: rows.map((a) => ({ ...a, files: byAsset.get(a.id) || [] })),
        kinds: KIDS_LIBRARY_KINDS,
        categories: KIDS_LIBRARY_CATEGORIES,
      });
    }
    if (p === "/api/kids/library" && req.method === "POST") {
      const store = kidsStore();
      if (!store) return json(res, 503, { error: "database unavailable" });
      const body = await readJson(req);
      const kind = KIDS_LIBRARY_KINDS.includes(String(body.kind)) ? String(body.kind) : "character";
      const asset = normalizeKidsLibraryAsset(body, { kind });
      if (!asset.name) return json(res, 400, { error: "the asset needs a name" });
      const projectId = body.project_id ? String(body.project_id) : null;
      if (projectId) {
        const db = kidsDbFor(store);
        const project = await kidsGetProject(store, db, projectId);
        if (!project) return json(res, 404, { error: "no such project" });
      }
      const row = await kidsInsertLibraryAsset(store, kidsDbFor(store), {
        ...asset,
        scope: projectId || "shared",
        project_id: projectId,
      });
      return json(res, 200, { asset: row });
    }
    if (p.startsWith("/api/kids/library/")) {
      const store = kidsStore();
      if (!store) return json(res, 503, { error: "database unavailable" });
      const db = kidsDbFor(store);
      const segs = p.split("/");
      const id = Number(pathName(segs[4] || ""));
      if (!Number.isInteger(id) || id <= 0) return json(res, 400, { error: "bad library asset id" });
      const existing = await kidsGetLibraryAsset(store, db, id);
      if (!existing) return json(res, 404, { error: "no such library asset" });
      // --- Generate the reference still (the Flux Reference Image workflow) --
      if (segs[5] === "generate" && req.method === "POST") {
        const body = await readJson(req).catch(() => ({}));
        const prompt = String(existing.prompt || "").trim();
        if (!prompt) {
          return json(res, 400, { error: "this asset has no saved prompt — write one first" });
        }
        const workflow = isImageWorkflowId(body.workflow) ? String(body.workflow) : DEFAULT_IMAGE_WORKFLOW;
        const jobId = `kids_ref_${id}_${Date.now().toString(36)}`;
        await kidsUpsertJob(store, db, {
          id: jobId, project_id: existing.scope === "shared" ? null : existing.scope,
          kind: "library_reference", status: "PENDING", error_message: null,
          // The prompt travels VERBATIM — the workflow is used as authored.
          metadata: { asset_id: id, workflow, prompt },
        });
        void kidsPumpJobs();
        return json(res, 202, {
          job: { id: jobId, kind: "library_reference", status: "PENDING" },
          message: "the reference still is queued — the prompt is passed exactly as saved",
        });
      }
      if (segs[5] === "files" && req.method === "GET") {
        return json(res, 200, { files: await kidsListLibraryFiles(store, db, id) });
      }
      if (req.method === "PUT") {
        const body = await readJson(req);
        if (existing.locked === true && body.locked !== true) {
          return json(res, 409, { error: "this asset is locked — unlock it before editing" });
        }
        const patch = normalizeKidsLibraryAsset({ ...existing, ...body }, { kind: existing.kind });
        const updated = await kidsUpdateLibraryAsset(store, db, id, {
          name: patch.name,
          category: patch.category,
          description: patch.description,
          tags: patch.tags,
          prompt: patch.prompt,
          reference_image: patch.reference_image,
          appearance: patch.appearance,
          clothing: patch.clothing,
          colors: patch.colors,
          personality: patch.personality,
          voice: patch.voice,
          movement: patch.movement,
          age_appearance: patch.age_appearance,
          version: patch.version,
          status: patch.status,
          locked: body.locked === undefined ? existing.locked : body.locked === true,
        });
        return json(res, 200, { asset: updated });
      }
      if (req.method === "DELETE") {
        await kidsDeleteLibraryAsset(store, db, id);
        return json(res, 200, { ok: true });
      }
    }    if (p.startsWith("/api/kids/projects/")) {
      const store = kidsStore();
      if (!store) return json(res, 503, { error: "database unavailable" });
      const db = kidsDbFor(store);
      // "/api/kids/projects/<id>[/<rest>]" — segment 4 is the id, 5+ the rest.
      const segs = p.split("/");
      const id = pathName(segs[4] || "");
      const rest = segs.slice(5).join("/");
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return json(res, 400, { error: "bad project id" });
      const project = await kidsGetProject(store, db, id);
      if (!project) return json(res, 404, { error: "no such project" });
      // --- Director Plan ---------------------------------------------------
      if (rest === "plan" && req.method === "GET") {
        const plan = await kidsGetPlan(store, db, id);
        return json(res, 200, { plan, history: await kidsListPlans(store, db, id) });
      }
      if (rest === "plan" && req.method === "PUT") {
        // An APPROVED plan must never be silently overwritten — an explicit
        // unlock is required (the same discipline the Devotional library uses).
        const current = await kidsGetPlan(store, db, id);
        const body = await readJson(req);
        const guard = planEditGuard(current?.status || "draft", { unlock: body.unlock === true });
        if (!guard.allowed) return json(res, 409, { error: guard.error });
        const plan = normalizeKidsDirectorPlan(body.plan || {});
        const saved = await kidsSavePlan(store, db, id, plan, { status: "draft", note: String(body.note || "") });
        return json(res, 200, { plan: saved });
      }
      if (rest === "plan" && req.method === "POST") {
        // Generate a fresh Director Plan with the AI. The prompt is built by
        // the shared pure helper; the plan is stored as a NEW version.
        const body = await readJson(req).catch(() => ({}));
        const script = body.script || project.script || project.lyrics;
        if (!hasScript(script)) {
          return json(res, 400, { error: "the project needs a script or lyrics before the Director can plan" });
        }
        const draft = normalizeKidsProject({ ...project, script, lyrics: project.lyrics }, {
          options: await kidsOptions(store, db),
        });
        let plan;
        try {
          const raw = await llmChatJson({
            system: KIDS_DIRECTOR_SYSTEM,
            user: buildKidsDirectorPlanPrompt(draft, { promptAddons: kidsPromptAddons(readDirectorPromptSettings()) }),
            maxTokens: 16000,
            temperature: 0.7,
            timeoutMs: REQUEST_TIMEOUT_MS,
            rawTag: `_raw_${id}_kids_plan.log`,
          });
          assertNoCJK(raw, "the kids Director Plan");
          plan = normalizeKidsDirectorPlan(raw);
        } catch (e) {
          await kidsUpsertJob(store, db, {
            id: `kids_plan_${id}_${Date.now().toString(36)}`,
            project_id: id, kind: "director_plan", status: "FAILED",
            error_message: String(e.message || e).slice(0, 500), metadata: {},
          });
          return json(res, 502, { error: `the Director could not plan this project: ${String(e.message || e).slice(0, 300)}` });
        }
        if (!isPlanSubstantive(plan)) {
          return json(res, 502, { error: "the Director returned an empty plan — try again" });
        }
        const saved = await kidsSavePlan(store, db, id, plan, { status: "draft", note: "AI generated" });
        await kidsUpsertJob(store, db, {
          id: `kids_plan_${id}_${Date.now().toString(36)}`,
          project_id: id, kind: "director_plan", status: "COMPLETED", metadata: { version: saved.version },
        });
        return json(res, 200, { plan: saved });
      }
      if (rest === "plan/approve" && req.method === "POST") {
        const current = await kidsGetPlan(store, db, id);
        if (!current) return json(res, 404, { error: "this project has no Director Plan yet" });
        const approved = await kidsApprovePlan(store, db, id, current.version);
        await kidsUpdateProject(store, db, id, { status: "approved" });
        return json(res, 200, { plan: approved });
      }
      // --- Link / mirror the shared Director board ------------------------
      // The studio does NOT plan scenes itself: the existing Director engine
      // owns the bible and the scene plan. The studio links the board and
      // MIRRORS its scenes + characters so the dashboard, the gallery and the
      // project page all read one source of truth.
      if ((rest === "board" && req.method === "PUT") || (rest === "sync" && req.method === "POST")) {
        const body = rest === "board" ? await readJson(req) : {};
        const boardId = String(body.board_id || project.board_id || "");
        if (!boardId) return json(res, 400, { error: "no Director board to link" });
        let board;
        try { board = readDirectorBoard(boardId); }
        catch (e) { return json(res, 404, { error: `storyboard not found: ${String(e.message || e)}` }); }
        const scenes = (board.scenes || []).map((s) => ({
          scene_number: Number(s.scene_number) || 0,
          title: String(s.title || ""),
          synopsis: String(s.story_beat || s.action || ""),
          duration_seconds: Number(s.duration_seconds) || 0,
          camera: [s.camera?.shot_type, s.camera?.movement].filter(Boolean).join(" · "),
          transition: String(s.transition_to_next_scene || ""),
          prompt: String(s.image_prompt || ""),
          status: String(s.status || "planned"),
        }));
        const characters = (board.blueprint?.characters || []).map((c) => ({
          character_id: String(c.character_id || ""),
          name: String(c.name || ""),
          role: String(c.role || ""),
          species: String(c.species || ""),
          description: Object.entries(c.appearance || {}).map(([k, v]) => `${k}: ${v}`).join(", "),
          visual_identity_prompt: String(c.visual_identity_prompt || ""),
        }));
        await kidsReplaceScenes(store, db, id, scenes);
        await kidsReplaceCharacters(store, db, id, characters);
        // The kids cast keeps ONE voice across every scene: the library rows
        // (an explicit voice id wins) decide the per-speaker TTS voices, and
        // the map is written onto the board so the workspace speaks with them.
        try {
          const libChars = (await kidsListLibrary(store, db, { scope: "shared" }))
            .concat(await kidsListLibrary(store, db, { scope: id }))
            .filter((a) => a.kind === "character");
          const voiceMap = buildKidsVoiceMap(libChars, {
            language: project.language,
            existing: (board.input && board.input.tts && board.input.tts.voices) || {},
          });
          if (Object.keys(voiceMap).length) {
            board.input = board.input || {};
            board.input.tts = {
              ...(board.input.tts && typeof board.input.tts === "object" ? board.input.tts : {}),
              language: project.language || (board.input.tts && board.input.tts.language) || "Hindi",
              voices: { ...(board.input.tts && board.input.tts.voices) || {}, ...voiceMap },
            };
            writeDirectorBoard(board);
          }
        } catch (e) { console.warn("[kids] voice map failed:", e.message); }
        // The Director Plan is derived from the board — it can never drift
        // from the storyboard it describes.
        const derived = buildKidsPlanFromBoard(board, project);
        const existing = await kidsGetPlan(store, db, id);
        const plan = existing && existing.status === "approved"
          ? existing
          : await kidsSavePlan(store, db, id, derived, {
            status: "draft", note: "derived from the Director storyboard",
          });
        const updated = await kidsUpdateProject(store, db, id, {
          board_id: boardId,
          status: board.status === "approved" ? "approved" : "planning",
        });
        return json(res, 200, { project: updated, plan, scenes, characters });
      }
      // --- Scenes / characters / assets / jobs (read) ----------------------
      if (rest === "scenes" && req.method === "GET") {
        return json(res, 200, await kidsListScenes(store, db, id));
      }
      if (rest === "characters" && req.method === "GET") {
        return json(res, 200, await kidsListCharacters(store, db, id));
      }
      if (rest === "assets" && req.method === "GET") {
        return json(res, 200, await kidsListAssets(store, db, id));
      }
      if (rest === "jobs" && req.method === "GET") {
        return json(res, 200, await kidsListJobs(store, db, id));
      }
      // ============================================================
      // The production pipeline of ONE project (real state only)
      // ============================================================
      const kidsTry = async (fn) => {
        try { return { ok: true, data: await fn() }; }
        catch (e) { return { ok: false, status: Number(e?.status) || 500, error: String(e?.message || e) }; }
      };
      const kidsState = async () => {
        const [plan, story, lyricSections, audioSegments, scenes, assets, feedback, qcRuns, library, timelineRows] = await Promise.all([
          kidsGetPlan(store, db, id),
          kidsGetStory(store, db, id),
          kidsListLyricSections(store, db, id),
          kidsListAudioSegments(store, db, id),
          kidsListScenes(store, db, id),
          kidsListAssets(store, db, id),
          kidsListFeedback(store, db, id),
          kidsListQcRuns(store, db, id),
          kidsListLibrary(store, db, {}),
          kidsListTimeline(store, db, id),
        ]);
        const mine = (kind) => library.filter((a) => a.kind === kind && (a.scope === "shared" || a.scope === id));
        const characters = mine("character");
        const locations = mine("location");
        const props = mine("prop");
        // The generated media: the REAL files on disk are the source of truth.
        const disk = { images: 0, videos: 0, reference: false, final: null };
        if (project.scenario_name) {
          const dirs = allDirsFor(folderSlug(project.scenario_name));
          for (const dir of dirs) {
            const full = path.join(OUTPUTS, dir);
            if (!fs.existsSync(full)) continue;
            let vm = null;
            try { vm = versionMap(full, prefixFor(dir), []); } catch { vm = null; }
            if (!vm) continue;
            if (vm.refMain) disk.reference = true;
            for (const b of Object.values(vm.beats || {})) {
              if (b.keyframeMain) disk.images += 1;
              if (b.clipMain) disk.videos += 1;
            }
            if (vm.finalMain) disk.final = { dir, file: vm.finalMain, path: path.join(full, vm.finalMain) };
            break;
          }
        }
        const stored = timelineRows.map((r) => r.payload).filter(Boolean);
        const timeline = stored.length
          ? stored
          : buildKidsTimeline({
            scenes: scenes.map((s) => ({
              scene_number: s.scene_number,
              title: s.title,
              duration_seconds: s.duration_seconds,
              text: s.synopsis,
              camera_shot: s.camera,
              image_prompt: s.prompt,
            })),
            segments: audioSegments,
            characters,
            locations,
            props,
          });
        return {
          plan, story, lyricSections, audioSegments, scenes, assets, feedback,
          qcRuns, characters, locations, props, timeline, library, disk,
        };
      };
      const kidsStageList = async () => {
        const s = await kidsState();
        const stages = kidsStageStatus({
          plan: s.plan,
          story: s.story,
          lyricSections: s.lyricSections,
          audioSegments: s.audioSegments,
          characters: s.characters,
          locations: s.locations,
          props: s.props,
          scenes: s.scenes,
          timeline: s.timeline,
          images: s.disk.images,
          videos: s.disk.videos,
          voices: s.assets.filter((a) => a.kind === "audio"),
          final: s.disk.final,
          assets: s.assets,
          qc: s.qcRuns[0] || null,
          feedback: s.feedback,
        });
        return { stages, runnable: kidsRunnableStages(stages) };
      };
      if (rest === "pipeline" && req.method === "GET") {
        return json(res, 200, await kidsStageList());
      }
      if (rest === "pipeline" && req.method === "POST") {
        // Run the SELECTED stages. Only the stages the studio can execute
        // itself are executed here; the generation stages are delegated to the
        // EXISTING engines (the Director board + the workspace run) and are
        // reported as "needs the workspace" instead of being faked.
        const body = await readJson(req).catch(() => ({}));
        const requested = Array.isArray(body.stages) ? body.stages.map(String) : [];
        if (!requested.length) return json(res, 400, { error: "select at least one stage to run" });
        const { stages, runnable } = await kidsStageList();
        const results = [];
        for (const stageId of requested) {
          const stage = stages.find((s) => s.id === stageId);
          if (!stage) { results.push({ stage: stageId, status: "unknown", message: "unknown stage" }); continue; }
          if (!runnable.includes(stageId) && stage.status !== "done") {
            results.push({
              stage: stageId, status: "blocked",
              message: `blocked by ${stage.blocked_by.join(", ") || "an earlier stage"}`,
            });
            continue;
          }
          const run = async (fn) => {
            const r = await kidsTry(fn);
            return r.ok ? { status: "completed", message: "" } : { status: "failed", message: r.error };
          };
          if (stageId === "story") {
            // The story runs as a background job (a local model needs minutes).
            const jobId = `kids_story_${id}_${Date.now().toString(36)}`;
            await kidsUpsertJob(store, db, {
              id: jobId, project_id: id, kind: "story", status: "PROCESSING",
              error_message: null, metadata: { started_at: new Date().toISOString() },
            });
            (async () => {
              try {
                const saved = await generateKidsStory(store, db, project, {});
                await kidsUpsertJob(store, db, {
                  id: jobId, project_id: id, kind: "story", status: "COMPLETED",
                  error_message: null, metadata: { version: saved.version },
                });
              } catch (e) {
                await kidsUpsertJob(store, db, {
                  id: jobId, project_id: id, kind: "story", status: "FAILED",
                  error_message: String(e.message || e).slice(0, 500), metadata: {},
                });
              }
            })();
            results.push({ stage: stageId, status: "started", message: "the story is being written — follow the job" });
            continue;
          }
          if (stageId === "song") {
            const r = await kidsTry(() => analyzeKidsLyrics(store, db, project, {}));
            results.push({
              stage: stageId, status: r.ok ? "completed" : "failed",
              message: r.ok ? `${r.data.sections.length} lyric section(s) saved` : r.error,
            });
            continue;
          }
          if (stageId === "audio") {
            const r = await kidsTry(() => analyzeKidsAudio(store, db, project, {}));
            results.push({
              stage: stageId, status: r.ok ? "completed" : "failed",
              message: r.ok ? `${r.data.segments.length} audio segment(s) measured` : r.error,
            });
            continue;
          }
          if (stageId === "storyboard") {
            const r = await kidsTry(() => buildKidsTimelineForProject(store, db, project));
            results.push({
              stage: stageId, status: r.ok ? "completed" : "failed",
              message: r.ok ? `${r.data.length} scene(s) on the timeline` : r.error,
            });
            continue;
          }
          if (stageId === "qc") {
            const r = await kidsTry(() => runKidsQc(store, db, project));
            results.push({
              stage: stageId, status: r.ok ? "completed" : "failed",
              message: r.ok ? `${r.data.summary.errors} error(s), ${r.data.summary.warnings} warning(s)` : r.error,
            });
            continue;
          }
          results.push({
            stage: stageId, status: "delegated",
            message: `${stage.label} runs in the ${stage.engine === "comfyui" ? "workspace / Director" : stage.engine} engine — open it to generate`,
          });
        }
        await kidsUpsertJob(store, db, {
          id: `kids_pipeline_${id}_${Date.now().toString(36)}`,
          project_id: id, kind: "pipeline", status: "COMPLETED",
          error_message: null, metadata: { stages: requested, results },
        });
        return json(res, 200, { results, ...(await kidsStageList()) });
      }
      // ============================================================
      // Story Studio
      // ============================================================
      if (rest === "story" && req.method === "GET") {
        const story = await kidsGetStory(store, db, id);
        const jobs = await kidsListJobs(store, db, id);
        return json(res, 200, {
          story,
          history: await kidsListStories(store, db, id),
          job: jobs.find((j) => j.kind === "story") || null,
        });
      }
      if (rest === "story" && req.method === "POST") {
        if (!project) return json(res, 404, { error: "no such project" });
        const body = await readJson(req).catch(() => ({}));
        // The AI story can take minutes on a local model — it runs as a JOB
        // (the studio's own job table) so the request never blocks the UI.
        // The client polls GET /api/kids/projects/:id/story.
        const jobId = `kids_story_${id}_${Date.now().toString(36)}`;
        const check = hasScript(body.script || project.script || body.lyrics || project.lyrics);
        if (!check) {
          return json(res, 400, { error: "the project needs a script or lyrics before the story can be written" });
        }
        await kidsUpsertJob(store, db, {
          id: jobId, project_id: id, kind: "story", status: "PROCESSING",
          error_message: null, metadata: { started_at: new Date().toISOString() },
        });
        // Fire and forget - the job row carries the outcome.
        (async () => {
          try {
            const saved = await generateKidsStory(store, db, project, body);
            await kidsUpsertJob(store, db, {
              id: jobId, project_id: id, kind: "story", status: "COMPLETED",
              error_message: null, metadata: { version: saved.version },
            });
          } catch (e) {
            await kidsUpsertJob(store, db, {
              id: jobId, project_id: id, kind: "story", status: "FAILED",
              error_message: String(e.message || e).slice(0, 500), metadata: {},
            });
          }
        })();
        return json(res, 202, {
          job: { id: jobId, kind: "story", status: "PROCESSING" },
          message: "the Director is writing the story — this tab polls the job",
        });
      }
      if (rest === "story" && req.method === "PUT") {
        const body = await readJson(req);
        const current = await kidsGetStory(store, db, id);
        if (current && current.status === "approved" && body.unlock !== true) {
          return json(res, 409, { error: "this story is approved — unlock it before editing" });
        }
        const story = normalizeKidsStory(body.story || {});
        if (!isKidsStorySubstantive(story)) {
          return json(res, 400, { error: "the story is empty" });
        }
        const check = validateKidsStory(story);
        const saved = await kidsSaveStory(store, db, id, story, {
          status: "draft", note: String(body.note || "edited"),
        });
        return json(res, 200, { story: saved, warnings: check.warnings, errors: check.errors });
      }
      if (rest === "story/approve" && req.method === "POST") {
        const current = await kidsGetStory(store, db, id);
        if (!current) return json(res, 404, { error: "this project has no story yet" });
        const story = normalizeKidsStory(current.story);
        const check = validateKidsStory(story);
        if (check.errors.length) return json(res, 400, { error: check.errors[0], errors: check.errors });
        const approved = await kidsApproveStory(store, db, id, current.version);
        return json(res, 200, { story: approved, warnings: check.warnings });
      }
      // ============================================================
      // Song & Lyrics Studio
      // ============================================================
      if (rest === "lyrics" && req.method === "GET") {
        return json(res, 200, { sections: await kidsListLyricSections(store, db, id) });
      }
      if (rest === "lyrics" && req.method === "POST") {
        const body = await readJson(req).catch(() => ({}));
        const r = await kidsTry(() => analyzeKidsLyrics(store, db, project, body));
        if (!r.ok) return json(res, r.status, { error: r.error });
        return json(res, 200, r.data);
      }
      // ============================================================
      // Audio Analysis and Narration
      // ============================================================
      if (rest === "audio-analysis" && req.method === "GET") {
        return json(res, 200, { segments: await kidsListAudioSegments(store, db, id) });
      }
      if (rest === "audio-analysis" && req.method === "POST") {
        const body = await readJson(req).catch(() => ({}));
        const r = await kidsTry(() => analyzeKidsAudio(store, db, project, body));
        if (!r.ok) return json(res, r.status, { error: r.error });
        return json(res, 200, r.data);
      }
      // ============================================================
      // Storyboard and Scene Timeline
      // ============================================================
      if (rest === "timeline" && req.method === "GET") {
        const rows = await kidsListTimeline(store, db, id);
        if (rows.length) return json(res, 200, { timeline: rows.map((r) => r.payload) });
        const built = await buildKidsTimelineForProject(store, db, project);
        return json(res, 200, { timeline: built, saved: false });
      }
      if (rest === "timeline" && req.method === "PUT") {
        const body = await readJson(req);
        const rows = Array.isArray(body.timeline) ? body.timeline : [];
        if (!rows.length) return json(res, 400, { error: "the timeline is empty" });
        const check = validateKidsTimeline(rows, { duration: Number(body.duration_seconds) || 0 });
        const saved = await kidsReplaceTimeline(store, db, id, rows.map((r, i) => ({
          scene_number: Number(r.scene_number) || i + 1,
          payload: r,
        })));
        return json(res, 200, { timeline: saved.map((r) => r.payload), warnings: check.warnings, errors: check.errors });
      }
      if (rest === "timeline/build" && req.method === "POST") {
        const r = await kidsTry(() => buildKidsTimelineForProject(store, db, project));
        if (!r.ok) return json(res, r.status, { error: r.error });
        return json(res, 200, { timeline: r.data });
      }
      // ============================================================
      // Quality control and export
      // ============================================================
      if (rest === "qc" && req.method === "GET") {
        const runs = await kidsListQcRuns(store, db, id);
        return json(res, 200, { runs, latest: runs[0] || null });
      }
      if (rest === "qc" && req.method === "POST") {
        const r = await kidsTry(() => runKidsQc(store, db, project));
        if (!r.ok) return json(res, r.status, { error: r.error });
        return json(res, 200, r.data);
      }
      if (rest === "exports" && req.method === "GET") {
        return json(res, 200, { exports: await kidsListExports(store, db, id) });
      }
      if (rest === "export" && req.method === "POST") {
        const body = await readJson(req).catch(() => ({}));
        const profile = String(body.profile || "youtube");
        const s = await kidsState();
        if (!s.disk.final) {
          return json(res, 400, {
            error: "there is no final cut yet — generate the clips and assemble the video first",
          });
        }
        const duration = await videoDurationSec(s.disk.final.path);
        const resolution = String(body.resolution || project.resolution || "");
        const row = await kidsInsertExport(store, db, {
          project_id: id,
          profile,
          status: "recorded",
          file_path: s.disk.final.path,
          duration_seconds: duration || 0,
          resolution,
          notes: String(body.notes || "").slice(0, 500),
        });
        return json(res, 200, {
          export: {
            id: Number(row.id),
            profile,
            status: "recorded",
            file_path: s.disk.final.path,
            duration_seconds: duration || 0,
            resolution,
          },
          message: "the export record was written — the file itself was produced by the FFmpeg assembly step",
        });
      }
      // ============================================================
      // Unified production (audio-driven + story-only) — additive routes.
      // Original WAV metadata is the timing authority; timelines, blueprints
      // and snapshots store references + versions, never a second audio clock.
      // ============================================================
      if (rest === "production-mode" && req.method === "GET") {
        const audios = await kidsListAudioAssets(store, db, id);
        const mode = resolveProductionMode({ audioAsset: audios[0] ? { durationSec: audios[0].duration_sec } : null });
        return json(res, 200, { productionMode: mode, audioAsset: audios[0] || null });
      }
      if (rest === "audio-asset" && req.method === "POST") {
        const body = await readJson(req).catch(() => ({}));
        const durationSec = Number(body.duration_sec ?? body.durationSec ?? 0);
        if (!(durationSec > 0)) return json(res, 400, { error: "audio-asset requires a positive duration_sec (original WAV authority)" });
        const row = await kidsInsertAudioAsset(store, db, {
          id: String(body.id || `audio-${id}-${Date.now().toString(36)}`),
          project_id: id,
          original_filename: String(body.original_filename || body.originalFilename || "original.wav"),
          file_path: String(body.file_path || body.filePath || ""),
          duration_sec: durationSec,
          sample_rate_hz: Number(body.sample_rate_hz || 48000),
          channels: Number(body.channels || 2),
          metadata: { lyrics_version: body.lyrics_version || null, language: body.language || project.language || "" },
        });
        return json(res, 200, { audioAsset: row, productionMode: "audio_driven" });
      }
      if (rest === "audio-asset" && req.method === "GET") {
        return json(res, 200, { assets: await kidsListAudioAssets(store, db, id) });
      }
      if (rest === "unified-timeline" && req.method === "POST") {
        const body = await readJson(req).catch(() => ({}));
        let timeline;
        try {
          timeline = buildUnifiedTimeline({
            productionId: id,
            audioAsset: body.audioAsset || { durationSec: Number(project.duration_seconds || 60) },
            frameRate: Number(body.frame_rate || 30),
            musicSections: body.musicSections || [],
            lyricLines: body.lyricLines || [],
            speakerEvents: body.speakerEvents || [],
            narrativeEvents: body.narrativeEvents || [],
            characterAppearances: body.characterAppearances || [],
            characterActions: body.characterActions || [],
            emotions: body.emotions || [],
            choreography: body.choreography || [],
            cameraDirections: body.cameraDirections || [],
            soundEffects: body.soundEffects || [],
            transitions: body.transitions || [],
            subtitles: body.subtitles || [],
          });
        } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
        const check = validateUnifiedTimeline(timeline);
        if (check.errors.length) return json(res, 400, { error: check.errors[0], errors: check.errors, warnings: check.warnings });
        const saved = await kidsSaveUnifiedTimeline(store, db, id, timeline);
        return json(res, 200, { timeline: saved.timeline || timeline, record: saved, warnings: check.warnings });
      }
      if (rest === "unified-timeline" && req.method === "GET") {
        return json(res, 200, { timelines: await kidsListTimelines(store, db, id) });
      }
      if (rest === "unified-timeline/approve" && req.method === "POST") {
        const body = await readJson(req).catch(() => ({}));
        const version = Number(body.version || 0);
        if (!(version > 0)) return json(res, 400, { error: "version is required" });
        const approved = await kidsApproveTimeline(store, db, id, version);
        if (!approved) return json(res, 404, { error: "no such timeline version" });
        return json(res, 200, { timeline: approved });
      }
      if (rest === "pacing-blueprint" && req.method === "POST") {
        const body = await readJson(req).catch(() => ({}));
        const timelines = await kidsListTimelines(store, db, id);
        const latest = timelines.find((t) => t.status === "approved") || timelines[0] || null;
        let blueprint;
        try {
          blueprint = buildDurationPacingBlueprint({
            productionId: id,
            productionMode: body.productionMode || (latest ? "audio_driven" : "story_only"),
            audioDurationMs: body.audioDurationMs ?? (latest ? latest.master_duration_ms : undefined),
            frameRate: Number(body.frame_rate || latest?.frame_rate || 30),
            timeline: latest?.timeline || body.timeline || { tracks: {} },
            narrativeEvents: body.narrativeEvents || [],
            lyricLines: body.lyricLines || [],
            userOverrideMs: body.userOverrideMs,
          });
        } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
        if (blueprint.validation.errors.length) {
          return json(res, 400, { error: blueprint.validation.errors[0], errors: blueprint.validation.errors, blueprint });
        }
        const saved = await kidsSaveBlueprint(store, db, id, blueprint);
        return json(res, 200, { blueprint, record: saved });
      }
      if (rest === "pacing-blueprint" && req.method === "GET") {
        return json(res, 200, { blueprints: await kidsListBlueprints(store, db, id) });
      }
      if (rest === "pacing-blueprint/approve" && req.method === "POST") {
        const body = await readJson(req).catch(() => ({}));
        const version = Number(body.version || 0);
        if (!(version > 0)) return json(res, 400, { error: "version is required" });
        const approved = await kidsApproveBlueprint(store, db, id, version);
        if (!approved) return json(res, 404, { error: "no such blueprint version" });
        return json(res, 200, { blueprint: approved });
      }
      if (rest === "director-snapshot" && req.method === "POST") {
        const body = await readJson(req).catch(() => ({}));
        const snapshot = buildDirectorInputSnapshot({ productionId: id, ...body });
        const saved = await kidsSaveSnapshot(store, db, id, snapshot);
        return json(res, 200, { snapshot, record: saved });
      }
      if (rest === "director-snapshot" && req.method === "GET") {
        const snaps = await kidsListSnapshots(store, db, id);
        return json(res, 200, { snapshots: snaps });
      }
      if (rest === "director-gate" && req.method === "GET") {
        const [audios, timelines, blueprints, snaps] = await Promise.all([
          kidsListAudioAssets(store, db, id), kidsListTimelines(store, db, id), kidsListBlueprints(store, db, id), kidsListSnapshots(store, db, id),
        ]);
        const approvedTl = timelines.find((t) => t.status === "approved");
        const approvedBp = blueprints.find((b) => b.approved === true || b.approved === 1);
        const mode = approvedTl || approvedBp || audios[0]
          ? "audio_driven"
          : resolveProductionMode({});
        const gate = canRunDirector({
          productionMode: mode,
          timelineApprovalStatus: approvedTl ? "approved" : "pending",
          durationBlueprintApproved: Boolean(approvedBp),
          directorInputSnapshotId: snaps[0]?.id || null,
        });
        let staleness = { stale: false, affected: [], reasons: [] };
        if (snaps[0]?.snapshot && approvedTl) {
          staleness = isSnapshotStale(snaps[0].snapshot, { masterTimelineVersion: approvedTl.version });
        }
        return json(res, 200, { gate, staleness, mode });
      }
      // ============================================================
      // AI Learning and Feedback
      // ============================================================
      if (rest === "feedback" && req.method === "GET") {
        const rows = await kidsListFeedback(store, db, id);
        return json(res, 200, {
          feedback: rows,
          training_examples: kidsTrainingExamples(rows),
        });
      }
      if (rest === "feedback" && req.method === "POST") {
        const body = await readJson(req);
        const record = normalizeKidsFeedback(body);
        if (record.errors.length) return json(res, 400, { error: record.errors[0], errors: record.errors });
        const id2 = record.id || `kids_fb_${id}_${Date.now().toString(36)}`;
        const row = await kidsInsertFeedback(store, db, {
          id: id2,
          project_id: id,
          target_kind: record.target_kind,
          target_id: record.target_id,
          rating: record.rating,
          verdict: record.verdict,
          note: record.note,
          corrected_text: record.corrected_text,
          use_for_training: record.use_for_training,
          payload: record.payload,
        });
        return json(res, 200, {
          feedback: {
            id: row.id,
            target_kind: row.target_kind,
            target_id: row.target_id,
            rating: row.rating == null ? null : Number(row.rating),
            verdict: row.verdict,
            note: row.note,
            use_for_training: row.use_for_training === true || Number(row.use_for_training) === 1,
            created_at: row.created_at ?? null,
          },
        });
      }
      // --- The project itself ----------------------------------------------
      if (!rest && req.method === "GET") {
        const [plan, planHistory, scenes, characters, assets, jobs] = await Promise.all([
          kidsGetPlan(store, db, id),
          kidsListPlans(store, db, id),
          kidsListScenes(store, db, id),
          kidsListCharacters(store, db, id),
          kidsListAssets(store, db, id),
          kidsListJobs(store, db, id),
        ]);
        const [story, storyHistory, lyricSections, audioSegments, timelineRows, library, feedback, qcRuns, exports] = await Promise.all([
          kidsGetStory(store, db, id),
          kidsListStories(store, db, id),
          kidsListLyricSections(store, db, id),
          kidsListAudioSegments(store, db, id),
          kidsListTimeline(store, db, id),
          kidsListLibrary(store, db, {}),
          kidsListFeedback(store, db, id),
          kidsListQcRuns(store, db, id),
          kidsListExports(store, db, id),
        ]);
        const mine = (kind) => library.filter((a) => a.kind === kind && (a.scope === "shared" || a.scope === id));
        return json(res, 200, {
          project, plan, planHistory, scenes, characters, assets, jobs,
          story, storyHistory, lyricSections, audioSegments,
          timeline: timelineRows.map((r) => r.payload),
          library: {
            characters: mine("character"),
            locations: mine("location"),
            props: mine("prop"),
          },
          feedback, qcRuns, exports,
        });
      }
      if (!rest && req.method === "PUT") {
        const body = await readJson(req);
        const options = await kidsOptions(store, db);
        const merged = normalizeKidsProject({ ...project, ...body }, { options });
        // The brief fields the Director already consumed are NOT silently
        // rewritten — a change to script/lyrics after a plan exists needs an
        // explicit reset so the approved plan can never drift from the brief.
        if (body.reset_plan === true) {
          await kidsSavePlan(store, db, id, { version: 1 }, { status: "draft", note: "brief changed — plan reset" });
        }
        const updated = await kidsUpdateProject(store, db, id, {
          ...merged,
          board_id: body.board_id !== undefined ? body.board_id : project.board_id,
          scenario_name: body.scenario_name !== undefined ? body.scenario_name : project.scenario_name,
        });
        const check = validateKidsProject(merged);
        return json(res, 200, { project: updated, warnings: check.warnings, errors: check.errors });
      }
      if (!rest && req.method === "DELETE") {
        const removed = await kidsDeleteProject(store, db, id);
        if (!removed) return json(res, 404, { error: "no such project" });
        return json(res, 200, { ok: true });
      }
    }
    // ------------------------------------------------- Documentary Mode
    // Orchestration layer on top of the EXISTING pipeline (never a parallel
    // renderer): brief -> chapters -> sequences -> shots + Hindi narration +
    // character/location bibles via the shared llmChatJson convention, with a
    // deterministic heuristic fallback when the LLM is offline. APPROVE hands
    // a standard scenario config to the existing saveScenario/workspace
    // pipeline (client PUTs, then opens the workspace) — Flux/LTX/Wan, TTS,
    // ACE-Step, lip-sync, SSE, versioning, resume and FFmpeg assembly are all
    // reused unchanged. Boards persist to documentary/*.json (offline
    // fallback) mirrored into documentary_boards (DB-backed list).
    const docBoardFile = (id) => path.join(DOCUMENTARY, `${id}.json`);
    const readDocBoard = (id) => {
      if (!isSafe(id)) throw new Error("bad documentary id");
      const f = docBoardFile(id);
      if (!fs.existsSync(f)) throw new Error("documentary not found");
      return JSON.parse(fs.readFileSync(f, "utf8"));
    };
    const writeDocBoard = (board) => {
      fs.mkdirSync(DOCUMENTARY, { recursive: true });
      board.updatedAt = new Date().toISOString();
      fs.writeFileSync(docBoardFile(board.id), JSON.stringify(board, null, 2));
      pgUpsertDocBoard(board).catch((e) => console.warn("[pg] documentary board mirror failed:", e.message));
      return board;
    };
    const docBoardMeta = (b) => ({
      id: b.id,
      title: (b.brief && b.brief.title) || b.id,
      status: b.status,
      targetSeconds: (b.brief && b.brief.targetSeconds) || null,
      shots: countBoardShots(b),
      shotsTotal: countBoardShots(b),
      scenarioName: b.scenarioName ?? null,
      project_id: Number.isInteger(b.project_id) ? b.project_id : null,
      updatedAt: b.updatedAt ?? null,
      createdAt: b.createdAt ?? null,
    });
    const docSlug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || `doc_${Date.now().toString(36)}`;
    if (p === "/api/documentary/boards" && req.method === "POST") {
      // Blank/Auto brief fields are detected automatically (heuristic,
      // instant + offline-safe); manual typing always wins. Duration is
      // never typed — estimated from the source text when absent.
      // validateDocBrief stays the final fallback for anything still empty.
      const rawBody = await readJson(req);
      if (rawBody.targetMinutes == null && rawBody.targetSeconds == null) {
        rawBody.targetSeconds = heuristicEstimateDuration(rawBody);
      }
      // Topic is never typed either — derived from the pasted story/poem.
      if (!String(rawBody.topic || "").trim()) {
        rawBody.topic = heuristicTopicText(rawBody.sourceMaterial || rawBody.story, rawBody.title);
      }
      const brief = validateDocBrief(fillDocBriefAuto(rawBody));
      // Unique board id: a repeated title must never overwrite an existing
      // board (mirrors the approve-time scenario dedup below).
      const base = docSlug(brief.title);
      let id = base;
      for (let i = 2; ; i++) {
        let taken = fs.existsSync(docBoardFile(id));
        if (!taken && pgUp) {
          try {
            const r = await pgPool.query("SELECT 1 FROM documentary_boards WHERE board_id = $1", [id]);
            taken = r.rows.length > 0;
          } catch { taken = false; }
        }
        if (!taken) break;
        id = `${base}_${i}`;
      }
      const now = new Date().toISOString();
      const board = writeDocBoard({
        id, brief, status: "brief",
        chapters: [], characters: [], locations: [], musicBeds: [],
        analysis: null,
        stage_approvals: {},
        stage_history: [],
        styleLock: brief.visualStyle,
        sceneCount: 0, shotCount: 0,
        scenarioName: null, project_id: null,
        error: null, createdAt: now, updatedAt: now,
      });
      return json(res, 200, board);
    }
    // Brief auto-detection preview (Documentary-only): the full brief form
    // needs only title/topic/source — tone, audience, visual style,
    // narration, music, source type, language, characters, events and
    // locations come back detected (LLM, heuristic offline). Nothing stored.
    if (p === "/api/documentary/detect-brief" && req.method === "POST") {
      const body = await readJson(req);
      const input = {
        title: String(body.title ?? ""),
        topic: String(body.topic ?? ""),
        sourceMaterial: String(body.sourceMaterial ?? body.story ?? ""),
      };
      if (!input.title.trim() && !input.topic.trim() && !input.sourceMaterial.trim()) {
        return json(res, 400, { error: "title, topic or source material required" });
      }
      try {
        const raw = await llmChatJson({
          system: DOCUMENTARY_DIRECTOR_SYSTEM,
          user: buildDocBriefDetectPrompt(input),
          maxTokens: 1500, temperature: 0.3, timeoutMs: REQUEST_TIMEOUT_MS,
          rawTag: `_raw_doc_detect_brief.log`,
        });
        const detected = normalizeDocDetectedBrief(raw);
        const filled = { ...detected };
        const heur = heuristicDetectBrief(input);
        for (const k of Object.keys(filled)) {
          if (!String(filled[k] ?? "").trim() && String(heur[k] ?? "").trim()) filled[k] = heur[k];
        }
        return json(res, 200, { detected: filled, source: "llm" });
      } catch (e) {
        console.warn(`[documentary] detect-brief LLM failed, heuristic fallback: ${e.message}`);
        return json(res, 200, { detected: normalizeDocDetectedBrief(heuristicDetectBrief(input)), source: "heuristic" });
      }
    }
    if (p === "/api/documentary/boards" && req.method === "GET") {
      fs.mkdirSync(DOCUMENTARY, { recursive: true });
      const seen = new Map();
      if (pgUp) {
        try {
          const r = await pgPool.query("SELECT board_id, board FROM documentary_boards");
          for (const row of r.rows) {
            try {
              const b = typeof row.board === "string" ? JSON.parse(row.board) : row.board;
              if (b && b.id) seen.set(String(b.id), docBoardMeta(b));
            } catch { /* skip corrupt rows */ }
          }
        } catch (e) { console.warn("[pg] documentary boards list failed:", e.message); }
      }
      for (const f of fs.readdirSync(DOCUMENTARY).filter((f) => f.endsWith(".json") && !f.startsWith("_raw"))) {
        try {
          const b = JSON.parse(fs.readFileSync(path.join(DOCUMENTARY, f), "utf8"));
          if (b && b.id && !seen.has(String(b.id))) {
            seen.set(String(b.id), docBoardMeta(b));
            if (pgUp) pgUpsertDocBoard(b).catch((e) => console.warn("[pg] documentary board backfill failed:", e.message));
          }
        } catch { /* skip corrupt board files */ }
      }
      const list = [...seen.values()];
      list.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
      return json(res, 200, list);
    }
    {
      const mDoc = p.match(/^\/api\/documentary\/boards\/([^/]+)$/);
      if (mDoc) {
        const id = decodeURIComponent(mDoc[1]);
        if (req.method === "GET") {
          if (pgUp) {
            try {
              const r = await pgPool.query("SELECT board FROM documentary_boards WHERE board_id = $1", [id]);
              if (r.rows[0]?.board) {
                const b = typeof r.rows[0].board === "string" ? JSON.parse(r.rows[0].board) : r.rows[0].board;
                return json(res, 200, b);
              }
            } catch (e) { console.warn("[pg] documentary board read failed:", e.message); }
          }
          return json(res, 200, readDocBoard(id));
        }
        if (req.method === "PUT") {
          const board = readDocBoard(id);
          const patch = await readJson(req);
          // Editable fields: brief bits, narration, bibles, shot
          // approve/skip flags and prompt edits. Narration/character changes
          // mark dependent shots stale (status back to WAITING, approved
          // cleared) — images/videos of unrelated shots are never touched.
          if (patch.brief && typeof patch.brief === "object") {
            for (const k of ["audience", "tone", "visualStyle", "narrationStyle", "narrationVoice", "musicStyle", "instructions", "sourceType"]) {
              if (typeof patch.brief[k] === "string" && patch.brief[k].trim()) board.brief[k] = patch.brief[k].trim().slice(0, 2000);
            }
            board.styleLock = board.brief.visualStyle;
          }
          if (Array.isArray(patch.characters)) board.characters = patch.characters.map(normalizeDocCharacter);
          if (Array.isArray(patch.locations)) board.locations = patch.locations.map(normalizeDocLocation);
          // Per-stage Approve verdicts from the stage tabs (Documentary-only).
          // Replaced whole (client sends the full map); unknown stages dropped.
          if (patch.stageApprovals && typeof patch.stageApprovals === "object" && !Array.isArray(patch.stageApprovals)) {
            board.stage_approvals = normalizeDocStageApprovals(patch.stageApprovals);
          }
          if (patch.shot && typeof patch.shot === "object") {
            const { shot_id, ...fields } = patch.shot;
            let found = null;
            for (const c of board.chapters) for (const q of c.sequences) for (const s of q.shots) {
              if (s.shot_id === shot_id) found = s;
            }
            if (!found) throw new Error("shot not found");
            if (typeof fields.flux_prompt === "string") found.flux_prompt = fields.flux_prompt.slice(0, 4000);
            if (typeof fields.ltx_prompt === "string") { found.ltx_prompt = fields.ltx_prompt.slice(0, 2000); found.motion = found.ltx_prompt; }
            if (typeof fields.title === "string") found.title = fields.title.slice(0, 200);
            if (typeof fields.duration_seconds === "number" && Number.isFinite(fields.duration_seconds)) {
              found.duration_seconds = Math.min(60, Math.max(3, Math.round(fields.duration_seconds)));
              // Duration change -> timing/audio may be stale: reopen the shot.
              found.status = "WAITING"; found.approved = false;
            }
            if (Array.isArray(fields.narration_lines)) {
              found.narration_lines = fields.narration_lines.map((x) => String(x)).filter(Boolean).slice(0, 8);
              // Narration change -> timing/audio may be stale: reopen the shot.
              found.status = "WAITING"; found.approved = false;
            }
            // Micro-timing fields (dialogue / emotion / time / action / visual
            // meaning / cast / staging): same caps as normalizeDocShot.
            // Spoken-line changes reopen the shot; pure metadata does not.
            if (Array.isArray(fields.dialogue_lines)) {
              found.dialogue_lines = fields.dialogue_lines.map((x) => String(x)).filter(Boolean).slice(0, 8);
              found.status = "WAITING"; found.approved = false;
            }
            if (typeof fields.emotion === "string") found.emotion = fields.emotion.slice(0, 120);
            if (typeof fields.time_of_day === "string") found.time_of_day = fields.time_of_day.slice(0, 40);
            if (Array.isArray(fields.actions)) {
              found.actions = fields.actions.map((x) => String(x)).filter(Boolean).slice(0, 8);
            }
            if (typeof fields.visual_meaning === "string") found.visual_meaning = fields.visual_meaning.slice(0, 500);
            if (Array.isArray(fields.characters)) {
              found.characters = fields.characters.map((x) => String(x)).filter(Boolean);
            }
            if (typeof fields.location === "string") found.location = fields.location.slice(0, 120);
            if (typeof fields.visual_type === "string") found.visual_type = fields.visual_type.slice(0, 40);
            if (typeof fields.lighting === "string") found.lighting = fields.lighting.slice(0, 500);
            if (typeof fields.pacing === "string") found.pacing = fields.pacing.slice(0, 40);
            if (typeof fields.motion === "string") { found.motion = fields.motion.slice(0, 2000); found.ltx_prompt = found.motion; }
            if (fields.camera && typeof fields.camera === "object") {
              for (const k of ["shot_type", "angle", "movement"]) {
                if (typeof fields.camera[k] === "string") found.camera[k] = fields.camera[k].slice(0, 60);
              }
            }
            if (fields.audio && typeof fields.audio === "object") {
              if (typeof fields.audio.music === "boolean") found.audio.music = fields.audio.music;
              if (typeof fields.audio.sfx === "boolean") found.audio.sfx = fields.audio.sfx;
              if (typeof fields.audio.sfx_kind === "string") found.audio.sfx_kind = fields.audio.sfx_kind.slice(0, 120);
            }
            // Re-fit: spoken lines must fit the shot (same rule as normalize).
            try {
              const refit = normalizeDocShot(found, found.chapter, found.sequence, 1, found.global_index, found.duration_seconds);
              found.duration_seconds = refit.duration_seconds;
            } catch { /* keep edited duration on normalizer failure */ }
            if (typeof fields.approved === "boolean") found.approved = fields.approved;
            if (typeof fields.status === "string" && ["WAITING", "SKIPPED", "FAILED"].includes(fields.status)) found.status = fields.status;
          }
          if (patch.characterRefChanged) {
            const cid = String(patch.characterRefChanged);
            for (const c of board.chapters) for (const q of c.sequences) for (const s of q.shots) {
              if (Array.isArray(s.characters) && s.characters.includes(cid)) { s.status = "WAITING"; s.approved = false; }
            }
          }
          board.error = null;
          return json(res, 200, writeDocBoard(board));
        }
        if (req.method === "DELETE") {
          readDocBoard(id);
          fs.rmSync(docBoardFile(id), { force: true });
          await pgDeleteDocBoard(id).catch((e) => console.warn("[pg] documentary board delete failed:", e.message));
          return json(res, 200, { ok: true });
        }
      }
    }
    // Plan: analysis (TASK 0/3) + bible + chapters + sequences first (LLM,
    // else heuristic), then shots per chapter (LLM batches, else heuristic).
    // Fully resumable: a planned board replans only what is missing.
    // Documentary-only: no other workflow calls these builders.
    if (p.match(/^\/api\/documentary\/boards\/[^/]+\/plan$/) && req.method === "POST") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      const board = readDocBoard(id);
      // Snapshot the previous execution for the stage tabs' past-runs view
      // (only when something was planned/analyzed before — first Plan has no
      // past). Taken before this run overwrites chapters/analysis.
      const prevStages = (board.analysis || (Array.isArray(board.chapters) && board.chapters.length))
        ? { at: board.updatedAt || new Date().toISOString(), source: (board.analysis && board.analysis.source) || "heuristic", stages: snapshotDocStages(board) }
        : null;
      board.status = "planning";
      writeDocBoard(board);
      // TASK 0/3 — source analysis (RAW POEM -> understanding pipeline):
      // one LLM call over the raw source text; heuristic fallback offline.
      // Stored on the board and fed as read-only context to the bible +
      // shot planners below (empty context = their prompts byte-identical).
      let analysis = null;
      try {
        const araw = await llmChatJson({
          system: DOCUMENTARY_DIRECTOR_SYSTEM,
          user: buildDocAnalysisPrompt(board.brief),
          maxTokens: 4000, temperature: 0.3, timeoutMs: REQUEST_TIMEOUT_MS,
          rawTag: `_raw_doc_${id}_analysis.log`,
        });
        assertNoCJK(araw, "the documentary analysis");
        analysis = normalizeDocAnalysis(araw);
        analysis.source = "llm";
      } catch (e) {
        console.warn(`[documentary] analysis LLM failed, heuristic fallback: ${e.message}`);
      }
      if (!analysis) analysis = heuristicAnalyze(board.brief);
      board.analysis = analysis;
      writeDocBoard(board);
      const actx = docAnalysisContext(analysis);
      let blueprint = null;
      try {
        const raw = await llmChatJson({
          system: DOCUMENTARY_DIRECTOR_SYSTEM,
          user: buildDocBiblePrompt(board.brief, actx),
          maxTokens: 16000, temperature: 0.7, timeoutMs: REQUEST_TIMEOUT_MS,
          rawTag: `_raw_doc_${id}_bible.log`,
        });
        assertNoCJK(raw, "the documentary blueprint");
        blueprint = raw && typeof raw === "object" ? raw : null;
      } catch (e) {
        console.warn(`[documentary] bible LLM failed, heuristic fallback: ${e.message}`);
      }
      if (blueprint && Array.isArray(blueprint.chapters) && blueprint.chapters.length) {
        board.characters = Array.isArray(blueprint.characters) ? blueprint.characters.map(normalizeDocCharacter) : board.characters;
        board.locations = Array.isArray(blueprint.locations) ? blueprint.locations.map(normalizeDocLocation) : board.locations;
        board.musicBeds = Array.isArray(blueprint.music_beds) ? blueprint.music_beds : board.musicBeds;
        board.chapters = blueprint.chapters.map((c, i) => normalizeDocChapter({ ...c, __globalOffset: 0 }, i + 1));
        board.status = "narration";
        // Per-chapter shot batches via the LLM; a failed chapter falls back
        // to heuristic shots for that chapter only (never aborts the board).
        let global = 0;
        for (const c of board.chapters) {
          // A chapter with no sequences (LLM dropped them) gets heuristic
          // sequences sized to its target duration — never an empty chapter.
          if (!Array.isArray(c.sequences) || !c.sequences.length) {
            const cDur = Number(c.target_duration_seconds) > 0 ? Math.round(c.target_duration_seconds) : 120;
            const nSeq = Math.min(4, Math.max(2, Math.round(cDur / 60)));
            const qDur = Math.floor(cDur / nSeq);
            let rem = cDur;
            c.sequences = Array.from({ length: nSeq }, (_, i) => {
              const last = i === nSeq - 1;
              const d = last ? rem : qDur;
              rem -= d;
              return normalizeDocSequence({
                title: `${c.title} — भाग ${i + 1}`,
                purpose: c.purpose || "",
                narration: c.purpose || `${board.brief.topic} — ${c.title}`,
                duration_seconds: d,
                visual_goal: c.title,
                pacing: "EXPLANATION",
                shots: [],
              }, c.chapter_number, i + 1, 0);
            });
          }
          try {
            const raw = await llmChatJson({
              system: DOCUMENTARY_DIRECTOR_SYSTEM,
              user: buildDocShotsPrompt({
                brief: board.brief, board, chapter: c, startGlobal: global, analysisCtx: actx,
                promptAddons: documentaryPromptAddons(readDirectorPromptSettings()),
              }),
              maxTokens: 16000, temperature: 0.7, timeoutMs: REQUEST_TIMEOUT_MS,
              rawTag: `_raw_doc_${id}_ch${c.chapter_number}.log`,
            });
            assertNoCJK(raw, "the documentary shot plan");
            const seqs = raw && Array.isArray(raw.sequences) ? raw.sequences : null;
            if (seqs && seqs.length) {
              c.sequences = seqs.map((q, i) => {
                const prev = c.sequences[i] || {};
                return normalizeDocSequence({ ...prev, ...q }, c.chapter_number, Number(q.seq) || i + 1, global + c.sequences.slice(0, i).reduce((a, x) => a + (Array.isArray(x.shots) ? x.shots.length : 0), 0));
              });
            }
          } catch (e) {
            console.warn(`[documentary] chapter ${c.chapter_number} shots LLM failed, heuristic fill: ${e.message}`);
          }
          // Any sequence still shot-less gets heuristic shots sized to its duration.
          // Each shot voices only its own narration chunk so durations derive
          // from their own lines (same rule as heuristicPlan).
          for (const q of c.sequences) {
            if (!Array.isArray(q.shots) || !q.shots.length) {
              const nShots = Math.min(12, Math.max(2, Math.round((q.duration_seconds || 40) / 12)));
              const chunks = splitNarrationForShots(q.narration, nShots);
              const d = Math.max(3, Math.min(15, Math.round((q.duration_seconds || 40) / nShots)));
              const main = board.characters[0];
              const loc = board.locations[0];
              const devotionalFill = isDevotionalBrief(board.brief);
              q.shots = Array.from({ length: nShots }, (_, hi) => normalizeDocShot({
                title: `${q.title} — shot ${hi + 1}`,
                duration_seconds: d,
                narration_lines: chunks[hi] ? [chunks[hi]] : [],
                visual_type: hi === 0 ? "establishing" : "character",
                characters: main ? [main.character_id] : [],
                location: loc ? loc.location_id : "",
                flux_prompt: devotionalFill
                  ? withDevotionalRealism([board.brief.visualStyle, main ? (main.identity_prompt || main.name) : "", loc ? (loc.description || loc.name) : "", `${q.visual_goal || q.title}, cinematic ${["wide", "medium", "close-up"][hi % 3]} framing`].filter(Boolean).join(", "))
                  : [board.brief.visualStyle, main ? (main.identity_prompt || main.name) : "", loc ? (loc.description || loc.name) : "", `${q.visual_goal || q.title}, cinematic ${["wide", "medium", "close-up"][hi % 3]} framing`].filter(Boolean).join(", "),
                ltx_prompt: "gentle cinematic motion, clouds drifting, subtle divine glow; keep the exact character, face, clothing, colors, lighting and background from the input image — animate natural motion only",
                camera: { shot_type: ["Wide Shot", "Medium Shot", "Close-Up"][hi % 3], angle: "Eye Level", movement: "slow cinematic push-in" },
                audio: { music: true, sfx: false },
              }, c.chapter_number, q.seq, hi + 1, 0, d));
            }
          }
          // Re-sync: post-shot-planning, sequence durations are the sum of
          // their (dialogue-driven) shots — never the stale bible estimate.
          for (const q of c.sequences) {
            const sum = q.shots.reduce((a, s) => a + (Number(s.duration_seconds) || 0), 0);
            if (sum > 0) q.duration_seconds = Math.round(sum * 10) / 10;
          }
          global += c.sequences.reduce((a, q) => a + q.shots.length, 0);
        }
        reindexBoardShots(board.chapters);
        board.status = "ready";
      } else {
        // Full heuristic fallback (LLM offline): deterministic plan sized to
        // the target duration — the same path the 5-minute test uses.
        const h = heuristicPlan(board.brief);
        board.chapters = h.chapters;
        board.characters = h.characters;
        board.locations = h.locations;
        board.musicBeds = h.musicBeds;
        board.status = "ready";
      }
      board.shotCount = countBoardShots(board);
      board.error = null;
      // New execution -> past run remembered (capped), prior stage approvals
      // are stale -> cleared for re-approval from the stage tabs.
      if (prevStages) {
        const hist = Array.isArray(board.stage_history) ? board.stage_history : [];
        hist.unshift(prevStages);
        board.stage_history = hist.slice(0, DOC_HISTORY_CAP);
      }
      board.stage_approvals = {};
      return json(res, 200, writeDocBoard(board));
    }
    // Approve: flatten to a standard scenario config; the CLIENT persists via
    // the existing saveScenario PUT then opens the workspace — generation,
    // progress, resume and assembly are 100% the existing pipeline.
    if (p.match(/^\/api\/documentary\/boards\/[^/]+\/approve$/) && req.method === "POST") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      const board = readDocBoard(id);
      if (!countBoardShots(board)) throw new Error("nothing to approve — plan the documentary first");
      const config = docBoardToScenario(board);
      // INTERNAL KEY: the brief title becomes the space-free scenario key
      // (same rule as the Story Director approve); the typed title rides
      // along as config.display_name for UI labels.
      const approveTitle = String(board.brief.title || "").trim().slice(0, 120);
      let target = board.scenarioName || spaceFreeName(approveTitle) || id;
      if (approveTitle) config.display_name = approveTitle;
      if (!board.scenarioName) {
        try {
          const taken = new Set((await dbListScenarios()).map((r) => r.name));
          if (taken.has(target)) {
            for (let i = 2; ; i++) {
              if (!taken.has(`${target}_${i}`)) { target = `${target}_${i}`; break; }
            }
          }
        } catch { /* name check is best-effort; save enforces uniqueness */ }
      }
      board.status = "approved";
      board.scenarioName = target;
      try {
        const pid = await pgProjectId(target);
        board.project_id = pid;
        if (pid != null) await pgLinkDocBoards(target, pid);
      } catch { /* link is best-effort; the PUT save links too */ }
      board.error = null;
      writeDocBoard(board);
      return json(res, 200, { name: target, config, shots: countBoardShots(board), narrationSeconds: boardNarrationSeconds(board) });
    }
    // Timeline: totals per chapter/sequence/shot with cumulative offsets.
    if (p.match(/^\/api\/documentary\/boards\/[^/]+\/timeline$/) && req.method === "GET") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      return json(res, 200, docBuildTimeline(readDocBoard(id)));
    }
    // Status: planning progress + per-shot WAITING/IMAGE/VIDEO/AUDIO/READY/
    // FAILED. When linked to a project, shot states derive from the existing
    // project_assets catalog + outputs dir (one failed shot never blocks the
    // rest — the serial queue keeps going per existing behavior); otherwise
    // plan counts. Resume = read this state and continue from the last
    // incomplete shot (the existing runners already skip assets on disk).
    if (p.match(/^\/api\/documentary\/boards\/[^/]+\/status$/) && req.method === "GET") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      const board = readDocBoard(id);
      const stats = docBoardStats(board);
      let linked = null;
      if (board.scenarioName && pgUp) {
        try {
          const pid = await pgProjectId(board.scenarioName);
          if (pid != null) {
            const r = await pgPool.query(
              "SELECT beat_index, asset_type, status, file_path FROM project_assets WHERE project_id = $1 AND version = (SELECT max(version) FROM project_assets WHERE project_id = $1)",
              [pid]);
            linked = { project_id: pid, rows: r.rows.length };
            // Overlay catalog states onto plan shots by global index (= beat).
            const shotByBeat = new Map();
            for (const c of board.chapters) for (const q of c.sequences) for (const s of q.shots) shotByBeat.set(s.global_index, s);
            for (const row of r.rows) {
              const s = shotByBeat.get(Number(row.beat_index));
              if (!s) continue;
              if (row.asset_type === "VIDEO" && row.status === "COMPLETED") s.status = "READY";
              else if (row.status === "FAILED" && s.status !== "READY") s.status = "FAILED";
              else if (row.asset_type === "KEYFRAME" && row.status === "COMPLETED" && s.status === "WAITING") s.status = "IMAGE";
            }
          }
        } catch (e) { console.warn("[pg] documentary status link failed:", e.message); }
      }
      const shots = countBoardShots(board);
      const ready = stats.byStatus.READY || 0;
      return json(res, 200, {
        id: board.id, status: board.status,
        shots, ready,
        pct: shots ? Math.round((ready / shots) * 100) : 0,
        stages: ["Planning", "Writing narration", "Creating Bible", "Generating images", "Generating videos", "Generating narration", "Generating music", "Assembling", "Completed"],
        byStatus: stats.byStatus,
        narrationSeconds: stats.narrationSeconds,
        targetSeconds: board.brief.targetSeconds,
        scenarioName: board.scenarioName,
        linked,
      });
    }
    // Export manifest: final MP4 + chapter MP4s + narration wav + music dir +
    // subtitles.srt (from exact narration timing) + documentary.json, using
    // existing storage conventions. Assembly itself reuses the existing
    // FFmpeg stitch (client triggers via the workspace); this endpoint writes
    // the portable manifest + subtitles next to the outputs dir when it exists.
    if (p.match(/^\/api\/documentary\/boards\/[^/]+\/export$/) && req.method === "POST") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      const board = readDocBoard(id);
      const body = await readJson(req).catch(() => ({}));
      const dir = isSafe(body.dir) ? body.dir : null;
      const manifest = docExportManifest(board, dir || board.scenarioName);
      const srt = docSubtitles(board);
      let wrote = [];
      if (dir) {
        const full = path.join(OUTPUTS, dir);
        try {
          if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
            fs.writeFileSync(path.join(full, "subtitles.srt"), srt);
            fs.writeFileSync(path.join(full, "documentary.json"), JSON.stringify({ title: board.brief.title, brief: board.brief, timeline: docBuildTimeline(board), manifest }, null, 2));
            wrote = ["subtitles.srt", "documentary.json"];
          }
        } catch (e) { console.warn("[documentary] export write failed:", e.message); }
      }
      return json(res, 200, { ...manifest, srtPreview: srt.slice(0, 2000), wrote });
    }
    if (p === "/api/outputs/stitch" && req.method === "POST") {
      const body = await readJson(req);
      if (!isSafe(body.scenario)) return json(res, 400, { error: "bad scenario" });
      const folder = await migrateProjectStorage(body.scenario);
      const run = startRun(body.scenario, {
        stitch: true,
        engine: body.engine || "ltx",
        format: body.format ?? (body.vertical ? "vertical" : undefined),
        storageFolder: folder,
        configName: body.scenario,
      });
      return json(res, 200, { id: run.id, folder });
    }
    // Short cut for Instagram Reels/Shorts: trim the dir's latest final cut
    // down to the first N seconds. Writes
    // outputs/<dir>/<prefix>_reel_<N>s.mp4 via stream copy (fast, lossless)
    // so the Reel panel can play the exact short; re-cutting the same length
    // overwrites the same file (no version sprawl). When the final is already
    // shorter than N seconds, no file is written — the final itself is the cut.
    if (p === "/api/reel-cut" && req.method === "POST") {
      const body = await readJson(req);
      if (!isSafe(body.dir)) return json(res, 400, { error: "bad dir" });
      const seconds = Math.floor(Number(body.seconds));
      if (![30, 60, 90].includes(seconds)) return json(res, 400, { error: "seconds must be 30, 60 or 90" });
      const full = path.join(OUTPUTS, body.dir);
      let st = null;
      try { st = fs.statSync(full); } catch { st = null; }
      if (!st || !st.isDirectory()) return json(res, 404, { error: "unknown outputs dir" });
      const prefix = prefixForDir(body.dir);
      const vm = versionMap(full, prefix, []);
      const finals = [...(vm.final ?? [])].sort((a, b) => a.v - b.v);
      const latest = finals.length ? finals[finals.length - 1].file : null;
      if (!latest) return json(res, 400, { error: "no final cut yet — create the video first" });
      const srcFull = path.join(full, latest);
      const dur = await videoDurationSec(srcFull);
      if (dur != null && dur <= seconds) {
        return json(res, 200, { file: latest, duration: dur, cut: false, from: latest, fromDuration: dur });
      }
      const outFile = `${prefix}_reel_${seconds}s.mp4`;
      const dstFull = path.join(full, outFile);
      try {
        await runCmd("ffmpeg", ["-y", "-i", srcFull, "-t", String(seconds),
          "-c", "copy", "-movflags", "+faststart", dstFull], 120000);
      } catch (e) {
        return json(res, 500, { error: `cut failed: ${e.message || e}` });
      }
      const outDur = await videoDurationSec(dstFull);
      return json(res, 200, { file: outFile, duration: outDur ?? seconds, cut: true, from: latest, fromDuration: dur });
    }
    // Preview of the exact LLM messages a craft would send (AI Craft
    // "View Prompt" popup). No LLM call, nothing persisted — the UI lets the
    // user review/edit the user message, then POSTs it back as `userPrompt`.
    if (p === "/api/craft-preview" && req.method === "POST") {
      const body = await readJson(req);
      // description may be omitted when target names a stored project — the
      // brief then falls back to the database / prompts JSON copy.
      if (!body.description && !body.topic && !body.target)
        return json(res, 400, { error: "description required" });
      try {
        const brief = await buildCraftPreview(body);
        return json(res, 200, {
          system: brief.system,
          user: brief.user,
          presetName: brief.presetMeta ? brief.presetMeta.name : null,
          rulesApplied: !brief.noRules,
          // Where the brief was read from: "database" | "json" | "request".
          source: brief.briefFrom || "request",
          project: typeof body.target === "string" && body.target ? body.target : null,
        });
      } catch (e) {
        return json(res, 400, { error: String(e.message || "preview failed") });
      }
    }
    if (p === "/api/craft" && req.method === "POST") {
      const body = await readJson(req);
      // Current UI sends { description, masterPrompt }; accept legacy
      // { topic, requirements } too — both are LLM-only inputs, never stored.
      // description may be omitted when target names a stored project (the
      // brief falls back to the database / prompts JSON copy, same as preview).
      if (!body.description && !body.topic && !body.target)
        return json(res, 400, { error: "description required" });
      const crafted = await craftScenario(body);
      // Craft persists the project immediately (before any Save): the row
      // exists in projects from the click on, and Save Scenario later reuses
      // this same project_id for its project_assets rows.
      let project_id = null;
      // Targeted craft: the UI asked to re-craft the OPEN project (body.target
      // names an existing scenario). Keep that SAME name — the next Save then
      // stores a new version of the project (delta rows for changed scenes
      // only) instead of minting a new project. The project row already
      // exists, so nothing is inserted here.
      const target = typeof body.target === "string" && isSafe(body.target) ? body.target : null;
      let targeted = false;
      if (target && pgUp) {
        try {
          if ((await dbGetScenario(target)) !== null) {
            crafted.name = target;
            targeted = true;
            project_id = await pgProjectId(target);
          }
        } catch (e) { console.warn("[pg] craft target lookup failed:", e.message); }
      }
      if (pgUp && !targeted) {
        try {
          // Unique name: never clobber an existing scenario/project (the
          // editor would show it as a _2 draft otherwise, orphaning this row).
          let target = crafted.name;
          for (let i = 2; ; i++) {
            const takenSqlite = (await dbGetScenario(target)) !== null;
            let takenPg = false;
            try {
              const r = await pgPool.query("SELECT 1 FROM projects WHERE name = $1", [target]);
              takenPg = r.rowCount > 0;
            } catch { takenPg = false; }
            if (!takenSqlite && !takenPg) break;
            target = `${crafted.name}_${i}`;
          }
          crafted.name = target;
          const cfg = { ...crafted.config };
          // Drop any legacy brief fields that may have ridden along.
          delete cfg.topic;
          delete cfg.requirements;
          project_id = await pgEnsureProject(target, cfg);
          // Stamp the minted immutable folder into the crafted config so the
          // draft Save (PUT) keeps the same storage identity.
          try {
            const claimed = await getFolderNameFromRow(target);
            if (claimed) {
              cfg.folder_name = claimed;
              crafted.config = { ...crafted.config, folder_name: claimed };
            }
          } catch { /* row keeps it; PUT re-resolves */ }
        } catch (e) { console.warn("[pg] craft project save failed:", e.message); }
      }
      return json(res, 200, { ...crafted, project_id });
    }
    if (p === "/api/craft-beat" && req.method === "POST") {
      const body = await readJson(req);
      const cfg = body.config;
      if (!cfg || !Array.isArray(cfg.sequence)) return json(res, 400, { error: "config with sequence required" });
      // Explicit preset override wins; otherwise the saved config's presetId
      // applies (craftNextBeats sanitizes both via resolvePresetId).
      // A presetRules string overrides the preset file for this call only;
      // an empty string clears the project override back to the preset file.
      if (typeof body.presetId === "string") cfg.presetId = body.presetId;
      if (typeof body.presetRules === "string") {
        if (body.presetRules.trim()) cfg.presetRules = body.presetRules.trim();
        else delete cfg.presetRules;
      }
      const count = Math.max(1, Number(body.count) || 1);
      return json(res, 200, { beats: await craftNextBeats(cfg, count) });
    }
    // Append the Master Prompt to every scene's keyframe image prompt
    // (same rules as craft-time fan-out: blank = no-op, never double-appends,
    // motion never touched).
    // Stateless — the caller (AI Craft "Apply to All Scene") persists the
    // returned sequence via the normal draft/save path.
    if (p === "/api/apply-master" && req.method === "POST") {
      const body = await readJson(req);
      const cfg = body.config;
      if (!cfg || !Array.isArray(cfg.sequence)) return json(res, 400, { error: "config with sequence required" });
      return json(res, 200, { sequence: applyMasterToBeats(cfg.sequence, body.master ?? "") });
    }
    // AI variant of the Master Prompt fan-out, one scene at a time. The
    // "Apply to All Scenes" popup calls this once per scene so it can show
    // per-scene progress ("working on scene N…"). The LLM checks semantic
    // presence first (paraphrase counts) and inserts only missing details at
    // the natural place in the keyframe prompt. Motion is never touched.
    // On LLM failure falls back to the naive append so the popup never
    // hard-fails mid-run — the response carries fallback:true in that case.
    if (p === "/api/apply-master-scene" && req.method === "POST") {
      const body = await readJson(req);
      const master = String(body.master ?? "").trim();
      const beat = body.beat && typeof body.beat === "object" ? body.beat : null;
      if (!beat) return json(res, 400, { error: "beat required" });
      if (!master) {
        return json(res, 200, {
          image: String(beat.image ?? ""), changed: false, skipped: true,
          reason: "empty master", fallback: false,
        });
      }
      try {
        const r = await mergeMasterIntoScene(master, beat);
        return json(res, 200, { ...r, fallback: false });
      } catch (e) {
        console.warn("[apply-master-scene] LLM failed, naive-append fallback:", e.message);
        const s = String(beat.image ?? "").trim();
        if (!s) {
          return json(res, 200, {
            image: master, changed: true, skipped: false,
            reason: `LLM offline — used master as-is (${String(e.message || e).slice(0, 120)})`,
            fallback: true,
          });
        }
        if (s.includes(master)) {
          return json(res, 200, {
            image: s, changed: false, skipped: true,
            reason: "master already present verbatim", fallback: true,
          });
        }
        return json(res, 200, {
          image: `${s}, ${master}`, changed: true, skipped: false,
          reason: `LLM offline — appended at end (${String(e.message || e).slice(0, 120)})`,
          fallback: true,
        });
      }
    }
    // Publishing metadata (title / description / hashtags) for a scenario,
    // drafted by the local LLM from the scenario JSON. Stateless — nothing
    // is persisted; the UI caches it per project in localStorage.
    if (p === "/api/video-meta" && req.method === "POST") {
      const body = await readJson(req);
      const cfg = body.config;
      if (!cfg || !Array.isArray(cfg.sequence)) return json(res, 400, { error: "config with sequence required" });
      return json(res, 200, await craftVideoMeta(cfg));
    }
    // Single Master Prompt from Description + Video Type (Create New Project
    // "Get by AI" button). Stateless — the dialog fills its Master Prompt box
    // with the result; nothing is persisted.
    if (p === "/api/master-prompt" && req.method === "POST") {
      const body = await readJson(req);
      const description = String(body.description ?? body.topic ?? "").trim();
      if (!description) return json(res, 400, { error: "description required" });
      try {
        return json(res, 200, await craftMasterPrompt({
          description,
          presetId: body.presetId,
          presetRules: body.presetRules,
        }));
      } catch (e) {
        console.error("[master-prompt] failed:", e.message);
        return json(res, 502, { error: String(e.message || "master prompt failed") });
      }
    }
    // Song length estimate for the Create Song tab: the local LLM reads the
    // lyrics + song mode and returns the exact singable seconds (plus optional
    // bpm/key refinements). Stateless — the Create Song form fills its fields
    // with the result; nothing is persisted. Falls back to the word-rate
    // heuristic when the LLM is offline so the button never hard-fails.
    if (p === "/api/song-estimate" && req.method === "POST") {
      const body = await readJson(req);
      const lyrics = String(body.lyrics || "").trim();
      if (lyrics.length < 3) return json(res, 400, { error: "lyrics required" });
      const presetId = String(body.presetId || "kids-song");
      const SONG_WPM = {
        "kids-song": 100, "songs-for-kids": 110, "kids-story-narration": 135,
        "devotional-song": 90, "devotional-narration": 120,
        "devotional-narration-music": 120,
      };
      const SONG_PAD = {
        "kids-song": 12, "songs-for-kids": 10, "kids-story-narration": 6,
        "devotional-song": 14, "devotional-narration": 10,
        "devotional-narration-music": 10,
      };
      const heuristic = () => {
        const words = lyrics.split(/\s+/).filter(Boolean).length;
        const lines = lyrics.split("\n").map((l) => l.trim()).filter(Boolean).length;
        const sections = (lyrics.match(/(मुखड़ा|अंतरा|कोरस|ब्रिज|pre-chorus|chorus|verse|antara|bridge|shloka|doha|मुखडा)/gi) || []).length;
        const wpm = SONG_WPM[presetId] || 100;
        const pad = SONG_PAD[presetId] ?? 10;
        if (!words) return 120;
        const raw = pad + (words * 60) / wpm + lines * 0.8 + sections * 4;
        return Math.round(Math.min(300, Math.max(30, raw)) / 5) * 5;
      };
      try {
        const raw = await llmChatJson({
          system: "You time lyrics for an AI singing model (ACE-Step). Reply with JSON only: {\"duration_seconds\": <integer 30-300>, \"bpm\": <integer 60-140>, \"keyscale\": \"<key>\", \"reasoning\": \"<one short sentence>\"}. Estimate singable seconds from the line/word count and the song mode (kids songs are brisk, bhajans and narrations are slow with pauses).",
          user: JSON.stringify({
            mode: presetId,
            language: String(body.language || "hi"),
            lyrics: lyrics.slice(0, 6000),
          }),
          maxTokens: 300,
          temperature: 0.2,
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
        const dur = Math.round(Math.min(300, Math.max(30, Number(raw.duration_seconds) || heuristic())));
        const out = { duration: Math.round(dur / 5) * 5, source: "llm" };
        if (Number.isFinite(Number(raw.bpm))) out.bpm = Math.min(300, Math.max(10, Math.round(Number(raw.bpm))));
        if (typeof raw.keyscale === "string" && raw.keyscale.trim()) out.keyscale = raw.keyscale.trim().slice(0, 24);
        if (typeof raw.reasoning === "string" && raw.reasoning.trim()) out.reasoning = raw.reasoning.trim().slice(0, 200);
        return json(res, 200, out);
      } catch (e) {
        console.warn("[song-estimate] LLM failed, heuristic fallback:", e.message);
        return json(res, 200, { duration: heuristic(), source: "heuristic" });
      }
    }
    // Story target-duration estimate for the AI Story Director: the local LLM
    // reads the story (+ genre/language) and suggests the video length in
    // seconds. Stateless — the director form fills its target with the
    // result; nothing is persisted. Falls back to the word-rate heuristic
    // when the LLM is offline so the button never hard-fails.
    if (p === "/api/director-estimate" && req.method === "POST") {
      const body = await readJson(req);
      const story = String(body.story || "").trim();
      if (story.length < 3) return json(res, 400, { error: "story required" });
      const heuristic = () => {
        const words = story.split(/\s+/).filter(Boolean).length;
        const lines = story.split("\n").map((l) => l.trim()).filter(Boolean).length;
        if (!words) return 60;
        const raw = 20 + words * 0.45 + lines * 1.2;
        return Math.round(Math.min(600, Math.max(30, raw)) / 5) * 5;
      };
      try {
        const raw = await llmChatJson({
          system: "You time a story for AI video generation. Reply with JSON only: {\"duration_seconds\": <integer 15-600>, \"reasoning\": \"<one short sentence>\"}. Base it on story length and complexity: short tales 30-60s, medium stories 60-180s, epics 180-600s. Assume ~3s scenes.",
          user: JSON.stringify({
            title: String(body.title || "").slice(0, 120),
            genre: String(body.genre || "Kids"),
            language: String(body.language || "English"),
            sceneSeconds: Math.min(30, Math.max(1, Number(body.sceneSeconds) || 3)),
            story: story.slice(0, 6000),
          }),
          maxTokens: 300,
          temperature: 0.2,
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
        const dur = Math.round(Math.min(600, Math.max(15, Number(raw.duration_seconds) || heuristic())));
        const out = { duration: Math.round(dur / 5) * 5, source: "llm" };
        if (typeof raw.reasoning === "string" && raw.reasoning.trim()) out.reasoning = raw.reasoning.trim().slice(0, 200);
        return json(res, 200, out);
      } catch (e) {
        console.warn("[director-estimate] LLM failed, heuristic fallback:", e.message);
        return json(res, 200, { duration: heuristic(), source: "heuristic" });
      }
    }
    // Director instructions suggestion for the AI Story Director: the local LLM
    // reads the story/lyrics (+ title/genre/style/language) and drafts concise
    // Additional director instructions. Stateless — the director form fills its
    // textarea with the result; nothing is persisted. Small local models often
    // answer with a plain-text list instead of JSON, so a non-JSON reply is
    // cleaned and used as-is (never a 502 for a usable answer) — only a
    // missing LLM, an HTTP/timeout failure or an empty reply errors.
    if (p === "/api/director-instructions" && req.method === "POST") {
      const body = await readJson(req);
      const story = String(body.story || "").trim();
      const title = String(body.title || "").trim().slice(0, 120);
      if (story.length < 20 && !title) {
        return json(res, 400, { error: "paste the story (20+ characters) or give it a title first" });
      }
      const existing = String(body.existing || body.instructions || "").trim().slice(0, 2000);
      // Plain-text fallback: strip fences, surrounding quotes and a leading
      // "instructions:" label so a non-JSON model reply still fills the box.
      const cleanInstructionsText = (t) => {
        let s = String(t || "").trim();
        const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        if (fence) s = fence[1].trim();
        s = s.replace(/^["'\s]+|["'\s]+$/g, "").trim();
        s = s.replace(/^(?:director\s+)?instructions\s*:\s*/i, "").trim();
        // Drop a trailing JSON-ish reasoning tail if the model mixed formats.
        s = s.replace(/\{\s*"reasoning"[\s\S]*$/i, "").trim();
        return s.slice(0, 2000).trim();
      };
      try {
        const base = (process.env.LLM_BASE || "").replace(/\/+$/, "");
        if (!base) throw new Error("LLM_BASE not set — the director needs the local LLM (LM Studio / llama-server).");
        let text = "";
        try {
          const d = await llmPostChat(`${base}/v1/chat/completions`, {
            model: LLM_MODEL,
            messages: [
              { role: "system", content: "You are an assistant film director for AI video generation. Reply with JSON only: {\"instructions\": \"<3-6 short imperative lines, newline-separated>\", \"reasoning\": \"<one short sentence>\"}. Suggest concrete visual-storytelling instructions tailored to the story (character consistency, mood, pacing, what to emphasize or avoid). Keep each line under 140 characters. Never repeat the story back. Write in English. NEVER write Chinese, Japanese or Korean." },
              {
                role: "user",
                content: JSON.stringify({
                  title,
                  genre: String(body.genre || "Kids").slice(0, 40),
                  visualStyle: String(body.visualStyle || body.style || "3D Preschool Animation").slice(0, 120),
                  language: String(body.language || "English").slice(0, 24),
                  ...(existing ? { existingInstructions: existing } : {}),
                  story: story.slice(0, 6000),
                }),
              },
            ],
            temperature: 0.7,
            max_tokens: 500,
            chat_template_kwargs: { enable_thinking: false },
          }, { tag: "suggest-instructions" });
          text = String(d.choices?.[0]?.message?.content ?? "");
        } catch (e) {
          if (e?.name === "AbortError") throw new Error("LLM timed out — the model may still be loading; the story is kept, try again.");
          throw e;
        }
        // Preferred: structured JSON. Fallback: usable plain-text list.
        let instructions = "";
        let reasoning = "";
        try {
          const raw = stripJson(text);
          instructions = String(raw.instructions || "").trim().slice(0, 2000);
          if (typeof raw.reasoning === "string" && raw.reasoning.trim()) reasoning = raw.reasoning.trim().slice(0, 200);
        } catch {
          instructions = cleanInstructionsText(text);
        }
        if (!instructions) throw new Error("LLM returned an empty response — try again.");
        const out = { instructions, source: "llm" };
        if (reasoning) out.reasoning = reasoning;
        return json(res, 200, out);
      } catch (e) {
        console.warn("[director-instructions] LLM failed:", e.message);
        return json(res, 502, { error: String(e.message || "AI request failed") });
      }
    }
    // Song analysis for the Kids Video Director: the local LLM reads the
    // uploaded song's metadata (title, duration, lyrics) + genre/language and
    // returns mood, structure (timed segments), narration style and visual
    // recommendations. Stateless — nothing is persisted. Falls back to a
    // heuristic when the LLM is offline so the button never hard-fails.
    if (p === "/api/director/analyze-song" && req.method === "POST") {
      // The SAME analyzer the Sanskriti Kids Song & Audio studios use.
      const body = await readJson(req);
      const result = await analyzeSongAudio(body);
      if (result && result.error) return json(res, result.status || 400, { error: result.error });
      return json(res, 200, result);
    }
    // Predefined video-type presets (system-owned presets/*.md defaults).
    // List carries metadata only; content is fetched per id when needed
    // (craft prompt injection, View/edit-rules panel). Per-project edits are
    // stored on the project as `presetRules` and never touch presets/*.md.
    if (p === "/api/presets" && req.method === "GET") {
      try {
        return json(res, 200, GetAvailablePresets());
      } catch (e) {
        console.error("[presets] list failed:", e.message);
        return json(res, 500, { error: "presets unavailable" });
      }
    }
    if (p.startsWith("/api/presets/") && req.method === "GET" && p.split("/").length === 4) {
      const id = pathName(p.split("/")[3]);
      try {
        const { meta, content } = GetPresetContent(id);
        return json(res, 200, {
          id: meta.id, name: meta.name, category: meta.category,
          description: meta.description, content,
        });
      } catch (e) {
        // Unknown id OR missing file: 400 with a clear message, never a
        // stack trace — and never an arbitrary filesystem read (ids are
        // registry-validated inside GetPresetContent).
        return json(res, 400, { error: String(e.message || "Invalid preset selected.") });
      }
    }
    if (p === "/api/comfy" && req.method === "GET") return json(res, 200, await comfyStatus());
    // Combined health for the Home page (one round trip). Each service is
    // probed independently — an offline LLM/ComfyUI never blocks project data.
    if (p === "/api/health" && req.method === "GET") {
      // SQLite mode is standalone: the DB is always "up", no pg probe.
      const [dbUp, comfy, llm] = await Promise.all([
        USE_SQLITE ? true : pgProbe().catch(() => false),
        comfyStatus().catch(() => ({ up: false, error: "status check failed" })),
        llmStatus().catch(() => ({ up: false, error: "status check failed" })),
      ]);
      const q = (comfy && comfy.queue) || {};
      return json(res, 200, {
        db: { up: !!dbUp },
        comfy: {
          up: !!comfy.up,
          queueRunning: Array.isArray(q.queue_running) ? q.queue_running.length : null,
          queuePending: Array.isArray(q.queue_pending) ? q.queue_pending.length : null,
          error: comfy.error,
        },
        llm: { up: !!llm.up, error: llm.error },
      });
    }
    // Aggregated Home-page dashboard (statistics + per-project progress).
    if (p === "/api/dashboard" && req.method === "GET") {
      try {
        return json(res, 200, await dashboardPayload());
      } catch (e) {
        console.warn("[dashboard] failed:", e.message);
        return json(res, 500, { error: "dashboard unavailable" });
      }
    }
    // Narrow project_assets rows for a project (one row per asset).
    // GET /api/project/:name/assets[?version=N][&mode=exact] — version
    // defaults to latest. Default mode is EFFECTIVE: because versions are
    // delta-based (v2 may hold only beat 3), the response resolves the
    // latest applicable row per (beat_index, asset_type) with
    // version <= requested, so callers always see the full project state
    // (beat 1 -> v1, beat 3 -> v2, ...). mode=exact returns only the raw
    // delta rows stored at that version (for version history).
    if (p.startsWith("/api/project/") && p.endsWith("/assets") && req.method === "GET") {
      const segs = p.split("/");
      const name = decodeURIComponent(segs[3] || "");
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      // Generated media and scenario configs remain available from disk even
      // if the optional Postgres catalog is offline (or SQLite mode is active).
      if (!pgUp) return json(res, 200, []);
      const pid = await pgProjectId(name);
      if (pid == null) return json(res, 200, []);
      // Missing ?version= means latest. The DB fallback is NULL with zero
      // version rows — latestVersionOf maps that (and any other phantom like
      // Number(null) === 0) to null so the endpoint returns [] instead of
      // querying a version that can never exist.
      const versionParam = u.searchParams.get("version");
      let version = versionParam == null || versionParam === "" ? NaN : Number(versionParam);
      if (!Number.isInteger(version)) {
        const r = await pgPool.query("SELECT max(version) AS v FROM scenario_versions WHERE name = $1", [name]);
        version = latestVersionOf(r.rows[0]?.v) ?? NaN;
      }
      if (!Number.isInteger(version)) return json(res, 200, []);
      const mode = String(u.searchParams.get("mode") || "").toLowerCase();
      const exact = mode === "exact" || mode === "delta" || mode === "raw" ||
        u.searchParams.get("exact") === "1";
      // Cut-scoped history: YOUTUBE (landscape main cut) by default, INSTAGRAM
      // (vertical Reel cut) on request — the two cuts keep independent rows.
      const vtParam = String(u.searchParams.get("video_type") || "").toUpperCase();
      const videoType = vtParam === "INSTAGRAM" ? "INSTAGRAM" : "YOUTUBE";
      const r = await pgPool.query(exact ? EXACT_VERSION_SQL : EFFECTIVE_ASSETS_SQL, [pid, version, videoType]);
      return json(res, 200, r.rows);
    }
    // Reference visuals for a project (one row per generation/upload).
    // GET /api/project/:name/references[?dir=<outputDir>] — is_main marks the
    // record selected as main on the UI. This is what the Reference section
    // of the gallery displays.
    if (p.startsWith("/api/project/") && p.endsWith("/references") && req.method === "GET") {
      const segs = p.split("/");
      const name = decodeURIComponent(segs[3] || "");
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      if (!pgUp) return json(res, 503, { error: "database unavailable" });
      const pid = await pgProjectId(name);
      if (pid == null) return json(res, 200, []);
      const dir = u.searchParams.get("dir");
      const r = dir && isSafe(dir)
        ? await pgPool.query(
          `SELECT id, project_id, output_dir, version, prompt, negative_prompt, file_path,
                  model, workflow, seed, attempts, source, video_type, is_main, pinned, metadata,
                  started_at, completed_at, created_at, updated_at
           FROM project_references WHERE project_id = $1 AND output_dir = $2
           ORDER BY created_at ASC, id ASC`,
          [pid, dir])
        : await pgPool.query(
          `SELECT id, project_id, output_dir, version, prompt, negative_prompt, file_path,
                  model, workflow, seed, attempts, source, video_type, is_main, pinned, metadata,
                  started_at, completed_at, created_at, updated_at
           FROM project_references WHERE project_id = $1
           ORDER BY output_dir ASC, created_at ASC, id ASC`,
          [pid]);
      return json(res, 200, r.rows);
    }
    // Saved Create Song form for a project (project_songs row).
    // GET /api/project/:name/song — returns the exact fields the user filled
    // in, so selecting the project restores the whole form. Lazy-backfills
    // from the scenario config on first read (projects saved before the
    // project_songs table existed, e.g. Ramya, get their row here).
    if (p.startsWith("/api/project/") && p.endsWith("/song") && req.method === "GET") {
      const segs = p.split("/");
      const name = decodeURIComponent(segs[3] || "");
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      if (!pgUp) return json(res, 503, { error: "database unavailable" });
      let row = (await pgPool.query(
        `SELECT s.*, p.folder_name AS pfolder, p.project_type
         FROM projects p LEFT JOIN project_songs s ON s.project_id = p.project_id
         WHERE p.name = $1`, [name])).rows[0] ?? null;
      if (!row) return json(res, 404, { error: "no such project" });
      if (row.id == null) {
        // No song row yet — backfill from the saved scenario audio block.
        try {
          const raw = await dbGetScenario(name);
          const cfg = raw ? JSON.parse(raw) : null;
          if (cfg && cfg.audio && typeof cfg.audio === "object") {
            const pid = await pgProjectId(name);
            await pgUpsertProjectSong(name, cfg, pid, row.pfolder || folderName(name));
            row = (await pgPool.query(
              `SELECT s.*, p.folder_name AS pfolder, p.project_type
               FROM projects p LEFT JOIN project_songs s ON s.project_id = p.project_id
               WHERE p.name = $1`, [name])).rows[0] ?? row;
          }
        } catch (e) { console.warn("[pg] song backfill failed:", e.message); }
      }
      const { id, project_id, folder_name, description, tags, lyrics, duration,
        bpm, language, keyscale, timesignature, seed, steps, file_path, updated_at,
        song_preset, song_vocal, cfg_scale, temperature, song_model } = row ?? {};
      const folder = folder_name ?? row?.pfolder ?? folderName(name);
      // file_path always tracks the latest take on disk (a take rendered
      // outside a save — or deleted since — is reconciled on read).
      let filePath = file_path ?? null;
      try {
        const latest = latestSongFile(folder);
        if (latest && latest !== filePath && id != null) {
          await pgPool.query(`UPDATE project_songs SET file_path = $2, updated_at = now() WHERE id = $1`, [id, latest]);
          filePath = latest;
        }
      } catch { /* keep the stored value */ }
      const file = filePath ? path.basename(filePath) : null;
      return json(res, 200, {
        name,
        folder,
        project_type: row?.project_type ?? "VIDEO",
        song: id == null ? null : {
          description: description ?? null, tags: tags ?? null, lyrics: lyrics ?? null,
          duration, bpm, language: language ?? null, keyscale: keyscale ?? null,
          timesignature: timesignature ?? null, seed, steps,
          songPreset: song_preset ?? null, songVocal: song_vocal ?? null,
          cfgScale: cfg_scale ?? null, temperature: temperature ?? null,
          songModel: song_model ?? null,
          file_path: filePath,
          ...(file ? { file, url: `/outputs/${folder}/${encodeURIComponent(file)}` } : {}),
          project_id, updated_at,
        },
      });
    }
    // Generated songs for a project (ACE-Step mp3s in outputs/<folder>/).
    // GET /api/project/:name/songs — versioned song takes, newest last.
    // This is what the Create Song tab's "Generated Songs" section displays.
    if (p.startsWith("/api/project/") && p.endsWith("/songs") && req.method === "GET") {
      const segs = p.split("/");
      const name = decodeURIComponent(segs[3] || "");
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      const folder = (pgUp ? await getFolderNameFromRow(name) : null) || folderName(name);
      const dir = path.join(OUTPUTS, folder);
      const songs = [];
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
          if (!SONG_FILE_RE.test(f)) continue;
          const full = path.join(dir, f);
          try {
            if (!fs.statSync(full).isFile()) continue;
            const stem = f.slice(0, -".mp3".length);
            const m = stem.match(/_song_v(\d+)$/);
            songs.push({
              file: f,
              url: `/outputs/${folder}/${encodeURIComponent(f)}`,
              version: m ? Number(m[1]) : 1,
              bytes: fs.statSync(full).size,
              mtimeMs: Math.round(fs.statSync(full).mtimeMs),
            });
          } catch { /* skip unreadable entries */ }
        }
      }
      songs.sort((a, b) => a.version - b.version || (a.file < b.file ? -1 : 1));
      return json(res, 200, { folder, songs });
    }
    // Delete one generated song take (ACE-Step mp3 in outputs/<folder>/).
    // DELETE /api/project/:name/songs/:file — removes the mp3 from disk and
    // repoints project_songs.file_path in the DB (to the next-latest take, or
    // null when none remain). Only *_song[_vN].mp3 files are deletable.
    if (p.startsWith("/api/project/") && p.includes("/songs/") && req.method === "DELETE") {
      const segs = p.split("/");
      // [0]="" [1]="api" [2]="project" [3]=name [4]="songs" [5]=file
      if (segs.length !== 6 || segs[4] !== "songs") return json(res, 404, { error: "unknown route" });
      const name = pathName(segs[3]);
      const file = pathName(segs[5]);
      if (!isSafe(name) || !isSafe(file)) return json(res, 400, { error: "bad name" });
      if (!SONG_FILE_RE.test(file)) return json(res, 400, { error: "not a generated song file" });
      const folder = (pgUp ? await getFolderNameFromRow(name) : null) || folderName(name);
      const full = path.join(OUTPUTS, folder, file);
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return json(res, 404, { error: "no such song" });
      try { fs.unlinkSync(full); } catch (e) { return json(res, 500, { error: "delete failed: " + e.message }); }
      // DB: project_songs.file_path always tracks the latest take — repoint
      // it when the deleted file was the stored one (or reconcile anyway).
      let filePath = null;
      if (pgUp) {
        try {
          filePath = latestSongFile(folder);
          const pid = await pgProjectId(name);
          if (pid != null) {
            await pgPool.query(
              `UPDATE project_songs SET file_path = $2, updated_at = now() WHERE project_id = $1`,
              [pid, filePath]);
          }
        } catch (e) { console.warn("[pg] song delete repoint failed:", e.message); }
      }
      return json(res, 200, { ok: true, deleted: file, file_path: filePath });
    }
    // Character dialogue pipeline status (disk-derived, no DB required).
    // GET /api/project/:name/dialogue[?engine=ltx|wan&format=landscape|vertical]
    // — per-beat dialogue lines + per-stage status (voice/video/lipsync/final)
    // so the UI can show every stage independently and retry only the failed
    // one (retry = POST /api/runs { mode: "dialogue", beats: "N" }).
    if (p.startsWith("/api/project/") && p.endsWith("/dialogue") && req.method === "GET") {
      const segs = p.split("/");
      const name = decodeURIComponent(segs[3] || "");
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      let raw;
      try { raw = await dbGetScenario(name); }
      catch { return json(res, 503, { error: "database unavailable" }); }
      if (raw === null) return json(res, 404, { error: "no such scenario" });
      let cfg;
      try { cfg = JSON.parse(raw); }
      catch { return json(res, 500, { error: "scenario config is corrupt" }); }
      const engine = String(u.searchParams.get("engine") || "ltx").toLowerCase() === "wan" ? "wan" : "ltx";
      const format = normalizeFormat(String(u.searchParams.get("format") || "landscape"));
      const folder = (pgUp ? await getFolderNameFromRow(name).catch(() => null) : null) || folderName(name);
      const dirName = outDirName(folder, engine, format);
      const outDir = path.join(OUTPUTS, dirName);
      const prefix = prefixForDir(dirName);
      const seq = Array.isArray(cfg.sequence) ? cfg.sequence : [];
      const beats = seq.map((b, i) => {
        const n = i + 1;
        const title = b?.title ?? `beat${n}`;
        const dialogue = normalizeDialogue(b?.dialogue);
        const st = beatDialogueStatus({ outDir, prefix, n, title, dialogue });
        // Actual per-line audio lengths when the line wavs exist on disk.
        const lineDurations = dialogue.map((_, li) => {
          try {
            const f = path.join(outDir, lineWavFile(prefix, n, title, li));
            return fs.existsSync(f) ? Math.round(audioDuration(f) * 100) / 100 : null;
          } catch { return null; }
        });
        const timing = lineDurations.every((d) => typeof d === "number" && d > 0)
          ? planDialogueTiming(dialogue, lineDurations)
          : [];
        return {
          ...st,
          dialogue,
          lineDurations,
          ...(timing.length ? { timing, total: dialogueTotal(timing) } : {}),
        };
      });
        let musetalkWorkflow = false;
        try { musetalkWorkflow = musetalkWorkflowReady(); } catch { musetalkWorkflow = false; }
      return json(res, 200, {
        name, folder, engine, format, dir: dirName,
        providers: { tts: ttsProviderName(), lipsync: lipSyncProviderName(), musetalkWorkflow },
        beats,
      });
    }
    // Update one beat's dialogue (create/edit dialogue lines).
    // PUT /api/project/:name/scene/:n/dialogue { dialogue: [{ speaker, line }] }
    // — validates, persists through the scenario store (scenarios + prompts
    // JSON + in-place version, same as Save Scenario), and deletes the beat's
    // stale voice wavs in every cut dir so the next GET honestly reports
    // voice=PENDING (dialogue changed -> regenerate TTS -> regenerate
    // lip-sync; the unchanged clip video is kept when still compatible).
    if (p.startsWith("/api/project/") && p.includes("/scene/") && p.endsWith("/dialogue") && req.method === "PUT") {
      const segs = p.split("/");
      // [0]="" [1]="api" [2]="project" [3]=name [4]="scene" [5]=n [6]="dialogue"
      if (segs.length !== 7 || segs[4] !== "scene") return json(res, 404, { error: "unknown route" });
      const name = pathName(segs[3]);
      const n = Number(segs[5]);
      if (!isSafe(name) || !Number.isInteger(n) || n < 1) return json(res, 400, { error: "bad name or scene" });
      const body = await readJson(req).catch(() => null);
      if (!body || !Array.isArray(body.dialogue)) return json(res, 400, { error: "body must be { dialogue: [{ speaker, line }] }" });
      if (body.dialogue.length > 8) return json(res, 400, { error: "at most 8 dialogue lines per scene" });
      for (const d of body.dialogue) {
        if (!d || typeof d !== "object" || typeof d.line !== "string" || !d.line.trim())
          return json(res, 400, { error: "every dialogue entry needs a non-empty line" });
        if (d.line.length > 500) return json(res, 400, { error: "dialogue line over 500 chars" });
        if (typeof d.speaker !== "string" || !d.speaker.trim())
          return json(res, 400, { error: "every dialogue entry needs a speaker" });
      }
      let prevRaw;
      try { prevRaw = await dbGetScenario(name); }
      catch { return json(res, 503, { error: "database unavailable" }); }
      if (prevRaw === null) return json(res, 404, { error: "no such scenario" });
      let cfg;
      try { cfg = JSON.parse(prevRaw); }
      catch { return json(res, 500, { error: "scenario config is corrupt" }); }
      const seq = Array.isArray(cfg.sequence) ? cfg.sequence : [];
      if (n > seq.length) return json(res, 400, { error: `scene ${n} out of range (1..${seq.length})` });
      const dialogue = normalizeDialogue(body.dialogue);
      const prevCfg = JSON.parse(JSON.stringify(cfg));
      seq[n - 1] = { ...seq[n - 1], dialogue };
      if (body.duration != null) {
        const d = Number(body.duration);
        if (!Number.isFinite(d) || d < 1 || d > 30) return json(res, 400, { error: "duration must be 1..30s" });
        seq[n - 1].duration = Math.round(d);
      }
      if (USE_SQLITE) {
        await dbSaveScenario(name, cfg);
        fs.writeFileSync(promptsSlugFile(name), JSON.stringify(cfg, null, 2));
        pgSaveScenarioMirror(name, cfg).catch((e) => console.warn("[pg] scenario mirror failed:", e.message));
      } else {
        if (!pgUp) return json(res, 503, { error: "database unavailable" });
        await dbSaveScenario(name, cfg);
        fs.writeFileSync(promptsSlugFile(name), JSON.stringify(cfg, null, 2));
      }
      let version = null;
      if (pgUp) {
        try {
          const latestRow = await pgPool.query(
            "SELECT max(version) AS v FROM scenario_versions WHERE name = $1", [name]);
          const latest = latestVersionOf(latestRow.rows[0]?.v);
          const saved = latest == null
            ? await pgSaveVersionDelta(name, prevCfg, cfg)
            : await pgSaveVersionInPlace(name, latest, prevCfg, cfg);
          version = saved.version;
        } catch (e) { console.warn("[pg] dialogue version save failed:", e.message); }
      }
      // Invalidate stale voice takes in every cut dir (voice must be
      // regenerated for the new lines; clip video stays until re-synced).
      const folder = (pgUp ? await getFolderNameFromRow(name).catch(() => null) : null)
        || cfg.folder_name || folderName(name);
      const title = seq[n - 1]?.title ?? `beat${n}`;
      let invalidated = 0;
      for (const suffix of ["", "_wan", "_vertical", "_wan_vertical"]) {
        const dir = path.join(OUTPUTS, folder + suffix);
        if (!fs.existsSync(dir)) continue;
        const pfx = prefixForDir(folder + suffix);
        const mixed = dialogueWavFile(pfx, n, title);
        for (const f of fs.readdirSync(dir)) {
          if (f === mixed || (f.startsWith(mixed.replace(/\.wav$/, "")) && f.endsWith(".wav"))) {
            try { fs.unlinkSync(path.join(dir, f)); invalidated++; } catch { /* keep going */ }
          }
        }
      }
      return json(res, 200, { ok: true, version, scene: n, dialogue, segmented: needsSegmentation(dialogue), invalidated });
    }
// ---------------------------------------------------------------- database browser
// Generic SQLite browser + row CRUD for the Database tab.
// Covers every user table in data/scenarios.sqlite
// (the canonical store when USE_SQLITE=true). Identifiers are validated
// against /^[A-Za-z_][A-Za-z0-9_]*$/ AND against the live schema, all values
// are bound — no string-interpolated user input ever reaches SQL.
const DB_BROWSER_FILES = { scenarios: DB };
const dbIdentOk = (s) => typeof s === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
const dbFileOf = (key) => "scenarios";
// A fresh short-lived handle per request (never touches the long-lived db
// handle); closed before responding.
const dbBrowserOpen = (key) => {
  const file = DB_BROWSER_FILES[dbFileOf(key)];
  if (!file || !fs.existsSync(file)) return null;
  return new DatabaseSync(file);
};
const dbBrowserTables = (h) =>
  h.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map((r) => r.name).filter(dbIdentOk);
const dbBrowserColumns = (h, table) =>
  h.prepare("SELECT name, type, [notnull], dflt_value, pk FROM pragma_table_info(?)").all(table);
const dbBrowserPk = (cols) => cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
// "" in a numeric column means NULL (SQLite affinity would otherwise store a
// TEXT empty string in an INTEGER column).
const dbCoerce = (cols, values) => {
  const byName = new Map(cols.map((c) => [c.name, String(c.type || "").toUpperCase()]));
  const out = {};
  for (const [k, v] of Object.entries(values || {})) {
    if (!byName.has(k)) continue;
    const t = byName.get(k);
    if (v === "" && /INT|REAL|FLOA|DOUB|NUMERIC|DECIMAL/.test(t)) out[k] = null;
    else out[k] = v === undefined ? null : v;
  }
  return out;
};
const dbReadRow = (h, table, keyCols, key) => {
  const where = keyCols.map((c) => `"${c}" IS ?`).join(" AND ");
  const vals = keyCols.map((c) => (key[c] === undefined ? null : key[c]));
  return h.prepare(`SELECT * FROM "${table}" WHERE ${where}`).get(...vals) ?? null;
};
// Row keys arrive as JSON (form fields are strings): coerce numeric-looking
// strings for numeric columns — `IS` (unlike `=`) applies no type affinity,
// so "3" would never match an INTEGER 3 without this.
const dbCoerceKey = (cols, key) => {
  const byName = new Map(cols.map((c) => [c.name, String(c.type || "").toUpperCase()]));
  const out = { ...(key || {}) };
  for (const [k, v] of Object.entries(out)) {
    const t = byName.get(k);
    if (typeof v === "string" && t && /INT|REAL|FLOA|DOUB|NUMERIC|DECIMAL/.test(t)
        && v.trim() !== "" && Number.isFinite(Number(v))) out[k] = Number(v);
  }
  return out;
};
if (p === "/api/database" && req.method === "GET") {
  const files = [];
  for (const key of ["scenarios"]) {
    const h = dbBrowserOpen(key);
    if (!h) continue;
    try {
      const tables = dbBrowserTables(h).map((name) => {
        let rows = 0;
        try { rows = h.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get()?.n ?? 0; } catch { rows = 0; }
        return { name, rows };
      });
      files.push({
        key,
        file: path.relative(ROOT, DB_BROWSER_FILES[key]) || DB_BROWSER_FILES[key],
        tables,
      });
    } finally { try { h.close(); } catch { /* ignore */ } }
  }
  return json(res, 200, { store: USE_SQLITE ? "sqlite" : "postgres", files });
}
if (p === "/api/database/rows" && req.method === "GET") {
  const key = dbFileOf(u.searchParams.get("db"));
  const table = u.searchParams.get("table") || "";
  const h = dbBrowserOpen(key);
  if (!h) return json(res, 503, { error: "database file unavailable" });
  try {
    if (!dbIdentOk(table) || !dbBrowserTables(h).includes(table))
      return json(res, 404, { error: "unknown table" });
    const cols = dbBrowserColumns(h, table);
    const pk = dbBrowserPk(cols);
    const search = (u.searchParams.get("search") || "").trim();
    const where = [];
    const args = [];
    if (search) {
      // Case-insensitive substring match across every column.
      const ors = cols.map((c) => `CAST("${c.name}" AS TEXT) LIKE ? ESCAPE '\\'`);
      where.push(`(${ors.join(" OR ")})`);
      const esc = search.replace(/[\\%_]/g, (c) => `\\${c}`);
      for (let i = 0; i < ors.length; i++) args.push(`%${esc}%`);
    }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = h.prepare(`SELECT COUNT(*) AS n FROM "${table}" ${w}`).get(...args)?.n ?? 0;
    let sort = u.searchParams.get("sort") || "";
    if (sort && (!dbIdentOk(sort) || !cols.some((c) => c.name === sort))) sort = "";
    const dir = String(u.searchParams.get("dir") || "").toUpperCase() === "ASC" ? "ASC" : "DESC";
    const order = sort ? `ORDER BY "${sort}" ${dir}` : "ORDER BY rowid DESC";
    const limit = Math.max(1, Math.min(200, Number(u.searchParams.get("limit")) || 25));
    const offset = Math.max(0, Number(u.searchParams.get("offset")) || 0);
    const rows = h.prepare(`SELECT rowid AS _rowid, * FROM "${table}" ${w} ${order} LIMIT ? OFFSET ?`)
      .all(...args, limit, offset);
    return json(res, 200, {
      db: key, table,
      columns: cols.map((c) => ({ name: c.name, type: c.type, notnull: !!c.notnull, default: c.dflt_value ?? null, pk: c.pk > 0 })),
      pk, total, limit, offset, rows,
    });
  } finally { try { h.close(); } catch { /* ignore */ } }
}
if (p === "/api/database/rows" && (req.method === "POST" || req.method === "PUT" || req.method === "DELETE")) {
  const key = dbFileOf(u.searchParams.get("db"));
  const table = u.searchParams.get("table") || "";
  const h = dbBrowserOpen(key);
  if (!h) return json(res, 503, { error: "database file unavailable" });
  try {
    if (!dbIdentOk(table) || !dbBrowserTables(h).includes(table))
      return json(res, 404, { error: "unknown table" });
    const cols = dbBrowserColumns(h, table);
    const pk = dbBrowserPk(cols);
    let body = {};
    try { body = await readJson(req); } catch { return json(res, 400, { error: "bad json" }); }
    const keyOf = (k) => {
      // { col: val } object, or a scalar for single-column PK tables.
      if (k != null && typeof k === "object" && !Array.isArray(k)) return k;
      if (pk.length === 1) return { [pk[0]]: k };
      return {};
    };
    if (req.method === "POST") {
      const values = dbCoerce(cols, body.values || body);
      if (table === "scenarios") {
        if (!values.name || !String(values.name).trim()) return json(res, 400, { error: "name is required" });
        if (values.config != null) {
          try { JSON.parse(String(values.config)); }
          catch { return json(res, 400, { error: "config must be valid JSON" }); }
        }
        if (values.updated_at == null) values.updated_at = Date.now();
      }
      // Column list is built AFTER table defaults are applied (the
      // scenarios updated_at default above must reach the INSERT).
      const names = Object.keys(values);
      if (!names.length) return json(res, 400, { error: "no values" });
      const placeholders = names.map(() => "?").join(", ");
      const q = `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${placeholders})`;
      let stmtInfo;
      try {
        stmtInfo = h.prepare(q).run(...names.map((n) => values[n]));
      } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
      if (table === "scenarios") {
        // Keep prompts/<name>.json in sync (CLI runners read it).
        try {
          fs.mkdirSync(PROMPTS, { recursive: true });
          fs.writeFileSync(promptsSlugFile(values.name), String(values.config ?? "{}"));
        } catch (e) { console.warn("[database] prompts mirror failed:", e.message); }
      }
      let row = null;
      try {
        if (pk.length === 1 && /INT/.test(String(cols.find((c) => c.name === pk[0])?.type || "").toUpperCase())) {
          row = h.prepare(`SELECT rowid AS _rowid, * FROM "${table}" WHERE rowid IS ?`).get(stmtInfo.lastInsertRowid) ?? null;
        } else if (pk.length) {
          row = dbReadRow(h, table, pk, dbCoerceKey(cols, Object.fromEntries(pk.map((c) => [c, values[c] ?? null]))));
        }
      } catch { row = null; }
      return json(res, 200, { ok: true, row });
    }
    if (req.method === "PUT") {
      const keyVals = dbCoerceKey(cols, keyOf(body.key));
      const values = dbCoerce(cols, body.values || {});
      const names = Object.keys(values).filter((n) => !(pk.includes(n)));
      const keyCols = pk.length ? pk : ["_rowid"];
      const effKey = pk.length ? keyVals : { _rowid: Number(body.key?.rowid ?? body.key?._rowid ?? body.key) };
      if (!names.length) return json(res, 400, { error: "no values to update" });
      if (keyCols.some((c) => effKey[c] === undefined))
        return json(res, 400, { error: "row key is required" });
      if (table === "scenarios" && values.config != null) {
        try { JSON.parse(String(values.config)); }
        catch { return json(res, 400, { error: "config must be valid JSON" }); }
      }
      const set = names.map((n) => `"${n}" = ?`).join(", ");
      const where = keyCols.map((c) => (c === "_rowid" ? "rowid IS ?" : `"${c}" IS ?`)).join(" AND ");
      let info;
      try {
        info = h.prepare(`UPDATE "${table}" SET ${set} WHERE ${where}`)
          .run(...names.map((n) => values[n]), ...keyCols.map((c) => (effKey[c] === undefined ? null : effKey[c])));
      } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
      if (!info.changes) return json(res, 404, { error: "row not found" });
      const row = pk.length
        ? dbReadRow(h, table, pk, effKey)
        : h.prepare(`SELECT rowid AS _rowid, * FROM "${table}" WHERE rowid IS ?`).get(effKey._rowid ?? null);
      if (table === "scenarios" && row) {
        try {
          fs.mkdirSync(PROMPTS, { recursive: true });
          fs.writeFileSync(promptsSlugFile(row.name), String(row.config ?? "{}"));
        } catch (e) { console.warn("[database] prompts mirror failed:", e.message); }
      }
      return json(res, 200, { ok: true, updated: info.changes, row });
    }
    // DELETE — body { key } or ?key=<scalar> for single-PK tables.
    const rawKey = body.key !== undefined ? body.key : u.searchParams.get("key");
    let keyVals = dbCoerceKey(cols, keyOf(typeof rawKey === "string" && pk.length === 1 ? rawKey : rawKey));
    if (pk.length === 1 && keyVals[pk[0]] === undefined && typeof rawKey === "string") {
      const n = Number(rawKey);
      keyVals = { [pk[0]]: rawKey !== "" && Number.isFinite(n) && String(n) === rawKey ? n : rawKey };
    }
    const keyCols = pk.length ? pk : ["_rowid"];
    const effKey = pk.length ? keyVals : { _rowid: Number(rawKey) };
    if (keyCols.some((c) => effKey[c] === undefined || (c === "_rowid" && !Number.isFinite(effKey[c]))))
      return json(res, 400, { error: "row key is required" });
    let doomed = null;
    if (table === "scenarios") {
      doomed = pk.length ? dbReadRow(h, table, pk, effKey) : null;
    }
    const where = keyCols.map((c) => (c === "_rowid" ? "rowid IS ?" : `"${c}" IS ?`)).join(" AND ");
    let info;
    try {
      info = h.prepare(`DELETE FROM "${table}" WHERE ${where}`)
        .run(...keyCols.map((c) => (effKey[c] === undefined ? null : effKey[c])));
    } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
    if (!info.changes) return json(res, 404, { error: "row not found" });
    if (table === "scenarios" && doomed?.name) {
      // Remove the slug-named export AND any legacy raw display-name file.
      for (const f of [promptsSlugFile(doomed.name), promptsLegacyFile(doomed.name)]) {
        try { fs.unlinkSync(f); } catch { /* prompt file may not exist */ }
      }
    }
    return json(res, 200, { ok: true, deleted: info.changes });
  } finally { try { h.close(); } catch { /* ignore */ } }
}
    if (p === "/api/db" && req.method === "GET") {      if (USE_SQLITE) return json(res, 200, { up: true, store: "sqlite" });
      if (!(await pgProbe())) return json(res, 200, { up: false });
      const [s, pj, pa, pr] = await Promise.all([
        pgPool.query("SELECT count(*)::int AS n FROM scenarios"),
        pgPool.query("SELECT count(*)::int AS n FROM projects").catch(() => ({ rows: [{ n: null }] })),
        pgPool.query("SELECT count(*)::int AS n FROM project_assets").catch(() => ({ rows: [{ n: null }] })),
        pgPool.query("SELECT count(*)::int AS n FROM project_references").catch(() => ({ rows: [{ n: null }] })),
      ]);
      return json(res, 200, { up: true, scenarios: s.rows[0].n, projects: pj.rows[0].n, project_assets_linked: pa.rows[0].n, references: pr.rows[0].n });
    }
    if (p.startsWith("/outputs/")) {
      const [, , scenario, file] = p.split("/");
      return serveOutput(res, decodeURIComponent(scenario), decodeURIComponent(file));
    }
    if (p.startsWith("/resources/")) {
      const [, , file] = p.split("/");
      return serveResource(res, decodeURIComponent(file));
    }
    if (p.startsWith("/kids/")) {
      // /kids/<scope>/<Kind>/<key>/<file> — the Sanskriti Kids asset
      // library's generated reference stills (path segments are validated:
      // path segments are validated, nothing outside the kids folder is
      // readable).
      const rel = p.slice("/kids/".length).split("/").map((s) => {
        try { return decodeURIComponent(s); } catch { return ""; }
      }).join("/");
      return serveKids(res, rel);
    }
    if (p.startsWith("/director-assets/")) {
      // /director-assets/<boardId>/<kind>/<assetId>/reference[_vN].png
      const rel = p.slice("/director-assets/".length).split("/").map((s) => {
        try { return decodeURIComponent(s); } catch { return ""; }
      }).join("/");
      return serveDirectorAssets(res, rel);
    }

    // ----- Generate Assets stage (real jobs, persisted on the board JSON) -----
    const assetBoardMatch = p.match(/^\/api\/director\/boards\/([^/]+)\/assets\/(generate|approve|skip|regenerate)$/);
    if (assetBoardMatch && req.method === "POST") {
      const id = decodeURIComponent(assetBoardMatch[1]);
      const action = assetBoardMatch[2];
      const board = readDirectorBoard(id);
      const body = (await readJson(req).catch(() => ({}))) || {};
      let state = getBoardAssetState(board);

      if (action === "generate" || action === "regenerate") {
        const comfy = await directorComfyProbe();
        if (!comfy.up) {
          return json(res, 503, {
            error: `ComfyUI is unavailable: ${comfy.error}. Start ComfyUI and retry asset generation.`,
            production: state,
          });
        }
      }

      if (action === "generate") {
        // Build once per bible version. Clicking twice must NOT reset a
        // rendered-but-unapproved asset to pending or queue duplicate jobs.
        const signature = blueprintAssetSignature(board.blueprint);
        if (!state.assets.length || state.sourceSignature !== signature) {
          state = buildBoardAssetState(board.blueprint, state);
        }
        if (state.jobs.some((j) => j && (j.status === "PENDING" || j.status === "PROCESSING"))) {
          return json(res, 409, { error: "master asset renders are already queued — wait for them to finish", production: state });
        }
        const wanted = Array.isArray(body.ids) && body.ids.length
          ? new Set(body.ids.map(String)) : null;
        const wf = resolveImageWorkflow(String(body.workflow || "flux_text_image"), DEFAULT_IMAGE_WORKFLOW);
        const targets = state.assets.filter((a) => {
          if (wanted && !wanted.has(a.id)) return false;
          if (wanted) return Boolean(String(a.prompt || "").trim()); // explicit retry
          return a.status === "pending" || a.status === "no-prompt";
        });
        const noPrompt = targets.filter((a) => !String(a.prompt || "").trim()).map((a) => a.id);
        const queueable = targets.filter((a) => String(a.prompt || "").trim());
        if (!queueable.length && noPrompt.length) {
          return json(res, 400, { error: `assets have no saved generation prompt: ${noPrompt.join(", ")}`, production: state });
        }
        const now = new Date().toISOString();
        for (const a of queueable) {
          state.jobs.push({
            id: `dir_asset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            asset_id: a.id,
            kind: "master_reference",
            status: "PENDING",
            workflow: wf.id,
            error: null,
            created_at: now,
            updated_at: now,
            metadata: {},
          });
          a.status = "queued";
          a.error = null;
        }
        state.status = queueable.length ? "generating" : state.status;
        board.assetProduction = state;
        directorAssetWriteBoard(board);
        if (queueable.length) void directorAssetPumpJobs();
        return json(res, 202, { production: state, queued: queueable.length, no_prompt: noPrompt });
      }

      if (action === "regenerate") {
        const assetId = String(body.id || "");
        if (!isValidAssetId(assetId)) return json(res, 400, { error: "invalid asset id" });
        const asset = findAsset(state, assetId);
        if (!asset) return json(res, 404, { error: "no such asset on this board" });
        const prompt = String(body.prompt ?? asset.prompt ?? "").trim();
        if (!prompt) return json(res, 400, { error: "a generation prompt is required" });
        const wf = resolveImageWorkflow(String(body.workflow || asset.workflow || "flux_text_image"), DEFAULT_IMAGE_WORKFLOW);
        asset.prompt = prompt; // explicit edit wins
        asset.status = "queued";
        asset.error = null;
        const now = new Date().toISOString();
        state.jobs.push({
          id: `dir_asset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          asset_id: asset.id, kind: "master_reference", status: "PENDING", workflow: wf.id,
          error: null, created_at: now, updated_at: now, metadata: {},
        });
        state.status = "generating";
        state.updatedAt = now;
        board.assetProduction = state;
        directorAssetWriteBoard(board);
        void directorAssetPumpJobs();
        return json(res, 202, { production: state });
      }

      if (action === "approve") {
        const ids = Array.isArray(body.ids) && body.ids.length ? body.ids.map(String) : null;
        const result = approveAssets(state, ids);
        board.assetProduction = result.state;
        directorAssetWriteBoard(board);
        return json(res, 200, { production: result.state, approved: result.changed });
      }

      if (action === "skip") {
        board.assetProduction = skipAssets(state);
        directorAssetWriteBoard(board);
        return json(res, 200, { production: board.assetProduction });
      }

      return json(res, 400, { error: "unknown asset action" });
    }
    if (p.startsWith("/api/")) return json(res, 404, { error: "unknown route" });
    serveStatic(req, res, p === "/" ? "/index.html" : p);
  } catch (e) {
    // Log the real failure server-side (method + route + message + stack) so
    // a 500 is always diagnosable from the backend terminal — previously only
    // the message reached the client and nothing was logged.
    try {
      console.error(`[api] ${req.method} ${p} failed: ${(e && e.message) || e}${e && e.stack ? `\n${e.stack}` : ""}`);
    } catch { /* logging must never break the error response */ }
    json(res, 500, { error: String(e.message || e) });
  }
});
server.on("error", (e) => {
  if (e && e.code === "EADDRINUSE") {
    console.error(`port ${PORT} is already in use — a server is already running (run only one 'npm run serve' at a time).`);
    process.exit(1);
  }
  throw e;
});
server.listen(PORT, () => {
  console.log(`frontend server on http://localhost:${PORT}`);
  console.log(`[env] LLM_BASE=${process.env.LLM_BASE || "(not set)"} COMFY_BASE=${process.env.COMFY_BASE || "(not set)"}`);
  // Resume any master-asset renders interrupted by a restart.
  void directorAssetPumpJobs();
});

