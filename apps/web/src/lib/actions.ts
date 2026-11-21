'use client';
import { toast } from 'sonner';
import { api, errMsg } from './api';
import { openTab, useUi } from './store';
import type { Agent, BrowserSession, Server, Terminal } from './types';

export const openServer = (s: Pick<Server, 'id' | 'name'>, split = false) => openTab({ kind: 'server', id: s.id }, s.name, { split });
export const openAgent = (a: Pick<Agent, 'id' | 'name'>, split = false) => openTab({ kind: 'agent', id: a.id }, a.name, { split });
export const openBrowser = (b: Pick<BrowserSession, 'id' | 'name'>, split = false) => openTab({ kind: 'browser', id: b.id }, b.name, { split });
export const openTerminalTab = (t: Pick<Terminal, 'id' | 'title'>, split = false) => openTab({ kind: 'terminal', id: t.id }, t.title, { split });

export async function newTerminal(server: Pick<Server, 'id' | 'name'>, cwd?: string) {
  try {
    const t = await api<Terminal>(`/api/servers/${server.id}/terminals`, { body: cwd ? { cwd } : {} });
    openTerminalTab(t);
  } catch (e) {
    toast.error(`Could not open a terminal on ${server.name}`, { description: errMsg(e) });
  }
}

export function openFiles(serverId: string, path?: string) {
  useUi.getState().setFilesServer(serverId);
  if (path) useUi.getState().setFilesPath(path);
  openTab({ kind: 'files' }, 'Files');
}

/** Open a section and ask it to start an action (e.g. show its "new" dialog). */
export function openWithIntent(kind: 'servers' | 'agents' | 'browsers' | 'projects' | 'deployments', title: string, intent: string) {
  useUi.getState().setIntent(intent);
  openTab({ kind }, title);
}

/** Resolve "agent:<id>" / "server:<id>" / "browser:<id>" links carried by alerts. */
export function openLink(link: string | null, title: string) {
  const m = /^(agent|server|browser|project|deployment):(.+)$/.exec(link ?? '');
  if (m) openTab({ kind: m[1] as 'agent' | 'server' | 'browser' | 'project' | 'deployment', id: m[2] }, title);
}
