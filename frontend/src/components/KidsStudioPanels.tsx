import { useCallback, useEffect, useMemo, useState } from "react";
import {
  kidsPipeline, kidsRunPipeline, kidsPipelineCatalog,
  kidsStory, kidsGenerateStory, kidsSaveStory, kidsApproveStory,
  kidsLyrics, kidsAnalyzeLyrics,
  kidsAudioAnalysis, kidsRunAudioAnalysis,
  kidsTimeline, kidsBuildTimeline, kidsSaveTimeline,
  kidsLibrary, kidsCreateLibraryAsset, kidsUpdateLibraryAsset, kidsDeleteLibraryAsset,
  kidsGenerateReference, kidsFileUrl, kidsJobs,
  kidsRunQc, kidsQc, kidsRecordExport, kidsExports,
  kidsFeedbackList, kidsSaveFeedback,
  type KidsStage, type KidsPipelineServices,
  type KidsStory, type KidsStoryVersion,
  type KidsLyricSection, type KidsAudioSegment, type KidsTimelineRow,
  type KidsLibraryAsset, type KidsQcCheck, type KidsQcRun, type KidsExport, type KidsFeedback,
} from "../kidsApi";
import { IconCheck, IconClapper, IconFolder, IconRefresh, IconSparkles, IconTrash, Spinner } from "./Icons";

// ---------------------------------------------------------------------------
// The Sanskriti Kids studio panels.
//
// Every panel talks to the REAL backend (/api/kids/*) and renders what the
// server returns. Nothing here fabricates a metric, a progress bar or a
// success state — an empty studio shows an empty studio.
// ---------------------------------------------------------------------------

const card = (children: React.ReactNode, style?: React.CSSProperties) => (
  <section className="card" style={{ marginBottom: 16, ...style }}>{children}</section>
);

const head = (title: string, right?: React.ReactNode, sub?: string) => (
  <div className="card-head" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
    <div style={{ flex: 1, minWidth: 180 }}>
      <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{title}</h2>
      {sub && <div className="hint" style={{ margin: "2px 0 0" }}>{sub}</div>}
    </div>
    {right}
  </div>
);

const field = (label: string, input: React.ReactNode, hint?: string) => (
  <div style={{ marginBottom: 12 }}>
    <label style={{ display: "block", marginBottom: 6, fontWeight: 600, fontSize: 13 }}>{label}</label>
    {input}
    {hint && <div className="hint" style={{ marginTop: 4 }}>{hint}</div>}
  </div>
);

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "7px 9px", border: "1px solid var(--line, #e5e7eb)",
  borderRadius: 6, fontSize: 13, background: "var(--inset, #fff)",
  color: "var(--text, #111827)", boxSizing: "border-box",
};

