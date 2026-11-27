// Vertical (Instagram Reel 9:16) variant tests.
// Run: node --test tests/   (from the repo root; zero deps, Node >= 18)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LANDSCAPE,
  VERTICAL,
  VERTICAL_FLUX_WIDTH,
  VERTICAL_FLUX_HEIGHT,
  VERTICAL_LTX_RATIO,
  VERTICAL_WAN_WIDTH,
  VERTICAL_WAN_HEIGHT,
  normalizeFormat,
  outDirName,
  cfgNameForDir,
  prefixForDir,
  isVerticalDir,
  engineForDir,
  projectForDir,
  allDirsFor,
} from "../lib/variant.mjs";

describe("variant formats", () => {
  it("normalizes unknown formats to landscape", () => {
    assert.equal(normalizeFormat("vertical"), VERTICAL);
    assert.equal(normalizeFormat("landscape"), LANDSCAPE);
    assert.equal(normalizeFormat(undefined), LANDSCAPE);
    assert.equal(normalizeFormat("VERTICAL"), LANDSCAPE);
    assert.equal(normalizeFormat(""), LANDSCAPE);
  });

  it("maps scenario x engine x format to output dirs", () => {
    assert.equal(outDirName("film", "ltx", "landscape"), "film");
    assert.equal(outDirName("film", "ltx", "vertical"), "film_vertical");
    assert.equal(outDirName("film", "wan", "landscape"), "film_wan");
    assert.equal(outDirName("film", "wan", "vertical"), "film_wan_vertical");
    // engine defaults to ltx, format defaults to landscape
    assert.equal(outDirName("film"), "film");
  });

  it("strips engine + format suffixes back to the scenario name", () => {
    assert.equal(cfgNameForDir("film"), "film");
    assert.equal(cfgNameForDir("film_wan"), "film");
    assert.equal(cfgNameForDir("film_vertical"), "film");
    assert.equal(cfgNameForDir("film_wan_vertical"), "film");
  });

  it("detects vertical dirs and engines independently", () => {
    assert.equal(isVerticalDir("film_vertical"), true);
    assert.equal(isVerticalDir("film_wan_vertical"), true);
    assert.equal(isVerticalDir("film"), false);
    assert.equal(isVerticalDir("film_wan"), false);
    assert.equal(engineForDir("film"), "ltx");
    assert.equal(engineForDir("film_vertical"), "ltx");
    assert.equal(engineForDir("film_wan"), "wan");
    assert.equal(engineForDir("film_wan_vertical"), "wan");
    assert.equal(projectForDir("film_wan_vertical"), "film");
    assert.equal(prefixForDir("film_wan_vertical"), "film_wan_vertical");
  });

  it("lists all four output dirs for a scenario", () => {
    assert.deepEqual(allDirsFor("film"), ["film", "film_wan", "film_vertical", "film_wan_vertical"]);
  });

  it("keeps display-name spaces out of resource dirs and prefixes", () => {
    assert.equal(outDirName("My Cozy Film", "wan", "vertical"), "my_cozy_film_wan_vertical");
    assert.deepEqual(allDirsFor("My Cozy Film"), [
      "my_cozy_film", "my_cozy_film_wan", "my_cozy_film_vertical", "my_cozy_film_wan_vertical",
    ]);
    assert.equal(prefixForDir("My Cozy Film_wan_vertical"), "my_cozy_film_wan_vertical");
  });

  it("vertical canvases are 9:16 within rounding", () => {
    const fluxRatio = VERTICAL_FLUX_WIDTH / VERTICAL_FLUX_HEIGHT;
    const wanRatio = VERTICAL_WAN_WIDTH / VERTICAL_WAN_HEIGHT;
    for (const r of [fluxRatio, wanRatio]) {
      assert.ok(Math.abs(r - 9 / 16) < 0.03, `ratio ${r} is not 9:16`);
    }
    assert.equal(VERTICAL_WAN_WIDTH % 16, 0);
    assert.equal(VERTICAL_WAN_HEIGHT % 16, 0);
    assert.equal(VERTICAL_LTX_RATIO, "9:16 (Portrait Widescreen)");
  });
});
