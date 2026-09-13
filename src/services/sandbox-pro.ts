/**
 * PRO removed: every feature is accessible, always.
 *
 * The upstream project gates premium features behind Clerk auth + Convex
 * entitlements, which need production backend credentials this self-hosted
 * deployment does not have — so the gates could never resolve here. Instead of
 * toggling, PRO is now simply GONE: all premium surfaces (panels, layers, tab
 * caps, exports, AI) are permanently unlocked for everyone.
 */

export function isSandboxPro(): boolean {
  return true;
}
