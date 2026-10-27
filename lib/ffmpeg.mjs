/**
 * Shared ffmpeg/ffprobe binary resolution.
 *
 * Every stitch/mux/tts/lipsync path used to spawn the BARE name ("ffmpeg"),
 * which only works when the binary is on PATH — on Windows machines without
 * an ffmpeg install that dies with `spawnSync ffmpeg ENOENT` (seen on the
 * Stitch button's "normalizing mismatched takes" path).
 *
 * Resolution order (cached, first hit wins):
 *   1. `FFMPEG_PATH` / `FFPROBE_PATH` env override
 *   2. the bare name on PATH (the historical behavior)
 *   3. the static builds npm-installed under `frontend/node_modules`
 *      (`ffmpeg-static` / `ffprobe-static`)
 *   4. a manual drop-in under `vendor/ffmpeg/<binary>.exe`
 *
 * When nothing is found the bare name is returned so spawn throws the same
 * ENOENT as before (the error message stays honest).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";

function isExecutable(p) {
  try {
    return fs.statSync(p).isFile();
  } catch { return false; }
}

/** Locate `bin` on PATH the way spawn would (PATHEXT on Windows). */
function onPath(bin) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const exts = WIN
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").map((e) => e.toLowerCase())
    : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, ext ? `${bin}${ext}` : bin);
      if (isExecutable(p)) return p;
    }
  }
  return null;
}

/** Static-build candidates npm can put on disk for us (no code changes when
 *  present — `npm i ffmpeg-static ffprobe-static` inside frontend/ is enough). */
function staticCandidates(bin) {
  const exe = WIN ? `${bin}.exe` : bin;
  const out = [
    path.join(ROOT, "vendor", "ffmpeg", exe),
    path.join(ROOT, "frontend", "node_modules", "ffmpeg-static", exe),
  ];
  if (bin === "ffprobe") {
    // ffprobe-static ships under bin/<platform>/<arch>/
    out.push(path.join(ROOT, "frontend", "node_modules", "ffprobe-static",
      "bin", process.platform, process.arch, exe));
  }
  return out;
}

function resolve(bin) {
  const envPath = process.env[bin === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"];
  if (envPath && isExecutable(envPath)) return envPath;
  const onPathHit = onPath(bin);
  if (onPathHit) return onPathHit;
  for (const c of staticCandidates(bin)) {
    if (isExecutable(c)) {
      console.log(`[ffmpeg] ${bin} not on PATH — using ${c}`);
      return c;
    }
  }
  return bin; // bare name: spawn reports the usual ENOENT
}

let cachedFfmpeg;
let cachedFfprobe;

/** Absolute ffmpeg binary path (or the bare name when nothing else resolves). */
export function ffmpegPath() {
  if (cachedFfmpeg === undefined) cachedFfmpeg = resolve("ffmpeg");
  return cachedFfmpeg;
}

/** Absolute ffprobe binary path (or the bare name when nothing else resolves). */
export function ffprobePath() {
  if (cachedFfprobe === undefined) cachedFfprobe = resolve("ffprobe");
  return cachedFfprobe;
}

export const FFMPEG = ffmpegPath();
export const FFPROBE = ffprobePath();
