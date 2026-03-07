import { useState, useCallback, useEffect, useRef } from 'react';
import RunTable from './components/RunTable';
import FieldSelector, { type FieldSelectorHandle } from './components/FieldSelector';
import VisualizationPanel from './components/VisualizationPanel';
import AnalysisPanel from './components/AnalysisPanel';
import RunDataTab from './components/RunDataTab';
import RunMetadataTab from './components/RunMetadataTab';
import RunSummaryTab from './components/RunSummaryTab';
import QServerPanel from './components/QServerPanel';
import type { Panel, XYTrace, TraceStyle } from './types';
import { fitData, MODEL_NAMES } from './fitting';
import type { FitResult } from './fitting';

function computeDerivative(xs: number[], ys: number[], w: number): { x: number[]; y: number[] } {
  if (xs.length < 2) return { x: [], y: [] };
  const order = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
  const sx = order.map(i => xs[i]);
  const sy = order.map(i => ys[i]);
  const half = Math.floor(w / 2);
  const smooth = w > 1
    ? sy.map((_, i) => {
        const s = Math.max(0, i - half), e = Math.min(sy.length - 1, i + half);
        let sum = 0; for (let j = s; j <= e; j++) sum += sy[j];
        return sum / (e - s + 1);
      })
    : sy;
  const n = sx.length;
  const dy = sx.map((_, i) => {
    const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
    return (smooth[i1] - smooth[i0]) / (sx[i1] - sx[i0]);
  });
  return { x: sx, y: dy };
}

