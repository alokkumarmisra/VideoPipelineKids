// Kids Video Director tests — pure lib, no network.
// Run: node --test tests/kids_director.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeBlueprint,
  normalizeScene,
  parseLyricLines,
  estimateLyricTiming,
  buildLyricCoverageMap,
  coverageSummary,
  boardLyricLines,
  boardToScenario,
  genreDirectingNotes,
  isKidsGenre,
  learningFocus,
  extractLearningExpectations,
  validateBibleAnatomy,
  styleLockFor,
  withQualityLock,
  withAnatomyLock,
  normalizeCharacter,
  splitSceneTimeline,
  validateStoryBoard,
  autoFixStoryBoard,
  canonicalizeSceneRefs,
} from "../lib/director.mjs";

const mkScene = (n, extra = {}) => normalizeScene({
  title: `S${n}`,
  image_prompt: `still ${n}, 3D preschool animation`,
  video_prompt: `camera holds as the character moves ${n}`,
  duration_seconds: 3,
  ...extra,
}, n, 3);

// ── Kids genre detection ──
describe("kids genre detection", () => {
  it("detects English kids genres", () => {
    assert.equal(isKidsGenre("Kids"), true);
    assert.equal(isKidsGenre("Educational"), true);
    assert.equal(isKidsGenre("Custom", "nursery rhyme for children"), true);
    assert.equal(isKidsGenre("Adventure"), false);
  });
  it("detects Hindi kids genres (Devanagari)", () => {
    assert.equal(isKidsGenre("Custom", "बच्चों की कहानी"), true);
    assert.equal(isKidsGenre("Custom", "अक्षर गिनती जानवर"), true);
    assert.equal(isKidsGenre("Custom", "लोरी नर्सरी तुकबंदी"), true);
    assert.equal(isKidsGenre("Custom", "पंचतंत्र नैतिक कहानी"), true);
  });
  it("detects Hinglish kids genres", () => {
    assert.equal(isKidsGenre("Custom", "balgeet lori ginti akshar"), true);
  });
});

// ── Educational category validation ──
describe("educational categories", () => {
  const CATEGORIES = [
    "Alphabet & Phonics", "Counting & Math", "Colors & Shapes",
    "Animals & Nature", "Fruits & Vegetables", "Hygiene & Healthy Habits",
    "Good Manners", "Stories & Morals", "Custom",
  ];
  it("has all expected categories", () => {
    assert.ok(CATEGORIES.includes("Alphabet & Phonics"));
    assert.ok(CATEGORIES.includes("Counting & Math"));
    assert.ok(CATEGORIES.includes("Animals & Nature"));
    assert.equal(CATEGORIES.length, 9);
  });
});

// ── Story analysis validation ──
describe("story analysis", () => {
  it("parseLyricLines splits lyrics into numbered lines", () => {
    const lines = parseLyricLines("A for Apple\nB for Ball\n[Chorus]\nABC song!");
    assert.equal(lines.length, 3);
    assert.equal(lines[0].lyric_text, "A for Apple");
    assert.equal(lines[1].lyric_text, "B for Ball");
    assert.equal(lines[2].lyric_text, "ABC song!");
  });
  it("parseLyricLines drops headers and emoji-only lines", () => {
    const lines = parseLyricLines("[Verse 1]\nHello world\n🎵\n(Chorus)");
    assert.equal(lines.length, 1);
    assert.equal(lines[0].lyric_text, "Hello world");
  });
  it("estimateLyricTiming distributes duration proportionally", () => {
    const lines = [
      { lyric_line_id: 1, lyric_text: "short" },
      { lyric_line_id: 2, lyric_text: "a much longer line here" },
    ];
    const timed = estimateLyricTiming(lines, 10);
    assert.equal(timed[0].song_start_time, 0);
    assert.ok(timed[0].song_end_time <= timed[1].song_start_time);
    assert.equal(timed[1].song_end_time, 10);
  });
});

// ── Character bible ──
describe("character bible", () => {
  it("normalizeCharacter creates stable IDs and defaults", () => {
    const c = normalizeCharacter({ name: "Chiku", species: "rabbit", role: "main_character" }, 0);
    assert.equal(c.character_id, "chiku");
    assert.equal(c.name, "Chiku");
    assert.equal(c.species, "rabbit");
    assert.equal(c.role, "main_character");
    assert.equal(typeof c.visual_identity_prompt, "string");
    assert.ok(Array.isArray(c.consistency_rules));
    assert.ok(c.consistency_rules.length > 0);
  });
  it("normalizeBlueprint preserves characters, locations, objects", () => {
    const bp = normalizeBlueprint({
      logline: "A rabbit learns the alphabet",
      characters: [{ name: "Chiku", species: "rabbit", visual_identity_prompt: "grey rabbit, long ears" }],
      locations: [{ name: "forest", visual_identity_prompt: "green forest" }],
      objects: [{ name: "apple", visual_identity_prompt: "red apple" }],
      beats: [{ n: 1, title: "Intro", summary: "Chiku enters the forest" }],
    });
    assert.equal(bp.characters.length, 1);
    assert.equal(bp.locations.length, 1);
    assert.equal(bp.objects.length, 1);
    assert.equal(bp.beats.length, 1);
    assert.equal(bp.logline, "A rabbit learns the alphabet");
  });
  it("character ID derivation falls back to index", () => {
    const c = normalizeCharacter({ species: "elephant" }, 2);
    assert.equal(c.character_id, "character_3");
    assert.equal(c.name, "Character 3");
  });
});

