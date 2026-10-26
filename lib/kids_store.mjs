// Sanskriti Kids Studio — data-access layer (Postgres `Sanskriti_kids` +
// SQLite fallback). Imported by frontend/server.mjs.
//
// Every function takes the resolved store ("pg" | "sqlite") so the caller
// decides which backend answers. The two branches are explicit on purpose:
// the pg columns are TYPED (JSONB, BOOLEAN, INTEGER) while SQLite stores
// JSON as TEXT and booleans as 0/1 — passing the wrong shape to either
// backend fails differently, so the split is never "shared".

import {
  normalizeKidsDirectorPlan,
  kidsDashboardMetrics,
  KIDS_OPTION_KEYS,
} from "./kids.mjs";

// Row -> API shape. PG returns JSONB as objects and BOOLEAN as true/false;
// SQLite returns JSON as TEXT and BOOLEAN as 0/1.
export function kidsProjectRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    title: r.title ?? "",
    description: r.description ?? "",
    language: r.language ?? "Hindi",
    category: r.category ?? "",
    age_group: r.age_group ?? "",
    duration_seconds: Number(r.duration_seconds ?? 60),
    aspect_ratio: r.aspect_ratio ?? "16:9",
    resolution: r.resolution ?? "1280x720",
    visual_style: r.visual_style ?? "",
    narration_preferences: r.narration_preferences ?? "",
    music_preferences: r.music_preferences ?? "",
    target_platform: r.target_platform ?? "",
    lyrics: r.lyrics ?? "",
    script: r.script ?? "",
    audio_path: r.audio_path ?? "",
    reference_images: (Array.isArray(r.reference_images) ? r.reference_images : safeJson(r.reference_images, [])) || [],
    status: r.status ?? "draft",
    board_id: r.board_id ?? null,
    scenario_name: r.scenario_name ?? null,
    metadata: (r.metadata && typeof r.metadata === "object") ? r.metadata : safeJson(r.metadata, {}),
    created_at: r.created_at ?? null,
    updated_at: r.updated_at ?? null,
  };
}

function safeJson(v, fb) {
  if (v == null) return fb;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return fb; }
}

export function kidsPlanRow(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    project_id: r.project_id,
    version: Number(r.version ?? 1),
    status: r.status ?? "draft",
    plan: normalizeKidsDirectorPlan(safeJson(r.plan, {})),
    note: r.note ?? "",
    approved_at: r.approved_at ?? null,
    created_at: r.created_at ?? null,
    updated_at: r.updated_at ?? null,
  };
}

export function kidsSceneRow(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    project_id: r.project_id,
    scene_number: Number(r.scene_number ?? 0),
    title: r.title ?? "",
    synopsis: r.synopsis ?? "",
    duration_seconds: Number(r.duration_seconds ?? 0),
    camera: r.camera ?? "",
    transition: r.transition ?? "",
    prompt: r.prompt ?? "",
    status: r.status ?? "planned",
    created_at: r.created_at ?? null,
    updated_at: r.updated_at ?? null,
  };
}

export function kidsCharacterRow(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    project_id: r.project_id,
    character_id: r.character_id ?? "",
    name: r.name ?? "",
    role: r.role ?? "",
    species: r.species ?? "",
    description: r.description ?? "",
    visual_identity_prompt: r.visual_identity_prompt ?? "",
    created_at: r.created_at ?? null,
    updated_at: r.updated_at ?? null,
  };
}

export function kidsAssetRow(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    project_id: r.project_id,
    kind: r.kind ?? "",
    scene_number: r.scene_number == null ? null : Number(r.scene_number),
    file_path: r.file_path ?? "",
    prompt: r.prompt ?? "",
    status: r.status ?? "PENDING",
    created_at: r.created_at ?? null,
    updated_at: r.updated_at ?? null,
  };
}

export function kidsJobRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    project_id: r.project_id ?? null,
    kind: r.kind ?? "",
    status: r.status ?? "PENDING",
    error_message: r.error_message ?? null,
    metadata: safeJson(r.metadata, {}),
    created_at: r.created_at ?? null,
    updated_at: r.updated_at ?? null,
  };
}

// --------------------------------------------------------------- options
// The configurable option lists (age groups, categories, languages,
// platforms, resolutions, visual styles). Served from the table so the UI
// renders what the user configured — never a hardcoded list.
export async function kidsOptions(store, db) {
  const out = {};
  for (const key of KIDS_OPTION_KEYS) out[key] = [];
  if (store === "pg") {
    const r = await db.query(
      "SELECT option_key, option_value FROM kids_options ORDER BY option_key, sort_order, option_value");
    for (const row of r.rows) {
      if (!out[row.option_key]) out[row.option_key] = [];
      out[row.option_key].push(row.option_value);
    }
  } else {
    const rows = db.prepare(
      "SELECT option_key, option_value FROM kids_options ORDER BY option_key, sort_order, option_value").all();
    for (const row of rows) {
      if (!out[row.option_key]) out[row.option_key] = [];
      out[row.option_key].push(row.option_value);
    }
  }
  return out;
}