const fmtTime = (s: number) => {
  const n = Number(s) || 0;
  const m = Math.floor(n / 60);
  const sec = Math.floor(n % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
};

const stageTone = (status: string) => {
  if (status === "done") return "ok";
  if (status === "blocked") return "err";
  return "warn";
};

// =====================================================================
// 1. The production pipeline (the 16 stages)
// =====================================================================

export function KidsPipelinePanel({ projectId, onChanged, onImageMode, onOpenProject, projectName }: {
  projectId: string | null;
  onChanged?: () => void;
  onImageMode?: (mode: "flux" | "flux_text_image" | "flux_reference_image") => void;
  onOpenProject?: (name: string) => void;
  /** The workspace project this studio project was approved into. */
  projectName?: string | null;
}) {
  const [stages, setStages] = useState<KidsStage[]>([]);
  const [runnable, setRunnable] = useState<string[]>([]);
  const [services, setServices] = useState<KidsPipelineServices | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const catalog = await kidsPipelineCatalog();
      setServices(catalog.services);
      if (!projectId) { setStages(catalog.stages); setRunnable([]); return; }
      const p = await kidsPipeline(projectId);
      setStages(p.stages);
      setRunnable(p.runnable);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const run = async (ids: string[]) => {
    if (!projectId || !ids.length) return;
    setBusy(ids.join(","));
    setError("");
    setMessage("");
    try {
      const r = await kidsRunPipeline(projectId, ids);
      const done = r.results.filter((x) => x.status === "completed").length;
      const failed = r.results.filter((x) => x.status === "failed").length;
      const delegated = r.results.filter((x) => x.status === "delegated").length;
      setMessage(
        `${done} stage(s) completed` +
        (failed ? `, ${failed} failed` : "") +
        (delegated ? `, ${delegated} delegated to the shared engines` : ""),
      );
      setStages(r.stages);
      setRunnable(r.runnable);
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const groups = useMemo(() => {
    const out: Record<string, KidsStage[]> = {};
    for (const s of stages) (out[s.group] ||= []).push(s);
    return out;
  }, [stages]);

  return (
    <>
      {card(
        <>
          {head("Production pipeline", (
            <button className="btn sm" onClick={() => { void load(); }} disabled={loading}>
              {loading ? <Spinner size={13} /> : <><IconRefresh size={13} /> Refresh</>}
            </button>
          ), "Every stage shows its REAL status — the counts come from the project rows and the files on disk.")}
          {services && (
            <div className="row" style={{ marginTop: 10 }}>
              <span className={`pill ${services.llm.up ? "ok" : "err"}`}>LLM {services.llm.up ? "up" : "offline"}</span>
              <span className={`pill ${services.comfyui.up ? "ok" : "err"}`}>ComfyUI {services.comfyui.up ? "up" : "offline"}</span>
              <span className={`pill ${services.whisper.up ? "ok" : "warn"}`} title={services.whisper.note}>Whisper {services.whisper.up ? "ready" : "not configured"}</span>
              <span className={`pill ${services.lipsync.up ? "ok" : "warn"}`} title={services.lipsync.note}>Lip sync {services.lipsync.up ? "ready" : "not configured"}</span>
              <span className="pill ok">TTS {services.tts.up ? "ready" : "offline"}</span>
            </div>
          )}
          {error && <div className="hint err-text" style={{ marginTop: 10 }}>{error}</div>}
          {message && <div className="hint" style={{ marginTop: 10 }}>{message}</div>}
        </>
      )}

      {!projectId && (
        <div className="hint">Open a project to run its production stages.</div>
      )}

      {projectId && (
        <div className="row" style={{ marginBottom: 12 }}>
          <button
            className="btn sm primary"
            disabled={!selected.length || busy !== null}
            onClick={() => { void run(selected); }}
          >
            {busy ? <Spinner size={13} /> : <><IconClapper size={13} /> Run the selected stages</>}
          </button>
          <button
            className="btn sm"
            disabled={!runnable.length || busy !== null}
            onClick={() => { void run(runnable); }}
          >
            Run everything that is ready ({runnable.length})
          </button>
          <button className="btn sm ghost" onClick={() => setSelected([])}>Clear selection</button>
        </div>
      )}

      {Object.entries(groups).map(([group, list]) => (
        <div key={group}>
          <div style={{ fontWeight: 600, fontSize: 13, margin: "12px 0 6px", textTransform: "capitalize" }}>{group}</div>
          <div className="grid grid-3">
            {list.map((s) => {
              const checked = selected.includes(s.id);
              return (
                <div key={s.id} style={{
                  border: "1px solid var(--line, #e5e7eb)", borderRadius: 8, padding: 10,
                  background: "var(--inset, #fff)",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                    {projectId && (
                      <input
                        type="checkbox"
                        checked={checked}
                        aria-label={`Select ${s.label}`}
                        onChange={(e) => setSelected((prev) => (e.target.checked
                          ? [...prev, s.id]
                          : prev.filter((x) => x !== s.id)))}
                      />
                    )}
                    <strong style={{ fontSize: 12.5, flex: 1 }}>{s.label}</strong>
                    <span className={`pill ${stageTone(s.status)}`}>{s.status}</span>
                  </div>
                  <div className="hint" style={{ margin: 0 }}>{s.description}</div>
                  <div className="hint" style={{ margin: "4px 0 0" }}>
                    engine: {s.engine} · outputs: {s.output_count}
                    {s.blocked_by.length ? ` · blocked by ${s.blocked_by.join(", ")}` : ""}
                    {s.advisory_pending?.length ? ` · advised: ${s.advisory_pending.join(", ")}` : ""}
                  </div>
                  {projectId && (
                    <button
                      className="btn sm"
                      style={{ marginTop: 6 }}
                      disabled={busy !== null}
                      onClick={() => { void run([s.id]); }}
                    >
                      Run this stage
                    </button>
                  )}
                  {(s.id === "images" || s.id === "video") && (
                    <div className="hint" style={{ marginTop: 6 }}>
                      Scene keyframes must run in <strong>Flux t2i</strong> mode — it is the only mode
                      that anchors on the approved character reference. The library reference stills
                      themselves always use the Flux Reference Image workflow (the saved prompt only).
                      <div className="row" style={{ marginTop: 4 }}>
                        <button
                          className="btn sm"
                          onClick={() => { onImageMode?.("flux"); setMessage("the header image dropdown is now Flux t2i (img2img anchor)"); }}
                        >
                          Use Flux t2i mode
                        </button>
                        {onOpenProject && projectName && (
                          <button className="btn sm" onClick={() => onOpenProject(projectName)}>
                            Open the workspace
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}

// =====================================================================
// 2. Story Studio
// =====================================================================

export function KidsStoryStudioPanel({ projectId, onChanged }: {
  projectId: string | null;
  onChanged?: () => void;
}) {
  const [story, setStory] = useState<KidsStoryVersion | null>(null);
  const [history, setHistory] = useState<KidsStoryVersion[]>([]);
  const [draft, setDraft] = useState<KidsStory | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<{ id: string; status: string; error_message?: string | null } | null>(null);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);

  const load = useCallback(async () => {
    if (!projectId) return;
    setError("");
    try {
      const r = await kidsStory(projectId);
      setStory(r.story);
      setHistory(r.history || []);
      setDraft(r.story ? r.story.story : null);
      setJob((r as unknown as { job?: { id: string; status: string; error_message?: string | null } }).job || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  // The AI story runs as a background job — poll it until it finishes.
  useEffect(() => {
    if (!projectId || !job || job.status !== "PROCESSING") return;
    const t = window.setInterval(() => {
      void load().then(() => onChanged?.());
    }, 4000);
    return () => window.clearInterval(t);
  }, [projectId, job, load, onChanged]);

  const generate = async () => {
    if (!projectId) return;
    setBusy(true); setError(""); setWarnings([]);
    try {
      await kidsGenerateStory(projectId);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const save = async () => {
    if (!projectId || !draft) return;
    setBusy(true); setError(""); setWarnings([]);
    try {
      const r = await kidsSaveStory(projectId, draft, { unlock: story?.status === "approved" });
      setStory(r.story);
      setWarnings(r.warnings || []);
      setEditing(false);
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const approve = async () => {
    if (!projectId) return;
    setBusy(true); setError(""); setWarnings([]);
    try {
      const r = await kidsApproveStory(projectId);
      setStory(r.story);
      setWarnings(r.warnings || []);
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  if (!projectId) return <div className="hint">Open a project to write its story.</div>;

  return (
    <>
      {card(
        <>
          {head("Story Studio", (
            <div className="row">
              <button className="btn sm primary" onClick={() => { void generate(); }} disabled={busy}>
                {busy ? <Spinner size={13} /> : <><IconSparkles size={13} /> Write the story</>}
              </button>
              {story && (
                <button className="btn sm" onClick={() => setEditing((v) => !v)}>
                  {editing ? "Stop editing" : "Edit"}
                </button>
              )}
              {story && (
                <button className="btn sm" onClick={() => { void save(); }} disabled={busy || !editing}>
                  Save as a new version
                </button>
              )}
              {story && (
                <button className="btn sm" onClick={() => { void approve(); }} disabled={busy}>
                  <IconCheck size={13} /> Approve
                </button>
              )}
            </div>
          ), "Topic → outline → characters → scene breakdown → dialogue → narration → storyboard → production plan.")}
          {error && <div className="hint err-text" style={{ marginTop: 8 }}>{error}</div>}
          {warnings.map((w) => <div key={w} className="hint warn-text" style={{ marginTop: 4 }}>{w}</div>)}
          {job && (
            <div className="hint" style={{ marginTop: 8 }}>
              job {job.id}: {job.status}
              {job.status === "PROCESSING" ? " — the local model is writing the story, this panel updates itself" : ""}
              {job.status === "FAILED" && job.error_message ? ` — ${job.error_message}` : ""}
            </div>
          )}
          {!story && !busy && (
            <div className="hint" style={{ marginTop: 8 }}>
              No story yet — press <strong>Write the story</strong>. The Director Plan and the shared storyboard
              stay the source of truth; this document is the studio&apos;s editable layer on top of them.
            </div>
          )}
          {story && (
            <div className="hint" style={{ marginTop: 8 }}>
              version {story.version} · {story.status} · {story.note || "no note"}
              {story.status === "approved" ? " — an approved story is locked until you edit it explicitly." : ""}
            </div>
          )}
        </>
      )}

      {draft && (
        card(
          <>
            {head("The story document")}
            {editing ? (
              <>
                {field("Title", <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} style={inputStyle} />)}
                {field("Learning objective", <textarea rows={2} value={draft.learning_objective} onChange={(e) => setDraft({ ...draft, learning_objective: e.target.value })} style={inputStyle} />)}
                {field("Beginning", <textarea rows={3} value={draft.beginning} onChange={(e) => setDraft({ ...draft, beginning: e.target.value })} style={inputStyle} />)}
                {field("Middle", <textarea rows={3} value={draft.middle} onChange={(e) => setDraft({ ...draft, middle: e.target.value })} style={inputStyle} />)}
                {field("Ending", <textarea rows={3} value={draft.ending} onChange={(e) => setDraft({ ...draft, ending: e.target.value })} style={inputStyle} />)}
                {field("Visual continuity", <textarea rows={2} value={draft.visual_continuity} onChange={(e) => setDraft({ ...draft, visual_continuity: e.target.value })} style={inputStyle} />)}
                <div className="hint">
                  Characters, dialogue, narration and the scene breakdown are edited in the panels below — they
                  belong to the shared storyboard and the character library.
                </div>
              </>
            ) : (
              <>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{draft.title || "(untitled)"}</div>
                <div className="hint" style={{ marginTop: 2 }}>
                  {draft.age_group || "no age group"} · {draft.learning_objective || "no learning objective"}
                </div>
                {draft.description && <p style={{ fontSize: 13, margin: "8px 0" }}>{draft.description}</p>}
                <div className="grid">
                  <div>
                    <div className="hint" style={{ margin: 0 }}>Beginning</div>
                    <div style={{ fontSize: 13 }}>{draft.beginning || "—"}</div>
                  </div>
                  <div>
                    <div className="hint" style={{ margin: 0 }}>Middle</div>
                    <div style={{ fontSize: 13 }}>{draft.middle || "—"}</div>
                  </div>
                </div>
                <div className="hint" style={{ marginTop: 8 }}>Ending</div>
                <div style={{ fontSize: 13 }}>{draft.ending || "—"}</div>
              </>
            )}
          </>
        )
      )}

      {draft && draft.characters.length > 0 && (
        card(
          <>
            {head(`Characters (${draft.characters.length})`, undefined,
              "The canonical look of every character — the library holds the approved prompt and reference.")}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {draft.characters.map((c) => (
                <div key={c.character_id} style={{ border: "1px solid var(--line, #e5e7eb)", borderRadius: 6, padding: 9 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <strong style={{ fontSize: 13 }}>{c.name}</strong>
                    <span className="pill">{c.role || c.category || "character"}</span>
                    <span className="pill">{c.character_id}</span>
                  </div>
                  <div className="hint" style={{ marginTop: 4 }}>{c.appearance}</div>
                  {c.voice && <div className="hint">voice: {c.voice}</div>}
                  {c.movement && <div className="hint">movement: {c.movement}</div>}
                </div>
              ))}
            </div>
          </>
        )
      )}

      {draft && draft.scenes.length > 0 && (
        card(
          <>
            {head(`Scene breakdown (${draft.scenes.length})`)}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {draft.scenes.map((s) => (
                <div key={s.scene_number} style={{ border: "1px solid var(--line, #e5e7eb)", borderRadius: 6, padding: 9 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <strong style={{ fontSize: 13 }}>#{s.scene_number} {s.title}</strong>
                    <span className="pill">{s.duration_seconds || 0}s</span>
                    {s.camera_shot && <span className="pill">{s.camera_shot}</span>}
                    {s.location && <span className="pill">{s.location}</span>}
                  </div>
                  <div className="hint" style={{ marginTop: 4 }}>{s.action || s.description}</div>
                  {s.image_prompt && <div className="hint">image prompt: {s.image_prompt.slice(0, 220)}</div>}
                </div>
              ))}
            </div>
          </>
        )
      )}

      {draft && (draft.safety.concerns.length > 0 || draft.warnings.length > 0) && (
        card(
          <>
            {head("Safety and teacher notes")}
            {[...draft.safety.concerns, ...draft.warnings].map((w) => (
              <div key={w} className="hint warn-text">{w}</div>
            ))}
          </>
        )
      )}

      {history.length > 0 && (
        card(
          <>
            {head(`Story versions (${history.length})`)}
            <div className="row">
              {history.map((h) => (
                <span key={h.id} className={`pill ${h.status === "approved" ? "ok" : ""}`}>
                  v{h.version} · {h.status}
                </span>
              ))}
            </div>
          </>
        )
      )}
    </>
  );
}

// =====================================================================
// 3. Song & Lyrics Studio
// =====================================================================

export function KidsSongStudioPanel({ projectId, onChanged }: {
  projectId: string | null;
  onChanged?: () => void;
}) {
  const [sections, setSections] = useState<KidsLyricSection[]>([]);
  const [source, setSource] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const r = await kidsLyrics(projectId);
      setSections(r.sections || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const analyze = async (useLlm: boolean) => {
    if (!projectId) return;
    setBusy(true); setError("");
    try {
      const r = await kidsAnalyzeLyrics(projectId, { ...(lyrics ? { lyrics } : {}), use_llm: useLlm });
      setSections(r.sections || []);
      setSource(r.source || "");
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  if (!projectId) return <div className="hint">Open a project to segment its lyrics.</div>;

  return (
    <>
      {card(
        <>
          {head("Song and Lyrics Studio", (
            <div className="row">
              <button className="btn sm primary" onClick={() => { void analyze(false); }} disabled={busy}>
                {busy ? <Spinner size={13} /> : <><IconSparkles size={13} /> Segment the lyrics</>}
              </button>
              <button className="btn sm" onClick={() => { void analyze(true); }} disabled={busy}>
                Label with the AI
              </button>
            </div>
          ), "Verses, choruses, intros, outros and instrumental parts — with the timing and the choreography.")}
          {field("Lyrics (optional — the project lyrics are used when this is empty)", (
            <textarea rows={6} value={lyrics} onChange={(e) => setLyrics(e.target.value)} style={inputStyle}
              placeholder={"[Verse 1]\nEk do teen chaar\n[Chorus]\n..."} />
          ), "You can also upload an audio file in the brief — the studio then measures the real timing.")}
          {error && <div className="hint err-text">{error}</div>}
          {source && <div className="hint">segments from: {source}</div>}
        </>
      )}

      {sections.length === 0 ? (
        <div className="hint">No lyric sections yet.</div>
      ) : (
        card(
          <>
            {head(`Lyric sections (${sections.length})`, undefined,
              "A timing without a measured word-level alignment is marked as an estimate.")}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {sections.map((s) => (
                <div key={s.seq} style={{ border: "1px solid var(--line, #e5e7eb)", borderRadius: 6, padding: 9 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span className="pill">{s.label}</span>
                    <span className="pill">{fmtTime(s.start_seconds)} – {fmtTime(s.end_seconds)}</span>
                    {s.estimated && <span className="pill warn">estimated timing</span>}
                    {s.lip_sync && <span className="pill ok">lip sync</span>}
                    {s.emotion && <span className="pill">{s.emotion}</span>}
                  </div>
                  <div style={{ fontSize: 13, marginTop: 6, whiteSpace: "pre-wrap" }}>{s.text || "(no text)"}</div>
                  {s.choreography && <div className="hint">choreography: {s.choreography}</div>}
                </div>
              ))}
            </div>
          </>
        )
      )}
    </>
  );
}

// =====================================================================
// 4. Audio Analysis and Narration
// =====================================================================

export function KidsAudioStudioPanel({ projectId, onChanged }: {
  projectId: string | null;
  onChanged?: () => void;
}) {
  const [segments, setSegments] = useState<KidsAudioSegment[]>([]);
  const [analysis, setAnalysis] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const r = await kidsAudioAnalysis(projectId);
      setSegments(r.segments || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const run = async () => {
    if (!projectId) return;
    setBusy(true); setError("");
    try {
      const r = await kidsRunAudioAnalysis(projectId);
      setSegments(r.segments || []);
      setAnalysis(r.analysis as unknown as Record<string, unknown>);
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  if (!projectId) return <div className="hint">Open a project to analyse its audio.</div>;

  const tone = (type: string) => {
    if (type === "singing" || type === "dialogue" || type === "narration") return "#fbbf24";
    if (type === "music") return "#38bdf8";
    if (type === "sound_effect") return "#a78bfa";
    return "#cbd5e1";
  };

  return (
    <>
      {card(
        <>
          {head("Audio Analysis and Narration", (
            <button className="btn sm primary" onClick={() => { void run(); }} disabled={busy}>
              {busy ? <Spinner size={13} /> : <><IconRefresh size={13} /> Analyse the audio</>}
            </button>
          ), "The duration, the silence, the beats and the transcript — measured, never guessed.")}
          {error && <div className="hint err-text">{error}</div>}
          {analysis && (
            <div className="row" style={{ marginTop: 8 }}>
              {analysis.mood ? <span className="pill">{String(analysis.mood)}</span> : null}
              {analysis.structure ? <span className="pill">{String(analysis.structure)}</span> : null}
              {analysis.source ? <span className="pill">source: {String(analysis.source)}</span> : null}
              {analysis.duration_seconds ? <span className="pill">{fmtTime(Number(analysis.duration_seconds))}</span> : null}
            </div>
          )}
        </>
      )}

      {segments.length === 0 ? (
        <div className="hint">No audio analysed yet — attach an audio file in the brief first.</div>
      ) : (
        card(
          <>
            {head(`Audio timeline (${segments.length} segments)`)}
            <div style={{ display: "flex", height: 18, borderRadius: 4, overflow: "hidden", marginBottom: 10 }}>
              {segments.map((s, i) => (
                <div
                  key={i}
                  title={`${s.type} ${s.start_seconds}s–${s.end_seconds}s`}
                  style={{
                    flex: `${Math.max(0.1, s.duration_seconds)} 1 0`,
                    background: tone(s.type),
                    borderRight: "1px solid rgba(255,255,255,.6)",
                  }}
                />
              ))}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {segments.map((s) => (
                <div key={s.seq} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
                  <span className="pill" style={{ background: tone(s.type), color: "#111827", border: "none" }}>{s.type}</span>
                  <span style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                    {s.start_seconds.toFixed(1)}–{s.end_seconds.toFixed(1)}s
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {s.text || s.music_note || s.action || "—"}
                    {s.estimated && <span className="hint"> (estimated)</span>}
                  </span>
                </div>
              ))}
            </div>
          </>
        )
      )}
    </>
  );
}

// =====================================================================
// 5. The reusable asset library
// =====================================================================

const LIB_KINDS: { id: "character" | "location" | "prop"; label: string }[] = [
  { id: "character", label: "Characters" },
  { id: "location", label: "Locations" },
  { id: "prop", label: "Props" },
];

export function KidsLibraryPanel({ projectId, onChanged }: {
  projectId: string | null;
  onChanged?: () => void;
}) {
  const [kind, setKind] = useState<"character" | "location" | "prop">("character");
  const [assets, setAssets] = useState<KidsLibraryAsset[]>([]);
  const [categories, setCategories] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [draft, setDraft] = useState<Partial<KidsLibraryAsset>>({});
  // The reference still is rendered by the Flux Reference Image workflow — a
  // JOB (the ComfyUI queue is serial), so the panel polls while it runs.
  const [job, setJob] = useState<{ id: string; status: string; error_message?: string | null; assetId?: number } | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const r = await kidsLibrary(kind ? { kind } : {});
      setAssets(r.assets || []);
      setCategories(r.categories || {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [kind]);

  useEffect(() => { void load(); }, [load]);

  // Poll the reference job until it finishes.
  useEffect(() => {
    if (!job || job.status !== "PENDING" && job.status !== "PROCESSING") return;
    const t = window.setInterval(() => {
      void (async () => {
        try {
          const jobs = await kidsJobs({ kind: "library_reference" });
          const found = jobs.jobs.find((j) => j.id === job.id);
          if (found) {
            setJob((prev) => (prev ? { ...prev, status: found.status, error_message: found.error_message } : prev));
            if (found.status === "COMPLETED" || found.status === "FAILED") {
              await load();
              onChanged?.();
            }
          }
        } catch { /* the poll is best-effort */ }
      })();
    }, 4000);
    return () => window.clearInterval(t);
  }, [job, projectId, load, onChanged]);

  const create = async () => {
    if (!draft.name) { setError("the asset needs a name"); return; }
    setBusy(true); setError("");
    try {
      await kidsCreateLibraryAsset({
        ...draft,
        kind,
        project_id: projectId || undefined,
        scope: projectId ? "project" : "shared",
      });
      setDraft({});
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const update = async (asset: KidsLibraryAsset, patch: Record<string, unknown>) => {
    setBusy(true); setError("");
    try {
      await kidsUpdateLibraryAsset(asset.id, patch);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const remove = async (asset: KidsLibraryAsset) => {
    setBusy(true); setError("");
    try {
      await kidsDeleteLibraryAsset(asset.id);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  // Generate the reference still. The SAVED PROMPT goes to the Flux
  // Reference Image workflow exactly as stored — the workflow is used as
  // authored and only the prompt node changes.
  const generateReference = async (asset: KidsLibraryAsset) => {
    setBusy(true); setError(""); setMessage("");
    try {
      const r = await kidsGenerateReference(asset.id);
      setJob({ id: r.job.id, status: r.job.status, assetId: asset.id });
      setMessage(r.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const set = (patch: Partial<KidsLibraryAsset>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <>
      {card(
        <>
          {head("Asset library", (
            <div className="row">
              {LIB_KINDS.map((k) => (
                <button
                  key={k.id}
                  className={`btn sm${kind === k.id ? " primary" : ""}`}
                  onClick={() => setKind(k.id)}
                >
                  {k.label}
                </button>
              ))}
              <button className="btn sm" onClick={() => { void load(); }}>
                <IconRefresh size={13} /> Refresh
              </button>
            </div>
          ), "Reusable characters, locations and props — an approved entry keeps the same look in every scene.")}
          {error && <div className="hint err-text" style={{ marginTop: 8 }}>{error}</div>}
        </>
      )}

      {card(
        <>
          {head(`New ${kind}`)}
          <div className="grid">
            {field("Name", <input value={draft.name || ""} onChange={(e) => set({ name: e.target.value })} style={inputStyle} />)}
            {field("Category", (
              <input
                value={draft.category || ""}
                list="kids-lib-categories"
                onChange={(e) => set({ category: e.target.value })}
                style={inputStyle}
              />
            ), (categories[kind] || []).join(", "))}
          </div>
          {field("Approved visual prompt (the only text sent to the image model)", (
            <textarea rows={3} value={draft.prompt || ""} onChange={(e) => set({ prompt: e.target.value })} style={inputStyle}
              placeholder={kind === "character" ? "a small golden puppy with a red bandana, 3d preschool animation, front view" : "a sunny green garden with a wooden fence"} />
          ), "The reference still is rendered with the Flux Reference Image workflow — this text is passed to it exactly as written (only the prompt node of the workflow changes).")}
          {field("Description", <textarea rows={2} value={draft.description || ""} onChange={(e) => set({ description: e.target.value })} style={inputStyle} />)}
          {kind === "character" && (
            <div className="grid">
              {field("Appearance", <textarea rows={2} value={draft.appearance || ""} onChange={(e) => set({ appearance: e.target.value })} style={inputStyle} />)}
              {field("Clothing / colors", <textarea rows={2} value={draft.clothing || ""} onChange={(e) => set({ clothing: e.target.value })} style={inputStyle} />)}
              {field("Personality", <input value={draft.personality || ""} onChange={(e) => set({ personality: e.target.value })} style={inputStyle} />)}
              {field("Voice", <input value={draft.voice || ""} onChange={(e) => set({ voice: e.target.value })} style={inputStyle} />, "A licensed Edge-TTS voice id (e.g. hi-IN-SwaraNeural) — it is used for this character in every scene.")}
              {field("Movement / animation style", <input value={draft.movement || ""} onChange={(e) => set({ movement: e.target.value })} style={inputStyle} />)}
              {field("Reference image (resource id or file name)", <input value={draft.reference_image || ""} onChange={(e) => set({ reference_image: e.target.value })} style={inputStyle} />)}
            </div>
          )}
          <div className="row">
            <button className="btn sm primary" onClick={() => { void create(); }} disabled={busy}>
              {busy ? <Spinner size={13} /> : <><IconFolder size={13} /> Save to the library</>}
            </button>
            {projectId
              ? <span className="hint">saved for this project — uncheck the project scope to share it</span>
              : <span className="hint">shared across every kids project</span>}
          </div>
        </>
      )}

      {card(
        <>
          {head(`${kind === "character" ? "Characters" : kind === "location" ? "Locations" : "Props"} (${assets.length})`)}
          {assets.length === 0 ? (
            <div className="hint">Nothing in the library yet.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {assets.map((a) => {
                const files = a.files || [];
                const main = files.length ? files[files.length - 1] : null;
                const running = job && job.assetId === a.id && (job.status === "PENDING" || job.status === "PROCESSING");
                return (
                <div key={a.id} style={{ border: "1px solid var(--line, #e5e7eb)", borderRadius: 6, padding: 9 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <strong style={{ fontSize: 13 }}>{a.name}</strong>
                    <span className="pill">{a.asset_key}</span>
                    <span className={`pill ${a.status === "approved" ? "ok" : a.status === "review" ? "warn" : ""}`}>{a.status}</span>
                    <span className="pill">{a.scope === "shared" ? "shared" : "project"}</span>
                    {a.locked && <span className="pill warn">locked</span>}
                    <span className="pill">v{a.version}</span>
                    {files.length > 0 && <span className="pill ok">{files.length} reference(s)</span>}
                  </div>
                  {a.prompt && <div className="hint" style={{ marginTop: 4 }}>{a.prompt}</div>}
                  {(main || running) && (
                    <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginTop: 8 }}>
                      {main && (
                        <img
                          src={kidsFileUrl(main.file_path)}
                          alt={`${a.name} reference`}
                          style={{ width: 160, borderRadius: 6, border: "1px solid var(--line, #e5e7eb)" }}
                        />
                      )}
                      {running && (
                        <div style={{ fontSize: 12 }}>
                          <Spinner size={14} /> rendering the reference with the Flux Reference Image workflow…
                          <div className="hint" style={{ marginTop: 4 }}>
                            the saved prompt is passed exactly as written — only the prompt node changes
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  <div className="row" style={{ marginTop: 6 }}>
                    <button
                      className="btn sm primary"
                      disabled={busy || !a.prompt || !!running}
                      onClick={() => { void generateReference(a); }}
                      title="Render one reference still with the Flux Reference Image workflow (the saved prompt only)"
                    >
                      {running ? <Spinner size={12} /> : <><IconSparkles size={13} /> Generate reference</>}
                    </button>
                    {a.status !== "approved" && (
                      <button className="btn sm" disabled={busy} onClick={() => { void update(a, { status: "approved" }); }}>
                        Approve
                      </button>
                    )}
                    <button
                      className="btn sm"
                      disabled={busy}
                      onClick={() => { void update(a, { locked: !a.locked }); }}
                    >
                      {a.locked ? "Unlock" : "Lock"}
                    </button>
                    <button className="btn sm" disabled={busy} onClick={() => { void update(a, { version: (a.version || 1) + 1 }); }}>
                      New version
                    </button>
                    <button className="btn sm ghost" disabled={busy} onClick={() => { void remove(a); }}>
                      <IconTrash size={13} /> Delete
                    </button>
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </>
  );
}

// =====================================================================
// 6. Storyboard and scene timeline
// =====================================================================

export function KidsStoryboardPanel({ projectId, onChanged }: {
  projectId: string | null;
  onChanged?: () => void;
}) {
  const [rows, setRows] = useState<KidsTimelineRow[]>([]);
  const [draft, setDraft] = useState<KidsTimelineRow[]>([]);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);

  const load = useCallback(async () => {
    if (!projectId) return;
    setError("");
    try {
      const r = await kidsTimeline(projectId);
      setRows(r.timeline || []);
      setDraft(r.timeline || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const build = async () => {
    if (!projectId) return;
    setBusy(true); setError("");
    try {
      const r = await kidsBuildTimeline(projectId);
      setRows(r.timeline || []);
      setDraft(r.timeline || []);
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const save = async () => {
    if (!projectId) return;
    setBusy(true); setError(""); setWarnings([]);
    try {
      const r = await kidsSaveTimeline(projectId, draft);
      setRows(r.timeline || []);
      setWarnings(r.warnings || []);
      setEditing(false);
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  if (!projectId) return <div className="hint">Open a project to see its storyboard.</div>;

  const total = rows.reduce((a, r) => a + (Number(r.duration_seconds) || 0), 0);

  return (
    <>
      {card(
        <>
          {head("Storyboard and Scene Timeline", (
            <div className="row">
              <button className="btn sm primary" onClick={() => { void build(); }} disabled={busy}>
                {busy ? <Spinner size={13} /> : <><IconClapper size={13} /> Rebuild from the storyboard</>}
              </button>
              <button className="btn sm" onClick={() => setEditing((v) => !v)}>{editing ? "Stop editing" : "Edit timings"}</button>
              <button className="btn sm" onClick={() => { void save(); }} disabled={busy || !editing}>Save the timeline</button>
            </div>
          ), "Scenes, timestamps, characters, prompts, references and the approval state. With a linked AI Director storyboard the timeline follows THAT storyboard (it is what gets rendered) — without one it follows the Story Studio plan.")}
          {error && <div className="hint err-text" style={{ marginTop: 8 }}>{error}</div>}
          {warnings.map((w) => <div key={w} className="hint warn-text" style={{ marginTop: 4 }}>{w}</div>)}
          {rows.length > 0 && (
            <div className="hint" style={{ marginTop: 6 }}>
              {rows.length} scene(s) · {total.toFixed(1)}s total
            </div>
          )}
        </>
      )}

      {rows.length === 0 ? (
        <div className="hint">No storyboard yet — write the story, then rebuild the timeline.</div>
      ) : (
        card(
          <>
            {head("Scenes")}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {rows.map((row, i) => (
                <div key={row.scene_number} style={{ border: "1px solid var(--line, #e5e7eb)", borderRadius: 8, padding: 10 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <strong style={{ fontSize: 13 }}>#{row.scene_number} {row.title}</strong>
                    <span className="pill">{fmtTime(row.start_seconds)} – {fmtTime(row.end_seconds)}</span>
                    <span className="pill">{Number(row.duration_seconds || 0).toFixed(1)}s</span>
                    {row.timing && <span className={`pill ${row.timing === "measured" ? "ok" : "warn"}`}>{row.timing}</span>}
                    {row.approval && <span className="pill">{row.approval}</span>}
                    {row.generation_status && <span className="pill">{row.generation_status}</span>}
                  </div>
                  {row.text && <div className="hint" style={{ marginTop: 4 }}>{row.text}</div>}
                  {row.action && <div className="hint">action: {row.action}</div>}
                  {Array.isArray((row as unknown as { dialogue?: string[] }).dialogue)
                    && (row as unknown as { dialogue: string[] }).dialogue.length > 0 && (
                    <div className="hint">
                      voice: {(row as unknown as { dialogue: string[] }).dialogue.join(" · ")}
                    </div>
                  )}
                  <div className="hint">
                    camera: {row.camera_shot || "—"} {row.camera_movement || ""} · location: {row.location || "—"}
                    {row.characters?.length ? ` · characters: ${row.characters.join(", ")}` : ""}
                  </div>
                  {editing ? (
                    <div className="grid" style={{ marginTop: 8 }}>
                      <label style={{ fontSize: 12 }}>
                        start (s)
                        <input
                          type="number" step="0.1" style={inputStyle}
                          value={row.start_seconds}
                          onChange={(e) => {
                            const next = [...draft];
                            next[i] = { ...row, start_seconds: Number(e.target.value) };
                            setDraft(next);
                          }}
                        />
                      </label>
                      <label style={{ fontSize: 12 }}>
                        end (s)
                        <input
                          type="number" step="0.1" style={inputStyle}
                          value={row.end_seconds}
                          onChange={(e) => {
                            const next = [...draft];
                            next[i] = { ...row, end_seconds: Number(e.target.value) };
                            setDraft(next);
                          }}
                        />
                      </label>
                      <label style={{ fontSize: 12, gridColumn: "1 / -1" }}>
                        image prompt
                        <textarea
                          rows={2} style={inputStyle}
                          value={row.image_prompt}
                          onChange={(e) => {
                            const next = [...draft];
                            next[i] = { ...row, image_prompt: e.target.value };
                            setDraft(next);
                          }}
                        />
                      </label>
                      <label style={{ fontSize: 12, gridColumn: "1 / -1" }}>
                        video (motion) prompt
                        <textarea
                          rows={2} style={inputStyle}
                          value={row.video_prompt}
                          onChange={(e) => {
                            const next = [...draft];
                            next[i] = { ...row, video_prompt: e.target.value };
                            setDraft(next);
                          }}
                        />
                      </label>
                    </div>
                  ) : (
                    <>
                      {row.image_prompt && <div className="hint">image: {row.image_prompt.slice(0, 240)}</div>}
                      {row.video_prompt && <div className="hint">video: {row.video_prompt.slice(0, 240)}</div>}
                    </>
                  )}
                </div>
              ))}
            </div>
          </>
        )
      )}
    </>
  );
}

// =====================================================================
// 7. Quality control and export
// =====================================================================

export function KidsQualityPanel({ projectId, onChanged }: {
  projectId: string | null;
  onChanged?: () => void;
}) {
  const [run, setRun] = useState<KidsQcRun | null>(null);
  const [runs, setRuns] = useState<KidsQcRun[]>([]);
  const [exports, setExports] = useState<KidsExport[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    if (!projectId) return;
    setError("");
    try {
      const [q, e] = await Promise.all([kidsQc(projectId), kidsExports(projectId)]);
      setRun(q.latest);
      setRuns(q.runs || []);
      setExports(e.exports || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const runQc = async () => {
    if (!projectId) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const r = await kidsRunQc(projectId);
      setRun({
        id: r.run_id,
        summary: r.summary,
        checks: r.checks,
        created_at: new Date().toISOString(),
      });
      setMessage(r.note);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const recordExport = async () => {
    if (!projectId) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const r = await kidsRecordExport(projectId, { profile: "youtube" });
      setMessage(r.message);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  if (!projectId) return <div className="hint">Open a project to run its quality checks.</div>;

  const tone = (severity: string) => (severity === "error" ? "err" : severity === "warning" ? "warn" : "");

  return (
    <>
      {card(
        <>
          {head("Quality control and export", (
            <div className="row">
              <button className="btn sm primary" onClick={() => { void runQc(); }} disabled={busy}>
                {busy ? <Spinner size={13} /> : <><IconCheck size={13} /> Run the checks</>}
              </button>
              <button className="btn sm" onClick={() => { void recordExport(); }} disabled={busy}>
                Record the export
              </button>
            </div>
          ), "Automated checks only — a teacher still reviews the content before it is published.")}
          {error && <div className="hint err-text" style={{ marginTop: 8 }}>{error}</div>}
          {message && <div className="hint" style={{ marginTop: 8 }}>{message}</div>}
          {run && (
            <div className="row" style={{ marginTop: 8 }}>
              <span className="pill err">{run.summary.errors} error(s)</span>
              <span className="pill warn">{run.summary.warnings} warning(s)</span>
              <span className="pill">{run.summary.infos} note(s)</span>
            </div>
          )}
        </>
      )}

      {run && (
        card(
          <>
            {head("Findings")}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {run.checks.map((c: KidsQcCheck, i) => (
                <div key={`${c.id}-${i}`} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <span className={`pill ${tone(c.severity)}`}>{c.severity}</span>
                  <span style={{ flex: 1, fontSize: 13 }}>
                    {c.message}
                    {c.suggestion && <span className="hint"> → {c.suggestion}</span>}
                  </span>
                </div>
              ))}
            </div>
          </>
        )
      )}

      {exports.length > 0 && (
        card(
          <>
            {head(`Export records (${exports.length})`)}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {exports.map((e) => (
                <div key={e.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                  <span className="pill">{e.profile}</span>
                  <span className="pill">{e.status}</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{e.file_path}</span>
                  <span>{Number(e.duration_seconds || 0).toFixed(1)}s</span>
                </div>
              ))}
            </div>
          </>
        )
      )}

      {runs.length > 1 && (
        card(
          <>
            {head(`Previous runs (${runs.length - 1})`)}
            <div className="row">
              {runs.slice(1).map((r) => (
                <span key={r.id} className="pill">
                  {r.created_at ? new Date(r.created_at).toLocaleString() : `#${r.id}`} · {r.summary.errors}e / {r.summary.warnings}w
                </span>
              ))}
            </div>
          </>
        )
      )}
    </>
  );
}

// =====================================================================
// 8. AI learning and feedback
// =====================================================================

export function KidsFeedbackPanel({ projectId }: { projectId: string | null }) {
  const [rows, setRows] = useState<KidsFeedback[]>([]);
  const [examples, setExamples] = useState<KidsFeedback[]>([]);
  const [targetKind, setTargetKind] = useState("scene");
  const [targetId, setTargetId] = useState("");
  const [rating, setRating] = useState(5);
  const [verdict, setVerdict] = useState("approve");
  const [note, setNote] = useState("");
  const [useForTraining, setUseForTraining] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    if (!projectId) return;
    setError("");
    try {
      const r = await kidsFeedbackList(projectId);
      setRows(r.feedback || []);
      setExamples(r.training_examples || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!projectId) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await kidsSaveFeedback(projectId, {
        target_kind: targetKind,
        target_id: targetId,
        rating,
        verdict,
        note,
        use_for_training: useForTraining,
      });
      setNote("");
      setMessage("the feedback was stored");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  if (!projectId) return <div className="hint">Open a project to rate its outputs.</div>;

  return (
    <>
      {card(
        <>
          {head("AI Learning Center", (
            <button className="btn sm primary" onClick={() => { void save(); }} disabled={busy}>
              {busy ? <Spinner size={13} /> : <><IconCheck size={13} /> Save the feedback</>}
            </button>
          ), "Ratings and approvals become versioned examples — the studio never retrains on unreviewed output.")}
          <div className="grid">
            {field("What are you rating?", (
              <select value={targetKind} onChange={(e) => setTargetKind(e.target.value)} style={inputStyle}>
                {["story", "plan", "prompt", "image", "scene", "narration", "video", "final"].map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
            ))}
            {field("Which one? (scene number, asset id or version)", (
              <input value={targetId} onChange={(e) => setTargetId(e.target.value)} style={inputStyle} placeholder="1" />
            ))}
            {field("Rating", (
              <select value={rating} onChange={(e) => setRating(Number(e.target.value))} style={inputStyle}>
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            ))}
            {field("Verdict", (
              <select value={verdict} onChange={(e) => setVerdict(e.target.value)} style={inputStyle}>
                {["approve", "reject", "edit"].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            ))}
          </div>
          {field("Note", <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} style={inputStyle} />)}
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
            <input type="checkbox" checked={useForTraining} onChange={(e) => setUseForTraining(e.target.checked)} />
            Store this as an approved training example
          </label>
          {error && <div className="hint err-text" style={{ marginTop: 8 }}>{error}</div>}
          {message && <div className="hint" style={{ marginTop: 8 }}>{message}</div>}
        </>
      )}

      {card(
        <>
          {head(`Feedback (${rows.length})`)}
          {rows.length === 0 ? (
            <div className="hint">No feedback yet.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {rows.map((f) => (
                <div key={f.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, flexWrap: "wrap" }}>
                  <span className={`pill ${f.verdict === "approve" ? "ok" : f.verdict === "reject" ? "err" : "warn"}`}>{f.verdict}</span>
                  <span className="pill">{f.target_kind}</span>
                  <span>{f.target_id}</span>
                  {f.rating ? <span className="pill">{"★".repeat(f.rating)}</span> : null}
                  {f.use_for_training && <span className="pill ok">training example</span>}
                  <span style={{ flex: 1, minWidth: 0 }}>{f.note}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {examples.length > 0 && (
        card(
          <>
            {head(`Approved training examples (${examples.length})`, undefined,
              "Reusable examples for the studio — fine-tuning stays a separate, explicit operation.")}
            <div className="row">
              {examples.map((f) => (
                <span key={f.id} className="pill ok">{f.target_kind}:{f.target_id}</span>
              ))}
            </div>
          </>
        )
      )}
    </>
  );
}
