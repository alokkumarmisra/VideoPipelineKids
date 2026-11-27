// Idempotent, review-ready sample production for the Movie workspace.
import fs from "node:fs";
import { addCharacterReference, addMovieCharacter, addMovieCostume, createMovieProject, getMovieProject, listMovieProjects, movieDb, reviewCharacterReference, reviewCostume, saveMovieProduction, setCanonicalReference } from "../frontend/movieStore.mjs";
import { normalizeMovieCharacter } from "../lib/movie.mjs";

const findOrCreateProject = () => listMovieProjects().find((row) => row.title === "Gabbar") || createMovieProject("Gabbar");
const projectRow = findOrCreateProject();
let project = getMovieProject(projectRow.movie_id);
let gabbar = project.characters.find((row) => row.name === "Gabbar");
if (!gabbar) {
  const existing = movieDb.prepare("SELECT character_id FROM movie_characters WHERE lower(name)=lower('Gabbar')").get();
  if (existing) throw new Error(`Gabbar already exists as ${existing.character_id} in another movie; resolve it in the Character Bible first.`);
  gabbar = addMovieCharacter(project.movie_id, normalizeMovieCharacter({
    name: "Gabbar",
    identity: {
      age: "48", gender_presentation: "masculine", height: "5 ft 11 in", body_type: "lean, weathered, broad-shouldered",
      skin_tone: "warm medium brown", facial_structure: "rugged oval face, strong brow", eye_shape_color: "deep-set dark brown eyes",
      nose_shape: "straight, broad bridge", lips: "medium lips, usually set", jawline: "square jaw with light stubble",
      hairstyle: "shoulder-length wavy hair", hair_color: "black with a few gray strands",
      distinguishing_features: "thick curled moustache; healed diagonal scar on right cheek",
    },
    personality: "guarded and intimidating at first, quietly protective, decisive under pressure",
    background: "A former bandit who now watches the dry ravines and keeps an old signal tower working.",
    voice_profile: "low, gravelly Hindi voice; measured pace; restrained warmth beneath a stern delivery",
    relationships: [],
    description: "Original fictional frontier watchman; this sample is not modeled on a real actor or existing film character.",
  }));
}

const assets = [
  { view: "canonical_face", file: "data/movie/references/gabbar-canonical-v1.png" },
  { view: "full_body_front", file: "data/movie/references/gabbar-full-body-v1.png" },
  { view: "left_profile", file: "data/movie/references/gabbar-left-profile-v1.png" },
];
for (const asset of assets) {
  if (!fs.existsSync(asset.file)) throw new Error(`Sample character reference is missing: ${asset.file}`);
  const existing = gabbar.references.find((ref) => ref.view === asset.view && ref.file_path === asset.file);
  if (!existing) {
    const ref = addCharacterReference(gabbar.character_id, asset.view, asset.file);
    reviewCharacterReference(ref.reference_id, "approved");
  }
}
project = getMovieProject(project.movie_id);
gabbar = project.characters.find((row) => row.character_id === gabbar.character_id);
if (!gabbar.canonical_reference_id) {
  const canonical = gabbar.references.find((ref) => ref.view === "canonical_face" && ref.status === "approved");
  if (!canonical) throw new Error("Approved canonical portrait was not saved");
  gabbar = setCanonicalReference(gabbar.character_id, canonical.reference_id);
}

const costumeName = "Ravine Watch — Olive Kurta";
let costume = gabbar.costumes.find((row) => row.name === costumeName);
if (!costume) costume = addMovieCostume(gabbar.character_id, {
  name: costumeName,
  description: "Faded olive cotton kurta, dark charcoal woven shoulder scarf, worn brown boots; no jewelry.",
  color: "olive brown, charcoal, worn leather",
  fabric: "coarse cotton and handwoven wool",
  accessories: "dark shoulder scarf, worn boots",
  reference_path: "data/movie/references/gabbar-full-body-v1.png",
});
if (costume.approval_status !== "approved") costume = reviewCostume(costume.costume_id, "approved");

