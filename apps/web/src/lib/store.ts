'use client';
import type { WorkspaceImperativeHandle, WorkspaceModel } from 'react-resizable-panels';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ViewKind =
  | 'overview' | 'servers' | 'server' | 'agents' | 'agent' | 'workflows' | 'projects' | 'project' | 'deployments' | 'deployment'
  | 'browsers' | 'browser' | 'terminals' | 'terminal' | 'containers' | 'files' | 'activity' | 'settings';
export interface TabData { kind: ViewKind; id?: string }
export interface Selection { kind: 'server' | 'agent' | 'browser' | 'file' | 'container' | 'process'; id: string; serverId?: string; data?: unknown }

interface UiState {
  model: WorkspaceModel<TabData> | null;
  selection: Selection | null;
  terminal: { fontSize: number; fontFamily: string };
  filesServerId: string | null;
  /** Directory the Files view should open next (consumed once by the view). */
  filesPath: string | null;
  setFilesPath: (p: string | null) => void;
  /** One-shot request for a view to do something on arrival, e.g. 'add-server' or 'new-agent'. */
  intent: string | null;
  setIntent: (i: string | null) => void;
  setModel: (m: WorkspaceModel<TabData>) => void;
  select: (s: Selection | null) => void;
  setTerminal: (t: Partial<UiState['terminal']>) => void;
  setFilesServer: (id: string | null) => void;
}

/** UI preferences only (layout, fonts). Persisted locally for instant restore and mirrored to the server per user. */
export const useUi = create<UiState>()(
  persist(
    (set) => ({
      model: null,
      selection: null,
      terminal: { fontSize: 13, fontFamily: 'Geist Mono' },
      filesServerId: null,
      filesPath: null,
      setFilesPath: (filesPath) => set({ filesPath }),
      intent: null,
      setIntent: (intent) => set({ intent }),
      setModel: (model) => set({ model }),
      select: (selection) => set({ selection }),
      setTerminal: (t) => set((s) => ({ terminal: { ...s.terminal, ...t } })),
      setFilesServer: (filesServerId) => set({ filesServerId }),
    }),
    { name: 'vc-ui', version: 1, partialize: ({ model, terminal, filesServerId }) => ({ model, terminal, filesServerId }) },
  ),
);

/** Imperative handle of the mounted workspace; set by <Shell>. */
export const workspace: { current: WorkspaceImperativeHandle<TabData> | null } = { current: null };

export const tabId = (d: TabData) => (d.id ? `${d.kind}:${d.id}` : d.kind);

/** The tabset the user last touched, or the first one if they have not touched any yet. */
export function activeTabset(ws: WorkspaceImperativeHandle<TabData>): string | undefined {
  const first = (n: WorkspaceModel<TabData>['root']): string | undefined => (n.type === 'split' ? n.children.map(first).find(Boolean) : n.id);
  const model = ws.getModel();
  const active = ws.getActiveTabsetId();
  const exists = (n: WorkspaceModel<TabData>['root']): boolean => (n.type === 'split' ? n.children.some(exists) : n.id === active);
  return active && exists(model.root) ? active : first(model.root);
}

/** Open (or focus) a tab. `split` opens it beside the active tabset. */
export function openTab(data: TabData, title: string, opts: { split?: boolean } = {}) {
  const ws = workspace.current;
  if (!ws) return;
  const id = tabId(data);
  const tabsetId = activeTabset(ws);
  if (opts.split && tabsetId) ws.addTab({ id, title, data }, { target: { region: 'right', tabsetId } });
  else ws.addTab({ id, title, data }, tabsetId ? { tabsetId } : undefined);
  ws.selectTab(id);
}
export const closeTab = (data: TabData) => workspace.current?.closeTab(tabId(data));
export const renameTab = (data: TabData, title: string) => workspace.current?.updateTab(tabId(data), { title });

/** Shell-level actions, registered by <Shell> so the palette and views can trigger them. */
export const shell = { toggleSidebar: () => {}, toggleInspector: () => {}, showInspector: () => {}, openPalette: () => {} };

/** Kinds of the tabs currently selected in any tabset (for sidebar highlighting). */
export function selectedKinds(model: WorkspaceModel<TabData> | null): Set<string> {
  const out = new Set<string>();
  const walk = (n: WorkspaceModel<TabData>['root']) => {
    if (n.type === 'split') return n.children.forEach(walk);
    const tab = n.tabs.find((t) => t.id === n.selectedId) ?? n.tabs[0];
    if (tab) out.add(tab.data.kind);
  };
  if (model) walk(model.root);
  return out;
}
