const { buildVideoPromptFor } = require('./lib/director.mjs');

const board = {
  blueprint: {
    characters: [
      { 
        visual_identity_prompt: 'Test Shiva figure', 
        name: 'shiv', 
        species: 'human', 
        role: 'main' 
      }
    ]
  }
};

const shot = {
  lyric_segment: 'जब यह नेत्र खुलता है...',
  characters: ['shiv'], 
  location: 'kailash',
  action: 'तीसरी आंख की पुतली का विस्तार और उसके अंदर से निकलने वाली तेज रोशनी (Intense light beam).',
  emotion: 'intense focus, power',
  camera: { shot_type: 'Extreme Close-Up', angle: 'Direct frontal view', movement: 'Static with slight push-in' }
};

console.log('=== USER DATA SCENARIO ===');
const result = buildVideoPromptFor(shot, board);
console.log(result);
console.log();

// Verification
const actionText = 'Intense light beam';
const cameraMovementText = 'Static with slight push-in';

console.log('=== VERIFICATION ===');
console.log('Action text in prompt:', result.toLowerCase().includes(actionText.toLowerCase()));
console.log('Camera movement in prompt:', result.toLowerCase().includes(cameraMovementText.toLowerCase()));
console.log('Motion fidelity lock:', result.includes('Keep the exact character'));
console.log('Is dynamic:', !result.toLowerCase().includes('hardcoded') && !result.toLowerCase().includes('hindi') && !result.toLowerCase().includes('sanskriti'));