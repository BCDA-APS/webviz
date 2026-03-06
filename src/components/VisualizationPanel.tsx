import { useState, useEffect } from 'react';
import { PlotlyHeatmap, PlotlyScatter } from '@blueskyproject/finch';
import { useTiledImage } from '../hooks/useTiledImage';
import type { Panel, XYTrace } from '../types';

type VisualizationPanelProps = {
  panel: Panel;
  onRemove: (id: string) => void;
  onRemoveTrace?: (index: number) => void;
  onStopLive?: () => void;
};

function PanelShell({ title, onRemove, id, badge, children, footer }: {
  title: string; id: string; onRemove: (id: string) => void;
  badge?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 flex flex-col overflow-hidden h-full min-h-[400px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 bg-gray-50 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-gray-700 truncate" title={title}>{title}</span>
          {badge}
        </div>
        <button
          onClick={() => onRemove(id)}
          className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2 shrink-0"
          aria-label="Close panel"
        >×</button>
      </div>
      <div className="flex-1 flex flex-col items-center justify-center p-2 min-h-0 relative">
        {children}
      </div>
      {footer}
    </div>
  );
}

// Plotly's default discrete color sequence
const PLOTLY_COLORS = [
  '#636efa', '#EF553B', '#00cc96', '#ab63fa', '#FFA15A',
  '#19d3f3', '#FF6692', '#B6E880', '#FF97FF', '#FECB52',
];

function XYPanelContent({ panel, onRemove, onRemoveTrace, onStopLive }: VisualizationPanelProps & { panel: Extract<Panel, { type: 'xy' }> }) {
  const [liveTraces, setLiveTraces] = useState<XYTrace[] | null>(null);

  // Reset liveTraces when a new panel is created so stale data doesn't bleed into a new plot
  useEffect(() => { setLiveTraces(null); }, [panel.id]);

  const liveConfig = panel.liveConfig;
  useEffect(() => {
    if (!liveConfig) return;
    const { serverUrl, catalog, stream, runId, dataSubNode, dataNodeFamily } = liveConfig;
    let cancelled = false;
    let busy = false;

    const poll = async () => {
      if (cancelled || busy) return;
      busy = true;
      try {
        // Check if run has a stop document (complete)
        const metaResp = await fetch(`${serverUrl}/api/v1/metadata/${catalog}/${runId}`);
        if (cancelled || !metaResp.ok) return;
        const meta = await metaResp.json();
        const isComplete = !!meta.data?.attributes?.metadata?.stop;

        // Re-fetch all trace data
        const subPath = dataSubNode ? `/${dataSubNode}` : '';
        let updated: typeof panel.traces;
        if (dataNodeFamily === 'table') {
          const resp = await fetch(`${serverUrl}/api/v1/table/full/${catalog}/${runId}/${stream}${subPath}?format=application/json`);
          if (!resp.ok) return;
          const table = await resp.json();
          const seqNums: number[] = table.seq_num ?? [];
          const nRows = seqNums.length > 0 ? (seqNums.findIndex(s => s === 0) === -1 ? seqNums.length : seqNums.findIndex(s => s === 0)) : undefined;
          updated = panel.traces.map(trace => ({
            ...trace,
            x: nRows !== undefined ? (table[trace.xLabel] ?? trace.x).slice(0, nRows) : (table[trace.xLabel] ?? trace.x),
            y: nRows !== undefined ? (table[trace.yLabel] ?? trace.y).slice(0, nRows) : (table[trace.yLabel] ?? trace.y),
          }));
        } else {
          const base = `${serverUrl}/api/v1/array/full/${catalog}/${runId}/${stream}${subPath}`;
          updated = await Promise.all(panel.traces.map(async (trace) => {
            const [xr, yr] = await Promise.all([
              fetch(`${base}/${trace.xLabel}?format=application/json`),
              fetch(`${base}/${trace.yLabel}?format=application/json`),
            ]);
            if (!xr.ok || !yr.ok) return trace;
            const [x, y] = await Promise.all([xr.json(), yr.json()]);
            return { ...trace, x, y };
          }));
        }

        if (!cancelled) {
          setLiveTraces(updated);
          if (isComplete) onStopLive?.();
        }
      } catch { } finally { busy = false; }
    };

    poll();
    const id = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(id); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveConfig?.runId]);

  // Static traces added via "+" to a live panel live in panel.traces but not in liveTraces;
  // merge them so they're always visible alongside polled live data.
  const liveKeys = new Set(liveTraces?.map(t => `${t.runId}|${t.xLabel}|${t.yLabel}`) ?? []);
  const staticTraces = liveTraces
    ? panel.traces.filter(t => !liveKeys.has(`${t.runId}|${t.xLabel}|${t.yLabel}`))
    : [];
  const displayTraces = liveTraces ? [...liveTraces, ...staticTraces] : panel.traces;
  const xAxisTitle = displayTraces[0]?.xLabel ?? '';
  const yAxisTitle = displayTraces.length === 1 ? displayTraces[0].yLabel : 'Value';

  const liveBadge = liveConfig ? (
    <span className="flex items-center gap-1 text-xs font-semibold text-red-500 shrink-0">
      <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
      LIVE
    </span>
  ) : undefined;

  return (
    <PanelShell title={panel.title} id={panel.id} onRemove={onRemove} badge={liveBadge}>
      <div className="w-full h-full flex flex-col">
        <div className="shrink-0 flex flex-wrap gap-1 px-2 py-1 border-b border-gray-100">
          {displayTraces.map((t, i) => (
            <span key={i} className="inline-flex items-center gap-1 text-xs bg-gray-100 rounded px-1.5 py-0.5 max-w-[220px]">
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: PLOTLY_COLORS[i % PLOTLY_COLORS.length] }}
              />
              <span className="truncate">{t.runLabel} ({t.runId.slice(0, 7)}) - {t.yLabel}</span>
              {!liveConfig && (
                <button
                  onClick={() => onRemoveTrace?.(i)}
                  className="text-gray-400 hover:text-red-500 leading-none shrink-0"
                  aria-label={`Remove ${t.yLabel}`}
                >×</button>
              )}
            </span>
          ))}
        </div>
        <div className="flex-1 min-h-0">
          <PlotlyScatter
            data={displayTraces.map((t) => {
              const order = t.x.map((_, i) => i).sort((a, b) => t.x[a] - t.x[b]);
              return { x: order.map(i => t.x[i]), y: order.map(i => t.y[i]), mode: 'lines+markers', type: 'scatter', name: `${t.runLabel} (${t.runId.slice(0, 7)}) - ${t.yLabel}`, showlegend: false };
            })}
            xAxisTitle={xAxisTitle}
            yAxisTitle={yAxisTitle}
            className="w-full h-full"
          />
        </div>
      </div>
    </PanelShell>
  );
}

