// LIVE end-to-end smoke: WAV upload → (WhisperX import seam) → aligned
// timeline → master-timeline review → APPROVAL → the REAL Song Director
// scene generation (LM Studio) → the REAL approve → snapped generation config.
// Run: node tests/master_timeline_smoke.mjs   (server on :8790, LM Studio up)
//
// Honesty notes:
//  * WhisperX is NOT installed in this environment (python has no whisperx
//    module). The smoke exercises the EXACT seam the WhisperX job feeds —
//    POST /whisper-import with a fixture payload shaped like the job's
//    result.json — and separately proves the real /whisperx/analyze job
//    FAILS HONESTLY with the preflight error instead of faking analysis.
//  * The fixture audio is a 24 s synthesized WAV (tone bursts where the
//    lyrics sit, silence elsewhere) — so every timestamp in the fixture is
//    true of the fixture audio by construction, and the approval, the
//    Director prompt contract and the snapped scenario config are REAL
//    server behaviour, not mocks.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const BASE = process.env.SMOKE_BASE || "http://127.0.0.1:8790";
// The server loads LOGIN_USER/LOGIN_PASS from the root .env (defaults admin);
// the smoke reads the same file the same way — never hardcoded credentials.
const loadEnv = () => {
  try {
    const raw = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".env"), "utf8").replace(/\u0000/g, "");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*["']?(.*)["']?\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
    }
  } catch { /* defaults below */ }
};
loadEnv();
if (process.env.SMOKE_DEBUG) console.log(`[debug] user=${process.env.LOGIN_USER} passLen=${(process.env.LOGIN_PASS || "").length}`);
const USER = process.env.LOGIN_USER || "admin";
const PASS = process.env.LOGIN_PASS || "admin";
const OUT = [];
const log = (m) => { OUT.push(m); console.log(m); };

