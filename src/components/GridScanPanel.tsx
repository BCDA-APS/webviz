import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { PlotlyScatter } from '@blueskyproject/finch';

type Props = {
  serverUrl: string;
  catalog: string | null;
  runId: string;
  shape: [number, number]; // [nRows (slow), nCols (fast)]
  dimensions: string[][]; // [[slowMotorName, ...], [fastMotorName, ...]]
};

const catSeg = (c: string | null) => c ? `/${c}` : '';

// Viridis colormap (11 stops)
const VIRIDIS: [number, number, number][] = [
  [68, 1, 84], [72, 36, 117], [64, 67, 135], [52, 94, 141],
  [41, 120, 142], [32, 144, 140], [34, 167, 132], [68, 190, 112],
  [121, 209, 81], [189, 222, 38], [253, 231, 37],
];

function viridisColor(t: number): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, t));
  const idx = clamped * (VIRIDIS.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(VIRIDIS.length - 1, Math.ceil(idx));
  const frac = idx - lo;
  return [0, 1, 2].map(i => Math.round(VIRIDIS[lo][i] + frac * (VIRIDIS[hi][i] - VIRIDIS[lo][i]))) as [number, number, number];
}

function reshape(arr: number[], nRows: number, nCols: number): number[][] {
  return Array.from({ length: nRows }, (_, i) => arr.slice(i * nCols, (i + 1) * nCols));
}

async function fetchAllColumns(serverUrl: string, cs: string, runId: string): Promise<Record<string, number[]> | null> {
  // 1. Find primary stream
  const sj = await fetch(`${serverUrl}/api/v1/search${cs}/${runId}?page[limit]=50`).then(r => r.json());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const streams: string[] = (sj.data ?? []).map((d: any) => d.id);
  const stream = streams.includes('primary') ? 'primary' : (streams[0] ?? '');
  if (!stream) return null;

  // 2. Discover fields
  const fj = await fetch(`${serverUrl}/api/v1/search${cs}/${runId}/${stream}?page[limit]=200`).then(r => r.json());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let columns: string[] = (fj.data ?? []).filter((i: any) => i.attributes?.structure_family === 'array').map((i: any) => i.id);
  let arrayBase = `${serverUrl}/api/v1/array/full${cs}/${runId}/${stream}`;

  if (columns.length === 0) {
    // Try sub-nodes (MongoDB adapter)
    for (const sub of ['data', 'internal']) {
      const subj = await fetch(`${serverUrl}/api/v1/search${cs}/${runId}/${stream}/${sub}?page[limit]=200`).then(r => r.json());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cols: string[] = (subj.data ?? []).filter((i: any) => i.attributes?.structure_family === 'array').map((i: any) => i.id);
      if (cols.length > 0) {
        columns = cols;
        arrayBase = `${serverUrl}/api/v1/array/full${cs}/${runId}/${stream}/${sub}`;
        break;
      }
    }
    // Try table sub-node (PostgreSQL adapter)
    if (columns.length === 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tblItem = (fj.data ?? []).find((i: any) => i.attributes?.structure_family === 'table');
      if (tblItem) {
        columns = tblItem.attributes?.structure?.columns ?? [];
        arrayBase = `${serverUrl}/api/v1/array/full${cs}/${runId}/${stream}/${tblItem.id}`;
      }
    }
  }
  if (columns.length === 0) return null;

  // 3. Fetch each column
  const entries = await Promise.all(
    columns.map(async col => {
      const r = await fetch(`${arrayBase}/${col}?format=application/json`);
      if (!r.ok) return [col, []] as [string, number[]];
      const data = await r.json();
      return [col, Array.isArray(data) ? data.map(Number) : []] as [string, number[]];
    })
  );
  return Object.fromEntries(entries);
}