function DatasetPanelContent({ panel, onRemove }: VisualizationPanelProps & { panel: Extract<Panel, { type: 'dataset' }> }) {
  const { array, line, metadata, zIndex, setZIndex, loading, error } = useTiledImage(panel.url);
  const leadingShape = metadata ? metadata.shape.slice(0, -2) : [];
  const totalFrames = leadingShape.reduce((a, b) => a * b, 1);
  const is3D = totalFrames > 1;
  const zMax = Math.max(0, totalFrames - 1);

  return (
    <PanelShell
      title={panel.title}
      id={panel.id}
      onRemove={onRemove}
      badge={metadata && (
        <span className="text-xs text-gray-400 shrink-0">
          [{metadata.shape.join(' × ')}]
        </span>
      )}
      footer={is3D ? (
        <div className="px-4 py-2 border-t border-gray-100 flex items-center gap-3 shrink-0">
          <span className="text-xs font-medium text-gray-500">Z</span>
          <input
            type="range" min={0} max={zMax} value={zIndex}
            onChange={(e) => setZIndex(Number(e.target.value))}
            className="flex-1 accent-sky-600"
          />
          <span className="text-xs text-gray-500 w-12 text-right">{zIndex} / {zMax}</span>
        </div>
      ) : undefined}
    >
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/70 z-10">
          <div className="flex flex-col items-center gap-2 text-gray-500">
            <svg className="animate-spin h-6 w-6" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
            <span className="text-sm">Loading...</span>
          </div>
        </div>
      )}

      {error && !loading && (
        <div className="flex flex-col items-center gap-2 px-6 text-center">
          <svg className="h-8 w-8 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
          <p className="text-sm text-red-500 font-medium">Failed to load</p>
          <p className="text-xs text-gray-400">{error}</p>
        </div>
      )}

      {line && (
        <div className="w-full h-full">
          <PlotlyScatter
            data={[{ y: line, mode: 'lines', type: 'scatter' }]}
            xAxisTitle={metadata?.dims?.[metadata.dims.length - 1] ?? 'Index'}
            yAxisTitle="Value"
            className="w-full h-full"
          />
        </div>
      )}

      {array && (
        <div className="w-full h-full">
          <PlotlyHeatmap
            array={array}
            colorScale="Viridis"
            showScale
            lockPlotHeightToParent
            xAxisTitle={metadata?.dims?.[metadata.dims.length - 1] ?? 'X'}
            yAxisTitle={metadata?.dims?.[metadata.dims.length - 2] ?? 'Y'}
          />
        </div>
      )}

      {!line && !array && !loading && !error && (
        <p className="text-sm text-gray-400">Fetching dataset...</p>
      )}
    </PanelShell>
  );
}

export default function VisualizationPanel({ panel, onRemove, onRemoveTrace, onStopLive }: VisualizationPanelProps) {
  if (panel.type === 'xy') {
    return <XYPanelContent panel={panel} onRemove={onRemove} onRemoveTrace={onRemoveTrace} onStopLive={onStopLive} />;
  }
  return <DatasetPanelContent panel={panel} onRemove={onRemove} />;
}
