// Shared semver helpers: the dotted major.minor.patch compare used by validate.mjs's
// culprits.json check and verification.mjs's resolved-in check. One definition, two callers.
export const SEMVER_RE = /^\d+\.\d+\.\d+$/;

export function cmpSemver(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}
