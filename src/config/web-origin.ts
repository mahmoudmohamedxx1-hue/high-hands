/**
 * Canonical https origin of the WorldMonitor web app.
 *
 * The desktop WebView serves the dashboard from `tauri://localhost` (or
 * `https://localhost:<port>` under `desktop:dev`), so a relative link to a
 * web-only surface — pricing, the billing portal, a payment-provider return
 * URL — resolves against an origin that hosts none of those routes and
 * dead-ends the user. Every desktop-reachable link into the web app must be
 * absolute against this constant.
 *
 * Self-hosted deployments (HIGH-HANDS): when the dashboard is served from a
 * host that is NOT worldmonitor.app, "web app surfaces" (checkout, pricing,
 * billing) must stay on the local origin — navigating users to the upstream
 * SaaS checkout would send them to a product this deployment is not. Only
 * the desktop WebView keeps the absolute upstream origin, because a WebView
 * origin cannot host those surfaces at all.
 *
 * Dependency-free on purpose: consumers span `config`, `services`,
 * `components` and `utils`, and the checkout-return builders are unit-tested
 * without the browser service graph.
 */
function resolveWebAppOrigin(): string {
  const UPSTREAM = 'https://worldmonitor.app';
  try {
    if (typeof window === 'undefined' || !window.location?.hostname) return UPSTREAM;
    const host = window.location.hostname;
    // Desktop WebView (tauri://localhost and friends) — upstream stays absolute.
    if (/^(tauri|asset|vscode-webview)/i.test(window.location.protocol)) return UPSTREAM;
    // Served from the upstream SaaS (or its preview subdomains) — unchanged.
    if (host === 'worldmonitor.app' || host.endsWith('.worldmonitor.app')) return UPSTREAM;
    // Self-hosted web deployment — keep every surface local.
    return window.location.origin;
  } catch {
    return UPSTREAM;
  }
}

export const WEB_APP_ORIGIN = resolveWebAppOrigin();
