import { useCallback, useEffect, useMemo, useState } from "react";
import {
  kidsDashboard,
  kidsHealth,
  kidsOptions,
  kidsProjects,
  kidsCreateProject,
  kidsProject,
  kidsUpdateProject,
  kidsDeleteProject,
  kidsGeneratePlan,
  kidsSavePlan,
  kidsApprovePlan,
  kidsLinkBoard,
  kidsSyncBoard,
  kidsPipeline,
  type KidsDirectorPlan,
  type KidsMetrics,
  type KidsOptions,
  type KidsProject,
  type KidsProjectDetail,
  type KidsRecentProject,
  type KidsStage,
} from "../kidsApi";
import { directorBoards, directorUploadSong, uploadResource, type DirectorBoardMeta, type ImageMode } from "../api";
import { useDialog } from "./Dialog";
import {
  IconCheck, IconClapper, IconFilm, IconFolder, IconPanel, IconRefresh,
  IconSparkles, IconTrash, Spinner,
} from "./Icons";
import KidsDirectorPage from "./KidsDirectorPage";
import StoryPage from "./StoryPage";
import {
  KidsPipelinePanel,
  KidsStoryStudioPanel,
  KidsSongStudioPanel,
  KidsAudioStudioPanel,
  KidsLibraryPanel,
  KidsStoryboardPanel,
  KidsQualityPanel,
  KidsFeedbackPanel,
} from "./KidsStudioPanels";

// ---------------------------------------------------------------------------
// Sanskriti Kids Studio — the Kids module of Sanskriti AI Studio.
//
// The studio is a PROJECT LAYER over the existing Director pipeline: it owns
// the kids brief (age group, category, platform, …), the Director Plan and
// the mirrored storyboard, while story analysis, scene planning, approval,
// image/video generation, dialogue and the final cut all run through the
// shared engines unchanged. Every metric below comes from the live
// `Sanskriti_kids` database — never a hardcoded number.
// ---------------------------------------------------------------------------

const ASPECTS = ["16:9", "9:16", "1:1"];

const card = (children: React.ReactNode, style?: React.CSSProperties) => (
  <section className="card" style={{ marginBottom: 16, ...style }}>{children}</section>
);

const field = (label: string, input: React.ReactNode, hint?: string) => (
  <div style={{ marginBottom: 12 }}>
    <label style={{ display: "block", marginBottom: 6, fontWeight: 600, fontSize: 13 }}>{label}</label>
    {input}
    {hint && <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4 }}>{hint}</div>}
  </div>
);

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

type Tab =
  | "dashboard" | "projects" | "director" | "story"
  | "pipeline" | "story_studio" | "song_studio" | "audio_studio"
  | "library" | "storyboard" | "qc" | "feedback";

