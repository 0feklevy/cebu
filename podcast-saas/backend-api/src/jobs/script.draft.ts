import { task } from '@trigger.dev/sdk/v3';

export const scriptDraftTask = task({
  id: 'script.draft',
  maxDuration: 180,
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 5000 },
  run: async (payload: { project_id: string; script_id: string }) => {
    throw new Error('NotImplemented: use ScriptPipeline.run() via the SSE stream in Phase 1');
  },
});