function drawHeatmap(
  canvas: HTMLCanvasElement,
  zMatrix: number[][],
  crossRow: number | null,
  crossCol: number | null,
) {
  const nRows = zMatrix.length;
  const nCols = zMatrix[0]?.length ?? 0;
  if (nRows === 0 || nCols === 0) return;

  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Compute z range
  let zMin = Infinity, zMax = -Infinity;
  for (const row of zMatrix) for (const v of row) { if (v < zMin) zMin = v; if (v > zMax) zMax = v; }
  const zRange = zMax - zMin || 1;

  const cellW = w / nCols;
  const cellH = h / nRows;

  const imageData = ctx.createImageData(w, h);
  const data = imageData.data;

  for (let row = 0; row < nRows; row++) {
    for (let col = 0; col < nCols; col++) {
      const t = (zMatrix[row][col] - zMin) / zRange;
      const [r, g, b] = viridisColor(t);
      const x0 = Math.floor(col * cellW);
      const x1 = Math.floor((col + 1) * cellW);
      const y0 = Math.floor(row * cellH);
      const y1 = Math.floor((row + 1) * cellH);
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const idx = (py * w + px) * 4;
          data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = 255;
        }
      }
    }
  }
  ctx.putImageData(imageData, 0, 0);

  // Draw crosshair
  if (crossRow !== null && crossCol !== null) {
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.5;
    // Horizontal line
    const cy = (crossRow + 0.5) * cellH;
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(w, cy); ctx.stroke();
    // Vertical line
    const cx = (crossCol + 0.5) * cellW;
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();
  }
}

