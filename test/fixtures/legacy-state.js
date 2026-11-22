// Saved state in the shapes the app wrote BEFORE batch 1 (the retired
// "Fast concept" / "From reference image" presets). Used by the migration
// tests: everything here must still load and work, and the files must not be
// rewritten by reading them.
export const T0 = Date.UTC(2026, 10, 20, 18, 0, 0);

export const oldHistory = () => ({
  version: 1,
  sessions: [{ id: 's_old00001', startedAt: T0, lastAt: T0 + 120000 }],
  entries: [
    {
      id: 'h_oldfast0001', sessionId: 's_old00001', createdAt: T0, promptId: 'p-old-1', workflow: 'fast-concept',
      prompt: 'a brass airship over a canyon', seed: 4242, width: 832, height: 1248, steps: 4,
      images: [{ filename: 'concept_00001_.png', subfolder: 'concept-app', type: 'output' }], favorite: true, status: 'done',
    },
    {
      id: 'h_oldref00001', sessionId: 's_old00001', createdAt: T0 + 60000, promptId: 'p-old-2', workflow: 'from-reference-image',
      prompt: 'same castle, winter', seed: 77, width: 1024, height: 1024, strength: 0.6, reference: { 10: 'old-ref.png' },
      images: [{ filename: 'reference_00001_.png', subfolder: 'concept-app', type: 'output' }], favorite: false, status: 'done',
    },
    {
      id: 'h_oldup000001', sessionId: 's_old00001', createdAt: T0 + 120000, promptId: 'p-old-3', workflow: 'action:upscale',
      prompt: 'a brass airship over a canyon', action: 'upscale', params: { scale: 2 }, parent: { historyId: 'h_oldfast0001' },
      images: [{ filename: 'upscale_00001_.png', subfolder: 'concept-app', type: 'output' }], favorite: false, status: 'done',
    },
  ],
});

export const oldChats = () => ({
  version: 1,
  chats: [{
    id: 'c_oldchat01', title: 'airship', model: 'gemma3:4b', createdAt: T0, updatedAt: T0 + 5000,
    messages: [
      { role: 'user', content: 'it looks like a balloon, make it an airship [attached: img1]', at: T0 + 1000,
        images: [{ ref: 'img1', filename: 'concept_00001_.png', subfolder: 'concept-app', type: 'output', prompt: 'a brass airship over a canyon', seed: 4242, preset: 'fast-concept', historyId: 'h_oldfast0001' }] },
      { role: 'assistant', content: 'Made the hull rigid and added propellers.', at: T0 + 2000, prompt: 'a rigid brass airship with propellers over a canyon', basePrompt: 'a brass airship over a canyon', applied: true },
    ],
  }],
});

// localStorage from the old app: the preset choice, the panel (old aspect name,
// steps keyed by the old preset id), the open chat thread.
export const oldLocalStorage = (preset = 'from-reference-image') => ({
  preset,
  'conceptPanel.v1': JSON.stringify({ prompt: 'same castle, winter', negative: '', negOn: false, batch: 2, aspect: 'portrait', seedMode: 'random', seed: 0, strength: 0.6, steps: { 'fast-concept': 4 }, expose: {} }),
  'conceptChat.id': 'c_oldchat01',
});
