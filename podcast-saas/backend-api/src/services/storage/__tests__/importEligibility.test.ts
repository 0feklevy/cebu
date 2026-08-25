/**
 * Who may pull another project's simulation into their own.
 *
 * The bar every assertion is written against: what would a PERMISSIVE implementation also satisfy?
 * A function that returns `allowed: true` unconditionally passes every "the owner can import"
 * test perfectly. So the load-bearing half of this file is the refusals — and, just as much, the
 * SHAPE of the refusals, because a 403 where a 404 belongs tells a stranger that a private project
 * exists.
 */
import { describe, it, expect } from 'vitest';
import { judgeImport, mayReadProject, mayWriteProject, type ProjectFacts, type Requester } from '../importEligibility.js';

const ALICE = 'uid-alice';
const BOB = 'uid-bob';

const proj = (over: Partial<ProjectFacts> = {}): ProjectFacts => ({
  id: 'src-1', visibility: 'private', ownerId: ALICE, isCollaborator: false, shareToken: null, ...over,
});
const dest = (over: Partial<ProjectFacts> = {}): ProjectFacts => proj({ id: 'dst-1', ...over });
const who = (over: Partial<Requester> = {}): Requester => ({ uid: ALICE, ...over });

describe('reading the source', () => {
  it('lets the owner read their own private project', () => {
    expect(mayReadProject(proj(), who({ uid: ALICE }))).toBe(true);
  });

  it('lets a collaborator read it', () => {
    expect(mayReadProject(proj({ isCollaborator: true }), who({ uid: BOB }))).toBe(true);
  });

  it('lets anyone read a public project, signed in or not', () => {
    expect(mayReadProject(proj({ visibility: 'public' }), who({ uid: BOB }))).toBe(true);
    expect(mayReadProject(proj({ visibility: 'public' }), who({ uid: null }))).toBe(true);
  });

  it('refuses a stranger on a private project', () => {
    expect(mayReadProject(proj(), who({ uid: BOB }))).toBe(false);
    expect(mayReadProject(proj(), who({ uid: null }))).toBe(false);
  });
});

describe('unlisted projects — the link IS the credential', () => {
  it('opens with the matching token', () => {
    const p = proj({ visibility: 'unlisted', shareToken: 'tok-abc' });
    expect(mayReadProject(p, who({ uid: BOB, shareToken: 'tok-abc' }))).toBe(true);
  });

  it('refuses a wrong token', () => {
    const p = proj({ visibility: 'unlisted', shareToken: 'tok-abc' });
    expect(mayReadProject(p, who({ uid: BOB, shareToken: 'tok-xyz' }))).toBe(false);
  });

  it('refuses NO token — presenting nothing is not presenting the link', () => {
    const p = proj({ visibility: 'unlisted', shareToken: 'tok-abc' });
    expect(mayReadProject(p, who({ uid: BOB }))).toBe(false);
  });

  it('does not open an unlisted project that has NO token to a caller with no token', () => {
    // The bug this guards: `undefined === undefined` is true, so a naive comparison would open
    // every tokenless unlisted project to every tokenless request — which is all of them.
    for (const held of [null, undefined, '']) {
      for (const real of [null, undefined, '']) {
        const p = proj({ visibility: 'unlisted', shareToken: real as string | null });
        expect(mayReadProject(p, who({ uid: BOB, shareToken: held as string | null })),
          `held=${String(held)} real=${String(real)}`).toBe(false);
      }
    }
  });
});

describe('writing to the destination', () => {
  it('requires ownership or collaboration — a PUBLIC destination is not a writable one', () => {
    // Visibility governs reading. Anyone being able to see a project must never imply anyone can
    // add content to it.
    expect(mayWriteProject(dest({ visibility: 'public', ownerId: ALICE }), who({ uid: BOB }))).toBe(false);
  });

  it('refuses an anonymous caller outright', () => {
    expect(mayWriteProject(dest({ visibility: 'public' }), who({ uid: null }))).toBe(false);
  });

  it('allows the owner and a collaborator', () => {
    expect(mayWriteProject(dest({ ownerId: ALICE }), who({ uid: ALICE }))).toBe(true);
    expect(mayWriteProject(dest({ ownerId: ALICE, isCollaborator: true }), who({ uid: BOB }))).toBe(true);
  });
});

describe('the whole decision', () => {
  it('allows an owner importing their own public source into their own project', () => {
    expect(judgeImport({
      source: proj({ visibility: 'public', ownerId: BOB }),
      destination: dest({ ownerId: ALICE }),
      who: who({ uid: ALICE }),
    })).toEqual({ allowed: true });
  });

  it('checks the DESTINATION first, so a refusal reveals nothing about the source', () => {
    // A caller with no write rights gets the same 403 whether the source is public, private, or
    // does not exist at all. Checking the source first would turn this endpoint into an existence
    // oracle for private projects.
    const outcomes = [
      judgeImport({ source: proj({ visibility: 'public' }), destination: dest({ ownerId: BOB }), who: who({ uid: ALICE }) }),
      judgeImport({ source: proj({ visibility: 'private', ownerId: BOB }), destination: dest({ ownerId: BOB }), who: who({ uid: ALICE }) }),
      judgeImport({ source: null, destination: dest({ ownerId: BOB }), who: who({ uid: ALICE }) }),
    ];
    for (const o of outcomes) {
      expect(o).toEqual({ allowed: false, reason: 'destination-not-editable', status: 403 });
    }
  });

  it('answers 404 — never 403 — for a private source the caller cannot see', () => {
    // "You are not allowed to touch this" confirms it exists. The requester is not entitled to
    // tell "no such project" from "not yours".
    const v = judgeImport({
      source: proj({ visibility: 'private', ownerId: BOB }),
      destination: dest({ ownerId: ALICE }),
      who: who({ uid: ALICE }),
    });
    expect(v).toEqual({ allowed: false, reason: 'not-found', status: 404 });
  });

  it('gives a MISSING source and a forbidden one the identical answer', () => {
    const missing = judgeImport({ source: null, destination: dest({ ownerId: ALICE }), who: who({ uid: ALICE }) });
    const forbidden = judgeImport({
      source: proj({ visibility: 'private', ownerId: BOB }), destination: dest({ ownerId: ALICE }), who: who({ uid: ALICE }),
    });
    expect(missing).toEqual(forbidden);
  });

  it('refuses importing a project into itself', () => {
    const p = dest({ ownerId: ALICE });
    const v = judgeImport({ source: p, destination: p, who: who({ uid: ALICE }) });
    expect(v).toEqual({ allowed: false, reason: 'same-project', status: 400 });
  });

  it('refuses an anonymous caller before anything else', () => {
    expect(judgeImport({
      source: proj({ visibility: 'public' }), destination: dest({ visibility: 'public' }), who: who({ uid: null }),
    })).toMatchObject({ allowed: false, reason: 'destination-not-editable' });
  });

  it('never returns allowed:true for a source the requester could not open', () => {
    // The blanket claim, swept across the combinations a permissive implementation would pass.
    const strangers: Requester[] = [{ uid: BOB }, { uid: null }, { uid: BOB, shareToken: 'wrong' }];
    for (const w of strangers) {
      const v = judgeImport({
        source: proj({ visibility: 'private', ownerId: ALICE }),
        destination: dest({ ownerId: BOB, isCollaborator: true }),
        who: w,
      });
      expect(v.allowed, JSON.stringify(w)).toBe(false);
    }
  });
});