// ── Anatomy / skin covering validation (kids safety) ──
describe("anatomy & covering validation", () => {
  it("validateBibleAnatomy flags legged animal with limbless template", () => {
    const bp = {
      characters: [{
        name: "Sheru", species: "dog", appearance: { body: "four-legged", ears: "floppy" },
        visual_identity_prompt: "dog with fur",
      }],
    };
    const issues = validateBibleAnatomy(bp);
    // dog is legged, no limbless mention — should be clean
    assert.ok(!issues.some((i) => i.includes("limbless")), issues.join("|"));
  });
  it("flags wrong skin covering", () => {
    const bp = {
      characters: [{
        name: "Kaa", species: "snake", appearance: { body: "serpentine", fur: "soft fur" },
        visual_identity_prompt: "snake with fur",
      }],
    };
    const issues = validateBibleAnatomy(bp);
    assert.ok(issues.some((i) => i.includes("SCALES")), issues.join("|"));
  });
});

// ── Learning focus detection ──
describe("learning focus", () => {
  it("detects alphabet focus", () => {
    assert.equal(learningFocus("Custom", "alphabet phonics अक्षर वर्णमाला"), "alphabet");
    assert.equal(learningFocus("Kids"), "kids");
    assert.equal(learningFocus("Adventure"), null);
  });
  it("detects counting focus", () => {
    assert.equal(learningFocus("Custom", "counting numbers गिनती संख्या"), "counting");
  });
  it("detects animals focus", () => {
    assert.equal(learningFocus("Custom", "animals जानवर पशु"), "animals");
  });
  it("detects rhyme focus", () => {
    assert.equal(learningFocus("Custom", "nursery rhyme लोरी तुकबंदी"), "rhyme");
  });
});

// ── Learning expectations extraction ──
describe("learning expectations", () => {
  it("extracts alphabet letters", () => {
    const { letters } = extractLearningExpectations(["A for Apple", "letter B", "अक्षर अ"], "alphabet");
    assert.ok(letters.includes("A"));
    assert.ok(letters.includes("B"));
  });
  it("extracts counts", () => {
    const { counts } = extractLearningExpectations(["5 ducks", "five stars", "३ तारे"], "counting");
    assert.ok(counts.includes(5));
    assert.ok(counts.includes(3));
  });
  it("returns empty sets for wrong focus", () => {
    const r = extractLearningExpectations(["A for Apple"], "counting");
    assert.equal(r.counts.length, 0);
    assert.equal(r.letters.length, 0);
  });
});

// ── Timeline calculations ──
describe("timeline", () => {
  it("splitSceneTimeline tiles duration exactly", () => {
    const shots = splitSceneTimeline(["intro", "action", "outro"], 6, { minShotSeconds: 1.5 });
    const sum = shots.reduce((a, x) => a + x.duration_seconds, 0);
    assert.equal(Math.round(sum * 10) / 10, 6);
    assert.ok(shots.every((s) => s.duration_seconds >= 1.49));
    assert.deepEqual(shots.map((s) => s.start_time), [0, 2, 4]);
  });
  it("shot floor forces longer scenes (shared normalizeScene options)", () => {
    const s = normalizeScene({
      title: "S1", duration_seconds: 3,
      shots: [
        { lyric_segment: "a", action: "a", duration_seconds: 0.6 },
        { lyric_segment: "b", action: "b", duration_seconds: 0.6 },
        { lyric_segment: "c", action: "c", duration_seconds: 0.6 },
        { lyric_segment: "d", action: "d", duration_seconds: 0.6 },
        { lyric_segment: "e", action: "e", duration_seconds: 0.6 },
      ],
    }, 1, 3, { minSceneSeconds: 4, minShotSeconds: 1.5 });
    // 5 shots × 1.5s floor = 7.5s, scene should be lengthened
    assert.ok(s.duration_seconds >= 7.4, `expected >= 7.5s, got ${s.duration_seconds}`);
  });
});

