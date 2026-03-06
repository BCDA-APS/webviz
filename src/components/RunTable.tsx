import { useState, useEffect, useMemo, useRef } from 'react';

type RunRow = {
  id: string;
  scanId?: number | string;
  planName?: string;
  detectors?: string;
  positioners?: string;
  numPoints?: number;
  detectorList: string[];
  motorList: string[];
  date?: string;
  status?: string;
  acquiring: boolean;
};

type RunTableProps = {
  serverUrl: string;
  catalog: string;
  page: number;
  selectedRunId?: string;
  autoFollow?: boolean;
  onPageChange: (page: number) => void;
  onSelectRun: (runId: string, label: string, detectors: string[], motors: string[], acquiring: boolean) => void;
  onDoubleClickRun?: (runId: string, label: string, detectors: string[], motors: string[], acquiring: boolean) => void;
  onAutoFollowChange?: (v: boolean) => void;
  onNewAcquiringRun?: (runId: string, label: string, detectors: string[], motors: string[], acquiring: boolean) => void;
};

type Filters = {
  scanId: string;
  planName: string;
  detector: string;
  positioner: string;
  text: string;
  since: string;
  until: string;
};

const EMPTY_FILTERS: Filters = { scanId: '', planName: '', detector: '', positioner: '', text: '', since: '', until: '' };
const PAGE_SIZE = 20;

function parseRun(item: Record<string, unknown>): RunRow {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const attrs = (item.attributes ?? {}) as Record<string, any>;
  const start = attrs.metadata?.start ?? {};
  const stop  = attrs.metadata?.stop;
  const detectorList: string[] = Array.isArray(start.detectors) ? start.detectors : [];
  const motorList: string[] = Array.isArray(start.motors)
    ? start.motors
    : Array.isArray(start.positioners) ? start.positioners : [];
  const date = start.time
    ? new Date(start.time * 1000).toLocaleString()
    : undefined;
  return {
    id:           String(item.id ?? ''),
    scanId:       start.scan_id,
    planName:     start.plan_name,
    detectors:    detectorList.join(', ') || undefined,
    positioners:  motorList.join(', ') || undefined,
    numPoints:    start.num_points,
    detectorList,
    motorList,
    date,
    status:       stop?.exit_status,
    acquiring:    !stop,
  };
}

const DAY_MS = 86_400_000;
const msToLocal = (ms: number) => new Date(ms).toISOString().slice(0, 16);


function buildFilterQs(f: Filters): URLSearchParams {
  const qs = new URLSearchParams();
  if (f.scanId) {
    const n = Number(f.scanId);
    if (Number.isFinite(n)) {
      qs.append('filter[eq][condition][key]',   'scan_id');
      qs.append('filter[eq][condition][value]',  JSON.stringify(n));
    }
  }
  if (f.planName) {
    qs.append('filter[eq][condition][key]',   'plan_name');
    qs.append('filter[eq][condition][value]',  JSON.stringify(f.planName));
  }
  if (f.detector) {
    qs.append('filter[eq][condition][key]',   'detectors');
    qs.append('filter[eq][condition][value]',  JSON.stringify(f.detector));
  }
  if (f.positioner) {
    qs.append('filter[eq][condition][key]',   'motors');
    qs.append('filter[eq][condition][value]',  JSON.stringify(f.positioner));
  }
  if (f.text) {
    qs.append('filter[fulltext][condition][text]', f.text);
  }
  if (f.since) {
    const ts = Math.floor(new Date(f.since).getTime() / 1000);
    qs.append('filter[comparison][condition][operator]', 'ge');
    qs.append('filter[comparison][condition][key]',      'time');
    qs.append('filter[comparison][condition][value]',    JSON.stringify(ts));
  }
  if (f.until) {
    const ts = Math.floor(new Date(f.until).getTime() / 1000);
    qs.append('filter[comparison][condition][operator]', 'le');
    qs.append('filter[comparison][condition][key]',      'time');
    qs.append('filter[comparison][condition][value]',    JSON.stringify(ts));
  }
  return qs;
}

