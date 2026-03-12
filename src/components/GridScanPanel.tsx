import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { PlotlyScatter } from '@blueskyproject/finch';
import { type RGB, COLORMAPS, interpolateColor } from '../utils/colormap';
import { buildZMatrix, matrixRange } from '../utils/scanUtils';

// PlotlyScatter internal margins (from finch source) — keep in sync to align canvas with plots
// l=60 (y-title present), r=30, t=30, b=70 + pb-4 wrapper (16px) = 86
const PLOT_T = 30, PLOT_B = 86, PLOT_L = 60, PLOT_R = 30;

type Props = {
  serverUrl: string;
  catalog: string | null;
  runId: string;
  shape: [number, number] | null;
  dimensions: string[][];
  zField?: string;
  onClose?: () => void;
  onAnalyzeCut?: (x: number[], y: number[], xLabel: string, yLabel: string, title: string) => void;
};

type Viewport = { r0: number; r1: number; c0: number; c1: number };
type DragState =
  | { mode: 'pan';    sx: number; sy: number; svp: Viewport; moved: boolean }
  | { mode: 'select'; sx: number; sy: number; cRect: DOMRect; moved: boolean };

const catSeg = (c: string | null) => c ? `/${c}` : '';

// Mirrors RunDataTab.resolveTableSource: finds the correct table/full URL for the primary stream.
async function resolveTableUrl(serverUrl: string, cs: string, runId: string): Promise<{ tableUrl: string; arrayBase: string | null; columns?: string[] } | null> {
  const sj = await fetch(`${serverUrl}/api/v1/search${cs}/${runId}?page[limit]=50`).then(r => r.json());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const streams: string[] = (sj.data ?? []).map((d: any) => d.id);
  const stream = streams.includes('primary') ? 'primary' : (streams[0] ?? '');
  if (!stream) return null;

  const fj = await fetch(`${serverUrl}/api/v1/search${cs}/${runId}/${stream}?page[limit]=200`).then(r => r.json());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: any[] = fj.data ?? [];

  // Case 1: table node directly under stream (PostgreSQL adapter)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tblItem = items.find((i: any) => i.attributes?.structure_family === 'table');
  if (tblItem) {
    return { tableUrl: `${serverUrl}/api/v1/table/full${cs}/${runId}/${stream}/${tblItem.id}?format=application/json`, arrayBase: null };
  }

  // Case 2: arrays directly under stream
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasArrays = items.some((i: any) => i.attributes?.structure_family === 'array');
  if (hasArrays) {
    return {
      tableUrl: `${serverUrl}/api/v1/table/full${cs}/${runId}/${stream}?format=application/json`,
      arrayBase: `${serverUrl}/api/v1/array/full${cs}/${runId}/${stream}`,
    };
  }

  // Case 3: sub-nodes (MongoDB adapter: primary/data or primary/internal)
  for (const sub of ['data', 'internal']) {
    const subPath = `${cs}/${runId}/${stream}/${sub}`;
    const subR = await fetch(`${serverUrl}/api/v1/search${subPath}?page[limit]=200`);
    if (subR.ok) {
      const subJson = await subR.json();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const arrayItems: any[] = (subJson.data ?? []).filter((i: any) => i.attributes?.structure_family === 'array');
      if (arrayItems.length > 0) {
        return {
          tableUrl: `${serverUrl}/api/v1/table/full${subPath}?format=application/json`,
          arrayBase: `${serverUrl}/api/v1/array/full${subPath}`,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          columns: arrayItems.map((i: any) => i.id),
        };
      }
    }
  }
  return null;
}

async function fetchAllColumns(serverUrl: string, cs: string, runId: string): Promise<Record<string, number[]> | null> {
  const source = await resolveTableUrl(serverUrl, cs, runId);
  if (!source) return null;

  // Primary path: table/full returns all columns at once as {colName: number[]}
  const r = await fetch(source.tableUrl);
  if (r.ok) {
    const d: Record<string, unknown[]> = await r.json();
    return Object.fromEntries(
      Object.entries(d).map(([k, v]) => [k, Array.isArray(v) ? (v as unknown[]).map(Number) : []])
    );
  }

  // Fallback: fetch columns individually via array/full
  if (source.arrayBase) {
    const cols: string[] = source.columns
      ?? await fetch(`${source.arrayBase.replace('/api/v1/array/full', '/api/v1/search')}?page[limit]=200`)
          .then(sr => sr.json())
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .then(sj => (sj.data ?? []).filter((i: any) => i.attributes?.structure_family === 'array').map((i: any) => i.id));
    const entries = await Promise.all(
      cols.map(async col => {
        const cr = await fetch(`${source.arrayBase}/${col}?format=application/json`);
        if (!cr.ok) return [col, []] as [string, number[]];
        const data = await cr.json();
        return [col, Array.isArray(data) ? (data as unknown[]).map(Number) : []] as [string, number[]];
      })
    );
    return Object.fromEntries(entries);
  }

  return null;
}

