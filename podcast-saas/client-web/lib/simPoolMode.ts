// Resolution rule for the `?simpool` query override of the resident sim pool mode (KILLSW,
// audit §17). The override exists for diagnostics and as a viewer-side escape hatch, so it may
// only ever make a session CHEAPER than what the server decided:
//
//   • 'single'   — always honoured: downgrading to the kill-switch tier must work everywhere,
//                  for anyone, because it is the "my device is dying" escape hatch;
//   • 'adaptive' — an UPGRADE, honoured only in development builds. In production a link with
//                  `?simpool=adaptive` must not be able to override an operator's server-side
//                  'single': that would let any shared URL defeat the kill switch the operator
//                  threw during an incident;
//   • anything else (absent, empty, garbage) — the server value stands.
//
// Pure and synchronous so the rule is unit-testable in isolation (simPoolMode.test.ts covers
// the full combination table).

export type SimPoolMode = 'single' | 'adaptive';

export function resolveSimPoolMode(
  serverMode: SimPoolMode,
  query: string | null,
  isDev: boolean,
): SimPoolMode {
  if (query === 'single') return 'single';                 // downgrade: always allowed
  if (query === 'adaptive' && isDev) return 'adaptive';    // upgrade: dev builds only
  return serverMode;
}
