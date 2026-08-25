/**
 * Deleting a project once bytes can be shared.
 *
 * Every test here is written against one question: what would a plan that DESTROYS somebody else's
 * video also satisfy? A planner that returns "delete everything" passes any test that only checks
 * unused files are removed — so the assertions that carry weight are the ones about what must NOT
 * be deleted, and about the ORDER in which the surviving bytes are secured.
 */
import { describe, it, expect } from 'vitest';
import {
  planProjectDeletion,
  readyToDelete,
  deletableKeys,
  adoptableKeys,
  isContentAddressedKey,
  type OwnedObject,
} from '../projectDeletionPlan.js';

const obj = (over: Partial<OwnedObject> = {}): OwnedObject => ({
  key: 'uploads/p1/video.mp4', externalRefs: 0, contentAddressed: false, ...over,
});

describe('what gets deleted', () => {
  it('deletes what nothing outside the project references', () => {
    const plan = planProjectDeletion([obj({ key: 'uploads/p1/a.mp4', externalRefs: 0 })]);
    expect(deletableKeys(plan)).toEqual(['uploads/p1/a.mp4']);
  });

  it('NEVER deletes an object another project still references', () => {
    // The whole point. This is somebody's video playing right now.
    const plan = planProjectDeletion([obj({ key: 'simulations/p1/s1/index.html', externalRefs: 2 })]);
    expect(deletableKeys(plan)).toEqual([]);
    expect(adoptableKeys(plan)).toEqual(['simulations/p1/s1/index.html']);
  });

  it('keeps content-addressed blobs out of project deletion entirely', () => {
    // A blob is owned by no project. Deleting a project must not reason about it at all — the
    // sweeper, working under its own grace period, is the only thing allowed to remove one.
    const plan = planProjectDeletion([obj({ key: 'blobs/ab/cd/abcd…', contentAddressed: true })]);
    expect(deletableKeys(plan)).toEqual([]);
    expect(adoptableKeys(plan)).toEqual([]);
    expect(plan.dispositions[0]).toEqual({ action: 'keep', key: 'blobs/ab/cd/abcd…', why: 'content-addressed' });
  });

  it('keeps a content-addressed blob even when its reference count reads ZERO', () => {
    // A count of zero at this instant races an import in flight. The blob table's own sweeper has
    // a grace period for exactly that; project deletion has no business second-guessing it.
    const plan = planProjectDeletion([obj({ key: 'blobs/ab/cd/x', contentAddressed: true, externalRefs: 0 })]);
    expect(deletableKeys(plan)).toEqual([]);
  });

  it('recognises the blob namespace from the KEY even if the flag says otherwise', () => {
    // Two independent signals, and the safe one wins. A caller that forgets to set the flag must
    // not be able to talk the planner into deleting shared bytes.
    const plan = planProjectDeletion([obj({ key: 'blobs/ab/cd/x', contentAddressed: false, externalRefs: 0 })]);
    expect(deletableKeys(plan)).toEqual([]);
  });
});

describe('the direction of doubt', () => {
  it('KEEPS an object whose reference state could not be determined', () => {
    // A leaked object costs storage and can be swept later. A wrongly deleted one is somebody's
    // video, gone, with the row that explained it gone in the same transaction.
    const plan = planProjectDeletion([obj({ externalRefs: null })]);
    expect(deletableKeys(plan)).toEqual([]);
    expect(plan.dispositions[0]).toMatchObject({ action: 'keep', why: 'reference-state-unknown' });
  });

  it('treats a nonsense count as undetermined, not as zero', () => {
    // NaN from a broken aggregate must not read as "nothing references this".
    for (const bad of [NaN, Infinity, -1 as number]) {
      const plan = planProjectDeletion([obj({ externalRefs: bad })]);
      expect(deletableKeys(plan), String(bad)).toEqual([]);
    }
  });

  it('counts the undetermined ones so the incompleteness is visible', () => {
    const plan = planProjectDeletion([
      obj({ key: 'a', externalRefs: null }), obj({ key: 'b', externalRefs: null }), obj({ key: 'c', externalRefs: 0 }),
    ]);
    expect(plan.undetermined).toBe(2);
    expect(deletableKeys(plan)).toEqual(['c']);
  });
});

describe('the ordering that makes the guarantee real', () => {
  it('refuses to delete while an adoption is still outstanding', () => {
    // Delete first and adopt afterwards, and a crash in between destroys exactly the bytes the
    // adoption existed to save.
    const plan = planProjectDeletion([obj({ key: 'shared.mp4', externalRefs: 1 })]);
    expect(plan.adoptionsRequired).toBe(1);
    const v = readyToDelete(plan, 0);
    expect(v.ready).toBe(false);
    expect(v.reason).toMatch(/another project serves/i);
  });

  it('allows deletion once every adoption has completed', () => {
    const plan = planProjectDeletion([obj({ key: 'shared.mp4', externalRefs: 1 })]);
    expect(readyToDelete(plan, 1)).toEqual({ ready: true, reason: null });
  });

  it('allows deletion immediately when nothing needed adopting', () => {
    const plan = planProjectDeletion([obj({ externalRefs: 0 })]);
    expect(plan.adoptionsRequired).toBe(0);
    expect(readyToDelete(plan, 0).ready).toBe(true);
  });

  it('refuses on a nonsense progress figure rather than trusting it', () => {
    const plan = planProjectDeletion([obj({ key: 'shared.mp4', externalRefs: 1 })]);
    for (const bad of [NaN, -1, Infinity]) {
      expect(readyToDelete(plan, bad).ready, String(bad)).toBe(false);
    }
  });

  it('names the number outstanding, so an operator knows what is holding it', () => {
    const plan = planProjectDeletion([
      obj({ key: 'a', externalRefs: 1 }), obj({ key: 'b', externalRefs: 3 }), obj({ key: 'c', externalRefs: 0 }),
    ]);
    expect(plan.adoptionsRequired).toBe(2);
    expect(readyToDelete(plan, 1).reason).toMatch(/^1 shared object/);
  });
});

describe('a realistic mixed project', () => {
  it('sorts every class correctly in one pass', () => {
    const plan = planProjectDeletion([
      obj({ key: 'blobs/aa/bb/deadbeef', contentAddressed: true }),        // shared bytes, not ours
      obj({ key: 'uploads/p1/private.mp4', externalRefs: 0 }),             // only ours → goes
      obj({ key: 'simulations/p1/s1/index.html', externalRefs: 1 }),       // imported elsewhere → adopt
      obj({ key: 'uploads/p1/mystery.png', externalRefs: null }),          // unknown → kept
    ]);
    expect(deletableKeys(plan)).toEqual(['uploads/p1/private.mp4']);
    expect(adoptableKeys(plan)).toEqual(['simulations/p1/s1/index.html']);
    expect(plan.adoptionsRequired).toBe(1);
    expect(plan.undetermined).toBe(1);
    expect(readyToDelete(plan, 0).ready).toBe(false);
  });
});

describe('the namespace test', () => {
  it('matches the blob prefix and nothing that merely contains it', () => {
    expect(isContentAddressedKey('blobs/ab/cd/x')).toBe(true);
    expect(isContentAddressedKey('uploads/p1/blobs/x')).toBe(false);
    expect(isContentAddressedKey('blobsy/ab/x')).toBe(false);
    expect(isContentAddressedKey('')).toBe(false);
  });
});
