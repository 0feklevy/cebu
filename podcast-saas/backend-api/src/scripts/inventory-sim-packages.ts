/**
 * Verified inventory of every stored simulation package — the pre-flight for a bridge rebuild.
 *
 * Deliberately reads the ACTUAL STORED BYTES, never only the database row: the whole point of a
 * migration inventory is to catch the cases where metadata and storage disagree (a row marked
 * ready whose files 404, an entry HTML whose bridge tag points at a hash that is not there).
 *
 *   tsx --env-file=../.env src/scripts/inventory-sim-packages.ts [--json <out.json>]
 *
 * Reports per package: identity, storage keys, hashes/sizes, bridge version + capabilities,
 * every @@SIM_BRIDGE:<sectionId>@@ body (hashed, never dumped), the timeline sections that use
 * the package, and the feature flags a rebuild must preserve (Minimal UI, automation, guidance,
 * multiple variations). Read-only: it writes nothing to storage or the database.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { db } from '../db/index.js';
import { simulations, timeline_sections } from '../db/schema.js';
import { getStorageAdapter } from '../services/storage/getStorageAdapter.js';
import {
  deriveEntryRelPath,
  parseSectionEntries,
} from '../services/simulation/SimulationService.js';

const sha = (s: string | Buffer): string =>
  createHash('sha256').update(typeof s === 'string' ? Buffer.from(s, 'utf-8') : s).digest('hex').slice(0, 16);

export interface SectionBodyInfo {
  sectionId: string;
  bytes: number;
  sha256_16: string;
  /** Normalised (trailing whitespace stripped) — what a rebuild round-trip must preserve. */
  normalisedSha: string;
}

export interface TimelineUse {
  sectionRowId: string;
  projectId: string;
  label: string | null;
  simulationUrl: string | null;
  /** The ?section= identity the player dispatches on. null = malformed/legacy row. */
  urlSectionKey: string | null;
  simScript: string | null;
  simpleUi: boolean;
  autoScript: boolean;
  hideSelectorCount: number;
  hasGuidance: boolean;
}

export interface PackageInventory {
  simulationId: string;
  projectId: string | null;
  name: string;
  status: string;
  entryFile: string | null;
  storagePrefix: string;
  entryKey: string;
  bridgeKey: string;
  files: {
    entry: { present: boolean; bytes: number; sha256_16: string | null; source: string };
    bridge: { present: boolean; bytes: number; sha256_16: string | null; source: string };
    guidance: { key: string; present: boolean; bytes: number; sha256_16: string | null }[];
  };
  bridge: {
    version: string | null;
    combined: boolean;
    ackCapable: boolean;
    hasScriptMissing: boolean;
    hasPauseScript: boolean;
    hasDemoTimer: boolean;
    sectionCount: number;
    sections: SectionBodyInfo[];
  };
  entry: {
    rafGateVersion: number | null;
    bridgeTagHash: string | null;
    hasBootSnippet: boolean;
  };
  timeline: TimelineUse[];
  features: {
    usesMinimalUi: boolean;
    usesAutomation: boolean;
    usesGuidance: boolean;
    multipleVariations: boolean;
  };
  problems: string[];
}

/** Read a stored object, falling back to the public serving path (mirrors the rebuild tool). */
async function readStored(
  storage: ReturnType<typeof getStorageAdapter>,
  key: string,
): Promise<{ buf: Buffer | null; source: string }> {
  try {
    return { buf: await storage.readObject(key), source: 'storage' };
  } catch {
    try {
      const res = await fetch(storage.getSimPublicUrl(key));
      if (!res.ok) return { buf: null, source: `http ${res.status}` };
      return { buf: Buffer.from(await res.arrayBuffer()), source: 'sim-public' };
    } catch (e) {
      return { buf: null, source: `error ${(e as Error).message.slice(0, 60)}` };
    }
  }
}

