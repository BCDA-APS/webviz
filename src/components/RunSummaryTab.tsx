import { useState, useEffect } from 'react';

type Props = {
  serverUrl: string;
  catalog: string | null;
  runId: string;
  runAcquiring?: boolean;
};

const catSeg = (c: string | null) => c ? `/${c}` : '';

type FieldDesc = {
  name: string;
  shape: number[];   // full shape excluding time dim, e.g. [] for scalar, [100,100] for image
  nRows: number;     // length of time dimension, 0 if unknown
  dtype: string;
  itemsize: number;  // bytes per element, 0 if unknown
};

type StreamDesc = {
  name: string;
  fields: FieldDesc[];
};

function fmtBytes(n: number): string {
  if (n <= 0) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}kB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

// Parse numpy dtype string like "<f8", ">i4", "|U20", "bool"
function parseNumpyDtype(s: string): { dtype: string; itemsize: number } {
  if (!s) return { dtype: '', itemsize: 0 };
  const m = s.match(/[<>=|!]?([a-zA-Z])(\d+)?/);
  if (!m) return { dtype: s, itemsize: 0 };
  const kind = m[1], nb = parseInt(m[2] ?? '0');
  const bits = nb * 8;
  if (kind === 'f') return { dtype: `float${bits}`, itemsize: nb };
  if (kind === 'i') return { dtype: `int${bits}`, itemsize: nb };
  if (kind === 'u') return { dtype: `uint${bits}`, itemsize: nb };
  if (kind === 'U') return { dtype: `<U${nb / 4}`, itemsize: nb };
  if (kind === 'b' || kind === 'B') return { dtype: 'bool', itemsize: 1 };
  if (kind === 'c') return { dtype: `complex${bits}`, itemsize: nb };
  return { dtype: s, itemsize: nb };
}

// Map bluesky JSON-schema dtype names to numpy-style strings
function mapBlueskeyDtype(d: string): string {
  if (d === 'number') return 'float64';
  if (d === 'integer') return 'int64';
  if (d === 'string') return 'str';
  if (d === 'boolean') return 'bool';
  return d || '';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeDtypeRaw(dt: any): { dtype: string; itemsize: number } {
  if (!dt) return { dtype: '', itemsize: 0 };
  if (typeof dt === 'string') return parseNumpyDtype(dt);
  const kind = dt.kind ?? '';
  const nb: number = dt.itemsize ?? 0;
  const bits = nb * 8;
  if (kind === 'f') return { dtype: `float${bits}`, itemsize: nb };
  if (kind === 'i') return { dtype: `int${bits}`, itemsize: nb };
  if (kind === 'u') return { dtype: `uint${bits}`, itemsize: nb };
  if (kind === 'U') return { dtype: `<U${nb / 4}`, itemsize: nb };
  if (kind === 'b' || kind === 'B') return { dtype: 'bool', itemsize: 1 };
  if (kind === 'c') return { dtype: `complex${bits}`, itemsize: nb };
  return { dtype: kind || '', itemsize: nb };
}

// Build a map: streamName → { fieldName → {dtype, itemsize, shape} }
// sourced from bluesky event descriptors (available in the run metadata).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildDescriptorMap(descriptors: any[]): Record<string, Record<string, { dtype: string; itemsize: number; shape: number[] }>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const map: Record<string, Record<string, any>> = {};
  for (const desc of descriptors) {
    const streamName: string = desc.name ?? '';
    if (!map[streamName]) map[streamName] = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const [key, info] of Object.entries(desc.data_keys ?? {} as Record<string, any>)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dk = info as any;
      // dtype_numpy takes priority (e.g. "<f8"), then dtype (JSON schema string)
      const rawNp = Array.isArray(dk.dtype_numpy) ? dk.dtype_numpy[0] : dk.dtype_numpy;
      const { dtype, itemsize } = rawNp
        ? parseNumpyDtype(rawNp)
        : { dtype: mapBlueskeyDtype(dk.dtype ?? ''), itemsize: dk.dtype === 'number' ? 8 : dk.dtype === 'integer' ? 8 : 0 };
      const shape: number[] = Array.isArray(dk.shape) ? dk.shape : [];
      map[streamName][key] = { dtype, itemsize, shape };
    }
  }
  return map;
}

