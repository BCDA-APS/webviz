import { useState, useEffect, useCallback, useMemo, useRef, forwardRef, useImperativeHandle } from 'react';
import type { XYTrace } from '../types';

type FieldInfo = {
  name: string;
  shape: number[];
};

type FieldSelectorProps = {
  serverUrl: string;
  catalog: string;
  runId: string;
  runLabel: string;
  runDetectors: string[];
  runMotors: string[];
  runAcquiring: boolean;
  onPlot: (traces: XYTrace[], title: string) => void;
  onAddTraces: ((traces: XYTrace[]) => void) | null;
  onLivePlot: ((traces: XYTrace[], title: string, stream: string, dataSubNode: string, dataNodeFamily: 'array' | 'table') => void) | null;
  onRemoveRunTraces?: (runId: string) => void;
};

export type FieldSelectorHandle = { schedulePlot: () => void; scheduleLive: () => void; removeY: (yLabel: string) => void };

const FieldSelector = forwardRef<FieldSelectorHandle, FieldSelectorProps>(function FieldSelector({
  serverUrl, catalog, runId, runLabel,
  runDetectors, runMotors, runAcquiring,
  onPlot, onAddTraces, onLivePlot, onRemoveRunTraces,
}, ref) {
  const [streams, setStreams] = useState<string[]>([]);
  const [selectedStream, setSelectedStream] = useState('');
  const [fields, setFields] = useState<FieldInfo[]>([]);
  const [xField, setXField] = useState('');
  const [yFields, setYFields] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const lastXRef = useRef('');
  const lastYRef = useRef<string[]>([]);
  // True after we removed traces via onRemoveRunTraces, so the next Y check re-creates the panel
  const removedTracesRef = useRef(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const [pendingAction, setPendingAction] = useState<'plot' | 'live' | null>(null);
  const [dataSubNode, setDataSubNode] = useState('');
  const [dataNodeFamily, setDataNodeFamily] = useState<'array' | 'table'>('array');
  const [livePointCount, setLivePointCount] = useState<number | null>(null);

  // Reset removedTracesRef when the run changes so it doesn't bleed into the next run
  useEffect(() => { removedTracesRef.current = false; }, [runId]);

  // Fetch streams for this run
  useEffect(() => {
    if (!serverUrl || !catalog || !runId) return;
    setStreams([]);
    setSelectedStream('');
    fetch(`${serverUrl}/api/v1/search/${catalog}/${runId}?page[limit]=50`)
      .then(r => r.json())
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then(json => {
        const names: string[] = (json.data ?? []).map((item: any) => item.id);
        setStreams(names);
        setSelectedStream(names.includes('primary') ? 'primary' : (names[0] ?? ''));
      })
      .catch(() => {});
  }, [serverUrl, catalog, runId]);

  const fetchFields = useCallback(() => {
    if (!selectedStream) return;
    setLoading(true);
    setFields([]);
    setError('');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parseArrayItems = (json: any): FieldInfo[] =>
      (json.data ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((item: any) => item.attributes?.structure_family === 'array')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((item: any) => ({ name: item.id, shape: item.attributes?.structure?.shape ?? [] }));

    const fetchUrl = (url: string) =>
      fetch(url).then(r => r.ok ? r.json() : Promise.reject(new Error('http')));

    const streamUrl = `${serverUrl}/api/v1/search/${catalog}/${runId}/${selectedStream}?page[limit]=200`;

    fetchUrl(streamUrl)
      .then(json => {
        // Arrays directly under stream
        const arrays = parseArrayItems(json);
        if (arrays.length > 0) {
          setDataSubNode(''); setDataNodeFamily('array'); setFields(arrays); return;
        }
        // Table node under stream (PostgreSQL adapter)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tableItem = (json.data ?? []).find((item: any) => item.attributes?.structure_family === 'table');
        if (tableItem) {
          const columns: string[] = tableItem.attributes?.structure?.columns ?? [];
          setDataSubNode(tableItem.id); setDataNodeFamily('table');
          setFields(columns.map((col: string) => ({ name: col, shape: [] })));
          return;
        }
        // Try sub-nodes as array containers (older MongoDB adapter)
        const trySubNode = (sub: string) =>
          fetchUrl(`${serverUrl}/api/v1/search/${catalog}/${runId}/${selectedStream}/${sub}?page[limit]=200`)
            .then(j => { const fs = parseArrayItems(j); if (fs.length === 0) throw new Error('empty'); return { fs, sub }; });

        return trySubNode('data')
          .catch(() => trySubNode('internal'))
          .then(({ fs, sub }) => { setDataSubNode(sub); setDataNodeFamily('array'); setFields(fs); });
      })
      .catch(() => setError('Failed to load fields'))
      .finally(() => setLoading(false));
  }, [serverUrl, catalog, runId, selectedStream]);

  useEffect(() => { fetchFields(); }, [fetchFields]);

  // Prefix-aware classification: device names like "tetramm1" match fields "tetramm1_current1_..."
  const matchesDev = (fieldName: string, devNames: string[]) =>
    devNames.some(d => fieldName === d || fieldName.startsWith(d + '_'));

  const devSortKey = (fieldName: string, devNames: string[]) => {
    const idx = devNames.findIndex(d => fieldName === d || fieldName.startsWith(d + '_'));
    return idx === -1 ? Infinity : idx;
  };

  // Sort fields: time → motors → other → detectors
  const sortedFields = useMemo(() => {
    const timeFields = fields.filter(f => f.name === 'time');
    const motorFields = fields
      .filter(f => f.name !== 'time' && matchesDev(f.name, runMotors))
      .sort((a, b) => devSortKey(a.name, runMotors) - devSortKey(b.name, runMotors));
    const detectorFields = fields
      .filter(f => matchesDev(f.name, runDetectors))
      .sort((a, b) => devSortKey(a.name, runDetectors) - devSortKey(b.name, runDetectors));
    const otherFields = fields.filter(
      f => f.name !== 'time' && !matchesDev(f.name, runMotors) && !matchesDev(f.name, runDetectors)
    );
    return [...timeFields, ...motorFields, ...otherFields, ...detectorFields];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, runDetectors, runMotors]);

  // Auto-preselect X and Y: restore last user selection if it exists, else fall back to defaults
  useEffect(() => {
    if (sortedFields.length === 0) return;
    const fieldNames = new Set(sortedFields.map(f => f.name));

    if (lastXRef.current && fieldNames.has(lastXRef.current)) {
      setXField(lastXRef.current);
    } else {
      const firstMotor = sortedFields.find(f => f.name !== 'time' && matchesDev(f.name, runMotors));
      setXField(firstMotor?.name ?? '');
    }

    const validLastY = lastYRef.current.filter(y => fieldNames.has(y));
    if (validLastY.length > 0) {
      setYFields(validLastY);
    } else {
      const firstDet = sortedFields.find(f => matchesDev(f.name, runDetectors));
      setYFields(firstDet ? [firstDet.name] : []);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedFields, runMotors, runDetectors]);

  const selectXField = (name: string) => {
    lastXRef.current = name;
    setXField(name);
    if (onAddTraces) handlePlot(name, yFields);
  };

  const toggleYField = (name: string) => {
    const next = yFields.includes(name) ? yFields.filter(n => n !== name) : [...yFields, name];
    lastYRef.current = next;
    setYFields(next);
    if (onAddTraces || removedTracesRef.current) {
      if (next.length > 0) {
        removedTracesRef.current = false;
        handlePlot(xField, next);
      } else {
        removedTracesRef.current = true;
        onRemoveRunTraces?.(runId);
      }
    }
  };

  const fetchAllTraces = async (x: string, ys: string[]): Promise<XYTrace[]> => {
    const subPath = dataSubNode ? `/${dataSubNode}` : '';
    if (dataNodeFamily === 'table') {
      const resp = await fetch(`${serverUrl}/api/v1/table/full/${catalog}/${runId}/${selectedStream}${subPath}?format=application/json`);
      if (!resp.ok) throw new Error('Fetch failed');
      const table = await resp.json();
      const seqNums: number[] = table.seq_num ?? [];
      const nRows = seqNums.length > 0 ? (seqNums.findIndex(s => s === 0) === -1 ? seqNums.length : seqNums.findIndex(s => s === 0)) : undefined;
      return ys.map(yf => {
        const yArr = nRows !== undefined ? (table[yf] ?? []).slice(0, nRows) : (table[yf] ?? []);
        const xArr = nRows !== undefined ? (table[x] ?? []).slice(0, nRows) : (table[x] ?? []);
        return { x: xArr, y: yArr, xLabel: x, yLabel: yf, runLabel, runId };
      });
    }
    const base = `${serverUrl}/api/v1/array/full/${catalog}/${runId}/${selectedStream}${subPath}`;
    const yResps = await Promise.all(ys.map(yf => fetch(`${base}/${yf}?format=application/json`)));
    if (yResps.some(r => !r.ok)) throw new Error('Fetch failed');
    const yDatas: number[][] = await Promise.all(yResps.map(r => r.json()));
    const xResp = await fetch(`${base}/${x}?format=application/json`);
    if (!xResp.ok) throw new Error('Fetch failed');
    const xData: number[] = await xResp.json();
    return ys.map((yf, i) => ({ x: xData, y: yDatas[i], xLabel: x, yLabel: yf, runLabel, runId }));
  };

  const handlePlot = async (x = xField, ys = yFields) => {
    if (!x || ys.length === 0 || adding) return;
    setAdding(true);
    setError('');
    try {
      const traces = await fetchAllTraces(x, ys);
      const title = ys.length === 1 ? `${ys[0]} vs ${x}` : `${ys.join(', ')} vs ${x}`;
      onPlot(traces, title);
    } catch {
      setError('Failed to fetch data');
    } finally {
      setAdding(false);
    }
  };

  // Auto-schedule live plot when selecting an acquiring run; clear when switching to non-acquiring
  useEffect(() => {
    setPendingAction(runAcquiring && !!onLivePlot ? 'live' : null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  // When waiting for live and primary stream hasn't appeared yet, poll for it
  useEffect(() => {
    if (pendingAction !== 'live' || selectedStream === 'primary') return;
    const poll = () =>
      fetch(`${serverUrl}/api/v1/search/${catalog}/${runId}?page[limit]=50`)
        .then(r => r.json())
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .then(json => {
          const names: string[] = (json.data ?? []).map((item: any) => item.id);
          if (names.includes('primary')) { setStreams(names); setSelectedStream('primary'); }
        })
        .catch(() => {});
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAction, selectedStream, serverUrl, catalog, runId]);

  // Retry fetchFields every 2s while on primary but waiting for data to appear
  useEffect(() => {
    if (pendingAction !== 'live' || loading || fields.length > 0 || selectedStream !== 'primary') return;
    const id = setInterval(fetchFields, 2000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAction, loading, fields.length, selectedStream]);

  // Fire plot/live once fields are ready; guard live against non-primary stream
  useEffect(() => {
    if (pendingAction && !loading && xField && yFields.length > 0) {
      if (pendingAction === 'live' && selectedStream !== 'primary') return;
      const action = pendingAction;
      setPendingAction(null);
      if (action === 'live') handleLivePlot();
      else handlePlot();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAction, loading, xField, yFields, selectedStream]);

  useImperativeHandle(ref, () => ({
    schedulePlot: () => setPendingAction('plot'),
    scheduleLive: () => setPendingAction('live'),
    removeY: (yLabel: string) => {
      setYFields(prev => {
        const next = prev.filter(y => y !== yLabel);
        lastYRef.current = next;
        return next;
      });
    },
  }), []);

  // Fetch table row count for shape display — polls every 2s while acquiring, once when completed
  useEffect(() => {
    if (dataNodeFamily !== 'table' || !dataSubNode || selectedStream !== 'primary' || fields.length === 0 || pendingAction !== null) {
      setLivePointCount(null);
      return;
    }
    const subPath = `/${dataSubNode}`;
    let cancelled = false;
    const fetchCount = async () => {
      try {
        const resp = await fetch(`${serverUrl}/api/v1/table/full/${catalog}/${runId}/${selectedStream}${subPath}?format=application/json`);
        if (!resp.ok || cancelled) return;
        const table = await resp.json();
        const seqNums: number[] = table.seq_num ?? [];
        const nRows = seqNums.length > 0
          ? (seqNums.findIndex(s => s === 0) === -1 ? seqNums.length : seqNums.findIndex(s => s === 0))
          : 0;
        if (!cancelled) setLivePointCount(nRows);
      } catch { }
    };
    fetchCount();
    const id = runAcquiring ? setInterval(fetchCount, 2000) : undefined;
    return () => { cancelled = true; if (id) clearInterval(id); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runAcquiring, dataNodeFamily, dataSubNode, selectedStream, fields.length, serverUrl, catalog, runId, pendingAction]);

  const handleLivePlot = async () => {
    if (!xField || yFields.length === 0 || adding || !onLivePlot) return;
    setAdding(true);
    setError('');
    try {
      const traces = await fetchAllTraces(xField, yFields);
      const title = yFields.length === 1
        ? `${yFields[0]} vs ${xField}`
        : `${yFields.join(', ')} vs ${xField}`;
      onLivePlot(traces, title, selectedStream, dataSubNode, dataNodeFamily);
    } catch {
      setError('Failed to fetch data');
    } finally {
      setAdding(false);
    }
  };

  const handleAddTraces = async () => {
    if (!xField || yFields.length === 0 || adding || !onAddTraces) return;
    setAdding(true);
    setError('');
    try {
      const traces = await fetchAllTraces(xField, yFields);
      onAddTraces(traces);
    } catch {
      setError('Failed to fetch data');
    } finally {
      setAdding(false);
    }
  };

  const thClass = 'px-2 py-1 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-200 bg-gray-50';
  const tdClass = 'px-2 py-1 text-xs text-gray-700';

  return (
    <div className="flex flex-col h-full overflow-hidden border-t-2 border-gray-200">
      {/* Header */}
      <div className="shrink-0 px-3 py-2 bg-gray-50 border-b border-gray-200">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-xs font-semibold text-gray-600">Fields</span>
          <span className="text-xs text-gray-400 truncate" title={runLabel}>{runLabel}</span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={selectedStream}
            onChange={e => setSelectedStream(e.target.value)}
            className="text-xs bg-white border border-gray-300 rounded px-2 py-1 focus:outline-none focus:border-sky-400"
          >
            {streams.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => { setPendingAction(null); handlePlot(); }}
              disabled={!xField || yFields.length === 0 || adding}
              className="px-2 py-0.5 text-xs bg-sky-600 text-white rounded hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed font-medium"
              title="Replace plot with selected fields"
            >{adding ? '…' : 'Plot'}</button>
            <button
              onClick={handleAddTraces}
              disabled={!xField || yFields.length === 0 || adding || !onAddTraces}
              className="px-2 py-0.5 text-xs bg-white border border-sky-600 text-sky-600 rounded hover:bg-sky-50 disabled:opacity-40 disabled:cursor-not-allowed font-medium"
              title={onAddTraces ? 'Add curve(s) to current plot' : 'No plot open — use Plot first'}
            >+</button>
          </div>
        </div>
        {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-scroll">
        {loading || (pendingAction === 'live' && fields.length === 0) ? (
          <div className="flex items-center justify-center h-20 text-gray-400 text-xs">
            {pendingAction === 'live' && !loading ? 'Waiting for run to start…' : 'Loading…'}
          </div>
        ) : (
          <table className="w-full border-collapse">
            <thead className="sticky top-0 z-10">
              <tr>
                <th className={thClass}>Field</th>
                <th className={`${thClass} text-center w-8`}>X</th>
                <th className={`${thClass} text-center w-8`}>Y</th>
                <th className={`${thClass} text-right`}>Shape</th>
              </tr>
            </thead>
            <tbody>
              {sortedFields.map((f, i) => {
                const isDet = matchesDev(f.name, runDetectors);
                const isMotor = f.name !== 'time' && matchesDev(f.name, runMotors);
                const rowBg = i % 2 === 0 ? 'bg-white' : 'bg-gray-50';
                return (
                  <tr key={f.name} className={`cursor-pointer hover:bg-sky-50 ${rowBg}`}>
                    <td className={`${tdClass} font-mono`}>
                      {f.name}
                      {isDet && <span className="ml-1 text-[10px] text-purple-400 font-sans">det</span>}
                      {isMotor && <span className="ml-1 text-[10px] text-green-500 font-sans">mot</span>}
                    </td>
                    <td className={`${tdClass} text-center`}>
                      <input
                        type="radio"
                        name="xField"
                        checked={xField === f.name}
                        onChange={() => selectXField(f.name)}
                        className="accent-sky-600"
                      />
                    </td>
                    <td className={`${tdClass} text-center`}>
                      <input
                        type="checkbox"
                        checked={yFields.includes(f.name)}
                        onChange={() => toggleYField(f.name)}
                        className="accent-sky-600"
                      />
                    </td>
                    <td className={`${tdClass} text-right text-gray-400`}>
                      {livePointCount !== null ? `(${livePointCount})` : `(${f.shape.join(', ')})`}
                    </td>
                  </tr>
                );
              })}
              {sortedFields.length === 0 && !loading && (
                <tr>
                  <td colSpan={4} className="px-2 py-6 text-center text-xs text-gray-400">No fields found</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
});

export default FieldSelector;
