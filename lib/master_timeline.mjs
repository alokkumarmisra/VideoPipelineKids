// ---------------------------------------------------------------------------
// Master timeline (Story / Song) — the AUDIO-ALIGNED chronological cut list.
// ---------------------------------------------------------------------------
// Built on top of the WhisperX lyric timeline (lib/semantics.mjs): the aligned
// lyric lines supply MEASURED singing/dialogue windows, vocal-activity rows
// (WhisperX VAD when available, the honest energy fallback from
// lib/audio_analysis.mjs otherwise) supply vocal vs non-vocal intervals, and
// this module turns both into ONE chronological segment list covering the
// WHOLE song — instrumental, singing, dialogue, mixed and uncertain sections.
//
// The rules the workflow states must never regress:
//   * measured alignment timestamps are the timing source of truth,
//   * "no recognized words" is NEVER silently classified instrumental,
//   * a lyric-specific action never starts before its own lyric begins,
//   * a "mixed" segment exists for overlapping kinds and "unknown" stays
//     available wherever the evidence does not justify a stronger label,
//   * the user's corrections + explicit approval outrank every automated
//     rebuild, and approved timings refuse edits until an explicit unlock.
//
// Every helper is pure (no fs / network / db / LLM) so the server, the panels
// and the tests share exactly one implementation.

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v, n = 0) => {
  const t = String(v ?? "").trim();
  return n ? t.slice(0, n) : t;
};
const num = (v, fb = null) => (Number.isFinite(Number(v)) ? Number(v) : fb);
const round = (v) => Math.round(Number(v) * 1000) / 1000;

export const MASTER_SEGMENT_TYPES = ["instrumental", "singing", "dialogue", "mixed", "unknown"];

const MASTER_MIN_GAP = 0.25;
/** A clip is 3–5 s: the window the existing pipeline renders per keyframe. */
export const MASTER_CLIP_MIN = 3;
export const MASTER_CLIP_MAX = 5;

const normToken = (v) => str(v).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

// ---------------------------------------------------------------------------
// Vocal-activity normalisation
// ---------------------------------------------------------------------------

/**
 * One uniform shape for every activity source:
 *   - `whisperx-vad` rows (Silero/pyannote voice detection — a real
 *     "vocal vs non-vocal" signal),
 *   - the energy-silence fallback (`analyzePcm().vocalActivity`, where an
 *     "audio" row only means "sound is present").
 * Output rows: `{ start, end, activity: "vocal" | "non_vocal" | "unknown" }`,
 * sorted, merged, clipped to the song duration. `measured`/`voice_detectable`
 * are true ONLY for a real voice detector — the energy fallback never gets
 * to claim it can tell voice from instruments.
 */
export function normalizeVocalActivity(raw, { duration = 0 } = {}) {
  const total = num(duration, 0);
  const src = raw && typeof raw === "object" ? raw : {};
  const rows = [];
  for (const entry of arr(src.segments)) {
    const o = entry && typeof entry === "object" ? entry : {};
    const a = num(o.start ?? o.start_seconds);
    const b = num(o.end ?? o.end_seconds);
    if (a == null || b == null || b <= a) continue;
    const label = str(o.activity ?? o.label ?? o.type).toLowerCase();
    // energy-heuristic rows say "audio" / "low"; VAD rows say "voice"/"speech"
    // or "silence"/"music"/"non_vocal".
    const activity = /^(vocal|voice|speech|speech_presence)$/.test(label)
      ? "vocal"
      : /^(non_vocal|nonvocal|silence|instrumental|music|low|no_speech)$/.test(label)
        ? "non_vocal"
        : label === "audio" ? "unknown" : "unknown";
    rows.push({
      start: round(Math.max(0, a)),
      end: round(total > 0 ? Math.min(total, b) : b),
      activity,
    });
  }
  rows.sort((x, y) => x.start - y.start || x.end - y.end);
  const merged = [];
  for (const r of rows) {
    const prev = merged[merged.length - 1];
    if (prev && r.activity === prev.activity && r.start <= prev.end + 0.001) {
      prev.end = Math.max(prev.end, r.end);
      continue;
    }
    merged.push({ ...r });
  }
  const method = str(src.method);
  const measured = /vad|silero|pyannote|voice-?detector|whisperx/i.test(method);
  return {
    status: merged.length ? "ok" : "unavailable",
    method: method || (merged.length ? "unknown" : "none"),
    measured,
    note: str(src.note) || (merged.length
      ? (measured
        ? "vocal vs non-vocal intervals from a voice/VAD model"
        : "audio-energy intervals only — a row that is not silent may still be music")
      : "no vocal-activity data — uncertain sections stay 'unknown', never instrumental"),
    segments: merged,
    voice_detectable: measured && merged.length > 0,
  };
}

/** Seconds of [a, b) covered by activity rows the predicate accepts. */
function activityCovers(activity, a, b, accept) {
  let cover = 0;
  for (const row of activity.segments) {
    if (accept && !accept(row)) continue;
    cover += Math.max(0, Math.min(b, row.end) - Math.max(a, row.start));
  }
  return cover;
}

/**
 * Repeat groups across the ALIGNED lyric lines (any text sung more than
 * once). Every occurrence stays its OWN row in the segments — the shared
 * `repeat-N` group key only lets the Song Director keep chorus visuals
 * consistent and lets the UI show repeats side by side.
 */
export function detectRepeatedLyrics(lines = []) {
  const groups = new Map();
  for (const line of arr(lines)) {
    const key = normToken(line && line.lyric_text);
    if (!key || num(line.start_seconds) == null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      line_id: num(line.line_id) || null,
      occurrence: num(line.occurrence, 1),
      start_seconds: line.start_seconds,
      end_seconds: line.end_seconds,
      lyric_text: str(line.lyric_text),
    });
  }
  return [...groups.values()]
    .filter((g) => g.length >= 2)
    .map((g, i) => ({ group: `repeat-${i + 1}`, lines: g, occurrences: g.length }));
}

// ---------------------------------------------------------------------------
// Segment construction
// ---------------------------------------------------------------------------

