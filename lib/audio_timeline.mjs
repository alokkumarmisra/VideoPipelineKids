const arr = value => Array.isArray(value) ? value : [];
const text = value => String(value ?? "").trim();
const num = (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const round = value => Math.round(Number(value) * 1000) / 1000;

export function audioTimelineDuration(board) {
  const input = board?.input || {};
  return Math.max(0, Number(input.song?.durationSeconds || input.sourceAudio?.durationSeconds) || 0);
}

function transcriptWindows(board, duration) {
  const entries = arr(board?.input?.songAnalysis?.transcript?.segments);
  return entries.map((entry, i) => {
    const start = Math.max(0, num(entry.start, 0));
    const end = Math.min(duration, num(entry.end, 0));
    if (!(end > start)) return null;
    return { start, end, transcript: text(entry.text), id: `audio-${i + 1}` };
  }).filter(Boolean);
}

function plannedShots(board, duration) {
  const out = [];
  let cursor = 0;
  for (const scene of arr(board?.scenes)) {
    const sceneDuration = Math.max(.1, num(scene.duration_seconds, 0.1));
    const globalStart = num(scene.song_start_time, cursor);
    const sceneStart = Math.max(0, globalStart);
    const rows = arr(scene.shots).length ? scene.shots : [scene];
    const sum = rows.reduce((n, row) => n + Math.max(.1, num(row.duration_seconds, sceneDuration / rows.length)), 0) || sceneDuration;
    let local = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || {};
      const rowDuration = Math.max(.1, num(row.duration_seconds, sceneDuration / rows.length));
      const relativeStart = num(row.start_time, local);
      const relativeEnd = num(row.end_time, relativeStart + rowDuration);
      const start = scene.song_start_time != null
        ? sceneStart + (relativeStart / sceneDuration) * sceneDuration
        : sceneStart + (relativeStart / Math.max(sceneDuration, sum)) * sceneDuration;
      const end = scene.song_start_time != null
        ? sceneStart + (relativeEnd / sceneDuration) * sceneDuration
        : sceneStart + (relativeEnd / Math.max(sceneDuration, sum)) * sceneDuration;
      const clippedStart = Math.max(0, Math.min(duration, start));
      const clippedEnd = Math.max(0, Math.min(duration, end));
      if (clippedEnd > clippedStart) out.push({ scene, row, start: clippedStart, end: clippedEnd, order: out.length });
      local = relativeEnd;
    }
    cursor = scene.song_end_time != null ? Number(scene.song_end_time) : sceneStart + sceneDuration;
  }
  return out.sort((a, b) => a.start - b.start || a.order - b.order);
}

function gapShot(start, end, index, window, mode) {
  const textLine = window?.transcript || "";
  return {
    shot_id: window ? `${window.id}-${Math.round(start * 1000)}-${Math.round(end * 1000)}` : `audio-${index}`,
    source_scene_number: null, source_shot_index: null,
    start_seconds: round(start), end_seconds: round(end), duration_seconds: round(end - start),
    audio_type: textLine ? "vocal" : "instrumental",
    voice_ids: [], lyrics_or_dialogue: textLine, mood: "",
    music_section: "unclassified", bpm: null, beat_timestamps: [],
    character_ids: [], character_reference_ids: [],
    action: "Visual direction needed", facial_expression: "", body_movement: "",
    camera_shot: "", camera_angle: "", camera_movement: "", framing: "",
    location: "", background: "", props: [], lighting: "", color_palette: [],
    lip_sync_required: false,
    aligned_vocal_cues: textLine ? [{ start_seconds: round(start), end_seconds: round(end), text: textLine, voice_ids: [] }] : [],
    continuity_from_previous_shot: "", continuity_to_next_shot: "",
    transition_in: "", transition_out: "",
    image_generation_prompt: "", video_motion_prompt: "",
    model_profile: null, workflow_id: null, generation_status: "draft",
    confidence: { timing: window ? null : 0, content: null, speaker: null },
    analysis_warnings: [window ? "Whisper phrase timestamps; ASR confidence unavailable." : "Unplanned audio interval; add visual direction."],
    director_mode: mode,
  };
}

