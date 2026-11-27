const { buildVideoPromptFor, buildImagePromptFor } = require('./lib/director.mjs');

// Complex JSON from user
const complexShot = {
  emotion: "Complex mix of emotions (Peace, Fear, Compassion, Power)",
  expression: "Abstract representations of emotions",
  body_language: "Symbolic gestures representing the surge of diverse emotions triggered by the name",
  camera: {
    shot_type: "Montage",
    angle: "Varied angles",
    movement: "Fast-paced editing with subtle camera shakes"
  },
  lighting: "Dynamic lighting shifts from soft blue to dark stormy grey and warm gold",
  environment: "Cosmic stage floating in the sky, surrounded by swirling colors and stars",
  characters: ["shiv"],
  action: "symbolic gestures of emotion",
  lyric_segment: null
};

const board = {
  blueprint: {
    characters: [
      { 
        visual_identity_prompt: 'Lord Shiva, third eye, trishul, snake around neck, ash-covered body, tiger skin, matted hair with Ganga river, glowing crescent moon',
        name: 'shiv', 
        species: ' hindu deity', 
        role: 'divine' 
      }
    ]
  }
};

console.log('=== TEST: Complex JSON fields in image AND video prompts ===');
console.log();

// Image Prompt
console.log('--- IMAGE PROMPT ---');
const imagePrompt = buildImagePromptFor(complexShot, board);
console.log(imagePrompt);
console.log();

// Check which complex fields appear in image prompt
const imageFields = {
  emotion: imagePrompt.toLowerCase().includes('complex mix of emotions'.toLowerCase()) || imagePrompt.toLowerCase().includes('peace'.toLowerCase()) || imagePrompt.toLowerCase().includes('fear'.toLowerCase()) || imagePrompt.toLowerCase().includes('compassion'.toLowerCase()) || imagePrompt.toLowerCase().includes('power'.toLowerCase()),
  expression: imagePrompt.toLowerCase().includes('abstract representations'.toLowerCase()) || imagePrompt.toLowerCase().includes('emotions'.toLowerCase()),
  body_language: imagePrompt.toLowerCase().includes('symbolic gestures'.toLowerCase()) || imagePrompt.toLowerCase().includes('surge of diverse'.toLowerCase()),
  lighting: imagePrompt.toLowerCase().includes('dynamic lighting'.toLowerCase()) || imagePrompt.toLowerCase().includes('soft blue'.toLowerCase()) || imagePrompt.toLowerCase().includes('stormy grey'.toLowerCase()) || imagePrompt.toLowerCase().includes('warm gold'.toLowerCase()),
  environment: imagePrompt.toLowerCase().includes('cosmic stage'.toLowerCase()) || imagePrompt.toLowerCase().includes('swirling colors'.toLowerCase()) || imagePrompt.toLowerCase().includes('stars'.toLowerCase())
};

console.log('IMAGE PROMPT FIELD CHECK:');
console.log('  Emotion:', imageFields.emotion);
console.log('  Expression:', imageFields.expression);
console.log('  Body language:', imageFields.body_language);
console.log('  Lighting:', imageFields.lighting);
console.log('  Environment:', imageFields.environment);
console.log();

// Video Prompt
console.log('--- VIDEO PROMPT ---');
const videoPrompt = buildVideoPromptFor(complexShot, board);
console.log(videoPrompt);
console.log();

// Check which complex fields appear in video prompt
const videoFields = {
  emotion: videoPrompt.toLowerCase().includes('complex mix of emotions'.toLowerCase()) || videoPrompt.toLowerCase().includes('peace'.toLowerCase()) || videoPrompt.toLowerCase().includes('fear'.toLowerCase()) || videoPrompt.toLowerCase().includes('compassion'.toLowerCase()) || videoPrompt.toLowerCase().includes('power'.toLowerCase()),
  expression: videoPrompt.toLowerCase().includes('abstract representations'.toLowerCase()) || videoPrompt.toLowerCase().includes('emotions'.toLowerCase()),
  body_language: videoPrompt.toLowerCase().includes('symbolic gestures'.toLowerCase()) || videoPrompt.toLowerCase().includes('surge of diverse'.toLowerCase()),
  lighting: videoPrompt.toLowerCase().includes('dynamic lighting'.toLowerCase()) || videoPrompt.toLowerCase().includes('soft blue'.toLowerCase()) || videoPrompt.toLowerCase().includes('stormy grey'.toLowerCase()) || videoPrompt.toLowerCase().includes('warm gold'.toLowerCase()),
  environment: videoPrompt.toLowerCase().includes('cosmic stage'.toLowerCase()) || videoPrompt.toLowerCase().includes('swirling colors'.toLowerCase()) || videoPrompt.toLowerCase().includes('stars'.toLowerCase()),
  camera_movement: videoPrompt.toLowerCase().includes('fast-paced editing'.toLowerCase()) || videoPrompt.toLowerCase().includes('camera shakes'.toLowerCase())
};

console.log('VIDEO PROMPT FIELD CHECK:');
console.log('  Emotion:', videoFields.emotion);
console.log('  Expression:', videoFields.expression);
console.log('  Body language:', videoFields.body_language);
console.log('  Lighting:', videoFields.lighting);
console.log('  Environment:', videoFields.environment);
console.log('  Camera movement:', videoFields.camera_movement);
console.log();

// Summary
console.log('=== SUMMARY ===');
console.log('Image prompt includes all complex fields:', Object.values(imageFields).every(v => v));
console.log('Video prompt includes all complex fields:', Object.values(videoFields).every(v => v));