const baseSegment = (id, type, start, end, extra = {}) => ({
  segment_id: id,
  type,
  start_seconds: round(start),
  end_seconds: round(end),
  duration_seconds: round(end - start),
  // Lyric content
  lyric_line_id: null,
  lyric_text: "",
  heard_text: "",
  words: [],
  // Timing provenance
  timing_source: "unknown",
  confidence: null,
  low_confidence: false,
  review_status: "pending",
  // Song Director assignment (heuristic — the review panel remains the boss)
  character_id: "",
  speaker: "",
  speaker_source: "none",
  action: "",
  expression: "",
  location: "",
  props: [],
  style_refs: [],
  camera: null,
  // Occurrence / clip linkage
  occurrence: 1,
  repeat_group: null,
  scene_clip_ids: [],
  notes: [],
  ...extra,
});

const stableLineId = (line) => `lbl-${num(line.line_id, 0)}_o${num(line.occurrence, 1)}`;

/**
 * Build the chronological master timeline:
 *   `lyricTimeline`  — lib/semantics.mjs buildLyricTimeline output,
 *   `vocalActivity`  — activity rows (see normalizeVocalActivity),
 *   `duration`       — the MEASURED audio duration (seconds, source of truth),
 *   `characters`     — the board's cast (`blueprint.characters`),
 *   `style`          — the board's visual style string(s),
 *   `semantics`      — the meaning layer's per-line rows (actions/props),
 *   `previous`       — the stored timeline (manual corrections + approval).
 *
 * Deterministic classification:
 *   1. an aligned lyric window → "singing" (or "dialogue" when the line kind
 *      says dialogue); measured windows keep their word timings,
 *   2. transcript text WITHOUT a matching lyric line → "unknown" carrying the
 *      heard text (recognized words nobody claimed — review needed),
 *   3. remaining gaps follow the VOCAL ACTIVITY, never the word list:
 *        voice-detector: vocal   → "unknown"       (sound present, words
 *                                                   unaligned — review),
 *        voice-detector: silent  → "instrumental",
 *        energy: sound present   → "unknown"       (may be voice OR music),
 *        energy: silent          → "instrumental",
 *        no activity data        → "unknown"       (flagged; never invented),
 *   4. overlapping rows merge into "mixed" when their kinds collide.
 */
export function buildMasterTimeline({
  lyricTimeline = null,
  vocalActivity = null,
  duration = 0,
  characters = [],
  style = [],
  semantics = [],
  previous = null,
} = {}) {
  const total = Math.max(0, num(duration, 0));
  const lines = arr(lyricTimeline && lyricTimeline.lines);
  const activity = normalizeVocalActivity(vocalActivity, { duration: total });
  const semByLine = new Map(arr(semantics).map((s) => [num(s && s.line_id), s && typeof s === "object" ? s : {}]));
  const warnings = [];

  // 1. Lyric windows (singing / dialogue) from the aligned rows.
  const rows = [];
  for (const line of lines) {
    const a = num(line.start_seconds);
    const b = num(line.end_seconds);
    if (!(b > a)) continue; // un-placed line: reported below, never invented
    const sem = semByLine.get(num(line.line_id)) || {};
    const isDialogue = str(sem.line_kind).toLowerCase() === "dialogue";
    const timed = arr(line.words).filter((w) => num(w.start_seconds) != null && num(w.end_seconds, -1) > num(w.start_seconds, 0));
    const seg = baseSegment(stableLineId(line), isDialogue ? "dialogue" : "singing", a, b, {
      lyric_line_id: num(line.line_id) || null,
      lyric_text: str(line.lyric_text),
      heard_text: str(line.heard_text),
      words: timed.map((w) => ({
        word: str(w.word),
        start_seconds: num(w.start_seconds),
        end_seconds: num(w.end_seconds),
        confidence: num(w.confidence),
        timing: str(w.timing) || "estimated",
      })),
      timing_source: line.timing === "manual" ? "manual"
        : line.timing === "measured" && timed.length ? "whisperx-word-alignment"
        : "whisperx-alignment-estimate",
      confidence: num(line.confidence),
      low_confidence: line.low_confidence === true,
      occurrence: num(line.occurrence, 1),
    });
    rows.push(seg);
  }
  const unplaced = lines.filter((l) => !(num(l.end_seconds, -1) > num(l.start_seconds, -1)));
  if (unplaced.length) {
    warnings.push(`${unplaced.length} lyric line(s) have no usable timing window yet — they are NOT on the timeline; correct their timing first`);
  }

  // 2. Whisper segments whose text no lyric window claims → "unknown".
  const whisperSegments = arr(lyricTimeline && lyricTimeline.whisper && lyricTimeline.whisper.segments);
  for (const w of whisperSegments) {
    const a = num(w.start_seconds), b = num(w.end_seconds);
    if (!(b > a) || !str(w.text)) continue;
    const covered = rows.some((r) => {
      const ov = Math.min(r.end_seconds, b) - Math.max(r.start_seconds, a);
      return ov > 0.55 * (b - a);
    });
    if (covered) continue;
    rows.push(baseSegment(`snk-${num(w.segment_index, rows.length)}`, "unknown", a, b, {
      heard_text: str(w.text),
      words: arr(w.words).map((x) => ({
        word: str(x.word),
        start_seconds: num(x.start_seconds),
        end_seconds: num(x.end_seconds),
        confidence: num(x.confidence),
        timing: str(x.timing) || "estimated",
      })).filter((x) => x.start_seconds != null),
      timing_source: "whisperx-transcript-unclaimed",
      notes: ["transcript words without a matching lyric line — fix the lyric text or its timing, or assign a segment type"],
    }));
  }

  // 3. Fill the gaps with ACTIVITY-aware segments (collected first: the
  //    iteration must not mutate the array it walks). Each gap is split at
  //    voice/activity boundaries, so a silent stretch beside a wordless vocal
  //    hum keeps its own honest verdict.
  rows.sort((x, y) => x.start_seconds - y.start_seconds || x.end_seconds - y.end_seconds);
  {
    const fills = [];
    let cursor = 0;
    for (const r of rows) {
      const a = Math.max(0, Math.min(total, r.start_seconds));
      const b = Math.max(0, Math.min(total, r.end_seconds));
      if (a - cursor > MASTER_MIN_GAP) fills.push(...fillGap(cursor, a, activity, total));
      cursor = Math.max(cursor, b);
    }
    if (total - cursor > MASTER_MIN_GAP) fills.push(...fillGap(cursor, total, activity, total));
    rows.push(...fills);
  }

  // 4. Merge OVERLAPPING rows of colliding kinds into one "mixed" row (the
  //    overlap is never silently dropped or relabelled instrumental).
  //    Touching (adjacent) rows merge only when they share a kind AND carry
  //    no different labels — an instrumental gap next to a lyric window must
  //    stay its own row, never stretch the lyric over it.
  rows.sort((x, y) => x.start_seconds - y.start_seconds || x.end_seconds - y.end_seconds);
  const merged = [];
  for (const r of rows) {
    const prev = merged[merged.length - 1];
    if (!prev) { merged.push({ ...r }); continue; }
    const ov = Math.min(prev.end_seconds, r.end_seconds) - Math.max(prev.start_seconds, r.start_seconds);
    const touching = Math.abs(prev.end_seconds - r.start_seconds) <= 0.001;
    if (ov <= 0.001) {
      const bothNoLyric = !str(prev.lyric_text) && !str(r.lyric_text);
      // Adjacent rows merge ONLY when neither carries a label (two gap
      // slivers): labelled lyric windows must stay separate across a cut.
      if (touching && prev.type === r.type && bothNoLyric) {
        prev.end_seconds = round(Math.max(prev.end_seconds, r.end_seconds));
        continue;
      }
      merged.push({ ...r });
      continue;
    }
    const bothLyric = Boolean(str(prev.lyric_text) && str(r.lyric_text));
    if (bothLyric) {
      // Two labelled windows collide — keep BOTH (the validator reports the
      // overlap); silently cutting either would drop a sung phrase.
      merged.push({ ...r });
      continue;
    }
    // One labelled window + one unlabelled row: the label wins and absorbs
    // the other's evidence; a kind change marks the result "mixed".
    const keep = str(prev.lyric_text) ? prev : (str(r.lyric_text) ? r : prev);
    const other = keep === prev ? r : prev;
    if (keep === r) keep.start_seconds = round(Math.min(prev.start_seconds, r.start_seconds));
    keep.end_seconds = round(Math.max(prev.end_seconds, r.end_seconds));
    keep.duration_seconds = round(keep.end_seconds - keep.start_seconds);
    if (str(other.heard_text) && !str(keep.heard_text)) keep.heard_text = str(other.heard_text);
    if (str(other.character_id) && !str(keep.character_id)) keep.character_id = str(other.character_id);
    if (str(prev.type) !== str(r.type) && keep.type !== "mixed") keep.type = "mixed";
    if (!keep.notes.some((n) => /merged/.test(str(n)))) {
      keep.notes.push(`merged with a ${str(other.type)} row covering the same audio`);
    }
  }
  const segments = merged
    .sort((x, y) => x.start_seconds - y.start_seconds || x.end_seconds - y.end_seconds)
    .filter((r) => (num(r.end_seconds, -1) - num(r.start_seconds, 0)) > 0.001);
  segments.forEach((s, i) => { s.segment_index = i + 1; });

  // Song Director (deterministic visual assignments).
  applySongDirector(segments, { characters, style, semantics });

  // Repeats + corrections + approval.
  const repeats = detectRepeatedLyrics(lines);
  for (const seg of segments) {
    const grp = seg.lyric_line_id != null
      && repeats.find((g) => g.lines.some((l) => l.line_id === seg.lyric_line_id));
    if (grp) seg.repeat_group = grp.group;
  }
  let out = {
    schema_version: 2,
    duration_seconds: round(total),
    language: str(lyricTimeline && lyricTimeline.language) || "auto",
    source: "whisperx+activity",
    activity: {
      status: activity.status,
      method: activity.method,
      measured: activity.measured,
      voice_detectable: activity.voice_detectable,
      segments: activity.segments,
    },
    segments,
    repeats,
    stats: masterStats(segments, total),
    warnings,
  };
  // Manual corrections from the previous build outrank every re-analysis.
  const kept = arr(previous && previous.corrections);
  if (kept.length) {
    const applied = applyMasterCorrections(out, kept, { approved: false });
    out = applied.timeline;
    out.warnings = [...arr(out.warnings), ...applied.warnings];
  }
  // Approval survives a rebuild ONLY while the windows did not change (an
  // approval is a review decision; changed audio re-opens the review).
  if (previous && previous.approved) {
    if (sameWindows(arr(previous && previous.segments), out.segments)) {
      out.approved = previous.approved;
      out.segments = out.segments.map(markApproved);
    } else {
      out.warnings.push("the timeline windows changed after approval — the approval was released for re-review");
    }
  }
  out.validation = validateMasterTimeline(out, { duration: total });
  return out;
}

