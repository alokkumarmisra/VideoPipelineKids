// Sanskriti AI Studio — unit tests for the MEANING-AWARE semantic engine
// (lib/semantics.mjs): language detection, bilingual action extraction,
// camera planning, scene semantic validation and deterministic repair.
// Run: node --test tests/semantics.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  detectLanguage, tokenize, matchActions, extractEntities,
  buildActionPlan, actionPhrase, planCamera, planBeats,
  assessActionFeasibility, analyzeLine, buildSemanticContext,
  validateSceneSemantics, repairSceneSemantics,
  buildEnglishVisualInstruction, buildNarrationVisuals,
  alignSemanticsToTiming, buildLyricActionPlan, mergeModelSemantics,
  attachSemantics, SEMANTIC_SYSTEM, ACTION_LEXICON,
  extractEmotionCues, classifyLine, isTtsVoiceId, kidsVoiceForCharacter,
  buildKidsVoiceMap,
} from "../lib/semantics.mjs";

// ---------------------------------------------------------------------------
// 1. Language + script detection (bilingual, incl. Hinglish)
// ---------------------------------------------------------------------------

test("detectLanguage identifies Devanagari Hindi", () => {
  assert.equal(detectLanguage("हाथी अपनी सूंड उठाता है"), "hi");
});

test("detectLanguage identifies Latin English", () => {
  assert.equal(detectLanguage("The elephant raises its trunk"), "en");
});

test("detectLanguage identifies Hinglish (Latin script + Hindi markers)", () => {
  assert.equal(detectLanguage("Munna bachcha jaanda hai"), "hinglish");
});

test("detectLanguage mixed script (Devanagari + Latin)", () => {
  assert.equal(detectLanguage("Munna हाथी दौड़ता है"), "hinglish");
});

test("detectLanguage empty defaults to en", () => {
  assert.equal(detectLanguage(""), "en");
});

test("detectLanguage accepts forced override", () => {
  assert.equal(detectLanguage("anything", "hi"), "hi");
});

// ---------------------------------------------------------------------------
// 2. Action extraction (verb → visible action), bilingual + inflection-tolerant
// ---------------------------------------------------------------------------

test("matchActions finds the English verb and cue", () => {
  const m = matchActions("The boy runs across the field");
  assert.ok(m.hits.some((h) => h.id === "run"), "run verb should match");
  assert.equal(m.language, "en");
});

test("matchActions finds the Hindi verb (state change: ho jata = becomes)", () => {
  const m = matchActions("बच्चा उदास हो जाता है");
  assert.ok(m.hits.some((h) => h.id === "become"), "become phrase should match");
});

test("matchActions identifies trunk raise", () => {
  const m = matchActions("हाथी अपनी सूंड उठाता है");
  assert.ok(m.hits.some((h) => h.id === "raise"), "raise should match उठाता");
});

test("matchActions identifies tail wag", () => {
  const m = matchActions("पूँछ हिलाए प्यारा डॉगी");
  assert.ok(m.hits.some((h) => h.id === "wave"), "wave should match हिलाए");
});

test("matchActions identifies singing", () => {
  const m = matchActions("कृष्ण बांसुरी बजाते हैं");
  assert.ok(m.hits.some((h) => h.id === "play"), "play should match बजाते");
});

test("matchActions identifies blooming", () => {
  const m = matchActions("फूल खिलता है");
  assert.ok(m.hits.some((h) => h.id === "open"), "open should match खिलता");
});

test("matchActions identifies sunrise", () => {
  const m = matchActions("सूरज उगता है");
  assert.ok(m.hits.some((h) => h.id === "ascend"), "ascend should match उगता");
});

// ---------------------------------------------------------------------------
// 3. Entities: subject / object / target (bible-first, heuristic fallback)
// ---------------------------------------------------------------------------

test("extractEntities resolves subject from bible by name", () => {
  const bible = { characters: [{ character_id: "elephant_01", name: "Hathi" }] };
  const e = extractEntities("Hathi raises its trunk", { language: "en", bible });
  assert.equal(e.subjects[0]?.text, "Hathi");
  assert.equal(e.subjects[0]?.id, "elephant_01");
  assert.equal(e.subjects[0]?.source, "bible");
});

