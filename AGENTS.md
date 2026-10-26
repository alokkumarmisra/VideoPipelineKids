# AGENTS.md — operating notes for video generation + frontend

## Sanskriti Kids Studio (children's videos — the "Kids" module)
A separate module INSIDE Sanskriti AI Studio, visible as **"Sanskriti
Kids"** (sidenav item + breadcrumb; the main studio identity is untouched).
Nav `frontend/src/components/SanskritiKidsPage.tsx`, client
`frontend/src/kidsApi.ts`, pure helpers + `KIDS_SCHEMA` in `lib/kids.mjs`,
data-access layer in `lib/kids_store.mjs`. The studio is a PROJECT LAYER on
top of the existing pipeline — it never renders on its own: the Director
bible/storyboard (`/api/director/*`), the image→video→dialogue→final-cut
workspace and `DirectorGeneration` are all reused unchanged. Its four
workflow tabs are Dashboard / Projects & Brief / AI Director / Story, where
the last two embed the existing `KidsDirectorPage` + `StoryPage` verbatim.
DATA: the studio owns a DEDICATED Postgres database (`Sanskriti_kids` by
default, `PG_KIDS_DATABASE`) — `kids_projects` + `kids_director_plans` +
`kids_scenes` + `kids_characters` + `kids_assets` + `kids_jobs` +
`kids_options` (created idempotently in `kidsInit()`, ALTERed for the
optional `audio_path` / `reference_images` columns) — so its rows never mix
with the main catalog (`video_generator`). Every `/api/kids/*` route branches
on `kidsStore()` ("pg" | "sqlite"); when the database is unreachable the
studio falls back to `data/kids.sqlite` (same tables, JSON as TEXT) and the
module keeps working. ROUTES: `/api/kids/health|dashboard|options` (GET),
`/api/kids/options` (PUT), `/api/kids/projects` (GET|POST),
`/api/kids/projects/:id` (GET|PUT|DELETE), `…/plan` (GET|PUT|POST),
`…/plan/approve` (POST), `…/board` (PUT) + `…/sync` (POST),
`…/scenes|characters|assets|jobs` (GET).
RULES: the brief fields the Director consumed are NEVER silently rewritten —
changing the script/lyrics needs `reset_plan: true`, and an APPROVED plan is
locked until an explicit `unlock: true` (`planEditGuard`). The Director Plan
is DERIVED from the real storyboard (`buildKidsPlanFromBoard`) so plan and
scenes can never drift; a linked board is mirrored into `kids_scenes` /
`kids_characters`. The option lists (age groups, categories, languages,
platforms, resolutions, visual styles) live in `kids_options` — the UI
renders what the server returns and never hardcodes them. Dashboard metrics
come from live rows (and the REAL files on disk for images/videos), never
from hardcoded numbers. Tests: `tests/kids.test.mjs`; live smoke scripts in
`frontend/tests/kids_*_smoke.mjs`.

### Sanskriti Kids — the 16-stage production studio (expanded module)
`SanskritiKidsPage.tsx` is now the full production environment: Dashboard /
Projects & Brief / AI Director / Story & Production + **Pipeline / Story
Studio / Song Studio / Audio & Narration / Character & Asset Library /
Storyboard & Timeline / Quality Control & Export / AI Learning & Feedback**
(the panels live in `frontend/src/components/KidsStudioPanels.tsx`, the
client in `frontend/src/kidsApi.ts`). PURE helpers: `lib/kids_pipeline.mjs`
(`KIDS_PIPELINE_STAGES` — the 16 stages with their REAL hard/advisory
dependencies, `kidsStageStatus`, `kidsRunnableStages`, `normalizeKidsStory`,
`buildKidsStoryPrompt`, `segmentLyrics`, `normalizeLyricSections`,
`buildKidsAudioTimeline`, `buildKidsTimeline`, `normalizeKidsLibraryAsset`,
`buildKidsScenePrompt`, `runKidsQualityChecks`, `normalizeKidsFeedback`).
DATA (new tables, created idempotently in `kidsInit()` and in the SQLite
fallback): `kids_story_versions` (versioned story documents),
`kids_library_assets` (characters / locations / props, `scope` = project id
or `shared`), `kids_lyric_sections`, `kids_audio_segments`,
`kids_timeline_rows` (the editable scene timeline), `kids_qc_runs`,
`kids_exports`, `kids_feedback`. The SQLite fallback ALTERs the columns an
OLD `data/kids.sqlite` file is missing (`audio_path`, `reference_images`,
`metadata`, …) — a fallback file created before a column existed otherwise
fails on insert. ROUTES: `/api/kids/pipeline` (GET = the catalog + the honest
service availability), `/api/kids/library` (GET|POST) + `/api/kids/library/:id`
(PUT|DELETE), and per project `…/pipeline` (GET|POST = run the selected
stages), `…/story` (GET|POST|PUT) + `…/story/approve`, `…/lyrics` (GET|POST),
`…/audio-analysis` (GET|POST), `…/timeline` (GET|PUT) + `…/timeline/build`
(POST), `…/qc` (GET|POST), `…/exports` (GET) + `…/export` (POST),
`…/feedback` (GET|POST). RULES: the studio NEVER renders on its own — the
image / video / voice / assembly / final-cut stages are REPORTED as
`delegated` to the shared workspace + Director engines, never faked. The
story is written by the SHARED LLM helper (streamed `llmChatJsonLive`, so a
slow local model never hits the HTTP headers timeout) and runs as a JOB
(`kids_jobs`, polled by the panel) — the old one-shot `llmChatJson` was moved
to MODULE level so the studio and the Director use the SAME client. The
Song + Audio studios use the SHARED analyzer (`analyzeSongAudio`, extracted
from `/api/director/analyze-song`, so there is only one analyzer); the
deterministic lyric segmentation is the default and the AI labelling is
opt-in (`use_llm: true`). A story feeds the library (every character /
location / prop becomes a `draft` library row) and the scene prompts are
composed from the CANONICAL library rows (`buildKidsScenePrompt`) so a
character's look never drifts between scenes. The QC stage only reports
findings — it never claims the content is safe or educationally accurate.
Tests: `tests/kids_pipeline.test.mjs` (pure + store) and
`tests/kids_pipeline_server.test.mjs` (wiring).

### Sanskriti Kids — the library reference stills (Flux Reference Image, prompt only)
`scripts/kids_reference.mjs` renders ONE still per run with the **Flux
Reference Image** workflow (`workflows/TextToImage/Flux_REFERENCE_IMAGE.json`).
THE SAVED PROMPT IS PASSED VERBATIM: the workflow is used EXACTLY as authored
and **only the prompt node ("6") is replaced** — no quality suffix, no extra
text, no invented negative (that graph's negative node stays empty), no other
node touched. The job rides the studio's own pump (`kidsPumpJobs()` in
server.mjs, ONE generator at a time — the ComfyUI queue is serial), the file
lands in `kids/<scope>/<Kind>/<key>/reference[_vN].png` (gitignored) and is
served auth-gated from `/kids/...` (`serveKids`). The row is written to
`kids_library_files` and the asset moves to `review` (the user still approves
it). ROUTES: `POST /api/kids/library/:id/generate` (queues the still),
`GET /api/kids/library/:id/files`, `GET /api/kids/jobs?kind=…` (the panels
poll it). The library default workflow is `flux_reference_image`
(`DEFAULT_IMAGE_WORKFLOW`).