/**
 * Classify ONE unresolved stretch [a, b). The verdict follows the vocal
 * activity, never the word list:
 *   voice detector: vocal   → "unknown"    (sound present, words unaligned),
 *   voice detector: silent  → "instrumental",
 *   energy: sound present   → "unknown"    (may be voice OR music),
 *   energy: silent          → "instrumental",
 *   no activity data        → "unknown"    (flagged; never invented).
 * The stretch may be split at activity-row boundaries (see fillGap) so a
 * silent sliver next to a wordless hum keeps its own verdict.
 */
function classifyGap(a, b, activity, timingSource) {
  const id = `gap-${round(a)}-${round(b)}`;
  if (activity.voice_detectable) {
    const vocal = activityCovers(activity, a, b, (row) => row.activity === "vocal");
    if (vocal > 0.5 * (b - a)) {
      return baseSegment(id, "unknown", a, b, {
        timing_source: timingSource,
        notes: ["voice-detector activity WITHOUT recognized words — review and assign a type/action; never auto-classed instrumental"],
      });
    }
    return baseSegment(id, "instrumental", a, b, {
      timing_source: timingSource,
      notes: ["no detected voice in this stretch (voice detector) — treated as instrumental"],
    });
  }
  if (activity.segments.length) {
    // Energy fallback only: sound present stays UNKNOWN — "not silent" is
    // never a reason to call something instrumental.
    const present = activityCovers(activity, a, b, (row) => row.activity === "unknown");
    if (present > 0.5 * (b - a)) {
      return baseSegment(id, "unknown", a, b, {
        timing_source: timingSource,
        notes: ["sound present but words unrecognized and no voice detector — review before calling it instrumental"],
      });
    }
    return baseSegment(id, "instrumental", a, b, {
      timing_source: timingSource,
      notes: ["no energy above the noise floor (silence or very quiet instrumental) — review"],
    });
  }
  return baseSegment(id, "unknown", a, b, {
    timing_source: "unavailable",
    notes: ["no vocal-activity data available — kept 'unknown' until the audio is reviewed"],
  });
}