// Replace one option list wholesale (the UI edits a list and saves it).
export async function kidsSetOptions(store, db, key, values) {
  const list = Array.isArray(values) ? values.map((v) => String(v).trim()).filter(Boolean) : [];
  if (store === "pg") {
    await db.query("DELETE FROM kids_options WHERE option_key = $1", [key]);
    let order = 0;
    for (const value of list) {
      await db.query(
        "INSERT INTO kids_options (option_key, option_value, sort_order) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [key, value, order++]);
    }
  } else {
    db.prepare("DELETE FROM kids_options WHERE option_key = ?").run(key);
    const ins = db.prepare(
      "INSERT INTO kids_options (option_key, option_value, sort_order) VALUES (?, ?, ?) ON CONFLICT DO NOTHING");
    let order = 0;
    for (const value of list) ins.run(key, value, order++);
  }
  return list;
}

// --------------------------------------------------------------- projects
export async function kidsListProjects(store, db) {
  if (store === "pg") {
    const r = await db.query("SELECT * FROM kids_projects ORDER BY updated_at DESC");
    return r.rows.map(kidsProjectRow);
  }
  return db.prepare("SELECT * FROM kids_projects ORDER BY updated_at DESC").all().map(kidsProjectRow);
}

export async function kidsGetProject(store, db, id) {
  if (store === "pg") {
    const r = await db.query("SELECT * FROM kids_projects WHERE id = $1", [id]);
    return kidsProjectRow(r.rows[0]);
  }
  return kidsProjectRow(db.prepare("SELECT * FROM kids_projects WHERE id = ?").get(id));
}

export async function kidsProjectNameExists(store, db, name, exceptId = null) {
  if (store === "pg") {
    const r = await db.query(
      "SELECT 1 FROM kids_projects WHERE name = $1 AND ($2::text IS NULL OR id <> $2) LIMIT 1",
      [name, exceptId]);
    return r.rowCount > 0;
  }
  const row = exceptId
    ? db.prepare("SELECT 1 FROM kids_projects WHERE name = ? AND id <> ?").get(name, exceptId)
    : db.prepare("SELECT 1 FROM kids_projects WHERE name = ?").get(name);
  return !!row;
}

export async function kidsInsertProject(store, db, row) {
  if (store === "pg") {
    const r = await db.query(
      `INSERT INTO kids_projects (
         id, name, title, description, language, category, age_group, duration_seconds,
         aspect_ratio, resolution, visual_style, narration_preferences, music_preferences,
         target_platform, lyrics, script, audio_path, reference_images, status, board_id,
         scenario_name, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20,$21,$22::jsonb)
       RETURNING *`,
      [row.id, row.name, row.title, row.description, row.language, row.category, row.age_group,
        row.duration_seconds, row.aspect_ratio, row.resolution, row.visual_style,
        row.narration_preferences, row.music_preferences, row.target_platform, row.lyrics,
        row.script, row.audio_path, JSON.stringify(row.reference_images || []), row.status,
        row.board_id, row.scenario_name, JSON.stringify(row.metadata || {})]);
    return kidsProjectRow(r.rows[0]);
  }
  db.prepare(
    `INSERT INTO kids_projects (
       id, name, title, description, language, category, age_group, duration_seconds,
       aspect_ratio, resolution, visual_style, narration_preferences, music_preferences,
       target_platform, lyrics, script, audio_path, reference_images, status, board_id,
       scenario_name, metadata
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(row.id, row.name, row.title, row.description, row.language, row.category, row.age_group,
    row.duration_seconds, row.aspect_ratio, row.resolution, row.visual_style,
    row.narration_preferences, row.music_preferences, row.target_platform, row.lyrics,
    row.script, row.audio_path, JSON.stringify(row.reference_images || []), row.status,
    row.board_id, row.scenario_name, JSON.stringify(row.metadata || {}));
  return kidsProjectRow(db.prepare("SELECT * FROM kids_projects WHERE id = ?").get(row.id));
}

export async function kidsUpdateProject(store, db, id, patch) {
  const fields = [
    "title", "description", "language", "category", "age_group", "duration_seconds",
    "aspect_ratio", "resolution", "visual_style", "narration_preferences",
    "music_preferences", "target_platform", "lyrics", "script", "audio_path", "status",
    "board_id", "scenario_name",
  ];
  const sets = [];
  const values = [];
  for (const f of fields) {
    if (!(f in patch)) continue;
    sets.push(`${f} = $${values.length + 1}`);
    values.push(patch[f]);
  }
  if ("reference_images" in patch) {
    sets.push(`reference_images = $${values.length + 1}::jsonb`);
    values.push(JSON.stringify(patch.reference_images || []));
  }
  if ("metadata" in patch) {
    sets.push(`metadata = $${values.length + 1}::jsonb`);
    values.push(JSON.stringify(patch.metadata || {}));
  }
  if (!sets.length) return kidsGetProject(store, db, id);
  if (store === "pg") {
    values.push(id);
    const r = await db.query(
      `UPDATE kids_projects SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
      values);
    return kidsProjectRow(r.rows[0]);
  }
  values.push(id);
  db.prepare(
    `UPDATE kids_projects SET ${sets.map((s) => s.replace(/\$\d+::jsonb/, "?")).join(", ")}, updated_at = ? WHERE id = ?`,
  ).run(...values, new Date().toISOString(), id);
  return kidsGetProject(store, db, id);
}

export async function kidsDeleteProject(store, db, id) {
  if (store === "pg") {
    const r = await db.query("DELETE FROM kids_projects WHERE id = $1", [id]);
    return r.rowCount;
  }
  // SQLite has no FK enforcement — delete the children explicitly.
  for (const t of [
    "kids_director_plans", "kids_scenes", "kids_characters", "kids_assets", "kids_jobs",
    "kids_story_versions", "kids_lyric_sections", "kids_audio_segments", "kids_qc_runs",
    "kids_exports", "kids_feedback", "kids_library_assets", "kids_timeline_rows",
  ]) {
    db.prepare(`DELETE FROM ${t} WHERE project_id = ?`).run(id);
  }
  const r = db.prepare("DELETE FROM kids_projects WHERE id = ?").run(id);
  return r.changes;
}

// --------------------------------------------------------------- plans
export async function kidsGetPlan(store, db, projectId) {
  if (store === "pg") {
    const r = await db.query(
      "SELECT * FROM kids_director_plans WHERE project_id = $1 ORDER BY version DESC LIMIT 1", [projectId]);
    return kidsPlanRow(r.rows[0]);
  }
  return kidsPlanRow(db.prepare(
    "SELECT * FROM kids_director_plans WHERE project_id = ? ORDER BY version DESC LIMIT 1").get(projectId));
}

export async function kidsListPlans(store, db, projectId) {
  if (store === "pg") {
    const r = await db.query(
      "SELECT * FROM kids_director_plans WHERE project_id = $1 ORDER BY version DESC", [projectId]);
    return r.rows.map(kidsPlanRow);
  }
  return db.prepare(
    "SELECT * FROM kids_director_plans WHERE project_id = ? ORDER BY version DESC").all(projectId).map(kidsPlanRow);
}

