# Implementation Plan: Audio Intelligence & 19-Track Master Timeline Integration

## Overview
Integrate the existing 19-track Synchronized Master Timeline workflow from `Sanskriti-AI-Studio` into the KIDS project's AI Director, making it a mandatory prerequisite stage between Story Input and AI Director Intelligence.

## Existing Components Analysis

### Sanskriti-AI-Studio (Source Project)
- **`src/lib/studioEngines.ts`**: Contains `buildMasterTimeline()` - builds the complete 19-track timeline
- **`src/lib/masterClock.ts`**: Time normalization, frame quantization, sample conversion
- **`src/types/studio.ts`**: Complete type definitions for 19 tracks, AVTimelineEvent, MasterTimeline, Production
- **`src/types/studio.ts` line 1325-1349**: `ALL_TIMELINE_TRACKS` - 19 tracks defined:
  01. original_audio, 02. music_structure, 03. lyrics, 04. word_timings, 05. speaker_events,
  06. narrative_events, 07. character_appearances, 08. character_actions, 09. emotions,
  10. dialogue_performance, 11. choreography, 12. camera_direction, 13. scene_timeline,
  14. shot_timeline, 15. lip_sync, 16. sound_effects, 17. video_assets, 18. transitions, 19. subtitles

- **`Production` type** (line 1226-1285): Includes `masterTimeline`, `audioVisualTimeline`, `audioAnalysis`, `shots`, `scenes`

### KIDS Project (Target)
- **`lib/director.mjs`**: AI Director functions (`buildBiblePrompt`, `buildScenesPrompt`, `normalizeScene`, etc.)
- **`frontend/src/api.ts`**: API routes for director workflow
- **`frontend/src/components/DirectorPage.tsx`**: Director UI
- **`lib/kids_pipeline.mjs`**: 16-stage Kids production pipeline

## Integration Architecture

```
Story Input
    ↓
Audio Intelligence Engine (new prerequisite stage)
    ↓
19-Track Master Timeline Generation & Validation
    ↓
Timeline Approval Gate
    ↓
AI Director Intelligence (extended to consume approved timeline)
    ↓
Story Bible & Semantic Reconciliation
    ↓
Cinematic Planning
    ↓
Existing 16-Stage Kids Production Pipeline
```

## Phase 1: New Files to Create

### `lib/directorAudioAdapter.mjs`
- `buildDirectorAudioContext(masterTimeline, production, options)` - converts approved 19-track MasterTimeline into normalized Director Input Contract
- Provides: Audio Context, Narrative Context, Performance Context, Visual Context, Post-Production Context, Validation Context

### `lib/directorAudioIntegration.mjs`
- Integration functions that extend existing Director functions with optional audioContext parameter
- `buildStoryPlan({input, blueprint, audioContext})`
- `buildScenesPrompt({input, blueprint, beats, audioContext})`
- `scoreDirectorPlan(board, {audioContext})`
- `validateStoryBoard(board, audioValidation)` - extended with audio-aware validation

## Phase 2: Modify Existing Files

### `lib/director.mjs`
- Add optional `audioContext` parameter to:
  - `buildBiblePrompt(input)` → add audio context info
  - `buildScenesPrompt({input, blueprint, beats, ...})` → pass audioContext through
  - `normalizeScene(s, n, sceneSeconds, opts)` → add audio timing awareness
  - `validateStoryBoard(board)` → add audio timeline validation checks
  - `scoreDirectorPlan(board, opts)` → add audio synchronization score component (20%)
  - `buildDirectionRepairPrompt(...)` → include audio context in repair diagnostics
  - `buildStoryPlan(board)` → reconcile with timeline
  - `buildShotList(board)` → add timeline event traceability
  - `buildImagePromptFor(shot, board)` → incorporate character identity from timeline
  - `buildVideoPromptFor(shot, board)` → incorporate motion from timeline timing

### `frontend/src/api.ts`
- Add routes for audio timeline upload, validation, and approval
- Extend existing director routes to accept audioContext

### `frontend/src/components/DirectorPage.tsx`
- Add Audio Intelligence panel displaying:
  - Uploaded audio
  - Audio duration and analysis status
  - Timeline generation status
  - Number of events per track
  - Validation results
  - Approval status
- Workflow stages visualization: Story Input → Audio Summary → 19-Track Timeline → Approval → Director Intelligence
- "Analyze Audio & Build 19-Track Timeline" action button
- "Send Approved Timeline to AI Director" (disabled until approval complete)

