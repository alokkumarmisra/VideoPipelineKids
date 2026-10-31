# Implementation Plan: Sanskriti AI Studio — Rename Story to Story/Song + WhisperX Timeline Import

## Overview

This implementation renames the existing "Story" workspace to "Story/Song" and adds complete WhisperX Timeline Import and Lyric-Action Synchronization features. Both Story Video and Song Video workflows share the same audio timeline, action planning, scene generation, validation, and rendering infrastructure.

## Key Objectives

1. **Rename** the Story navigation item to "Story/Song"
2. **Add** a workflow selector for "Story Video" and "Song Video"
3. **Implement** WhisperX JSON import with validation
4. **Preserve** original user lyrics (WhisperX is timing-only)
5. **Create** canonical audio timeline with vocal/instrumental/unknown segments
6. **Integrate** existing Story Director and Song Director against the timeline
7. **Add** timeline review/editing panel
8. **Ensure** both modes share the same infrastructure

## Architecture

### Shared Infrastructure (already exists)

- **`lib/semantics.mjs`**: Pure semantic engine — language detection, action extraction, entity extraction, camera planning, beat timing, validation, repair
- **`lib/director.mjs`**: Intelligent Director — phrase extraction, scene planning, schema, board-to-scenario mapping
- **`frontend/server.mjs`**: Backend API — director boards, WhisperX analysis, master timeline, lyric corrections
- **`frontend/src/api.ts`**: Frontend API clients — `importWhisperTimeline`, `directorMasterTimeline`, `saveLyricCorrections`, etc.
- **`frontend/src/components/StoryPage.tsx`**: Story page with lyric timeline tab (already has WhisperX import UI)

### New/Modified Components

1. **`frontend/src/components/DirectorPage.tsx`**: Rename "Story" to "Story/Song", add workflow selector
2. **`frontend/src/components/StoryPage.tsx`**: Add "Song" tab, enhance timeline review, share timeline state
3. **`frontend/src/api.ts`**: Add/route Song-related API endpoints (shared with Story)
4. **`lib/semantics.mjs`**: Ensure all lyric timeline functions handle both modes
5. **`lib/master_timeline.mjs`**: Master timeline building + clip generation shared between modes

## Implementation Sections

### 1. Rename Story to Story/Song

- Update navigation label in `App.tsx` sidebar/ breadcrumbs
- Update `DirectorPage.tsx` page title and headings
- Update `StoryPage.tsx` page title from "Story" to "Story/Song"
- Update breadcrumbs and empty states
- Add workflow selector: "Story Video" / "Song Video" tabs

### 2. WhisperX Timeline Import

The existing `StoryPage.tsx` already has WhisperX import functionality. Need to ensure:

- Accept WhisperX JSON with fields: `segments[].start`, `segments[].end`, `segments[].text`, `segments[].words[].word`, `segments[].words[].start`, `segments[].words[].end`, `segments[].words[].score`
- Validate file structure, timestamps, audio duration, word ordering
- Support segment-only timestamps (word-level alignment unavailable clearly indicated)
- Preserve original imported file, associate with project and audio asset
- Store media on disk, metadata in PostgreSQL

### 3. Preserve Original Lyrics

- User's lyric text is always authoritative
- WhisperX transcript kept in `heard_text` for review, never replaces user text
- Support Hindi Unicode text and normalization
- Support repeated lyric occurrences separately
- Display recognized text alongside corrected text
- Retain original timestamps when only text is corrected
- Support re-alignment when corrected lyrics need new timestamps
- Flag low-confidence, unmatched, missing, out-of-order words
- Distinguish measured, manually corrected, and estimated data

### 4. Canonical Audio Timeline

- **AudioSegment**: start/end seconds, type (vocal, instrumental, mixed, unknown), source and confidence
- **LyricWord**: recognized text, corrected text, start/end times, confidence, alignment status
- **LyricPhrase**: phrase text, start/end times, associated word IDs, section type
- **ActionTimelineItem**: action ID, timing, related lyric phrase, character/location/prop references, action description, camera direction, lip-sync requirement, timing source
- **SceneClip**: clip start/end times, associated action IDs, prompt, generation status, generated asset reference

All timestamps use seconds from the beginning of the original audio. The measured audio timeline is authoritative — the LLM must not rewrite measured timestamps.

### 5. Song Director Integration

For each aligned phrase:
- Determine which character acts or sings
- What the character does
- Which location and props are used
- Whether mouth movement or lip-sync is required
- Which camera movement and framing are appropriate
- Whether the action continues from the previous clip

The director must respect the original lyric order and timestamps. Instrumental sections receive appropriate visual actions without triggering future lyric-specific actions.

### 6. Story Director Update

Story events follow the narrative while respecting the audio timeline. The story may continue across multiple lyric phrases — not every lyric forces a new scene. Maintain character identity, locations, props, visual style, narrative continuity, and genre-specific rules.

### 7. Timeline-Aware Scene and Clip Generation

For each clip:
1. Establish exact start and end time
2. Retrieve actions overlapping that interval
3. Convert absolute timestamps to clip-relative timestamps
4. Include relevant lyrics, characters, locations, props, and visual style
5. Specify action order and prevent premature actions
6. Preserve continuity from preceding scenes
7. Exclude actions occurring entirely outside the clip

Example: If clip starts at 9.0s and lyric begins at 10.1s, lyric-related action begins ~1.1s after clip starts.