const DEFAULT_QS_URL = 'http://nefarian.xray.aps.anl.gov:60610';
function loadQsUrl() {
  const saved = localStorage.getItem('qsUrl') ?? DEFAULT_QS_URL;
  return saved.startsWith('http://') || saved.startsWith('https://') ? saved : DEFAULT_QS_URL;
}
function toQsProxyUrl(url: string) {
  return url.replace(/^(https?):\/\//, `${window.location.origin}/qs-proxy/$1/`);
}

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
  const [selectedRunAcquiring, setSelectedRunAcquiring] = useState(false);
  const [runPage, setRunPage] = useState(0);
  const [autoFollow, setAutoFollow] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [analysisCollapsed, setAnalysisCollapsed] = useState(false);
  const [analysisWidth, setAnalysisWidth] = useState(260);
  const [analysisHeight, setAnalysisHeight] = useState(200);
  const [analysisPosition, setAnalysisPosition] = useState<'right' | 'bottom'>('right');
  const [xLog, setXLog] = useState(false);
  const [yLog, setYLog] = useState(false);
  const [fitModel, setFitModel] = useState(() => {
    const saved = localStorage.getItem('fitModel');
    return saved && MODEL_NAMES.includes(saved) ? saved : MODEL_NAMES[0];
  });
  const [activeTraceIndex, setActiveTraceIndex] = useState(0);
  const [fitResults, setFitResults] = useState<FitResult | null>(null);
  const [showDerivative, setShowDerivative] = useState(false);
  const [smoothingWindow, setSmoothingWindow] = useState(1);
  const [centerTab, setCenterTab] = useState<'graph' | 'data' | 'metadata' | 'summary'>('graph');
  const [appTab, setAppTab] = useState<'visualizer' | 'qserver'>('visualizer');
  const [qsInputUrl, setQsInputUrl] = useState(loadQsUrl);
  const [qsInputApiKey, setQsInputApiKey] = useState(() => localStorage.getItem('qsApiKey') ?? '');
  const [qsProxyUrl, setQsProxyUrl] = useState(() => toQsProxyUrl(loadQsUrl()));
  const [qsConnectionId, setQsConnectionId] = useState(0);
  const [qsStatus, setQsStatus] = useState<{ manager_state: string; re_state: string; items_in_queue: number } | null>(null);
  const [traceStyles, setTraceStyles] = useState<TraceStyle[]>([]);
  const [cursor1, setCursor1] = useState<number | null>(null);
  const [cursor1Y, setCursor1Y] = useState<number | null>(null);
  const [cursor2, setCursor2] = useState<number | null>(null);
  const [cursor2Y, setCursor2Y] = useState<number | null>(null);
  const [snapToData, setSnapToData] = useState(true);
  const [fitBetweenCursors, setFitBetweenCursors] = useState(false);
  const fieldSelectorRef = useRef<FieldSelectorHandle>(null);

  const [derivativeTraces, setDerivativeTraces] = useState<XYTrace[]>([]);
  // Track derivative source by identity so adding/removing other traces doesn't shift it
  const [derivSourceKey, setDerivSourceKey] = useState<string | null>(null);

  const realTraces = panel?.type === 'xy' ? panel.traces : [];

  // Resolve derivative source: prefer key lookup, fall back to current real active index
  const derivSource = (() => {
    if (realTraces.length === 0) return null;
    if (derivSourceKey) {
      return realTraces.find(t => `${t.runId}|${t.yLabel}` === derivSourceKey) ?? realTraces[0];
    }
    return realTraces[Math.min(activeTraceIndex, realTraces.length - 1)] ?? null;
  })();

  useEffect(() => {
    if (!showDerivative || !derivSource || derivSource.x.length < 2) {
      setDerivativeTraces([]);
      return;
    }
    const deriv = computeDerivative(derivSource.x, derivSource.y, smoothingWindow);
    setDerivativeTraces([{
      x: deriv.x, y: deriv.y,
      xLabel: derivSource.xLabel,
      yLabel: `d/dx (${derivSource.runLabel} - ${derivSource.yLabel})`,
      runLabel: derivSource.runLabel,
      runId: `__deriv__:${derivSource.runId}`,
    }]);
  }, [showDerivative, smoothingWindow, derivSource]);

  const allTraces = [...realTraces, ...derivativeTraces];
  const activeTrace = allTraces[Math.min(activeTraceIndex, allTraces.length - 1)] ?? null;

  const handleActiveTraceIndexChange = useCallback((i: number) => {
    setActiveTraceIndex(i);
    setFitResults(null);
    if (i < realTraces.length) {
      // User selected a real trace — lock derivative source to it
      const t = realTraces[i];
      setDerivSourceKey(`${t.runId}|${t.yLabel}`);
    } else if (!derivSourceKey && derivSource) {
      // User selected derivative — lock in current source so new traces don't shift it
      setDerivSourceKey(`${derivSource.runId}|${derivSource.yLabel}`);
    }
  }, [realTraces, derivSourceKey, derivSource]);

  const handleTraceStyleChange = useCallback((i: number, patch: Partial<TraceStyle>) => {
    setTraceStyles(prev => {
      const next = [...prev];
      next[i] = { color: '', lineWidth: 2, lineDash: 'solid', markerSymbol: 'circle', ...(next[i] ?? {}), ...patch };
      return next;
    });
  }, []);

  const handlePlotClick = useCallback((dataX: number, dataY: number, cursorIdx: 0 | 1) => {
    let x = dataX, y = dataY;
    if (snapToData && activeTrace && activeTrace.x.length > 0) {
      let nearest = 0, minDist = Infinity;
      for (let i = 0; i < activeTrace.x.length; i++) {
        const d = Math.abs(activeTrace.x[i] - dataX);
        if (d < minDist) { minDist = d; nearest = i; }
      }
      x = activeTrace.x[nearest];
      y = activeTrace.y[nearest];
    }
    if (cursorIdx === 0) {
      setCursor1(x); setCursor1Y(y);
    } else {
      setCursor2(x); setCursor2Y(y);
    }
  }, [snapToData, activeTrace]);

  const handleFit = useCallback(() => {
    if (!activeTrace) return;
    let xs = activeTrace.x, ys = activeTrace.y;
    if (fitBetweenCursors && cursor1 != null && cursor2 != null) {
      const xMin = Math.min(cursor1, cursor2), xMax = Math.max(cursor1, cursor2);
      const pairs = xs.map((x, i) => [x, ys[i]] as [number, number]).filter(([x]) => x >= xMin && x <= xMax);
      xs = pairs.map(([x]) => x);
      ys = pairs.map(([, y]) => y);
    }
    if (xs.length < 2) return;
    const result = fitData(fitModel, xs, ys);
    setFitResults(result);
  }, [activeTrace, fitModel, fitBetweenCursors, cursor1, cursor2]);

  const toProxyUrl = toProxyUrlStatic;

  const handleConnect = () => {
    setSelectedCatalog('');
    setSelectedRunId('');
    setSelectedRunLabel('');
    setServerUrl(toProxyUrl(inputUrl));
  };

  const handleQsConnect = () => {
    const url = qsInputUrl.replace(/\/$/, '');
    localStorage.setItem('qsUrl', url);
    localStorage.setItem('qsApiKey', qsInputApiKey);
    setQsProxyUrl(toQsProxyUrl(url));
    setQsStatus(null);
    setQsConnectionId(id => id + 1);
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
    setFitResults(null);
    setShowDerivative(false);
  }, []);

  const livePlot = useCallback((traces: XYTrace[], title: string, stream: string, dataSubNode: string, dataNodeFamily: 'array' | 'table') => {
    setPanel({
      id: crypto.randomUUID(), type: 'xy' as const, traces, title,
      liveConfig: { serverUrl, catalog: selectedCatalog, stream, runId: selectedRunId, dataSubNode, dataNodeFamily },
    });
    setFitResults(null);
    setShowDerivative(false);
  }, [serverUrl, selectedCatalog, selectedRunId]);

  const stopLive = useCallback(() => {
    setPanel(prev => {
      if (!prev || prev.type !== 'xy') return prev;
      const { liveConfig: _, ...rest } = prev as Extract<typeof prev, { type: 'xy' }>;
      return rest;
    });
  }, []);

  const handleLiveTracesUpdate = useCallback((updated: XYTrace[]) => {
    setPanel(prev => {
      if (!prev || prev.type !== 'xy') return prev;
      const updatedKeys = new Set(updated.map(t => `${t.runId}|${t.xLabel}|${t.yLabel}`));
      const merged = prev.traces.map(t => {
        const key = `${t.runId}|${t.xLabel}|${t.yLabel}`;
        return updatedKeys.has(key) ? (updated.find(u => `${u.runId}|${u.xLabel}|${u.yLabel}` === key) ?? t) : t;
      });
      return { ...prev, traces: merged };
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

  const handleAnalysisDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = analysisWidth;

    const onMouseMove = (e: MouseEvent) => {
      // dragging left increases width (panel is on the right)
      const newWidth = Math.max(240, Math.min(600, startWidth - (e.clientX - startX)));
      setAnalysisWidth(newWidth);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [analysisWidth]);

  const handleAnalysisBottomDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = analysisHeight;

    const onMouseMove = (e: MouseEvent) => {
      // dragging up (negative delta) increases height
      const newHeight = Math.max(100, Math.min(500, startHeight - (e.clientY - startY)));
      setAnalysisHeight(newHeight);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [analysisHeight]);

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
      <header className="flex-none h-12 bg-sky-950 flex items-center px-4 gap-4 shadow-md z-10">
        {/* App tabs */}
        <div className="flex items-end h-full gap-0.5 pt-1.5">
          {(['visualizer', 'qserver'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setAppTab(tab)}
              className={`px-4 h-full text-sm font-medium rounded-t transition-colors flex items-center gap-1.5 ${
                appTab === tab
                  ? 'bg-sky-100 text-sky-900'
                  : 'text-sky-300 hover:text-white hover:bg-sky-800'
              }`}
            >
              {tab === 'visualizer' ? (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                  </svg>
                  Visualizer
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <polygon points="12 2 2 7 12 12 22 7 12 2" />
                    <polyline points="2 12 12 17 22 12" />
                    <polyline points="2 17 12 22 22 17" />
                  </svg>
                  Q Server
                </>
              )}
            </button>
          ))}
        </div>

        {/* Tiled server controls (visualizer only) */}
        {appTab === 'visualizer' && (
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
        )}

        {/* QServer controls (qserver tab only) */}
        {appTab === 'qserver' && (
          <div className="ml-auto flex items-center gap-2">
            <label className="text-sky-300 text-xs font-medium">HTTP URL</label>
            <input
              className="bg-sky-900 text-white text-sm px-3 py-1.5 rounded border border-sky-700 focus:outline-none focus:border-sky-400 w-96 placeholder:text-sky-500 font-mono"
              value={qsInputUrl}
              onChange={e => setQsInputUrl(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleQsConnect()}
              placeholder="http://localhost:60610"
            />
            <label className="text-sky-300 text-xs font-medium">API Key</label>
            <input
              className="bg-sky-900 text-white text-sm px-3 py-1.5 rounded border border-sky-700 focus:outline-none focus:border-sky-400 w-36 placeholder:text-sky-500 font-mono"
              value={qsInputApiKey}
              onChange={e => setQsInputApiKey(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleQsConnect()}
              type="password"
              placeholder="(optional)"
            />
            <button
              onClick={handleQsConnect}
              className="bg-sky-600 hover:bg-sky-500 active:bg-sky-700 text-white text-sm px-4 py-1.5 rounded font-medium transition-colors"
            >Connect</button>
            {qsStatus && (
              <>
                <div className="w-px h-6 bg-sky-700 mx-1" />
                <span className="text-sky-300 text-xs">Manager: <span className={`font-mono font-medium ${qsStatus.manager_state === 'idle' ? 'text-green-400' : 'text-amber-400'}`}>{qsStatus.manager_state}</span></span>
                <span className="text-sky-300 text-xs">RE: <span className={`font-mono font-medium ${qsStatus.re_state === 'idle' ? 'text-green-400' : qsStatus.re_state === 'running' ? 'text-sky-300 animate-pulse' : 'text-amber-400'}`}>{qsStatus.re_state}</span></span>
                <span className="text-sky-300 text-xs">Queue: <span className="text-white font-medium">{qsStatus.items_in_queue}</span></span>
              </>
            )}
          </div>
        )}
      </header>

      {/* Queue Server tab */}
      {appTab === 'qserver' && (
        <div className="flex-1 overflow-hidden">
          <QServerPanel key={qsConnectionId} proxyUrl={qsProxyUrl} serverUrl={qsInputUrl.replace(/\/$/, '')} onStatusChange={setQsStatus} />
        </div>
      )}

      {/* Visualizer body */}
      <div className={`flex flex-1 overflow-hidden ${appTab !== 'visualizer' ? 'hidden' : ''}`}>
        {/* Sidebar */}
        <aside
          className="flex-none bg-white overflow-hidden flex flex-col transition-none"
          style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
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
                  autoFollow={autoFollow}
                  onPageChange={setRunPage}
                  onSelectRun={(id, label, dets, motors, acquiring) => {
                    if (id === selectedRunId && acquiring) {
                      fieldSelectorRef.current?.scheduleLive();
                      return;
                    }
                    setSelectedRunId(id);
                    setSelectedRunLabel(label);
                    setSelectedRunDetectors(dets);
                    setSelectedRunMotors(motors);
                    setSelectedRunAcquiring(acquiring);
                  }}
                  onDoubleClickRun={(id, label, dets, motors, acquiring) => {
                    setSelectedRunId(id);
                    setSelectedRunLabel(label);
                    setSelectedRunDetectors(dets);
                    setSelectedRunMotors(motors);
                    setSelectedRunAcquiring(acquiring);
                    if (!acquiring) fieldSelectorRef.current?.schedulePlot();
                  }}
                  onAutoFollowChange={setAutoFollow}
                  onNewAcquiringRun={(id, label, dets, motors, acquiring) => {
                    if (!autoFollow) return;
                    setSelectedRunId(id);
                    setSelectedRunLabel(label);
                    setSelectedRunDetectors(dets);
                    setSelectedRunMotors(motors);
                    setSelectedRunAcquiring(acquiring);
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
                      runAcquiring={selectedRunAcquiring}
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

        {/* Drag handle + collapse toggle */}
        <div className="flex-none flex flex-col items-center relative" style={{ width: 16 }}>
          {/* Clickable drag strip (only when expanded) */}
          {!sidebarCollapsed && (
            <div
              className="absolute inset-y-0 left-0 w-1 cursor-col-resize bg-gray-200 hover:bg-sky-400 transition-colors"
              onMouseDown={handleDividerMouseDown}
            />
          )}
          {/* Toggle button */}
          <button
            onClick={() => setSidebarCollapsed(c => !c)}
            className="absolute top-1/2 -translate-y-1/2 flex items-center justify-center w-4 h-8 rounded-r bg-gray-200 hover:bg-sky-400 text-gray-600 hover:text-white transition-colors text-xs leading-none select-none"
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? '›' : '‹'}
          </button>
        </div>

        {analysisPosition === 'right' ? (
          <>
            {/* Main content with tabs */}
            <main className="flex-1 overflow-hidden flex flex-col">
              {/* Tab bar */}
              <div className="flex-none flex gap-0.5 px-4 pt-2 bg-gray-50 border-b border-gray-200">
                {(['graph', 'data', 'metadata', 'summary'] as const).map(tab => (
                  <button
                    key={tab}
                    onClick={() => setCenterTab(tab)}
                    className={`px-4 py-1.5 text-sm font-medium rounded-t -mb-px border-b-2 transition-colors ${
                      centerTab === tab
                        ? 'text-sky-700 border-sky-600 bg-white'
                        : 'text-gray-500 border-transparent hover:text-gray-700 hover:border-gray-300'
                    }`}
                  >
                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  </button>
                ))}
              </div>

              {/* Tab content */}
              <div className="flex-1 overflow-hidden p-4">
                {centerTab === 'graph' && (
                  panel ? (
                    <VisualizationPanel panel={panel} onRemove={() => { setPanel(null); setFitResults(null); }} onRemoveTrace={removeTrace} onStopLive={stopLive} onLiveTracesUpdate={handleLiveTracesUpdate} extraTraces={derivativeTraces} onRemoveExtraTrace={() => setShowDerivative(false)} xLog={xLog} yLog={yLog} fitResults={fitResults} traceStyles={traceStyles} cursor1={cursor1} cursor2={cursor2} cursor1Y={cursor1Y} cursor2Y={cursor2Y} onPlotClick={handlePlotClick} />
                  ) : (
                    <div className="h-full flex flex-col items-center justify-center text-gray-400 select-none">
                      <svg className="h-16 w-16 mb-4 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1}
                          d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
                      </svg>
                      <p className="text-base font-medium">No plot open</p>
                      <p className="text-sm mt-1">Double-click a run to plot it, or select a run,</p>
                      <p className="text-sm">choose X and Y fields on the left, and click Plot</p>
                    </div>
                  )
                )}
                {centerTab === 'data' && (
                  <div className="bg-white rounded-lg border border-gray-200 h-full overflow-hidden">
                    <RunDataTab serverUrl={serverUrl} catalog={selectedCatalog} runId={selectedRunId} />
                  </div>
                )}
                {centerTab === 'metadata' && (
                  <div className="bg-white rounded-lg border border-gray-200 h-full overflow-hidden">
                    <RunMetadataTab serverUrl={serverUrl} catalog={selectedCatalog} runId={selectedRunId} />
                  </div>
                )}
                {centerTab === 'summary' && (
                  <div className="bg-gray-50 rounded-lg border border-gray-200 h-full overflow-hidden">
                    <RunSummaryTab serverUrl={serverUrl} catalog={selectedCatalog} runId={selectedRunId} />
                  </div>
                )}
              </div>
            </main>

            {/* Right analysis divider + collapse toggle */}
            <div className="flex-none flex flex-col items-center relative" style={{ width: 16 }}>
              {!analysisCollapsed && (
                <div
                  className="absolute inset-y-0 right-0 w-1 cursor-col-resize bg-gray-200 hover:bg-sky-400 transition-colors"
                  onMouseDown={handleAnalysisDividerMouseDown}
                />
              )}
              <button
                onClick={() => setAnalysisCollapsed(c => !c)}
                className="absolute top-1/2 -translate-y-1/2 flex items-center justify-center w-4 h-8 rounded-l bg-gray-200 hover:bg-sky-400 text-gray-600 hover:text-white transition-colors text-xs leading-none select-none"
                title={analysisCollapsed ? 'Expand analysis panel' : 'Collapse analysis panel'}
              >
                {analysisCollapsed ? '‹' : '›'}
              </button>
            </div>

            {/* Analysis panel right */}
            <aside
              className="flex-none bg-white overflow-hidden flex flex-col border-l border-gray-100"
              style={{ width: analysisCollapsed ? 0 : analysisWidth }}
            >
              <AnalysisPanel
                position="right" onTogglePosition={() => setAnalysisPosition('bottom')}
                xLog={xLog} yLog={yLog} onXLogChange={setXLog} onYLogChange={setYLog}
                hasXYPanel={panel?.type === 'xy'}
                xyTraces={panel?.type === 'xy' ? allTraces.map(t => t.runId.startsWith('__deriv__') ? t.yLabel : `${t.runLabel} (${t.runId.slice(0, 7)}) - ${t.yLabel}`) : []}
                activeTraceIndex={activeTraceIndex} onActiveTraceIndexChange={handleActiveTraceIndexChange}
                activeX={activeTrace?.x ?? []} activeY={activeTrace?.y ?? []}
                showDerivative={showDerivative} onShowDerivativeChange={setShowDerivative}
                smoothingWindow={smoothingWindow} onSmoothingWindowChange={setSmoothingWindow}
                fitModel={fitModel} onFitModelChange={m => { setFitModel(m); localStorage.setItem('fitModel', m); setFitResults(null); }}
                fitResults={fitResults} onFit={handleFit} onClearFit={() => setFitResults(null)}
                cursor1={cursor1} cursor2={cursor2} cursor1Y={cursor1Y} cursor2Y={cursor2Y}
                snapToData={snapToData} fitBetweenCursors={fitBetweenCursors}
                onSnapToDataChange={setSnapToData}
                onFitBetweenCursorsChange={setFitBetweenCursors}
                onClearCursor1={() => { setCursor1(null); setCursor1Y(null); }}
                onClearCursor2={() => { setCursor2(null); setCursor2Y(null); }}
                onClearAllCursors={() => { setCursor1(null); setCursor1Y(null); setCursor2(null); setCursor2Y(null); }}
                traceStyles={traceStyles} onTraceStyleChange={handleTraceStyleChange}
              />
            </aside>
          </>
        ) : (
          /* Bottom position */
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Main content with tabs */}
            <main className="flex-1 overflow-hidden flex flex-col">
              {/* Tab bar */}
              <div className="flex-none flex gap-0.5 px-4 pt-2 bg-gray-50 border-b border-gray-200">
                {(['graph', 'data', 'metadata', 'summary'] as const).map(tab => (
                  <button
                    key={tab}
                    onClick={() => setCenterTab(tab)}
                    className={`px-4 py-1.5 text-sm font-medium rounded-t -mb-px border-b-2 transition-colors ${
                      centerTab === tab
                        ? 'text-sky-700 border-sky-600 bg-white'
                        : 'text-gray-500 border-transparent hover:text-gray-700 hover:border-gray-300'
                    }`}
                  >
                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  </button>
                ))}
              </div>

              {/* Tab content */}
              <div className="flex-1 overflow-hidden p-4">
                {centerTab === 'graph' && (
                  panel ? (
                    <VisualizationPanel panel={panel} onRemove={() => { setPanel(null); setFitResults(null); }} onRemoveTrace={removeTrace} onStopLive={stopLive} onLiveTracesUpdate={handleLiveTracesUpdate} extraTraces={derivativeTraces} onRemoveExtraTrace={() => setShowDerivative(false)} xLog={xLog} yLog={yLog} fitResults={fitResults} traceStyles={traceStyles} cursor1={cursor1} cursor2={cursor2} cursor1Y={cursor1Y} cursor2Y={cursor2Y} onPlotClick={handlePlotClick} />
                  ) : (
                    <div className="h-full flex flex-col items-center justify-center text-gray-400 select-none">
                      <svg className="h-16 w-16 mb-4 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1}
                          d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
                      </svg>
                      <p className="text-base font-medium">No plot open</p>
                      <p className="text-sm mt-1">Double-click a run to plot it, or select a run,</p>
                      <p className="text-sm">choose X and Y fields on the left, and click Plot</p>
                    </div>
                  )
                )}
                {centerTab === 'data' && (
                  <div className="bg-white rounded-lg border border-gray-200 h-full overflow-hidden">
                    <RunDataTab serverUrl={serverUrl} catalog={selectedCatalog} runId={selectedRunId} />
                  </div>
                )}
                {centerTab === 'metadata' && (
                  <div className="bg-white rounded-lg border border-gray-200 h-full overflow-hidden">
                    <RunMetadataTab serverUrl={serverUrl} catalog={selectedCatalog} runId={selectedRunId} />
                  </div>
                )}
                {centerTab === 'summary' && (
                  <div className="bg-gray-50 rounded-lg border border-gray-200 h-full overflow-hidden">
                    <RunSummaryTab serverUrl={serverUrl} catalog={selectedCatalog} runId={selectedRunId} />
                  </div>
                )}
              </div>
            </main>

            {/* Bottom analysis divider + collapse toggle */}
            <div className="flex-none flex items-center justify-center relative" style={{ height: 16 }}>
              {!analysisCollapsed && (
                <div
                  className="absolute inset-x-0 top-0 h-1 cursor-row-resize bg-gray-200 hover:bg-sky-400 transition-colors"
                  onMouseDown={handleAnalysisBottomDividerMouseDown}
                />
              )}
              <button
                onClick={() => setAnalysisCollapsed(c => !c)}
                className="absolute left-1/2 -translate-x-1/2 flex items-center justify-center h-4 w-8 rounded-b bg-gray-200 hover:bg-sky-400 text-gray-600 hover:text-white transition-colors text-xs leading-none select-none"
                title={analysisCollapsed ? 'Expand analysis panel' : 'Collapse analysis panel'}
              >
                {analysisCollapsed ? '∧' : '∨'}
              </button>
            </div>

            {/* Analysis panel bottom */}
            <aside
              className="flex-none bg-white overflow-hidden flex flex-col border-t border-gray-100"
              style={{ height: analysisCollapsed ? 0 : analysisHeight }}
            >
              <AnalysisPanel
                position="bottom" onTogglePosition={() => setAnalysisPosition('right')}
                xLog={xLog} yLog={yLog} onXLogChange={setXLog} onYLogChange={setYLog}
                hasXYPanel={panel?.type === 'xy'}
                xyTraces={panel?.type === 'xy' ? allTraces.map(t => t.runId.startsWith('__deriv__') ? t.yLabel : `${t.runLabel} (${t.runId.slice(0, 7)}) - ${t.yLabel}`) : []}
                activeTraceIndex={activeTraceIndex} onActiveTraceIndexChange={handleActiveTraceIndexChange}
                activeX={activeTrace?.x ?? []} activeY={activeTrace?.y ?? []}
                showDerivative={showDerivative} onShowDerivativeChange={setShowDerivative}
                smoothingWindow={smoothingWindow} onSmoothingWindowChange={setSmoothingWindow}
                fitModel={fitModel} onFitModelChange={m => { setFitModel(m); localStorage.setItem('fitModel', m); setFitResults(null); }}
                fitResults={fitResults} onFit={handleFit} onClearFit={() => setFitResults(null)}
                cursor1={cursor1} cursor2={cursor2} cursor1Y={cursor1Y} cursor2Y={cursor2Y}
                snapToData={snapToData} fitBetweenCursors={fitBetweenCursors}
                onSnapToDataChange={setSnapToData}
                onFitBetweenCursorsChange={setFitBetweenCursors}
                onClearCursor1={() => { setCursor1(null); setCursor1Y(null); }}
                onClearCursor2={() => { setCursor2(null); setCursor2Y(null); }}
                onClearAllCursors={() => { setCursor1(null); setCursor1Y(null); setCursor2(null); setCursor2Y(null); }}
                traceStyles={traceStyles} onTraceStyleChange={handleTraceStyleChange}
              />
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
