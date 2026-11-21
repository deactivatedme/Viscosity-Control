'use client';
import { useQuery } from '@tanstack/react-query';
import { FileDiff, FileText, RefreshCw, TerminalSquare } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import type { GitStatus } from '@viscosity/protocol';
import { EmptyState, Skeleton } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { api, errMsg } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { Agent, AgentEnvelope } from '@/lib/types';
import { buildItems, toolSummary } from './stream';

export type PanelTab = 'changes' | 'commands' | 'files';

export function Diff({ text }: { text: string }) {
  return (
    <pre className="overflow-x-auto py-2 font-mono text-xs leading-[1.55]">
      {text.split('\n').map((line, i) => {
        const add = line.startsWith('+') && !line.startsWith('+++');
        const del = line.startsWith('-') && !line.startsWith('---');
        const head = /^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line);
        return (
          <span key={i} className={cn('block min-w-max px-3',
            add && 'bg-white/[0.07] text-fg', del && 'text-fg-3 line-through decoration-fg-4',
            head && 'text-fg-2', line.startsWith('diff --git') && 'mt-2 border-t pt-2 font-medium text-fg first:mt-0 first:border-0 first:pt-0',
            line.startsWith('@@') && 'text-fg-4', !add && !del && !head && !line.startsWith('@@') && 'text-fg-3')}>
            {line || ' '}
          </span>
        );
      })}
    </pre>
  );
}

function Changes({ agent }: { agent: Agent }) {
  const git = useQuery({
    queryKey: ['agent-git', agent.id],
    queryFn: () => api<{ status: GitStatus; diff: string; truncated: boolean }>(`/api/agents/${agent.id}/git`),
    retry: false,
  });
  // A finished run is exactly when the working tree is worth re-reading.
  const { refetch } = git;
  useEffect(() => { void refetch(); }, [agent.status, refetch]);

  const head = (
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b px-3 text-xs text-fg-3">
      <span className="truncate font-mono">{git.data?.status.isRepo ? `${git.data.status.branch ?? 'detached'} · ${git.data.status.files.length} changed` : (agent.worktreePath ?? agent.cwd)}</span>
      <Button variant="ghost" size="icon" aria-label="Refresh changes" loading={git.isFetching} onClick={() => git.refetch()}>{git.isFetching ? null : <RefreshCw />}</Button>
    </div>
  );
  let body;
  if (git.isPending) body = <div className="space-y-2 p-3"><Skeleton /><Skeleton className="w-2/3" /><Skeleton className="h-24" /></div>;
  else if (git.error) body = (
    <EmptyState icon={FileDiff} title="Changes unavailable">
      {agent.serverOnline ? errMsg(git.error) : 'The server is offline, so its working tree cannot be read right now.'}
    </EmptyState>
  );
  else if (!git.data.status.isRepo) body = <EmptyState icon={FileDiff} title="Not a git repository">The agent&apos;s working directory is not under version control, so there is no diff to show.</EmptyState>;
  else if (git.data.status.files.length === 0) body = <EmptyState icon={FileDiff} title="No changes">The working tree is clean.</EmptyState>;
  else body = (
    <div className="min-h-0 flex-1 overflow-auto">
      <ul className="border-b px-3 py-2">
        {git.data.status.files.map((f) => (
          <li key={f.path} className="flex gap-2 py-0.5 font-mono text-xs"><span className="w-5 shrink-0 text-fg-3">{f.status}</span><span className="break-all">{f.path}</span></li>
        ))}
      </ul>
      {git.data.diff ? <Diff text={git.data.diff.replace(/\n$/, '')} /> : <p className="p-3 text-xs text-fg-3">No diff against HEAD (changes are untracked files only).</p>}
      {git.data.truncated ? <p className="border-t px-3 py-2 text-xs text-fg-3">The diff was truncated by the worker. Open a terminal to see all of it.</p> : null}
    </div>
  );
  return <>{head}{body}</>;
}

function Commands({ agent, events }: { agent: Agent; events: AgentEnvelope[] }) {
  const cmds = useMemo(() => buildItems(events).flatMap((it) =>
    it.kind === 'tool' && typeof (it.use.input as { command?: unknown })?.command === 'string' ? [it] : []), [events]);
  if (agent.provider === 'custom')
    return (
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <p className="mb-2 text-xs text-fg-3">Custom agents run one process. Its argv (no shell), with the task appended as the last argument:</p>
        <pre className="whitespace-pre-wrap break-all rounded-md border bg-panel px-3 py-2 font-mono text-xs text-fg-2">{[...(agent.command ?? []), agent.task].map((a) => JSON.stringify(a)).join(' ')}</pre>
        <p className="mt-2 text-xs text-fg-3">Its output is in the conversation stream.</p>
      </div>
    );
  if (cmds.length === 0) return <EmptyState icon={TerminalSquare} title="No commands yet">Shell commands the agent runs appear here with their output.</EmptyState>;
  return (
    <ol className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
      {cmds.map((c) => (
        <li key={c.seq}>
          <pre className="whitespace-pre-wrap break-all rounded-t-md border bg-panel px-3 py-1.5 font-mono text-xs"><span className="select-none text-fg-4">$ </span>{toolSummary(c.use.input)}</pre>
          <pre className={cn('max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-b-md border border-t-0 px-3 py-1.5 font-mono text-xs', c.result?.isError ? 'text-fg' : 'text-fg-3')}>
            {!c.result ? 'running…' : (c.result.isError ? '[failed]\n' : '') + (c.result.output || '(no output)')}
          </pre>
        </li>
      ))}
    </ol>
  );
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
function Files({ events }: { events: AgentEnvelope[] }) {
  const files = useMemo(() => {
    const m = new Map<string, { kinds: Set<string>; count: number }>();
    const add = (path: string, kind: string, count: boolean) => {
      const e = m.get(path) ?? { kinds: new Set<string>(), count: 0 };
      e.kinds.add(kind);
      if (count) e.count++;
      m.set(path, e);
    };
    for (const { event } of events) {
      if (event.type === 'file_change') add(event.path, event.kind, true);
      // Claude edits also arrive as file_change; the tool input only fills gaps, so it is not double-counted.
      else if (event.type === 'tool_use' && EDIT_TOOLS.has(event.name)) {
        const p = (event.input as { file_path?: unknown; notebook_path?: unknown } | null);
        const path = typeof p?.file_path === 'string' ? p.file_path : typeof p?.notebook_path === 'string' ? p.notebook_path : null;
        if (path) add(path, event.name === 'Write' ? 'write' : 'edit', false);
      }
    }
    return [...m.entries()];
  }, [events]);
  if (files.length === 0)
    return <EmptyState icon={FileText} title="No file edits reported">Files the agent edits through its tools are listed here. Changes made by shell commands show up under Changes instead.</EmptyState>;
  return (
    <ul className="min-h-0 flex-1 overflow-auto p-3">
      {files.map(([path, f]) => (
        <li key={path} className="flex items-baseline gap-3 border-b py-1.5 last:border-0">
          <span className="min-w-0 flex-1 break-all font-mono text-xs">{path}</span>
          <span className="shrink-0 text-xs text-fg-3">{[...f.kinds].join(', ')}{f.count > 1 ? ` ×${f.count}` : ''}</span>
        </li>
      ))}
    </ul>
  );
}

export function SidePanel({ tab, agent, events }: { tab: PanelTab; agent: Agent; events: AgentEnvelope[] }) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {tab === 'changes' ? <Changes agent={agent} /> : tab === 'commands' ? <Commands agent={agent} events={events} /> : <Files events={events} />}
    </div>
  );
}
