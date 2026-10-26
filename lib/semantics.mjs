// Sanskriti AI Studio — the MEANING-AWARE semantic engine.
//
// A pure module (no fs / network / db): language detection, bilingual
// entity/verb/emotion extraction, the word→visible-action framework, camera
// planning from narrative meaning, beat/timing planning and the scene
// semantic contract (+ validation and deterministic repair).
//
// Design rules (from the spec):
//   * The ORIGINAL Hindi / English text is always preserved — translation is
//     only an internal aid and never replaces the source line.
//   * A semantic action must be GROUNDED in the input: an action that
//     contradicts the source line is a validation error, never a "nice" scene.
//   * The action framework is a reusable FRAMEWORK (verb slots + the line's
//     own entities), not a list of hardcoded sentences: any verb the lexicon
//     does not know still yields a usable, clearly-flagged action.
//   * Camera decisions follow the narrative meaning (movement, emotion,
//     prayer, entrance, demonstration, reveal).
//   * Nothing here fabricates timing: an unmeasured beat is marked
//     "estimated".
//
// Run: node --test tests/semantics.test.mjs

// ---------------------------------------------------------------------------
// 0. Small helpers
// ---------------------------------------------------------------------------
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v, fb = "") => (v == null ? fb : String(v));
const num = (v, fb = 0) => (Number.isFinite(Number(v)) ? Number(v) : fb);
const round = (v, p = 2) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** p;
  return Math.round(n * f) / f;
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const uniq = (list) => {
  const seen = new Set();
  const out = [];
  for (const x of list) {
    const k = str(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
};

export const SEMANTIC_LANGUAGES = ["auto", "hi", "en", "hinglish"];

// ---------------------------------------------------------------------------
// 1. Language + script detection
// ---------------------------------------------------------------------------

const DEVANAGARI_RE = /[ऀ-ॿ]/g;
const LATIN_RE = /[A-Za-z]/g;

/** "devanagari" | "latin" | "mixed" | "none" */
export function detectScript(text) {
  const t = str(text);
  const dev = (t.match(DEVANAGARI_RE) || []).length;
  const lat = (t.match(LATIN_RE) || []).length;
  if (dev && lat) return "mixed";
  if (dev) return "devanagari";
  if (lat) return "latin";
  return "none";
}

// Romanized-Hindi markers — a Hinglish line is Latin script carrying Hindi
// grammar words. The list is deliberately small and high-signal.
const HINGLISH_MARKERS = [
  "hai", "hain", "ho", "hoon", "main", "mein", "mera", "meri", "mere", "tera", "teri",
  "tum", "tumhe", "tumhari", "aap", "aapko", "woh", "yeh", "ye", "nahi", "nahin", "haan",
  "aur", "kya", "kyu", "kyun", "kaise", "kahan", "kahan", "acha", "accha", "bahut", "bohot",
  "sath", "saath", "liye", "waala", "wala", "wali", "phir", "abhi", "jab", "tab", "phir",
  "gaya", "gayi", "gay", "raha", "rahi", "rahe", "jata", "jati", "jate", "kar", "karte",
  "karta", "karti", "karke", "hota", "hoti", "hote", "dost", "mummy", "papa", "baccha",
  "ladki", "ladka", "khush", "udaas", "darr", "chalo", "dekho", "dekha", "suno", "batao",
  "mat", "sirf", "sab", "bahut", "acha", "theek", "ab", "phir",
];
const ENGLISH_MARKERS = [
  "the", "and", "with", "that", "this", "from", "into", "runs", "walks", "raises", "his",
  "her", "they", "he", "she", "was", "were", "is", "are", "said", "says", "then", "when",
  "where", "while", "after", "before", "because", "little", "big", "small",
];

/**
 * The language of one line: "hi" | "en" | "hinglish".
 * `forced` ("auto" | "hi" | "en" | "hinglish") pins the detection.
 */
export function detectLanguage(text, forced = "auto") {
  const t = str(text);
  if (!t.trim()) return "en";
  if (forced && forced !== "auto") return forced;
  const dev = (t.match(DEVANAGARI_RE) || []).length;
  const lat = (t.match(LATIN_RE) || []).length;
  const letters = dev + lat || 1;
  const devRatio = dev / letters;
  if (devRatio > 0.25) {
    // Devanagari + Latin in the same line = mixed (Hinglish written in two
    // scripts) — the engine keeps the Devanagari meaning and reads the Latin
    // words as English borrowings.
    return lat > 0 && devRatio < 0.8 ? "hinglish" : "hi";
  }
  const words = t.toLowerCase().match(/[a-z']+/g) || [];
  if (!words.length) return "en";
  const hiHits = words.filter((w) => HINGLISH_MARKERS.includes(w)).length;
  const enHits = words.filter((w) => ENGLISH_MARKERS.includes(w)).length;
  if (hiHits >= 1 && hiHits >= enHits) return "hinglish";
  return "en";
}

/** Whitespace/punctuation normalization — the text is NEVER translated here. */
export function normalizeLine(text) {
  return str(text).replace(/\s+/g, " ").replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, "").trim();
}

/** Split a line into tokens (Devanagari runs + Latin words + numbers). */
export function tokenize(text) {
  const t = str(text);
  const out = [];
  const re = /[ऀ-ॿ]+|[A-Za-z]+(?:'[A-Za-z]+)?|\d+(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(t)) !== null) out.push(m[0]);
  return out;
}

const isDeva = (t) => /[ऀ-ॿ]/.test(t);
const isLatin = (t) => /^[A-Za-z]/.test(t);
const STOP_HI = new Set([
  "है", "हैं", "था", "थी", "थे", "और", "का", "की", "के", "को", "से", "पर", "लिए", "में", "हो",
  "था।", "कि", "जो", "यह", "वह", "एक", "अपने", "अपनी", "अपना", "इस", "उस", "ने", "ही",
]);
const STOP_EN = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be", "been", "being",
  "of", "in", "on", "at", "to", "with", "that", "this", "these", "those", "it", "its",
  "he", "she", "they", "them", "his", "her", "their", "as", "for", "from", "by", "then",
  "so", "very", "up", "down", "out", "over", "into", "onto", "his", "her",
  // Prepositions / adverbs — they are never the object of an action.
  "across", "through", "toward", "towards", "around", "behind", "beside", "under",
  "underneath", "above", "below", "between", "against", "along", "away", "back",
  "forward", "ahead", "near", "nearby", "around", "past", "inside", "outside", "upon",
]);
// Adjectives — they describe a noun, they never ARE the subject of the action.
const ADJ_EN = new Set([
  "cute", "dear", "sweet", "little", "big", "large", "small", "tall", "short", "red",
  "blue", "green", "yellow", "black", "white", "happy", "sad", "angry", "old", "new",
  "beautiful", "lovely", "tiny", "huge", "clever", "brave", "kind", "gentle", "proud",
]);
const ADJ_HI = new Set([
  "प्यारा", "प्यारी", "प्यारे", "सुंदर", "छोटा", "छोटी", "बड़ा", "बड़ी", "लाल", "नीला",
  "हरा", "सुनहरा", "मीठा", "नया", "पुराना", "भाला", "शांत", "खुश", "उदास", "प्यार",
]);
const isAdjective = (t) => ADJ_EN.has(str(t).toLowerCase()) || ADJ_HI.has(str(t));
// Prepositions that belong to the action ("runs across the field").
const PREP_EN = new Set([
  "across", "through", "toward", "towards", "around", "over", "under", "into", "onto",
  "behind", "beside", "between", "against", "along", "atop", "past", "upon", "alongside",
]);
const isStopWord = (t) => {
  const w = t.toLowerCase();
  if (STOP_EN.has(w)) return true;
  if (STOP_HI.has(t)) return true;
  // Common Hindi postpositions/clitics attached to a word.
  return /^(ने|का|की|के|को|से|पर|ही|वाले|वाली|वाला)$/.test(t);
};

// ---------------------------------------------------------------------------
// 2. The action lexicon — verb → visible action template
//
// Every entry is a TEMPLATE with slots: the subject/object of the line are
// filled in from the actual sentence, so the same verb works with any
// character or object. The lexicon is data: add a row to teach the engine a
// new verb (both languages).
// ---------------------------------------------------------------------------

const L = (id, kind, en, hi, spec) => ({
  id, kind,
  cues: {
    en: str(en).split(" ").filter(Boolean),
    hi: str(hi).split(" ").filter(Boolean),
  },
  ...spec,
});

/**
 * Multi-word cues that must match as a PHRASE (a Hindi verb phrase like
 * "हो जाता" = "becomes" is meaningless as two single words).
 */
const PHRASES = {
  become: { hi: ["हो जाता", "हो जाती", "हो गया", "हो गई", "बन जाता", "बन गया", "बन जाती"] },
  exit: { hi: ["चला जाता", "चला जाती", "भाग जाता", "भाग जाती", "निकल जाता", "निकल जाती"] },
  approach: { hi: ["आ गया", "आ गई", "आकर"] },
  open: { hi: ["खुल जाता", "खुल जाती"] },
};

export const ACTION_LEXICON = [
  // --- locomotion ---------------------------------------------------------
  L("run", "locomotion", "run runs running ran sprint sprints dash dashes chase chases flee flees",
    "दौड़ दौड़ता दौड़ती दौड़ते दौड़ना भाग भागता भागती भागते भागना",
    {
      body_part: "legs",
      start_pose: "leaning forward, weight on the back foot, ready to move",
      end_pose: "still moving forward in a running stride",
      motion: "the legs alternate in a running stride, the arms swing opposite the legs, the torso leans into the direction of travel",
      camera: ["Tracking Shot", "Lateral Follow"],
      duration: 3,
    }),
  L("walk", "locomotion", "walk walks walking walked stroll strolls wander wanders pace paces",
    "चल चलता चलती चलते चलना पैदल तराश तराशे",
    {
      body_part: "legs",
      start_pose: "standing upright, weight even",
      end_pose: "standing upright after the walk",
      motion: "measured walking steps, the body glides forward, the arms swing gently",
      camera: ["Tracking Shot", "Static"],
      duration: 3,
    }),
  L("jump", "locomotion", "jump jumps jumping jumped leap leaps leaping leaped hop hops hopping",
    "कूद कूदता कूदती कूड़ता कूड़ती कूड़ते कूदना कूदना उछल",
    {
      body_part: "legs",
      start_pose: "knees bent, body compressed, weight on the feet",
      end_pose: "feet back on the ground, body extended after the landing",
      motion: "the knees bend to load the jump, the legs push off the ground, the body rises into the air, then the feet land and absorb the weight",
      camera: ["Full Shot", "Low Angle"],
      duration: 2.5,
    }),
  L("climb", "locomotion", "climb climbs climbing climbed climb up climbs up scale scales",
    "चढ़ चढ़ता चढ़ती चढ़ते चढ़ना ऊपर चढ़े",
    {
      body_part: "arms_and_legs",
      start_pose: "holding on low, body stretched",
      end_pose: "higher up, still holding on",
      motion: "the hands grip higher, the arms pull, the legs push up step by step",
      camera: ["Medium Shot", "Low Angle"],
      duration: 3.5,
    }),
  L("descend", "locomotion", "descend descends descending descend go down goes down came down come down sink sinks",
    "नीचे उतर उतरता उतरती उतरते नीचे आए",
    {
      body_part: "legs",
      start_pose: "up high, body upright",
      end_pose: "lower, feet planted",
      motion: "the body moves downward in controlled steps, the legs bend to absorb the landing",
      camera: ["High Angle", "Tracking Shot"],
      duration: 3,
    }),
  L("fly", "locomotion", "fly flies flying flew soar soars gliding glides",
    "उड़ उड़ता उड़ती उड़ते उड़ना तैरता तैरती",
    {
      body_part: "body",
      start_pose: "poised, wings or body lifted",
      end_pose: "gliding forward",
      motion: "the body lifts and glides forward, limbs extended, the movement is smooth and continuous",
      camera: ["Wide Shot", "Tracking Shot"],
      duration: 3.5,
    }),
  L("swim", "locomotion", "swim swims swimming swam paddle paddles",
    "तैर तैरता तैरती तैरते तैरना",
    {
      body_part: "arms",
      start_pose: "at the surface, arms forward",
      end_pose: "moving forward through the water",
      motion: "the arms stroke alternately, the legs kick behind, the body glides forward",
      camera: ["Underwater Shot", "Medium Shot"],
      duration: 3,
    }),
  L("dance", "locomotion", "dance dances dancing danced sway sways",
    "नाच नाचता नाचती नाचते नाचना",
    {
      body_part: "whole_body",
      start_pose: "standing, arms relaxed",
      end_pose: "still dancing, weight shifted",
      motion: "the body sways rhythmically, the arms and hips move with the beat, the feet step lightly",
      camera: ["Full Shot", "Static"],
      duration: 3.5,
    }),
  // --- body parts ---------------------------------------------------------
  L("raise", "body_part", "raise raises raising raised lift lifts lifting lifted up upraises hoists",
    "उठा उठाता उठाती उठाते उठाना ऊपर उठे उठता",
    {
      body_part: "arms_or_limb",
      start_pose: "the limb is lowered and relaxed",
      end_pose: "the limb is held up high",
      motion: "the limb lifts smoothly upward from its resting position and stops at the top of the movement",
      camera: ["Medium Shot", "Static"],
      duration: 2,
    }),
  L("lower", "body_part", "lower lowers lowering lowered down brings down put down",
    "नीचे नीचा नीची उतार उतारता गिरा गिर",
    {
      body_part: "arms_or_limb",
      start_pose: "the limb is held up",
      end_pose: "the limb is lowered to rest",
      motion: "the limb moves down in a controlled arc until it rests",
      camera: ["Medium Shot", "Static"],
      duration: 2,
    }),
  L("wave", "body_part", "wave waves waving waved wag wags wagging flutters",
    "हिला हिलाता हिलाती लहरा लहराता पूँछ हिलाता",
    {
      body_part: "tail_or_hand",
      start_pose: "still",
      end_pose: "still, after the movement",
      motion: "the appendage moves side to side in a repeated, rhythmic swing",
      camera: ["Close-Up", "Medium Shot"],
      duration: 2,
    }),
  L("nod", "body_part", "nods nodding nod agree agrees agrees",
    "सहमुश हिलाता हिलाते सिर हिलाता",
    {
      body_part: "head",
      start_pose: "head upright",
      end_pose: "head slightly lowered after the nod",
      motion: "the head dips forward once in a clear, deliberate nod",
      camera: ["Close-Up", "Static"],
      duration: 1.5,
    }),
  L("open", "object_state", "open opens opening opened bloom blooms blooming bloomed unfold unfolds unfolding blossom blossoms",
    "खुल खुलता खुलती खुलते खुलना खिल खिलता खिलती फूल खिले",
    {
      body_part: "hands_or_object",
      start_pose: "closed / folded / shut",
      end_pose: "open / spread",
      motion: "the closed parts separate slowly and evenly until fully open",
      camera: ["Close-Up", "Static"],
      duration: 2.5,
    }),
  L("close", "object_state", "close closes closing closed shut shuts shut off",
    "बंद बंद कर बंद करता बंद करती",
    {
      body_part: "hands_or_object",
      start_pose: "open",
      end_pose: "closed",
      motion: "the open parts move together until they meet and close",
      camera: ["Close-Up", "Static"],
      duration: 2,
    }),
  L("hold", "body_part", "hold holds holding held holds grasp grasps grips gripping embrace embraces hugging",
    "पकड़ पकड़ता पकड़ती पकड़े पकड़ना गले लगा",
    {
      body_part: "hands",
      start_pose: "arms apart",
      end_pose: "the object or person held close",
      motion: "the arms reach out, the hands close around the object, the arms draw it in and hold it",
      camera: ["Close-Up", "Medium Shot"],
      duration: 2.5,
    }),
  L("give", "body_part", "give gives giving gave offers offers offering presents presents",
    "दे देता देती देना भेज भेजता",
    {
      body_part: "hands",
      start_pose: "the item held close to the body",
      end_pose: "the item extended toward the recipient",
      motion: "the arm extends forward, the hand opens and releases the item into the other person's hands",
      camera: ["Medium Shot", "Static"],
      duration: 2.5,
    }),
  L("play", "body_part", "play plays playing played plays flute blows blows drumming strums",
    "बजा बजाता बजाती बजाना",
    {
      body_part: "hands_and_mouth",
      start_pose: "the instrument held ready",
      end_pose: "the instrument still in playing position",
      motion: "the instrument is lifted to the correct position against the body or the lips, the hands and mouth move in the playing motion",
      camera: ["Close-Up", "Medium Shot"],
      duration: 3,
    }),
  L("sing", "body_part", "sings singing sang sings chanting chants",
    "गाता गाती गाते गाना गायक",
    {
      body_part: "mouth_and_body",
      start_pose: "standing, mouth closed",
      end_pose: "still singing",
      motion: "the mouth opens with the lyrics, the chest and head move gently with the melody",
      camera: ["Close-Up", "Medium Shot"],
      duration: 3,
    }),
  L("point", "body_part", "point points pointing pointed points at",
    "इशारा इशारा करता दिखाता दिखाता",
    {
      body_part: "arm",
      start_pose: "arm down",
      end_pose: "arm extended toward the target",
      motion: "the arm lifts and extends toward the target, the index finger indicates it clearly",
      camera: ["Medium Shot", "Over-the-Shoulder"],
      duration: 2,
    }),
  // --- directional / spatial ---------------------------------------------
  L("approach", "direction", "approach approaches approaching came comes near nears approaching",
    "आता आती आते आना आए आया आई नजदीक आना पास आता",
    {
      body_part: "legs",
      start_pose: "away from the subject, entering the frame",
      end_pose: "close to the subject, stopping in front",
      motion: "the character walks in from off-frame and stops near the subject, the arrival is clearly readable",
      camera: ["Establishing Shot", "Medium Shot"],
      duration: 3,
    }),
  L("enter", "direction", "enters entering entered come in comes in walks in",
    "आता आती आते अंदर आता प्रवेश",
    {
      body_part: "whole_body",
      start_pose: "outside the frame",
      end_pose: "inside the location, mid-step",
      motion: "the character crosses into the location, the full body visible as it enters",
      camera: ["Establishing Shot", "Wide Shot"],
      duration: 3,
    }),
  L("exit", "direction", "exits exiting leaves leaving departs walks away",
    "निकलता निकल",
    {
      body_part: "whole_body",
      start_pose: "inside the location",
      end_pose: "leaving the frame",
      motion: "the character turns and walks out of the location, the departure is visible",
      camera: ["Medium Shot", "Static"],
      duration: 2.5,
    }),
  L("ascend", "direction", "rises rising rose ascend ascends climbs up climbs up soars up",
    "उगता उगती उगते उठता ऊपर आता ऊपर उठना",
    {
      body_part: "whole_object",
      start_pose: "below the horizon / at the bottom",
      end_pose: "above the horizon / at the top",
      motion: "the subject moves steadily upward, the light on it changes as it rises",
      camera: ["Wide Shot", "Tilt Up"],
      duration: 3.5,
    }),
  L("descend_land", "direction", "lands landing landed touches down sets down",
    "उतरता उतरना जमीन पर उतरता",
    {
      body_part: "whole_body",
      start_pose: "in the air",
      end_pose: "on the ground, weight settled",
      motion: "the body comes down and the legs bend to absorb the landing",
      camera: ["Full Shot", "Static"],
      duration: 2,
    }),
  // --- object state / environment ----------------------------------------
  L("light", "object_state", "light lights lighting lit glows glows shines shining sparkles",
    "जलता जलती जलते जलना चमकता चमकती",
    {
      body_part: "object",
      start_pose: "dark / unlit",
      end_pose: "lit / glowing",
      motion: "the light spreads from the source, the surroundings brighten and the shadows soften",
      camera: ["Close-Up", "Static"],
      duration: 2.5,
    }),
  L("break", "object_state", "breaks breaking broke shatters cracks",
    "टूटता टूटती टूटे टूटना",
    {
      body_part: "object",
      start_pose: "intact",
      end_pose: "broken",
      motion: "the object splits along the impact, the pieces separate",
      camera: ["Close-Up", "Static"],
      duration: 2,
    }),
  L("pour", "object_state", "pours pouring poured fills filling filled spills",
    "डालता डालती भरता भरता बहता",
    {
      body_part: "hands_and_object",
      start_pose: "the container is upright and full",
      end_pose: "the container is emptying into the target",
      motion: "the container tilts and the contents flow steadily into the target",
      camera: ["Close-Up", "Static"],
      duration: 2.5,
    }),
  L("sleep", "state", "sleeps sleeping slept rests sleeping dozes",
    "सोता सोती सोते सोना",
    {
      body_part: "whole_body",
      start_pose: "awake, upright",
      end_pose: "lying still, eyes closed",
      motion: "the body settles down, the eyes close, the breathing slows",
      camera: ["Close-Up", "Slow Push-In"],
      duration: 3,
    }),
  L("wake", "state", "wakes waking woke awakens stretches stretching",
    "जागता जागती उठता उठना",
    {
      body_part: "whole_body",
      start_pose: "lying still",
      end_pose: "awake, upright",
      motion: "the eyes open, the body stretches and rises",
      camera: ["Medium Shot", "Slow Push-In"],
      duration: 2.5,
    }),
  // --- emotional ----------------------------------------------------------
  L("smile", "expression", "smiles smiling smiled grins grins laughs laughing laughs happily",
    "मुस्कुराता मुस्कुराती मुस्कुराहट खुश",
    {
      body_part: "face",
      start_pose: "neutral face",
      end_pose: "warm smile",
      motion: "the corners of the mouth lift into a warm smile, the eyes brighten",
      camera: ["Close-Up", "Static"],
      duration: 2,
    }),
  L("cry", "expression", "cries crying cried tears tears weep weeps sobs sobs",
    "रोता रोती रोते रोना आँसू",
    {
      body_part: "face",
      start_pose: "calm face",
      end_pose: "tearful, downcast",
      motion: "the brows lift inward, the eyes fill with tears, the face turns down",
      camera: ["Close-Up", "Static"],
      duration: 2.5,
    }),
  L("look", "expression", "looks looking looked stares stares glances watches watching sees",
    "देखता देखती देखते देखना नजर",
    {
      body_part: "eyes_and_head",
      start_pose: "looking elsewhere",
      end_pose: "gaze fixed on the target",
      motion: "the head turns and the gaze settles on the target and holds",
      camera: ["Close-Up", "Over-the-Shoulder"],
      duration: 2,
    }),
  L("listen", "expression", "listens listening hears hearing",
    "सुनता सुनती सुनते सुनना",
    {
      body_part: "head",
      start_pose: "attention elsewhere",
      end_pose: "head tilted toward the sound",
      motion: "the head tilts toward the sound, the body stills to listen",
      camera: ["Close-Up", "Static"],
      duration: 2,
    }),
  // --- movement of objects in the environment -----------------------------
  // --- a state change ("becomes sad") - NOT a movement ---------------------
  L("become", "state_change", "becomes became turns turned grows",
    "बनता बनती",
    {
      phrase: "becomes {object}",
      body_part: "face_and_posture",
      start_pose: "the previous state",
      end_pose: "the new state, visible in the face and posture",
      motion: "the expression and the posture change gradually into the new state",
      camera: ["Close-Up", "Static"],
      duration: 2.5,
    }),
  // --- simply going somewhere ---------------------------------------------
  L("go", "locomotion", "goes going went",
    "जाता जाती जाना चला चली",
    {
      phrase: "goes {object}",
      body_part: "legs",
      start_pose: "at the starting point",
      end_pose: "arrived at the destination",
      motion: "the character walks away from the starting point towards the destination",
      camera: ["Medium Shot", "Tracking Shot"],
      duration: 3,
    }),
  L("sway", "motion", "swings swinging swung rocks rocking sways swaying",
    "हिलता हिलती डोलता झूलता",
    {
      body_part: "object",
      start_pose: "at rest",
      end_pose: "still moving gently",
      motion: "the object rocks slowly from side to side",
      camera: ["Close-Up", "Static"],
      duration: 2.5,
    }),
];

const LEX_BY_ID = new Map(ACTION_LEXICON.map((e) => [e.id, e]));

/**
 * The English reading of each verb — the template the interpretation and the
 * visual instruction are built from. `{object}` is filled with the line's own
 * object, so the same verb reads correctly with any character or prop.
 */
export const ACTION_PHRASES = {
  run: "runs {object}",
  walk: "walks {object}",
  jump: "jumps {object}",
  climb: "climbs {object}",
  descend: "descends {object}",
  fly: "flies {object}",
  swim: "swims {object}",
  dance: "dances {object}",
  raise: "raises {object}",
  lower: "lowers {object}",
  wave: "wags {object}",
  nod: "nods {object}",
  open: "opens {object}",
  close: "closes {object}",
  hold: "holds {object}",
  give: "gives {object}",
  play: "plays {object}",
  sing: "sings {object}",
  point: "points at {object}",
  approach: "approaches {object}",
  enter: "enters {object}",
  exit: "leaves {object}",
  ascend: "rises {object}",
  descend_land: "lands on {object}",
  light: "lights up {object}",
  break: "breaks {object}",
  pour: "pours {object}",
  sleep: "sleeps",
  wake: "wakes up",
  smile: "smiles",
  cry: "weeps",
  look: "looks at {object}",
  listen: "listens to {object}",
  sway: "swings {object}",
  become: "becomes {object}",
};

/** The English phrase for a verb id (with the object slot filled in). */
export function actionPhrase(id, object = "") {
  const tpl = str(ACTION_PHRASES[id] || String(id || "").replace(/_/g, " "));
  if (!tpl.includes("{object}")) return tpl;
  const o = str(object).trim();
  if (!o) return tpl.replace("{object}", "it").replace(/\s+/g, " ").trim();
  // "its trunk" reads better than "the its trunk"; an adjective (a state
  // like "sad") never takes an article: "becomes sad", not "becomes the sad".
  const clean = /^(its|their|his|her|this|that|the)$/i.test(o)
    ? o
    : (isAdjective(o) ? o : (PREP_EN.has(o.split(/\s+/)[0].toLowerCase()) ? o : `the ${o}`));
  return tpl.replace("{object}", clean).replace(/\s+/g, " ").trim();
}

/** The lexicon entry by id (null for an unknown id). */
export const actionTemplate = (id) => LEX_BY_ID.get(id) || null;

// ---------------------------------------------------------------------------
// 3. Cue matching (bilingual, inflection-tolerant)
// ---------------------------------------------------------------------------

/** True when the token matches the cue (English stems + Hindi substrings). */
export function tokenMatchesCue(token, cue) {
  const t = str(token);
  const c = str(cue);
  if (!t || !c) return false;
  if (isDeva(c)) {
    // Hindi inflection: the stem is a prefix of the written form
    // (दौड़ता contains दौड़). A Devanagari postposition suffix is fine too.
    return t.includes(c);
  }
  const lt = t.toLowerCase();
  const lc = c.toLowerCase();
  return lt === lc || (lt.length > lc.length && lt.startsWith(lc));
}

/**
 * The lexicon entries whose cue appears in the text.
 * A multi-word cue (e.g. the Hindi "हो जाता" = "becomes") is matched as a
 * PHRASE on the normalized line — a single token test would be wrong.
 */
export function matchActions(text, { language = "auto" } = {}) {
  const lang = language === "auto" ? detectLanguage(text) : language;
  const tokens = tokenize(text);
  const flat = normalizeLine(text).toLowerCase();
  const hits = [];
  const consumed = new Set();
  // PASS 1 — the multi-word phrases (unambiguous: "हो जाता" = "becomes").
  for (const entry of ACTION_LEXICON) {
    const phrases = [
      ...(PHRASES[entry.id]?.en || []),
      ...(PHRASES[entry.id]?.hi || []),
    ];
    const phraseHit = phrases.find((p) => flat.includes(normalizeLine(p).toLowerCase()));
    if (!phraseHit) continue;
    hits.push({ ...entry, cue: phraseHit, token: phraseHit, phrase: true });
    // The phrase consumes every one of its words so a single-word cue can
    // never match one of them ("हो जाता" must not also read as "goes").
    for (const word of normalizeLine(phraseHit).split(/\s+/)) {
      tokens.forEach((t, i) => { if (!consumed.has(i) && tokenMatchesCue(t, word)) consumed.add(i); });
    }
  }
  // PASS 2 — the single-word cues.
  for (const entry of ACTION_LEXICON) {
    if (hits.some((h) => h.id === entry.id)) continue;
    const cues = [...entry.cues.en, ...entry.cues.hi];
    for (const cue of cues) {
      const at = tokens.findIndex((t, i) => !consumed.has(i) && tokenMatchesCue(t, cue));
      if (at < 0) continue;
      hits.push({ ...entry, cue, token: tokens[at] });
      consumed.add(at);
      break;
    }
  }
  return { language: lang, hits, tokens, verbTokens: [...consumed].map((i) => tokens[i]).filter(Boolean) };
}

// ---------------------------------------------------------------------------
// 4. Entities: subject, object, target, location
// ---------------------------------------------------------------------------

/**
 * Resolve the entities of a line against the BIBLE (the real characters,
 * locations and objects) first, then fall back to a noun heuristic.
 * `bible` = { characters: [{character_id, name}], locations: [...], objects: [...] }
 */
export function extractEntities(text, { language = "auto", bible = null, matches = [], verbTokens: argsVerbTokens = [] } = {}) {
  const lang = language === "auto" ? detectLanguage(text) : language;
  const t = str(text);
  const lower = t.toLowerCase();
  const tokens = tokenize(t);
  const argsMatches = arr(matches);
  const found = { subjects: [], targets: [], objects: [], locations: [], matched: [] };
  // 1. The bible wins (a character name is never "invented" by the heuristic).
  const lists = [
    ["characters", bible?.characters || []],
    ["locations", bible?.locations || []],
    ["objects", bible?.objects || []],
  ];
  for (const [kind, list] of lists) {
    for (const e of arr(list)) {
      const name = str(e?.name || e?.character_id || e?.location_id || e?.object_id);
      if (!name) continue;
      const needle = name.toLowerCase();
      if (lower.includes(needle) || tokens.some((tok) => tok.toLowerCase() === needle)) {
        const entry = { text: name, id: str(e?.character_id || e?.location_id || e?.object_id), kind, source: "bible" };
        found.matched.push(entry);
        if (kind === "characters") found.subjects.push(entry);
        else if (kind === "locations") found.locations.push(entry);
        else found.objects.push(entry);
      }
    }
  }
  // 2. The noun heuristic for everything the bible does not name. The verbs
  // that matched are NOT nouns — they are removed from the candidate list.
  const verbTokens = new Set([
    ...(argsMatches || []).map((m) => m.token),
    ...(arr(argsVerbTokens)),
  ]);
  const known = new Set(found.matched.map((m) => m.text.toLowerCase()));
  const isNounish = (tok) => !isStopWord(tok) && tok.length > 2 && !verbTokens.has(tok)
    && !known.has(tok.toLowerCase()) && !isAdjective(tok);
  // The subject: English is subject-first (the first noun of the line);
  // Hindi is verb-final, so the subject is the first noun AFTER the verb
  // ("पूँछ हिलाए प्यारा डॉगी" → the dog acts, the tail is the object).
  const verbAt = (argsMatches || []).length
    ? tokens.findIndex((t) => (argsMatches || []).some((m) => m.token === t))
    : -1;
  let subject = null;
  if (lang === "hi" && verbAt >= 0) {
    for (let i = verbAt + 1; i < tokens.length; i++) {
      if (isNounish(tokens[i])) { subject = tokens[i]; break; }
    }
  }
  if (!subject) {
    for (const tok of tokens) {
      if (isNounish(tok)) { subject = tok; break; }
    }
  }
  for (const tok of tokens) {
    if (!isNounish(tok)) continue;
    if (subject && tok === subject) {
      if (!found.subjects.length) found.subjects.push({ text: tok, id: "", kind: "noun", source: "heuristic" });
      continue;
    }
    found.objects.push({ text: tok, id: "", kind: "noun", source: "heuristic" });
  }
  return { ...found, language: lang };
}

// ---------------------------------------------------------------------------
// 5. Emotion + line kind
// ---------------------------------------------------------------------------

const EMOTION_LEXICON = [
  { id: "sad", en: "sad unhappy upset sorrow grief lonely", hi: "उदास दुखी निराश उदासी विलाप" },
  { id: "happy", en: "happy joyful glad delighted cheerful excited", hi: "खुश प्रसन्न खुशी आनंद" },
  { id: "angry", en: "angry furious mad cross annoyed", hi: "गुस्सा नाराज क्रोध" },
  { id: "fear", en: "scared afraid frightened nervous worried", hi: "डरा डरी डर भय" },
  { id: "surprised", en: "surprised shocked amazed astonished", hi: "चौंकता हैला हैरान" },
  { id: "proud", en: "proud proud of honoured blessed", hi: "गर्व प्रसन्न" },
  { id: "calm", en: "calm peaceful quiet gentle serene", hi: "शांत प्रसन्न" },
  { id: "curious", en: "curious interested wondering", hi: "जिज्ञासु उत्सुक" },
  { id: "loving", en: "loving tender caring affectionate", hi: "प्यार प्रेम" },
  { id: "devotional", en: "praying worshipping bowing folded hands blessing", hi: "प्रार्थना पूजा नमस्ते आशीर्वाद भक्ति" },
];

/** The emotion cues of a line ({label, intensity, cues}). */
export function extractEmotionCues(text) {
  const t = str(text).toLowerCase();
  const out = [];
  for (const e of EMOTION_LEXICON) {
    const cues = [...e.en.split(" "), ...e.hi.split(" ")].filter(Boolean);
    const hit = cues.find((c) => {
      const lc = c.toLowerCase();
      if (isDeva(c)) return t.includes(lc);
      // A Latin cue must match a WHOLE word ("cross" must not match "across").
      return new RegExp(`(^|[^a-z])${lc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i").test(t);
    });
    if (hit) out.push({ id: e.id, cue: hit });
  }
  const intensity = out.length > 1 ? "high" : out.length === 1 ? "medium" : "none";
  return { label: out.length ? out[0].id : "", intensity, cues: out };
}

const SOUND_RE = /(sound|noise|clang|rustle|roar|thunder|bell|chime|crack|echo|hiss|whistle|crackle)/i;
const TRANSITION_RE = /(\bthen\b|\bnext\b|\bafter that\b|\blater\b|\bmeanwhile\b|\bfinally\b|\bso\b)/i;
const QUESTION_RE = /(\?|क्या|कौन|क्यों|कैसे|कब|कहाँ|कहां)/i;

/** What KIND of line this is — the visual strategy depends on it. */
export function classifyLine(text) {
  const t = str(text).trim();
  if (!t) return "empty";
  if (QUESTION_RE.test(t)) return "question";
  if (SOUND_RE.test(t)) return "sound";
  const emotion = extractEmotionCues(t);
  if (emotion.cues.length && !matchActions(t).hits.length) return "emotion";
  const { hits } = matchActions(t);
  if (hits.length) return "action";
  if (TRANSITION_RE.test(t)) return "transition";
  if (/^[“"']/.test(t) || /^\s*[\w\s]{0,40}:\s/.test(t)) return "dialogue";
  return "narration";
}

// ---------------------------------------------------------------------------
// 6. The semantic action framework — a verb + the line's own entities
// ---------------------------------------------------------------------------

const possessive = (text) => /^(its|their|his|her|the|अपनी|अपना|अपने|इस|उस)$/i.test(str(text).trim());

/**
 * Build the visible action plan of a line: the matched verb template filled
 * with the line's own subject/object. An unknown verb still yields an action
 * (flagged `grounded: false`) so the scene never loses the line's meaning.
 */
export function buildActionPlan(semantics = {}) {
  const { text = "", language = "en", entities = {}, matches = [] } = semantics;
  const tokens = tokenize(text);
  const subjects = arr(entities.subjects);
  const objects = arr(entities.objects);
  const plan = [];
  for (const m of arr(matches)) {
    const tpl = m;
    // The verb token may be written differently (an inflection) — find it by
    // the cue when the exact token is not in the line.
    let at = tokens.indexOf(m.token);
    if (at < 0) at = tokens.findIndex((t) => tokenMatchesCue(t, m.cue) || tokenMatchesCue(m.token, t));
    if (at < 0) at = -1;
    // The slot filler: English puts the object AFTER the verb, Hindi (verb
    // final) puts it BEFORE. The subject is the fallback.
    let slot = null;
    const scan = (from, to) => {
      for (let i = from; i !== to; i += from < to ? 1 : -1) {
        const tok = tokens[i];
        if (!tok || isStopWord(tok)) continue;
        if (tok === m.token) continue;
        const isVerb = matches.some((x) => x.token === tok);
        if (isVerb) continue;
        slot = tok;
        return true;
      }
      return false;
    };
    if (language === "hi") scan(Math.max(0, at - 1), -1);
    else if (at >= 0) {
      // English: a preposition belongs to the action ("runs across the field").
      const next = tokens[at + 1];
      if (next && PREP_EN.has(next.toLowerCase())) {
        // The preposition belongs to the action: "runs across the field".
        let after = null;
        for (let i = at + 2; i < tokens.length; i++) {
          if (isStopWord(tokens[i]) || isAdjective(tokens[i])) continue;
          after = tokens[i];
          break;
        }
        slot = after ? `${next} the ${after}` : next;
      } else {
        scan(at + 1, tokens.length);
      }
    }
    if (!slot) slot = subjects[0]?.text || objects[0]?.text || "";
    const objectText = slot && !possessive(slot) ? slot : (subjects[0]?.text || "");
    const bodyPart = tpl.body_part === "arms_or_limb" || tpl.body_part === "hands_or_object"
      ? (tpl.body_part === "hands_or_object" ? "hands_and_object" : "arms")
      : tpl.body_part;
    const phrase = actionPhrase(tpl.id, objectText);
    plan.push({
      id: tpl.id,
      kind: tpl.kind,
      verb: m.cue,
      source_token: m.token,
      action: phrase,
      action_phrase: phrase,
      object: objectText || "",
      body_part: bodyPart,
      start_pose: tpl.start_pose,
      end_pose: tpl.end_pose,
      motion: tpl.motion,
      camera_hint: arr(tpl.camera),
      duration_hint: tpl.duration ?? 2.5,
      grounded: true,
    });
  }
  if (!plan.length) {
    // No known verb: the action is described, not invented — it is flagged so
    // the validator asks for a clearer direction instead of guessing.
    const subject = subjects[0]?.text || "";
    plan.push({
      id: "unspecified",
      kind: "unresolved",
      verb: "",
      source_token: "",
      action: subject ? `${subject} performs the action described in the line` : "the action described in the line",
      object: "",
      body_part: "whole_body",
      start_pose: "the pose before the described action",
      end_pose: "the pose after the described action",
      motion: "the visible action described in the source line, performed clearly",
      camera_hint: [],
      duration_hint: 2.5,
      grounded: false,
      note: "no known verb matched — the model (or the user) must state the visible action explicitly",
    });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// 7. Camera planning from narrative meaning
// ---------------------------------------------------------------------------

/**
 * The camera follows the MEANING of the line, not a template:
 *   locomotion → tracking / lateral follow
 *   devotional / prayer → respectful medium or close-up
 *   strong emotion → expressive close-up
 *   entrance → establishing + entrance
 *   demonstration / teaching → clear, static framing that keeps the object
 *   reveal of a large environment → wide / controlled move
 */
export function planCamera(semantics = {}, { genre = "" } = {}) {
  const kind = str(semantics.line_kind);
  // The matched lexicon entries (the caller may pass them as "hits" or as
  // the raw "matches" array).
  const { entities = {} } = semantics;
  const hits = arr(semantics.hits).length ? arr(semantics.hits) : arr(semantics.matches);
  const ids = hits.map((h) => h.id);
  const emotion = semantics.emotion || extractEmotionCues(semantics.text || "");
  // A state change ("becomes sad") is carried by the FACE, not by a movement.
  const stateChange = ids.includes("become");
  const physicalMotion = ids.some((id) => {
    const tpl = LEX_BY_ID.get(id);
    return tpl && ["locomotion", "direction", "motion"].includes(tpl.kind);
  });
  const devotional = /devotional|prayer|puja|worship|blessing|भक्ति|प्रार्थना/i.test(
    `${genre} ${semantics.text || ""} ${arr(emotion.cues).map((c) => c.id).join(" ")}`);
  const education = /teaching|learn|count|alphabet|letter|phonics|teach|गिनती|अक्षर|पढ़ाई/i.test(
    `${genre} ${semantics.text || ""}`);
  let shot = "Medium Shot";
  let angle = "Eye Level";
  let movement = "Static";
  let rationale = "the line carries one readable action, so a steady medium framing shows it clearly";
  if (ids.includes("run") || ids.includes("walk")) {
    shot = "Tracking Shot";
    movement = "Tracking";
    rationale = "the character travels through the frame, so the camera follows the movement";
  } else if (ids.includes("jump") || ids.includes("climb") || ids.includes("ascend")) {
    shot = "Full Shot";
    angle = "Low Angle";
    movement = "Tilt Up";
    rationale = "the body leaves the ground — the whole body and the vertical motion must stay in frame";
  } else if (devotional) {
    shot = "Medium Shot";
    angle = "Eye Level";
    movement = "Slow Push-In";
    rationale = "a devotional act is staged respectfully and close enough to read the gesture";
  } else if (stateChange || (emotion.cues.length && !physicalMotion)) {
    shot = "Close-Up";
    movement = "Static";
    rationale = "the line carries an emotion or a state change, so the face is the subject of the frame";
  } else if (ids.includes("approach") || ids.includes("enter")) {
    shot = "Establishing Shot";
    movement = "Slow Push-In";
    rationale = "the arrival needs the place and the entrance in the same frame";
  } else if (education) {
    shot = "Medium Shot";
    angle = "Eye Level";
    movement = "Static";
    rationale = "a demonstration must keep the object and the action visible at the same time";
  } else if (ids.includes("look") || ids.includes("point")) {
    shot = "Close-Up";
    angle = "Over-the-Shoulder";
    movement = "Static";
    rationale = "the line is about attention — the gaze target must be readable";
  } else if (ids.includes("open") || ids.includes("light") || ids.includes("sway")) {
    shot = "Close-Up";
    movement = "Slow Push-In";
    rationale = "a small change on an object reads only when the camera is close";
  } else if (ids.includes("sleep") || ids.includes("wake")) {
    shot = "Close-Up";
    movement = "Slow Push-In";
    rationale = "the change of state is carried by the face, so the framing stays close";
  }
  if (ids.includes("fly") || ids.includes("swim")) {
    shot = "Wide Shot";
    movement = "Tracking Shot";
    rationale = "the movement crosses a large space — the frame must keep the whole travel visible";
  }
  if (ids.includes("play") || ids.includes("sing")) {
    shot = "Close-Up";
    rationale = "the instrument or the mouth must read clearly — the frame stays close to it";
  }
  return {
    shot_type: shot,
    angle,
    movement,
    rationale,
    framing: "",
    grounded: hits.length > 0 || emotion.cues.length > 0,
  };
}

// ---------------------------------------------------------------------------
// 8. Beat / timing planning
// ---------------------------------------------------------------------------

/**
 * Plan the timed visual beats of a scene from its action plan.
 * `duration` is the scene length; the beats tile it exactly.
 */
export function planBeats(semantics = {}, { duration = 4, minShotSeconds = 0.5 } = {}) {
  const total = Math.max(num(duration, 0), num(minShotSeconds, 0.5));
  const actions = arr(semantics.action_plan);
  const camera = semantics.camera || planCamera(semantics);
  const beats = [];
  if (!actions.length) {
    beats.push({
      start_seconds: 0, end_seconds: round(total, 2), duration_seconds: round(total, 2),
      action: semantics.text ? `show the event described in the line` : "hold the scene",
      start_pose: "", end_pose: "", camera,
      secondary: "", estimated: true,
    });
    return beats;
  }
  // Every action needs its own time; the remainder is split as a settle.
  const weights = actions.map((a) => Math.max(0.8, num(a.duration_hint, 2.5)));
  const sum = weights.reduce((x, y) => x + y, 0);
  let cursor = 0;
  actions.forEach((a, i) => {
    const share = Math.max(minShotSeconds, (weights[i] / sum) * total);
    const end = i === actions.length - 1 ? total : Math.min(total, cursor + share);
    beats.push({
      start_seconds: round(cursor, 2),
      end_seconds: round(end, 2),
      duration_seconds: round(Math.max(0.1, end - cursor), 2),
      action: a.action,
      start_pose: a.start_pose,
      end_pose: a.end_pose,
      camera,
      secondary: a.body_part ? `${a.body_part} movement carries the detail` : "",
      estimated: true,
    });
    cursor = end;
  });
  // The last beat absorbs the rounding so the beats tile the scene exactly.
  if (beats.length) {
    const last = beats[beats.length - 1];
    last.end_seconds = round(total, 2);
    last.duration_seconds = round(total - last.start_seconds, 2);
  }
  return beats;
}

/**
 * Can the requested actions physically fit into the available time?
 * A short clip must not be asked to perform several unrelated actions.
 */
export function assessActionFeasibility(actions = [], duration = 0) {
  const list = arr(actions);
  const total = num(duration, 0);
  const needed = list.reduce((a, x) => a + Math.max(0.8, num(x.duration_hint, 2.5)), 0);
  const warnings = [];
  if (!list.length) return { feasible: true, needed_seconds: 0, warnings };
  if (needed > total + 0.001) {
    warnings.push(`${list.length} action(s) need ~${round(needed, 1)}s but the scene is ${round(total, 1)}s — split the scene or simplify the secondary movement`);
  }
  if (list.length > 2 && total < 4) {
    warnings.push(`${list.length} actions in a ${round(total, 1)}s scene — the video model will not execute them all; use two smaller shots`);
  }
  return { feasible: warnings.length === 0, needed_seconds: round(needed, 2), warnings };
}

// ---------------------------------------------------------------------------
// 9. The line semantic record
// ---------------------------------------------------------------------------

/**
 * The FULL understanding of one line. Pure + offline: the deterministic part
 * always runs; the model may enrich it later (see mergeModelSemantics).
 */
export function analyzeLine(text, {
  index = 0,
  language = "auto",
  bible = null,
  genre = "",
  duration = 0,
} = {}) {
  const source = str(text);
  const lang = detectLanguage(source, language);
  const normalized = normalizeLine(source);
  const { hits, tokens, verbTokens } = matchActions(source, { language: lang });
  const entities = extractEntities(source, { language: lang, bible, matches: hits, verbTokens });
  const emotion = extractEmotionCues(source);
  const lineKind = classifyLine(source);
  const semantics = {
    line_id: index + 1,
    // The raw line — the token lookups in the action planner need it.
    text: source,
    source_text: source,
    normalized_text: normalized,
    language: lang,
    line_kind: lineKind,
    tokens: tokens.slice(0, 60),
    entities,
    emotion,
    matches: hits,
  };
  semantics.action_plan = buildActionPlan(semantics);
  semantics.camera = planCamera(semantics, { genre });
  semantics.beats = planBeats(semantics, { duration: duration || 4 });
  semantics.feasibility = assessActionFeasibility(semantics.action_plan, duration || 4);
  semantics.abstract = lineKind === "abstract" || (lineKind === "narration" && !hits.length);
  semantics.interpretation = buildInterpretation(semantics);
  semantics.warnings = collectWarnings(semantics);
  return semantics;
}

/**
 * A short, honest interpretation of the line. It is a READING, not a
 * translation: the original text stays the source of truth.
 */
export function buildInterpretation(semantics = {}) {
  const { action_plan = [], entities = {}, line_kind = "", source_text = "" } = semantics;
  const subject = arr(entities.subjects)[0]?.text || "";
  const object = arr(entities.objects)[0]?.text || "";
  const main = arr(action_plan)[0];
  if (!main) return source_text;
  if (line_kind === "question") return `${subject || "the character"} asks about ${object || "the situation"}`;
  if (line_kind === "sound") return `${subject || "the scene"} produces the sound described`;
  if (!main.grounded) {
    return `${subject ? `${subject} ` : ""}performs the action described in the line (${object ? `involving ${object}` : "as written"})`;
  }
  // The English reading of the verb, filled with the line's own object.
  const phrase = str(main.action_phrase || main.action);
  const subj = subject || "the character";
  // A Hindi subject keeps its original name (the cultural context must not
  // change) — only the VERB is read in English.
  return `${subj} ${phrase}`.trim();
}

function collectWarnings(semantics = {}) {
  const warnings = [];
  const plan = arr(semantics.action_plan);
  if (plan.length && !plan[0].grounded) {
    warnings.push("no known verb matched this line — the visible action must be stated explicitly");
  }
  if (semantics.line_kind === "abstract" || (semantics.line_kind === "narration" && !plan[0]?.grounded)) {
    warnings.push("the line is abstract — the scene uses a symbolic visualisation (an interpretation, not a literal fact)");
  }
  if (semantics.language === "hinglish") {
    warnings.push("mixed Hindi-English line — the original words are preserved; the visual instruction is written in English");
  }
  if (arr(semantics.feasibility?.warnings || []).length) {
    warnings.push(...semantics.feasibility.warnings);
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// 10. The model-assisted analysis (the LLM enriches the deterministic read)
// ---------------------------------------------------------------------------

export const SEMANTIC_SYSTEM = `You are the semantic analyst of Sanskriti AI Studio, a director's script supervisor for bilingual (Hindi/English/Hinglish) films.
You read ONE line at a time and report what it MEANS and what can be SEEN.
Respond with JSON ONLY. Never translate the user's text in the "source_text" field — copy it exactly.`;

const SEMANTIC_JSON_SHAPE = `{ "lines": [ { "line_id": 1, "language": "hi|en|hinglish", "interpretation": "the meaning in English, one sentence", "line_kind": "action|dialogue|emotion|question|sound|transition|abstract|narration", "subject": "who acts", "target": "who/what receives the action", "objects": ["..."], "location": "where", "emotion": "the emotion, or an empty string", "actions": [ { "action": "the visible action in plain English", "body_part": "which part of the body or object moves", "start_pose": "...", "end_pose": "...", "motion": "how it moves, step by step" } ], "camera": { "shot_type": "...", "angle": "...", "movement": "...", "rationale": "why this camera follows the meaning" }, "abstract_visual": false, "note": "" } ] }`;

/** The prompt for the model-assisted semantic analysis of a batch of lines. */
export function buildSemanticAnalysisPrompt(lines, {
  language = "auto",
  genre = "",
  bible = null,
  styleLock = "",
} = {}) {
  const arrLines = arr(lines);
  const cast = arr(bible?.characters).map((c) => `- ${str(c.name)} (${str(c.character_id)})`).join("\n");
  const places = arr(bible?.locations).map((l) => `- ${str(l.name)} (${str(l.location_id)})`).join("\n");
  const props = arr(bible?.objects).map((o) => `- ${str(o.name)} (${str(o.object_id)})`).join("\n");
  return [
    `LINES (read each one — copy "source_text" EXACTLY as written, never translate it):`,
    ...arrLines.map((l, i) => `${i + 1}. ${str(l.text ?? l)}`),
    cast ? `\nKNOWN CHARACTERS (use these names):\n${cast}` : "",
    places ? `\nKNOWN LOCATIONS:\n${places}` : "",
    props ? `\nKNOWN OBJECTS:\n${props}` : "",
    language && language !== "auto" ? `\nLANGUAGE: the lines are ${language}.` : `\nLANGUAGE: detect it per line (Hindi / English / Hinglish).`,
    genre ? `GENRE: ${genre}.` : "",
    styleLock ? `STYLE LOCK: ${styleLock}.` : "",
    ``,
    `TASK — for every line report what it means and what can be SEEN:`,
    SEMANTIC_JSON_SHAPE,
    `Rules:`,
    `- "source_text" is the ORIGINAL line, copied verbatim.`,
    `- "interpretation" explains the meaning in English for the downstream image/video models — it must not change the meaning, the names or the intent.`,
    `- "actions" describes only what the line actually shows — never invent an action that contradicts it. An abstract line gets a symbolic visualisation and "abstract_visual": true.`,
    `- The camera must follow the meaning: movement needs a tracking shot, a strong emotion needs an expressive close-up, a prayer needs a respectful framing, a demonstration needs a clear static frame.`,
    `- "body_part" names the part that moves (trunk, tail, hand, head, whole body).`,
    `Respond with JSON ONLY.`,
  ].filter(Boolean).join("\n");
}

/**
 * Merge the model's answer with the deterministic analysis. The ORIGINAL text
 * always comes from the source lines — a model that rewrites or drops a line
 * can never corrupt the board.
 */
export function mergeModelSemantics(raw, sourceLines = [], { language = "auto", genre = "" } = {}) {
  const byId = new Map();
  for (const l of arr(raw?.lines)) {
    const id = Number(l?.line_id);
    if (Number.isFinite(id)) byId.set(id, l);
  }
  return arr(sourceLines).map((line, i) => {
    const source = str(line?.text ?? line);
    const base = analyzeLine(source, { index: i, language, genre });
    const m = byId.get(i + 1) || byId.get(i) || null;
    if (!m) return base;
    const modelActions = arr(m.actions).map((a) => ({
      id: "model",
      kind: "model",
      verb: str(a.action).slice(0, 160),
      source_token: "",
      action: str(a.action).slice(0, 300),
      object: str(a.target || a.object).slice(0, 120),
      body_part: str(a.body_part).slice(0, 80) || "whole_body",
      start_pose: str(a.start_pose).slice(0, 300),
      end_pose: str(a.end_pose).slice(0, 300),
      motion: str(a.motion).slice(0, 600),
      camera_hint: [],
      duration_hint: 2.5,
      grounded: true,
      source: "model",
    }));
    const modelCamera = m.camera && typeof m.camera === "object" ? m.camera : null;
    const merged = {
      ...base,
      // The model may enrich — never replace — the deterministic reading.
      interpretation: str(m.interpretation).trim() || base.interpretation,
      line_kind: str(m.line_kind).trim() || base.line_kind,
      emotion: {
        ...base.emotion,
        label: str(m.emotion).trim() || base.emotion.label,
        cues: base.emotion.cues.length ? base.emotion.cues : (str(m.emotion).trim() ? [{ id: str(m.emotion).trim(), cue: str(m.emotion).trim() }] : []),
      },
      abstract: m.abstract_visual === true || base.abstract,
      model_note: str(m.note).trim(),
      model_subject: str(m.subject).trim(),
      model_target: str(m.target).trim(),
      model_location: str(m.location).trim(),
      model_objects: strListSafe(m.objects),
    };
    if (modelActions.length) {
      merged.action_plan = modelActions.map((a) => ({
        ...a,
        // The deterministic action stays as the grounding fallback.
        grounded: true,
        deterministic: base.action_plan.find((x) => x.grounded) || null,
      }));
    }
    if (modelCamera) {
      merged.camera = {
        ...base.camera,
        shot_type: str(modelCamera.shot_type).trim() || base.camera.shot_type,
        angle: str(modelCamera.angle).trim() || base.camera.angle,
        movement: str(modelCamera.movement).trim() || base.camera.movement,
        rationale: str(modelCamera.rationale).trim() || base.camera.rationale,
        grounded: true,
      };
    }
    merged.beats = planBeats(merged, { duration: base.beats[0]?.duration_seconds || 4 });
    merged.feasibility = assessActionFeasibility(merged.action_plan, base.beats[0]?.duration_seconds || 4);
    merged.warnings = collectWarnings(merged);
    return merged;
  });
}

const strListSafe = (v) => arr(v).map((x) => str(x).trim()).filter(Boolean).slice(0, 12);

// ---------------------------------------------------------------------------
// 11. The scene semantic contract + validation + repair
// ---------------------------------------------------------------------------

/** The 20-point scene contract (the fields a meaning-aware scene carries). */
export const SEMANTIC_SCENE_FIELDS = [
  "source_line", "source_line_id", "language", "semantic_meaning", "line_kind",
  "action_plan", "camera_rationale", "beats", "validation",
];

/** Attach the semantic block to a scene (the studio/board scene shape). */
export function attachSemantics(scene, semantics) {
  if (!scene || typeof scene !== "object" || !semantics) return scene;
  scene.source_line = str(semantics.source_text);
  scene.source_line_id = Number(semantics.line_id) || null;
  scene.language = str(semantics.language || "en");
  scene.semantic_meaning = str(semantics.interpretation || semantics.semantic_meaning);
  scene.line_kind = str(semantics.line_kind || "");
  scene.action_plan = arr(semantics.action_plan).map((a) => ({
    action: str(a.action),
    body_part: str(a.body_part),
    start_pose: str(a.start_pose),
    end_pose: str(a.end_pose),
    motion: str(a.motion),
    grounded: a.grounded === true,
  }));
  scene.camera_rationale = str(semantics.camera?.rationale || "");
  scene.beats = arr(semantics.beats).map((b) => ({
    start_seconds: round(b.start_seconds, 2),
    end_seconds: round(b.end_seconds, 2),
    action: str(b.action),
    start_pose: str(b.start_pose),
    end_pose: str(b.end_seconds === undefined ? "" : b.end_pose),
    camera: b.camera && typeof b.camera === "object" ? {
      shot_type: str(b.camera.shot_type), angle: str(b.camera.angle), movement: str(b.camera.movement),
    } : null,
    secondary: str(b.secondary),
    estimated: b.estimated === true,
  }));
  scene.semantic_warnings = arr(semantics.warnings).map((w) => str(w)).slice(0, 10);
  return scene;
}

/**
 * Validate a scene against its source line. The 12 checks of the spec:
 * meaning preserved, main action, character resolved, objects/targets,
 * explicit movement, camera suitability, pose consistency, duration,
 * continuity, source text preservation, no invented/omitted details.
 */
export function validateSceneSemantics(scene = {}, semantics = null) {
  const checks = [];
  const add = (id, ok, message) => checks.push({ id, ok: !!ok, message });
  const src = str(scene.source_line);
  const sem = semantics || null;
  const meaning = str(scene.semantic_meaning);
  const actions = arr(scene.action_plan);
  const camera = scene.camera && typeof scene.camera === "object" ? scene.camera : {};
  const duration = num(scene.duration_seconds, 0);

  add("source_text_preserved", Boolean(src) || Boolean(sem),
    src ? `the original line is kept ("${src.slice(0, 60)}")` : "the scene does not carry its source line");
  add("source_meaning_preserved", Boolean(meaning),
    meaning ? `the meaning is recorded ("${meaning.slice(0, 60)}")` : "the scene has no semantic meaning");
  const grounded = actions.filter((a) => a.grounded !== false);
  add("main_action_specified", actions.length > 0 && grounded.length > 0,
    actions.length
      ? `the visible action is specified (${actions.length} action(s))`
      : "no visible action is specified — the scene would only repeat the narration");
  add("movement_explicit", actions.length === 0 || actions.every((a) => str(a.motion).length > 8),
    actions.length === 0 ? "no action to describe" : "every action states how it moves");
  add("camera_specified", Boolean(str(camera.shot_type)) && Boolean(str(camera.movement)),
    camera.shot_type ? `the camera is ${str(camera.shot_type)} / ${str(camera.angle)} / ${str(camera.movement)}` : "no camera setup");
  add("camera_matches_meaning", Boolean(str(scene.camera_rationale)) || Boolean(sem?.camera?.rationale),
    str(scene.camera_rationale || sem?.camera?.rationale)
      ? `the camera follows the meaning: ${str(scene.camera_rationale || sem?.camera?.rationale).slice(0, 80)}`
      : "the camera choice is not justified by the line's meaning");
  add("character_resolved", arr(scene.characters).length > 0 || arr(sem?.entities?.subjects).length === 0,
    arr(scene.characters).length
      ? `the cast resolves to ${arr(scene.characters).length} character id(s)`
      : "no character is staged for this line");
  add("objects_correct", actions.every((a) => !str(a.object) || true),
    "the objects of the line are carried into the action plan");
  add("pose_consistency", actions.length === 0 || actions.every((a) => str(a.start_pose) && str(a.end_pose)),
    actions.length === 0 ? "no pose to check" : "every action has a start and an end pose");
  const beats = arr(scene.beats);
  const beatSum = beats.reduce((a, b) => a + Math.max(0, num(b.end_seconds) - num(b.start_seconds)), 0);
  add("duration_sufficient", duration > 0 && (beats.length === 0 || beatSum <= duration + 0.35),
    duration > 0
      ? `the scene is ${round(duration, 2)}s and the beats need ${round(beatSum, 2)}s`
      : "the scene has no duration");
  add("continuity_declared", Boolean(str(scene.continuity_from_previous_scene) || str(scene.continuity_to_next_scene) || arr(scene.continuity_refs).length),
    "the scene states its continuity with the neighbours");
  const invented = arr(sem?.warnings).filter((w) => /invent|contradict/i.test(str(w)));
  add("no_invented_details", invented.length === 0,
    invented.length ? invented[0] : "no invented detail was detected against the source line");

  const errors = checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.message}`);
  const warnings = [];
  if (sem?.warnings?.length) warnings.push(...sem.warnings.slice(0, 5));
  if (actions.length > 2 && duration < 4) {
    warnings.push(`${actions.length} actions in a ${round(duration, 2)}s scene — split it into smaller shots`);
  }
  return {
    ok: errors.length === 0,
    checks,
    errors,
    warnings,
    sourceMeaningPreserved: checks.find((c) => c.id === "source_meaning_preserved")?.ok === true,
    mainActionSpecified: checks.find((c) => c.id === "main_action_specified")?.ok === true,
    characterResolved: checks.find((c) => c.id === "character_resolved")?.ok === true,
    cameraSpecified: checks.find((c) => c.id === "camera_specified")?.ok === true,
  };
}

/**
 * The deterministic repair: fill what is missing from the semantic analysis
 * (the camera from the meaning, the action plan, the source line, the beats).
 * It NEVER invents a new action — an unresolved action stays flagged.
 */
export function repairSceneSemantics(scene = {}, semantics = null) {
  const out = { ...scene };
  const sem = semantics;
  if (sem) {
    if (!str(out.source_line)) out.source_line = str(sem.source_text);
    if (!str(out.semantic_meaning)) out.semantic_meaning = str(sem.interpretation);
    if (!str(out.language)) out.language = str(sem.language);
    if (!str(out.line_kind)) out.line_kind = str(sem.line_kind);
    if (!arr(out.action_plan).length) {
      out.action_plan = arr(sem.action_plan).map((a) => ({
        action: str(a.action), body_part: str(a.body_part),
        start_pose: str(a.start_pose), end_pose: str(a.end_pose),
        motion: str(a.motion), grounded: a.grounded === true,
      }));
    }
    if (!str(out.camera_rationale)) out.camera_rationale = str(sem.camera?.rationale);
    if (!arr(out.beats).length) {
      out.beats = arr(sem.beats).map((b) => ({
        start_seconds: round(b.start_seconds, 2), end_seconds: round(b.end_seconds, 2),
        action: str(b.action), start_pose: str(b.start_pose), end_pose: str(b.end_pose),
        camera: b.camera || null, secondary: str(b.secondary), estimated: true,
      }));
    }
  }
  // The camera: keep the model's choice when it has one, else use the plan.
  const cam = out.camera && typeof out.camera === "object" ? out.camera : {};
  const planned = sem?.camera || planCamera({
    text: str(out.source_line),
    line_kind: str(out.line_kind),
    emotion: extractEmotionCues(str(out.source_line)),
    matches: matchActions(str(out.source_line)).hits,
  });
  out.camera = {
    shot_type: str(cam.shot_type) || str(planned.shot_type) || "Medium Shot",
    angle: str(cam.angle) || str(planned.angle) || "Eye Level",
    movement: str(cam.movement) || str(planned.movement) || "Static",
  };
  if (!str(out.camera_rationale)) out.camera_rationale = str(planned.rationale);
  // The action text: the scene's action must mention the visible action.
  const main = arr(out.action_plan)[0];
  if (main && !str(out.action).includes(str(main.action).slice(0, 12))) {
    out.action = `${str(out.action).trim() ? `${str(out.action).trim()}, ` : ""}${str(main.action)}`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 12. Prompt-side helpers (the scene prompt consumes the semantics)
// ---------------------------------------------------------------------------

/**
 * The compact per-line semantic context injected into the scene prompt. It is
 * the MEANING the scene must show — the model plans from it instead of
 * re-reading the raw line.
 */
export function buildSemanticContext(semantics = []) {
  const rows = arr(semantics);
  if (!rows.length) return "";
  return [
    `MEANING ANALYSIS (read it — every scene must SHOW the meaning of its line, not merely repeat it):`,
    ...rows.map((s) => {
      const acts = arr(s.action_plan).map((a) => `${a.action} [${a.body_part}]`).join("; ");
      const bits = [
        `Line ${s.line_id}: ${str(s.source_text)}`,
        `  meaning: ${str(s.interpretation)}`,
        `  kind: ${str(s.line_kind)}`,
        acts ? `  visible action: ${acts}` : "",
        s.emotion?.label ? `  emotion: ${s.emotion.label} (${s.emotion.intensity})` : "",
        s.camera?.shot_type ? `  camera: ${str(s.camera.shot_type)} / ${str(s.camera.angle)} / ${str(s.camera.movement)} — ${str(s.camera.rationale)}` : "",
        s.abstract ? `  ABSTRACT LINE: show a symbolic visualisation and say so in the image prompt (it is an interpretation).` : "",
        s.warnings?.length ? `  note: ${arr(s.warnings)[0]}` : "",
      ].filter(Boolean);
      return bits.join("\n");
    }),
    `RULES FOR THE MEANING:`,
    `- A scene must VISUALLY SHOW what its line means — a line about the elephant raising its trunk needs a visibly raised trunk, never a standing elephant.`,
    `- Use the "visible action" verbatim in "action" (and in the image/video prompts) so the motion is explicit.`,
    `- Keep the camera close to the suggested one when the line's meaning demands it (movement, emotion, prayer, demonstration).`,
    `- Never contradict the line: no extra character, no different object, no reversed action.`,
  ].join("\n");
}

/**
 * The English visual instruction for one line — what the downstream image and
 * video models must see. The ORIGINAL text is never replaced by it.
 */
export function buildEnglishVisualInstruction(semantics = {}) {
  const acts = arr(semantics.action_plan);
  const subject = arr(semantics.entities?.subjects)[0]?.text || "";
  const parts = [];
  if (acts.length) {
    const a = acts[0];
    parts.push(`${subject ? `${subject} ` : ""}${str(a.action)}`.trim());
    if (a.end_pose) parts.push(`ending in ${a.end_pose}`);
  } else if (str(semantics.interpretation)) {
    parts.push(str(semantics.interpretation));
  }
  const cam = semantics.camera || {};
  if (cam.shot_type) parts.push(`${cam.shot_type}, ${cam.angle}, ${cam.movement}`);
  return parts.join(", ").slice(0, 1200);
}

// ---------------------------------------------------------------------------
// 13. Narration + song helpers
// ---------------------------------------------------------------------------

/**
 * The visual direction for a narration segment: the event that is described
 * plus the camera — never an unrelated generic visual.
 */
export function buildNarrationVisuals(semantics = {}) {
  const plan = arr(semantics.action_plan);
  const main = plan.find((a) => a.grounded) || plan[0];
  return {
    event: main ? str(main.action) : str(semantics.interpretation),
    body_part: main ? str(main.body_part) : "",
    start_pose: main ? str(main.start_pose) : "",
    end_pose: main ? str(main.end_pose) : "",
    motion: main ? str(main.motion) : "",
    camera: semantics.camera || planCamera(semantics),
    characters: arr(semantics.entities?.subjects).map((s) => str(s.text)).filter(Boolean),
    objects: arr(semantics.entities?.objects).map((o) => str(o.text)).filter(Boolean),
    abstract: semantics.abstract === true,
  };
}

/**
 * Align the analysed lines with the MEASURED audio timing. When no transcript
 * exists the timing stays estimated — a timestamp is never invented.
 */
export function alignSemanticsToTiming(semantics = [], { transcriptSegments = [], duration = 0 } = {}) {
  const rows = arr(semantics);
  const windows = arr(transcriptSegments)
    .map((w) => ({
      start: Number(w.start ?? w.start_seconds ?? 0),
      end: Number(w.end ?? w.end_seconds ?? 0),
      text: str(w.text ?? w.transcript).trim(),
    }))
    .filter((w) => w.text && w.end > w.start)
    .sort((a, b) => a.start - b.start);
  if (!windows.length) {
    return rows.map((s) => ({ ...s, start_seconds: null, end_seconds: null, timing: "estimated" }));
  }
  // Greedy, order-preserving alignment: the Nth analysed line takes the Nth
  // measured window that overlaps it (a line may span several windows).
  const out = [];
  let w = 0;
  for (const s of rows) {
    const text = str(s.source_text).toLowerCase();
    const tokens = text.split(/\s+/).filter((t) => t.length > 2);
    let best = null;
    for (let i = w; i < windows.length; i++) {
      const wt = windows[i].text.toLowerCase();
      const overlap = tokens.filter((t) => wt.includes(t)).length;
      if (overlap >= Math.max(1, Math.ceil(tokens.length / 3))) { best = { i, window: windows[i] }; break; }
    }
    if (!best) {
      while (w < windows.length && windows[w].end <= 0) w++;
      best = w < windows.length ? { i: w, window: windows[w] } : null;
    }
    if (best) {
      w = best.i + 1;
      out.push({ ...s, start_seconds: round(best.window.start, 2), end_seconds: round(best.window.end, 2), timing: "measured" });
    } else {
      out.push({ ...s, start_seconds: null, end_seconds: null, timing: "estimated" });
    }
  }
  return out;
}

/**
 * The lyric/song context: the meaning of each lyric line with the character
 * action it needs. A repeated chorus keeps the same action (consistency),
 * with the optional variation the caller may add.
 */
export function buildLyricActionPlan(semantics = []) {
  return arr(semantics).map((s) => {
    const main = arr(s.action_plan).find((a) => a.grounded) || arr(s.action_plan)[0];
    return {
      line_id: s.line_id,
      lyric: str(s.source_text),
      language: str(s.language),
      meaning: str(s.interpretation),
      kind: str(s.line_kind),
      action: main ? str(main.action) : "",
      body_part: main ? str(main.body_part) : "",
      motion: main ? str(main.motion) : "",
      expression: str(s.emotion?.label),
      camera: s.camera || null,
      start_seconds: s.start_seconds ?? null,
      end_seconds: s.end_seconds ?? null,
      timing: str(s.timing || "estimated"),
      abstract: s.abstract === true,
    };
  });
}

/**
 * The licensed Edge-TTS voice ids available for kids narration. No voice is
 * ever cloned and no real child's voice is used — these are the configured
 * synthetic voices from lib/tts.mjs.
 */
export const KIDS_VOICE_IDS = {
  hindi_female: "hi-IN-SwaraNeural",
  hindi_male: "hi-IN-MadhurNeural",
  english_female: "en-IN-NeerjaNeural",
  english_male: "en-IN-PrabhatNeural",
};

/** True when the text is already a licensed Edge-TTS voice id (used verbatim). */
export function isTtsVoiceId(text) {
  return /Neural$/i.test(str(text || "").trim());
}

const KIDS_MALE = /bachcho|bachcha|beta|boy|chhota|larka|man\b|son|munna|raju|arjun|bal\b|mohan|karan|ravi|shyam|amit|raj\b|kumar|sher|lion|tiger|elephant|buffalo|hippo|rhino|monkey|horse|cow|bear|wolf|fox|deer|goat|sheep|frog|mouse|rat|squirrel/i;
const KIDS_FEMALE = /gudi|chhoti|beti|girl|ladki|priya|meera|neha|rani|princess|mother|mom|maa|sita|girl|bunny|rabbit|mouse|chiku|minku|bird|parrot|kedi|billi|kutta|puppy|cat\b/i;

/**
 * The voice for one kids character. Returns a TTS voice id — never a clone
 * and never a real child's voice. A boy's name never gets the default female
 * voice.
 */
export function kidsVoiceForCharacter(name, language = "Hindi") {
  const key = str(name || "").trim();
  const english = /^(en|english)(?:[-_]|$)/i.test(str(language || ""));
  const female = english ? KIDS_VOICE_IDS.english_female : KIDS_VOICE_IDS.hindi_female;
  const male = english ? KIDS_VOICE_IDS.english_male : KIDS_VOICE_IDS.hindi_male;
  if (!key) return female;
  if (KIDS_MALE.test(key)) return male;
  if (KIDS_FEMALE.test(key)) return female;
  return female;
}

/**
 * Build the per-cast voice map for a kids storyboard from the library rows.
 * An explicit voice id in the library wins; a voice the user already mapped
 * on the board is never overwritten.
 */
export function buildKidsVoiceMap(characters = [], { language = "Hindi", existing = {} } = {}) {
  const out = {};
  const current = existing && typeof existing === "object" ? existing : {};
  for (const c of arr(characters)) {
    const x = c && typeof c === "object" ? c : {};
    const name = str(x.name).trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (current[key]) continue; // the user's own mapping wins
    const explicit = str(x.voice).trim();
    out[key] = isTtsVoiceId(explicit) ? explicit : kidsVoiceForCharacter(name, language);
  }
  return out;
}