### `lib/kids_pipeline.mjs`
- Update `KIDS_PIPELINE_STAGES` to include Audio Intelligence stage between "story" and "song"
- Update `kidsStageStatus` to reflect audio timeline availability
- Update `kidsRunnableStages` to block Director planning without approved timeline

## Phase 3: Database & Persistence

### Existing Tables (Reuse)
- Production table: reuse `phase` field values ("Audio Intelligence", "Director Planning")
- Add metadata columns:
  - `audio_timeline_id` - reference to approved timeline package
  - `audio_timeline_version` - version number
  - `audio_timeline_status` - "generated"|"validated"|"approved"|"failed"
  - `director_input_snapshot_id` - ID of director input contract
  - `director_input_created_at` - timestamp

### Do NOT duplicate
- Do not duplicate the complete 19-track event data into Director tables
- Store references to the approved timeline package only
- Director's derived output must remain additive - must not overwrite original Audio Timeline

## Phase 4: Testing Strategy

### Test Scenarios
1. Hindi devotional song with full 19-track timeline
2. English children's song
3. Hinglish song
4. Instrumental-only music (verify zero lip-sync during instrumental shots - Part 12.3)
5. Song with multiple characters
6. Song with dialogue and narration
7. Song with choreography
8. Story-only production without audio (preserve existing Director workflow)

### Verification Points
- All 19 tracks remain available after integration
- Audio remains the single master clock - no independent scene/shot clocks
- No unauthorized timing changes
- Lip-sync rules enforced (no lip-sync during instrumental shots)
- Character identities reconciled with Story Bible
- Director shots reference their source timeline events
- Existing Director functionality continues to work
- Existing 16-stage production pipeline remains operational

## Phase 5: Migration & Rollback

### Migration Steps
1. Backup existing production data
2. Add new metadata columns to database schema
3. Implement adapter layer first (no database changes initially)
4. Add UI workflow stages progressively
5. Test story-only productions still work
6. Test audio-driven productions with new pipeline
7. Gradual rollout: enable audio timeline stage opt-in via feature flag

### Rollback Strategy
- Feature flag in `.env`: `ENABLE_AUDIO_TIMELINE_INTEGRATION=true|false`
- When disabled, existing Director workflow operates unchanged
- New metadata columns are optional (nullable), so schema can be dropped
- Adapter layer is purely additive - no existing code modified destructively

## Key Constraints (from Spec)

### PART 10 — TIMING AND LIP-SYNC INTEGRITY (Non-negotiable)
- Original audio clock remains authoritative throughout
- No independent scene clock, no independent shot clock
- No arbitrary duration changes
- No unapproved movement of timeline events
- No lip-sync during instrumental shots
- Every visible speaking character must have appropriate lip-sync events
- Preserve word-level timing wherever available

### PART 5 — DIRECTOR INPUT ADAPTER
- Must NOT copy entire original audio into every scene
- Pass references and time ranges only
- Preserve original event IDs and source-track references

### PART 13 — AUTOMATIC REPAIR
- Repair engine must identify defective scenes/shots by their source timeline events
- Must preserve approved character identities
- Must preserve original audio timestamps
- Must preserve unaffected scenes

### PART 17 — EXISTING PRODUCTION PIPELINE
- Preserve all 16 stages: director → story → song → audio → characters → locations → props → storyboard → images → video → voice → assembly → final → assets → QC → feedback
- Adapt dependencies so audio-driven productions cannot execute Director planning without approved timeline
- Do NOT unnecessarily change existing stage names, jobs, dependencies or execution behavior

## Implementation Priority

1. **Week 1**: Create `lib/directorAudioAdapter.mjs` and `lib/directorAudioIntegration.mjs`
   - Implement `buildDirectorAudioContext()` function
   - Extend key Director functions with optional audioContext parameter
   - Maintain full backward compatibility

2. **Week 2**: Modify `frontend/src/api.ts`
   - Add audio timeline upload/validation routes
   - Extend director routes to accept audioContext
   - Minimal UI changes for testing

3. **Week 3**: Modify `frontend/src/components/DirectorPage.tsx`
   - Add Audio Intelligence panel
   - Workflow stage visualization
   - Integration buttons

4. **Week 4**: Update `lib/kids_pipeline.mjs`
   - Add Audio Intelligence stage to pipeline
   - Update stage dependencies and status logic
   - Test both audio-driven and story-only paths

5. **Week 5**: Comprehensive testing
   - All 14 test scenarios from Part 18
   - Backward compatibility verification
   - Performance and timing validation

6. **Week 6**: Finalization
   - Feature flag configuration
   - Documentation updates
   - Rollback verification