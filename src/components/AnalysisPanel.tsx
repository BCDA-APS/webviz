import { useState, useRef, useEffect } from 'react';
import { MODEL_NAMES } from '../fitting';
import type { FitResult } from '../fitting';
import type { TraceStyle } from '../types';
import { PLOTLY_COLORS, MARKER_ICONS, CURSOR_COLORS, DEFAULT_TRACE_STYLE } from '../constants';

type AnalysisPanelProps = {
  position: 'right' | 'bottom';
  onTogglePosition: () => void;
  xLog: boolean;
  yLog: boolean;
  onXLogChange: (v: boolean) => void;
  onYLogChange: (v: boolean) => void;
  hasXYPanel: boolean;
  xyTraces: string[];
  activeTraceIndex: number;
  onActiveTraceIndexChange: (i: number) => void;
  activeX: number[];
  activeY: number[];
  showDerivative: boolean;
  onShowDerivativeChange: (v: boolean) => void;
  normalizeDerivative: boolean;
  onNormalizeDerivativeChange: (v: boolean) => void;
  smoothingWindow: number;
  onSmoothingWindowChange: (n: number) => void;
  fitModel: string;
  onFitModelChange: (m: string) => void;
  fitResults: FitResult | null;
  onFit: () => void;
  onClearFit: () => void;
  // Cursors
  cursor1: number | null;
  cursor2: number | null;
  cursor1Y: number | null;
  cursor2Y: number | null;
  snapToData: boolean;
  fitBetweenCursors: boolean;
  onSnapToDataChange: (v: boolean) => void;
  onFitBetweenCursorsChange: (v: boolean) => void;
  onClearCursor1: () => void;
  onClearCursor2: () => void;
  onClearAllCursors: () => void;
  // Style (per active trace)
  traceStyles: TraceStyle[];
  onTraceStyleChange: (i: number, patch: Partial<TraceStyle>) => void;
};

