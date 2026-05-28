import { task } from '@trigger.dev/sdk/v3';

export const scriptValidateTask = task({
  id: 'script.validate',
  maxDuration: 30,
  run: async (payload: { project_id: string; script_id: string }) => {
    throw new Error('NotImplemented: validation runs inline in ScriptPipeline.run() in Phase 1');
  },
});