**The scene keyframes are a DIFFERENT mode**: the reference stills are pure
text-to-image (that graph has no image input), so a kids SCENE must run in
**Flux t2i** (`flux`, the only mode that anchors on an image) to inherit the
approved character reference. The studio says so in the pipeline panel and
switches the header image dropdown when the images/video stage is opened.
The Devotional Library keeps its own behaviour — unchanged.

### Sanskriti Kids — the kids rules that must not regress
- The module is KIDS-ONLY: the sidenav carries ONE entry ("Sanskriti Kids"),
  Both workflows are SEEDED from the
  studio brief (`KidsDirectorSeed`) so the storyboard can never drift from it.
  NO GENRE IS PINNED: the Kids Director offers the full genre list and the
  Story workflow takes no `kidsOnly` prop — genre/style/pacing are the user's
  choices everywhere (no forced kids register, no calm-pacing floor, no
  content-tripwire approval gate).
- The timeline follows the RENDERED storyboard: with a linked Director board
  the timeline is built from THAT board (`readDirectorBoard(project.board_id)`)
  — the story's own plan is only used when no board is linked.
- Clip negatives carry NO genre branch: `buildLtxGraph` uses
  `LTX_DEFAULT_NEGATIVE` for every cut unless the caller passes its own
  negative (or `verbatim: true` for the Devotional Studio). Set a board
  negative explicitly to override.
- Every kids character keeps ONE voice across the scenes: the library rows
  decide the per-speaker TTS voices (`buildKidsVoiceMap` — an explicit voice
  id wins, a boy's name never gets the default female voice, and a voice the
  user already mapped on the board is never overwritten). The voices are the
  licensed Edge-TTS ids (lib/tts.mjs) — no voice is cloned and no real
  child's voice is used.

### Meaning-Aware, Bilingual AI Direction System (Director / Story / Songs / Narration)
The Director, Story, Songs and Narration workflows now run a **meaning-aware
semantic layer** (`lib/semantics.mjs`, pure: no fs/network/db) before any
scene is planned. Every source line is analyzed line-by-line:

- **Language detection** (`detectLanguage`): Hindi (Devanagari), English
  (Latin), or Hinglish (Latin script + Hindi grammar markers). A forced
  override (`auto` | `hi` | `en` | `hinglish`) is respected. The ORIGINAL
  text is always preserved — translation is only an internal aid.
- **Action extraction** (`matchActions` + `buildActionPlan`): a reusable verb
  lexicon (`ACTION_LEXICON`, bilingual cues including multi-word Hindi phrases
  like "हो जाता" = "becomes") maps each important verb to a visible-action
  template filled with the line's OWN subject/object. Unknown verbs yield an
  explicitly-flagged (`grounded: false`) action — never an invented one.
- **Entity extraction** (`extractEntities`): bible characters/locations/objects
  win over a noun heuristic; Hindi is verb-final so the subject is resolved
  after the verb ("पूँछ हिलाए प्यारा डॉगी" → डॉगी acts, पूँछ is the object).
- **Camera from meaning** (`planCamera`): locomotion → tracking shot; emotion/
  state change → expressive close-up; devotional → respectful medium; entrance
  → establishing + push-in; demonstration → static clear framing; reveal → wide.
- **Beat/timing planning** (`planBeats`): actions tile the scene duration
  exactly; `assessActionFeasibility` warns when too many actions are crammed
  into a short clip.
- **Scene semantic contract** (`attachSemantics` + `validateSceneSemantics` +
  `repairSceneSemantics`): every scene carries `source_line`, `semantic_meaning`,
  `action_plan`, `camera_rationale`, `beats` and validation results. Validation
  checks meaning preservation, main action, character resolution, explicit
  movement, camera suitability, pose consistency, duration, continuity and no
  invented details. Repairs fill gaps deterministically — never inventing a new
  action.

**Server routes** (`frontend/server.mjs`): `POST /api/director/boards/:id/semantics`
runs (or re-runs) the analysis — deterministic pass is instant; an optional
model pass (`useModel: true`, streamed via `llmChatJsonLive`) enriches subject/
target/cultural context and never replaces the source text. `GET .../semantics`
returns the stored analysis; `GET .../validate` now includes per-line semantic
issues. The scenes route (`POST .../scenes`) enriches the board semantics and
attaches them to every planned scene; the repair route (`POST .../repair`)
includes the meaning context so flagged scenes are fixed against their lines.
The board's `input.semanticsLanguage` (`auto`|`hi`|`en`|`hinglish`) pins the
detection.

**Frontend** (`DirectorPage.tsx`, `StoryPage.tsx`): a "Source language"
selector (Auto detect / Hindi / English / Hinglish) rides on the brief; a
"Meaning" panel shows every line's original text beside its interpretation,
visible action, camera and beats; scene rows inline the source line + meaning.
The Story workflow seeds the Director board from the same brief so semantic
information is shared end-to-end.

**Tests:** `tests/semantics.test.mjs` (43 tests: language detection, bilingual
action extraction, camera planning, beat tiling, feasibility, validation,
repair, timing alignment, lyric action plan, voice map, model-merge source
preservation).

