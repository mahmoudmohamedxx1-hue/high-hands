import { CANONICAL_FEEDS, INTEL_SOURCES, SOURCE_REGION_MAP } from '@/config/feeds';
import { WEB_APP_ORIGIN } from '@/config/web-origin';
import { openExternalUrl } from '@/services/external-navigation';
import { THEATER_PRESETS, getTheaterPreset, getTheaterPresetEnableList, resolveTheaterPresetSources, type TheaterPreset } from '@/config/theater-presets';
import {
  PANEL_CATEGORY_MAP,
  ALL_PANELS,
  getEffectivePanelConfig,
  getVariantPanelCategories,
  isPanelInVariantDefaults,
} from '@/config/panels';
import { SITE_VARIANT } from '@/config/variant';
import { t } from '@/services/i18n';
import { createSettingsButton } from '@/components/settings-button';
import { confirmDialog } from '@/components/confirm-dialog';
import type { UnifiedSettingsTabId } from '@/components/settings-types';
import {
  getSettingsTabNavigationIndex,
  normalizeSettingsTab,
  restoreSettingsToggleFocus,
  updateSettingsTabSelection,
} from '@/components/unified-settings-interactions';
import type { MapProvider } from '@/config/basemap';
import { escapeHtml } from '@/utils/sanitize';
import { safeStorageRemove, safeStorageSet } from '@/utils/safe-storage';
import type { PanelConfig } from '@/types';
import { renderPreferences } from '@/services/preferences-content';
// Notifications settings tab removed: channel management depends on the
// account backend (/api/notification-channels) that does not exist in this
// self-hosted deployment — the tab would only render a sign-in/upgrade CTA.
import { getAuthState } from '@/services/auth-state';
import { track } from '@/services/analytics';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { legalLinksHtml, LEGAL_LINK_ATTR } from '@/utils/legal-links';
import { createFocusTrap, type FocusTrap } from '@/utils/focus-trap';
import {
  overlayHistory,
  type OverlayCloseOrigin,
  type OverlayId,
} from '@/utils/overlay-history';
import { isMobileDevice } from '@/utils';
import {
  FONT_SCALE_STEPS,
  fontScaleLabel,
  parseFontScale,
} from '@/services/font-scale-settings';
import { showToast } from '@/utils/toast';

export interface UnifiedSettingsConfig {
  getPanelSettings: () => Record<string, PanelConfig>;
  savePanelSettings: (panels: Record<string, PanelConfig>) => void;
  getDisabledSources: () => Set<string>;
  toggleSource: (name: string) => void;
  setSourcesEnabled: (names: string[], enabled: boolean) => void;
  getAllSourceNames: () => string[];
  getLocalizedPanelName: (key: string, fallback: string) => string;
  resetLayout: () => void;
  isDesktopApp: boolean;
  onMapProviderChange?: (provider: MapProvider) => void;
  /**
   * The user finished editing Settings → SOURCES and the enabled set is not
   * what it was when the overlay opened.
   *
   * Sources apply to `ctx.disabledSources` on click (no draft/Save step like
   * panels), but nothing subscribed to that write, so the change only reached
   * the dashboard at the next `REFRESH_INTERVALS.feeds` tick — 20 minutes
   * (#6380). This is the subscription.
   *
   * Fired on teardown rather than per click on purpose: the overlay covers the
   * dashboard, so nothing is observable until it closes, and a per-click
   * refetch would be a request storm while the user works through the grid
   * (the budget guarded by e2e/dashboard-news-request-budget.spec.ts). Once per
   * settings session, and only when the selection genuinely moved.
   */
  onSourcesChanged?: () => void;
}

type TabId = UnifiedSettingsTabId;

export class UnifiedSettings {
  private overlay: HTMLElement;
  private focusTrap: FocusTrap;
  private config: UnifiedSettingsConfig;
  private activeTab: TabId = 'settings';
  private legalLinkHandoffAttached = false;
  private activeSourceRegion = 'all';
  private sourceFilter = '';
  private activePanelCategory = 'all';
  private panelFilter = '';
  private escapeHandler: (e: KeyboardEvent) => void;
  private prefsCleanup: (() => void) | null = null;
  private draftPanelSettings: Record<string, PanelConfig> = {};
  private panelsJustSaved = false;
  private savedTimeout: ReturnType<typeof setTimeout> | null = null;
  private confirmingClose = false;
  private historyRegistered = false;
  /**
   * `sourceSelectionSignature()` as of the last open(), or null while closed.
   *
   * A signature rather than a "something was toggled" flag: a source click can
   * legitimately fail to mutate anything (the free-tier cap toasts and returns
   * without touching the set), and toggling a source off and back on again is a
   * net no-op the dashboard must not be asked to reload for.
   */
  private sourceSelectionBaseline: string | null = null;

