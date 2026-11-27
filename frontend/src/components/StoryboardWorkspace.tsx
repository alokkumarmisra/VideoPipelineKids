import { useEffect, useMemo, useRef, useState } from "react";
import {
  directorSongUrl,
  directorStoryboard,
  directorStoryboardValidate,
  type DirectorBoard,
  type StoryboardEvent,
  type StoryboardScene,
  type StoryboardValidation,
  type StoryboardView,
} from "../api";

// Storyboard Planner 2.0 workspace. READ-ONLY by design: it visualises the
// board the existing Director engine planned and the approved timeline that
// drove it. It never edits timestamps, starts a run, or replaces Generate /
// Continue / Stop / Approve — those stay in DirectorPage.

const TRACK_LABELS: Record<string, string> = {
  original_audio: "Original Audio",
  music_structure: "Music Structure",
  lyrics: "Lyrics",
  word_timings: "Word Timings",
  speaker_events: "Speaker Events",
  narrative_events: "Narrative Events",
  character_appearances: "Character Appearances",
  character_actions: "Character Actions",
  emotions: "Emotions",
  dialogue_performance: "Dialogue Performance",
  choreography: "Choreography",
  camera_direction: "Camera Direction",
  scene_timeline: "Scene Timeline",
  shot_timeline: "Shot Timeline",
  lip_sync: "Lip-Sync",
  sound_effects: "Sound Effects",
  video_assets: "Video Assets",
  transitions: "Transitions",
  subtitles: "Subtitles",
};

