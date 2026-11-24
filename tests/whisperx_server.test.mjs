// WhisperX analysis job hardening — static wiring tests.
// Run: node --test tests/whisperx_server.test.mjs (from the repo root)
//
// The "Audio Intelligence & 19-Track Timeline" panel does not run WhisperX
// itself: DirectorPage uploads the WAV, POSTs .../whisperx/analyze, polls the
// job, then reads .../master-timeline. These tests pin the server seams that
// made that flow fail with an opaque HTTP 500 / a stuck "running" job:
//   * the dedicated venv interpreter comes from WHISPERX_PYTHON and is
//     reported by preflight (no silent fallback to a system Python),
//   * only ONE analysis job may run at a time (shared GPU),
//   * orphaned jobs from a server restart are marked failed honestly,
//   * a bad interpreter path fails the JOB instead of crashing the API,
//   * memory errors halve the batch and real exceptions are reported.
import assert from "node:assert/strict";
import { test, describe } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "frontend", "server.mjs"), "utf8");
const envExample = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
const envFile = fs.existsSync(path.join(ROOT, ".env"))
  ? fs.readFileSync(path.join(ROOT, ".env"), "utf8") : "";
const directorSrc = fs.readFileSync(
  path.join(ROOT, "frontend", "src", "components", "DirectorPage.tsx"), "utf8");
const apiSrc = fs.readFileSync(path.join(ROOT, "frontend", "src", "api.ts"), "utf8");

describe("WhisperX server wiring", () => {
  test("dedicated venv interpreter is configured and resolved", () => {
    assert.match(envFile, /WHISPERX_PYTHON="C:\\WhisperX-env\\Scripts\\python\.exe"/);
    assert.match(envExample, /WHISPERX_PYTHON="C:\\\\WhisperX-env\\\\Scripts\\\\python\.exe"/);
    assert.match(serverSrc, /process\.env\.WHISPERX_PYTHON \|\| process\.env\.PYTHON \|\| "python"/);
    assert.match(serverSrc, /return \{ ok, checks, config: whisperxConfig\(\) \}/);
    assert.match(serverSrc, /interpreter: \$\{whisperxCmd \|\| python\}/);
  });

  test("preflight is a real route the UI can query", () => {
    assert.match(serverSrc, /p === "\/api\/whisperx\/preflight"/);
    assert.match(apiSrc, /whisperXPreflight/);
  });

  test("only one WhisperX job may run (shared GPU), repeat clicks attach to it", () => {
    assert.match(serverSrc, /const whisperxActiveJob = \(\) =>/);
    assert.match(serverSrc, /\(j\.status === "pending" \|\| j\.status === "running"\) && !j\.cancelled/);
    assert.match(serverSrc, /const active = whisperxActiveJob\(\);/);
    assert.match(serverSrc, /active\.boardId === id/);
    assert.match(serverSrc, /alreadyRunning: true/);
    assert.match(serverSrc, /WhisperX analysis already running on another board \(job \$\{active\.id\}/);
    assert.match(serverSrc, /json\(res, 409, \{/);
  });

  test("orphaned jobs from a restart are failed, not left running", () => {
    assert.match(serverSrc, /server restarted while this WhisperX job was running/);
    assert.match(serverSrc, /if \(j\.status === "pending" \|\| j\.status === "running"\)/);
  });

  test("spawn errors fail the job instead of taking down the API", () => {
    assert.match(serverSrc, /proc\.on\("error", \(e\) => \{/);
    assert.match(serverSrc, /WhisperX could not start: \$\{e\.message\}/);
    assert.match(serverSrc, /if \(job\.status === "failed"\) return; \/\/ spawn 'error' already reported it/);
  });

  test("memory failures retry with a smaller batch; real errors are surfaced", () => {
    assert.match(serverSrc, /def transcribe_batched\(model, audio, batch_size, lang\):/);
    assert.match(serverSrc, /'out of memory' in msg or 'alloc_failed' in msg/);
    assert.match(serverSrc, /res=transcribe_batched\(model,audio_loaded,batch_size,lang\)/);
    assert.match(serverSrc, /print\('ERR %s: %s' % \(type\(e\)\.__name__, reason\[:400\]\)/);
    assert.match(serverSrc, /lines\.filter\(\(l\) => l\.startsWith\("ERR "\)\)\.pop\(\)/);
  });

  test("the panel still consumes the REAL upload → job → master-timeline flow", () => {
    assert.match(directorSrc, /uploadLyricAudio\(board\.id, dataUrl, name\)/);
    assert.match(directorSrc, /startWhisperXAnalysis\(board\.id/);
    assert.match(directorSrc, /waitForWhisperXJob\(board\.id, started\.jobId\)/);
    assert.match(directorSrc, /directorMasterTimeline\(board\.id\)/);
  });
});