Prefer one dominant action per clip. Generated clip durations conform to assigned timeline before final rendering.

### 8. Instrumental and Unknown Sections

- Allow establishing shots, entrances, dancing, reactions, transitions during instrumental sections
- Do not stretch earlier lyric across long gaps
- Do not assume every region without aligned lyrics is instrumental — mark as unknown until established
- Preserve intentional gaps and overlapping vocals

### 9. Timeline Review Panel

Display within the Story/Song workspace:
- Original audio duration and playback position
- Vocal, instrumental, mixed, and unknown intervals
- Corrected lyric phrases and word timestamps
- Character action intervals
- Scene clip boundaries
- Confidence values and validation warnings
- Timing provenance: audio-aligned, manually corrected, or estimated

Allows users to:
- Correct lyric text and timing
- Review proposed actions
- Approve the timeline
- Regenerate dependent prompts without rerunning unrelated stages

### 10. Validation and Background Processing

Before video generation, validate:
- Timestamp ranges and audio boundaries
- Word and phrase ordering
- Repeated lyric occurrences
- Action-to-lyric relationships
- Character and asset references
- Clip durations and timeline coverage
- Unresolved low-confidence alignment

Run audio analysis, alignment, and generation as background jobs using existing job infrastructure. Provide progress, error reporting, retry, and cancellation. Cache alignment results using audio hash, lyric content, and model/configuration version.

### 11. Testing

Add tests for:
- Instrumental intro followed by lyrics
- Long gaps between vocal segments
- Repeated choruses
- Hindi recognition errors
- Low-confidence words
- Missing word-level timestamps
- Lyrics crossing clip boundaries
- Manual corrections and re-alignment
- Instrumental and unknown regions
- Final audio/video duration consistency
- Existing Story workflows continuing to work after the rename

Use deterministic fixtures with known timestamps and at least one manually verified real-song test.

## Files to Create/Modify

### Created:
- `frontend/src/components/StorySongPage.tsx` — New Story/Song page combining Story and Song workflows
- `lib/master_timeline.mjs` — Enhanced master timeline (if needed)
- `tests/story_song.test.mjs` — Tests for the new feature

### Modified:
- `frontend/src/App.tsx` — Update navigation label, add Story/Song badge
- `frontend/src/components/DirectorPage.tsx` — Rename "Story" to "Story/Song", add workflow selector
- `frontend/src/components/StoryPage.tsx` — Add Song tab, enhance timeline review, share state
- `frontend/src/api.ts` — Ensure all WhisperX/timeline routes work for both modes
- `tests/lyric_timeline.test.mjs` — Ensure all existing tests pass
- `tests/lyric_timeline_server.test.mjs` — Server tests for WhisperX import

## Database Changes

The existing database schema already supports:
- `director_boards.lyric_timeline` — stored WhisperX timeline
- `director_boards.master` — approved master timeline
- `scenarios.config` — project config with project_type
- `project_songs` — song form data (already exists for Create Song tab)

No new database tables or migrations are needed unless adding new columns. The existing infrastructure is sufficient.

## UI Changes

1. **Sidebar/Navigation**: "Story/Song" label replacing "Story"
2. **Workspace Page Title**: "Story/Song Studio" 
3. **Breadcrumbs**: Story/Song path
4. **Page Headings**: "Story/Song Studio" 
5. **Empty States**: Support both Story and Song empty states
6. **Workflow Tabs**: "Story Video" / "Song Video" selector
7. **Lyric Timeline Panel**: Enhanced review/editing
8. **Master Timeline Panel**: Same panel serves both modes
9. **Audio Player**: Same player for both modes
10. **Progress/Status**: Shared across both modes

## API Changes

Existing routes already support the feature:
- `POST /api/whisperx/preflight` — WhisperX preflight check
- `POST /api/director/boards` — Create board (supports song mode)
- `GET/PUT /api/director/boards/:id/timeline` — Audio timeline
- `POST /api/director/boards/:id/analyze-story` / `.../analyze-song` — Analyze
- `GET /api/director/boards/:id/master` — Master timeline
- `POST /api/director/boards/:id/approve-master` — Approve timeline
- `POST /api/director/boards/:id/unlock-master` — Unlock timeline
- `POST /api/director/boards/:id/generate-master-clips` — Generate clips
- `GET /api/project/:name/song` — Song form data
- `GET /api/project/:name/dialogue` — Dialogue status

No new API routes needed — existing routes serve both modes.

## Migration Strategy

- Existing "Story" projects remain accessible and functional
- When a user opens an existing Story project in the new Story/Song workspace, it defaults to "Story Video" mode
- New projects can choose "Story Video" or "Song Video" at creation
- All stored data (boards, scenes, timelines) carries a `project_type` or can be inferred
- No data migration needed — the same board JSON works for both modes

## Definition of Done

- [ ] The existing Story workspace is displayed as "Story/Song"
- [ ] Both Story Video and Song Video workflows remain accessible
- [ ] WhisperX JSON imports and validates successfully
- [ ] Original lyrics are preserved (never overwritten by transcript)
- [ ] The approved master timeline drives action planning and clip generation
- [ ] Instrumental sections do not trigger future lyric actions
- [ ] Clip-local prompts respect the master timeline
- [ ] The user can review and correct uncertain alignments
- [ ] Existing project, asset, scene, batch, and rendering workflows continue to work
- [ ] Database migrations and automated tests pass
- [ ] Documentation updated according to project conventions