const c = gabbar.character_id, w = costume.costume_id;
const scenes = [
  {
    scene_id: "MOV_GABBAR_SC01", scene_number: 1, title: "The Last Lantern", location: "Dry ravine — watchman's shelter", time_of_day: "late dusk",
    duration_seconds: 32, status: "planned",
    summary: "Gabbar finds the old brass signal lantern extinguished as the first storm clouds gather beyond the ravine.",
    continuity_start: { costume_id: w, hair: "dry, wind-tossed", physical_condition: "uninjured", dirt: "dust on sleeves and boots", wetness: "dry", accessories: ["dark scarf"], carried_objects: [], position: "inside the shelter doorway", orientation: "facing east", emotion: "watchful" },
    continuity_end: { costume_id: w, hair: "dry, wind-tossed", physical_condition: "uninjured", dirt: "dust on sleeves and boots", wetness: "dry", accessories: ["dark scarf"], carried_objects: ["brass signal lantern"], position: "leaving the shelter toward the ridge", orientation: "facing east", emotion: "resolved" },
    state_snapshots: [{ snapshot_id:"MOV_GABBAR_STATE_SC01", character_id:c, version:1, approved:true, state:{ costume_id:w, hair_condition:"dry, wind-tossed", physical_condition:"uninjured", injuries:[], dirt:"dust on sleeves and boots", blood:"none", wetness:"dry", accessories:["dark scarf"], carried_objects:["brass signal lantern"], position:"leaving the shelter toward the ridge", orientation:"facing east", emotional_state:"resolved" } }],
    shots: [
      { shot_id:"MOV_GABBAR_SC01_SH01", shot_number:1, character_ids:[c], costume_ids:[w], action:"Gabbar notices the unlit brass lantern on a shelf", body_movement:"He stops at the threshold and turns his head toward it", expression:"wary, focused", emotion:"watchful", dialogue:"", camera_angle:"eye level", camera_movement:"slow push in", shot_size:"medium wide", lighting:"blue dusk with warm spill from a small oil lamp", composition:"Gabbar foreground left; lantern readable in the right third", duration_seconds:14, continuity:{ preserve_dry_costume:true, scar_on_right_cheek_visible:true }, status:"planned" },
      { shot_id:"MOV_GABBAR_SC01_SH02", shot_number:2, character_ids:[c], costume_ids:[w], action:"He lifts the lantern and checks its wick", body_movement:"One hand steadies the handle while he leans closer", expression:"quiet concern", emotion:"concern turning to resolve", dialogue:"Gabbar: 'Aaj raat koi raasta nahi bhatkega.'", camera_angle:"slight low angle", camera_movement:"gentle tilt from lantern to face", shot_size:"medium close-up", lighting:"warm practical glow against cool dusk", composition:"Hands and lantern in foreground, face remains unobstructed", duration_seconds:18, continuity:{ lantern_becomes_carried_object:true, costume_unchanged:true }, status:"planned" },
    ],
  },
  {
    scene_id: "MOV_GABBAR_SC02", scene_number: 2, title: "Across the Ridge", location: "Ravine ridge trail", time_of_day: "night, storm beginning",
    duration_seconds: 34, status: "planned",
    summary: "Carrying the lantern, Gabbar crosses the exposed ridge while a light rain begins.",
    continuity_start: { costume_id:w, hair:"dry, wind-tossed", physical_condition:"uninjured", dirt:"dust on sleeves and boots", wetness:"dry", accessories:["dark scarf"], carried_objects:["brass signal lantern"], position:"ridge trail entrance", orientation:"facing east", emotion:"resolved" },
    continuity_end: { costume_id:w, hair:"damp at the ends", physical_condition:"uninjured", dirt:"dust darkened by rain on boots", wetness:"light rain on shoulders and scarf", accessories:["dark scarf"], carried_objects:["brass signal lantern"], position:"at the foot of the signal tower", orientation:"looking upward", emotion:"determined" },
    state_snapshots: [{ snapshot_id:"MOV_GABBAR_STATE_SC02", character_id:c, version:1, approved:true, state:{ costume_id:w, hair_condition:"damp at the ends", physical_condition:"uninjured", injuries:[], dirt:"dust darkened by rain on boots", blood:"none", wetness:"light rain on shoulders and scarf", accessories:["dark scarf"], carried_objects:["brass signal lantern"], position:"at the foot of the signal tower", orientation:"looking upward", emotional_state:"determined" } }],
    shots: [
      { shot_id:"MOV_GABBAR_SC02_SH01", shot_number:1, character_ids:[c], costume_ids:[w], action:"Gabbar walks carefully along the ridge with the lantern", body_movement:"Measured steps; free hand shields the lantern from wind", expression:"intent, alert", emotion:"determination", dialogue:"", camera_angle:"eye level profile", camera_movement:"parallel tracking shot", shot_size:"wide", lighting:"moonless blue night with distant storm flashes", composition:"Silhouette on ridge line; lantern is the only warm point", duration_seconds:18, continuity:{ carried_lantern_from_SC01:true, rain_begins_during_shot:true, outfit_starts_dry:true }, status:"planned" },
      { shot_id:"MOV_GABBAR_SC02_SH02", shot_number:2, character_ids:[c], costume_ids:[w], action:"He reaches the tower and looks up at the dark beacon", body_movement:"Stops, catches his breath, then grips the wet railing", expression:"focused resolve", emotion:"urgency", dialogue:"Gabbar: 'Bas ek roshni aur.'", camera_angle:"low angle from tower base", camera_movement:"tilt up with a short push", shot_size:"medium", lighting:"rain sheen with intermittent lightning edge light", composition:"Tower rises behind him; cheek scar and face remain identifiable", duration_seconds:16, continuity:{ wetness_progresses_to_light:true, lantern_stays_in_left_hand:true }, status:"planned" },
    ],
  },
  {
    scene_id: "MOV_GABBAR_SC03", scene_number: 3, title: "A Signal at Dawn", location: "Signal tower platform", time_of_day: "pre-dawn",
    duration_seconds: 38, status: "planned",
    summary: "Gabbar relights the beacon and stays beside it until a distant answering light appears.",
    continuity_start: { costume_id:w, hair:"damp at the ends", physical_condition:"uninjured", dirt:"dust darkened by rain on boots", wetness:"light rain on shoulders and scarf", accessories:["dark scarf"], carried_objects:["brass signal lantern"], position:"signal tower platform", orientation:"toward the beacon", emotion:"determined" },
    continuity_end: { costume_id:w, hair:"damp, settling", physical_condition:"tired but uninjured", dirt:"same rain-darkened dust", wetness:"damp scarf and shoulders, beginning to dry", accessories:["dark scarf"], carried_objects:["brass signal lantern"], position:"beside the lit beacon", orientation:"facing the distant valley", emotion:"quiet relief" },
    state_snapshots: [{ snapshot_id:"MOV_GABBAR_STATE_SC03", character_id:c, version:1, approved:true, state:{ costume_id:w, hair_condition:"damp, settling", physical_condition:"tired but uninjured", injuries:[], dirt:"same rain-darkened dust", blood:"none", wetness:"damp scarf and shoulders, beginning to dry", accessories:["dark scarf"], carried_objects:["brass signal lantern"], position:"beside the lit beacon", orientation:"facing the distant valley", emotional_state:"quiet relief" } }],
    shots: [
      { shot_id:"MOV_GABBAR_SC03_SH01", shot_number:1, character_ids:[c], costume_ids:[w], action:"Gabbar lights the beacon and shields its flame until it catches", body_movement:"He cups both hands around the flame, then steps back", expression:"strained focus easing into relief", emotion:"hope", dialogue:"", camera_angle:"three-quarter eye level", camera_movement:"slow arc from hands to face", shot_size:"medium close-up", lighting:"beacon glow warms his face; first pale dawn on the horizon", composition:"Flame foreground, same scar and moustache visible, valley soft behind", duration_seconds:20, continuity:{ wet_costume_and_hair_continue_from_SC02:true, beacon_changes_from_dark_to_lit:true }, status:"planned" },
      { shot_id:"MOV_GABBAR_SC03_SH02", shot_number:2, character_ids:[c], costume_ids:[w], action:"He sees a distant answering light and lowers his shoulders", body_movement:"A small exhale; hands relax at his sides", expression:"restrained, human relief", emotion:"hope fulfilled", dialogue:"Gabbar: 'Pahunch gaye.'", camera_angle:"over-shoulder then face", camera_movement:"gentle pull back", shot_size:"wide into close-up", lighting:"soft dawn with warm beacon rim light", composition:"Answering light in the valley, then hold on Gabbar's unchanged face", duration_seconds:18, continuity:{ beacon_remains_lit:true, scarf_remains_damp:true, no_costume_change:true }, status:"planned" },
    ],
  },
];