// ── Image prompt construction ──
describe("image prompts", () => {
  it("styleLockFor returns the preschool style lock", () => {
    const lock = styleLockFor("3D Preschool Animation");
    assert.ok(/preschool/i.test(lock));
    assert.ok(lock.length > 20);
  });
  it("styleLockFor custom uses custom text", () => {
    const lock = styleLockFor("Custom", "cute 3D cartoon style");
    assert.ok(/cute 3D cartoon/i.test(lock));
  });
  it("withQualityLock idempotent", () => {
    const base = "a cute rabbit, ultra-detailed 8k uhd, highly clear, no distortion";
    const once = withQualityLock(base);
    const twice = withQualityLock(once);
    assert.equal(once, twice);
  });
  it("withAnatomyLock appends limbless exclusion for snakes", () => {
    const chars = [{ species: "snake", visual_identity_prompt: "green snake" }];
    const out = withAnatomyLock("a snake in the grass", chars);
    assert.ok(/no legs|no arms|limbless/i.test(out));
  });
  it("withAnatomyLock passes legged animals through", () => {
    const chars = [{ species: "dog", visual_identity_prompt: "brown dog" }];
    const out = withAnatomyLock("a dog in the park", chars);
    assert.equal(out, "a dog in the park");
  });
});

// ── Motion plan / storyboard ──
describe("motion plan & storyboard", () => {
  it("normalizeScene sets camera defaults", () => {
    const s = normalizeScene({ title: "S1", duration_seconds: 3 }, 1, 3);
    assert.equal(s.camera.shot_type, "Medium Shot");
    assert.equal(s.camera.angle, "Eye Level");
    assert.equal(s.camera.movement, "Static");
  });
  it("scene shots tile duration exactly", () => {
    const s = normalizeScene({
      title: "S1", duration_seconds: 6,
      shots: [
        { lyric_segment: "A", action: "a", duration_seconds: 2 },
        { lyric_segment: "B", action: "b", duration_seconds: 2 },
        { lyric_segment: "C", action: "c", duration_seconds: 2 },
      ],
    }, 1, 6);
    assert.equal(s.shots.length, 3);
    const sum = s.shots.reduce((a, x) => a + x.duration_seconds, 0);
    assert.equal(Math.round(sum * 10) / 10, 6);
    assert.deepEqual(s.shots.map((x) => x.end_time), [2, 4, 6]);
  });
  it("canonicalizeSceneRefs drops unknown character refs", () => {
    const { scene, repairs } = canonicalizeSceneRefs(
      { scene_number: 1, characters: ["rabbit", "unknown_dragon"], location: "forest" },
      { characters: [{ character_id: "rabbit", name: "Chiku" }], locations: [], objects: [] }
    );
    assert.ok(!scene.characters.includes("unknown_dragon"));
    assert.ok(scene.characters.includes("rabbit"));
    assert.ok(repairs.some((r) => r.includes("unknown_dragon")), repairs.join("|"));
  });
});

// ── Story board validation ──
describe("story board validation", () => {
  it("validateStoryBoard rejects missing blueprint and scenes", () => {
    const { errors } = validateStoryBoard({});
    assert.ok(errors.some((e) => e.includes("No story analysis")));
    assert.ok(errors.some((e) => e.includes("No characters")));
    assert.ok(errors.some((e) => e.includes("No scenes")));
  });
  it("validateStoryBoard accepts valid board", () => {
    const board = {
      blueprint: {
        characters: [{ character_id: "rabbit", name: "Chiku", species: "rabbit", visual_identity_prompt: "grey rabbit" }],
      },
      scenes: [mkScene(1, { characters: ["rabbit"] })],
    };
    const { errors } = validateStoryBoard(board);
    assert.equal(errors.length, 0, errors.join("|"));
  });
  it("autoFixStoryBoard fills missing emotion/expression", () => {
    const board = {
      blueprint: { characters: [{ character_id: "rabbit", name: "Chiku", visual_identity_prompt: "grey rabbit" }] },
      scenes: [mkScene(1, { dialogue: [{ speaker: "rabbit", line: "hello" }] })],
    };
    const { board: fixed, fixed: notes } = autoFixStoryBoard(board);
    assert.ok(notes.some((n) => n.includes("emotion")), notes.join("|"));
    assert.equal(fixed.scenes[0].dialogue[0].emotion, "neutral");
    assert.equal(fixed.scenes[0].dialogue[0].expression, "calm, natural expression");
  });
});

