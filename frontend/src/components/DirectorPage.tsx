import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  alertServiceError, directorAddEntry, directorAnalyze, directorAnalyzeLive, directorApprove, directorAssets, directorBiblePreview, directorBoard, directorBoards, directorDeleteBoard, directorOptimizePrompt,
  directorDuplicateBoard, directorLive, directorPromptPreview, directorRegenEntry, directorRegenScene, directorScenes, directorSongUrl, directorUpdateBoard, fmtRelative, directorDisplayId, getScenario, listOutputs, outScenario, folderOf, saveScenario, suggestDirectorInstructions,
  uploadLyricAudio, startWhisperXAnalysis, getWhisperXJobStatus, directorMasterTimeline, approveMasterTimeline, listScenarios,
  directorGenerateAssets, directorApproveAssets, directorSkipAssets, directorRegenerateAsset, directorUploadAsset, directorAssetFileUrl,
  type DirectorAssetProduction, type DirectorMasterAsset, type DirectorBoard, type DirectorBoardMeta, type DirectorEntryKind, type DirectorInput, type DirectorLive, type DirectorPromptPreview, type DirectorScene, type DirectorShot, type ImageMode, type MasterTimelineResponse,
} from "../api";
import type { ScenarioInfo } from "../types";
import type { Scenario } from "../types";
import { useDialog } from "./Dialog";
import { IconCheck, IconClapper, IconFilm, IconFolder, IconPanel, IconRefresh, IconSparkles, IconTrash, IconUpload, Spinner } from "./Icons";
import Collapse from "./Collapse";
import AudioIntelligencePanel from "./AudioIntelligencePanel";
import BatchSizeSelect, { SCENE_BATCH } from "./BatchSizeSelect";
import DirectorGeneration from "./DirectorGeneration";
import Lightbox, { type PreviewItem } from "./Lightbox";
import { useIdleFollow } from "./useIdleFollow";
import {
  emptyProgress, formatDuration, loadDirectorPace, recordDirectorPaceDuration,
  type GenerationProgress,
} from "./GenerationProgressBar";

type DirectorTabId = "brief" | "audio" | "assets" | "scenes" | "media" | "export";
type DirectorTabStatus = "approved" | "pending" | "running";
type DirectorImportTabId = "brief" | "audio" | "assets" | "scenes";
const DIRECTOR_IMPORT_TABS: { id: DirectorImportTabId; label: string }[] = [
  { id: "brief", label: "Brief" },
  { id: "audio", label: "Audio Analysis" },
  { id: "assets", label: "Characters & World" },
  { id: "scenes", label: "Generate Scenes" },
];
const DIRECTOR_TABS: { id: DirectorTabId; label: string }[] = [
  { id: "brief", label: "Brief" },
  { id: "audio", label: "Audio Analysis" },
  { id: "assets", label: "Characters & World" },
  { id: "scenes", label: "Generate Scenes" },
  { id: "media", label: "Generate Media" },
  { id: "export", label: "Export" },
];

function processedDirectorImports(source: DirectorBoard | null): DirectorImportTabId[] {
  if (!source) return [];
  const blueprint = source.blueprint;
  const input = source.input as DirectorInput & {
    songAnalysis?: unknown;
    whisperxAudio?: unknown;
  };
  const raw = source as DirectorBoard & { audioTimeline?: unknown; assetProduction?: { status?: string } };
  const hasAssets = Boolean(blueprint && (
    blueprint.characters?.length || blueprint.locations?.length || blueprint.objects?.length
  ));
  const done: DirectorImportTabId[] = [];
  if (input.story?.trim() && blueprint) done.push("brief");
  if (input.songAnalysis || raw.audioTimeline || source.lyric_timeline?.lines?.length) done.push("audio");
  if (hasAssets) done.push("assets");
  if (source.scenes?.length) done.push("scenes");
  return done;
}

function DirectorAssetPreview({ name, reference, versions = [] }: { name: string; reference: string; versions?: PreviewItem[] }) {
  const src = directorAssetFileUrl(reference);
  const [failed, setFailed] = useState(false);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  useEffect(() => setFailed(false), [src]);
  if (failed) {
    return <div className="dir-asset-preview-error" role="img" aria-label={`Preview unavailable for ${name}`}>
      <IconFilm size={20} />
      <span>Image preview could not be loaded</span>
    </div>;
  }
  const items = versions.length ? versions : [{ src, kind: "image" as const, alt: `${name} generated reference` }];
  const current = items.findIndex((item) => item.src === src);
  return <>
    <button className="dir-asset-preview-button" type="button" onClick={() => setPreviewIndex(current >= 0 ? current : 0)} title={`Preview ${name} image`} aria-label={`Preview ${name} image`}>
      <img
        className="dir-asset-preview"
        src={src}
        alt={`${name} generated reference — click to preview`}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
      <span className="dir-asset-preview-hint">View image</span>
    </button>
    {previewIndex != null && <Lightbox
      item={items[previewIndex] || items[0]}
      items={items}
      index={previewIndex}
      onIndexChange={setPreviewIndex}
      onClose={() => setPreviewIndex(null)}
    />}
  </>;
}

const GENRES = ["Kids", "Devotional", "Adventure", "Fantasy", "Horror", "Comedy", "Educational", "Custom"];
const STYLES = ["3D Preschool Animation", "3D Cinematic", "Realistic", "Anime", "Cartoon", "Indian Mythological", "Fantasy", "Custom"];
// Master Prompt presets — one per visual style, auto-filled into the Master
// Prompt box when the style changes (the user can then edit it freely; the
// edited text is sent as THE style lock). Mirrors STYLE_LOCKS in
// lib/director.mjs (the frontend cannot import that module).
const STYLE_MASTER_PROMPTS: Record<string, string> = {
  "3D Preschool Animation":
    "Colorful 3D preschool animation, cute rounded characters, big expressive eyes, warm lighting, clean simple backgrounds, soft cinematic rendering",
  "3D Cinematic":
    "High-end 3D cinematic animation, detailed characters, dramatic lighting, rich textures, film-quality rendering",
  Realistic:
    "Ultra photorealistic highly detailed 8k uhd cinematic film still, natural skin texture, detailed expressive eyes, sharp focus, intricate details, realistic lighting and shadows, volumetric lighting, rich colors, shallow depth of field, no cartoon, no painting, no illustration, no blur",
  Anime:
    "Vibrant anime style, clean cel shading, expressive large eyes, dynamic composition, detailed backgrounds",
  Cartoon:
    "Classic 2D cartoon style, bold outlines, bright flat colors, playful squash-and-stretch feel",
  "Indian Mythological":
    "Ultra photorealistic Indian mythological cinematic film still, highly detailed 8k uhd, divine glowing palette, lifelike faces with natural skin texture and detailed expressive eyes, ornate traditional costumes and jewelry with intricate fabric detail, volumetric temple lighting, sharp focus, epic realistic backgrounds, no cartoon, no painting, no illustration, no blur",
  Fantasy:
    "Epic fantasy illustration style, magical glowing accents, lush detailed environments, cinematic atmosphere",
  Custom: "",
};

// Analyzer director types — each with role, task, and instructions
// Based on the Director instruction prompts for generating story and song videos
const ANALYZER_TYPES = {
  story_director: {
    role: "Story Director — Sanskriti AI Studio",
    task: "Analyze the supplied complete story, narration, or script and create a production-ready visual storyboard.",
    instructions: [
      "Understand the complete story before planning scenes.",
      "Identify the plot, beginning, middle, climax, ending, characters, relationships, events, locations, and props.",
      "Register every important character, including speaking characters and animals, with a unique ID, species, accurate anatomy, appearance, and reusable static visual_identity_prompt.",
      "Register all important locations and props with unique IDs and reusable visual identity prompts.",
      "Analyze the story and identify the characters, locations, objects, and source details needed for direct scene planning.",
      "Plan scenes directly from the supplied source lines, grouping only adjacent lines that describe the same visual moment.",
      "Specify the characters, location, visible props, action, narration or dialogue, shot composition, camera movement, lighting, and transition for each scene.",
      "Preserve the source's meaning, event order, and character relationships. Do not invent unnecessary characters or events.",
      "Maintain consistent character designs, clothing, proportions, props, locations, and visual style across scenes.",
      "Use the supplied video duration as the target runtime. Allocate scene durations according to narrative importance and supplied timing cues. Do not invent audio timestamps.",
      "Ensure every scene reference uses valid character, location, and prop IDs.",
      "Return valid JSON using the application's required schema, including story analysis and registered assets."
    ]
  },
  // Song Director: a full 16-section directive (asset-library-driven scene
  // planning). Sections render verbatim into the Master Prompt between TASK
  // and the VISUAL STYLE LOCK; the style lock itself stays dynamic (follows
  // the Visual Style dropdown) and the Additional Instructions box overrides
  // `additionalDefault` when the user types their own.
  song_director: {
    role: "Song Director — Sanskriti AI Studio",
    task: "Convert supplied song lyrics and available audio metadata into a complete visual music-video storyboard synchronized to the existing song. Use the complete Storyboard asset library to select appropriate characters, locations, and objects for every scene according to the lyrics, music, action, and narrative context.",
    instructions: [], // unused — `sections` renders instead
    sections: [
      {
        title: "Song Understanding and Structure",
        body: [
          "1. Read and understand all lyrics before planning scenes.",
          "2. Identify the intro, verses, chorus, repeated sections, bridge, outro, singers, speakers, characters, actions, and emotional progression when present.",
          "3. Do not rewrite lyrics, compose a new song, change the supplied duration, or generate replacement audio.",
          "4. Analyze available audio metadata, lyric timestamps, vocal segments, instrumental passages, tempo, mood, and transitions when provided.",
          "5. Treat the supplied audio duration as the fixed runtime.",
          "6. Never invent exact audio timestamps when they are unavailable. Estimate scene timings only when necessary and label them as estimated.",
        ].join("\n"),
      },
      {
        title: "Complete Storyboard Asset Registration",
        body: [
          "1. Register every relevant character represented in the lyrics, including singers, talking animals, personified objects, and other characters when present.",
          "2. Assign unique, stable IDs to characters and provide reusable static visual identity prompts.",
          "3. Register all relevant locations, environments, objects, and props identified through the lyrics, story, or supplied Storyboard analysis.",
          "4. Assign unique, stable IDs to locations and objects and provide reusable visual identity prompts.",
          "5. Preserve existing asset IDs, names, descriptions, reference images, and mappings supplied by Storyboard Analysis.",
          "6. Do not duplicate assets that already exist in the asset library.",
          "7. Do not invent replacement assets when suitable registered assets already exist.",
          "8. Do not assume that the first character, location, or object is the default asset.",
          "9. Do not assume a fixed number of assets.",
          "10. Treat the complete supplied asset library as the candidate pool for every scene, not merely the first entry or a small initial subset.",
        ].join("\n"),
      },
      {
        title: "Mandatory Full Asset Evaluation for Every Scene",
        body: [
          "Before generating EACH scene, evaluate the complete available list of registered characters, locations, and objects.",
          "",
          "This requirement applies independently to every scene and every batch of scenes.",
          "",
          "For each scene, determine:",
          "",
          "- Which registered characters are necessary for the current lyric or musical event?",
          "- Which registered location best matches the scene's action and narrative context?",
          "- Which registered objects or props are necessary for the action?",
          "- Which assets from previous scenes must remain present for continuity?",
          "- Which assets should be introduced, reused, moved, or removed?",
          "- Does the scene require a new location or a continuation of the existing location?",
          "- Does the scene require one character or an interaction between multiple characters?",
          "",
          "Do not select assets based on their array position, registration order, popularity, or convenience.",
          "",
          "**CRITICAL RULE:** The first registered location, character, or object must never automatically become the default for all scenes. Select assets according to scene relevance.",
        ].join("\n"),
      },
      {
        title: "Intelligent Location Selection and Distribution",
        body: [
          "1. Evaluate ALL registered locations before selecting the location for each scene.",
          "2. Choose the location that best matches the lyric meaning, action, story progression, and visual requirements.",
          "3. Use different locations when the lyrics or narrative indicate a change in setting.",
          "4. Maintain the current location when the story continues in the same environment.",
          "5. Introduce appropriate location transitions when characters travel, move, explore, or enter another environment.",
          "6. Use location-specific visual details from the registered asset description.",
          "7. Do not repeatedly use the first location merely because it was registered first.",
          "8. Do not randomly rotate locations simply to increase variety.",
          "9. Do not force every registered location into the song if it has no narrative relevance.",
          "10. Across the complete video, ensure that every relevant location is considered and used when the song provides a suitable opportunity.",
          "11. If the lyrics explicitly identify a location, prioritize that location when it matches the available asset library.",
          "12. If several locations are plausible, choose the one that best supports the current action and continuity.",
        ].join("\n"),
      },
      {
        title: "Intelligent Character Selection",
        body: [
          "1. Evaluate all registered characters for each scene.",
          "2. Include every character required by the current action, lyric, dialogue, or interaction.",
          "3. Include multiple characters when the action requires them to interact.",
          "4. Do not automatically reuse the first registered character.",
          "5. Do not force every character into every scene.",
          "6. Preserve character identity, appearance, clothing, proportions, colors, and distinguishing features.",
          "7. Keep singers and vocal performers consistent with the corresponding lyric or vocal segment.",
          "8. Do not assign lip-sync or singing actions to an unrelated character.",
          "9. For instrumental passages, use appropriate character actions when narratively relevant, without inventing sung dialogue.",
          "10. Ensure that all relevant characters receive appropriate appearances across the complete video.",
        ].join("\n"),
      },
      {
        title: "Intelligent Object and Prop Selection",
        body: [
          "1. Evaluate all registered objects and props for every scene.",
          "2. Select objects required by the lyrics, scene action, environment, or narrative.",
          "3. Include relevant props explicitly in the scene plan and final generation prompt.",
          "4. Do not ignore a relevant registered object because it appears later in the asset list.",
          "5. Do not insert irrelevant objects merely to increase asset utilization.",
          "6. Maintain object identity, color, shape, size, and appearance across scenes.",
          "7. Preserve object continuity when a character carries, uses, drops, collects, exchanges, or puts down an object.",
          "8. Introduce objects at the appropriate point in the song.",
          "9. If an object is mentioned in the lyrics, evaluate whether it should be visibly represented.",
          "10. When an object is not available in the registered library, use an existing suitable asset if appropriate; otherwise, identify the missing asset rather than falsely claiming that a registered asset was selected.",
        ].join("\n"),
      },
      {
        title: "Scene Segmentation and Lyric Synchronization",
        body: [
          "1. Plan scenes directly from the chronological lyrics and supplied timing cues.",
          "2. Group related lines when they describe one coherent action; split them when the visual meaning changes.",
          "3. For every scene, specify the corresponding lyric lines, start and end times when known, characters, location, visible props, and one primary visual action.",
          "4. Translate lyrics into literal or appropriately symbolic visuals that a viewer can understand.",
          "5. Do not create unrelated scenes just to fill the song.",
          "6. Use the existing song duration as the fixed runtime.",
          "7. Ensure the scene plan covers the supplied duration without unexplained gaps or overlaps.",
          "8. Preserve the existing scene-duration constraints and clip segmentation rules.",
          "9. Align scene changes with lyric changes, vocal phrases, musical transitions, and instrumental breaks when the supplied metadata supports them.",
          "10. Avoid changing a scene's primary action midway; split it into separate scenes when the visual meaning changes.",
        ].join("\n"),
      },
      {
        title: "Scene-Level Asset Mapping",
        body: [
          "Every scene MUST explicitly map its selected assets to the registered asset library.",
          "",
          "For each scene, include the fields supported by the existing output schema:",
          "",
          "- Scene ID.",
          "- Lyric segment or musical segment.",
          "- Start and end timestamps.",
          "- Selected character IDs and names.",
          "- Selected location ID and name.",
          "- Selected object/prop IDs and names.",
          "- Primary visual action.",
          "- Character interactions and positions.",
          "- Scene-specific environment details.",
          "- Camera framing and movement.",
          "- Lighting, mood, and visual style.",
          "- Transition to the next scene.",
          "- Final image or text-to-video prompt.",
          "",
          "Use existing registered IDs wherever available.",
          "",
          "Do not rely on vague instructions such as \"use storyboard assets\" or \"use the appropriate background.\"",
          "",
          "The final scene prompt must explicitly describe the selected location, characters, and relevant props so the video-generation model can produce the intended composition.",
          "",
          "Do not include all registered assets indiscriminately in every scene. Include the assets that are appropriate for that specific scene.",
        ].join("\n"),
      },
      {
        title: "Scene Prompt Construction",
        body: [
          "Construct every image or video generation prompt using the following order:",
          "",
          "1. **Location:** Identify the selected registered location and describe its relevant visual features.",
          "2. **Characters:** Identify the selected characters and preserve their registered visual identities.",
          "3. **Objects and props:** Identify the selected objects, their appearance, and how they are used.",
          "4. **Primary action:** Describe exactly one main visible action for the scene.",
          "5. **Composition:** Specify character positions, foreground, background, and important visual elements.",
          "6. **Camera:** Specify shot type, angle, framing, and movement.",
          "7. **Lighting and mood:** Match the musical mood and lyric context.",
          "8. **Continuity:** Preserve relevant details from previous scenes.",
          "9. **Style:** Apply the global visual style lock.",
          "10. **Transition:** Describe the visual transition when supported by the existing schema.",
          "",
          "The generated prompt must reflect the selected assets, not merely repeat the same generic scene description with different lyrics.",
        ].join("\n"),
      },
      {
        title: "Character, Location, and Prop Continuity",
        body: [
          "1. Maintain consistent character identity and appearance throughout the video.",
          "2. Maintain location continuity when consecutive scenes represent the same place.",
          "3. Preserve relevant props across scenes until the story indicates that they are removed, transferred, or no longer visible.",
          "4. Ensure that a character's actions in one scene make sense in the following scene.",
          "5. Allow location changes when justified by the lyrics or narrative.",
          "6. Avoid contradictory character positions, object ownership, and environmental details.",
          "7. Repeated choruses must preserve character identity while allowing purposeful variation in actions, camera angles, composition, and relevant locations.",
          "8. Reuse registered asset descriptions instead of creating inconsistent new descriptions for the same assets.",
        ].join("\n"),
      },
      {
        title: "Cinematic Direction",
        body: [
          "For each scene, specify:",
          "",
          "- One primary visual action.",
          "- Character expression and body language.",
          "- Shot type and camera angle.",
          "- Camera movement when appropriate.",
          "- Foreground and background composition.",
          "- Lighting and color mood.",
          "- Relevant environmental motion.",
          "- A suitable transition.",
          "",
          "Keep the scene visually understandable and appropriate for the song's audience.",
          "",
          "For children's songs, prefer clear actions, readable expressions, colorful environments, and simple compositions. For other songs, adapt the direction to the song's genre, mood, and narrative.",
          "",
          "Do not sacrifice lyric synchronization or asset relevance for unnecessary cinematic complexity.",
        ].join("\n"),
      },
      {
        title: "Instrumental Sections and Repeated Lyrics",
        body: [
          "1. Use instrumental passages for relevant visual actions, establishing shots, reactions, environmental movement, or transitions.",
          "2. Do not invent lyrics or assign lip-sync during instrumental-only segments.",
          "3. Repeated choruses should retain character identity and important story details.",
          "4. Use purposeful visual variation when appropriate, including different actions, framing, or relevant registered locations.",
          "5. Do not change the location or introduce new objects solely because a lyric section repeats.",
          "6. Make visual variation consistent with the actual song and narrative.",
        ].join("\n"),
      },
      {
        title: "Mandatory Asset Selection Validation",
        body: [
          "Before finalizing EACH scene, validate all of the following:",
          "",
          "- Was the complete available character list evaluated?",
          "- Was the complete available location list evaluated?",
          "- Was the complete available object and prop list evaluated?",
          "- Does the selected location match the current scene?",
          "- Are all characters necessary for the action included?",
          "- Are all relevant props included?",
          "- Are the selected asset IDs valid and mapped to registered assets?",
          "- Does the final prompt explicitly describe the selected assets?",
          "- Is the scene consistent with the lyrics and music?",
          "- Is continuity preserved from the previous scene?",
          "- Has an appropriate location change been made when required?",
          "- Has any suitable asset been overlooked simply because it was not the first entry?",
          "- Is the scene free of irrelevant assets added solely for coverage?",
          "",
          "If the first location or first asset keeps being selected despite more appropriate registered alternatives, reconsider the selection before finalizing the scene.",
        ].join("\n"),
      },
      {
        title: "Complete-Video Asset Coverage",
        body: [
          "After planning all scenes, review the complete storyboard as a whole.",
          "",
          "1. Check which registered characters, locations, and objects are used.",
          "2. Check which relevant assets were not used.",
          "3. Determine whether unused assets are genuinely irrelevant or have been overlooked.",
          "4. Add or revise scenes only when the song's lyrics, musical structure, and narrative support the change.",
          "5. Do not force irrelevant assets into the video to achieve 100% asset usage.",
          "6. Preserve the song duration, chronology, and established scene boundaries.",
          "7. Ensure that all relevant assets receive appropriate consideration across the complete video.",
          "",
          "Where supported by the existing schema, include a compact asset-coverage summary showing each registered asset's ID, type, scene IDs where it is used, and its reason for being unused when applicable.",
          "",
          "This summary must not replace scene-level asset mapping.",
        ].join("\n"),
      },
      {
        title: "Batch Processing and Context Preservation",
        body: [
          "If scene generation is performed in multiple batches:",
          "",
          "1. Apply the same full-asset-evaluation rules to every batch.",
          "2. Preserve the complete registered asset library across batches.",
          "3. Preserve character, location, prop, and continuity information from preceding batches.",
          "4. Do not reset the default location or character when a new batch begins.",
          "5. Do not assume that the assets used in the previous batch are the only available assets.",
          "6. Use global story context and local scene context together.",
          "7. Ensure that scene numbering and timestamps remain chronological across all batches.",
          "",
          "If the model receives only a partial asset list or insufficient context, do not pretend that all assets were evaluated. Use only the assets actually available and flag the missing context in a supported diagnostic field or validation report.",
        ].join("\n"),
      },
      {
        title: "Output and Schema Compliance",
        body: [
          "1. Return valid JSON using the existing required schema.",
          "2. Include registered characters, locations, and props; plan scenes directly from the source lines.",
          "3. Preserve existing field names, data types, required properties, and downstream compatibility.",
          "4. Do not introduce new top-level fields or change the schema unless explicitly permitted.",
          "5. Include selected asset IDs in every scene using the existing supported field structure.",
          "6. Ensure every referenced asset ID exists in the registered asset list.",
          "7. Ensure timestamps are valid, chronological, and consistent with the supplied duration.",
          "8. Do not include explanatory prose outside the JSON when machine-readable JSON is required.",
          "9. Do not use comments, trailing commas, or Markdown code fences around the JSON.",
          "10. If the existing schema supports asset-coverage metadata, populate it. Otherwise, keep the coverage validation internal without changing the schema.",
        ].join("\n"),
      },
    ],
    additionalDefault: [
      "- The complete registered Storyboard asset library is the candidate pool for every scene.",
      "- Evaluate every available location, character, and object before selecting assets for each scene.",
      "- Asset selection must be based on narrative relevance, lyrics, action, and continuity—not registration order.",
      "- Never automatically use the first location as the setting for every scene.",
      "- Never automatically use the first character or object as the default.",
      "- Use all relevant assets appropriately across the complete video, but never force irrelevant assets into a scene.",
      "- Every scene's final generation prompt must explicitly describe its selected assets and primary action.",
      "- Preserve existing audio synchronization, visual style, JSON schema, scene segmentation, and downstream workflow.",
      "- If the asset library is incomplete in the model's input context, identify the limitation rather than inventing selections.",
      "- Prioritize correct storytelling, scene-specific asset selection, and continuity over arbitrary visual variety.",
    ].join("\n"),
    objective: "Produce a complete, synchronized music-video storyboard in which every scene independently selects the most suitable registered characters, location, and objects from the entire available Storyboard asset library. The complete video must reflect the song's narrative progression and use relevant assets naturally, while maintaining consistent identities, meaningful location changes, coherent actions, and strict output-schema compatibility.",
  },
  story_from_song_director: {
    role: "Story-from-Song Director — Sanskriti AI Studio",
    task: "Transform narrative lyrics into a coherent visual story video synchronized to the existing song.",
    instructions: [
      "Analyze the complete lyrics as a narrative, not merely as separate lines.",
      "Identify the protagonist, supporting characters, goals, relationships, important events, setting, turning points, climax, and ending.",
      "Register all characters, locations, and props with stable IDs and reusable visual identity prompts.",
      "Preserve the narrative's chronological order and causal relationships.",
      "Plan scenes directly from the source lyrics in order, grouping adjacent lines only when they describe the same visual moment.",
      "Each scene must contain one clear primary visible action and reference its characters, location, and visible props.",
      "Use the exact lyric lines assigned to each scene. Use supplied timestamps when available; otherwise keep timing marked as estimated.",
      "Let musical repetition influence visual motifs and transitions, but do not force every repeated line to introduce a new event.",
      "During instrumental passages, continue the story with relevant actions, reactions, travel, environmental shots, or transitions consistent with the narrative.",
      "Preserve character designs, clothing, anatomy, props, and location continuity.",
      "Specify image composition, video action, camera movement, lighting, and transitions.",
      "Use the supplied total audio duration as the fixed runtime. Cover the complete song without changing its audio.",
      "Return valid JSON containing narrative analysis, registered assets, and the required scene-planning context."
    ]
  },
  kids_director: {
    role: "Kids Content Director — Sanskriti AI Studio",
    task: "Create preschool-friendly visual scenes from supplied children's song lyrics or story.",
    instructions: [
      "Understand the complete source and preserve its meaning.",
      "Register every important singer, speaker, and character with a unique species, accurate anatomy, and reusable visual identity prompt.",
      "Register relevant locations and props with unique IDs.",
      "Give every scene one simple, clearly readable primary action.",
      "Match song actions to the corresponding lyrics, or story actions to the narrative events.",
      "Use bright colors, warm lighting, soft materials, expressive faces, large gestures, and gentle camera movement.",
      "Avoid frightening faces, violence, harsh lighting, startling entrances, and dangerous actions children might imitate.",
      "Apply correct anatomy and skin covering to every species. Cats, dogs, and rabbits have fur; birds have feathers; reptiles and fish have scales.",
      "Keep character colors, markings, proportions, and accessories identical across scenes.",
      "Use repetition to reinforce recognizable actions while varying the composition appropriately.",
      "Specify the action, characters, location, visible props, image composition, video movement, and transition for every scene.",
      "Use the supplied song duration or story runtime. Do not regenerate lyrics or audio.",
      "Return valid JSON with registered assets and source-grounded scene-planning context, using the application's required schema."
    ]
  },
  devotional_director: {
    role: "Devotional Director — Sanskriti AI Studio",
    task: "Create a respectful, visually consistent devotional video from supplied lyrics or a mythological narrative.",
    instructions: [
      "Analyze the lyrics or story to identify the devotional subject, intended meaning, spiritual mood, narrative events, and emotional progression.",
      "Register every deity, saint, devotee, singer, and other relevant character with a unique ID and reusable visual identity prompt.",
      "Preserve appropriate iconography, complexion where specified, clothing, ornaments, number of arms, sacred attributes, and associated symbols according to the source or selected tradition.",
      "Register temples, sacred landscapes, locations, and props with unique IDs and reusable visual descriptions.",
      "For devotional songs, follow the lyric sequence and supplied song duration. For mythological stories, follow narrative chronology.",
      "Plan scenes directly from the lyrics or narration in source order, showing the meaning of each assigned passage.",
      "Give every scene one primary action and specify characters, location, visible props, composition, camera movement, lighting, and transition.",
      "Use devotional atmosphere, meaningful symbolism, and appropriate visual effects without obscuring the subject.",
      "Do not fabricate sacred quotations, unsupported scriptural events, or arbitrary divine attributes.",
      "Maintain deity identity, iconography, costume, props, and location continuity across all scenes.",
      "Preserve the supplied lyrics and audio. Use supplied timestamps where available and label estimated timings when they are not.",
      "Return valid JSON with devotional analysis and registered assets, using the application's required schema."
    ]
  }
} as const;

type AnalyzerType = keyof typeof ANALYZER_TYPES;

const LANGS = ["Hindi", "English", "Hinglish"];
const TARGETS = [
  { label: "30 sec", seconds: 30 },
  { label: "1 min", seconds: 60 },
  { label: "2 min", seconds: 120 },
  { label: "3 min", seconds: 180 },
  { label: "5 min", seconds: 300 },
  { label: "10 min", seconds: 600 },
  { label: "Custom", seconds: -1 },
];
const SCENE_DURS = [
  { label: "3 sec", seconds: 3 },
  { label: "5 sec", seconds: 5 },
  { label: "6 sec", seconds: 6 },
  { label: "8 sec", seconds: 8 },
  { label: "Custom", seconds: -1 },
];
const ASPECTS = ["16:9", "9:16", "1:1"];

const str = (v: unknown): string => (v == null ? "" : String(v));

// Shot timeline formatting: 1-decimal seconds ("1.4s"), ranges as "0–1.4s".
const fmtT = (v: unknown): string => {
  const n = Number(v);
  return Number.isFinite(n) ? `${Math.round(n * 10) / 10}s` : "—";
};
const fmtRange = (a: unknown, b: unknown): string => `${fmtT(a)}–${fmtT(b)}`;
// Timed shots of a scene (multi-shot scenes); [] = legacy single-image scene.
const sceneShots = (s: DirectorScene): DirectorShot[] =>
  (Array.isArray(s.shots) ? s.shots : []) as DirectorShot[];
// Total generation beats a board flattens to (shots each render one clip).
const boardBeats = (scenes: DirectorScene[]): number =>
  scenes.reduce((a, s) => a + Math.max(1, sceneShots(s).length), 0);
// Projected total beats for an in-progress board: beats planned so far plus
// the remaining scene rows projected at the observed shots/scene average.
// Shots ARE scenes at generation time (one clip per shot), so this is the
// live "total scenes" — it starts at sceneCount (1 shot/scene) and grows as
// multi-shot scenes land. When the plan completes (rows == sceneCount) it
// collapses to exactly the flattened beats, mirroring the server shrink.
const boardBeatsTotal = (scenes: DirectorScene[], sceneCount: number): number => {
  const done = boardBeats(scenes);
  const rows = scenes.length;
  const cap = Math.max(0, Math.round(Number(sceneCount) || 0));
  if (!rows) return Math.max(1, cap);
  if (rows >= cap) return done;
  const avg = done / Math.max(1, rows);
  return Math.max(cap, done, Math.round(done + Math.max(0, cap - rows) * avg));
};
// Planned seconds across scenes (1-decimal), vs the board's time target.
const boardPlannedSeconds = (scenes: DirectorScene[]): number =>
  Math.round(scenes.reduce((a, s) => a + (Number(s.duration_seconds) || 0), 0) * 10) / 10;