const txt = (v: unknown) => (v == null ? "" : String(v));
const sec = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const clock = (v: unknown) => {
  const s = Math.max(0, sec(v));
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

type ViewMode = "grid" | "list" | "timeline";

export default function StoryboardWorkspace({
  boardId,
  board,
  livePhase,
}: {
  boardId?: string | null;
  board?: DirectorBoard | null;
  livePhase?: string;
}) {
  const [mode, setMode] = useState<ViewMode>("grid");
  const [view, setView] = useState<StoryboardView | null>(null);
  const [validation, setValidation] = useState<StoryboardValidation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [showFindings, setShowFindings] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const boardStamp = `${board?.updatedAt || ""}|${board?.scenes?.length ?? 0}|${board?.status || ""}`;
  useEffect(() => {
    if (!boardId) {
      setView(null);
      setValidation(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([directorStoryboard(boardId), directorStoryboardValidate(boardId)])
      .then(([v, q]) => {
        if (cancelled) return;
        setView(v);
        setValidation(q);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String((e as Error)?.message || e));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // boardStamp refreshes the snapshot after each saved batch/approval.
  }, [boardId, boardStamp]);

  const duration = Math.max(1, sec(view?.timeline.durationSec));
  const scenes = useMemo(() => view?.scenes || [], [view]);
  const activeScene = useMemo(
    () => scenes.find((s) => s.scene_number === selected) || null,
    [scenes, selected],
  );
  const audioUrl = board?.input?.song?.file
    ? directorSongUrl(board.input.song.file)
    : board?.input?.sourceAudio?.file
      ? directorSongUrl(board.input.sourceAudio.file)
      : null;

  const seek = (to: number) => {
    const t = Math.max(0, Math.min(duration, sec(to)));
    setPlayhead(t);
    const a = audioRef.current;
    if (a && Number.isFinite(a.duration)) a.currentTime = Math.min(t, a.duration);
  };

  const eventStyle = (e: StoryboardEvent) => {
    const start = Math.max(0, sec(e.start));
    const end = Math.max(start, sec(e.end));
    return {
      left: `${(start / duration) * 100}%`,
      width: `${Math.max(0.6, ((end - start) / duration) * 100)}%`,
    };
  };

  const selectScene = (n: number) => {
    setSelected((prev) => (prev === n ? null : n));
    const s = scenes.find((x) => x.scene_number === n);
    if (s?.start != null) seek(s.start);
  };

  const renderSceneCard = (s: StoryboardScene) => (
    <button
      type="button"
      key={s.scene_number}
      className={`sbw-scene-card${selected === s.scene_number ? " active" : ""}`}
      onClick={() => selectScene(s.scene_number)}
    >
      <div className="sbw-scene-top">
        <span className="sbw-scene-num">S{s.scene_number}</span>
        <span className="sbw-scene-time">{clock(s.start)}–{clock(s.end)} · {sec(s.duration)}s</span>
        {s.timing_source ? <span className="pill ok">timed</span> : null}
      </div>
      <div className="sbw-scene-title">{txt(s.title) || `Scene ${s.scene_number}`}</div>
      <div className="sbw-scene-action">{txt(s.action) || "(no visible action)"}</div>
      <div className="sbw-scene-tags">
        {txt(s.location) ? <span className="pill">📍 {txt(s.location)}</span> : null}
        {(s.characters || []).length ? <span className="pill">👥 {s.characters.length}</span> : null}
        <span className="pill">🎬 {s.shots.length} shot{s.shots.length === 1 ? "" : "s"}</span>
      </div>
      <div className="sbw-scene-bar">
        <span style={{ left: `${Math.max(0, (sec(s.start) / duration) * 100)}%`, width: `${Math.max(1, ((sec(s.end) - sec(s.start)) / duration) * 100)}%` }} />
      </div>
    </button>
  );

  const renderList = () => (
    <div className="sbw-list">
      {scenes.length ? scenes.map((s) => (
        <div key={s.scene_number} className={`sbw-list-row${selected === s.scene_number ? " active" : ""}`}>
          <button type="button" className="sbw-list-open" onClick={() => selectScene(s.scene_number)}>
            <span className="sbw-list-n">S{s.scene_number}</span>
            <span className="sbw-list-main">
              <strong>{txt(s.title) || `Scene ${s.scene_number}`}</strong>
              <small>{clock(s.start)}–{clock(s.end)} · {txt(s.action).slice(0, 140)}</small>
            </span>
          </button>
          <div className="sbw-shot-strip">
            {s.shots.length ? s.shots.map((sh) => (
              <span key={sh.shot_id} className="sbw-shot" title={`${txt(sh.action)} · ${txt(sh.shot_type)} ${txt(sh.angle)} ${txt(sh.movement)}`}>
                <b>{txt(sh.shot_id)}</b>
                <small>{clock(sh.start)}–{clock(sh.end)}</small>
              </span>
            )) : <span className="muted">1 scene shot</span>}
          </div>
        </div>
      )) : <div className="sbw-empty">No scenes planned yet. Generate scenes in the Director panel below.</div>}
    </div>
  );

  const renderTimeline = () => {
    const tracks = view?.timeline.tracks || {};
    const names = Object.keys(TRACK_LABELS);
    return (
      <div className="sbw-timeline">
        {audioUrl ? (
          <audio
            ref={audioRef}
            controls
            preload="metadata"
            src={audioUrl}
            onTimeUpdate={(e) => setPlayhead(sec(e.currentTarget.currentTime))}
            onLoadedMetadata={(e) => setPlayhead(sec(e.currentTarget.currentTime))}
          />
        ) : (
          <div className="sbw-no-audio muted">No uploaded audio — the ruler is still aligned to the approved timeline. Click the ruler to move the playhead.</div>
        )}
        <div className="sbw-ruler" onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          seek(((e.clientX - r.left) / Math.max(1, r.width)) * duration);
        }}>
          {[0, 0.25, 0.5, 0.75, 1].map((p) => <span key={p} style={{ left: `${p * 100}%` }}>{clock(duration * p)}</span>)}
        </div>
        <div className="sbw-timeline-scroll">
          <div className="sbw-lane sbw-scene-lane">
            <div className="sbw-lane-label">Scenes</div>
            <div className="sbw-lane-track">
              {scenes.map((s) => (
                <button
                  type="button"
                  key={s.scene_number}
                  className={`sbw-scene-block${selected === s.scene_number ? " active" : ""}`}
                  style={eventStyle({ id: `s${s.scene_number}`, trackId: "scene", start: s.start ?? 0, end: s.end ?? 0, label: s.title } as StoryboardEvent)}
                  onClick={() => selectScene(s.scene_number)}
                  title={`S${s.scene_number}: ${txt(s.title)}`}
                >S{s.scene_number}</button>
              ))}
            </div>
          </div>
          {names.map((name) => {
            const events = tracks[name] || [];
            return (
              <div className="sbw-lane" key={name}>
                <div className="sbw-lane-label">{TRACK_LABELS[name]}</div>
                <div className="sbw-lane-track">
                  {events.map((e, i) => (
                    <span
                      key={`${e.id || name}-${i}`}
                      className={`sbw-event sbw-event-${name}`}
                      style={eventStyle(e)}
                      title={`${TRACK_LABELS[name]} · ${clock(e.start)}–${clock(e.end)} · ${txt(e.label)}`}
                      onClick={() => seek(e.start)}
                    >{txt(e.label).slice(0, 28)}</span>
                  ))}
                </div>
              </div>
            );
          })}
          <div className="sbw-playhead" style={{ left: `calc(108px + (100% - 108px) * ${Math.min(1, playhead / duration)})` }}>
            <span>{clock(playhead)}</span>
          </div>
        </div>
      </div>
    );
  };

  const cov = view?.coverage;
  const valErrors = validation?.errors || [];
  const valWarnings = validation?.warnings || [];

  return (
    <section className="card sbw-card" id="storyboard-workspace">
      <div className="card-head">
        <div>
          <h3>🎞 Storyboard Studio 2.0</h3>
          <div className="card-desc">
            Read-only cinematic view of the approved timeline and the Director's scene plan. Timing authority: {txt(view?.timeline.source || "loading…")}
            {view?.timeline.approvedAt ? ` · approved ${txt(view.timeline.approvedAt).slice(0, 19).replace("T", " ")}` : ""}
          </div>
        </div>
        <div className="sbw-head-actions">
          <div className="sbw-modes">
            {(["grid", "list", "timeline"] as ViewMode[]).map((m) => (
              <button type="button" key={m} className={mode === m ? "active" : ""} onClick={() => setMode(m)}>
                {m === "grid" ? "▦ Grid" : m === "list" ? "☰ List" : "⏱ Timeline"}
              </button>
            ))}
          </div>
          <button type="button" className="btn-blue" onClick={() => {
            if (!boardId) return;
            setLoading(true);
            Promise.all([directorStoryboard(boardId), directorStoryboardValidate(boardId)])
              .then(([v, q]) => { setView(v); setValidation(q); setError(null); })
              .catch((e: unknown) => setError(String((e as Error)?.message || e)))
              .finally(() => setLoading(false));
          }} disabled={!boardId || loading}>{loading ? "Loading…" : "↻ Refresh"}</button>
        </div>
      </div>

      <div className="sbw-phases">
        {(view?.phases || []).map((phase, i) => (
          <span key={phase} className={`sbw-phase${livePhase === phase ? " active" : ""}`} title={`Stage ${i + 1}`}>
            <b>{i + 1}</b>{phase}
          </span>
        ))}
      </div>

      {error ? <div className="err-text">Storyboard view failed: {error}</div> : null}
      {!boardId ? <div className="sbw-empty">Open or generate a Director board to see its cinematic storyboard.</div> : null}
      {boardId && !view && loading ? <div className="sbw-empty">Reading the approved timeline and scene plan…</div> : null}

      {view ? (
        <>
          <div className="sbw-cov">
            <span className={`pill ${cov?.complete ? "ok" : "warn"}`}>
              {cov?.complete ? "✓ Coverage verified" : "⚠ Coverage needs review"}
            </span>
            <span className="pill">{cov?.coveragePercent ?? 0}% story events covered</span>
            <span className="pill">{cov?.durationCoveragePercent ?? 0}% audio duration planned</span>
            <span className="pill">🎬 {cov?.sceneCount ?? 0} scenes · {cov?.shotCount ?? 0} shots</span>
            <span className={`pill ${validation?.canApprove ? "ok" : "err"}`}>
              {validation?.canApprove ? "Ready for review" : `${valErrors.length} critical error${valErrors.length === 1 ? "" : "s"}`}
            </span>
            <button type="button" className="link-btn" onClick={() => setShowFindings((v) => !v)}>
              {showFindings ? "Hide report" : "Coverage & validation report"}
            </button>
          </div>
          {showFindings ? (
            <div className="sbw-report">
              <div className="sbw-report-col">
                <h4>Coverage</h4>
                <ul>
                  <li>Planned {sec(cov?.plannedDuration)}s of {sec(cov?.totalAudioDuration)}s · {sec(cov?.unplannedDuration)}s unplanned</li>
                  <li>Ending {cov?.endingCovered ? "covered" : "NOT covered"}</li>
                  <li>Instrumentals: {cov?.instrumentalCoverage.covered ?? 0}/{cov?.instrumentalCoverage.total ?? 0} planned</li>
                  {(cov?.uncoveredLyricEvents.length || 0) > 0 ? <li className="err-text">Uncovered lyrics: {cov?.uncoveredLyricEvents.map((l) => `L${txt(l.lineId || l.id)} @ ${clock(l.start)}`).join(", ")}</li> : null}
                  {(cov?.uncoveredNarrativeEvents.length || 0) > 0 ? <li className="err-text">Uncovered narrative: {cov?.uncoveredNarrativeEvents.map((e) => txt(e.label).slice(0, 48)).join("; ")}</li> : null}
                  {(cov?.uncoveredNarrativeEvents.length || 0) === 0 && (cov?.uncoveredLyricEvents.length || 0) === 0 ? <li className="muted">No uncovered lyric or narrative events.</li> : null}
                  {(cov?.gaps.length || 0) > 0 ? <li>Unplanned gaps: {cov?.gaps.map((g) => `${clock(g.from)}–${clock(g.to)} (${g.seconds}s${g.intentional ? ", intentional" : ""})`).join(", ")}</li> : null}
                  {(cov?.overlaps.length || 0) > 0 ? <li className="warn-text">Overlaps: {cov?.overlaps.map((o) => `S${o.scene} @ ${clock(o.start)}`).join(", ")}</li> : null}
                  {(cov?.continuityWarnings.length || 0) > 0 ? <li className="warn-text">Continuity: {cov?.continuityWarnings.join("; ")}</li> : null}
                </ul>
              </div>
              <div className="sbw-report-col">
                <h4 className="err-text">Critical ({valErrors.length})</h4>
                {valErrors.length ? <ul>{valErrors.slice(0, 12).map((e, i) => <li key={`${e.code}-${i}`}><b>{e.code}</b>: {e.message}</li>)}</ul> : <p className="muted">No critical pre-approval errors.</p>}
                <h4 className="warn-text">Advisory ({valWarnings.length})</h4>
                {valWarnings.length ? <ul>{valWarnings.slice(0, 12).map((w, i) => <li key={`${w.code}-${i}`}><b>{w.code}</b>: {w.message}</li>)}</ul> : <p className="muted">No advisory warnings.</p>}
              </div>
            </div>
          ) : null}

          <div className="sbw-body">
            <div className="sbw-main">
              {mode === "grid" ? <div className="sbw-grid">{scenes.length ? scenes.map(renderSceneCard) : <div className="sbw-empty">No scenes planned yet.</div>}</div> : null}
              {mode === "list" ? renderList() : null}
              {mode === "timeline" ? renderTimeline() : null}
            </div>
            <aside className="sbw-inspector">
              <h4>Scene inspector</h4>
              {activeScene ? (
                <>
                  <div className="sbw-inspector-head">
                    <span className="pill">S{activeScene.scene_number}</span>
                    <strong>{txt(activeScene.title) || "Untitled scene"}</strong>
                    <small>{clock(activeScene.start)}–{clock(activeScene.end)} · {sec(activeScene.duration)}s</small>
                  </div>
                  <dl className="sbw-dl">
                    <dt>Action</dt><dd>{txt(activeScene.action) || "—"}</dd>
                    <dt>Emotion</dt><dd>{txt(activeScene.emotion) || txt(activeScene.expression) || "—"}</dd>
                    <dt>Cast</dt><dd>{(activeScene.characters || []).join(", ") || "—"}</dd>
                    <dt>Location</dt><dd>{txt(activeScene.location) || "—"}</dd>
                    <dt>Objects</dt><dd>{(activeScene.objects || []).join(", ") || "—"}</dd>
                    <dt>Camera</dt><dd>{[txt((activeScene.camera as Record<string, unknown> | null)?.shot_type), txt((activeScene.camera as Record<string, unknown> | null)?.angle), txt((activeScene.camera as Record<string, unknown> | null)?.movement)].filter(Boolean).join(" · ") || "—"}</dd>
                    <dt>Lighting</dt><dd>{txt(activeScene.lighting) || "—"}</dd>
                    <dt>Source lines</dt><dd>{(activeScene.source_line_ids || []).map((n) => `L${n}`).join(", ") || "—"}</dd>
                    <dt>Continuity</dt><dd>{txt(activeScene.continuity?.from_previous) || "—"}</dd>
                    <dt>Transition</dt><dd>{txt(activeScene.transition) || txt(activeScene.continuity?.to_next) || "—"}</dd>
                  </dl>
                  <h5>Shots ({activeScene.shots.length})</h5>
                  <div className="sbw-inspector-shots">
                    {activeScene.shots.length ? activeScene.shots.map((sh) => (
                      <div key={sh.shot_id} className="sbw-inspector-shot">
                        <b>{txt(sh.shot_id)}</b> <small>{clock(sh.start)}–{clock(sh.end)}</small>
                        <div>{txt(sh.action) || "—"}</div>
                        <div className="muted">{[txt(sh.shot_type), txt(sh.angle), txt(sh.movement)].filter(Boolean).join(" · ") || "—"}{sh.lip_sync_required ? " · lip-sync" : ""}</div>
                        {txt(sh.image_prompt) ? <details><summary>Image prompt</summary><pre>{txt(sh.image_prompt)}</pre></details> : null}
                        {txt(sh.video_prompt) ? <details><summary>Motion prompt</summary><pre>{txt(sh.video_prompt)}</pre></details> : null}
                      </div>
                    )) : <p className="muted">No separate shots — this scene is one beat.</p>}
                  </div>
                </>
              ) : (
                <p className="muted">Select a scene card, list row or timeline block to inspect its cast, action, camera, prompts and timing references.</p>
              )}
            </aside>
          </div>
          <div className="sbw-footnote">
            {txt(view.note)} The workspace is read-only: Generate / Continue / Stop, Repair and Approve remain in the Director panel. No automatic content-safety scan is performed — human review is required.
          </div>
        </>
      ) : null}
    </section>
  );
}