export async function buildInventory(): Promise<PackageInventory[]> {
  const storage = getStorageAdapter();
  const simRows = await db.query.simulations.findMany();
  const sectionRows = await db.query.timeline_sections.findMany();

  const out: PackageInventory[] = [];
  for (const sim of simRows) {
    const problems: string[] = [];
    const entryRel = deriveEntryRelPath(sim.entry_file, sim.storage_prefix);
    if (!entryRel) problems.push('cannot derive entry file from entry_file/storage_prefix');
    const entryKey = entryRel ? `${sim.storage_prefix}/${entryRel}` : '';
    const bridgeKey = `${sim.storage_prefix}/bridge.js`;

    const entryRead = entryKey ? await readStored(storage, entryKey) : { buf: null, source: 'n/a' };
    const bridgeRead = await readStored(storage, bridgeKey);
    if (!entryRead.buf) problems.push(`entry HTML unreadable (${entryRead.source})`);
    if (!bridgeRead.buf) problems.push(`bridge.js unreadable (${bridgeRead.source})`);

    const bridgeJs = bridgeRead.buf?.toString('utf-8') ?? '';
    const entryHtml = entryRead.buf?.toString('utf-8') ?? '';

    // Section bodies — the artefact a rebuild must preserve byte-for-byte.
    let bodies: SectionBodyInfo[] = [];
    if (bridgeJs) {
      try {
        const entries = parseSectionEntries(bridgeJs);
        bodies = [...entries.entries()].map(([sectionId, body]) => ({
          sectionId,
          bytes: Buffer.byteLength(body, 'utf-8'),
          sha256_16: sha(body),
          normalisedSha: sha(body.replace(/\s+$/, '')),
        }));
      } catch (e) {
        problems.push(`parseSectionEntries threw: ${(e as Error).message.slice(0, 80)}`);
      }
    }
    if (bridgeJs && bodies.length === 0) problems.push('no @@SIM_BRIDGE markers — legacy/pre-combined bridge');

    const verMatch = /sim-bridge v([\d.]+)/i.exec(bridgeJs) ?? /bridge v([\d.]+)/i.exec(bridgeJs);
    const gateMatch = /sim-raf-gate v(\d+)/i.exec(entryHtml);
    const tagMatch = /bridge\.js\?v=([a-z0-9]+)/i.exec(entryHtml);

    // Guidance artefacts live beside the package; enumerate rather than assume a fixed name.
    const guidanceKeys = [`${sim.storage_prefix}/guidance.js`];
    const guidance: PackageInventory['files']['guidance'] = [];
    for (const key of guidanceKeys) {
      const r = await readStored(storage, key);
      guidance.push({ key, present: !!r.buf, bytes: r.buf?.length ?? 0, sha256_16: r.buf ? sha(r.buf) : null });
    }

    // Timeline rows that point at this package (match on the storage prefix inside the URL).
    const uses: TimelineUse[] = [];
    for (const s of sectionRows) {
      const url = (s as { simulation_url?: string | null }).simulation_url ?? null;
      if (!url || !url.includes(sim.storage_prefix)) continue;
      let urlSectionKey: string | null = null;
      try { urlSectionKey = new URL(url, 'http://x.invalid').searchParams.get('section'); } catch { /* malformed */ }
      const meta = (s as { sim_meta?: Record<string, unknown> | null }).sim_meta ?? null;
      const ui = (meta?.uiControls ?? null) as { hide?: unknown[] } | null;
      uses.push({
        sectionRowId: s.id,
        projectId: (s as { project_id?: string }).project_id ?? '',
        label: (s as { label?: string | null }).label ?? null,
        simulationUrl: url,
        urlSectionKey,
        simScript: (s as { sim_script?: string | null }).sim_script ?? null,
        simpleUi: !!(s as { simple_ui?: boolean }).simple_ui,
        autoScript: (s as { auto_script?: boolean }).auto_script !== false,
        hideSelectorCount: Array.isArray(ui?.hide) ? ui!.hide!.length : 0,
        hasGuidance: false,   // guidance is a SIMULATION-level artefact, recorded below
      });
      if (!urlSectionKey) problems.push(`timeline row ${s.id} has no ?section= identity`);
    }

    out.push({
      simulationId: sim.id,
      projectId: (sim as { project_id?: string | null }).project_id ?? null,
      name: sim.name,
      status: sim.status,
      entryFile: sim.entry_file,
      storagePrefix: sim.storage_prefix,
      entryKey,
      bridgeKey,
      files: {
        entry: { present: !!entryRead.buf, bytes: entryRead.buf?.length ?? 0, sha256_16: entryRead.buf ? sha(entryRead.buf) : null, source: entryRead.source },
        bridge: { present: !!bridgeRead.buf, bytes: bridgeRead.buf?.length ?? 0, sha256_16: bridgeRead.buf ? sha(bridgeRead.buf) : null, source: bridgeRead.source },
        guidance,
      },
      bridge: {
        version: verMatch?.[1] ?? null,
        combined: bodies.length > 0,
        ackCapable: bridgeJs.includes('SCRIPT_APPLIED'),
        hasScriptMissing: bridgeJs.includes('SCRIPT_MISSING'),
        hasPauseScript: bridgeJs.includes('pauseScript'),
        hasDemoTimer: bridgeJs.includes('simDemoTimer'),
        sectionCount: bodies.length,
        sections: bodies,
      },
      entry: {
        rafGateVersion: gateMatch ? Number(gateMatch[1]) : null,
        bridgeTagHash: tagMatch?.[1] ?? null,
        hasBootSnippet: /<script\s+data-simboot[\s>]/i.test(entryHtml),
      },
      timeline: uses,
      features: {
        usesMinimalUi: uses.some((u) => u.simpleUi) || uses.some((u) => u.hideSelectorCount > 0),
        usesAutomation: uses.some((u) => u.autoScript),
        usesGuidance: guidance.some((g) => g.present)
          || ['draft', 'ready', 'publishing'].includes((sim as { guidance_status?: string }).guidance_status ?? 'none'),
        multipleVariations: bodies.length > 1,
      },
      problems,
    });
  }
  return out;
}

