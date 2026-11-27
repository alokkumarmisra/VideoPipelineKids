// Sanskriti KIDS — Master 19-Track Synchronized Timeline (DAW-style UI).
//
// Pure presentation over the EXISTING master timeline object. No analysis, no
// new database, no invented events: `buildTimelineView()` (lib/timeline_view.mjs)
// maps the server's MasterTimelineResponse onto 19 renderable lanes. Playback
// uses the board's original uploaded audio (the single authoritative clock).

import {
  memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type MouseEvent as ReactMouseEvent, type RefObject,
} from "react";
import {
  buildRulerTicks,
  buildTimelineView,
  formatTimecode,
  visibleEvents,
  TIMELINE_VIEW_TRACKS,
  type TimelineView,
  type TimelineViewEvent,
  type TimelineViewTrack,
} from "../../../lib/timeline_view.mjs";
import { directorBoardAudioUrl, type MasterTimelineResponse } from "../api";
import { IconMusic } from "./Icons";

export type TimelineTrackCounts = {
  lyrics: number; word_timings: number; speaker_events: number; narrative_events: number;
  character_appearances: number; character_actions: number; emotions: number;
  dialogue_performance: number; choreography: number; camera_direction: number;
  scene_timeline: number; shot_timeline: number; lip_sync: number; sound_effects: number;
  video_assets: number; transitions: number; subtitles: number;
  original_audio: number; music_structure: number;
};

export type TimelineValidation = { valid: boolean; warnings: string[] };

export type MasterTimelineStudioProps = {
  boardId?: string;
  uploaded: boolean;
  duration: number;
  analysisStatus: "pending" | "generated" | "validated" | "approved" | "failed";
  timelineEvents: TimelineTrackCounts;
  validation: TimelineValidation;
  approval: "pending" | "approved" | "revision_required";
  version: number;
  /** The same approved master-timeline object the rest of the studio uses. */
  masterTimeline?: MasterTimelineResponse | null;
  audioFileName?: string;
  onUpload: (audioFile: File) => void | Promise<void>;
  onAnalyze: () => void;
  onDirectorPlan: () => void;
};