test("extractEntities heuristics pick the first noun as subject (English)", () => {
  const e = extractEntities("The elephant raises its trunk", { language: "en" });
  assert.ok(e.subjects.some((s) => s.text === "elephant"), "elephant should be the subject");
  assert.ok(e.objects.some((o) => o.text === "trunk"), "trunk should be an object");
});

test("extractEntities Hindi subject-after-verb (पूँछ हिलाए प्यारा डॉगी)", () => {
  const m = matchActions("पूँछ हिलाए प्यारा डॉगी", { language: "hi" });
  const e = extractEntities("पूँछ हिलाए प्यारा डॉगी", { language: "hi", matches: m.hits, verbTokens: m.verbTokens });
  // Verb-final: subject comes after the verb → डॉगी is the subject, पूँछ is the object.
  assert.ok(e.subjects.some((s) => s.text === "डॉगी"), "डॉगी should be the subject");
  assert.ok(e.objects.some((o) => o.text === "पूँछ"), "पूँछ should be the object");
});

// ---------------------------------------------------------------------------
// 4. Action plan: verb template filled with the line's own entities
// ---------------------------------------------------------------------------

test("buildActionPlan builds a grounded action with the line's object", () => {
  const m = matchActions("The elephant raises its trunk", { language: "en" });
  const sem = {
    text: "The elephant raises its trunk",
    language: "en",
    entities: { subjects: [{ text: "elephant", id: "e1", kind: "noun", source: "heuristic" }], objects: [{ text: "trunk", id: "", kind: "noun", source: "heuristic" }], targets: [], locations: [], matched: [] },
    matches: m.hits,
  };
  const plan = buildActionPlan(sem);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, "raises the trunk");
  assert.equal(plan[0].grounded, true);
  assert.equal(plan[0].body_part, "arms");
});

test("buildActionPlan flags an unresolved verb instead of inventing", () => {
  const sem = {
    text: "The child does something impossible",
    language: "en",
    entities: { subjects: [], objects: [], targets: [], locations: [], matched: [] },
    matches: [],
  };
  const plan = buildActionPlan(sem);
  assert.equal(plan[0].grounded, false);
  assert.ok(plan[0].note.includes("no known verb matched"));
});

// ---------------------------------------------------------------------------
// 5. actionPhrase reads the verb in English (translated visual instruction)
// ---------------------------------------------------------------------------

test("actionPhrase fills the object slot", () => {
  assert.equal(actionPhrase("raise", "trunk"), "raises the trunk");
});

test("actionPhrase keeps an adjective bare (becomes sad, not becomes the sad)", () => {
  assert.equal(actionPhrase("become", "sad"), "becomes sad");
});

// ---------------------------------------------------------------------------
// 6. Camera from narrative meaning
// ---------------------------------------------------------------------------

test("planCamera chooses tracking for locomotion", () => {
  const cam = planCamera({ text: "The boy runs", line_kind: "action", matches: ACTION_LEXICON.filter((x) => x.id === "run") });
  assert.equal(cam.shot_type, "Tracking Shot");
  assert.equal(cam.movement, "Tracking");
});

test("planCamera chooses close-up for emotion / state change", () => {
  const cam = planCamera({
    text: "बच्चा उदास हो जाता है",
    line_kind: "action",
    matches: ACTION_LEXICON.filter((x) => x.id === "become"),
  });
  assert.equal(cam.shot_type, "Close-Up");
});

test("planCamera chooses wide/tracking for flight", () => {
  const cam = planCamera({
    text: "The bird flies",
    line_kind: "action",
    matches: ACTION_LEXICON.filter((x) => x.id === "fly"),
  });
  assert.equal(cam.shot_type, "Wide Shot");
  assert.equal(cam.movement, "Tracking Shot");
});

// ---------------------------------------------------------------------------
// 7. Beats tile the scene exactly; feasibility assessment
// ---------------------------------------------------------------------------

test("planBeats tiles multiple actions across the scene duration", () => {
  const sem = {
    text: "Hathi raises its trunk and walks",
    action_plan: [
      { id: "raise", action: "raises the trunk", body_part: "arms", motion: "lifts the trunk", duration_hint: 2, start_pose: "lowered", end_pose: "raised", grounded: true },
      { id: "walk", action: "walks the trunk", body_part: "legs", motion: "steps forward", duration_hint: 2, start_pose: "standing", end_pose: "walking", grounded: true },
    ],
  };
  const beats = planBeats(sem, { duration: 4 });
  assert.equal(beats.length, 2);
  const sum = beats.reduce((a, b) => a + (b.end_seconds - b.start_seconds), 0);
  assert.ok(Math.abs(sum - 4) < 0.01, `beats tile 4s, summed ${sum}`);
  assert.equal(beats[0].start_seconds, 0);
  assert.equal(beats[beats.length - 1].end_seconds, 4);
});