/**
 * The gap [start, end) classified in ACTIVITY-AWARE runs: the stretch is cut
 * at every activity-row boundary first, so each run is judged by the evidence
 * that actually covers IT — a chorus hum beside a quiet bridge yields one
 * "unknown" run and one "instrumental" run, not one blurred label.
 */
function fillGap(start, end, activity, total) {
  const a = Math.max(0, Math.min(total, start));
  const b = Math.max(0, Math.min(total, end));
  if (!activity.voice_detectable && !activity.segments.length) {
    return [classifyGap(a, b, activity, "unavailable")];
  }
  const cuts = new Set([a, b]);
  for (const row of activity.segments) {
    if (row.activity === "unknown" && activity.voice_detectable) continue;
    if (row.end <= a + 0.001 || row.start >= b - 0.001) continue;
    cuts.add(round(Math.max(a, Math.min(b, row.start))));
    cuts.add(round(Math.max(a, Math.min(b, row.end))));
  }
  const bounds = [...cuts].sort((x, y) => x - y);
  const source = activity.voice_detectable ? "vocal-activity" : "audio-energy";
  const out = [];
  for (let i = 1; i < bounds.length; i += 1) {
    const ra = bounds[i - 1], rb = bounds[i];
    if (rb - ra <= MASTER_MIN_GAP) continue; // too thin to be its own row
    out.push(classifyGap(ra, rb, activity, source));
  }
  // Whatever the cuts left thin falls back to the whole-stretch verdict.
  if (!out.length) return [classifyGap(a, b, activity, source)];
  return out;
}

// ---------------------------------------------------------------------------
// Song Director (deterministic pass — the review panel remains authoritative)
// ---------------------------------------------------------------------------

/**
 * Assign character identity, visual action, expression, location, props and
 * camera per segment. DETERMINISTIC ONLY (nothing is invented):
 *   - a dialogue line whose leading "Name:" matches a cast id/name picks that
 *     cast member (`confirmed`);
 *   - a singing line inherits its repeat group's assignment (chorus
 *     consistency) or cycles through the cast (`heuristic` — review flagged);
 *   - action/expression/camera come from the meaning layer's own grounded
 *     action plan (lib/semantics.mjs); absent data stays EMPTY with a note;
 *   - style refs ride on every segment from the board's visual style.
 * Segments are mutated in place (both callers own the array).
 */
export function applySongDirector(segments, { characters = [], style = [], semantics = [] } = {}) {
  const cast = arr(characters).map((c) => {
    const o = c && typeof c === "object" ? c : { character_id: String(c) };
    return {
      character_id: str(o.character_id ?? o.id ?? o.characterId) || str(o.name) || String(c),
      name: str(o.name) || str(o.character_id ?? o.id ?? o.name),
      visual_identity_prompt: str(o.visual_identity_prompt),
    };
  }).filter((c) => c.character_id);
  const styleRefs = arr(style).map((s) => str(s)).filter(Boolean);
  const semByLine = new Map(arr(semantics).map((s) => [num(s && s.line_id), s && typeof s === "object" ? s : {}]));
  const arrStr = (v) => arr(v).map((x) => str(x)).filter(Boolean);
  let rota = 0;
  for (const seg of segments) {
    seg.style_refs = styleRefs;
    if (seg.type === "instrumental" || seg.type === "unknown") {
      // No identity is invented over audio nobody reviewed yet.
      continue;
    }
    const sem = semByLine.get(num(seg.lyric_line_id)) || {};
    const plan = arr(sem.action_plan).filter((a) => a && typeof a === "object");
    const main = plan.find((a) => a && a.grounded !== false) || plan[0] || null;
    if (main) {
      seg.action = str(main.action).slice(0, 300);
      seg.expression = (str(main.expression) || str(sem.emotion) || "").slice(0, 120);
      seg.camera = sem.camera && typeof sem.camera === "object" ? {
        shot_type: str(sem.camera.shot_type),
        angle: str(sem.camera.angle),
        movement: str(sem.camera.movement),
        rationale: str(sem.camera.rationale).slice(0, 200),
      } : null;
      const loc = arrStr(sem.entities && sem.entities.location);
      seg.location = loc[0] || "";
      seg.props = arrStr(sem.objects ?? (sem.entities && sem.entities.objects)).slice(0, 6);
    } else {
      seg.action = seg.action || "";
      seg.props = seg.props && seg.props.length ? seg.props : [];
    }
    if (!seg.action) seg.notes.push("no grounded visual action for this segment yet — review");
    // Speaker: a confirmed "Name:" dialogue match wins; otherwise the rota.
    if (seg.type === "dialogue") {
      const m = (/^\s*([^:\n]{1,40}):\s/).exec(str(seg.lyric_text));
      if (m) {
        const speaker = str(m[1]);
        const hit = cast.find((c) => normToken(c.name) === normToken(speaker) || normToken(c.character_id) === normToken(speaker));
        if (hit) {
          seg.character_id = hit.character_id;
          seg.speaker = hit.name;
          seg.speaker_source = "confirmed";
        } else {
          seg.speaker = speaker;
          seg.speaker_source = "unlisted";
          seg.notes.push(`speaker “${speaker}” is not in the cast — choose a character or extend the bible`);
        }
      }
    }
    if (!seg.character_id && cast.length) {
      if (seg.repeat_group) {
        const twin = segments.find((s) => s !== seg && s.repeat_group === seg.repeat_group && s.character_id);
        if (twin) {
          seg.character_id = twin.character_id;
          seg.speaker = twin.speaker || twin.character_id;
          seg.speaker_source = "heuristic";
          seg.notes.push("repeats share this assignment (chorus consistency) — change if wrong");
        }
      }
      if (!seg.character_id) {
        const pick = cast[rota % cast.length];
        seg.character_id = pick.character_id;
        seg.speaker = pick.name;
        seg.speaker_source = "heuristic";
        seg.notes.push("heuristic casting — confirm or change the character");
        rota += 1;
      }
    }
  }
  return segments;
}

// ---------------------------------------------------------------------------
// Corrections / approval
// ---------------------------------------------------------------------------

