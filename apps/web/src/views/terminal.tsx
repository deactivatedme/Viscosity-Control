'use client';
import '@xterm/xterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import { Loader2, Plus, RotateCw, ServerOff, SquareTerminal, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { newTerminal } from '@/lib/actions';
import { useServers, useTerminals } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { wsOrigin } from '@/lib/ws';

type Phase =
  | { s: 'connecting' } | { s: 'online' } | { s: 'offline' }
  | { s: 'exited'; exitCode: number | null; reason?: string | null }
  | { s: 'error'; message: string };

// Monochrome ANSI palette: the 8 colours become 8 grey levels (bright variants are lighter).
const GREYS = ['#1d1d20', '#8f8f95', '#b4b4b9', '#c9c9cd', '#7c7c82', '#a3a3a8', '#bebec3', '#dcdcde'];
const BRIGHT = ['#47474c', '#a9a9ae', '#cdcdd1', '#e0e0e2', '#98989d', '#bcbcc1', '#d6d6d9', '#ffffff'];
const NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;
const THEME = {
  background: '#09090a', foreground: '#ededee', cursor: '#ededee', cursorAccent: '#09090a', selectionBackground: 'rgba(255,255,255,0.2)',
  ...Object.fromEntries(NAMES.flatMap((n, i) => [[n, GREYS[i]], [`bright${n[0]!.toUpperCase()}${n.slice(1)}`, BRIGHT[i]]])),
};
const MAX_FAILED_CONNECTS = 6;

/** xterm needs a concrete family name; "Geist Mono" is exposed by next/font only as a CSS variable. */
function resolveFont(family: string) {
  const geist = getComputedStyle(document.documentElement).getPropertyValue('--font-geist-mono').trim();
  return `${family === 'Geist Mono' && geist ? geist : `"${family}"`}, ui-monospace, Menlo, monospace`;
}