const SIDE_W = 236;
const LANE_H = 34;
const RULER_H = 38;
const MIN_PPS = 0.25;
const MAX_PPS = 900;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------
export function TimelineHeader({ view, approval, version }: {
  view: TimelineView; approval: MasterTimelineStudioProps["approval"]; version: number;
}) {
  const status = approval === "approved"
    ? { cls: "done", label: "Approved · timing authority" }
    : approval === "revision_required"
      ? { cls: "warn", label: "Revision required" }
      : { cls: "pending", label: "Pending approval" };
  return (
    <header className="daw-head">
      <div className="daw-title-row">
        <h3><IconMusic size={14} /> Master 19-Track Synchronized Audio-Visual Timeline</h3>
        <span className={`pill ${status.cls}`}>{status.label}</span>
      </div>
      <p className="daw-sub">
        Single authoritative audio clock ({view.duration.toFixed(1)}s @ {view.frameRate} fps) · {view.totalEvents.toLocaleString()} synchronized events across 19 tracks · v{view.version || version}
      </p>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Playback / zoom toolbar
// ---------------------------------------------------------------------------
export function TimelineToolbar({ playing, currentTime, duration, pxPerSec, audioReady, trackCount, filter, onFilter, onPlay, onZoom, onFit }: {
  playing: boolean;
  currentTime: number;
  duration: number;
  pxPerSec: number;
  audioReady: boolean;
  trackCount: number;
  filter: string;
  onFilter: (v: string) => void;
  onPlay: () => void;
  onZoom: (factor: number) => void;
  onFit: () => void;
}) {
  return (
    <div className="daw-toolbar">
      <div className="daw-tool-group">
        <button className="daw-btn daw-play" onClick={onPlay} disabled={!audioReady}
          title={playing ? "Pause the original audio" : "Play the original audio"} aria-label={playing ? "Pause" : "Play"}>
          {playing ? "❚❚" : "▶"}
        </button>
        <span className={`daw-time${audioReady ? "" : " muted"}`} title="Current position on the authoritative audio clock">
          {formatTimecode(currentTime)}
        </span>
        <span className="daw-duration">/ {formatTimecode(duration)}</span>
      </div>
      <div className="daw-tool-group daw-tool-right">
        <button className="daw-btn" onClick={() => onZoom(1 / 1.5)} title="Zoom out" aria-label="Zoom out">−</button>
        <span className="daw-zoom" title="Zoom relative to the 10 px/s baseline">{Math.round((pxPerSec / 10) * 100)}%</span>
        <button className="daw-btn" onClick={() => onZoom(1.5)} title="Zoom in" aria-label="Zoom in">+</button>
        <button className="daw-btn daw-fit" onClick={onFit} title="Fit the entire timeline in view">Fit</button>
        <label className="daw-filter">
          <span>Filter</span>
          <select value={filter} onChange={(e) => onFilter(e.target.value)} title="Filter tracks">
            <option value="all">All 19 tracks</option>
            <option value="events">Tracks with events</option>
            <option value="empty">Empty tracks</option>
            <option value="audio">Audio &amp; music</option>
            <option value="text">Lyrics &amp; text</option>
            <option value="narrative">Narrative &amp; characters</option>
            <option value="performance">Performance &amp; lip-sync</option>
            <option value="direction">Camera, scenes &amp; shots</option>
            <option value="assets">Assets &amp; transitions</option>
          </select>
        </label>
        <span className="daw-count" title="Visible tracks">{trackCount}/19 tracks</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ruler — one shared time axis for every lane
// ---------------------------------------------------------------------------
export const TimelineRuler = memo(function TimelineRuler({ duration, pxPerSec, viewportWidth, onSeek }: {
  duration: number; pxPerSec: number; viewportWidth: number; onSeek: (t: number) => void;
}) {
  const ticks = useMemo(
    () => buildRulerTicks(duration, pxPerSec, Math.max(200, viewportWidth - SIDE_W)),
    [duration, pxPerSec, viewportWidth],
  );
  const onClick = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    onSeek(clamp((e.clientX - rect.left) / pxPerSec, 0, duration));
  }, [duration, onSeek, pxPerSec]);
  return (
    <div className="daw-ruler" style={{ width: duration * pxPerSec }} onClick={onClick} title="Click to seek">
      {ticks.map((t) => (
        <div key={t.time.toFixed(4)} className={`daw-tick${t.major ? " major" : ""}`} style={{ left: t.time * pxPerSec }}>
          {t.major && <span className="daw-tick-label">{t.label}</span>}
        </div>
      ))}
      <div className="daw-ruler-end" style={{ left: duration * pxPerSec }}>{formatTimecode(duration, false)}</div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Fixed track-name column
// ---------------------------------------------------------------------------
export const TrackSidebar = memo(function TrackSidebar({ tracks, hidden, locked, onToggleHidden, onToggleLocked }: {
  tracks: TimelineViewTrack[];
  hidden: Set<string>;
  locked: Set<string>;
  onToggleHidden: (id: string) => void;
  onToggleLocked: (id: string) => void;
}) {
  return (
    <div className="daw-side" style={{ width: SIDE_W }}>
      {tracks.map((track) => (
        <div key={track.id} className={`daw-side-row${hidden.has(track.id) ? " hidden-track" : ""}`} style={{ height: LANE_H }}
          data-track={track.id}>
          <span className="daw-track-no">{String(track.number).padStart(2, "0")}</span>
          <span className="daw-track-name" style={{ borderLeftColor: track.color }} title={track.name}>{track.name}</span>
          <span className="daw-track-count" title={`${track.count} event${track.count === 1 ? "" : "s"}`}>{track.count}</span>
          <button className={`daw-icon${hidden.has(track.id) ? " off" : ""}`}
            onClick={() => onToggleHidden(track.id)}
            title={hidden.has(track.id) ? "Show track" : "Hide track"} aria-label={`Toggle ${track.name} visibility`}>
            {hidden.has(track.id) ? "◌" : "👁"}
          </button>
          <button className={`daw-icon${locked.has(track.id) ? " off" : ""}`}
            onClick={() => onToggleLocked(track.id)}
            title={locked.has(track.id) ? "Unlock track" : "Lock track"} aria-label={`Toggle ${track.name} lock`}>
            {locked.has(track.id) ? "🔒" : "🔓"}
          </button>
        </div>
      ))}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Event block
// ---------------------------------------------------------------------------
export const TimelineEvent = memo(function TimelineEvent({ event, color, pxPerSec, selected, onSelect }: {
  event: TimelineViewEvent;
  color: string;
  pxPerSec: number;
  selected: boolean;
  onSelect: (event: TimelineViewEvent) => void;
}) {
  const left = event.start * pxPerSec;
  const width = Math.max(2, (event.end - event.start) * pxPerSec);
  return (
    <button
      className={`daw-event${selected ? " selected" : ""}`}
      style={{ left, width, background: `${color}2e`, borderColor: `${color}aa`, boxShadow: `inset 2px 0 0 ${color}` }}
      onClick={(e) => { e.stopPropagation(); onSelect(event); }}
      title={`${event.label} · ${formatTimecode(event.start)} → ${formatTimecode(event.end)}`}
      data-event-id={event.id}
      data-start={event.start}
      data-end={event.end}
    >
      <span className="daw-event-label">{event.label}</span>
    </button>
  );
});

// ---------------------------------------------------------------------------
// One lane — only events intersecting the viewport are mounted (virtualized)
// ---------------------------------------------------------------------------
export const TimelineTrack = memo(function TimelineTrack({ track, pxPerSec, from, to, hidden, locked, selectedId, onSelect }: {
  track: TimelineViewTrack;
  pxPerSec: number;
  from: number;
  to: number;
  hidden: boolean;
  locked: boolean;
  selectedId: string | null;
  onSelect: (event: TimelineViewEvent) => void;
}) {
  const shown = useMemo(() => visibleEvents(track.events, from, to, 2 / pxPerSec), [track.events, from, to, pxPerSec]);
  if (hidden) return <div className="daw-lane hidden-lane" style={{ height: LANE_H }} data-lane={track.id} data-count={track.count} />;
  return (
    <div className="daw-lane" style={{ height: LANE_H }} data-lane={track.id} data-count={track.count}>
      {shown.map((event) => (
        <TimelineEvent key={event.id} event={event} color={track.color} pxPerSec={pxPerSec}
          selected={selectedId === event.id && !locked} onSelect={locked ? () => undefined : onSelect} />
      ))}
      {track.count === 0 && <span className="daw-empty-label">No events generated for this track</span>}
      {locked && track.count > 0 && <span className="daw-lock-mark" title="Track locked">🔒</span>}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Playhead — driven directly from the audio element via rAF, so its smooth
// movement never re-renders the 19 lanes or the ruler.
// ---------------------------------------------------------------------------
export function Playhead({ audioRef, playing, pxPerSec, duration }: {
  audioRef: RefObject<HTMLAudioElement>;
  playing: boolean;
  pxPerSec: number;
  duration: number;
}) {
  const [time, setTime] = useState(0);
  useEffect(() => {
    if (!playing) {
      setTime(audioRef.current?.currentTime || 0);
      return;
    }
    let raf = 0;
    const tick = () => {
      setTime(audioRef.current?.currentTime || 0);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [audioRef, playing]);
  const x = clamp(time, 0, duration) * pxPerSec;
  return (
    <div className="daw-playhead" style={{ left: x }} aria-hidden="true">
      <span className="daw-playhead-cap">{formatTimecode(time)}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Selected event details
// ---------------------------------------------------------------------------
const META_LABELS: Record<string, string> = {
  character: "Character", scene: "Scene", shot: "Shot / clip", action: "Action", emotion: "Emotion",
  dialogue: "Dialogue", camera: "Camera", timing: "Timing source", confidence: "Confidence",
  line: "Lyric line", kind: "Segment type", grounded: "Grounded", reviewed: "Review status",
};
export function EventDetailsPanel({ event, track, onClose, onSeek }: {
  event: TimelineViewEvent; track: TimelineViewTrack; onClose: () => void; onSeek: (t: number) => void;
}) {
  const meta = event.meta || {};
  const rows: [string, string][] = [
    ["Track", `${String(track.number).padStart(2, "0")} · ${track.name}`],
    ["Start", formatTimecode(event.start)],
    ["End", formatTimecode(event.end)],
    ["Duration", `${(event.end - event.start).toFixed(3)} s`],
    ["Event ID", event.id],
  ];
  for (const [key, label] of Object.entries(META_LABELS)) {
    const value = meta[key];
    if (value == null || value === "") continue;
    rows.push([label, typeof value === "object" ? JSON.stringify(value) : String(value)]);
  }
  return (
    <aside className="daw-details" aria-label="Event details">
      <div className="daw-details-head">
        <strong>Event details</strong>
        <button className="daw-icon" onClick={onClose} title="Close details" aria-label="Close event details">✕</button>
      </div>
      <div className="daw-details-title" style={{ borderLeftColor: track.color }}>{event.label}</div>
      {event.detail && <p className="daw-details-desc">{event.detail}</p>}
      <dl className="daw-details-grid">
        {rows.map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd title={v}>{v}</dd></div>
        ))}
      </dl>
      <button className="daw-btn daw-seek" onClick={() => onSeek(event.start)}>⏱ Seek to start</button>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Compact status / validation / actions (replaces the old count-only summary)
// ---------------------------------------------------------------------------
export function TimelineValidationPanel({ view, fallbackCounts, analysisStatus, validation, approval, version, onAnalyze, onDirectorPlan }: {
  view: TimelineView | null;
  fallbackCounts: TimelineTrackCounts;
  analysisStatus: MasterTimelineStudioProps["analysisStatus"];
  validation: TimelineValidation;
  approval: MasterTimelineStudioProps["approval"];
  version: number;
  onAnalyze: () => void;
  onDirectorPlan: () => void;
}) {
  const counts = useMemo(() => {
    const out: { id: string; name: string; count: number; color: string }[] = [];
    for (const def of TIMELINE_VIEW_TRACKS) {
      const live = view?.tracks.find((t) => t.id === def.id);
      out.push({
        id: def.id, name: def.name, color: def.color,
        count: live ? live.count : (fallbackCounts[def.id as keyof TimelineTrackCounts] || 0),
      });
    }
    return out;
  }, [view, fallbackCounts]);
  const total = view ? view.totalEvents : Object.values(fallbackCounts).reduce((n, v) => n + v, 0);
  const analysisLabel = analysisStatus === "validated" || analysisStatus === "approved" ? "Validated"
    : analysisStatus === "failed" ? "Failed" : "Pending";
  return (
    <section className="daw-status" aria-label="Timeline status and validation">
      <div className="daw-status-head">
        <span className={`daw-tag${validation.valid && validation.warnings.length === 0 ? " ok" : validation.warnings.length ? " warn" : " err"}`}>
          Analysis: {analysisLabel}
        </span>
        <span className="daw-tag">Version: v{view?.version || version}</span>
        <span className="daw-tag">Duration: {(view?.duration || 0).toFixed(1)}s</span>
        <span className={`daw-tag${approval === "approved" ? " approved" : approval === "revision_required" ? " err" : " warn"}`}>
          Approval: {approval === "approved" ? "Approved" : approval === "revision_required" ? "Revision required" : "Pending"}
        </span>
        <span className="daw-tag">Total events: {total.toLocaleString()}</span>
        <span className="daw-spacer" />
        <button className="daw-btn" onClick={onAnalyze} title="Run WhisperX on the uploaded audio and derive the 19-track master timeline">
          Analyze Audio &amp; Build 19-Track Timeline
        </button>
        {approval === "pending" && <button className="daw-btn" onClick={onDirectorPlan}>Approve Timeline</button>}
        {approval === "approved" && (
          <button className="daw-btn primary" onClick={onDirectorPlan}>Send Approved Timeline to AI Director</button>
        )}
      </div>
      <div className="daw-count-grid">
        {counts.map((c) => (
          <span key={c.id} className="daw-count-chip" style={{ borderLeftColor: c.color }}>
            <span>{c.name}</span><b>{c.count}</b>
          </span>
        ))}
      </div>
      <details className="daw-validation" open={validation.warnings.length > 0}>
        <summary>
          Validation details · {validation.valid ? "Valid" : "Invalid"}
          {validation.warnings.length > 0 && <span className="daw-warn-count"> {validation.warnings.length} warning{validation.warnings.length === 1 ? "" : "s"}</span>}
          {approval === "approved" && <span className="daw-approved-mark"> · Approved (separate status)</span>}
        </summary>
        {validation.warnings.length === 0
          ? <p className="daw-validation-empty">No validation warnings reported.</p>
          : (
            <ul className="daw-warnings">
              {validation.warnings.map((w, i) => <li key={`${i}-${w}`}>{w}</li>)}
            </ul>
          )}
      </details>
      <p className="daw-note">
        Design principle (spec PART 10): the original audio clock is authoritative throughout — no
        independent scene/shot clocks, no lip-sync during instrumental shots, all timestamps clamped
        to the master audio duration. Approval and validation remain separate statuses.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main studio shell
// ---------------------------------------------------------------------------
function MasterTimelineStudio(props: MasterTimelineStudioProps) {
  const {
    boardId, uploaded, duration, analysisStatus, timelineEvents, validation, approval, version,
    masterTimeline, audioFileName, onUpload, onAnalyze, onDirectorPlan,
  } = props;

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pendingCenterRef = useRef<number | null>(null);
  const fittedForRef = useRef<string | null>(null);

  const view = useMemo<TimelineView>(() => buildTimelineView(masterTimeline, {
    duration: uploaded ? duration : 0,
    version,
    hasAudio: uploaded,
    audioFileName,
  }), [masterTimeline, duration, uploaded, version, audioFileName]);

  const audioUrl = masterTimeline?.whisperx_audio_url
    || (boardId ? directorBoardAudioUrl(boardId) : null);
  const audioReady = Boolean(audioUrl);

  const [pxPerSec, setPxPerSec] = useState(10);
  const [viewportWidth, setViewportWidth] = useState(1200);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [filter, setFilter] = useState("all");
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [locked, setLocked] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<{ event: TimelineViewEvent; track: TimelineViewTrack } | null>(null);

  const fit = useCallback(() => {
    const el = scrollRef.current;
    const usable = Math.max(240, (el?.clientWidth || viewportWidth) - SIDE_W - 24);
    setPxPerSec(clamp((view.duration || 0) > 0 ? usable / view.duration : 10, MIN_PPS, MAX_PPS));
    if (el) el.scrollLeft = 0;
  }, [view.duration, viewportWidth]);

  // Measure once and on resize; fit the whole timeline on first load / duration change.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const key = `${boardId || "board"}:${view.duration.toFixed(3)}`;
    if (view.duration <= 0 || fittedForRef.current === key) return;
    fittedForRef.current = key;
    fit();
  }, [boardId, view.duration, fit]);

  // Preserve the time under the viewport centre across zoom changes.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || pendingCenterRef.current == null) return;
    const laneW = Math.max(120, el.clientWidth - SIDE_W);
    el.scrollLeft = Math.max(0, pendingCenterRef.current * pxPerSec - laneW / 2);
    pendingCenterRef.current = null;
  }, [pxPerSec]);

  const zoom = useCallback((factor: number) => {
    const el = scrollRef.current;
    const laneW = Math.max(120, (el?.clientWidth || viewportWidth) - SIDE_W);
    pendingCenterRef.current = ((el?.scrollLeft || 0) + laneW / 2) / pxPerSec;
    setPxPerSec((cur) => clamp(cur * factor, MIN_PPS, MAX_PPS));
  }, [pxPerSec, viewportWidth]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) setScrollLeft(el.scrollLeft);
  }, []);

  const seek = useCallback((t: number) => {
    const a = audioRef.current;
    if (!a) return;
    const next = clamp(t, 0, Math.max(0, view.duration));
    try { a.currentTime = next; } catch { /* not loaded yet */ }
    setCurrentTime(next);
  }, [view.duration]);

  const togglePlay = useCallback(() => {
    const a = audioRef.current;
    if (!a || !audioReady) return;
    if (a.paused) void a.play().catch(() => setPlaying(false));
    else a.pause();
  }, [audioReady]);

  const onTimeUpdate = useCallback(() => {
    const a = audioRef.current;
    if (a) setCurrentTime(a.currentTime);
  }, []);

  const toggleHidden = useCallback((id: string) => setHidden((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);
  const toggleLocked = useCallback((id: string) => setLocked((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);
  const selectEvent = useCallback((event: TimelineViewEvent) => {
    const track = view.tracks.find((t) => t.id === event.trackId) || null;
    if (track) setSelected({ event, track });
    seek(event.start);
  }, [seek, view.tracks]);

  const selectedTrack = selected ? view.tracks.find((t) => t.id === selected.event.trackId) || null : null;
  // Memoized so horizontal scroll (which updates `scrollLeft`) never rebuilds
  // the sidebar or invalidates the 19 memoized lane components.
  const shownTracks = useMemo(() => view.tracks.filter((track) => {
    if (hidden.has(track.id)) return true; // hidden rows stay visible (with no events)
    if (filter === "all") return true;
    if (filter === "events") return track.count > 0;
    if (filter === "empty") return track.count === 0;
    return track.group === filter;
  }), [view.tracks, filter, hidden]);
  const visibleCount = useMemo(
    () => shownTracks.filter((t) => !hidden.has(t.id)).length, [shownTracks, hidden],
  );
  const canvasWidth = SIDE_W + Math.max(viewportWidth - SIDE_W, view.duration * pxPerSec);
  const from = scrollLeft / pxPerSec;
  const to = from + Math.max(0, viewportWidth - SIDE_W) / pxPerSec;

  return (
    <section className="card daw-shell" aria-label="Master 19-track synchronized timeline">
      <TimelineHeader view={view} approval={approval} version={version} />
      <TimelineToolbar
        playing={playing} currentTime={currentTime} duration={view.duration} pxPerSec={pxPerSec}
        audioReady={audioReady} trackCount={visibleCount} filter={filter} onFilter={setFilter}
        onPlay={togglePlay} onZoom={zoom} onFit={fit}
      />
      <audio
        ref={audioRef} preload="metadata" src={audioUrl || undefined}
        onTimeUpdate={onTimeUpdate} onSeeked={onTimeUpdate}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setCurrentTime(view.duration); }}
      />
      <div className="daw-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="daw-canvas" style={{ width: canvasWidth, gridTemplateColumns: `${SIDE_W}px ${canvasWidth - SIDE_W}px` }}>
          <div className="daw-corner" style={{ height: RULER_H, width: SIDE_W }}>
            <span>TRACKS</span><span className="daw-corner-count">19</span>
          </div>
          <TimelineRuler duration={view.duration} pxPerSec={pxPerSec} viewportWidth={viewportWidth} onSeek={seek} />
          <TrackSidebar tracks={shownTracks} hidden={hidden} locked={locked}
            onToggleHidden={toggleHidden} onToggleLocked={toggleLocked} />
          <div className="daw-lanes" style={{ height: shownTracks.length * LANE_H }}>
            {shownTracks.map((track) => (
              <TimelineTrack key={track.id} track={track} pxPerSec={pxPerSec} from={from} to={to}
                hidden={hidden.has(track.id)} locked={locked.has(track.id)}
                selectedId={selected?.event.id || null} onSelect={selectEvent} />
            ))}
            <Playhead audioRef={audioRef} playing={playing} pxPerSec={pxPerSec} duration={view.duration} />
          </div>
        </div>
      </div>
      {selected && selectedTrack && (
        <EventDetailsPanel event={selected.event} track={selectedTrack}
          onClose={() => setSelected(null)} onSeek={seek} />
      )}
      <TimelineValidationPanel
        view={view.totalEvents > 0 || uploaded ? view : null}
        fallbackCounts={timelineEvents}
        analysisStatus={analysisStatus} validation={validation} approval={approval} version={version}
        onAnalyze={onAnalyze} onDirectorPlan={onDirectorPlan}
      />
      {!audioReady && (
        <p className="daw-note">The uploaded audio stream is not available on this board yet — analysis/playback unlocks after upload.</p>
      )}
    </section>
  );
}

export default memo(MasterTimelineStudio);
