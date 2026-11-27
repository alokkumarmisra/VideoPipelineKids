import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
fs.mkdirSync(DATA, { recursive: true });
export const movieFilesDir = path.join(DATA, "movie", "references");
fs.mkdirSync(movieFilesDir, { recursive: true });
export const movieDb = new DatabaseSync(path.join(DATA, "movie.sqlite"));
movieDb.exec(`
PRAGMA busy_timeout = 10000;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS movie_projects (
  movie_id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS movie_characters (
  character_id TEXT PRIMARY KEY, movie_id TEXT NOT NULL REFERENCES movie_projects(movie_id) ON DELETE CASCADE,
  name TEXT NOT NULL, identity_json TEXT NOT NULL, personality TEXT NOT NULL DEFAULT '', background TEXT NOT NULL DEFAULT '',
  voice_profile TEXT NOT NULL DEFAULT '', relationships_json TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL DEFAULT '',
  identity_version INTEGER NOT NULL DEFAULT 1, approval_status TEXT NOT NULL DEFAULT 'draft', identity_locked INTEGER NOT NULL DEFAULT 0,
  canonical_reference_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS movie_identity_versions (
  character_id TEXT NOT NULL REFERENCES movie_characters(character_id) ON DELETE CASCADE,
  version INTEGER NOT NULL, identity_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(character_id, version)
);
CREATE TABLE IF NOT EXISTS movie_character_references (
  reference_id TEXT PRIMARY KEY, character_id TEXT NOT NULL REFERENCES movie_characters(character_id) ON DELETE CASCADE,
  identity_version INTEGER NOT NULL DEFAULT 1, view TEXT NOT NULL, file_path TEXT NOT NULL, source_board_id TEXT, source_asset_id TEXT, status TEXT NOT NULL DEFAULT 'review',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS movie_costumes (
  costume_id TEXT PRIMARY KEY, character_id TEXT NOT NULL REFERENCES movie_characters(character_id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '', fabric TEXT NOT NULL DEFAULT '',
  accessories TEXT NOT NULL DEFAULT '', reference_path TEXT, version INTEGER NOT NULL DEFAULT 1,
  approval_status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS movie_environment_assets (
  asset_id TEXT PRIMARY KEY, movie_id TEXT NOT NULL REFERENCES movie_projects(movie_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('location','object')), name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  aliases_json TEXT NOT NULL DEFAULT '[]', identity_version INTEGER NOT NULL DEFAULT 1,
  reference_path TEXT, reference_status TEXT NOT NULL DEFAULT 'missing',
  approval_status TEXT NOT NULL DEFAULT 'draft', identity_locked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS movie_screenplays (
  movie_id TEXT PRIMARY KEY REFERENCES movie_projects(movie_id) ON DELETE CASCADE,
  logline TEXT NOT NULL DEFAULT '', synopsis TEXT NOT NULL DEFAULT '', plot_json TEXT NOT NULL DEFAULT '[]',
  screenplay_text TEXT NOT NULL DEFAULT '', genre TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS movie_scenes (
  scene_id TEXT PRIMARY KEY, movie_id TEXT NOT NULL REFERENCES movie_projects(movie_id) ON DELETE CASCADE,
  scene_number INTEGER NOT NULL, title TEXT NOT NULL, location TEXT NOT NULL DEFAULT '', time_of_day TEXT NOT NULL DEFAULT '',
  duration_seconds REAL NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft',
  continuity_start_json TEXT NOT NULL DEFAULT '{}', continuity_end_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(movie_id, scene_number)
);
CREATE TABLE IF NOT EXISTS movie_shots (
  shot_id TEXT PRIMARY KEY, scene_id TEXT NOT NULL REFERENCES movie_scenes(scene_id) ON DELETE CASCADE,
  shot_number INTEGER NOT NULL, character_ids_json TEXT NOT NULL DEFAULT '[]', costume_ids_json TEXT NOT NULL DEFAULT '[]',
  location_ids_json TEXT NOT NULL DEFAULT '[]', object_ids_json TEXT NOT NULL DEFAULT '[]',
  action TEXT NOT NULL DEFAULT '', body_movement TEXT NOT NULL DEFAULT '', expression TEXT NOT NULL DEFAULT '', emotion TEXT NOT NULL DEFAULT '',
  dialogue TEXT NOT NULL DEFAULT '', camera_angle TEXT NOT NULL DEFAULT '', camera_movement TEXT NOT NULL DEFAULT '', shot_size TEXT NOT NULL DEFAULT '',
  lighting TEXT NOT NULL DEFAULT '', composition TEXT NOT NULL DEFAULT '', duration_seconds REAL NOT NULL DEFAULT 0,
  continuity_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'draft', UNIQUE(scene_id, shot_number)
);
CREATE TABLE IF NOT EXISTS movie_character_state_snapshots (
  snapshot_id TEXT PRIMARY KEY, movie_id TEXT NOT NULL REFERENCES movie_projects(movie_id) ON DELETE CASCADE,
  scene_id TEXT NOT NULL REFERENCES movie_scenes(scene_id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES movie_characters(character_id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1, state_json TEXT NOT NULL, approved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(scene_id, character_id, version)
);
CREATE TABLE IF NOT EXISTS movie_generation_jobs (
  job_id TEXT PRIMARY KEY, movie_id TEXT NOT NULL REFERENCES movie_projects(movie_id) ON DELETE CASCADE,
  shot_id TEXT NOT NULL REFERENCES movie_shots(shot_id) ON DELETE CASCADE, kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', prompt TEXT NOT NULL, workflow TEXT NOT NULL, model TEXT NOT NULL,
  asset_path TEXT, error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS movie_shot_assets (
  asset_id TEXT PRIMARY KEY, shot_id TEXT NOT NULL REFERENCES movie_shots(shot_id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES movie_generation_jobs(job_id) ON DELETE CASCADE, kind TEXT NOT NULL,
  version INTEGER NOT NULL, file_path TEXT NOT NULL, prompt TEXT NOT NULL, workflow TEXT NOT NULL, model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'review', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(shot_id,kind,version)
);
CREATE INDEX IF NOT EXISTS movie_characters_movie_idx ON movie_characters(movie_id);
CREATE INDEX IF NOT EXISTS movie_refs_character_idx ON movie_character_references(character_id);
CREATE INDEX IF NOT EXISTS movie_environment_assets_movie_idx ON movie_environment_assets(movie_id,kind,name);
CREATE INDEX IF NOT EXISTS movie_scenes_movie_idx ON movie_scenes(movie_id,scene_number);
CREATE INDEX IF NOT EXISTS movie_jobs_movie_idx ON movie_generation_jobs(movie_id,created_at DESC);
CREATE INDEX IF NOT EXISTS movie_shot_assets_shot_idx ON movie_shot_assets(shot_id,kind,version DESC);
`);
try { movieDb.exec("ALTER TABLE movie_character_references ADD COLUMN identity_version INTEGER NOT NULL DEFAULT 1"); } catch { /* already migrated */ }
try { movieDb.exec("ALTER TABLE movie_character_references ADD COLUMN source_board_id TEXT"); } catch { /* already migrated */ }
try { movieDb.exec("ALTER TABLE movie_character_references ADD COLUMN source_asset_id TEXT"); } catch { /* already migrated */ }
try { movieDb.exec("ALTER TABLE movie_shots ADD COLUMN location_ids_json TEXT NOT NULL DEFAULT '[]'"); } catch { /* already migrated */ }
try { movieDb.exec("ALTER TABLE movie_shots ADD COLUMN object_ids_json TEXT NOT NULL DEFAULT '[]'"); } catch { /* already migrated */ }