// Some older/empty boards persisted sceneCount=0. Display and plan from the
// same duration-based cap the server recovers, rather than hiding the scene
// panel (and its live LLM response) until the first batch has returned.
const directorSceneCap = (board: DirectorBoard | null): number => {
  if (!board) return 0;
  const saved = Math.round(Number(board.sceneCount) || 0);
  if (saved > 0) return saved;
  const target = Math.round(Number(board.input.song?.durationSeconds ?? board.input.targetSeconds) || 0);
  const seconds = Math.max(1, Math.min(30, Math.floor(Number(board.input.sceneSeconds) || 3)));
  return target > 0 ? Math.min(300, Math.max(1, Math.round(target / seconds))) : 0;
};
// Numbered source lines (story lines or lyric lines) for coverage text.
const sourceLinesOf = (board: DirectorBoard | null): string[] => {
  if (!board) return [];
  const bp = board.blueprint as unknown as { lyric_lines?: { lyric_text?: unknown }[] } | null;
  const song = board.input.song;
  if (song && song.hasLyrics !== false && Array.isArray(bp?.lyric_lines) && bp.lyric_lines.length) {
    return bp.lyric_lines.map((l) => str(l.lyric_text)).filter(Boolean);
  }
  return str(board.input.story).split("\n")
    .map((l) => l.trim()).filter((l) => l && !/^\[.*\]$/.test(l));
};
// Human-readable source coverage for a scene box: the lyric/story lines it
// covers ("L2–3: …"), falling back to the lyric text.
const sceneCoverage = (s: DirectorScene, lines: string[]): string | null => {
  if (str(s.lyric_text)) return `\u201c${str(s.lyric_text).slice(0, 120)}\u201d`;
  const a = Number(s.line_from);
  const b = Number(s.line_to);
  if (lines.length && Number.isFinite(a) && a > 0) {
    const from = Math.max(1, Math.round(a));
    const to = Math.max(from, Number.isFinite(b) && b > 0 ? Math.round(b) : from);
    const slice = lines.slice(from - 1, to).filter(Boolean);
    if (slice.length) {
      const label = to > from ? `L${from}\u2013${to}` : `L${from}`;
      return `${label}: \u201c${slice.join(" / ").slice(0, 140)}\u201d`;
    }
  }
  return null;
};

// --- Line-by-line live typing for newly planned storyboard scenes ---
// Newly landed scenes reveal their row text progressively (title → shot
// segments/action → source coverage), one line after another with a typing
// caret, instead of popping in all at once. Purely client-side: the batch
// already landed, we just replay its text with a typewriter effect.
const TYPE_CHAR_MS = 14;
const TYPE_LINE_GAP_MS = 320;

function TypedText({ text, animate, delayMs = 0, className, style, title }: {
  text: string; animate: boolean; delayMs?: number; className?: string; style?: CSSProperties; title?: string;
}) {
  const full = str(text);
  const [shown, setShown] = useState(animate ? 0 : full.length);
  useEffect(() => {
    if (!animate) { setShown(full.length); return; }
    setShown(0);
    let iv: number | null = null;
    const t = window.setTimeout(() => {
      iv = window.setInterval(() => {
        setShown((n) => {
          if (n >= full.length) { if (iv != null) window.clearInterval(iv); return n; }
          return n + 1;
        });
      }, TYPE_CHAR_MS);
    }, Math.max(0, delayMs));
    return () => { window.clearTimeout(t); if (iv != null) window.clearInterval(iv); };
  }, [animate, delayMs, full]);
  const done = shown >= full.length;
  return (
    <span className={className} style={style} title={title}>
      {full.slice(0, shown)}
      {animate && !done && <span className="typing-caret" aria-hidden="true" />}
    </span>
  );
}

// Rough replay budget for a scene row (title + shot segments/action +
// coverage), so the typing flag clears once the animation must be done.
const sceneTypeBudget = (s: DirectorScene): number => {
  const shots = sceneShots(s);
  const segs = shots.length
    ? shots.map((sh) => str(sh.lyric_segment) || str(sh.action))
    : [str(s.action)];
  const chars = str(s.title).length + segs.reduce((a, t) => a + Math.min(t.length, 400), 0) + 200;
  return chars * TYPE_CHAR_MS + (segs.length + 2) * TYPE_LINE_GAP_MS;
};

// "speaker: line" per line (optional "(expression)" after the speaker) —
// shared by scene + per-shot dialogue editors; the clip grows to fit voices.
const parseDialogueLines = (text: string): { speaker: string; line: string; expression?: string }[] =>
  text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const c = l.indexOf(":");
    if (c <= 0) return { speaker: "", line: l };
    const head = l.slice(0, c).trim();
    const line = l.slice(c + 1).trim();
    const m = head.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    return m
      ? { speaker: m[1].trim(), expression: m[2].trim(), line }
      : { speaker: head, line };
  }).filter((d) => d.line);
const formatDialogueLines = (dlg: unknown): string =>
  (Array.isArray(dlg) ? dlg.map((d) => {
    const sp = String((d as { speaker?: unknown }).speaker || "").trim();
    const ln = String((d as { line?: unknown }).line || "").trim();
    const ex = String((d as { expression?: unknown }).expression || "").trim();
    const head = sp && ex ? `${sp} (${ex})` : sp;
    return head ? `${head}: ${ln}` : ln;
  }).filter(Boolean).join("\n") : "");

// Pre-defined CHARACTER CONSISTENCY rules (mirrors
// DEFAULT_CHARACTER_CONSISTENCY_RULES in lib/director.mjs). Every character
// gets these by default; the per-character popup lets the user edit, add,
// delete or reset them at any time. Saved as character.consistency_rules
// and sent to the AI with every scene-batch + regen call.
const DEFAULT_CHAR_RULES = [
  "Keep the exact same face: shape, eyes, nose, lips, jawline and skin tone in every scene.",
  "Keep the exact same body, species traits and proportions in every scene.",
  "Keep the exact same clothing, colors and accessories unless the story explicitly changes them.",
  "Paste the visual_identity_prompt verbatim into every image_prompt — never paraphrase or shorten it.",
  "Keep the same art style and rendering for this character across all scenes.",
  "Stage speaking scenes front-facing so the face stays clearly visible.",
];
const charRules = (c: Record<string, unknown>): string[] =>
  Array.isArray(c.consistency_rules)
    ? (c.consistency_rules as unknown[]).map((x) => String(x ?? "")).filter(Boolean)
    : [...DEFAULT_CHAR_RULES];

// Elapsed seconds since `since` (null = not running).
function Elapsed({ since }: { since: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since == null) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [since]);
  if (since == null) return null;
  const s = Math.max(0, Math.round((now - since) / 1000));
  return <span className="muted"> · {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}</span>;
}

// AI Story Director — Story-to-Video workflow. Authors a storyboard
// (analysis -> bibles -> source-grounded scenes) via the local LLM; APPROVE hands
// a standard scenario to the EXISTING save/generation pipeline, so image /
// video / merge / progress / resume are all reused, never reimplemented.

// Saved-storyboard card language: board status -> pill label + tone.
const BOARD_STATUS: Record<string, { label: string; cls: string }> = {
  analyzed: { label: "Analyzed", cls: "warn" },
  "scenes-partial": { label: "Scenes partial", cls: "running" },
  ready: { label: "Ready", cls: "ok" },
  approved: { label: "Approved", cls: "done" },
  "approved-partial": { label: "Approved · partial", cls: "done" },
};
const boardStatusOf = (s: string) => BOARD_STATUS[s] ?? { label: s, cls: "" };
// ----- Audio Intelligence: real .wav upload → WhisperX → 19-track timeline -----
// The panel uploads the .wav to POST /api/director/boards/:id/audio-upload,
// runs POST .../whisperx/analyze, polls the job, then reads the derived
// master timeline from GET .../master-timeline. Every count below comes from
// that real server response — never mocked.
type TimelineTrackCounts = {
  lyrics: number; word_timings: number; speaker_events: number;
  narrative_events: number; character_appearances: number;
  character_actions: number; emotions: number;
  dialogue_performance: number; choreography: number;
  camera_direction: number; scene_timeline: number;
  shot_timeline: number; lip_sync: number; sound_effects: number;
  video_assets: number; transitions: number; subtitles: number;
  original_audio: number; music_structure: number;
};
const EMPTY_TRACK_COUNTS: TimelineTrackCounts = {
  lyrics: 0, word_timings: 0, speaker_events: 0,
  narrative_events: 0, character_appearances: 0,
  character_actions: 0, emotions: 0,
  dialogue_performance: 0, choreography: 0,
  camera_direction: 0, scene_timeline: 0,
  shot_timeline: 0, lip_sync: 0, sound_effects: 0,
  video_assets: 0, transitions: 0, subtitles: 0,
  original_audio: 0, music_structure: 0,
};
const fileToDataUrl = (file: File, onProgress?: (percent: number) => void): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("could not read audio file"));
    r.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(Math.floor((event.loaded / event.total) * 20));
    };
    r.onload = () => { onProgress?.(20); resolve(String(r.result || "")); };
    r.readAsDataURL(file);
  });
const sleep = (ms: number): Promise<void> =>
  new Promise<void>((res) => { setTimeout(res, ms); });
// Poll a WhisperX job until it succeeds; throw on failure/cancel/timeout.
async function waitForWhisperXJob(boardId: string, jobId: string, onProgress?: (percent: number) => void): Promise<void> {
  for (let i = 0; i < 400; i++) {
    await sleep(3000);
    const st = await getWhisperXJobStatus(boardId, jobId);
    onProgress?.(Math.min(100, Math.max(0, Number(st.progress) || 0)));
    if (st.status === "succeeded") { onProgress?.(100); return; }
    if (st.status === "failed" || st.status === "cancelled") {
      throw new Error(st.error || st.message || `WhisperX analysis ${st.status}`);
    }
  }
  throw new Error("WhisperX analysis timed out — check the server log and retry.");
}
// Per-track event counts derived from the REAL master-timeline response.
// Tracks the server does not emit as separate events stay 0 (honest, not mocked).
function deriveTrackCounts(mt: MasterTimelineResponse): TimelineTrackCounts {
  const lines = mt.timeline?.lines || [];
  const segments = mt.master?.segments || [];
  const clips = mt.master?.clips || [];
  const sceneMap = mt.timeline?.scene_map || [];
  const wordCount = lines.reduce((n, l) => n + (l.words?.length || 0), 0);
  const scenes = new Set(sceneMap.map((s) => s.scene_number).filter((n) => n != null));
  const chars = new Set(segments.map((s) => s.character_id).filter(Boolean));
  const vocalSegs = segments.filter((s) => s.type === "singing" || s.type === "dialogue" || s.type === "mixed");
  return {
    lyrics: lines.length,
    word_timings: wordCount,
    speaker_events: segments.filter((s) => s.speaker).length,
    narrative_events: (mt.timeline?.actions || []).length,
    character_appearances: chars.size,
    character_actions: segments.filter((s) => s.action).length,
    emotions: segments.filter((s) => s.expression).length,
    dialogue_performance: vocalSegs.length,
    choreography: 0,
    camera_direction: segments.filter((s) => s.camera).length,
    scene_timeline: scenes.size,
    shot_timeline: clips.length,
    lip_sync: vocalSegs.reduce((n, s) => n + (s.words?.length || 0), 0),
    sound_effects: 0,
    video_assets: 0,
    transitions: clips.length > 0 ? clips.length - 1 : 0,
    subtitles: lines.length,
    original_audio: mt.whisperx_audio_url ? 1 : 0,
    music_structure: segments.length,
  };
}