// Probe a stream to get its field list + structure from Tiled search.
// For array adapters, nRows comes from shape[0] (the time dimension).
// For table adapters, nRows is left as 0 (to be filled from stop.num_events).
async function probeStreamFields(serverUrl: string, catalog: string | null, runId: string, stream: string): Promise<FieldDesc[]> {
  const r = await fetch(`${serverUrl}/api/v1/search${catSeg(catalog)}/${runId}/${stream}?page[limit]=200`);
  if (!r.ok) return [];
  const json = await r.json();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: any[] = json.data ?? [];

  // Arrays directly under stream (each has full shape + dtype in structure)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const arrayItems = items.filter((item: any) => item.attributes?.structure_family === 'array');
  if (arrayItems.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return arrayItems.map((item: any) => {
      const rawDt = item.attributes?.structure?.data_type ?? item.attributes?.structure?.dtype;
      const { dtype, itemsize } = normalizeDtypeRaw(rawDt);
      const fullShape: number[] = item.attributes?.structure?.shape ?? [];
      // fullShape[0] is the time dimension (nRows); rest are inner dims
      return { name: item.id, shape: fullShape.slice(1), nRows: fullShape[0] ?? 0, dtype, itemsize };
    });
  }

  // Table node (PostgreSQL adapter) — column names only, nRows from stop.num_events later
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tableItem = items.find((item: any) => item.attributes?.structure_family === 'table');
  if (tableItem) {
    const columns: string[] = tableItem.attributes?.structure?.columns ?? [];
    return columns.map(col => ({ name: col, shape: [], nRows: 0, dtype: '', itemsize: 0 }));
  }

  // Sub-nodes (MongoDB: primary/data or primary/internal)
  for (const sub of ['data', 'internal']) {
    const subR = await fetch(`${serverUrl}/api/v1/search${catSeg(catalog)}/${runId}/${stream}/${sub}?page[limit]=200`);
    if (!subR.ok) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const subItems: any[] = (await subR.json()).data ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const subArrays = subItems.filter((item: any) => item.attributes?.structure_family === 'array');
    if (subArrays.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return subArrays.map((item: any) => {
        const rawDt = item.attributes?.structure?.data_type ?? item.attributes?.structure?.dtype;
        const { dtype, itemsize } = normalizeDtypeRaw(rawDt);
        const fullShape: number[] = item.attributes?.structure?.shape ?? [];
        return { name: item.id, shape: fullShape.slice(1), nRows: fullShape[0] ?? 0, dtype, itemsize };
      });
    }
  }
  return [];
}

