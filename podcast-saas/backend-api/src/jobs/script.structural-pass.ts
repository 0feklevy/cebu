import { task } from '@trigger.dev/sdk/v3';

// Structural analysis pass is orchestrated within ScriptPipeline.run(),
// which is driven inline by the SSE stream for Phase 1.
// This task stub exists for Phase 2 independent retry/retry support.
export const scriptStructuralPassTask = task({
  id: 'script.structural_pass',
  maxDuration: 120,
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 5000 },
  run: async (payload: { project_id: string; script_id: string }) => {
    throw new Error('NotImplemented: use ScriptPipeline.run() via the SSE stream in Phase 1');
  },
});
