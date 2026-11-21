'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, ChevronRight, Download, File, FileImage, FileText, Folder, FolderPlus, FolderSearch, FolderTree, Link2, MoreHorizontal, Pencil, Search, ServerOff, Trash2, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { toast } from 'sonner';
import type { FsEntry } from '@viscosity/protocol';
import { NameDialog } from '@/components/files/dialogs';
import { baseName, download, fsUrl, imageType, joinPath, parentPath } from '@/components/files/util';
import { FileViewer } from '@/components/files/viewer';
import { pickServer, ServerPicker } from '@/components/server-picker';
import { EmptyState, ErrorState, SkeletonRows, Td, Th, View } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/menu';
import { api, errMsg } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ago, bytes, dateTime } from '@/lib/format';
import { useServers } from '@/lib/queries';
import { shell, useUi } from '@/lib/store';
import type { Server } from '@/lib/types';

const iconFor = (e: FsEntry) => (e.type === 'dir' ? Folder : e.type === 'symlink' ? Link2 : imageType(e.name) ? FileImage : e.type === 'file' ? FileText : File);

function Explorer({ server }: { server: Server }) {
  const sid = server.id;
  const qc = useQueryClient();
  const roots = server.system?.roots ?? [];
  const online = server.status === 'online';
  const [root, setRoot] = useState(roots[0] ?? '/');
  const [cwd, setCwd] = useState(root);
  const [query, setQuery] = useState('');
  const [searchFor, setSearchFor] = useState('');
  // A project or agent can ask the explorer to open at a specific directory (once).
  const wanted = useUi((s) => s.filesPath);
  useEffect(() => {
    if (!wanted) return;
    const base = roots.find((r) => wanted === r || wanted.startsWith(`${r}/`));
    if (base) { setRoot(base); setCwd(wanted); }
    useUi.getState().setFilesPath(null);
  }, [wanted]); // eslint-disable-line react-hooks/exhaustive-deps
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null); // action waiting on "discard changes?"
  const [mkdir, setMkdir] = useState(false);
  const [renaming, setRenaming] = useState<FsEntry | null>(null);
  const [deleting, setDeleting] = useState<FsEntry | null>(null);
  const [replacing, setReplacing] = useState<File[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const [wide, setWide] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const selection = useUi((s) => s.selection);
  const select = useUi((s) => s.select);

  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setWide((e?.contentRect.width ?? 1000) >= 820));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  const list = useQuery({ queryKey: ['fs-list', sid, cwd], enabled: online, retry: false, queryFn: () => api<FsEntry[]>(fsUrl(sid, 'list', { path: cwd })) });
  const search = useQuery({ queryKey: ['fs-search', sid, cwd, searchFor], enabled: online && !!searchFor, retry: false, queryFn: () => api<FsEntry[]>(fsUrl(sid, 'search', { path: cwd, query: searchFor })) });
  const active = searchFor ? search : list;
  const refresh = () => qc.invalidateQueries({ queryKey: ['fs-list', sid] });
  const post = (op: string, body: unknown) => api(`/api/servers/${sid}/fs/${op}`, { body });

  /** Run an action that would drop the open editor's unsaved text only after the user agrees. */
  const guarded = (action: () => void) => (dirty ? setPending(() => action) : action());
  const navigate = (path: string) => { setSearchFor(''); setQuery(''); setCwd(path); };
  const onDirty = useCallback((d: boolean) => setDirty(d), []);

  async function open(e: FsEntry) {
    let type = e.type;
    if (type === 'symlink') {
      try { type = (await api<FsEntry>(fsUrl(sid, 'stat', { path: e.path }))).type; } catch (err) { return toast.error(`Cannot follow ${e.name}`, { description: errMsg(err) }); }
    }
    if (type === 'dir') navigate(e.path);
    else if (type === 'file') guarded(() => setOpenPath(e.path));
    else toast(`${e.name} is not a regular file`);
  }

  function pick(e: FsEntry) {
    select({ kind: 'file', id: e.path, serverId: sid, data: { Type: e.type, Size: e.type === 'dir' ? '—' : bytes(e.size), Modified: dateTime(e.mtime), Permissions: e.mode, Owner: e.owner, Server: server.name } });
    shell.showInspector();
  }

  async function upload(files: File[]) {
    const id = toast.loading(`Uploading ${files.length} file${files.length > 1 ? 's' : ''}…`);
    let done = 0;
    try {
      for (const f of files) {
        toast.loading(`Uploading ${f.name} (${done + 1}/${files.length}, ${bytes(f.size)})…`, { id });
        await api(fsUrl(sid, 'upload', { path: joinPath(cwd, f.name) }), { method: 'PUT', raw: f });
        done++;
      }
      toast.success(`Uploaded ${done} file${done > 1 ? 's' : ''} to ${cwd}`, { id });
    } catch (err) {
      toast.error(`Upload failed after ${done} of ${files.length}`, { id, description: errMsg(err) });
    }
    await refresh();
  }
  function startUpload(files: File[]) {
    if (files.length === 0) return;
    const existing = new Set(list.data?.map((e) => e.name));
    if (files.some((f) => existing.has(f.name))) setReplacing(files);
    else void upload(files);
  }

  // Beside an open file the listing is narrow: keep name, size and actions only.
  const full = (cls: string) => (openPath ? 'hidden' : cls);
  const crumbs = cwd === root ? [] : cwd.slice(root.length).split('/').filter(Boolean);
  const atRoot = cwd === root;
  const listing = (
    <div
      className={cn('relative h-full overflow-auto', dragging && 'outline outline-1 -outline-offset-4 outline-fg-3')}
      onDragOver={(e) => { if (online && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); startUpload([...e.dataTransfer.files]); }}
    >
      {searchFor ? (
        <div className="flex items-center gap-2 border-b bg-raised px-3 py-1.5 text-sm" role="status">
          <FolderSearch className="size-3.5 text-fg-3" />
          <span className="min-w-0 flex-1 truncate">{search.data ? `${search.data.length} match${search.data.length === 1 ? '' : 'es'}` : 'Searching'} for <span className="font-mono">“{searchFor}”</span> under <span className="font-mono text-fg-2">{cwd}</span></span>
          <Button size="sm" variant="ghost" onClick={() => { setSearchFor(''); setQuery(''); }}><X />Clear</Button>
        </div>
      ) : null}
      {!online ? <EmptyState icon={ServerOff} title={`${server.name} is offline`}>Files are read live from the server through its worker. They will be available again when it reconnects.</EmptyState>
        : active.isPending ? <SkeletonRows />
        : active.error ? <ErrorState error={active.error} onRetry={() => active.refetch()} />
        : active.data.length === 0 ? (
          searchFor ? <EmptyState icon={FolderSearch} title="No matches">Nothing under this folder has “{searchFor}” in its name. node_modules and .git are skipped.</EmptyState>
            : <EmptyState icon={Folder} title="This folder is empty" action={<Button onClick={() => picker.current?.click()}><Upload />Upload files</Button>}>Drop files here to upload them, or create a folder.</EmptyState>
        ) : (
          <table className="w-full border-collapse text-base">
            <thead><tr><Th>Name</Th><Th className="w-24 text-right">Size</Th><Th className={full('hidden w-28 @md:table-cell')}>Modified</Th><Th className={full('hidden w-28 @3xl:table-cell')}>Permissions</Th><Th className={full('hidden w-24 @3xl:table-cell')}>Owner</Th><Th className="w-10" /></tr></thead>
            <tbody>
              {active.data.map((e) => {
                const Icon = iconFor(e);
                const selected = selection?.kind === 'file' && selection.id === e.path;
                return (
                  <tr key={e.path} tabIndex={0} aria-selected={selected} onClick={() => pick(e)} onDoubleClick={() => void open(e)}
                    onKeyDown={(ev) => { if (ev.key === 'Enter' && ev.target === ev.currentTarget) void open(e); }}
                    className={cn('cursor-default transition-colors hover:bg-raised focus-visible:bg-raised', (selected || openPath === e.path) && 'bg-raised')}>
                    <Td>
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Icon className={cn('size-4 shrink-0', e.type === 'dir' ? 'text-fg' : 'text-fg-3')} strokeWidth={1.6} />
                        <span className="truncate font-mono text-sm">{searchFor ? e.path.slice(cwd.length).replace(/^\//, '') : e.name}</span>
                      </div>
                    </Td>
                    <Td className="tnum whitespace-nowrap text-right font-mono text-xs text-fg-2">{e.type === 'dir' ? '' : bytes(e.size)}</Td>
                    <Td className={full('hidden whitespace-nowrap text-sm text-fg-3 @md:table-cell')}><span title={dateTime(e.mtime)}>{ago(e.mtime)}</span></Td>
                    <Td className={full('hidden font-mono text-xs text-fg-3 @3xl:table-cell')}>{e.mode}</Td>
                    <Td className={full('hidden font-mono text-xs text-fg-3 @3xl:table-cell')}>{e.owner}</Td>
                    <Td className="text-right">
                      <span onClick={(ev) => ev.stopPropagation()} onDoubleClick={(ev) => ev.stopPropagation()}>
                        <Menu trigger={<Button variant="ghost" size="icon" aria-label={`Actions for ${e.name}`}><MoreHorizontal /></Button>}>
                          <MenuItem icon={e.type === 'dir' ? Folder : FileText} onSelect={() => void open(e)}>Open</MenuItem>
                          <MenuItem icon={Download} disabled={e.type !== 'file'} onSelect={() => download(sid, e.path)}>Download</MenuItem>
                          <MenuItem icon={Pencil} onSelect={() => setRenaming(e)}>Rename…</MenuItem>
                          <MenuSeparator />
                          <MenuItem icon={Trash2} danger onSelect={() => setDeleting(e)}>Delete…</MenuItem>
                        </Menu>
                      </span>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
    </div>
  );

  return (
    <div ref={box} className="flex h-full min-w-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-panel px-3 py-1.5">
        <Button variant="ghost" size="icon" aria-label="Up one folder" disabled={atRoot} onClick={() => navigate(parentPath(cwd))}><ArrowUp /></Button>
        {roots.length > 1 ? (
          <Select aria-label="Root folder" value={root} onChange={(e) => { setRoot(e.target.value); navigate(e.target.value); }} className="h-7 w-auto max-w-48 font-mono text-xs">
            {roots.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
        ) : null}
        <nav aria-label="Path" className="flex min-w-32 flex-1 items-center overflow-x-auto font-mono text-xs">
          <button onClick={() => navigate(root)} className={cn('shrink-0 rounded px-1.5 py-1 transition-colors hover:bg-hover', atRoot ? 'text-fg' : 'text-fg-3 hover:text-fg')}>{root}</button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex shrink-0 items-center">
              <ChevronRight className="size-3 text-fg-4" />
              <button onClick={() => navigate(joinPath(root, crumbs.slice(0, i + 1).join('/')))} aria-current={i === crumbs.length - 1 ? 'page' : undefined}
                className={cn('rounded px-1.5 py-1 transition-colors hover:bg-hover', i === crumbs.length - 1 ? 'text-fg' : 'text-fg-3 hover:text-fg')}>{c}</button>
            </span>
          ))}
        </nav>
        <form role="search" className="relative" onSubmit={(e) => { e.preventDefault(); setSearchFor(query.trim()); }}>
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-3" />
          <Input aria-label="Search file names in this folder" placeholder="Search names…" value={query} onChange={(e) => setQuery(e.target.value)} disabled={!online} maxLength={200} className="h-7 w-40 pl-7 text-sm" />
        </form>
        <Button size="sm" disabled={!online} onClick={() => setMkdir(true)}><FolderPlus />New folder</Button>
        <Button size="sm" disabled={!online} onClick={() => picker.current?.click()}><Upload />Upload</Button>
        <input ref={picker} type="file" multiple hidden onChange={(e) => { startUpload([...(e.target.files ?? [])]); e.target.value = ''; }} />
      </div>
      <div className="min-h-0 flex-1">
        {openPath ? (
          <Group key={wide ? 'h' : 'v'} orientation={wide ? 'horizontal' : 'vertical'} className="h-full">
            <Panel id="listing" defaultSize="42%" minSize={wide ? 240 : 120}>{listing}</Panel>
            <Separator />
            <Panel id="viewer" minSize={wide ? 320 : 160}>
              <FileViewer key={openPath} serverId={sid} path={openPath} onDirty={onDirty} onSaved={refresh} onClose={() => guarded(() => setOpenPath(null))} />
            </Panel>
          </Group>
        ) : listing}
      </div>

      <NameDialog open={mkdir} onOpenChange={setMkdir} title="New folder" label={`Folder name in ${cwd}`} initial="" submitLabel="Create folder"
        onSubmit={async (name) => { await post('mkdir', { path: joinPath(cwd, name) }); await refresh(); toast(`Created ${name}`); }} />
      <NameDialog open={!!renaming} onOpenChange={() => setRenaming(null)} title={`Rename ${renaming?.name ?? ''}`} label="New name" initial={renaming?.name ?? ''} submitLabel="Rename"
        onSubmit={async (name) => {
          const from = renaming!.path;
          const to = joinPath(parentPath(from), name);
          await post('rename', { from, to });
          if (openPath === from) setOpenPath(null); // the open editor points at a path that no longer exists
          await refresh(); await qc.invalidateQueries({ queryKey: ['fs-search', sid] });
          toast(`Renamed to ${name}`);
        }} />
      <ConfirmDialog open={!!deleting} onOpenChange={() => setDeleting(null)} title={`Delete ${deleting?.name ?? ''}?`} confirmLabel={deleting?.type === 'dir' ? 'Delete folder and contents' : 'Delete'}
        typeToConfirm={deleting?.type === 'dir' ? deleting.name : undefined}
        description={deleting?.type === 'dir'
          ? <>This permanently deletes the folder <span className="font-mono text-fg-2">{deleting.path}</span> and everything inside it on {server.name}. There is no trash.</>
          : <>This permanently deletes <span className="font-mono text-fg-2">{deleting?.path}</span> on {server.name}. There is no trash.</>}
        onConfirm={async () => {
          const e = deleting!;
          await post('delete', { path: e.path, recursive: e.type === 'dir' });
          if (openPath && (openPath === e.path || openPath.startsWith(`${e.path}/`))) setOpenPath(null);
          if (selection?.kind === 'file' && selection.id === e.path) select(null);
          await refresh(); await qc.invalidateQueries({ queryKey: ['fs-search', sid] });
          toast(`Deleted ${e.name}`);
        }} />
      <ConfirmDialog open={!!replacing} onOpenChange={() => setReplacing(null)} title="Replace existing files?" confirmLabel="Upload and replace"
        description={<>{replacing?.filter((f) => list.data?.some((e) => e.name === f.name)).map((f) => f.name).join(', ')} already exist{(replacing?.length ?? 0) === 1 ? 's' : ''} in this folder and will be overwritten.</>}
        onConfirm={() => { const files = replacing!; void upload(files); }} />
      <ConfirmDialog open={!!pending} onOpenChange={() => setPending(null)} title="Discard unsaved changes?" confirmLabel="Discard changes"
        description={<>{openPath ? baseName(openPath) : 'The open file'} has edits that have not been saved to the server.</>}
        onConfirm={() => { setDirty(false); pending?.(); }} />
    </div>
  );
}

export default function Files() {
  const servers = useServers();
  const stored = useUi((s) => s.filesServerId);
  const setFilesServer = useUi((s) => s.setFilesServer);
  const server = pickServer(servers.data, stored);
  return (
    <View flush title="Files" subtitle={server ? `${server.name}${server.system ? ` · as ${server.system.user}` : ''}` : undefined}
      actions={servers.data?.length ? <ServerPicker servers={servers.data} value={server?.id ?? null} onChange={setFilesServer} /> : null}>
      {servers.isPending ? <SkeletonRows /> : servers.error ? <ErrorState error={servers.error} onRetry={() => servers.refetch()} />
        : !server ? <EmptyState icon={FolderTree} title="No server to browse">Enroll a server first. Files are browsed live through its worker, restricted to the directories that server allows.</EmptyState>
        : !server.system ? <EmptyState icon={FolderTree} title={`${server.name} is not enrolled yet`}>Its worker has never connected, so there is nothing to browse.</EmptyState>
        : <Explorer key={server.id} server={server} />}
    </View>
  );
}