## Devotional Studio (canonical asset library)
Devotional nav (`frontend/src/components/DevotionalPage.tsx`, client in
`frontend/src/devotionalApi.ts`, pure helpers + `DEVOTIONAL_SCHEMA` in
`lib/devotional.mjs`). Metadata/versions/approvals/scene-links live in
Postgres when it is up (`devotional_assets` + `devotional_asset_versions` +
`devotional_asset_files` + `devotional_jobs` + `devotional_scene_links` +
`devotional_project_usage`, created idempotently in `pgInit()`), else in the
SQLite fallback `data/devotional.sqlite` (same tables as JSON-TEXT columns,
`project` name instead of `project_id` in usage — every `/api/devotional/*`
route branches on `devStore()`; `/api/devotional/health` `db.up` is true when
either store is available); binaries live
under `devotional/<Kind>/<Name>/<ID>/` (gitignored, `DEVOTIONAL_DIR` override,
served auth-gated via `/devotional/...`). Stable IDs (`CHAR_/LOC_/PROP_/
STYLE_`) are primary — folder names are derived, never authoritative.
Lifecycle `draft → review → approved → archived` (+ transient `generating`),
enforced server-side (`canTransition`); `approved` rows auto-lock and need
explicit `unlock:true` for canonical edits; approve requires ≥1 reference
file. Variants/sub-locations = self-FK `parent_id` (same-kind only).
Reference generation runs the image workflow picked in the HEADER DROPDOWN
("Main" image dropdown, `App.tsx` → `imageMode`, remembered in
`localStorage`) via `scripts/devotional_reference.mjs` (one still, resumable,
`[asset]` log line) spawned by the `devPumpJobs()` background pump — serial
with main runs (waits for a free ComfyUI queue, never blocks API requests);
`server.mjs` must never statically import `lib/comfy.mjs` (it `process.exit(1)`
without `COMFY_BASE`). The workflow table is PURE and shared
(`lib/image_workflows.mjs` — ids, labels, model, default size/steps; the
server imports it safely, the graph builders live in `lib/comfy.mjs`):
`flux` (Flux 2 Klein 1280x768/4 steps, the only mode that can anchor on a
picked image), `flux_text_image` (Flux.1-dev GGUF 960x544/20 steps) and
`flux_reference_image` (the user's `workflows/TextToImage/Flux_REFERENCE_IMAGE.json`
— Flux.1-dev GGUF, 20 steps, guidance 3.5, cfg 1, EMPTY negative node,
random seed, 1920x1024 latent — **the workflow is used EXACTLY as authored:
only the prompt text (node `6`) changes; nothing else is overridden**, the
9:16 cut is the one exception because it owns the canvas). The choice
travels with the job:
the client sends `body.workflow`, the server stores it on
`devotional_jobs.workflow` (+ `model`) and the pump spawns the script with
`--workflow <id> --width --height --steps`; the generated file row records
the workflow/model that actually ran. THE DEVOTIONAL LIBRARY DEFAULTS TO
`flux_reference_image` (`DEFAULT_IMAGE_WORKFLOW`) — every asset still is
rendered with the Flux Reference Image workflow unless the header dropdown
says otherwise. The same dropdown drives the project pipeline
(`--image-mode` → `buildImageGraph` in `lib/comfy.mjs`).
One-click media: every library card has a Generate button (detail dialog has
Still + clip too) → `POST /api/devotional/assets/:id/generate` with
`{ both: true }` queues a still only when no reference image exists plus an
LTX showcase clip (`devotional_jobs.kind = 'video'`,
`scripts/devotional_video.mjs`, gentle push-in, 2–8s default 3, stored as a
`video` file row) behind it; clip jobs never touch asset status (the still
owns draft→generating→review); the detail dialog renders clips in `<video>`.
No success popup — the card/dialog renders inline loading bars with % right
where Generate was pressed (`DevotionalMediaProgress.tsx`, sessions live at
the `DevotionalPage` root so tab switches keep them): Still (cyan) + Clip
(blue) + Overall (accent) bars in the app's `.gen-compact-table` language,
Overall counting REAL completions only, in-flight unit estimated 0–99% from
the shared pace store (`loadPace`/`recordPaceDuration`, same formula as
`RunPanel`; indeterminate sweep + ticking elapsed with no pace yet), polled
via `GET /api/devotional/jobs?ids=` (precise lookup, never the LIMIT window);
success auto-reloads + clears, failure shows inline with Dismiss (Reference
Studio keeps full history + Cancel/Retry).
Saved prompt = THE ONLY TEXT SENT TO THE AI: every asset carries a
first-class `prompt` column (PG + SQLite, auto-migrated, in snapshots/exports)
editable via the detail dialog's Generation prompt panel (Edit Prompt → Save,
or Save & Regenerate which renders a NEW still + a clip from that still — FIFO
pump, old versions kept). The generate route resolves per-request `prompt` →
saved `prompt` → nothing: a blank prompt is REFUSED (400), never auto-filled
from the library metadata. `assetInputText(a)` (lib/devotional.mjs) is the
single accessor for that text — name, description, identity traits and
continuity rules are library metadata (filter/approve/version only) and are
NEVER rendered, so `describeAssetForPrompt` is gone. `buildDevotionalScenePrompt`
uses `assetInputText` for every character/variant/location/prop/style (the
Director bridge reports `without_prompt` for assets that carry no input
text). The user's Negative prompt is now actually sent: the job carries it
(`metadata.negative`) → `--negative` → Flux node `75:67` (verbatim) and the
LTX negative node. VERBATIM MODE: the model receives EXACTLY the user's text
— no motion prefix, no quality-motion suffix, no default negative list. The
Flux still (`buildFluxGraph` → node `75:74`) was always verbatim; the LTX
clip now is too (`buildLtxGraph({ verbatim: true })` → nodes `398:376` /
`398:373` carry the caller's strings unchanged, empty when the user gave
no negative). Every other flow (character sequence, documentary, …) keeps
the quality-locked defaults. Tests: `tests/devotional_verbatim.test.mjs`.
One-time backfill at boot: assets predating the column inherit
their own description as the initial input text (editable per asset; the
form/dialog offer "Use description" as an explicit copy). The input-text
cap is `DEVOTIONAL_PROMPT_MAX` = 4000 chars (lib, PUT, generate, seed,
restore, UI maxLength) — a production prompt incl. its own negative section
must reach the model complete, never truncated mid-sentence; version restore
carries the snapshot's prompt.
Image & video section (`DevotionalMediaSection.tsx`, on every library card +
in the detail dialog): the Keyframes → clips tile copied over — bulk checkbox,
still + clip frames with vN badges, v1/v2/… version chips (oldest-first by
file id, latest shown; chips switch the SHOWN file only, no backend main),
and per-kind regen buttons (image → `POST .../generate` still, video →
`{ only: "video" }` clip-only, both keep old files as new versions and track
through the same inline progress). Library toolbar has the bulk bar
(All/None + Videos/Images/Both + Regenerate (n), same `beats-bulk` classes):
one queued set per checked asset, pump runs them serially, clip regens skip
assets with no still yet. List responses carry `image_versions` /
`video_versions` (existing files only, newest-first) so cards need no detail
fetch. Cancel never lies: the pump's failure write is guarded to PROCESSING
so 'cancelled by user' survives the proc tail.
Director bridge: `POST /api/devotional/resolve` (approved-only, missing ids
reported never substituted) + `POST /api/devotional/prompt`
(`buildDevotionalScenePrompt`: identity vs scene-action stay separate) +
`POST /api/devotional/scene-links` (pins asset versions per board scene;
regeneration keeps assignments). Without Postgres the endpoints answer 503
like the rest of the catalog; `/api/devotional/health` (db/comfy/storage)
works regardless. Tests: `tests/devotional.test.mjs` (lib) +
`tests/devotional_server.test.mjs` (route/schema wiring).

