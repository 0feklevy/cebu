// Central model configuration for the avatar visual engine (ported from
// darwin-avatar/server/config/models.ts). Change a model once here.
export const MODELS = {
  // Visual engine (real-time chat)
  visualClassify:        'gpt-4.1-mini',
  simulationCode:        'gpt-4.1',
  simulationCodeCheaper: 'gpt-4.1-mini',

  // Image pipeline
  imageClassify:   'gpt-4.1-mini',
  imageGeneration: 'gpt-image-1',

  // Admin / library tools
  adminPromptBuilder: 'gpt-4.1-mini',
  simulationEdit:     'gpt-4.1',

  // Memory
  memoryCompact: 'gpt-4.1-nano',
} as const;

export type ModelKey = keyof typeof MODELS;
