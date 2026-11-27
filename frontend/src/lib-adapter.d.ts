// Type declarations for the shared pure-JS adapter modules in ../../lib.
// These files are plain .mjs (no types); the declarations below keep `tsc`
// quiet while Vite resolves the real modules at dev/build time.
declare module "../../lib/directorAudioAdapter" {
  export interface DirectorAudioContext {
    audioId: string | null;
    audioFilename: string | null;
    durationSec: number;
    sampleRateHz: number;
    frameRate: number;
    bpm: number;
    totalBeats: number;
    beatPositionsSec: number[];
  }
  export function buildDirectorAudioContext(
    masterTimeline: unknown,
    production: unknown,
    options?: { bpm?: number; beatPositionsSec?: number[] },
  ): DirectorAudioContext;
  export function buildDirectorInputEnriched(
    baseInput: unknown,
    masterTimeline: unknown,
    production: unknown,
    options?: { bpm?: number; beatPositionsSec?: number[]; enrichFromTimeline?: boolean },
  ): {
    input: unknown;
    audioContext: DirectorAudioContext | null;
    narrativeContext: Record<string, unknown[]>;
    visualContext: Record<string, unknown[]>;
    validationContext: {
      timelineStatus: string;
      approvalStatus: string;
      warnings: string[];
      timelineVersion: number;
    };
  };
  export function buildDirectorNarrativeContext(
    masterTimelineEvents: unknown,
    masterDurationSec: number,
    options?: { clampToMaster?: boolean },
  ): Record<string, unknown[]>;
  export function buildDirectorVisualContext(
    masterTimelineEvents: unknown,
    masterDurationSec: number,
  ): Record<string, unknown[]>;
  export function verifyAdapterBackwardCompatibility(baseInput: unknown): boolean;
  export const DIRECTOR_TIMELINE_TRACKS: string[];
}

declare module "../../lib/directorAudioIntegration" {
  export function unifiedToMasterTimelineArg(timeline: unknown): unknown;
  export function buildStoryPlan(args: unknown, unified?: unknown): unknown;
  export function buildScenesPrompt(args: unknown, unified?: unknown): string;
  export function computeAudioSyncScore(board: unknown, unified: unknown): number;
  export function scoreDirectorPlan(board: unknown, opts?: unknown, unified?: unknown): unknown;
  export function validateStoryBoard(board: unknown, unified?: unknown): unknown;
  export function verifyAdapterIntegration(sampleArgs: unknown): boolean;
  export const DIRECTOR_TIMELINE_TRACKS: string[];
}