// Save a plan as a NEW version (never overwrite — the plan history is the
// audit trail). The version number is derived from the current max.
export async function kidsSavePlan(store, db, projectId, plan, { status = "draft", note = "" } = {}) {
  const current = await kidsGetPlan(store, db, projectId);
  const version = (current ? Number(current.version) : 0) + 1;
  const normalized = normalizeKidsDirectorPlan(plan);
  if (store === "pg") {
    const r = await db.query(
      `INSERT INTO kids_director_plans (project_id, version, status, plan, note, approved_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6)
       ON CONFLICT (project_id, version) DO UPDATE
         SET status = EXCLUDED.status, plan = EXCLUDED.plan, note = EXCLUDED.note,
             approved_at = EXCLUDED.approved_at, updated_at = NOW()
       RETURNING *`,
      [projectId, version, status, JSON.stringify(normalized), String(note || "").slice(0, 500),
        status === "approved" ? new Date().toISOString() : null]);
    return kidsPlanRow(r.rows[0]);
  }
  db.prepare(
    `INSERT INTO kids_director_plans (project_id, version, status, plan, note, approved_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT (project_id, version) DO UPDATE
       SET status = excluded.status, plan = excluded.plan, note = excluded.note,
           approved_at = excluded.approved_at, updated_at = ?`,
  ).run(projectId, version, status, JSON.stringify(normalized), String(note || "").slice(0, 500),
    status === "approved" ? new Date().toISOString() : null, new Date().toISOString());
  return kidsPlanRow(db.prepare(
    "SELECT * FROM kids_director_plans WHERE project_id = ? AND version = ?").get(projectId, version));
}

// Approve the current plan (marks it approved — it then locks against
// silent edits until it is explicitly unlocked).
export async function kidsApprovePlan(store, db, projectId, version) {
  const current = await kidsGetPlan(store, db, projectId);
  if (!current) return null;
  const target = version ? Number(version) : current.version;
  if (store === "pg") {
    const r = await db.query(
      `UPDATE kids_director_plans SET status='approved', approved_at=NOW(), updated_at=NOW()
       WHERE project_id = $1 AND version = $2 RETURNING *`, [projectId, target]);
    return kidsPlanRow(r.rows[0]);
  }
  db.prepare(
    "UPDATE kids_director_plans SET status='approved', approved_at=?, updated_at=? WHERE project_id = ? AND version = ?",
  ).run(new Date().toISOString(), new Date().toISOString(), projectId, target);
  return kidsPlanRow(db.prepare(
    "SELECT * FROM kids_director_plans WHERE project_id = ? AND version = ?").get(projectId, target));
}

// --------------------------------------------------------------- scenes
export async function kidsListScenes(store, db, projectId) {
  if (store === "pg") {
    const r = await db.query(
      "SELECT * FROM kids_scenes WHERE project_id = $1 ORDER BY scene_number", [projectId]);
    return r.rows.map(kidsSceneRow);
  }
  return db.prepare("SELECT * FROM kids_scenes WHERE project_id = ? ORDER BY scene_number")
    .all(projectId).map(kidsSceneRow);
}

// Replace the scene list for a project (the Director owns the scene plan;
// the studio mirrors it so the dashboard and the gallery read one source).
export async function kidsReplaceScenes(store, db, projectId, scenes) {
  if (store === "pg") {
    await db.query("DELETE FROM kids_scenes WHERE project_id = $1", [projectId]);
    for (const s of scenes) {
      await db.query(
        `INSERT INTO kids_scenes (project_id, scene_number, title, synopsis, duration_seconds, camera, transition, prompt, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (project_id, scene_number) DO UPDATE SET
           title = EXCLUDED.title, synopsis = EXCLUDED.synopsis,
           duration_seconds = EXCLUDED.duration_seconds, camera = EXCLUDED.camera,
           transition = EXCLUDED.transition, prompt = EXCLUDED.prompt,
           status = EXCLUDED.status, updated_at = NOW()`,
        [projectId, s.scene_number, s.title, s.synopsis, s.duration_seconds, s.camera,
          s.transition, s.prompt, s.status]);
    }
    return kidsListScenes(store, db, projectId);
  }
  db.prepare("DELETE FROM kids_scenes WHERE project_id = ?").run(projectId);
  const ins = db.prepare(
    `INSERT INTO kids_scenes (project_id, scene_number, title, synopsis, duration_seconds, camera, transition, prompt, status)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT (project_id, scene_number) DO UPDATE SET
       title = excluded.title, synopsis = excluded.synopsis,
       duration_seconds = excluded.duration_seconds, camera = excluded.camera,
       transition = excluded.transition, prompt = excluded.prompt,
       status = excluded.status, updated_at = ?`);
  const now = new Date().toISOString();
  for (const s of scenes) {
    ins.run(projectId, s.scene_number, s.title, s.synopsis, s.duration_seconds, s.camera,
      s.transition, s.prompt, s.status, now);
  }
  return kidsListScenes(store, db, projectId);
}

// --------------------------------------------------------------- characters
export async function kidsListCharacters(store, db, projectId) {
  if (store === "pg") {
    const r = await db.query(
      "SELECT * FROM kids_characters WHERE project_id = $1 ORDER BY name", [projectId]);
    return r.rows.map(kidsCharacterRow);
  }
  return db.prepare("SELECT * FROM kids_characters WHERE project_id = ? ORDER BY name")
    .all(projectId).map(kidsCharacterRow);
}

export async function kidsReplaceCharacters(store, db, projectId, characters) {
  if (store === "pg") {
    await db.query("DELETE FROM kids_characters WHERE project_id = $1", [projectId]);
    for (const c of characters) {
      await db.query(
        `INSERT INTO kids_characters (project_id, character_id, name, role, species, description, visual_identity_prompt)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (project_id, character_id) DO UPDATE SET
           name = EXCLUDED.name, role = EXCLUDED.role, species = EXCLUDED.species,
           description = EXCLUDED.description,
           visual_identity_prompt = EXCLUDED.visual_identity_prompt, updated_at = NOW()`,
        [projectId, c.character_id, c.name, c.role, c.species, c.description, c.visual_identity_prompt]);
    }
    return kidsListCharacters(store, db, projectId);
  }
  db.prepare("DELETE FROM kids_characters WHERE project_id = ?").run(projectId);
  const ins = db.prepare(
    `INSERT INTO kids_characters (project_id, character_id, name, role, species, description, visual_identity_prompt)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT (project_id, character_id) DO UPDATE SET
       name = excluded.name, role = excluded.role, species = excluded.species,
       description = excluded.description,
       visual_identity_prompt = excluded.visual_identity_prompt, updated_at = ?`);
  const now = new Date().toISOString();
  for (const c of characters) {
    ins.run(projectId, c.character_id, c.name, c.role, c.species, c.description,
      c.visual_identity_prompt, now);
  }
  return kidsListCharacters(store, db, projectId);
}

