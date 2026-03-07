import { useState, useEffect, useRef, useCallback } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

type QueueItem = {
  item_type: string;
  name: string;
  kwargs: Record<string, unknown>;
  item_uid: string;
  status?: string;
  result?: { exit_status?: string; msg?: string };
};

type PlanParam = {
  name: string;
  kind: { name: string };
  annotation?: { type?: string };
  default?: unknown;
};

type AllowedPlan = {
  name: string;
  description?: string;
  parameters?: PlanParam[];
};

type ServerStatus = {
  manager_state: string;   // 'idle' | 'running' | 'paused' | ...
  re_state: string;        // 'idle' | 'running' | 'paused' | ...
  items_in_queue: number;
  items_in_history: number;
  running_item_uid: string | null;
  worker_environment_exists: boolean;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function statusColor(status?: string) {
  if (!status) return 'bg-gray-200 text-gray-600';
  if (status === 'completed') return 'bg-green-100 text-green-700';
  if (status === 'failed' || status === 'aborted') return 'bg-red-100 text-red-600';
  if (status === 'running') return 'bg-sky-100 text-sky-700';
  return 'bg-amber-100 text-amber-700';
}

function planColor(name: string | undefined) {
  const colors = [
    'bg-sky-100 border-sky-300 text-sky-800',
    'bg-violet-100 border-violet-300 text-violet-800',
    'bg-emerald-100 border-emerald-300 text-emerald-800',
    'bg-amber-100 border-amber-300 text-amber-800',
    'bg-rose-100 border-rose-300 text-rose-800',
  ];
  if (!name) return colors[0];
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return colors[h % colors.length];
}

function kwargsSummary(kwargs: Record<string, unknown>): string {
  return Object.entries(kwargs)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(', ');
}

// Parse a user-typed string into a JS value (number, bool, JSON, or string)
function parseParamValue(s: string): unknown {
  const t = s.trim();
  if (t === '') return undefined;
  if (t === 'true') return true;
  if (t === 'false') return false;
  const n = Number(t);
  if (!isNaN(n) && t !== '') return n;
  try { return JSON.parse(t); } catch { return t; }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function QueueCard({ item, running, onDelete }: {
  item: QueueItem;
  running: boolean;
  onDelete: () => void;
}) {
  const cls = planColor(item.name);
  return (
    <div className={`relative border rounded p-2 text-xs ${running ? 'ring-2 ring-sky-500 ' + cls : cls}`}>
      <div className="flex items-start gap-1">
        <span className="font-semibold flex-1 truncate">{item.name}</span>
        {running && <span className="shrink-0 animate-pulse text-sky-600 font-bold">▶</span>}
        {!running && (
          <button
            onClick={onDelete}
            className="shrink-0 text-gray-400 hover:text-red-500 leading-none ml-1"
            title="Remove"
          >×</button>
        )}
      </div>
      {Object.keys(item.kwargs).length > 0 && (
        <p className="text-gray-500 mt-0.5 truncate">{kwargsSummary(item.kwargs)}</p>
      )}
    </div>
  );
}

function HistoryCard({ item }: { item: QueueItem }) {
  const cls = planColor(item.name);
  const exitStatus = item.result?.exit_status ?? item.status ?? '';
  return (
    <div className={`border rounded p-2 text-xs ${cls}`}>
      <div className="flex items-start gap-1">
        <span className="font-semibold flex-1 truncate">{item.name}</span>
        <span className={`shrink-0 text-[10px] px-1 py-0.5 rounded font-medium ${statusColor(exitStatus)}`}>
          {exitStatus || '?'}
        </span>
      </div>
      {Object.keys(item.kwargs).length > 0 && (
        <p className="text-gray-500 mt-0.5 truncate">{kwargsSummary(item.kwargs)}</p>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function QServerPanel({ proxyUrl, serverUrl, onStatusChange }: {
  proxyUrl: string;
  serverUrl: string;
  onStatusChange?: (status: ServerStatus | null) => void;
}) {

  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [runningItem, setRunningItem] = useState<QueueItem | null>(null);
  const [history, setHistory] = useState<QueueItem[]>([]);
  const [allowedPlans, setAllowedPlans] = useState<AllowedPlan[]>([]);

  // Add item form
  const [selectedPlan, setSelectedPlan] = useState('');
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [submitMsg, setSubmitMsg] = useState('');
  const [submitError, setSubmitError] = useState('');

  // Console
  const [consoleLines, setConsoleLines] = useState<string[]>([]);
  const [consoleOn, setConsoleOn] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);
  const consoleEndRef = useRef<HTMLDivElement>(null);

  // ── API helpers ──────────────────────────────────────────────────────────
  const api = useCallback(async (path: string, body?: object) => {
    const apiKey = localStorage.getItem('qsApiKey') ?? '';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `ApiKey ${apiKey}`;
    const opts: RequestInit = body !== undefined
      ? { method: 'POST', headers, body: JSON.stringify(body) }
      : { method: 'GET', headers };
    const r = await fetch(`${proxyUrl}${path}`, opts);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }, [proxyUrl]);

  // ── Polling ──────────────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    try {
      const [st, q, h] = await Promise.all([
        api('/api/status').catch(() => null),
        api('/api/queue/get').catch(() => null),
        api('/api/history/get').catch(() => null),
      ]);
      if (st) setStatus(st);
      if (q) {
        setQueue(q.items ?? []);
        setRunningItem(q.running_item ?? null);
      }
      if (h) setHistory([...(h.items ?? [])].reverse());
    } catch { /* ignore */ }
  }, [api]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh]);

  // ── Allowed plans ────────────────────────────────────────────────────────
  useEffect(() => {
    api('/api/plans/allowed')
      .then(j => {
        const plans: AllowedPlan[] = Object.values(j.plans_allowed ?? {}) as AllowedPlan[];
        plans.sort((a, b) => a.name.localeCompare(b.name));
        setAllowedPlans(plans);
        if (plans.length > 0 && !selectedPlan) setSelectedPlan(plans[0].name);
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proxyUrl]);

  // ── When plan changes, reset param values ────────────────────────────────
  useEffect(() => {
    const plan = allowedPlans.find(p => p.name === selectedPlan);
    if (!plan) { setParamValues({}); return; }
    const init: Record<string, string> = {};
    for (const p of plan.parameters ?? []) {
      if (p.default !== undefined && p.default !== 'no_default') {
        init[p.name] = typeof p.default === 'string' ? p.default : JSON.stringify(p.default);
      }
    }
    setParamValues(init);
  }, [selectedPlan, allowedPlans]);

  // ── Report status to parent ───────────────────────────────────────────────
  useEffect(() => { onStatusChange?.(status); }, [status, onStatusChange]);

  // ── WebSocket console (direct connection — no proxy for WS) ──────────────
  useEffect(() => {
    if (!consoleOn) { wsRef.current?.close(); return; }
    // The vite proxy doesn't handle WS upgrades, connect directly to the server
    const wsUrl = serverUrl.replace(/^https/, 'wss').replace(/^http/, 'ws') + '/api/console_output/ws';
    let ws: WebSocket | null = null;
    try { ws = new WebSocket(wsUrl); } catch { return; }
    const _ws = ws;
    wsRef.current = _ws;
    _ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        const line: string = data.text ?? data.msg ?? JSON.stringify(data);
        setConsoleLines(prev => [...prev.slice(-499), line]);
      } catch {
        setConsoleLines(prev => [...prev.slice(-499), ev.data]);
      }
    };
    _ws.onerror = () => {};
    return () => { _ws.close(); };
  }, [serverUrl, consoleOn]);

  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [consoleLines]);

  // ── Actions ──────────────────────────────────────────────────────────────
  const handleStartRE = async () => {
    try {
      if (!status?.worker_environment_exists) {
        await api('/api/environment/open', {});
      } else {
        await api('/api/queue/start', {});
      }
      refresh();
    } catch (e) { console.error(e); }
  };

  const handleStopRE = async () => {
    try {
      await api('/api/queue/stop', {});
      refresh();
    } catch (e) { console.error(e); }
  };

  const handleAddToQueue = async () => {
    setSubmitMsg(''); setSubmitError('');
    const plan = allowedPlans.find(p => p.name === selectedPlan);
    if (!plan) return;
    const kwargs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(paramValues)) {
      const parsed = parseParamValue(v);
      if (parsed !== undefined) kwargs[k] = parsed;
    }
    try {
      const res = await api('/api/queue/item/add', {
        item: { item_type: 'plan', name: selectedPlan, kwargs },
      });
      setSubmitMsg(`Added: ${res.item?.item_uid?.slice(0, 8) ?? 'ok'}`);
      refresh();
    } catch (e) { setSubmitError(String(e)); }
  };

  const handleExecute = async () => {
    setSubmitMsg(''); setSubmitError('');
    const plan = allowedPlans.find(p => p.name === selectedPlan);
    if (!plan) return;
    const kwargs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(paramValues)) {
      const parsed = parseParamValue(v);
      if (parsed !== undefined) kwargs[k] = parsed;
    }
    try {
      await api('/api/queue/item/execute', {
        item: { item_type: 'plan', name: selectedPlan, kwargs },
      });
      setSubmitMsg('Executing…');
      refresh();
    } catch (e) { setSubmitError(String(e)); }
  };

  const handleDelete = async (uid: string) => {
    try {
      await api('/api/queue/item/remove', { item_uid: uid });
      refresh();
    } catch (e) { console.error(e); }
  };

  // ── Derived state ────────────────────────────────────────────────────────
  const isRERunning = status?.re_state === 'running';
  const isREIdle = status?.re_state === 'idle' || !status?.worker_environment_exists;
  const reState = status?.re_state ?? '—';
  const activePlan = allowedPlans.find(p => p.name === selectedPlan);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left sidebar: Queue + RE + History */}
        <div className="flex-none w-64 bg-gray-50 border-r border-gray-200 flex flex-col overflow-hidden">

          {/* Queue */}
          <div className="flex-none px-3 py-2 bg-white border-b border-gray-200 flex items-center gap-2">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide flex-1">
              Queue · {queue.length + (runningItem ? 1 : 0)}
            </span>
            <button
              onClick={handleStartRE}
              disabled={isRERunning}
              className="text-xs px-2 py-0.5 rounded bg-sky-600 hover:bg-sky-500 disabled:bg-gray-200 disabled:text-gray-400 text-white font-medium transition-colors"
            >Start</button>
            <button
              onClick={handleStopRE}
              disabled={isREIdle}
              className="text-xs px-2 py-0.5 rounded bg-red-500 hover:bg-red-400 disabled:bg-gray-200 disabled:text-gray-400 text-white font-medium transition-colors"
            >Stop</button>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1.5 min-h-0" style={{ maxHeight: '40%' }}>
            {runningItem && (
              <QueueCard item={runningItem} running key={runningItem.item_uid} onDelete={() => {}} />
            )}
            {queue.map(item => (
              <QueueCard
                key={item.item_uid}
                item={item}
                running={false}
                onDelete={() => handleDelete(item.item_uid)}
              />
            ))}
            {queue.length === 0 && !runningItem && (
              <p className="text-xs text-gray-400 text-center py-4">Queue is empty</p>
            )}
          </div>

          {/* RE status indicator */}
          <div className="flex-none border-t border-b border-gray-200 bg-white px-3 py-2 flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full shrink-0 ${isRERunning ? 'bg-sky-500 animate-pulse' : isREIdle ? 'bg-green-500' : 'bg-amber-400'}`} />
            <span className="text-xs text-gray-600 font-medium">
              {!status?.worker_environment_exists ? 'Worker not open' : `RE: ${reState}`}
            </span>
            {!status?.worker_environment_exists && status && (
              <button
                onClick={handleStartRE}
                className="ml-auto text-xs text-sky-600 hover:text-sky-800 font-medium"
              >Open</button>
            )}
          </div>

          {/* History */}
          <div className="flex-none px-3 py-2 bg-white border-b border-gray-200">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              History · {history.length}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5 min-h-0">
            {history.map(item => (
              <HistoryCard key={item.item_uid} item={item} />
            ))}
            {history.length === 0 && (
              <p className="text-xs text-gray-400 text-center py-4">No history</p>
            )}
          </div>
        </div>

        {/* Right main area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Add Item */}
          <div className="flex-none bg-white border-b border-gray-200 p-4">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Add Item</h3>

            {allowedPlans.length === 0 ? (
              <p className="text-xs text-gray-400">
                {status ? 'No plans available — check QServer URL.' : 'Connect to a queue server to add plans.'}
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {/* Plan selector */}
                <div className="flex items-center gap-3">
                  <label className="text-xs text-gray-500 w-20 shrink-0 text-right">Plan</label>
                  <select
                    value={selectedPlan}
                    onChange={e => setSelectedPlan(e.target.value)}
                    className="flex-1 text-sm border border-gray-200 rounded px-2 py-1 bg-white focus:outline-none focus:border-sky-400"
                  >
                    {allowedPlans.map(p => (
                      <option key={p.name} value={p.name}>{p.name}</option>
                    ))}
                  </select>
                </div>

                {/* Plan description */}
                {activePlan?.description && (
                  <p className="text-xs text-gray-400 italic pl-[5.5rem] leading-relaxed">{activePlan.description}</p>
                )}

                {/* Parameters */}
                {(activePlan?.parameters ?? []).map(param => {
                  const typeName = param.annotation?.type ?? '';
                  const hasDefault = param.default !== undefined && param.default !== 'no_default';
                  return (
                    <div key={param.name} className="flex items-center gap-3">
                      <label
                        className="text-xs text-gray-500 w-20 shrink-0 text-right truncate"
                        title={param.name}
                      >
                        {param.name}
                        {!hasDefault && <span className="text-red-400 ml-0.5">*</span>}
                      </label>
                      <div className="flex-1 flex items-center gap-2">
                        <input
                          className="flex-1 text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:border-sky-400 font-mono"
                          value={paramValues[param.name] ?? ''}
                          onChange={e => setParamValues(prev => ({ ...prev, [param.name]: e.target.value }))}
                          placeholder={hasDefault ? String(param.default) : typeName || 'value'}
                        />
                        {typeName && (
                          <span className="text-[10px] text-gray-400 shrink-0 max-w-[120px] truncate" title={typeName}>
                            {typeName.replace(/typing\.|ophyd\.[^.]+\./g, '').replace('typing.', '')}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}

                {/* Actions */}
                <div className="flex items-center gap-2 pl-[5.5rem]">
                  <button
                    onClick={handleAddToQueue}
                    className="text-sm bg-sky-600 hover:bg-sky-500 text-white px-4 py-1 rounded font-medium transition-colors"
                  >Add to Queue</button>
                  <button
                    onClick={handleExecute}
                    className="text-sm border border-sky-400 text-sky-700 hover:bg-sky-50 px-4 py-1 rounded font-medium transition-colors"
                  >Execute Now</button>
                  {submitMsg && <span className="text-xs text-green-600">{submitMsg}</span>}
                  {submitError && <span className="text-xs text-red-500">{submitError}</span>}
                </div>
              </div>
            )}
          </div>

          {/* Console */}
          <div className="flex-1 flex flex-col overflow-hidden bg-gray-900">
            <div className="flex-none flex items-center gap-3 px-3 py-1.5 bg-gray-800 border-b border-gray-700">
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide flex-1">Console Output</span>
              <button
                onClick={() => setConsoleLines([])}
                className="text-xs text-gray-500 hover:text-gray-300"
              >Clear</button>
              <label className="flex items-center gap-1.5 cursor-pointer select-none">
                <span className="text-xs text-gray-500">Live</span>
                <span
                  onClick={() => setConsoleOn(v => !v)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${consoleOn ? 'bg-sky-500' : 'bg-gray-600'}`}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${consoleOn ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </span>
              </label>
            </div>
            <div className="flex-1 overflow-y-auto p-3 font-mono text-xs text-green-300 leading-relaxed">
              {consoleLines.length === 0 ? (
                <span className="text-gray-600">
                  {consoleOn ? 'Waiting for console output…' : 'Console paused.'}
                </span>
              ) : (
                consoleLines.map((line, i) => (
                  <div key={i} className="whitespace-pre-wrap break-all">{line}</div>
                ))
              )}
              <div ref={consoleEndRef} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