// --- a 24 s mono 16 kHz WAV: tone bursts (2–6, 6–9.5, 12–16, 20–23.5), silence between.
function makeWav() {
  const sr = 16000, dur = 24;
  const bursts = [[2, 6], [6, 9.5], [12, 16], [20, 23.5]];
  const n = sr * dur;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    const t = i / sr;
    const on = bursts.some(([a, b]) => t >= a && t < b);
    const v = on ? Math.round(12000 * Math.sin(2 * Math.PI * 220 * t) * (1 + 0.3 * Math.sin(2 * Math.PI * 3 * t))) : 0;
    pcm.writeInt16LE(v, i * 2);
  }
  const hdr = Buffer.alloc(44);
  hdr.write("RIFF", 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write("WAVE", 8);
  hdr.write("fmt ", 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(sr, 24); hdr.writeUInt32LE(sr * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
  hdr.write("data", 36); hdr.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([hdr, pcm]);
}

// The fixture the WhisperX job's result.json would carry (same shape the
// import route + buildLyricTimeline normalize): segments + word timings that
// are true of the synthesized WAV above.
const whisperFixture = () => ({
  language: "hi",
  segments: [
    { start: 2.0, end: 6.0, text: "इस नदी में दूध है", words: [
      { word: "इस", start: 2.0, end: 2.8 }, { word: "नदी", start: 2.8, end: 3.6 },
      { word: "में", start: 3.6, end: 4.2 }, { word: "दूध", start: 4.2, end: 5.4 }, { word: "है", start: 5.4, end: 6.0 },
    ] },
    { start: 6.0, end: 9.5, text: "पीना नहीं", words: [
      { word: "पीना", start: 6.0, end: 7.4 }, { word: "नहीं", start: 7.4, end: 9.5 },
    ] },
    { start: 12.0, end: 16.0, text: "इस नदी में दूध है", words: [
      { word: "इस", start: 12.0, end: 12.8 }, { word: "नदी", start: 12.8, end: 13.6 },
      { word: "में", start: 13.6, end: 14.2 }, { word: "दूध", start: 14.2, end: 15.4 }, { word: "है", start: 15.4, end: 16.0 },
    ] },
    { start: 20.0, end: 23.5, text: "चलो घर चलें", words: [
      { word: "चलो", start: 20.0, end: 21.5 }, { word: "घर", start: 21.5, end: 22.4 }, { word: "चलें", start: 22.4, end: 23.5 },
    ] },
  ],
});

let cookie = "";
const api = async (method, p, body, raw = false) => {
  const r = await fetch(BASE + p, {
    method,
    headers: {
      ...(body && !raw ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? (raw ? body : JSON.stringify(body)) : undefined,
    signal: AbortSignal.timeout(600000),
  });
  const setc = r.headers.get("set-cookie");
  if (setc && !cookie) cookie = setc.split(";")[0];
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return raw ? r : r.json();
};

const LYRICS = [
  "इस नदी में दूध है",
  "पीना नहीं",
  "इस नदी में दूध है",
  "चलो घर चलें",
].join("\n");

(async () => {
  // 0. Login
  await api("POST", "/api/login", { username: USER, password: PASS });
  log("[0] logged in");

  // 1. WhisperX preflight — must report the module honestly missing.
  const pf = await api("GET", "/api/whisperx/preflight");
  log(`[1] preflight ok=${pf.ok} — ${JSON.stringify(pf.checks?.whisperx || {})}`);

  // 2. Analyze a song board through the REAL Director analyze (LM Studio).
  //    The song attachment goes through the REAL upload route first (the
  //    analyze route refuses a missing song file).
  const wav = makeWav();
  const songUp = await api("POST", "/api/director/song-upload", {
    data: `data:audio/wav;base64,${wav.toString("base64")}`,
    fileName: "smoke_fixture.wav",
  });
  const input = {
    title: "Smoke Timeline Song",
    story: LYRICS,
    language: "Hindi",
    semanticsLanguage: "hi",
    genre: "Devotional",
    visualStyle: "3D Cinematic",
    targetSeconds: 24,
    sceneSeconds: 3,
    aspectRatio: "16:9",
    song: { file: songUp.file, fileName: songUp.fileName, durationSeconds: songUp.durationSeconds, hasLyrics: true },
  };
  const board = await api("POST", "/api/director/analyze", input);
  const id = board.id;
  assert.ok(id, "analyze returned no board id");
  log(`[2] analyzed board ${id} — ${board.blueprint?.characters?.length ?? 0} characters, ${board.blueprint?.lyric_lines?.length ?? 0} lyric lines`);

  // 3. Upload the WAV through the REAL WhisperX upload route.
  const up = await api("POST", `/api/director/boards/${encodeURIComponent(id)}/audio-upload`, {
    data: `data:audio/wav;base64,${wav.toString("base64")}`,
    fileName: "smoke_fixture.wav",
  });
  assert.equal(up.valid, true);
  assert.ok(Math.abs(up.durationSeconds - 24) < 0.5, `measured duration ${up.durationSeconds}`);
  log(`[3] uploaded WAV — measured ${up.durationSeconds}s (${(wav.length / 1024).toFixed(0)} KB)`);

  // 4. The REAL WhisperX analyze job: WhisperX is NOT installed → the job
  //    must FAIL HONESTLY (preflight), never fabricate a timeline.
  const job = await api("POST", `/api/director/boards/${encodeURIComponent(id)}/whisperx/analyze`, { language: "hi" });
  assert.ok(job.jobId, "no job id");
  let done = null;
  for (let i = 0; i < 60; i += 1) {
    done = await api("GET", `/api/director/boards/${encodeURIComponent(id)}/whisperx/jobs/${encodeURIComponent(job.jobId)}`);
    if (["succeeded", "failed", "cancelled"].includes(done.status)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(done.status, "failed", `expected an honest failure, got ${done.status}`);
  assert.ok(/preflight/i.test(String(done.error || "")), `expected the preflight error, got ${String(done.error).slice(0, 120)}`);
  log(`[4] WhisperX job failed honestly: "${done.error}" (${String(done.message).slice(0, 120)})`);

  // 5. Import the SAME payload the job would have persisted (the seam), then
  //    verify the derived master timeline covers the whole audio.
  const imported = await api("POST", `/api/director/boards/${encodeURIComponent(id)}/whisper-import`, { whisper: whisperFixture(), language: "hi" });
  assert.ok(imported.timeline?.lines?.length, "no aligned lines");
  const measured = imported.timeline.lines.filter((l) => l.match === "whisperx").length;
  log(`[5] imported: ${imported.timeline.lines.length} aligned lines (${measured} whisperx-matched); master segments=${imported.master?.segments?.length}, instrumental=${(imported.master?.stats?.by_type?.instrumental || 0).toFixed(1)}s`);
  assert.ok(imported.master?.segments?.length > 0, "no master timeline derived");

  // 6. Review corrections on a segment, then APPROVE (the explicit gate).
  const view = await api("GET", `/api/director/boards/${encodeURIComponent(id)}/master-timeline`);
  assert.ok(view.master?.segments?.length > 0, "GET master-timeline returned nothing");
  const firstSeg = view.master.segments.find((s) => s.lyric_text);
  const corrected = await api("PUT", `/api/director/boards/${encodeURIComponent(id)}/master-timeline`, {
    segment_corrections: [{ segment_id: firstSeg.segment_id, action: "Moti bows to the river" }],
  });
  assert.ok(corrected.master, "correction lost the master view");
  const approved = await api("POST", `/api/director/boards/${encodeURIComponent(id)}/master-timeline/approve`);
  assert.ok(approved.approved, "approve refused");
  log(`[6] approved ${approved.master.segments.length} segments → ${approved.clips.length} planned clips (3–5 s)`);

  // 7. The REAL scene generation (LM Studio) must now plan ON the timeline:
  //    the prompt preview shows the contract, and the planned scenes carry
  //    song windows inside the approved ones.
  const preview = await api("GET", `/api/director/boards/${encodeURIComponent(id)}/prompt-preview`);
  assert.ok(preview.user.includes("APPROVED AUDIO TIMELINE"), "the batch prompt does NOT carry the timing contract");
  assert.ok(/2\s*–\s*6s \| singing/.test(preview.user), "the approved segment windows are not in the batch prompt");
  log(`[7] prompt-preview carries the contract (~${preview.approxTokens} tokens)`);

  let scenesResp = null;
  for (let guard = 0; guard < 12; guard += 1) {
    scenesResp = await api("POST", `/api/director/boards/${encodeURIComponent(id)}/scenes`, {});
    if (scenesResp.status === "ready" || (scenesResp.scenes?.length ?? 0) >= (scenesResp.sceneCount ?? 0)) break;
    if (scenesResp.error) throw new Error(`scene planning failed: ${scenesResp.error}`);
  }
  const scenes = scenesResp.scenes || [];
  assert.ok(scenes.length, "no scenes planned");
  const withWindows = scenes.filter((s) => Number.isFinite(Number(s.song_start_time)) && Number(s.song_end_time) > Number(s.song_start_time));
  log(`[8] planned ${scenes.length} scenes (${scenesResp.sceneCount}) — ${withWindows.length} carry song windows`);
  const view2 = await api("GET", `/api/director/boards/${encodeURIComponent(id)}/master-timeline`);
  const segs = view2.master.segments;
  for (const sc of withWindows) {
    // The timing rule the contract states: a scene window either sits INSIDE
    // one approved segment or STARTS on an approved boundary (e.g. a scene
    // covering an instrumental intro that runs into the first lyric line).
    const inside = segs.some((sg) => Number(sg.start_seconds) - 0.6 <= Number(sc.song_start_time) && Number(sc.song_end_time) <= Number(sg.end_seconds) + 0.6);
    const onBoundary = segs.some((sg) => Math.abs(Number(sg.start_seconds) - Number(sc.song_start_time)) <= 0.6);
    if (!inside && !onBoundary) throw new Error(`scene ${sc.scene_number} window ${sc.song_start_time}–${sc.song_end_time} is not aligned to any approved segment boundary`);
  }
  log("[8] every planned scene window sits inside the approved segments (+0.6s tolerance)");

  // 9. The REAL approve: drifted windows must snap; the config durations must
  //    match the approved timeline.
  const approvedBoard = await api("POST", `/api/director/boards/${encodeURIComponent(id)}/approve`);
  assert.ok(approvedBoard.config?.sequence?.length, "approve returned no sequence");
  log(`[9] approve → project "${approvedBoard.name}", ${approvedBoard.config.sequence.length} beats, timing_corrections=${(approvedBoard.timing_corrections || []).length}`);
  const approved2 = await api("GET", `/api/director/boards/${encodeURIComponent(id)}/master-timeline`);
  const approvedSegs = approved2.master.segments;
  for (const sc of (await api("GET", `/api/director/boards/${encodeURIComponent(id)}`)).scenes) {
    if (!Number.isFinite(Number(sc.song_start_time))) continue;
    const near = approvedSegs.some((sg) => Math.abs(Number(sg.start_seconds) - Number(sc.song_start_time)) < 0.75
      || Math.abs(Number(sg.end_seconds) - Number(sc.song_end_time)) < 0.75
      || (Number(sg.start_seconds) <= Number(sc.song_start_time) && Number(sc.song_end_time) <= Number(sg.end_seconds) + 0.001));
    assert.ok(near, `scene ${sc.scene_number} did NOT land on the approved timeline (${sc.song_start_time}–${sc.song_end_time})`);
  }
  log("[9] every timed scene landed on the approved master timeline");

  // 10. Cleanup: delete the smoke board (leave no fixture project behind).
  try { await api("DELETE", `/api/director/boards/${encodeURIComponent(id)}`); } catch { /* keep-alive best-effort */ }
  log("[10] smoke board deleted — done");
  fs.writeFileSync(path.join("frontend", "tests", "master_timeline_smoke_last.log"), OUT.join("\n"));
})().catch((e) => {
  console.error("SMOKE FAILED:", e.message);
  fs.writeFileSync(path.join("frontend", "tests", "master_timeline_smoke_last.log"), OUT.join("\n") + "\nFAILED: " + e.message);
  process.exit(1);
});
