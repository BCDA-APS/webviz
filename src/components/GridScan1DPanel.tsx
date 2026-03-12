import { useState, useEffect, useMemo, useCallback } from 'react';
import { PlotlyScatter } from '@blueskyproject/finch';
import { buildZMatrix } from '../utils/scanUtils';
import { fetchAllColumns } from './GridScanPanel';

const catSeg = (c: string | null) => c ? `/${c}` : '';

type Props = {
  serverUrl: string;
  catalog: string | null;
  runId: string;
  dimensions: string[][];
  zField?: string;
  runAcquiring?: boolean;
  onClose?: () => void;
};

export default function GridScan1DPanel({ serverUrl, catalog, runId, dimensions, zField, runAcquiring, onClose }: Props) {
  const slowMotor = dimensions[0]?.[0] ?? '';
  const fastMotor = dimensions[1]?.[0] ?? '';

  const [allData, setAllData] = useState<Record<string, number[]> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [xAxis, setXAxis] = useState<'fast' | 'slow'>('fast');
  const [sliderIndex, setSliderIndex] = useState(0);

  const loadData = useCallback(() => {
    const cs = catSeg(catalog);
    return fetchAllColumns(serverUrl, cs, runId)
      .then(d => setAllData(d))
      .catch(e => setError(String(e)));
  }, [serverUrl, catalog, runId]);

  useEffect(() => {
    setAllData(null);
    setError('');
    setSliderIndex(0);
    setLoading(true);
    loadData().finally(() => setLoading(false));
  }, [loadData]);

  // Auto-refresh while acquiring
  useEffect(() => {
    if (!runAcquiring) return;
    const id = setInterval(loadData, 2000);
    return () => clearInterval(id);
  }, [runAcquiring, loadData]);

  const effectiveZField = useMemo(() => {
    if (!allData) return '';
    const motors = new Set([slowMotor, fastMotor]);
    const auto = Object.keys(allData).find(f => !motors.has(f) && f !== 'time') ?? '';
    if (zField && allData[zField]?.length > 0) return zField;
    return auto;
  }, [zField, allData, slowMotor, fastMotor]);

  const matrixResult = useMemo(() => {
    if (!allData || !effectiveZField || !slowMotor || !fastMotor) return null;
    return buildZMatrix(allData, effectiveZField, slowMotor, fastMotor);
  }, [allData, effectiveZField, slowMotor, fastMotor]);

  const zMatrix = matrixResult?.zMatrix ?? null;
  const slowAxis = matrixResult?.slowAxis ?? [];
  const fastAxis = matrixResult?.fastAxis ?? [];

  // The "other" axis is the one not plotted on x
  const otherAxis = xAxis === 'fast' ? slowAxis : fastAxis;
  const clampedIndex = Math.min(sliderIndex, Math.max(0, otherAxis.length - 1));

  // During acquisition, auto-advance slider to the latest position on the other axis.
  // For xAxis==='fast' this tracks the current slow motor row as new rows start;
  // for xAxis==='slow' the fast axis is stable after row 0 so this is a no-op.
  useEffect(() => {
    if (!runAcquiring || otherAxis.length === 0) return;
    setSliderIndex(otherAxis.length - 1);
  }, [runAcquiring, otherAxis.length]);

  const { plotX, plotY, xLabel } = useMemo(() => {
    if (!zMatrix || !slowAxis.length || !fastAxis.length) {
      return { plotX: [] as number[], plotY: [] as number[], xLabel: '' };
    }
    if (xAxis === 'fast') {
      return { plotX: fastAxis, plotY: zMatrix[clampedIndex] ?? [], xLabel: fastMotor };
    }
    return { plotX: slowAxis, plotY: zMatrix.map(row => row[clampedIndex]), xLabel: slowMotor };
  }, [zMatrix, slowAxis, fastAxis, xAxis, clampedIndex, fastMotor, slowMotor]);

  if (loading) return <div className="h-full flex items-center justify-center text-gray-400 text-sm">Loading…</div>;
  if (error) return <div className="h-full flex items-center justify-center text-red-400 text-sm">{error}</div>;
  if (!allData || !zMatrix) return <div className="h-full flex items-center justify-center text-gray-400 text-sm">No data</div>;

  return (
    <div className="h-full flex flex-col gap-2 overflow-hidden">
      {/* Toolbar */}
      <div className="flex-none flex items-center gap-3 px-1 flex-wrap">
        {effectiveZField && <span className="text-xs text-gray-600 font-medium">Z: {effectiveZField}</span>}
        <span className="text-xs text-gray-400">vs</span>
        <label className="flex items-center gap-1 text-xs cursor-pointer">
          <input type="radio" name="1d-xAxis" checked={xAxis === 'fast'} onChange={() => setXAxis('fast')} className="accent-sky-600" />
          <span>{fastMotor} (fast)</span>
        </label>
        <label className="flex items-center gap-1 text-xs cursor-pointer">
          <input type="radio" name="1d-xAxis" checked={xAxis === 'slow'} onChange={() => setXAxis('slow')} className="accent-sky-600" />
          <span>{slowMotor} (slow)</span>
        </label>
        {runAcquiring && <span className="text-xs text-green-600 font-medium animate-pulse">● live</span>}
        {onClose && (
          <button onClick={onClose} className="ml-auto text-gray-400 hover:text-gray-600 text-xl leading-none" aria-label="Close panel">×</button>
        )}
      </div>

      {/* Slider for fixed motor position */}
      <div className="flex-none flex items-center gap-2 px-1">
        <span className="text-xs text-gray-500 shrink-0">{xAxis === 'fast' ? slowMotor : fastMotor}:</span>
        <input
          type="range"
          min={0}
          max={Math.max(0, otherAxis.length - 1)}
          step={1}
          value={clampedIndex}
          onChange={e => setSliderIndex(parseInt(e.target.value))}
          className="flex-1"
        />
        <span className="text-xs font-mono text-gray-700 w-28 text-right shrink-0">
          {otherAxis[clampedIndex]?.toPrecision(4) ?? '—'} ({clampedIndex + 1}/{otherAxis.length})
        </span>
      </div>

      {/* Plot */}
      <div className="flex-1 min-h-0 bg-white rounded border border-gray-200 overflow-hidden">
        <PlotlyScatter
          data={[{
            x: plotX,
            y: plotY,
            type: 'scatter',
            mode: 'lines+markers',
            line: { color: '#0ea5e9' },
            marker: { size: 5 },
            showlegend: false,
          }]}
          xAxisTitle={xLabel}
          yAxisTitle={effectiveZField}
          className="w-full h-full"
        />
      </div>
    </div>
  );
}
