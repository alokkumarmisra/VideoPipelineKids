const { buildVideoPromptFor, characterDirectionsOf } = require('./lib/director.mjs');

// Test: Does character action get COMBINED with camera movement, or kept separate?
const board = {
  blueprint: {
    characters: [
      { visual_identity_prompt: 'Test character', name: 'shiv', species: 'human', role: 'main' }
    ]
  }
};

// Scenario A: Action + Camera movement both present
const shotA = {
  characters_detailed: [{
    character_id: 'shiv',
    name: 'shiv', 
    role: 'main',
    emotion: 'intense focus',
    action: 'raising hands in prayer',  // Character action
    gaze_target: ''
  }],
  camera: { movement: 'slow push-in' }  // Camera movement
};

const resultA = buildVideoPromptFor(shotA, board);
console.log('=== SCENARIO A: Character action + Camera movement ===');
console.log(resultA);
console.log();

// Check if character action appears in the prompt
const hasCharacterAction = resultA.toLowerCase().includes('raising hands'.toLowerCase());
const hasCameraMovement = resultA.toLowerCase().includes('slow push-in'.toLowerCase());

console.log('Character action "raising hands" in prompt:', hasCharacterAction);
console.log('Camera movement "slow push-in" in prompt:', hasCameraMovement);
console.log();

// Scenario B: Only camera movement, no character action
const shotB = {
  characters_detailed: [{
    character_id: 'shiv',
    name: 'shiv', 
    role: 'main',
    emotion: 'calm',
    action: ''  // Empty action
  }],
  camera: { movement: 'pan left' }
};

const resultB = buildVideoPromptFor(shotB, board);
console.log('=== SCENARIO B: Only camera movement ===');
console.log(resultB);
console.log();

// Scenario C: Only character action, no camera movement
const shotC = {
  characters_detailed: [{
    character_id: 'shiv',
    name: 'shiv', 
    role: 'main',
    emotion: 'intense focus',
    action: 'meditating quietly'  // Character action
  }],
  camera: { movement: '' }  // Empty camera movement
};

const resultC = buildVideoPromptFor(shotC, board);
console.log('=== SCENARIO C: Only character action ===');
console.log(resultC);
console.log('Character action in prompt:', resultC.toLowerCase().includes('meditating'.toLowerCase()));