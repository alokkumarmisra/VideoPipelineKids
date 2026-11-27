// ---------------------------------------------------------------------------
// Intelligent cinematic storyboard planner (Storyboard Planner 2.0).
// ---------------------------------------------------------------------------
// PURE adapter / audit layer. It NEVER builds, rewrites or approves a timeline:
// the approved 19-track timeline (or the Director's approved master segment
// timeline) stays the read-only timing authority. The existing duration-driven
// scene engine in lib/director.mjs remains the one and only planning engine —
// this module only turns the approved timeline into (a) a compact per-batch
// context for that engine, (b) an honest coverage audit and (c) a pre-approval
// report + AI Director handoff description.
//
// No fs / network / db / LLM here. Every timestamp is copied from the input;
// nothing is invented, snapped, moved or fabricated.

import { ALL_TIMELINE_TRACKS } from "./studio_engines.mjs";
import {
  validateBibleAnatomy,
  boardLyricLines as directorBoardLyricLines,
} from "./director.mjs";

export const STORYBOARD_TRACKS = [...ALL_TIMELINE_TRACKS];

export const STORYBOARD_PHASES = Object.freeze([
  "Preparing Story Context",
  "Reading Approved Audio Timeline",
  "Analyzing Narrative Events",
  "Planning Scenes",
  "Generating Shot Breakdown",
  "Validating Character Continuity",
  "Saving Batch",
  "Preparing Next Batch",
  "Generation Complete",
]);

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v, n = 0) => {
  const t = String(v ?? "").trim();
  return n ? t.slice(0, n) : t;
};
const num = (v, fb = null) => (Number.isFinite(Number(v)) ? Number(v) : fb);
const round = (v) => Math.round(Number(v) * 1000) / 1000;
const msToSec = (ms) => round(num(ms, 0) / 1000);
const eventStartSec = (e) => {
  const ms = num(e?.startMs, null);
  if (ms != null) return msToSec(ms);
  const sec = num(e?.start_seconds, null);
  if (sec != null) return round(sec);
  return round(num(e?.start, 0));
};
const eventEndSec = (e) => {
  const ms = num(e?.endMs, null);
  if (ms != null) return msToSec(ms);
  const sec = num(e?.end_seconds, null);
  if (sec != null) return round(sec);
  return round(num(e?.end, 0));
};
const overlaps = (a, b, t) => Number(a.start) < Number(b.end) - (t || 0) && Number(a.end) > Number(b.start) + (t || 0);
const overlapSec = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
const isInstrumentalLabel = (label) => /instrumental|intro|outro|break|interlude|silence|pause/i.test(str(label));
const isDanceLabel = (label) => /danc|choreograph|spin|leap|twirl|step|move/i.test(str(label));

function sceneWindow(s) {
  const a = num(s && (s.song_start_time ?? s.start_seconds ?? s.start));
  const b = num(s && (s.song_end_time ?? s.end_seconds ?? s.end));
  if (a == null || b == null || b <= a) return null;
  return { start: round(a), end: round(b) };
}

function sceneIdsForLine(s) {
  // A set, not a list: a line repeated on the scene and each of its shots is
  // still ONE source line. Duplicates would bloat every prompt/context block.
  const out = new Set();
  for (const key of ["lyric_line_id", "line_from", "line_to", "parent_line_id"]) {
    const n = num(s && s[key]);
    if (n != null && n > 0) out.add(n);
  }
  for (const sh of arr(s && s.shots)) {
    // Shot windows inherit their parent scene's line range when no own id.
    for (const key of ["lyric_line_id", "parent_line_id"]) {
      const n = num(sh && sh[key]);
      if (n != null && n > 0) out.add(n);
    }
  }
  return [...out];
}

