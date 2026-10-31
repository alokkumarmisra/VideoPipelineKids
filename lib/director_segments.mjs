// Transcript-preserving WhisperX segmentation for director-ready clips.
// Pure helpers: no filesystem, network, database, or model calls.

const arr = (value) => Array.isArray(value) ? value : [];
const text = (value) => value == null ? "" : String(value);
const round = (value) => Math.round(Number(value) * 1000) / 1000;

const plain = (value) => text(value).normalize("NFC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const lexicalTokens = (value) => {
  const re = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
  return [...text(value).matchAll(re)].map((m) => ({ value: m[0], start: m.index, end: m.index + m[0].length }));
};

// Match WhisperX word records back to the exact transcript text so punctuation,
// capitalization, and spacing remain untouched in the resulting SRT/JSON.
function textPieces(sourceText, words) {
  const tokens = lexicalTokens(sourceText);
  const wordTokens = words.map((w) => lexicalTokens(w.word).map((t) => plain(t.value)).join(""));
  const sourceTokens = tokens.map((t) => plain(t.value));
  const pieces = [];
  let ti = 0;
  let cursor = 0;
  for (const wanted of wordTokens) {
    if (!wanted) return null;
    let end = ti;
    let found = "";
    while (end < sourceTokens.length && found.length < wanted.length) {
      found += sourceTokens[end++];
    }
    if (found !== wanted) return null;
    const tokenEnd = tokens[end - 1].end;
    pieces.push(sourceText.slice(cursor, tokenEnd));
    cursor = tokenEnd;
    ti = end;
  }
  if (ti !== sourceTokens.length) return null;
  if (pieces.length) pieces[pieces.length - 1] += sourceText.slice(cursor);
  return pieces;
}