export default function GridScanPanel({ serverUrl, catalog, runId, shape, dimensions }: Props) {
  const [nRows, nCols] = shape;
  const slowMotor = dimensions[0]?.[0] ?? '';
  const fastMotor = dimensions[1]?.[0] ?? '';

  const [allData, setAllData] = useState<Record<string, number[]> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [zField, setZField] = useState('');
  const [crossRow, setCrossRow] = useState<number | null>(null);
  const [crossCol, setCrossCol] = useState<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch all columns when run changes
  useEffect(() => {
    setAllData(null);
    setZField('');
    setCrossRow(null);
    setCrossCol(null);
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

  // Auto-pick z field (first non-motor, non-time field)
  useEffect(() => {
    if (!allData || zField) return;
    const motors = new Set([slowMotor, fastMotor]);
    const candidate = Object.keys(allData).find(f => !motors.has(f) && f !== 'time');
    if (candidate) setZField(candidate);
  }, [allData, zField, slowMotor, fastMotor]);

  // Derived: z matrix and axis value arrays
  const zMatrix = useMemo(() => {
    if (!allData || !zField || !allData[zField]) return null;
    return reshape(allData[zField], nRows, nCols);
  }, [allData, zField, nRows, nCols]);

  const slowAxis = useMemo(() => {
    if (!allData || !slowMotor || !allData[slowMotor]) return [];
    const vals = allData[slowMotor];
    return Array.from({ length: nRows }, (_, i) => vals[i * nCols]);
  }, [allData, slowMotor, nRows, nCols]);

  const fastAxis = useMemo(() => {
    if (!allData || !fastMotor || !allData[fastMotor]) return [];
    return allData[fastMotor].slice(0, nCols);
  }, [allData, fastMotor, nCols]);

  // Draw heatmap on canvas whenever data or crosshair changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !zMatrix) return;
    drawHeatmap(canvas, zMatrix, crossRow, crossCol);
  }, [zMatrix, crossRow, crossCol]);

  // Resize canvas to match container
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const obs = new ResizeObserver(() => {
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
      if (zMatrix) drawHeatmap(canvas, zMatrix, crossRow, crossCol);
    });
    obs.observe(container);
    return () => obs.disconnect();
  }, [zMatrix, crossRow, crossCol]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !zMatrix) return;
    const rect = canvas.getBoundingClientRect();
    const col = Math.floor(((e.clientX - rect.left) / rect.width) * nCols);
    const row = Math.floor(((e.clientY - rect.top) / rect.height) * nRows);
    setCrossRow(Math.max(0, Math.min(nRows - 1, row)));
    setCrossCol(Math.max(0, Math.min(nCols - 1, col)));
  }, [zMatrix, nRows, nCols]);

  // Cut data for plots
  const horizCut = useMemo(() => {
    if (crossRow === null || !zMatrix) return null;
    return { x: fastAxis, y: zMatrix[crossRow] };
  }, [crossRow, zMatrix, fastAxis]);

  const vertCut = useMemo(() => {
    if (crossCol === null || !zMatrix) return null;
    return { x: slowAxis, y: zMatrix.map(row => row[crossCol]) };
  }, [crossCol, zMatrix, slowAxis]);

  const nonMotorFields = useMemo(() => {
    if (!allData) return [];
    const motors = new Set([slowMotor, fastMotor, 'time']);
    return Object.keys(allData).filter(f => !motors.has(f));
  }, [allData, slowMotor, fastMotor]);

  if (loading) return <div className="h-full flex items-center justify-center text-gray-400 text-sm">Loading…</div>;
  if (error) return <div className="h-full flex items-center justify-center text-red-400 text-sm">{error}</div>;
  if (!allData) return <div className="h-full flex items-center justify-center text-gray-400 text-sm">No data</div>;

  return (
    <div className="h-full flex flex-col gap-2 overflow-hidden">
      {/* Toolbar */}
      <div className="flex-none flex items-center gap-3 px-1">
        <span className="text-xs text-gray-500 font-medium">Z:</span>
        <select
          value={zField}
          onChange={e => setZField(e.target.value)}
          className="text-xs border border-gray-200 rounded px-1.5 py-0.5 bg-white text-gray-700"
        >
          {nonMotorFields.map(f => <option key={f} value={f}>{f}</option>)}
        </select>
        <span className="text-xs text-gray-400">{nRows} × {nCols} grid · click heatmap to set crosshair</span>
        {crossRow !== null && crossCol !== null && (
          <span className="text-xs text-sky-600 font-mono">
            {slowMotor}={slowAxis[crossRow]?.toPrecision(4)} · {fastMotor}={fastAxis[crossCol]?.toPrecision(4)}
          </span>
        )}
      </div>

      {/* Main layout: heatmap + cuts */}
      <div className="flex-1 min-h-0 grid grid-cols-2 grid-rows-2 gap-2">
        {/* Heatmap */}
        <div className="relative bg-gray-900 rounded overflow-hidden" ref={containerRef}>
          <canvas
            ref={canvasRef}
            className="w-full h-full cursor-crosshair"
            onClick={handleCanvasClick}
          />
          {/* Axis labels */}
          <div className="absolute bottom-0 left-0 right-0 text-center text-[10px] text-gray-300 pb-0.5 pointer-events-none">
            {fastMotor}
          </div>
          <div className="absolute top-0 bottom-0 left-0 flex items-center text-[10px] text-gray-300 pl-0.5 pointer-events-none" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
            {slowMotor}
          </div>
        </div>

        {/* Vertical cut (column at crossCol) */}
        <div className="bg-white rounded border border-gray-200 overflow-hidden">
          {vertCut ? (
            <PlotlyScatter
              data={[{ x: vertCut.x, y: vertCut.y, type: 'scatter', mode: 'lines+markers', line: { color: '#0ea5e9' }, marker: { size: 4 } }]}
              xAxisTitle={slowMotor}
              yAxisTitle={zField}
              className="w-full h-full"
            />
          ) : (
            <div className="h-full flex items-center justify-center text-xs text-gray-400">
              Click heatmap for vertical cut
            </div>
          )}
        </div>

        {/* Horizontal cut (row at crossRow) */}
        <div className="bg-white rounded border border-gray-200 overflow-hidden">
          {horizCut ? (
            <PlotlyScatter
              data={[{ x: horizCut.x, y: horizCut.y, type: 'scatter', mode: 'lines+markers', line: { color: '#10b981' }, marker: { size: 4 } }]}
              xAxisTitle={fastMotor}
              yAxisTitle={zField}
              className="w-full h-full"
            />
          ) : (
            <div className="h-full flex items-center justify-center text-xs text-gray-400">
              Click heatmap for horizontal cut
            </div>
          )}
        </div>

        {/* Bottom-right: info / colorbar placeholder */}
        <div className="bg-gray-50 rounded border border-gray-200 flex items-center justify-center">
          <div className="text-xs text-gray-400 text-center px-3">
            <p className="font-medium text-gray-500">{runId.slice(0, 8)}…</p>
            <p className="mt-1">{shape[0]} rows × {shape[1]} cols</p>
            {zMatrix && (
              <p className="mt-1 font-mono">
                z: [{Math.min(...zMatrix.flat()).toPrecision(4)}, {Math.max(...zMatrix.flat()).toPrecision(4)}]
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