test("assessActionFeasibility warns when actions exceed scene time", () => {
  const fa = assessActionFeasibility(
    [{ id: "run", action: "runs", duration_hint: 3 }, { id: "jump", action: "jumps", duration_hint: 3 }],
    4);
  assert.equal(fa.feasible, false);
  assert.ok(fa.warnings.length > 0);
});

// ---------------------------------------------------------------------------
// 8. analyzeLine: the full deterministic record (preserves source text)
// ---------------------------------------------------------------------------

test("analyzeLine preserves the ORIGINAL Hindi text (never translates it)", () => {
  const s = analyzeLine("हाथी अपनी सूंड उठाता है", { index: 0 });
  assert.equal(s.source_text, "हाथी अपनी सूंड उठाता है");
  assert.equal(s.language, "hi");
  assert.equal(s.line_kind, "action");
  assert.ok(s.action_plan.some((a) => a.grounded));
});

test("analyzeLine English", () => {
  const s = analyzeLine("The elephant raises its trunk", { index: 0 });
  assert.equal(s.source_text, "The elephant raises its trunk");
  assert.equal(s.language, "en");
  assert.equal(s.action_plan[0].action, "raises the trunk");
  assert.ok(s.camera.shot_type && s.camera.movement);
});

test("analyzeLine Hinglish is flagged", () => {
  const s = analyzeLine("Munna हाथी दौड़ता है", { index: 0 });
  assert.equal(s.language, "hinglish");
});

test("analyzeLine abstract narration (no verb) is marked abstract", () => {
  const s = analyzeLine("वह बहुत उदास है", { index: 0 });
  assert.ok(s.abstract || s.line_kind === "emotion", `expected abstract/emotion, got kind=${s.line_kind} abstract=${s.abstract}`);
});

// ---------------------------------------------------------------------------
// 9. Scene semantic contract: validation detects missing/contradictory actions
// ---------------------------------------------------------------------------

test("validateSceneSemantics passes for a complete meaning-aware scene", () => {
  const sem = analyzeLine("The elephant raises its trunk", { index: 0 });
  const scene = {
    source_line: sem.source_text,
    source_line_id: sem.line_id,
    language: sem.language,
    semantic_meaning: sem.interpretation,
    line_kind: sem.line_kind,
    action_plan: sem.action_plan.map((a) => ({ action: a.action, body_part: a.body_part, start_pose: a.start_pose, end_pose: a.end_pose, motion: a.motion, grounded: a.grounded })),
    camera: sem.camera,
    camera_rationale: sem.camera.rationale,
    beats: sem.beats,
    duration_seconds: 4,
    characters: ["elephant_01"],
    continuity_from_previous_scene: "same clearing",
  };
  const v = validateSceneSemantics(scene, sem);
  assert.equal(v.ok, true, `expected valid, got errors: ${v.errors.join("; ")}`);
});

test("validateSceneSemantics fails when source line is missing", () => {
  const v = validateSceneSemantics({ title: "X" });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("source_text_preserved")));
});

test("validateSceneSemantics fails when no visible action", () => {
  const sem = analyzeLine("The boy runs", { index: 0 });
  const scene = {
    source_line: sem.source_text, language: "en", semantic_meaning: sem.interpretation,
    line_kind: "action", action_plan: [], camera: {}, beats: [], duration_seconds: 4,
  };
  const v = validateSceneSemantics(scene, sem);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("main_action")));
});

// ---------------------------------------------------------------------------
// 10. repairSceneSemantics fills camera/action/beats without inventing actions
// ---------------------------------------------------------------------------

test("repairSceneSemantics adds the camera rationale from meaning", () => {
  const sem = analyzeLine("बच्चा उदास हो जाता है", { index: 0 });
  const scene = { source_line: sem.source_text, language: "hi" };
  const fixed = repairSceneSemantics(scene, sem);
  assert.ok(fixed.camera.shot_type && fixed.camera.movement);
  assert.equal(fixed.camera_rationale, sem.camera.rationale);
  assert.ok(fixed.source_line);
});

