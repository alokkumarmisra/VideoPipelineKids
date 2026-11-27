// ---------------------------------------------------------------------------
// Production modes + Director Input Snapshot (spec Parts 2 + 16 + 17).
// Pure: no fs / network / db. Decides audio-driven vs story-only, gates the
// Director on approvals, and makes Director inputs reproducible/versioned.
// Stores REFERENCES only — never duplicates the 19-track events.
// ---------------------------------------------------------------------------

export const PRODUCTION_MODES = ["audio_driven", "story_only"];

export function resolveProductionMode(input = {}) {
  const audioMs = Number(input.audioDurationMs ?? input.audioAsset?.durationSec * 1000 ?? 0);
  if (Number.isFinite(audioMs) && audioMs > 0) return "audio_driven";
  return "story_only";
}

export function canRunDirector(gate = {}) {
  const mode = gate.productionMode === "audio_driven" ? "audio_driven" : "story_only";
  const blockers = [];
  if (mode === "audio_driven") {
    if (gate.timelineApprovalStatus !== "approved") blockers.push("approved 19-track master timeline required");
    if (!gate.durationBlueprintApproved) blockers.push("approved duration & pacing blueprint required");
    if (!gate.directorInputSnapshotId) blockers.push("director input snapshot required");
  }
  return { ok: blockers.length === 0, blockers, mode };
}

/**
 * Build an immutable Director Input Snapshot: every id/version the Director
 * consumed, so a later source change can mark affected plans stale.
 */
export function buildDirectorInputSnapshot(input = {}) {
  return {
    snapshotId: String(input.snapshotId || `dis-${Date.now()}`),
    createdAt: new Date().toISOString(),
    productionId: String(input.productionId || ""),
    productionMode: input.productionMode === "audio_driven" ? "audio_driven" : "story_only",
    audioAssetId: input.audioAssetId ?? null,
    audioReference: input.audioReference ?? null,
    lyricsVersion: input.lyricsVersion ?? null,
    audioSummaryVersion: input.audioSummaryVersion ?? null,
    masterTimelineId: input.masterTimelineId ?? null,
    masterTimelineVersion: input.masterTimelineVersion ?? null,
    timelineApprovalStatus: input.timelineApprovalStatus ?? "pending",
    durationBlueprintId: input.durationBlueprintId ?? null,
    durationBlueprintVersion: input.durationBlueprintVersion ?? null,
    storyBibleVersion: input.storyBibleVersion ?? null,
    characterReferenceIds: [...(input.characterReferenceIds || [])],
    locationReferenceIds: [...(input.locationReferenceIds || [])],
    objectReferenceIds: [...(input.objectReferenceIds || [])],
    genre: String(input.genre || ""),
    visualStyle: String(input.visualStyle || ""),
    directorConfigVersion: String(input.directorConfigVersion || "1"),
  };
}

/** Compare a snapshot against current source versions; never auto-repairs. */
export function isSnapshotStale(snapshot = {}, current = {}) {
  const checks = [
    ["masterTimelineVersion", "timeline"],
    ["durationBlueprintVersion", "duration blueprint"],
    ["storyBibleVersion", "story bible"],
    ["lyricsVersion", "lyrics"],
    ["audioSummaryVersion", "audio summary"],
  ];
  const staleFields = [];
  for (const [field, label] of checks) {
    if (current[field] != null && snapshot[field] !== current[field]) staleFields.push(`${label}: ${snapshot[field]} → ${current[field]}`);
  }
  const affected = [...staleFields];
  if (snapshot.timelineApprovalStatus === "approved" && current.timelineApprovalStatus && current.timelineApprovalStatus !== "approved") {
    affected.push("timeline approval revoked");
  }
  return { stale: affected.length > 0, affected, reasons: affected };
}
