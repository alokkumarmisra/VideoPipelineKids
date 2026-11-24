// Types for the pure UI adapter ../frontend/src/components/MasterTimelineStudio.tsx consumes.
export interface TimelineViewTrackDef {
  id: string;
  number: number;
  name: string;
  color: string;
  group: string;
}
export interface TimelineViewEvent {
  id: string;
  trackId: string;
  /** seconds on the single authoritative audio clock */
  start: number;
  end: number;
  label: string;
  detail: string;
  meta: Record<string, unknown>;
}
export interface TimelineViewTrack extends TimelineViewTrackDef {
  events: TimelineViewEvent[];
  count: number;
}
export interface TimelineView {
  duration: number;
  frameRate: number;
  version: number;
  approved: boolean;
  audioUrl: string | null;
  totalEvents: number;
  tracks: TimelineViewTrack[];
  events: TimelineViewEvent[];
}
export const TIMELINE_VIEW_TRACKS: readonly TimelineViewTrackDef[];
export function buildTimelineView(
  response: unknown,
  options?: {
    duration?: number;
    frameRate?: number;
    version?: number;
    hasAudio?: boolean;
    audioFileName?: string;
  },
): TimelineView;
export function formatTimecode(seconds: number, withMs?: boolean): string;
export function timelineTickStep(pxPerSec: number, viewportWidth?: number): number;
export function buildRulerTicks(duration: number, pxPerSec: number, viewportWidth?: number):
  { time: number; major: boolean; label: string }[];
export function visibleEvents(
  events: TimelineViewEvent[],
  start: number,
  end: number,
  pad?: number,
): TimelineViewEvent[];