/**
 * Apply the user's segment corrections (`[{ segment_id, start_seconds?,
 * end_seconds?, type?, character_id?, action?, expression?, location?,
 * lyric_text? }]`). Timing edits make the row `manual`; type/character edits
 * update the field in place. An APPROVED timeline refuses corrections unless
 * the caller unlocked it first. Unknown segment ids are reported, never
 * applied blindly, and overlapping edited windows are REPORTED (validator),
 * never silently moved.
 */
export function applyMasterCorrections(timeline, corrections = [], { approved = false, unlock = false } = {}) {
  const base = timeline && typeof timeline === "object" ? timeline : {};
  const wasApproved = approved || Boolean(base.approved);
  const warnings = [];
  if (wasApproved && !unlock) {
    return {
      timeline: base,
      corrections: [],
      warnings: ["the timeline is approved — unlock it explicitly before correcting it"],
      blocked: true,
    };
  }
  const segments = arr(base.segments).map((s) => ({
    ...s,
    words: arr(s.words).map((w) => ({ ...w })),
    notes: [...arr(s.notes)],
  }));
  const byId = new Map(segments.map((s) => [s.segment_id, s]));
  const applied = [];
  for (const c of arr(corrections)) {
    const id = str(c && c.segment_id);
    const seg = byId.get(id);
    if (!seg) { warnings.push(`correction for unknown segment ${id || "?"} skipped`); continue; }
    let touched = false;
    const a = num(c.start_seconds);
    const b = num(c.end_seconds);
    if (a != null) { seg.start_seconds = round(Math.max(0, a)); touched = true; }
    if (b != null) { seg.end_seconds = round(Math.max(0, b)); touched = true; }
    const type = str(c.type).toLowerCase();
    if (type && MASTER_SEGMENT_TYPES.includes(type) && type !== seg.type) {
      seg.type = type;
      seg.notes.push(`type set to ${type} by the user`);
      touched = true;
    }
    for (const f of ["character_id", "action", "expression", "location"]) {
      if (typeof c[f] === "string" && c[f].trim() !== str(seg[f])) { seg[f] = c[f].trim().slice(0, 400); touched = true; }
    }
    if (typeof c.lyric_text === "string" && c.lyric_text.trim() && c.lyric_text.trim() !== str(seg.lyric_text)) {
      seg.lyric_text = c.lyric_text.trim().slice(0, 1200);
      seg.notes.push("lyric text corrected by the user");
      touched = true;
    }
    if (touched) {
      seg.duration_seconds = round(seg.end_seconds - seg.start_seconds);
      if (a != null || b != null) seg.timing_source = "manual";
      seg.review_status = "corrected";
      applied.push(seg.segment_id);
    }
  }
  const cleaned = segments
    .filter((s) => (num(s.end_seconds, -1) - num(s.start_seconds, 0)) > 0.001)
    .sort((x, y) => x.start_seconds - y.start_seconds || x.end_seconds - y.end_seconds);
  cleaned.forEach((s, i) => { s.segment_index = i + 1; });
  const out = {
    ...base,
    segments: cleaned,
    stats: { ...base.stats, ...masterStats(cleaned, num(base.duration_seconds, 0)) },
    corrected_at: new Date().toISOString(),
  };
  if (wasApproved && unlock) {
    delete out.approved;
    out.approval_released = true;
  }
  const validation = validateMasterTimeline(out, { duration: num(base.duration_seconds, 0) });
  out.validation = validation;
  out.warnings = [...arr(base.warnings), ...warnings, ...validation.warnings.slice(0, 6)];
  return { timeline: out, corrections: applied, warnings, blocked: false };
}

function markApproved(seg) {
  return { ...seg, review_status: "approved" };
}

function sameWindows(a = [], b = []) {
  if (a.length !== b.length) return false;
  for (const [i, x] of a.entries()) {
    const y = b[i];
    if (!y || x.segment_id !== y.segment_id) return false;
    if (Math.abs(num(x.start_seconds, -1) - num(y.start_seconds, -2)) > 0.01) return false;
    if (Math.abs(num(x.end_seconds, -1) - num(y.end_seconds, -2)) > 0.01) return false;
  }
  return true;
}

/** Approve the timeline (explicit gate before expensive generation). */
export function approveMasterTimeline(timeline) {
  const base = timeline && typeof timeline === "object" ? timeline : {};
  const validation = base.validation || validateMasterTimeline(base, { duration: num(base.duration_seconds, 0) });
  if (validation.errors.length) {
    return { timeline: base, approved: false, error: validation.errors[0], errors: validation.errors };
  }
  const at = new Date().toISOString();
  const out = {
    ...base,
    approved: at,
    segments: arr(base.segments).map(markApproved),
    warnings: [...arr(base.warnings), `timeline approved ${at} — timing is locked until an explicit unlock`],
  };
  out.validation = validation;
  return { timeline: out, approved: true, error: null, errors: [] };
}

/** Explicit unlock (the user releases the approval). */
export function unlockMasterTimeline(timeline) {
  const base = timeline && typeof timeline === "object" ? timeline : {};
  if (!base.approved) return { timeline: base, changed: false };
  const { approved, ...rest } = base;
  void approved;
  const at = new Date().toISOString();
  return {
    timeline: {
      ...rest,
      approval_released: true,
      warnings: [...arr(base.warnings), `approval released ${at} — timings are editable again`],
      segments: arr(base.segments).map((s) => ({
        ...s,
        review_status: s.review_status === "approved" ? "reviewed" : s.review_status,
      })),
    },
    changed: true,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateMasterTimeline(timeline, { duration = 0 } = {}) {
  const errors = [];
  const warnings = [];
  const total = num(duration, num(timeline && timeline.duration_seconds, 0));
  const segments = arr(timeline && timeline.segments);
  if (!segments.length) errors.push("timeline has no segments");
  let cursor = 0;
  for (const [i, seg] of segments.entries()) {
    const tag = str(seg.segment_id) || `segment ${i + 1}`;
    const a = num(seg.start_seconds);
    const b = num(seg.end_seconds);
    if (!MASTER_SEGMENT_TYPES.includes(seg.type)) errors.push(`${tag}: unknown type “${str(seg.type)}”`);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) {
      errors.push(`${tag}: start must be before end`);
    } else {
      if (a < cursor - 0.05) warnings.push(`${tag}: overlaps the previous segment`);
      else if (a > cursor + 0.05) warnings.push(`${tag}: leaves a gap (${round(cursor, 2)}s → ${round(a, 2)}s)`);
      cursor = b;
    }
    if (total > 0 && b > total + 0.25) errors.push(`${tag}: ends after the audio (${round(b, 2)}s > ${round(total, 2)}s)`);
    if (b - a < 0.2 && b > a) warnings.push(`${tag}: very short (${round(b - a, 2)}s) — check it is not a slip`);
    if (seg.type === "unknown") warnings.push(`${tag}: type is still uncertain — review`);
    if (seg.type === "instrumental" && str(seg.lyric_text)) errors.push(`${tag}: cannot carry lyrics while marked instrumental`);
    if ((seg.type === "singing" || seg.type === "dialogue") && !str(seg.lyric_text)) {
      warnings.push(`${tag}: ${seg.type} has no lyric text attached`);
    }
  }
  if (total > 0 && cursor < total - 0.25) {
    warnings.push(`timeline ends at ${round(cursor, 2)}s but the audio runs ${round(total, 2)}s — the tail is uncovered`);
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      segments: segments.length,
      measured: segments.filter((s) => s.timing_source === "whisperx-word-alignment").length,
      manual: segments.filter((s) => s.timing_source === "manual").length,
      unknown: segments.filter((s) => s.type === "unknown").length,
      duration_seconds: total ? round(total, 3) : 0,
    },
  };
}