const punctScore = (s) => /[.!?…।॥][”’"')\]]*\s*$/u.test(text(s)) ? 3
  : /[,;:—–-][”’"')\]]*\s*$/u.test(text(s)) ? 1.5 : 0;

/**
 * Split an aligned WhisperX transcript into director-ready segments.
 * Input accepts WhisperX {segments:[{start,end,text,words:[{word,start,end,...}]}]}
 * or the app's normalized timeline.whisper shape.
 */
export function splitWhisperTranscript(raw, {
  minSeconds = 3,
  maxSeconds = 5,
  targetSeconds = 4,
  pauseSeconds = 0.75,
} = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const sourceRows = arr(source.segments);
  if (!sourceRows.length) throw new Error("WhisperX transcript has no segments");
  if (!(minSeconds > 0 && maxSeconds >= minSeconds && targetSeconds >= minSeconds && targetSeconds <= maxSeconds)) {
    throw new Error("invalid target range");
  }

  const units = [];
  const unsegmented = [];
  for (const [sourceIndex, rowValue] of sourceRows.entries()) {
    const row = rowValue && typeof rowValue === "object" ? rowValue : {};
    const rowText = text(row.text).replace(/\r\n/g, "\n");
    const rowWords = arr(row.words).map((w, wordIndex) => {
      const o = w && typeof w === "object" ? w : {};
      const start = Number(o.start_seconds ?? o.start);
      const end = Number(o.end_seconds ?? o.end);
      return { ...o, word: text(o.word ?? o.text), start_seconds: start, end_seconds: end,
        _sourceIndex: sourceIndex, _wordIndex: wordIndex };
    }).filter((w) => Number.isFinite(w.start_seconds) && Number.isFinite(w.end_seconds) && w.end_seconds > w.start_seconds && text(w.word).trim());
    const pieces = textPieces(rowText, rowWords);
    if (!rowWords.length) {
      if (rowText) unsegmented.push({ start_seconds: Number(row.start_seconds ?? row.start), end_seconds: Number(row.end_seconds ?? row.end), text: `${sourceIndex ? " " : ""}${rowText}`, words: [], _sourceIndex: sourceIndex });
      continue;
    }
    if (!pieces) {
      // Keep a WhisperX phrase intact if its word labels cannot be mapped back
      // to the transcript verbatim. Never fabricate a replacement transcript.
      unsegmented.push({ start_seconds: Number(row.start_seconds ?? row.start), end_seconds: Number(row.end_seconds ?? row.end), text: `${sourceIndex ? " " : ""}${rowText}`, words: rowWords, _sourceIndex: sourceIndex });
      continue;
    }
    if (sourceIndex > 0 && pieces.length) pieces[0] = ` ${pieces[0]}`;
    rowWords.forEach((w, i) => units.push({ ...w, _piece: pieces[i], _punctuation: punctScore(pieces[i]) }));
  }
  units.sort((a, b) => a._sourceIndex - b._sourceIndex || a._wordIndex - b._wordIndex);
  const groups = [];
  let current = [];
  const flush = (endNote = "") => { if (current.length) groups.push({ words: current, endNote }); current = []; };
  for (let i = 0; i < units.length; i += 1) {
    const word = units[i];
    const prev = current[current.length - 1];
    const gap = prev ? word.start_seconds - prev.end_seconds : 0;
    const speakerChanged = prev && (prev.speaker_id ?? prev.speaker) != null && (word.speaker_id ?? word.speaker) != null && (prev.speaker_id ?? prev.speaker) !== (word.speaker_id ?? word.speaker);
    if (prev && gap >= 0 && ((gap >= pauseSeconds) || speakerChanged)) {
      flush(gap >= pauseSeconds ? `cut at ${round(gap)}s pause` : "cut at speaker change");
    }
    current.push(word);
  }
  flush();
  // Unmappable or wordless utterances remain whole, preserving the transcript.
  for (const row of unsegmented) groups.push({ words: row.words, start_seconds: row.start_seconds, end_seconds: row.end_seconds, text: row.text, _sourceIndex: row._sourceIndex });
  groups.sort((a, b) => (a.words[0]?._sourceIndex ?? a._sourceIndex) - (b.words[0]?._sourceIndex ?? b._sourceIndex) ||
    (a.words[0]?._wordIndex ?? 0) - (b.words[0]?._wordIndex ?? 0));

  const output = [];
  let previousEnd = 0;
  const append = (wordGroup, note) => {
    const first = wordGroup[0];
    const last = wordGroup[wordGroup.length - 1];
    const start = Number(first?.start_seconds);
    const end = Number(last?.end_seconds);
    const groupText = wordGroup.map((w) => w._piece ?? text(w.word)).join("");
    const cleanText = groupText || "";
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    if (output.length && start < previousEnd - 0.0005) throw new Error("overlapping WhisperX word timestamps prevent a non-overlapping segment export");
    const actualStart = start;
    if (end <= actualStart) throw new Error("overlapping WhisperX word timestamps prevent a non-overlapping segment export");
    const id = `seg-${String(output.length + 1).padStart(3, "0")}`;
    const words = wordGroup.map((w, i) => {
      const { _sourceIndex, _wordIndex, _piece, _punctuation, ...original } = w;
      return { ...original, word_index: output.reduce((n, s) => n + s.words.length, 0) + i, segment_id: id };
    });
    output.push({ segment_id: id, start_seconds: round(actualStart), end_seconds: round(end), duration_seconds: round(end - actualStart), text: cleanText, cut_note: note, words });
    previousEnd = end;
  };

  for (const group of groups) {
    if (!group.words?.length) {
      const start = Number(group.start_seconds), end = Number(group.end_seconds);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      if (output.length && start < previousEnd - 0.0005) throw new Error("overlapping WhisperX segment timestamps prevent a non-overlapping export");
      const actualStart = start;
      if (end <= actualStart) throw new Error("overlapping WhisperX segment timestamps prevent a non-overlapping export");
      const id = `seg-${String(output.length + 1).padStart(3, "0")}`;
      output.push({ segment_id: id, start_seconds: round(actualStart), end_seconds: round(end), duration_seconds: round(end - actualStart), text: group.text, cut_note: "kept as one WhisperX phrase (no usable word-level timing)", words: [] });
      previousEnd = end;
      continue;
    }
    const ws = group.words;
    let startIndex = 0;
    while (startIndex < ws.length) {
      let best = -1;
      let bestScore = Infinity;
      for (let endIndex = startIndex; endIndex < ws.length; endIndex += 1) {
        const duration = ws[endIndex].end_seconds - ws[startIndex].start_seconds;
        if (ws[endIndex + 1] && ws[endIndex + 1].start_seconds < ws[endIndex].end_seconds) continue;
        if (duration > maxSeconds && endIndex > startIndex) break;
        if (duration < minSeconds && endIndex < ws.length - 1) continue;
        const after = ws[endIndex]._piece || "";
        const next = ws[endIndex + 1];
        const gap = next ? next.start_seconds - ws[endIndex].end_seconds : 0;
        const natural = ws[endIndex]._punctuation + (gap > 0.25 ? Math.min(2, gap) : 0);
        const durationPenalty = Math.abs(duration - targetSeconds) + (duration < minSeconds ? (minSeconds - duration) * 1.4 : 0) + (duration > maxSeconds ? (duration - maxSeconds) * 2 : 0);
        const score = durationPenalty - natural;
        if (score < bestScore) { bestScore = score; best = endIndex; }
        // Prefer a natural boundary near target; allow the phrase to run longer
        // than 5s when punctuation indicates the meaningful unit isn't done.
        if (duration >= targetSeconds && natural >= 1.5) { best = endIndex; break; }
        if (duration >= maxSeconds) break;
      }
      if (best < startIndex) best = ws.length - 1;
      const piece = ws.slice(startIndex, best + 1);
      const next = ws[best + 1];
      let note = "cut near 4-second target at a word boundary";
      if (next && next.start_seconds - piece[piece.length - 1].end_seconds >= pauseSeconds) note = `cut at ${round(next.start_seconds - piece[piece.length - 1].end_seconds)}s pause`;
      else if (piece[piece.length - 1]._punctuation >= 2.5) note = "cut at sentence or lyric ending";
      else if (piece[piece.length - 1]._punctuation > 0) note = "cut at a phrase boundary";
      else if (next && (next.speaker_id ?? next.speaker) !== (piece[piece.length - 1].speaker_id ?? piece[piece.length - 1].speaker)) note = "cut at speaker change";
      if (best === ws.length - 1 && group.endNote) note = group.endNote;
      append(piece, note);
      startIndex = best + 1;
    }
  }
  if (!output.length) throw new Error("WhisperX transcript has no usable timed words");

  const sourceText = sourceRows.map((s) => text(s?.text).replace(/\r\n/g, "\n")).join(" ").trim();
  const outputText = output.map((s) => s.text).join("").trim();
  const textPreserved = sourceText === outputText;
  const checks = validateDirectorSegments(output);
  if (!textPreserved) checks.errors.push("segment text does not exactly reproduce the WhisperX transcript");
  return {
    schema_version: 1,
    source: "whisperx",
    target_seconds: { min: minSeconds, max: maxSeconds, ideal: targetSeconds },
    transcript: sourceText,
    text_preserved: textPreserved,
    validation: { ...checks, text_preserved: textPreserved },
    segments: output,
  };
}

export function validateDirectorSegments(segments) {
  const errors = [];
  const rows = arr(segments);
  for (let i = 0; i < rows.length; i += 1) {
    const s = rows[i];
    const duration = Number(s.end_seconds) - Number(s.start_seconds);
    if (!(Number.isFinite(duration) && duration > 0)) errors.push(`${s.segment_id || i + 1}: invalid timestamps`);
    if (Math.abs(duration - Number(s.duration_seconds)) > 0.0011) errors.push(`${s.segment_id || i + 1}: duration does not match timestamps`);
    if (i && Number(s.start_seconds) < Number(rows[i - 1].end_seconds) - 0.0005) errors.push(`${s.segment_id || i + 1}: overlaps previous segment`);
  }
  return { ok: errors.length === 0, errors, segment_count: rows.length };
}

const srtTime = (seconds) => {
  const ms = Math.max(0, Math.round(Number(seconds) * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, r = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(r).padStart(3, "0")}`;
};

export function directorSegmentsToSrt(segments) {
  return arr(segments).map((s, i) => `${i + 1}\n${srtTime(s.start_seconds)} --> ${srtTime(s.end_seconds)}\n${text(s.text)}\n`).join("\n");
}
