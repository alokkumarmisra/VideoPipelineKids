// MINIMIZED PROMPT FOR DIRECTOR SCENE PLANNING
// Original was ~19,311 chars; this is compressed version

const minimizedPrompt = `TASK: Analyze source lines and create scene plan. Audio runtime: 600s. Batch covers ~60s lines 1-16 of 189.

STORY: Shiv Tandav | GENRE: Devotional | STYLE: Indian Mythological

PHASE 2: Plan this batch only using Phase 1 analysis. Source lines win over narration if conflict.

TIME BUDGET: batch ~60s. You decide scene count (1-20), durations, and shots. Scenes' durations MUST sum to ~60s.

ESSENTIAL CONSTRAINTS (keep these — remove all others):
- identity_free: Scene 1 must have characters=[], location="", objects=[], asset_refs all empty. No Shiva, Kailash, meditation pose, Ganga, or any character reference image.
- source_led: Build scene sequence directly from supplied narration/lyric lines. Group adjacent lines describing same continuous idea. Split when subject/visible action/location/meaning changes. Cover every line exactly once in order. Duration is pacing target, not omission reason.
- source_grounded: Derive each scene's visible action, setting, composition from exact narration lines assigned. Later characters/locations MUST NOT be pulled into earlier scenes. Abstract opening lines must remain abstract/symbolic. No concrete location without source support. If no physical location, set location="" and describe symbolic environment.
- narration_preservation: For each scene, copy exact original Hindi/source text for source lines covered by line_from-line_to into "narration" field. Preserve wording and order verbatim. Do not translate, paraphrase, shorten, or turn narrator text into character dialogue. Use dialogue only for character speech explicitly present in source. Set narration to "" if dialogue script.
- dialogue_disabled: emit "dialogue": [] on EVERY scene, no exceptions. Silent film — video plays silent over visuals/music only.
- visual_quality: Make every scene and shot's structured direction production-ready. Specify exact subject(s), visible pose/action and expression, foreground/midground/background composition, location details, framing and camera angle, depth, lighting direction and quality, atmosphere, and palette. Server composes image prompts from these fields, so keep image_prompt empty.
- video_prompt_quality: Describe only the visible movement over time (starting state, physical motion, camera motion, ending state). Do not repeat appearance or image composition.
- meaning_variation: For flagged lines (no grounded visible action), state ONE different, concrete, visible symbolic action using that line's own subject, object and imagery. Keep character identity/anatomy unchanged; vary staging around them. Give each flagged scene its own emotion, expression, body_language, dramatic_purpose. Different lines require different actions — changing only shot_type/angle/movement is NOT a new scene. An action crossing a cut still continues across it.
- multi_shot: When one line/sentence covers 2+ distinct persons/objects/locations, split scene into 2-5 SHOTS inside same scene — one shot per entity/moment, each with its own segment, cast, location, prompts and dialogue. Size every shot by pronounceable length. Shot durations MUST sum EXACTLY to scene's duration_seconds, with cumulative boundaries from 0.
- anatomy_safe: Every action, body_language and video_prompt must be physically possible for character's species body plan. Characters without limbs (snake/serpent/worm/eel) NEVER walk, run, stand, dance on legs, wave hands, or grow ears — they slither, coil, wiggle, sway rhythmically, bob head, flick tongue/tail. Extra legs/arms/hands/feet/ears/wings FORBIDDEN.
- ids_required: Scene and shot "location" takes ONLY valid location id (exact spelling) OR empty string. "characters" takes ONLY valid character ids. "objects" takes ONLY valid object ids. Object ID NEVER goes in location slot. Always output "objects" array (use [] when no bible prop visibly present).
- output_language: Write all story text, dialogue lines, narration, titles, summaries in Hindi (Devanagari). Write all image/video generation prompts in English. Never write CJK (Chinese/Japanese/Korean). Never use Han characters, kana or hangul. Copy names and source_text verbatim — never translate.
- approved_assets: Whenever approved asset is visibly present in scene/shot, attach its exact approved asset ID from matching CHARACTERS/LOCATIONS/OBJECTS list in asset_refs. Keep corresponding bible ID in characters/location/objects. Scene-level asset_refs = union of visible assets across its shots. Shot-level asset_refs = every approved asset visible in that exact frame and no invisible asset. Never substitute name/bible ID/another asset ID. Do not copy asset descriptions, appearance text, prompts, or image paths into scene output. Leave scene- and shot-level image_prompt and video_prompt empty: server composes them from structured direction fields after planning. Symbolic/abstract shot with no depicted asset must use empty asset_refs even if character named in narration.
- continuity: Every scene STARTS from previous scene's end state — same character(s) in same clothing, matched framing. Describe continuity_from_previous_scene concretely. Keep time_of_day/lighting identical across consecutive scenes unless story explicitly changes time.

VALID CHARACTERS: shiva_main, ganga_support, vasuki_support, nandi_support, parvati_support, ganesha_support, karthikeya_support
VALID LOCATIONS: kailash_location, universe_location
VALID OBJECTS: trishul_object, damru_object, crescent_object, bela_object, lot_object

FLAGGED LINES (lines 1,2,3,5,7,8,9,10,11,13 — have NO grounded visible action):
For EACH: state ONE concrete visible symbolic action using that line's own subject/object/imagery. DO NOT copy placeholder "performes the action described in the line". Give each its own emotion, expression, body_language, dramatic_purpose derived from its feeling.

OUTPUT: JSON with scenes array. Each scene: scene_number, title, line_from, line_to, narration, dramatic_purpose, duration_seconds, characters[], location, objects[], asset_refs{(characters/locations/objects)}, time_of_day, action, motion, emotion, expression, body_language, camera{(shot_type/angle/movement)}, lighting, environment, continuity_from_previous_scene, transition_to_next_scene, dialogue[], image_prompt="", video_prompt="", shots[].

GLOBAL STYLE: ultra-photorealistic Indian mythological cinematic, 8k UHD, divine glowing palette, lifelike faces with natural skin texture, ornate traditional costumes/jewelry, volumetric temple lighting, sharp focus, epic realistic backgrounds, no cartoon/painting/illustration/blur.

Return JSON ONLY. No markdown fences, no commentary outside JSON.`

console.log('Minimized prompt length:', minimizedPrompt.length, 'chars');
// Show reduction vs original ~19311
console.log('Estimated reduction: ~' + Math.round((1 - minimizedPrompt.length/19311)*100) + '%')