function eventOf(trackId, id, start, end, label, extra = {}) {
  return {
    id: str(id) || `${trackId}-${round(start)}-${round(end)}-${str(label, 24)}`,
    trackId,
    start: round(start),
    end: round(end),
    label: str(label),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Timeline adapter — read-only view of the approved authority
// ---------------------------------------------------------------------------

/** Map the Director master-segment timeline onto the 19-track vocabulary. */
function tracksFromMaster(master, durationSec) {
  const tracks = Object.fromEntries(STORYBOARD_TRACKS.map((t) => [t, []]));
  const segments = arr(master && master.segments).filter((s) => num(s && s.end_seconds) > num(s && s.start_seconds));
  const clips = arr(master && master.clips);
  for (const s of segments) {
    const a = round(num(s.start_seconds, 0));
    const b = round(num(s.end_seconds, a));
    const sid = str(s.segment_id) || `segment-${a}`;
    const lineId = num(s.lyric_line_id);
    const lineRef = lineId > 0 ? lineId : null;
    const lyric = str(s.lyric_text);
    if (lineRef && lyric) {
      tracks.lyrics.push(eventOf("lyrics", `lyric-${lineRef}-o${num(s.occurrence, 1)}`, a, b, lyric, {
        lineId, occurrence: num(s.occurrence, 1), segmentId: sid, repeatGroup: s.repeat_group || null,
        timingSource: str(s.timing_source) || "unknown", lowConfidence: s.low_confidence === true,
      }));
      tracks.subtitles.push(eventOf("subtitles", `subtitle-${lineRef}-o${num(s.occurrence, 1)}`, a, b, lyric, {
        lineId, segmentId: sid,
      }));
    }
    for (const [i, w] of arr(s.words).entries()) {
      const wa = num(w && w.start_seconds);
      const wb = num(w && w.end_seconds);
      if (wa == null || wb == null || wb <= wa) continue;
      tracks.word_timings.push(eventOf("word_timings", `${sid}-w${i + 1}`, wa, wb, str(w.word), {
        lineId, segmentId: sid, timing: str(w.timing) || "estimated",
      }));
    }
    if (s.type === "instrumental") {
      tracks.music_structure.push(eventOf("music_structure", `music-${sid}`, a, b, "instrumental", {
        segmentId: sid, section: "instrumental",
      }));
    }
    if (str(s.speaker) || str(s.character_id)) {
      const kind = str(s.type) === "dialogue" ? "dialogue" : "singing";
      tracks.speaker_events.push(eventOf("speaker_events", `speaker-${sid}`, a, b, str(s.speaker) || str(s.character_id), {
        characterId: str(s.character_id), kind, segmentId: sid, derived: true,
      }));
    }
    if (str(s.action) && lineRef) {
      tracks.narrative_events.push(eventOf("narrative_events", `narrative-${sid}`, a, b, str(s.action), {
        sourceLine: lineRef, segmentId: sid, derived: true,
      }));
    }
    if (str(s.character_id)) {
      tracks.character_appearances.push(eventOf("character_appearances", `appear-${sid}`, a, b, str(s.character_id), {
        characterId: str(s.character_id), segmentId: sid, derived: true,
      }));
    }
    if (str(s.action) && str(s.character_id)) {
      tracks.character_actions.push(eventOf("character_actions", `action-${sid}`, a, b, str(s.action), {
        characterId: str(s.character_id), segmentId: sid, derived: true,
        grounded: s.grounded !== false,
      }));
    }
    if (isDanceLabel(s.action)) {
      tracks.choreography.push(eventOf("choreography", `choreo-${sid}`, a, b, str(s.action), {
        segmentId: sid, derived: true,
      }));
    }
    if (str(s.expression)) {
      tracks.emotions.push(eventOf("emotions", `emotion-${sid}`, a, b, str(s.expression), {
        segmentId: sid, derived: true,
      }));
    }
    if (str(s.type) === "dialogue" && lyric) {
      tracks.dialogue_performance.push(eventOf("dialogue_performance", `perf-${sid}`, a, b, lyric, {
        characterId: str(s.character_id), segmentId: sid, derived: true,
        lipSyncRequired: str(s.character_id) ? true : false,
      }));
      if (str(s.character_id)) {
        tracks.lip_sync.push(eventOf("lip_sync", `lip-${sid}`, a, b, str(s.character_id), {
          characterId: str(s.character_id), segmentId: sid, derived: true,
        }));
      }
    }
    if (s.camera && typeof s.camera === "object") {
      const c = s.camera;
      const label = [str(c.shot_type || c.shotType), str(c.angle), str(c.movement || c.cameraMovement)]
        .filter(Boolean).join(" · ");
      tracks.camera_direction.push(eventOf("camera_direction", `camera-${sid}`, a, b, label || "Camera", {
        shotType: str(c.shot_type || c.shotType), angle: str(c.angle),
        movement: str(c.movement || c.cameraMovement), segmentId: sid, derived: true,
      }));
    }
    for (const [i, note] of arr(s.notes).entries()) {
      if (isInstrumentalLabel(note)) {
        tracks.transitions.push(eventOf("transitions", `transition-${sid}-${i + 1}`, a, b, str(note), {
          segmentId: sid, derived: true,
        }));
      }
    }
  }
  for (const [i, c] of clips.entries()) {
    const a = round(num(c.start_seconds, 0));
    const b = round(num(c.end_seconds, a));
    if (b <= a) continue;
    const kind = str(c.kind) || "unknown";
    const target = kind === "scene" || kind === "singing" || kind === "dialogue" || kind === "mixed"
      ? "scene_timeline" : "shot_timeline";
    tracks[target].push(eventOf(target, str(c.clip_id) || `clip-${i + 1}`, a, b, str(c.lyric_text) || kind, {
      clipId: str(c.clip_id) || `clip-${i + 1}`, kind, segmentIds: arr(c.segment_ids), derived: true,
    }));
  }
  // The original audio lane is the WAV clock itself — never a new clock.
  if (durationSec > 0) {
    tracks.original_audio.push(eventOf("original_audio", "original_audio-1", 0, round(durationSec), "original audio", {
      authoritative: true,
    }));
  }
  return tracks;
}

/**
 * Build a READ-ONLY storyboard view of the approved timeline.
 * Source priority: approved 19-track Kids timeline → approved Director master
 * timeline → no timeline (existing story-only fallback, nothing fabricated).
 */
export function normalizeStoryboardTimeline({ board = {}, unifiedTimeline = null } = {}) {
  const tracks = Object.fromEntries(STORYBOARD_TRACKS.map((t) => [t, []]));
  const master = board && board.lyric_timeline && board.lyric_timeline.master;
  const unifiedApproved = unifiedTimeline && typeof unifiedTimeline === "object" && (
    unifiedTimeline.status === "approved" || unifiedTimeline.approval?.status === "approved"
    || unifiedTimeline.approved === true
  ) ? unifiedTimeline : null;
  let source = "none";
  let available = false;
  let approved = false;
  let durationSec = 0;
  let id = null;
  let version = null;
  let approvedAt = null;
  let trackCounts = {};
  if (unifiedApproved?.tracks) {
    source = "unified-19-track";
    available = true;
    approved = true;
    durationSec = round(num(unifiedApproved.masterDurationSec, msToSec(unifiedApproved.masterDurationMs), 0) || 0);
    id = str(unifiedApproved.timelineId) || str(unifiedApproved.id) || null;
    version = num(unifiedApproved.version, null);
    approvedAt = str(unifiedApproved.approval?.approved_at || unifiedApproved.approved_at || master?.approved) || null;
    for (const t of STORYBOARD_TRACKS) {
      for (const e of arr(unifiedApproved.tracks[t])) {
        const a = eventStartSec(e);
        const b = eventEndSec(e);
        if (!(b > a)) continue;
        const { startMs, endMs, startFrame, endFrame, startSample, endSample, ...rest } = e || {};
        tracks[t].push({ ...rest, id: str(e.id) || `${t}-${tracks[t].length + 1}`, trackId: t, start: a, end: b, startMs, endMs });
      }
      trackCounts[t] = tracks[t].length;
    }
  } else if (master && master.approved && Array.isArray(master.segments)) {
    source = "director-master-timeline";
    available = true;
    approved = true;
    durationSec = round(num(master.duration_seconds, 0) || 0);
    id = str(master.timeline_id || board.lyric_timeline?.timeline_id) || null;
    version = num(board.lyric_timeline?.version, null);
    approvedAt = str(master.approved) || null;
    const mapped = tracksFromMaster(master, durationSec);
    for (const t of STORYBOARD_TRACKS) {
      tracks[t] = mapped[t];
      trackCounts[t] = tracks[t].length;
    }
  } else {
    // Honest fallback: the old planner's behaviour stays exactly as it was.
    durationSec = round(num(board?.input?.song?.durationSeconds, board?.input?.targetSeconds, 0) || 0);
    for (const t of STORYBOARD_TRACKS) trackCounts[t] = 0;
  }
  if (!(durationSec > 0)) {
    const latestEnd = Math.max(0, ...STORYBOARD_TRACKS.flatMap((t) => tracks[t].map((e) => e.end)));
    if (latestEnd > durationSec) durationSec = round(latestEnd);
  }
  for (const t of STORYBOARD_TRACKS) tracks[t].sort((a, b) => a.start - b.start || a.end - b.end);
  return {
    available, approved, source, id, version, approvedAt, durationSec,
    trackCounts, tracks,
    readOnly: true,
    note: available
      ? "Approved timeline is a read-only reference — original timestamps are never modified."
      : "No approved timeline — the existing story-only planner fallback remains in force.",
  };
}

/** Slice the read-only timeline to a batch window, preserving every source id. */
export function storyboardBatchContext({ board = {}, timeline = null, from = 0, to = 0 } = {}) {
  const tl = timeline && timeline.tracks ? timeline : normalizeStoryboardTimeline({ board });
  const duration = tl.durationSec || 0;
  const a = round(Math.max(0, Math.min(num(from, 0), duration || Infinity)));
  const b = round(Math.max(a, Math.min(num(to, duration || a), duration || Infinity)));
  // Half-open [a, b): an event starting exactly at the window end belongs to
  // the NEXT batch, otherwise adjacent lyrics leak into every prompt slice.
  const inWindow = (e) => Number(e.end) > a + 0.0001 && Number(e.start) < b - 0.0001;
  const slice = (track) => arr(tl.tracks?.[track]).filter(inWindow)
    .map((e) => ({ ...e, start: round(e.start), end: round(e.end) }));
  const music = slice("music_structure");
  const lyrics = slice("lyrics");
  const instrumentals = music.filter((e) => isInstrumentalLabel(e.label))
    .map((e) => ({
      ...e,
      lyricOverlap: lyrics.some((l) => overlaps(l, e, 0.05)),
      visualShotsAdvisory: Math.max(1, Math.min(3, Math.ceil((e.end - e.start) / 4))),
    }));
  const sceneCoveredIds = new Set(arr(board?.scenes).flatMap(sceneIdsForLine));
  const uncoveredLyrics = lyrics.filter((l) => !sceneCoveredIds.has(num(l.lineId)))
    .map((l) => ({ id: l.id, lineId: l.lineId, start: l.start, end: l.end, label: l.label }));
  const narrative = slice("narrative_events");
  const uncoveredNarrative = narrative.filter((e) => !arr(board?.scenes).some((s) => {
    const line = num(e.sourceLine);
    return (line > 0 && sceneIdsForLine(s).includes(line))
      || (str(e.label) && str(s.action).toLowerCase().includes(str(e.label).toLowerCase().slice(0, 30)));
  })).map((e) => ({ id: e.id, start: e.start, end: e.end, label: e.label }));
  const prev = arr(board?.scenes).length ? arr(board.scenes).at(-1) : null;
  const prevWin = prev ? sceneWindow(prev) : null;
  return {
    available: tl.available && tl.approved,
    source: tl.source,
    version: tl.version,
    approvedAt: tl.approvedAt,
    from: a, to: b,
    durationSec: tl.durationSec,
    tracks: Object.fromEntries(STORYBOARD_TRACKS.map((t) => [t, slice(t)])),
    instrumentals,
    uncoveredLyrics,
    uncoveredNarrative,
    continuity: prev ? {
      sceneNumber: num(prev.scene_number, arr(board.scenes).length),
      title: str(prev.title),
      action: str(prev.action),
      characters: arr(prev.characters).map((c) => str(typeof c === "string" ? c : (c.character_id || c.name))).filter(Boolean),
      location: str(prev.location && typeof prev.location === "object" ? prev.location.location_id : prev.location),
      end: prevWin ? prevWin.end : null,
      lastLine: arr(prev.dialogue).length ? str(arr(prev.dialogue).at(-1)?.line) : "",
      handoff: str(prev.continuity_from_previous_scene || prev.transition_to_next_scene),
    } : null,
  };
}

const listLines = (title, rows, fmt, limit = 6) => {
  if (!rows.length) return null;
  const out = [`- ${title}:`];
  for (const e of rows.slice(0, limit)) out.push(`  · ${e.start}–${e.end}s | ${fmt(e)}`);
  if (rows.length > limit) out.push(`  · …and ${rows.length - limit} more (source ids preserved on the board)`);
  return out.join("\n");
};

/** Render the compact hard/advisory prompt block for a batch. */
export function buildStoryboardPromptBlock(ctx) {
  if (!ctx || !ctx.available) return null;
  const t = ctx.tracks || {};
  const hard = [
    `CINEMATIC STORYBOARD CONTEXT — APPROVED 19-TRACK MASTER TIMELINE (${str(ctx.source)}${ctx.version != null ? ` v${ctx.version}` : ""}; read-only; window ${ctx.from}s–${ctx.to}s).`,
    "HARD TIMING CONSTRAINTS (never violate — the approved source timeline is never edited):",
    `- AUDIO CLOCK: 0–${ctx.durationSec}s. Every scene/shot window stays inside it; never change the original audio duration.`,
    listLines("APPROVED MUSIC STRUCTURE", t.music_structure, (e) => `${str(e.label)} [${e.section || str(e.label)}]`, 8),
    listLines("APPROVED LYRIC WINDOWS — exact, never moved", t.lyrics,
      (e) => `${e.lineId ? `L${e.lineId}${e.occurrence > 1 ? ` occ${e.occurrence}` : ""}: ` : ""}"${str(e.label, 90)}"${e.timingSource ? ` (${e.timingSource})` : ""}`, 10),
    listLines("WORD-LEVEL TIMINGS — lip-sync authority", t.word_timings,
      (e) => `"${str(e.label, 30)}"${e.lineId ? ` (L${e.lineId})` : ""}`, 12),
    listLines("APPROVED SPEAKER EVENTS — keep the speaker", t.speaker_events,
      (e) => `${str(e.label)}${e.characterId ? ` (${e.characterId})` : ""} · ${str(e.kind)}`, 6),
    listLines("APPROVED LIP-SYNC WINDOWS", t.lip_sync,
      (e) => `${str(e.characterId || e.label)}`, 6),
    listLines("APPROVED SUBTITLES — exact text/time", t.subtitles, (e) => `"${str(e.label, 90)}"`, 6),
    `- Instrumental windows: ${ctx.instrumentals.length
      ? ctx.instrumentals.map((e) => `${e.start}–${e.end}s`).join(", ")
      : "(none in this window)"} — stage pure visuals ONLY. No vocals, speech, lyric-driven gesture or lip-sync there.`,
    `- Uncovered approved lyric lines in this window: ${ctx.uncoveredLyrics.length
      ? ctx.uncoveredLyrics.map((l) => `L${l.lineId || l.id} @ ${l.start}s`).join(", ") : "(none)"}. Cover them in this batch without moving their windows.`,
  ].filter(Boolean).join("\n");
  const advisory = [
    "CREATIVE VISUAL GUIDANCE (advisory — never changes a timestamp above):",
    listLines("NARRATIVE EVENTS — cause and effect", t.narrative_events, (e) => str(e.label, 120), 6),
    listLines("CHARACTER APPEARANCES (bible ids only)", t.character_appearances, (e) => str(e.characterId || e.label), 6),
    listLines("CHARACTER ACTIONS — make them visible", t.character_actions,
      (e) => `${str(e.characterId)}: ${str(e.label, 120)}${e.grounded === false ? " (unverified — do not invent details)" : ""}`, 6),
    listLines("EMOTIONS — face / body / atmosphere", t.emotions, (e) => str(e.label), 6),
    listLines("DIALOGUE PERFORMANCE intent", t.dialogue_performance,
      (e) => `${str(e.characterId || "speaker")}: ${str(e.label, 90)}${e.lipSyncRequired ? " (lip-sync)" : ""}`, 6),
    listLines("CHOREOGRAPHY — only when the source has movement", t.choreography, (e) => str(e.label, 100), 4),
    listLines("EXISTING CAMERA INTENT — develop, do not contradict", t.camera_direction,
      (e) => str(e.label || [e.shotType, e.angle, e.movement].filter(Boolean).join(" · ")), 6),
    listLines("SOUND EFFECTS (source events)", t.sound_effects, (e) => str(e.label), 4),
    listLines("LINKED VIDEO ASSETS — reuse, never invent", t.video_assets, (e) => str(e.generationRef || e.label || e.id), 4),
    listLines("TRANSITIONS", t.transitions, (e) => str(e.label), 4),
    ...ctx.instrumentals.map((e) => `- ${e.start}–${e.end}s instrumental: plan ~${e.visualShotsAdvisory} pure visual shot(s) (performance, scenery, camera move). Advisory shot count only.`),
    ctx.uncoveredNarrative.length
      ? `- Uncovered narrative events in this window: ${ctx.uncoveredNarrative.map((e) => str(e.label, 60)).join("; ")}` : null,
    ctx.continuity ? `- CONTINUITY FROM SCENE ${ctx.continuity.sceneNumber} "${str(ctx.continuity.title, 60)}": ${str(ctx.continuity.action, 160) || "(no action)"}${ctx.continuity.characters.length ? ` | chars ${ctx.continuity.characters.join(", ")}` : ""}${ctx.continuity.location ? ` | location ${ctx.continuity.location}` : ""}${ctx.continuity.lastLine ? ` | last line "${str(ctx.continuity.lastLine, 100)}"` : ""}. Start the next scene from this end state — no teleports, wardrobe changes or dropped props.` : null,
  ].filter(Boolean).join("\n");
  return `${hard}\n${advisory}`;
}

// ---------------------------------------------------------------------------
// Honest timeline coverage audit
// ---------------------------------------------------------------------------

function mergedCoverage(scenes) {
  const spans = arr(scenes).map(sceneWindow).filter(Boolean).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const s of spans) {
    const prev = merged.at(-1);
    if (prev && s.start <= prev.end + 0.001) prev.end = Math.max(prev.end, s.end);
    else merged.push({ ...s });
  }
  return merged;
}

/**
 * Report what the plan actually covers. No 100% claim while any required
 * lyric, narrative event, instrumental section or the ending is unplanned.
 */
export function auditStoryboardCoverage({ board = {}, timeline = null } = {}) {
  const tl = timeline && timeline.tracks ? timeline : normalizeStoryboardTimeline({ board });
  const scenes = arr(board?.scenes);
  const duration = tl.durationSec || round(num(board?.input?.song?.durationSeconds, board?.input?.targetSeconds, 0) || 0);
  const merged = mergedCoverage(scenes);
  const plannedDuration = round(merged.reduce((sum, w) => sum + (w.end - w.start), 0));
  const unplannedDuration = round(Math.max(0, duration - plannedDuration));
  const sceneIds = new Set(scenes.flatMap(sceneIdsForLine));
  const lyricEvents = tl.available
    ? arr(tl.tracks.lyrics)
    : directorBoardLyricLines(board).map((l) => ({
      id: `lyric-${num(l.lyric_line_id)}`, lineId: num(l.lyric_line_id),
      start: round(num(l.song_start_time, 0)), end: round(num(l.song_end_time, 0)), label: str(l.lyric_text),
    }));
  const lyricCovered = [];
  const lyricUncovered = [];
  for (const e of lyricEvents) {
    const covered = (e.lineId != null && sceneIds.has(num(e.lineId)))
      || scenes.some((s) => {
        const w = sceneWindow(s);
        return w && overlapSec(w, e) >= Math.min(0.6, (e.end - e.start) * 0.5);
      });
    (covered ? lyricCovered : lyricUncovered).push({
      id: e.id, lineId: e.lineId ?? null, start: e.start, end: e.end, label: str(e.label),
    });
  }
  const narrativeEvents = arr(tl.tracks?.narrative_events);
  const narrativeCovered = [];
  const narrativeUncovered = [];
  for (const e of narrativeEvents) {
    const line = num(e.sourceLine);
    const covered = (line > 0 && sceneIds.has(line)) || scenes.some((s) => {
      const w = sceneWindow(s);
      return w && overlapSec(w, e) >= Math.min(0.6, (e.end - e.start) * 0.5);
    });
    (covered ? narrativeCovered : narrativeUncovered).push({ id: e.id, start: e.start, end: e.end, label: str(e.label) });
  }
  const instrumentals = arr(tl.tracks?.music_structure).filter((e) => isInstrumentalLabel(e.label));
  const instrumentalCovered = [];
  const instrumentalUncovered = [];
  for (const e of instrumentals) {
    const hit = scenes.some((s) => {
      const w = sceneWindow(s);
      return w && overlapSec(w, e) >= 0.5;
    });
    (hit ? instrumentalCovered : instrumentalUncovered).push({ id: e.id, start: e.start, end: e.end, label: str(e.label) });
  }
  const overlapsFound = [];
  const sorted = scenes.map((s, i) => ({ n: num(s.scene_number, i + 1), ...(sceneWindow(s) || {}) }))
    .filter((s) => s.start != null).sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start + 0.01 < sorted[i - 1].end) {
      overlapsFound.push({ scene: sorted[i].n, start: sorted[i].start, end: Math.min(sorted[i].end, sorted[i - 1].end) });
    }
  }
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const gap = round(sorted[i].start - sorted[i - 1].end);
    if (gap <= 0.5) continue;
    const intentional = instrumentals.some((e) => overlapSec(e, { start: sorted[i - 1].end, end: sorted[i].start }) >= gap - 0.1)
      || /intentional|visual pause|silence/i.test(str(sorted[i].title));
    gaps.push({ from: round(sorted[i - 1].end), to: sorted[i].start, seconds: gap, intentional });
  }
  const bibleIds = {
    characters: new Set(arr(board?.blueprint?.characters).map((c) => str(c.character_id))),
    locations: new Set(arr(board?.blueprint?.locations).map((l) => str(l.location_id))),
    objects: new Set(arr(board?.blueprint?.objects).map((o) => str(o.object_id))),
  };
  const continuityWarnings = [];
  if (board?.input?.chainContinuity === true) {
    for (const s of scenes) {
      if (!str(s.continuity_from_previous_scene) && num(s.scene_number, 0) > 1) {
        continuityWarnings.push(`scene ${num(s.scene_number)}: connected board has no continuity_from_previous_scene`);
      }
    }
  }
  for (const s of scenes) {
    for (const c of arr(s.characters)) {
      const id = str(typeof c === "string" ? c : (c.character_id || c.name));
      if (id && !bibleIds.characters.has(id)) continuityWarnings.push(`scene ${num(s.scene_number)}: character "${id}" is not in the Story Bible`);
    }
    const loc = str(s.location && typeof s.location === "object" ? s.location.location_id : s.location);
    if (loc && !bibleIds.locations.has(loc)) continuityWarnings.push(`scene ${num(s.scene_number)}: location "${loc}" is not in the Story Bible`);
    for (const sh of arr(s.shots)) for (const c of arr(sh.characters)) {
      const id = str(typeof c === "string" ? c : (c.character_id || c.name));
      if (id && !bibleIds.characters.has(id)) continuityWarnings.push(`shot ${str(sh.shot_id)}: character "${id}" is not in the Story Bible`);
    }
  }
  const speakerEvents = arr(tl.tracks?.speaker_events);
  const speakersNeedingVisual = speakerEvents.filter((e) => scenes.some((s) => {
    const w = sceneWindow(s);
    return w && overlaps(w, e, 0.05);
  })).map((e) => ({ id: e.id, start: e.start, end: e.end, label: str(e.label), characterId: str(e.characterId) }));
  const endingSegment = lyricEvents.at(-1) || arr(tl.tracks?.original_audio).at(-1) || null;
  const endingTarget = duration || num(endingSegment?.end, 0);
  const lastEnd = sorted.length ? Math.max(...sorted.map((s) => s.end)) : 0;
  const endingCovered = endingTarget > 0 ? lastEnd >= endingTarget - Math.max(0.75, endingTarget * 0.01) : scenes.length > 0;
  const requiredUnits = lyricEvents.length + narrativeEvents.length + instrumentals.length + (endingTarget > 0 ? 1 : 0);
  const coveredUnits = lyricCovered.length + narrativeCovered.length + instrumentalCovered.length + (endingCovered ? 1 : 0);
  const coveragePercent = requiredUnits > 0 ? Math.round((coveredUnits / requiredUnits) * 100) : 0;
  return {
    timingAuthority: tl.source,
    approved: tl.approved,
    available: tl.available,
    totalAudioDuration: round(duration),
    plannedDuration,
    unplannedDuration,
    durationCoveragePercent: duration > 0 ? Math.round((plannedDuration / duration) * 100) : 0,
    coveragePercent,
    complete: coveragePercent === 100 && unplannedDuration <= 0.75 && !lyricUncovered.length
      && !narrativeUncovered.length && !instrumentalUncovered.length && endingCovered,
    coveredLyricEvents: lyricCovered,
    uncoveredLyricEvents: lyricUncovered,
    coveredNarrativeEvents: narrativeCovered,
    uncoveredNarrativeEvents: narrativeUncovered,
    instrumentalCoverage: {
      total: instrumentals.length, covered: instrumentalCovered.length,
      coveredWindows: instrumentalCovered, uncoveredWindows: instrumentalUncovered,
    },
    speakerEventsNeedingVisual: speakersNeedingVisual,
    sceneCount: scenes.length,
    shotCount: scenes.reduce((n, s) => n + arr(s.shots).length, 0),
    overlaps: overlapsFound,
    gaps,
    intentionalGaps: gaps.filter((g) => g.intentional),
    continuityWarnings: [...new Set(continuityWarnings)],
    endingCovered,
    note: tl.available
      ? "Audit uses the approved 19-track timeline as the timing authority; source timestamps are never modified."
      : "No approved timeline — audited against the board's own story/lyric lines (existing fallback).",
  };
}

