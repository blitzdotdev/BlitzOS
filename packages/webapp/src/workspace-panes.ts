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

export function otherRegion(region: WorkspaceRegion): WorkspaceRegion {
  return region === 'main' ? 'side' : 'main';
}

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

/** Files opens files beside itself: a file tab joins the pane hosting the Files
 * panel, not whichever pane last had focus. */
export function filesHostRegion(tabs: WorkspaceTabs): WorkspaceRegion {
  const files = panelTab(tabs, 'files');
  return files === null ? 'main' : tabRegion(files);
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

/** Moves a managed terminal/chat session out of the pane layout without
 * destroying the underlying runtime session. */
export function archiveTab(tabs: WorkspaceTabs, id: number): WorkspaceTabs {
  const tab = findTab(tabs, id);
  if (tab === null || !isManagedWorkspaceTab(tab)) return tabs;
  const closed = closeTab(tabs, id);
  return normalizedWorkspaceTabs({
    ...closed,
    archivedTabs: [...(tabs.archivedTabs ?? []), tab],
  });
}

/** Restores an archived session into the pane it previously occupied and
 * selects it. Normalization promotes a lone side-pane tab into main. */
export function restoreTab(tabs: WorkspaceTabs, id: number): WorkspaceTabs {
  const archivedTabs = tabs.archivedTabs ?? [];
  const tab = archivedTabs.find((entry) => entry.id === id);
  if (tab === undefined) return tabs;
  const region = tabRegion(tab);
  const entries = [...tabs.tabs];
  entries.splice(appendIndex(entries, region), 0, tab);
  const remaining = archivedTabs.filter((entry) => entry.id !== id);
  return normalizedWorkspaceTabs({
    ...tabs,
    tabs: entries,
    archivedTabs: remaining,
    ...(region === 'main' ? { activeId: id } : { sideActiveId: id }),
  });
}

/** Removes a cockpit tab record. This does not claim to erase provider-native
 * transcripts or other runtime artifacts. */
export function removeTabPermanently(tabs: WorkspaceTabs, id: number): WorkspaceTabs {
  if (tabs.tabs.some((tab) => tab.id === id)) return closeTab(tabs, id);
  const archivedTabs = tabs.archivedTabs ?? [];
  if (!archivedTabs.some((tab) => tab.id === id)) return tabs;
  return normalizedWorkspaceTabs({
    ...tabs,
    archivedTabs: archivedTabs.filter((tab) => tab.id !== id),
  });
}

/** Applies a bounded custom label to an active or archived managed session.
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
  const archived = (tabs.archivedTabs ?? []).map(rename);
  if (!changed) return tabs;
  return normalizedWorkspaceTabs({
    ...tabs,
    tabs: active,
    archivedTabs: archived,
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

/** Moves a tab into `region`, landing before `beforeId` when the drop named an
 * insertion point and at the end of that column otherwise. */
export function moveTab(
  tabs: WorkspaceTabs,
  id: number,
  region: WorkspaceRegion,
  beforeId: number | null,
): WorkspaceTabs {
  const moving = findTab(tabs, id);
  if (moving === null) return tabs;
  const from = tabRegion(moving);
  const entries = tabs.tabs.filter((tab) => tab.id !== id);
  const anchor = beforeId === null ? -1 : entries.findIndex((tab) => tab.id === beforeId);
  entries.splice(anchor < 0 ? appendIndex(entries, region) : anchor, 0, withRegion(moving, region));
  const next: WorkspaceTabs = { ...tabs, tabs: entries };
  if (from === 'main' && tabs.activeId === id) next.activeId = null;
  if (from === 'side' && tabs.sideActiveId === id) delete next.sideActiveId;
  if (region === 'main') next.activeId = id;
  else next.sideActiveId = id;
  return normalizedWorkspaceTabs(next);
}

/** An edge drop claims a whole column. Dropping a tab on the edge of the pane
 * it already owns pushes its neighbours to the other column instead — the
 * dragged tab keeps the half the landing rectangle showed. */
export function splitTab(
  tabs: WorkspaceTabs,
  id: number,
  region: WorkspaceRegion,
): WorkspaceTabs {
  const moving = findTab(tabs, id);
  if (moving === null) return tabs;
  if (tabRegion(moving) !== region) return moveTab(tabs, id, region, null);
  const away = otherRegion(region);
  if (regionTabs(tabs, away).length > 0) return moveTab(tabs, id, region, null);
  const entries = tabs.tabs.map(
    (tab) => (tab.id === id ? tab : withRegion(tab, away)),
  );
  const displaced = entries.filter((tab) => tab.id !== id);
  const keptActive = regionActiveId(tabs, region);
  const movedActive = displaced.some((tab) => tab.id === keptActive)
    ? keptActive ?? undefined
    : displaced.at(-1)?.id;
  const next: WorkspaceTabs = { ...tabs, tabs: entries };
  if (region === 'main') {
    next.activeId = id;
    if (movedActive !== undefined) next.sideActiveId = movedActive;
  } else {
    next.sideActiveId = id;
    next.activeId = movedActive ?? null;
  }
  return normalizedWorkspaceTabs(next);
}