async function main(): Promise<void> {
  const jsonIdx = process.argv.indexOf('--json');
  const inv = await buildInventory();

  console.log(`\n=== Stored simulation package inventory — ${inv.length} row(s) ===`);
  console.log('');
  for (const p of inv) {
    const ok = p.problems.length === 0 ? '' : `  ⚠️  ${p.problems.length} problem(s)`;
    console.log(`── ${p.name}  [${p.status}]${ok}`);
    console.log(`   sim ${p.simulationId}   project ${p.projectId ?? '—'}`);
    console.log(`   prefix ${p.storagePrefix}   entry ${p.entryFile ?? '—'}`);
    console.log(`   entry  ${p.files.entry.present ? `${p.files.entry.bytes}b sha:${p.files.entry.sha256_16} (${p.files.entry.source})` : 'MISSING'}`);
    console.log(`   bridge ${p.files.bridge.present ? `${p.files.bridge.bytes}b sha:${p.files.bridge.sha256_16} (${p.files.bridge.source})` : 'MISSING'}`);
    console.log(`   gate v${p.entry.rafGateVersion ?? '—'}  bridgeTag ${p.entry.bridgeTagHash ?? '—'}  bootSnippet ${p.entry.hasBootSnippet}`);
    console.log(`   bridge caps: combined=${p.bridge.combined} ack=${p.bridge.ackCapable} missing=${p.bridge.hasScriptMissing} pause=${p.bridge.hasPauseScript} demoTimer=${p.bridge.hasDemoTimer}`);
    console.log(`   sections (${p.bridge.sectionCount}):`);
    for (const s of p.bridge.sections) console.log(`      ${s.sectionId}  ${s.bytes}b  sha:${s.sha256_16}`);
    console.log(`   timeline uses (${p.timeline.length}):`);
    for (const u of p.timeline) {
      console.log(`      row ${u.sectionRowId}  section=${u.urlSectionKey ?? 'NONE ⚠️'}  simpleUi=${u.simpleUi} auto=${u.autoScript} hides=${u.hideSelectorCount}`);
    }
    console.log(`   features: minimalUi=${p.features.usesMinimalUi} automation=${p.features.usesAutomation} guidance=${p.features.usesGuidance} multiVariation=${p.features.multipleVariations}`);
    for (const pr of p.problems) console.log(`   ⚠️  ${pr}`);
    console.log('');
  }

  const ready = inv.filter((p) => p.status === 'ready');
  const rebuildable = ready.filter((p) => p.bridge.combined && p.files.entry.present);
  console.log(`Summary: ${inv.length} rows, ${ready.length} ready, ${rebuildable.length} rebuildable (combined bridge + readable entry).`);
  console.log(`Rebuildable: ${rebuildable.map((p) => p.name).join(', ') || '(none)'}`);
  const bad = inv.filter((p) => p.problems.length);
  if (bad.length) console.log(`Rows with problems: ${bad.map((p) => p.name).join(', ')}`);

  if (jsonIdx !== -1 && process.argv[jsonIdx + 1]) {
    writeFileSync(process.argv[jsonIdx + 1], JSON.stringify({ at: new Date().toISOString(), packages: inv }, null, 2) + '\n');
    console.log(`\nJSON written to ${process.argv[jsonIdx + 1]}`);
  }
  process.exit(0);
}

// Only run when invoked directly (the inventory is also imported by the preservation prover).
if (process.argv[1] && process.argv[1].includes('inventory-sim-packages')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