export default function DirectorPage({ onOpenProject, onProjectsChanged, onPlanningProgress, imageMode, onImageMode, requestedBoard, onSelectedBoardChange }: {
  onOpenProject: (name: string) => void;
  onProjectsChanged: () => void;
  /** Lifts AI planning progress (analyze + scene batches) to the menu's
      Progress Status — same shape as generation progress, unit "scenes". */
  onPlanningProgress?: (p: GenerationProgress) => void;
  imageMode?: ImageMode;
  onImageMode?: (mode: ImageMode) => void;
  requestedBoard?: { id: string; nonce: number } | null;
  onSelectedBoardChange?: (id: string | null) => void;
}) {
  const dialog = useDialog();
  // Story form.
  const [title, setTitle] = useState("");
  const [story, setStory] = useState("");
  const [language, setLanguage] = useState("English");
  // The language of the SOURCE TEXT for the meaning analysis. "auto" detects
  // it per line (Hindi / English / Hinglish).
  const [semanticsLanguage, setSemanticsLanguage] = useState("auto");
  const [genre, setGenre] = useState("Adventure");
  const [genreCustom, setGenreCustom] = useState("");
  const [visualStyle, setVisualStyle] = useState("3D Cinematic");
  const [styleCustom, setStyleCustom] = useState("");
  // Analyzer type: selects which director prompt to use
  const [analyzerType, setAnalyzerType] = useState<AnalyzerType>("story_director");
  // Master Prompt: auto-filled from the visual-style preset on style change,
  // freely editable — it is sent as THE style lock for every image prompt.
  const [masterPrompt, setMasterPrompt] = useState(STYLE_MASTER_PROMPTS["3D Cinematic"]);
  const [targetOpt, setTargetOpt] = useState(60);
  const [targetCustom, setTargetCustom] = useState("90");
  const [sceneOpt, setSceneOpt] = useState(3);
  const [sceneCustom, setSceneCustom] = useState("3");
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [instructions, setInstructions] = useState("");
  // ✨ Get by AI for the instructions box: the local LLM reads the story +
  // master settings and drafts tailored director instructions into the box.
  const [suggestingInstructions, setSuggestingInstructions] = useState(false);
  const [instructionsNote, setInstructionsNote] = useState<string | null>(null);
  // Dialogue opt-out (voice + lip-sync) and connected-scenes chaining.
  // Both default ON: voiced, visually continuous movies. Uncheck dialogues
  // for a silent film; uncheck connected for independent per-scene shots.
  const [includeDialogue, setIncludeDialogue] = useState(true);
  const [chainContinuity, setChainContinuity] = useState(true);
  // Boards.
  const [boards, setBoards] = useState<DirectorBoardMeta[]>([]);
  const [boardMediaProgress, setBoardMediaProgress] = useState<Record<string, { scenesGenerated: number; scenesTotal: number; shotsGenerated: number; shotsTotal: number; imagesGenerated: number; videosGenerated: number }>>({});
  const [board, setBoard] = useState<DirectorBoard | null>(null);
  const [addNewOpen, setAddNewOpen] = useState(false);
  const [addNewProjects, setAddNewProjects] = useState<{ name: string; label: string; boardId: string }[]>([]);
  const [addNewSourceBoard, setAddNewSourceBoard] = useState<DirectorBoard | null>(null);
  const [addNewSourceId, setAddNewSourceId] = useState("");
  const [addNewName, setAddNewName] = useState("");
  const [addNewTabs, setAddNewTabs] = useState<DirectorImportTabId[]>([]);
  const [addNewLoading, setAddNewLoading] = useState(false);
  const [addNewSaving, setAddNewSaving] = useState(false);
  const [addNewError, setAddNewError] = useState("");
  const [activeDirectorTab, setActiveDirectorTab] = useState<DirectorTabId>("brief");
  const [mediaOutputsReady, setMediaOutputsReady] = useState(false);
  const [finalOutputReady, setFinalOutputReady] = useState(false);
  const [mediaProcessingStage, setMediaProcessingStage] = useState<"media" | "export" | null>(null);
  const [generationProgressPct, setGenerationProgressPct] = useState(0);
  // Generate Assets stage — master stills reused by every scene of the board.
  const [assetProduction, setAssetProduction] = useState<DirectorAssetProduction | null>(null);
  const [assetBusy, setAssetBusy] = useState(false);
  const [assetUploading, setAssetUploading] = useState<string | null>(null);
  const [selectedAssetVersions, setSelectedAssetVersions] = useState<Record<string, number | null>>({});
  const [assetPromptEditor, setAssetPromptEditor] = useState<{ assetId: string; name: string; prompt: string } | null>(null);
  const [busy, setBusy] = useState<{ label: string; since: number } | null>(null);
  const [error, setError] = useState("");
  const [sceneProgress, setSceneProgress] = useState("");
  // Scene boxes currently being planned by the AI (rendered as Generating…;
  // every later box renders as To be Generated until its batch lands).
  const [generatingRange, setGeneratingRange] = useState<{ from: number; to: number } | null>(null);
  // Storyboard live typing: scene_numbers currently replaying their row text
  // line by line (see TypedText). Detected by diffing landed scenes per open
  // board — opening a board seeds the seen set, so old boards never replay.
  const [typingScenes, setTypingScenes] = useState<number[]>([]);
  const seenSceneNumsRef = useRef<{ boardId: string; nums: Set<number> } | null>(null);
  const assetFileInputRefs = useRef(new Map<string, HTMLInputElement>());
  // Scene keyframes can consume approved pixel references only in Flux 2
  // Klein mode. The global image selector defaults to Flux Reference Image,
  // which is text-only, so switch it when the Director media stage opens.
  useEffect(() => {
    if (activeDirectorTab === "media") onImageMode?.("flux");
  }, [activeDirectorTab, onImageMode]);
  const reduceMotion = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches)[0];
  useEffect(() => {
    if (!board || reduceMotion) return;
    const nums = board.scenes.map((s) => s.scene_number);
    const seen = seenSceneNumsRef.current;
    if (!seen || seen.boardId !== board.id) {
      seenSceneNumsRef.current = { boardId: board.id, nums: new Set(nums) };
      setTypingScenes([]);
      return;
    }
    const fresh = nums.filter((n) => !seen.nums.has(n));
    if (!fresh.length) return;
    for (const n of fresh) seen.nums.add(n);
    setTypingScenes((cur) => [...cur.filter((n) => !fresh.includes(n)), ...fresh]);
  }, [board, reduceMotion]);
  // Typing is a replay with a known budget — clear the flag once it must be
  // done so rows settle to static text (TypedText already hides the caret).
  useEffect(() => {
    if (!typingScenes.length || !board) return;
    let budget = 0;
    for (const n of typingScenes) {
      const s = board.scenes.find((x) => x.scene_number === n);
      if (s) budget = Math.max(budget, sceneTypeBudget(s));
    }
    const t = window.setTimeout(() => setTypingScenes([]), Math.min(25000, budget + 1200));
    return () => window.clearTimeout(t);
  }, [typingScenes, board]);
  const [stoppedNote, setStoppedNote] = useState<string | null>(null);
  // Character consistency toggle: when enabled, appends the same character
  // description to every scene's prompt, ensuring visual consistency across
  // all scenes. May reduce AI creative freedom but greatly improves character
  // similarity. Persisted in localStorage.
  const [characterConsistent, setCharacterConsistent] = useState<
    boolean
  >(() => {
    const stored = localStorage.getItem("characterConsistent");
    return stored !== null ? JSON.parse(stored) : false;
  });
  // UI: persist toggle choice so it survives tab refreshes
  useEffect(() => {
    localStorage.setItem("characterConsistent", JSON.stringify(characterConsistent));
  }, [characterConsistent]);
  // Scene-planning batch size (scenes per AI Director LLM batch) — chosen
  // from the Batch Size dropdown before Generate scenes / Continue scenes and
  // sent as the batch count (server default when unset = SCENE_BATCH = 20).
  const [sceneBatch, setSceneBatch] = useState<number>(SCENE_BATCH);
  // Character consistency toggle UI
  const characterConsistentToggle = (
    <label style={{ marginRight: 16, fontSize: 12 }}>
      <input
        type="checkbox"
        checked={characterConsistent}
        onChange={(e) => setCharacterConsistent(e.target.checked)}
        style={{ transform: "scale(1.2)", marginRight: 4 }}
      />
      Consistent
    </label>
  );
  // ----- Audio Intelligence state (Part 5 & 6) -----
  const [audioUploaded, setAudioUploaded] = useState(false);
  const [audioDuration, setAudioDuration] = useState(0);
  const [audioMeta, setAudioMeta] = useState<{ file: string; fileName: string } | null>(null);
  const [audioAnalysisStatus, setAudioAnalysisStatus] = useState<"pending" | "generated" | "validated" | "approved" | "failed">("pending"); // "pending"|"generated"|"validated"|"approved"|"failed"
  const [audioBusy, setAudioBusy] = useState(false);
  const [audioProgressPct, setAudioProgressPct] = useState(0);
  const [timelineEventsCount, setTimelineEventsCount] = useState<TimelineTrackCounts>(EMPTY_TRACK_COUNTS);
  const [timelineValidation, setTimelineValidation] = useState({ valid: true, warnings: [] as string[] });
  const [timelineApproval, setTimelineApproval] = useState<"pending" | "approved" | "revision_required">("pending");
  const [timelineVersion, setTimelineVersion] = useState(0);
  // The full server response — the single source of truth for the visual
  // 19-track timeline. Only read through the UI adapter; never mutated here.
  const [masterTimeline, setMasterTimeline] = useState<MasterTimelineResponse | null>(null);
  const [directorConsumption, setDirectorConsumption] = useState<"idle" | "consuming" | "planning" | "consumed">("idle");
  const [directorBusy, setDirectorBusy] = useState<"load" | "model" | "planning" | "consumed">("load");
  const cancelRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  // Planning progress for the menu's Progress Status (total + per-scene Time
  // Remaining, same countdown language as Projects). planPhase is set for the
  // two LLM phases only (analyze + scene batches) — approve/migrate/regen
  // are seconds-long and stay local. Batch stats accumulate per-board so
  // Stop/resume keeps its live pace instead of restarting cold.
  const [planPhase, setPlanPhase] = useState<{
    kind: "analyze" | "scenes"; startedAt: number; title: string; total: number;
  } | null>(null);
  const batchStartRef = useRef<number | null>(null);
  const planStatsRef = useRef<{ boardId: string; sceneMs: number; scenes: number } | null>(null);
  // 1s ticker so the remaining-time countdowns stay live while planning.
  const [dirNow, setDirNow] = useState(() => Date.now());
  useEffect(() => {
    if (!planPhase) return;
    const t = setInterval(() => setDirNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [planPhase]);
  // Live LLM view: while planning, poll the read-only stream buffer (~1s) so
  // the storyboard shows what the backend is writing scene-by-scene,
  // word-by-word. Best-effort — a failed poll never disturbs planning.
  const [live, setLive] = useState<DirectorLive | null>(null);
  const liveBoardId = board?.id ?? null;
  useEffect(() => {
    if (!planPhase || !liveBoardId) { setLive(null); return; }
    let dead = false;
    const tick = async () => {
      try {
        const s = await directorLive(liveBoardId);
        if (!dead) setLive(s && s.active ? s : null);
      } catch { /* live view is best-effort */ }
    };
    void tick();
    const t = window.setInterval(tick, 1000);
    return () => { dead = true; window.clearInterval(t); };
  }, [planPhase, liveBoardId]);
  // Live backend response for the PRE-BOARD form: while the storyboard is
  // being generated (no board exists yet), poll the analyze stream buffer
  // (~1s) and show the raw response in the read-only textarea below the
  // instructions box. Hidden again the moment generation ends.
  const [formLiveText, setFormLiveText] = useState("");
  const analyzeLiveIdRef = useRef<string | null>(null);
  const formLiveRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (!planPhase || planPhase.kind !== "analyze") {
      if (!planPhase) setFormLiveText("");
      return;
    }
    const id = analyzeLiveIdRef.current;
    if (!id) return;
    let dead = false;
    const tick = async () => {
      try {
        const s = await directorAnalyzeLive(id);
        if (!dead && s.active && s.text) setFormLiveText(s.text);
      } catch { /* live view is best-effort */ }
    };
    void tick();
    const t = window.setInterval(tick, 1000);
    return () => { dead = true; window.clearInterval(t); };
  }, [planPhase]);
  // Keep the live textarea pinned to the newest tokens.
  useEffect(() => {
    const el = formLiveRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [formLiveText]);
  // Editing + master-detail selection (compact cards + one full detail section).
  const [selectedScene, setSelectedScene] = useState<number | null>(null);
  const [selectedSceneNumbers, setSelectedSceneNumbers] = useState<Set<number>>(() => new Set());
  const [editingScene, setEditingScene] = useState<number | null>(null);
  // Scene Details/Edit popup: one modal per scene (mode details = full
  // breakdown, mode edit = edit form). Cards stay compact; the separate
  // details section below the grid is replaced by this popup.
  const [sceneModal, setSceneModal] = useState<{ index: number; mode: "details" | "edit"; shot?: number | null } | null>(null);
  const [sceneDraft, setSceneDraft] = useState<Partial<DirectorScene>>({});
  const [dialogueDraft, setDialogueDraft] = useState("");
  const [regenScene, setRegenScene] = useState<number | null>(null);
  // AI append (Add Character / Location / Object): one LLM call that reads
  // the master input + already-generated bible and appends a single entry.
  const [addingEntry, setAddingEntry] = useState<DirectorEntryKind | null>(null);
  // Per-card AI regenerate (one bible entry rewritten in place).
  const [regenEntry, setRegenEntry] = useState<{ kind: DirectorEntryKind; index: number } | null>(null);
  // Per-character CHARACTER CONSISTENCY popup (prompt + editable rules).
  const [editingChar, setEditingChar] = useState<number | null>(null);
  const [charDraft, setCharDraft] = useState<Record<string, string>>({});
  const [ruleDraft, setRuleDraft] = useState<string[]>([]);
  const [newRule, setNewRule] = useState("");
  const [savingChar, setSavingChar] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [showAnalysis, setShowAnalysis] = useState(false);
  // 📝 Directing-inputs viewer/editor: the master inputs saved before
  // directing (title, story/lyrics, language, genre, style, durations,
  // aspect, instructions + toggles). Opened from the open board header AND
  // from any Saved Storyboard card (fetches that board's inputs on demand).
  // View always; Edit flips the fields editable and Save persists via PUT.
  const [inputBoard, setInputBoard] = useState<DirectorBoard | null>(null);
  const [inputEditing, setInputEditing] = useState(false);
  const [inputDraft, setInputDraft] = useState({
    title: "", story: "", language: "English", genre: "Adventure", genreCustom: "",
    visualStyle: "3D Cinematic", styleCustom: "", masterPrompt: "", targetSeconds: 60,
    sceneSeconds: 3, aspectRatio: "16:9", instructions: "",
    includeDialogue: true, chainContinuity: true,
  });
  const [savingInputs, setSavingInputs] = useState(false);
  const [loadingCardInputs, setLoadingCardInputs] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("ss-sec-director") === "closed");
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      localStorage.setItem("ss-sec-director", c ? "open" : "closed");
      return !c;
    });
  // Saved-storyboard rail on the right: open by default, collapsible to a
  // slim Boards rail (same pattern as the Projects panel). Choice persists.
  const [boardsOpen, setBoardsOpen] = useState(() => localStorage.getItem("ss-sec-boards") !== "closed");
  const toggleBoards = () =>
    setBoardsOpen((o) => {
      localStorage.setItem("ss-sec-boards", o ? "closed" : "open");
      return !o;
    });

  const targetSeconds = targetOpt === -1 ? Math.max(15, Number(targetCustom) || 60) : targetOpt;

  // ✨ Get by AI for Additional director instructions: the local LLM reads the
  // story/lyrics + master settings and drafts tailored instructions into the
  // box (existing text is sent along so the AI refines instead of discarding).
  const handleSuggestInstructions = async () => {
    if (suggestingInstructions || busy) return;
    if (story.trim().length < 20 && !title.trim()) {
      setInstructionsNote("Paste the story (20+ characters) or give it a title first.");
      return;
    }
    setSuggestingInstructions(true);
    setInstructionsNote(null);
    try {
      const r = await suggestDirectorInstructions(story, {
        title: title.trim(),
        genre: genre === "Custom" && genreCustom.trim() ? genreCustom.trim() : genre,
        visualStyle: visualStyle === "Custom" && styleCustom.trim() ? styleCustom.trim() : visualStyle,
        language,
        existing: instructions.trim(),
      });
      setInstructions(r.instructions);
      setInstructionsNote(
        r.reasoning ? `AI drafted instructions — ${r.reasoning}` : "AI drafted instructions — review and edit as needed.",
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setInstructionsNote(msg);
      alertIfLlm(msg);
    } finally {
      setSuggestingInstructions(false);
    }
  };
  const sceneSeconds = sceneOpt === -1 ? Math.min(30, Math.max(1, Number(sceneCustom) || 4)) : sceneOpt;
  // Scene count is purely story + time driven (target / scene). The 300 safety
  // ceiling in lib/director.mjs only guards runaway custom inputs.
  const plannedScenes = Math.min(300, Math.max(1, Math.round(targetSeconds / sceneSeconds)));

  const refreshBoardMediaProgress = useCallback(async (boardList: DirectorBoardMeta[]) => {
    try {
      const projects = await listScenarios();
      const linked = boardList.filter((item) => item.scenarioName);
      const rows = await Promise.all(linked.map(async (item) => {
        const project = projects.find((candidate) => candidate.name === item.scenarioName
          || (item.project_id != null && candidate.project_id === item.project_id));
        if (!project) return [item.id, null] as const;
        try {
          const [scenario, outputs] = await Promise.all([
            getScenario(project.name),
            Promise.all((["ltx", "wan"] as const).flatMap((engine) => (["landscape", "vertical"] as const).map((format) =>
              listOutputs(outScenario(folderOf(project, project.name), engine, format))))),
          ]);
          const config = scenario.config;
          const sequence = Array.isArray((config as Scenario).sequence) ? (config as Scenario).sequence : [];
          const generated = sequence.map((_, i) => ({ image: false, video: false }));
          for (const output of outputs) {
            sequence.forEach((_, i) => {
              const beat = output.versions?.beats?.[String(i + 1)];
              if (beat?.keyframe?.length) generated[i].image = true;
              if (beat?.clip?.length) generated[i].video = true;
            });
          }
          const scenes = new Map<string, number[]>();
          sequence.forEach((beat, i) => {
            const n = Number((beat as { scene_number?: unknown })?.scene_number);
            const key = Number.isFinite(n) && n > 0 ? String(n) : String(i + 1);
            scenes.set(key, [...(scenes.get(key) ?? []), i]);
          });
          return [item.id, {
            scenesGenerated: [...scenes.values()].filter((indices) => indices.every((i) => generated[i].image && generated[i].video)).length,
            scenesTotal: scenes.size,
            shotsGenerated: generated.filter((beat) => beat.image && beat.video).length,
            shotsTotal: sequence.length,
            imagesGenerated: generated.filter((beat) => beat.image).length,
            videosGenerated: generated.filter((beat) => beat.video).length,
          }] as const;
        } catch {
          return [item.id, null] as const;
        }
      }));
      const nextProgress: Record<string, { scenesGenerated: number; scenesTotal: number; shotsGenerated: number; shotsTotal: number; imagesGenerated: number; videosGenerated: number }> = {};
      for (const [id, value] of rows) if (value) nextProgress[id] = value;
      setBoardMediaProgress(nextProgress);
    } catch { /* progress is best-effort; board cards remain usable */ }
  }, []);
  const refreshBoards = async () => {
    try {
      const next = await directorBoards();
      setBoards(next);
      void refreshBoardMediaProgress(next);
    } catch { /* board list is best-effort */ }
  };
  useEffect(() => {
    void refreshBoards();
    const timer = window.setInterval(() => void refreshBoards(), 15000);
    return () => window.clearInterval(timer);
  }, [refreshBoardMediaProgress]);

  const openAddNew = async () => {
    setAddNewOpen(true);
    setAddNewLoading(true);
    setAddNewError("");
    setAddNewSourceBoard(null);
    setAddNewSourceId("");
    setAddNewTabs([]);
    setAddNewName("");
    try {
      const [projects, metas] = await Promise.all([listScenarios(), directorBoards()]);
      const eligible = projects.flatMap((project) => {
        const linked = metas
          .filter((meta) => (project.project_id != null && meta.project_id === project.project_id)
            || meta.scenarioName === project.name)
          .sort((a, b) => Date.parse(String(b.updatedAt || "")) - Date.parse(String(a.updatedAt || "")));
        const source = linked[0];
        return source ? [{
          name: project.name,
          label: project.display_name || project.name,
          boardId: source.id,
        }] : [];
      });
      setAddNewProjects(eligible);
      if (eligible.length) {
        setAddNewSourceId(eligible[0].name);
        setAddNewName(`${eligible[0].label} — New Story`);
        const source = await directorBoard(eligible[0].boardId);
        setAddNewSourceBoard(source);
        setAddNewTabs(processedDirectorImports(source));
      }
    } catch (e) {
      setAddNewError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddNewLoading(false);
    }
  };

  const selectAddNewProject = async (name: string) => {
    const option = addNewProjects.find((project) => project.name === name);
    setAddNewSourceId(name);
    setAddNewSourceBoard(null);
    setAddNewTabs([]);
    setAddNewName(option ? `${option.label} — New Story` : "");
    if (!option) return;
    setAddNewLoading(true);
    setAddNewError("");
    try {
      const source = await directorBoard(option.boardId);
      setAddNewSourceBoard(source);
      setAddNewTabs(processedDirectorImports(source));
    } catch (e) {
      setAddNewError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddNewLoading(false);
    }
  };

  const createFromImportedTabs = async () => {
    const option = addNewProjects.find((project) => project.name === addNewSourceId);
    if (!option || !addNewName.trim() || !addNewTabs.length || addNewSaving) return;
    setAddNewSaving(true);
    setAddNewError("");
    try {
      const created = await directorDuplicateBoard(option.boardId, {
        title: addNewName.trim(),
        imports: addNewTabs,
      });
      setAddNewOpen(false);
      await refreshBoards();
      await openBoard(created.id);
    } catch (e) {
      setAddNewError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddNewSaving(false);
    }
  };

  // Build the Master Prompt from the selected Analyzer + Visual Style + Additional Director Instructions
  const buildMasterPrompt = (analyzer: AnalyzerType, style: string, styleCustomVal: string, additionalInstructions: string) => {
    const a = ANALYZER_TYPES[analyzer];
    const stylePreset = style === "Custom" ? (styleCustomVal.trim() || "Custom style — describe the look in full.") : (STYLE_MASTER_PROMPTS[style] ?? "");
    // Sectioned analyzers (Song Director) render a full structured directive;
    // the Additional Instructions box overrides the analyzer's own default
    // bullet list when the user has typed something.
    const additional = additionalInstructions.trim()
      || ("additionalDefault" in a && a.additionalDefault ? a.additionalDefault : "")
      || "(none)";
    if ("sections" in a && a.sections) {
      // The directive's style-lock line is a full sentence (ends with a
      // period); the shared presets are comma lists, so normalize here.
      const styleLock = /[.!?]$/.test(stylePreset) ? stylePreset : `${stylePreset}.`;
      const lines: string[] = [
        `ROLE: ${a.role}`,
        "",
        `TASK: ${a.task}`,
        "",
        "## INSTRUCTIONS",
        "",
      ];
      a.sections.forEach((sec, i) => lines.push(`### ${i + 1}. ${sec.title}`, "", sec.body, ""));
      lines.push("## VISUAL STYLE LOCK", "", styleLock, "");
      lines.push("Apply this style consistently to all scenes while preserving the registered identity of each character, location, and object.", "");
      lines.push("## ADDITIONAL DIRECTOR INSTRUCTIONS", "", additional, "");
      if ("objective" in a && a.objective) lines.push("FINAL DIRECTOR OBJECTIVE:", "", a.objective);
      return lines.join("\n");
    }
    const lines = [
      `ROLE: ${a.role}`,
      `TASK: ${a.task}`,
      "INSTRUCTIONS:",
      ...a.instructions.map((inst, i) => `${i + 1}. ${inst}`),
      "",
      "VISUAL STYLE LOCK:",
      stylePreset,
      "",
      "ADDITIONAL DIRECTOR INSTRUCTIONS:",
      additional
    ];
    return lines.join("\n");
  };

  // Update Master Prompt when Analyzer type changes
  useEffect(() => {
    setMasterPrompt(buildMasterPrompt(analyzerType, visualStyle, styleCustom, instructions));
  }, [analyzerType]);

  // Update Master Prompt when Visual Style changes (append/replace style lock at the end)
  useEffect(() => {
    const newPrompt = buildMasterPrompt(analyzerType, visualStyle, styleCustom, instructions);
    setMasterPrompt(newPrompt);
  }, [visualStyle, styleCustom]);

  // Update Master Prompt when Additional Director Instructions change
  useEffect(() => {
    const newPrompt = buildMasterPrompt(analyzerType, visualStyle, styleCustom, instructions);
    setMasterPrompt(newPrompt);
  }, [instructions]);

  // AI/ComfyUI failures pop the centered alert dialog — inline text under
  // the header is too easy to miss mid-flow. A down LLM/ComfyUI API gets its
  // dedicated offline alert window ("LLM API offline" / "ComfyUI API
  // offline"); other service errors keep the generic failure alert.
  // The message is ALSO kept inline so it survives after dismissing.
  const alertIfLlm = (msg: string) => {
    void alertServiceError(msg, dialog, "AI Director request");
  };
  const reportError = (e: unknown, suffix = "") => {
    const msg = `${e instanceof Error ? e.message : String(e)}${suffix}`;
    setError(msg);
    alertIfLlm(msg);
  };

  const openBoard = async (id: string) => {
    onSelectedBoardChange?.(id);
    setActiveDirectorTab("scenes");
    setError("");
    setStoppedNote(null);
    // Reset the .wav / 19-track panel — reloaded from the server below when
    // the board already carries an uploaded audio.
    setAudioUploaded(false); setAudioDuration(0); setAudioMeta(null);
    setMasterTimeline(null);
    setSelectedSceneNumbers(new Set());
    setAudioAnalysisStatus("pending"); setTimelineEventsCount(EMPTY_TRACK_COUNTS);
    setTimelineValidation({ valid: true, warnings: [] });
    setTimelineApproval("pending"); setTimelineVersion(0);
    setDirectorConsumption("idle"); setDirectorBusy("load");
    setAssetProduction(null); setAssetBusy(false);
    try {
      const b = await directorBoard(id);
      setBoard(b);
      void loadAssetProduction(id);
      // Surface a server-side batch note (e.g. salvaged partial batch).
      if (b.error && b.scenes.length < b.sceneCount) setStoppedNote(b.error);
      // If this board already has an uploaded .wav, surface it + its derived
      // 19-track timeline (best-effort — a missing timeline just stays pending).
      try {
        const input = (b.input || {}) as {
          whisperxAudio?: { durationSeconds?: number; file?: string; fileName?: string };
          sourceAudio?: { durationSeconds?: number; file?: string; fileName?: string };
        };
        const audio = input.whisperxAudio || input.sourceAudio;
        if (audio?.file) {
          setAudioUploaded(true);
          setAudioDuration(Number(audio.durationSeconds) || 0);
          setAudioMeta({ file: String(audio.file), fileName: String(audio.fileName || "audio.wav") });
          setTimelineVersion(1);
        }
        try {
          const mt = await directorMasterTimeline(b.id);
          setMasterTimeline(mt);
          if (mt.master || (mt.timeline?.lines?.length || 0) > 0) {
            setTimelineEventsCount(deriveTrackCounts(mt));
            const v = mt.validation;
            setTimelineValidation({ valid: (v?.ok ?? true) && (v?.errors?.length || 0) === 0, warnings: [...(v?.warnings || []), ...(v?.errors || [])] });
            setTimelineApproval(mt.master?.approved ? "approved" : "pending");
            setAudioAnalysisStatus(mt.master ? "validated" : "generated");
            if (mt.master?.approved) setDirectorConsumption("consumed");
          }
        } catch { /* timeline stays pending until analyzed */ }
      } catch { /* audio panel stays in the empty state */ }
      setSelectedScene(0);
      setEditingScene(null);
      setSceneModal(null);
    }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  useEffect(() => {
    if (requestedBoard?.id) void openBoard(requestedBoard.id);
    // The nonce intentionally retriggers when the same board is selected again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedBoard?.nonce]);


  // ----- Audio Intelligence handlers (Part 5 & 6): real backend flow -----
  // .wav upload → POST audio-upload → POST whisperx/analyze → poll job →
  // GET master-timeline (the derived 19-track timeline). No mocks.

  // Re-read the derived master timeline into the panel (counts + validation).
  // Returns true when a master timeline exists.
  const refreshTimelineFromServer = useCallback(async (): Promise<boolean> => {
    if (!board) return false;
    const mt = await directorMasterTimeline(board.id);
    setMasterTimeline(mt);
    setTimelineEventsCount(deriveTrackCounts(mt));
    const v = mt.validation;
    const warnings = [...(v?.warnings || []), ...(v?.errors || [])];
    setTimelineValidation({ valid: (v?.ok ?? true) && (v?.errors?.length || 0) === 0, warnings });
    setTimelineApproval(mt.master?.approved ? "approved" : "pending");
    setAudioAnalysisStatus("validated");
    return !!mt.master;
  }, [board]);

  const handleAudioUpload = useCallback(async (audioFile: File) => {
    if (!board) { setError("Open a Director board first, then upload the .wav."); return; }
    const name = audioFile.name || "audio.wav";
    const mime = audioFile.type || "";
    const mimeOk = /audio\/(wav|x-wav|mpeg|mp3|mp4|x-m4a|aiff|x-aiff|ogg|opus|webm)/i.test(mime);
    const extOk = /\.(wav|mp3|m4a|aac|ogg|opus|webm|aif|aiff)$/i.test(name);
    if (!mimeOk && !extOk) {
      setError(`Unsupported audio type — upload a .wav (mp3/m4a also work). Got: ${mime || name}`);
      return;
    }
    setError("");
    setAudioUploaded(false);
    setAudioMeta(null);
    setMasterTimeline(null);
    setAudioAnalysisStatus("generated");
    setTimelineVersion(0);
    setTimelineApproval("pending");
    setTimelineValidation({ valid: true, warnings: [] });
    setDirectorConsumption("consuming");
    setAudioBusy(true);
    setAudioProgressPct(0);
    try {
      // 1. Upload the .wav (server validates RIFF/WAVE + measures duration)
      const dataUrl = await fileToDataUrl(audioFile, setAudioProgressPct);
      const up = await uploadLyricAudio(board.id, dataUrl, name);
      setAudioProgressPct(30);
      setAudioUploaded(true);
      setAudioDuration(up.durationSeconds);
      setAudioMeta({ file: up.file, fileName: up.fileName });
      setTimelineVersion(1);
      // 2. Start WhisperX analysis (board language pin rides along when set)
      const lang = (board.input as unknown as { semanticsLanguage?: string } | null | undefined)?.semanticsLanguage;
      const started = await startWhisperXAnalysis(board.id, lang && lang !== "auto" ? { language: lang } : {});
      // 3. Wait for transcription + alignment + master-timeline derivation
      await waitForWhisperXJob(board.id, started.jobId, setAudioProgressPct);
      try { setBoard(await directorBoard(board.id)); } catch { /* keep current board */ }
      // 4. Read the REAL derived 19-track timeline into the panel
      const hasMaster = await refreshTimelineFromServer();
      if (!hasMaster) throw new Error("analysis finished but no master timeline was derived — check the server log");
      setAudioProgressPct(100);
      setDirectorConsumption("consumed");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setTimelineValidation({ valid: false, warnings: [msg] });
      setTimelineApproval("revision_required");
      setAudioAnalysisStatus("failed");
    } finally {
      setAudioBusy(false);
    }
  }, [board, refreshTimelineFromServer]);

  const handleAnalyzeTimeline = useCallback(async () => {
    if (!board) { setError("Open a Director board first."); return; }
    if (!audioUploaded) { setError("Upload the .wav first — the 19-track timeline is built from it."); return; }
    if (timelineApproval === "approved") return; // already approved
    setError("");
    setAudioBusy(true);
    setAudioProgressPct(0);
    try {
      // If nothing was derived yet (e.g. after a re-upload), run analysis now.
      const mt = await directorMasterTimeline(board.id);
      if (!mt.master) {
        const started = await startWhisperXAnalysis(board.id, {});
        await waitForWhisperXJob(board.id, started.jobId, setAudioProgressPct);
      }
      const hasMaster = await refreshTimelineFromServer();
      if (!hasMaster) throw new Error("Analysis completed but no master timeline was returned.");
      setAudioProgressPct(100);
      setDirectorConsumption("consumed");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setTimelineValidation({ valid: false, warnings: [msg] });
      setTimelineApproval("revision_required");
      setAudioAnalysisStatus("failed");
    } finally {
      setAudioBusy(false);
    }
  }, [board, audioUploaded, timelineApproval, refreshTimelineFromServer]);

  const handleSendToDirector = useCallback(async () => {
    if (!board) { setError("Open a Director board first."); return; }
    if (!audioUploaded) { setError("Upload the .wav first — the 19-track timeline is built from it."); return; }
    setDirectorBusy("model");
    setError("");
    try {
      // The APPROVED master timeline drives timing: approve server-side first
      // (the server snaps scene/shot windows onto the approved segments).
      // Scene planning then reads those approved windows automatically.
      let mt = await directorMasterTimeline(board.id);
      if (!mt.master) throw new Error("No master timeline yet — run Analyze Audio & Build 19-Track Timeline first.");
      if (!mt.master.approved) {
        const ap = await approveMasterTimeline(board.id);
        mt = { ...mt, master: ap.master };
      }
      setTimelineApproval("approved");
      const master = mt.master;
      if (!master) throw new Error("No master timeline yet — run Analyze Audio & Build 19-Track Timeline first.");
      // Counts + validation come from the freshly approved server response —
      // the server is the timing authority (it snaps scene/shot windows onto
      // these approved segments on the approve route).
      setTimelineEventsCount(deriveTrackCounts(mt));
      setMasterTimeline(mt);
      setDirectorBusy("planning");
      setDirectorConsumption("planning");
      try { setBoard(await directorBoard(board.id)); } catch { /* keep current board */ }
      try { await refreshTimelineFromServer(); } catch { /* counts already set */ }
      setDirectorBusy("consumed");
      setDirectorConsumption("consumed");
      setError("Timeline sent to AI Director successfully — cinematic planning ready.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setDirectorBusy("load");
    }
  }, [board, audioUploaded, refreshTimelineFromServer]);

  const doAnalyze = async (promptOverride?: string) => {
    if (busy) return;
    const input: DirectorInput = {
      title: title.trim(),
      story: story.trim(),
      analyzerType, masterPrompt: masterPrompt.trim(),
      language, genre,
      // The source language for the meaning analysis (auto | hi | en | hinglish).
      semanticsLanguage,
      genreCustom: genre === "Custom" ? genreCustom.trim() : "",
      visualStyle, styleCustom: visualStyle === "Custom" ? styleCustom.trim() : "",
      targetSeconds, sceneSeconds, aspectRatio, instructions: instructions.trim(),
      includeDialogue, chainContinuity,
    };
    if (!input.title) {
      setError("Give the story a title.");
      return;
    }
    if (input.story.length < 20) {
      setError("Give the story a title and paste the full story (20+ characters).");
      return;
    }
    setBusy({ label: "Analyzing story — characters, locations, beats…", since: Date.now() });
    setError("");
    setPlanPhase({ kind: "analyze", startedAt: Date.now(), title: title.trim(), total: plannedScenes });
    try {
      // Request id for the live response stream (textarea below the form).
      const liveId = `dir-live-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      analyzeLiveIdRef.current = liveId;
      const b = await directorAnalyze(input, promptOverride?.trim() ? promptOverride : undefined, liveId);
      setBoard(b);
      setActiveDirectorTab("scenes");
      setSelectedScene(0);
      setSelectedSceneNumbers(new Set());
      setAssetProduction(null);
      void loadAssetProduction(b.id);
      await refreshBoards();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(null);
      setPlanPhase(null);
    }
  };

  // ----- Generate Assets stage -------------------------------------------
  const loadAssetProduction = useCallback(async (id: string) => {
    try {
      const a = await directorAssets(id);
      setAssetProduction(a.production ?? null);
    } catch { /* best effort — the stage simply stays unloaded */ }
  }, []);

  const doGenerateAssets = async (ids?: string[]) => {
    if (!board || assetBusy || busy) return;
    setAssetBusy(true);
    setError("");
    try {
      const r = await directorGenerateAssets(board.id, ids?.length ? { ids } : {});
      setAssetProduction(r.production);
      if (r.no_prompt?.length) {
        reportError(new Error(`No generation prompt saved for: ${r.no_prompt.join(", ")}. Open that asset and set one.`));
      }
    } catch (e) { reportError(e); }
    finally { setAssetBusy(false); }
  };
  const doApproveAssets = async (ids?: string[]) => {
    if (!board || assetBusy || busy) return;
    setAssetBusy(true);
    setError("");
    try {
      const r = await directorApproveAssets(board.id, ids);
      setAssetProduction(r.production);
    } catch (e) { reportError(e); }
    finally { setAssetBusy(false); }
  };
  const doSkipAssets = async () => {
    if (!board || assetBusy || busy) return;
    setAssetBusy(true);
    try {
      const r = await directorSkipAssets(board.id);
      setAssetProduction(r.production);
    } catch (e) { reportError(e); }
    finally { setAssetBusy(false); }
  };
  const doRegenerateAsset = async (assetId: string, prompt: string) => {
    if (!board || assetBusy || busy) return;
    setAssetBusy(true);
    try {
      const r = await directorRegenerateAsset(board.id, assetId, prompt);
      setAssetProduction(r.production);
    } catch (e) { reportError(e); }
    finally { setAssetBusy(false); }
  };

  const doUploadAsset = async (assetId: string, data: string) => {
    if (!board || assetUploading || busy) return;
    setAssetUploading(assetId);
    try {
      const uploaded = await directorUploadAsset(board.id, assetId, data);
      setAssetProduction(uploaded.production as DirectorAssetProduction);
      // Reload so directorAssetWithVersions populates image_versions with
      // human-readable reference ids (e.g. SHIV_01, SHIV_02).
      await loadAssetProduction(board.id);
      setSelectedAssetVersions((cur) => ({ ...cur, [`${board.id}:${assetId}`]: uploaded.version }));
    } catch (e) { reportError(e); }
    finally { setAssetUploading(null); }
  };

  const handleAssetFileChange = (assetId: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) { reportError(new Error("Please select an image file (PNG, JPEG, WebP).")); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result);
      if (!data.startsWith("data:")) return;
      void doUploadAsset(assetId, data);
    };
    reader.onerror = () => reportError(new Error("Failed to read the selected image."));
    reader.readAsDataURL(file);
    // Reset so the same file can be re-selected next time.
    e.target.value = "";
  };

  // Poll only while a render is actually in flight — never while idle.
  const assetJobsActive = Boolean(assetProduction?.jobs?.some(
    (j) => j.status === "PENDING" || j.status === "PROCESSING",
  ));
  useEffect(() => {
    if (!board?.id || !assetJobsActive) return;
    const timer = window.setInterval(() => { void loadAssetProduction(board.id); }, 3000);
    return () => window.clearInterval(timer);
  }, [board?.id, assetJobsActive, loadAssetProduction]);

  // Show Prompt popup (pre-directing): fetches the EXACT user prompt the
  // Generate Storyboard (bible) call will send — no model call — and lets the
  // user edit it. Generating from the popup sends the edited text verbatim
  // (promptOverride); the system prompt + every downstream stage are unchanged.
  const [biblePromptOpen, setBiblePromptOpen] = useState(false);
  const [biblePromptDraft, setBiblePromptDraft] = useState("");
  const [biblePromptLoading, setBiblePromptLoading] = useState(false);
  const [biblePromptEdited, setBiblePromptEdited] = useState(false);
  const openBiblePrompt = async () => {
    if (biblePromptLoading || busy) return;
    if (!title.trim() || story.trim().length < 20) {
      setError("Give the story a title and paste the full story (20+ characters) to preview its prompt.");
      return;
    }
    setError("");
    setBiblePromptLoading(true);
    try {
      const r = await directorBiblePreview({
        title: title.trim(),
        story: story.trim(),
        language, genre,
        semanticsLanguage,
        genreCustom: genre === "Custom" ? genreCustom.trim() : "",
        visualStyle, styleCustom: visualStyle === "Custom" ? styleCustom.trim() : "",
        masterPrompt: masterPrompt.trim(),
        targetSeconds, sceneSeconds, aspectRatio, instructions: instructions.trim(),
        includeDialogue, chainContinuity,
      });
      setBiblePromptDraft(r.prompt);
      setBiblePromptEdited(false);
      setBiblePromptOptimized(null);
      setBiblePromptTokens(null);
      setBiblePromptOptimizeError("");
      setBiblePromptOpen(true);
    } catch (e) {
      reportError(e);
    } finally {
      setBiblePromptLoading(false);
    }
  };

  // ✨ Optimize Prompt (Show Prompt popup): the LLM rewrites the current
  // draft for clarity/impact — every constraint kept. The optimized prompt is
  // shown WITH its token count next to the main (original) prompt with its
  // own count; nothing is applied until the user presses Use optimized.
  const [biblePromptOptimizing, setBiblePromptOptimizing] = useState(false);
  const [biblePromptOptimized, setBiblePromptOptimized] = useState<string | null>(null);
  const [biblePromptMain, setBiblePromptMain] = useState("");
  const [biblePromptTokens, setBiblePromptTokens] = useState<{ original: number; optimized: number } | null>(null);
  const [biblePromptOptimizeError, setBiblePromptOptimizeError] = useState("");
  const optimizeBiblePrompt = async () => {
    if (biblePromptOptimizing) return;
    const text = biblePromptDraft.trim();
    if (!text) return;
    setBiblePromptOptimizing(true);
    setBiblePromptOptimizeError("");
    try {
      const r = await directorOptimizePrompt(text, title.trim() || undefined);
      setBiblePromptOptimized(r.optimized);
      setBiblePromptMain(text);
      setBiblePromptTokens(r.tokens ?? null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setBiblePromptOptimizeError(msg);
      alertIfLlm(msg);
    } finally {
      setBiblePromptOptimizing(false);
    }
  };
  const useOptimizedBiblePrompt = () => {
    if (biblePromptOptimized == null) return;
    setBiblePromptDraft(biblePromptOptimized);
    setBiblePromptEdited(true);
    setBiblePromptOptimized(null);
    setBiblePromptTokens(null);
  };

  // Show prompt (dry run): the exact system + user messages the next
  // Continue would send to the LLM — fetched without calling the model,
  // nothing planned or saved. Read-only, so it works even mid-planning.
  const [promptPreview, setPromptPreview] = useState<DirectorPromptPreview | null>(null);
  const [promptLoading, setPromptLoading] = useState(false);
  const onShowPrompt = async () => {
    if (!board || promptLoading) return;
    setPromptLoading(true);
    try {
      setPromptPreview(await directorPromptPreview(board.id, sceneBatch));
    } catch (e) {
      reportError(e, "");
    } finally {
      setPromptLoading(false);
    }
  };

  // Generate scenes in batches until the plan is complete. Resumable: the
  // server appends from scenes.length, so Stop / retry continues from the
  // next scene, never restarts (e.g. Stop during 61–72 resumes at 73).
  const doScenes = async () => {
    if (!board || busy) return;
    cancelRef.current = false;
    setBusy({ label: "Planning scenes…", since: Date.now() });
    setError("");
    setStoppedNote(null);
    // Fresh board (or finished plan) restarts the live pace; Stop/resume on
    // the same board keeps accumulating so the countdown doesn't go cold.
    const stats = planStatsRef.current;
    if (!stats || stats.boardId !== board.id) {
      planStatsRef.current = { boardId: board.id, sceneMs: 0, scenes: 0 };
    }
    setPlanPhase({ kind: "scenes", startedAt: Date.now(), title: board.input.title, total: directorSceneCap(board) });
    try {
      // Reload the freshest board first so a resume after Stop never re-plans
      // scenes the server already saved while we were away.
      let b = await directorBoard(board.id).catch(() => board);
      if (!b.sceneCount && !b.scenes.length) b = { ...b, sceneCount: directorSceneCap(b) };
      setBoard(b);
      // Recovery pass: an early-finalized board (scenes == sceneCount but the
      // timeline still owes seconds) gets one forced server call, which
      // reopens it by extending the cap — the normal loop then paces the rest.
      const bTarget = Number(b.input.song?.durationSeconds ?? b.input.targetSeconds);
      const bTol = Math.max(1, (Number(b.input.sceneSeconds) || 3) / 2);
      let forceOne = Number.isFinite(bTarget) && bTarget > 0 &&
        b.scenes.length >= b.sceneCount &&
        (bTarget - boardPlannedSeconds(b.scenes)) > bTol;
      while (b.scenes.length < b.sceneCount || forceOne) {
        forceOne = false;
        if (cancelRef.current) break;
        // Shot-aware progress: shots ARE scenes at generation time (one clip
        // per shot), so the total tracks projected beats, not just scene rows.
        const beatsDone = boardBeats(b.scenes);
        const beatsTotal = boardBeatsTotal(b.scenes, b.sceneCount);
        const batchEnd = Math.min(b.sceneCount, b.scenes.length + sceneBatch);
        setSceneProgress(`Scene ${b.scenes.length + 1}–${batchEnd} of ${b.sceneCount} · 🎞 ${beatsDone}/${beatsTotal} shots`);
        setGeneratingRange({ from: b.scenes.length + 1, to: batchEnd });
        const ctl = new AbortController();
        abortRef.current = ctl;
        const prevLen = b.scenes.length;
        const batchStart = Date.now();
        batchStartRef.current = batchStart;
        try {
          b = await directorScenes(b.id, sceneBatch, ctl.signal);
        } catch (e) {
          // Stop pressed mid-batch: the server may still save that batch —
          // reload and report exactly where the resume continues from.
          if (ctl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) {
            try { b = await directorBoard(board.id); } catch { /* keep last */ }
            setBoard(b);
            break;
          }
          throw e;
        } finally {
          abortRef.current = null;
          batchStartRef.current = null;
        }
        // One landed batch = one pace sample (per-scene), feeding both the
        // live countdown below and the persisted pace for the next plan.
        const landed = b.scenes.length - prevLen;
        if (landed > 0) {
          const perScene = (Date.now() - batchStart) / landed;
          const st = planStatsRef.current;
          if (st && st.boardId === b.id) {
            st.sceneMs += perScene * landed;
            st.scenes += landed;
          }
          recordDirectorPaceDuration(perScene);
        }
        setBoard(b);
      }
      const endTarget = Number(b.input.song?.durationSeconds ?? b.input.targetSeconds);
      const endOpen = Number.isFinite(endTarget) && endTarget > 0 &&
        (endTarget - boardPlannedSeconds(b.scenes)) > Math.max(1, (Number(b.input.sceneSeconds) || 3) / 2);
      if (cancelRef.current && (b.scenes.length < b.sceneCount || endOpen)) {
        setStoppedNote(endOpen && b.scenes.length >= b.sceneCount
          ? `Stopped at ~${boardPlannedSeconds(b.scenes)}s of ~${Math.round(endTarget)}s (🎞 ${boardBeats(b.scenes)} shots) — press Continue planning to resume the timeline.`
          : `Stopped after scene ${b.scenes.length} of ${b.sceneCount} (🎞 ${boardBeats(b.scenes)}/${boardBeatsTotal(b.scenes, b.sceneCount)} shots) — press Continue to resume from scene ${b.scenes.length + 1}.`);
      } else if (b.error && b.scenes.length < b.sceneCount) {
        // Server-side batch note (e.g. salvaged partial batch) — shown in
        // the existing notice line so cut-off output still binds visibly.
        setStoppedNote(b.error);
      }
      setSelectedScene((sel) => (sel == null && b.scenes.length ? 0 : sel));
      await refreshBoards();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 409 = another batch is already planning this board (double-click or a
      // second tab) — it was rejected server-side, so nothing was duplicated.
      // Reload and point at the true resume position instead of erroring.
      if (/already running/i.test(msg)) {
        try {
          const fresh = await directorBoard(board.id);
          setBoard(fresh);
          setStoppedNote(`Planning is already running for this board — wait a moment, then Continue from scene ${fresh.scenes.length + 1} of ${fresh.sceneCount} (🎞 ${boardBeats(fresh.scenes)}/${boardBeatsTotal(fresh.scenes, fresh.sceneCount)} shots). No duplicates were saved.`);
        } catch { /* keep sick */ }
      } else {
        reportError(e, " — partial scenes are kept, retry continues.");
        try { setBoard(await directorBoard(board.id)); } catch { /* keep sick */ }
      }
    } finally {
      setBusy(null);
      setSceneProgress("");
      setGeneratingRange(null);
      batchStartRef.current = null;
      setPlanPhase(null);
      abortRef.current = null;
    }
  };

  const doRegenScene = async (index: number) => {
    if (!board || regenScene != null) return;
    setRegenScene(index);
    setError("");
    try {
      const b = await directorRegenScene(board.id, index);
      setBoard(b);
      // Replay the rewritten scene with live typing, like a fresh batch.
      const num = b.scenes[index]?.scene_number ?? board.scenes[index]?.scene_number;
      if (num != null && !reduceMotion) {
        const seen = seenSceneNumsRef.current;
        if (seen && seen.boardId === b.id) seen.nums.delete(num);
        else seenSceneNumsRef.current = {
          boardId: b.id, nums: new Set(b.scenes.map((s) => s.scene_number).filter((n) => n !== num)),
        };
        setTypingScenes((cur) => (cur.includes(num) ? cur : [...cur, num]));
      }
    } catch (e) {
      reportError(e);
    } finally {
      setRegenScene(null);
    }
  };

  // Show the prompt the AI would use for planning this specific scene.
  const showScenePrompt = async (index: number) => {
    if (!board || busy) return;
    setPromptLoading(true);
    try {
      const sceneNum = board.scenes[index]?.scene_number ?? index + 1;
      // Show prompt for 1 scene starting from this scene's position
      setPromptPreview(await directorPromptPreview(board.id, 1));
    } catch (e) {
      reportError(e, "");
    } finally {
      setPromptLoading(false);
    }
  };

  const doDeleteScene = async (index: number) => {
    if (!board) return;
    if (sceneModal) setSceneModal(null);
    const s = board.scenes[index];
    const ok = await dialog.confirm("The plan renumbers after deletion.", {
      title: `Delete Scene ${s.scene_number} (${s.title})?`,
      tone: "error", okText: "Delete", cancelText: "Keep",
    });
    if (!ok) return;
    try {
      const b = await directorUpdateBoard(board.id, { scenes: board.scenes.filter((_, i) => i !== index) });
      setBoard(b);
      setSelectedSceneNumbers(new Set());
      setSelectedScene((sel) => (sel == null ? sel : Math.min(sel, Math.max(0, b.scenes.length - 1))));
      setEditingScene(null);
      await refreshBoards();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const doDeleteSelectedScenes = async () => {
    if (!board || busy || !selectedSceneNumbers.size) return;
    const selected = new Set(selectedSceneNumbers);
    const doomed = board.scenes.filter((scene) => selected.has(scene.scene_number));
    if (!doomed.length) { setSelectedSceneNumbers(new Set()); return; }
    const ok = await dialog.confirm(
      `Deletes ${doomed.length} selected scene${doomed.length === 1 ? "" : "s"}. Remaining scenes will be renumbered.`,
      { title: `Delete ${doomed.length} selected scene${doomed.length === 1 ? "" : "s"}?`, tone: "error", okText: "Delete scenes", cancelText: "Keep scenes" }
    );
    if (!ok) return;
    try {
      const b = await directorUpdateBoard(board.id, { scenes: board.scenes.filter((scene) => !selected.has(scene.scene_number)) });
      setBoard(b);
      setSelectedSceneNumbers(new Set());
      setSelectedScene((current) => current == null ? current : Math.min(current, Math.max(0, b.scenes.length - 1)));
      setEditingScene(null);
      setSceneModal(null);
      await refreshBoards();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // AI append: the server re-reads the story/lyrics + master settings +
  // the already-generated bible, appends exactly one new entry, and refreshes
  // the story beats to fold the new entry in (existing beats stay stable).
  const doAddEntry = async (kind: DirectorEntryKind) => {
    if (!board || addingEntry || busy) return;
    setAddingEntry(kind);
    setError("");
    try {
      const b = await directorAddEntry(board.id, kind);
      setBoard(b);
      void loadAssetProduction(board.id);
      await refreshBoards();
    } catch (e) {
      reportError(e);
    } finally {
      setAddingEntry(null);
    }
  };

  // AI rewrite: the server re-reads the story/lyrics + master settings +
  // the full bible and swaps in a richer rewrite of the selected entry.
  // The id is pinned server-side so scene references keep working.
  const doRegenEntry = async (kind: DirectorEntryKind, index: number) => {
    if (!board || regenEntry || addingEntry || busy) return;
    setRegenEntry({ kind, index });
    setError("");
    try {
      const b = await directorRegenEntry(board.id, kind, index);
      setBoard(b);
      void loadAssetProduction(board.id);
      await refreshBoards();
    } catch (e) {
      reportError(e);
    } finally {
      setRegenEntry(null);
    }
  };

  const doDeleteChar = async (index: number) => {
    if (!board?.blueprint) return;
    const list = (board.blueprint.characters ?? []) as Record<string, unknown>[];
    const c = list[index] as Record<string, unknown> | undefined;
    const ok = await dialog.confirm("Scenes that reference this character keep its name as plain text — update them or regenerate before approving.", {
      title: `Delete character "${str(c?.name) || `Character ${index + 1}`}"?`,
      tone: "error", okText: "Delete", cancelText: "Keep",
    });
    if (!ok) return;
    try {
      const b = await directorUpdateBoard(board.id, { characters: list.filter((_, i) => i !== index) });
      setBoard(b);
      void loadAssetProduction(board.id);
      setEditingChar(null);
      await refreshBoards();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const doDeleteLoc = async (index: number) => {
    if (!board?.blueprint) return;
    const list = (board.blueprint.locations ?? []) as Record<string, unknown>[];
    const l = list[index] as Record<string, unknown> | undefined;
    const ok = await dialog.confirm("Scenes set in this location keep its name as plain text — update them before approving.", {
      title: `Delete location "${str(l?.name) || `Location ${index + 1}`}"?`,
      tone: "error", okText: "Delete", cancelText: "Keep",
    });
    if (!ok) return;
    try {
      const b = await directorUpdateBoard(board.id, { locations: list.filter((_, i) => i !== index) });
      setBoard(b);
      void loadAssetProduction(board.id);
      await refreshBoards();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const doDeleteObj = async (index: number) => {
    if (!board?.blueprint) return;
    const list = (board.blueprint.objects ?? []) as Record<string, unknown>[];
    const o = list[index] as Record<string, unknown> | undefined;
    const ok = await dialog.confirm("Scenes showing this object keep its name as plain text — update them before approving.", {
      title: `Delete object "${str(o?.name) || `Object ${index + 1}`}"?`,
      tone: "error", okText: "Delete", cancelText: "Keep",
    });
    if (!ok) return;
    try {
      const b = await directorUpdateBoard(board.id, { objects: list.filter((_, i) => i !== index) });
      setBoard(b);
      void loadAssetProduction(board.id);
      await refreshBoards();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Per-shot dialogue drafts for the scene edit popup (keyed by shot index).
  const [shotDlgDrafts, setShotDlgDrafts] = useState<Record<number, string>>({});
  const startEditScene = (index: number) => {
    if (!board) return;
    setEditingScene(index);
    setSceneDraft({ ...board.scenes[index] });
    setDialogueDraft(formatDialogueLines(board.scenes[index].dialogue));
    const per: Record<number, string> = {};
    sceneShots(board.scenes[index]).forEach((sh, k) => { per[k] = formatDialogueLines(sh.dialogue); });
    setShotDlgDrafts(per);
  };
  const saveEditScene = async () => {
    if (!board || editingScene == null) return;
    const dlg = parseDialogueLines(dialogueDraft);
    const draftShots = Array.isArray((sceneDraft as DirectorScene).shots)
      ? (sceneDraft as DirectorScene).shots as DirectorShot[]
      : null;
    // Shot durations are authoritative when shots exist: the scene total is
    // re-derived from them so the server keeps (not repairs) the timeline.
    const shots = draftShots?.map((sh, k) => ({
      ...sh,
      dialogue: parseDialogueLines(shotDlgDrafts[k] ?? ""),
    })) ?? undefined;
    const total = shots?.length
      ? Math.round(shots.reduce((a, x) => a + (Number(x.duration_seconds) || 0), 0) * 10) / 10
      : undefined;
    const next = board.scenes.map((s, i) => (i === editingScene
      ? {
        ...s, ...sceneDraft, dialogue: dlg,
        ...(shots ? { shots, duration_seconds: total } : {}),
      }
      : s));
    try {
      const b = await directorUpdateBoard(board.id, { scenes: next });
      setBoard(b);
      setEditingScene(null);
      setSceneModal(null);
      setShotDlgDrafts({});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  // Close the scene popup (discards an unsaved edit).
  const closeSceneModal = () => {
    setSceneModal(null);
    setEditingScene(null);
    setShotDlgDrafts({});
  };

  const startEditChar = (index: number) => {
    const c = board?.blueprint?.characters?.[index] as Record<string, unknown> | undefined;
    if (!c) return;
    setEditingChar(index);
    setCharDraft({ name: str(c.name), role: str(c.role), visual_identity_prompt: str(c.visual_identity_prompt) });
    setRuleDraft(charRules(c));
    setNewRule("");
  };
  const saveEditChar = async () => {
    if (!board?.blueprint || editingChar == null || savingChar) return;
    setSavingChar(true);
    const next = board.blueprint.characters.map((c, i) =>
      i === editingChar
        ? { ...(c as object), ...charDraft, consistency_rules: ruleDraft.map((r) => r.trim()).filter(Boolean) }
        : c);
    try {
      const b = await directorUpdateBoard(board.id, { characters: next });
      setBoard(b);
      void loadAssetProduction(board.id);
      setEditingChar(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingChar(false);
    }
  };
  // Lock background scroll while the popup is open. Popups close only
  // via their Cancel / close buttons — no backdrop-click or Escape dismiss.
  useEffect(() => {
    if (editingChar == null) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [editingChar]);
  // Same lock for the scene Details/Edit popup.
  useEffect(() => {
    if (sceneModal == null) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [sceneModal]);
  // Same lock for the directing-inputs popup.
  useEffect(() => {
    if (inputBoard == null) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [inputBoard]);
  // Keep the asset prompt editor consistent with the other in-app dialogs.
  useEffect(() => {
    if (assetPromptEditor == null) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [assetPromptEditor]);

  const doRenameBoard = async () => {
    if (!board || !titleDraft.trim()) return;
    try {
      const b = await directorUpdateBoard(board.id, { input: { title: titleDraft.trim() } });
      setBoard(b);
      setEditingTitle(false);
      await refreshBoards();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // 📝 Directing inputs popup: snapshot a board's saved master inputs into the
  // draft (view mode). Edit flips the fields editable; Save persists via PUT.
  const openInputs = (b: DirectorBoard) => {
    setInputBoard(b);
    setInputEditing(false);
    setInputDraft({
      title: str(b.input.title),
      story: str(b.input.story),
      language: str(b.input.language) || "English",
      genre: str(b.input.genre) || "Adventure",
      genreCustom: str(b.input.genreCustom),
      visualStyle: str(b.input.visualStyle) || "3D Cinematic",
      styleCustom: str(b.input.styleCustom),
      // Legacy boards predate the Master Prompt — show the style's preset so
      // the box reflects the lock the server actually derives.
      masterPrompt: str(b.input.masterPrompt) || STYLE_MASTER_PROMPTS[str(b.input.visualStyle)] || "",
      targetSeconds: Math.max(15, Math.round(Number(b.input.targetSeconds) || 60)),
      sceneSeconds: Math.min(30, Math.max(1, Math.round(Number(b.input.sceneSeconds) || 3))),
      aspectRatio: str(b.input.aspectRatio) || "16:9",
      instructions: str(b.input.instructions),
      includeDialogue: b.input.includeDialogue !== false,
      chainContinuity: b.input.chainContinuity === true,
    });
  };
  // Saved-card icon: fetch that board's full inputs on demand (the rail meta
  // carries only title/genre chips), then show the same popup. stopPropagation
  // at the call site keeps the card itself from opening.
  const openInputsById = async (id: string) => {
    if (loadingCardInputs) return;
    // Reuse the already-open board when it matches — no fetch needed.
    if (board && board.id === id) {
      openInputs(board);
      return;
    }
    setLoadingCardInputs(id);
    try {
      openInputs(await directorBoard(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingCardInputs(null);
    }
  };
  const closeInputs = () => {
    setInputBoard(null);
    setInputEditing(false);
    setSavingInputs(false);
  };
  const saveInputs = async () => {
    if (!inputBoard || savingInputs) return;
    if (!inputDraft.title.trim()) {
      setError("Project title is required.");
      return;
    }
    if (inputDraft.story.trim().length < 3) {
      setError("Story is too short — paste the full story.");
      return;
    }
    setSavingInputs(true);
    setError("");
    try {
      const b = await directorUpdateBoard(inputBoard.id, {
        input: {
          title: inputDraft.title.trim().slice(0, 120),
          story: inputDraft.story.trim().slice(0, 10000),
          language: inputDraft.language,
          genre: inputDraft.genre,
          genreCustom: inputDraft.genreCustom.trim().slice(0, 40),
          visualStyle: inputDraft.visualStyle,
          styleCustom: inputDraft.styleCustom.trim().slice(0, 120),
          masterPrompt: inputDraft.masterPrompt.trim().slice(0, 20000),
          targetSeconds: Math.max(15, Math.min(3600, Math.round(Number(inputDraft.targetSeconds) || 60))),
          sceneSeconds: Math.min(30, Math.max(1, Math.round(Number(inputDraft.sceneSeconds) || 3))),
          aspectRatio: inputDraft.aspectRatio,
          instructions: inputDraft.instructions.trim().slice(0, 2000),
          analyzerType: inputBoard.input.analyzerType,
          includeDialogue: inputDraft.includeDialogue,
          chainContinuity: inputDraft.chainContinuity,
        },
      });
      // Turning Connected OFF scrubs handoffs server-side; turning Dialogues
      // OFF strips lines — reload so the open board shows the effect at once.
      if (board && board.id === b.id) setBoard(b);
      setInputBoard(b);
      setInputEditing(false);
      await refreshBoards();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingInputs(false);
    }
  };

  // Board-level Dialogue toggle: OFF strips every planned scene's dialogue
  // (silent film from here on — future batches plan [], approve carries no
  // voice); ON only flips future batches/the approve handoff (planned scenes
  // keep [] until regenerated, so nothing is invented behind the user's back).
  const doToggleBoardDialogue = async () => {
    if (!board || busy) return;
    const off = board.input.includeDialogue !== false;
    if (off) {
      const ok = await dialog.confirm(
        `Removes all ${board.scenes.filter((s) => (s.dialogue ?? []).length).length} planned dialogue line(s) from this board. Future scenes plan silent and Approve generates visuals only.`,
        { title: "Turn dialogues OFF (silent film)?", tone: "info", okText: "Remove dialogues", cancelText: "Keep" }
      );
      if (!ok) return;
      try {
        const b = await directorUpdateBoard(board.id, {
          input: { includeDialogue: false },
          scenes: board.scenes.map((s) => ({ ...s, dialogue: [] })),
        });
        setBoard(b);
        await refreshBoards();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } else {
      try {
        const b = await directorUpdateBoard(board.id, { input: { includeDialogue: true } });
        setBoard(b);
        await refreshBoards();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  };

  // Board-level Connected toggle: ON plans continuations (handoff text in
  // prompts); OFF scrubs handoff state from already-planned scenes so Approve
  // generates independent shots. Camera restaging of old scenes still needs a
  // per-scene Regenerate; already-generated clips need a workspace regen.
  const doToggleBoardChain = async () => {
    if (!board || busy) return;
    const next = board.input.chainContinuity !== true;
    try {
      const b = await directorUpdateBoard(board.id, next
        ? { input: { chainContinuity: true } }
        : {
          input: { chainContinuity: false },
          scenes: board.scenes.map((s) => ({ ...s, continuity_from_previous_scene: "", transition_to_next_scene: "" })),
        });
      setBoard(b);
      await refreshBoards();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };


  const doApprove = async () => {
    if (!board || busy || !board.scenes.length) return;
    const songNote = board.input.song
      ? ` The uploaded song ("${board.input.song.fileName}", ~${board.input.song.durationSeconds}s) travels with the project — after the final cut is stitched, mix it over the video from the project workspace.`
      : "";
    const dlgNote = board.input.includeDialogue === false
      ? " Dialogues are OFF — this project generates visuals only (no voice, no lip-sync)."
      : "";
    const chainNote = board.input.chainContinuity === true
      ? " Connected scenes are ON — each scene continues the previous shot's end state in its prompts (every clip still animates its own scene image)."
      : " Connected scenes are OFF — every scene generates as an independent fresh shot.";
    const beats = boardBeats(board.scenes);
    const total = boardBeatsTotal(board.scenes, directorSceneCap(board));
    const shotNote = ` Multi-shot scenes flatten to ${beats} timed clips (one image + video per shot) — shots generate as scenes.`
    const ok = await dialog.confirm(
      `Creates project "${board.input.title}" with ${board.scenes.length} scenes (${beats}/${total} shots), then opens it in the workspace for generation (images → videos → final cut).${shotNote}${songNote}${dlgNote}${chainNote}`,
      { title: `Approve storyboard for "${board.input.title}"?`, tone: "info", okText: "Approve", cancelText: "Keep editing" }
    );
    if (!ok) return;
    setBusy({ label: "Approving storyboard…", since: Date.now() });
    setError("");
    try {
      const { name, config } = await directorApprove(board.id);
      await saveScenario(name, config);
      onProjectsChanged();
      onOpenProject(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };


  // Partial migration: after Stop (or anytime while scenes are still being
  // planned), migrate the scenes planned so far into a project now; the rest
  // follow later into the SAME project via "Migrate remaining" (the server
  // reuses board.scenarioName and the generation pipeline skips assets that
  // already exist, so nothing is rebuilt).
  const doMigratePartial = async () => {
    if (!board || busy || !board.scenes.length || board.scenes.length >= board.sceneCount) return;
    const migrated = board.migratedScenes ?? (board.scenarioName ? board.scenes.length : 0);
    const fresh = Math.max(0, board.scenes.length - (board.scenarioName ? migrated : 0));
    const songNote = board.input.song
      ? ` The uploaded song ("${board.input.song.fileName}", ~${board.input.song.durationSeconds}s) travels with the project.`
      : "";
    const ok = board.scenarioName
      ? await dialog.confirm(
        `Appends ${fresh} new scene${fresh === 1 ? "" : "s"} (1–${board.scenes.length} planned so far, 🎞 ${boardBeats(board.scenes)} shots) into existing project "${board.scenarioName}" (updates its scenario). Already-generated images/videos are kept — only new scenes generate.${songNote}`,
        { title: `Migrate remaining scenes into "${board.scenarioName}"?`, tone: "info", okText: fresh ? "Migrate remaining" : "Re-migrate", cancelText: "Keep planning" }
      )
      : await dialog.confirm(
        `Migrates scenes 1–${board.scenes.length} of ${board.sceneCount} planned (🎞 ${boardBeats(board.scenes)}/${boardBeatsTotal(board.scenes, board.sceneCount)} shots) into project "${board.input.title}" now and opens it for generation (images → videos → final cut). Keep planning here — Continue plans the rest, then Migrate remaining appends them to the same project.${songNote}`,
        { title: `Migrate partial project (${board.scenes.length}/${board.sceneCount} scenes · 🎞 ${boardBeats(board.scenes)} shots)?`, tone: "info", okText: "Migrate partial", cancelText: "Keep planning" }
      );
    if (!ok) return;
    setBusy({ label: "Migrating partial project…", since: Date.now() });
    setError("");
    try {
      const { name, config } = await directorApprove(board.id);
      await saveScenario(name, config);
      onProjectsChanged();
      try { setBoard(await directorBoard(board.id)); } catch { /* navigated away */ }
      await refreshBoards();
      onOpenProject(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const doDeleteBoard = async () => {
    if (!board) return;
    const ok = await dialog.confirm("The story input and all planned scenes are removed. Generated projects are kept.", {
      title: `Delete board "${board.input.title}"?`, tone: "error", okText: "Delete", cancelText: "Keep",
    });
    if (!ok) return;
    try {
      await directorDeleteBoard(board.id);
      setBoard(null);
      await refreshBoards();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Delete one saved storyboard straight from the grid (same confirm + API
  // as the open-board delete; removes the DB row and the file together).
  const doDeleteBoardById = async (id: string, title: string) => {
    const ok = await dialog.confirm("The story input and all planned scenes are removed. Generated projects are kept.", {
      title: `Delete board "${title}"?`, tone: "error", okText: "Delete", cancelText: "Keep",
    });
    if (!ok) return;
    try {
      await directorDeleteBoard(id);
      await refreshBoards();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Duplicate the open board as a fresh version (exact copy of characters,
  // locations, objects + scenes prompts; no linked project so Approve
  // mints a new project and images/videos regenerate from scratch). The
  // server auto-versions the title (v2, then v3, …).
  const [duplicating, setDuplicating] = useState(false);
  const doDuplicateBoard = async () => {
    if (!board || duplicating || busy) return;
    const ok = await dialog.confirm(
      `Copies characters, locations, objects and all ${board.scenes.length}/${board.sceneCount} scene prompts (🎞 ${boardBeats(board.scenes)} shots) exactly into a new versioned board (v2, then v3…). The copy starts with no linked project, so approving it generates fresh images/videos. The original board and its project are untouched.`,
      { title: `Duplicate "${board.input.title}" as a new version?`, tone: "info", okText: "Duplicate", cancelText: "Cancel" }
    );
    if (!ok) return;
    setDuplicating(true);
    setError("");
    try {
      const nb = await directorDuplicateBoard(board.id);
      setBoard(nb);
      setSelectedScene(0);
      setEditingScene(null);
      setSceneModal(null);
      await refreshBoards();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDuplicating(false);
    }
  };

  // Duplicate one saved storyboard straight from the grid (same API as the
  // open-board duplicate; opens the new versioned copy on success).
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const doDuplicateBoardById = async (id: string, title: string) => {
    if (duplicatingId) return;
    const ok = await dialog.confirm(
      "Copies characters, locations, objects and scene prompts exactly into a new versioned board (v2, then v3…). The copy starts with no linked project, so approving it generates fresh images/videos.",
      { title: `Duplicate "${title}" as a new version?`, tone: "info", okText: "Duplicate", cancelText: "Cancel" }
    );
    if (!ok) return;
    setDuplicatingId(id);
    try {
      const nb = await directorDuplicateBoard(id);
      await refreshBoards();
      await openBoard(nb.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDuplicatingId(null);
    }
  };

  // Jump the viewport to the live work: the first Generating box of the
  // current batch, else the last planned scene card. The sticky header pill
  // calls this so progress is one click away on long boards.
  const scrollToLive = () => {
    const from = generatingRange?.from;
    const live = from != null ? document.getElementById(`dir-scene-pending-${from}`) : null;
    const last = document.getElementById(`dir-scene-${board?.scenes.length ?? 0}`);
    (live ?? last)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  // Auto-follow the live batch ONLY while the user is idle (same 2-minute
  // rule as the generation tiles: no auto-scroll while the user is working).
  // Each new batch brings its first Generating box into view so the active
  // work stays visible while 80+ scenes push it far below the fold. Skipped
  // while the scene popup is open (background is scroll-locked then — the
  // pill click still jumps on demand).
  const idle = useIdleFollow();
  const liveFromRef = useRef<number | null>(null);
  useEffect(() => {
    if (!generatingRange || sceneModal) return;
    if (!idle) return;
    if (liveFromRef.current === generatingRange.from) return;
    liveFromRef.current = generatingRange.from;
    const from = generatingRange.from;
    window.setTimeout(() => {
      document.getElementById(`dir-scene-pending-${from}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 120);
  }, [generatingRange, sceneModal, idle]);
  useEffect(() => { liveFromRef.current = null; }, [board?.id]);
  // Scene Details/Edit popups (scene cards stay compact with essentials
  // only; the full breakdown + edit form live in the modal).
  const openSceneDetails = (i: number) => {
    if (!board || i < 0 || i >= board.scenes.length) return;
    setSelectedScene(i);
    setSceneModal({ index: i, mode: "details", shot: null });
  };
  const openSceneEdit = (i: number) => {
    if (!board || i < 0 || i >= board.scenes.length) return;
    startEditScene(i);
    setSelectedScene(i);
    setSceneModal({ index: i, mode: "edit", shot: null });
  };
  const stepSceneModal = (dir: 1 | -1) => {
    if (!board || !sceneModal) return;
    const next = Math.min(board.scenes.length - 1, Math.max(0, sceneModal.index + dir));
    if (next === sceneModal.index) return;
    if (sceneModal.mode === "edit") startEditScene(next);
    setSelectedScene(next);
    // Keep the shot focus when the target scene has shots, else fall back.
    const shots = sceneShots(board.scenes[next]);
    const shot = sceneModal.shot == null || !shots.length
      ? null
      : Math.min(sceneModal.shot, shots.length - 1);
    setSceneModal({ index: next, mode: sceneModal.mode, shot });
  };
  // Per-shot popups (same modal shell as scenes, focused on one shot).
  const openShotDetails = (i: number, k: number) => {
    if (!board || i < 0 || i >= board.scenes.length) return;
    const shots = sceneShots(board.scenes[i]);
    if (!shots.length || k < 0 || k >= shots.length) return;
    setSelectedScene(i);
    setSceneModal({ index: i, mode: "details", shot: k });
  };
  const openShotEdit = (i: number, k: number) => {
    if (!board || i < 0 || i >= board.scenes.length) return;
    const shots = sceneShots(board.scenes[i]);
    if (!shots.length || k < 0 || k >= shots.length) return;
    startEditScene(i);
    setSelectedScene(i);
    setSceneModal({ index: i, mode: "edit", shot: k });
  };
  // Step across shots (flat position: within the scene, then into the
  // neighboring scene's edge shot, or its scene view when shot-less).
  const stepShotModal = (dir: 1 | -1) => {
    if (!board || !sceneModal || sceneModal.shot == null) return;
    const shots = sceneShots(board.scenes[sceneModal.index]);
    const nextK = sceneModal.shot + dir;
    if (nextK >= 0 && nextK < shots.length) {
      if (sceneModal.mode === "edit") startEditScene(sceneModal.index);
      setSceneModal({ ...sceneModal, shot: nextK });
      return;
    }
    const nextI = Math.min(board.scenes.length - 1, Math.max(0, sceneModal.index + dir));
    if (nextI === sceneModal.index) return;
    if (sceneModal.mode === "edit") startEditScene(nextI);
    setSelectedScene(nextI);
    const nextShots = sceneShots(board.scenes[nextI]);
    setSceneModal({
      index: nextI,
      mode: sceneModal.mode,
      shot: !nextShots.length ? null : (dir > 0 ? 0 : nextShots.length - 1),
    });
  };
  // One shot's read-only breakdown (shared by the scene popup's shot list
  // and the shot-focused popup). Includes Details/Edit jump buttons unless
  // already inside that shot's own popup (hideSelf).
  const renderShotDetails = (d: DirectorScene, i: number, k: number, sh: DirectorShot, hideSelf = false) => (
    <div key={str(sh.shot_id) || k} className="shot-detail-card" style={{ borderLeft: "2px solid var(--line-2)", paddingLeft: 8, marginBottom: 8 }}>
      <p className="shot-detail-title" style={{ margin: "2px 0" }}>
        <b>{d.scene_number}.{k + 1}{sh.shot_id ? ` (${sh.shot_id})` : ""}</b>
        {` · ${fmtRange(sh.start_time, sh.end_time)} · ${fmtT(sh.duration_seconds)}`}
        {sh.camera?.shot_type ? ` · ${sh.camera.shot_type}` : ""}
        {sh.camera?.movement ? ` · ${sh.camera.movement}` : ""}
        {(sh as DirectorShot & { lighting?: string }).lighting ? ` · 💡 ${str((sh as DirectorShot & { lighting?: string }).lighting).slice(0, 40)}` : ""}
      </p>
      <p className="shot-detail-seg" style={{ margin: "2px 0" }}>
        {(str(sh.lyric_segment) || str(sh.action) || "—")}
        {sh.semantic_meaning ? ` → ${sh.semantic_meaning}` : ""}
      </p>
      {str((sh as DirectorShot & { dramatic_purpose?: string }).dramatic_purpose) && (
        <p className="muted shot-detail-line" style={{ margin: "2px 0", fontSize: 12 }} title="Why this shot exists">
          🎯 {str((sh as DirectorShot & { dramatic_purpose?: string }).dramatic_purpose)}
        </p>
      )}
      {((sh as DirectorShot & { characters_detailed?: { character_id: string; role?: string; emotion?: string; gaze_target?: string; action?: string }[] }).characters_detailed ?? []).length > 0 && (
        <p className="muted shot-detail-line" style={{ margin: "2px 0", fontSize: 12 }} title="Per-character action, gaze and role (Notice → Orient → Approach → Act → React → Resolve)">
          {(sh as DirectorShot & { characters_detailed?: { character_id: string; role?: string; emotion?: string; gaze_target?: string; action?: string }[] }).characters_detailed!.map((c) =>
            `🧍 ${c.character_id}${c.role ? ` (${c.role})` : ""}${c.action ? `: ${c.action}` : ""}${c.gaze_target ? ` 👀 ${c.gaze_target}` : ""}${c.emotion ? ` · ${c.emotion}` : ""}`,
          ).join("  |  ")}
        </p>
      )}
      <p className="muted shot-detail-line" style={{ margin: "2px 0", fontSize: 12 }}>
        {(() => {
          const approvedAssets = assetProduction?.assets ?? [];
          const assetForRef = (type: DirectorMasterAsset["type"], id: string, blueprintId = "") =>
            approvedAssets.find((asset) => asset.type === type && (
              asset.id === id
              || asset.reference_id === id
              || asset.image_versions?.some((version) => version.reference_id === id)
              || (blueprintId && asset.blueprint_id === blueprintId)
            ));
          const names = (sh.characters ?? []).map((id, index) => {
            const entry = (board?.blueprint?.characters ?? []).find((c) => String(c.character_id ?? c.id ?? "") === id);
            const assetId = sh.asset_refs?.characters?.[index] || "";
            const asset = assetForRef("character", assetId, id);
            const name = String(asset?.name || entry?.name || id);
            const mappedId = assetId || asset?.reference_id || asset?.id || "";
            return `${name}${mappedId ? ` [${mappedId}]` : ""}`;
          });
          const locationId = sh.asset_refs?.locations?.[0] || "";
          const locationEntry = (board?.blueprint?.locations ?? []).find((item) =>
            String(item.location_id ?? item.id ?? "") === String(sh.location || ""));
          const locationAsset = assetForRef("location", locationId, String(sh.location || ""));
          const locationName = locationAsset?.name || String(locationEntry?.name || sh.location || "");
          const mappedLocationId = locationId || (locationAsset?.reference_id || locationAsset?.id) || "";
          const objectIds = sh.asset_refs?.objects ?? [];
          const objectRows = [...new Map([...new Set([...(sh.objects ?? []), ...objectIds])].map((id) => {
            const bibleObject = (board?.blueprint?.objects ?? []).find((item) =>
              String(item.object_id ?? item.id ?? "") === id);
            const asset = assetForRef("object", id, id);
            const name = String(asset?.name || bibleObject?.name || id);
            const mappedId = asset?.reference_id || asset?.id || id;
            return [mappedId, `${name}${mappedId ? ` [${mappedId}]` : ""}`] as const;
          })).values()];
          return [
            `Characters: ${names.join(", ") || "—"}`,
            locationName ? `Location: ${locationName}${mappedLocationId ? ` [${mappedLocationId}]` : ""}` : null,
            objectRows.length ? `Objects: ${objectRows.join(", ")}` : null,
          ].filter(Boolean).join(" · ");
        })()}
        {(sh.dialogue ?? []).length ? ` · 🎙 ${(sh.dialogue ?? []).map((x) => `${x.speaker || "voice"}: ${x.line}`).join(" / ")}` : ""}
      </p>
      <p className="muted shot-detail-line" style={{ margin: "2px 0", fontSize: 12 }} title="Physical movement over the duration of this shot">
        ↗ Motion: {str(sh.motion) || (str(sh.body_language) ? `from body language — ${str(sh.body_language)}` : str(sh.action) ? `from action — ${str(sh.action)}` : "—")}
      </p>
      <p className="muted shot-detail-line shot-detail-prompt" style={{ margin: "2px 0", fontSize: 12 }} title={sh.image_prompt || ""}>
        🖼 {str(sh.image_prompt).slice(0, 2000) || "—"}{str(sh.image_prompt).length > 2000 ? "…" : ""}
      </p>
      <p className="muted shot-detail-line shot-detail-prompt" style={{ margin: "2px 0", fontSize: 12 }} title={sh.video_prompt || ""}>
        🎬 {str(sh.video_prompt).slice(0, 2000) || "—"}{str(sh.video_prompt).length > 2000 ? "…" : ""}
      </p>
      {!hideSelf && (
        <div className="row" style={{ marginTop: 4, gap: 4 }}>
          <button
            className="ghost shotlist-btn"
            onClick={() => openShotDetails(i, k)}
            title={`Open the full breakdown of Shot ${d.scene_number}.${k + 1} in a popup`}
          >
            Details
          </button>
          <button
            className="ghost shotlist-btn"
            onClick={() => openShotEdit(i, k)}
            disabled={busy != null}
            title={`Edit Shot ${d.scene_number}.${k + 1} in a popup`}
          >
            Edit
          </button>
        </div>
      )}
    </div>
  );
  // One shot's edit form (shared by the scene popup's shot list and the
  // shot-focused popup). Writes into sceneDraft/shots + shotDlgDrafts; the
  // existing Save persists the whole scene (timings re-tiled server-side).
  const renderShotEditor = (d: DirectorScene, k: number, sh: DirectorShot) => (
    <div className="dir-shot-edit" key={str(sh.shot_id) || k}>
      <div className="shotlist-detail-label">
        Shot {d.scene_number}.{k + 1}{sh.shot_id ? ` (${sh.shot_id})` : ""} · {fmtRange(sh.start_time, sh.end_time)}
      </div>
      <div className="row" style={{ gap: 8 }}>
        <label style={{ flex: 1 }} title="Seconds for this shot">
          Duration
          <input
            type="number" min={0.5} max={30} step={0.1}
            value={Number(sh.duration_seconds) || 0}
            onChange={(e) => setSceneDraft((x) => {
              const cur = sceneShots({ ...d, ...x } as DirectorScene);
              return {
                ...x,
                shots: cur.map((y, j) => (j === k ? { ...y, duration_seconds: Number(e.target.value) } : y)),
              };
            })}
          />
        </label>
        <label style={{ flex: 3 }} title="Exact words/clause this shot visualizes">
          Segment
          <input
            value={str(sh.lyric_segment ?? "")} maxLength={300}
            placeholder="Exact words this shot visualizes…"
            onChange={(e) => setSceneDraft((x) => {
              const cur = sceneShots({ ...d, ...x } as DirectorScene);
              return {
                ...x,
                shots: cur.map((y, j) => (j === k ? { ...y, lyric_segment: e.target.value } : y)),
              };
            })}
          />
        </label>
      </div>
      <label style={{ marginTop: 6 }} title="One visible action for this shot">
        Action
        <input
          value={str(sh.action ?? "")} maxLength={300}
          onChange={(e) => setSceneDraft((x) => {
            const cur = sceneShots({ ...d, ...x } as DirectorScene);
            return {
              ...x,
              shots: cur.map((y, j) => (j === k ? { ...y, action: e.target.value } : y)),
            };
          })}
        />
      </label>
      <label style={{ marginTop: 6 }} title="Physical movement or change over the shot duration; do not describe appearance">
        Motion
        <input
          value={str(sh.motion ?? "")}
          maxLength={300}
          placeholder="e.g. slowly raises his tail, then holds still"
          onChange={(e) => setSceneDraft((x) => {
            const cur = sceneShots({ ...d, ...x } as DirectorScene);
            return {
              ...x,
              shots: cur.map((y, j) => (j === k ? { ...y, motion: e.target.value } : y)),
            };
          })}
        />
      </label>
      <label style={{ marginTop: 6 }} title="One per line as speaker: line — voiced + lip-synced on this shot's clip">
        Shot dialogue
        <textarea
          rows={2}
          value={shotDlgDrafts[k] ?? ""}
          placeholder="speaker: line"
          onChange={(e) => setShotDlgDrafts((m) => ({ ...m, [k]: e.target.value }))}
        />
      </label>
      <label style={{ marginTop: 6 }}>Shot image prompt</label>
      <textarea
        rows={3}
        value={str(sh.image_prompt ?? "")}
        onChange={(e) => setSceneDraft((x) => {
          const cur = sceneShots({ ...d, ...x } as DirectorScene);
          return {
            ...x,
            shots: cur.map((y, j) => (j === k ? { ...y, image_prompt: e.target.value } : y)),
          };
        })}
      />
      <label style={{ marginTop: 6 }}>Shot video prompt (motion only)</label>
      <textarea
        rows={3}
        value={str(sh.video_prompt ?? "")}
        onChange={(e) => setSceneDraft((x) => {
          const cur = sceneShots({ ...d, ...x } as DirectorScene);
          return {
            ...x,
            shots: cur.map((y, j) => (j === k ? { ...y, video_prompt: e.target.value } : y)),
          };
        })}
      />
    </div>
  );

  const chars = (board?.blueprint?.characters ?? []) as Record<string, unknown>[];
  const storedAnalyzerType = board?.input.analyzerType as AnalyzerType | undefined;
  const storedAnalyzerLabel = storedAnalyzerType && ANALYZER_TYPES[storedAnalyzerType]
    ? ANALYZER_TYPES[storedAnalyzerType].role
    : (str(board?.input.masterPrompt).match(/^ROLE:\s*(.+)$/m)?.[1] || "Not recorded for this older board");
  const masterAssets = assetProduction?.assets ?? [];
  const masterAssetsGenerated = masterAssets.filter((asset) => Boolean(asset.reference));
  const masterAssetsReady = masterAssets.filter((asset) => asset.status === "review" && Boolean(asset.reference));
  const masterAssetsApproved = masterAssets.filter((asset) => asset.status === "approved" && Boolean(asset.reference));
  const masterAssetsRendering = Boolean(assetProduction?.jobs?.some((job) => job.status === "PENDING" || job.status === "PROCESSING"));
  const masterAssetFor = (type: DirectorMasterAsset["type"], blueprintId: string) =>
    blueprintId ? assetProduction?.assets?.find((asset) => asset.type === type
      && (asset.blueprint_id === blueprintId || asset.id === blueprintId)) : undefined;
  const masterAssetRendering = (asset: DirectorMasterAsset | undefined) => Boolean(asset && (
    asset.status === "queued" || asset.status === "generating"
    || assetProduction?.jobs?.some((job) => job.asset_id === asset.id && (job.status === "PENDING" || job.status === "PROCESSING"))
  ));
  const assetVersionKey = (asset: DirectorMasterAsset) => `${board?.id ?? "board"}:${asset.id}`;
  const renderMasterAssetDetails = (asset: DirectorMasterAsset | undefined) => {
    if (!asset) return null;
    const rendering = masterAssetRendering(asset);
    const versions = asset.image_versions?.length
      ? asset.image_versions
      : asset.reference ? [{ version: asset.version || 1, reference: asset.reference }] : [];
    const chosenVersion = selectedAssetVersions[assetVersionKey(asset)];
    const selectedImage = (typeof chosenVersion === "number"
      ? versions.find((item) => item.version === chosenVersion)
      : null) || versions[versions.length - 1] || null;
    // Object/prop renders use the same versioned reference storage as
    // characters and locations, so expose their saved stills in the picker too.
    const showVersionPicker = true;
    return (
      <div className={`dir-master-asset-inline${rendering ? " is-generating" : ""}`} aria-busy={rendering}>
        <div className="row dir-master-asset-heading">
          <span className="section-label" style={{ margin: 0 }} title={`Stable asset: ${asset.id}`}>Master image · {asset.reference_id || asset.id} · {rendering ? "generating" : asset.status}{asset.reference ? ` · v${asset.version}` : ""}</span>
          <span className="spacer" />
          {rendering
            ? <span className="dir-asset-rendering-badge" role="status"><span className="dir-asset-rendering-dot" /> Rendering image</span>
            : asset.reference && <span className="pill" title="Generated reference still is linked to this asset">Image ready</span>}
        </div>
        {asset.error && <p className="hint err-text" style={{ margin: "4px 0" }}>{asset.error}</p>}
        {asset.description && <p className="hint dir-master-asset-description">{asset.description}</p>}
        {selectedImage ? (
          <div className="dir-master-asset-preview-wrap">
            <DirectorAssetPreview
              key={selectedImage.reference}
              name={asset.name}
              reference={selectedImage.reference}
              versions={versions.map((item) => ({
                src: directorAssetFileUrl(item.reference),
                kind: "image" as const,
                alt: `${asset.name} v${item.version}`,
              }))}
            />
            {rendering && <div className="dir-asset-rendering-overlay" aria-hidden="true"><span className="dir-asset-rendering-sweep" /><span className="dir-asset-rendering-label"><span className="dir-asset-rendering-spinner" /> Generating new image</span></div>}
          </div>
        ) : (
          <div className={`dir-master-asset-empty${rendering ? " is-generating" : ""}`}>
            {rendering ? <><span className="dir-asset-rendering-spinner" /> Generating image…</> : "No master image yet"}
          </div>
        )}
        {showVersionPicker && versions.length > 0 && (
          <div className="dir-asset-versions" role="group" aria-label={`${asset.name} image versions`}>
            <span className="dir-asset-versions-label">Versions</span>
            {versions.map((item) => (
              <button
                key={`${asset.id}-v${item.version}`}
                type="button"
                className={`dir-asset-version${selectedImage?.version === item.version ? " selected" : ""}`}
                aria-pressed={selectedImage?.version === item.version}
                title={`Show ${asset.name} image version ${item.version}`}
                onClick={() => setSelectedAssetVersions((current) => ({ ...current, [assetVersionKey(asset)]: item.version }))}
              >{item.reference_id || `v${item.version}`}</button>
            ))}
            <span className="dir-asset-latest-note">Latest selected by default</span>
          </div>
        )}
        <details className="dir-master-asset-prompt">
          <summary>Image generation prompt</summary>
          <p>{asset.prompt || "No saved image prompt."}</p>
        </details>
        <div className="row dir-master-asset-actions">
          <button
            className="ghost shotlist-btn"
            disabled={busy != null || assetBusy || assetUploading === asset.id || asset.status === "queued" || asset.status === "generating"}
            onClick={() => setAssetPromptEditor({ assetId: asset.id, name: asset.name, prompt: asset.prompt || "" })}
            title="Edit the image prompt and generate a new master still"
          >
            {asset.reference ? "Edit prompt & regenerate" : "Set prompt & generate"}
          </button>
          <button
            className="ghost shotlist-btn"
            disabled={busy != null || assetBusy || assetUploading === asset.id || asset.status === "queued" || asset.status === "generating"}
            onClick={() => assetFileInputRefs.current.get(asset.id)?.click()}
            title={`Upload a reference image for ${asset.name}`}
          >
            <IconUpload size={13} /> Upload image
          </button>
          {asset.status === "review" && (
            <button className="btn-green" disabled={busy != null || assetBusy || assetUploading === asset.id} onClick={() => void doApproveAssets([asset.id])}>
              <IconCheck size={13} /> Approve image
            </button>
          )}
          {assetUploading === asset.id && (
            <span className="spinner-inline" title="Uploading image…"><Spinner size={11} /> Uploading…</span>
          )}
          <input
            ref={(element) => {
              if (element) assetFileInputRefs.current.set(asset.id, element);
              else assetFileInputRefs.current.delete(asset.id);
            }}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={handleAssetFileChange(asset.id)}
          />
        </div>
      </div>
    );
  };

  // ---- Planning Time Remaining (total + per-scene) ----
  // Per-scene pace: live average from this plan's landed batches first, then
  // the persisted pace from previous plans (same fallback chain as Projects).
  // Total = remaining scenes × pace − time already spent in the current batch.
  const planPace = (() => {
    const st = planStatsRef.current;
    if (planPhase?.kind === "scenes" && st && st.boardId === (board?.id ?? "") && st.scenes > 0) {
      return st.sceneMs / st.scenes;
    }
    return loadDirectorPace();
  })();
  const planBatchElapsed = batchStartRef.current != null ? Math.max(0, dirNow - batchStartRef.current) : 0;
  // Shot-aware planning totals: shots flatten to one generation beat each,
  // so progress tracks beats (not just scene rows). Starts at sceneCount and
  // grows with the observed shots/scene average as multi-shot scenes land.
  const sceneCap = directorSceneCap(board);
  const planBeatsTotal = board ? boardBeatsTotal(board.scenes, sceneCap) : 0;
  const planBeatsDone = board ? boardBeats(board.scenes) : 0;
  const planTotal = planPhase
    ? planPhase.kind === "analyze" ? Math.max(1, planPhase.total) : Math.max(1, planBeatsTotal || planPhase.total)
    : 0;
  const planDone = planPhase
    ? planPhase.kind === "analyze" ? 0 : Math.min(planTotal, planBeatsDone)
    : 0;
  const planRemainingMs = planPhase && planPace != null && planTotal > planDone
    ? Math.max(0, Math.round((planTotal - planDone) * planPace - planBatchElapsed))
    : null;
  // Per-scene remaining for a 1-based pending scene number: its queue position
  // × pace − time already spent in the current batch. Null while paceless.
  const planSceneEta = (num: number): number | null => {
    if (!planPhase || planPhase.kind !== "scenes" || planPace == null) return null;
    if (num <= planDone) return null;
    return Math.max(0, Math.round((num - planDone) * planPace - planBatchElapsed));
  };
  // Lift to the menu's Progress Status (unit "scenes" so the header reads
  // counts + countdown in scene terms). Idle when no LLM phase is active, so
  // the menu falls back to generation progress exactly as before.
  const planMenuProgress: GenerationProgress = planPhase
    ? {
        ...emptyProgress,
        status: "running",
        unit: "scenes",
        scenario: planPhase.title || "storyboard",
        pct: planTotal > 0 ? (planDone / planTotal) * 100 : 0,
        completed: planDone,
        total: planTotal,
        scene: planPhase.kind === "scenes" && planTotal > planDone ? planDone + 1 : null,
        totalScenes: planPhase.kind === "scenes" ? planTotal : null,
        etaMs: planRemainingMs,
        elapsedMs: Math.max(0, dirNow - planPhase.startedAt),
        startedAt: planPhase.startedAt,
      }
    : emptyProgress;
  const planBoardId = board?.id ?? null;
  const planDoneCount = board?.scenes.length ?? 0;
  const planCount = sceneCap;
  useEffect(() => {
    onPlanningProgress?.(planMenuProgress);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planPhase, planBoardId, planDoneCount, planCount, dirNow]);
  const locs = (board?.blueprint?.locations ?? []) as Record<string, unknown>[];
  const objs = (board?.blueprint?.objects ?? []) as Record<string, unknown>[];
  const objectLabel = (id: string) => str(objs.find((o) => str(o.object_id) === id)?.name) || id;
  const analysis = (board?.blueprint?.analysis ?? {}) as Record<string, unknown>;
  // Timeline still open: an early-finalized board (scenes == sceneCount,
  // status ready) can still owe story seconds — Continue reopens it
  // server-side (cap extension), mirroring the server's DONE_TOL rule.
  const boardTarget = board ? Number(board.input.song?.durationSeconds ?? board.input.targetSeconds) : NaN;
  const boardWhisperAudio = (board?.input as (DirectorInput & { whisperxAudio?: { file?: string } }) | null)?.whisperxAudio;
  const hasSceneAudio = Boolean(board?.input.song?.file || board?.input.sourceAudio?.file || boardWhisperAudio?.file || audioUploaded);
  const boardPlanned = board ? boardPlannedSeconds(board.scenes) : 0;
  const boardTol = board ? Math.max(1, (Number(board.input.sceneSeconds) || 3) / 2) : 0;
  const timelineOpen = !!board && Number.isFinite(boardTarget) && boardTarget > 0
    && (boardTarget - boardPlanned) > boardTol;

  const directorTabStatuses: Record<DirectorTabId, DirectorTabStatus> = {
    brief: planPhase?.kind === "analyze" ? "running" : board?.processedTabs?.includes("brief") || board?.blueprint ? "approved" : "pending",
    audio: audioBusy ? "running"
      : board?.processedTabs?.includes("audio") ? "approved"
      : !board?.input.song && !audioUploaded ? "approved"
        : timelineApproval === "approved" ? "approved" : "pending",
    assets: assetBusy || assetJobsActive ? "running"
      : board?.processedTabs?.includes("assets") || assetProduction?.status === "approved" ? "approved" : "pending",
    scenes: busy ? "running"
      : board?.processedTabs?.includes("scenes") || (board && sceneCap > 0 && board.scenes.length >= sceneCap && !timelineOpen) ? "approved" : "pending",
    media: mediaProcessingStage === "media" ? "running" : mediaOutputsReady ? "approved" : "pending",
    export: mediaProcessingStage === "export" ? "running" : finalOutputReady ? "approved" : "pending",
  };
  const clampProgress = (value: number) => Math.min(99, Math.max(0, Math.floor(Number.isFinite(value) ? value : 0)));
  const activeAssetJobs = assetProduction?.jobs ?? [];
  const assetProgressPct = activeAssetJobs.length
    ? clampProgress((activeAssetJobs.filter((job) => job.status === "COMPLETED").length / activeAssetJobs.length) * 100)
    : 0;
  const directorTabProgress: Partial<Record<DirectorTabId, number>> = {
    brief: clampProgress(planMenuProgress.pct),
    audio: clampProgress(audioProgressPct),
    assets: assetProgressPct,
    scenes: clampProgress(planMenuProgress.pct),
    media: clampProgress(generationProgressPct),
    export: clampProgress(generationProgressPct),
  };
  const directorTabStatusText = (tab: DirectorTabId, status: DirectorTabStatus) => {
    if (tab === "audio" && status === "approved" && !board?.input.song && !audioUploaded) return "Not required";
    return status === "approved" ? "Approved" : status === "running" ? "Running" : "Pending";
  };
  const onDirectorGenerationStatus = useCallback((status: { mediaReady: boolean; exportReady: boolean; runningStage: "media" | "export" | null; progressPct: number }) => {
    setMediaOutputsReady(status.mediaReady);
    setFinalOutputReady(status.exportReady);
    setMediaProcessingStage(status.runningStage);
    setGenerationProgressPct(status.progressPct);
  }, []);

  // Saved-storyboard rail content: the same board cards, always listed in
  // the right rail (even while a board is open) so every board stays one
  // click away. The open board gets the `current` tint.
  const boardsPanel = boards.length === 0 ? (
    <div className="sidebar-empty">No saved boards yet — direct a story to save one here.</div>
  ) : (
    <div className="dir-board-grid dir-board-grid-2">
      {boards.map((b) => {
        const st = boardStatusOf(b.status);
        const total = Math.max(0, Number(b.sceneCount) || 0);
        const done = Math.min(total, Math.max(0, Number(b.scenes) || 0));
        // Shot-aware card total: shots ARE scenes at generation time, so the
        // live total projects remaining rows at the observed shots/scene avg.
        const shotsDone = Math.max(0, Number(b.shots) || 0);
        const avg = done > 0 ? Math.max(1, shotsDone / done) : 1;
        const shotsTotal = done >= total ? shotsDone : Math.max(total, shotsDone, Math.round(shotsDone + Math.max(0, total - done) * avg));
        const pct = shotsTotal > 0 ? Math.round((shotsDone / shotsTotal) * 100) : 0;
        const chips = [b.genre, b.visualStyle, b.language, b.aspectRatio].filter(Boolean) as string[];
        const when = b.updatedAt ? Date.parse(b.updatedAt) : null;
        return (
          <article
            key={b.id}
            className={`dir-board-card${board?.id === b.id ? " current" : ""}`}
            role="button"
            tabIndex={0}
            title={`Open ${b.title}`}
            aria-label={`Open storyboard ${b.title}`}
            aria-current={board?.id === b.id ? "true" : undefined}
            onClick={() => void openBoard(b.id)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void openBoard(b.id); } }}
          >
            <div className="dir-board-top">
              <span className="dir-chip dir-board-id" title={`Internal Director ID: ${b.id}`}>{directorDisplayId(b.id)}</span>
              <span className={`pill ${st.cls}`.trim()}>{st.label}</span>
              <span className="muted dir-board-when" title={b.updatedAt ?? ""}>
                {when != null ? fmtRelative(when) : ""}
              </span>
              <button
                className="icon-btn"
                onClick={(e) => { e.stopPropagation(); void openInputsById(b.id); }}
                disabled={loadingCardInputs === b.id}
                title={`View/edit the saved directing inputs for "${b.title}" (project name, story, language, genre, style, durations, instructions)`}
                aria-label={`View directing inputs for "${b.title}"`}
              >
                {loadingCardInputs === b.id ? <Spinner size={12} /> : <span aria-hidden="true">📝</span>}
              </button>
              <button
                className="icon-btn"
                onClick={(e) => { e.stopPropagation(); void doDuplicateBoardById(b.id, b.title); }}
                disabled={duplicatingId === b.id}
                title={`Duplicate "${b.title}" as a new version (copy characters, locations, scenes — no linked project/images/videos)`}
                aria-label={`Duplicate board "${b.title}" as a new version`}
              >
                {duplicatingId === b.id ? <Spinner size={12} /> : <span aria-hidden="true">⧉</span>}
              </button>
              <button
                className="icon-btn danger"
                onClick={(e) => { e.stopPropagation(); void doDeleteBoardById(b.id, b.title); }}
                title={`Delete board "${b.title}"`}
                aria-label={`Delete board "${b.title}"`}
              >
                <IconTrash size={13} />
              </button>
            </div>
            <h4 className="dir-board-title" title={b.title}>{b.title}</h4>
            {b.logline && <p className="dir-board-logline" title={b.logline}>{b.logline}</p>}
            {chips.length > 0 && (
              <div className="dir-board-chips">
                {chips.map((c) => <span key={c} className="dir-chip">{c}</span>)}
              </div>
            )}
            <div className="dir-board-progress" title={`${done}/${total} scenes planned · ${shotsDone}/${shotsTotal} timed shots (shots generate as scenes)`}>
              <div className="dir-board-bar"><span style={{ width: `${pct}%` }} /></div>
              <span className="muted">{done}/{total} scenes · 🎞 {shotsDone}/{shotsTotal}</span>
            </div>
            {boardMediaProgress[b.id] && (() => {
              const media = boardMediaProgress[b.id];
              return (
                <div className="dir-board-media-progress" title={`Images ${media.imagesGenerated}/${media.shotsTotal} · videos ${media.videosGenerated}/${media.shotsTotal} · assets ${media.imagesGenerated + media.videosGenerated}/${media.shotsTotal * 2}`}>
                  <span className="muted">Generated · Scenes {media.scenesGenerated}/{media.scenesTotal} · Shots {media.shotsGenerated}/{media.shotsTotal} · Assets {media.imagesGenerated + media.videosGenerated}/{media.shotsTotal * 2}</span>
                </div>
              );
            })()}
            <div className="dir-board-foot">
              {b.scenarioName
                ? <span className="pill done" title={`${directorDisplayId(b.id)} linked to project ${b.scenarioName}${b.project_id != null ? ` (#${b.project_id})` : ""}`}>→ {directorDisplayId(b.id)} · {b.scenarioName}{b.project_id != null ? ` #${b.project_id}` : ""}</span>
                : <span />}
              <button
                type="button"
                className="btn-blue shotlist-btn dir-board-open"
                tabIndex={-1}
                title={`Open ${b.title}`}
              >
                Open
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );

  return (
    <>
    <div className="dir-layout">
    <section className={`card dir-main${collapsed ? " collapsed" : ""}`} aria-label="AI Story Director">
      <div className="card-head">
        <h2>
          <span className="head-icon hi-output"><IconClapper size={15} /></span>
          AI Story Director
        </h2>
        {busy && (
          <span
            className="pill running live-jump"
            title={`${busy.label} — click to jump to the scenes being generated`}
            role="button"
            tabIndex={0}
            onClick={() => scrollToLive()}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); scrollToLive(); } }}
          >
            <Spinner size={11} />
            {busy.label.split("—")[0].trim()}…
            <Elapsed since={busy.since} />
          </span>
        )}
        <span className="spacer" />
        {board && (
          <span className="pill pending" title="Audio Intelligence lives in the Director workflow sections below">
            🎧 Audio panel below
          </span>
        )}
        {board && (
          <span style={{ display: "inline-flex", flexDirection: "column", gap: 4 }}>
            <button className="ghost" onClick={() => void openAddNew()} title="Create a new story by importing processed tabs from an existing project">
              Add New
            </button>
            <button className="ghost" onClick={() => void onShowPrompt()} disabled={promptLoading} title="Show the exact prompt the next Continue would send to the LLM (no planning, nothing saved)">
              {promptLoading ? "Loading…" : "Show prompt"}
            </button>
          </span>
        )}
        <button
          className="icon-btn"
          onClick={toggleCollapsed}
          title={collapsed ? "Show story director" : "Hide story director"}
          aria-label={collapsed ? "Show story director" : "Hide story director"}
          aria-expanded={!collapsed}
        >
          <span aria-hidden="true">⧉</span>
        </button>
      </div>
      <Collapse open={!collapsed}>
        {error && <p className="hint err-text">{error}</p>}

        <nav className="dir-flow-tabs" role="tablist" aria-label="Director workflow stages">
          {DIRECTOR_TABS.map((tab) => {
            const status = directorTabStatuses[tab.id];
            const progressPct = directorTabProgress[tab.id] ?? 0;
            const statusText = status === "running" ? `Processing ${progressPct}%` : directorTabStatusText(tab.id, status);
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeDirectorTab === tab.id}
                aria-controls={`director-panel-${tab.id}`}
                aria-label={`${tab.label}: ${statusText}`}
                aria-current={activeDirectorTab === tab.id ? "page" : undefined}
                className={`dir-flow-tab ${status === "approved" ? "approved" : status === "running" ? "processing" : "pending"}${activeDirectorTab === tab.id ? " active" : ""}`}
                style={{ "--tab-progress": `${progressPct}%` } as CSSProperties}
                onClick={() => setActiveDirectorTab(tab.id)}
              >
                <span className="dir-flow-tab-label">{tab.label}</span>
                <span className={`dir-flow-tab-icon${status === "running" ? " spinning" : ""}`} aria-hidden="true">{status === "approved" ? "✓" : status === "running" ? "↻" : "◷"}</span>
                {status === "running" && <span className="dir-flow-tab-progress">{progressPct}%</span>}
              </button>
            );
          })}
        </nav>

        {!board && (
          <div id="director-panel-brief" role="tabpanel" aria-label="Brief" hidden={activeDirectorTab !== "brief"}>
            <div className="row" style={{ marginTop: 8, gap: 10, alignItems: "flex-end" }}>
              <div style={{ flex: "2.2 1 150px" }}>
                <label htmlFor="dir-title">Story title</label>
                <input
                  id="dir-title"
                  value={title}
                  maxLength={120}
                  placeholder="The Mouse and the Magic Cheese"
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>
              <div style={{ flex: "1.5 1 130px" }}>
                <label htmlFor="dir-analyzer" title="Select the director type — its task and instructions will appear in the Master Prompt">Analyzer</label>
                <select id="dir-analyzer" value={analyzerType} onChange={(e) => setAnalyzerType(e.target.value as AnalyzerType)}>
                  {Object.entries(ANALYZER_TYPES).map(([key, val]) => <option key={key} value={key}>{val.role}</option>)}
                </select>
              </div>
              <div style={{ flex: "1.5 1 130px" }}>
                <label htmlFor="dir-style" title="Changing the style updates the Visual Style Lock in the Master Prompt">Visual style</label>
                <select id="dir-style" value={visualStyle} onChange={(e) => setVisualStyle(e.target.value)}>
                  {STYLES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                {visualStyle === "Custom" && (
                  <input value={styleCustom} maxLength={120} placeholder="Describe the custom style…" onChange={(e) => setStyleCustom(e.target.value)} style={{ marginTop: 6 }} />
                )}
              </div>
              <div style={{ flex: "1.2 1 110px" }}>
                <label htmlFor="dir-target">Target duration</label>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  {targetOpt === -1 ? (
                    <input type="number" min={15} max={3600} value={targetCustom} onChange={(e) => setTargetCustom(e.target.value)} style={{ flex: "1 1 60px", minWidth: 60, width: "100%" }} disabled={busy != null} />
                  ) : (
                    <select
                      id="dir-target"
                      value={targetOpt}
                      onChange={(e) => { setTargetOpt(Number(e.target.value)); }}
                      disabled={busy != null}
                      style={{ flex: "1 1 70px", minWidth: 70, width: "100%" }}
                    >
                      {TARGETS.map((t) => <option key={t.seconds} value={t.seconds}>{t.label}</option>)}
                    </select>
                  )}
                </div>
              </div>
              <div style={{ flex: "1 1 95px" }}>
                <label htmlFor="dir-scene" title="Typical scene length (pacing hint only) — the AI decides each scene's own duration, shot count and shot timings from the story, line by line">Scene duration</label>
                <select id="dir-scene" value={sceneOpt} onChange={(e) => setSceneOpt(Number(e.target.value))}>
                  {SCENE_DURS.map((t) => <option key={t.seconds} value={t.seconds}>{t.label}</option>)}
                </select>
                {sceneOpt === -1 && (
                  <input type="number" min={1} max={30} value={sceneCustom} onChange={(e) => setSceneCustom(e.target.value)} style={{ marginTop: 6 }} />
                )}
              </div>
              <div className="muted" style={{ flex: "1 0 100%", fontSize: 11, marginTop: -4 }}>
                About {plannedScenes} scenes across {Math.ceil(plannedScenes / sceneBatch)} batches of up to {sceneBatch}. The runtime and scene length estimate the count; the story determines each scene’s content and boundaries.
              </div>
              <label
                style={{ display: "flex", gap: 4, alignItems: "center", fontWeight: 400, paddingBottom: 6, flexShrink: 0, cursor: "pointer", opacity: includeDialogue ? 1 : 0.45 }}
                title="When ON, scenes carry spoken lines (voice + lip-sync). Turn OFF for a silent film — clips stay at their planned length."
                aria-label="Dialogues"
              >
                <input
                  type="checkbox"
                  checked={includeDialogue}
                  onChange={(e) => setIncludeDialogue(e.target.checked)}
                  disabled={busy != null}
                />
                <span aria-hidden="true" style={{ fontSize: 16 }}>🎙</span>
              </label>
              <label
                style={{ display: "flex", gap: 4, alignItems: "center", fontWeight: 400, paddingBottom: 6, flexShrink: 0, cursor: "pointer", opacity: chainContinuity ? 1 : 0.45 }}
                title="When ON, every scene continues the previous shot's end state (same look/framing) via prompt continuity — so the movie plays as one connected story. When OFF, every scene plans and generates as an independent fresh shot. Pixels always stay per-scene (each clip animates its own scene image)."
                aria-label="Connected scenes"
              >
                <input
                  type="checkbox"
                  checked={chainContinuity}
                  onChange={(e) => setChainContinuity(e.target.checked)}
                  disabled={busy != null}
                />
                <span aria-hidden="true" style={{ fontSize: 16 }}>🔗</span>
              </label>
            </div>
            <div style={{ marginTop: 8 }}>
              <label htmlFor="dir-master" title="Shows the selected Analyzer's task and instructions. The Visual style preset is appended at the end — edit freely. This text is sent as THE style lock appended to every image prompt, so scenes cannot drift off-style.">
                Master Prompt <span className="hint" style={{ fontWeight: 400 }}>(Analyzer task + instructions + Visual style preset — editable)</span>
              </label>
              <textarea
                id="dir-master"
                rows={10}
                value={masterPrompt}
                maxLength={4000}
                placeholder="Select an Analyzer to see its task and instructions…"
                onChange={(e) => setMasterPrompt(e.target.value)}
                style={{ fontFamily: "monospace", fontSize: 12, whiteSpace: "pre-wrap" }}
              />
              <p className="hint" style={{ margin: "4px 0 0" }}>
                The Analyzer's task and instructions are shown above. The Visual style preset is appended at the end. Your edits are kept and used verbatim.
              </p>
            </div>
              <label htmlFor="dir-story" style={{ marginTop: 8 }}>
                Story
              </label>
              <textarea
              id="dir-story"
              rows={8}
              style={{ height: "20vh" }}
              value={story}
              maxLength={10000}
              placeholder="Once upon a time… (paste the full story)"
              onChange={(e) => setStory(e.target.value)}
            />
            <div className="row" style={{ marginTop: 8, gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 0", minWidth: 110 }}>
                <label htmlFor="dir-lang">Language</label>
                <select id="dir-lang" value={language} onChange={(e) => setLanguage(e.target.value)}>
                  {LANGS.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>
              <div style={{ flex: "1 1 0", minWidth: 110 }}>
                <label htmlFor="dir-sem-lang" title="The language of the story text for the meaning analysis (the spoken language above is separate)">Source language</label>
                <select id="dir-sem-lang" value={semanticsLanguage} onChange={(e) => setSemanticsLanguage(e.target.value)}>
                  <option value="auto">Auto detect</option>
                  <option value="hi">Hindi</option>
                  <option value="en">English</option>
                  <option value="hinglish">Hinglish (mixed)</option>
                </select>
                <p className="hint" style={{ margin: "4px 0 0" }}>
                  Every line is read for its meaning before a scene is planned.
                </p>
              </div>
              <div style={{ flex: "1 1 0", minWidth: 110 }}>
                <label htmlFor="dir-genre">Genre</label>
                <select id="dir-genre" value={genre} onChange={(e) => setGenre(e.target.value)}>
                  {GENRES.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
                {genre === "Custom" && (
                  <input value={genreCustom} maxLength={40} placeholder="Custom genre…" onChange={(e) => setGenreCustom(e.target.value)} style={{ marginTop: 6 }} />
                )}
              </div>
              <div style={{ flex: "1 1 0", minWidth: 110 }}>
                <label htmlFor="dir-aspect">Aspect ratio</label>
                <select id="dir-aspect" value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)}>
                  {ASPECTS.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
                <p className="hint" style={{ margin: "4px 0 0" }}>
                  {aspectRatio === "9:16"
                    ? "9:16 renders through the Instagram Reel flow after approval."
                    : aspectRatio === "1:1"
                      ? "The pipeline renders 16:9/9:16 — approved as 16:9."
                      : "Standard landscape cut."}
                </p>
              </div>
            </div>
            <div className="row" style={{ marginTop: 8, alignItems: "center", gap: 8 }}>
              <div style={{ flex: "1 1 0", minWidth: 180 }}>
                <label htmlFor="dir-audio-status" title="Audio Intelligence and 19-track Master Timeline status">Audio Intelligence</label>
              </div>
              <div style={{ flex: "1 1 0", minWidth: 120, fontSize: 12, color: "var(--line)" }}>
                {audioUploaded ? (
                  <div>
                    <span className={`pill ${timelineApproval === "approved" ? "done" : timelineApproval === "revision_required" ? "warn" : "pending"}`}>
                      {timelineApproval === "approved" ? "Approved" : timelineApproval === "revision_required" ? "Revision required" : "Pending"}
                    </span>
                    {timelineVersion > 0 && <span className="muted">v{timelineVersion}</span>}
                  </div>
                ) : (
                  <span>No audio</span>
                )}
              </div>
              <div style={{ flex: "1 1 0", minWidth: 120, fontSize: 12, color: "var(--line)" }}>
                {audioUploaded && timelineApproval === "approved" ? (
                  <span className="ok">✓ Director-consumed</span>
                ) : (
                  <span>—</span>
                )}
              </div>
            </div>
            <div className="row" style={{ marginTop: 8, gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 0", minWidth: 110 }}>
                <label htmlFor="dir-lang2">Language</label>
                <select id="dir-lang2" value={language} onChange={(e) => setLanguage(e.target.value)}>
                  {LANGS.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>
              <div style={{ flex: "1 1 0", minWidth: 110 }}>
                <label htmlFor="dir-sem-lang2" title="The language of the story text for the meaning analysis (the spoken language above is separate)">Source language</label>
                <select id="dir-sem-lang2" value={semanticsLanguage} onChange={(e) => setSemanticsLanguage(e.target.value)}>
                  <option value="auto">Auto detect</option>
                  <option value="hi">Hindi</option>
                  <option value="en">English</option>
                  <option value="hinglish">Hinglish (mixed)</option>
                </select>
                <p className="hint" style={{ margin: "4px 0 0" }}>
                  Every line is read for its meaning before a scene is planned.
                </p>
              </div>
              <div style={{ flex: "1 1 0", minWidth: 110 }}>
                <label htmlFor="dir-genre2">Genre</label>
                <select id="dir-genre2" value={genre} onChange={(e) => setGenre(e.target.value)}>
                  {GENRES.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
                {genre === "Custom" && (
                  <input value={genreCustom} maxLength={40} placeholder="Custom genre…" onChange={(e) => setGenreCustom(e.target.value)} style={{ marginTop: 6 }} />
                )}
              </div>
              <div style={{ flex: "1 1 0", minWidth: 110 }}>
                <label htmlFor="dir-aspect2">Aspect ratio</label>
                <select id="dir-aspect2" value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)}>
                  {ASPECTS.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
                <p className="hint" style={{ margin: "4px 0 0" }}>
                  {aspectRatio === "9:16"
                    ? "9:16 renders through the Instagram Reel flow after approval."
                    : aspectRatio === "1:1"
                      ? "The pipeline renders 16:9/9:16 — approved as 16:9."
                      : "Standard landscape cut."}
                </p>
              </div>
            </div>
            {!board && (
              <p className="hint" style={{ margin: "8px 0 0" }}>
                🎧 .wav upload unlocks after Generate Storyboard: open the board, then upload the .wav here — WhisperX builds the 19-track master timeline from it.
              </p>
            )}
            <AudioIntelligencePanel
              uploaded={audioUploaded}
              duration={audioDuration}
              analysisStatus={audioAnalysisStatus}
              timelineEvents={timelineEventsCount}
              validation={timelineValidation}
              approval={timelineApproval}
              version={timelineVersion}
              onUpload={handleAudioUpload}
              onAnalyze={handleAnalyzeTimeline}
              onDirectorPlan={handleSendToDirector}
            />
            {!includeDialogue && (
              <p className="hint" style={{ margin: "4px 0 0" }}>
                Silent film: scenes plan with empty dialogue — approve generates visuals only (no TTS, no lip-sync).
              </p>
            )}
            {!chainContinuity && (
              <p className="hint" style={{ margin: "4px 0 0" }}>
                Independent: every scene plans and generates as a fresh shot — no continuation of the previous scene.
              </p>
            )}
            <div className="row" style={{ marginTop: 8, alignItems: "center", gap: 8 }}>
              <label htmlFor="dir-instructions" style={{ margin: 0 }}>Additional director instructions</label>
              <span className="spacer" />
              <button
                type="button"
                className="ghost shotlist-btn"
                onClick={() => void handleSuggestInstructions()}
                disabled={busy != null || suggestingInstructions || (story.trim().length < 20 && !title.trim())}
                title="Ask the local LLM to read the story and draft tailored director instructions into this box"
              >
                {suggestingInstructions ? "Drafting…" : "✨ Get by AI"}
              </button>
            </div>
            <textarea
              id="dir-instructions"
              rows={3}
              style={{ height: "20vh" }}
              value={instructions}
              placeholder="Keep Minku's appearance exactly the same… avoid scary scenes…"
              onChange={(e) => setInstructions(e.target.value)}
            />
            {instructionsNote && <p className="muted" style={{ margin: "4px 0 0" }}>{instructionsNote}</p>}
            {busy != null && (
              <div style={{ marginTop: 8 }}>
                <label htmlFor="dir-live" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span className="pill running" aria-hidden="true">🔴 LIVE</span>
                  <span style={{ color: "var(--accent)" }}>Backend response — streaming live from the AI Director</span>
                </label>
                <textarea
                  id="dir-live"
                  ref={formLiveRef}
                  readOnly
                  value={formLiveText}
                  rows={6}
                  placeholder="Waiting for the first tokens from the model…"
                  spellCheck={false}
                  style={{ height: "16vh", fontFamily: "monospace", fontSize: 12, resize: "vertical", whiteSpace: "pre-wrap", color: "#22c55e" }}
                />
              </div>
            )}
            <div className="row" style={{ marginTop: 12 }}>
              <button
                className="ghost shotlist-btn"
                onClick={() => void openBiblePrompt()}
                disabled={busy != null || biblePromptLoading || !title.trim() || story.trim().length < 20}
                title="Preview the exact prompt the AI Director will receive — edit it before sending"
              >
                {biblePromptLoading ? <Spinner size={13} /> : "👁"}
                {biblePromptLoading ? "Loading…" : "Show Prompt"}
              </button>
              <button className="primary" onClick={() => void doAnalyze()} disabled={busy != null || !title.trim() || story.trim().length < 20} title="Analyze the story and build its character, location, and object bible">
                {busy ? <Spinner size={13} /> : <IconSparkles size={13} />}
                {busy ? "Directing…" : "Generate Storyboard"}
              </button>
            </div>
            {biblePromptOpen && (
              <div className="dlg-overlay" role="dialog" aria-modal="true" aria-label="Edit the directing prompt" onClick={() => setBiblePromptOpen(false)}>
                <div className="dlg-box" style={{ width: "min(1104px, 94vw)" }} onClick={(e) => e.stopPropagation()}>
                  <div className="row shot-popup-head" style={{ alignItems: "center", marginBottom: 8 }}>
                    <h3 className="dlg-title" style={{ margin: 0, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}>
                      🧠 Prompt sent to the AI Director{biblePromptEdited ? " — edited" : ""}
                    </h3>
                    <button className="icon-btn" onClick={() => setBiblePromptOpen(false)} title="Close popup" aria-label="Close popup">✕</button>
                  </div>
                  <p className="hint" style={{ margin: "0 0 8px" }}>
                    Edit freely — this text is sent to the model verbatim in place of the default prompt
                    (the system rules and every downstream stage stay the same). Reset restores the generated prompt.
                  </p>
                  <details open style={{ marginBottom: 8 }}>
                    <summary><b>MASTER PROMPT</b> — the style lock (from Analyzer + Visual Style + Additional Instructions) that will be appended to every image prompt</summary>
                    <textarea
                      value={masterPrompt}
                      onChange={(e) => setMasterPrompt(e.target.value)}
                      style={{ width: "100%", height: "10vh", fontFamily: "monospace", fontSize: 12, resize: "vertical", whiteSpace: "pre-wrap", marginTop: 8, background: "rgba(0,0,0,0.15)", border: "1px solid var(--line, #e5e7eb)", borderRadius: 8, padding: 10 }}
                      spellCheck={false}
                    />
                  </details>
                  <details open style={{ marginBottom: 8 }}>
                    <summary><b>USER PROMPT</b> — the story/lyrics + settings sent to the model</summary>
                    <textarea
                      value={biblePromptDraft}
                      onChange={(e) => { setBiblePromptDraft(e.target.value); setBiblePromptEdited(true); }}
                      style={{ width: "100%", height: "45vh", fontFamily: "monospace", fontSize: 12, resize: "vertical", whiteSpace: "pre-wrap" }}
                      spellCheck={false}
                    />
                  </details>
                  {biblePromptOptimizing && (
                    <p className="hint" style={{ margin: "8px 0 0" }}>
                      <Spinner size={12} /> Optimizing the prompt with the LLM — keeping every constraint…
                    </p>
                  )}
                  {biblePromptOptimizeError && <p className="hint err-text" style={{ margin: "8px 0 0" }}>{biblePromptOptimizeError}</p>}
                  {biblePromptOptimized !== null && !biblePromptOptimizing && (
                    <div style={{ marginTop: 10, border: "1px solid var(--line, #e5e7eb)", borderRadius: 8, padding: 10 }}>
                      <div className="row" style={{ alignItems: "center", gap: 8, marginBottom: 6 }}>
                        <strong style={{ flex: 1, minWidth: 0 }}>
                          ✨ Optimized prompt
                          {biblePromptTokens ? ` — ≈${biblePromptTokens.optimized} tokens (was ≈${biblePromptTokens.original})` : ""}
                        </strong>
                        <button className="ghost" onClick={() => { setBiblePromptOptimized(null); setBiblePromptTokens(null); }} title="Hide the optimized comparison">
                          Dismiss
                        </button>
                        <button className="primary" onClick={useOptimizedBiblePrompt} title="Replace the editable prompt above with the optimized text">
                          Use optimized
                        </button>
                      </div>
                      <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 200, overflowY: "auto", background: "rgba(0,0,0,0.25)", padding: 10, borderRadius: 8, margin: 0 }}>{biblePromptOptimized}</pre>
                      <div className="shotlist-detail-label" style={{ marginTop: 8 }}>
                        Main prompt{biblePromptTokens ? ` (≈${biblePromptTokens.original} tokens)` : ""}
                      </div>
                      <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 160, overflowY: "auto", background: "rgba(0,0,0,0.15)", padding: 10, borderRadius: 8, margin: "4px 0 0" }}>{biblePromptMain}</pre>
                    </div>
                  )}
                  <div className="dlg-actions" style={{ marginTop: 12 }}>
                    <button className="ghost" onClick={() => void openBiblePrompt()} disabled={biblePromptLoading} title="Restore the auto-generated prompt">
                      Reset
                    </button>
                    <button
                      className="ghost"
                      onClick={() => void optimizeBiblePrompt()}
                      disabled={biblePromptOptimizing || !biblePromptDraft.trim()}
                      title="Ask the LLM to rewrite this prompt for clarity and impact — every constraint is kept. Compare the optimized text (with token counts) against the main prompt before applying."
                    >
                      {biblePromptOptimizing ? <Spinner size={13} /> : "✨"}
                      {biblePromptOptimizing ? "Optimizing…" : "Optimize Prompt"}
                    </button>
                    <span className="spacer" />
                    <button className="ghost" onClick={() => setBiblePromptOpen(false)} title="Keep the default prompt (nothing is sent)">
                      Close
                    </button>
                    <button
                      className="primary"
                      onClick={() => { setBiblePromptOpen(false); void doAnalyze(biblePromptDraft.trim() || undefined); }}
                      disabled={busy != null || !biblePromptDraft.trim()}
                      title="Send the text above to the AI Director"
                    >
                      {biblePromptEdited ? "Generate with edited prompt" : "Generate Storyboard"}
                    </button>
                  </div>
                </div>
              </div>
            )}

          </div>
        )}

        {!board && activeDirectorTab !== "brief" && (
          <div id={`director-panel-${activeDirectorTab}`} role="tabpanel" aria-label={DIRECTOR_TABS.find((tab) => tab.id === activeDirectorTab)?.label ?? "Director stage"} className="dir-flow-empty">
            <span>No data found</span>
          </div>
        )}

        {board && (
          <>
            <div id="director-panel-audio" role="tabpanel" aria-label="Audio Analysis" hidden={activeDirectorTab !== "audio"}>
              <AudioIntelligencePanel
                boardId={board.id}
                uploaded={audioUploaded}
                duration={audioDuration}
                analysisStatus={audioAnalysisStatus}
                timelineEvents={timelineEventsCount}
                validation={timelineValidation}
                approval={timelineApproval}
                version={timelineVersion}
                masterTimeline={masterTimeline}
                audioFileName={audioMeta?.fileName}
                onUpload={handleAudioUpload}
                onAnalyze={handleAnalyzeTimeline}
                onDirectorPlan={handleSendToDirector}
              />
            </div>
            <div id="director-panel-brief-board" hidden={activeDirectorTab !== "brief"}>
            <p className="card-desc">
              {editingTitle ? (
                <span className="row" style={{ display: "inline-flex", gap: 6 }}>
                  <input
                    value={titleDraft}
                    maxLength={120}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void doRenameBoard(); }}
                    title="Board title — the approved project takes exactly this name"
                    style={{ minWidth: 200 }}
                  />
                  <button className="primary" onClick={() => void doRenameBoard()} disabled={!titleDraft.trim()} title="Save the new title">
                    Save
                  </button>
                  <button className="ghost" onClick={() => setEditingTitle(false)} title="Keep the current title">
                    Cancel
                  </button>
                </span>
              ) : (
                <>
                  <b>{board.input.title}</b>{" "}
                  <button
                    className="ghost shotlist-btn"
                    onClick={() => { setTitleDraft(board.input.title); setEditingTitle(true); }}
                    title="Rename — the approved project takes exactly this name"
                  >
                    Rename
                  </button>{" "}
                  <button
                    className="ghost shotlist-btn"
                    onClick={() => openInputs(board)}
                    title="View/edit the saved directing inputs (project name, story, language, genre, style, durations, instructions) — what you entered before directing"
                  >
                    📝 Inputs
                  </button>
                </>
              )}
              {" "}· {board.input.genre} · {board.input.language} · {board.input.aspectRatio} ·
              {" "}{board.scenes.length}/{sceneCap} scenes · 🎞 {boardBeats(board.scenes)}/{boardBeatsTotal(board.scenes, sceneCap)} shots · ~{boardPlannedSeconds(board.scenes)}s/~{Math.round(Number(board.input.song?.durationSeconds ?? board.input.targetSeconds) || 0)}s
              {board.scenarioName ? <> · approved → <b>{board.scenarioName}</b></> : null}
              {" "}· {board.input.includeDialogue === false ? "🔇 silent" : `🎙 ${board.scenes.filter((s) => (s.dialogue ?? []).length).length} dialogue`}
              {" "}· {board.input.chainContinuity === true ? "🔗 connected" : "▫️ independent"}
            </p>
            <div className="row" style={{ marginBottom: 8 }}>
              <button
                className="ghost shotlist-btn"
                onClick={() => void doToggleBoardDialogue()}
                disabled={busy != null}
                title={board.input.includeDialogue === false
                  ? "Turn dialogues ON — future scenes plan spoken lines (planned scenes stay silent until regenerated)"
                  : "Turn dialogues OFF — strips all planned lines, future scenes plan silent, Approve generates visuals only"}
              >
                {board.input.includeDialogue === false ? "🎙 Dialogues: off → on" : "🔇 Dialogues: on → off"}
              </button>
              <button
                className="ghost shotlist-btn"
                onClick={() => void doToggleBoardChain()}
                disabled={busy != null}
                title={board.input.chainContinuity === true
                  ? "Turn connected scenes OFF — scrubs handoffs from planned scenes; Approve generates independent shots"
                  : "Turn connected scenes ON — future scenes continue the previous shot's end state in their prompts"}
              >
                {board.input.chainContinuity === true ? "🔗 Connected: on → off" : "▫️ Connected: off → on"}
              </button>
            </div>
            <section className="dir-saved-brief" aria-label="Brief values saved for this Director board">
              <div className="dir-saved-brief-head">
                <div>
                  <div className="section-label">Brief used to create this board</div>
                  <p className="hint">Saved creation settings are shown here whenever you reopen this board.</p>
                </div>
                <button className="ghost shotlist-btn" onClick={() => openInputs(board)} title="View or edit the saved brief values">
                  Edit brief values
                </button>
              </div>
              <div className="dir-saved-brief-grid">
                <div className="dir-saved-brief-field"><span>Story title</span><b>{board.input.title || "—"}</b></div>
                <div className="dir-saved-brief-field"><span>Analyzer</span><b>{storedAnalyzerLabel}</b></div>
                <div className="dir-saved-brief-field"><span>Language</span><b>{board.input.language || "—"}</b></div>
                <div className="dir-saved-brief-field"><span>Source language</span><b>{{ auto: "Auto detect", hi: "Hindi", en: "English", hinglish: "Hinglish" }[str(board.input.semanticsLanguage)] || "Auto detect"}</b></div>
                <div className="dir-saved-brief-field"><span>Genre</span><b>{board.input.genre || "—"}{board.input.genre === "Custom" && board.input.genreCustom ? ` · ${board.input.genreCustom}` : ""}</b></div>
                <div className="dir-saved-brief-field"><span>Visual style</span><b>{board.input.visualStyle || "—"}{board.input.visualStyle === "Custom" && board.input.styleCustom ? ` · ${board.input.styleCustom}` : ""}</b></div>
                <div className="dir-saved-brief-field"><span>Target duration</span><b>~{Math.round(Number(board.input.song?.durationSeconds ?? board.input.targetSeconds) || 0)} seconds{board.input.song?.durationSeconds ? " · locked to song" : ""}</b></div>
                <div className="dir-saved-brief-field"><span>Scene duration</span><b>~{Math.round(Number(board.input.sceneSeconds) || 3)} seconds</b></div>
                <div className="dir-saved-brief-field"><span>Aspect ratio</span><b>{board.input.aspectRatio || "—"}</b></div>
                <div className="dir-saved-brief-field"><span>Dialogues</span><b>{board.input.includeDialogue === false ? "Off" : "On"}</b></div>
                <div className="dir-saved-brief-field"><span>Connected scenes</span><b>{board.input.chainContinuity === true ? "On" : "Off"}</b></div>
              </div>
              <label className="dir-saved-brief-block-label" htmlFor={`saved-brief-story-${board.id}`}>Story / lyrics</label>
              <textarea id={`saved-brief-story-${board.id}`} className="dir-saved-brief-story" readOnly value={board.input.story || ""} rows={6} />
              {board.input.song?.fileName && (
                <div className="dir-saved-brief-field dir-saved-brief-song"><span>Attached song</span><b>🎵 {board.input.song.fileName} · ~{board.input.song.durationSeconds}s · {board.input.song.hasLyrics === false ? "Instrumental" : "Lyrics"}</b></div>
              )}
              {board.input.sourceAudio?.fileName && (
                <div className="dir-saved-brief-field dir-saved-brief-song"><span>Source audio</span><b>🎧 {board.input.sourceAudio.fileName} · ~{board.input.sourceAudio.durationSeconds}s</b></div>
              )}
              <details className="dir-saved-brief-details">
                <summary>Master prompt and additional instructions</summary>
                <div className="dir-saved-brief-detail-content">
                  <div><span>Master prompt</span><p>{board.input.masterPrompt || board.styleLock || "Not recorded for this older board."}</p></div>
                  <div><span>Additional director instructions</span><p>{board.input.instructions || "None"}</p></div>
                </div>
              </details>
            </section>
            {board.blueprint?.logline ? <p className="hint">{board.blueprint.logline}</p> : null}
            {board.input.song?.file ? (
              <div className="beat-meta-box" style={{ marginBottom: 12 }}>
                <div className="section-label">🎵 Song · {board.input.song.fileName} · ~{board.input.song.durationSeconds}s</div>
                <audio controls src={directorSongUrl(board.input.song.file)} style={{ width: "100%" }} />
                <p className="hint" style={{ margin: "4px 0 0" }}>
                  Timeline is locked to the song. After the final cut is stitched in the project
                  workspace, mix this song over it (the approved project carries the song along).
                </p>
              </div>
            ) : null}
            </div>
            <div id="director-panel-scenes-controls" hidden={activeDirectorTab !== "scenes"}>
            <div className="beat-meta-box dir-scene-inputs" aria-label="Inputs used for scene planning">
              <div className="section-label" style={{ marginBottom: 6 }}>Generate Scenes uses the processed project data</div>
              <div className="dir-scene-inputs-grid">
                <div><b>Story source</b><span>{chars.length} characters · {locs.length} locations · {objs.length} objects · scenes planned directly from narration or lyrics</span></div>
                <div><b>Audio timing</b><span>{!hasSceneAudio ? "No audio attached; no audio timeline is required"
                  : timelineApproval === "approved" && !masterTimeline?.stale
                    ? "Approved master audio timeline drives scene timing"
                    : masterTimeline?.stale
                      ? "Audio analysis is stale for the current source lines; scene timing falls back to estimates"
                      : board.lyric_timeline?.lines?.length
                        ? "Saved audio analysis is used; master timing is not locked until approved"
                        : "Audio is attached; line timing is estimated until analysis is available"}</span></div>
                <div><b>Visual references</b><span>{assetProduction?.skipped
                  ? "Asset stage was skipped; bible identity prompts are used"
                  : assetProduction?.status === "approved"
                    ? `${masterAssetsApproved.length} approved assets are referenced by ID; full prompts resolve after planning`
                    : "Storyboard bible identities and prompts ground the visuals"}</span></div>
                <div><b>Meaning & coverage</b><span>Each batch analyzes its source lines, uses the character/location/object bible, and checks meaningful phrases against visible actions.</span></div>
              </div>
            </div>
            <BatchSizeSelect value={sceneBatch} onChange={setSceneBatch} disabled={busy != null} />
            <div className="row" style={{ marginBottom: 8 }}>
              {board.scenes.length < sceneCap || timelineOpen ? (
                <button
                  className="primary"
                  onClick={() => void doScenes()}
                  disabled={busy != null || (assetProduction != null && assetProduction.status !== "approved")}
                  title={assetProduction != null && assetProduction.status !== "approved"
                    ? "Generate and approve the master assets first (or explicitly skip the asset stage)"
                    : (timelineOpen && board.scenes.length >= sceneCap
                      ? `The plan stopped early at ~${boardPlanned}s of ~${Math.round(boardTarget)}s — continue planning the rest of the timeline (the scene cap reopens automatically)`
                      : "Plan the remaining scenes (resumes on retry)")}
                >
                  {busy ? <Spinner size={13} /> : <IconFilm size={13} />}
                  {busy
                    ? `Planning…${sceneProgress ? ` ${sceneProgress}` : ""}`
                    : board.scenes.length
                      ? (timelineOpen && board.scenes.length >= sceneCap
                        ? `Continue planning (~${boardPlanned}s of ~${Math.round(boardTarget)}s · 🎞 ${boardBeats(board.scenes)} shots)`
                        : `Continue scenes (${board.scenes.length}/${sceneCap} · 🎞 ${boardBeats(board.scenes)}/${boardBeatsTotal(board.scenes, sceneCap)})`)
                      : "Generate scenes"}
                </button>
              ) : (
                <button className="btn-green" onClick={() => void doApprove()} disabled={busy != null} title="Create a standard project from these scenes and open it in the workspace for generation">
                  {busy ? <Spinner size={13} /> : <IconCheck size={13} />}
                  {busy ? "Approving…" : "Approve Storyboard"}
                </button>
              )}
              {!busy && timelineOpen && board.scenes.length >= sceneCap && (
                <button
                  className="ghost"
                  onClick={() => void doApprove()}
                  title={`Approve anyway with only ~${boardPlanned}s of ~${Math.round(boardTarget)}s planned — the rest of the story stays unplanned`}
                >
                  Approve short plan
                </button>
              )}
              {!busy && board.scenes.length > 0 && (board.scenes.length < board.sceneCount || timelineOpen) && (
                (() => {
                  const migrated = board.migratedScenes ?? (board.scenarioName ? board.scenes.length : 0);
                  const fresh = Math.max(0, board.scenes.length - (board.scenarioName ? migrated : 0));
                  return board.scenarioName ? (
                    <button
                      className="ghost"
                      onClick={() => void doMigratePartial()}
                      title={fresh
                        ? `Append the ${fresh} new scene${fresh === 1 ? "" : "s"} into existing project "${board.scenarioName}" — the rest can follow later the same way`
                        : `Re-migrate all ${board.scenes.length} planned scenes into "${board.scenarioName}"`}
                    >
                      {fresh ? `Migrate remaining (${fresh} new) → ${board.scenarioName}` : `Re-migrate → ${board.scenarioName}`}
                    </button>
                  ) : (
                    <button
                      className="ghost"
                      onClick={() => void doMigratePartial()}
                      title={`Migrate scenes 1–${board.scenes.length} of ${board.sceneCount} (🎞 ${boardBeats(board.scenes)} shots) into a project now — Continue plans the rest, Migrate remaining appends them later`}
                    >
                      Migrate partial ({board.scenes.length}/{board.sceneCount} · 🎞 {boardBeats(board.scenes)})
                    </button>
                  );
                })()
              )}
              {busy && (
                <button
                  className="ghost"
                  onClick={() => { cancelRef.current = true; abortRef.current?.abort(); }}
                  title="Stop now — planned scenes are kept, Continue resumes from the next scene"
                >
                  Stop
                </button>
              )}
              <button
                className="ghost"
                onClick={() => setShowAnalysis((s) => !s)}
                title={showAnalysis ? "Hide story analysis" : "Show story analysis"}
                aria-expanded={showAnalysis}
              >
                {showAnalysis ? "Hide analysis" : "Show analysis"}
              </button>
              <button
                className="ghost shotlist-btn"
                onClick={() => void doDuplicateBoard()}
                disabled={busy != null || duplicating}
                title="Copy characters, locations, objects + scene prompts exactly into a new versioned board (v2, then v3…) with no linked project — approve the copy to generate fresh images/videos"
              >
                {duplicating ? <Spinner size={11} /> : <span aria-hidden="true">⧉</span>}
                {duplicating ? "Duplicating…" : "Duplicate as v2+"}
              </button>
              <span className="spacer" />
              <button className="icon-btn danger" onClick={() => void doDeleteBoard()} disabled={busy != null} title={`Delete board "${board.input.title}"`} aria-label="Delete board">
                <IconTrash size={13} />
              </button>
            </div>
            {busy && sceneProgress && <p className="hint">{sceneProgress}{planRemainingMs != null && ` · ⏳ ${formatDuration(planRemainingMs)} left`} · partial scenes are kept — Stop resumes from the next scene.</p>}
              {!busy && stoppedNote && (board.scenes.length < sceneCap || timelineOpen) && (
              <p className="hint">{stoppedNote} Or migrate what's planned so far with Migrate partial — the rest can follow later.</p>
            )}
            {!busy && board.warn && (
              <p className="hint warn-text" title="Server-side grounding report for the latest scene batch (unknown cast/places repaired or skipped)">⚠️ {board.warn}</p>
            )}

            {showAnalysis && (
              <div className="beat-meta-box" style={{ marginBottom: 12 }}>
                {Object.entries(analysis).map(([k, v]) => (
                  <div key={k} style={{ marginBottom: 6 }}>
                    <div className="shotlist-detail-label">{k.replace(/_/g, " ")}</div>
                    <p style={{ margin: "2px 0 0" }}>{Array.isArray(v) ? v.map(String).join(", ") || "—" : (str(v) || (v == null ? "—" : str(v)))}</p>
                  </div>
                ))}
              </div>
            )}
            </div>

            {board.blueprint && (
              <div id="director-panel-assets" hidden={activeDirectorTab !== "assets"}>
                <div className="dir-master-assets-toolbar">
                  <div>
                    <div className="section-label">Characters &amp; World · Master Assets</div>
                    <p className="hint" style={{ margin: "3px 0 0" }}>
                      Descriptions, consistency rules, image prompts, previews, and approvals stay together on each asset card.
                    </p>
                  </div>
                  <span className="spacer" />
                  <span className="pill" title="Master character, location, and object reference images generated">
                    Images {masterAssetsGenerated.length}/{masterAssets.length}
                  </span>
                  <span className="pill">
                    {assetProduction?.status === "approved"
                      ? (assetProduction.skipped ? "skipped" : "approved")
                      : masterAssetsRendering ? "rendering…" : `${masterAssetsReady.length}/${masterAssets.length} ready`}
                  </span>
                  <div className="row dir-master-assets-actions">
                    <button
                      className="primary"
                      disabled={busy != null || assetBusy || masterAssetsRendering}
                      onClick={() => void doGenerateAssets()}
                      title="Queue master reference stills for assets with saved prompts"
                    >
                      {assetBusy || masterAssetsRendering ? <Spinner size={13} /> : <IconSparkles size={13} />}
                      Generate assets
                    </button>
                    <button
                      className="btn-green"
                      disabled={busy != null || assetBusy || masterAssetsReady.length === 0}
                      onClick={() => void doApproveAssets()}
                      title="Approve all generated master stills"
                    >
                      {assetBusy ? <Spinner size={13} /> : <IconCheck size={13} />}
                      Approve all
                    </button>
                    <button
                      className="ghost"
                      disabled={busy != null || assetBusy || assetProduction?.status === "approved"}
                      onClick={() => void doSkipAssets()}
                      title="Continue without master stills"
                    >
                      Skip stage
                    </button>
                  </div>
                </div>
                <div className="row" style={{ alignItems: "center", marginTop: 4 }}>
                  <div className="section-label" style={{ margin: 0 }}>Characters · {chars.length}</div>
                  <span className="spacer" />
                  <button
                    className="ghost shotlist-btn"
                    onClick={() => void doAddEntry("character")}
                    disabled={addingEntry != null || busy != null}
                    title="AI reads the story/lyrics + master settings + existing bible, then appends one new character"
                  >
                    {addingEntry === "character" ? <Spinner size={11} /> : <span aria-hidden="true">＋</span>}
                    {addingEntry === "character" ? "Adding…" : "Add character"}
                  </button>
                </div>
                {chars.length === 0 && addingEntry == null && (
                  <p className="hint" style={{ margin: "4px 0 0" }}>No characters yet — press Add character and the AI will invent one from the story.</p>
                )}
                <div
                  className="grid grid-bible"
                  style={{ gridTemplateColumns: `repeat(${Math.min(Math.max(chars.length, 1), 4)}, minmax(0, 1fr))` }}
                >
                  {chars.map((c, i) => (
                    <div className={`shot dir-bible-asset-card${masterAssetRendering(masterAssetFor("character", str(c.character_id))) ? " is-generating" : ""}`} key={String(c.character_id ?? i)}>
                      <div className="shot-head" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span aria-hidden="true" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                          {str(c.name) || `Character ${i + 1}`} · {str(c.role) || "supporting"}
                        </span>
                        <button
                          className="icon-btn"
                          onClick={() => void doRegenEntry("character", i)}
                          disabled={busy != null || addingEntry != null || regenEntry != null}
                          title={`Regenerate ${str(c.name) || `Character ${i + 1}`} with AI`}
                          aria-label={`Regenerate ${str(c.name) || `Character ${i + 1}`} with AI`}
                        >
                          {regenEntry?.kind === "character" && regenEntry.index === i ? <Spinner size={12} /> : <IconRefresh size={12} />}
                        </button>
                        <button
                          className="icon-btn danger"
                          onClick={() => void doDeleteChar(i)}
                          disabled={busy != null || addingEntry != null}
                          title={`Delete ${str(c.name) || `Character ${i + 1}`}`}
                          aria-label={`Delete ${str(c.name) || `Character ${i + 1}`}`}
                        >
                          <IconTrash size={12} />
                        </button>
                      </div>
                      <p className="hint" style={{ margin: 0 }}>{str(c.visual_identity_prompt) || [str(c.species), str(c.age)].filter(Boolean).join(" · ") || "—"}</p>
                      <div className="row" style={{ marginTop: 6 }}>
                        <button
                          className="ghost shotlist-btn"
                          onClick={() => startEditChar(i)}
                          title={`Edit ${str(c.name) || `Character ${i + 1}`} — CHARACTER CONSISTENCY prompt + rules`}
                        >
                          🔒 Consistency · {charRules(c).length}
                        </button>
                      </div>
                      {renderMasterAssetDetails(masterAssetFor("character", str(c.character_id)))}
                    </div>
                  ))}
                </div>
                {editingChar != null && chars[editingChar] && (
                  <div className="dlg-overlay" role="dialog" aria-modal="true" aria-label="Character consistency">
                    <div className="dlg-box char-popup" onClick={(e) => e.stopPropagation()}>
                      <h3 className="dlg-title">
                        🔒 {str(chars[editingChar].name) || `Character ${editingChar + 1}`} — Character Consistency
                      </h3>
                      <p className="dlg-message">
                        The prompt is pasted verbatim into every scene; the rules steer the AI on every
                        scene batch. Changes apply to future generations.
                      </p>
                      <label>Name</label>
                      <input value={charDraft.name ?? ""} maxLength={60} onChange={(e) => setCharDraft((d) => ({ ...d, name: e.target.value }))} />
                      <label style={{ marginTop: 8 }}>Role</label>
                      <input value={charDraft.role ?? ""} maxLength={40} onChange={(e) => setCharDraft((d) => ({ ...d, role: e.target.value }))} />
                      <label style={{ marginTop: 8 }}>CHARACTER CONSISTENCY prompt (verbatim into every image_prompt)</label>
                      <textarea
                        rows={5}
                        value={charDraft.visual_identity_prompt ?? ""}
                        placeholder="Species + body + face + eyes + colors + clothing, comma-separated…"
                        onChange={(e) => setCharDraft((d) => ({ ...d, visual_identity_prompt: e.target.value }))}
                      />
                      <div className="char-rules-head">
                        <label style={{ margin: 0 }}>Consistency rules · {ruleDraft.length}</label>
                        <button
                          className="ghost shotlist-btn"
                          onClick={() => { setRuleDraft([...DEFAULT_CHAR_RULES]); }}
                          title="Restore the pre-defined default rules"
                        >
                          Reset defaults
                        </button>
                      </div>
                      <div className="char-rules-list">
                        {ruleDraft.map((r, ri) => (
                          <div className="char-rule-row" key={ri}>
                            <input
                              value={r}
                              maxLength={240}
                              onChange={(e) => setRuleDraft((list) => list.map((x, xi) => (xi === ri ? e.target.value : x)))}
                              title={`Rule ${ri + 1} — editable, sent to the AI`}
                            />
                            <button
                              className="icon-btn danger"
                              onClick={() => setRuleDraft((list) => list.filter((_, xi) => xi !== ri))}
                              title={`Delete rule ${ri + 1}`}
                              aria-label={`Delete rule ${ri + 1}`}
                            >
                              <IconTrash size={12} />
                            </button>
                          </div>
                        ))}
                        {ruleDraft.length === 0 && (
                          <p className="hint" style={{ margin: "4px 0" }}>
                            No rules — the AI gets no per-character consistency instructions. Reset defaults to restore.
                          </p>
                        )}
                      </div>
                      <div className="char-rule-row" style={{ marginTop: 6 }}>
                        <input
                          value={newRule}
                          maxLength={240}
                          placeholder="Add a custom rule, e.g. Always keep the red scarf visible…"
                          onChange={(e) => setNewRule(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && newRule.trim()) {
                              e.preventDefault();
                              setRuleDraft((list) => [...list, newRule.trim()]);
                              setNewRule("");
                            }
                          }}
                          title="Type a custom consistency rule and press Enter or Add"
                        />
                        <button
                          className="ghost shotlist-btn"
                          disabled={!newRule.trim()}
                          onClick={() => {
                            if (!newRule.trim()) return;
                            setRuleDraft((list) => [...list, newRule.trim()]);
                            setNewRule("");
                          }}
                          title="Add this custom rule"
                        >
                          Add
                        </button>
                      </div>
                      <div className="dlg-actions">
                        <button className="ghost" onClick={() => setEditingChar(null)} title="Close without saving">
                          Cancel
                        </button>
                        <button className="primary" onClick={() => void saveEditChar()} disabled={savingChar} title="Save prompt + rules for this character">
                          {savingChar ? "Saving…" : "Save"}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {board.blueprint && (
              <div hidden={activeDirectorTab !== "assets"}>
              <>
                <div className="row" style={{ alignItems: "center", marginTop: 8 }}>
                  <div className="section-label" style={{ margin: 0 }}>World · {locs.length} location{locs.length === 1 ? "" : "s"} · {objs.length} object{objs.length === 1 ? "" : "s"}</div>
                  <span className="spacer" />
                  <button
                    className="ghost shotlist-btn"
                    onClick={() => void doAddEntry("location")}
                    disabled={addingEntry != null || busy != null}
                    title="AI reads the story/lyrics + master settings + existing bible, then appends one new location"
                  >
                    {addingEntry === "location" ? <Spinner size={11} /> : <span aria-hidden="true">＋</span>}
                    {addingEntry === "location" ? "Adding…" : "Add location"}
                  </button>
                  <button
                    className="ghost shotlist-btn"
                    onClick={() => void doAddEntry("object")}
                    disabled={addingEntry != null || busy != null}
                    title="AI reads the story/lyrics + master settings + existing bible, then appends one new object"
                  >
                    {addingEntry === "object" ? <Spinner size={11} /> : <span aria-hidden="true">＋</span>}
                    {addingEntry === "object" ? "Adding…" : "Add object"}
                  </button>
                </div>
                <div
                  className="grid grid-bible"
                  style={{ gridTemplateColumns: `repeat(${Math.min(Math.max(locs.length + objs.length, 1), 4)}, minmax(0, 1fr))` }}
                >
                  {locs.map((l, i) => (
                    <div className={`shot dir-bible-asset-card${masterAssetRendering(masterAssetFor("location", str(l.location_id))) ? " is-generating" : ""}`} key={String(l.location_id ?? `l${i}`)}>
                      <div className="shot-head" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span aria-hidden="true" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>📍 {str(l.name) || `Location ${i + 1}`}</span>
                        <button
                          className="icon-btn"
                          onClick={() => void doRegenEntry("location", i)}
                          disabled={busy != null || addingEntry != null || regenEntry != null}
                          title={`Regenerate ${str(l.name) || `Location ${i + 1}`} with AI`}
                          aria-label={`Regenerate ${str(l.name) || `Location ${i + 1}`} with AI`}
                        >
                          {regenEntry?.kind === "location" && regenEntry.index === i ? <Spinner size={12} /> : <IconRefresh size={12} />}
                        </button>
                        <button
                          className="icon-btn danger"
                          onClick={() => void doDeleteLoc(i)}
                          disabled={busy != null || addingEntry != null}
                          title={`Delete ${str(l.name) || `Location ${i + 1}`}`}
                          aria-label={`Delete ${str(l.name) || `Location ${i + 1}`}`}
                        >
                          <IconTrash size={12} />
                        </button>
                      </div>
                      <p className="hint" style={{ margin: 0 }}>{str(l.visual_identity_prompt) || str(l.description) || "—"}</p>
                      {renderMasterAssetDetails(masterAssetFor("location", str(l.location_id)))}
                    </div>
                  ))}
                  {objs.map((o, i) => (
                    <div className={`shot dir-bible-asset-card${masterAssetRendering(masterAssetFor("object", str(o.object_id))) ? " is-generating" : ""}`} key={String(o.object_id ?? `o${i}`)}>
                      <div className="shot-head" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span aria-hidden="true" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>🧭 {str(o.name) || `Object ${i + 1}`}</span>
                        <button
                          className="icon-btn"
                          onClick={() => void doRegenEntry("object", i)}
                          disabled={busy != null || addingEntry != null || regenEntry != null}
                          title={`Regenerate ${str(o.name) || `Object ${i + 1}`} with AI`}
                          aria-label={`Regenerate ${str(o.name) || `Object ${i + 1}`} with AI`}
                        >
                          {regenEntry?.kind === "object" && regenEntry.index === i ? <Spinner size={12} /> : <IconRefresh size={12} />}
                        </button>
                        <button
                          className="icon-btn danger"
                          onClick={() => void doDeleteObj(i)}
                          disabled={busy != null || addingEntry != null}
                          title={`Delete ${str(o.name) || `Object ${i + 1}`}`}
                          aria-label={`Delete ${str(o.name) || `Object ${i + 1}`}`}
                        >
                          <IconTrash size={12} />
                        </button>
                      </div>
                      <p className="hint" style={{ margin: 0 }}>{str(o.visual_identity_prompt) || str(o.description) || "—"}</p>
                      {renderMasterAssetDetails(masterAssetFor("object", str(o.object_id)))}
                    </div>
                  ))}
                </div>
              </>
              </div>
            )}

            {(board.scenes.length > 0 || sceneCap > 0 || busy != null || live?.active) && (
              <>
                <div hidden={activeDirectorTab !== "scenes"}>
                <div className="row" style={{ alignItems: "center" }}>
                  <div className="section-label" style={{ margin: 0 }}>Scenes · {board.scenes.length}/{sceneCap} · Shots {boardBeats(board.scenes)}/{boardBeatsTotal(board.scenes, sceneCap)}</div>
                  {(() => {
                    const beats = boardBeats(board.scenes);
                    const total = boardBeatsTotal(board.scenes, sceneCap);
                    return (
                      <span className="pill" title="Shots ARE scenes at generation time — each shot flattens to one image + video clip at approve time, so this shot total is the real generation total">
                        🎞 {beats}/{total} timed shots
                      </span>
                    );
                  })()}
                  {(() => {
                    const planned = boardPlannedSeconds(board.scenes);
                    const target = board.input.song?.durationSeconds ?? board.input.targetSeconds;
                    return (
                      <span className="pill" title="Planned story seconds vs the time target — the AI paces scenes itself until the timeline is covered">
                        ⏱ ~{planned}s / ~{Math.round(Number(target) || 0)}s
                      </span>
                    );
                  })()}
                  <label className="dir-scene-bulk-select">
                    <input
                      type="checkbox"
                      checked={board.scenes.length > 0 && board.scenes.every((scene) => selectedSceneNumbers.has(scene.scene_number))}
                      disabled={!board.scenes.length || busy != null}
                      onChange={(event) => setSelectedSceneNumbers(event.target.checked
                        ? new Set(board.scenes.map((scene) => scene.scene_number))
                        : new Set())}
                      aria-label="Select all scenes"
                    />
                    Select all
                  </label>
                  <button
                    className="ghost shotlist-btn danger"
                    disabled={!selectedSceneNumbers.size || busy != null}
                    onClick={() => void doDeleteSelectedScenes()}
                    title="Delete selected scenes"
                  >
                    <IconTrash size={12} /> Delete selected{selectedSceneNumbers.size ? ` (${selectedSceneNumbers.size})` : ""}
                  </button>
                  <span className="spacer" />
                  {(() => {
                    const groups = new Map<number, { shots: string[]; text: string }>();
                    for (const s of board.scenes) {
                      const pid = s.parent_line_id ?? s.lyric_line_id;
                      if (pid == null) continue;
                      const g = groups.get(pid) ?? { shots: [], text: str(s.lyric_text) };
                      if (s.shot_id) g.shots.push(s.shot_id);
                      if (!g.text && s.lyric_text) g.text = str(s.lyric_text);
                      groups.set(pid, g);
                    }
                    const multiCount = [...groups.keys()].filter((k) =>
                      board.scenes.filter((x) => (x.parent_line_id ?? x.lyric_line_id) === k).length > 1).length;
                    if (!groups.size) return null;
                    return (
                      <span
                        className="pill"
                        title={[...groups.entries()].map(([k, g]) =>
                          g.shots.length > 1
                            ? `Line ${k} → ${g.shots.length} shots (${g.shots.join(", ")})${g.text ? `: ${g.text.slice(0, 60)}` : ""}`
                            : `Line ${k} → 1 shot${g.text ? `: ${g.text.slice(0, 60)}` : ""}`
                        ).join("\n")}
                      >
                        🎵 {groups.size} lyric line{groups.size === 1 ? "" : "s"}{multiCount ? ` · ${multiCount} multi-shot` : ""}
                      </span>
                    );
                  })()}
                </div>
                <div className="dir-scene-rows" aria-label="Scenes with timed shots">
                  {(() => {
                    const lines = sourceLinesOf(board);
                    return board.scenes.map((s, i) => {
                    const selected = selectedScene === i;
                    const shots = sceneShots(s);
                    const dlgCount = (s.dialogue ?? []).length
                      + shots.reduce((a, sh) => a + ((sh.dialogue ?? []) as unknown[]).length, 0);
                    const cov = sceneCoverage(s, lines);
                    // Live typing for freshly landed scenes: cumulative start
                    // delays replay the row line by line (title → shots/action
                    // → coverage). Older scenes render static text as before.
                    const typing = !reduceMotion && typingScenes.includes(s.scene_number);
                    let typeAt = 0;
                    const typeDelay = (len: number) => {
                      const cur = typeAt;
                      typeAt += Math.min(Math.max(0, len), 400) * TYPE_CHAR_MS + TYPE_LINE_GAP_MS;
                      return cur;
                    };
                    return (
                      <div className={`dir-scene-row shot-count-${Math.min(shots.length, 4)}${selected ? " selected" : ""}${typing ? " typing" : ""}`} key={s.scene_number} id={`dir-scene-${s.scene_number}`}>
                        <div className="dir-scene-row-head">
                          <span className="pill" aria-hidden="true" title={`Scene ${s.scene_number} of ${sceneCap}`}>
                            {s.scene_number}/{sceneCap}
                          </span>
                          <label className="dir-scene-row-check">
                            <input
                              type="checkbox"
                              checked={selectedSceneNumbers.has(s.scene_number)}
                              disabled={busy != null}
                              onChange={(event) => setSelectedSceneNumbers((current) => {
                                const next = new Set(current);
                                if (event.target.checked) next.add(s.scene_number);
                                else next.delete(s.scene_number);
                                return next;
                              })}
                              aria-label={`Select Scene ${s.scene_number}`}
                              title={`Select Scene ${s.scene_number}`}
                            />
                          </label>
                          <span className="dir-scene-row-title" title={s.title}>
                            <TypedText text={s.title} animate={typing} delayMs={typeDelay(str(s.title).length)} />
                          </span>
                          <span className="muted" style={{ fontSize: 11 }} title={shots.length ? "Scene timeline = sum of its shots" : "Scene duration"}>
                            ⏱ {fmtT(s.duration_seconds)}{shots.length ? ` · ${shots.length} shot${shots.length === 1 ? "" : "s"}` : ""}
                            {dlgCount ? ` · 🎙 ${dlgCount}` : ""}
                          </span>
                          {((s.shot_id || s.parent_line_id != null) || s.continuity_required) && (
                            <span className="muted" style={{ fontSize: 11 }}>
                              {s.shot_id ? `🎞 ${s.shot_id}` : s.parent_line_id != null ? `🎞 Line ${s.parent_line_id}` : ""}
                              {s.song_start_time != null && s.song_end_time != null ? ` · ${s.song_start_time}–${s.song_end_time}s` : ""}
                              {s.continuity_required ? ` · 🔗 ${str(s.reference_source) || "PREV"}` : ""}
                            </span>
                          )}
                          <span className="dir-scene-row-actions">
                            <button
                              className={`ghost shotlist-btn${selected ? " on" : ""}`}
                              onClick={() => openSceneDetails(i)}
                              title={`Open the full breakdown of Scene ${s.scene_number} in a popup`}
                            >
                              Details
                            </button>
                            <button className="ghost shotlist-btn" onClick={() => openSceneEdit(i)} title={`Edit Scene ${s.scene_number} in a popup`}>
                              Edit
                            </button>
                            <button
                              className="ghost shotlist-btn"
                              disabled={regenScene != null || busy != null}
                              onClick={() => void doRegenScene(i)}
                              title={regenScene === i ? "Regenerating…" : `Regenerate Scene ${s.scene_number} with the AI Director`}
                            >
                              {regenScene === i ? <Spinner size={11} /> : <IconRefresh size={11} />}
                              {regenScene === i ? "Working…" : "Regen"}
                            </button>
                            <button
                              className="ghost shotlist-btn"
                              onClick={() => void showScenePrompt(i)}
                              disabled={busy != null}
                              title={busy ? "Planning busy" : `Show prompt for Scene ${s.scene_number}`}>
                              📝
                            </button>
                            <button
                              className="icon-btn danger"
                              onClick={() => void doDeleteScene(i)}
                              disabled={busy != null}
                              title={`Delete Scene ${s.scene_number}`}
                              aria-label={`Delete Scene ${s.scene_number}`}
                            >
                              <IconTrash size={12} />
                            </button>
                          </span>
                        </div>
                        {((s as DirectorScene & { source_line?: string; semantic_meaning?: string; action_plan?: { action: string }[]; camera_rationale?: string }).source_line
                          || (s as DirectorScene & { semantic_meaning?: string }).semantic_meaning) && (
                          <div className="dir-scene-meaning" style={{ fontSize: 11, margin: "2px 0 4px" }}>
                            <span title="The original source line this scene shows">
                              🔤 {str((s as DirectorScene & { source_line?: string }).source_line).slice(0, 120)}
                            </span>
                            {(s as DirectorScene & { semantic_meaning?: string }).semantic_meaning && (
                              <span className="muted" title="What the line means — the scene must SHOW it">
                                {" → "}{str((s as DirectorScene & { semantic_meaning?: string }).semantic_meaning).slice(0, 140)}
                              </span>
                            )}
                            {((s as DirectorScene & { action_plan?: { action: string }[] }).action_plan || []).length > 0 && (
                              <span className="muted" title="The visible action the model must render">
                                {" · 🎬 "}{(s as DirectorScene & { action_plan?: { action: string }[] }).action_plan!.map((a) => str(a.action)).join(" · ").slice(0, 160)}
                              </span>
                            )}
                          </div>
                        )}
                        <div className="dir-shot-strip" role="list" aria-label={`Timed shots of Scene ${s.scene_number}`}>
                          {shots.length ? shots.map((sh, k) => {
                            const seg = str(sh.lyric_segment) || str(sh.action) || "—";
                            const dlg = ((sh.dialogue ?? []) as unknown[]).length;
                            return (
                              <div
                                className="dir-shot"
                                role="listitem"
                                key={str(sh.shot_id) || k}
                                style={{ flexGrow: Math.max(1, Number(sh.duration_seconds) || 1) }}
                                title={`${s.scene_number}.${k + 1}${sh.shot_id ? ` (${sh.shot_id})` : ""} · ${fmtRange(sh.start_time, sh.end_time)} of ${fmtT(s.duration_seconds)}${sh.semantic_meaning ? ` — ${sh.semantic_meaning}` : ""}`}
                              >
                                <div className="dir-shot-head" aria-hidden="true">
                                  <span>{s.scene_number}.{k + 1}{sh.shot_id ? ` · ${sh.shot_id}` : ""}</span>
                                  <span className="dir-shot-time">{fmtRange(sh.start_time, sh.end_time)}</span>
                                </div>
                                <div className="dir-shot-seg" title={seg}>
                                  <TypedText text={seg} animate={typing} delayMs={typeDelay(seg.length)} />
                                </div>
                                <span className="dir-shot-meta">
                                  {sh.camera?.shot_type ?? ""}{sh.camera?.movement ? ` · ${sh.camera.movement}` : ""} · {fmtT(sh.duration_seconds)}
                                  {sh.objects?.length ? ` · 🧺 ${sh.objects.map(objectLabel).join(", ")}` : ""}
                                  {dlg ? ` · 🎙 ${dlg}` : ""}
                                </span>
                                <div className="row" style={{ marginTop: 4, gap: 4 }}>
                                  <button
                                    className="ghost shotlist-btn"
                                    onClick={() => openShotDetails(i, k)}
                                    title={`Open the full breakdown of Shot ${s.scene_number}.${k + 1} in a popup`}
                                  >
                                    Details
                                  </button>
                                  <button
                                    className="ghost shotlist-btn"
                                    onClick={() => openShotEdit(i, k)}
                                    disabled={busy != null}
                                    title={`Edit Shot ${s.scene_number}.${k + 1} in a popup`}
                                  >
                                    Edit
                                  </button>
                                </div>
                              </div>
                            );
                          }) : (
                            <div className="dir-shot" style={{ flexGrow: 1 }} title={`Scene ${s.scene_number} · ${fmtT(s.duration_seconds)}`}>
                              <div className="dir-shot-head" aria-hidden="true">
                                <span>{s.scene_number}.1</span>
                                <span className="dir-shot-time">{fmtT(s.duration_seconds)}</span>
                              </div>
                              <div className="dir-shot-seg" title={s.action || ""}>
                                <TypedText text={s.action || "—"} animate={typing} delayMs={typeDelay(str(s.action).length)} />
                              </div>
                              <span className="dir-shot-meta">
                                {s.camera?.shot_type ?? ""}{s.camera?.movement ? ` · ${s.camera.movement}` : ""} · {fmtT(s.duration_seconds)}
                                {s.objects?.length ? ` · 🧺 ${s.objects.map(objectLabel).join(", ")}` : ""}
                                {Array.isArray(s.dialogue) && s.dialogue.length ? ` · 🎙 ${s.dialogue.length}` : ""}
                              </span>
                            </div>
                          )}
                        </div>
                        {cov && (() => {
                          const covText = cov.length > 160 ? `${cov.slice(0, 160)}…` : cov;
                          return (
                            <p className="hint" style={{ margin: "6px 0 0" }} title={`Source lines covered by Scene ${s.scene_number}: ${cov}`}>
                              📖 <TypedText text={covText} animate={typing} delayMs={typeDelay(covText.length)} />
                            </p>
                          );
                        })()}
                      </div>
                    );
                    });
                  })()}
                  {live?.active && (
                    <div
                      className="dir-scene-row typing live"
                      aria-live="polite"
                      title="Read-only live view of the running LLM batch — planning is unaffected"
                    >
                      <div className="dir-scene-row-head">
                        <span className="pill live-pill" aria-hidden="true">🔴 LIVE</span>
                        <span className="dir-scene-row-title">
                          Scenes {live.batchFrom ?? "…"}–{live.batchTo ?? "…"}{" "}
                          {live.thinking && !live.tail ? "thinking…" : "writing…"}
                          {live.scenes.length > 0 && ` · ${live.scenes.length} scene${live.scenes.length === 1 ? "" : "s"} complete in stream`}
                        </span>
                        <span className="muted" style={{ fontSize: 11 }}>
                          {live.llmElapsedMs != null
                            ? `LLM ${formatDuration(live.llmElapsedMs)}${live.currentAttempt && live.currentAttempt > 1 ? ` · attempt ${live.currentAttempt}` : ""}`
                            : `${live.llmAttempts?.length ? "Post-processing" : "Preparing"} · ${formatDuration(live.elapsedMs || 0)}`}
                          {live.elapsedMs != null && live.llmElapsedMs != null && ` · batch ${formatDuration(live.elapsedMs)}`}
                        </span>
                        <span className="muted" style={{ fontSize: 11 }}>read-only · planning unaffected</span>
                      </div>
                      {live.scenes.map((ps, k) => (
                        <div className="live-scene" key={ps.scene_number || `live-${k}`}>
                          <span className="live-scene-num" aria-hidden="true">
                            {ps.scene_number ? `S${ps.scene_number}` : "S…"}
                          </span>
                          <span className="live-scene-body">
                            <span className="live-scene-title" title={ps.title}>
                              {ps.title || `Scene ${ps.scene_number || "…"}`}
                            </span>
                            {ps.action && (
                              <span className="live-scene-text" title={ps.action}>{ps.action}</span>
                            )}
                          </span>
                        </div>
                      ))}
                      {/* Thinking phase of a reasoning model (qwen3.5…): the
                          content stream is still empty, so show the model's
                          own reasoning tail — visible typing while it thinks. */}
                      {!!live.thinking && !live.tail && !!live.reasoning && (
                        <p className="hint live-tail" style={{ margin: "6px 0 0", opacity: 0.8 }}>
                          <span style={{ color: "var(--accent)" }}>Thinking… </span>
                          {live.reasoning.slice(-600)}
                          <span className="typing-caret" aria-hidden="true" />
                        </p>
                      )}
                      {!!live.tail && (
                        <p className="hint live-tail" style={{ margin: "6px 0 0" }}>
                          {live.tail}
                          <span className="typing-caret" aria-hidden="true" />
                        </p>
                      )}
                    </div>
                  )}
                  {!live?.active && board.scenePlanningMetrics?.batches?.length ? (() => {
                    const latest = board.scenePlanningMetrics.batches[board.scenePlanningMetrics.batches.length - 1];
                    const retryCount = Math.max(0, latest.attempts.length - 1);
                    return (
                      <p className="hint" style={{ margin: "8px 0", fontSize: 11 }} title="Scene planning timing for the most recently completed batch">
                        Last batch · prep {formatDuration(latest.preparationMs)} · LLM {formatDuration(latest.llmMs)} · post-process {formatDuration(latest.postLlmMs)} · total {formatDuration(latest.totalMs)} · {latest.accepted}/{latest.requested} scenes accepted{retryCount ? ` · ${retryCount} retry` : ""}
                      </p>
                    );
                  })() : null}
                  {Array.from({ length: Math.max(0, sceneCap - board.scenes.length) }, (_, k) => {
                    const num = board.scenes.length + 1 + k;
                    const isGen = generatingRange != null && num >= generatingRange.from && num <= generatingRange.to;
                    const eta = planSceneEta(num);
                    return (
                      <div
                        className={`dir-scene-row shot-count-1 pending${isGen ? " generating" : " is-queued"}`}
                        key={`pending-${num}`}
                        id={`dir-scene-pending-${num}`}
                        aria-label={`Scene ${num} ${isGen ? "generating" : "to be generated"}${eta != null ? `, about ${formatDuration(eta)} remaining` : ""}`}
                      >
                        <div className="dir-scene-row-head">
                          <span className="pill" aria-hidden="true">Scene {num}/{sceneCap}</span>
                          {isGen ? (
                            <p className="hint" style={{ margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
                              <Spinner size={11} /> Generating…{eta != null && ` · ~${formatDuration(eta)} left`}
                            </p>
                          ) : (
                            <p className="hint" style={{ margin: 0 }}>To be Generated{eta != null && ` · ~${formatDuration(eta)}`}</p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                </div>
                {sceneModal && (() => {
                  const d = board.scenes[sceneModal.index];
                  if (!d) return null;
                  const isEdit = sceneModal.mode === "edit" && editingScene === sceneModal.index;
                  const mShots = sceneShots(d);
                  // Shot-focused popup (opened from a shot card's Details/Edit
                  // buttons); null = whole-scene popup as before.
                  const focusShot = sceneModal.shot != null && mShots.length
                    ? Math.min(sceneModal.shot, mShots.length - 1)
                    : null;
                  const fShot = focusShot != null ? mShots[focusShot] : null;
                  const draftShots = sceneShots({ ...d, ...sceneDraft } as DirectorScene);
                  const eShot = focusShot != null ? (draftShots[focusShot] ?? fShot) : null;
                  const headTitle = isEdit
                    ? (focusShot != null && fShot
                      ? `✏️ Edit Shot ${d.scene_number}.${focusShot + 1}${fShot.shot_id ? ` (${fShot.shot_id})` : ""}`
                      : `✏️ Edit Scene ${d.scene_number}/${board.sceneCount}`)
                    : (focusShot != null && fShot
                      ? `🎬 Shot ${d.scene_number}.${focusShot + 1}${fShot.shot_id ? ` (${fShot.shot_id})` : ""}`
                      : `🎬 Scene ${d.scene_number}/${board.sceneCount}`);
                  // Absolute ends of the flat (scene, shot) walk for nav state.
                  const atFirstShot = sceneModal.index <= 0 && (focusShot ?? 0) <= 0;
                  const atLastShot = sceneModal.index >= board.scenes.length - 1 &&
                    (focusShot == null || focusShot >= mShots.length - 1);
                  // Shot-focused bodies (single shot + shot navigation).
                  if (focusShot != null && fShot) {
                    return (
                      <div className="dlg-overlay" role="dialog" aria-modal="true" aria-label={`${isEdit ? "Edit" : "Details of"} Shot ${d.scene_number}.${focusShot + 1}`}>
                        <div className="dlg-box scene-popup shot-popup" onClick={(e) => e.stopPropagation()}>
                          <div className="row shot-popup-head" data-drag-handle style={{ alignItems: "center", marginBottom: 8 }}>
                            <h3 className="dlg-title" style={{ margin: 0, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}>
                              {headTitle} — {isEdit ? str(sceneDraft.title ?? d.title) || d.title : d.title}
                            </h3>
                            <button className="icon-btn" onClick={() => closeSceneModal()} title="Close popup" aria-label="Close popup">
                              ✕
                            </button>
                          </div>
                          {isEdit && eShot ? (
                            <>
                              {renderShotEditor(d, focusShot, eShot)}
                              <div className="dlg-actions" style={{ marginTop: 12 }}>
                                <button
                                  className="ghost"
                                  onClick={() => setSceneModal({ index: sceneModal.index, mode: "details", shot: focusShot })}
                                  title="Back to the shot breakdown without saving"
                                >
                                  Back
                                </button>
                                <button className="primary" onClick={() => void saveEditScene()} title={`Save Shot ${d.scene_number}.${focusShot + 1} (scene timings re-tiled automatically)`}>
                                  Save shot
                                </button>
                              </div>
                            </>
                          ) : (
                            <>
                              {renderShotDetails(d, sceneModal.index, focusShot, fShot, true)}
                              <div className="row" style={{ marginTop: 12 }}>
                                <button
                                  className="ghost shotlist-btn"
                                  disabled={atFirstShot}
                                  onClick={() => stepShotModal(-1)}
                                  title="Previous shot"
                                >
                                  ← Prev
                                </button>
                                <button
                                  className="ghost shotlist-btn"
                                  disabled={atLastShot}
                                  onClick={() => stepShotModal(1)}
                                  title="Next shot"
                                >
                                  Next →
                                </button>
                                <span className="spacer" />
                                <button
                                  className="ghost shotlist-btn"
                                  onClick={() => openShotEdit(sceneModal.index, focusShot)}
                                  disabled={busy != null}
                                  title={`Edit Shot ${d.scene_number}.${focusShot + 1}`}
                                >
                                  Edit shot
                                </button>
                                <button className="primary" onClick={() => closeSceneModal()} title="Close popup">
                                  Close
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div className="dlg-overlay" role="dialog" aria-modal="true" aria-label={isEdit ? `Edit Scene ${d.scene_number}` : `Scene ${d.scene_number} details`}>
                      <div className="dlg-box scene-popup" onClick={(e) => e.stopPropagation()}>
                        <div className="row" style={{ alignItems: "center", marginBottom: 8 }}>
                          <h3 className="dlg-title" style={{ margin: 0, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}>
                            {isEdit ? `✏️ Edit Scene ${d.scene_number}/${board.sceneCount}` : `🎬 Scene ${d.scene_number}/${board.sceneCount}`} — {isEdit ? str(sceneDraft.title ?? d.title) || d.title : d.title}
                          </h3>
                          <button className="icon-btn" onClick={() => closeSceneModal()} title="Close popup" aria-label="Close popup">
                            ✕
                          </button>
                        </div>
                        {isEdit ? (
                          <>
                            <label>Title</label>
                            <input value={str(sceneDraft.title ?? "")} maxLength={80} onChange={(e) => setSceneDraft((x) => ({ ...x, title: e.target.value }))} />
                            <label style={{ marginTop: 6 }}>Action (visible behavior)</label>
                            <textarea rows={3} value={str(sceneDraft.action ?? "")} onChange={(e) => setSceneDraft((x) => ({ ...x, action: e.target.value }))} />
                            <label style={{ marginTop: 6 }} title="Physical movement or change over the scene duration; do not describe appearance">Motion</label>
                            <textarea rows={2} value={str(sceneDraft.motion ?? "")} placeholder="e.g. slowly raises his tail, then holds still" onChange={(e) => setSceneDraft((x) => ({ ...x, motion: e.target.value }))} />
                            <label style={{ marginTop: 6 }}>Emotion</label>
                            <input value={str(sceneDraft.emotion ?? "")} maxLength={60} onChange={(e) => setSceneDraft((x) => ({ ...x, emotion: e.target.value }))} />
                            <label style={{ marginTop: 6 }} title="Exact lyric words this shot visualizes (song boards)">Lyric segment</label>
                            <input value={str(sceneDraft.lyric_segment ?? "")} maxLength={300} placeholder="Exact words this shot visualizes…" onChange={(e) => setSceneDraft((x) => ({ ...x, lyric_segment: e.target.value }))} />
                            <label style={{ marginTop: 6 }} title="The visible event on screen for this shot">Visual event</label>
                            <input value={str(sceneDraft.visual_event ?? "")} maxLength={300} placeholder="Visible event on screen…" onChange={(e) => setSceneDraft((x) => ({ ...x, visual_event: e.target.value }))} />
                            <label style={{ marginTop: 6 }}>Duration (sec)</label>
                            <input type="number" min={1} max={30} value={Number(sceneDraft.duration_seconds ?? d.duration_seconds)} onChange={(e) => setSceneDraft((x) => ({ ...x, duration_seconds: Number(e.target.value) }))} />
                            <label style={{ marginTop: 6 }}>Source narration (verbatim)</label>
                            <textarea rows={3} value={str(sceneDraft.narration ?? d.narration ?? "")} placeholder="Exact narration lines covered by this scene" onChange={(e) => setSceneDraft((x) => ({ ...x, narration: e.target.value }))} />
                            {sceneShots({ ...d, ...sceneDraft } as DirectorScene).length > 0 && (
                              <>
                                <label style={{ marginTop: 8 }} title="Each shot renders its own image + video clip; widths in the scene row follow these durations">
                                  Timed shots (durations must sum to the scene total — saved automatically)
                                </label>
                                {sceneShots({ ...d, ...sceneDraft } as DirectorScene).map((sh, k) => renderShotEditor(d, k, sh))}
                              </>
                            )}
                            <label style={{ marginTop: 6 }} title="One per line as speaker: line — voiced per character (Edge-TTS Hindi) and lip-synced; the clip grows to fit the voice">Dialogue (speaker: line per line — voiced + lip-synced)</label>
                            <textarea rows={3} value={dialogueDraft} placeholder={"chiku: नमस्ते! मैं चीकू हूँ।\nshera: कौन है वहाँ?"} onChange={(e) => setDialogueDraft(e.target.value)} />
                            <label style={{ marginTop: 6 }}>Image prompt</label>
                            <textarea rows={4} value={str(sceneDraft.image_prompt ?? "")} onChange={(e) => setSceneDraft((x) => ({ ...x, image_prompt: e.target.value }))} />
                            <label style={{ marginTop: 6 }}>Video prompt</label>
                            <textarea rows={4} value={str(sceneDraft.video_prompt ?? "")} onChange={(e) => setSceneDraft((x) => ({ ...x, video_prompt: e.target.value }))} />
                            <div className="dlg-actions" style={{ marginTop: 12 }}>
                              <button className="ghost" onClick={() => { setEditingScene(null); setSceneModal({ index: sceneModal.index, mode: "details" }); }} title="Back to the full breakdown without saving">
                                Back
                              </button>
                              <button className="primary" onClick={() => void saveEditScene()} title="Save changes to this scene">
                                Save scene
                              </button>
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="shotlist-detail-grid">
                              <div>
                                {d.narration && <><div className="shotlist-detail-label">Source narration</div><p>{d.narration}</p></>}
                              </div>
                              <div>
                                <div className="shotlist-detail-label">Duration</div>
                                <p>{d.duration_seconds}s</p>
                              </div>
                            </div>
                            {(d.lyric_text || d.lyric_segment || d.shot_id || d.parent_line_id != null) && (
                              <>
                                <div className="shotlist-detail-label">
                                  Lyric {d.shot_id ? `· Shot ${d.shot_id}` : d.parent_line_id != null ? `· Line ${d.parent_line_id}` : ""}
                                  {d.song_start_time != null && d.song_end_time != null ? ` · ${d.song_start_time}–${d.song_end_time}s` : ""}
                                </div>
                                <p>{d.lyric_text || "—"}</p>
                                {(d.lyric_segment || d.semantic_meaning || d.visual_event) && (
                                  <>
                                    <div className="shotlist-detail-label">Segment → meaning → visual event</div>
                                    <p>
                                      {d.lyric_segment ? <><b>“{d.lyric_segment}”</b>{d.semantic_meaning || d.visual_event ? " → " : ""}</> : null}
                                      {[d.semantic_meaning, d.visual_event].filter(Boolean).join(" → ") || "—"}
                                    </p>
                                  </>
                                )}
                                {(d.continuity_required || (d.reference_source && d.reference_source !== "NONE")) && (
                                  <>
                                    <div className="shotlist-detail-label">Continuity reference</div>
                                    <p>
                                      🔗 {d.reference_source || "PREVIOUS_IMAGE"}
                                      {Array.isArray(d.continuity_refs) && d.continuity_refs.length ? ` (${d.continuity_refs.join(", ")})` : ""}
                                    </p>
                                  </>
                                )}
                              </>
                            )}
                            {sceneShots(d).length > 0 && (
                              <>
                                <div className="shotlist-detail-label">
                                  Timed shots · {sceneShots(d).length} (each renders one clip) · {fmtT(d.duration_seconds)} total
                                </div>
                                {sceneShots(d).map((sh, k) => renderShotDetails(d, sceneModal.index, k, sh))}
                              </>
                            )}
                            <div className="shotlist-detail-grid">
                              <div>
                                <div className="shotlist-detail-label">Characters</div>
                                <p>{d.characters?.join(", ") || "—"}</p>
                              </div>
                              <div>
                                <div className="shotlist-detail-label">Location</div>
                                <p>{d.location || "—"}</p>
                              </div>
                            </div>
                            <div className="shotlist-detail-grid">
                              <div>
                                <div className="shotlist-detail-label">Time of day</div>
                                <p>{d.time_of_day || "—"}</p>
                              </div>
                              <div>
                                <div className="shotlist-detail-label">Emotion</div>
                                <p>{d.emotion || "—"}</p>
                              </div>
                            </div>
                            <div className="shotlist-detail-label">Action</div>
                            <p>{d.action || "—"}</p>
                            {(d as DirectorScene & { dramatic_purpose?: string }).dramatic_purpose && (
                              <>
                                <div className="shotlist-detail-label">Dramatic purpose</div>
                                <p>🎯 {(d as DirectorScene & { dramatic_purpose?: string }).dramatic_purpose}</p>
                              </>
                            )}
                            {Array.isArray((d as DirectorScene & { characters_detailed?: { character_id: string; role?: string; emotion?: string; gaze_target?: string; action?: string }[] }).characters_detailed) && (d as DirectorScene & { characters_detailed?: { character_id: string; role?: string; emotion?: string; gaze_target?: string; action?: string }[] }).characters_detailed!.length > 0 && (
                              <>
                                <div className="shotlist-detail-label">Per-character direction</div>
                                <p>{(d as DirectorScene & { characters_detailed?: { character_id: string; role?: string; emotion?: string; gaze_target?: string; action?: string }[] }).characters_detailed!.map((c) =>
                                  `🧍 ${c.character_id}${c.role ? ` (${c.role})` : ""}${c.action ? `: ${c.action}` : ""}${c.gaze_target ? ` 👀 ${c.gaze_target}` : ""}${c.emotion ? ` · ${c.emotion}` : ""}`,
                                ).join("  |  ")}</p>
                              </>
                            )}
                            <div className="shotlist-detail-label">Expression / body language</div>
                            <p>{[d.expression, d.body_language].filter(Boolean).join(" · ") || "—"}</p>
                            <div className="shotlist-detail-label">Motion</div>
                            <p>{str(d.motion) || (str(d.action) ? `From action: ${str(d.action)}` : "—")}</p>
                            <div className="shotlist-detail-label">Camera</div>
                            <p>{[d.camera?.shot_type, d.camera?.angle, d.camera?.movement].filter(Boolean).join(" · ") || "—"}</p>
                            <div className="shotlist-detail-grid">
                              <div>
                                <div className="shotlist-detail-label">Lighting</div>
                                <p>{d.lighting || "—"}</p>
                              </div>
                              <div>
                                <div className="shotlist-detail-label">Environment</div>
                                <p>{d.environment || "—"}</p>
                              </div>
                            </div>
                            <div className="shotlist-detail-label">Continuity from previous</div>
                            <p>{d.continuity_from_previous_scene || "—"}</p>
                            <div className="shotlist-detail-label">Transition to next</div>
                            <p>{d.transition_to_next_scene || "—"}</p>
                            <div className="shotlist-detail-label">Image prompt</div>
                            <p>{d.image_prompt || "—"}</p>
                            <div className="shotlist-detail-label">Video prompt</div>
                            <p>{d.video_prompt || "—"}</p>
                            <div className="shotlist-detail-label">Dialogue (voiced per character + lip-synced)</div>
                            {Array.isArray(d.dialogue) && d.dialogue.length ? (
                              <p>{d.dialogue.map((x, li) => (
                                <span key={li} title={`${x.speaker} (voice: per-character Hindi TTS)`}>
                                  <b>{x.speaker || "voice"}</b>: {x.line}{li < d.dialogue.length - 1 ? <br /> : null}
                                </span>
                              ))}</p>
                            ) : (
                              <p>—</p>
                            )}
                            <div className="row" style={{ marginTop: 12 }}>
                              <button
                                className="ghost shotlist-btn"
                                disabled={sceneModal.index <= 0}
                                onClick={() => stepSceneModal(-1)}
                                title="Previous scene"
                              >
                                ← Prev
                              </button>
                              <button
                                className="ghost shotlist-btn"
                                disabled={sceneModal.index >= board.scenes.length - 1}
                                onClick={() => stepSceneModal(1)}
                                title="Next scene"
                              >
                                Next →
                              </button>
                              <span className="spacer" />
                              <button
                                className="ghost shotlist-btn"
                                onClick={() => openSceneEdit(sceneModal.index)}
                                title={`Edit Scene ${d.scene_number}`}
                              >
                                Edit scene
                              </button>
                              <button className="primary" onClick={() => closeSceneModal()} title="Close popup">
                                Close
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </>
            )}
          </>
        )}
      </Collapse>
    </section>
      {boardsOpen ? (
        <aside className="card dir-rail" aria-label="Saved storyboards">
          <div className="card-head">
            <h2>
              <span className="head-icon hi-output" aria-hidden="true"><IconFolder size={15} /></span>
              Saved Storyboards
            </h2>
            <span className="muted" title={`${boards.length} boards stored in the database`}>{boards.length}</span>
            <span className="spacer" />
            <button
              className="icon-btn"
              onClick={toggleBoards}
              title="Collapse saved storyboards to the right"
              aria-label="Collapse saved storyboards"
              aria-expanded="true"
            >
              <IconPanel size={15} />
            </button>
          </div>
          {boardsPanel}
        </aside>
      ) : (
        <button
          className="sidebar-show rail-right"
          onClick={toggleBoards}
          title="Show saved storyboards"
          aria-label="Show saved storyboards"
          aria-expanded="false"
          type="button"
        >
          <IconFolder size={15} />
          <span className="sidebar-show-label">Boards</span>
        </button>
      )}
    </div>
    {/* Generation copy just below the AI Story Director: Render Clip +
        Generate Reference + Keyframes → clips + YouTube/Instagram cut,
        scoped to this board's linked project. Shot-aware via the board's
        flattened shot-beats (one beat per shot). Rendered only when a board
        is open so planning flow is untouched. */}
    {board && (
      <div hidden={activeDirectorTab !== "media" && activeDirectorTab !== "export"}>
      {board.scenarioName ? (
        <DirectorGeneration
          projectName={board.scenarioName}
          boardScenes={board.scenes}
          onOpenProject={onOpenProject}
          imageMode={imageMode}
          onImageMode={onImageMode}
          activeSection={activeDirectorTab === "export" ? "export" : "media"}
          onStatus={onDirectorGenerationStatus}
        />
      ) : (
        <section className="card" aria-label="Generation" style={{ marginTop: 12 }}>
          <div className="card-head">
            <h2>🎬 Generation</h2>
            <span className="spacer" />
            <span className="pill" title="Approve or migrate the storyboard to create its project first">
              {board.scenes.length}/{sceneCap} scenes planned
            </span>
          </div>
          <p className="hint" style={{ margin: "8px 0 0" }}>
            Approve the storyboard (or Migrate partial) to create its project — Render Clip, Generate Reference,
            Keyframes → clips and the YouTube/Instagram cuts appear here for that project. Nothing here changes
            planning; it only generates for the linked project once it exists.
          </p>
        </section>
      )
      }
      </div>
    )}
    {/* 🔍 Prompt preview popup: the exact system + user messages the next
        Continue would send to the LLM (dry run — no model call, nothing
        saved). Built server-side by the same batch planner as the real call. */}
    {addNewOpen && (
      <div className="dlg-overlay" role="dialog" aria-modal="true" aria-label="Add new AI story">
        <div className="dlg-box" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 620, width: "min(620px, 94vw)" }}>
          <h3 className="dlg-title">＋ Add New AI Story</h3>
          <p className="dlg-message">Choose an existing project, select its processed Director tabs to import, and name the new story.</p>
          <label htmlFor="director-import-project">Existing project</label>
          <select
            id="director-import-project"
            value={addNewSourceId}
            onChange={(e) => void selectAddNewProject(e.target.value)}
            disabled={addNewLoading || addNewSaving || addNewProjects.length === 0}
          >
            {addNewProjects.length === 0
              ? <option value="">No projects with a saved Director board</option>
              : addNewProjects.map((project) => <option key={project.name} value={project.name}>{project.label}</option>)}
          </select>
          <label htmlFor="director-import-name" style={{ marginTop: 12 }}>New project / story name</label>
          <input
            id="director-import-name"
            value={addNewName}
            maxLength={120}
            placeholder="Enter a name for the new story"
            onChange={(e) => setAddNewName(e.target.value)}
            disabled={addNewLoading || addNewSaving}
          />
          <div className="section-label" style={{ marginTop: 14 }}>Processed tabs available to import</div>
          {addNewLoading ? <p className="muted">Loading the selected project…</p> : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 6, marginTop: 8 }}>
              {DIRECTOR_IMPORT_TABS.filter((tab) => processedDirectorImports(addNewSourceBoard).includes(tab.id)).map((tab) => (
                <label key={tab.id} style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 400, padding: "6px 8px", border: "1px solid var(--line, rgba(255,255,255,.12))", borderRadius: 6 }}>
                  <input
                    type="checkbox"
                    checked={addNewTabs.includes(tab.id)}
                    onChange={(e) => setAddNewTabs((current) => e.target.checked
                      ? [...new Set([...current, tab.id])]
                      : current.filter((id) => id !== tab.id))}
                    disabled={addNewSaving}
                  />
                  <span>{tab.label}</span><span className="muted" style={{ marginLeft: "auto", fontSize: 11 }}>Processed</span>
                </label>
              ))}
              {!processedDirectorImports(addNewSourceBoard).length && addNewSourceId && (
                <p className="muted">This project has no processed Director tabs to import.</p>
              )}
            </div>
          )}
          <p className="hint" style={{ margin: "8px 0 0", fontSize: 11 }}>
            Imported scenes also bring their story bible and source-grounded scene plan. Generated media and exports stay with the source project.
          </p>
          {addNewError && <p className="error" role="alert" style={{ marginTop: 10 }}>{addNewError}</p>}
          <div className="dlg-actions" style={{ marginTop: 18 }}>
            <button className="ghost" onClick={() => setAddNewOpen(false)} disabled={addNewSaving}>Cancel</button>
            <button className="primary" onClick={() => void createFromImportedTabs()} disabled={addNewLoading || addNewSaving || !addNewSourceBoard || !addNewName.trim() || !addNewTabs.length}>
              {addNewSaving ? <><Spinner size={13} /> Creating…</> : "Create new story"}
            </button>
          </div>
        </div>
      </div>
    )}
    {promptPreview && (
      <div className="dlg-overlay" role="dialog" aria-modal="true" aria-label="Next LLM prompt preview">
        <div className="dlg-box scene-popup" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 860 }}>
          <h3 className="dlg-title">
            🔍 Next prompt —{" "}
            {promptPreview.ready
              ? "plan complete"
              : `scenes ${promptPreview.startNumber}–${(promptPreview.startNumber ?? 1) + (promptPreview.count ?? 1) - 1} (~${promptPreview.approxTokens ?? "?"} tokens)`}
          </h3>
          <p className="dlg-message">
            {promptPreview.ready
              ? (promptPreview.note || "Nothing left to plan.")
              : `Exactly what Continue sends next: system (${promptPreview.systemChars ?? "?"} chars) + user brief (${promptPreview.userChars ?? "?"} chars, ~${promptPreview.batchSeconds ?? "?"}s batch). Nothing was sent or saved.`}
          </p>
          {!promptPreview.ready && (
            <>
              <details open>
                <summary><b>USER message</b> — the batch brief</summary>
                <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 320, overflowY: "auto", background: "rgba(0,0,0,0.25)", padding: 10, borderRadius: 8 }}>{promptPreview.user || "(empty)"}</pre>
              </details>
              <details style={{ marginTop: 8 }}>
                <summary><b>SYSTEM message</b> — the shared director rules</summary>
                <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 320, overflowY: "auto", background: "rgba(0,0,0,0.25)", padding: 10, borderRadius: 8 }}>{promptPreview.system || "(empty)"}</pre>
              </details>
              <details style={{ marginTop: 8 }}>
                <summary><b>MASTER PROMPT</b> — the style lock (from Analyzer + Visual Style)</summary>
                <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 200, overflowY: "auto", background: "rgba(0,0,0,0.25)", padding: 10, borderRadius: 8 }}>{masterPrompt || "(empty)"}</pre>
              </details>
            </>
          )}
          <div className="dlg-actions" style={{ marginTop: 12 }}>
            {!promptPreview.ready && promptPreview.user && (
              <button
                className="ghost"
                onClick={() => { try { void navigator.clipboard.writeText(`SYSTEM:\n${promptPreview.system || ""}\n\nUSER:\n${promptPreview.user || ""}`); } catch { /* clipboard unavailable */ } }}
                title="Copy system + user prompt to clipboard"
              >
                Copy
              </button>
            )}
            <button className="primary" onClick={() => setPromptPreview(null)} title="Close preview">Close</button>
          </div>
        </div>
      </div>
    )}
    {/* 📝 Directing-inputs popup: what was saved before directing (project
        name, story/lyrics, language, genre, style, durations, instructions).
        View always; Edit + Save to change. Story/style edits steer FUTURE
        scene batches only — planned characters/scenes stay until regenerated;
        song boards lock the target to the song length. */}
    {inputBoard && (
      <div className="dlg-overlay" role="dialog" aria-modal="true" aria-label="Directing inputs">
        <div className="dlg-box char-popup" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
          <h3 className="dlg-title">
            📝 Directing inputs — {str(inputBoard.input.title) || inputBoard.id}
          </h3>
          <p className="dlg-message">
            What you saved before directing. View anytime; press Edit to change.
            Edits steer <b>future</b> scene batches (pacing, style grounding, instructions) —
            already-planned characters and scenes stay as-is until regenerated.
            {inputBoard.input.song?.durationSeconds
              ? " Song board: the target duration stays locked to the uploaded song."
              : ""}
          </p>
          {!inputEditing ? (
            <>
              <div className="shotlist-detail-label">Project name</div>
              <p>{str(inputBoard.input.title) || "—"}</p>
              <div className="shotlist-detail-label">Story{inputBoard.input.song ? " / lyrics" : ""}</div>
              <p style={{ whiteSpace: "pre-wrap", maxHeight: 220, overflowY: "auto" }}>{str(inputBoard.input.story) || "—"}</p>
              <div className="dir-scene-row-head" style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                <span><span className="shotlist-detail-label">Analyzer</span><p style={{ margin: "2px 0 0" }}>{inputBoard.input.analyzerType && ANALYZER_TYPES[inputBoard.input.analyzerType as AnalyzerType] ? ANALYZER_TYPES[inputBoard.input.analyzerType as AnalyzerType].role : (str(inputBoard.input.masterPrompt).match(/^ROLE:\s*(.+)$/m)?.[1] || "Not recorded for this older board")}</p></span>
                <span><span className="shotlist-detail-label">Language</span><p style={{ margin: "2px 0 0" }}>{str(inputBoard.input.language) || "—"}</p></span>
                <span><span className="shotlist-detail-label">Genre</span><p style={{ margin: "2px 0 0" }}>{str(inputBoard.input.genre) || "—"}{inputBoard.input.genre === "Custom" && inputBoard.input.genreCustom ? ` (${inputBoard.input.genreCustom})` : ""}</p></span>
                <span><span className="shotlist-detail-label">Visual style</span><p style={{ margin: "2px 0 0" }}>{str(inputBoard.input.visualStyle) || "—"}{inputBoard.input.visualStyle === "Custom" && inputBoard.input.styleCustom ? ` (${inputBoard.input.styleCustom})` : ""}</p></span>
                <span><span className="shotlist-detail-label">Aspect ratio</span><p style={{ margin: "2px 0 0" }}>{str(inputBoard.input.aspectRatio) || "—"}</p></span>
              </div>
              <div className="shotlist-detail-label" style={{ marginTop: 8 }}>Master prompt</div>
              <p style={{ whiteSpace: "pre-wrap" }}>{str(inputBoard.input.masterPrompt) || "—"}</p>
              <div className="dir-scene-row-head" style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 8 }}>
                <span><span className="shotlist-detail-label">Target duration</span><p style={{ margin: "2px 0 0" }}>~{Math.round(Number(inputBoard.input.song?.durationSeconds ?? inputBoard.input.targetSeconds) || 0)}s{inputBoard.input.song?.durationSeconds ? " (🔒 song length)" : ""}</p></span>
                <span><span className="shotlist-detail-label">Scene duration (AI pace hint)</span><p style={{ margin: "2px 0 0" }}>~{inputBoard.input.sceneSeconds}s</p></span>
                <span><span className="shotlist-detail-label">Dialogues</span><p style={{ margin: "2px 0 0" }}>{inputBoard.input.includeDialogue === false ? "🔇 off (silent)" : "🎙 on"}</p></span>
                <span><span className="shotlist-detail-label">Connected scenes</span><p style={{ margin: "2px 0 0" }}>{inputBoard.input.chainContinuity === true ? "🔗 on" : "▫️ off"}</p></span>
              </div>
              {inputBoard.input.song?.fileName ? (
                <>
                  <div className="shotlist-detail-label" style={{ marginTop: 8 }}>Song</div>
                  <p>🎵 {str(inputBoard.input.song.fileName)} · ~{inputBoard.input.song.durationSeconds}s</p>
                </>
              ) : null}
              <div className="shotlist-detail-label" style={{ marginTop: 8 }}>Additional director instructions</div>
              <p style={{ whiteSpace: "pre-wrap" }}>{str(inputBoard.input.instructions) || "—"}</p>
              <div className="dlg-actions">
                <button className="ghost" onClick={() => closeInputs()} title="Close">
                  Close
                </button>
                <button className="primary" onClick={() => setInputEditing(true)} disabled={busy != null} title="Edit these directing inputs">
                  Edit
                </button>
              </div>
            </>
          ) : (
            <>
              <label>Project name</label>
              <input
                value={inputDraft.title}
                maxLength={120}
                onChange={(e) => setInputDraft((d) => ({ ...d, title: e.target.value }))}
                title="Board title — the approved project takes exactly this name"
              />
              <label style={{ marginTop: 8 }}>Story{inputBoard.input.song ? " / lyrics" : ""} (future batches plan from this)</label>
              <textarea
                rows={8}
                value={inputDraft.story}
                maxLength={10000}
                onChange={(e) => setInputDraft((d) => ({ ...d, story: e.target.value }))}
                title="Saved story text — edits steer future scene batches; planned characters/scenes stay until regenerated"
              />
              <div className="grid grid-3" style={{ marginTop: 8 }}>
                <div>
                  <label>Language</label>
                  <select value={inputDraft.language} onChange={(e) => setInputDraft((d) => ({ ...d, language: e.target.value }))}>
                    {LANGS.map((l) => <option key={l} value={l}>{l}</option>)}
                  </select>
                </div>
                <div>
                  <label>Genre</label>
                  <select value={inputDraft.genre} onChange={(e) => setInputDraft((d) => ({ ...d, genre: e.target.value }))}>
                    {GENRES.map((g) => <option key={g} value={g}>{g}</option>)}
                  </select>
                  {inputDraft.genre === "Custom" && (
                    <input value={inputDraft.genreCustom} maxLength={40} placeholder="Custom genre…" onChange={(e) => setInputDraft((d) => ({ ...d, genreCustom: e.target.value }))} style={{ marginTop: 6 }} />
                  )}
                </div>
                <div>
                  <label>Visual style</label>
                  <select value={inputDraft.visualStyle} onChange={(e) => { const v = e.target.value; setInputDraft((d) => ({ ...d, visualStyle: v, masterPrompt: STYLE_MASTER_PROMPTS[v] ?? d.masterPrompt })) }}>
                    {STYLES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  {inputDraft.visualStyle === "Custom" && (
                    <input value={inputDraft.styleCustom} maxLength={120} placeholder="Describe the custom style…" onChange={(e) => setInputDraft((d) => ({ ...d, styleCustom: e.target.value }))} style={{ marginTop: 6 }} />
                  )}
                </div>
              </div>
              <label style={{ marginTop: 8 }}>Master prompt (style preset — auto-filled from Visual style)</label>
              <textarea
                rows={2}
                value={inputDraft.masterPrompt}
                maxLength={2000}
                placeholder="Style master prompt — sent as THE style lock for every image prompt…"
                onChange={(e) => setInputDraft((d) => ({ ...d, masterPrompt: e.target.value }))}
                title="Auto-filled from the Visual style preset; edits are used verbatim as the style lock"
              />
              <div className="grid grid-3" style={{ marginTop: 8 }}>
                <div>
                  <label>Target duration (sec){inputBoard.input.song?.durationSeconds ? " 🔒" : ""}</label>
                  <input
                    type="number" min={15} max={3600}
                    value={inputDraft.targetSeconds}
                    disabled={inputBoard.input.song?.durationSeconds != null}
                    onChange={(e) => setInputDraft((d) => ({ ...d, targetSeconds: Number(e.target.value) }))}
                    title={inputBoard.input.song?.durationSeconds ? "Locked to the uploaded song length" : "Story timeline target — future batches pace to this"}
                  />
                </div>
                <div>
                  <label>Scene duration (sec)</label>
                  <input
                    type="number" min={1} max={30}
                    value={inputDraft.sceneSeconds}
                    onChange={(e) => setInputDraft((d) => ({ ...d, sceneSeconds: Number(e.target.value) }))}
                    title="AI pace hint for future batches — each scene's own duration still comes from the story"
                  />
                </div>
                <div>
                  <label>Aspect ratio</label>
                  <select value={inputDraft.aspectRatio} onChange={(e) => setInputDraft((d) => ({ ...d, aspectRatio: e.target.value }))}>
                    {ASPECTS.map((a) => <option key={a} value={a}>{a}</option>)}
                  </select>
                </div>
              </div>
              <label style={{ marginTop: 8 }}>Additional director instructions</label>
              <textarea
                rows={3}
                value={inputDraft.instructions}
                maxLength={2000}
                placeholder="Keep Minku's appearance exactly the same…"
                onChange={(e) => setInputDraft((d) => ({ ...d, instructions: e.target.value }))}
              />
              <div className="row" style={{ marginTop: 8, gap: 16 }}>
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontWeight: 400 }}>
                  <input
                    type="checkbox"
                    checked={inputDraft.includeDialogue}
                    onChange={(e) => setInputDraft((d) => ({ ...d, includeDialogue: e.target.checked }))}
                  />
                  🎙 Dialogues {inputDraft.includeDialogue ? "on" : "off"}
                </label>
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontWeight: 400 }}>
                  <input
                    type="checkbox"
                    checked={inputDraft.chainContinuity}
                    onChange={(e) => setInputDraft((d) => ({ ...d, chainContinuity: e.target.checked }))}
                  />
                  🔗 Connected {inputDraft.chainContinuity ? "on" : "off"}
                </label>
              </div>
              <p className="hint" style={{ margin: "6px 0 0" }}>
                Turning Dialogues OFF strips all planned lines; turning Connected OFF scrubs handoffs —
                the open board reloads with the effect at once.
              </p>
              <div className="dlg-actions">
                <button className="ghost" onClick={() => { if (inputBoard) openInputs(board && board.id === inputBoard.id ? board : inputBoard); }} disabled={savingInputs} title="Discard edits, back to view">
                  Cancel
                </button>
                <button className="primary" onClick={() => void saveInputs()} disabled={savingInputs || !inputDraft.title.trim() || inputDraft.story.trim().length < 3} title="Save these directing inputs">
                  {savingInputs ? "Saving…" : "Save"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    )}
    {assetPromptEditor && (
      <div className="dlg-overlay dir-asset-prompt-overlay" role="dialog" aria-modal="true" aria-labelledby="dir-asset-prompt-title">
        <div className="dlg-box dir-asset-prompt-dialog" onClick={(e) => e.stopPropagation()}>
          <div className="dir-asset-prompt-mark" aria-hidden="true">✦</div>
          <div className="section-label dir-asset-prompt-eyebrow">MASTER REFERENCE IMAGE</div>
          <h2 className="dir-asset-prompt-title" id="dir-asset-prompt-title">
            {assetPromptEditor.prompt ? "Refine image prompt" : "Create image prompt"}
          </h2>
          <p className="dir-asset-prompt-subtitle">
            For <strong>{assetPromptEditor.name}</strong>. This prompt is sent verbatim to the image model.
          </p>
          <label className="dir-asset-prompt-label" htmlFor="dir-asset-prompt-input">Generation prompt</label>
          <textarea
            id="dir-asset-prompt-input"
            className="dir-asset-prompt-input"
            autoFocus
            rows={9}
            value={assetPromptEditor.prompt}
            onChange={(e) => setAssetPromptEditor((current) => current ? { ...current, prompt: e.target.value } : current)}
            placeholder="Describe the subject, appearance, clothing, pose, and visual details…"
          />
          <div className="dir-asset-prompt-footer">
            <span className="hint">Keep identity and appearance details consistent with the story bible.</span>
            <span className="dir-asset-prompt-count">{assetPromptEditor.prompt.length} characters</span>
          </div>
          <div className="dlg-actions dir-asset-prompt-actions">
            <button className="ghost" onClick={() => setAssetPromptEditor(null)} disabled={assetBusy}>Cancel</button>
            <button
              className="primary dir-asset-prompt-submit"
              disabled={!assetPromptEditor.prompt.trim() || assetBusy || busy != null}
              onClick={() => {
                const edit = assetPromptEditor;
                if (!edit?.prompt.trim()) return;
                setSelectedAssetVersions((current) => ({ ...current, [`${board?.id ?? "board"}:${edit.assetId}`]: null }));
                setAssetPromptEditor(null);
                void doRegenerateAsset(edit.assetId, edit.prompt.trim());
              }}
            >
              ✨ {assetPromptEditor.prompt ? "Save & regenerate" : "Generate image"}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