function masterStats(segments, total) {
  const byType = {};
  for (const t of MASTER_SEGMENT_TYPES) byType[t] = 0;
  let covered = 0;
  let assigned = 0;
  for (const s of segments) {
    byType[s.type] = round(byType[s.type] + s.end_seconds - s.start_seconds);
    covered += s.end_seconds - s.start_seconds;
    if (str(s.action)) assigned += 1;
  }
  return {
    duration_seconds: round(total),
    covered_seconds: round(covered),
    uncovered_seconds: round(Math.max(0, total - covered)),
    by_type: byType,
    visual_assignments: assigned,
  };
}

// ---------------------------------------------------------------------------
// Clips: 3–5 s windows, with clip-relative action times
// ---------------------------------------------------------------------------

/**
 * Plan the scene clips from the (approved) timeline. Each 3–5 s window is
 * anchored on the segments it covers:
 *   - a lyric-carrying boundary is preferred as a clip edge, so a singing
 *     action never starts before its own words and the vocal interval is
 *     never cut mid-word when a better boundary exists;
 *   - a single long segment (a long held line) splits at `max` seconds —
 *     that continuation is a deliberate cut, surfaced via the clip list;
 *   - the song tail is absorbed into the last clip when short.
 * Lyric-backed anchors are only meaningful AFTER approval (the review panel
 * is the authority on where a phrase really ends).
 */
export function planTimelineClips(timeline, { min = MASTER_CLIP_MIN, max = MASTER_CLIP_MAX } = {}) {
  const segments = arr(timeline && timeline.segments)
    .slice()
    .sort((x, y) => x.start_seconds - y.start_seconds || x.end_seconds - y.end_seconds);
  const duration = num(timeline && timeline.duration_seconds, 0);
  if (!segments.length || !(duration > 0)) return [];
  const anchors = segments.map((s) => ({
    segment_id: s.segment_id,
    start: num(s.start_seconds, 0),
    end: num(s.end_seconds, 0),
    lyric: Boolean(str(s.lyric_text)),
    type: str(s.type),
    seg: s,
  }));
  const clips = [];
  let cursor = 0;
  let i = 0;
  while (i < anchors.length && cursor < duration - 0.05) {
    const start = Math.max(cursor, anchors[i].start);
    if (!(duration > start + 0.001)) break;
    // Candidate clip edges: anchor boundaries in (start+min, start+max].
    // A lyric boundary is preferred; otherwise the last reachable one.
    let end = null;
    let endIdx = i;
    let haveLyricEdge = false;
    for (let j = i; j < anchors.length; j += 1) {
      const boundary = Math.min(anchors[j].end, start + max);
      if (!(boundary > start + min - 0.001)) continue;
      const isLyricEdge = anchors[j].lyric && anchors[j].end <= start + max + 0.001;
      if (isLyricEdge || (!haveLyricEdge && boundary > (end ?? 0))) {
        end = boundary;
        endIdx = j + 1;
        haveLyricEdge = haveLyricEdge || isLyricEdge;
      }
      if (isLyricEdge) break;
    }
    if (end == null) {
      // No anchor boundary inside [start+min, start+max] — every coverable
      // anchor spans past start+max (or the next one is beyond): split at max.
      end = Math.min(duration, start + max);
      endIdx = i + 1;
    }
    if (end >= duration - 0.05) end = duration;
    // The song tail: a leftover below `min` is absorbed into THIS clip when
    // one of its anchors reaches the end.
    const tail = duration - end;
    if (tail > 0.05 && tail < min) {
      const lastCoveredEnd = anchors[anchors.length - 1].end;
      if (lastCoveredEnd >= duration - 0.05) {
        const wanted = Math.min(duration, end + (min - tail));
        for (let j = i; j < anchors.length; j += 1) {
          if (anchors[j].end >= wanted - 0.001) { endIdx = j + 1; break; }
        }
        end = wanted;
      }
    }
    const covered = [];
    for (const a of anchors) {
      const a2 = Math.max(a.start, start);
      const b2 = Math.min(a.end, end);
      if (b2 - a2 > 0.001) covered.push({ ...a, coverStart: a2, coverEnd: b2 });
    }
    const types = [...new Set(covered.map((c) => c.type))];
    const clip = {
      clip_id: `clip-${clips.length + 1}`,
      start_seconds: round(start),
      end_seconds: round(end),
      duration_seconds: round(end - start),
      // One kind, else the vocal kind wins as "mixed".
      kind: types.length === 1 ? types[0]
        : [...new Set(types.filter((t) => t === "singing" || t === "dialogue"))].length ? "mixed"
        : "instrumental",
      segment_ids: covered.map((c) => c.segment_id),
      lyric_text: covered.map((c) => str(c.lyric_text)).filter(Boolean).join(" "),
      character_id: (covered.find((c) => str(c.character_id)) || {}).character_id || "",
      actions: [],
      flags: [],
    };
    if (end - start < min) clip.flags.push("below_min");
    if (end - start > max + 0.001 && !covered.some((c) => c.lyric)) clip.flags.push("split_long_segment");
    // Clip-relative action times: ABSOLUTE song time stays the source of
    // truth; the offsets are derived here, and a lyric-specific action never
    // precedes its own words (the anchor boundary guarantees it).
    for (const c of covered) {
      const seg = c.seg;
      if (!seg || !str(seg.action)) continue;
      clip.actions.push({
        segment_id: seg.segment_id,
        action: str(seg.action),
        expression: str(seg.expression),
        character_id: str(seg.character_id),
        absolute_start: round(c.coverStart),
        absolute_end: round(c.coverEnd),
        clip_relative_start: round(c.coverStart - start),
        clip_relative_end: round(c.coverEnd - start),
      });
    }
    // Link the clip ids back onto the segments (scene-clip association).
    for (const id of clip.segment_ids) {
      const seg = segments.find((s) => s.segment_id === id);
      if (seg) seg.scene_clip_ids = [...new Set([...arr(seg.scene_clip_ids), clip.clip_id])];
    }
    clips.push(clip);
    cursor = end;
    while (i < anchors.length && anchors[i].end <= cursor + 0.001) i += 1;
  }
  // Uncovered tail (a short trailing stretch between anchors): extend the
  // last clip when the audio simply continues past it.
  if (clips.length && cursor < duration - 0.05) {
    const last = clips[clips.length - 1];
    if (duration - last.start_seconds <= max + 1.5) {
      last.end_seconds = round(duration);
      last.duration_seconds = round(duration - last.start_seconds);
      last.flags.push("extends_tail");
      const tailCovered = [];
      for (const a of anchors) {
        const a2 = Math.max(a.start, last.start_seconds);
        const b2 = Math.min(a.end, duration);
        if (b2 - a2 > 0.001) tailCovered.push({ ...a, coverStart: a2, coverEnd: b2 });
      }
      last.segment_ids = tailCovered.map((c) => c.segment_id);
      last.lyric_text = [...new Set([...arr(last.lyric_text), ...tailCovered.map((c) => str(c.lyric_text)).filter(Boolean)])].join(" ");
      last.actions = last.actions.concat(tailCovered.filter((c) => c.seg && str(c.seg.action) && c.coverEnd > last.end_seconds - (c.coverEnd - c.coverStart) - 0.001).map((c) => ({
        segment_id: c.seg.segment_id,
        action: str(c.seg.action),
        expression: str(c.seg.expression),
        character_id: str(c.seg.character_id),
        absolute_start: round(c.coverStart),
        absolute_end: round(c.coverEnd),
        clip_relative_start: round(c.coverStart - last.start_seconds),
        clip_relative_end: round(c.coverEnd - last.start_seconds),
      })));
      for (const id of last.segment_ids) {
        const seg = segments.find((s) => s.segment_id === id);
        if (seg) seg.scene_clip_ids = [...new Set([...arr(seg.scene_clip_ids), last.clip_id])];
      }
    }
  }
  return clips;
}