export default function RunSummaryTab({ serverUrl, catalog, runId, runAcquiring }: Props) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [meta, setMeta] = useState<Record<string, any> | null>(null);
  const [streams, setStreams] = useState<StreamDesc[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!serverUrl || catalog === null || !runId) { setMeta(null); setStreams([]); return; }
    setLoading(true);
    setMeta(null);
    setStreams([]);
    let cancelled = false;

    const fetchAll = async () => {
      if (cancelled) return;
      try {
        // Fetch run metadata (includes start, stop, descriptors)
        const metaR = await fetch(`${serverUrl}/api/v1/metadata${catSeg(catalog)}/${runId}`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const metaJson: any = metaR.ok ? await metaR.json() : {};
        const attrs = metaJson.data?.attributes?.metadata ?? {};
        setMeta(attrs);

        // Build descriptor map and num_events from already-fetched metadata
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const descMap = buildDescriptorMap(attrs.descriptors ?? []);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const numEvents: Record<string, number> = attrs.stop?.num_events ?? {};

        // Fetch stream list
        const streamR = await fetch(`${serverUrl}/api/v1/search${catSeg(catalog)}/${runId}?page[limit]=50`);
        if (!streamR.ok) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const streamNames: string[] = ((await streamR.json()).data ?? []).map((d: any) => d.id);

        // Probe fields for each stream, then enrich with descriptor info
        const descs = await Promise.all(streamNames.map(async streamName => {
          const rawFields = await probeStreamFields(serverUrl, catalog, runId, streamName);
          const streamDesc = descMap[streamName] ?? {};
          const nRowsFromStop = numEvents[streamName] ?? 0;

          const fields: FieldDesc[] = rawFields.map(f => {
            const desc = streamDesc[f.name];
            return {
              name: f.name,
              shape: f.shape.length > 0 ? f.shape : (desc?.shape ?? []),
              // Prefer probe nRows (from array shape[0]), fall back to stop.num_events
              nRows: f.nRows > 0 ? f.nRows : nRowsFromStop,
              dtype: f.dtype || desc?.dtype || '',
              itemsize: f.itemsize || desc?.itemsize || 0,
            };
          });

          // Add fields from descriptors not covered by Tiled probe (e.g. ts_* timestamps)
          for (const [key, desc] of Object.entries(streamDesc)) {
            if (!fields.find(f => f.name === key)) {
              fields.push({ name: key, shape: desc.shape, nRows: nRowsFromStop, dtype: desc.dtype, itemsize: desc.itemsize });
            }
          }

          return { name: streamName, fields };
        }));
        if (!cancelled) setStreams(descs);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchAll();
    const id = runAcquiring ? setInterval(fetchAll, 5000) : undefined;
    return () => { cancelled = true; if (id) clearInterval(id); };
  }, [serverUrl, catalog, runId, runAcquiring]);

  if (!runId) {
    return (
      <div className="h-full flex items-center justify-center text-gray-400 text-sm">
        Select a run to view summary
      </div>
    );
  }

  if (loading) {
    return <div className="flex items-center justify-center h-full text-gray-400 text-sm">Loading…</div>;
  }

  const start = meta?.start ?? {};
  const stop = meta?.stop ?? null;
  const scanId = start.scan_id;
  const planName = start.plan_name ?? '—';
  const detectors: string[] = Array.isArray(start.detectors) ? start.detectors : [];
  const motors: string[] = Array.isArray(start.motors)
    ? start.motors
    : Array.isArray(start.positioners) ? start.positioners : [];
  const startTime = start.time ? new Date(start.time * 1000).toLocaleString() : '—';
  const exitStatus = stop?.exit_status ?? (stop === null ? 'running' : '—');
  const numPoints = start.num_points;

  const rowCls = 'flex items-baseline gap-4 py-1 border-b border-gray-100 last:border-0';
  const labelCls = 'w-32 shrink-0 text-xs font-semibold text-gray-400 uppercase tracking-wide';
  const valueCls = 'text-xs text-gray-800 font-mono';

  const summaryRows: [string, string][] = [
    ['scan', scanId != null ? String(scanId) : '—'],
    ['plan', planName],
    ['detectors', detectors.join(', ') || '—'],
    ['positioners', motors.join(', ') || '—'],
    ['start time', startTime],
    ['exit status', exitStatus],
    ...(numPoints != null ? [['num points', String(numPoints)] as [string, string]] : []),
  ];

  const fieldSize = (f: FieldDesc): string => {
    if (!f.itemsize || !f.nRows) return '';
    const innerElements = f.shape.reduce((a, b) => a * b, 1);
    return fmtBytes(f.nRows * innerElements * f.itemsize);
  };

  const dimStr = (f: FieldDesc): string => {
    if (!f.nRows) return '';
    if (f.shape.length === 0) return `(time: ${f.nRows})`;
    return `(time: ${f.nRows}, ${f.shape.join(', ')})`;
  };

  return (
    <div className="h-full overflow-auto p-4 space-y-4">
      {/* Run summary card */}
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Run Summary</h3>
        <div className="divide-y divide-gray-100">
          {summaryRows.map(([label, value]) => (
            <div key={label} className={rowCls}>
              <span className={labelCls}>{label}</span>
              <span className={`${valueCls} ${label === 'exit status'
                ? value === 'success' ? 'text-green-700' : value === 'running' ? 'text-sky-600 animate-pulse' : 'text-red-600'
                : ''}`}>
                {value}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Stream sections */}
      {streams.map(stream => {
        const timeField = stream.fields.find(f => f.name === 'time');
        const nRows = stream.fields.find(f => f.nRows > 0)?.nRows ?? 0;
        const dataVars = stream.fields.filter(f => f.name !== 'time');

        // Total size = sum of all field sizes
        const totalBytes = stream.fields.reduce((acc, f) => {
          if (!f.itemsize || !f.nRows) return acc;
          const inner = f.shape.reduce((a, b) => a * b, 1);
          return acc + f.nRows * inner * f.itemsize;
        }, 0);

        return (
          <div key={stream.name} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            {/* Stream header */}
            <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 flex items-center gap-3 flex-wrap">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">stream</span>
              <span className="text-sm font-mono font-medium text-gray-800">{stream.name}</span>
              {totalBytes > 0 && (
                <span className="text-xs text-gray-500">Size: {fmtBytes(totalBytes)}</span>
              )}
              <span className="text-xs text-gray-400">
                · {stream.fields.length} variable{stream.fields.length !== 1 ? 's' : ''}
              </span>
            </div>

            {stream.fields.length === 0 ? (
              <div className="px-4 py-3 text-xs text-gray-400">No fields found</div>
            ) : (
              <table className="w-full text-xs font-mono">
                <tbody>
                  {/* Dimensions */}
                  {nRows > 0 && (
                    <tr className="border-b border-gray-100">
                      <td className="px-4 py-1.5 text-gray-400 w-28 align-top">Dimensions</td>
                      <td className="px-2 py-1.5 text-gray-600 whitespace-nowrap">(time: {nRows})</td>
                      <td className="px-2 py-1.5" /><td className="px-4 py-1.5" />
                    </tr>
                  )}

                  {/* Coordinates */}
                  {timeField && (
                    <>
                      <tr>
                        <td className="px-4 pt-2 pb-0.5 text-gray-400 font-sans font-semibold text-[10px] uppercase tracking-wide" colSpan={4}>
                          Coordinates
                        </td>
                      </tr>
                      <tr className="border-b border-gray-100 bg-sky-50/30">
                        <td className="pl-6 pr-2 py-1 text-sky-600 whitespace-nowrap">✦ time</td>
                        <td className="px-2 py-1 text-gray-500 whitespace-nowrap">{dimStr(timeField)}</td>
                        <td className="px-2 py-1 text-amber-600 whitespace-nowrap">{fieldSize(timeField)}</td>
                        <td className="px-4 py-1 text-purple-600 whitespace-nowrap">{timeField.dtype}</td>
                      </tr>
                    </>
                  )}

                  {/* Data variables */}
                  {dataVars.length > 0 && (
                    <>
                      <tr>
                        <td className="px-4 pt-2 pb-0.5 text-gray-400 font-sans font-semibold text-[10px] uppercase tracking-wide" colSpan={4}>
                          Data variables
                        </td>
                      </tr>
                      {dataVars.map(f => (
                        <tr key={f.name} className="border-b border-gray-100 last:border-0">
                          <td className="pl-6 pr-2 py-1 text-gray-700 whitespace-nowrap">{f.name}</td>
                          <td className="px-2 py-1 text-gray-500 whitespace-nowrap">{dimStr(f)}</td>
                          <td className="px-2 py-1 text-amber-600 whitespace-nowrap">{fieldSize(f)}</td>
                          <td className="px-4 py-1 text-purple-600 whitespace-nowrap">{f.dtype}</td>
                        </tr>
                      ))}
                    </>
                  )}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
}