  constructor(config: UnifiedSettingsConfig) {
    this.config = config;

    this.overlay = document.createElement('div');
    this.overlay.className = 'modal-overlay';
    this.overlay.id = 'unifiedSettingsModal';
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.setAttribute('aria-label', t('header.settings'));
    this.focusTrap = createFocusTrap(this.overlay);

    this.resetPanelDraft();

    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.close();
    };

    this.overlay.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      if (target === this.overlay) {
        this.close();
        return;
      }

      if (target.closest('.unified-settings-close')) {
        this.close();
        return;
      }

      const tab = target.closest<HTMLElement>('.unified-settings-tab');
      if (tab?.dataset.tab) {
        this.switchTab(tab.dataset.tab as TabId);
        return;
      }

      const panelCatPill = target.closest<HTMLElement>('[data-panel-cat]');
      if (panelCatPill?.dataset.panelCat) {
        this.activePanelCategory = panelCatPill.dataset.panelCat;
        this.panelFilter = '';
        const searchInput = this.overlay.querySelector<HTMLInputElement>('.panels-search input');
        if (searchInput) searchInput.value = '';
        this.renderPanelCategoryPills();
        this.renderPanelsTab();
        return;
      }

      if (target.closest('.panels-reset-layout')) {
        this.config.resetLayout();
        return;
      }

      if (target.closest('.panels-save-layout')) {
        this.savePanelChanges();
        return;
      }

      const panelItem = target.closest<HTMLElement>('.panel-toggle-item');
      if (panelItem?.dataset.panel) {
        const panelKey = panelItem.dataset.panel;
        const shouldRestoreFocus = document.activeElement === panelItem;
        this.toggleDraftPanel(panelKey);
        restoreSettingsToggleFocus(
          shouldRestoreFocus,
          this.overlay.querySelectorAll<HTMLElement>('.panel-toggle-item'),
          'panel',
          panelKey,
        );
        return;
      }

      const sourceItem = target.closest<HTMLElement>('.source-toggle-item');
      if (sourceItem?.dataset.source) {
        const sourceName = sourceItem.dataset.source;
        const shouldRestoreFocus = document.activeElement === sourceItem;
        this.config.toggleSource(sourceName);
        this.renderSourcesGrid();
        this.updateSourcesCounter();
        restoreSettingsToggleFocus(
          shouldRestoreFocus,
          this.overlay.querySelectorAll<HTMLElement>('.source-toggle-item'),
          'source',
          sourceName,
        );
        return;
      }

      const pill = target.closest<HTMLElement>('.unified-settings-region-pill');
      if (pill?.dataset.region) {
        this.activeSourceRegion = pill.dataset.region;
        this.sourceFilter = '';
        const searchInput = this.overlay.querySelector<HTMLInputElement>('.sources-search input');
        if (searchInput) searchInput.value = '';
        this.renderRegionPills();
        this.renderSourcesGrid();
        this.updateSourcesCounter();
        return;
      }

      if (target.closest('.sources-select-all')) {
        const visible = this.getVisibleSourceNames();
        this.config.setSourcesEnabled(visible, true);
        this.renderSourcesGrid();
        this.updateSourcesCounter();
        return;
      }

      const presetChip = target.closest<HTMLElement>('.unified-settings-preset-chip');
      if (presetChip?.dataset.presetId) {
        this.applyCoveragePreset(presetChip.dataset.presetId);
        return;
      }

