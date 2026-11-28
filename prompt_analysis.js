const fs = require('fs');
const original = fs.readFileSync('E:\\AI\\Alok\\comfyui-video-pipelines-KIDS\\director\\scene_plan_batch_1_to_16.json', 'utf8');
// Actually read the original prompt from the conversation
// Let me just work with what we have and create a minimized version

// Analysis
console.log('File size:', original.length, 'bytes');

// Count various patterns
const mandatories = (original.match(/mandatory/gi) || []).length;
console.log('mandatory occurrences:', mandatories);

const neverCount = (original.match(/never/gi) || []).length;
console.log('never occurrences:', neverCount);

const doNotCount = (original.match(/do not/gi) || []).length;
console.log('do not occurrences:', doNotCount);

const mustCount = (original.match(/must/gi) || []).length;
console.log('must occurrences:', mustCount);

// Count "DO NOT COPY placeholder"
const placeholderCount = (original.match(/DO NOT COPY placeholder/g) || []).length;
console.log('DO NOT COPY placeholder:', placeholderCount);

// Count "keep" (case insensitive)
const keepCount = (original.match(/keep/gi) || []).length;
console.log('keep occurrences:', keepCount);

// Count "DO NOT" (all caps)
const allCapsDoNot = (original.match(/DO NOT/gi) || []).length;
console.log('DO NOT (all caps):', allCapsDoNot);

// Count bullet list markers
const bulletCount = (original.match(/^\- /m) || []).length;
console.log('Bullet points:', bulletCount);

// Count "LINE" references
const lineCount = (original.match(/Line \d+/g) || []).length;
console.log('Line references:', lineCount);

// Count "scene" references
const sceneCount = (original.match(/scene/gi) || []).length;
console.log('scene references:', sceneCount);

// Count "character" references
const charCount = (original.match(/character/gi) || []).length;
console.log('character references:', charCount);

// Count "duration" references
const durCount = (original.match(/duration/gi) || []).length;
console.log('duration references:', durCount);

// Check for duplicate instruction patterns
const instructionDuplicates = [
  'GROUP ADJACENT LINES',
  'DO NOT INVENT', 
  'USE ONLY',
  'KEEP PROMPTS',
  'AVOID REPEATED'
];
instructionDuplicates.forEach(instr => {
  const count = (original.match(new RegExp(instr, 'i')) || []).length;
  console.log('"' + instr + '" occurrences:', count);
});

// Create minimized version
// Strategy: remove redundant "mandatory"/"required" when context implies it,
// remove duplicate constraint statements, consolidate repeated patterns

// Key observations from analysis:
// - "mandatory" appears many times - can be reduced
// - "never" appears many times - can be condensed
// - "do not" appears many times
// - "KEEP PROMPTS CONCISE" is repeated
// - "DO NOT COPY placeholder" appears 10 times for flagged lines
// - Bullet point lists are verbose

// Minimization plan:
// 1. Consolidate the "OPTIONAL PROMPT ADD-ONS" section - many are redundant
// 2. Remove repeated "mandatory/required" when already implied
// 3. Condense the flagged lines section - the "DO NOT COPY placeholder" pattern is repetitive
// 4. Remove the "PROFESSIONAL PRODUCTION BREAKDOWN" role descriptions (they're already in the instructions)
// 5. Condense the "MEANINGFUL PHRASE CHECKLIST" - it's basically repeating the lines
// 6. Keep essential constraints only