// ---------------------------------------------------------------------------
// The approved timeline as the authority on scene timing
// ---------------------------------------------------------------------------

const round1 = (v) => Math.round(Number(v) * 10) / 10;

/**
 * Snap the planned scene/shot timings onto the APPROVED master timeline
 * before the board converts to a generation config. Priority rule §6:
 * user-approved corrections > validated alignment > estimate — so when the
 * Song Director planned (or drifted from) windows that disagree with the
 * approved segments, the approved windows win.
 *
 * Rules (deliberately conservative — never invent, never silently move far):
 *   * a scene is matched by its OWN lyric line ids (scene + shots), picking
 *     the occurrence with the max overlap — a repeated chorus line never
 *     collapses into another occurrence;
 *   * a snap applies ONLY when both boundaries sit within `tolerance` of the
 *     approved ones — a gross mismatch is REPORTED, never moved (an explicit
 *     timeline decision belongs to the review panel);
 *   * a scene with no finite song windows (story boards, unplaced lines)
 *     passes through untouched;
 *   * shots without their own lyric line rescale proportionally inside the
 *     snapped scene so the tiles keep covering the scene exactly.
 *
 * PURE (returns new objects; the input is never mutated):
 *   `{ scenes, corrections, notes }` — corrections are the [from → to] pairs
 *   the approve route reports back to the UI.
 */