// Backward-mapping render: for each canvas pixel, look up the grid cell it belongs to.
// This naturally handles any zoom viewport without extra logic.
function drawHeatmap(
  canvas: HTMLCanvasElement,
  zMatrix: number[][],
  crossRow: number | null,
  crossCol: number | null,
  vp: Viewport,
  colorFn: (t: number) => RGB,
) {
  const nRows = zMatrix.length;
  const nCols = zMatrix[0]?.length ?? 0;
  if (nRows === 0 || nCols === 0) return;

  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  let zMin = Infinity, zMax = -Infinity;
  for (const row of zMatrix) for (const v of row) {
    if (isFinite(v) && v < zMin) zMin = v;
    if (isFinite(v) && v > zMax) zMax = v;
  }
  const zRange = zMax - zMin || 1;

  const { r0, r1, c0, c1 } = vp;
  const rowSpan = r1 - r0;
  const colSpan = c1 - c0;

  const imageData = ctx.createImageData(w, h);
  const data = imageData.data;

  for (let py = 0; py < h; py++) {
    const row = Math.max(0, Math.min(nRows - 1, Math.floor(r0 + (py / h) * rowSpan)));
    for (let px = 0; px < w; px++) {
      const col = Math.max(0, Math.min(nCols - 1, Math.floor(c0 + (px / w) * colSpan)));
      const v = zMatrix[row][col];
      const t = isFinite(v) ? (v - zMin) / zRange : 0;
      const [r, g, b] = colorFn(t);
      const idx = (py * w + px) * 4;
      data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);

  if (crossRow !== null && crossCol !== null) {
    const cx = ((crossCol + 0.5 - c0) / colSpan) * w;
    const cy = ((crossRow + 0.5 - r0) / rowSpan) * h;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.5;
    if (cy >= 0 && cy <= h) { ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(w, cy); ctx.stroke(); }
    if (cx >= 0 && cx <= w) { ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke(); }
  }
}

export default function GridScanPanel({ serverUrl, catalog, runId, dimensions, zField, onClose, onAnalyzeCut }: Props) {
  const slowMotor = dimensions[0]?.[0] ?? '';
  const fastMotor = dimensions[1]?.[0] ?? '';

  const [allData, setAllData] = useState<Record<string, number[]> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [crossRow, setCrossRow] = useState<number | null>(null);
  const [crossCol, setCrossCol] = useState<number | null>(null);
  const [colormap, setColormap] = useState(() => localStorage.getItem('heatmapColormap') ?? 'viridis');
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [selBox, setSelBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [colSplit, setColSplit] = useState(() => { const s = parseFloat(localStorage.getItem('heatmapColSplit') ?? ''); return isNaN(s) ? 60 : s; });
  const [rowSplit, setRowSplit] = useState(() => { const s = parseFloat(localStorage.getItem('heatmapRowSplit') ?? ''); return isNaN(s) ? 60 : s; });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const splitDragRef = useRef<'col' | 'row' | null>(null);
  // always-current viewport for use in imperative event handlers
  const vpRef = useRef<Viewport>({ r0: 0, r1: 1, c0: 0, c1: 1 });

  useEffect(() => {
    setAllData(null);
    setCrossRow(null);
    setCrossCol(null);
    setViewport(null);
    if (!runId || !serverUrl) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    const cs = catSeg(catalog);
    fetchAllColumns(serverUrl, cs, runId)
      .then(d => { if (!cancelled) { setAllData(d); setLoading(false); } })
      .catch(e => { if (!cancelled) { setError(String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [runId, serverUrl, catalog]);

  const effectiveZField = useMemo(() => {
    if (!allData) return '';
    const motors = new Set([slowMotor, fastMotor]);
    const autoField = Object.keys(allData).find(f => !motors.has(f) && f !== 'time') ?? '';
    // Use the prop only if it actually exists in allData; otherwise fall back to auto-pick
    if (zField && allData[zField]?.length > 0) return zField;
    return autoField;
  }, [zField, allData, slowMotor, fastMotor]);

  const { zMatrix, slowAxis, fastAxis } = useMemo<{
    zMatrix: number[][] | null; slowAxis: number[]; fastAxis: number[];
  }>(() => {
    if (!allData || !effectiveZField || !slowMotor || !fastMotor) {
      return { zMatrix: null, slowAxis: [], fastAxis: [] };
    }
    const result = buildZMatrix(allData, effectiveZField, slowMotor, fastMotor);
    if (!result) return { zMatrix: null, slowAxis: [], fastAxis: [] };
    return result;
  }, [allData, effectiveZField, slowMotor, fastMotor]);

  const nRows = zMatrix?.length ?? 0;
  const nCols = zMatrix?.[0]?.length ?? 0;

  // Global z range for crosshair line spans (so lines are always full-height/full-width)
  const { globalZMin, globalZMax } = useMemo(() => {
    if (!zMatrix) return { globalZMin: 0, globalZMax: 1 };
    const { min, max } = matrixRange(zMatrix);
    return { globalZMin: min, globalZMax: max };
  }, [zMatrix]);

  // Keep vpRef in sync with current effective viewport
  useEffect(() => {
    vpRef.current = viewport ?? { r0: 0, r1: nRows, c0: 0, c1: nCols };
  }, [viewport, nRows, nCols]);

  // Reset viewport when grid dimensions change (new run)
  useEffect(() => { setViewport(null); }, [nRows, nCols]);

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !zMatrix) return;
    const palette = COLORMAPS[colormap] ?? COLORMAPS.viridis;
    drawHeatmap(canvas, zMatrix, crossRow, crossCol, vpRef.current, t => interpolateColor(palette, t));
  }, [zMatrix, crossRow, crossCol, viewport, colormap]);

  // Split drag (col/row dividers)
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!splitDragRef.current || !layoutRef.current) return;
      const rect = layoutRef.current.getBoundingClientRect();
      if (splitDragRef.current === 'col') {
        const v = Math.max(20, Math.min(80, ((e.clientX - rect.left) / rect.width) * 100));
        setColSplit(v);
        localStorage.setItem('heatmapColSplit', String(v));
      } else {
        const v = Math.max(20, Math.min(80, ((e.clientY - rect.top) / rect.height) * 100));
        setRowSplit(v);
        localStorage.setItem('heatmapRowSplit', String(v));
      }
    };
    const onUp = () => { splitDragRef.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  // Resize canvas
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const obs = new ResizeObserver(() => {
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
      if (zMatrix) {
        const palette = COLORMAPS[colormap] ?? COLORMAPS.viridis;
        drawHeatmap(canvas, zMatrix, crossRow, crossCol, vpRef.current, t => interpolateColor(palette, t));
      }
    });
    obs.observe(container);
    return () => obs.disconnect();
  }, [zMatrix, crossRow, crossCol, colormap]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wheel zoom (must be non-passive to call preventDefault)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      if (!zMatrix) return;
      const rect = canvas.getBoundingClientRect();
      const fx = (e.clientX - rect.left) / rect.width;
      const fy = (e.clientY - rect.top) / rect.height;
      const vp = vpRef.current;
      const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
      const rowC = vp.r0 + fy * (vp.r1 - vp.r0);
      const colC = vp.c0 + fx * (vp.c1 - vp.c0);
      const newRowSpan = (vp.r1 - vp.r0) * factor;
      const newColSpan = (vp.c1 - vp.c0) * factor;
      const r0 = Math.max(0, rowC - fy * newRowSpan);
      const r1 = Math.min(nRows, rowC + (1 - fy) * newRowSpan);
      const c0 = Math.max(0, colC - fx * newColSpan);
      const c1 = Math.min(nCols, colC + (1 - fx) * newColSpan);
      // Don't zoom out beyond full grid
      if (r1 - r0 >= nRows && c1 - c0 >= nCols) { setViewport(null); return; }
      setViewport({ r0, r1, c0, c1 });
    };
    canvas.addEventListener('wheel', handler, { passive: false });
    return () => canvas.removeEventListener('wheel', handler);
  }, [zMatrix, nRows, nCols]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const container = containerRef.current;
    if (!container) return;
    if (e.shiftKey) {
      dragRef.current = { mode: 'select', sx: e.clientX, sy: e.clientY, cRect: container.getBoundingClientRect(), moved: false };
    } else {
      dragRef.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, svp: { ...vpRef.current }, moved: false };
    }
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!drag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    drag.moved = true;

    if (drag.mode === 'select') {
      const { cRect } = drag;
      const x0 = Math.max(0, Math.min(drag.sx, e.clientX) - cRect.left);
      const y0 = Math.max(0, Math.min(drag.sy, e.clientY) - cRect.top);
      const x1 = Math.min(cRect.width,  Math.max(drag.sx, e.clientX) - cRect.left);
      const y1 = Math.min(cRect.height, Math.max(drag.sy, e.clientY) - cRect.top);
      setSelBox({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    } else {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const { svp } = drag;
      const dr = -(dy / canvas.clientHeight) * (svp.r1 - svp.r0);
      const dc = -(dx / canvas.clientWidth)  * (svp.c1 - svp.c0);
      const rowSpan = svp.r1 - svp.r0;
      const colSpan = svp.c1 - svp.c0;
      const r0 = Math.max(0, Math.min(nRows - rowSpan, svp.r0 + dr));
      const c0 = Math.max(0, Math.min(nCols - colSpan, svp.c0 + dc));
      setViewport({ r0, r1: r0 + rowSpan, c0, c1: c0 + colSpan });
    }
  }, [nRows, nCols]);

  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setSelBox(null);

    if (!drag || !zMatrix) return;

    if (drag.mode === 'select' && drag.moved) {
      // Zoom to the drawn selection box
      const { cRect } = drag;
      const fx0 = (Math.min(drag.sx, e.clientX) - cRect.left) / cRect.width;
      const fx1 = (Math.max(drag.sx, e.clientX) - cRect.left) / cRect.width;
      const fy0 = (Math.min(drag.sy, e.clientY) - cRect.top)  / cRect.height;
      const fy1 = (Math.max(drag.sy, e.clientY) - cRect.top)  / cRect.height;
      const vp = vpRef.current;
      const rowSpan = vp.r1 - vp.r0;
      const colSpan = vp.c1 - vp.c0;
      setViewport({
        r0: vp.r0 + fy0 * rowSpan, r1: vp.r0 + fy1 * rowSpan,
        c0: vp.c0 + fx0 * colSpan, c1: vp.c0 + fx1 * colSpan,
      });
      return;
    }

    if (!drag.moved) {
      // Plain click → set crosshair
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const vp = vpRef.current;
      const col = Math.floor(vp.c0 + ((e.clientX - rect.left) / rect.width)  * (vp.c1 - vp.c0));
      const row = Math.floor(vp.r0 + ((e.clientY - rect.top)  / rect.height) * (vp.r1 - vp.r0));
      setCrossRow(Math.max(0, Math.min(nRows - 1, row)));
      setCrossCol(Math.max(0, Math.min(nCols - 1, col)));
    }
  }, [zMatrix, nRows, nCols]);

  const handleDoubleClick = useCallback(() => setViewport(null), []);

  const horizCut = useMemo(() => {
    if (crossRow === null || !zMatrix) return null;
    const y = zMatrix[crossRow];
    let mn = Infinity, mx = -Infinity;
    for (const v of y) { if (v < mn) mn = v; if (v > mx) mx = v; }
    return { x: fastAxis, y, yMin: mn, yMax: mx };
  }, [crossRow, zMatrix, fastAxis]);

  const vertCut = useMemo(() => {
    if (crossCol === null || !zMatrix) return null;
    const y = zMatrix.map(row => row[crossCol]);
    let mn = Infinity, mx = -Infinity;
    for (const v of y) { if (v < mn) mn = v; if (v > mx) mx = v; }
    return { x: slowAxis, y, yMin: mn, yMax: mx };
  }, [crossCol, zMatrix, slowAxis]);

  const isZoomed = viewport !== null;

  // Axis ranges for cut plots — match the visible viewport so the crosshair aligns
  const evp = viewport ?? { r0: 0, r1: nRows, c0: 0, c1: nCols };
  const vertCutYRange: [number, number] = slowAxis.length > 0 ? [
    slowAxis[Math.min(slowAxis.length - 1, Math.max(0, Math.ceil(evp.r1) - 1))],
    slowAxis[Math.max(0, Math.min(slowAxis.length - 1, Math.floor(evp.r0)))],
  ] : [nRows, 0]; // reversed: row 0 (first motor pos) at top
  const horizCutXRange: [number, number] = fastAxis.length > 0 ? [
    fastAxis[Math.max(0, Math.min(fastAxis.length - 1, Math.floor(evp.c0)))],
    fastAxis[Math.min(fastAxis.length - 1, Math.max(0, Math.ceil(evp.c1) - 1))],
  ] : [0, nCols];

  if (loading) return <div className="h-full flex items-center justify-center text-gray-400 text-sm">Loading…</div>;
  if (error) return <div className="h-full flex items-center justify-center text-red-400 text-sm">{error}</div>;
  if (!allData) return <div className="h-full flex items-center justify-center text-gray-400 text-sm">No data</div>;
  if (!zMatrix) return <div className="h-full flex items-center justify-center text-gray-400 text-sm">Select a Z field in the field table</div>;

  return (
    <div className="h-full flex flex-col gap-2 overflow-hidden">
      {/* Toolbar */}
      <div className="flex-none flex items-center gap-3 px-1">
        {effectiveZField && <span className="text-xs text-gray-600 font-medium">Z: {effectiveZField}</span>}
        <select
          value={colormap}
          onChange={e => { setColormap(e.target.value); localStorage.setItem('heatmapColormap', e.target.value); }}
          className="text-xs border border-gray-200 rounded px-1.5 py-0.5 bg-white text-gray-700"
        >
          {Object.keys(COLORMAPS).map(cm => <option key={cm} value={cm}>{cm}</option>)}
        </select>
        <span className="text-xs text-gray-400">{nRows} × {nCols} grid · scroll/⇧drag to zoom · drag to pan · click to crosshair</span>
        {isZoomed && (
          <button
            onClick={() => setViewport(null)}
            className="text-xs text-sky-600 hover:text-sky-800 underline"
          >
            reset zoom
          </button>
        )}
        {crossRow !== null && crossCol !== null && (
          <span className="text-xs text-sky-600 font-mono">
            {slowMotor}={slowAxis[crossRow]?.toPrecision(4)} · {fastMotor}={fastAxis[crossCol]?.toPrecision(4)}
          </span>
        )}
        {onClose && (
          <button
            onClick={onClose}
            className="ml-auto text-gray-400 hover:text-gray-600 text-xl leading-none"
            aria-label="Close panel"
          >×</button>
        )}
      </div>

      {/* Main layout: heatmap + cuts (resizable) */}
      <div ref={layoutRef} className="flex-1 min-h-0 flex flex-col select-none">
        {/* Top row */}
        <div className="flex min-h-0" style={{ height: `${rowSplit}%` }}>
        {/* Heatmap — outer div is full-size; inner div is inset to match PlotlyScatter margins */}
        <div className="relative bg-white rounded overflow-hidden border border-gray-200" style={{ width: `${colSplit}%` }}>
          <div ref={containerRef} className="absolute"
               style={{ top: PLOT_T, bottom: PLOT_B, left: PLOT_L, right: PLOT_R }}>
            <canvas
              ref={canvasRef}
              className={`w-full h-full ${isZoomed ? 'cursor-grab active:cursor-grabbing' : 'cursor-crosshair'}`}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={() => { dragRef.current = null; setSelBox(null); }}
              onDoubleClick={handleDoubleClick}
            />
            {selBox && (
              <div
                className="absolute pointer-events-none border border-white/80 bg-white/10"
                style={{ left: selBox.x, top: selBox.y, width: selBox.w, height: selBox.h,
                         borderStyle: 'dashed', borderWidth: 1.5 }}
              />
            )}
          </div>
          {/* Axis labels sit in the margin area of the outer div */}
          <div className="absolute bottom-0 left-0 right-0 text-center text-[10px] text-gray-300 pb-0.5 pointer-events-none">
            {fastMotor}
          </div>
          <div className="absolute top-0 bottom-0 left-0 flex items-center text-[10px] text-gray-300 pl-0.5 pointer-events-none" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
            {slowMotor}
          </div>
        </div>

          {/* Column drag handle */}
          <div
            className="w-1.5 shrink-0 cursor-col-resize bg-gray-200 hover:bg-sky-300 active:bg-sky-400 transition-colors rounded mx-0.5"
            onMouseDown={e => { e.preventDefault(); splitDragRef.current = 'col'; }}
          />

          {/* Vertical cut */}
          <div className="relative bg-white rounded border border-gray-200 overflow-hidden flex-1">
            {vertCut ? (
              <>
                <PlotlyScatter
                  data={[
                    { x: vertCut.y, y: vertCut.x, type: 'scatter', mode: 'lines+markers', line: { color: '#0ea5e9' }, marker: { size: 4 }, showlegend: false },
                    { x: [globalZMin, globalZMax], y: [slowAxis[crossRow!], slowAxis[crossRow!]], type: 'scatter', mode: 'lines',
                      line: { color: 'rgba(100,100,100,0.45)', dash: 'dash', width: 1 }, hoverinfo: 'skip' as const, showlegend: false },
                  ]}
                  xAxisTitle={effectiveZField}
                  yAxisTitle={slowMotor}
                  yAxisRange={vertCutYRange}
                  className="w-full h-full"
                />
                {onAnalyzeCut && (
                  <button
                    onClick={() => onAnalyzeCut(vertCut.x, vertCut.y, slowMotor, effectiveZField, `${effectiveZField} vs ${slowMotor} (vertical cut)`)}
                    className="absolute top-1 right-1 text-[10px] px-1.5 py-0.5 bg-gray-100 hover:bg-gray-200 border border-gray-300 rounded text-gray-600"
                    title="Open in analysis panel"
                  >
                    Analyze
                  </button>
                )}
              </>
            ) : (
              <div className="h-full flex items-center justify-center text-xs text-gray-400">Click heatmap for vertical cut</div>
            )}
          </div>
        </div>{/* end top row */}

        {/* Row drag handle */}
        <div
          className="h-1.5 shrink-0 cursor-row-resize bg-gray-200 hover:bg-sky-300 active:bg-sky-400 transition-colors rounded my-0.5"
          onMouseDown={e => { e.preventDefault(); splitDragRef.current = 'row'; }}
        />

        {/* Bottom row */}
        <div className="flex min-h-0 flex-1">
          {/* Horizontal cut */}
          <div className="relative bg-white rounded border border-gray-200 overflow-hidden" style={{ width: `${colSplit}%` }}>
            {horizCut ? (
              <>
                <PlotlyScatter
                  data={[
                    { x: horizCut.x, y: horizCut.y, type: 'scatter', mode: 'lines+markers', line: { color: '#10b981' }, marker: { size: 4 }, showlegend: false },
                    { x: [fastAxis[crossCol!], fastAxis[crossCol!]], y: [globalZMin, globalZMax], type: 'scatter', mode: 'lines',
                      line: { color: 'rgba(100,100,100,0.45)', dash: 'dash', width: 1 }, hoverinfo: 'skip' as const, showlegend: false },
                  ]}
                  xAxisTitle={fastMotor}
                  yAxisTitle={effectiveZField}
                  xAxisRange={horizCutXRange}
                  className="w-full h-full"
                />
                {onAnalyzeCut && (
                  <button
                    onClick={() => onAnalyzeCut(horizCut.x, horizCut.y, fastMotor, effectiveZField, `${effectiveZField} vs ${fastMotor} (horizontal cut)`)}
                    className="absolute top-1 right-1 text-[10px] px-1.5 py-0.5 bg-gray-100 hover:bg-gray-200 border border-gray-300 rounded text-gray-600"
                    title="Open in analysis panel"
                  >
                    Analyze
                  </button>
                )}
              </>
            ) : (
              <div className="h-full flex items-center justify-center text-xs text-gray-400">Click heatmap for horizontal cut</div>
            )}
          </div>

          {/* Spacer aligned with column handle */}
          <div className="w-1.5 shrink-0 mx-0.5" />

          {/* Info */}
          <div className="bg-gray-50 rounded border border-gray-200 flex-1 flex items-center justify-center">
            <div className="text-xs text-gray-400 text-center px-3">
              <p className="font-medium text-gray-500">{runId.slice(0, 8)}…</p>
              <p className="mt-1">{nRows} rows × {nCols} cols</p>
              {zMatrix && (
                <p className="mt-1 font-mono">
                  z: [{Math.min(...zMatrix.flat().filter(isFinite)).toPrecision(4)}, {Math.max(...zMatrix.flat().filter(isFinite)).toPrecision(4)}]
                </p>
              )}
            </div>
          </div>
        </div>{/* end bottom row */}
      </div>
    </div>
  );
}