// --------------------------------------------------------------- assets
export async function kidsListAssets(store, db, projectId) {
  if (store === "pg") {
    const r = await db.query(
      "SELECT * FROM kids_assets WHERE project_id = $1 ORDER BY id", [projectId]);
    return r.rows.map(kidsAssetRow);
  }
  return db.prepare("SELECT * FROM kids_assets WHERE project_id = ? ORDER BY id")
    .all(projectId).map(kidsAssetRow);
}

export async function kidsAllAssets(store, db) {
  if (store === "pg") {
    const r = await db.query("SELECT * FROM kids_assets");
    return r.rows.map(kidsAssetRow);
  }
  return db.prepare("SELECT * FROM kids_assets").all().map(kidsAssetRow);
}

export async function kidsUpsertAsset(store, db, row) {
  if (store === "pg") {
    const r = await db.query(
      `INSERT INTO kids_assets (project_id, kind, scene_number, file_path, prompt, status)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [row.project_id, row.kind, row.scene_number, row.file_path, row.prompt, row.status]);
    return kidsAssetRow(r.rows[0]);
  }
  const r = db.prepare(
    "INSERT INTO kids_assets (project_id, kind, scene_number, file_path, prompt, status) VALUES (?,?,?,?,?,?)",
  ).run(row.project_id, row.kind, row.scene_number, row.file_path, row.prompt, row.status);
  return kidsAssetRow(db.prepare("SELECT * FROM kids_assets WHERE id = ?").get(r.lastInsertRowid));
}

// --------------------------------------------------------------- jobs
export async function kidsListJobs(store, db, projectId = null) {
  if (store === "pg") {
    const r = projectId
      ? await db.query("SELECT * FROM kids_jobs WHERE project_id = $1 ORDER BY created_at DESC", [projectId])
      : await db.query("SELECT * FROM kids_jobs ORDER BY created_at DESC LIMIT 100");
    return r.rows.map(kidsJobRow);
  }
  const rows = projectId
    ? db.prepare("SELECT * FROM kids_jobs WHERE project_id = ? ORDER BY created_at DESC").all(projectId)
    : db.prepare("SELECT * FROM kids_jobs ORDER BY created_at DESC LIMIT 100").all();
  return rows.map(kidsJobRow);
}

export async function kidsUpsertJob(store, db, job) {
  if (store === "pg") {
    const r = await db.query(
      `INSERT INTO kids_jobs (id, project_id, kind, status, error_message, metadata)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status, error_message = EXCLUDED.error_message,
         metadata = EXCLUDED.metadata, updated_at = NOW()
       RETURNING *`,
      [job.id, job.project_id, job.kind, job.status, job.error_message ?? null,
        JSON.stringify(job.metadata || {})]);
    return kidsJobRow(r.rows[0]);
  }
  db.prepare(
    `INSERT INTO kids_jobs (id, project_id, kind, status, error_message, metadata)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT (id) DO UPDATE SET
       status = excluded.status, error_message = excluded.error_message,
       metadata = excluded.metadata, updated_at = ?`,
  ).run(job.id, job.project_id, job.kind, job.status, job.error_message ?? null,
    JSON.stringify(job.metadata || {}), new Date().toISOString());
  return kidsJobRow(db.prepare("SELECT * FROM kids_jobs WHERE id = ?").get(job.id));
}

// --------------------------------------------------------------- dashboard
// Every metric comes from a live query — never a hardcoded number.
export async function kidsDashboard(store, db) {
  const projects = await kidsListProjects(store, db);
  const scenes = [];
  const characters = [];
  for (const p of projects) {
    scenes.push(...await kidsListScenes(store, db, p.id));
    characters.push(...await kidsListCharacters(store, db, p.id));
  }
  const assets = await kidsAllAssets(store, db);
  const jobs = await kidsListJobs(store, db);
  const metrics = kidsDashboardMetrics({ projects, scenes, characters, assets, jobs });
  const recent = projects.slice(0, 8).map((p) => ({
    id: p.id,
    name: p.name,
    title: p.title,
    status: p.status,
    category: p.category,
    age_group: p.age_group,
    language: p.language,
    duration_seconds: p.duration_seconds,
    board_id: p.board_id,
    scenario_name: p.scenario_name,
    updated_at: p.updated_at,
    created_at: p.created_at,
  }));
  // The raw arrays are returned too — the server recomputes the asset counts
  // from the real files on disk (the source of truth for generated media).
  return { metrics, recent, projects, scenes, characters, assets, jobs, store };
}

// =====================================================================
// Story Studio — versioned story documents
// =====================================================================

export function kidsStoryRow(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    project_id: r.project_id,
    version: Number(r.version ?? 1),
    status: r.status ?? "draft",
    story: safeJson(r.story, {}),
    note: r.note ?? "",
    approved_at: r.approved_at ?? null,
    created_at: r.created_at ?? null,
    updated_at: r.updated_at ?? null,
  };
}

export async function kidsGetStory(store, db, projectId) {
  if (store === "pg") {
    const r = await db.query(
      "SELECT * FROM kids_story_versions WHERE project_id = $1 ORDER BY version DESC LIMIT 1", [projectId]);
    return kidsStoryRow(r.rows[0]);
  }
  return kidsStoryRow(db.prepare(
    "SELECT * FROM kids_story_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1").get(projectId));
}

export async function kidsListStories(store, db, projectId) {
  if (store === "pg") {
    const r = await db.query(
      "SELECT * FROM kids_story_versions WHERE project_id = $1 ORDER BY version DESC", [projectId]);
    return r.rows.map(kidsStoryRow);
  }
  return db.prepare("SELECT * FROM kids_story_versions WHERE project_id = ? ORDER BY version DESC")
    .all(projectId).map(kidsStoryRow);
}

export async function kidsSaveStory(store, db, projectId, story, { status = "draft", note = "" } = {}) {
  const current = await kidsGetStory(store, db, projectId);
  const version = (current ? Number(current.version) : 0) + 1;
  const payload = JSON.stringify(story || {});
  if (store === "pg") {
    const r = await db.query(
      `INSERT INTO kids_story_versions (project_id, version, status, story, note, approved_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6)
       ON CONFLICT (project_id, version) DO UPDATE SET
         status = EXCLUDED.status, story = EXCLUDED.story, note = EXCLUDED.note,
         approved_at = EXCLUDED.approved_at, updated_at = NOW()
       RETURNING *`,
      [projectId, version, status, payload, String(note || "").slice(0, 500),
        status === "approved" ? new Date().toISOString() : null]);
    return kidsStoryRow(r.rows[0]);
  }
  db.prepare(
    `INSERT INTO kids_story_versions (project_id, version, status, story, note, approved_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT (project_id, version) DO UPDATE SET
       status = excluded.status, story = excluded.story, note = excluded.note,
       approved_at = excluded.approved_at, updated_at = ?`,
  ).run(projectId, version, status, payload, String(note || "").slice(0, 500),
    status === "approved" ? new Date().toISOString() : null, new Date().toISOString());
  return kidsStoryRow(db.prepare(
    "SELECT * FROM kids_story_versions WHERE project_id = ? AND version = ?").get(projectId, version));
}

export async function kidsApproveStory(store, db, projectId, version) {
  const current = await kidsGetStory(store, db, projectId);
  if (!current) return null;
  const target = version ? Number(version) : current.version;
  const now = new Date().toISOString();
  if (store === "pg") {
    const r = await db.query(
      `UPDATE kids_story_versions SET status='approved', approved_at=$3, updated_at=NOW()
       WHERE project_id = $1 AND version = $2 RETURNING *`, [projectId, target, now]);
    return kidsStoryRow(r.rows[0]);
  }
  db.prepare(
    "UPDATE kids_story_versions SET status='approved', approved_at=?, updated_at=? WHERE project_id = ? AND version = ?",
  ).run(now, now, projectId, target);
  return kidsStoryRow(db.prepare(
    "SELECT * FROM kids_story_versions WHERE project_id = ? AND version = ?").get(projectId, target));
}

// =====================================================================
// The reusable asset library (characters, locations, props)
// =====================================================================

export function kidsLibraryRow(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    scope: r.scope ?? "shared",
    project_id: r.project_id ?? null,
    kind: r.kind ?? "character",
    asset_key: r.asset_key ?? "",
    name: r.name ?? "",
    category: r.category ?? "",
    description: r.description ?? "",
    tags: (Array.isArray(r.tags) ? r.tags : safeJson(r.tags, [])) || [],
    prompt: r.prompt ?? "",
    reference_image: r.reference_image ?? "",
    appearance: r.appearance ?? "",
    clothing: r.clothing ?? "",
    colors: r.colors ?? "",
    personality: r.personality ?? "",
    voice: r.voice ?? "",
    movement: r.movement ?? "",
    age_appearance: r.age_appearance ?? "",
    version: Number(r.version ?? 1),
    status: r.status ?? "draft",
    locked: r.locked === true || Number(r.locked) === 1,
    metadata: (r.metadata && typeof r.metadata === "object") ? r.metadata : safeJson(r.metadata, {}),
    created_at: r.created_at ?? null,
    updated_at: r.updated_at ?? null,
  };
}

export async function kidsListLibrary(store, db, { scope = null, kind = null } = {}) {
  const where = [];
  const values = [];
  if (scope) { where.push(`scope = $${values.length + 1}`); values.push(scope); }
  if (kind) { where.push(`kind = $${values.length + 1}`); values.push(kind); }
  const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  if (store === "pg") {
    const r = await db.query(`SELECT * FROM kids_library_assets${clause} ORDER BY kind, name, id`, values);
    return r.rows.map(kidsLibraryRow);
  }
  const sql = `SELECT * FROM kids_library_assets${clause.replace(/\$\d+/g, "?")} ORDER BY kind, name, id`;
  return db.prepare(sql).all(...values).map(kidsLibraryRow);
}

export async function kidsGetLibraryAsset(store, db, id) {
  if (store === "pg") {
    const r = await db.query("SELECT * FROM kids_library_assets WHERE id = $1", [id]);
    return kidsLibraryRow(r.rows[0]);
  }
  return kidsLibraryRow(db.prepare("SELECT * FROM kids_library_assets WHERE id = ?").get(id));
}

export async function kidsInsertLibraryAsset(store, db, asset) {
  if (store === "pg") {
    const r = await db.query(
      `INSERT INTO kids_library_assets (
         scope, project_id, kind, asset_key, name, category, description, tags, prompt,
         reference_image, appearance, clothing, colors, personality, voice, movement,
         age_appearance, version, status, locked, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb)
       ON CONFLICT (scope, kind, asset_key) DO UPDATE SET
         name = EXCLUDED.name, category = EXCLUDED.category, description = EXCLUDED.description,
         tags = EXCLUDED.tags, prompt = EXCLUDED.prompt, reference_image = EXCLUDED.reference_image,
         appearance = EXCLUDED.appearance, clothing = EXCLUDED.clothing, colors = EXCLUDED.colors,
         personality = EXCLUDED.personality, voice = EXCLUDED.voice, movement = EXCLUDED.movement,
         age_appearance = EXCLUDED.age_appearance, version = EXCLUDED.version,
         status = EXCLUDED.status, locked = EXCLUDED.locked, metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING *`,
      [asset.scope || "shared", asset.project_id ?? null, asset.kind, asset.asset_key, asset.name,
        asset.category, asset.description, JSON.stringify(asset.tags || []), asset.prompt,
        asset.reference_image, asset.appearance, asset.clothing, asset.colors, asset.personality,
        asset.voice, asset.movement, asset.age_appearance, asset.version ?? 1, asset.status || "draft",
        asset.locked === true, JSON.stringify(asset.metadata || {})]);
    return kidsLibraryRow(r.rows[0]);
  }
  db.prepare(
    `INSERT INTO kids_library_assets (
       scope, project_id, kind, asset_key, name, category, description, tags, prompt,
       reference_image, appearance, clothing, colors, personality, voice, movement,
       age_appearance, version, status, locked, metadata
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (scope, kind, asset_key) DO UPDATE SET
       name = excluded.name, category = excluded.category, description = excluded.description,
       tags = excluded.tags, prompt = excluded.prompt, reference_image = excluded.reference_image,
       appearance = excluded.appearance, clothing = excluded.clothing, colors = excluded.colors,
       personality = excluded.personality, voice = excluded.voice, movement = excluded.movement,
       age_appearance = excluded.age_appearance, version = excluded.version,
       status = excluded.status, locked = excluded.locked, metadata = excluded.metadata,
       updated_at = ?`,
  ).run(asset.scope || "shared", asset.project_id ?? null, asset.kind, asset.asset_key, asset.name,
    asset.category, asset.description, JSON.stringify(asset.tags || []), asset.prompt,
    asset.reference_image, asset.appearance, asset.clothing, asset.colors, asset.personality,
    asset.voice, asset.movement, asset.age_appearance, asset.version ?? 1, asset.status || "draft",
    asset.locked === true ? 1 : 0, JSON.stringify(asset.metadata || {}), new Date().toISOString());
  return kidsLibraryRow(db.prepare(
    "SELECT * FROM kids_library_assets WHERE scope = ? AND kind = ? AND asset_key = ?")
    .get(asset.scope || "shared", asset.kind, asset.asset_key));
}

export async function kidsUpdateLibraryAsset(store, db, id, patch) {
  const fields = [
    "name", "category", "description", "prompt", "reference_image", "appearance",
    "clothing", "colors", "personality", "voice", "movement", "age_appearance",
    "version", "status",
  ];
  const sets = [];
  const values = [];
  for (const f of fields) {
    if (!(f in patch)) continue;
    sets.push(`${f} = $${values.length + 1}`);
    values.push(patch[f]);
  }
  if ("tags" in patch) {
    sets.push(`tags = $${values.length + 1}::jsonb`);
    values.push(JSON.stringify(patch.tags || []));
  }
  if ("metadata" in patch) {
    sets.push(`metadata = $${values.length + 1}::jsonb`);
    values.push(JSON.stringify(patch.metadata || {}));
  }
  if ("locked" in patch) {
    sets.push(`locked = $${values.length + 1}`);
    values.push(patch.locked === true);
  }
  if (!sets.length) return kidsGetLibraryAsset(store, db, id);
  if (store === "pg") {
    values.push(id);
    const r = await db.query(
      `UPDATE kids_library_assets SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
      values);
    return kidsLibraryRow(r.rows[0]);
  }
  // SQLite has no $N placeholders — every parameter becomes an anonymous "?"
  // and the values keep their order.
  const sqliteSets = sets.map((s) => s.replace(/\$\d+(::jsonb)?/g, "?"));
  // SQLite stores a boolean as 0/1 — the pg branch passes a real boolean.
  const sqliteValues = values.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v));
  db.prepare(
    `UPDATE kids_library_assets SET ${sqliteSets.join(", ")}, updated_at = ? WHERE id = ?`,
  ).run(...sqliteValues, new Date().toISOString(), id);
  return kidsGetLibraryAsset(store, db, id);
}