## Devotional Studio — project layer (story → assets → scenes → cut)
The library above is CANONICAL; this is the PROJECT layer on top of it
(`lib/devotional_project.mjs` = pure helpers, `frontend/src/components/
DevotionalStudioPage.tsx` = the workspace, nav item "Devotional Studio";
the "Devotional Library" nav item is the old library page — it stays).
Tables: `devotional_projects` (inputs + `analysis` JSONB story plan),
`devotional_project_assets` (resolved asset id + VERSION per requirement,
FK RESTRICT — a project references library assets, never copies them) and
`devotional_project_scenes` (the scene plan: timing, asset ids, prompts,
continuity, image/clip paths, approval). `devotional_jobs` gained two
NULLABLE columns (`project_id`, `scene_number`) so scene jobs ride the ONE
existing pump (no second queue): a scene still = `kind 'scene'` (Flux t2i),
a scene clip = `kind 'scene_video'` (LTX i2v, animates the scene's own
approved still). Scene binaries live under `devotional/Projects/<id>/Scenes/
<n>/` (library assets stay separate); the cut under `.../Final/`.
Routes: `GET|POST /api/devotional/projects`, `GET|PUT|DELETE
/api/devotional/projects/:id`, `POST .../audio` (base64 mp3/wav, duration
from ffprobe), `POST .../analyze` (LM Studio via the shared `llmChatJson`;
when the model is unavailable it returns an honest LOCAL draft that groups
the user's own lyrics and invents NO cast/places), `POST .../resolve`
(requirements → library candidates; ambiguous ones are reported, never
silently substituted), `PUT .../assets` (the user's explicit choice wins),
`GET|POST .../scenes` (build the plan), `PUT .../scenes/:n` (edit one
scene), `POST .../scenes/split|merge|reorder`, `POST .../scenes/:n/generate`
(`only: image|clip`), `POST .../scenes/:n/approve` (the gate before the
clip), `GET .../progress` (the stage stepper), `POST .../assemble`
(validates order/missing clips/resolution/audio, then ffmpeg concat
`-c copy` + optional audio mux).
Rules that must not regress: the scene prompt is composed ONLY from the
assets' own input text (`assetInputText`) — library metadata is never
rendered; timings are marked `exact|estimated|unknown` (never faked); a
project NEVER duplicates a canonical asset; a scene regeneration reuses the
resolved ids + versions. RESOLVER MATCHING: a requirement matches an asset
by COVERAGE of its distinctive words (name + description), never by any
shared word — a word that appears only in the asset's NAME names the OWNER
("Krishna's Flute" vs "Krishna's peacock feather"), and generic words
("river", "temple") carry no identity. So "Peacock Feather (on Krishna's
attire)" stays MISSING instead of silently binding the flute, and "Yamuna
River" binds Vrindavan, never Ayodhya. A scene that names no prop reuses
the project's resolved props (a sacred object never vanishes mid-film).
POSTGRES vs SQLITE PARAM TYPES: the pg columns are
typed (`scenes INTEGER[]`, `character_ids`/`prop_ids TEXT[]`, `camera JSONB`,
`approved BOOLEAN`) while the sqlite columns are TEXT — so the pg branch
must pass NATIVE arrays / a real boolean and the sqlite branch the JSON
text. A JSON string in a pg array column fails with "malformed array
literal", and the sqlite path hides that bug. Pinned by
`tests/devotional_project_server.test.mjs` ("postgres parameter types").
Tests: `tests/devotional_project.test.mjs` (pure),
`tests/devotional_project_server.test.mjs` (wiring), live scripts
`tests/devotional_project_smoke.mjs`, `tests/devotional_project_job_retry.mjs`,
`tests/acceptance_devotional_project.mjs` (Krishna_Flute_Test).

## Intelligent Director upgrade (lyric coverage + quality control)
Pure helpers in `lib/director.mjs` (all unit-tested in
`tests/director_intelligent.test.mjs`, acceptance A–H): `DIRECTOR_STAGES`
(8-stage pipeline), `extractMeaningfulPhrases` (word-by-word phrase split),
`buildLyricCoverageMap` + `coverageSummary` (Lyric Coverage Map §3),
`boardLyricLines` (bible decomposition, else song fallback, else []),
`normalizeCastEntry`/`castIdsOf`/`characterDirectionsOf` (rich per-character
action/gaze/role direction; string-id casts keep working),
`SHOT_TYPES`/`CAMERA_MOVEMENTS`/`normalizeCamera` (shot vocabulary §6),
`validateShotDirection` (vague-action + contradictory-camera flags),
`detectContinuityIssues` (location jumps, emotion flips, dropped refs),
`scoreDirectorPlan` (configurable 0–100: lyric 30 / action 20 / continuity 15
/ timing 15 / prompts 20), `genreDirectingNotes` (kids/devotional registers),
`buildDirectionRepairPrompt` (staged LLM repair of flagged shots only),
`llmModelName()` (`LLM_MODEL` env, default `"local"`).
`normalizeScene`/`normalizeShot` additionally preserve `characters_detailed[]`
+ `dramatic_purpose` (absent on legacy scenes) and accept object casts via
`castIdsOf`; existing exports behave byte-identically (all 58 pre-existing
director tests pass unchanged).
Anatomy-latch guard (a real dog board once got the full snake template on
every character): the bible rule is conditional (limbless template ONLY for
snake/serpent/worm/eel, explicitly FORBIDDEN words for legged species),
`anatomyLockFor` returns null for legged species even when poisoned, and
`validateBibleAnatomy` flags latched bibles in validate warnings and blocks
prompt-preview / scene planning / approval. SKIN COVERING is part of the same
rule (snake/lizard/fish/turtle = scales, birds = feathers, elephant/buffalo/
human = bare skin, lion/dog/cat = fur) and is checked by the same validator.
This is the ONLY hard gate — it protects the rendered body plan for ALL
genres, not a kids register.

Server (`frontend/server.mjs`): all chat-completions `model:` fields use the
shared `LLM_MODEL` const (Muse Spark 1.3 = `LLM_BASE` spark endpoint +
`LLM_MODEL=muse-spark-1.3`; default `"local"` = existing LM Studio behavior).
New read-only routes `GET /api/director/boards/:id/coverage` (coverage map) +
`GET .../validate` (score + breakdown + issues + approve-gate errors +
continuity + genre note); `POST .../repair` re-plans ONLY flagged scenes via
`llmChatJson` + `normalizeScene` and persists the board; `PUT` accepts an
opaque `storyPlan` object (staged artefacts; scenes stay the source of truth).
No schema migration (board JSONB carries the new fields).
UI (`DirectorPage.tsx` + `frontend/src/api.ts`): `🎬 Intelligent Director`
card after the analysis box (quality pill, coverage pill, Check/Repair
buttons, genre note, logline, collapsible Validation + Lyric coverage with
click-to-shot navigation via `jumpToShot`), plus dramatic-purpose +
per-character direction lines in `renderShotDetails`. Tests: run
`node --test tests/director.test.mjs tests/director_intelligent.test.mjs`.
Kids content is NOT special-cased anywhere in the engine text: no
`kidsDirectingRules` injection, no `kidsContentWarnings` keyword gate (the
studio QC stage reports an honest "no automatic content scan — teacher review
required" instead), no kids-scene-physics validator, no `kidsShotOpts` floors.
`directorValidateInput` honors the user's `sceneSeconds` (1–30s clamp only),
all four `normalizeScene` call sites pass no options, unknown board genres
default to "Adventure" / "3D Cinematic" (not Kids/preschool), and the UI
defaults are the same neutral picks with no kids auto-switch. `isKidsGenre`
and the learning helpers (`learningFocus`, `extractLearningExpectations`,
`learningReviewChecklist`, `verifyOcrText`) remain as PURE exports used by
the Sanskriti Kids studio displays and the opt-in `verify_learning.mjs`
checker (validate warnings still carry `learningReviewChecklist` + the
generic anatomy findings). This keyword scan removal is honest: no scan claims
safety anywhere.
Hindi/Hinglish input is first-class: `isKidsGenre` matches Devanagari
(बच्चों/लोरी/अक्षर/गिनती/जानवर/पंचतंत्र…) and romanized (balgeet/lori/ginti)
genre text (used by the studio displays), and the `anatomyLockFor` /
`validateBibleAnatomy` species recognition covers Hindi species names
(कुत्ता/बिल्ली/शेर/हाथी…) so the body-plan guard works on Hindi bibles.
`boardToScenario` carries the Director language into TTS defaults; `voiceFor`
chooses paired English/Hindi voices and respects explicit per-cast overrides.
Learning OCR (`verify_learning.mjs`) matches standalone OCR letter tokens and
planned lyric metadata, rejects missing expectations/keyframes for explicit
alphabet/counting focus, and reports object counts as unverified (human visual
review remains necessary; OCR cannot count depicted objects).

## AI Story Director (Story-to-Video)
Director menu (`frontend/src/components/DirectorPage.tsx`, pure helpers in
`lib/director.mjs`). Boards are DB-backed (`director_boards` table, mirrored on
every write; `director/<slug>.json` files remain as the offline fallback).
Two LLM calls via the shared llama-server convention (`llmChatJson` in
`server.mjs`): (1) bible (analysis + character/location/object bibles + beats),
(2) scene batches of ≤10 (`SCENE_BATCH`) with identity-string context only.
Scene batches stream (`llmChatJsonLive`, same payload + `stream:true` — same
prompt/tokens/compute, deltas only flushed over the wire) into a per-board
memory buffer served read-only by `GET /api/director/boards/:id/live`
(completed scenes via `extractPartialScenes` + trailing fragment tail); the
storyboard polls it ~1s while planning for the 🔴 LIVE panel. Polling never
touches the model, so planning is unaffected. Newly landed rows also replay
with a client-side typewriter (`TypedText`); `prefers-reduced-motion` renders
static text.
`APPROVE` returns a standard scenario config; the client persists it through
the existing `saveScenario` PUT and opens the workspace — image/video/merge/
progress/resume are 100% the existing pipeline. Style lock is appended
server-side (`boardToScenario`) so scenes can't drift off-style. Approved boards
link to their project (`director_boards.project_id` FK → `projects`, set on
save/approve, `ON DELETE CASCADE` + board-file cleanup — deleting a project
removes its storyboard; renames follow `scenario_name`). Unapproved drafts have
no link and survive project deletion.
Multi-shot scenes: when one line/sentence covers 2+ entities, the AI plans
timed `shots[]` INSIDE the scene (`normalizeShot`/`normalizeShots`/
`splitSceneTimeline` in `lib/director.mjs` — pronounceable-length durations
that tile the scene total exactly, cumulative from 0). The UI renders one
scene per row with its shots laid out horizontally, width ∝ duration.
`APPROVE` flattens each shot to one generation beat (`<scene>_<a|b|…>`, shot
duration/prompts/dialogue, `scene_number`/`shot_id`/`start_time`/`end_time`
metadata + song-absolute offsets); shot-less scenes map 1:1 byte-identically.
Keyframes → clips tiles number by flat beat (`Beat n/N`, N = total shots) with
the Director linkage as `Sc S · Sh s/t` suffix (`beatHead` in
`OutputGallery.tsx`); the in-flight beat always renders (unioned into
`sceneNums`/`liveTotal`) so its red `.generating` pulse can never lose its
tile. The Director Generation section follows foreign server runs for its
project (`foreignRunForProject` + `attachRun` in `DirectorGeneration.tsx`,
same reattach rule as the workspace) so tiles pulse even when the run was
started in the workspace or before a refresh.
Bible-id grounding: every scene-batch brief carries VALID id lists + a
location/object rotation + anti-repeat mandate (ids only — free-text places,
objects in the location slot, and invented cast are forbidden); beats carry
`location`/`objects` place-props. The server enforces it per batch
(`canonicalizeSceneRefs`/`dedupeScenes` in `lib/director.mjs`: display names
resolve to ids, bible objects parked in `location` OR `characters` move to
`continuity_refs` (lossless — server-logged in `notes`, never warned),
truly-unknown cast and exact-duplicate scenes are skipped) and reports losses
in `board.warn` (⚠️ hint in the storyboard header, cleared by manual edits).
Dynamic planning: Generate Scenes is duration-driven, not count-driven —
each batch gets numbered source lines sliced to its time window
(`linesForTimeWindow`), a seconds budget, and planned-so-far context; the AI
decides scene boundaries (`line_from`/`line_to`), scene/shot counts and all
durations, and returns `complete=true` at the story end, at which point the
server shrinks `sceneCount` to what was planned (`planProgress` paces it).
`complete=true` is VERIFIED (`verifyPlanComplete`: last line covered + timeline
within tolerance — never trusted blindly); a premature flag is logged and
planning continues, and an early-finalized board reopens by extending the cap
from the remaining seconds (close-enough `DONE_TOL` never spawns a filler scene).
Scene boxes show the covered lines (`L2–3: "…"`) + a `⏱ ~planned/~target` pill.
DB shot linkage: `project_assets` carries `scene_number/shot_id/shot_number/
start_time/end_time` per keyframe/clip row (NULL for legacy/FINAL), written
on every path via `shotColumns(beat)` in `lib/project_versioning.mjs` and
returned by EFFECTIVE/EXACT asset SQL; `director_boards.shot_count`
denormalizes the planned shot total beside `scenes_done`.

## What this is
Repo root is the folder `comfyui-video-pipelines-frontend/` (all paths below are
relative to it). Two parts:
- **CLI generation**: standalone Node scripts that drive a **remote ComfyUI** (via a
  reverse-proxy tunnel) to make videos. No local GPU. ESM (`.mjs`), Node ≥ 18, no deps.
- **`frontend/`**: a React+TS (Vite) web UI over the character-sequence pipeline, with a
  zero-dep Node backend (`frontend/server.mjs`).

## Ground rules
1. **Never edit the base workflows** (`workflows/flux-t2i.json`, `workflows/ltx2_5_i2v.json`,
   `workflows/image_to_video_wan.json`). Clone them (`structuredClone`) and mutate the
   clone via the builders in `lib/comfy.mjs` (`buildFluxGraph`, `buildLtxGraph`,
   `buildMergedGraph`, `buildWanGraph`).
2. **All generation code goes through `lib/comfy.mjs`** (`run`, `queue`, `wait`,
   `download`, `uploadToInput`, `fetchJson`). Don't re-implement HTTP/retries in scripts —
   fix the lib instead.
3. **Prompts live in `prompts/*.json`**, not in scripts. Scripts read config from the
   matching JSON. New content usually needs **no new script** — just a new prompts JSON run
   through a generic runner.
4. **Outputs go to `outputs/<project>/`**. Runners are resumable: an asset with any
   version on disk is skipped. Keep that pattern.
5. **Stitch with ffmpeg concat** (`-c copy`): clips from one ComfyUI run share
   codec/resolution/fps, so stream-copy concat is safe and lossless.
6. **Self-contained**: base workflows live in `workflows/` and are loaded from there by
   `lib/comfy.mjs` (`WORKFLOWS_DIR` overrides). Nothing else outside the repo is read at
   runtime (only remote ComfyUI via `COMFY_BASE`).

## Scripts
Generic runners (a new scenario = one new `prompts/<scenario>.json`):
- `reface.py analyze <jobDir> | swap <jobDir> --face <faceId>` — **face-swap
  studio worker** (local CPU, insightface — NOT ComfyUI). Analyze samples the
  source at 1fps, detects faces (buffalo_l) and greedy-clusters identities by
  embedding cosine (same rule as `clusterEmbeddings` in `lib/reface.mjs`) into
  `faces.json` + `thumbs/faceN.jpg` (+ `embeddings.npz`, python-only). Swap
  replaces the chosen identity with the largest face in `reference.*` via
  inswapper_128 frame-by-frame and re-encodes `result.mp4` (libx264/yuv420p,
  original audio muxed). Progress streams to `progress.json` for UI polling.
  Models: buffalo_l auto-downloads to `~/.insightface`; inswapper_128 fetches
  once from `INSWAPPER_URL` into `INSWAPPER_MODEL` (override both via env).
- `director.mjs [scenario]` — N scenes, **merged** Flux→LTX per scene (one queue item each).
  JSON: `{ duration, scenes: [{ title, fluxPrompt, ltxPrompt }] }`
- `character_sequence.mjs [scenario]` — reference visual + N keyframe beats (same subject),
  **split** Flux→LTX. JSON: `{ duration, referencePrompt, sequence: [{ title, image, motion }] }`.
  Flags: `--stitch` (re-stitch only), `--regen ref|keyframe|clip <beat>` (regenerate one asset
  as a new version, then re-stitch).
- `character_sequence_wan.mjs [scenario]` — same shape but clips use **Wan 2.1 i2v**
  (`buildWanGraph`, video-only, no audio). Outputs to `outputs/<scenario>_wan/` so it never
  clobbers the LTX run.
- `dialogue_lipsync.mjs [scenario]` — **voice + lip-sync pass** over an already-generated
  project (run AFTER clips exist). JSON: beats carry
  `dialogue: [{ speaker, line }]` (+ optional `tts: { defaultVoice, voices }`).
  Per beat: Edge-TTS Hindi voice audio (`lib/tts.mjs`, `<prefix>_dlg<n>_<slug>.wav`,
  auto-cast rabbit→`hi-IN-SwaraNeural` / lion→`hi-IN-MadhurNeural`) → clip loop-extended
  to the audio length (stream-copy, so the `-c copy` stitch stays safe) → local
  Easy-Wav2Lip (`lib/lipsync.mjs`, `EASY_WAV2LIP_DIR`/`EASY_WAV2LIP_PYTHON` env) →
  synced take stored as a new clip version + clip main → final re-stitched with voices.
  Wav2Lip needs a clear (near-frontal) face: the Director stages speaking scenes as
  frontal Close-Ups; beats with no detectable face fall back to dubbed (voice muxed,
  no mouth movement) instead of failing. Flags: `--beats 9,11`, `--vertical`, `--wan`,
  `--skip-tts`, `--skip-lipsync`, `--no-stitch` (voice+sync clips but leave the final
  cut alone — review single scenes first, merge later with Stitch). The Rendered Clip
  header's 🎙 Dialogue button triggers it via `POST /api/runs` with `{ mode: "dialogue" }`;
  the Story Board's per-row 🎙 button runs one scene (`{ mode: "dialogue", beats: "N",
  noStitch: true }`). Fresh clips are generated AT the
  voice length (`beatTargetDuration` in both sequence runners reads the wav).
  Multi-speaker beats are segmented AUTOMATICALLY (`lib/dialogue_pipeline.mjs`:
  per-line timing from actual line-audio lengths via `planDialogueTiming`, one clip
  window per line synced to its own speaker's voice via `lipSyncBeatSegmented`, then
  merged as a new clip version; single-speaker beats keep the whole-beat path).
  Provider seams: `TTS_PROVIDER` (default `edge-tts`) and `LIPSYNC_PROVIDER`
  (`wav2lip` default, `musetalk-comfy` = `MUSETALK_WORKFLOW` JSON with
  `{{VIDEO}}`/`{{AUDIO}}` tokens on ComfyUI). The LipSync section selects the
  engine per run (`POST /api/runs` `{ mode: "dialogue", lipsync }` →
  `--lipsync` flag, recorded on the run); every beat (single- and
  multi-speaker) routes through it. Beats with no clip get a silent
  keyframe→i2v clip generated in-dialogue (LTX/Wan, 3–5s dialogue-fitted) so
  the section runs standalone from Character Image to Final Scene.
  `workflows/musetalk_lipsync.json` is a placeholder template until replaced
  with a real exported workflow — `musetalkWorkflowReady()` gates the UI
  option on actual tokens, never bare file existence. Dialogue APIs:
  `GET /api/project/:name/dialogue` (per-beat lines + voice/video/lipsync/final
  status, served by `beatDialogueStatus` from disk) and
  `PUT /api/project/:name/scene/:n/dialogue` (edit lines; stale voice wavs are
  deleted so status honestly returns to PENDING — TTS + lip-sync regen, clip kept).
  The Video LipSync page shows 🎙/🎬/👄/🎞 pills + SEG badge from that endpoint.
  Test scenario: `prompts/rabbit_lion_dialogue.json` (Rabbit+Lion Hindi E2E).
- `verify_learning.mjs <scenario> [--focus alphabet|counting|auto] [--beats 1,3]` —
  **letterform/numeral verifier** for ABC + counting boards, run AFTER keyframes
  exist but BEFORE clips generate. Extracts planned hero letters/counts per beat
  (`extractLearningExpectations` in `lib/director.mjs`: `A for Apple`, `letter B`,
  `अक्षर अ`, `5 ducks`, `५ तारे`, `तीन बिल्लियाँ`…) from beat titles + dialogue,
  resolves each beat's main keyframe via `resolveMain` (latest version wins),
  OCRs it with Tesseract (`--psm 8` then `6`, `eng+hin` with `eng` fallback) and
  compares via `verifyOcrText`. Exit 0 = all pass, 1 = missing letter/numeral
  (regenerate the keyframe), 2 = usage or Tesseract missing (install hint, never
  a silent pass). Emits `[asset] {"type":"learning-verify",…}` lines so a future
  UI run mode surfaces results. The Validate panel already carries the
  zero-dependency half: `learningReviewChecklist` (per-scene must-show lines for
  alphabet/counting boards) rides in validate `warnings`.
- `generate_song.mjs [folder]` — Create Song tab renderer (triggered via
  `POST /api/runs` with `{ mode: "song" }`). Two engines by `audio.songPreset`:
  song presets render **sung** via the selected audio model (`audio.songModel`:
  `"ace-step"` = ACE-Step 1.5 XL Turbo via `buildAceSongGraph`, `"minimax"` =
  MiniMax Music 3 via `buildMinimaxSongGraph`, `--song-model` CLI override;
  reference workflows in `workflows/Audio/`; lyrics auto-sanitized +
  `[verse]/[chorus]`-structured in `lib/songtext.mjs` —
  raw markdown/emoji/`...` lyrics come back as mumble/noise without this);
  narration presets (`kids-story-narration`, `devotional-narration`,
  `devotional-narration-music`) render
  **spoken** via Edge-TTS Hindi voices (`hi-IN-SwaraNeural`/`hi-IN-MadhurNeural`,
  duet alternates per paragraph); the music variant additionally renders an
  ACE-Step instrumental bed sized to the narration and mixes voice-over-bed
  (bed at 22% volume). Both write versioned
  `<prefix>_song[_vN].mp3` + `[asset]` events, so the UI needs no branching.
- Either runner takes **`--vertical`** for the 9:16 Instagram Reel cut: every asset is
  regenerated vertical (Flux 360×640, LTX `9:16 (Portrait Widescreen)` at 0.125MP, Wan 240×416,
  prompts gain a portrait-framing suffix) into `outputs/<scenario>[_wan]_vertical/`
  (see `lib/variant.mjs` — the single source of truth for the mapping). The landscape
  cut is never touched; the frontend's Reel card (`InstagramCut`) triggers it via
  `POST /api/runs` with `{ format: "vertical" }`. The Rendered Clip header's Video
  dropdown switches the workspace cut (YOUTUBE landscape / INSTAGRAM vertical):
  Reference, Story Board and Keyframes→clips all follow it (vertical regens run
  with `format: "vertical"`); the Reel card renders only on INSTAGRAM, plus the
  short-cut dropdown (`POST /api/reel-cut` trims the Reel final to 30/60/90s).
- `make_music.mjs [scenario]` — music-only: LTX **t2v** at tiny 64×64 (video throwaway),
  extracts the generated AAC to `.wav`; optionally lays it onto an existing video with the
  video's audio ducked. JSON: `{ musicPrompt, duration, fps?, size?, video?, videoVolume?, musicVolume?, out? }`.
- `movie_director.mjs [scenario]` — 20s LTX **t2v** narration at 64×64 + 5× 9:16 0.5MP
  trailer clips → final cut; `clipAudioVolume` mixes narration 100% / clip audio 20%.
- `man_eras.mjs` — 5-era character film.

Single-shot test tools: `run_flux_ltx_test.mjs` (one merged shot; ad-hoc via
`FLUX_PROMPT`/`LTX_PROMPT` env) and `run_flux_wan_test.mjs` (`prompts/wan_i2v.json`;
`--image <file>` skips Flux).

## Character-sequence implementation (important)
`character_sequence.mjs` and `character_sequence_wan.mjs` are **thin wrappers** — the shared
pipeline lives in `lib/sequence.mjs` (`runSequence`/`stitchSequence`); they differ only in the
clip builder and `videoNode` ("75" LTX / "56" Wan). `lib/sequence_state.mjs` handles
**versioned assets**: regenerating writes a new `_vN` file (never overwrites); the "main"
version per asset is recorded in `outputs/<scenario>/state.json` and is what gets stitched /
used as the keyframe a clip is generated from. Default main = latest version.

## frontend/ (web UI)
Serve the built UI + API: `npm install && npm run build` then `npm run serve`
(http://localhost:8790). Dev with hot reload: `npm run serve` + `npm run dev` (vite :5173,
proxies `/api` + `/outputs` + `/resources` + `/reface` to :8790). `build` = `tsc && vite build`.

Gotchas:
- **Scenarios live in Postgres** (`scenarios` table, canonical for the UI) by default —
  SQLite (`data/scenarios.sqlite`) is only used when `USE_SQLITE=true` is set in root
  `.env` (then SQLite is canonical and Postgres only mirrors saves). **Every
  save also writes `prompts/<name>.json`** so the CLI runners keep working (in either
  mode). Editing the JSON directly won't update the UI list — prefer the UI Save route.
- Auth is session-cookie based. Defaults `LOGIN_USER`/`LOGIN_PASS` = `admin`/`admin` from
  env — change these for anything non-local (server.mjs already forces login for `/api/*`
  and `/outputs/*`, plus `/resources/*` and `/reface/*`).
- `server.mjs` spawns the sequence scripts via `startRun()`; **only one run at a time** (the
  ComfyUI queue is serial) — new runs are rejected while one is `running`.
- **Reface studio** (`RefacePage.tsx` + `POST /api/reface/*`, files under `reface/<id>/`,
  served via `/reface/<id>/file/<path>` with range support): video uploads arrive as
  **raw binary** (`readRaw`, 500MB cap — not base64 JSON); reference faces stay base64
  data-URLs like every other image upload. One worker at a time (`refaceProcs`);
  progress is polled from `progress.json` (3s), never SSE.
- **Database tab** (`DatabasePage.tsx`, below Reface): generic SQLite browser + row
  CRUD over `data/scenarios.sqlite` + `data/devotional.sqlite` (`GET /api/database`
  overview, `GET/POST/PUT/DELETE /api/database/rows?db=&table=`). Identifiers are
  validated against the live schema and all values bound (no interpolated SQL);
  `IS` key lookups coerce numeric strings (`dbCoerceKey`) since `IS` skips type
  affinity. `scenarios` writes validate `config` JSON + mirror `prompts/<name>.json`;
  deleting a `devotional_assets` row cascades to its files/versions/jobs/links/usage
  (SQLite has no FK enforcement). Search is a case-insensitive LIKE across all
  columns; default order is `rowid DESC`.
- Runs stream script logs via SSE and parse `[asset] {...}` lines into live asset events —
  keep emitting `[asset]` JSON from any script you want surfaced in the UI.
- **Postgres catalog**: every finished generation is recorded in the `video_generator`
  DB (`project_assets` rows for keyframes/clips/finals, `project_references` rows
  for reference visuals; binaries stay in `outputs/`). `project_assets` carries a
  `video_type` cut dimension (`YOUTUBE` landscape / `INSTAGRAM` vertical, in the
  unique key) — both cuts keep a full per-scene row set; the Rendered Clip header
  dropdown switches which cut that card shows/generates. `server.mjs` marks rows
  complete on each `[asset]` event, refreshes the current version's file names on
  run exit, backfills projects on boot, and serves the gallery file list from
  disk. Scenario saves are
  versioned in `scenario_versions` (every PUT = new version, never overwrite;
  `GET /api/scenario/:name/versions[/:v]`); editor has no autosave — explicit Save only.
  Needs the `pg` npm dep + `PG_HOST`/`PG_PORT`/`PG_DATABASE`/`PG_USER`/`PG_PASSWORD`
  from root `.env` (see `.env.example`). `GET /api/db` reports catalog health/counts.
- "Craft" / "extend beat" features call a local llama-server at `LLM_BASE`
  (`/v1/chat/completions`, `chat_template_kwargs: {enable_thinking:false}`) to author
  scenario JSON. Every chat-completions POST in `server.mjs` goes through the shared
  `llmPostChat` helper, which transparently retries transport drops (socket hang up /
  reset / 429 / 502 / 503 / 504 — the LM Studio "Client disconnected" case) with
  exponential backoff (`LLM_RETRIES`, default 3, and `LLM_RETRY_BASE_MS` env overrides);
  timeouts and 4xx/model errors are never retried.

## Configuration
- `COMFY_BASE` (required) and `LLM_BASE` come from root `.env` via the tiny built-in loader
  in `lib/comfy.mjs` / `server.mjs`. **Never hardcode the ComfyUI URL in code or docs.**
  `.env.example` is the template. Real env vars always override `.env`.

## ComfyUI API facts (verified)
- Endpoints: `POST /prompt`, `GET /history/{id}`, `GET /view?...`,
  `POST /upload/image` (multipart: `image` + `overwrite`), `GET /object_info/{Node}`,
  `GET /system_stats`, `GET /queue`.
- **The reverse-proxy tunnel intermittently returns HTML error pages (404/502) instead of
  JSON.** All HTTP in `lib/comfy.mjs` retries on non-JSON content-type. Keep that.
- `SaveVideo` emits its file under `outputs[node].images` (not `.videos`).
- `LoadImage` can only read ComfyUI's **input** folder → external images must go through
  `uploadToInput()` first.
- History: `entry.outputs[nodeId]`, `entry.status.messages` has `["execution_error", ...]`
  on failure. `run()` throws with them.

## Workflow node map (the ones that matter)
`ltx2_5_i2v.json`:
- `395` LoadImage (first frame, input-folder filename)
- `398:376` prompt; `403` ResolutionSelector; `398:362`/`398:361` duration(s)/fps (frames=duration×fps+1)
- `398:363` "Switch to Text to Video?" (false=i2v; `buildLtxGraph({t2v:true})` sets true —
  used by movie_director/make_music to generate narration/music audio)
- `398:372`/`398:360` PrimitiveInt width/height — `buildLtxGraph({size:[w,h]})` sets these to
  literals, bypassing ResolutionSelector (lets us go below its 0.1MP floor, e.g. 64×64 runs)
- `398:383` "Enable Prompt Enhance" (leave false — gemma e2b not needed)
- `75` SaveVideo (final mp4). Latent gen runs at **half** resolution then 2× `LTXVLatentUpsampler`.
- **LTX-2.5 generates audio (AAC) alongside video — expected, not a bug.**

`flux-t2i.json`: `75:74` prompt, `75:68`/`75:69` w/h, `75:62` steps (default 4 in builder, base ships 20), `75:73` seed,
`75:65` VAEDecode (IMAGE — the bridge point), `9` SaveImage. Merged bridge:
`398:351`.inputs.input = `["75:65", 0]`; delete nodes `395` and `9`.
Keyframe ref anchor (`buildFluxImg2ImgGraph`): LoadImage (`ref:load`, uploaded main
ref version) → ImageScale (`ref:scale`, bilinear to target w/h, center crop) →
VAEEncode (`ref:vaeenc`, same `75:72` VAE); `75:64` latent_image rewired from
`75:66` (deleted) to `ref:vaeenc`. Falls back to pure t2i when no ref exists yet.

Flux.1-dev GGUF workflows (`TextToImage/Flux_Text_to_image.json`,
`TextToImage/Flux_REFERENCE_IMAGE.json` — the SAME graph, different shipped
size/prompt; API builders `buildFluxTextImageGraph` / `buildFluxReferenceImageGraph`):
`39` DualCLIPLoader (clip_l + t5xxl, type flux), `6` CLIPTextEncode (prompt),
`33` CLIPTextEncode (negative — stays EMPTY: Flux.1-dev has no negative
prompt at cfg 1, the graph's own Note says so), `35` FluxGuidance
(3.5), `38` UnetLoaderGGUF (`flux1-dev-Q8_0.gguf`), `27` EmptySD3LatentImage
(w/h), `31` KSampler (seed — random, as authored; steps 20, cfg 1,
euler/simple), `40` VAELoader
(`flux_vae.safetensors`), `8` VAEDecode, `9` SaveImage. **Pure text-to-image —
no image input node, so these modes never anchor on a reference picture.**
`buildImageGraph(mode, …)` (lib/comfy.mjs) is the dispatcher the header
dropdown drives: `flux` → Klein t2i/img2img, `flux_text_image` →
text-to-image, `flux_reference_image` → reference-image. The reference-image
workflow is NEVER re-tuned: its own size/steps/seed/negative stay as shipped
(`tests/image_workflows.test.mjs` compares the built graph against the
workflow FILE node for node).

`image_to_video_wan.json` (Wan 2.1 i2v): `52` LoadImage; `6`/`7` positive/negative CLIPTextEncode;
`50` WanImageToVideo (w/h min 16 step 16; `length`=frames, **4n+1**, step 4 — 33≈2s at fixed
16fps of `55` CreateVideo); `3` KSampler (8 steps, cfg 1, uni_pc/simple — AccVid LoRA);
`56` SaveVideo. **Wan is video-only (no generated audio).**

## Models on the remote box (RTX 3080 Ti, 12GB)
- UNets: `flux-2-klein-9b-fp8`, `ltx-2.5-22b-distilled-transformer-comfy-int8-convrot`,
  `wan2.1-i2v-14b-480p-Q4_K_M.gguf` (+ `Wan21_AccVid_I2V_480P_14B_lora_rank32` LoRA)
- CLIPs: `qwen_3_8b_fp4mixed` (flux), `gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot` (ltx),
  `umt5_xxl_fp8_e4m3fn_scaled` (wan), `clip_vision_h`
- VAEs: `flux2-vae`, `ltx-2.5-video-vae-bf16`, `ltx-2.5-audio-vae-bf16`, `wan_2.1_vae`
- Upscaler: `ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0`

## Performance
- Back-to-back runs are much faster (models stay in VRAM): ~30s vs ~120s for i2v.
- Flux decode of one frame is <1s — don't try to "optimize it away"; the VAEs are
  incompatible between Flux and LTX, pixels are the only bridge.
- Keep `megapixels` at 0.5 for 16:9 (960×512) unless quality demands otherwise.

## Debugging
- `curl $COMFY_BASE/system_stats` — is the box alive? `curl $COMFY_BASE/queue` — stuck?
  `curl $COMFY_BASE/object_info/{Node}` — node schema.
- Execution errors land in `entry.status.messages` — `run()` throws with them.