export function buildAudioTimeline(board) {
  const duration = audioTimelineDuration(board);
  if (!(duration > 0)) throw new Error("audio timeline requires a positive source duration");
  const mode = board?.input?.song ? "music_video" : "story_video";
  const signal = board?.input?.songAnalysis?.measured?.signal || {};
  const sections = arr(board?.input?.songAnalysis?.segments);
  const beats = arr(signal.beatTimes).map(Number).filter(Number.isFinite);
  const windows = transcriptWindows(board, duration);
  const planned = plannedShots(board, duration);
  const rows = [];
  let cursor = 0;
  const addGap = (start, end) => {
    if (end - start < .02) return;
    const overlaps = windows.filter(w => w.end > start && w.start < end).sort((a, b) => a.start - b.start);
    let at = start;
    for (const w of overlaps) {
      const a = Math.max(at, start, w.start), b = Math.min(end, w.end);
      if (a > at) rows.push(gapShot(at, a, rows.length + 1, null, mode));
      if (b > a) { rows.push(gapShot(a, b, rows.length + 1, w, mode)); at = b; }
    }
    if (end > at) rows.push(gapShot(at, end, rows.length + 1, null, mode));
  };
  for (const item of planned) {
    if (item.start > cursor) addGap(cursor, item.start);
    const start = Math.max(cursor, item.start);
    const end = Math.max(start, item.end);
    if (!(end > start)) continue;
    const scene = item.scene || {}, shot = item.row || {};
    const lyric = text(shot.lyric_segment || shot.lyric_text || scene.lyric_segment || scene.lyric_text);
    const dialogue = arr(shot.dialogue || scene.dialogue).map(d => `${text(d.speaker)}: ${text(d.line)}`).filter(Boolean).join("\n");
    const vocal = lyric || dialogue;
    const section = sections.find(s => Number(s.end) > start && Number(s.start) < end);
    const localBeats = beats.filter(t => t >= start && t < end);
    rows.push({
      shot_id: text(shot.shot_id || scene.shot_id) || `shot-${rows.length + 1}`,
      source_scene_number: Number(scene.scene_number) || null,
      source_shot_index: arr(scene.shots).length ? arr(scene.shots).indexOf(shot) : null,
      start_seconds: round(start), end_seconds: round(end), duration_seconds: round(end - start),
      audio_type: vocal ? (dialogue ? "dialogue" : "vocal") : (mode === "music_video" ? "instrumental" : "mixed"),
      voice_ids: arr(shot.voice_ids || scene.voice_ids), lyrics_or_dialogue: vocal,
      mood: text(section?.mood),
      music_section: text(section?.label), bpm: num(signal.bpm), beat_timestamps: localBeats,
      character_ids: arr(shot.characters || scene.characters),
      character_reference_ids: arr(shot.character_reference_ids || scene.character_reference_ids),
      action: text(shot.action || scene.action), facial_expression: text(shot.expression || scene.expression),
      body_movement: text(shot.body_language || scene.body_language),
      camera_shot: text(shot.camera?.shot_type || scene.camera?.shot_type),
      camera_angle: text(shot.camera?.angle || scene.camera?.angle),
      camera_movement: text(shot.camera?.movement || scene.camera?.movement),
      framing: text(shot.framing || scene.framing), location: text(shot.location || scene.location),
      background: text(shot.environment || scene.environment), props: arr(shot.objects || scene.objects),
      lighting: text(shot.lighting || scene.lighting), color_palette: arr(shot.color_palette || scene.color_palette),
      lip_sync_required: shot.lip_sync_required === true || scene.lip_sync_required === true,
      aligned_vocal_cues: vocal ? [{ start_seconds: round(start), end_seconds: round(end), text: vocal, voice_ids: arr(shot.voice_ids || scene.voice_ids) }] : [],
      continuity_from_previous_shot: text(shot.continuity_from_previous_scene || scene.continuity_from_previous_scene),
      continuity_to_next_shot: text(shot.transition_to_next_scene || scene.transition_to_next_scene),
      transition_in: text(shot.transition_in), transition_out: text(shot.transition_out || scene.transition_to_next_scene),
      image_generation_prompt: text(shot.image_prompt || scene.image_prompt),
      video_motion_prompt: text(shot.video_prompt || scene.video_prompt),
      model_profile: null, workflow_id: null, generation_status: "planned",
      confidence: { timing: scene.song_start_time != null ? null : 0, content: null, speaker: null },
      analysis_warnings: ["Speaker diarization is not available; voice IDs are left blank."],
      director_mode: mode,
    });
    cursor = end;
  }
  if (cursor < duration) addGap(cursor, duration);
  if (!rows.length) addGap(0, duration);
  rows.sort((a, b) => a.start_seconds - b.start_seconds);
  for (const row of rows) {
    const section = sections.find(s => Number(s.end) > row.start_seconds && Number(s.start) < row.end_seconds);
    if (!row.music_section) row.music_section = text(section?.label) || (row.audio_type === "instrumental" ? "Instrumental passage" : "Unclassified section");
    if (!row.mood) row.mood = text(section?.mood);
  }
  // Canonicalize boundaries to be gapless and end exactly at source duration.
  let boundary = 0;
  rows.forEach((row, i) => {
    row.start_seconds = round(boundary);
    row.end_seconds = round(i === rows.length - 1 ? duration : Math.max(boundary, Math.min(duration, row.end_seconds)));
    row.duration_seconds = round(row.end_seconds - row.start_seconds);
    boundary = row.end_seconds;
  });
  rows[rows.length - 1].end_seconds = round(duration);
  rows[rows.length - 1].duration_seconds = round(duration - rows[rows.length - 1].start_seconds);
  return {
    schema_version: 2, director_mode: mode, duration_seconds: round(duration),
    source_audio: board?.input?.song?.fileName || board?.input?.sourceAudio?.fileName || null,
    status: board?.scenes?.length ? "draft" : "analysis_only",
    coverage: { start_seconds: 0, end_seconds: round(duration), complete: true },
    warnings: [
      "Whisper phrase-level timestamps are not word-level forced alignment.",
      "Speaker diarization and source separation are not configured; assign voice IDs manually.",
      "Voice IDs and lip-sync flags are saved as annotations; actual dialogue/lip-sync generation still uses the existing dialogue pipeline.",
      "Model profile/workflow IDs are not declared by this timeline; the existing project pipeline selects its configured workflow.",
      ...(board?.scenes?.length ? [] : ["Generate storyboard scenes to populate visual actions and prompts."]),
    ],
    shots: rows,
  };
}

