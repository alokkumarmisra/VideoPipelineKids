# Prompt Generation Summary

## Image Prompt (`buildImagePromptFor`)

**Dynamic Processing Pipeline:**
1. VERBATIM character identity paste (from `visual_identity_prompt`)
2. Location identity (from location database or text)
3. Character directions (action, expression, body language, gaze)
4. Environment text
5. Camera framing (shot_type + angle from vocabularies)
6. Style lock (from preset/Custom/masterPrompt)
7. Anatomy lock (species-specific restrictions)
8. Quality lock (enforced server-side: "ultra-detailed 8k uhd...")

**Output Format:** Self-contained image generation prompt
- Starts with verbatim character identity
- Adds location, camera, lighting, environment
- Appends quality lock and anatomy restrictions
- Never paraphrases or shortens character identities

## Video Prompt (`buildVideoPromptFor`)

**Dynamic Processing Pipeline:**
1. Character action descriptions (from `characterDirectionsOf`)
2. Camera movement (critical - must describe motion)
3. Motion fidelity lock (enforced: "Keep the exact character... animate natural motion only")
4. Quality elements (8k uhd, smooth natural motion, stable character/background)

**Output Format:** Motion-only prompt
- Describes starting position → movement → ending position
- Never describes looks, face, clothing, colors, style
- The keyframe image owns all visual details
- Complementary to image_prompt (image=looks, video=motion)

## JSON Fields That Flow In

| Field | Image Prompt | Video Prompt |
|-------|-------------|--------------|
| `lyric_segment` | Context only | Context only |
| `semantic_meaning` | Camera/action rationale | Camera/action rationale |
| `characters` | **VERBATIM paste** | Action references |
| `location` | Setting description | Setting references |
| `action` | Part of character directions | **Core motion description** |
| `emotion` | Character direction | May influence motion |
| `expression` | Character direction | Not included (looks owned by keyframe) |
| `body_language` | Pose/action description | Pose references |
| `camera.shot_type` | Framing | Included but not descriptive of looks |
| `camera.angle` | Framing | Framing references |
| `camera.movement` | Framing | **Critical: "X camera move"** |
| `lighting` | Added to prompt | May be referenced |
| `environment` | Added to prompt | May be referenced |

## Optimization Notes

**For faster scene generation:**
- Provide all JSON fields - reduces default fallback processing
- Use vocabulary terms from `SHOT_TYPES` and `CAMERA_MOVEMENTS`
- Avoid vague action terms ("beautiful", "nice", "good")
- Consistent terminology across scenes reduces re-planning
- Complete data → compact prompts (no context addition needed)

**Your Scene 28 Example:**
- Input JSON has all required fields → prompts generated deterministically
- No missing fields → no fallback processing needed
- Vocabulary terms used → instant normalization
- Result: Both image and video prompts generated in single pass