// ---------------------------------------------------------------------------
// Sanskriti KIDS — Master 19-track timeline VIEW adapter (pure).
//
// This module does NOT analyze audio, generate events, or touch any database.
// It only MAPS the already-approved `MasterTimelineResponse` (the single
// source of truth used by the Audio Intelligence panel) onto renderable
// timeline blocks, plus a few pure helpers for the DAW ruler / virtualization.
//
// Every event keeps its original id (prefixed with its track id) and its
// untouched source row in `meta.raw`, so nothing is silently changed.
// ---------------------------------------------------------------------------

/** The 19 canonical tracks, in the exact order required by the studio. */
export const TIMELINE_VIEW_TRACKS = Object.freeze([
  { id: "original_audio", number: 1, name: "Original Audio", color: "#3b82f6", group: "audio" },
  { id: "music_structure", number: 2, name: "Music Structure", color: "#64748b", group: "audio" },
  { id: "lyrics", number: 3, name: "Lyrics", color: "#3b82f6", group: "text" },
  { id: "word_timings", number: 4, name: "Word Timings", color: "#7dd3fc", group: "text" },
  { id: "speaker_events", number: 5, name: "Speaker Events", color: "#60a5fa", group: "text" },
  { id: "narrative_events", number: 6, name: "Narrative Events", color: "#f59e0b", group: "narrative" },
  { id: "character_appearances", number: 7, name: "Character Appearances", color: "#fbbf24", group: "narrative" },
  { id: "character_actions", number: 8, name: "Character Actions", color: "#a78bfa", group: "narrative" },
  { id: "emotions", number: 9, name: "Emotions", color: "#fbbf24", group: "narrative" },
  { id: "dialogue_performance", number: 10, name: "Dialogue Performance", color: "#c084fc", group: "performance" },
  { id: "choreography", number: 11, name: "Choreography", color: "#8b5cf6", group: "performance" },
  { id: "camera_direction", number: 12, name: "Camera Direction", color: "#14b8a6", group: "direction" },
  { id: "scene_timeline", number: 13, name: "Scene Timeline", color: "#22c55e", group: "direction" },
  { id: "shot_timeline", number: 14, name: "Shot Timeline", color: "#16a34a", group: "direction" },
  { id: "lip_sync", number: 15, name: "Lip-Sync", color: "#a78bfa", group: "performance" },
  { id: "sound_effects", number: 16, name: "Sound Effects", color: "#94a3b8", group: "assets" },
  { id: "video_assets", number: 17, name: "Video Assets", color: "#64748b", group: "assets" },
  { id: "transitions", number: 18, name: "Transitions", color: "#6b7280", group: "assets" },
  { id: "subtitles", number: 19, name: "Subtitles", color: "#60a5fa", group: "text" },
]);

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => String(v ?? "").trim();
const num = (v, fb = null) => (v == null || v === "" || !Number.isFinite(Number(v)) ? fb : Number(v));
const pos = (v, fb = null) => {
  const n = num(v, null);
  return n != null && n > 0 ? n : fb;
};