export default function TerminalView({ id }: { id?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const [phase, setPhase] = useState<Phase>({ s: 'connecting' });
  const [attempt, setAttempt] = useState(0); // bumping it reconnects after an error
  const font = useUi((s) => s.terminal);

  // Remember which server this shell lives on (the row disappears from the open list once it exits).
  const row = useTerminals().data?.find((t) => t.id === id);
  const serverId = useRef<string | null>(null);
  if (row) serverId.current = row.serverId;
  const servers = useServers().data;

  useEffect(() => {
    const el = host.current;
    if (!el || !id) return;
    const { fontSize, fontFamily } = useUi.getState().terminal;
    const xt = new XTerm({ theme: THEME, fontSize, fontFamily: resolveFont(fontFamily), cursorBlink: true, scrollback: 5000, allowProposedApi: false });
    const fitter = new FitAddon();
    xt.loadAddon(fitter);
    xt.open(el);
    term.current = xt;
    fit.current = fitter;

    let ws: WebSocket | null = null;
    let disposed = false;
    let exited = false;
    let online = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const encoder = new TextEncoder();
    const sendSize = () => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: 'resize', cols: xt.cols, rows: xt.rows }));
    // Hidden tabs stay mounted at 0×0; fitting then would collapse the PTY to a 2-column window.
    const doFit = () => { if (el.clientWidth > 40 && el.clientHeight > 20) fitter.fit(); };

    const connect = () => {
      ws = new WebSocket(`${wsOrigin()}/ws/terminal/${id}`);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => { failures = 0; doFit(); sendSize(); };
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') return xt.write(new Uint8Array(e.data as ArrayBuffer));
        const msg = JSON.parse(e.data) as { t: string; online?: boolean; exitCode?: number | null; reason?: string | null; message?: string };
        if (msg.t === 'reset') xt.reset(); // scrollback replay follows
        else if (msg.t === 'status') { online = !!msg.online; setPhase({ s: online ? 'online' : 'offline' }); if (online) sendSize(); }
        else if (msg.t === 'exit') { exited = true; online = false; setPhase({ s: 'exited', exitCode: msg.exitCode ?? null, reason: msg.reason }); }
        else if (msg.t === 'error') setPhase({ s: 'error', message: msg.message ?? 'terminal error' });
      };
      ws.onclose = () => {
        online = false;
        if (disposed || exited) return;
        if (++failures > MAX_FAILED_CONNECTS) return setPhase({ s: 'error', message: 'Could not reach the terminal session. It may have been closed, or the control plane is unreachable.' });
        setPhase({ s: 'connecting' });
        timer = setTimeout(connect, Math.min(8000, 400 * 2 ** failures));
      };
    };

    const onData = xt.onData((d) => { if (online && ws?.readyState === WebSocket.OPEN) ws.send(encoder.encode(d)); });
    const onResize = xt.onResize(sendSize);
    const ro = new ResizeObserver(doFit);
    ro.observe(el);
    setPhase({ s: 'connecting' });
    connect();
    xt.focus();

    return () => {
      disposed = true;
      clearTimeout(timer);
      ro.disconnect();
      onData.dispose();
      onResize.dispose();
      ws?.close();
      xt.dispose();
      term.current = null;
      fit.current = null;
    };
  }, [id, attempt]);

  // Live font changes from Settings.
  useEffect(() => {
    const xt = term.current;
    if (!xt) return;
    xt.options.fontSize = font.fontSize;
    xt.options.fontFamily = resolveFont(font.fontFamily);
    if (host.current && host.current.clientWidth > 40) fit.current?.fit();
  }, [font]);

  const server = servers?.find((s) => s.id === serverId.current);
  const again = server ? <Button size="sm" onClick={() => newTerminal(server)}><Plus />New terminal on {server.name}</Button> : null;

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      <div className="relative min-h-0 flex-1">
        <div ref={host} className="absolute inset-0" aria-label={row?.title ?? 'Terminal'} />
        {phase.s === 'exited' || phase.s === 'error' ? (
          <div role="status" className="absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-3 border-t border-line-strong bg-panel/95 px-4 py-3 backdrop-blur animate-in">
            {phase.s === 'exited' ? <SquareTerminal className="size-4 text-fg-2" strokeWidth={1.6} /> : <TriangleAlert className="size-4" strokeWidth={1.6} />}
            <div className="min-w-0 flex-1 text-sm">
              {phase.s === 'exited' ? (
                <>
                  <span className="font-medium">Session ended</span>
                  <span className="ml-2 font-mono text-xs text-fg-3">{phase.exitCode == null ? 'no exit status' : `exit code ${phase.exitCode}`}</span>
                  {phase.reason ? <p className="text-xs text-fg-3">{phase.reason}</p> : null}
                </>
              ) : <><span className="font-medium">Terminal error</span><p className="break-words font-mono text-xs text-fg-2">{phase.message}</p></>}
            </div>
            {phase.s === 'error' ? <Button size="sm" onClick={() => setAttempt((a) => a + 1)}><RotateCw />Retry</Button> : null}
            {again}
          </div>
        ) : null}
      </div>
      <div className="flex h-6 shrink-0 items-center gap-3 border-t bg-panel px-3 font-mono text-2xs text-fg-3" role="status">
        {phase.s === 'connecting' && <span className="flex items-center gap-1.5"><Loader2 className="size-3 animate-spin" />connecting…</span>}
        {phase.s === 'online' && <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-fg" />connected</span>}
        {phase.s === 'offline' && <span className="flex items-center gap-1.5 text-fg"><ServerOff className="size-3" />server offline — input is paused; the shell keeps running and resumes when the server reconnects</span>}
        {phase.s === 'exited' && <span>ended</span>}
        {phase.s === 'error' && <span className="text-fg">error</span>}
        <span className="ml-auto truncate">{row ? `${row.title}${row.shell ? ` · ${row.shell}` : ''}` : ''}</span>
      </div>
    </div>
  );
}