// ---------------------------------------------------------------------------
// 11. Context + visual instruction builders (prompt-side)
// ---------------------------------------------------------------------------

test("buildSemanticContext emits per-line meaning rules", () => {
  const sem = [analyzeLine("The elephant raises its trunk", { index: 0 })];
  const ctx = buildSemanticContext(sem);
  assert.ok(ctx.includes("raises the trunk"));
  assert.ok(ctx.includes("MEANING ANALYSIS"));
});

test("buildEnglishVisualInstruction returns the English motion sentence", () => {
  const sem = analyzeLine("The elephant raises its trunk", { index: 0 });
  const inst = buildEnglishVisualInstruction(sem);
  assert.ok(inst.includes("raises"), `expected 'raises' in: ${inst}`);
});

// ---------------------------------------------------------------------------
// 12. Narration visuals (no generic stock visuals)
// ---------------------------------------------------------------------------

test("buildNarrationVisuals returns event + body part + camera", () => {
  const sem = analyzeLine("The elephant raises its trunk", { index: 0 });
  const nv = buildNarrationVisuals(sem);
  assert.ok(nv.event.includes("raises"));
  assert.ok(nv.camera.shot_type);
});

// ---------------------------------------------------------------------------
// 13. Timing alignment uses MEASURED audio (never fabricates)
// ---------------------------------------------------------------------------

test("alignSemanticsToTiming marks unaligned beats as estimated", () => {
  const sem = [analyzeLine("Line one", { index: 0 }), analyzeLine("Line two", { index: 1 })];
  const out = alignSemanticsToTiming(sem, { transcriptSegments: [], duration: 10 });
  assert.ok(out.every((s) => s.timing === "estimated"));
  assert.ok(out.every((s) => s.start_seconds == null));
});

test("alignSemanticsToTiming uses measured windows when transcript overlaps", () => {
  const sem = [analyzeLine("The boy runs", { index: 0 })];
  const out = alignSemanticsToTiming(sem, {
    transcriptSegments: [{ start: 0, end: 3, text: "the boy runs" }],
    duration: 10,
  });
  assert.equal(out[0].timing, "measured");
  assert.equal(out[0].start_seconds, 0);
  assert.equal(out[0].end_seconds, 3);
});

// ---------------------------------------------------------------------------
// 14. Lyric action plan (song workflow)
// ---------------------------------------------------------------------------

test("buildLyricActionPlan keeps chorus action consistent", () => {
  const sem = [
    analyzeLine("आया आया प्यारा डॉगी", { index: 0 }),
    analyzeLine("पूँछ हिलाए प्यारा डॉगी", { index: 1 }),
  ];
  const plan = buildLyricActionPlan(sem);
  assert.equal(plan.length, 2);
  assert.ok(plan[0].action);
  assert.ok(plan[1].action.includes("wags") || plan[1].action.includes("वाग"));
});

// ---------------------------------------------------------------------------
// 15. Voice map (Edge-TTS licensed ids, boy ≠ default female)
// ---------------------------------------------------------------------------

test("kidsVoiceForCharacter boys get male voice", () => {
  assert.equal(kidsVoiceForCharacter("Munna", "Hindi"), "hi-IN-MadhurNeural");
});

test("kidsVoiceForCharacter respects explicit voice id", () => {
  const map = buildKidsVoiceMap([{ name: "Raju", voice: "en-IN-PrabhatNeural" }], { language: "Hindi" });
  assert.equal(map.raju, "en-IN-PrabhatNeural");
});

test("isTtsVoiceId accepts Edge-TTS ids only", () => {
  assert.equal(isTtsVoiceId("hi-IN-SwaraNeural"), true);
  assert.equal(isTtsVoiceId("not a voice"), false);
});

// ---------------------------------------------------------------------------
// 16. mergeModelSemantics keeps original text even if model rewrites it
// ---------------------------------------------------------------------------

test("mergeModelSemantics preserves source text over model output", () => {
  const model = { lines: [{ line_id: 1, source_text: "TOTALLY DIFFERENT LINE", interpretation: "model reading" }] };
  const merged = mergeModelSemantics(model, [{ text: "हाथी अपनी सूंड उठाता है" }]);
  assert.equal(merged[0].source_text, "हाथी अपनी सूंड उठाता है");
  // model may enrich interpretation but cannot replace the line
});