// Dual-range slider: single track with two thumb handles
function DualRangeSlider({ minMs, maxMs, fromMs, toMs, onFromChange, onToChange }: {
  minMs: number; maxMs: number;
  fromMs: number; toMs: number;
  onFromChange: (ms: number) => void;
  onToChange: (ms: number) => void;
}) {
  const fromPct = ((fromMs - minMs) / (maxMs - minMs)) * 100;
  const toPct   = ((toMs   - minMs) / (maxMs - minMs)) * 100;

  return (
    <div className="relative h-5 flex items-center my-1">
      <style>{`
        .dr-input { pointer-events: none; position: absolute; inset: 0; width: 100%;
          appearance: none; -webkit-appearance: none; background: transparent; outline: none; }
        .dr-input::-webkit-slider-runnable-track { height: 6px; background: transparent; }
        .dr-input::-moz-range-track { height: 6px; background: transparent; border: none; }
        .dr-input::-webkit-slider-thumb {
          pointer-events: all; -webkit-appearance: none; appearance: none;
          width: 16px; height: 16px; border-radius: 50%;
          background: white; border: 2px solid #0ea5e9;
          cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,0.25); margin-top: -5px;
        }
        .dr-input::-moz-range-thumb {
          pointer-events: all; width: 16px; height: 16px; border-radius: 50%;
          background: white; border: 2px solid #0ea5e9;
          cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,0.25);
        }
      `}</style>

      {/* Track */}
      <div className="absolute inset-x-0 h-1.5 bg-gray-200 rounded-full pointer-events-none">
        <div
          className="absolute h-full bg-sky-400 rounded-full"
          style={{ left: `${fromPct}%`, right: `${100 - toPct}%` }}
        />
      </div>

      {/* From thumb */}
      <input
        type="range" className="dr-input"
        min={minMs} max={maxMs - DAY_MS} step={DAY_MS}
        value={fromMs}
        onChange={e => onFromChange(Math.min(Number(e.target.value), toMs - DAY_MS))}
        style={{ zIndex: fromPct > 95 ? 4 : 3 }}
      />
      {/* To thumb */}
      <input
        type="range" className="dr-input"
        min={minMs + DAY_MS} max={maxMs} step={DAY_MS}
        value={toMs}
        onChange={e => onToChange(Math.max(Number(e.target.value), fromMs + DAY_MS))}
        style={{ zIndex: fromPct > 95 ? 3 : 4 }}
      />
    </div>
  );
}