export async function kidsDeleteLibraryAsset(store, db, id) {
  if (store === "pg") {
    const r = await db.query("DELETE FROM kids_library_assets WHERE id = $1", [id]);
    return r.rowCount;
  }
  try { db.prepare("DELETE FROM kids_library_files WHERE asset_id = ?").run(id); } catch { /* table may be missing in an old file */ }
  return db.prepare("DELETE FROM kids_library_assets WHERE id = ?").run(id).changes;
}

// --------------------------------------------------------------- library files
// The generated reference stills of a library asset (one row per version).

export function kidsLibraryFileRow(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    asset_id: Number(r.asset_id),
    file_path: r.file_path ?? "",
    kind: r.kind ?? "image",
    prompt: r.prompt ?? "",
    workflow: r.workflow ?? "",
    model: r.model ?? "",
    status: r.status ?? "COMPLETED",
    created_at: r.created_at ?? null,
  };
}

export async function kidsListLibraryFiles(store, db, assetId) {
  if (store === "pg") {
    const r = await db.query(
      "SELECT * FROM kids_library_files WHERE asset_id = $1 ORDER BY id", [assetId]);
    return r.rows.map(kidsLibraryFileRow);
  }
  return db.prepare("SELECT * FROM kids_library_files WHERE asset_id = ? ORDER BY id")
    .all(assetId).map(kidsLibraryFileRow);
}