export function validateAudioTimeline(timeline, expectedDuration) {
  const errors = [];
  const duration = Number(expectedDuration);
  const shots = arr(timeline?.shots);
  if (!Number.isFinite(duration) || duration <= 0) errors.push("source duration must be positive");
  if (!shots.length) errors.push("timeline must contain at least one shot");
  let cursor = 0;
  for (const [index, shot] of shots.entries()) {
    const start = Number(shot.start_seconds), end = Number(shot.end_seconds);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) errors.push(`shot ${index + 1} has invalid bounds`);
    if (Number.isFinite(start) && Math.abs(start - cursor) > .001) errors.push(`shot ${index + 1} creates a gap or overlap at ${round(cursor)}s`);
    if (Number.isFinite(end)) cursor = end;
  }
  if (Number.isFinite(duration) && Math.abs(cursor - duration) > .001) errors.push(`timeline ends at ${round(cursor)}s, expected ${round(duration)}s`);
  return errors;
}

// Sync only when every timeline row has a one-to-one reference to the saved
// storyboard. Analysis-only gaps remain editable timeline annotations rather
// than being silently dropped or turned into ungrounded scenes.
export function syncAudioTimelineToScenes(scenes, timeline, { shotFloor = .5, sceneFloor = 1 } = {}) {
  const list = arr(scenes);
  const rows = arr(timeline?.shots);
  if (!list.length || !rows.length) return { synced: false, reason: "No planned storyboard scenes to sync." };
  const byNumber = new Map(list.map(scene => [Number(scene.scene_number), scene]));
  const groups = new Map();
  if (!rows.every(row => Number.isFinite(Number(row.source_scene_number)) && byNumber.has(Number(row.source_scene_number))))
    return { synced: false, reason: "Timeline includes analysis-only or unmatched audio intervals." };
  for (const row of rows) {
    const number = Number(row.source_scene_number);
    if (!groups.has(number)) groups.set(number, []);
    groups.get(number).push(row);
  }
  if (groups.size !== list.length || list.some(scene => !groups.has(Number(scene.scene_number)))
      || rows.length !== list.reduce((sum, scene) => sum + (arr(scene.shots).length || 1), 0))
    return { synced: false, reason: "Timeline rows do not map one-to-one to storyboard shots." };

  for (const [number, edits] of groups) {
    const scene = byNumber.get(number);
    edits.sort((a, b) => Number(a.source_shot_index ?? -1) - Number(b.source_shot_index ?? -1));
    const nested = arr(scene.shots).length > 0;
    if (nested && edits.some((row, i) => Number(row.source_shot_index) !== i))
      return { synced: false, reason: `Shot references for scene ${number} are incomplete or out of order.` };
    if (!nested && (edits.length !== 1 || edits[0].source_shot_index != null))
      return { synced: false, reason: `Scene ${number} does not map to exactly one timeline shot.` };
    if (edits.at(-1).end_seconds - edits[0].start_seconds < sceneFloor || edits.some(row => row.duration_seconds < shotFloor))
      return { synced: false, reason: `Scene ${number} violates the pacing floor (${shotFloor}s per shot, ${sceneFloor}s per scene).` };
  }

  const applyVisual = (target, row) => {
    target.characters = arr(row.character_ids);
    target.location = text(row.location);
    target.objects = arr(row.props);
    target.action = text(row.action);
    target.lyric_segment = text(row.lyrics_or_dialogue);
    target.lyric_text = text(row.lyrics_or_dialogue);
    target.expression = text(row.facial_expression);
    target.body_language = text(row.body_movement);
    target.camera = { ...(target.camera || {}), shot_type: text(row.camera_shot), angle: text(row.camera_angle), movement: text(row.camera_movement) };
    target.lighting = text(row.lighting);
    target.environment = text(row.background);
    target.color_palette = arr(row.color_palette);
    target.transition_to_next_scene = text(row.transition_out);
    target.image_prompt = text(row.image_generation_prompt);
    target.video_prompt = text(row.video_motion_prompt);
  };
  for (const [number, edits] of groups) {
    const scene = byNumber.get(number);
    scene.song_start_time = Number(edits[0].start_seconds);
    scene.song_end_time = Number(edits.at(-1).end_seconds);
    scene.duration_seconds = round(scene.song_end_time - scene.song_start_time);
    if (arr(scene.shots).length) edits.forEach((row, i) => {
      const shot = scene.shots[i];
      shot.duration_seconds = Number(row.duration_seconds);
      shot.start_time = round(Number(row.start_seconds) - scene.song_start_time);
      shot.end_time = round(Number(row.end_seconds) - scene.song_start_time);
      applyVisual(shot, row);
    });
    else applyVisual(scene, edits[0]);
  }
  return { synced: true, reason: "Timeline timing and visual directions were synced to storyboard scenes." };
}
