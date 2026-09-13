/**
 * Canonical tab-id union for the settings modal. Lives in the components layer
 * (a pure leaf type with no imports) so both the UnifiedSettings component and
 * the app-context controller interface can share one declaration without a
 * components -> app backward import.
 *
 * Self-hosted: the SaaS account tabs (billing, api-keys, embeds, mcp-clients)
 * are removed — they depend on the Convex/Dodo backend this deployment has no
 * account system for.
 */
export type UnifiedSettingsTabId =
  | 'settings'
  | 'panels'
  | 'sources';