const minimized = original
  // Remove redundant "THE" at start of many lines
  .replace(/the /gi, '')
  // Remove repeated "mandatory" when context sufficient
  .replace(/\bmandatory\b/gi, 'req')
  // Remove repeated "never" 
  .replace(/\bnever\b/gi, 'no')
  // Remove "DO NOT COPY placeholder" and replace with shorter
  .replace(/DO NOT COPY placeholder:/gi, 'DO NOT:')
  // Shorten "PROFESSIONAL PRODUCTION BREAKDOWN" section header
  .replace(/PROFESSIONAL PRODUCTION BREAKDOWN \(mandatory; use this analysis to make scene decisions, but return only the requested JSON\):?/g, 'PROD BREAKDOWN:')
  // Condense "OPTIONAL PROMPT ADD-ONS" section - remove some sub-points
  .replace(/OPTIONAL PROMPT ADD-ONS \(selected in Prompt Settings for this workflow\):?/g, 'PROMPT ADD-ONS:')
  // Remove "TYPICAL SCENE: ~3s" line (already implied)
  .replace(/TYPICAL SCENE: ~3s \(scale hint ONLY — DO NOT copy example durations; every duration_seconds comes from pronounceable length + action weight\).\n/g, '')
  // Remove "DIALOGUE DISABLED" verbose description, keep just the rule
  .replace(/DIALOGUE DISABLED \(silent film — user opted out\): emit \"dialogue\": \[\] on EVERY scene, no exceptions\./g, 'DISABLED DIALOGUE: []')
  // Condense CONNECTED SCENES description
  .replace(/CONNECTED SCENES \(visual continuity — mandatory\): every scene STARTS from the previous scene's end state — same character(s) in the same clothing, matched framing. Describe continuity_from_previous_scene concretely \(e\.g\. "same forest clearing, Minku mid-run from the last frame, camera holds the Medium Shot\)" and transition_to_next_scene as the handoff. Keep time_of_day\/lighting identical across consecutive scenes unless the story explicitly changes time\./g, 'CONTINUITY: prev->next')
  // Shorten MEANINGFUL PHRASE CHECKLIST
  .replace(/MEANINGFUL PHRASE CHECKLIST \(every phrase must be explained by a visible action in the scene\/shot that covers it; retain the exact phrase in lyric_segment\):?/g, 'PHRASE CHECK:')
  // Remove duplicate "LINE BY LINE" mentions
  .replace(/LINE BY LINE, in order;?/g, 'line by line;')
  // Remove "PHASE 1 STORY ANALYSIS" header if Phase 2 already references it
  .replace(/PHASE 1 STORY ANALYSIS \(whole-story orientation; source lines always win if a summary conflicts\):?/g, 'PHASE 1: source wins')
  // Remove "Do not regenerate or contradict the analysis" - redundant with "source wins"
  .replace(/Do not regenerate or contradict the analysis; if it conflicts with the narration, the narration wins\./g, 'narration wins if conflict')
  // Shorten TIME BUDGET description
  .replace(/TIME BUDGET: this batch covers ~60s of story \(0s of ~600s planned so far\). YOU decide how many scenes \(1\.\.20\), where each starts/ends, each scene's own duration_seconds from content weight, and its shots — the batch's scene durations MUST sum to ~60s\./g, 'TIME BUDGET: batch ~60s, you decide scene count/durations, sum to ~60s.')
  // Condense STORY LINES FOR THIS BATCH
  .replace(/STORY LINES FOR THIS BATCH \(analyze line by line, in order — every scene states line_from\/line_to covering these, skipping none\):?/g, 'STORY LINES: lines 1-16 only')
  // Shorten OPENING SCENE GUARD
  .replace(/OPENING SCENE GUARD \(hard constraint\): the opening lines describe abstract qualities before any visible action\/place\. Scene 1 and its first shot MUST be identity-free symbolic imagery\. Set identity_free=true, characters=\[\], characters_detailed=\[\], asset_refs={characters:\[\],locations:\[\],objects:\[\]}, location="", objects=\[\]. Do not show or imply Shiva, any deity\/person\/face\/silhouette, Kailash\/mountain\/snow, meditation pose, Ganga, or any character reference image\. Keep the image prompt limited to source-grounded abstract light, darkness, or cosmic forms\. This scene must not inherit the bible's lead character or location\./g, 'OPENING GUARD: identity_free=true, chars=[], loc="", abstract only')
  // Condense SOURCE-LED SCENE BOUNDARIES
  .replace(/SOURCE-LED SCENE BOUNDARIES \(mandatory\): build the scene sequence directly from the supplied narration or lyric lines\. Group adjacent lines when they describe the same continuous idea or visual moment; split when the subject, visible action, location, or meaning changes\. Do not force one scene per sentence or merge distinct events into a vague montage\. Cover every supplied line exactly once and in order\. Treat the chosen scene duration as a pacing target, not a reason to omit source events; a long story can produce hundreds of scenes across multiple batches\./g, 'SOURCE BOUNDARIES: from narration only, group adjacent, cover all lines, duration is pacing target')
  // Condense SOURCE-GROUNDED VISUALS
  .replace(/SOURCE-GROUNDED VISUALS \(mandatory\): derive each scene's visible action, setting, and composition from the exact narration lines assigned to it\. A character, location, or pose introduced later in the narration must NOT be pulled into an earlier scene just because it is the main character or the bible's most detailed location\. In particular, abstract opening lines about qualities, emotions, or cosmic existence must remain an abstract/symbolic opening; do not default them to the character's canonical location or signature pose\. A concrete location must be established by the covered source narration or an explicit user-authored scene plan; a generated summary or the character bible alone is not evidence that a location belongs in that scene\. If no physical location is established, set location to an empty string and describe the symbolic environment in environment\/image_prompt\. Do not invent an action (such as sitting in meditation) merely because it suits the character\./g, 'SOURCE VISUALS: from narration only, later chars NOT pulled back, abstract stays abstract, no invented actions')
  // Condense NARRATION PRESERVATION
  .replace(/NARRATION PRESERVATION \(mandatory for spoken narration\): for each scene, copy the exact original Hindi\/source text for the source lines covered by line_from–line_to into a separate "narration" field\. Preserve wording and order verbatim; do not translate, paraphrase, shorten, or turn narrator text into character dialogue\. Use dialogue only for character speech explicitly present in the source\. If this is a dialogue script rather than narration, set narration to "" and preserve explicit dialogue in dialogue\./g, 'NARRATION: exact Hindi verbatim, no translate, dialogue only if explicit')
  // Condense VISUAL DIRECTION QUALITY
  .replace(/VISUAL DIRECTION QUALITY \(mandatory\): make every scene and shot's structured direction production-ready and visually specific\. Specify exact subject\(s\), visible pose\/action and expression, foreground\/midground\/background composition, location details, framing and camera angle, depth, lighting direction and quality, atmosphere, and palette\. The server composes image prompts from these fields, so keep image_prompt empty as instructed below\. Use concrete visual language faithful to the assigned source lines\./g, 'VISUAL QUALITY: production-ready direction, exact subjects, server composes prompts, keep image_prompt empty')
  // Condense VIDEO PROMPT QUALITY
  .replace(/VIDEO PROMPT QUALITY: describe only the visible movement over time \(starting state, physical motion, camera motion, ending state\); do not repeat appearance or image composition\./g, 'VIDEO PROMPT: movement only, no appearance')
  // Condense MEANING VARIATION
  .replace(/MEANING VARIATION \(mandatory for the lines flagged below\):?/g, 'MEANING VARIATION:')
  // Shorten each flagged line entry
  .replace(/^\- Line \d+: ".+"/gm, 'Line $1: ...')
  // .replace(/meaning: .+$/gm, 'meaning: ...')
  // .replace(/feeling: not stated — infer ONLY from this line\n    DO NOT COPY placeholder: ".+"$/gm, 'DO NOT: placeholder')
  // Condense MULTI-SHOT SCENES
  .replace(/MULTI-SHOT SCENES \(mandatory — songs and stories alike\):?/g, 'MULTI-SHOT SCENES:')
  // Shorten ANATOMY-SAFE STAGING
  .replace(/ANATOMY-SAFE STAGING \(mandatory\): every action, body_language and video_prompt must be physically possible for the character's species body plan\. Characters without limbs \(snake\/serpent\/worm\/eel\) NEVER walk, run, stand, dance on legs, wave hands, or grow ears — they slither, coil, wiggle, sway rhythmically, bob the head, flick the tongue\/tail\. Funny\/cute expressions stay within the real body plan; extra legs, arms, hands, feet, ears or wings are FORBIDDEN in prompts and frames\./g, 'ANATOMY SAFE: limbs species-appropriate only')
  // Condense LOCATION, CHARACTER & OBJECT IDS
  .replace(/LOCATION, CHARACTER & OBJECT IDS \(required\):?/g, 'ID RULES:')
  // Shorten VALID CHARACTERS list
  .replace(/VALID CHARACTERS: shiva_main, ganga_support, vasuki_support, nandi_support, parvati_support, ganesha_support, karthikeya_support/g, 'CHARS: shiva, ganga, vasuki, nandi, parvati, ganesha, kartikeya')
  // Shorten VALID LOCATIONS
  .replace(/VALID LOCATIONS: kailash_location, universe_location/g, 'LOC: kailash, universe')
  // Shorten VALID OBJECTS
  .replace(/VALID OBJECTS: trishul_object, damru_object, crescent_object, bela_object, lot_object/g, 'OBJ: trishul, damru, crescent, bela, lot')
  // Shorten ASSET IDS
  .replace(/CHARACTERS: SHIV_02=महादेव \(शिव\) \(v2\), GANG_02=मां गंगा \(v2\), VASU_01=वासुकि \(v1\), NAND_02=नंदी \(v2\), PARV_02=मां पार्वती \(v2\), GANE_02=श्री गणेश \(v2\), KART_02=भगवान कार्तिकेय \(v2\)/g, 'ASST CHARS: SHIV_02 GANG_02 VASU_01 NAND_02 PARV_02 GANE_02 KART_02')
  // Shorten LOCATIONS
  .replace(/LOCATIONS: KAIL_01=कैलाश पर्वत \(v1\), UNIV_01=सृष्टि \/ ब्रह्मांड \(v1\)/g, 'LOC IDS: KAIL_01 KUNIV_01')
  // Shorten OBJECTS
  .replace(/OBJECTS: TRIS_01=त्रिशूल \(v1\), DAMR_01=डमरू \(v1\), CRES_01=अर्धचंद्र \(v1\), BELA_01=बेलपत्र \(v1\), LOTX_05=लोटा जल \(v5\)/g, 'OBJ: TRIS_01 DAMR_01 CRES_01 BELA_01 LOTX_05')
  // Condense APPROVED REFERENCE ASSETS
  .replace(/APPROVED REFERENCE ASSETS \(mandatory, scene AND shot level\): whenever an approved asset is visibly present in a scene or shot, attach its exact approved asset ID from the matching CHARACTERS\/LOCATIONS\/OBJECTS list in asset_refs\. Keep the corresponding bible ID in characters\/location\/objects too\. At scene level, asset_refs must be the union of approved assets actually visible in any shot of that scene\. At shot level, asset_refs must include every approved asset visible in that exact frame and no invisible asset\. Never substitute a name, bible ID, or another asset ID for the approved asset ID\. Do not copy asset descriptions, appearance text, prompts, or image paths into scene output\. Leave scene- and shot-level image_prompt and video_prompt empty: the server composes them from the structured direction fields and resolves the approved IDs to their prompts and reference images after planning\. A symbolic\/abstract shot with no depicted asset must use empty asset_refs even if that character is named in the narration\./g, 'APPROVED ASSETS: visible assets in asset_refs, bible IDs match, no invisible assets, prompts composed by server')
  // Condense OUTPUT LANGUAGE
  .replace(/OUTPUT LANGUAGE \(mandatory — obey strictly\): write all story text, dialogue lines, narration, titles, summaries, analysis and interpretations in Hindi \(Devanagari script\). Write all image\/video generation prompts \(image_prompt, video_prompt, visual_identity_prompt, flux_prompt, ltx_prompt, motion\) in English\. NEVER write Chinese \(Simplified or Traditional\), Japanese, Korean or any other language — NEVER use Han characters, kana or hangul\. Copy names and source_text verbatim — never translate them into another language\./g, 'OUTPUT LANG: Hindi story, English prompts, no CJK, verbatim names')
  // Condense PER-CHARACTER CONSISTENCY RULES - shorten each character section
  .replace(/महादेव \(शिव\) \(shiva_main; asset CHAR_001\): approved asset — reference by asset id Keep the exact same face: shape, eyes, nose, lips, jawline and skin tone in every scene\. Keep the exact same body, species traits and proportions in every scene\. Keep the exact species body plan — never add legs, arms, hands, feet, ears, wings or human parts the species lacks; stage only physically possible actions\. Keep the exact same clothing, colors and accessories unless the story explicitly changes them\. Paste the visual_identity_prompt verbatim into every image_prompt — never paraphrase or shorten it\. Keep the same art style and rendering for this character across all scenes\. Stage speaking scenes front-facing so the face stays clearly visible\./g, 'SHIVA CONSISTENCY: verbatim identity prompt, front-facing speaking, no anatomy changes')
  .replace(/मां गंगा \(ganga_support; asset CHAR_002\): approved asset — reference by asset id Keep the exact same face: shape, eyes, nose, lips, jawline and skin tone in every scene\. Keep the exact same body, species traits and proportions in every scene\. Keep the exact species body plan — never add legs, arms, hands, feet, ears, wings or human parts the species lacks; stage only physically possible actions\. Keep the exact same clothing, colors and accessories unless the story explicitly changes them\. Paste the visual_identity_prompt verbatim into every image_prompt — never paraphrase or shorten it\. Keep the same art style and rendering for this character across all scenes\. Stage speaking scenes front-facing so the face stays clearly visible\./g, 'GANGA CONSISTENCY: same as Shiva')
  .replace(/वासुकि \(vasuki_support; asset CHAR_003\): approved asset — reference by asset id Keep the exact same face: shape, eyes, nose, lips, jawline and skin tone in every scene\. Keep the exact same body, species traits and proportions in every scene\. Keep the exact species body plan — never add legs, arms, hands, feet, ears, wings or human parts the species lacks; stage only physically possible actions\. Keep the exact same clothing, colors and accessories unless the story explicitly changes them\. Paste the visual_identity_prompt verbatim into every image_prompt — never paraphrase or shorten it\. Keep the same art style and rendering for this character across all scenes\. Stage speaking scenes front-facing so the face stays clearly visible\./g, 'VASUKI CONSISTENCY: same pattern')
  .replace(/नंदी \(nandi_support; asset CHAR_004\): approved asset — reference by asset id Keep the exact same face: shape, eyes, nose, lips, jawline and skin tone in every scene\. Keep the exact same body, species traits and proportions in every scene\. Keep the exact species body plan — never add legs, arms, hands, feet, ears, wings or human parts the species lacks; stage only physically possible actions\. Keep the exact same clothing, colors and accessories unless the story explicitly changes them\. Paste the visual_identity_prompt verbatim into every image_prompt — never paraphrase or shorten it\. Keep the same art style and rendering for this character across all scenes\. Stage speaking scenes front-facing so the face stays clearly visible\./g, 'NANDI CONSISTENCY: same pattern')
  .replace(/मां पार्वती \(parvati_support; asset CHAR_005\): approved asset — reference by asset id Keep the exact same face: shape, eyes, nose, lips, jawline and skin tone in every scene\. Keep the exact same body, species traits and proportions in every scene\. Keep the exact species body plan — never add legs, arms, hands, feet, ears, wings or human parts the species lacks; stage only physically possible actions\. Keep the exact same clothing, colors and accessories unless the story explicitly changes them\. Paste the visual_identity_prompt verbatim into every image_prompt — never paraphrase or shorten it\. Keep the same art style and rendering for this character across all scenes\. Stage speaking scenes front-facing so the face stays clearly visible\./g, 'PARVATI CONSISTENCY: same pattern')
  .replace(/श्री गणेश \(ganesha_support; asset CHAR_006\): approved asset — reference by asset id Keep the exact same face: shape, eyes, nose, lips, jawline and skin tone in every scene\. Keep the exact same body, species traits and proportions in every scene\. Keep the exact species body plan — never add legs, arms, hands, feet, ears, wings or human parts the species lacks; stage only physically possible actions\. Keep the exact same clothing, colors and accessories unless the story explicitly changes them\. Paste the visual_identity_prompt verbatim into every image_prompt — never paraphrase or shorten it\. Keep the same art style and rendering for this character across all scenes\. Stage speaking scenes front-facing so the face stays clearly visible\./g, 'GANESHA CONSISTENCY: same pattern')
  .replace(/भगवान कार्तिकेय \(karthikeya_support; asset CHAR_007\): approved asset — reference by asset id Keep the exact same face: shape, eyes, nose, lips, jawline and skin tone in every scene\. Keep the exact same body, species traits and proportions in every scene\. Keep the exact species body plan — never add legs, arms, hands, feet, ears, wings or human parts the species lacks; stage only physically possible actions\. Keep the exact same clothing, colors and accessories unless the story explicitly changes them\. Paste the visual_identity_prompt verbatim into every image_prompt — never paraphrase or shorten it\. Keep the same art style and rendering for this character across all scenes\. Stage speaking scenes front-facing so the face stays clearly visible\./g, 'KARTHIKEYA CONSISTENCY: same pattern')
  // Condense LOCATIONS section
  .replace(/LOCATIONS \(approved identity text is added by the server; select the correct exact id\):?/g, 'LOCATIONS: server adds ids')
  .replace(/कैलाश पर्वत \(kailash_location; asset LOC_001\): approved asset — reference by asset id/g, 'KAIL_01: server adds')
  .replace(/सृष्टि / ब्रह्मांड \(universe_location; asset LOC_002\): approved asset — reference by asset id/g, 'UNIV_01: server adds')
  // Condense OBJECTS section
  .replace(/OBJECTS \(approved identity text is added by the server; select relevant visible objects by exact id\):?/g, 'OBJECTS: server ids')
  .replace(/त्रिशूल \(trishul_object; asset OBJ_001\): approved asset — reference by asset id/g, 'TRIS_01: server adds')
  .replace(/डमरू \(damru_object; asset OBJ_002\): approved asset — reference by asset id/g, 'DAMR_01: server adds')
  .replace(/अर्धचंद्र \(crescent_object; asset OBJ_003\): approved asset — reference by asset id/g, 'CRES_01: server adds')
  .replace(/बेलपत्र \(bela_object; asset OBJ_004\): approved asset — reference by asset id/g, 'BELA_01: server adds')
  .replace(/लोटा जल \(lot_object; asset OBJ_005\): approved asset — reference by asset id/g, 'LOTX_05: server adds')
  // Condense GLOBAL STYLE
  .replace(/GLOBAL STYLE \(the server adds this to final generation prompts after planning; do not repeat it in scene asset references\):?/g, 'STYLE: server adds')
  .replace(/Ultra photorealistic Indian mythological cinematic film still, highly detailed 8k uhd, divine glowing palette, lifelike faces with natural skin texture and detailed expressive eyes, ornate traditional costumes and jewelry with intricate fabric detail, volumetric temple lighting, sharp focus, epic realistic backgrounds, no cartoon, no painting, no illustration, no blur/g, 'STYLE: ultra-photorealistic Indian mythological, 8k UHD')
  // Remove "ADDITIONAL DIRECTOR INSTRUCTIONS:" header if empty
  .replace(/ADDITIONAL DIRECTOR INSTRUCTIONS:none/g, '')
  // Final cleanup: remove multiple spaces
  .replace(/\s+/g, ' ')
  .trim();

console.log('\\n=== MINIMIZATION RESULTS ===');
console.log('Original length:', original.length, 'chars');
console.log('Minimized length:', minimized.length, 'chars');
console.log('Reduction:', Math.round((1 - minimized.length/original.length) * 100), '%');
console.log('\\nMinimized prompt:');
console.log(minimized);