const screenplay = {
  genre: "Adventure drama",
  status: "approved-sample",
  logline: "On a storm-darkened ridge, a guarded watchman risks the night to relight a beacon and guide unseen travelers to safety.",
  synopsis: "Gabbar, an isolated ravine watchman, discovers that the old signal lantern has gone dark. As rain moves across the ridge, he carries it to a failing tower, relights the beacon, and waits through the storm. A distant answering light tells him the signal reached its destination. The short film turns a feared silhouette into a quiet protector through action rather than exposition.",
  plot: [
    { act:1, title:"The dark lantern", beats:["Gabbar discovers the extinguished signal lantern.","He decides to carry it to the ridge tower."] },
    { act:2, title:"The exposed ridge", beats:["He crosses the trail as rain begins.","He reaches the tower with the flame still protected."] },
    { act:3, title:"The answering light", beats:["He relights the beacon.","A distant light answers; Gabbar stays until the valley is safe."] },
  ],
  screenplay_text: `FADE IN:\n\n1. INT. RAVINE WATCHMAN'S SHELTER — DUSK\nDust moves through a narrow beam of lamplight. GABBAR notices a brass signal lantern, dark and cold. He checks the wick, then looks toward the ridge.\n\nGABBAR\nAaj raat koi raasta nahi bhatkega.\n\nHe takes the lantern.\n\n2. EXT. RAVINE RIDGE TRAIL — NIGHT\nWind pushes at Gabbar's scarf. He shields the lantern as the first rain reaches the trail. A dark signal tower rises ahead.\n\nGABBAR\nBas ek roshni aur.\n\n3. EXT. SIGNAL TOWER PLATFORM — PRE-DAWN\nGabbar cups his hands around the flame. The beacon catches and paints the wet stone gold. He waits. Across the valley, a small answering light appears.\n\nGABBAR\nPahunch gaye.\n\nHe remains beside the beacon as dawn begins.\n\nFADE OUT.`,
};

const saved = saveMovieProduction(project.movie_id, screenplay, scenes);
console.log(JSON.stringify({ movie_id: saved.movie_id, title: saved.title, character_id: gabbar.character_id,
  canonical_reference_id: gabbar.canonical_reference_id, costume_id: costume.costume_id,
  scenes: saved.scenes.length, shots: saved.scenes.reduce((sum, scene) => sum + scene.shots.length, 0) }));
