'use client';
import dynamic from 'next/dynamic';
import {
  Activity, Bot, Boxes, FolderGit2, FolderTree, Globe, LayoutDashboard, Rocket, Server, Settings, SquareTerminal, Workflow, type LucideIcon,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { SkeletonRows } from '@/components/ui/bits';
import type { ViewKind } from '@/lib/store';

const lazy = (load: () => Promise<{ default: ComponentType<{ id?: string }> }>) => dynamic(load, { ssr: false, loading: () => <SkeletonRows /> });

export const NAV: { kind: ViewKind; label: string; icon: LucideIcon; keys: string }[] = [
  { kind: 'overview', label: 'Overview', icon: LayoutDashboard, keys: 'o' },
  { kind: 'servers', label: 'Servers', icon: Server, keys: 's' },
  { kind: 'agents', label: 'Agents', icon: Bot, keys: 'a' },
  { kind: 'workflows', label: 'Workflows', icon: Workflow, keys: 'w' },
  { kind: 'projects', label: 'Projects', icon: FolderGit2, keys: 'p' },
  { kind: 'deployments', label: 'Deployments', icon: Rocket, keys: 'd' },
  { kind: 'browsers', label: 'Browser Sessions', icon: Globe, keys: 'b' },
  { kind: 'terminals', label: 'Terminals', icon: SquareTerminal, keys: 't' },
  { kind: 'containers', label: 'Containers', icon: Boxes, keys: 'c' },
  { kind: 'files', label: 'Files', icon: FolderTree, keys: 'f' },
  { kind: 'activity', label: 'Activity', icon: Activity, keys: 'y' },
  { kind: 'settings', label: 'Settings', icon: Settings, keys: ',' },
];

export const ICONS: Record<ViewKind, LucideIcon> = {
  ...(Object.fromEntries(NAV.map((n) => [n.kind, n.icon])) as Record<ViewKind, LucideIcon>),
  server: Server, agent: Bot, browser: Globe, terminal: SquareTerminal,
};

/** Every view is a default export taking an optional entity id, loaded on demand. */
export const VIEWS: Record<ViewKind, ComponentType<{ id?: string }>> = {
  overview: lazy(() => import('./overview')),
  servers: lazy(() => import('./servers')),
  server: lazy(() => import('./server-detail')),
  agents: lazy(() => import('./agents')),
  agent: lazy(() => import('./agent-workspace')),
  workflows: lazy(() => import('./workflows')),
  projects: lazy(() => import('./planned')),
  deployments: lazy(() => import('./planned')),
  browsers: lazy(() => import('./browsers')),
  browser: lazy(() => import('./browser-session')),
  terminals: lazy(() => import('./terminals')),
  terminal: lazy(() => import('./terminal')),
  containers: lazy(() => import('./containers')),
  files: lazy(() => import('./files')),
  activity: lazy(() => import('./activity')),
  settings: lazy(() => import('./settings')),
};
