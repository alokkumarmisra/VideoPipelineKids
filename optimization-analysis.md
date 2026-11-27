# Image Prompt & Video Prompt Dynamic Generation Analysis

Based on the codebase analysis, here's exactly how `image_prompt` and `video_prompt` are generated from JSON scene data:

## 1. Source JSON Structure (from LLM output / board data)

Each scene/shot contains these dynamic fields that flow into prompt generation:

```json
{
  "shot_id": "28-A",
  "shot_number": 1,
  "lyric_segment": "जब यह नेत्र खुलता है...",          // The exact words/segment this shot visualizes
  "semantic_meaning": "The moment the eye opens.",     // What the segment really means
  "characters": ["shiv"],                              // Character ids (exact IDs only)
  "location": "kailash",                               // Location id (exact ID only)
  "action": "तीसरी आंख की पुतली का विस्तार और उसके अंदर से निकलने वाली तेज रोशनी (Intense light beam).",  // ONE visible action on screen
  "emotion": "intense focus, power",                   // Delivery feeling
  "expression": "गहरी गंभीरता (Deep seriousness)",    // Face while speaking
  "body_language": "मनोनिर्भर ध्यान (Meditative concentration).",  // Body posture
  "camera": {
    "shot_type": "Extreme Close-Up",                   // From SHOT_TYPES vocabulary
    "angle": "Direct frontal view",                    // e.g., Eye Level, Low Angle
    "movement": "Static with slight push-in"          // From CAMERA_MOVEMENTS vocabulary
  },
  "lighting": "तेज सुनहरा और लाल (Intense golden and red)",  // Lighting description
  "environment": "अंधेरा पृष्ठभूमि के साथ (Dark background)",  // Environment setting
  "dialogue": [],                                      // Optional dialogue lines
  "image_prompt": "",                                  // Will be GENERATED dynamically
  "video_prompt": ""                                   // Will be GENERATED dynamically
}
```

## 2. Image Prompt Generation Flow (`buildImagePromptFor` in `lib/director.mjs`)

**Step-by-step dynamic processing:**

```
INPUT JSON Fields → PROMPT BUILDER → FINAL IMAGE PROMPT
```

### Processing Pipeline:

1. **Base image_prompt** (if provided in JSON):
   ```javascript
   const base = str(x.image_prompt).trim();
   if (base) bits.push(base);
   ```

2. **Character identity (VERBATIM paste)**:
   ```javascript
   for (const cid of castIdsOf(x.characters)) {
     const c = chars.get(cid) || chars.get(slugId(cid));
     const ident = c ? str(c.visual_identity_prompt) || str(c.name) : cid;
     if (ident && !bits.join(" ").toLowerCase().includes(ident.slice(0, 24).toLowerCase())) bits.push(ident);
   }
   ```
   → **Pastes the character's `visual_identity_prompt` VERBATIM** (mandatory per spec)

3. **Character directions** (pose, action, expression, gaze):
   ```javascript
   const dir = characterDirectionsOf(x);
   const pose = dir.map((c) => [c.starting_state, c.action, c.expression, c.gaze_target ? `gazing at ${c.gaze_target}` : ""]).filter(Boolean);
   if (pose.length) bits.push(pose.join(" | "));
   ```

4. **Location**:
   ```javascript
   if (x.location) {
     const l = locs.get(slugId(x.location)) || locs.get(idStr(x.location));
     bits.push(str((l && l.visual_identity_prompt)) || str(x.location));
   }
   ```

5. **Continuity references** (objects from earlier shots):
   ```javascript
   for (const ref of arr(x.continuity_refs)) {
     const o = objs.get(slugId(ref)) || objs.get(idStr(ref));
     if (o && str(o.visual_identity_prompt)) bits.push(str(o.visual_identity_prompt));
   }
   ```

6. **Environment**:
   ```javascript
   if (x.environment) bits.push(str(x.environment));
   ```

7. **Camera framing**:
   ```javascript
   const cam = x.camera && typeof x.camera === "object" ? x.camera : {};
   const framing = [cam.shot_type, cam.angle].filter(Boolean).join(", ");
   if (framing) bits.push(framing);
   ```

8. **Style lock** (from preset/Custom/masterPrompt):
   ```javascript
   const lock = styleLockFor(...);
   if (lock && !bits.join(" ").toLowerCase().includes(lock.slice(0, 24).toLowerCase())) bits.push(lock);
   ```

9. **Anatomy lock** (species-specific restrictions):
   ```javascript
   return withQualityLock(withAnatomyLock(bits.filter(Boolean).join(", "), [...new Set(chars.values())]));
   ```

### **Final Format Example** (from your data):
```
Full body portrait of Lord Shiva, human male form with broad chest and powerful arms, standing upright in a meditative yoga pose. Skin is pale ash-gray covered entirely in thick white sacred ash (Vibhuti). He wears a tiger skin shawl draped loosely over his torso and waist. On his forehead is a glowing crescent moon. Thick matted hair (Jata) flows down, with the river Ganga flowing visibly within it. A large serpent (Vasuki) coils around his neck. Third eye on forehead closed but glowing faintly red. Expression is serene yet powerful. Ultra photorealistic Indian mythological cinematic film still, highly detailed 8k uhd, divine glowing palette, lifelike faces with natural skin texture and detailed expressive eyes, ornate traditional costumes and jewelry with intricate fabric detail, volumetric temple lighting, sharp focus, epic realistic backgrounds, no cartoon, no painting, no illustration, no blur. Extreme Close-Up Direct frontal view, glowing golden and blue, snow-capped peaks, lost in mist
```

## 3. Video Prompt Generation Flow (`buildVideoPromptFor` in `lib/director.mjs`)

