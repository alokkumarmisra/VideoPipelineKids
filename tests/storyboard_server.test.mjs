// Storyboard Planner 2.0 — server/UI wiring + preserved engine guarantees.
// Run: node --test tests/storyboard_server.test.mjs
//
// The new routes are READ-ONLY views. This suite pins that they never write a
// board, never start a run and never touch an approved timestamp — and that the
// existing Generate / Continue / Stop / retry / salvage / Approve path is
// byte-for-byte preserved around the additive prompt enrichment.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, describe } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const serverSrc = src("frontend/server.mjs");
const apiSrc = src("frontend/src/api.ts");
const pageSrc = src("frontend/src/components/DirectorPage.tsx");
const wsSrc = src("frontend/src/components/StoryboardWorkspace.tsx");
const cssSrc = src("frontend/src/styles.css");

const routeBlock = () => {
  const start = serverSrc.indexOf("// Storyboard Planner 2.0 — READ-ONLY views");
  const end = serverSrc.indexOf("// Prompt preview (dry run)", start);
  assert.ok(start > 0 && end > start, "storyboard route block not found");
  return serverSrc.slice(start, end);
};

describe("storyboard read-only API routes", () => {
  // Regex source text escapes the internal slashes (\/).
  const routes = [
    "/storyboard$", "/storyboard\\/timeline$", "/storyboard\\/context$",
    "/storyboard\\/coverage$", "/storyboard\\/validate$", "/storyboard\\/handoff$",
  ];
  test("all six workspace routes exist as GET handlers", () => {
    const block = routeBlock();
    for (const r of routes) {
      assert.ok(block.includes(r), `missing route ${r}`);
      assert.ok(block.includes('req.method === "GET"'), `route ${r} must be GET-only`);
    }
    assert.equal((block.match(/req\.method === "GET"/g) || []).length, 6);
  });

  test("the route block only reads — no writes, no run, no approval", () => {
    const block = routeBlock();
    for (const forbidden of ["writeDirectorBoard", "approveMasterTimeline", "startRun(", "directorApprove", "saveScenario", "req.method === \"POST\""]) {
      assert.ok(!block.includes(forbidden), `read-only block must not contain ${forbidden}`);
    }
    assert.ok(block.includes("readOnly: true"), "the timeline response must declare itself read-only");
  });

  test("every route re-reads the board and derives the timeline from it", () => {
    const block = routeBlock();
    const reads = block.match(/readDirectorBoard\(id\)/g) || [];
    assert.equal(reads.length, 6, "each route must read the live board, not a cached copy");
    assert.equal((block.match(/normalizeStoryboardTimeline\(\{ board \}\)/g) || []).length, 6);
  });
});

