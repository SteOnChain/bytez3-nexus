/**
 * Bytez3 Nexus — bun:bundle shim
 * 
 * In the original Claude Code, `feature()` is a Bun compile-time macro that
 * tree-shakes unreachable code paths. In Bytez3 Nexus running on Node.js,
 * we replace it with a runtime function that enables all features by default.
 * 
 * Feature flags can be selectively disabled via the NEXUS_DISABLED_FEATURES
 * environment variable (comma-separated list), e.g.:
 *   NEXUS_DISABLED_FEATURES=SSH_REMOTE,COORDINATOR_MODE
 */

const disabledFeatures = new Set(
  (process.env.NEXUS_DISABLED_FEATURES || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

export function feature(name: string): boolean {
  if (disabledFeatures.has(name)) {
    return false;
  }
  return true;
}

export default { feature };


function feature(name: any) { return process.env[name] === '1'; }