export default function SanskritiKidsPage({ onOpenProject, imageMode, onImageMode }: {
  onOpenProject?: (name: string) => void;
  imageMode?: ImageMode;
  onImageMode?: (mode: ImageMode) => void;
}) {
  const dialog = useDialog();
  const [tab, setTab] = useState<Tab>("dashboard");

  // ---- Dashboard state ----
  const [metrics, setMetrics] = useState<KidsMetrics | null>(null);
  const [recent, setRecent] = useState<KidsRecentProject[]>([]);
  const [dashLoading, setDashLoading] = useState(true);
  const [dashError, setDashError] = useState("");
  const [store, setStore] = useState<string>("");

  // ---- Options (server-owned, never hardcoded) ----
  const [options, setOptions] = useState<KidsOptions | null>(null);
  const [optionsError, setOptionsError] = useState("");

  // ---- Projects ----
  const [projects, setProjects] = useState<KidsProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<KidsProjectDetail | null>(null);
  const [pipeline, setPipeline] = useState<KidsStage[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState<string | null>(null);

  // ---- Stage 1 brief form ----
  const emptyBrief = {
    title: "",
    description: "",
    language: "",
    category: "",
    age_group: "",
    duration_seconds: 60,
    aspect_ratio: "16:9",
    resolution: "",
    visual_style: "",
    narration_preferences: "",
    music_preferences: "",
    target_platform: "",
    lyrics: "",
    script: "",
    audio_path: "",
    reference_images: [] as string[],
  };
  const [brief, setBrief] = useState(emptyBrief);
  const [creating, setCreating] = useState(false);
  const [uploadingAudio, setUploadingAudio] = useState(false);
  const [uploadingRef, setUploadingRef] = useState(false);
  const [audioInfo, setAudioInfo] = useState<{ file: string; fileName: string; durationSeconds: number } | null>(null);
  const [audioDuration, setAudioDuration] = useState(0);
  const [refIds, setRefIds] = useState<string[]>([]);

  // Optional narration / song audio. The file is stored by the EXISTING
  // Director upload endpoint (director/) and the handle is kept on the brief.
  const onAudioFile = async (f: File | undefined) => {
    if (!f) return;
    setUploadingAudio(true);
    setError("");
    try {
      const data = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result));
        r.onerror = () => rej(new Error("could not read the audio file"));
        r.readAsDataURL(f);
      });
      const up = await directorUploadSong(data, f.name);
      setAudioInfo({ file: up.file, fileName: up.fileName, durationSeconds: up.durationSeconds });
      setBrief((b) => ({ ...b, audio_path: up.file }));
      // The measured duration rides along so the Audio & Narration stage can
      // run even when ffprobe is unavailable.
      setAudioDuration(up.durationSeconds || 0);
    } catch (e) {
      reportError(e);
    } finally { setUploadingAudio(false); }
  };

  // Optional reference images. They go into the SHARED resource library, so
  // the existing reference-image pipeline can use them unchanged.
  const onRefFile = async (f: File | undefined) => {
    if (!f) return;
    setUploadingRef(true);
    setError("");
    try {
      const data = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result));
        r.onerror = () => rej(new Error("could not read the image file"));
        r.readAsDataURL(f);
      });
      const entry = await uploadResource(data);
      const next = [...refIds, String(entry.id)];
      setRefIds(next);
      setBrief((b) => ({ ...b, reference_images: next }));
    } catch (e) {
      reportError(e);
    } finally { setUploadingRef(false); }
  };

  const loadOptions = useCallback(async () => {
    try {
      const o = await kidsOptions();
      setOptions(o);
      setOptionsError("");
      // Seed the form from the FIRST configured option of each list — the
      // studio never invents values the user did not configure.
      setBrief((b) => ({
        ...b,
        language: b.language || o.languages[0] || "",
        category: b.category || o.categories[0] || "",
        age_group: b.age_group || o.age_groups[0] || "",
        resolution: b.resolution || o.resolutions[0] || "",
        visual_style: b.visual_style || o.visual_styles[0] || "",
        target_platform: b.target_platform || o.platforms[0] || "",
      }));
    } catch (e) {
      setOptionsError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadDashboard = useCallback(async () => {
    setDashLoading(true);
    try {
      const d = await kidsDashboard();
      setMetrics(d.metrics);
      setRecent(d.recent || []);
      setStore(d.store || "");
      setDashError("");
    } catch (e) {
      setDashError(e instanceof Error ? e.message : String(e));
    } finally {
      setDashLoading(false);
    }
  }, []);

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    try {
      setProjects(await kidsProjects());
      setProjectsError("");
    } catch (e) {
      setProjectsError(e instanceof Error ? e.message : String(e));
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => { void loadOptions(); }, [loadOptions]);
  useEffect(() => { void loadDashboard(); }, [loadDashboard]);
  useEffect(() => { void loadProjects(); }, [loadProjects]);

  // Health poll — the studio shows which store answers (postgres/sqlite).
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const h = await kidsHealth();
        if (alive) setStore(h.db.store || "");
      } catch { /* offline is reported by the dashboard error state */ }
    };
    void tick();
    const t = window.setInterval(tick, 20000);
    return () => { alive = false; window.clearInterval(t); };
  }, []);

  const openDetail = useCallback(async (id: string) => {
    setSelectedId(id);
    setDetailLoading(true);
    setError("");
    try {
      setDetail(await kidsProject(id));
      // The dashboard pipeline shows the REAL stage status of this project.
      try { setPipeline((await kidsPipeline(id)).stages); }
      catch { setPipeline([]); }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const reportError = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    setError(msg);
    void dialog.alert(msg, { title: "Sanskriti Kids request failed", tone: "error" });
  };

  // Open the panel that belongs to a production stage. The generation stages
  // (images, clips, voices, assembly, the final cut) live in the shared
  // workspace — the studio never pretends to have produced them.
  const openStage = (stage: KidsStage) => {    const byStage: Record<string, Tab> = {
      director: "director",
      story: "story_studio",
      song: "song_studio",
      audio: "audio_studio",
      characters: "library",
      locations: "library",
      props: "library",
      storyboard: "storyboard",
      assets: "storyboard",
      qc: "qc",
      feedback: "feedback",
    };
    const target = byStage[stage.id];
    if (target) { setTab(target); return; }
    // The image + video stages run in the shared workspace. They need the
    // Flux t2i (img2img) mode so a keyframe anchors on the approved
    // character reference — the library reference stills themselves always
    // use the Flux Reference Image workflow.
    if (stage.id === "images" || stage.id === "video") onImageMode?.("flux");
    const scenario = detail?.project?.scenario_name;
    if (scenario && onOpenProject) { onOpenProject(scenario); return; }
    setTab("projects");
  };

  // ---- Stage 1: create the project ----
  const doCreate = async () => {
    if (creating) return;
    setCreating(true);
    setError("");
    setWarning(null);
    try {
      const r = await kidsCreateProject({ ...brief, audio_duration_seconds: audioDuration || undefined });
      setBrief((b) => ({ ...emptyBrief, ...pickDefaults(options, b) }));
      await Promise.all([loadProjects(), loadDashboard()]);
      await openDetail(r.project.id);
      setTab("projects");
      if (r.warnings?.length) setWarning(r.warnings.join(" · "));
      await dialog.alert(
        `Project "${r.project.title}" created. Next: write the Director Plan, then plan the storyboard.`,
        { title: "Project created", tone: "success" });
    } catch (e) {
      reportError(e);
    } finally {
      setCreating(false);
    }
  };

  // ---- Stage 2: the Director Plan ----
  const doGeneratePlan = async () => {
    if (!selectedId || busy) return;
    setBusy("plan");
    setError("");
    try {
      const r = await kidsGeneratePlan(selectedId);
      setDetail((d) => (d ? { ...d, plan: r.plan, planHistory: [r.plan, ...d.planHistory] } : d));
      await loadProjects();
    } catch (e) {
      reportError(e);
    } finally { setBusy(null); }
  };

  const doSavePlan = async (plan: KidsDirectorPlan, unlock = false) => {
    if (!selectedId || busy) return;
    setBusy("save-plan");
    setError("");
    try {
      const r = await kidsSavePlan(selectedId, plan, { unlock });
      setDetail((d) => (d ? { ...d, plan: r.plan, planHistory: [r.plan, ...d.planHistory] } : d));
    } catch (e) {
      reportError(e);
    } finally { setBusy(null); }
  };

  const doApprovePlan = async () => {
    if (!selectedId || busy) return;
    setBusy("approve");
    setError("");
    try {
      const r = await kidsApprovePlan(selectedId);
      setDetail((d) => (d ? { ...d, plan: r.plan, project: { ...d.project, status: "approved" } } : d));
      await loadDashboard();
    } catch (e) {
      reportError(e);
    } finally { setBusy(null); }
  };

  const doSync = async () => {
    if (!selectedId || busy) return;
    setBusy("sync");
    setError("");
    try {
      const r = await kidsSyncBoard(selectedId);
      setDetail((d) => (d ? { ...d, project: r.project, plan: r.plan, scenes: r.scenes, characters: r.characters } : d));
      await loadDashboard();
    } catch (e) {
      reportError(e);
    } finally { setBusy(null); }
  };

  const doDelete = async (id: string) => {
    if (!confirm("Delete this Kids project? Its plan, scenes and characters are removed too.")) return;
    try {
      await kidsDeleteProject(id);
      if (selectedId === id) { setSelectedId(null); setDetail(null); }
      await Promise.all([loadProjects(), loadDashboard()]);
    } catch (e) { reportError(e); }
  };

  const doUpdateBrief = async (patch: Record<string, unknown>) => {
    if (!selectedId || busy) return;
    setBusy("update");
    setError("");
    try {
      const r = await kidsUpdateProject(selectedId, patch);
      setDetail((d) => (d ? { ...d, project: r.project } : d));
      await loadProjects();
    } catch (e) {
      reportError(e);
    } finally { setBusy(null); }
  };

  const stats = useMemo(() => {
    const m = metrics;
    return [
      { label: "Kids Projects", value: m?.totalProjects ?? 0, tone: "#0369a1", bg: "#e0f2fe" },
      { label: "Draft Stories", value: m?.draftStories ?? 0, tone: "#92400e", bg: "#fef3c7" },
      { label: "Characters", value: m?.characters ?? 0, tone: "#6b21a8", bg: "#f3e8ff" },
      { label: "Scenes", value: m?.scenes ?? 0, tone: "#15803d", bg: "#f0fdf4" },
      { label: "Images Generated", value: m?.imagesGenerated ?? 0, tone: "#0f766e", bg: "#ccfbf1" },
      { label: "Videos Generated", value: m?.videosGenerated ?? 0, tone: "#1d4ed8", bg: "#dbeafe" },
      { label: "In Progress", value: m?.inProgress ?? 0, tone: "#c2410c", bg: "#ffedd5" },
      { label: "Completed", value: m?.completedVideos ?? 0, tone: "#166534", bg: "#dcfce7" },
      { label: "Failed / Pending Jobs", value: m?.failedOrPendingJobs ?? 0, tone: "#b91c1c", bg: "#fee2e2" },
    ];
  }, [metrics]);

  // The brief of the selected project seeds the Director + Story workflows —
  // the studio brief and the storyboard must never drift apart.
  const directorSeed = useMemo(() => {
    const p = detail?.project;
    if (!p) return null;
    return {
      key: p.id,
      title: p.title,
      story: p.script || p.lyrics || "",
      language: p.language,
      visualStyle: p.visual_style,
      aspectRatio: p.aspect_ratio,
      targetSeconds: p.duration_seconds,
      educationalCategory: p.category,
    };
  }, [detail?.project]);

  const storySeed = useMemo(() => {
    const p = detail?.project;
    if (!p) return null;
    return {
      key: p.id,
      title: p.title,
      story: p.script || p.lyrics || "",
      language: p.language,
      visualStyle: p.visual_style,
      targetSeconds: p.duration_seconds,
    };
  }, [detail?.project]);

  // ---------------------------------------------------------------- render
  return (
    <div className="page sanskriti-kids-page" style={{ padding: 16 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <IconSparkles size={24} />
        <div style={{ flex: 1, minWidth: 220 }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>🧒 Sanskriti Kids</h1>
          <p style={{ margin: 2, fontSize: 13, color: "#6b7280" }}>
            Children&apos;s educational and entertainment videos — brief, Director Plan, storyboard, then the
            shared image / video / audio / final-cut pipeline.
          </p>
        </div>
        {store && (
          <span className="pill" title="Which database answers the studio queries">
            {store === "pg" ? "PostgreSQL" : "SQLite"}
          </span>
        )}
      </div>

      {/* Sub-navigation: every Kids workflow lives in this module */}
      <div className="tabs" role="tablist" aria-label="Sanskriti Kids workflows">
        {([
          ["dashboard", "Dashboard"],
          ["projects", "Projects & Brief"],
          ["director", "AI Director"],
          ["story", "Story & Production"],
          ["pipeline", "Pipeline"],
          ["story_studio", "Story Studio"],
          ["song_studio", "Song Studio"],
          ["audio_studio", "Audio & Narration"],
          ["library", "Character & Asset Library"],
          ["storyboard", "Storyboard & Timeline"],
          ["qc", "Quality Control & Export"],
          ["feedback", "AI Learning & Feedback"],
        ] as [Tab, string][]).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={`tab${tab === id ? " on" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div style={{ padding: 10, background: "#fee2e2", color: "#991b1b", borderRadius: 6, marginBottom: 16 }}>
          {error}
        </div>
      )}
      {warning && (
        <div style={{ padding: 10, background: "#fef3c7", color: "#92400e", borderRadius: 6, marginBottom: 16 }}>
          {warning}
        </div>
      )}

      {/* ============================ DASHBOARD ============================ */}
      {tab === "dashboard" && (
        <>
          {card(
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>Studio Overview</span>
                <span style={{ flex: 1 }} />
                <button className="btn sm" onClick={() => { void loadDashboard(); }} disabled={dashLoading}>
                  {dashLoading ? <Spinner size={14} /> : <><IconRefresh size={14} /> Refresh</>}
                </button>
              </div>
              {dashLoading && !metrics ? (
                <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#6b7280", fontSize: 13 }}>
                  <Spinner size={16} /> Loading studio metrics…
                </div>
              ) : dashError && !metrics ? (
                <div style={{ padding: 12, background: "#fee2e2", color: "#991b1b", borderRadius: 6, fontSize: 13 }}>
                  {dashError}
                  <div style={{ marginTop: 8 }}>
                    <button className="btn sm" onClick={() => { void loadDashboard(); }}>Retry</button>
                  </div>
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
                  {stats.map((s) => (
                    <div key={s.label} style={{ padding: 12, background: s.bg, borderRadius: 6 }}>
                      <div style={{ fontSize: 11.5, color: s.tone, fontWeight: 600, marginBottom: 4 }}>{s.label}</div>
                      <div style={{ fontSize: 20, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{s.value}</div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {card(
            <>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>Quick Actions</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btn" onClick={() => setTab("projects")}>📝 Create a story</button>
                <button className="btn" onClick={() => setTab("director")}>🎬 Open the AI Director</button>
                <button className="btn" onClick={() => setTab("story")}>📖 Story workflow</button>
                <button className="btn" onClick={() => setTab("song_studio")}>🎵 Import lyrics</button>
                <button className="btn" onClick={() => setTab("library")}>🧒 Generate characters</button>
                <button className="btn" onClick={() => setTab("pipeline")}>🎞️ Start video production</button>
              </div>
            </>
          )}

          {card(
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>Production sections</span>
                <span className="hint" style={{ margin: 0 }}>
                  {selectedId
                    ? "the status comes from this project's rows and the files on disk"
                    : "open a project to see its real status"}
                </span>
                <span style={{ flex: 1 }} />
                {selectedId && (
                  <button className="btn sm" onClick={() => { void openDetail(selectedId); }}>
                    <IconRefresh size={13} /> Refresh
                  </button>
                )}
              </div>
              {!selectedId ? (
                <div className="hint">Open a project (Projects & Brief) to fill this in.</div>
              ) : pipeline.length === 0 ? (
                <div className="hint">Loading the pipeline…</div>
              ) : (
                <div className="grid grid-3">
                  {pipeline.map((s) => (
                    <div key={s.id} style={{
                      border: "1px solid var(--line, #e5e7eb)", borderRadius: 8, padding: 10,
                      background: "var(--inset, #fff)",
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                        <strong style={{ fontSize: 12.5, flex: 1 }}>{s.label}</strong>
                        <span className={`pill ${s.status === "done" ? "ok" : s.status === "blocked" ? "err" : "warn"}`}>
                          {s.status}
                        </span>
                      </div>
                      <div className="hint" style={{ margin: 0 }}>{s.description}</div>
                      <div className="hint" style={{ margin: "4px 0 6px" }}>
                        outputs: {s.output_count}
                        {s.blocked_by.length ? ` · blocked by ${s.blocked_by.join(", ")}` : ""}
                      </div>
                      <button className="btn sm" onClick={() => openStage(s)}>
                        Open
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {card(
            <>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>Recent Projects</div>
              {dashLoading && !recent.length ? (
                <div style={{ color: "#6b7280", fontSize: 13 }}>Loading…</div>
              ) : recent.length ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {recent.map((p) => (
                    <div key={p.id} style={{
                      display: "flex", alignItems: "center", gap: 10, padding: "9px 11px",
                      border: "1px solid #e5e7eb", borderRadius: 6, background: "#fff",
                    }}>
                      <IconClapper size={16} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{p.title || p.name}</div>
                        <div style={{ fontSize: 11.5, color: "#6b7280" }}>
                          {p.category || "Uncategorised"} · {p.age_group || "any age"} · {p.language}
                        </div>
                      </div>
                      <span className="pill" style={{ fontSize: 11 }}>{p.status}</span>
                      <button className="btn sm" onClick={() => { void openDetail(p.id); setTab("projects"); }}>
                        Open
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 13, color: "#6b7280" }}>
                  No Kids projects yet. Create one to start the workflow.
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ============================ PROJECTS ============================ */}
      {tab === "projects" && (
        <>
          {card(
            <>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>
                Stage 1 — Project Creation
              </div>
              {optionsError && (
                <div style={{ padding: 10, background: "#fef3c7", color: "#92400e", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
                  The option lists could not be loaded ({optionsError}) — the studio cannot create a project
                  until the database answers.
                </div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                {field("Project title",
                  <input
                    className="input"
                    value={brief.title}
                    onChange={(e) => setBrief({ ...brief, title: e.target.value })}
                    placeholder="e.g. A for Apple / बंदर और कथा"
                  />)}
                {field("Description",
                  <input
                    className="input"
                    value={brief.description}
                    onChange={(e) => setBrief({ ...brief, description: e.target.value })}
                    placeholder="What is this video about?"
                  />)}
                {field("Language", select(options?.languages, brief.language, (v) => setBrief({ ...brief, language: v })))}
                {field("Content category", select(options?.categories, brief.category, (v) => setBrief({ ...brief, category: v })))}
                {field("Target age group", select(options?.age_groups, brief.age_group, (v) => setBrief({ ...brief, age_group: v })))}
                {field("Target platform", select(options?.platforms, brief.target_platform, (v) => setBrief({ ...brief, target_platform: v })))}
                {field("Video duration (seconds)",
                  <input
                    className="input"
                    type="number"
                    min={5}
                    max={3600}
                    value={brief.duration_seconds}
                    onChange={(e) => setBrief({ ...brief, duration_seconds: num(e.target.value) })}
                  />)}
                {field("Aspect ratio", select(ASPECTS, brief.aspect_ratio, (v) => setBrief({ ...brief, aspect_ratio: v })))}
                {field("Output resolution", select(options?.resolutions, brief.resolution, (v) => setBrief({ ...brief, resolution: v })))}
                {field("Visual style", select(options?.visual_styles, brief.visual_style, (v) => setBrief({ ...brief, visual_style: v })))}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
                {field("Narration preferences",
                  <textarea
                    className="input"
                    rows={2}
                    value={brief.narration_preferences}
                    onChange={(e) => setBrief({ ...brief, narration_preferences: e.target.value })}
                    placeholder="e.g. friendly female Hindi voice, slow and clear"
                  />)}
                {field("Music & sound preferences",
                  <textarea
                    className="input"
                    rows={2}
                    value={brief.music_preferences}
                    onChange={(e) => setBrief({ ...brief, music_preferences: e.target.value })}
                    placeholder="e.g. light ukulele, birdsong ambience"
                  />)}
              </div>

              {field("Lyrics or script",
                <textarea
                  className="input"
                  rows={6}
                  value={brief.script || brief.lyrics}
                  onChange={(e) => setBrief({ ...brief, script: e.target.value })}
                  placeholder="Paste the children's lyrics or the educational story…"
                />,
                "The script is what the Director analyses — it must be at least 20 characters.")}

              {/* Optional attachments — the audio and the reference images ride
                  the SHARED upload paths, so the existing reference-image and
                  music-video pipelines consume them unchanged. */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
                {field("Narration / song audio (optional)",
                  <>
                    <input
                      className="input"
                      type="file"
                      accept="audio/mpeg,audio/wav,.mp3,.wav"
                      onChange={(e) => { void onAudioFile(e.target.files?.[0]); }}
                    />
                    {uploadingAudio && <span style={{ fontSize: 12, color: "#6b7280" }}>uploading…</span>}
                    {audioInfo && (
                      <div style={{ fontSize: 12, color: "#475569", marginTop: 4 }}>
                        {audioInfo.fileName} · ~{Math.round(audioInfo.durationSeconds)}s
                      </div>
                    )}
                  </>)}
                {field("Reference images (optional)",
                  <>
                    <input
                      className="input"
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(e) => { void onRefFile(e.target.files?.[0]); }}
                    />
                    {uploadingRef && <span style={{ fontSize: 12, color: "#6b7280" }}>uploading…</span>}
                    {refIds.length > 0 && (
                      <div style={{ fontSize: 12, color: "#475569", marginTop: 4 }}>
                        {refIds.length} reference image{refIds.length === 1 ? "" : "s"} attached
                      </div>
                    )}
                  </>)}
              </div>

              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <button className="btn primary" onClick={doCreate} disabled={creating || !!optionsError}>
                  {creating ? <Spinner size={16} /> : "Create Kids Project"}
                </button>
                <span style={{ fontSize: 12, color: "#6b7280" }}>
                  The project is stored in the Sanskriti Kids database and the Director Plan comes next.
                </span>
              </div>
            </>
          )}

          {card(
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>Kids Projects</span>
                <span style={{ flex: 1 }} />
                <button className="btn sm" onClick={() => { void loadProjects(); }} disabled={projectsLoading}>
                  {projectsLoading ? <Spinner size={14} /> : <><IconRefresh size={14} /> Refresh</>}
                </button>
              </div>
              {projectsLoading && !projects.length ? (
                <div style={{ color: "#6b7280", fontSize: 13 }}>Loading projects…</div>
              ) : projectsError && !projects.length ? (
                <div style={{ padding: 12, background: "#fee2e2", color: "#991b1b", borderRadius: 6, fontSize: 13 }}>
                  {projectsError}
                </div>
              ) : projects.length ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {projects.map((p) => (
                    <div key={p.id} style={{
                      display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
                      border: `1px solid ${selectedId === p.id ? "#2563eb" : "#e5e7eb"}`,
                      borderRadius: 6, background: selectedId === p.id ? "#eff6ff" : "#fff",
                    }}>
                      <IconFolder size={16} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{p.title || p.name}</div>
                        <div style={{ fontSize: 11.5, color: "#6b7280" }}>
                          {p.category || "Uncategorised"} · {p.age_group || "any age"} · {p.language} · {p.duration_seconds}s
                        </div>
                      </div>
                      <span className="pill" style={{ fontSize: 11 }}>{p.status}</span>
                      <button className="btn sm" onClick={() => { void openDetail(p.id); }}>Open</button>
                      {p.scenario_name && onOpenProject && (
                        <button className="btn sm" onClick={() => onOpenProject(p.scenario_name!)}>Workspace</button>
                      )}
                      <button className="btn sm" onClick={() => { void doDelete(p.id); }} title="Delete project">
                        <IconTrash size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 13, color: "#6b7280" }}>No Kids projects yet — create one above.</div>
              )}
            </>
          )}

          {/* --- The selected project: brief, plan, storyboard --- */}
          {selectedId && (
            card(
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>
                    {detail?.project.title || selectedId}
                  </span>
                  <span style={{ flex: 1 }} />
                  {detail?.project.board_id && (
                    <button className="btn sm" onClick={doSync} disabled={!!busy}>
                      {busy === "sync" ? <Spinner size={14} /> : "Sync storyboard"}
                    </button>
                  )}
                  <BoardLink
                    projectId={selectedId}
                    linkedBoardId={detail?.project.board_id ?? null}
                    busy={!!busy}
                    onLinked={async (boardId) => {
                      try {
                        const r = await kidsLinkBoard(selectedId!, boardId);
                        setDetail((d) => (d ? { ...d, project: r.project, plan: r.plan, scenes: r.scenes, characters: r.characters } : d));
                        await loadDashboard();
                      } catch (e) { reportError(e); }
                    }}
                  />
                  {detail?.project.scenario_name && onOpenProject && (
                    <button className="btn sm" onClick={() => onOpenProject(detail.project.scenario_name!)}>
                      Open workspace
                    </button>
                  )}
                </div>
                {detailLoading && !detail ? (
                  <div style={{ color: "#6b7280", fontSize: 13 }}>Loading…</div>
                ) : detail ? (
                  <ProjectDetail
                    detail={detail}
                    busy={busy}
                    onGeneratePlan={doGeneratePlan}
                    onSavePlan={doSavePlan}
                    onApprovePlan={doApprovePlan}
                    onUpdateBrief={doUpdateBrief}
                  />
                ) : null}
              </>,
              { borderLeft: "3px solid #2563eb" },
            )
          )}
        </>
      )}

      {/* ============================ DIRECTOR ============================ */}
      {/* The full Kids Director (story analysis, bible, storyboard, lyric
          coverage, audio timeline, QC + repair) — the existing component,
          reused unchanged inside the studio. It is seeded from the selected
          project's brief so the storyboard can never drift from it. */}
      {tab === "director" && (
        <div style={{ marginTop: -8 }}>
          <KidsDirectorPage onOpenProject={onOpenProject ?? (() => {})} seed={directorSeed} />
        </div>
      )}

      {/* ============================ STORY ============================ */}
      {/* The Story workflow (write -> analyze -> plan scenes -> validate ->
          approve -> generate) — the existing component, reused unchanged,
          seeded from the same brief (no genre pin; the user picks it). */}
      {tab === "story" && (
        <div style={{ marginTop: -8 }}>
          <StoryPage
            onOpenProject={onOpenProject}
            imageMode={imageMode}
            onImageMode={onImageMode}
            seed={storySeed}
          />
        </div>
      )}

      {/* ============================ PIPELINE ============================ */}
      {/* The 16 production stages with their real status. The generation
          stages (images, video, voice, assembly, final) run in the shared
          workspace / Director engines — the studio shows them as delegated
          instead of pretending to have produced them. */}
      {tab === "pipeline" && (
        <div style={{ marginTop: -8 }}>
          <KidsPipelinePanel
            projectId={selectedId}
            onChanged={() => { void openDetail(selectedId!); }}
            onImageMode={onImageMode as ((m: "flux" | "flux_text_image" | "flux_reference_image") => void) | undefined}
            onOpenProject={onOpenProject}
            projectName={detail?.project?.scenario_name || null}
          />
        </div>
      )}

      {/* ============================ STORY STUDIO ============================ */}
      {tab === "story_studio" && (
        <div style={{ marginTop: -8 }}>
          <KidsStoryStudioPanel projectId={selectedId} onChanged={() => { void openDetail(selectedId!); }} />
        </div>
      )}

      {/* ============================ SONG STUDIO ============================ */}
      {tab === "song_studio" && (
        <div style={{ marginTop: -8 }}>
          <KidsSongStudioPanel projectId={selectedId} onChanged={() => { void openDetail(selectedId!); }} />
        </div>
      )}

      {/* ============================ AUDIO & NARRATION ============================ */}
      {tab === "audio_studio" && (
        <div style={{ marginTop: -8 }}>
          <KidsAudioStudioPanel projectId={selectedId} onChanged={() => { void openDetail(selectedId!); }} />
        </div>
      )}

      {/* ============================ LIBRARY ============================ */}
      {tab === "library" && (
        <div style={{ marginTop: -8 }}>
          <KidsLibraryPanel projectId={selectedId} onChanged={() => { void openDetail(selectedId!); }} />
        </div>
      )}

      {/* ============================ STORYBOARD ============================ */}
      {tab === "storyboard" && (
        <div style={{ marginTop: -8 }}>
          <KidsStoryboardPanel projectId={selectedId} onChanged={() => { void openDetail(selectedId!); }} />
        </div>
      )}

      {/* ============================ QUALITY CONTROL ============================ */}
      {tab === "qc" && (
        <div style={{ marginTop: -8 }}>
          <KidsQualityPanel projectId={selectedId} onChanged={() => { void openDetail(selectedId!); }} />
        </div>
      )}

      {/* ============================ FEEDBACK ============================ */}
      {tab === "feedback" && (
        <div style={{ marginTop: -8 }}>
          <KidsFeedbackPanel projectId={selectedId} />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ helpers
const pickDefaults = (options: KidsOptions | null, current: Record<string, unknown>) => ({
  language: (current.language as string) || options?.languages[0] || "",
  category: (current.category as string) || options?.categories[0] || "",
  age_group: (current.age_group as string) || options?.age_groups[0] || "",
  resolution: (current.resolution as string) || options?.resolutions[0] || "",
  visual_style: (current.visual_style as string) || options?.visual_styles[0] || "",
  target_platform: (current.target_platform as string) || options?.platforms[0] || "",
});

const select = (values: string[] | undefined, value: string, onChange: (v: string) => void) => (
  <select className="input" value={value} onChange={(e) => onChange(e.target.value)} style={{ width: "100%" }}>
    {(values || []).map((v) => <option key={v} value={v}>{v}</option>)}
  </select>
);

// ------------------------------------------------------------------ detail
function ProjectDetail({ detail, busy, onGeneratePlan, onSavePlan, onApprovePlan, onUpdateBrief }: {
  detail: KidsProjectDetail;
  busy: string | null;
  onGeneratePlan: () => void;
  onSavePlan: (plan: KidsDirectorPlan, unlock?: boolean) => void;
  onApprovePlan: () => void;
  onUpdateBrief: (patch: Record<string, unknown>) => void;
}) {
  const { project, plan, scenes, characters, jobs } = detail;
  const [draft, setDraft] = useState<KidsDirectorPlan | null>(plan?.plan ?? null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setDraft(plan?.plan ?? null);
    setEditing(false);
  }, [plan?.id, plan?.version]);

  const locked = plan?.status === "approved";
  const dirty = editing && draft && plan
    ? JSON.stringify(draft) !== JSON.stringify(plan.plan)
    : false;

  return (
    <>
      {/* Brief */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>Brief</span>
          <span style={{ flex: 1 }} />
          <button
            className="btn sm"
            onClick={() => onUpdateBrief({
              title: project.title,
              description: project.description,
              script: project.script,
              reset_plan: true,
            })}
            disabled={!!busy}
            title="Save the brief and reset the Director Plan (the plan must match the brief)"
          >
            Save brief &amp; reset plan
          </button>
        </div>
        <div style={{ fontSize: 12.5, color: "#475569", lineHeight: 1.6 }}>
          <div><b>{project.title}</b> · {project.category || "Uncategorised"} · {project.age_group || "any age"} · {project.language} · {project.duration_seconds}s · {project.aspect_ratio} · {project.resolution}</div>
          {project.description && <div style={{ marginTop: 4 }}>{project.description}</div>}
          {(project.narration_preferences || project.music_preferences) && (
            <div style={{ marginTop: 4, color: "#6b7280" }}>
              {project.narration_preferences && <>Narration: {project.narration_preferences} · </>}
              {project.music_preferences && <>Sound: {project.music_preferences}</>}
            </div>
          )}
          {project.board_id && <div style={{ marginTop: 4, color: "#6b7280" }}>Storyboard: <code>{project.board_id}</code></div>}
        </div>
      </div>

      {/* Director Plan */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>Director Plan</span>
          {plan && <span className="pill" style={{ fontSize: 11 }}>v{plan.version} · {plan.status}</span>}
          <span style={{ flex: 1 }} />
          <button className="btn sm" onClick={onGeneratePlan} disabled={!!busy}>
            {busy === "plan" ? <Spinner size={14} /> : plan ? "Regenerate with AI" : "Generate with AI"}
          </button>
          {plan && plan.status !== "approved" && (
            <button className="btn sm" onClick={onApprovePlan} disabled={!!busy}>
              {busy === "approve" ? <Spinner size={14} /> : <><IconCheck size={14} /> Approve plan</>}
            </button>
          )}
          {plan && (
            <button
              className="btn sm"
              onClick={() => setEditing((v) => !v)}
              disabled={!!busy}
            >
              {editing ? "Stop editing" : "Edit plan"}
            </button>
          )}
        </div>

        {!plan ? (
          <div style={{ fontSize: 13, color: "#6b7280" }}>
            No Director Plan yet — press <b>Generate with AI</b>. The plan is stored in the database and
            stays editable until you approve it.
          </div>
        ) : (
          <>
            {locked && (
              <div style={{ padding: 9, background: "#f0fdf4", color: "#166534", borderRadius: 6, marginBottom: 10, fontSize: 12.5 }}>
                This plan is approved and locked. Unlocking is explicit — the approved decisions are never
                overwritten silently.
              </div>
            )}
            {editing && draft ? (
              <PlanEditor
                draft={draft}
                locked={locked}
                dirty={dirty}
                busy={!!busy}
                onChange={setDraft}
                onSave={() => onSavePlan(draft, locked)}
              />
            ) : (
              <PlanView plan={plan.plan} />
            )}
          </>
        )}
      </div>

      {/* Mirrored storyboard + characters */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Scenes ({scenes.length})</div>
          {scenes.length ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 260, overflowY: "auto" }}>
              {scenes.map((s) => (
                <div key={s.scene_number} style={{ padding: "7px 9px", border: "1px solid #e5e7eb", borderRadius: 5, fontSize: 12 }}>
                  <b>Scene {s.scene_number}</b> · {s.title || "untitled"} · {s.duration_seconds}s
                  {s.camera && <div style={{ color: "#6b7280" }}>{s.camera}</div>}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12.5, color: "#6b7280" }}>No scenes yet — link a storyboard from the Director tab.</div>
          )}
        </div>
        <div>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Characters ({characters.length})</div>
          {characters.length ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 260, overflowY: "auto" }}>
              {characters.map((c) => (
                <div key={c.character_id} style={{ padding: "7px 9px", border: "1px solid #e5e7eb", borderRadius: 5, fontSize: 12 }}>
                  <b>{c.name}</b> <span style={{ color: "#6b7280" }}>({c.role})</span>
                  {c.species && <div style={{ color: "#6b7280" }}>{c.species}</div>}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12.5, color: "#6b7280" }}>No characters yet.</div>
          )}
        </div>
      </div>

      {jobs.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Jobs</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {jobs.slice(0, 6).map((j) => (
              <div key={j.id} style={{ fontSize: 12, color: "#475569", display: "flex", gap: 8 }}>
                <span className="pill" style={{ fontSize: 10.5 }}>{j.status}</span>
                <span>{j.kind}</span>
                {j.error_message && <span style={{ color: "#b91c1c" }}>{j.error_message.slice(0, 120)}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ plan
function PlanView({ plan }: { plan: KidsDirectorPlan }) {
  const block = (title: string, body: string) => body ? (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "#475569", marginBottom: 3 }}>{title}</div>
      <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>{body}</div>
    </div>
  ) : null;
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 6, padding: 12, background: "#fff" }}>
      {block("Creative direction", plan.creative_direction)}
      {block("Teaching objective", plan.objective.teaching_objective)}
      {block("Entertainment objective", plan.objective.entertainment_objective)}
      {block("Narrative", [plan.narrative.beginning, plan.narrative.middle, plan.narrative.climax, plan.narrative.ending]
        .filter(Boolean).join(" → "))}
      {block("Visual continuity", plan.visual_continuity)}
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 10 }}>
        {plan.scene_count} scenes · ~{plan.approximate_duration_seconds}s
        {plan.camera.shot_types.length > 0 && <> · shots: {plan.camera.shot_types.join(", ")}</>}
        {plan.camera.movements.length > 0 && <> · moves: {plan.camera.movements.join(", ")}</>}
      </div>
      {plan.characters.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#475569", marginBottom: 3 }}>Characters</div>
          {plan.characters.map((c) => (
            <div key={c.character_id} style={{ fontSize: 12.5, marginBottom: 4 }}>
              <b>{c.name}</b> <span style={{ color: "#6b7280" }}>({c.role})</span>
              {c.usage && <div style={{ color: "#475569" }}>{c.usage}</div>}
            </div>
          ))}
        </div>
      )}
      {plan.audio.background_music && block("Music & sound", [plan.audio.background_music, plan.audio.ambience].filter(Boolean).join(" · "))}
      {plan.age_appropriateness.pacing_notes && block("Age notes", [
        plan.age_appropriateness.language_notes,
        plan.age_appropriateness.visual_notes,
        plan.age_appropriateness.pacing_notes,
      ].filter(Boolean).join(" "))}
      {plan.warnings.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {plan.warnings.map((w, i) => (
            <div key={i} style={{ fontSize: 11.5, color: "#92400e" }}>⚠ {w}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function PlanEditor({ draft, locked, dirty, busy, onChange, onSave }: {
  draft: KidsDirectorPlan;
  locked: boolean;
  dirty: boolean;
  busy: boolean;
  onChange: (p: KidsDirectorPlan) => void;
  onSave: () => void;
}) {
  const set = (patch: Partial<KidsDirectorPlan>) => onChange({ ...draft, ...patch });
  return (
    <div style={{ border: "1px solid #bfdbfe", borderRadius: 6, padding: 12, background: "#f8fbff" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 12.5, color: "#475569" }}>
          Editing the plan — every change is stored as a new version.
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn primary sm" onClick={onSave} disabled={!dirty || busy}>
          {busy ? <Spinner size={14} /> : "Save new version"}
        </button>
      </div>
      {locked && (
        <div style={{ padding: 8, background: "#fef3c7", color: "#92400e", borderRadius: 5, marginBottom: 10, fontSize: 12 }}>
          This plan is approved. Saving creates a new draft version — the approved one is kept in the history.
        </div>
      )}
      {field("Creative direction",
        <textarea className="input" rows={3} value={draft.creative_direction}
          onChange={(e) => set({ creative_direction: e.target.value })} />)}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
        {field("Teaching objective",
          <textarea className="input" rows={2} value={draft.objective.teaching_objective}
            onChange={(e) => set({ objective: { ...draft.objective, teaching_objective: e.target.value } })} />)}
        {field("Entertainment objective",
          <textarea className="input" rows={2} value={draft.objective.entertainment_objective}
            onChange={(e) => set({ objective: { ...draft.objective, entertainment_objective: e.target.value } })} />)}
        {field("Beginning",
          <textarea className="input" rows={2} value={draft.narrative.beginning}
            onChange={(e) => set({ narrative: { ...draft.narrative, beginning: e.target.value } })} />)}
        {field("Middle",
          <textarea className="input" rows={2} value={draft.narrative.middle}
            onChange={(e) => set({ narrative: { ...draft.narrative, middle: e.target.value } })} />)}
        {field("Climax",
          <textarea className="input" rows={2} value={draft.narrative.climax}
            onChange={(e) => set({ narrative: { ...draft.narrative, climax: e.target.value } })} />)}
        {field("Ending",
          <textarea className="input" rows={2} value={draft.narrative.ending}
            onChange={(e) => set({ narrative: { ...draft.narrative, ending: e.target.value } })} />)}
      </div>
      {field("Visual continuity",
        <textarea className="input" rows={2} value={draft.visual_continuity}
          onChange={(e) => set({ visual_continuity: e.target.value })} />)}
      {field("Pacing notes (age appropriateness)",
        <textarea className="input" rows={2} value={draft.age_appropriateness.pacing_notes}
          onChange={(e) => set({ age_appropriateness: { ...draft.age_appropriateness, pacing_notes: e.target.value } })} />)}
    </div>
  );
}

// ------------------------------------------------------------------ story
function StoryPanel({ detail, onSync, busy }: {
  detail: KidsProjectDetail;
  onSync: () => void;
  busy: string | null;
}) {
  const { project, scenes, characters } = detail;
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 13, color: "#475569" }}>
          {scenes.length} scenes · {characters.length} characters
          {project.board_id ? <> · storyboard <code>{project.board_id}</code></> : " · no storyboard linked yet"}
        </span>
        <span style={{ flex: 1 }} />
        {project.board_id && (
          <button className="btn sm" onClick={onSync} disabled={!!busy}>
            {busy === "sync" ? <Spinner size={14} /> : "Sync"}
          </button>
        )}
      </div>
      {scenes.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {scenes.map((s) => (
            <div key={s.scene_number} style={{ border: "1px solid #e5e7eb", borderRadius: 6, padding: "10px 12px", background: "#fff" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <b style={{ fontSize: 13 }}>Scene {s.scene_number}</b>
                <span style={{ fontSize: 13 }}>{s.title}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 11.5, color: "#6b7280" }}>{s.duration_seconds}s · {s.status}</span>
              </div>
              {s.synopsis && <div style={{ fontSize: 12.5, marginTop: 4, color: "#334155" }}>{s.synopsis}</div>}
              {(s.camera || s.transition) && (
                <div style={{ fontSize: 11.5, marginTop: 4, color: "#6b7280" }}>
                  {s.camera}{s.transition ? ` · transition: ${s.transition}` : ""}
                </div>
              )}
              {s.prompt && (
                <details style={{ marginTop: 6 }}>
                  <summary style={{ cursor: "pointer", fontSize: 11.5, color: "#475569" }}>Image prompt</summary>
                  <div style={{ fontSize: 11.5, color: "#334155", marginTop: 4 }}>{s.prompt}</div>
                </details>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: "#6b7280" }}>
          No scenes yet. Use the <b>AI Director</b> tab to analyse the story and plan the storyboard, then
          link it to this project.
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ link
// Link the project to a Director storyboard. The Director owns the
// storyboard; the studio mirrors it so the plan and the storyboard never
// drift apart (the server re-derives the Director Plan from the board).
function BoardLink({ projectId, linkedBoardId, busy, onLinked }: {
  projectId: string | null;
  linkedBoardId: string | null;
  busy: boolean;
  onLinked: (boardId: string) => void;
}) {
  const [boards, setBoards] = useState<DirectorBoardMeta[] | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await directorBoards();
      setBoards(list);
    } catch {
      setBoards([]);
    }
  }, []);

  useEffect(() => { if (open && !boards) void load(); }, [open, boards, load]);

  if (!projectId) return null;
  if (!open) {
    return (
      <button className="btn sm" onClick={() => setOpen(true)} disabled={busy}>
        {linkedBoardId ? "Change storyboard" : "Link storyboard"}
      </button>
    );
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <select
        className="input"
        defaultValue={linkedBoardId ?? ""}
        style={{ width: 220, fontSize: 12, padding: "4px 8px" }}
        onChange={(e) => { if (e.target.value) { onLinked(e.target.value); setOpen(false); } }}
      >
        <option value="" disabled>Pick a storyboard…</option>
        {(boards || []).map((b) => (
          <option key={b.id} value={b.id}>
            {b.title || b.id} · {b.scenes}/{b.sceneCount} scenes
          </option>
        ))}
      </select>
      <button className="btn sm" onClick={() => setOpen(false)}>Cancel</button>
    </div>
  );
}