      if (target.closest('.sources-select-none')) {
        const visible = this.getVisibleSourceNames();
        this.config.setSourcesEnabled(visible, false);
        this.renderSourcesGrid();
        this.updateSourcesCounter();
        return;
      }
    });

    this.overlay.addEventListener('change', (e) => {
      const select = (e.target as HTMLElement).closest<HTMLSelectElement>('[data-panel-font-scale]');
      const panelKey = select?.dataset.panelFontScale;
      if (!select || !panelKey) return;
      const panel = this.draftPanelSettings[panelKey];
      if (!panel) return;

      if (select.value === 'global') {
        delete panel.fontScale;
      } else {
        const scale = parseFontScale(select.value);
        if (scale === undefined) {
          select.value = panel.fontScale === undefined ? 'global' : String(panel.fontScale);
          return;
        }
        panel.fontScale = scale;
      }

      this.panelsJustSaved = false;
      select.closest('.panel-settings-item')
        ?.querySelector('.panel-toggle-item')
        ?.classList.toggle(
          'changed',
          this.isPanelDraftChanged(panelKey, panel, this.config.getPanelSettings()),
        );
      this.updatePanelsFooter();
    });

    this.overlay.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement;
      if (target.closest('.panels-search')) {
        this.panelFilter = target.value;
        this.renderPanelsTab();
      } else if (target.closest('.sources-search')) {
        this.sourceFilter = target.value;
        this.renderSourcesGrid();
        this.updateSourcesCounter();
      }
    });

    this.render();
    document.body.appendChild(this.overlay);
  }

  public open(tab?: TabId, replaceOverlayId?: OverlayId): void {
    const requestedTab = tab ?? this.activeTab;
    this.activeTab = requestedTab;
    this.resetPanelDraft();
    // Only on a FRESH session. open() is re-entrant on an overlay that is
    // already up (the deep-dive "Notify me about this country" jump to the
    // notifications tab, an overlayHistory replace), and re-snapshotting there
    // would adopt a source change already made in this session as the baseline
    // — silently discarding the very reload this exists to trigger.
    if (this.sourceSelectionBaseline === null) {
      this.sourceSelectionBaseline = this.sourceSelectionSignature();
    }
    this.render();
    this.overlay.classList.add('active');
    this.focusTrap.activate();
    if (isMobileDevice()) {
      this.historyRegistered = true;
      const close = (origin: OverlayCloseOrigin) => this.close(origin);
      if (replaceOverlayId) overlayHistory.replace(replaceOverlayId, 'settings', close);
      else overlayHistory.open('settings', close);
    }
    safeStorageSet('wm-settings-open', '1');
    document.addEventListener('keydown', this.escapeHandler);
    (this.overlay.querySelector('.unified-settings-tabs') as HTMLElement)?.addEventListener('keydown', (e: KeyboardEvent) => this.handleKeyDown(e));
    track('settings-open', { tab: tab ?? 'default' });
  }

  public close(origin: OverlayCloseOrigin = 'control'): void {
    if (origin === 'history') this.historyRegistered = false;
    // Unsaved panel changes → confirm before tearing down. The confirm is a
    // non-blocking in-app dialog (#4559): close() stays synchronous (8 callers)
    // and defers teardown to the user's choice instead of a blocking confirm().
    if (origin !== 'replacement' && this.hasPendingPanelChanges()) {
      if (origin === 'history' && !this.historyRegistered) {
        this.historyRegistered = true;
        overlayHistory.open('settings', (nextOrigin) => this.close(nextOrigin));
      }
      if (this.confirmingClose) return; // a confirm is already on screen
      this.confirmingClose = true;
      void confirmDialog({ message: t('header.unsavedChanges') }).then((discard) => {
        this.confirmingClose = false;
        if (discard) this.teardownSettings('control');
      });
      return;
    }
    this.teardownSettings(origin);
  }

  public hasPendingChanges(): boolean {
    return this.hasPendingPanelChanges();
  }

  private teardownSettings(origin: OverlayCloseOrigin = 'control'): void {
    if (origin === 'control' && this.historyRegistered) {
      overlayHistory.close('settings');
    }
    this.historyRegistered = false;
    this.overlay.classList.remove('active');
    this.focusTrap.deactivate();
    this.prefsCleanup?.();
    this.prefsCleanup = null;
    this.resetPanelDraft();
    safeStorageRemove('wm-settings-open');
    document.removeEventListener('keydown', this.escapeHandler);
    // Last: the host reloads data in response, and the overlay covering the
    // dashboard has to be gone before that lands for the user to see it.
    this.notifySourceSelectionChanged();
  }

  /**
   * Order-independent fingerprint of the currently DISABLED source names.
   *
   * NUL is the separator because source names contain spaces ("BBC World"):
   * any separator a name can itself hold collapses `["A B"]` and `["A", "B"]`
   * into one string, which is a silent miss for exactly the swap-one-source-
   * for-another case this comparison exists to catch.
   */
  private sourceSelectionSignature(): string {
    return [...this.config.getDisabledSources()].sort().join('\u0000');
  }

  /**
   * Tell the host the source selection moved during this settings session.
   *
   * Every close path funnels through teardownSettings — the close button, Esc,
   * the overlay backdrop, mobile history back, and the discard branch of the
   * unsaved-panel-changes confirm — so this is the single chokepoint. `destroy()`
   * deliberately does not reach it: the dashboard is going away.
   */
  private notifySourceSelectionChanged(): void {
    const baseline = this.sourceSelectionBaseline;
    this.sourceSelectionBaseline = null;
    // null baseline = never opened. A teardown without an open has no session
    // to compare against, and firing there would reload on a spurious close.
    if (baseline === null || baseline === this.sourceSelectionSignature()) return;
    this.config.onSourcesChanged?.();
  }

  public refreshPanelToggles(): void {
    this.resetPanelDraft();
    if (this.activeTab === 'panels') this.renderPanelsTab();
  }

  public getButton(): HTMLButtonElement {
    return createSettingsButton(() => this.open());
  }

  public destroy(): void {
    if (this.historyRegistered) overlayHistory.close('settings');
    this.historyRegistered = false;
    if (this.savedTimeout) clearTimeout(this.savedTimeout);
    this.prefsCleanup?.();
    this.prefsCleanup = null;
    document.removeEventListener('keydown', this.escapeHandler);
    // Teardown, not a user-initiated close: release the trap's document
    // listener without handing focus back to a trigger that is also going away.
    this.focusTrap.deactivate({ restoreFocus: false });
    this.overlay.remove();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (!(e.target instanceof HTMLElement)) return;
    const tablist = this.overlay.querySelector('.unified-settings-tabs');
    if (!tablist || !tablist.contains(e.target)) return;
    const tabs = Array.from(tablist.querySelectorAll<HTMLButtonElement>('button[role="tab"]'));
    const currentIndex = tabs.indexOf(e.target.closest('button[role="tab"]') as HTMLButtonElement);
    const nextIndex = getSettingsTabNavigationIndex(e.key, currentIndex, tabs.length);
    if (nextIndex === null) return;

    e.preventDefault();

    const nextTab = tabs[nextIndex];
    const tabId = nextTab?.dataset.tab as TabId | undefined;
    if (!tabId || !nextTab) return;
    this.switchTab(tabId);
    nextTab.focus();
  }

  private render(): void {
    this.prefsCleanup?.();
    this.prefsCleanup = null;

    const isSignedIn = getAuthState().user !== null;
    const prefs = renderPreferences({
      isDesktopApp: this.config.isDesktopApp,
      onMapProviderChange: this.config.onMapProviderChange,
      onSettingSaved: () => showToast(t('modals.settingsWindow.saved')),
      isSignedIn,
    });
    const availableTabs: TabId[] = [
      'settings',
      'panels',
      'sources',
    ];
    this.activeTab = normalizeSettingsTab(this.activeTab, availableTabs);
    const tabClass = (id: TabId) => `unified-settings-tab${this.activeTab === id ? ' active' : ''}`;
    const applicablePresets = this.getApplicableTheaterPresets();

    setTrustedHtml(this.overlay, trustedHtml(`
      <div class="modal unified-settings-modal">
        <div class="modal-header">
          <span class="modal-title">${t('header.settings')}</span>
          <button class="modal-close unified-settings-close" aria-label="Close">\u00d7</button>
        </div>
        <div class="unified-settings-tabs" role="tablist" aria-label="Settings">
          <button class="${tabClass('settings')}" tabindex="${this.activeTab === 'settings' ? 0 : -1}" data-tab="settings" role="tab" aria-selected="${this.activeTab === 'settings'}" id="us-tab-settings" aria-controls="us-tab-panel-settings">${t('header.tabSettings')}</button>
          <button class="${tabClass('panels')}" tabindex="${this.activeTab === 'panels' ? 0 : -1}" data-tab="panels" role="tab" aria-selected="${this.activeTab === 'panels'}" id="us-tab-panels" aria-controls="us-tab-panel-panels">${t('header.tabPanels')}</button>
          <button class="${tabClass('sources')}" tabindex="${this.activeTab === 'sources' ? 0 : -1}" data-tab="sources" role="tab" aria-selected="${this.activeTab === 'sources'}" id="us-tab-sources" aria-controls="us-tab-panel-sources">${t('header.tabSources')}</button>
        </div>
        <div class="unified-settings-tab-panel${this.activeTab === 'settings' ? ' active' : ''}" data-panel-id="settings" id="us-tab-panel-settings" role="tabpanel" aria-labelledby="us-tab-settings">
          ${prefs.html}
        </div>
        <div class="unified-settings-tab-panel${this.activeTab === 'panels' ? ' active' : ''}" data-panel-id="panels" id="us-tab-panel-panels" role="tabpanel" aria-labelledby="us-tab-panels">
          <div class="unified-settings-region-wrapper">
            <div class="unified-settings-region-bar" id="usPanelCatBar"></div>
          </div>
          <div class="panels-search">
            <input type="text" placeholder="${t('header.filterPanels')}" aria-label="${t('header.filterPanels')}" value="${escapeHtml(this.panelFilter)}" />
          </div>
          <div class="panel-toggle-grid" id="usPanelToggles"></div>
          <div class="panels-footer">
            <span class="panels-status" id="usPanelsStatus" aria-live="polite"></span>
            <button class="panels-save-layout">${t('modals.story.save')}</button>
            <button class="panels-reset-layout" title="${t('header.resetLayoutTooltip')}" aria-label="${t('header.resetLayoutTooltip')}">${t('header.resetLayout')}</button>
          </div>
        </div>
        <div class="unified-settings-tab-panel${this.activeTab === 'sources' ? ' active' : ''}" data-panel-id="sources" id="us-tab-panel-sources" role="tabpanel" aria-labelledby="us-tab-sources">
          <div class="unified-settings-region-wrapper">
            <div class="unified-settings-region-bar" id="usRegionBar"></div>
          </div>
          ${applicablePresets.length > 0 ? `
          <div class="unified-settings-presets" id="usCoveragePresets">
            <span class="unified-settings-presets-label">${t('theaterPresets.label')}</span>
            ${applicablePresets.map(preset =>
              `<button type="button" class="unified-settings-region-pill unified-settings-preset-chip" data-preset-id="${preset.id}" title="${escapeHtml(t(preset.descriptionKey))}">${escapeHtml(t(preset.labelKey))}</button>`
            ).join('')}
          </div>
          ` : ''}
          <div class="sources-search">
            <input type="text" placeholder="${t('header.filterSources')}" aria-label="${t('header.filterSources')}" value="${escapeHtml(this.sourceFilter)}" />
          </div>
          <div class="sources-toggle-grid" id="usSourceToggles"></div>
          <div class="sources-footer">
            <span class="sources-counter" id="usSourcesCounter"></span>
            <button class="sources-select-all">${t('common.selectAll')}</button>
            <button class="sources-select-none">${t('common.selectNone')}</button>
          </div>
        </div>
        ${legalLinksHtml(WEB_APP_ORIGIN)}
      </div>
    `, "legacy direct innerHTML migration"));

    const settingsPanel = this.overlay.querySelector('#us-tab-panel-settings');
    if (settingsPanel) {
      this.prefsCleanup = prefs.attach(settingsPanel as HTMLElement);
    }

    const closeBtn = this.overlay.querySelector<HTMLButtonElement>('.unified-settings-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this.close();
      });
    }

    this.attachLegalLinkHandoff();

    this.renderPanelCategoryPills();
    this.renderPanelsTab();
    this.renderRegionPills();
    this.renderSourcesGrid();
    this.updateSourcesCounter();
  }

  /**
   * Desktop hands legal links to the OS browser (#5911 precedent). A plain
   * `target="_blank"` anchor inside the Tauri WebView opens another WebView
   * window with no chrome, which is how a user ends up stranded on the Terms
   * with no way back. Delegated on the overlay so it covers the legal row AND
   * every checkout-consent line rendered inside a tab panel, including the ones
   * re-rendered after this handler is attached.
   */
  private attachLegalLinkHandoff(): void {
    if (!this.config.isDesktopApp || this.legalLinkHandoffAttached) return;
    // The overlay element outlives every re-render, so an unguarded attach
    // would stack one listener per render and open N windows on one click.
    this.legalLinkHandoffAttached = true;
    this.overlay.addEventListener('click', (e) => {
      const link = (e.target as HTMLElement | null)?.closest?.(`a[${LEGAL_LINK_ATTR}]`);
      const href = link instanceof HTMLAnchorElement ? link.href : '';
      if (!href) return;
      e.preventDefault();
      void openExternalUrl(href);
    });
  }

  private switchTab(tab: TabId): void {
    this.activeTab = tab;

    updateSettingsTabSelection(
      this.overlay.querySelectorAll<HTMLElement>('.unified-settings-tab'),
      this.overlay.querySelectorAll<HTMLElement>('.unified-settings-tab-panel'),
      tab,
    );

  }

  private categoryMatchesVariant(catDef: { variants?: string[] }): boolean {
    return !catDef.variants || catDef.variants.includes(SITE_VARIANT);
  }

  private getAvailablePanelCategories(): Array<{ key: string; label: string }> {
    return [
      { key: 'all', label: t('header.sourceRegionAll') },
      ...getVariantPanelCategories(this.config.getPanelSettings(), SITE_VARIANT)
        .map(({ key, labelKey }) => ({ key, label: t(labelKey) })),
    ];
  }

  private getVisiblePanelEntries(): Array<[string, PanelConfig]> {
    const panelSettings = this.draftPanelSettings;
    let entries = Object.entries(panelSettings)
      .filter(([key]) => key !== 'runtime-config' || this.config.isDesktopApp)
      .filter(([key]) => !key.startsWith('cw-'));

    if (this.activePanelCategory !== 'all') {
      const catDef = PANEL_CATEGORY_MAP[this.activePanelCategory];
      if (catDef) {
        if (!this.categoryMatchesVariant(catDef)) {
          return [];
        }
        const allowed = new Set(catDef.panelKeys);
        entries = entries.filter(([key]) => allowed.has(key));
      }
    }

    if (this.panelFilter) {
      const lower = this.panelFilter.toLowerCase();
      entries = entries.filter(([key, panel]) =>
        key.toLowerCase().includes(lower) ||
        panel.name.toLowerCase().includes(lower) ||
        this.config.getLocalizedPanelName(key, panel.name).toLowerCase().includes(lower)
      );
    }

    return entries;
  }

  private renderPanelCategoryPills(): void {
    const bar = this.overlay.querySelector('#usPanelCatBar');
    if (!bar) return;

    const categories = this.getAvailablePanelCategories();
    setTrustedHtml(bar, trustedHtml(categories.map(c =>
      `<button class="unified-settings-region-pill${this.activePanelCategory === c.key ? ' active' : ''}" data-panel-cat="${c.key}">${escapeHtml(c.label)}</button>`
    ).join(''), "legacy direct innerHTML migration"));
  }

  private renderPanelsTab(): void {
    const container = this.overlay.querySelector('#usPanelToggles');
    if (!container) return;

    const savedSettings = this.config.getPanelSettings();
    const entries = this.getVisiblePanelEntries();
    const panelFontScaleLabel = t('preferences.panelFontScale', { defaultValue: 'Text size' });
    const followGlobalFontScaleLabel = t('preferences.followGlobalFontScale', { defaultValue: 'Use global' });
    setTrustedHtml(container, trustedHtml(entries.map(([key, panel]) => {
      // Preserve saved config for dynamic cw-* panels; unknown keys should not
      // collapse to getEffectivePanelConfig's disabled synthetic fallback.
      const resolvedPanel = ALL_PANELS[key] ? getEffectivePanelConfig(key, SITE_VARIANT) : panel;
      const changed = this.isPanelDraftChanged(key, panel, savedSettings);
      const displayName = this.config.getLocalizedPanelName(key, resolvedPanel.name ?? panel.name);
      // Sandboxed MCP iframes cannot inherit the host panel's CSS scale.
      const supportsPanelFontScale = key !== 'map' && !key.startsWith('mcp-');
      return `
        <div class="panel-settings-item">
          <button type="button" class="panel-toggle-item ${panel.enabled ? 'active' : ''}${changed ? ' changed' : ''}" data-panel="${escapeHtml(key)}" aria-pressed="${panel.enabled}">
            <div class="panel-toggle-checkbox" aria-hidden="true">${panel.enabled ? '\u2713' : ''}</div>
            <span class="panel-toggle-label">${escapeHtml(displayName)}</span>
          </button>
          ${supportsPanelFontScale ? `<label class="panel-font-scale-control">
            <span>${escapeHtml(panelFontScaleLabel)}</span>
            <select data-panel-font-scale="${escapeHtml(key)}" aria-label="${escapeHtml(`${displayName}: ${panelFontScaleLabel}`)}">
              <option value="global"${panel.fontScale === undefined ? ' selected' : ''}>${escapeHtml(followGlobalFontScaleLabel)}</option>
              ${FONT_SCALE_STEPS.map(scale => `<option value="${scale}"${panel.fontScale === scale ? ' selected' : ''}>${fontScaleLabel(scale)}</option>`).join('')}
            </select>
          </label>` : ''}
        </div>
      `;
    }).join(''), "legacy direct innerHTML migration"));

    this.updatePanelsFooter();
  }

  private clonePanelSettings(source: Record<string, PanelConfig> = this.config.getPanelSettings()): Record<string, PanelConfig> {
    const cloned: Record<string, PanelConfig> = Object.fromEntries(
      Object.entries(source).map(([key, panel]) => [key, { ...panel }]),
    );
    for (const key of Object.keys(ALL_PANELS)) {
      if (!(key in cloned)) {
        cloned[key] = { ...getEffectivePanelConfig(key, SITE_VARIANT), enabled: isPanelInVariantDefaults(key) };
      }
    }
    return cloned;
  }

  private resetPanelDraft(): void {
    this.draftPanelSettings = this.clonePanelSettings();
    this.panelsJustSaved = false;
  }

  private getSavedPanelEnabled(key: string, savedSettings: Record<string, PanelConfig>): boolean {
    const savedPanel = savedSettings[key];
    if (savedPanel) return savedPanel.enabled;
    return Boolean(ALL_PANELS[key]) && isPanelInVariantDefaults(key);
  }

  private getSavedPanelFontScale(
    key: string,
    savedSettings: Record<string, PanelConfig>,
  ): PanelConfig['fontScale'] {
    return savedSettings[key]?.fontScale;
  }

  private isPanelDraftChanged(
    key: string,
    panel: PanelConfig,
    savedSettings: Record<string, PanelConfig>,
  ): boolean {
    return this.getSavedPanelEnabled(key, savedSettings) !== panel.enabled
      || this.getSavedPanelFontScale(key, savedSettings) !== panel.fontScale;
  }

  private hasPendingPanelChanges(): boolean {
    const savedSettings = this.config.getPanelSettings();
    return Object.entries(this.draftPanelSettings).some(
      ([key, panel]) => this.isPanelDraftChanged(key, panel, savedSettings),
    );
  }

  private toggleDraftPanel(key: string): void {
    const panel = this.draftPanelSettings[key];
    if (!panel) return;
    panel.enabled = !panel.enabled;
    this.panelsJustSaved = false;
    this.renderPanelsTab();
  }

  private savePanelChanges(): void {
    if (!this.hasPendingPanelChanges()) return;
    this.config.savePanelSettings(Object.fromEntries(Object.entries(this.draftPanelSettings).map(([k, v]) => [k, { ...v }])));
    this.draftPanelSettings = this.clonePanelSettings();
    this.panelsJustSaved = true;
    this.renderPanelsTab();
    if (this.savedTimeout) clearTimeout(this.savedTimeout);
    this.savedTimeout = setTimeout(() => {
      this.panelsJustSaved = false;
      this.savedTimeout = null;
      this.updatePanelsFooter();
    }, 2000);
  }

  private updatePanelsFooter(): void {
    const status = this.overlay.querySelector<HTMLElement>('#usPanelsStatus');
    const saveButton = this.overlay.querySelector<HTMLButtonElement>('.panels-save-layout');
    const hasPendingChanges = this.hasPendingPanelChanges();

    if (saveButton) {
      saveButton.disabled = !hasPendingChanges;
    }

    if (status) {
      status.textContent = this.panelsJustSaved ? t('modals.settingsWindow.saved') : '';
      status.classList.toggle('visible', this.panelsJustSaved);
    }
  }

  private getAvailableRegions(): Array<{ key: string; label: string }> {
    // A region pill shows when at least one of its sources is actually being
    // loaded — getAllSourceNames() covers the active preset PLUS any cross-
    // variant panels the user enabled, so customized-in regions appear too.
    const allowed = new Set(this.config.getAllSourceNames());
    const regions: Array<{ key: string; label: string }> = [
      { key: 'all', label: t('header.sourceRegionAll') }
    ];

    for (const [regionKey, regionDef] of Object.entries(SOURCE_REGION_MAP)) {
      if (regionKey === 'intel') {
        if (INTEL_SOURCES.length > 0) {
          regions.push({ key: regionKey, label: t(regionDef.labelKey) });
        }
        continue;
      }
      const hasFeeds = regionDef.feedKeys.some(fk =>
        (CANONICAL_FEEDS[fk] ?? []).some(f => allowed.has(f.name)));
      if (hasFeeds) {
        regions.push({ key: regionKey, label: t(regionDef.labelKey) });
      }
    }

    return regions;
  }

  private getSourcesByRegion(): Map<string, string[]> {
    const map = new Map<string, string[]>();
    // Resolve region membership from CANONICAL_FEEDS (the all-variant union),
    // then intersect with the sources actually loaded — getAllSourceNames()
    // already covers the active preset + any custom panels the user enabled —
    // so a customized-in panel's sources show under their proper region pill,
    // not just the 'all' view.
    const allowed = new Set(this.config.getAllSourceNames());

    for (const [regionKey, regionDef] of Object.entries(SOURCE_REGION_MAP)) {
      const sources: string[] = [];
      if (regionKey === 'intel') {
        INTEL_SOURCES.forEach(f => sources.push(f.name));
      } else {
        for (const fk of regionDef.feedKeys) {
          for (const f of CANONICAL_FEEDS[fk] ?? []) {
            if (allowed.has(f.name)) sources.push(f.name);
          }
        }
      }
      if (sources.length > 0) {
        map.set(regionKey, sources.sort((a, b) => a.localeCompare(b)));
      }
    }

    return map;
  }

  private getVisibleSourceNames(): string[] {
    let sources: string[];
    if (this.activeSourceRegion === 'all') {
      sources = this.config.getAllSourceNames();
    } else {
      const byRegion = this.getSourcesByRegion();
      sources = byRegion.get(this.activeSourceRegion) || [];
    }

    if (this.sourceFilter) {
      const lower = this.sourceFilter.toLowerCase();
      sources = sources.filter(s => s.toLowerCase().includes(lower));
    }

    return sources;
  }

  private renderRegionPills(): void {
    const bar = this.overlay.querySelector('#usRegionBar');
    if (!bar) return;

    const regions = this.getAvailableRegions();
    setTrustedHtml(bar, trustedHtml(regions.map(r =>
      `<button class="unified-settings-region-pill${this.activeSourceRegion === r.key ? ' active' : ''}" data-region="${r.key}">${escapeHtml(r.label)}</button>`
    ).join(''), "legacy direct innerHTML migration"));
  }

  private renderSourcesGrid(): void {
    const container = this.overlay.querySelector('#usSourceToggles');
    if (!container) return;

    const sources = this.getVisibleSourceNames();
    const disabled = this.config.getDisabledSources();

    setTrustedHtml(container, trustedHtml(sources.map(source => {
      const isEnabled = !disabled.has(source);
      const escaped = escapeHtml(source);
      return `
        <button type="button" class="source-toggle-item ${isEnabled ? 'active' : ''}" aria-pressed="${isEnabled}" data-source="${escaped}">
          <div class="source-toggle-checkbox" aria-hidden="true">${isEnabled ? '\u2713' : ''}</div>
          <span class="source-toggle-label">${escaped}</span>
        </button>
      `;
    }).join(''), "legacy direct innerHTML migration"));
  }

  private updateSourcesCounter(): void {
    const counter = this.overlay.querySelector('#usSourcesCounter');
    if (!counter) return;

    const disabled = this.config.getDisabledSources();
    const allSources = this.config.getAllSourceNames();
    const enabledTotal = allSources.length - disabled.size;

    counter.textContent = t('header.sourcesEnabled', { enabled: String(enabledTotal), total: String(allSources.length) });
  }

  /**
   * Presets with at least one source that resolves in the runtime-known
   * source set. Narrow variants (or disabled news panels) can leave a preset
   * with nothing to enable — those chips are dead, so don't offer them.
   */
  private getApplicableTheaterPresets(): readonly TheaterPreset[] {
    const known = new Set(this.config.getAllSourceNames());
    return THEATER_PRESETS.filter((preset) => resolveTheaterPresetSources(preset, known).length > 0);
  }

  /**
   * Theater coverage preset (#5956): additively enable the preset's sources.
   * Uses the same bulk primitive as select-all, so persistence, the free
   * source cap, and cloud sync behave identically; unrelated sources are
   * never touched.
   */
  private applyCoveragePreset(presetId: string): void {
    const preset = getTheaterPreset(presetId);
    if (!preset) return;

    const known = new Set(this.config.getAllSourceNames());
    const resolvable = resolveTheaterPresetSources(preset, known);
    const toEnable = getTheaterPresetEnableList(preset, this.config.getDisabledSources(), known);
    const label = t(preset.labelKey);

    // Zero resolvable sources (narrow variant or unloaded panels) is not the
    // same as "already applied" — say so. Normally unreachable because the
    // chips row only renders applicable presets; kept as a defensive guard.
    if (resolvable.length === 0) {
      showToast(t('theaterPresets.unavailable', { preset: label }));
      return;
    }

    if (toEnable.length === 0) {
      showToast(t('theaterPresets.alreadyApplied', { preset: label }));
      return;
    }

    // setSourcesEnabled no-ops (with its own free-cap toast) when the free
    // source cap would be exceeded — only re-render and claim success when
    // state actually changed.
    const disabledSizeBefore = this.config.getDisabledSources().size;
    this.config.setSourcesEnabled(toEnable, true);
    if (this.config.getDisabledSources().size !== disabledSizeBefore) {
      this.renderSourcesGrid();
      this.updateSourcesCounter();
      showToast(t('theaterPresets.applied', { preset: label, count: String(toEnable.length) }));
    }
  }
}