**Step-by-step dynamic processing:**

```
INPUT JSON Fields → PROMPT BUILDER → FINAL VIDEO PROMPT
```

### Processing Pipeline:

1. **Base video_prompt** (if provided in JSON):
   ```javascript
   const base = str(x.video_prompt).trim();
   if (base) bits.push(base);
   ```

2. **Character actions** (from character directions):
   ```javascript
   for (const c of characterDirectionsOf(x)) {
     if (c.action && !bits.join(" ").toLowerCase().includes(c.action.slice(0, 20).toLowerCase())) bits.push(c.action);
     if (c.gaze_target && !bits.join(" ").toLowerCase().includes(`look at ${c.gaze_target}`.slice(0, 24).toLowerCase())) bits.push(`turns to look at ${c.gaze_target}`);
   }
   ```

3. **Camera movement** (MOTION focus - CRITICAL):
   ```javascript
   const cam = x.camera && typeof x.camera === "object" ? x.camera : {};
   if (cam.movement && !/^(static|locked)$/i.test(str(cam.movement)) && !bits.join(" ").toLowerCase().includes(str(cam.movement).slice(0, 12).toLowerCase())) {
     bits.push(`${str(cam.movement)} camera move`);
   }
   ```

4. **Join all motion bits**:
   ```javascript
   const t = bits.filter(Boolean).join(", ");
   if (!t) return MOTION_FIDELITY_LOCK;  // Fallback lock
   return t.toLowerCase().includes(motionKeyFor().toLowerCase()) ? t : `${t}, ${MOTION_FIDELITY_LOCK}`;
   ```

### **Final Format Example** (from your data):
```
Third eye slit widens into a glowing fiery orb of light. Intense golden and red light beams radiate outward from the eye. Highly clear 8k uhd quality with smooth natural motion and a stable character/background — never distorted, morphed, flickering or redesigned.
```

**CRITICAL RULE**: Video prompts must describe MOTION ONLY — never looks, face, clothing, colors or style. The keyframe image owns those details.

## 4. Key Directives from the Spec

### Image Prompt Rules (§252-254):
- ✅ **SELF-CONTAINED**: every image_prompt is self-contained scene context
- ✅ **VERBATIM IDENTITIES**: paste visual_identity_prompt word-for-word, never paraphrase
- ✅ **Action + Camera around identity**: action/pose/camera go AROUND the pasted identity, never inside it
- ✅ **Quality lock**: ultra-detailed 8k uhd, highly clear, sharp focus (enforced server-side)
- ✅ **Anatomy safety**: limbless characters never get limbs, etc.

### Video Prompt Rules (§256-260):
- ✅ **MOTION ONLY**: describe starting position, movement, camera move, ending position
- ✅ **NEVER restate looks**: the keyframe owns character, face, clothing, colors, style
- ✅ **Complementary to image_prompt**: image = looks, video = motion
- ✅ **Quality lock**: highly clear 8k uhd quality, smooth natural motion, stable character/background
- ✅ **Never describe**: distorted, morphed, flickering or redesigned

## 5. Optimization Impact

### For Faster Generation:

1. **Provide complete JSON fields**: Scenes with all fields (`lyric_segment`, `semantic_meaning`, `location`, `action`, `emotion`, `camera.shot_type`, `camera.angle`, `camera.movement`, `lighting`, `environment`) generate prompts faster because the builder doesn't need to add defaults or fallbacks.

2. **Use vocabulary terms**: When `camera.shot_type` uses terms from `SHOT_TYPES` vocabulary and `camera.movement` uses terms from `CAMERA_MOVEMENTS`, normalization is instant and deterministic.

3. **Avoid vague terms**: Terms like "beautiful", "nice", "good" are flagged and may trigger re-planning (see `isVagueActionText`).

4. **Consistent terminology**: Using consistent camera language across scenes reduces validation errors and re-planning.

5. **Complete data = compact prompts**: When the JSON already has well-structured data, the prompt builders can produce concise prompts without needing to add extensive context.

## 6. Example: Your Scene 28 Data Flow

**Input JSON:**
```json
{
  "lyric_segment": "जब यह नेत्र खुलता है...",
  "semantic_meaning": "The moment the eye opens.",
  "characters": ["shiv"],
  "location": "kailash",
  "action": "तीसरी आंख की पुतली का विस्तार और उसके अंदर से निकलने वाली तेज रोशनी (Intense light beam).",
  "emotion": "intense focus, power",
  "expression": "गहरी गंभीरता (Deep seriousness)",
  "body_language": "मनोनिर्भर ध्यान (Meditative concentration).",
  "camera": {
    "shot_type": "Extreme Close-Up",
    "angle": "Direct frontal view",
    "movement": "Static with slight push-in"
  },
  "lighting": "तेज सुनहरा और लाल (Intense golden and red)",
  "environment": "अंधेरा पृष्ठभूमि के साथ (Dark background)"
}
```

**Generated Image Prompt** (dynamic processing):
- Starts with character's `visual_identity_prompt` (Lord Shiva description)
- Adds location: "kailash" / "Snow-capped peaks, lost in mist"
- Adds camera: "Extreme Close-Up Direct frontal view"
- Adds lighting: "Intense golden and red"
- Adds quality lock + anatomy lock
- **Result**: Full, detailed image prompt for Flux T2I

**Generated Video Prompt** (dynamic processing):
- Starts with action: "Intense light beam"
- Adds camera movement: "Static with slight push-in camera move"
- Adds motion fidelity lock
- **Result**: Motion-only prompt for LTX-I2V

---
*Generated from: lib/director.mjs buildImagePromptFor() and buildVideoPromptFor() functions*