/** Every library file (one query — the library is small). */
export async function kidsListAllLibraryFiles(store, db) {
  if (store === "pg") {
    const r = await db.query("SELECT * FROM kids_library_files ORDER BY id");
    return r.rows.map(kidsLibraryFileRow);
  }
  try {
    return db.prepare("SELECT * FROM kids_library_files ORDER BY id").all().map(kidsLibraryFileRow);
  } catch { return []; }
}

export async function kidsInsertLibraryFile(store, db, row) {
  if (store === "pg") {
    const r = await db.query(
      `INSERT INTO kids_library_files (asset_id, file_path, kind, prompt, workflow, model, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [row.asset_id, row.file_path, row.kind || "image", row.prompt || "",
        row.workflow || "", row.model || "", row.status || "COMPLETED"]);
    return kidsLibraryFileRow(r.rows[0]);
  }
  const r = db.prepare(
    `INSERT INTO kids_library_files (asset_id, file_path, kind, prompt, workflow, model, status)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(row.asset_id, row.file_path, row.kind || "image", row.prompt || "",
    row.workflow || "", row.model || "", row.status || "COMPLETED");
  return kidsLibraryFileRow(db.prepare("SELECT * FROM kids_library_files WHERE id = ?").get(r.lastInsertRowid));
}

// =====================================================================
// Song & Lyrics Studio — the segmented lyric sheet
// =====================================================================

export function kidsLyricRow(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    project_id: r.project_id,
    seq: Number(r.seq ?? 0),
    label: r.label ?? "verse",
    lines: (Array.isArray(r.lines) ? r.lines : safeJson(r.lines, [])) || [],
    text: r.text ?? "",
    start_seconds: Number(r.start_seconds ?? 0),
    end_seconds: Number(r.end_seconds ?? 0),
    emotion: r.emotion ?? "",
    character_ids: (Array.isArray(r.character_ids) ? r.character_ids : safeJson(r.character_ids, [])) || [],
    choreography: r.choreography ?? "",
    lip_sync: r.lip_sync === true || Number(r.lip_sync) === 1,
    estimated: r.estimated === true || Number(r.estimated) === 1,
  };
}

export async function kidsListLyricSections(store, db, projectId) {
  if (store === "pg") {
    const r = await db.query(
      "SELECT * FROM kids_lyric_sections WHERE project_id = $1 ORDER BY seq, id", [projectId]);
    return r.rows.map(kidsLyricRow);
  }
  return db.prepare("SELECT * FROM kids_lyric_sections WHERE project_id = ? ORDER BY seq, id")
    .all(projectId).map(kidsLyricRow);
}

export async function kidsReplaceLyricSections(store, db, projectId, sections) {
  if (store === "pg") {
    await db.query("DELETE FROM kids_lyric_sections WHERE project_id = $1", [projectId]);
    for (const s of sections) {
      await db.query(
        `INSERT INTO kids_lyric_sections (project_id, seq, label, lines, text, start_seconds, end_seconds,
           emotion, character_ids, choreography, lip_sync, estimated)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)`,
        [projectId, s.seq ?? 0, s.label, JSON.stringify(s.lines || []), s.text,
          s.start_seconds, s.end_seconds, s.emotion, JSON.stringify(s.character_ids || []),
          s.choreography, s.lip_sync === true, s.estimated !== false]);
    }
    return kidsListLyricSections(store, db, projectId);
  }
  db.prepare("DELETE FROM kids_lyric_sections WHERE project_id = ?").run(projectId);
  const ins = db.prepare(
    `INSERT INTO kids_lyric_sections (project_id, seq, label, lines, text, start_seconds, end_seconds,
       emotion, character_ids, choreography, lip_sync, estimated)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const s of sections) {
    ins.run(projectId, s.seq ?? 0, s.label, JSON.stringify(s.lines || []), s.text,
      s.start_seconds, s.end_seconds, s.emotion, JSON.stringify(s.character_ids || []),
      s.choreography, s.lip_sync === true ? 1 : 0, s.estimated !== false ? 1 : 0);
  }
  return kidsListLyricSections(store, db, projectId);
}

// =====================================================================
// Audio analysis — the measured segment timeline
// =====================================================================

export function kidsAudioRow(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    project_id: r.project_id,
    seq: Number(r.seq ?? 0),
    start_seconds: Number(r.start_seconds ?? 0),
    end_seconds: Number(r.end_seconds ?? 0),
    duration_seconds: Number(r.duration_seconds ?? 0),
    type: r.type ?? "music",
    speaker: r.speaker ?? "",
    text: r.text ?? "",
    emotion: r.emotion ?? "",
    character: r.character ?? "",
    action: r.action ?? "",
    scene: r.scene ?? "",
    background: r.background ?? "",
    camera: r.camera ?? "",
    music_note: r.music_note ?? "",
    sound_effect: r.sound_effect ?? "",
    confidence: r.confidence == null ? null : Number(r.confidence),
    estimated: r.estimated === true || Number(r.estimated) === 1,
  };
}

export async function kidsListAudioSegments(store, db, projectId) {
  if (store === "pg") {
    const r = await db.query(
      "SELECT * FROM kids_audio_segments WHERE project_id = $1 ORDER BY seq, id", [projectId]);
    return r.rows.map(kidsAudioRow);
  }
  return db.prepare("SELECT * FROM kids_audio_segments WHERE project_id = ? ORDER BY seq, id")
    .all(projectId).map(kidsAudioRow);
}

export async function kidsReplaceAudioSegments(store, db, projectId, segments) {
  if (store === "pg") {
    await db.query("DELETE FROM kids_audio_segments WHERE project_id = $1", [projectId]);
    for (const s of segments) {
      await db.query(
        `INSERT INTO kids_audio_segments (project_id, seq, start_seconds, end_seconds, duration_seconds,
           type, speaker, text, emotion, character, action, scene, background, camera,
           music_note, sound_effect, confidence, estimated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [projectId, s.seq ?? 0, s.start_seconds, s.end_seconds, s.duration_seconds, s.type,
          s.speaker, s.text, s.emotion, s.character, s.action, s.scene, s.background, s.camera,
          s.music_note, s.sound_effect, s.confidence ?? null, s.estimated !== false]);
    }
    return kidsListAudioSegments(store, db, projectId);
  }
  db.prepare("DELETE FROM kids_audio_segments WHERE project_id = ?").run(projectId);
  const ins = db.prepare(
    `INSERT INTO kids_audio_segments (project_id, seq, start_seconds, end_seconds, duration_seconds,
       type, speaker, text, emotion, character, action, scene, background, camera,
       music_note, sound_effect, confidence, estimated)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const s of segments) {
    ins.run(projectId, s.seq ?? 0, s.start_seconds, s.end_seconds, s.duration_seconds, s.type,
      s.speaker, s.text, s.emotion, s.character, s.action, s.scene, s.background, s.camera,
      s.music_note, s.sound_effect, s.confidence ?? null, s.estimated !== false ? 1 : 0);
  }
  return kidsListAudioSegments(store, db, projectId);
}

// =====================================================================
// Quality control runs + exports + feedback
// =====================================================================

export async function kidsInsertQcRun(store, db, projectId, summary, checks) {
  if (store === "pg") {
    const r = await db.query(
      `INSERT INTO kids_qc_runs (project_id, summary, checks) VALUES ($1,$2::jsonb,$3::jsonb) RETURNING *`,
      [projectId, JSON.stringify(summary || {}), JSON.stringify(checks || [])]);
    return { id: Number(r.rows[0].id), summary, checks, created_at: r.rows[0].created_at };
  }
  const r = db.prepare(
    "INSERT INTO kids_qc_runs (project_id, summary, checks) VALUES (?,?,?)",
  ).run(projectId, JSON.stringify(summary || {}), JSON.stringify(checks || []));
  const row = db.prepare("SELECT * FROM kids_qc_runs WHERE id = ?").get(r.lastInsertRowid);
  return { id: Number(row.id), summary: safeJson(row.summary, {}), checks: safeJson(row.checks, []), created_at: row.created_at };
}

export async function kidsListQcRuns(store, db, projectId) {
  if (store === "pg") {
    const r = await db.query(
      "SELECT * FROM kids_qc_runs WHERE project_id = $1 ORDER BY created_at DESC, id DESC", [projectId]);
    return r.rows.map((row) => ({
      id: Number(row.id),
      summary: safeJson(row.summary, {}),
      checks: safeJson(row.checks, []),
      created_at: row.created_at,
    }));
  }
  return db.prepare("SELECT * FROM kids_qc_runs WHERE project_id = ? ORDER BY created_at DESC, id DESC")
    .all(projectId)
    .map((row) => ({
      id: Number(row.id),
      summary: safeJson(row.summary, {}),
      checks: safeJson(row.checks, []),
      created_at: row.created_at,
    }));
}

export async function kidsInsertExport(store, db, row) {
  if (store === "pg") {
    const r = await db.query(
      `INSERT INTO kids_exports (project_id, profile, status, file_path, duration_seconds, resolution, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [row.project_id, row.profile, row.status, row.file_path, row.duration_seconds, row.resolution, row.notes]);
    return r.rows[0];
  }
  const r = db.prepare(
    `INSERT INTO kids_exports (project_id, profile, status, file_path, duration_seconds, resolution, notes)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(row.project_id, row.profile, row.status, row.file_path, row.duration_seconds, row.resolution, row.notes);
  return db.prepare("SELECT * FROM kids_exports WHERE id = ?").get(r.lastInsertRowid);
}

export async function kidsListExports(store, db, projectId) {
  if (store === "pg") {
    const r = await db.query(
      "SELECT * FROM kids_exports WHERE project_id = $1 ORDER BY created_at DESC, id DESC", [projectId]);
    return r.rows.map((row) => ({
      id: Number(row.id),
      project_id: row.project_id,
      profile: row.profile,
      status: row.status,
      file_path: row.file_path,
      duration_seconds: Number(row.duration_seconds ?? 0),
      resolution: row.resolution,
      notes: row.notes,
      created_at: row.created_at,
    }));
  }
  return db.prepare("SELECT * FROM kids_exports WHERE project_id = ? ORDER BY created_at DESC, id DESC")
    .all(projectId)
    .map((row) => ({
      id: Number(row.id),
      project_id: row.project_id,
      profile: row.profile,
      status: row.status,
      file_path: row.file_path,
      duration_seconds: Number(row.duration_seconds ?? 0),
      resolution: row.resolution,
      notes: row.notes,
      created_at: row.created_at,
    }));
}

export async function kidsInsertFeedback(store, db, row) {
  if (store === "pg") {
    const r = await db.query(
      `INSERT INTO kids_feedback (id, project_id, target_kind, target_id, rating, verdict, note,
         corrected_text, use_for_training, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         rating = EXCLUDED.rating, verdict = EXCLUDED.verdict, note = EXCLUDED.note,
         corrected_text = EXCLUDED.corrected_text, use_for_training = EXCLUDED.use_for_training,
         payload = EXCLUDED.payload
       RETURNING *`,
      [row.id, row.project_id ?? null, row.target_kind, row.target_id, row.rating ?? null,
        row.verdict, row.note, row.corrected_text, row.use_for_training === true,
        JSON.stringify(row.payload || {})]);
    return r.rows[0];
  }
  db.prepare(
    `INSERT INTO kids_feedback (id, project_id, target_kind, target_id, rating, verdict, note,
       corrected_text, use_for_training, payload)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (id) DO UPDATE SET
       rating = excluded.rating, verdict = excluded.verdict, note = excluded.note,
       corrected_text = excluded.corrected_text, use_for_training = excluded.use_for_training,
       payload = excluded.payload`,
  ).run(row.id, row.project_id ?? null, row.target_kind, row.target_id, row.rating ?? null,
    row.verdict, row.note, row.corrected_text, row.use_for_training === true ? 1 : 0,
    JSON.stringify(row.payload || {}));
  return db.prepare("SELECT * FROM kids_feedback WHERE id = ?").get(row.id);
}

export async function kidsListFeedback(store, db, projectId = null) {
  const sql = projectId
    ? "SELECT * FROM kids_feedback WHERE project_id = $1 ORDER BY created_at DESC"
    : "SELECT * FROM kids_feedback ORDER BY created_at DESC LIMIT 200";
  const values = projectId ? [projectId] : [];
  const rows = store === "pg"
    ? (await db.query(sql, values)).rows
    : db.prepare(sql.replace(/\$(\d+)/g, "?")).all(...values);
  return rows.map((row) => ({
    id: row.id,
    project_id: row.project_id ?? null,
    target_kind: row.target_kind,
    target_id: row.target_id,
    rating: row.rating == null ? null : Number(row.rating),
    verdict: row.verdict,
    note: row.note,
    corrected_text: row.corrected_text,
    use_for_training: row.use_for_training === true || Number(row.use_for_training) === 1,
    payload: safeJson(row.payload, {}),
    created_at: row.created_at ?? null,
  }));
}

// =====================================================================
// The editable scene timeline (the storyboard the studio ships)
// =====================================================================

export async function kidsListTimeline(store, db, projectId) {
  if (store === "pg") {
    const r = await db.query(
      "SELECT * FROM kids_timeline_rows WHERE project_id = $1 ORDER BY scene_number", [projectId]);
    return r.rows.map((row) => ({
      id: Number(row.id),
      project_id: row.project_id,
      scene_number: Number(row.scene_number),
      payload: safeJson(row.payload, {}),
      created_at: row.created_at ?? null,
      updated_at: row.updated_at ?? null,
    }));
  }
  return db.prepare("SELECT * FROM kids_timeline_rows WHERE project_id = ? ORDER BY scene_number")
    .all(projectId)
    .map((row) => ({
      id: Number(row.id),
      project_id: row.project_id,
      scene_number: Number(row.scene_number),
      payload: safeJson(row.payload, {}),
      created_at: row.created_at ?? null,
      updated_at: row.updated_at ?? null,
    }));
}

export async function kidsReplaceTimeline(store, db, projectId, rows) {
  if (store === "pg") {
    await db.query("DELETE FROM kids_timeline_rows WHERE project_id = $1", [projectId]);
    for (const row of rows) {
      await db.query(
        `INSERT INTO kids_timeline_rows (project_id, scene_number, payload)
         VALUES ($1,$2,$3::jsonb)
         ON CONFLICT (project_id, scene_number) DO UPDATE SET
           payload = EXCLUDED.payload, updated_at = NOW()`,
        [projectId, row.scene_number, JSON.stringify(row.payload || {})]);
    }
    return kidsListTimeline(store, db, projectId);
  }
  db.prepare("DELETE FROM kids_timeline_rows WHERE project_id = ?").run(projectId);
  const ins = db.prepare(
    `INSERT INTO kids_timeline_rows (project_id, scene_number, payload)
     VALUES (?,?,?)
     ON CONFLICT (project_id, scene_number) DO UPDATE SET
       payload = excluded.payload, updated_at = ?`);
  const now = new Date().toISOString();
  for (const row of rows) {
    ins.run(projectId, row.scene_number, JSON.stringify(row.payload || {}), now);
  }
  return kidsListTimeline(store, db, projectId);
}
