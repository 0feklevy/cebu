import { db } from '../src/db/index.js';
import { token_usage } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

const pricing: Record<string, { input: number; output: number; cached: number }> = {
  'claude-haiku-4-5':  { input: 0.00008,   output: 0.0004,   cached: 0.000008  },
  'claude-sonnet-4-5': { input: 0.0003,     output: 0.0015,   cached: 0.00003   },
  'claude-opus-4-7':   { input: 0.0015,     output: 0.0075,   cached: 0.00015   },
  'gpt-4o':            { input: 0.00025,    output: 0.001,    cached: 0.0000125 },
  'gpt-4o-mini':       { input: 0.000015,   output: 0.00006,  cached: 0.0000075 },
  'gemini-2.5-pro':    { input: 0.000125,   output: 0.0005,   cached: 0.0000313 },
  'gemini-2.5-flash':  { input: 0.0000375,  output: 0.00015,  cached: 0.0000094 },
  'gemini-2.0-flash':  { input: 0.00001,    output: 0.00004,  cached: 0.0000025 },
  'gemini-1.5-flash':  { input: 0.0000075,  output: 0.00003,  cached: 0.0000019 },
};

const rows = await db.query.token_usage.findMany();
let updated = 0;

for (const row of rows) {
  const p = pricing[row.model] ?? { input: 0.0001, output: 0.0001, cached: 0.00001 };
  const nonCached = row.input_tokens - row.cached_input_tokens;
  const correctCents = Math.round(
    nonCached * p.input + row.cached_input_tokens * p.cached + row.output_tokens * p.output,
  );
  if (correctCents !== row.cost_cents) {
    await db.update(token_usage).set({ cost_cents: correctCents }).where(eq(token_usage.id, row.id));
    updated++;
  }
}

console.log(`Fixed ${updated} / ${rows.length} rows`);
process.exit(0);
