// Prompts-JSON path resolution shared by the CLI runners.
//
// Storage names are SPACE-FREE everywhere in this repo: the server exports a
// saved scenario as prompts/<configSlug(displayName)>.json (e.g. "Pyari
// billi" -> "pyari_billi.json"). Legacy exports written before slugification
// still carry the raw display name, so resolution tries the slug file FIRST
// and falls back to the legacy raw-name file. Pure Node, no deps.
import fs from "node:fs";
import path from "node:path";
import { configSlug } from "./variant.mjs";

export function resolvePromptsJson(promptsDir, name) {
  const slugPath = path.join(promptsDir, `${configSlug(name)}.json`);
  if (fs.existsSync(slugPath)) return slugPath;
  const rawPath = path.join(promptsDir, `${String(name ?? "")}.json`);
  if (fs.existsSync(rawPath)) return rawPath;
  return slugPath; // not found — the caller's error message shows this path
}
