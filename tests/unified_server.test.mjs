import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KIDS_SCHEMA, KIDS_SQLITE_SCHEMA } from "../lib/kids.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "frontend", "server.mjs"), "utf8");

test("unified production routes are registered (additive)", () => {
  for (const r of [
    'rest === "production-mode"',
    'rest === "audio-asset"',
    'rest === "unified-timeline"',
    'rest === "unified-timeline/approve"',
    'rest === "pacing-blueprint"',
    'rest === "pacing-blueprint/approve"',
    'rest === "director-snapshot"',
    'rest === "director-gate"',
  ]) {
    assert.ok(serverSrc.includes(r), `${r} missing`);
  }
  assert.ok(serverSrc.includes("buildUnifiedTimeline"), "19-track builder not wired");
  assert.ok(serverSrc.includes("buildDurationPacingBlueprint"), "pacing blueprint not wired");
  assert.ok(serverSrc.includes("buildDirectorInputSnapshot"), "snapshot builder not wired");
});

test("schema carries the additive unified tables (both PG + SQLite)", () => {
  for (const t of ["kids_audio_assets", "kids_timelines", "kids_pacing_blueprints", "kids_director_snapshots"]) {
    assert.ok(KIDS_SCHEMA.includes(t), `PG schema missing ${t}`);
    assert.ok(KIDS_SQLITE_SCHEMA.includes(t), `SQLite schema missing ${t}`);
  }
});

test("unified tables round-trip on SQLite (references only, no duplication)", async () => {
  let DatabaseSync = null;
  try { ({ DatabaseSync } = await import("node:sqlite")); } catch { DatabaseSync = null; }
  if (!DatabaseSync) return; // sqlite module unavailable on this runtime — static checks above still pin wiring
  const store = await import("../lib/kids_store.mjs");
  const db = new DatabaseSync(":memory:");
  db.exec(KIDS_SQLITE_SCHEMA);
  db.exec("INSERT INTO kids_projects (id, name) VALUES ('p1','P1')");
  const audio = await store.kidsInsertAudioAsset("sqlite", db, { project_id: "p1", original_filename: "song.wav", duration_sec: 30 });
  assert.equal(audio.duration_sec, 30);
  const tl = await store.kidsSaveTimeline("sqlite", db, "p1", { timelineId: "tl1", status: "generated", masterDurationMs: 30000, frameRate: 30, tracks: { lyrics: [{ id: "a" }] } });
  assert.equal(tl.version, 1);
  const approved = await store.kidsApproveTimeline("sqlite", db, "p1", 1);
  assert.equal(approved.status, "approved");
  const bp = await store.kidsSaveBlueprint("sqlite", db, "p1", { productionMode: "audio_driven", totalTargetDurationMs: 30000, durationSource: "master_audio" });
  assert.equal(bp.version, 1);
  const snap = await store.kidsSaveSnapshot("sqlite", db, "p1", { snapshotId: "s1", productionId: "p1" });
  assert.equal(snap.id, "s1");
  assert.ok(!("timeline" in snap), "snapshot rows must not carry timeline payloads");
  assert.ok(!("blueprint" in snap), "snapshot rows must not carry blueprint payloads");
});
