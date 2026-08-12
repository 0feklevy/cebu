/**
 * PIN THE HARDWARE CAPABILITY INPUTS THE SUITE RESOLVES AGAINST.
 *
 * Same disease, same cure as the `NEXT_PUBLIC_API_URL` pin in vitest.config.ts: jsdom's
 * `navigator.hardwareConcurrency` reports the HOST machine's real core count, and
 * `canWarmUnpaused()` (lib/simCapability.ts) turns it into the resident-pool tier —
 * `'all'` above 4 cores, `'window'` at or below. So the suite's behaviour depended on the
 * machine it ran on: every developer laptop resolved tier `'all'` and passed, while CI's
 * 2-core runner resolved `'window'` and failed ten tests whose subject was something else
 * entirely. A suite that answers differently on different hardware is not testing the
 * product; it is testing the hardware.
 *
 * Pinned ABOVE the ≤4 threshold, so the deterministic default is the `'all'` tier most tests
 * were written against. Tests that exercise the low-end path opt in EXPLICITLY — either
 * instance-level `Object.defineProperty(navigator, 'hardwareConcurrency', …)` (which shadows
 * these prototype getters; simCapability.test.ts already works this way), or the
 * `SIM_TEST_CORES` / `SIM_TEST_MEM` env overrides, which exist so the whole suite can be
 * probed under low-end conditions from the command line:
 *
 *   SIM_TEST_CORES=2 pnpm --filter client-web exec vitest run
 *
 * That probe is exactly how the CI failure this file prevents was reproduced and root-caused.
 */
const PIN_CORES = process.env.SIM_TEST_CORES ? Number(process.env.SIM_TEST_CORES) : 8;

Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', {
  get: () => PIN_CORES,
  configurable: true,
});

// `deviceMemory` is DELIBERATELY not pinned by default. Unlike hardwareConcurrency it is already
// deterministic under jsdom — a Chrome-only API jsdom never defines — and several simUrl tests
// depend on its honest absence ("deviceMemory left undefined → no mem param"). Pinning it would
// not remove host-dependence; it would ADD a `mem=` parameter to every resolved sim URL that no
// real Firefox/Safari/jsdom environment produces. The override exists only for explicit probing.
if (process.env.SIM_TEST_MEM) {
  const PIN_MEM = Number(process.env.SIM_TEST_MEM);
  Object.defineProperty(Navigator.prototype, 'deviceMemory', {
    get: () => PIN_MEM,
    configurable: true,
  });
}