describe("additive prompt enrichment — the existing engine stays the authority", () => {
  test("the batch spec builds a cinematic context only when a timeline is approved", () => {
    assert.ok(serverSrc.includes("const sbTimeline = normalizeStoryboardTimeline({ board });"));
    assert.ok(serverSrc.includes("if (sbTimeline.available) {"));
    assert.match(serverSrc, /const ctx = storyboardBatchContext\(\{\s*board,\s*timeline: sbTimeline,/);
    assert.ok(serverSrc.includes("cinematicContext = buildStoryboardPromptBlock(ctx);"));
    const specReturn = serverSrc.match(/return \{ ready: false, done, planTarget[^\r\n]*/)?.[0] || "";
    assert.ok(specReturn.includes("masterTiming") && specReturn.includes("cinematicContext"), "the spec must return the context for both call sites");
  });

  test("real batch and prompt-preview pass the SAME context as masterTimeline", () => {
    assert.match(serverSrc, /masterTimeline: masterTiming \|\| null,\s*cinematicContext: cinematicContext \|\| null,/, "real batch prompt missing enrichment");
    assert.match(serverSrc, /masterTimeline: spec\.masterTiming \|\| null,\s*cinematicContext: spec\.cinematicContext \|\| null,/, "dry-run prompt missing enrichment");
  });

  test("buildScenesPrompt is inert without the new argument", () => {
    const directorSrc = src("lib/director.mjs");
    assert.match(directorSrc, /cinematicContext = null/);
    assert.match(directorSrc, /const block = cinematicContext && typeof cinematicContext === "string"/);
    assert.match(directorSrc, /cinematicBlock/);
  });
});

describe("storyboard phases are labels on the existing live buffer", () => {
  test("livePhase only changes the label — never tokens, polling or the model", () => {
    const start = serverSrc.indexOf("const livePhase =");
    const end = serverSrc.indexOf("const liveEnd =", start);
    const body = serverSrc.slice(start, end);
    assert.ok(body.includes("st.phase = phase"));
    for (const forbidden of ["st.text", "st.reasoning", "liveReset", "llmPostChat", "fetch("]) {
      assert.ok(!body.includes(forbidden), `livePhase must not touch ${forbidden}`);
    }
  });

  test("all nine phases are emitted around the unchanged scene call", () => {
    for (let i = 0; i < 9; i++) assert.ok(serverSrc.includes(`STORYBOARD_PHASES[${i}]`), `phase ${i} never emitted`);
    assert.ok(serverSrc.includes('liveBegin(id, { phase: STORYBOARD_PHASES[0]'));
    assert.match(serverSrc, /livePhase\(id, STORYBOARD_PHASES\[6\]\);\s*const savedBoard = writeDirectorBoard\(board\);/);
  });
});

describe("preserved Generate / Continue / Stop / retry semantics", () => {
  test("the board lock + 409 conflict message are unchanged", () => {
    assert.ok(serverSrc.includes("scene planning already running for this board — wait for it to finish, then Continue"));
    assert.ok(serverSrc.includes("directorPlanning.add(id);"));
    assert.ok(serverSrc.includes("directorPlanning.delete(id);"));
  });

  test("truncated-output salvage, smaller-batch fallback and compact retry are intact", () => {
    assert.ok(serverSrc.includes("Partial batch: kept ${salvaged.length} of ${attemptN} scenes (the AI output was cut off) — press Continue to plan the rest."));
    assert.ok(serverSrc.includes("extractPartialScenes("));
    assert.ok(serverSrc.includes("attemptN = Math.max(1, Math.floor(attemptN / 2));"));
    assert.ok(serverSrc.includes("attemptCompact = true"));
    assert.ok(serverSrc.includes("board.planBatchHint = 1;"));
    assert.ok(serverSrc.includes("if (!salvageNote) board.planBatchHint = null;"));
  });

  test("AbortController cancellation still flows through the shared LLM client", () => {
    assert.ok(serverSrc.includes("const ctl = new AbortController();"));
    assert.ok(serverSrc.includes("ctl.abort()"));
    assert.ok(serverSrc.includes("liveReset(id,"));
    assert.ok(serverSrc.includes("liveEnd(id)"));
  });

  test("the approve path keeps its anatomy gate, timing snap and project handoff", () => {
    const idx = serverSrc.indexOf("applyApprovedTimelineToScenes(board.scenes, approvedMaster)");
    assert.ok(idx > 0, "approve no longer snaps to the approved timeline");
    const generationBoard = serverSrc.indexOf("const generationBoard = {", idx);
    assert.ok(generationBoard > idx, "the snap must still run BEFORE boardToScenario");
    assert.ok(serverSrc.indexOf("boardToScenario(generationBoard)", generationBoard) > generationBoard, "the approved asset versions are resolved after the timing snap");
    assert.ok(serverSrc.includes("timing_corrections: timingCorrections"));
    assert.ok(serverSrc.includes("validateBibleAnatomy(board.blueprint)"));
    assert.ok(pageSrc.includes("saveScenario("), "the client still hands the approved config to the existing Save route");
  });
});

describe("cinematic workspace UI", () => {
  test("the client exposes all read-only storyboard calls", () => {
    for (const fn of ["directorStoryboard", "directorStoryboardTimeline", "directorStoryboardContext", "directorStoryboardCoverage", "directorStoryboardValidate", "directorStoryboardHandoff"]) {
      assert.ok(apiSrc.includes(`export const ${fn} =`), `client missing ${fn}`);
      assert.ok(apiSrc.includes("/storyboard"), "storyboard routes missing from client");
    }
    assert.ok(apiSrc.includes("interface StoryboardView"));
    assert.ok(apiSrc.includes("readOnly: boolean"));
  });

  test("the workspace is embedded beside the existing Director planner", () => {
    assert.ok(pageSrc.includes('import StoryboardWorkspace from "./StoryboardWorkspace"'));
    assert.ok(pageSrc.includes("<StoryboardWorkspace boardId={board.id} board={board}"));
    assert.ok(pageSrc.includes("livePhase={live?.phase}"));
  });

  test("grid/list/timeline views, inspector and honest report are rendered", () => {
    for (const mode of ['"grid"', '"list"', '"timeline"']) assert.ok(wsSrc.includes(mode), `view mode ${mode} missing`);
    assert.ok(wsSrc.includes("directorStoryboard(") && wsSrc.includes("directorStoryboardValidate("));
    assert.ok(wsSrc.includes("Scene inspector"));
    assert.ok(wsSrc.includes("Coverage & validation report"));
    assert.ok(wsSrc.includes("Critical ("));
    assert.ok(wsSrc.includes("Advisory ("));
    assert.ok(wsSrc.includes("Read-only"));
    assert.ok(wsSrc.includes("sbw-playhead"));
    assert.ok(wsSrc.includes("TRACK_LABELS"), "the 19-track lane labels are missing");
    assert.ok(cssSrc.includes(".sbw-card"));
    assert.ok(cssSrc.includes(".sbw-timeline"));
  });
});
