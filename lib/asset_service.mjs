// Pure helpers for the Director "Generate Assets" stage.
// No fs / network / DB access — safe to import anywhere (including tests).
//
// A director board's blueprint already carries the canonical cast / world /
// props from story analysis. This module turns those entries into stable,
// reusable master assets (CHAR_001, LOC_001, OBJ_001) plus the compact index
// handed to the LLM during scene planning.

export const ASSET_TYPES = Object.freeze({
  CHARACTER: "character",
  LOCATION: "location",
  OBJECT: "object",
});

const TYPE_KEYS = Object.freeze({
  [ASSET_TYPES.CHARACTER]: { plural: "characters", prefix: "CHAR", field: "character_id" },
  [ASSET_TYPES.LOCATION]: { plural: "locations", prefix: "LOC", field: "location_id" },
  [ASSET_TYPES.OBJECT]: { plural: "objects", prefix: "OBJ", field: "object_id" },
});

/** Stable, human-readable id: CHAR_001 / LOC_001 / OBJ_001. */
export function generateAssetId(type, index) {
  const meta = TYPE_KEYS[type];
  if (!meta) throw new Error(`unknown asset type: ${type}`);
  return `${meta.prefix}_${String(index).padStart(3, "0")}`;
}

/** The saved generation prompt is the model input, verbatim. */
export function assetPrompt(entry) {
  return String(
    entry?.visual_identity_prompt ||
    entry?.prompt ||
    entry?.description ||
    "",
  ).trim();
}

export function assetName(entry, fallback) {
  return String(entry?.name || fallback || "Untitled asset").trim();
}

const ID_TITLE_WORDS = new Set(["lord", "god", "goddess", "shri", "sri", "maa", "mata", "mother", "bhagwan", "bhagavān", "devi", "dev", "श्री", "भगवान", "भगवती", "मां", "माता"]);

/** Human-readable version reference, e.g. SHIV_01 / PARV_02. The database's
 * stable CHAR_/LOC_/OBJ_ id remains the primary key for old-board compatibility. */