// ---------------------------------------------------------------------------
// Pre-approval validation — critical errors vs advisory warnings
// ---------------------------------------------------------------------------

export function validateStoryboardForApproval({ board = {}, timeline = null, audit = null } = {}) {
  const tl = timeline && timeline.tracks ? timeline : normalizeStoryboardTimeline({ board });
  const report = audit || auditStoryboardCoverage({ board, timeline: tl });
  const scenes = arr(board?.scenes);
  const errors = [];
  const warnings = [];
  const pushError = (code, message) => errors.push({ code, message });
  const pushWarning = (code, message) => warnings.push({ code, message });
  if (!scenes.length) pushError("NO_SCENES", "Nothing to approve — generate scenes first.");
  if (tl.available) {
    if (!report.endingCovered) pushError("ENDING_UNCOVERED", "The final scene does not reach the intended ending of the audio.");
    if (report.unplannedDuration > 0.75) {
      pushError("INCOMPLETE_AUDIO_COVERAGE", `${report.unplannedDuration}s of the approved audio duration is unplanned.`);
    }
    for (const e of report.uncoveredLyricEvents) {
      pushError("LYRIC_UNCOVERED", `${e.lineId ? `Lyric L${e.lineId}` : `Lyric ${e.id}`} has no scene/shot covering "${str(e.label, 60)}".`);
    }
    for (const e of report.uncoveredNarrativeEvents) {
      pushError("NARRATIVE_UNCOVERED", `Narrative event "${str(e.label, 60)}" is not represented.`);
    }
    for (const e of report.instrumentalCoverage.uncoveredWindows) {
      pushError("INSTRUMENTAL_UNPLANNED", `Instrumental section ${e.start}s–${e.end}s has no visual plan.`);
    }
    // Approved windows must be preserved exactly wherever a scene/shot declares one.
    const lyricById = new Map(arr(tl.tracks.lyrics).map((e) => [num(e.lineId), e]));
    for (const s of scenes) {
      const nodes = [s, ...arr(s.shots)];
      for (const node of nodes) {
        const id = num(node?.lyric_line_id ?? node?.parent_line_id);
        const approved = lyricById.get(id);
        const w = sceneWindow(node);
        if (!approved || !w) continue;
        if (Math.abs(w.start - approved.start) > 0.05 || Math.abs(w.end - approved.end) > 0.05) {
          pushError("APPROVED_TIMING_CHANGED", `${str(node.shot_id) || `scene ${num(s.scene_number)}`} uses ${w.start}s–${w.end}s but lyric L${id} is approved at ${approved.start}s–${approved.end}s.`);
        }
      }
    }
    const instrumentals = arr(tl.tracks.music_structure).filter((e) => isInstrumentalLabel(e.label));
    for (const s of scenes) {
      const w = sceneWindow(s);
      const singingHere = instrumentals.some((e) => w && overlaps(w, e, 0.05));
      const spokenInInstrumental = singingHere && [s, ...arr(s.shots)].some((node) => arr(node?.dialogue).some((d) => str(d?.line)));
      const lipInInstrumental = singingHere && arr(s.shots).some((sh) => sh.lip_sync_required === true);
      if (spokenInInstrumental || lipInInstrumental) {
        pushError("SINGING_IN_INSTRUMENTAL", `scene ${num(s.scene_number)} places speech/lip-sync inside an instrumental window.`);
      }
    }
    const speakers = arr(tl.tracks.speaker_events);
    for (const s of scenes) {
      const w = sceneWindow(s);
      const allowed = new Set(speakers.filter((e) => w && overlaps(w, e, 0.05)).map((e) => str(e.characterId || e.label)).filter(Boolean));
      for (const d of [s, ...arr(s.shots)].flatMap((node) => arr(node?.dialogue))) {
        const speaker = str(d?.speaker);
        if (!speaker) continue;
        if (allowed.size && !allowed.has(speaker)) {
          pushError("SPEAKER_MISMATCH", `scene ${num(s.scene_number)} assigns "${speaker}" outside their approved speaker event.`);
        }
        if (!allowed.size) pushWarning("SPEAKER_UNVERIFIED", `scene ${num(s.scene_number)} speaker "${speaker}" has no approved speaker event in this window.`);
      }
    }
  } else {
    pushWarning("NO_APPROVED_TIMELINE", "No approved timeline — timing checks are advisory only; the existing story-only fallback applies.");
  }
  const bible = {
    characters: new Set(arr(board?.blueprint?.characters).map((c) => str(c.character_id))),
    locations: new Set(arr(board?.blueprint?.locations).map((l) => str(l.location_id))),
    objects: new Set(arr(board?.blueprint?.objects).map((o) => str(o.object_id))),
  };
  const keyOf = (s) => `${str(s.title).toLowerCase()}|${str(s.action).toLowerCase()}`;
  const seen = new Set();
  const sceneNums = new Set();
  for (const [i, s] of scenes.entries()) {
    const n = num(s.scene_number, i + 1);
    if (sceneNums.has(n)) pushError("DUPLICATE_SCENE_NUMBER", `scene number ${n} appears more than once.`);
    sceneNums.add(n);
    const key = keyOf(s);
    if (seen.has(key)) pushError("DUPLICATE_SCENE", `scene ${n} repeats the title and action of an earlier scene.`);
    seen.add(key);
    const w = sceneWindow(s);
    if (!w) pushError("BAD_SCENE_TIMING", `scene ${n} has no valid start/end window.`);
    else if (tl.available && (w.start < -0.01 || w.end > tl.durationSec + 0.05)) {
      pushError("OUTSIDE_AUDIO_CLOCK", `scene ${n} window is outside the approved audio clock.`);
    }
    for (const c of arr(s.characters)) {
      const id = str(typeof c === "string" ? c : (c.character_id || c.name));
      if (id && !bible.characters.has(id)) pushError("UNRESOLVED_CHARACTER", `scene ${n} character "${id}" does not resolve to a Story Bible id.`);
    }
    const loc = str(s.location && typeof s.location === "object" ? s.location.location_id : s.location);
    if (loc && !bible.locations.has(loc)) pushError("UNRESOLVED_LOCATION", `scene ${n} location "${loc}" does not resolve to a Story Bible id.`);
    for (const o of arr(s.objects)) {
      const id = str(typeof o === "string" ? o : (o.object_id || o.name));
      if (id && !bible.objects.has(id)) pushWarning("UNRESOLVED_OBJECT", `scene ${n} object "${id}" does not resolve to a Story Bible id.`);
    }
    const shotTotal = arr(s.shots).reduce((sum, sh) => sum + Math.max(0, num(sh.duration_seconds, 0)), 0);
    if (arr(s.shots).length && w && Math.abs(shotTotal - (w.end - w.start)) > 0.25) {
      pushError("SHOT_TIMING_MISMATCH", `scene ${n} shots total ${round(shotTotal)}s, scene is ${round(w.end - w.start)}s.`);
    }
    for (const sh of arr(s.shots)) {
      const parent = str(sh.parent_scene_id || sh.scene_id);
      if (parent && num(parent.replace(/[^\d]/g, "")) !== n && parent !== str(s.scene_id)) {
        pushError("ORPHAN_SHOT", `shot ${str(sh.shot_id)} does not belong to scene ${n}.`);
      }
      for (const c of arr(sh.characters)) {
        const id = str(typeof c === "string" ? c : (c.character_id || c.name));
        if (id && !bible.characters.has(id)) pushError("UNRESOLVED_CHARACTER", `shot ${str(sh.shot_id)} character "${id}" does not resolve to a Story Bible id.`);
      }
    }
  }
  for (const msg of validateBibleAnatomy(board?.blueprint)) pushError("BROKEN_BODY_PLAN", msg);
  for (const warning of report.continuityWarnings) pushWarning("CONTINUITY", warning);
  for (const overlap of report.overlaps) {
    pushWarning("SCENE_OVERLAP", `scene ${overlap.scene} overlaps an earlier scene near ${overlap.start}s.`);
  }
  for (const gap of report.gaps) {
    if (gap.intentional) pushWarning("INTENTIONAL_GAP", `${gap.seconds}s visual gap ${gap.from}s–${gap.to}s is marked intentional — review that this is desired.`);
    else pushWarning("UNPLANNED_GAP", `${gap.seconds}s gap ${gap.from}s–${gap.to}s is not represented by any scene.`);
  }
  const checks = {
    durationCovered: !tl.available || report.unplannedDuration <= 0.75,
    lyricsRepresented: !tl.available || report.uncoveredLyricEvents.length === 0,
    approvedTimestampsPreserved: !errors.some((e) => e.code === "APPROVED_TIMING_CHANGED"),
    instrumentalsHandled: !tl.available || report.instrumentalCoverage.uncoveredWindows.length === 0,
    bibleIdsResolve: !errors.some((e) => e.code === "UNRESOLVED_CHARACTER" || e.code === "UNRESOLVED_LOCATION"),
    bodyPlansValid: !errors.some((e) => e.code === "BROKEN_BODY_PLAN"),
    noDuplicates: !errors.some((e) => e.code === "DUPLICATE_SCENE" || e.code === "DUPLICATE_SCENE_NUMBER"),
    timingsValid: !errors.some((e) => e.code === "BAD_SCENE_TIMING" || e.code === "SHOT_TIMING_MISMATCH" || e.code === "OUTSIDE_AUDIO_CLOCK"),
    dialogueAssigned: !errors.some((e) => e.code === "SPEAKER_MISMATCH" || e.code === "SINGING_IN_INSTRUMENTAL"),
    shotsBelongToScenes: !errors.some((e) => e.code === "ORPHAN_SHOT"),
    endingCovered: !tl.available || report.endingCovered,
  };
  return { canApprove: errors.length === 0, errors, warnings, checks, coverage: report };
}