/** HH:MM:SS.mmm — the same clock display used by the ruler and the toolbar. */
export function formatTimecode(seconds, withMs = true) {
  const s = Math.max(0, num(seconds, 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const base = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  if (!withMs) return base;
  return `${base}.${String(Math.floor((s - Math.floor(s)) * 1000)).padStart(3, "0")}`;
}

/**
 * Adaptive ruler spacing. Major ticks land ~110 px apart at any zoom so the
 * labels never collide; minor ticks are a fifth of a major tick.
 */
export function timelineTickStep(pxPerSec, viewportWidth = 900) {
  const target = Math.max(70, Math.min(160, (Number(viewportWidth) || 900) / 7));
  const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const pps = Math.max(0.01, num(pxPerSec, 10));
  return steps.find((s) => s * pps >= target) || steps[steps.length - 1];
}

/**
 * Ruler tick list. `time` is in seconds on the SAME axis as every event.
 * Capped at ~2k marks so a 10-hour WAV never explodes the DOM at high zoom.
 */
export function buildRulerTicks(duration, pxPerSec, viewportWidth = 900) {
  const major = timelineTickStep(pxPerSec, viewportWidth);
  let minor = major / 5;
  if (duration / minor > 2000) minor = duration / 2000;
  const ticks = [];
  const count = Math.floor(duration / minor + 1e-6);
  for (let i = 0; i <= count && ticks.length < 2001; i += 1) {
    const time = i * minor;
    const isMajor = major > 0 && Math.abs(time / major - Math.round(time / major)) < 1e-4;
    ticks.push({ time, major: isMajor, label: isMajor ? formatTimecode(time, major < 1) : "" });
  }
  return ticks;
}

/** Events intersecting [start, end] (with optional overscan for smooth scroll). */
export function visibleEvents(events, start, end, pad = 0) {
  const from = num(start, 0) - Math.max(0, num(pad, 0));
  const to = num(end, 0) + Math.max(0, num(pad, 0));
  return arr(events).filter((e) => e && e.end >= from && e.start <= to);
}

/**
 * Convert a MasterTimelineResponse into 19 renderable lanes.
 * Options: { duration, frameRate, version, hasAudio, audioFileName }.
 */
export function buildTimelineView(response, options = {}) {
  const master = response?.master && typeof response.master === "object" ? response.master : null;
  const timeline = response?.timeline && typeof response.timeline === "object" ? response.timeline : null;
  const duration = Math.max(
    0,
    pos(master?.duration_seconds, null)
    ?? pos(response?.duration_seconds, null)
    ?? pos(timeline?.duration_seconds, null)
    ?? pos(options.duration, 0),
  );
  const frameRate = pos(master?.frame_rate, null) ?? pos(response?.frame_rate, null)
    ?? pos(timeline?.frame_rate, null) ?? pos(options.frameRate, 30);
  const version = pos(options.version, null) ?? pos(master?.version, null)
    ?? pos(response?.version, null) ?? pos(timeline?.version, null) ?? 0;

  const segments = arr(master?.segments);
  const lines = arr(timeline?.lines);
  const clips = arr(master?.clips);
  const sceneMap = arr(timeline?.scene_map);
  const actions = arr(timeline?.actions);

  const buckets = {};
  for (const t of TIMELINE_VIEW_TRACKS) buckets[t.id] = [];
  const add = (trackId, startRaw, endRaw, label, detail = "", meta = {}) => {
    const start = num(startRaw, null);
    const end = num(endRaw, null);
    if (start == null || end == null || end <= start || duration <= 0) return;
    const from = Math.max(0, Math.min(duration, start));
    const to = Math.max(0, Math.min(duration, end));
    if (to <= from) return;
    const sourceId = str(meta.sourceId);
    buckets[trackId].push({
      id: sourceId ? `${trackId}/${sourceId}` : `${trackId}/${buckets[trackId].length + 1}`,
      trackId,
      start: from,
      end: to,
      label: str(label) || `${trackId} event`,
      detail: str(detail),
      meta,
    });
  };

  // 01 Original Audio — one authoritative block covering the whole WAV.
  if (options.hasAudio) {
    add("original_audio", 0, duration, options.audioFileName || "Original Audio",
      `Authoritative audio clock · ${duration.toFixed(3)}s @ ${frameRate} fps`,
      { sourceId: "original", authoritative: true, raw: { duration } });
  }

  // 02 Music Structure — the derived chronological segment list.
  for (const s of segments) {
    if (!s || typeof s !== "object") continue;
    add("music_structure", s.start_seconds, s.end_seconds,
      `${str(s.type) || "segment"}${str(s.speaker) ? ` · ${s.speaker}` : ""}`,
      `${str(s.lyric_text) || str(s.heard_text) || "no transcript"} · ${str(s.timing_source) || "unknown timing"}`,
      { sourceId: s.segment_id, kind: s.type, confidence: s.confidence, timing: s.timing_source, raw: s });
  }

  // 03 Lyrics + 04 Word Timings + 19 Subtitles — the user's own lines.
  for (const line of lines) {
    if (!line || typeof line !== "object") continue;
    const sid = line.line_id;
    const lyric = str(line.lyric_text);
    const lineMeta = { sourceId: sid, line: sid, timing: line.timing, confidence: line.confidence, raw: line };
    add("lyrics", line.start_seconds, line.end_seconds, lyric || `Line ${sid}`,
      `Line ${sid} · occurrence ${line.occurrence ?? 1} · ${str(line.timing) || "unknown"} timing`,
      lineMeta);
    add("subtitles", line.start_seconds, line.end_seconds, lyric || `Line ${sid}`,
      `Subtitle ${sid} · ${str(line.language) || "language unknown"}`,
      lineMeta);
    for (const w of arr(line.words)) {
      if (!w || typeof w !== "object") continue;
      add("word_timings", w.start_seconds, w.end_seconds, str(w.word) || "word",
        `Line ${sid} · word ${w.word_index ?? "?"} · ${str(w.timing) || "unknown"}`,
        { sourceId: `${sid}-w${w.word_index ?? "?"}`, line: sid, timing: w.timing, confidence: w.confidence, raw: w });
    }
  }

  // 05 Speaker Events + 08 Actions + 09 Emotions + 10 Dialogue + 12 Camera.
  const vocal = [];
  const firstSeen = new Map();
  for (const s of segments) {
    if (!s || typeof s !== "object") continue;
    const sid = str(s.segment_id);
    const character = str(s.character_id);
    if (character && !firstSeen.has(character)) firstSeen.set(character, { start: s.start_seconds, end: s.end_seconds, raw: s });
    else if (character) {
      const seen = firstSeen.get(character);
      seen.start = Math.min(num(seen.start, 0), num(s.start_seconds, 0));
      seen.end = Math.max(num(seen.end, 0), num(s.end_seconds, 0));
    }
    const base = { sourceId: sid, character, segment: sid, raw: s };
    if (str(s.speaker)) add("speaker_events", s.start_seconds, s.end_seconds,
      s.speaker, `${str(s.type) || "segment"} · ${str(s.lyric_text) || str(s.heard_text) || ""}`,
      { ...base, dialogue: str(s.lyric_text) || str(s.heard_text) });
    if (str(s.action)) add("character_actions", s.start_seconds, s.end_seconds,
      s.action, `${character || "unknown character"} · ${str(s.location) || "location unknown"}`,
      { ...base, action: s.action, grounded: s.low_confidence === false });
    if (str(s.expression)) add("emotions", s.start_seconds, s.end_seconds,
      s.expression, `${character || "unknown character"} · expression`,
      { ...base, emotion: s.expression });
    if (s.type === "singing" || s.type === "dialogue" || s.type === "mixed") {
      vocal.push(s);
      add("dialogue_performance", s.start_seconds, s.end_seconds,
        str(s.lyric_text) || str(s.heard_text) || `${s.type} performance`,
        `${character || "unknown speaker"} · ${s.type}${str(s.speaker) ? ` · ${s.speaker}` : ""}`,
        { ...base, dialogue: str(s.lyric_text) || str(s.heard_text) });
    }
    const cam = s.camera && typeof s.camera === "object" ? s.camera : null;
    if (cam) add("camera_direction", s.start_seconds, s.end_seconds,
      [cam.shot_type, cam.angle, cam.movement].filter(Boolean).map(str).join(" · ") || "camera direction",
      str(cam.rationale) || `Camera for segment ${sid}`,
      { ...base, camera: cam });
  }

  // 07 Character Appearances — one span per distinct character (never invented).
  let ci = 0;
  for (const [character, win] of firstSeen) {
    ci += 1;
    add("character_appearances", win.start, win.end, character,
      "Appears in the derived master segments",
      { sourceId: `character-${ci}`, character, raw: win.raw });
  }

  // 15 Lip-Sync — only measured word windows of vocal segments.
  for (const s of vocal) {
    for (const w of arr(s.words)) {
      if (!w || typeof w !== "object") continue;
      add("lip_sync", w.start_seconds, w.end_seconds, str(w.word) || "word",
        `${str(s.character_id) || "unknown speaker"} · ${str(s.segment_id)}`,
        { sourceId: `${s.segment_id}-lip-${w.word_index ?? "?"}`, character: s.character_id, raw: w });
    }
  }

  // 06 Narrative Events — semantic actions from the lyric timeline.
  for (const a of actions) {
    if (!a || typeof a !== "object") continue;
    add("narrative_events", a.start_seconds, a.end_seconds,
      str(a.action) || str(a.meaning) || str(a.lyric) || `Line ${a.line_id}`,
      `${str(a.meaning) || "no meaning recorded"} · line ${a.line_id ?? "?"}${a.grounded === false ? " · ungrounded" : ""}`,
      { sourceId: a.line_id != null ? `action-${a.line_id}-${a.occurrence ?? 1}` : undefined,
        line: a.line_id, scene: a.scene_number, shot: a.shot_id, action: a.action, raw: a });
  }

  // 13 Scene Timeline — grouped by the storyboard's own scene number.
  const scenes = new Map();
  for (const row of sceneMap) {
    if (!row || typeof row !== "object" || row.scene_number == null) continue;
    const key = String(row.scene_number);
    const cur = scenes.get(key) || { start: row.start_seconds, end: row.end_seconds, raw: row };
    cur.start = Math.min(num(cur.start, Infinity), num(row.start_seconds, Infinity));
    cur.end = Math.max(num(cur.end, -Infinity), num(row.end_seconds, -Infinity));
    scenes.set(key, cur);
  }
  for (const [scene, win] of scenes) {
    add("scene_timeline", win.start, win.end, `Scene ${scene}`,
      "Window from the rendered storyboard", { sourceId: `scene-${scene}`, scene, raw: win.raw });
  }

  // 14 Shot Timeline — the approved clip windows (or the board's shot rows).
  if (clips.length) {
    for (const c of clips) {
      if (!c || typeof c !== "object") continue;
      add("shot_timeline", c.start_seconds, c.end_seconds,
        str(c.clip_id) || "clip", `${str(c.kind) || "clip"} · ${str(c.lyric_text) || "no dialogue"}`,
        { sourceId: c.clip_id, shot: c.clip_id, character: c.character_id, raw: c });
    }
  } else {
    const shots = new Map();
    for (const row of sceneMap) {
      const shot = str(row.shot_id);
      if (!shot) continue;
      const cur = shots.get(shot) || { start: row.start_seconds, end: row.end_seconds, raw: row };
      cur.start = Math.min(num(cur.start, Infinity), num(row.start_seconds, Infinity));
      cur.end = Math.max(num(cur.end, -Infinity), num(row.end_seconds, -Infinity));
      shots.set(shot, cur);
    }
    for (const [shot, win] of shots) {
      add("shot_timeline", win.start, win.end, shot, "Shot window from the storyboard",
        { sourceId: shot, shot, raw: win.raw });
    }
  }

  // 18 Transitions — the cut between two consecutive real clip windows.
  for (let i = 1; i < clips.length; i += 1) {
    const prev = clips[i - 1];
    const next = clips[i];
    if (!prev || !next) continue;
    const at = (num(prev.end_seconds, 0) + num(next.start_seconds, 0)) / 2;
    const half = Math.min(0.2, Math.max(0.02, duration / 2000));
    add("transitions", at - half, at + half, "Cut", `Clip ${i} → clip ${i + 1}`,
      { sourceId: `transition-${i}`, raw: { from: prev.clip_id, to: next.clip_id, at } });
  }

  // 11 Choreography, 16 Sound Effects, 17 Video Assets: the server does not
  // emit these rows. They stay as visible, EMPTY lanes — never fabricated.
  const tracks = TIMELINE_VIEW_TRACKS.map((t) => ({
    ...t,
    events: buckets[t.id].sort((a, b) => a.start - b.start || a.end - b.end),
    count: buckets[t.id].length,
  }));
  const flatEvents = tracks.flatMap((t) => t.events);
  return {
    duration,
    frameRate,
    version,
    approved: Boolean(master?.approved),
    audioUrl: str(response?.whisperx_audio_url) || null,
    totalEvents: flatEvents.length,
    tracks,
    events: flatEvents,
  };
}
