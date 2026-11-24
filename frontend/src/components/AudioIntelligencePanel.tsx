// Sanskriti KIDS — Audio Intelligence Panel entry point.
// All 19 tracks are now rendered visually by MasterTimelineStudio over the
// SAME MasterTimelineResponse object (no duplicate data, no new analysis).
// This wrapper keeps the original props/handlers and the no-audio upload state.

import { useCallback, useState } from "react";
import { IconMusic } from "./Icons";
import MasterTimelineStudio, {
  type TimelineTrackCounts, type TimelineValidation,
} from "./MasterTimelineStudio";
import type { MasterTimelineResponse } from "../api";

export type { TimelineTrackCounts, TimelineValidation };

export type AudioIntelligencePanelProps = {
  boardId?: string;
  /** Whether audio has been uploaded/processed */
  uploaded: boolean;
  /** Audio duration in seconds */
  duration: number;
  /** Audio analysis status */
  analysisStatus: "pending" | "generated" | "validated" | "approved" | "failed";
  /** Per-track event counts from the 19-track timeline (fallback summary) */
  timelineEvents: TimelineTrackCounts;
  /** Validation results */
  validation: TimelineValidation;
  /** Approval status */
  approval: "pending" | "approved" | "revision_required";
  /** Current timeline version number */
  version: number;
  /** The real master timeline — single source of truth for every event block. */
  masterTimeline?: MasterTimelineResponse | null;
  audioFileName?: string;
  /** Callback when user uploads audio (.wav) — may be async */
  onUpload: (audioFile: File) => void | Promise<void>;
  /** Callback when user clicks "Analyze Audio & Build 19-Track Timeline" */
  onAnalyze: () => void;
  /** Callback when user clicks "Send Approved Timeline to AI Director" */
  onDirectorPlan: () => void;
};

const AudioIntelligencePanel: React.FC<AudioIntelligencePanelProps> = ({
  boardId, uploaded, duration, analysisStatus, timelineEvents, validation, approval, version,
  masterTimeline, audioFileName, onUpload, onAnalyze, onDirectorPlan,
}) => {
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  // The parent (DirectorPage) runs the real .wav → WhisperX → master-timeline
  // pipeline. The panel only forwards the picked file — no fake timers, no
  // auto-generated counts.
  const handleUpload = useCallback(async (file: File) => {
    setIsAnalyzing(true);
    try { await onUpload(file); } finally { setIsAnalyzing(false); }
  }, [onUpload]);

  if (uploaded) {
    return (
      <MasterTimelineStudio
        boardId={boardId}
        uploaded={uploaded}
        duration={duration}
        analysisStatus={analysisStatus}
        timelineEvents={timelineEvents}
        validation={validation}
        approval={approval}
        version={version}
        masterTimeline={masterTimeline}
        audioFileName={audioFileName}
        onUpload={handleUpload}
        onAnalyze={onAnalyze}
        onDirectorPlan={onDirectorPlan}
      />
    );
  }

  return (
    <section className="card" aria-label="Audio Intelligence">
      <div className="card-head">
        <h3><IconMusic size={14} /> Audio Intelligence &amp; 19-Track Timeline</h3>
        <span className="pill pending">No .wav yet</span>
      </div>
      <div className="card-body">
        <div className="row" style={{ marginBottom: 8, gap: 8 }}>
          <button
            className="ghost"
            disabled={isAnalyzing}
            onClick={() => {
              const input = document.createElement("input");
              input.type = "file";
              input.accept = ".wav,audio/wav,audio/mpeg,audio/mp3,audio/mp4,.mp3,.m4a";
              input.onchange = (e) => {
                const file = (e.target as HTMLInputElement).files?.[0];
                if (file) void handleUpload(file);
              };
              input.click();
            }}
          >
            {isAnalyzing ? "Uploading…" : "📁 Upload Audio"}
          </button>
          <span className="hint">
            WAV/MP3/M4A. The original uploaded audio is the ONLY authoritative clock.
          </span>
        </div>
        <p className="hint" style={{ margin: 0 }}>
          Upload the original audio to unlock the 19-track synchronized timeline, playback and zoom controls.
        </p>
      </div>
    </section>
  );
};

export default AudioIntelligencePanel;