// ── boardToScenario for kids ──
describe("boardToScenario (kids)", () => {
  it("flattens multi-shot scenes into beats", () => {
    const board = {
      input: { title: "Kids Story", visualStyle: "3D Preschool Animation", sceneSeconds: 3 },
      blueprint: { characters: [], locations: [], objects: [] },
      scenes: [normalizeScene({
        title: "S1", duration_seconds: 6,
        shots: [
          { lyric_segment: "A", action: "a", duration_seconds: 3 },
          { lyric_segment: "B", action: "b", duration_seconds: 3 },
        ],
      }, 1, 6)],
    };
    const cfg = boardToScenario(board);
    assert.equal(cfg.sequence.length, 2); // one beat per shot
    assert.equal(cfg.sequence[0].title, "s1_a");
    assert.equal(cfg.sequence[1].title, "s1_b");
  });
  it("includes TTS defaults for Hindi", () => {
    const board = {
      input: { title: "Kids Story", visualStyle: "3D Preschool Animation", language: "Hindi", sceneSeconds: 3 },
      blueprint: { characters: [], locations: [], objects: [] },
      scenes: [mkScene(1)],
    };
    const cfg = boardToScenario(board);
    assert.equal(cfg.tts.language, "Hindi");
    assert.ok(cfg.tts.defaultVoice.includes("hi-IN"));
  });
});

// ── End-to-end: short kids story ──
describe("end-to-end: short kids story", () => {
  it("full pipeline: analyze → scenes → approve → scenario", () => {
    const story = "A for Apple.\nB for Ball.\nC for Cat.\nThree little ducks went out one day.";
    const lines = parseLyricLines(story);
    assert.ok(lines.length >= 3);

    // Simulate an analyzed board (as the LLM would produce)
    const board = {
      input: {
        title: "ABC & Counting",
        story,
        language: "Hindi",
        genre: "Kids",
        visualStyle: "3D Preschool Animation",
        targetSeconds: 60,
        sceneSeconds: 5,
        aspectRatio: "16:9",
        includeDialogue: true,
        chainContinuity: true,
      },
      blueprint: {
        logline: "Children learn letters and counting with animal friends",
        characters: [
          { character_id: "chiku", name: "Chiku", species: "rabbit", role: "main_character",
            appearance: { body: "small grey rabbit", ears: "long pink ears", eyes: "big black eyes" },
            clothing: { top: "red shirt", bottom: "blue shorts" },
            visual_identity_prompt: "small grey rabbit with long pink ears, big black eyes, red shirt, blue shorts" },
          { character_id: "mitu", name: "Mitu", species: "elephant", role: "supporting",
            visual_identity_prompt: "small grey elephant with pink inner ears, rounded body" },
        ],
        locations: [
          { location_id: "forest", name: "Forest", visual_identity_prompt: "green forest with tall trees" },
        ],
        objects: [
          { object_id: "apple", name: "Apple", visual_identity_prompt: "red apple with green leaf" },
        ],
        beats: [
          { n: 1, title: "A for Apple", summary: "Chiku shows an apple", location: "forest", objects: ["apple"] },
        ],
      },
      scenes: [
        normalizeScene({
          title: "A for Apple", duration_seconds: 8,
          characters: ["chiku"],
          location: "forest",
          action: "Chiku holds up a big red apple and smiles",
          emotion: "happy",
          expression: "wide happy smile",
          image_prompt: "small grey rabbit with long pink ears, big black eyes, red shirt, blue shorts, holding a red apple, green forest background",
          video_prompt: "rabbit moves the apple slightly, nose twitches, gentle camera push-in",
        }, 1, 8),
        normalizeScene({
          title: "B for Ball", duration_seconds: 8,
          characters: ["chiku"],
          location: "forest",
          action: "Chiku bounces a blue ball and laughs",
          emotion: "excited",
          expression: "open mouth laugh",
          image_prompt: "small grey rabbit with long pink ears, big black eyes, red shirt, blue shorts, bouncing a blue ball, green forest background",
          video_prompt: "ball bounces up and down, rabbit watches it, gentle camera pan",
        }, 2, 8),
      ],
      sceneCount: 2,
    };

    // Validate
    const { errors } = validateStoryBoard(board);
    assert.equal(errors.length, 0, errors.join("|"));

    // Coverage (no lyric lines on this story board, trivially complete)
    const map = buildLyricCoverageMap(board.scenes, []);
    assert.equal(map.length, 0);

    // Approve → scenario
    const cfg = boardToScenario(board);
    assert.equal(cfg.sequence.length, 2);
    assert.equal(cfg.description, "ABC & Counting — Children learn letters and counting with animal friends");
    assert.ok(cfg.tts.defaultVoice.includes("hi-IN"));
    // Each beat carries the character identity verbatim
    assert.ok(cfg.sequence[0].image.includes("grey rabbit with long pink ears"));
    assert.ok(cfg.sequence[1].image.includes("grey rabbit with long pink ears"));
    // Motion prompts describe motion only, not looks
    assert.ok(!cfg.sequence[0].motion.includes("grey rabbit"));
    assert.ok(!cfg.sequence[0].motion.includes("red shirt"));
  });
});
