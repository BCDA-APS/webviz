import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { PlotlyScatter } from '@blueskyproject/finch';

// PlotlyScatter internal margins (from finch source) — keep in sync to align canvas with plots
// l=60 (y-title present), r=30, t=30, b=70 + pb-4 wrapper (16px) = 86
const PLOT_T = 30, PLOT_B = 86, PLOT_L = 60, PLOT_R = 30;

type Props = {
  serverUrl: string;
  catalog: string | null;
  runId: string;
  stream: string;
  dataSubNode: string;
  fieldName: string;
  shape: number[]; // [nFrames, H, W] or [H, W]
  onClose?: () => void;
  onAnalyzeCut?: (x: number[], y: number[], xLabel: string, yLabel: string, title: string) => void;
};

type RGB = [number, number, number];
type Viewport = { r0: number; r1: number; c0: number; c1: number };
type DragState =
  | { mode: 'pan';    sx: number; sy: number; svp: Viewport; moved: boolean }
  | { mode: 'select'; sx: number; sy: number; cRect: DOMRect; moved: boolean };

const catSeg = (c: string | null) => c ? `/${c}` : '';

const COLORMAPS: Record<string, RGB[]> = {
  viridis:  [[68,1,84],[72,36,117],[64,67,135],[52,94,141],[41,120,142],[32,144,140],[34,167,132],[68,190,112],[121,209,81],[189,222,38],[253,231,37]],
  plasma:   [[12,7,134],[87,0,165],[143,13,163],[188,54,134],[219,96,97],[244,140,56],[254,191,33],[240,249,33]],
  inferno:  [[0,0,3],[40,11,84],[101,21,110],[159,42,99],[212,72,66],[245,125,21],[252,191,73],[252,255,164]],
  magma:    [[0,0,3],[28,16,68],[79,18,123],[129,37,129],[181,54,122],[229,80,100],[251,135,97],[254,212,148],[252,253,191]],
  hot:      [[0,0,0],[128,0,0],[255,0,0],[255,128,0],[255,255,0],[255,255,255]],
  greys:    [[0,0,0],[255,255,255]],
  rdbu:     [[33,102,172],[103,169,207],[209,229,240],[255,255,255],[253,219,199],[239,138,98],[178,24,43]],
  turbo:    [[48,18,59],[70,96,209],[20,175,252],[54,227,153],[194,243,22],[249,168,26],[215,67,9],[122,4,3]],
};

