import { useState, useCallback, useEffect, useRef } from 'react';
import RunTable from './components/RunTable';
import FieldSelector, { type FieldSelectorHandle } from './components/FieldSelector';
import VisualizationPanel from './components/VisualizationPanel';
import type { Panel, XYTrace } from './types';

export default function App() {
  const DEFAULT_SERVER = 'http://nefarian.xray.aps.anl.gov:8000';
  const toProxyUrlStatic = (url: string) =>
    url.replace(/^(https?):\/\//, `${window.location.origin}/tiled-proxy/$1/`);

  const [serverUrl, setServerUrl] = useState(() => toProxyUrlStatic(DEFAULT_SERVER));
  const [inputUrl, setInputUrl] = useState(DEFAULT_SERVER);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(380);
  const [runsHeight, setRunsHeight] = useState(() => Math.round((window.innerHeight - 64) * 3 / 5));
  const [catalogs, setCatalogs] = useState<string[]>([]);
  const [selectedCatalog, setSelectedCatalog] = useState('');
  const [selectedRunId, setSelectedRunId] = useState('');
  const [selectedRunLabel, setSelectedRunLabel] = useState('');
  const [selectedRunDetectors, setSelectedRunDetectors] = useState<string[]>([]);
  const [selectedRunMotors, setSelectedRunMotors] = useState<string[]>([]);
  const [runPage, setRunPage] = useState(0);
  const fieldSelectorRef = useRef<FieldSelectorHandle>(null);

  const toProxyUrl = toProxyUrlStatic;

  const handleConnect = () => {
    setSelectedCatalog('');
    setSelectedRunId('');
    setSelectedRunLabel('');
    setServerUrl(toProxyUrl(inputUrl));
  };

  // Fetch top-level catalog names whenever the server changes
  useEffect(() => {
    if (!serverUrl) return;
    setCatalogs([]);
    fetch(`${serverUrl}/api/v1/search/`)
      .then((r) => r.json())
      .then((json) => {
        const names: string[] = (json.data ?? []).map((item: { id: string }) => item.id);
        setCatalogs(names);
      })
      .catch(() => {});
  }, [serverUrl]);

  const plot = useCallback((traces: XYTrace[], title: string) => {
    setPanel({ id: crypto.randomUUID(), type: 'xy' as const, traces, title });
  }, []);

  const livePlot = useCallback((traces: XYTrace[], title: string, stream: string, dataSubNode: string, dataNodeFamily: 'array' | 'table') => {
    setPanel({
      id: crypto.randomUUID(), type: 'xy' as const, traces, title,
      liveConfig: { serverUrl, catalog: selectedCatalog, stream, runId: selectedRunId, dataSubNode, dataNodeFamily },
    });
  }, [serverUrl, selectedCatalog, selectedRunId]);

  const stopLive = useCallback(() => {
    setPanel(prev => {
      if (!prev || prev.type !== 'xy') return prev;
      const { liveConfig: _, ...rest } = prev as Extract<typeof prev, { type: 'xy' }>;
      return rest;
    });
  }, []);

  const addTraces = useCallback((traces: XYTrace[]) => {
    setPanel((prev) => {
      if (!prev || prev.type !== 'xy') return prev;
      const existingKeys = new Set(prev.traces.map(t => `${t.runId}|${t.xLabel}|${t.yLabel}`));
      const newTraces = traces.filter(t => !existingKeys.has(`${t.runId}|${t.xLabel}|${t.yLabel}`));
      return newTraces.length === 0 ? prev : { ...prev, traces: [...prev.traces, ...newTraces] };
    });
  }, []);

  const removeTrace = useCallback((index: number) => {
    setPanel((prev) => {
      if (!prev || prev.type !== 'xy') return prev;
      const traces = prev.traces.filter((_, i) => i !== index);
      return traces.length === 0 ? null : { ...prev, traces };
    });
  }, []);

  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const onMouseMove = (e: MouseEvent) => {
      const newWidth = Math.max(150, Math.min(800, startWidth + e.clientX - startX));
      setSidebarWidth(newWidth);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [sidebarWidth]);

  const handleRunsDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = runsHeight;

    const onMouseMove = (e: MouseEvent) => {
      const newHeight = Math.max(80, Math.min(600, startHeight + e.clientY - startY));
      setRunsHeight(newHeight);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [runsHeight]);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-gray-50">
      {/* Header */}
      <header className="flex-none h-16 bg-sky-950 flex items-center px-6 gap-4 shadow-md z-10">
        <h1 className="text-white text-xl font-semibold tracking-wide">Tiled Visualizer</h1>
        <div className="ml-auto flex items-center gap-2">
          <label className="text-sky-300 text-xs font-medium">Server</label>
          <input
            className="bg-sky-900 text-white text-sm px-3 py-1.5 rounded border border-sky-700 focus:outline-none focus:border-sky-400 w-72 placeholder:text-sky-500"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
            placeholder="http://localhost:8000"
          />
          <button
            onClick={handleConnect}
            className="bg-sky-600 hover:bg-sky-500 active:bg-sky-700 text-white text-sm px-4 py-1.5 rounded font-medium transition-colors"
          >
            Connect
          </button>

          {catalogs.length > 0 && (
            <>
              <div className="w-px h-6 bg-sky-700 mx-1" />
              <label className="text-sky-300 text-xs font-medium">Catalog</label>
              <select
                value={selectedCatalog}
                onChange={(e) => { setSelectedCatalog(e.target.value); setSelectedRunId(''); setSelectedRunLabel(''); setRunPage(0); }}
                className="bg-sky-900 text-white text-sm px-3 py-1.5 rounded border border-sky-700 focus:outline-none focus:border-sky-400"
              >
                <option value="">— root —</option>
                {catalogs.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </>
          )}
        </div>
      </header>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside
          className="flex-none bg-white overflow-hidden flex flex-col"
          style={{ width: sidebarWidth }}
        >
          {selectedCatalog ? (
            <>
              {/* Runs panel */}
              <div
                className="flex-none flex flex-col overflow-hidden"
                style={{ height: selectedRunId ? runsHeight : undefined, flex: selectedRunId ? undefined : '1' }}
              >
                <RunTable
                  serverUrl={serverUrl}
                  catalog={selectedCatalog}
                  page={runPage}
                  selectedRunId={selectedRunId}
                  onPageChange={setRunPage}
                  onSelectRun={(id, label, dets, motors) => {
                    setSelectedRunId(id);
                    setSelectedRunLabel(label);
                    setSelectedRunDetectors(dets);
                    setSelectedRunMotors(motors);
                  }}
                  onDoubleClickRun={(id, label, dets, motors) => {
                    setSelectedRunId(id);
                    setSelectedRunLabel(label);
                    setSelectedRunDetectors(dets);
                    setSelectedRunMotors(motors);
                    fieldSelectorRef.current?.schedulePlot();
                  }}
                />
              </div>
              {/* Horizontal drag handle + Fields panel */}
              {selectedRunId && (
                <>
                  <div
                    className="flex-none h-1 cursor-row-resize bg-gray-200 hover:bg-sky-400 transition-colors"
                    onMouseDown={handleRunsDividerMouseDown}
                  />
                  <div className="flex-1 overflow-hidden">
                    <FieldSelector
                      ref={fieldSelectorRef}
                      serverUrl={serverUrl}
                      catalog={selectedCatalog}
                      runId={selectedRunId}
                      runLabel={selectedRunLabel}
                      runDetectors={selectedRunDetectors}
                      runMotors={selectedRunMotors}
                      onPlot={plot}
                      onAddTraces={panel?.type === 'xy' ? addTraces : null}
                      onLivePlot={livePlot}
                    />
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-gray-400">
              Connect to a server and select a catalog
            </div>
          )}
        </aside>

        {/* Drag handle */}
        <div
          className="flex-none w-1 cursor-col-resize bg-gray-200 hover:bg-sky-400 transition-colors"
          onMouseDown={handleDividerMouseDown}
        />

        {/* Main content */}
        <main className="flex-1 overflow-hidden p-4">
          {panel ? (
            <VisualizationPanel panel={panel} onRemove={() => setPanel(null)} onRemoveTrace={removeTrace} onStopLive={stopLive} />
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-gray-400 select-none">
              <svg className="h-16 w-16 mb-4 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1}
                  d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
              </svg>
              <p className="text-base font-medium">No plot open</p>
              <p className="text-sm mt-1">Select X and Y fields on the left and click Plot</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
