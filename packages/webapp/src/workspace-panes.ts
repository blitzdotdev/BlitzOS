import {
  normalizedWorkspaceTabs,
  isManagedWorkspaceTab,
  SESSION_TITLE_MAX_LENGTH,
  tabRegion,
  withRegion,
  type WorkspaceDrawerSegment,
  type WorkspaceRegion,
  type WorkspaceTab,
  type WorkspaceTabs,
} from './storage';

/** Panes render in this order, left to right. */
export const PANE_REGIONS: readonly WorkspaceRegion[] = ['main', 'side'];

export function regionTabs(tabs: WorkspaceTabs, region: WorkspaceRegion): WorkspaceTab[] {
  return tabs.tabs.filter((tab) => tabRegion(tab) === region);
}

/** The columns the workspace currently shows. The side pane exists only while
 * it holds tabs, so closing its last tab collapses the split. */
export function paneRegions(tabs: WorkspaceTabs): WorkspaceRegion[] {
  return regionTabs(tabs, 'side').length === 0 ? ['main'] : ['main', 'side'];
}

export function regionActiveId(tabs: WorkspaceTabs, region: WorkspaceRegion): number | null {
  return region === 'main' ? tabs.activeId : tabs.sideActiveId ?? null;
}

export function withRegionActiveId(
  tabs: WorkspaceTabs,
  region: WorkspaceRegion,
  activeId: number,
): WorkspaceTabs {
  if (!tabs.tabs.some((tab) => tab.id === activeId && tabRegion(tab) === region)) return tabs;
  return normalizedWorkspaceTabs(region === 'main'
    ? { ...tabs, activeId }
    : { ...tabs, sideActiveId: activeId });
}

export function findTab(tabs: WorkspaceTabs, id: number): WorkspaceTab | null {
  return tabs.tabs.find((tab) => tab.id === id) ?? null;
}

export function panelTab(
  tabs: WorkspaceTabs,
  panel: WorkspaceDrawerSegment,
): WorkspaceTab | null {
  return tabs.tabs.find((tab) => tab.type === 'panel' && tab.panel === panel) ?? null;
}

/** Index just past the region's last tab, so an appended tab lands at the end
 * of its own column rather than the end of the flat list. */
function appendIndex(entries: WorkspaceTab[], region: WorkspaceRegion): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (tabRegion(entries[index]!) === region) return index + 1;
  }
  return entries.length;
}

export function appendTab(
  tabs: WorkspaceTabs,
  region: WorkspaceRegion,
  createTab: (id: number) => WorkspaceTab,
): WorkspaceTabs {
  const id = tabs.nextId;
  const entries = [...tabs.tabs];
  entries.splice(appendIndex(entries, region), 0, withRegion(createTab(id), region));
  return normalizedWorkspaceTabs({
    ...tabs,
    tabs: entries,
    ...(region === 'main' ? { activeId: id } : { sideActiveId: id }),
    nextId: id + 1,
  });
}

export function closeTab(tabs: WorkspaceTabs, id: number): WorkspaceTabs {
  const closing = findTab(tabs, id);
  if (closing === null) return tabs;
  const region = tabRegion(closing);
  const siblings = regionTabs(tabs, region);
  const index = siblings.findIndex((tab) => tab.id === id);
  const remaining = siblings.filter((tab) => tab.id !== id);
  const successor = remaining[Math.min(index, remaining.length - 1)]?.id;
  const next: WorkspaceTabs = {
    ...tabs,
    tabs: tabs.tabs.filter((tab) => tab.id !== id),
  };
  if (regionActiveId(tabs, region) === id) {
    if (region === 'main') next.activeId = successor ?? null;
    else if (successor === undefined) delete next.sideActiveId;
    else next.sideActiveId = successor;
  }
  return normalizedWorkspaceTabs(next);
}

/** Applies a bounded custom label to an active managed session.
 * An empty label restores the generated provider label. */
export function renameTab(
  tabs: WorkspaceTabs,
  id: number,
  title: string | undefined,
): WorkspaceTabs {
  const normalizedTitle = title?.trim().slice(0, SESSION_TITLE_MAX_LENGTH) || undefined;
  let changed = false;
  const rename = (tab: WorkspaceTab): WorkspaceTab => {
    if (tab.id !== id || !isManagedWorkspaceTab(tab) || tab.title === normalizedTitle) return tab;
    changed = true;
    const next = { ...tab };
    if (normalizedTitle === undefined) delete next.title;
    else next.title = normalizedTitle;
    return next;
  };
  const active = tabs.tabs.map(rename);
  if (!changed) return tabs;
  return normalizedWorkspaceTabs({
    ...tabs,
    tabs: active,
  });
}

/** Brings a panel forward, opening it in the side pane when it is not open at
 * all. Never closes anything — the mobile sheet's segment strip needs a
 * selection, not a toggle. */
export function showPanelTab(
  tabs: WorkspaceTabs,
  panel: WorkspaceDrawerSegment,
): WorkspaceTabs {
  const existing = panelTab(tabs, panel);
  return existing === null
    ? appendTab(tabs, 'side', (id) => ({ id, type: 'panel', panel }))
    : withRegionActiveId(tabs, tabRegion(existing), existing.id);
}

/** The right icon strip is a toggle: the panel opens in the side pane, comes
 * forward when it is already open behind another tab, and closes when it is
 * the tab you are looking at. */
export function togglePanelTab(
  tabs: WorkspaceTabs,
  panel: WorkspaceDrawerSegment,
): WorkspaceTabs {
  const existing = panelTab(tabs, panel);
  if (existing !== null && regionActiveId(tabs, tabRegion(existing)) === existing.id) {
    return closeTab(tabs, existing.id);
  }
  return showPanelTab(tabs, panel);
}

/*
 * `moveTab` and `splitTab` were here, and they are deleted with the native tab
 * strip (plans/LODY-TERMINAL-TABS.md §4.6, "PR 2 — the deletion").
 *
 * Their only caller was the pane drag-and-drop, whose only handle was a
 * draggable tab button in that strip: no strip, no drag, no writer. What
 * survives is the PLACEMENT half of the split — `paneRegions`, `tabRegion` and
 * `withRegion` — so a document that already holds a `region: 'side'` tab still
 * draws it in the second column, exactly as §5.3 promised a rollback. What is
 * gone is the ability to MOVE a tab between the columns, which nothing could
 * reach anyway.
 */