// ---------------------------------------------------------------------------
// AI Director handoff — references + plans, never a copy of the audio/timeline
// ---------------------------------------------------------------------------

/** Read-only workspace snapshot: scene cards + 19-track view + honest audit. */
export function buildStoryboardView({ board = {}, timeline = null, audit = null } = {}) {
  const tl = timeline && timeline.tracks ? timeline : normalizeStoryboardTimeline({ board });
  const report = audit || auditStoryboardCoverage({ board, timeline: tl });
  const handoff = buildDirectorHandoff({ board, timeline: tl, audit: report });
  return {
    schema: "storyboard-view/1",
    board_id: str(board.id),
    status: str(board.status) || "unknown",
    title: str(board.input?.title || board.title),
    sceneCount: arr(board.scenes).length,
    phases: [...STORYBOARD_PHASES],
    timeline: {
      source: tl.source,
      id: tl.id,
      version: tl.version,
      approvedAt: tl.approvedAt,
      durationSec: tl.durationSec,
      approved: tl.approved,
      available: tl.available,
      readOnly: true,
      trackCounts: { ...tl.trackCounts },
      tracks: tl.tracks,
    },
    scenes: handoff.scene_timeline,
    coverage: {
      complete: report.complete,
      coveragePercent: report.coveragePercent,
      durationCoveragePercent: report.durationCoveragePercent,
      totalAudioDuration: report.totalAudioDuration,
      plannedDuration: report.plannedDuration,
      unplannedDuration: report.unplannedDuration,
      sceneCount: report.sceneCount,
      shotCount: report.shotCount,
      uncoveredLyricEvents: report.uncoveredLyricEvents,
      uncoveredNarrativeEvents: report.uncoveredNarrativeEvents,
      instrumentalCoverage: report.instrumentalCoverage,
      gaps: report.gaps,
      overlaps: report.overlaps,
      continuityWarnings: report.continuityWarnings,
      endingCovered: report.endingCovered,
    },
    note: tl.note,
  };
}

