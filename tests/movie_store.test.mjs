import test from "node:test";
import assert from "node:assert/strict";
import { movieDb, createMovieProject, addMovieCharacter, getMovieProject, saveMovieProduction, createMovieJob, updateMovieJob, addMovieShotAsset, listMovieJobs, updateMovieCharacter, addCharacterReference, importMovieCharacterReference, reviewCharacterReference, setCanonicalReference, setCharacterApproval, addMovieEnvironmentAsset, updateMovieEnvironmentAsset, setMovieEnvironmentReference, reviewMovieEnvironmentReference, setMovieEnvironmentLock } from "../frontend/movieStore.mjs";
import { normalizeMovieCharacter, buildMovieReferencePacket } from "../lib/movie.mjs";

test("Movie identity records are globally numbered, versioned, and approval locked", () => {
  const project = createMovieProject(`movie-store-test-${Date.now()}`);
  try {
    const character = addMovieCharacter(project.movie_id, normalizeMovieCharacter({ name: `Test Character ${Date.now()}`, identity: { skin_tone: "olive" } }));
    assert.match(character.character_id, /^CHAR_\d{3,}$/);
    assert.equal(character.identity_version, 1);
    const ref = addCharacterReference(character.character_id, "canonical_face", "test-reference.png");
    reviewCharacterReference(ref.reference_id, "approved");
    const locked = setCanonicalReference(character.character_id, ref.reference_id);
    assert.equal(locked.identity_locked, true);
    assert.equal(locked.approval_status, "approved");
    assert.throws(() => updateMovieCharacter(character.character_id, normalizeMovieCharacter({ name: character.name, identity: { skin_tone: "blue" } }, character), false), /new identity version/);
    const changed = updateMovieCharacter(character.character_id, normalizeMovieCharacter({ name: character.name, identity: { skin_tone: "blue" } }, character), true);
    assert.equal(changed.identity_version, 2);
    assert.equal(changed.canonical_reference_id, null);
    assert.equal(changed.identity_locked, false);
    assert.throws(() => setCharacterApproval(character.character_id, "approved"), /current identity version/);
    assert.throws(() => buildMovieReferencePacket({ movieId: project.movie_id, character: changed }), /approved canonical/);
    const reused = importMovieCharacterReference(character.character_id, "canonical_face", "director_assets/board/characters/CHAR_001/reference.png", "board", "CHAR_001");
    assert.equal(reused.status, "approved");
    assert.equal(reused.source_board_id, "board");
    const relocked = setCanonicalReference(character.character_id, reused.reference_id);
    assert.equal(buildMovieReferencePacket({ movieId: project.movie_id, character: relocked }).canonical_face_reference, "director_assets/board/characters/CHAR_001/reference.png");
    const sceneId = `${project.movie_id}_SC01`;
    const saved = saveMovieProduction(project.movie_id, { logline: "A sample", screenplay_text: "FADE IN" }, [{
      scene_id: sceneId, scene_number: 1, title: "Opening", duration_seconds: 8, shots: [{ shot_id: `${sceneId}_SH01`, shot_number: 1,
        character_ids: [character.character_id], action: "turns", camera_angle: "eye level", duration_seconds: 8 }],
      state_snapshots: [{ snapshot_id: `${sceneId}_STATE01`, character_id: character.character_id, version: 1, approved: true, state: { wetness: "dry" } }],
    }]);
    assert.equal(saved.screenplay.logline, "A sample");
    assert.equal(saved.scenes[0].shots[0].character_ids[0], character.character_id);
    assert.equal(saved.scenes[0].state_snapshots[0].state.wetness, "dry");
    const job = createMovieJob({ movie_id:project.movie_id, shot_id:`${sceneId}_SH01`, kind:"keyframe", prompt:"locked sample prompt", workflow:"flux", model:"flux-2-klein-9b" });
    updateMovieJob(job.job_id, { status:"review", asset_path:"data/movie/Movies/sample/keyframe_v1.png" });
    const asset = addMovieShotAsset({ shot_id:`${sceneId}_SH01`, job_id:job.job_id, kind:"keyframe", version:1,
      file_path:"data/movie/Movies/sample/keyframe_v1.png", prompt:job.prompt, workflow:job.workflow, model:job.model });
    const media = listMovieJobs(project.movie_id);
    assert.equal(media.jobs[0].status, "review");
    assert.equal(media.assets[0].asset_id, asset.asset_id);
    assert.equal(getMovieProject(project.movie_id).characters.length, 1);
  } finally {
    movieDb.prepare("DELETE FROM movie_projects WHERE movie_id=?").run(project.movie_id);
  }
});

test("Movie locations and objects version, review, and lock their canonical reference", () => {
  const project = createMovieProject(`movie-environment-test-${Date.now()}`);
  try {
    const location = addMovieEnvironmentAsset(project.movie_id, { kind:"location", name:"Test Ridge", aliases:["upper ridge"], description:"three stone arches" });
    assert.equal(location.identity_version, 1);
    assert.throws(() => setMovieEnvironmentLock(location.asset_id, true), /Approve a canonical/);
    setMovieEnvironmentReference(location.asset_id, "data/movie/references/test-ridge.png");
    reviewMovieEnvironmentReference(location.asset_id, "approved");
    const locked = setMovieEnvironmentLock(location.asset_id, true);
    assert.equal(locked.identity_locked, true);
    assert.equal(locked.approval_status, "approved");
    assert.throws(() => updateMovieEnvironmentAsset(location.asset_id, { name:"Changed Ridge" }), /Unlock/);
    setMovieEnvironmentLock(location.asset_id, false);
    const changed = updateMovieEnvironmentAsset(location.asset_id, { name:"Changed Ridge", description:"two arches", aliases:["new ridge"] });
    assert.equal(changed.identity_version, 2);
    assert.equal(changed.reference_path, null);
    assert.equal(changed.reference_status, "missing");
    assert.deepEqual(getMovieProject(project.movie_id).environment_assets.map((asset) => asset.asset_id), [location.asset_id]);
  } finally {
    movieDb.prepare("DELETE FROM movie_projects WHERE movie_id=?").run(project.movie_id);
  }
});
