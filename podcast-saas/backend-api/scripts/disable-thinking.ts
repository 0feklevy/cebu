import { db } from '../src/db/index.js';
import { admin_settings } from '../src/db/schema.js';

const [row] = await db
  .update(admin_settings)
  .set({ extended_thinking_enabled: false })
  .returning({ id: admin_settings.id, extended_thinking_enabled: admin_settings.extended_thinking_enabled });

console.log('Updated settings:', row);
process.exit(0);