export function buildDirectorHandoff({ board = {}, timeline = null, audit = null } = {}) {
  const tl = timeline && timeline.tracks ? timeline : normalizeStoryboardTimeline({ board });
  const report = audit || auditStoryboardCoverage({ board, timeline: tl });
  const scenes = arr(board.scenes);
  return {
    schema: "storyboard-handoff/1",
    source: tl.source,
    timeline_reference: {
      id: tl.id, version: tl.version, approved_at: tl.approvedAt,
      durationSec: tl.durationSec, readOnly: true,
      trackCounts: tl.trackCounts,
    },
    story_bible: {
      logline: str(board.blueprint?.logline),
      characters: arr(board.blueprint?.characters).map((c) => ({ id: str(c.character_id), name: str(c.name), visual_identity_prompt: str(c.visual_identity_prompt) })),
      locations: arr(board.blueprint?.locations).map((l) => ({ id: str(l.location_id), name: str(l.name), visual_identity_prompt: str(l.visual_identity_prompt) })),
      objects: arr(board.blueprint?.objects).map((o) => ({ id: str(o.object_id), name: str(o.name), visual_identity_prompt: str(o.visual_identity_prompt) })),
    },
    scene_timeline: scenes.map((s) => ({
      scene_number: num(s.scene_number), title: str(s.title),
      start: sceneWindow(s)?.start ?? null, end: sceneWindow(s)?.end ?? null,
      duration: num(s.duration_seconds, sceneWindow(s) ? sceneWindow(s).end - sceneWindow(s).start : 0),
      characters: arr(s.characters).map((c) => str(typeof c === "string" ? c : (c.character_id || c.name))),
      location: str(s.location && typeof s.location === "object" ? s.location.location_id : s.location),
      objects: arr(s.objects).map((o) => str(typeof o === "string" ? o : (o.object_id || o.name))),
      action: str(s.action), emotion: str(s.emotion), expression: str(s.expression),
      camera: s.camera && typeof s.camera === "object" ? { ...s.camera } : null,
      lighting: str(s.lighting), environment: str(s.environment),
      source_line_ids: sceneIdsForLine(s),
      audio_timing_references: arr(tl.tracks.lyrics).filter((e) => sceneIdsForLine(s).includes(num(e.lineId)))
        .map((e) => ({ id: e.id, start: e.start, end: e.end })),
      image_prompt: str(s.image_prompt), video_prompt: str(s.video_prompt),
      continuity: {
        from_previous: str(s.continuity_from_previous_scene),
        to_next: str(s.transition_to_next_scene),
        instructions: str(s.visual_continuity_instructions || s.continuity_instructions),
      },
      transition: str(s.transition_to_next_scene),
      timing_source: str(s.timing_source) || null,
      shots: arr(s.shots).map((sh) => ({
        shot_id: str(sh.shot_id), parent_scene: num(s.scene_number),
        start: sceneWindow(sh)?.start ?? null, end: sceneWindow(sh)?.end ?? null,
        shot_type: str(sh.camera?.shot_type), angle: str(sh.camera?.angle), movement: str(sh.camera?.movement),
        characters: arr(sh.characters).map((c) => str(typeof c === "string" ? c : (c.character_id || c.name))),
        action: str(sh.action), expression: str(sh.expression), emotion: str(sh.emotion),
        lighting: str(sh.lighting), environment: str(sh.environment),
        visual_focus: str(sh.visual_focus || sh.visual_focus_character),
        image_prompt: str(sh.image_prompt), video_prompt: str(sh.video_prompt),
        source_line_ids: sceneIdsForLine(sh),
        lip_sync_required: sh.lip_sync_required === true || arr(sh.dialogue).some((d) => str(d?.line)),
        audio_timing_references: arr(tl.tracks.lyrics).filter((e) => sceneIdsForLine(sh).includes(num(e.lineId)))
          .map((e) => ({ id: e.id, start: e.start, end: e.end })),
      })),
    })),
    lip_sync_requirements: arr(tl.tracks.lip_sync).map((e) => ({
      id: e.id, start: e.start, end: e.end, characterId: str(e.characterId || e.label),
    })),
    audio_timing_references: arr(tl.tracks.lyrics).map((e) => ({
      id: e.id, lineId: e.lineId ?? null, start: e.start, end: e.end,
    })),
    coverage_summary: {
      complete: report.complete, coveragePercent: report.coveragePercent,
      totalAudioDuration: report.totalAudioDuration, plannedDuration: report.plannedDuration,
      sceneCount: report.sceneCount, shotCount: report.shotCount,
      continuityWarnings: report.continuityWarnings,
    },
    note: "Additive handoff description only — the existing boardToScenario/AI Director engine is used unchanged; no source timeline data is copied or rewritten.",
  };
}