function Section({ id: _id, label, icon, open, onToggle, children, position }: {
  id: string; label: string; icon: string; open: boolean;
  onToggle: () => void; children: React.ReactNode;
  position?: 'right' | 'bottom';
}) {
  const isBottom = position === 'bottom';
  return (
    <div className={[
      isBottom
        ? 'flex flex-col min-w-[190px] border-r border-gray-200 last:border-r-0'
        : 'border-b border-gray-200 last:border-0',
      open ? 'border-l-2 border-l-sky-400' : 'border-l-2 border-l-transparent',
    ].join(' ')}>
      <button
        onClick={onToggle}
        className={`w-full shrink-0 flex items-center gap-2 px-3 py-2 text-left transition-colors ${open ? 'bg-sky-50 hover:bg-sky-100' : 'hover:bg-gray-50'}`}
      >
        <svg className={`w-4 h-4 flex-none ${open ? 'text-sky-500' : 'text-gray-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
        </svg>
        <span className={`flex-1 text-sm font-medium ${open ? 'text-sky-700' : 'text-gray-700'}`}>{label}</span>
        <svg
          className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180 text-sky-400' : 'text-gray-400'}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && <div className={`px-3 pb-3 pt-1 bg-sky-50/40 ${isBottom ? 'flex-1 overflow-y-auto' : ''}`}>{children}</div>}
    </div>
  );
}

function IconBottom() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
      <rect x="1" y="1" width="14" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="1" y="12" width="14" height="3" rx="1" />
    </svg>
  );
}

function IconRight() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
      <rect x="1" y="1" width="9" height="14" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="12" y="1" width="3" height="14" rx="1" />
    </svg>
  );
}

function TraceDropdown({ traces, traceStyles, value, onChange }: {
  traces: string[];
  traceStyles: TraceStyle[];
  value: number;
  onChange: (i: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const getStyle = (i: number): TraceStyle => ({ ...DEFAULT_TRACE_STYLE, ...(traceStyles[i] ?? {}) });
  const getColor = (i: number) => getStyle(i).color || PLOTLY_COLORS[i % PLOTLY_COLORS.length];
  const hasMarker = (i: number) => getStyle(i).markerSymbol !== 'none';
  const getIcon = (i: number) => MARKER_ICONS[getStyle(i).markerSymbol];

  const renderIcon = (i: number) => hasMarker(i)
    ? <span className="shrink-0 leading-none" style={{ color: getColor(i), fontSize: '11px' }}>{getIcon(i)}</span>
    : <svg className="shrink-0" width="14" height="4" viewBox="0 0 14 4">
        <line x1="0" y1="2" x2="14" y2="2" stroke={getColor(i)} strokeWidth="2.5" strokeLinecap="round" />
      </svg>;

  return (
    <div ref={ref} className="relative flex-1 min-w-0">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-1.5 text-xs border border-gray-200 rounded px-1.5 py-1 bg-white hover:border-sky-400 text-left focus:outline-none"
      >
        {renderIcon(value)}
        <span className="flex-1 truncate text-gray-700">{traces[value]}</span>
        <svg className={`w-3 h-3 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute z-50 mt-1 left-0 right-0 bg-white border border-gray-200 rounded shadow-lg overflow-hidden">
          {traces.map((label, i) => (
            <button
              key={i}
              onClick={() => { onChange(i); setOpen(false); }}
              className={`w-full flex items-center gap-1.5 px-2 py-1.5 text-xs hover:bg-sky-50 text-left ${i === value ? 'bg-sky-50' : ''}`}
            >
              {renderIcon(i)}
              <span className="flex-1 truncate text-gray-700">{label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type Stats = {
  yMin: number; yMax: number; peakX: number;
  mean: number; stddev: number; com: number; fwhm: number;
};

function computeStats(xs: number[], ys: number[]): Stats | null {
  if (xs.length === 0) return null;
  const order = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
  const sx = order.map(i => xs[i]);
  const sy = order.map(i => ys[i]);
  const n = sx.length;
  let yMin = Infinity, yMax = -Infinity, peakIdx = 0;
  for (let i = 0; i < sy.length; i++) {
    if (sy[i] < yMin) yMin = sy[i];
    if (sy[i] > yMax) { yMax = sy[i]; peakIdx = i; }
  }
  const peakX = sx[peakIdx];
  const mean = sy.reduce((s, y) => s + y, 0) / n;
  const stddev = Math.sqrt(sy.reduce((s, y) => s + (y - mean) * (y - mean), 0) / n);
  const sumY = sy.reduce((s, y) => s + y, 0);
  const com = sumY !== 0 ? sx.reduce((s, x, i) => s + x * sy[i], 0) / sumY : NaN;
  const halfMax = (yMax + yMin) / 2;
  let left = sx[0], right = sx[n - 1];
  for (let i = 0; i < n - 1; i++) {
    if ((sy[i] - halfMax) * (sy[i + 1] - halfMax) < 0) {
      const t = (halfMax - sy[i]) / (sy[i + 1] - sy[i]);
      const x = sx[i] + t * (sx[i + 1] - sx[i]);
      if (x < peakX) left = x; else right = x;
    }
  }
  const fwhm = right - left;
  return { yMin, yMax, peakX, mean, stddev, com, fwhm };
}

function formatValue(v: number): string {
  if (!isFinite(v)) return String(v);
  const abs = Math.abs(v);
  if (abs === 0) return '0';
  if (abs >= 0.001 && abs < 1e6) return parseFloat(v.toPrecision(5)).toString();
  return v.toExponential(4);
}

export default function AnalysisPanel({
  position, onTogglePosition,
  xLog, yLog, onXLogChange, onYLogChange,
  hasXYPanel, xyTraces, activeTraceIndex, onActiveTraceIndexChange,
  activeX, activeY,
  showDerivative, onShowDerivativeChange, normalizeDerivative, onNormalizeDerivativeChange, smoothingWindow, onSmoothingWindowChange,
  fitModel, onFitModelChange, fitResults,
  onFit, onClearFit,
  cursor1, cursor2, cursor1Y, cursor2Y,
  snapToData, fitBetweenCursors,
  onSnapToDataChange, onFitBetweenCursorsChange,
  onClearCursor1, onClearCursor2, onClearAllCursors,
  traceStyles, onTraceStyleChange,
}: AnalysisPanelProps) {
  const stats = computeStats(activeX, activeY);
  const [open, setOpen] = useState<Set<string>>(new Set([]));

  const toggle = (id: string) =>
    setOpen(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div className={`flex flex-col h-full ${position === 'bottom' ? 'overflow-hidden' : 'overflow-y-auto'}`}>
      {/* Header */}
      <div className="flex-none px-3 py-2 border-b border-gray-200 flex items-center gap-2">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex-1">Analysis</span>
        <button
          onClick={onTogglePosition}
          className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
          title={position === 'right' ? 'Move panel to bottom' : 'Move panel to right'}
        >
          {position === 'right' ? <IconBottom /> : <IconRight />}
        </button>
      </div>

      {/* Active curve selector */}
      {xyTraces.length > 1 && (
        <div className="flex-none px-3 py-2 border-b border-gray-200 bg-gray-50 flex items-center gap-2">
          <span className="text-xs text-gray-500 shrink-0">Curve</span>
          <TraceDropdown
            traces={xyTraces}
            traceStyles={traceStyles}
            value={activeTraceIndex}
            onChange={onActiveTraceIndexChange}
          />
        </div>
      )}

      {/* Sections */}
      <div className={`flex-1 min-h-0 ${position === 'bottom' ? 'flex flex-row overflow-x-auto' : 'flex flex-col overflow-y-auto'}`}>

        <Section id="style" label="Style" icon="M4 20h16M8 16l4-12 4 12M6 10h12" position={position}
          open={open.has('style')} onToggle={() => toggle('style')}>
          {(() => {
            const style: TraceStyle = { ...DEFAULT_TRACE_STYLE, ...(traceStyles[activeTraceIndex] ?? {}) };
            const defaultColor = PLOTLY_COLORS[activeTraceIndex % PLOTLY_COLORS.length];
            const color = style.color || defaultColor;
            const patch = (p: Partial<TraceStyle>) => onTraceStyleChange(activeTraceIndex, p);
            const disabled = !hasXYPanel;
            return (
              <div className="flex flex-col gap-2.5">
                {xyTraces.length > 1 && (
                  <p className="text-xs text-gray-400 italic">Editing: {xyTraces[activeTraceIndex]}</p>
                )}
                {/* Line style */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500 w-12 shrink-0">Line</span>
                  <select
                    value={style.lineDash}
                    onChange={e => patch({ lineDash: e.target.value as TraceStyle['lineDash'] })}
                    disabled={disabled}
                    className="flex-1 text-xs border border-gray-200 rounded px-1.5 py-1 bg-white focus:outline-none focus:border-sky-400 disabled:opacity-50"
                  >
                    <option value="none">None</option>
                    <option value="solid">Solid</option>
                    <option value="dash">Dash</option>
                    <option value="dot">Dot</option>
                    <option value="dashdot">Dash-dot</option>
                  </select>
                  {style.lineDash !== 'none' && (
                    <>
                      <input
                        type="range" min={1} max={6} step={1} value={style.lineWidth}
                        onChange={e => patch({ lineWidth: Number(e.target.value) })}
                        disabled={disabled}
                        className="w-16 accent-sky-600 disabled:opacity-40"
                      />
                      <span className="text-xs text-gray-700 w-3 text-right">{style.lineWidth}</span>
                    </>
                  )}
                </div>
                {/* Marker symbol */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500 w-12 shrink-0">Marker</span>
                  <select
                    value={style.markerSymbol}
                    onChange={e => patch({ markerSymbol: e.target.value as TraceStyle['markerSymbol'] })}
                    disabled={disabled}
                    className="flex-1 text-xs border border-gray-200 rounded px-1.5 py-1 bg-white focus:outline-none focus:border-sky-400 disabled:opacity-50"
                  >
                    <option value="none">None</option>
                    <option value="circle">{MARKER_ICONS.circle} Circle</option>
                    <option value="square">{MARKER_ICONS.square} Square</option>
                    <option value="diamond">{MARKER_ICONS.diamond} Diamond</option>
                    <option value="triangle-up">{MARKER_ICONS['triangle-up']} Triangle</option>
                    <option value="cross">{MARKER_ICONS.cross} Cross</option>
                    <option value="x">{MARKER_ICONS.x} X</option>
                  </select>
                </div>
                {/* Color */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500 w-12 shrink-0">Color</span>
                  <input
                    type="color"
                    value={color}
                    onChange={e => patch({ color: e.target.value })}
                    disabled={disabled}
                    className="w-6 h-6 cursor-pointer border border-gray-200 rounded p-0 shrink-0"
                  />
                  {style.color && (
                    <button
                      onClick={() => patch({ color: '' })}
                      className="text-gray-300 hover:text-gray-500 text-sm leading-none"
                      title="Reset to default"
                    >↺</button>
                  )}
                </div>
                {!hasXYPanel && <p className="text-xs text-gray-400 italic">Open a plot to edit style.</p>}
              </div>
            );
          })()}
        </Section>

        <Section id="statistics" label="Statistics" icon="M3 3v18h18M7 16l4-6 4 4 4-8" position={position}
          open={open.has('statistics')} onToggle={() => toggle('statistics')}>
          {stats ? (
            <table className="w-full text-xs">
              <tbody>
                {([
                  ['Peak pos.', stats.peakX],
                  ['Peak val.', stats.yMax],
                  ['Min val.', stats.yMin],
                  ['Mean', stats.mean],
                  ['Std dev', stats.stddev],
                  ['COM', stats.com],
                  ['FWHM', stats.fwhm],
                ] as [string, number][]).map(([label, value]) => (
                  <tr key={label} className="border-b border-gray-100 last:border-0">
                    <td className="py-0.5 text-gray-500">{label}</td>
                    <td className="py-0.5 text-right font-mono text-gray-800">{formatValue(value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-xs text-gray-400 italic">Open a plot to see statistics.</p>
          )}
        </Section>

        <Section id="derivative" label="Derivative" icon="M3 12h2l3-8 4 16 3-10 2 2h4" position={position}
          open={open.has('derivative')} onToggle={() => toggle('derivative')}>
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showDerivative}
                onChange={e => onShowDerivativeChange(e.target.checked)}
                disabled={!hasXYPanel}
                className="accent-sky-600 w-3.5 h-3.5 disabled:opacity-40"
              />
              <span className={`text-sm ${hasXYPanel ? 'text-gray-700' : 'text-gray-400'}`}>Show d/dx</span>
            </label>
            {showDerivative && (
              <>
                <label className="flex items-center gap-2 select-none">
                  <span className="text-xs text-gray-500 shrink-0">Smoothing</span>
                  <input
                    type="number"
                    min={1} max={99} step={2}
                    value={smoothingWindow}
                    onChange={e => onSmoothingWindowChange(Math.max(1, Math.floor(Number(e.target.value))))}
                    className="w-16 text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:border-sky-400"
                  />
                  <span className="text-xs text-gray-400">pts</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={normalizeDerivative}
                    onChange={e => onNormalizeDerivativeChange(e.target.checked)}
                    className="accent-sky-600 w-3.5 h-3.5"
                  />
                  <span className="text-xs text-gray-700">Normalize to source scale</span>
                </label>
              </>
            )}
            {!hasXYPanel && (
              <p className="text-xs text-gray-400 italic">Open a plot to enable derivative.</p>
            )}
          </div>
        </Section>

        <Section id="fits" label="Fits" icon="M3 17c3-6 5-10 9-10s6 4 9 10" position={position}
          open={open.has('fits')} onToggle={() => toggle('fits')}>
          <div className={`${position === 'bottom' ? 'flex flex-row gap-3 items-start' : 'flex flex-col gap-2'}`}>
            {/* Controls */}
            <div className="flex flex-col gap-2 shrink-0">
              {/* Model selector */}
              <select
                value={fitModel}
                onChange={e => { onFitModelChange(e.target.value); onClearFit(); }}
                className="text-sm border border-gray-200 rounded px-2 py-1 bg-white focus:outline-none focus:border-sky-400"
              >
                {MODEL_NAMES.map(m => <option key={m} value={m}>{m}</option>)}
              </select>

              {/* Actions */}
              <div className="flex gap-1.5">
                <button
                  onClick={onFit}
                  disabled={!hasXYPanel}
                  className="flex-1 text-xs bg-sky-600 hover:bg-sky-500 active:bg-sky-700 disabled:bg-gray-200 disabled:text-gray-400 text-white rounded px-2 py-1 font-medium transition-colors"
                >
                  Fit
                </button>
                {fitResults && (
                  <button
                    onClick={onClearFit}
                    className="text-xs border border-gray-200 hover:bg-gray-50 text-gray-500 rounded px-2 py-1 transition-colors"
                  >
                    Clear
                  </button>
                )}
              </div>

              {/* Fit between cursors */}
              <label className={`flex items-center gap-2 select-none ${cursor1 != null && cursor2 != null ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'}`}>
                <input
                  type="checkbox"
                  checked={fitBetweenCursors}
                  onChange={e => onFitBetweenCursorsChange(e.target.checked)}
                  disabled={cursor1 == null || cursor2 == null}
                  className="accent-sky-600 w-3.5 h-3.5 disabled:opacity-40"
                />
                <span className="text-xs text-gray-600">Fit between cursors</span>
              </label>

              {!hasXYPanel && (
                <p className="text-xs text-gray-400 italic">Open a plot to enable fitting.</p>
              )}
            </div>

            {/* Results */}
            {fitResults && (
              <div className={`border border-gray-100 rounded overflow-hidden ${position !== 'bottom' ? 'mt-1' : ''}`}>
                <div className="bg-gray-50 px-2 py-1 flex items-center justify-between border-b border-gray-100">
                  <span className="text-xs font-medium text-gray-600">{fitResults.model}</span>
                  <span className={`text-xs font-semibold ${fitResults.rSquared > 0.99 ? 'text-green-600' : fitResults.rSquared > 0.95 ? 'text-amber-600' : 'text-red-500'}`}>
                    R² = {fitResults.rSquared.toFixed(4)}
                  </span>
                </div>
                <table className="w-full text-xs">
                  <tbody>
                    {fitResults.params.map(p => (
                      <tr key={p.name} className="border-b border-gray-50 last:border-0">
                        <td className="px-2 py-0.5 text-gray-500 pr-1">{p.label}</td>
                        <td className="px-2 py-0.5 text-right font-mono text-gray-800">{formatValue(p.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

          </div>
        </Section>

        <Section id="cursors" label="Cursors" icon="M12 3v18M3 12h18" position={position}
          open={open.has('cursors')} onToggle={() => toggle('cursors')}>
          <div className="flex flex-col gap-2">
            <p className="text-xs text-gray-400 leading-relaxed">
              C1 → Right click<br />
              C2 → Middle click or Alt+Right click
            </p>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={snapToData}
                onChange={e => onSnapToDataChange(e.target.checked)}
                disabled={!hasXYPanel}
                className="accent-sky-600 w-3.5 h-3.5 disabled:opacity-40"
              />
              <span className={`text-xs ${hasXYPanel ? 'text-gray-700' : 'text-gray-400'}`}>Snap to curve</span>
            </label>
            {/* Cursor readouts */}
            {(cursor1 != null || cursor2 != null) && (
              <div className="mt-1 flex flex-col gap-1 text-xs font-mono">
                {cursor1 != null && (
                  <div className="flex items-center gap-1">
                    <span style={{ color: CURSOR_COLORS[0] }} className="font-bold shrink-0">C1</span>
                    <span className="text-gray-600">x={formatValue(cursor1)}</span>
                    {cursor1Y != null && <span className="text-gray-500">y={formatValue(cursor1Y)}</span>}
                    <button onClick={onClearCursor1} className="ml-auto text-gray-300 hover:text-gray-500 text-xs leading-none">×</button>
                  </div>
                )}
                {cursor2 != null && (
                  <div className="flex items-center gap-1">
                    <span style={{ color: CURSOR_COLORS[1] }} className="font-bold shrink-0">C2</span>
                    <span className="text-gray-600">x={formatValue(cursor2)}</span>
                    {cursor2Y != null && <span className="text-gray-500">y={formatValue(cursor2Y)}</span>}
                    <button onClick={onClearCursor2} className="ml-auto text-gray-300 hover:text-gray-500 text-xs leading-none">×</button>
                  </div>
                )}
                {cursor1 != null && cursor2 != null && (
                  <div className="mt-0.5 pt-1 border-t border-gray-100 flex flex-col gap-0.5 text-gray-600">
                    <span>Δx = {formatValue(Math.abs(cursor2 - cursor1))}</span>
                    {cursor1Y != null && cursor2Y != null && (
                      <span>Δy = {formatValue(Math.abs(cursor2Y - cursor1Y))}</span>
                    )}
                    <span>Mid x = {formatValue((cursor1 + cursor2) / 2)}</span>
                    {cursor1Y != null && cursor2Y != null && (
                      <span>Mid y = {formatValue((cursor1Y + cursor2Y) / 2)}</span>
                    )}
                  </div>
                )}
                <button
                  onClick={onClearAllCursors}
                  className="mt-1 text-xs text-gray-400 hover:text-gray-600 text-left"
                >Clear all</button>
              </div>
            )}
            {!hasXYPanel && <p className="text-xs text-gray-400 italic">Open a plot to enable cursors.</p>}
          </div>
        </Section>

        <Section id="logscale" label="Log Scale" icon="M4 20V4m4 16V10m4 10V14m4 10V8" position={position}
          open={open.has('logscale')} onToggle={() => toggle('logscale')}>
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" checked={xLog} onChange={e => onXLogChange(e.target.checked)} className="accent-sky-600 w-3.5 h-3.5" />
              <span className="text-sm text-gray-700">X axis</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" checked={yLog} onChange={e => onYLogChange(e.target.checked)} className="accent-sky-600 w-3.5 h-3.5" />
              <span className="text-sm text-gray-700">Y axis</span>
            </label>
            {(xLog || yLog) && (
              <p className="text-xs text-amber-600 flex items-start gap-1 mt-0.5">
                <span className="shrink-0">⚠</span>
                <span>Values ≤ 0 are not shown on log scale.</span>
              </p>
            )}
          </div>
        </Section>

      </div>
    </div>
  );
}