function interpolateColor(palette: RGB[], t: number): RGB {
  const clamped = Math.max(0, Math.min(1, t));
  const idx = clamped * (palette.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(palette.length - 1, Math.ceil(idx));
  const frac = idx - lo;
  return [0, 1, 2].map(i => Math.round(palette[lo][i] + frac * (palette[hi][i] - palette[lo][i]))) as RGB;
}

function drawFrame(
  canvas: HTMLCanvasElement,
  frame: number[][],
  crossRow: number | null,
  crossCol: number | null,
  vp: Viewport,
  colorFn: (t: number) => RGB,
) {
  const nRows = frame.length;
  const nCols = frame[0]?.length ?? 0;
  if (nRows === 0 || nCols === 0) return;

  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  let zMin = Infinity, zMax = -Infinity;
  for (const row of frame) for (const v of row) {
    if (isFinite(v)) { if (v < zMin) zMin = v; if (v > zMax) zMax = v; }
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
      const v = frame[row][col];
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

export default function ImagePanel({ serverUrl, catalog, runId, stream, dataSubNode, fieldName, shape, onClose, onAnalyzeCut }: Props) {
  const nFrames = shape.length >= 3 ? shape[0] : 1;
  const H = shape.length >= 3 ? shape[1] : (shape[0] ?? 0);
  const W = shape.length >= 3 ? shape[2] : (shape[1] ?? 0);

  const [frameCache, setFrameCache] = useState<Map<number, number[][]>>(new Map());
  const [frameIdx, setFrameIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [colormap, setColormap] = useState(() => localStorage.getItem('heatmapColormap') ?? 'viridis');
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [crossRow, setCrossRow] = useState<number | null>(null);
  const [crossCol, setCrossCol] = useState<number | null>(null);
  const [selBox, setSelBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [colSplit, setColSplit] = useState(() => { const s = parseFloat(localStorage.getItem('heatmapColSplit') ?? ''); return isNaN(s) ? 60 : s; });
  const [rowSplit, setRowSplit] = useState(() => { const s = parseFloat(localStorage.getItem('heatmapRowSplit') ?? ''); return isNaN(s) ? 60 : s; });

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const vpRef = useRef<Viewport>({ r0: 0, r1: H, c0: 0, c1: W });
  const dragRef = useRef<DragState | null>(null);
  const splitDragRef = useRef<'col' | 'row' | null>(null);

  useEffect(() => {
    setFrameCache(new Map());
    setFrameIdx(0);
    setViewport(null);
    setCrossRow(null);
    setCrossCol(null);
    vpRef.current = { r0: 0, r1: H, c0: 0, c1: W };
  }, [runId, fieldName, H, W]);

  useEffect(() => {
    vpRef.current = viewport ?? { r0: 0, r1: H, c0: 0, c1: W };
  }, [viewport, H, W]);

  // Fetch frame if not cached
  useEffect(() => {
    if (!runId || !serverUrl || H === 0 || W === 0) return;
    if (frameCache.has(frameIdx)) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    const cs = catSeg(catalog);
    const subPath = dataSubNode ? `/${dataSubNode}` : '';
    const sliceParam = shape.length >= 3 ? `&slice=${frameIdx}` : '';
    const url = `${serverUrl}/api/v1/array/full${cs}/${runId}/${stream}${subPath}/${fieldName}?format=application/json${sliceParam}`;
    fetch(url)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((raw: any) => {
        if (cancelled) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let data: number[][] = raw as any;
        while (Array.isArray(data) && Array.isArray(data[0]) && Array.isArray(data[0][0])) {
          data = data[0] as unknown as number[][];
        }
        setFrameCache(prev => new Map(prev).set(frameIdx, data));
        setLoading(false);
      })
      .catch(e => { if (!cancelled) { setError(String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [frameIdx, runId, serverUrl, catalog, stream, dataSubNode, fieldName, shape, H, W]); // eslint-disable-line react-hooks/exhaustive-deps

  const currentFrame = frameCache.get(frameIdx) ?? null;

  const { zMin, zMax } = useMemo(() => {
    if (!currentFrame) return { zMin: Infinity, zMax: -Infinity };
    let mn = Infinity, mx = -Infinity;
    for (const row of currentFrame) for (const v of row) {
      if (isFinite(v)) { if (v < mn) mn = v; if (v > mx) mx = v; }
    }
    return { zMin: mn, zMax: mx };
  }, [currentFrame]);

  const horizCut = useMemo(() => {
    if (crossRow === null || !currentFrame) return null;
    const y = currentFrame[crossRow] ?? [];
    let mn = Infinity, mx = -Infinity;
    for (const v of y) { if (v < mn) mn = v; if (v > mx) mx = v; }
    return { x: Array.from({ length: W }, (_, i) => i), y, yMin: mn, yMax: mx };
  }, [crossRow, currentFrame, W]);

  const vertCut = useMemo(() => {
    if (crossCol === null || !currentFrame) return null;
    const y = currentFrame.map(row => row[crossCol]);
    let mn = Infinity, mx = -Infinity;
    for (const v of y) { if (v < mn) mn = v; if (v > mx) mx = v; }
    return { x: Array.from({ length: H }, (_, i) => i), y, yMin: mn, yMax: mx };
  }, [crossCol, currentFrame, H]);

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !currentFrame) return;
    const palette = COLORMAPS[colormap] ?? COLORMAPS.viridis;
    drawFrame(canvas, currentFrame, crossRow, crossCol, vpRef.current, t => interpolateColor(palette, t));
  }, [currentFrame, crossRow, crossCol, viewport, colormap]);

  // Resize observer
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const obs = new ResizeObserver(() => {
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
      const frame = frameCache.get(frameIdx);
      if (frame) {
        const palette = COLORMAPS[colormap] ?? COLORMAPS.viridis;
        drawFrame(canvas, frame, crossRow, crossCol, vpRef.current, t => interpolateColor(palette, t));
      }
    });
    obs.observe(container);
    return () => obs.disconnect();
  }, [frameCache, frameIdx, colormap, crossRow, crossCol]); // eslint-disable-line react-hooks/exhaustive-deps

  // Split drag
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!splitDragRef.current || !layoutRef.current) return;
      const rect = layoutRef.current.getBoundingClientRect();
      if (splitDragRef.current === 'col') {
        const v = Math.max(20, Math.min(80, ((e.clientX - rect.left) / rect.width) * 100));
        setColSplit(v); localStorage.setItem('heatmapColSplit', String(v));
      } else {
        const v = Math.max(20, Math.min(80, ((e.clientY - rect.top) / rect.height) * 100));
        setRowSplit(v); localStorage.setItem('heatmapRowSplit', String(v));
      }
    };
    const onUp = () => { splitDragRef.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  // Wheel zoom
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const vp = vpRef.current;
      const rect = canvas.getBoundingClientRect();
      const fx = (e.clientX - rect.left) / rect.width;
      const fy = (e.clientY - rect.top) / rect.height;
      const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
      const newRowSpan = (vp.r1 - vp.r0) * factor;
      const newColSpan = (vp.c1 - vp.c0) * factor;
      const rowC = vp.r0 + fy * (vp.r1 - vp.r0);
      const colC = vp.c0 + fx * (vp.c1 - vp.c0);
      const r0 = Math.max(0, rowC - fy * newRowSpan);
      const r1 = Math.min(H, rowC + (1 - fy) * newRowSpan);
      const c0 = Math.max(0, colC - fx * newColSpan);
      const c1 = Math.min(W, colC + (1 - fx) * newColSpan);
      if (r1 - r0 >= H && c1 - c0 >= W) { setViewport(null); return; }
      setViewport({ r0, r1, c0, c1 });
    };
    canvas.addEventListener('wheel', handler, { passive: false });
    return () => canvas.removeEventListener('wheel', handler);
  }, [H, W]);

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
      const r0 = Math.max(0, Math.min(H - rowSpan, svp.r0 + dr));
      const c0 = Math.max(0, Math.min(W - colSpan, svp.c0 + dc));
      setViewport({ r0, r1: r0 + rowSpan, c0, c1: c0 + colSpan });
    }
  }, [H, W]);

  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setSelBox(null);
    if (!drag) return;

    if (drag.mode === 'select' && drag.moved) {
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
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const vp = vpRef.current;
      const col = Math.floor(vp.c0 + ((e.clientX - rect.left) / rect.width)  * (vp.c1 - vp.c0));
      const row = Math.floor(vp.r0 + ((e.clientY - rect.top)  / rect.height) * (vp.r1 - vp.r0));
      setCrossCol(Math.max(0, Math.min(W - 1, col)));
      setCrossRow(Math.max(0, Math.min(H - 1, row)));
    }
  }, [H, W]);

  const handleDoubleClick = useCallback(() => setViewport(null), []);
  const isZoomed = viewport !== null;

  // Axis ranges for cut plots — match the visible viewport so the crosshair aligns
  const evp = viewport ?? { r0: 0, r1: H, c0: 0, c1: W };
  const vertCutYRange: [number, number] = [evp.r1 - 0.5, evp.r0 - 0.5]; // reversed: row 0 at top
  const horizCutXRange: [number, number] = [evp.c0 - 0.5, evp.c1 - 0.5];

  return (
    <div className="h-full flex flex-col gap-2 overflow-hidden">
      {/* Toolbar */}
      <div className="flex-none flex items-center gap-3 px-1 text-xs font-sans">
        <span className="font-semibold text-gray-800">{fieldName}</span>
        <span className="text-gray-400">{H} × {W}{nFrames > 1 ? ` · ${nFrames} frames` : ''}</span>
        <select
          value={colormap}
          onChange={e => { setColormap(e.target.value); localStorage.setItem('heatmapColormap', e.target.value); }}
          className="border border-gray-200 rounded px-1.5 py-0.5 bg-white text-gray-700 text-xs"
        >
          {Object.keys(COLORMAPS).map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <span className="text-gray-400">scroll/⇧drag to zoom · drag to pan · click for crosshair</span>
        {isZoomed && (
          <button onClick={() => setViewport(null)} className="text-sky-600 hover:text-sky-800 underline">reset zoom</button>
        )}
        {crossRow !== null && crossCol !== null && (
          <span className="font-mono text-sky-600">
            row={crossRow} · col={crossCol}
            {currentFrame?.[crossRow]?.[crossCol] !== undefined && (
              <> · {Number.isInteger(currentFrame[crossRow][crossCol])
                ? currentFrame[crossRow][crossCol]
                : currentFrame[crossRow][crossCol].toPrecision(5)}</>
            )}
          </span>
        )}
        {onClose && (
          <button onClick={onClose} className="ml-auto text-gray-400 hover:text-gray-600 text-xl leading-none" aria-label="Close">×</button>
        )}
      </div>

      {/* Frame slider */}
      {nFrames > 1 && (
        <div className="flex-none flex items-center gap-2 px-1 text-xs font-sans">
          <span className="text-gray-500">Frame</span>
          <input
            type="range" min={0} max={nFrames - 1} value={frameIdx}
            onChange={e => setFrameIdx(Number(e.target.value))}
            className="flex-1"
          />
          <span className="text-gray-600 w-14 text-right">{frameIdx + 1} / {nFrames}</span>
        </div>
      )}

      {/* Main resizable layout */}
      <div ref={layoutRef} className="flex-1 min-h-0 flex flex-col select-none">

        {/* Top row: image + vertical cut */}
        <div className="flex min-h-0" style={{ height: `${rowSplit}%` }}>

          {/* Image canvas — outer div is full-size; inner div is inset to match PlotlyScatter margins */}
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
                  style={{ left: selBox.x, top: selBox.y, width: selBox.w, height: selBox.h, borderStyle: 'dashed', borderWidth: 1.5 }}
                />
              )}
              {loading && (
                <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-60 text-white text-sm font-sans">
                  Loading{nFrames > 1 ? ` frame ${frameIdx + 1}` : ''}…
                </div>
              )}
              {error && (
                <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-70 text-red-400 text-sm font-sans p-4 text-center">
                  {error}
                </div>
              )}
            </div>
          </div>

          {/* Column divider */}
          <div
            className="w-1.5 shrink-0 cursor-col-resize bg-gray-200 hover:bg-sky-300 active:bg-sky-400 transition-colors rounded mx-0.5"
            onMouseDown={e => { e.preventDefault(); splitDragRef.current = 'col'; }}
          />

          {/* Vertical cut (col profile) */}
          <div className="relative bg-white rounded border border-gray-200 overflow-hidden flex-1">
            {vertCut ? (
              <>
                <PlotlyScatter
                  data={[
                    { x: vertCut.y, y: vertCut.x, type: 'scatter', mode: 'lines', line: { color: '#0ea5e9' }, showlegend: false },
                    { x: [zMin, zMax], y: [crossRow!, crossRow!], type: 'scatter', mode: 'lines',
                      line: { color: 'rgba(100,100,100,0.45)', dash: 'dash', width: 1 }, hoverinfo: 'skip' as const, showlegend: false },
                  ]}
                  xAxisTitle={fieldName}
                  yAxisTitle="row"
                  yAxisRange={vertCutYRange}
                  className="w-full h-full"
                />
                {onAnalyzeCut && (
                  <button
                    onClick={() => onAnalyzeCut(vertCut.x, vertCut.y, 'row', fieldName, `${fieldName} col=${crossCol}`)}
                    className="absolute top-1 right-1 text-[10px] px-1.5 py-0.5 bg-gray-100 hover:bg-gray-200 border border-gray-300 rounded text-gray-600"
                    title="Open in analysis panel"
                  >Analyze</button>
                )}
              </>
            ) : (
              <div className="h-full flex items-center justify-center text-xs text-gray-400">Click image for column profile</div>
            )}
          </div>
        </div>

        {/* Row divider */}
        <div
          className="h-1.5 shrink-0 cursor-row-resize bg-gray-200 hover:bg-sky-300 active:bg-sky-400 transition-colors rounded my-0.5"
          onMouseDown={e => { e.preventDefault(); splitDragRef.current = 'row'; }}
        />

        {/* Bottom row: horizontal cut + info */}
        <div className="flex min-h-0 flex-1">

          {/* Horizontal cut (row profile) */}
          <div className="relative bg-white rounded border border-gray-200 overflow-hidden" style={{ width: `${colSplit}%` }}>
            {horizCut ? (
              <>
                <PlotlyScatter
                  data={[
                    { x: horizCut.x, y: horizCut.y, type: 'scatter', mode: 'lines', line: { color: '#10b981' }, showlegend: false },
                    { x: [crossCol!, crossCol!], y: [zMin, zMax], type: 'scatter', mode: 'lines',
                      line: { color: 'rgba(100,100,100,0.45)', dash: 'dash', width: 1 }, hoverinfo: 'skip' as const, showlegend: false },
                  ]}
                  xAxisTitle="col"
                  yAxisTitle={fieldName}
                  xAxisRange={horizCutXRange}
                  className="w-full h-full"
                />
                {onAnalyzeCut && (
                  <button
                    onClick={() => onAnalyzeCut(horizCut.x, horizCut.y, 'col', fieldName, `${fieldName} row=${crossRow}`)}
                    className="absolute top-1 right-1 text-[10px] px-1.5 py-0.5 bg-gray-100 hover:bg-gray-200 border border-gray-300 rounded text-gray-600"
                    title="Open in analysis panel"
                  >Analyze</button>
                )}
              </>
            ) : (
              <div className="h-full flex items-center justify-center text-xs text-gray-400">Click image for row profile</div>
            )}
          </div>

          {/* Spacer aligned with column divider */}
          <div className="w-1.5 shrink-0 mx-0.5" />

          {/* Info */}
          <div className="bg-gray-50 rounded border border-gray-200 flex-1 flex items-center justify-center">
            <div className="text-xs text-gray-400 text-center px-3 font-sans">
              <p className="font-medium text-gray-500">{fieldName}</p>
              <p className="mt-1">{H} rows × {W} cols{nFrames > 1 ? ` · frame ${frameIdx + 1}/${nFrames}` : ''}</p>
              <p className="mt-1 font-mono">
                z: [{zMin === Infinity ? '—' : zMin.toPrecision(4)}, {zMax === -Infinity ? '—' : zMax.toPrecision(4)}]
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
