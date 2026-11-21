'use client';
import { X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Group, Panel, Separator, TabCloseButton, Workspace, useDefaultLayout, usePanelRef, type TabNode, type WorkspaceModelInput } from 'react-resizable-panels';
import { EmptyState } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { openTab, shell, useUi, workspace, type TabData } from '@/lib/store';
import { ICONS, NAV, VIEWS } from '@/views';
import { LayoutDashboard } from 'lucide-react';
import { Inspector } from './inspector';
import { Palette } from './palette';
import { Sidebar } from './sidebar';
import { StatusBar } from './statusbar';
import { TopBar, splitActive } from './topbar';

const DEFAULT_MODEL: WorkspaceModelInput<TabData> = {
  version: 1,
  root: { type: 'tabset', keepWhenEmpty: true, selectedId: 'overview', tabs: [{ id: 'overview', title: 'Overview', data: { kind: 'overview' } }] },
};

function TabContent({ tab }: { tab: TabNode<TabData> }) {
  const View = VIEWS[tab.data.kind];
  // A layout saved by an older build may reference a view that no longer exists.
  if (!View) return <EmptyState icon={LayoutDashboard} title="Unknown view">This tab was saved by a different version. Close it to continue.</EmptyState>;
  return <View id={tab.data.id} />;
}

export default function Shell() {
  const sidebar = usePanelRef();
  const inspector = usePanelRef();
  const [narrow, setNarrow] = useState(false);
  const [palette, setPalette] = useState(false);
  const layout = useDefaultLayout({ id: 'vc-shell', storage: localStorage });
  const initial = useMemo(() => useUi.getState().model ?? DEFAULT_MODEL, []);

  useEffect(() => {
    const toggle = (p: typeof sidebar) => (p.current?.isCollapsed() ? p.current.expand() : p.current?.collapse());
    shell.toggleSidebar = () => toggle(sidebar);
    shell.toggleInspector = () => toggle(inspector);
    shell.showInspector = () => inspector.current?.isCollapsed() && inspector.current.expand();
    shell.openPalette = () => setPalette(true);
    // Small screens start with both side panels tucked away.
    if (window.innerWidth < 900) { sidebar.current?.collapse(); inspector.current?.collapse(); }
  }, [sidebar, inspector]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'k') { e.preventDefault(); setPalette((o) => !o); }
      else if (mod && e.key === 'b') { e.preventDefault(); shell.toggleSidebar(); }
      else if (mod && e.key === '.') { e.preventDefault(); shell.toggleInspector(); }
      else if (mod && e.key === '\\') { e.preventDefault(); splitActive(); }
      else if (e.altKey && e.key >= '1' && e.key <= '9') {
        // Alt+1…9 jumps to a section
        const nav = NAV[Number(e.key) - 1];
        if (nav) { e.preventDefault(); openTab({ kind: nav.kind }, nav.label); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const renderTabContent = useCallback((tab: TabNode<TabData>) => <TabContent tab={tab} />, []);

  return (
    <div className="flex h-dvh flex-col">
      <Group id="vc-shell" orientation="horizontal" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged} className="min-h-0 flex-1">
        <Panel id="sidebar" panelRef={sidebar} collapsible collapsedSize={48} minSize={176} maxSize={340} defaultSize={216}
          groupResizeBehavior="preserve-pixel-size" onResize={(s) => setNarrow(s.inPixels < 120)}>
          <Sidebar narrow={narrow} />
        </Panel>
        <Separator />
        <Panel id="main" minSize={280}>
          <div className="flex h-full min-w-0 flex-col">
            <TopBar />
            <Workspace<TabData>
              className="min-h-0 flex-1"
              workspaceRef={(h) => { workspace.current = h; }}
              defaultModel={initial}
              onModelChanged={(m) => useUi.getState().setModel(m)}
              lazyTabContent
              hiddenTabBehavior="keep-mounted" // terminals and agent streams keep their state when a tab is hidden
              classNames={{ tabset: 'vc-tabset', header: 'vc-tabheader', tabList: 'vc-tablist', tabPanels: 'vc-tabpanels', tabContent: 'vc-tabcontent', dropIndicator: 'vc-drop' }}
              renderTabContent={renderTabContent}
              renderTab={(tab, props) => {
                const Icon = ICONS[tab.data.kind] ?? LayoutDashboard;
                return (
                  <div {...props} className={cn(props.className, 'vc-tab')} title={tab.title}>
                    <Icon className="size-3.5 shrink-0" strokeWidth={1.6} />
                    <span className="truncate">{tab.title}</span>
                    <TabCloseButton className="vc-tabclose"><X className="size-3" /></TabCloseButton>
                  </div>
                );
              }}
              renderEmptyTabset={() => (
                <EmptyState icon={LayoutDashboard} title="Nothing open"
                  action={<><Button onClick={() => openTab({ kind: 'overview' }, 'Overview')}>Open overview</Button><Button variant="ghost" onClick={() => setPalette(true)}>Command palette</Button></>}>
                  Pick a section from the sidebar, or drag a tab to the edge of this area to split the workspace.
                </EmptyState>
              )}
            />
          </div>
        </Panel>
        <Separator />
        <Panel id="inspector" panelRef={inspector} collapsible collapsedSize={0} minSize={240} maxSize={520} defaultSize={300} groupResizeBehavior="preserve-pixel-size">
          <Inspector />
        </Panel>
      </Group>
      <StatusBar />
      <Palette open={palette} onOpenChange={setPalette} />
    </div>
  );
}
