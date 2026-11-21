'use client';
import Editor, { loader, type BeforeMount, type OnMount } from '@monaco-editor/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Download, FileWarning, Save, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/menu';
import { api, ApiError, errMsg } from '@/lib/api';
import { bytes } from '@/lib/format';
import { baseName, download, fsUrl, imageType } from './util';

// Self-hosted Monaco (copied to public/ by scripts/copy-monaco.mjs) — nothing is fetched from a CDN.
loader.config({ paths: { vs: '/monaco/vs' } });

type ReadResult = { binary: true; size: number } | { binary: false; content: string; size: number };

const beforeMount: BeforeMount = (monaco) =>
  monaco.editor.defineTheme('viscosity', {
    base: 'vs-dark',
    inherit: false,
    rules: [
      { token: '', foreground: 'c9c9cd' },
      { token: 'comment', foreground: '6c6c72', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'ffffff', fontStyle: 'bold' },
      { token: 'string', foreground: 'a3a3a8' },
      { token: 'number', foreground: 'ededee' },
      { token: 'type', foreground: 'ededee' },
      { token: 'tag', foreground: 'ffffff' },
      { token: 'attribute.name', foreground: 'b4b4b9' },
      { token: 'delimiter', foreground: '8f8f95' },
    ],
    colors: {
      // bracket-pair colouring defaults to gold/pink/blue; keep every level grey
      ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`editorBracketHighlight.foreground${n}`, '#a3a3a8'])), 'editorBracketHighlight.unexpectedBracket.foreground': '#ffffff',
      'editor.background': '#09090a', 'editor.foreground': '#c9c9cd', 'editorLineNumber.foreground': '#47474c', 'editorLineNumber.activeForeground': '#a3a3a8',
      'editor.lineHighlightBackground': '#111113', 'editor.lineHighlightBorder': '#00000000', 'editor.selectionBackground': '#ffffff2e', 'editor.inactiveSelectionBackground': '#ffffff1a',
      'editorCursor.foreground': '#ededee', 'editorIndentGuide.background1': '#1a1a1d', 'editorIndentGuide.activeBackground1': '#2e2e32', 'editorWidget.background': '#141416',
      'editorWidget.border': '#2e2e32', 'input.background': '#09090a', 'input.border': '#2e2e32', 'focusBorder': '#6c6c72', 'scrollbarSlider.background': '#2a2a2e80',
      'scrollbarSlider.hoverBackground': '#3a3a3f', 'editorBracketMatch.background': '#ffffff14', 'editorBracketMatch.border': '#6c6c72', 'editor.findMatchBackground': '#ffffff40',
      'editor.findMatchHighlightBackground': '#ffffff1f', 'editorGutter.background': '#09090a', 'list.hoverBackground': '#1a1a1d', 'list.activeSelectionBackground': '#222225',
    },
  });

function ImagePreview({ serverId, path }: { serverId: string; path: string }) {
  // Fetched as a blob so the right MIME type can be applied (the download endpoint serves octet-stream).
  const img = useQuery({
    queryKey: ['fs-image', serverId, path], staleTime: 0, gcTime: 0,
    queryFn: async () => {
      const res = await fetch(fsUrl(serverId, 'download', { path }), { credentials: 'same-origin' });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? res.statusText);
      return URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: imageType(path) }));
    },
  });
  useEffect(() => () => { if (img.data) URL.revokeObjectURL(img.data); }, [img.data]);
  if (img.isPending) return <SkeletonRows rows={3} />;
  if (img.error) return <ErrorState error={img.error} onRetry={() => img.refetch()} />;
  return (
    <div className="flex h-full items-center justify-center overflow-auto p-6 [background:repeating-conic-gradient(#111113_0%_25%,#09090a_0%_50%)_50%/20px_20px]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={img.data} alt={baseName(path)} className="max-h-full max-w-full object-contain" />
    </div>
  );
}

/** Editor / preview for one remote file. The parent owns "discard unsaved changes?" via onDirty + onClose. */
export function FileViewer({ serverId, path, onClose, onDirty, onSaved }: {
  serverId: string; path: string; onClose: () => void; onDirty: (dirty: boolean) => void; onSaved: () => void;
}) {
  const isImage = !!imageType(path);
  const file = useQuery({
    queryKey: ['fs-read', serverId, path], enabled: !isImage, staleTime: 0, gcTime: 0, retry: false,
    queryFn: () => api<ReadResult>(fsUrl(serverId, 'read', { path })),
  });
  const [content, setContent] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    if (file.data && !file.data.binary) { setContent(file.data.content); setSaved(file.data.content); }
  }, [file.data]);
  const dirty = content !== null && content !== saved;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  const save = useMutation({
    mutationFn: (text: string) => api(`/api/servers/${serverId}/fs/write`, { method: 'PUT', body: { path, content: text } }).then(() => text),
    onSuccess: (text) => { setSaved(text); toast(`Saved ${baseName(path)}`); onSaved(); },
    onError: (e) => toast.error(`Could not save ${baseName(path)}`, { description: errMsg(e) }),
  });
  // Monaco's Ctrl/Cmd+S command is registered once; it must always see the latest text.
  const latest = useRef({ content, dirty, save: save.mutate });
  latest.current = { content, dirty, save: save.mutate };
  const onMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const l = latest.current;
      if (l.dirty && l.content !== null) l.save(l.content);
    });
    editor.focus();
  };

  const tooLarge = file.error instanceof ApiError && file.error.status === 413;
  const dl = <Button size="sm" onClick={() => download(serverId, path)}><Download />Download</Button>;
  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-panel pl-3 pr-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>
          {baseName(path)}
          {dirty ? <span className="ml-2 inline-block size-1.5 rounded-full bg-fg align-middle" role="status" aria-label="Unsaved changes" title="Unsaved changes" /> : null}
          <span className="ml-2 text-fg-3">{file.data ? bytes(file.data.size) : ''}</span>
        </span>
        {content !== null ? (
          <Tip label="Save (Ctrl/⌘ S)"><Button size="sm" variant={dirty ? 'primary' : 'ghost'} disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(content)}><Save />Save</Button></Tip>
        ) : null}
        <Button size="icon" variant="ghost" aria-label="Download file" onClick={() => download(serverId, path)}><Download /></Button>
        <Button size="icon" variant="ghost" aria-label="Close file" onClick={onClose}><X /></Button>
      </div>
      <div className="min-h-0 flex-1">
        {isImage ? <ImagePreview serverId={serverId} path={path} />
          : file.isPending ? <SkeletonRows />
          : tooLarge ? <EmptyState icon={FileWarning} title="Too large for the editor" action={dl}>{errMsg(file.error)}</EmptyState>
          : file.error ? <ErrorState error={file.error} onRetry={() => file.refetch()} />
          : file.data.binary ? <EmptyState icon={FileWarning} title="Binary file" action={dl}>This file is not text ({bytes(file.data.size)}), so it cannot be edited here.</EmptyState>
          : content !== null ? (
            <Editor theme="viscosity" path={`${serverId}${path}`} value={content} onChange={(v) => setContent(v ?? '')} beforeMount={beforeMount} onMount={onMount} loading={<SkeletonRows />}
              options={{ fontSize: 13, fontFamily: 'var(--font-geist-mono), ui-monospace, monospace', minimap: { enabled: false }, scrollBeyondLastLine: false, bracketPairColorization: { enabled: false }, // coloured brackets would break the monochrome theme
                renderLineHighlight: 'line', padding: { top: 10 }, automaticLayout: true, tabSize: 2 }} />
          ) : null}
      </div>
    </div>
  );
}
