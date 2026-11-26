// Helpers shared by the Director asset HTTP routes and the job pump.
// These functions only manipulate plain board-state objects — no fs/network.

import { assetVersionId, buildCompactAssetIndex } from "./asset_service.mjs";

export function emptyAssetState() {
  return { status: "idle", assets: [], jobs: [], skipped: false, updatedAt: null };
}

export function getBoardAssetState(board) {
  const production = board?.assetProduction;
  if (!production || typeof production !== "object") return emptyAssetState();
  return {
    status: String(production.status || "idle"),
    assets: Array.isArray(production.assets) ? production.assets : [],
    jobs: Array.isArray(production.jobs) ? production.jobs : [],
    skipped: Boolean(production.skipped),
    sourceSignature: production.sourceSignature || null,
    updatedAt: production.updatedAt || null,
  };
}

export function isValidAssetId(id) {
  return /^(CHAR|LOC|OBJ)_\d{3}$/.test(String(id || ""));
}

export function findAsset(state, assetId) {
  return (state.assets || []).find((a) => a.id === assetId) || null;
}

export function assetsReadyToApprove(state) {
  return (state.assets || []).filter((a) => a.status === "review" && Boolean(a.reference));
}

export function approveAssets(state, ids = null) {
  const wanted = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null;
  const now = new Date().toISOString();
  let changed = 0;
  const assets = (state.assets || []).map((a) => {
    if (wanted && !wanted.has(a.id)) return a;
    if (a.status !== "review" || !a.reference) return a;
    changed += 1;
    return { ...a, status: "approved", approvedAt: now, error: null };
  });
  const allApproved = assets.length > 0 && assets.every((a) => a.status === "approved" || a.status === "skipped");
  return {
    state: { ...state, assets, status: allApproved ? "approved" : state.status, updatedAt: now },
    changed,
  };
}

/** Mark the whole stage skipped (no renders) so the pipeline can continue. */
export function skipAssets(state) {
  const now = new Date().toISOString();
  return {
    ...state,
    status: "approved",
    skipped: true,
    assets: (state.assets || []).map((a) => ({
      ...a,
      status: a.status === "approved" ? "approved" : "skipped",
      approvedAt: a.approvedAt || now,
    })),
    updatedAt: now,
  };
}

export function compactIndex(state) {
  return buildCompactAssetIndex(state.assets, false);
}

/** Validate compact Director scene references against the approved master
 * library. Legacy bible ids are translated to asset ids without duplicating
 * any asset description into the scene row. */
export function resolveSceneAssetRefs(scene, state) {
  const assets = (state?.assets || []).filter((a) => a?.status === "approved" && a.reference);
  const byId = new Map(assets.map((a) => [String(a.id), { asset: a, refId: assetVersionId(a) }]));
  const byBlueprint = new Map(assets.filter((a) => a.blueprint_id).map((a) => [String(a.blueprint_id), { asset: a, refId: assetVersionId(a) }]));
  const byReferenceId = new Map();
  for (const asset of assets) {
    byReferenceId.set(String(asset.reference_id || assetVersionId(asset)), { asset, refId: String(asset.reference_id || assetVersionId(asset)) });
    for (const v of Array.isArray(asset.image_versions) ? asset.image_versions : []) {
      if (v?.reference_id && v.reference) byReferenceId.set(String(v.reference_id), { asset, version: v, refId: String(v.reference_id) });
    }
  }
  const issues = [];
  const resolveOne = (id, kind, where, explicit, rowIssues) => {
    const value = String(id || "").trim();
    if (!value) return null;
    const resolved = byReferenceId.get(value) || byId.get(value) || byBlueprint.get(value);
    if (!resolved) {
      if (explicit) rowIssues.push(`${where}: ${value} is not an approved asset id`);
      return null;
    }
    const asset = resolved.asset;
    if (asset.type !== kind) {
      rowIssues.push(`${where}: ${asset.id} is a ${asset.type}, not a ${kind}`);
      return null;
    }
    return resolved.refId;
  };
  const oneRow = (row, where) => {
    if (!row || typeof row !== "object") return;
    const rowIssues = [];
    const refs = row.asset_refs && typeof row.asset_refs === "object" ? row.asset_refs : {};
    const resolveList = (values, type, label, useExplicit) => [...new Set((Array.isArray(values) ? values : values ? [values] : [])
      .map((v) => resolveOne(typeof v === "object" ? v.asset_id || v.id : v, type, `${where} ${label}`, useExplicit, rowIssues))
      .filter(Boolean))];
    row.asset_refs = {
      characters: resolveList(refs.characters, "character", "character refs", Array.isArray(refs.characters) && refs.characters.length > 0),
      locations: resolveList(refs.locations, "location", "location refs", Array.isArray(refs.locations) && refs.locations.length > 0),
      objects: resolveList(refs.objects, "object", "object refs", Array.isArray(refs.objects) && refs.objects.length > 0),
    };
    // Empty/missing asset_refs remain backward-compatible: translate the
    // existing bible ids to approved asset ids where a rendered asset exists.
    if (!row.asset_refs.characters.length) row.asset_refs.characters = resolveList(row.characters, "character", "character refs", false);
    if (!row.asset_refs.locations.length) row.asset_refs.locations = resolveList(row.location ? [row.location] : [], "location", "location refs", false);
    if (!row.asset_refs.objects.length) row.asset_refs.objects = resolveList(row.objects, "object", "object refs", false);
    issues.push(...rowIssues);
    if (rowIssues.length) row.asset_reference_issues = [...new Set(rowIssues)];
    else delete row.asset_reference_issues;
  };
  oneRow(scene, `scene ${scene?.scene_number ?? "?"}`);
  for (const shot of Array.isArray(scene?.shots) ? scene.shots : []) oneRow(shot, `shot ${shot?.shot_id ?? "?"}`);
  return { scene, issues };
}

export default {
  emptyAssetState,
  getBoardAssetState,
  isValidAssetId,
  findAsset,
  assetsReadyToApprove,
  approveAssets,
  skipAssets,
  compactIndex,
  resolveSceneAssetRefs,
};