export function assetVersionId(asset, version = asset?.version || 1) {
  const displayName = String(asset?.name || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim();
  const nameWords = displayName.split(/[\s()[\]{}.,:/\\_-]+/).filter(Boolean);
  while (nameWords.length && ID_TITLE_WORDS.has(nameWords[0].toLocaleLowerCase())) nameWords.shift();
  const nameStem = (nameWords.join("").match(/[A-Za-z0-9]+/) || [""])[0];
  const blueprintStem = String(asset?.blueprint_id || "").split(/[^A-Za-z0-9]+/).filter(Boolean)[0] || "";
  const stem = (nameStem || blueprintStem || String(asset?.id || "ASST").replace(/[^A-Za-z0-9]/g, ""))
    .slice(0, 4).toUpperCase().padEnd(4, "X");
  const n = Math.max(1, Math.floor(Number(version) || 1));
  return `${stem}_${String(n).padStart(2, "0")}`;
}

/**
 * A cheap signature of the bible entries the master assets were derived from.
 * The Generate stage rebuilds only when this changes — clicking the button
 * twice must never wipe a rendered-but-unapproved still.
 */
export function blueprintAssetSignature(blueprint) {
  const bp = blueprint || {};
  const rows = (plural, field) => (Array.isArray(bp[plural]) ? bp[plural] : [])
    .map((r) => [String(r?.[field] || ""), assetName(r), assetPrompt(r)].join("\u0001"))
    .join("\u0002");
  return JSON.stringify({
    c: rows("characters", "character_id"),
    l: rows("locations", "location_id"),
    o: rows("objects", "object_id"),
  });
}

/**
 * Extract master assets from a normalized director blueprint.
 * Entries with no usable prompt are still returned (status `no-prompt`) so the
 * UI can ask the user to write one — we never silently invent text.
 */
export function extractAssetsFromBlueprint(blueprint) {
  const bp = blueprint || {};
  const assets = [];
  for (const type of Object.keys(TYPE_KEYS)) {
    const meta = TYPE_KEYS[type];
    const rows = Array.isArray(bp[meta.plural]) ? bp[meta.plural] : [];
    rows.forEach((row, i) => {
      const id = generateAssetId(type, i + 1);
      const prompt = assetPrompt(row);
      assets.push({
        id,
        type,
        name: assetName(row, id),
        blueprint_id: String(row?.[meta.field] || ""),
        prompt,
        description: String(row?.description || "").slice(0, 300),
        reference: null,
        status: prompt ? "pending" : "no-prompt",
        approvedAt: null,
        error: null,
        version: 0,
      });
    });
  }
  return assets;
}

/** Compact scene-planner index. Keep the complete saved identity prompt: this
 * is the canonical text lock paired with the generated reference still. */
export function buildCompactAssetIndex(assets, approvedOnly = true) {
  return (Array.isArray(assets) ? assets : [])
    .filter((a) => (approvedOnly ? a?.status === "approved" : Boolean(a?.id)))
    .map((a) => ({
      id: a.id,
      reference_id: assetVersionId(a),
      blueprint_id: a.blueprint_id || "",
      name: a.name,
      type: a.type,
      // The generation prompt is the saved visual identity sent to ComfyUI;
      // prefer it over the short catalog description in downstream locks.
      visualBrief: `${String(a.prompt || a.description || "").replace(/\s+/g, " ").slice(0, 120)}…`.trim(),
      prompt: String(a.prompt || a.description || "").trim(),
      reference: a.reference || null,
      version: Number(a.version) || 1,
      image_versions: Array.isArray(a.image_versions) ? a.image_versions : [],
    }));
}

const refId = (x) => String(
  x && typeof x === "object"
    ? (x.character_id || x.location_id || x.object_id || x.id || x.name || "")
    : (x ?? ""),
).trim();
const refName = (x) => String(x && typeof x === "object" ? (x.name || refId(x)) : "").trim();
const refList = (x) => Array.isArray(x) ? x : (x ? [x] : []);

/** Duplicate display names in a bible list — reported, never auto-merged. */
export function findDuplicateAssets(entries) {
  const groups = new Map();
  for (const row of Array.isArray(entries) ? entries : []) {
    const name = refName(row) || refId(row);
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    if (!groups.has(key)) groups.set(key, { name, ids: [] });
    const id = refId(row);
    if (id && !groups.get(key).ids.includes(id)) groups.get(key).ids.push(id);
  }
  return [...groups.values()].filter((g) => g.ids.length > 1);
}

/** Read-only reference map: which scenes/shots actually use each bible entry. */
export function buildAssetReferenceMap(board) {
  const bp = board?.blueprint || {};
  const makeRows = (plural, field) => (Array.isArray(bp[plural]) ? bp[plural] : []).map((r) => ({
    id: refId(r?.[field]), name: refName(r) || refId(r?.[field]), scenes: [], shots: [],
  }));
  const map = {
    characters: makeRows("characters", "character_id"),
    locations: makeRows("locations", "location_id"),
    props: makeRows("objects", "object_id"),
    styles: [],
  };
  const styleName = String(board?.styleLock || board?.input?.visualStyle || "").trim();
  if (styleName) map.styles = [{ id: "style_lock", name: styleName, scenes: [], shots: [] }];
  for (const scene of Array.isArray(board?.scenes) ? board.scenes : []) {
    const n = Number(scene?.scene_number) || 0;
    const shots = Array.isArray(scene?.shots) ? scene.shots : [];
    const shotRefs = (key, shot) => key === "characters"
      ? refList(shot?.characters)
      : key === "locations" ? refList(shot?.location) : refList(shot?.objects);
    const push = (key, values) => {
      for (const value of values) {
        const id = refId(value);
        const row = map[key].find((r) => r.id === id || r.name === String(value));
        if (!row) continue;
        if (n && !row.scenes.includes(n)) row.scenes.push(n);
        for (const shot of shots) {
          if (!shotRefs(key, shot).some((x) => refId(x) === id || String(x) === row.name)) continue;
          const label = `${n}-${shot?.shot_id || shot?.shot_number || "?"}`;
          if (!row.shots.includes(label)) row.shots.push(label);
        }
      }
    };
    push("characters", refList(scene?.characters).concat(refList(scene?.character_ids)));
    push("locations", refList(scene?.location).concat(refList(scene?.location_id)));
    push("props", refList(scene?.objects).concat(refList(scene?.object_ids)));
    if (styleName && n) {
      if (!map.styles[0].scenes.includes(n)) map.styles[0].scenes.push(n);
      for (const shot of shots) {
        const label = `${n}-${shot?.shot_id || shot?.shot_number || "?"}`;
        if (!map.styles[0].shots.includes(label)) map.styles[0].shots.push(label);
      }
    }
  }
  return map;
}

/** Compact visual guide derived from the bible + planned scenes. */
export function buildVisualStyleGuide(board) {
  const bp = board?.blueprint || {};
  const locations = Array.isArray(bp.locations) ? bp.locations : [];
  const scenes = Array.isArray(board?.scenes) ? board.scenes : [];
  const uniq = (xs) => [...new Set(xs.map((x) => String(x).trim()).filter(Boolean))].slice(0, 8);
  return {
    style: String(board?.styleLock || board?.input?.visualStyle || "Custom"),
    characters: Array.isArray(bp.characters) ? bp.characters.length : 0,
    locations: locations.length,
    palettes: uniq(locations.flatMap((l) => Array.isArray(l?.color_palette) ? l.color_palette : [l?.color_palette])),
    lighting: uniq(locations.map((l) => l?.lighting).concat(scenes.map((s) => s?.lighting))),
    layout: String(board?.input?.aspect || "16:9"),
  };
}

/** Honest continuity findings — never claims a board is "safe" or "correct". */
export function validateAssetContinuity(board) {
  const issues = [];
  for (const [label, entries, field] of [
    ["character", board?.blueprint?.characters, "character_id"],
    ["location", board?.blueprint?.locations, "location_id"],
    ["prop", board?.blueprint?.objects, "object_id"],
  ]) {
    for (const dup of findDuplicateAssets(entries)) {
      issues.push(`Duplicate ${label} name "${dup.name}" (${dup.ids.join(", ")}) — pick the canonical one.`);
    }
  }
  const known = {
    characters: new Set((board?.blueprint?.characters || []).map((r) => refId(r?.character_id))),
    locations: new Set((board?.blueprint?.locations || []).map((r) => refId(r?.location_id))),
    objects: new Set((board?.blueprint?.objects || []).map((r) => refId(r?.object_id))),
  };
  for (const scene of Array.isArray(board?.scenes) ? board.scenes : []) {
    const n = Number(scene?.scene_number) || "?";
    if (!refId(scene?.location) && !refId(scene?.location_id)) issues.push(`Scene ${n} has no bible location.`);
    for (const [label, values, set] of [
      ["character", refList(scene?.characters), known.characters],
      ["object", refList(scene?.objects), known.objects],
      ["location", refList(scene?.location), known.locations],
    ]) {
      for (const value of values) {
        const id = refId(value);
        if (id && !set.has(id)) issues.push(`Scene ${n} references unknown ${label} id "${id}".`);
      }
    }
  }
  return issues.slice(0, 50);
}

/** Subset of assets referenced by a scene (ids come from bible grounding). */
export function getAssetsForScene(assets, scene) {
  const ids = new Set([
    ...(Array.isArray(scene?.characters) ? scene.characters : []),
    ...(Array.isArray(scene?.character_ids) ? scene.character_ids : []),
    ...(Array.isArray(scene?.objects) ? scene.objects : []),
    ...(Array.isArray(scene?.location) ? [scene.location] : []),
    ...(scene?.location ? [scene.location] : []),
  ].map(String));
  const list = Array.isArray(assets) ? assets : [];
  if (!ids.size) return list.filter((a) => a.status === "approved");
  return list.filter((a) => ids.has(a.id) || ids.has(a.blueprint_id));
}

/** Fresh production state for a board, preserving already-approved assets. */
export function buildBoardAssetState(blueprint, existing = null) {
  const assets = extractAssetsFromBlueprint(blueprint);
  const sourceSignature = blueprintAssetSignature(blueprint);
  const old = Array.isArray(existing?.assets) ? existing.assets : [];
  const byId = new Map(old.map((a) => [a.id, a]));
  const keepable = new Set(["approved", "skipped", "review", "queued", "generating"]);
  const merged = assets.map((a) => {
    const prev = byId.get(a.id);
    if (!prev) return a;
    // Never silently discard a rendered master asset when the bible text
    // changes — a regeneration must be an explicit user action.
    return {
      ...a,
      prompt: prev.prompt || a.prompt,
      reference: prev.reference || null,
      status: keepable.has(prev.status) ? prev.status : a.status,
      approvedAt: prev.approvedAt || null,
      version: Number(prev.version) || 0,
      error: prev.error || null,
    };
  });
  const approved = merged.length > 0 && merged.every((a) => a.status === "approved" || a.status === "skipped");
  return {
    status: approved ? "approved" : (existing?.status === "approved" && !merged.length ? "approved" : "idle"),
    assets: merged,
    jobs: Array.isArray(existing?.jobs) ? existing.jobs : [],
    skipped: Boolean(existing?.skipped),
    sourceSignature,
    updatedAt: new Date().toISOString(),
  };
}

export default {
  ASSET_TYPES,
  generateAssetId,
  assetPrompt,
  assetName,
  blueprintAssetSignature,
  findDuplicateAssets,
  buildAssetReferenceMap,
  buildVisualStyleGuide,
  validateAssetContinuity,
  extractAssetsFromBlueprint,
  buildCompactAssetIndex,
  getAssetsForScene,
  buildBoardAssetState,
};