export default function RunTable({ serverUrl, catalog, page, selectedRunId, autoFollow, onPageChange, onSelectRun, onDoubleClickRun, onAutoFollowChange, onNewAcquiringRun }: RunTableProps) {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [debouncedFilters, setDebouncedFilters] = useState<Filters>(EMPTY_FILTERS);
  const [minDateMs, setMinDateMs] = useState(new Date('2000-01-01').getTime());
  const [refreshKey, setRefreshKey] = useState(0);
  const bgRefreshRef = useRef(false);

  // Fetch the oldest run's timestamp to set the slider minimum
  useEffect(() => {
    if (!serverUrl || !catalog) return;
    fetch(`${serverUrl}/api/v1/search/${catalog}?page[limit]=1&page[offset]=0`)
      .then(r => r.json())
      .then(json => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const attrs = (json.data?.[0]?.attributes ?? {}) as Record<string, any>;
        const time: number | undefined = attrs.metadata?.start?.time;
        if (time) setMinDateMs(Math.floor(time) * 1000);
      })
      .catch(() => {});
  }, [serverUrl, catalog]);

  // Poll every 5s for new runs and status updates (silent — no loading spinner)
  useEffect(() => {
    if (!serverUrl || !catalog) return;
    const id = setInterval(() => { bgRefreshRef.current = true; setRefreshKey(k => k + 1); }, 5000);
    return () => clearInterval(id);
  }, [serverUrl, catalog]);

  // Detect new acquiring runs independently of current page view
  const onNewAcquiringRunRef = useRef(onNewAcquiringRun);
  useEffect(() => { onNewAcquiringRunRef.current = onNewAcquiringRun; });

  useEffect(() => {
    if (!serverUrl || !catalog) return;
    let initialDone = false;
    let lastSeenId = '';
    const check = async () => {
      try {
        const r1 = await fetch(`${serverUrl}/api/v1/search/${catalog}?page[limit]=1&page[offset]=0`);
        if (!r1.ok) return;
        const j1 = await r1.json();
        const total: number = j1.meta?.count ?? j1.meta?.pagination?.count ?? 0;
        if (total === 0) { initialDone = true; return; }
        const r2 = await fetch(`${serverUrl}/api/v1/search/${catalog}?page[limit]=1&page[offset]=${total - 1}`);
        if (!r2.ok) return;
        const j2 = await r2.json();
        const items: Record<string, unknown>[] = j2.data ?? [];
        if (items.length === 0) { initialDone = true; return; }
        const run = parseRun(items[0]);
        if (initialDone && run.id !== lastSeenId && run.acquiring) {
          onNewAcquiringRunRef.current?.(run.id, run.scanId != null ? String(run.scanId) : '', run.detectorList, run.motorList, run.acquiring);
        }
        lastSeenId = run.id;
        initialDone = true;
      } catch { }
    };
    check();
    const id = setInterval(check, 5000);
    return () => clearInterval(id);
  }, [serverUrl, catalog]);

  const isFiltering = Object.values(debouncedFilters).some(Boolean);

  // Debounce all filter inputs together
  useEffect(() => {
    const t = setTimeout(() => setDebouncedFilters(filters), 400);
    return () => clearTimeout(t);
  }, [filters]);

  // Reset to page 0 whenever the active filter changes
  const filterKey = useMemo(() => JSON.stringify(debouncedFilters), [debouncedFilters]);
  useEffect(() => {
    onPageChange(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  useEffect(() => {
    if (!serverUrl || !catalog) { setRuns([]); setTotal(0); return; }
    let cancelled = false;
    const isBg = bgRefreshRef.current;
    bgRefreshRef.current = false;
    if (!isBg) setLoading(true);

    const extra = buildFilterQs(debouncedFilters);

    (async () => {
      try {
        // Step 1: get (filtered) total count
        const countQs = new URLSearchParams({ 'page[limit]': '1', 'page[offset]': '0' });
        extra.forEach((v, k) => countQs.append(k, v));
        const r1 = await fetch(`${serverUrl}/api/v1/search/${catalog}?${countQs}`);
        if (cancelled || !r1.ok) { setRuns([]); setTotal(0); return; }
        const j1 = await r1.json();
        const t: number = j1.meta?.count ?? j1.meta?.pagination?.count ?? 0;
        if (cancelled) return;
        setTotal(t);
        if (t === 0) { setRuns([]); return; }

        // Step 2: fetch the right page in reverse order (most recent first)
        const lastPage = Math.max(0, Math.ceil(t / PAGE_SIZE) - 1);
        const safePage = Math.min(page, lastPage);
        const reversedLimit = Math.min(PAGE_SIZE, t - safePage * PAGE_SIZE);
        const reversedOffset = Math.max(0, t - safePage * PAGE_SIZE - reversedLimit);
        const pageQs = new URLSearchParams({
          'page[limit]':  String(reversedLimit),
          'page[offset]': String(reversedOffset),
        });
        extra.forEach((v, k) => pageQs.append(k, v));
        const r2 = await fetch(`${serverUrl}/api/v1/search/${catalog}?${pageQs}`);
        if (cancelled || !r2.ok) return;
        const j2 = await r2.json();
        if (cancelled) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setRuns([...(j2.data ?? []).map((item: any) => parseRun(item))].reverse());
      } catch {
        // ignore
      } finally {
        if (!cancelled && !isBg) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [serverUrl, catalog, page, filterKey, refreshKey]);

  const [showFilters, setShowFilters] = useState(false);
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  const set = (field: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFilters(prev => ({ ...prev, [field]: e.target.value }));

  const inputCls = 'text-xs bg-white border border-gray-300 rounded px-1.5 py-0.5 focus:outline-none focus:border-sky-400 w-full min-w-0';
  const labelCls = 'text-[10px] font-semibold text-gray-400 uppercase tracking-wide w-10 shrink-0 text-right';
  const thClass = "px-2 py-1.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-200 bg-gray-50 whitespace-nowrap";
  const tdClass = "px-2 py-1.5 text-xs text-gray-700 truncate max-w-[120px]";

  const maxDateMs = Date.now();
  const sinceMs = filters.since ? new Date(filters.since).getTime() : minDateMs;
  const untilMs = filters.until ? new Date(filters.until).getTime() : maxDateMs;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="shrink-0 border-b border-gray-100 px-3 py-2 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-gray-700">Runs</h2>
        {isFiltering && <span className="w-1.5 h-1.5 rounded-full bg-sky-500 shrink-0" title="Filters active" />}
        {autoFollow !== undefined && (
          <button
            onClick={() => onAutoFollowChange?.(!autoFollow)}
            className={`px-2 py-0.5 text-xs rounded font-medium border transition-colors ${
              autoFollow ? 'bg-sky-100 text-sky-700 border-sky-400' : 'bg-white text-gray-400 border-gray-300 hover:text-gray-600'
            }`}
            title={autoFollow ? 'Auto-follow on — auto-plots new runs' : 'Auto-follow off — click to enable'}
          >
            {autoFollow ? '● Auto' : '○ Auto'}
          </button>
        )}
        <button
          onClick={() => setShowFilters(v => !v)}
          className={`ml-auto p-1 rounded transition-colors ${showFilters ? 'text-sky-600 bg-sky-50' : 'text-gray-400 hover:text-gray-600'}`}
          title="Toggle filters"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M4 4h16l-6 8v7l-4-2V12L4 4z" />
          </svg>
        </button>
      </div>

      {/* Collapsible filter panel */}
      {showFilters && (
        <div className="shrink-0 border-b border-gray-200 bg-gray-50 px-3 py-2 space-y-1">
          {([
            ['ID',     'scanId',     'exact'],
            ['Plan',   'planName',   'exact'],
            ['Det',    'detector',   'exact'],
            ['Pos',    'positioner', 'exact'],
            ['Search', 'text',       'full-text'],
          ] as [string, keyof Filters, string][]).map(([label, field, ph]) => (
            <div key={field} className="flex items-center gap-2">
              <span className={labelCls}>{label}</span>
              <input className={inputCls} value={filters[field]} onChange={set(field)} placeholder={ph} />
            </div>
          ))}

          {/* Date range */}
          <div className="pt-1.5 border-t border-gray-200">
            {/* Single dual-thumb slider */}
            <DualRangeSlider
              minMs={minDateMs} maxMs={maxDateMs}
              fromMs={sinceMs} toMs={untilMs}
              onFromChange={ms => setFilters(prev => ({ ...prev, since: ms > minDateMs ? msToLocal(ms) : '' }))}
              onToChange={ms => setFilters(prev => ({ ...prev, until: ms < maxDateMs ? msToLocal(ms) : '' }))}
            />

            {/* Precise datetime inputs */}
            {(['since', 'until'] as const).map(field => (
              <div key={field} className="flex items-center gap-2 mt-0.5">
                <span className={labelCls}>{field === 'since' ? 'From' : 'To'}</span>
                <input
                  type="datetime-local"
                  className="text-xs bg-white border border-gray-300 rounded px-1.5 py-0.5 focus:outline-none focus:border-sky-400 w-full min-w-0 text-gray-700"
                  value={filters[field]}
                  onChange={set(field)}
                />
                {filters[field] && (
                  <button
                    onClick={() => setFilters(prev => ({ ...prev, [field]: '' }))}
                    className="shrink-0 text-gray-300 hover:text-gray-500"
                    title="Clear"
                  >✕</button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-y-scroll">
        {loading ? (
          <div className="flex items-center justify-center h-full text-gray-400 text-sm">Loading…</div>
        ) : (
          <table className="w-full border-collapse">
            <thead className="sticky top-0 z-10">
              <tr>
                <th className={thClass}>Scan ID</th>
                <th className={thClass}>Plan</th>
                <th className={thClass}>Det</th>
                <th className={thClass}>Pos</th>
                <th className={thClass}>Pts</th>
                <th className={thClass}>Status</th>
                <th className={thClass}>Date</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run, i) => (
                <tr
                  key={run.id}
                  onClick={() => onSelectRun(run.id, run.scanId != null ? String(run.scanId) : '', run.detectorList, run.motorList, run.acquiring)}
                  onDoubleClick={() => onDoubleClickRun?.(run.id, run.scanId != null ? String(run.scanId) : '', run.detectorList, run.motorList, run.acquiring)}
                  className={`cursor-pointer ${run.id === selectedRunId ? 'bg-sky-100 hover:bg-sky-100' : `hover:bg-sky-50 ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}`}
                >
                  <td className={tdClass}>{run.scanId ?? '—'}</td>
                  <td className={tdClass}>{run.planName ?? '—'}</td>
                  <td className={`${tdClass} max-w-[100px]`} title={run.detectors}>{run.detectors ?? '—'}</td>
                  <td className={`${tdClass} max-w-[100px]`} title={run.positioners}>{run.positioners ?? '—'}</td>
                  <td className={tdClass}>{run.numPoints ?? '—'}</td>
                  <td className={tdClass}>
                    {run.acquiring ? (
                      <span className="flex items-center gap-1 text-xs font-medium text-sky-600">
                        <span className="w-1.5 h-1.5 rounded-full bg-sky-500 animate-pulse shrink-0" />
                        acquiring
                      </span>
                    ) : run.status ? (
                      <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                        run.status === 'success' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'
                      }`}>
                        {run.status}
                      </span>
                    ) : '—'}
                  </td>
                  <td className={tdClass}>{run.date ?? '—'}</td>
                </tr>
              ))}
              {runs.length === 0 && !loading && (
                <tr>
                  <td colSpan={7} className="px-2 py-6 text-center text-xs text-gray-400">
                    {isFiltering ? 'No runs match the filter' : 'No runs'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {total > 0 && (
        <div className="flex-none border-t border-gray-200 bg-white px-3 py-2 flex items-center justify-between shrink-0">
          <span className="text-xs text-gray-500">
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
            {isFiltering && <span className="text-gray-400"> filtered</span>}
          </span>
          <div className="flex gap-1">
            {(['«', '‹', '›', '»'] as const).map((arrow) => {
              const disabled =
                (arrow === '«' || arrow === '‹') ? page === 0 :
                (arrow === '›' || arrow === '»') ? page >= lastPage : false;
              const newPage =
                arrow === '«' ? 0 :
                arrow === '‹' ? page - 1 :
                arrow === '›' ? page + 1 :
                lastPage;
              return (
                <button
                  key={arrow}
                  disabled={disabled}
                  onClick={() => onPageChange(newPage)}
                  className="px-2 py-0.5 text-xs rounded border border-gray-300 bg-white hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed font-mono"
                >
                  {arrow}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