function characterRow(row) {
  if (!row) return null;
  return { ...row, identity: JSON.parse(row.identity_json), relationships: JSON.parse(row.relationships_json),
    identity_locked: !!row.identity_locked, references: movieDb.prepare("SELECT * FROM movie_character_references WHERE character_id=? ORDER BY created_at").all(row.character_id),
    costumes: movieDb.prepare("SELECT * FROM movie_costumes WHERE character_id=? ORDER BY created_at").all(row.character_id) };
}
export function listMovieProjects() {
  return movieDb.prepare(`SELECT p.*, (SELECT COUNT(*) FROM movie_characters c WHERE c.movie_id=p.movie_id) character_count
    FROM movie_projects p ORDER BY updated_at DESC`).all();
}
export function getMovieProject(id) {
  const project = movieDb.prepare("SELECT * FROM movie_projects WHERE movie_id=?").get(id);
  if (!project) return null;
  const screenplay = movieDb.prepare("SELECT * FROM movie_screenplays WHERE movie_id=?").get(id) ?? null;
  if (screenplay) screenplay.plot = JSON.parse(screenplay.plot_json);
  const scenes = movieDb.prepare("SELECT * FROM movie_scenes WHERE movie_id=? ORDER BY scene_number").all(id).map((scene) => ({
    ...scene, continuity_start: JSON.parse(scene.continuity_start_json), continuity_end: JSON.parse(scene.continuity_end_json),
    shots: movieDb.prepare("SELECT * FROM movie_shots WHERE scene_id=? ORDER BY shot_number").all(scene.scene_id).map((shot) => ({
      ...shot, character_ids: JSON.parse(shot.character_ids_json), costume_ids: JSON.parse(shot.costume_ids_json),
      location_ids: JSON.parse(shot.location_ids_json || "[]"), object_ids: JSON.parse(shot.object_ids_json || "[]"), continuity: JSON.parse(shot.continuity_json),
    })),
    state_snapshots: movieDb.prepare("SELECT * FROM movie_character_state_snapshots WHERE scene_id=? ORDER BY character_id,version").all(scene.scene_id).map((row) => ({ ...row, state: JSON.parse(row.state_json), approved: !!row.approved })),
  }));
  return { ...project, screenplay, scenes, characters: movieDb.prepare("SELECT * FROM movie_characters WHERE movie_id=? ORDER BY created_at").all(id).map(characterRow),
    environment_assets: listMovieEnvironmentAssets(id) };
}
export function saveMovieProduction(movieId, screenplay, scenes) {
  if (!movieDb.prepare("SELECT 1 FROM movie_projects WHERE movie_id=?").get(movieId)) throw new Error("Movie not found");
  movieDb.exec("BEGIN IMMEDIATE");
  try {
    movieDb.prepare(`INSERT INTO movie_screenplays(movie_id,logline,synopsis,plot_json,screenplay_text,genre,status,updated_at)
      VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(movie_id) DO UPDATE SET logline=excluded.logline,synopsis=excluded.synopsis,
      plot_json=excluded.plot_json,screenplay_text=excluded.screenplay_text,genre=excluded.genre,status=excluded.status,updated_at=CURRENT_TIMESTAMP`)
      .run(movieId,screenplay.logline||"",screenplay.synopsis||"",JSON.stringify(screenplay.plot||[]),screenplay.screenplay_text||"",screenplay.genre||"",screenplay.status||"draft");
    const sceneInsert = movieDb.prepare(`INSERT INTO movie_scenes(scene_id,movie_id,scene_number,title,location,time_of_day,duration_seconds,summary,status,continuity_start_json,continuity_end_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(movie_id,scene_number) DO UPDATE SET scene_id=excluded.scene_id,title=excluded.title,location=excluded.location,
      time_of_day=excluded.time_of_day,duration_seconds=excluded.duration_seconds,summary=excluded.summary,status=excluded.status,
      continuity_start_json=excluded.continuity_start_json,continuity_end_json=excluded.continuity_end_json`);
    const shotInsert = movieDb.prepare(`INSERT INTO movie_shots(shot_id,scene_id,shot_number,character_ids_json,costume_ids_json,location_ids_json,object_ids_json,action,body_movement,expression,emotion,dialogue,camera_angle,camera_movement,shot_size,lighting,composition,duration_seconds,continuity_json,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(shot_id) DO UPDATE SET scene_id=excluded.scene_id,shot_number=excluded.shot_number,
      character_ids_json=excluded.character_ids_json,costume_ids_json=excluded.costume_ids_json,location_ids_json=excluded.location_ids_json,object_ids_json=excluded.object_ids_json,action=excluded.action,body_movement=excluded.body_movement,
      expression=excluded.expression,emotion=excluded.emotion,dialogue=excluded.dialogue,camera_angle=excluded.camera_angle,camera_movement=excluded.camera_movement,
      shot_size=excluded.shot_size,lighting=excluded.lighting,composition=excluded.composition,duration_seconds=excluded.duration_seconds,continuity_json=excluded.continuity_json,status=excluded.status`);
    const stateInsert = movieDb.prepare(`INSERT INTO movie_character_state_snapshots(snapshot_id,movie_id,scene_id,character_id,version,state_json,approved)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(scene_id,character_id,version) DO UPDATE SET state_json=excluded.state_json,approved=excluded.approved`);
    for (const scene of scenes) {
      sceneInsert.run(scene.scene_id, movieId, scene.scene_number, scene.title, scene.location||"",scene.time_of_day||"",Number(scene.duration_seconds)||0,
        scene.summary||"",scene.status||"draft",JSON.stringify(scene.continuity_start||{}),JSON.stringify(scene.continuity_end||{}));
      for (const shot of scene.shots||[]) shotInsert.run(shot.shot_id,scene.scene_id,shot.shot_number,JSON.stringify(shot.character_ids||[]),JSON.stringify(shot.costume_ids||[]),JSON.stringify(shot.location_ids||[]),JSON.stringify(shot.object_ids||[]),
        shot.action||"",shot.body_movement||"",shot.expression||"",shot.emotion||"",shot.dialogue||"",shot.camera_angle||"",shot.camera_movement||"",shot.shot_size||"",
        shot.lighting||"",shot.composition||"",Number(shot.duration_seconds)||0,JSON.stringify(shot.continuity||{}),shot.status||"draft");
      for (const snapshot of scene.state_snapshots||[]) stateInsert.run(snapshot.snapshot_id,movieId,scene.scene_id,snapshot.character_id,Number(snapshot.version)||1,
        JSON.stringify(snapshot.state||{}),snapshot.approved?1:0);
    }
    movieDb.prepare("UPDATE movie_projects SET updated_at=CURRENT_TIMESTAMP WHERE movie_id=?").run(movieId);
    movieDb.exec("COMMIT");
  } catch (error) { movieDb.exec("ROLLBACK"); throw error; }
  return getMovieProject(movieId);
}
export function getMovieCharacter(id) { return characterRow(movieDb.prepare("SELECT * FROM movie_characters WHERE character_id=?").get(id)); }
export function createMovieProject(title) {
  const id = `MOV_${cryptoRandom()}`;
  movieDb.prepare("INSERT INTO movie_projects(movie_id,title) VALUES(?,?)").run(id, title);
  return getMovieProject(id);
}
export function addMovieCharacter(movieId, character) {
  if (!movieDb.prepare("SELECT 1 FROM movie_projects WHERE movie_id=?").get(movieId)) throw new Error("Movie not found");
  const duplicate = movieDb.prepare("SELECT character_id FROM movie_characters WHERE lower(trim(name))=lower(trim(?))").get(character.name);
  if (duplicate) throw new Error(`A character named ${character.name} already exists as ${duplicate.character_id}; select and reuse that record.`);
  const prior = movieDb.prepare("SELECT COALESCE(MAX(CAST(substr(character_id,6) AS INTEGER)),0)+1 n FROM movie_characters").get().n;
  const id = `CHAR_${String(prior).padStart(3, "0")}`;
  const identity = JSON.stringify(character.identity);
  movieDb.prepare(`INSERT INTO movie_characters(character_id,movie_id,name,identity_json,personality,background,voice_profile,relationships_json,description)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(id,movieId,character.name,identity,character.personality,character.background,character.voice_profile,JSON.stringify(character.relationships),character.description);
  movieDb.prepare("INSERT INTO movie_identity_versions(character_id,version,identity_json) VALUES(?,1,?)").run(id, identity);
  return characterRow(movieDb.prepare("SELECT * FROM movie_characters WHERE character_id=?").get(id));
}
export function updateMovieCharacter(id, character, createVersion = false) {
  const row = movieDb.prepare("SELECT * FROM movie_characters WHERE character_id=?").get(id);
  if (!row) throw new Error("Character not found");
  const identity = JSON.stringify(character.identity);
  const changed = identity !== row.identity_json;
  if (changed && createVersion !== true) throw new Error("Core visual identity changes must create a new identity version for review");
  let version = row.identity_version;
  if (changed && createVersion) {
    version += 1;
    movieDb.prepare("INSERT INTO movie_identity_versions(character_id,version,identity_json) VALUES(?,?,?)").run(id,version,identity);
  }
  movieDb.prepare(`UPDATE movie_characters SET name=?,identity_json=?,personality=?,background=?,voice_profile=?,relationships_json=?,description=?,
    identity_version=?,approval_status=?,identity_locked=?,canonical_reference_id=?,updated_at=CURRENT_TIMESTAMP WHERE character_id=?`).run(
      character.name,identity,character.personality,character.background,character.voice_profile,JSON.stringify(character.relationships),character.description,
      version, changed ? "draft" : row.approval_status, changed ? 0 : row.identity_locked, changed ? null : row.canonical_reference_id,id);
  return characterRow(movieDb.prepare("SELECT * FROM movie_characters WHERE character_id=?").get(id));
}
export function setCharacterApproval(id, status) {
  const existing = movieDb.prepare("SELECT * FROM movie_characters WHERE character_id=?").get(id);
  if (!existing) throw new Error("Character not found");
  if (status === "approved") {
    if (!existing.canonical_reference_id || !movieDb.prepare("SELECT 1 FROM movie_character_references WHERE reference_id=? AND status='approved' AND identity_version=?").get(existing.canonical_reference_id,existing.identity_version)) throw new Error("Select an approved canonical reference for the current identity version before locking identity");
    const version = movieDb.prepare("SELECT version FROM movie_identity_versions WHERE character_id=? ORDER BY version DESC LIMIT 1").get(id);
    movieDb.prepare("UPDATE movie_identity_versions SET status=CASE WHEN version=? THEN 'approved' ELSE status END WHERE character_id=?").run(version?.version ?? 1,id);
  }
  movieDb.prepare("UPDATE movie_characters SET approval_status=?, identity_locked=?, updated_at=CURRENT_TIMESTAMP WHERE character_id=?").run(status,status === "approved" ? 1 : 0,id);
  return characterRow(movieDb.prepare("SELECT * FROM movie_characters WHERE character_id=?").get(id));
}
export function addCharacterReference(id, view, filePath) {
  const refId = `MREF_${cryptoRandom()}`;
  const version = movieDb.prepare("SELECT identity_version FROM movie_characters WHERE character_id=?").get(id)?.identity_version;
  if (!version) throw new Error("Character not found");
  movieDb.prepare("INSERT INTO movie_character_references(reference_id,character_id,identity_version,view,file_path) VALUES(?,?,?,?,?)").run(refId,id,version,view,filePath);
  return movieDb.prepare("SELECT * FROM movie_character_references WHERE reference_id=?").get(refId);
}
export function importMovieCharacterReference(id, view, filePath, boardId, assetId) {
  const refId = `MREF_${cryptoRandom()}`;
  const version = movieDb.prepare("SELECT identity_version FROM movie_characters WHERE character_id=?").get(id)?.identity_version;
  if (!version) throw new Error("Character not found");
  const exists = movieDb.prepare("SELECT reference_id FROM movie_character_references WHERE character_id=? AND identity_version=? AND source_board_id=? AND source_asset_id=?").get(id,version,boardId,assetId);
  if (exists) return movieDb.prepare("SELECT * FROM movie_character_references WHERE reference_id=?").get(exists.reference_id);
  movieDb.prepare(`INSERT INTO movie_character_references(reference_id,character_id,identity_version,view,file_path,source_board_id,source_asset_id,status)
    VALUES(?,?,?,?,?,?,?,'approved')`).run(refId,id,version,view,filePath,boardId,assetId);
  return movieDb.prepare("SELECT * FROM movie_character_references WHERE reference_id=?").get(refId);
}
export function reviewCharacterReference(refId, status) {
  const ref = movieDb.prepare("SELECT * FROM movie_character_references WHERE reference_id=?").get(refId);
  if (!ref) throw new Error("Reference not found");
  movieDb.prepare("UPDATE movie_character_references SET status=? WHERE reference_id=?").run(status,refId);
  if (status === "approved") movieDb.prepare("UPDATE movie_characters SET approval_status='review', identity_locked=0 WHERE character_id=?").run(ref.character_id);
  return movieDb.prepare("SELECT * FROM movie_character_references WHERE reference_id=?").get(refId);
}
export function setCanonicalReference(id, refId) {
  const ref = movieDb.prepare(`SELECT r.* FROM movie_character_references r JOIN movie_characters c USING(character_id)
    WHERE r.reference_id=? AND r.character_id=? AND r.status='approved' AND r.identity_version=c.identity_version`).get(refId,id);
  if (!ref) throw new Error("Canonical reference must be an approved image belonging to this character");
  movieDb.prepare("UPDATE movie_characters SET canonical_reference_id=?, approval_status='approved', identity_locked=1, updated_at=CURRENT_TIMESTAMP WHERE character_id=?").run(refId,id);
  movieDb.prepare("UPDATE movie_identity_versions SET status='approved' WHERE character_id=? AND version=(SELECT identity_version FROM movie_characters WHERE character_id=?)").run(id,id);
  return characterRow(movieDb.prepare("SELECT * FROM movie_characters WHERE character_id=?").get(id));
}
export function addMovieCostume(id, data) {
  const costumeId = `COST_${cryptoRandom()}`;
  movieDb.prepare(`INSERT INTO movie_costumes(costume_id,character_id,name,description,color,fabric,accessories,reference_path)
    VALUES(?,?,?,?,?,?,?,?)`).run(costumeId,id,data.name,data.description ?? "",data.color ?? "",data.fabric ?? "",data.accessories ?? "",data.reference_path ?? null);
  return movieDb.prepare("SELECT * FROM movie_costumes WHERE costume_id=?").get(costumeId);
}
export function reviewCostume(id, status) {
  if (status === "approved") {
    const row = movieDb.prepare("SELECT reference_path FROM movie_costumes WHERE costume_id=?").get(id);
    if (!row?.reference_path) throw new Error("Costume approval requires its reference image");
  }
  movieDb.prepare("UPDATE movie_costumes SET approval_status=? WHERE costume_id=?").run(status,id);
  return movieDb.prepare("SELECT * FROM movie_costumes WHERE costume_id=?").get(id);
}
function environmentAssetRow(row) {
  if (!row) return null;
  return { ...row, aliases: JSON.parse(row.aliases_json), identity_locked: !!row.identity_locked };
}
export function listMovieEnvironmentAssets(movieId) {
  return movieDb.prepare("SELECT * FROM movie_environment_assets WHERE movie_id=? ORDER BY kind,name").all(movieId).map(environmentAssetRow);
}
export function addMovieEnvironmentAsset(movieId, { kind, name, description = "", aliases = [] }) {
  if (!movieDb.prepare("SELECT 1 FROM movie_projects WHERE movie_id=?").get(movieId)) throw new Error("Movie not found");
  if (!new Set(["location", "object"]).has(kind)) throw new Error("Environment asset kind must be location or object");
  const cleanName = String(name || "").trim();
  if (!cleanName) throw new Error("Location or object name is required");
  const duplicate = movieDb.prepare("SELECT asset_id FROM movie_environment_assets WHERE movie_id=? AND kind=? AND lower(trim(name))=lower(trim(?))").get(movieId,kind,cleanName);
  if (duplicate) throw new Error(`A ${kind} named ${cleanName} already exists as ${duplicate.asset_id}`);
  const asset_id = `${kind === "location" ? "LOC" : "OBJ"}_${cryptoRandom()}`;
  const cleanAliases = Array.isArray(aliases) ? [...new Set(aliases.map((value) => String(value).trim()).filter(Boolean))] : [];
  movieDb.prepare(`INSERT INTO movie_environment_assets(asset_id,movie_id,kind,name,description,aliases_json)
    VALUES(?,?,?,?,?,?)`).run(asset_id,movieId,kind,cleanName,String(description || "").trim(),JSON.stringify(cleanAliases));
  return environmentAssetRow(movieDb.prepare("SELECT * FROM movie_environment_assets WHERE asset_id=?").get(asset_id));
}
export function updateMovieEnvironmentAsset(id, { name, description = "", aliases = [] }) {
  const row = movieDb.prepare("SELECT * FROM movie_environment_assets WHERE asset_id=?").get(id);
  if (!row) throw new Error("Location or object not found");
  if (row.identity_locked) throw new Error("Unlock this location or object before editing its visual identity");
  const cleanName = String(name || "").trim();
  if (!cleanName) throw new Error("Location or object name is required");
  const duplicate = movieDb.prepare("SELECT asset_id FROM movie_environment_assets WHERE movie_id=? AND kind=? AND lower(trim(name))=lower(trim(?)) AND asset_id<>?").get(row.movie_id,row.kind,cleanName,id);
  if (duplicate) throw new Error(`A ${row.kind} named ${cleanName} already exists as ${duplicate.asset_id}`);
  const cleanAliases = Array.isArray(aliases) ? [...new Set(aliases.map((value) => String(value).trim()).filter(Boolean))] : [];
  const changed = cleanName !== row.name || String(description || "").trim() !== row.description || JSON.stringify(cleanAliases) !== row.aliases_json;
  movieDb.prepare(`UPDATE movie_environment_assets SET name=?,description=?,aliases_json=?,identity_version=identity_version+?,
    reference_path=CASE WHEN ? THEN NULL ELSE reference_path END,reference_status=CASE WHEN ? THEN 'missing' ELSE reference_status END,
    approval_status=CASE WHEN ? THEN 'draft' ELSE approval_status END,updated_at=CURRENT_TIMESTAMP WHERE asset_id=?`)
    .run(cleanName,String(description || "").trim(),JSON.stringify(cleanAliases),changed?1:0,changed?1:0,changed?1:0,changed?1:0,id);
  return environmentAssetRow(movieDb.prepare("SELECT * FROM movie_environment_assets WHERE asset_id=?").get(id));
}
export function setMovieEnvironmentReference(id, filePath) {
  const row = movieDb.prepare("SELECT * FROM movie_environment_assets WHERE asset_id=?").get(id);
  if (!row) throw new Error("Location or object not found");
  if (row.identity_locked) throw new Error("Unlock this location or object before replacing its reference image");
  movieDb.prepare("UPDATE movie_environment_assets SET reference_path=?,reference_status='review',approval_status='review',updated_at=CURRENT_TIMESTAMP WHERE asset_id=?").run(filePath,id);
  return environmentAssetRow(movieDb.prepare("SELECT * FROM movie_environment_assets WHERE asset_id=?").get(id));
}
export function reviewMovieEnvironmentReference(id, status) {
  if (!new Set(["approved","rejected"]).has(status)) throw new Error("Invalid reference status");
  const row = movieDb.prepare("SELECT reference_path FROM movie_environment_assets WHERE asset_id=?").get(id);
  if (!row?.reference_path) throw new Error("Upload a location or object reference image first");
  movieDb.prepare("UPDATE movie_environment_assets SET reference_status=?,approval_status='review',identity_locked=0,updated_at=CURRENT_TIMESTAMP WHERE asset_id=?").run(status,id);
  return environmentAssetRow(movieDb.prepare("SELECT * FROM movie_environment_assets WHERE asset_id=?").get(id));
}
export function setMovieEnvironmentLock(id, locked) {
  const row = movieDb.prepare("SELECT * FROM movie_environment_assets WHERE asset_id=?").get(id);
  if (!row) throw new Error("Location or object not found");
  if (locked && row.reference_status !== "approved") throw new Error("Approve a canonical location or object reference before locking it");
  movieDb.prepare("UPDATE movie_environment_assets SET identity_locked=?,approval_status=?,updated_at=CURRENT_TIMESTAMP WHERE asset_id=?")
    .run(locked?1:0,locked?"approved":"draft",id);
  return environmentAssetRow(movieDb.prepare("SELECT * FROM movie_environment_assets WHERE asset_id=?").get(id));
}
export function createMovieJob({ movie_id, shot_id, kind, prompt, workflow, model }) {
  const job_id = `MJOB_${cryptoRandom()}`;
  movieDb.prepare(`INSERT INTO movie_generation_jobs(job_id,movie_id,shot_id,kind,status,prompt,workflow,model)
    VALUES(?,?,?,?,'queued',?,?,?)`).run(job_id,movie_id,shot_id,kind,prompt,workflow,model);
  return movieDb.prepare("SELECT * FROM movie_generation_jobs WHERE job_id=?").get(job_id);
}
export function updateMovieJob(jobId, { status, error = null, asset_path = null }) {
  movieDb.prepare(`UPDATE movie_generation_jobs SET status=?,error=?,asset_path=COALESCE(?,asset_path),updated_at=CURRENT_TIMESTAMP WHERE job_id=?`)
    .run(status,error,asset_path,jobId);
  return movieDb.prepare("SELECT * FROM movie_generation_jobs WHERE job_id=?").get(jobId);
}
export function addMovieShotAsset({ shot_id, job_id, kind, version, file_path, prompt, workflow, model }) {
  const asset_id = `MASS_${cryptoRandom()}`;
  movieDb.prepare(`INSERT INTO movie_shot_assets(asset_id,shot_id,job_id,kind,version,file_path,prompt,workflow,model,status)
    VALUES(?,?,?,?,?,?,?,?,?,'review')`).run(asset_id,shot_id,job_id,kind,version,file_path,prompt,workflow,model);
  return movieDb.prepare("SELECT * FROM movie_shot_assets WHERE asset_id=?").get(asset_id);
}
export function listMovieJobs(movieId) {
  return {
    jobs: movieDb.prepare("SELECT * FROM movie_generation_jobs WHERE movie_id=? ORDER BY created_at DESC").all(movieId),
    assets: movieDb.prepare(`SELECT a.* FROM movie_shot_assets a JOIN movie_shots s USING(shot_id) JOIN movie_scenes c USING(scene_id)
      WHERE c.movie_id=? ORDER BY a.created_at DESC`).all(movieId),
  };
}
export function getMovieShotAsset(assetId) { return movieDb.prepare("SELECT * FROM movie_shot_assets WHERE asset_id=?").get(assetId); }
export function deleteMovieShotAsset(assetId) {
  const asset = getMovieShotAsset(assetId);
  if (!asset) return null;
  movieDb.prepare("DELETE FROM movie_shot_assets WHERE asset_id=?").run(assetId);
  return asset;
}
export function reviewMovieShotAsset(assetId, status) {
  if (!new Set(["approved","rejected"]).has(status)) throw new Error("Invalid review status");
  movieDb.prepare("UPDATE movie_shot_assets SET status=? WHERE asset_id=?").run(status,assetId);
  return getMovieShotAsset(assetId);
}
function cryptoRandom() { return crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase(); }
