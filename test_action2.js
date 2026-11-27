const { buildVideoPromptFor, characterDirectionsOf, normalizeCastEntry } = require('./lib/director.mjs');

// Test 1: characterDirectionsOf with action field
console.log('=== TEST 1: characterDirectionsOf ===');
const shot1 = {
  characters: [{
    character_id: 'shiv',
    name: 'shiv', 
    role: 'main',
    emotion: 'intense focus',
    action: 'pupil expanding with light emission',
    gaze_target: ''
  }],
  camera: { movement: 'Static with slight push-in' }
};
const dir1 = characterDirectionsOf(shot1);
console.log('characterDirectionsOf result:', JSON.stringify(dir1, null, 2));
console.log('Action extracted:', dir1[0]?.action);

// Test 2: Full shot with action in characters_detailed
console.log('\n=== TEST 2: Full shot structure ===');
const shot2 = {
  lyric_segment: 'जब यह नेत्र खुलता है...',
  characters_detailed: [{
    character_id: 'shiv',
    name: 'shiv', 
    role: 'main',
    emotion: 'intense focus',
    action: 'pupil expanding with light emission',
    gaze_target: ''
  }],
  camera: { movement: 'Static with slight push-in' }
};
const dir2 = characterDirectionsOf(shot2);
console.log('characterDirectionsOf result:', JSON.stringify(dir2, null, 2));
console.log('Action extracted:', dir2[0]?.action);

// Test 3: buildVideoPromptFor with full structure
console.log('\n=== TEST 3: buildVideoPromptFor ===');
const board = {
  blueprint: {
    characters: [
      { visual_identity_prompt: 'Test Shiva', name: 'shiv', species: 'human', role: 'main' }
    ]
  }
};

const shot3 = {
  lyric_segment: 'जब यह नेत्र खुलता है...',
  characters_detailed: [{
    character_id: 'shiv',
    name: 'shiv', 
    role: 'main',
    emotion: 'intense focus',
    action: 'pupil expanding with light emission',
    gaze_target: ''
  }],
  camera: { shot_type: 'Extreme Close-Up', angle: 'Direct frontal view', movement: 'Static with slight push-in' }
};
const result = buildVideoPromptFor(shot3, board);
console.log('Video prompt:');
console.log(result);
console.log();

// Verification
const actionText = 'pupil expanding';
console.log('Action in prompt:', result.toLowerCase().includes(actionText.toLowerCase()));
console.log('Camera movement in prompt:', result.toLowerCase().includes('static with slight push-in'.toLowerCase()));