export function applyApprovedTimelineToScenes(scenes, master, { tolerance = 2 } = {}) {
  const out = arr(scenes)
    .map((s) => (s && typeof s === "object"
      ? {
        ...s,
        shots: Array.isArray(s.shots) ? s.shots.map((sh) => ({ ...(sh && typeof sh === "object" ? sh : {}) })) : s.shots,
      }
      : s));
  const notes = [];
  const corrections = [];
  const segs = arr(master && master.segments)
    .map((s) => ({ ...(s && typeof s === "object" ? s : {}), start_seconds: Number(s && s.start_seconds), end_seconds: Number(s && s.end_seconds) }))
    .filter((s) => Number.isFinite(s.start_seconds) && s.end_seconds > s.start_seconds)
    .sort((x, y) => x.start_seconds - y.start_seconds);
  if (!master || !master.approved || !segs.length) {
    notes.push("no approved master timeline — scene timings pass through unchanged");
    return { scenes: out, corrections, notes };
  }
  const overlap = (a, b) => Math.min(a[1], b[1]) - Math.max(a[0], b[0]);
  const sceneLineIds = (sc) => {
    const ids = new Set();
    const lid = Number(sc.lyric_line_id);
    if (Number.isFinite(lid) && lid > 0) ids.add(lid);
    for (const sh of arr(sc.shots)) {
      const sl = Number(sh && sh.lyric_line_id);
      if (Number.isFinite(sl) && sl > 0) ids.add(sl);
    }
    const from = Number(sc.line_from), to = Number(sc.line_to);
    if (Number.isFinite(from) && Number.isFinite(to) && to >= from) {
      for (let n = from; n <= to && n - from < 40; n += 1) ids.add(n);
    }
    return [...ids];
  };
  const matchSeg = (lineIds, win) => {
    let best = null;
    for (const seg of segs) {
      if (Number(seg.lyric_line_id) > 0 && lineIds.length && !lineIds.includes(Number(seg.lyric_line_id))) continue;
      const ov = overlap(win, [seg.start_seconds, seg.end_seconds]);
      if (ov > 0.001 && (!best || ov > best.ov)) best = { seg, ov };
    }
    return best ? best.seg : null;
  };
  for (const sc of out) {
    if (!sc || typeof sc !== "object") continue;
    const s0 = Number(sc.song_start_time);
    const s1 = Number(sc.song_end_time);
    if (!Number.isFinite(s0) || !Number.isFinite(s1) || s1 <= s0) continue;
    const lineIds = sceneLineIds(sc);
    // The scene window snaps to the approved coverage of ITS lines: every
    // approved segment matching those ids that overlaps the planned window.
    const matched = segs.filter((seg) => {
      const lid = Number(seg.lyric_line_id);
      if (!(lid > 0)) return false;
      if (lineIds.length && !lineIds.includes(lid)) return false;
      return overlap([s0, s1], [seg.start_seconds, seg.end_seconds]) > 0.001;
    });
    const pool = matched.length ? matched
      : segs.filter((seg) => overlap([s0, s1], [seg.start_seconds, seg.end_seconds]) > 0.001);
    if (!pool.length) { notes.push(`scene ${num(sc.scene_number, "?")}: no approved segment overlaps its window — left unchanged`); continue; }
    const snappedS = Math.min(...pool.map((s) => s.start_seconds));
    const snappedE = Math.max(...pool.map((s) => s.end_seconds));
    if (Math.abs(snappedS - s0) > tolerance || Math.abs(snappedE - s1) > tolerance) {
      notes.push(`scene ${num(sc.scene_number, "?")}: planned window ${round1(s0)}–${round1(s1)}s sits far from the approved ${round1(snappedS)}–${round1(snappedE)}s — NOT moved; fix the timing in the review panel`);
      continue;
    }
    if (Math.abs(snappedS - s0) < 0.001 && Math.abs(snappedE - s1) < 0.001) continue;
    const oldDur = s1 - s0;
    const newDur = snappedE - snappedS;
    const r = oldDur > 0.001 ? newDur / oldDur : 1;
    for (const sh of arr(sc.shots)) {
      const relS = Number(sh.start_time);
      const relE = Number(sh.end_time);
      if (!Number.isFinite(relS) || !Number.isFinite(relE) || relE <= relS) continue;
      const shLid = Number(sh.lyric_line_id);
      let newRelS = null;
      let newRelE = null;
      if (shLid > 0) {
        // A lyric-carrying shot snaps to ITS OWN segment occurrence: absolute
        // old = old scene start + rel, matched against the approved rows.
        const seg = matchSeg([shLid], [s0 + relS, s0 + relE]);
        if (seg) {
          newRelS = Math.max(0, seg.start_seconds - snappedS);
          newRelE = Math.min(newDur, seg.end_seconds - snappedS);
        }
      }
      if (newRelS == null || !(newRelE > newRelS)) {
        newRelS = relS * r;
        newRelE = relE * r;
      }
      sh.start_time = round1(Math.max(0, Math.min(newDur, newRelS)));
      sh.end_time = round1(Math.max(sh.start_time + 0.1, Math.min(newDur, newRelE)));
      if (Number.isFinite(Number(sh.duration_seconds))) sh.duration_seconds = round1(sh.end_time - sh.start_time);
    }
    corrections.push({ scene_number: num(sc.scene_number, 0), from: [round1(s0), round1(s1)], to: [round1(snappedS), round1(snappedE)] });
    sc.song_start_time = round1(snappedS);
    sc.song_end_time = round1(snappedE);
    if (Number.isFinite(Number(sc.duration_seconds))) sc.duration_seconds = round1(newDur);
    sc.timing_source = "approved-master-timeline";
  }
  return { scenes: out, corrections, notes };
}

/**
 * The storyboard the existing pipeline consumes: one beat per clip with the
 * clip-relative action times written into the prompt text ("0.0–2.3s") and
 * carried in metadata. The server runs `storyboardToScenario` on this raw
 * object, so generation reuses the standard scene pipeline unchanged.
 */
export function timelineClipsToStoryboard(clips, {
  title = "Song",
  description = "",
  referencePrompt = "",
  characterIdentity = null,
  styleRefs = [],
} = {}) {
  const identityOf = (id) => {
    if (typeof characterIdentity === "function") return str(characterIdentity(str(id)));
    return str(characterIdentity) || str(id);
  };
  const styleBits = arr(styleRefs).map((s) => str(s)).filter(Boolean);
  const list = arr(clips);
  const beats = list.map((clip, i) => {
    const identity = identityOf(clip.character_id);
    const actionLines = arr(clip.actions)
      .filter((a) => str(a.action))
      .map((a) => {
        const who = identityOf(a.character_id) || a.character_id || "the character";
        return `${Number(a.clip_relative_start).toFixed(1)}–${Number(a.clip_relative_end).toFixed(1)}s: ${who} ${str(a.action)}`;
      });
    const lyric = str(clip.lyric_text);
    return {
      scene_number: i + 1,
      name: `${clip.clip_id} ${str(title)} (${clip.kind})`,
      // Fractional seconds survive as strings (parseClock keeps decimals).
      duration: String(clip.duration_seconds),
      timestamp: { start: String(clip.start_seconds), end: String(clip.end_seconds) },
      image: [identity, lyric ? `singing "${lyric}"` : "", ...styleBits].filter(Boolean).join(". "),
      motion: [
        identity ? `${identity} performs:` : "",
        ...actionLines,
        styleBits.length ? `visual style: ${styleBits.join(", ")}` : "",
        lyric ? `mouth clear and lip-sync visible while singing "${lyric}"` : "",
      ].filter(Boolean).join(". "),
      character_actions: [identity, ...actionLines].filter(Boolean).join(". "),
      visual_assets: [...new Set([identity, ...styleBits])].filter(Boolean),
      audio_cues: `${clip.kind}${lyric ? ` — "${lyric}"` : ""}`,
      on_screen_text: lyric || "",
      // Metadata: rides into the scenario config + project_assets rows.
      clip_id: clip.clip_id,
      segment_ids: arr(clip.segment_ids),
      absolute_start: clip.start_seconds,
      absolute_end: clip.end_seconds,
      timeline_flags: arr(clip.flags),
    };
  });
  const totalSeconds = list.length ? list[list.length - 1].end_seconds : 0;
  return {
    title: str(title),
    description: str(description) || `${str(title)} — timeline-driven cuts (${list.length} clips)`,
    project_title: str(title),
    total_duration: totalSeconds,
    referencePrompt: str(referencePrompt),
    scenes: beats,
    timeline_source: "master-timeline",
  };
}
