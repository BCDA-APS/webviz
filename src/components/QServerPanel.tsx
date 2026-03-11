import { useState, useEffect, useRef, useCallback } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

type QueueItem = {
  item_type: string;
  name: string;
  args?: unknown[];
  kwargs: Record<string, unknown>;
  item_uid: string;
  status?: string;
  result?: { exit_status?: string; msg?: string; time_start?: number; time_stop?: number; run_uids?: string[]; scan_ids?: number[] };
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

type RERunInfo = {
  uid: string;
  scan_id?: number;
  is_open: boolean;
  exit_status?: string;
};

type RERunsData = {
  run_list: RERunInfo[];
};

type ServerStatus = {
  manager_state: string;   // 'idle' | 'executing_queue' | 'paused' | ...
  re_state: string;        // 'idle' | 'running' | 'paused' | ...
  items_in_queue: number;
  items_in_history: number;
  running_item_uid: string | null;
  worker_environment_exists: boolean;
  queue_stop_pending: boolean;
  queue_autostart_enabled: boolean;
  plan_queue_mode: { loop: boolean };
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
    'border-l-sky-400',
    'border-l-violet-400',
    'border-l-emerald-400',
    'border-l-teal-400',
    'border-l-indigo-400',
    'border-l-fuchsia-400',
  ];
  if (!name) return colors[0];
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return colors[h % colors.length];
}

function itemSummary(item: QueueItem, plans: AllowedPlan[]): string {
  const plan = plans.find(p => p.name === item.name);
  const params = plan?.parameters ?? [];
  const varPosIdx = params.findIndex(p => p.kind.name === 'VAR_POSITIONAL');
  const posParamsBefore = varPosIdx >= 0
    ? params.slice(0, varPosIdx).filter(p => p.kind.name === 'POSITIONAL_OR_KEYWORD')
    : [];
  const parts: string[] = [];
  const args = item.args ?? [];
  posParamsBefore.forEach((param, idx) => {
    if (idx < args.length) parts.push(`${param.name}=${JSON.stringify(args[idx])}`);
  });
  if (varPosIdx >= 0) {
    const remaining = args.slice(posParamsBefore.length);
    if (remaining.length > 0) parts.push(`${params[varPosIdx].name}=${JSON.stringify(remaining)}`);
  }
  for (const [k, v] of Object.entries(item.kwargs ?? {})) parts.push(`${k}=${JSON.stringify(v)}`);
  return parts.join(', ');
}

// Parse a user-typed string into a JS value (number, bool, JSON, or Python literal)
function parseParamValue(s: string): unknown {
  const t = s.trim();
  if (t === '') return undefined;
  if (t === 'None' || t === 'null') return null;
  if (t === 'true' || t === 'True') return true;
  if (t === 'false' || t === 'False') return false;
  const n = Number(t);
  if (!isNaN(n) && t !== '') return n;
  // Try JSON directly (handles "string", [array], {obj})
  try { return JSON.parse(t); } catch {}
  // Try converting Python literal syntax to JSON:
  //   None/True/False in nested structures, tuples (...) → [...], single-quoted strings
  try {
    const j = t
      .replace(/\bNone\b/g, 'null')
      .replace(/\bTrue\b/g, 'true')
      .replace(/\bFalse\b/g, 'false')
      .replace(/\(/g, '[').replace(/\)/g, ']')
      .replace(/'([^'\\]*(\\.[^'\\]*)*)'/g, '"$1"');
    return JSON.parse(j);
  } catch {}
  return t;
}

// Build {args, kwargs} for QServer.
// When a plan has *args (VAR_POSITIONAL), all POSITIONAL_OR_KEYWORD params before it
// must also go into args[] (in order), otherwise Python sees a conflict.
function buildArgsKwargs(paramValues: Record<string, string>, plan: AllowedPlan) {
  const params = plan.parameters ?? [];
  const varPosIdx = params.findIndex(p => p.kind.name === 'VAR_POSITIONAL');
  const posArgs: unknown[] = [];
  const varArgs: unknown[] = [];
  const kwargs: Record<string, unknown> = {};

  for (let i = 0; i < params.length; i++) {
    const param = params[i];
    const raw = paramValues[param.name];
    if (raw === undefined) continue;
    const parsed = parseParamValue(raw);
    if (parsed === undefined || parsed === null) continue; // omit None — QServer uses its own default

    if (param.kind.name === 'VAR_POSITIONAL') {
      if (Array.isArray(parsed)) varArgs.push(...parsed);
    } else if (param.kind.name === 'POSITIONAL_OR_KEYWORD' && varPosIdx >= 0 && i < varPosIdx) {
      // Must be positional when there is a *args in the plan
      posArgs.push(parsed);
    } else {
      kwargs[param.name] = parsed;
    }
  }
  return { args: [...posArgs, ...varArgs], kwargs };
}

// Populate form values from an existing QueueItem, reversing buildArgsKwargs
function itemToParamValues(item: QueueItem, plan: AllowedPlan | undefined): Record<string, string> {
  const params = plan?.parameters ?? [];
  const varPosIdx = params.findIndex(p => p.kind.name === 'VAR_POSITIONAL');
  const posParamsBefore = varPosIdx >= 0
    ? params.slice(0, varPosIdx).filter(p => p.kind.name === 'POSITIONAL_OR_KEYWORD')
    : [];

  const vals: Record<string, string> = {};
  const itemArgs = item.args ?? [];

  // Distribute positional args back to their params
  posParamsBefore.forEach((param, idx) => {
    if (idx < itemArgs.length) vals[param.name] = JSON.stringify(itemArgs[idx]);
  });

  // Remaining args → VAR_POSITIONAL param
  if (varPosIdx >= 0) {
    const varPosParam = params[varPosIdx];
    const remaining = itemArgs.slice(posParamsBefore.length);
    if (remaining.length > 0) vals[varPosParam.name] = JSON.stringify(remaining);
  }

  // kwargs
  for (const [k, v] of Object.entries(item.kwargs ?? {})) {
    vals[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return vals;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function DragHandle({ onMouseDown }: { onMouseDown: () => void }) {
  return (
    <div
      className="shrink-0 flex gap-[3px] items-center text-gray-400 hover:text-gray-600 cursor-grab active:cursor-grabbing py-0.5 px-0.5"
      onMouseDown={onMouseDown}
      onClick={e => e.stopPropagation()}
      title="Drag to reorder"
    >
      <div className="flex flex-col gap-[3px]">
        <div className="w-[3px] h-[3px] rounded-full bg-current" />
        <div className="w-[3px] h-[3px] rounded-full bg-current" />
        <div className="w-[3px] h-[3px] rounded-full bg-current" />
      </div>
      <div className="flex flex-col gap-[3px]">
        <div className="w-[3px] h-[3px] rounded-full bg-current" />
        <div className="w-[3px] h-[3px] rounded-full bg-current" />
        <div className="w-[3px] h-[3px] rounded-full bg-current" />
      </div>
    </div>
  );
}

function QueueCard({ item, summary, running, selected, onSelect, onDelete, onEdit, onDuplicate, dragging, onDragStart, onDragEnd, onDragOver }: {
  item: QueueItem;
  summary: string;
  running: boolean;
  selected?: boolean;
  onSelect?: (e: React.MouseEvent) => void;
  onDelete: () => void;
  onEdit?: () => void;
  onDuplicate?: () => void;
  dragging?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  onDragOver?: (e: React.DragEvent) => void;
}) {
  const cls = planColor(item.name);
  const dragFromHandle = useRef(false);
  const cardCls = [
    'relative border border-l-4 rounded p-2 text-xs select-none bg-indigo-50',
    cls,
    running ? 'ring-2 ring-sky-500' : '',
    !running && selected ? 'ring-2 ring-sky-400 ring-offset-1' : '',
    dragging ? 'opacity-40' : '',
  ].filter(Boolean).join(' ');
  return (
    <div
      draggable={!running}
      onDragStart={e => {
        if (!dragFromHandle.current) { e.preventDefault(); return; }
        dragFromHandle.current = false;
        onDragStart?.(e);
      }}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onClick={!running ? onSelect : undefined}
      onDoubleClick={!running ? onEdit : undefined}
      className={cardCls}
    >
      {running ? (
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <p className="font-semibold truncate">{item.name}</p>
            {summary && <p className="text-gray-500 mt-0.5 truncate" title={summary}>{summary}</p>}
          </div>
          <span className="shrink-0 animate-pulse text-sky-600 font-bold text-xl leading-none">▶</span>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <DragHandle onMouseDown={() => { dragFromHandle.current = true; }} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold min-w-0 flex-1 truncate pr-1">{item.name}</span>
              <button
                onClick={e => { e.stopPropagation(); onDuplicate?.(); }}
                className="shrink-0 text-gray-400 hover:text-emerald-500 leading-none text-base font-bold"
                title="Duplicate"
              >⧉</button>
              <button
                onClick={e => { e.stopPropagation(); onEdit?.(); }}
                className="shrink-0 text-gray-400 hover:text-sky-500 leading-none text-xl font-bold"
                title="Edit"
              >✎</button>
              <button
                onClick={e => { e.stopPropagation(); onDelete(); }}
                className="shrink-0 text-gray-400 hover:text-red-500 leading-none text-xl font-bold"
                title="Remove"
              >×</button>
            </div>
            {summary && <p className="text-gray-500 mt-0.5 truncate" title={summary}>{summary}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function formatDateTime(ts: number | undefined): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const date = d.toLocaleDateString([], { month: '2-digit', day: '2-digit' });
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${date} ${time}`;
}

function HistoryCard({ item, summary, onCopyToQueue }: { item: QueueItem; summary: string; onCopyToQueue?: () => void }) {
  const cls = planColor(item.name);
  const exitStatus = item.result?.exit_status ?? item.status ?? '';
  const stopTime = formatDateTime(item.result?.time_stop);
  return (
    <div className={`border border-l-4 rounded p-2 text-xs bg-indigo-50 ${cls}`}>
      <div className="flex items-start gap-1">
        <span className="font-semibold flex-1 truncate">{item.name}</span>
        {stopTime && <span className="shrink-0 text-[10px] text-gray-500">{stopTime}</span>}
        <span className={`shrink-0 text-[10px] px-1 py-0.5 rounded font-medium ${statusColor(exitStatus)}`}>
          {exitStatus || '?'}
        </span>
        <button
          onClick={onCopyToQueue}
          className="shrink-0 text-gray-400 hover:text-emerald-500 leading-none text-base font-bold"
          title="Copy to queue"
        >⧉</button>
      </div>
      {summary && <p className="text-gray-500 mt-0.5 truncate" title={summary}>{summary}</p>}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function QServerPanel({ proxyUrl, serverUrl: _serverUrl, onStatusChange }: {
  proxyUrl: string;
  serverUrl: string;
  onStatusChange?: (status: ServerStatus | null) => void;
}) {

  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [runningItem, setRunningItem] = useState<QueueItem | null>(null);
  const [history, setHistory] = useState<QueueItem[]>([]);
  const [allowedPlans, setAllowedPlans] = useState<AllowedPlan[]>([]);

  // Add / edit item form
  const [selectedPlan, setSelectedPlan] = useState('');
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [editingItem, setEditingItem] = useState<QueueItem | null>(null);
  const [submitMsg, setSubmitMsg] = useState('');
  const [submitError, setSubmitError] = useState('');

  // RE pause/resume pending
  const [pausePending, setPausePending] = useState(false);
  const [resumePending, setResumePending] = useState(false);
  const [abortPending, setAbortPending] = useState(false);

  // Console
  const [consoleLines, setConsoleLines] = useState<string[]>([]);
  const [consoleOn, setConsoleOn] = useState(true);
  const [maxLines, setMaxLines] = useState(1000);
  const maxLinesRef = useRef(1000);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'open' | 'closed' | 'error'>('connecting');
  const [consoleError, setConsoleError] = useState<string>('');
  const consoleEndRef = useRef<HTMLDivElement>(null);
  const consoleScrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  const [reRuns, setReRuns] = useState<RERunsData | null>(null);

  // Queue selection + drag state
  const [selectedUids, setSelectedUids] = useState<Set<string>>(new Set());
  const [dragUid, setDragUid] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  // Refs mirror the state so callbacks always see the latest values regardless of closure age
  const dragUidRef = useRef<string | null>(null);
  const dropIndexRef = useRef<number | null>(null);

  // Resize state
  const [sidebarWidth, setSidebarWidth] = useState(500);
  const [queueHeight, setQueueHeight] = useState(600);
  const [topSectionHeight, setTopSectionHeight] = useState(600);
  const [runningPlanWidth, setRunningPlanWidth] = useState(400);

  const dragSidebar = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX, startW = sidebarWidth;
    const onMove = (ev: MouseEvent) => setSidebarWidth(Math.max(150, Math.min(window.innerWidth - 200, startW + ev.clientX - startX)));
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const dragQueue = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY, startH = queueHeight;
    const onMove = (ev: MouseEvent) => setQueueHeight(Math.max(60, Math.min(window.innerHeight - 200, startH + ev.clientY - startY)));
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const dragRunningPlan = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX, startW = runningPlanWidth;
    const onMove = (ev: MouseEvent) => setRunningPlanWidth(Math.max(150, Math.min(window.innerWidth - 300, startW + ev.clientX - startX)));
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const dragTopSection = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY, startH = topSectionHeight;
    const onMove = (ev: MouseEvent) => setTopSectionHeight(Math.max(100, Math.min(window.innerHeight - 150, startH + ev.clientY - startY)));
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

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
      const [st, q, h, runs] = await Promise.all([
        api('/api/status').catch(() => null),
        api('/api/queue/get').catch(() => null),
        api('/api/history/get').catch(() => null),
        api('/api/re/runs', {}).catch(() => null),
      ]);
      if (st) setStatus(st);
      if (q) {
        setQueue(q.items ?? []);
        setRunningItem(q.running_item?.item_uid ? q.running_item : null);
      }
      if (h) setHistory([...(h.items ?? [])].reverse());
setReRuns(runs ?? null);
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
        const all: AllowedPlan[] = Object.values(j.plans_allowed ?? {}) as AllowedPlan[];
        const seen = new Set<string>();
        const plans = all.filter(p => !seen.has(p.name) && seen.add(p.name));
        plans.sort((a, b) => a.name.localeCompare(b.name));
        setAllowedPlans(plans);
        if (plans.length > 0 && !selectedPlan) setSelectedPlan(plans[0].name);
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proxyUrl]);

  // ── When plan changes, reset param values (skip when loading an item for editing) ──
  useEffect(() => {
    if (editingItem) return;
    const plan = allowedPlans.find(p => p.name === selectedPlan);
    if (!plan) { setParamValues({}); return; }
    const init: Record<string, string> = {};
    for (const p of plan.parameters ?? []) {
      if (p.default !== undefined && p.default !== 'no_default') {
        init[p.name] = typeof p.default === 'string' ? p.default : JSON.stringify(p.default);
      }
    }
    setParamValues(init);
  }, [selectedPlan, allowedPlans, editingItem]);

  // ── Report status to parent ───────────────────────────────────────────────
  useEffect(() => { onStatusChange?.(status); }, [status, onStatusChange]);

  // ── Clear pending states when RE state changes ────────────────────────────
  useEffect(() => {
    if (status?.re_state !== 'running') setPausePending(false);
    if (status?.re_state !== 'paused') setResumePending(false);
    if (status?.re_state === 'idle') setAbortPending(false);
  }, [status?.re_state]);

  // ── Escape clears selection ───────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setSelectedUids(new Set()); lastSelectedUidRef.current = null; }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // ── Console streaming via EventSource (SSE) ────────────────────────────────
  // The /qs-stream proxy converts the upstream NDJSON stream to text/event-stream
  // so that Safari (and all browsers) deliver events incrementally.
  useEffect(() => {
    if (!consoleOn) { setWsStatus('closed'); return; }
    setWsStatus('connecting');

    // eslint-disable-next-line no-control-regex
    const stripAnsi = (s: string) => s
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b[@-Z\\-_]/g, '')
      .replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, '');

    const apiKey = localStorage.getItem('qsApiKey') ?? '';
    // proxyUrl = 'http://localhost:5173/qs-proxy/http/host:port'
    // sseBase  = 'http://localhost:5173/qs-stream/http/host:port'
    const sseBase = proxyUrl.replace('/qs-proxy/', '/qs-stream/');
    const sseUrl = `${sseBase}/api/stream_console_output`;
    const url = apiKey ? `${sseUrl}?api_key=${encodeURIComponent(apiKey)}` : sseUrl;

    const es = new EventSource(url);

    es.onopen = () => { setWsStatus('open'); setConsoleError(''); };
    es.onerror = () => { setWsStatus('connecting'); };

    es.onmessage = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        const msg: string = data.msg ?? '';
        if (!msg) return;
        const cleaned = stripAnsi(msg.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
        const newLines: string[] = [];
        for (const l of cleaned.split('\n')) {
          const trimmed = l.trimEnd();
          if (trimmed) newLines.push(trimmed);
        }
        if (newLines.length > 0) {
          setConsoleLines(prev => [...prev, ...newLines].slice(-maxLinesRef.current));
        }
      } catch { /* ignore malformed messages */ }
    };

    return () => { es.close(); };
  }, [proxyUrl, consoleOn]);

  useEffect(() => {
    if (autoScrollRef.current) {
      consoleEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
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
      if (status?.queue_stop_pending) {
        await api('/api/queue/stop/cancel', {});
      } else {
        await api('/api/queue/stop', {});
      }
      refresh();
    } catch (e) { console.error(e); }
  };

  const handlePauseRE = async () => {
    try { setPausePending(true); await api('/api/re/pause', { option: 'deferred' }); refresh(); } catch (e) { console.error(e); setPausePending(false); }
  };

  const handleResumeRE = async () => {
    try { setResumePending(true); await api('/api/re/resume', {}); refresh(); } catch (e) { console.error(e); setResumePending(false); }
  };

  const handleAbortRE = async () => {
    try { setAbortPending(true); await api('/api/re/abort', {}); refresh(); } catch (e) { console.error(e); setAbortPending(false); }
  };

  const handleToggleAutostart = async () => {
    try {
      await api('/api/queue/autostart', { enable: !status?.queue_autostart_enabled });
      refresh();
    } catch (e) { console.error(e); }
  };

  const handleToggleLoop = async () => {
    try {
      await api('/api/queue/mode/set', { mode: { loop: !status?.plan_queue_mode?.loop } });
      refresh();
    } catch (e) { console.error(e); }
  };

  const handleClearQueue = async () => {
    if (!window.confirm('Are you sure you want to clear the queue?')) return;
    try { await api('/api/queue/clear', {}); refresh(); } catch (e) { console.error(e); }
  };

  const handleClearHistory = async () => {
    if (!window.confirm('Are you sure you want to clear the history?')) return;
    try { await api('/api/history/clear', {}); refresh(); } catch (e) { console.error(e); }
  };

  const handleCopyToQueue = async (item: QueueItem) => {
    try {
      await api('/api/queue/item/add', { item: { item_type: 'plan', name: item.name, args: item.args ?? [], kwargs: item.kwargs } });
      refresh();
    } catch (e) { console.error(e); }
  };

  const handleSaveHistory = () => {
    const rows = [
      ['start_time', 'stop_time', 'name', 'kwargs', 'exit_status', 'scan_ids', 'run_uids'],
      ...history.map(item => [
        item.result?.time_start != null ? new Date(item.result.time_start * 1000).toLocaleString() : '',
        item.result?.time_stop != null ? new Date(item.result.time_stop * 1000).toLocaleString() : '',
        item.name,
        itemSummary(item, allowedPlans),
        item.result?.exit_status ?? item.status ?? '',
        (item.result?.scan_ids ?? []).join(';'),
        (item.result?.run_uids ?? []).join(';'),
      ]),
    ];
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `qserver_history_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleAddToQueue = async () => {
    setSubmitMsg(''); setSubmitError('');
    const plan = allowedPlans.find(p => p.name === selectedPlan);
    if (!plan) return;
    const { args, kwargs } = buildArgsKwargs(paramValues, plan);
    try {
      const res = await api('/api/queue/item/add', {
        item: { item_type: 'plan', name: selectedPlan, args, kwargs },
      });
      if (res.success === false) { setSubmitError(res.msg ?? 'QServer rejected the item'); return; }
      setSubmitMsg(`Added: ${res.item?.item_uid?.slice(0, 8) ?? 'ok'}`);
      refresh();
    } catch (e) { setSubmitError(String(e)); }
  };

  const handleEditItem = (item: QueueItem) => {
    setSubmitMsg(''); setSubmitError('');
    setEditingItem(item);
    setSelectedPlan(item.name);
    const plan = allowedPlans.find(p => p.name === item.name);
    setParamValues(itemToParamValues(item, plan));
  };

  const handleUpdateQueue = async () => {
    if (!editingItem) return;
    setSubmitMsg(''); setSubmitError('');
    const plan = allowedPlans.find(p => p.name === selectedPlan);
    if (!plan) return;
    const { args, kwargs } = buildArgsKwargs(paramValues, plan);
    try {
      await api('/api/queue/item/update', {
        item: { item_type: 'plan', name: selectedPlan, args, kwargs, item_uid: editingItem.item_uid },
      });
      setEditingItem(null);
      refresh();
    } catch (e) { setSubmitError(String(e)); }
  };

  const handleDelete = async (uid: string) => {
    try {
      await api('/api/queue/item/remove', { uid });
      setSelectedUids(prev => { const next = new Set(prev); next.delete(uid); return next; });
      refresh();
    } catch (e) { console.error(e); }
  };

  const handleDuplicate = async (item: QueueItem) => {
    try {
      await api('/api/queue/item/add', { item: { item_type: 'plan', name: item.name, kwargs: item.kwargs } });
      refresh();
    } catch (e) { console.error(e); }
  };

  const lastSelectedUidRef = useRef<string | null>(null);

  const toggleSelect = (uid: string) => {
    setSelectedUids(prev => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid); else next.add(uid);
      return next;
    });
  };

  const handleSelect = (uid: string, e: React.MouseEvent) => {
    if (e.shiftKey && lastSelectedUidRef.current !== null) {
      // Range selection — anchor stays the same
      const lastIdx = queue.findIndex(i => i.item_uid === lastSelectedUidRef.current);
      const currIdx = queue.findIndex(i => i.item_uid === uid);
      if (lastIdx >= 0 && currIdx >= 0) {
        const [from, to] = lastIdx <= currIdx ? [lastIdx, currIdx] : [currIdx, lastIdx];
        const rangeUids = new Set(queue.slice(from, to + 1).map(i => i.item_uid));
        setSelectedUids(prev => new Set([...prev, ...rangeUids]));
        return; // don't move the anchor
      }
    } else if (e.ctrlKey || e.metaKey) {
      // Discrete toggle
      toggleSelect(uid);
    } else {
      // Plain click — deselect if already the only selection, otherwise single select
      if (selectedUids.has(uid) && selectedUids.size === 1) {
        setSelectedUids(new Set());
        lastSelectedUidRef.current = null;
        return;
      }
      setSelectedUids(new Set([uid]));
    }
    lastSelectedUidRef.current = uid;
  };

  const handleMoveSelected = async (direction: 'up' | 'down' | 'top' | 'bottom') => {
    const selected = queue.filter(i => selectedUids.has(i.item_uid));
    if (selected.length === 0) return;
    let localQueue = [...queue];
    try {
      if (direction === 'top') {
        for (const item of [...selected].reverse()) {
          await api('/api/queue/item/move', { uid: item.item_uid, pos_dest: 'front' });
          localQueue = [item, ...localQueue.filter(i => i.item_uid !== item.item_uid)];
        }
      } else if (direction === 'bottom') {
        for (const item of selected) {
          await api('/api/queue/item/move', { uid: item.item_uid, pos_dest: 'back' });
          localQueue = [...localQueue.filter(i => i.item_uid !== item.item_uid), item];
        }
      } else if (direction === 'up') {
        const firstIdx = localQueue.findIndex(i => i.item_uid === selected[0].item_uid);
        if (firstIdx === 0) return;
        for (const item of selected) {
          const idx = localQueue.findIndex(i => i.item_uid === item.item_uid);
          if (idx <= 0) continue;
          await api('/api/queue/item/move', { uid: item.item_uid, before_uid: localQueue[idx - 1].item_uid });
          const q = [...localQueue]; q.splice(idx, 1); q.splice(idx - 1, 0, item); localQueue = q;
        }
      } else if (direction === 'down') {
        const lastIdx = localQueue.findIndex(i => i.item_uid === selected[selected.length - 1].item_uid);
        if (lastIdx >= localQueue.length - 1) return;
        for (const item of [...selected].reverse()) {
          const idx = localQueue.findIndex(i => i.item_uid === item.item_uid);
          if (idx >= localQueue.length - 1) continue;
          if (idx + 2 < localQueue.length) {
            await api('/api/queue/item/move', { uid: item.item_uid, before_uid: localQueue[idx + 2].item_uid });
            const q = [...localQueue]; q.splice(idx, 1); q.splice(idx + 1, 0, item); localQueue = q;
          } else {
            await api('/api/queue/item/move', { uid: item.item_uid, pos_dest: 'back' });
            const q = [...localQueue]; q.splice(idx, 1); q.push(item); localQueue = q;
          }
        }
      }
    } catch (e) { console.error(e); }
    refresh();
  };

  const handleDropItems = async (draggedUid: string, dIdx: number) => {
    // If drag started from a selected item and multiple are selected, move all selected
    const isMultiMove = selectedUids.has(draggedUid) && selectedUids.size > 1;
    const itemsToMove: QueueItem[] = isMultiMove
      ? queue.filter(i => selectedUids.has(i.item_uid))
      : queue.filter(i => i.item_uid === draggedUid);

    if (itemsToMove.length === 0) return;

    // No-movement guard for single item
    if (!isMultiMove) {
      const srcIndex = queue.findIndex(i => i.item_uid === draggedUid);
      if (srcIndex < 0 || dIdx === srcIndex || dIdx === srcIndex + 1) return;
    }

    const moveSet = new Set(itemsToMove.map(i => i.item_uid));

    // Find the anchor: first non-moved item at or after dIdx
    let beforeUid: string | null = null;
    let useFront = false;
    let useBack = false;
    if (dIdx === 0) {
      useFront = true;
    } else if (dIdx >= queue.length) {
      useBack = true;
    } else {
      for (let i = dIdx; i < queue.length; i++) {
        if (!moveSet.has(queue[i].item_uid)) { beforeUid = queue[i].item_uid; break; }
      }
      if (!beforeUid) useBack = true;
    }

    try {
      // Move in reverse order so items land in their original relative order at the target
      const reversed = [...itemsToMove].reverse();
      for (let i = 0; i < reversed.length; i++) {
        const item = reversed[i];
        if (i === 0) {
          if (useFront) await api('/api/queue/item/move', { uid: item.item_uid, pos_dest: 'front' });
          else if (useBack) await api('/api/queue/item/move', { uid: item.item_uid, pos_dest: 'back' });
          else await api('/api/queue/item/move', { uid: item.item_uid, before_uid: beforeUid! });
        } else {
          // Each subsequent item goes before the one we just placed
          await api('/api/queue/item/move', { uid: item.item_uid, before_uid: reversed[i - 1].item_uid });
        }
      }
      refresh();
    } catch (e) { console.error(e); }
  };

  // ── Derived state ────────────────────────────────────────────────────────
  const isRERunning = status?.re_state === 'running' || status?.re_state === 'paused' || abortPending;
  const isREIdle = status?.re_state === 'idle' || !status?.worker_environment_exists;
  const reState = status?.re_state ?? '—';
  const activePlan = allowedPlans.find(p => p.name === selectedPlan);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left sidebar: Queue + RE + History */}
        <div className="flex-none bg-gray-50 border-r border-gray-200 flex flex-col overflow-hidden" style={{ width: sidebarWidth }}>

          {/* Queue */}
          <div className="flex-none px-3 py-4 bg-white border-b border-gray-200 flex items-center gap-2">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide flex-1">
              Queue · {queue.length + (runningItem ? 1 : 0)}
              {selectedUids.size > 0 && <span className="ml-1.5 text-sky-500 normal-case font-normal">({selectedUids.size} selected)</span>}
            </span>
            {selectedUids.size > 0 && (
              <>
                <button onClick={() => handleMoveSelected('top')} title="Move to top" className="text-xs px-1.5 py-0.5 rounded bg-gray-100 hover:bg-sky-100 hover:text-sky-700 text-gray-600 font-bold transition-colors">⇈</button>
                <button onClick={() => handleMoveSelected('up')} title="Move up" className="text-xs px-1.5 py-0.5 rounded bg-gray-100 hover:bg-sky-100 hover:text-sky-700 text-gray-600 font-bold transition-colors">↑</button>
                <button onClick={() => handleMoveSelected('down')} title="Move down" className="text-xs px-1.5 py-0.5 rounded bg-gray-100 hover:bg-sky-100 hover:text-sky-700 text-gray-600 font-bold transition-colors">↓</button>
                <button onClick={() => handleMoveSelected('bottom')} title="Move to bottom" className="text-xs px-1.5 py-0.5 rounded bg-gray-100 hover:bg-sky-100 hover:text-sky-700 text-gray-600 font-bold transition-colors">⇊</button>
                <div className="w-px h-4 bg-gray-300 mx-1" />
              </>
            )}
            <button
              onClick={handleToggleAutostart}
              title={status?.queue_autostart_enabled ? 'Auto-start enabled — click to disable' : 'Auto-start disabled — click to enable'}
              className={`text-xs px-2 py-0.5 rounded font-medium transition-colors ${
                status?.queue_autostart_enabled
                  ? 'bg-emerald-500 hover:bg-emerald-400 text-white'
                  : 'bg-gray-200 hover:bg-gray-300 text-gray-600'
              }`}
            >Auto</button>
            <button
              onClick={handleToggleLoop}
              title={status?.plan_queue_mode?.loop ? 'Loop enabled — click to disable' : 'Loop disabled — click to enable'}
              className={`text-xs px-2 py-0.5 rounded font-medium transition-colors ${
                status?.plan_queue_mode?.loop
                  ? 'bg-violet-500 hover:bg-violet-400 text-white'
                  : 'bg-gray-200 hover:bg-gray-300 text-gray-600'
              }`}
            >Loop</button>
            <div className="w-px h-4 bg-gray-300 mx-1" />
            <button
              onClick={handleStartRE}
              disabled={isRERunning}
              className="text-xs px-2 py-0.5 rounded bg-sky-600 hover:bg-sky-500 disabled:bg-gray-200 disabled:text-gray-400 text-white font-medium transition-colors"
            >Start</button>
            <button
              onClick={handleStopRE}
              disabled={isREIdle}
              className={`text-xs px-2 py-0.5 rounded font-medium transition-colors disabled:bg-gray-200 disabled:text-gray-400 ${
                status?.queue_stop_pending
                  ? 'bg-amber-400 hover:bg-amber-300 text-white ring-2 ring-amber-300 ring-offset-1 animate-pulse'
                  : 'bg-red-500 hover:bg-red-400 text-white'
              }`}
              title={status?.queue_stop_pending ? 'Stop pending — click to cancel' : 'Stop queue after current plan'}
            >{status?.queue_stop_pending ? 'Cancel Stop' : 'Stop'}</button>
            <div className="w-px h-4 bg-gray-300 mx-1" />
            <button
              onClick={handleClearQueue}
              className="text-xs px-2 py-0.5 rounded bg-gray-100 hover:bg-red-100 hover:text-red-600 text-gray-600 font-medium transition-colors"
              title="Clear all items from the queue"
            >Clear</button>
          </div>

          <div
            className="overflow-y-auto p-2 min-h-0 flex flex-col gap-1.5"
            style={{ height: queueHeight }}
            onDragOver={e => e.preventDefault()}
            onDragLeave={e => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setDropIndex(null); dropIndexRef.current = null;
              }
            }}
            onDrop={e => {
              // Fallback: fires when dropping on the catchall area (not on a card)
              e.preventDefault();
              const uid = dragUidRef.current;
              const dIdx = dropIndexRef.current;
              setDragUid(null); dragUidRef.current = null;
              setDropIndex(null); dropIndexRef.current = null;
              if (uid !== null && dIdx !== null) handleDropItems(uid, dIdx);
            }}
          >
            {runningItem && (
              <QueueCard item={runningItem} summary={itemSummary(runningItem, allowedPlans)} running key={runningItem.item_uid} onDelete={() => {}} />
            )}
            {queue.map((item, idx) => (
              <div
                key={item.item_uid}
                className="flex flex-col gap-0"
                onDrop={e => {
                  e.preventDefault();
                  e.stopPropagation(); // prevent container's onDrop from double-firing
                  const uid = dragUidRef.current;
                  const dIdx = dropIndexRef.current;
                  setDragUid(null); dragUidRef.current = null;
                  setDropIndex(null); dropIndexRef.current = null;
                  if (uid !== null && dIdx !== null) handleDropItems(uid, dIdx);
                }}
              >
                {/* Drop indicator above this card */}
                <div
                  className={`h-0.5 rounded transition-colors mb-0.5 ${dragUid && dropIndex === idx ? 'bg-sky-400' : 'bg-transparent'}`}
                  onDragOver={e => {
                    e.preventDefault(); e.stopPropagation();
                    setDropIndex(idx); dropIndexRef.current = idx;
                  }}
                />
                <QueueCard
                  item={item}
                  summary={itemSummary(item, allowedPlans)}
                  running={false}
                  selected={selectedUids.has(item.item_uid)}
                  onSelect={e => handleSelect(item.item_uid, e)}
                  onDelete={() => handleDelete(item.item_uid)}
                  onEdit={() => handleEditItem(item)}
                  onDuplicate={() => handleDuplicate(item)}
                  dragging={dragUid !== null && (dragUid === item.item_uid || (selectedUids.has(dragUid) && selectedUids.has(item.item_uid)))}
                  onDragStart={e => {
                    e.dataTransfer.effectAllowed = 'move';
                    setDragUid(item.item_uid); dragUidRef.current = item.item_uid;
                  }}
                  onDragEnd={() => {
                    setDragUid(null); dragUidRef.current = null;
                    setDropIndex(null); dropIndexRef.current = null;
                  }}
                  onDragOver={e => {
                    e.preventDefault(); e.stopPropagation();
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    const dIdx = e.clientY < rect.top + rect.height / 2 ? idx : idx + 1;
                    setDropIndex(dIdx); dropIndexRef.current = dIdx;
                  }}
                />
              </div>
            ))}
            {/* Drop indicator at end */}
            <div
              className={`h-0.5 rounded transition-colors ${dragUid && dropIndex === queue.length ? 'bg-sky-400' : 'bg-transparent'}`}
              onDragOver={e => {
                e.preventDefault(); e.stopPropagation();
                setDropIndex(queue.length); dropIndexRef.current = queue.length;
              }}
            />
            {/* Catchall drop zone */}
            <div
              className="flex-1 min-h-8"
              onDragOver={e => {
                e.preventDefault();
                setDropIndex(queue.length); dropIndexRef.current = queue.length;
              }}
            />
            {queue.length === 0 && !runningItem && (
              <p className="text-xs text-gray-400 text-center py-4">Queue is empty</p>
            )}
          </div>

          {/* Queue/History drag handle */}
          <div
            className="flex-none h-1 cursor-row-resize bg-gray-200 hover:bg-sky-400 transition-colors"
            onMouseDown={dragQueue}
          />

          {/* History */}
          <div className="flex-none px-3 py-4 bg-white border-b border-gray-200 flex items-center gap-2">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide flex-1">
              History · {history.length}
            </span>
            <button
              onClick={handleSaveHistory}
              disabled={history.length === 0}
              className="text-xs px-2 py-0.5 rounded bg-gray-100 hover:bg-sky-100 hover:text-sky-600 text-gray-600 font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="Save history as CSV"
            >Save</button>
            <button
              onClick={handleClearHistory}
              className="text-xs px-2 py-0.5 rounded bg-gray-100 hover:bg-red-100 hover:text-red-600 text-gray-600 font-medium transition-colors"
              title="Clear all history"
            >Clear</button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5 min-h-0">
            {history.map(item => (
              <HistoryCard key={item.item_uid} item={item} summary={itemSummary(item, allowedPlans)} onCopyToQueue={() => handleCopyToQueue(item)} />
            ))}
            {history.length === 0 && (
              <p className="text-xs text-gray-400 text-center py-4">No history</p>
            )}
          </div>
        </div>

        {/* Vertical drag handle */}
        <div
          className="flex-none w-1 cursor-col-resize bg-gray-200 hover:bg-sky-400 transition-colors"
          onMouseDown={dragSidebar}
        />

        {/* Right main area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Top section: Running Plan + Add Item side by side */}
          <div className="flex-none flex flex-row overflow-hidden" style={{ height: topSectionHeight }}>

            {/* Running Plan */}
            <div className="flex-none flex flex-col overflow-hidden border-r border-gray-200" style={{ width: runningPlanWidth }}>
              <div className="flex-none px-3 py-4 bg-white border-b border-gray-200 flex items-center gap-2">
                <span className={`w-3 h-3 rounded-full shrink-0 ${
                  !status?.worker_environment_exists ? 'bg-red-500' :
                  abortPending ? 'bg-amber-400 animate-pulse' :
                  resumePending ? 'bg-sky-500 animate-pulse' :
                  status?.re_state === 'paused' ? 'bg-amber-400 animate-pulse' :
                  status?.re_state === 'running' ? 'bg-sky-500 animate-pulse' :
                  'bg-green-500'
                }`} />
                <span className="text-sm text-gray-600 font-medium flex-1">
                  {!status?.worker_environment_exists ? 'RE Env not open' : `RE: ${reState}`}
                </span>
                {status?.re_state === 'running' && (
                  <button
                    onClick={handlePauseRE}
                    className={`text-xs px-2 py-0.5 rounded font-medium transition-colors ${
                      pausePending
                        ? 'bg-amber-400 text-white animate-pulse ring-2 ring-amber-300 ring-offset-1'
                        : 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                    }`}
                    title={pausePending ? 'Pause requested — waiting for checkpoint…' : 'Pause at next checkpoint'}
                  >{pausePending ? 'Pausing…' : 'Pause'}</button>
                )}
                {status?.re_state === 'paused' && !abortPending && (
                  <button
                    onClick={handleResumeRE}
                    className={`text-xs px-2 py-0.5 rounded font-medium transition-colors ${
                      resumePending
                        ? 'bg-sky-500 text-white animate-pulse ring-2 ring-sky-300 ring-offset-1'
                        : 'bg-sky-100 text-sky-700 hover:bg-sky-200'
                    }`}
                    title={resumePending ? 'Resume requested…' : 'Resume paused plan'}
                  >{resumePending ? 'Resuming…' : 'Resume'}</button>
                )}
                {(status?.re_state === 'paused' || abortPending) && (
                  <button
                    onClick={handleAbortRE}
                    disabled={abortPending}
                    className={`text-xs px-2 py-0.5 rounded font-medium transition-colors ${abortPending ? 'bg-red-500 text-white animate-pulse ring-2 ring-red-300 ring-offset-1' : 'bg-red-100 text-red-600 hover:bg-red-200'}`}
                    title={abortPending ? 'Aborting…' : 'Abort paused plan'}
                  >{abortPending ? 'Aborting…' : 'Abort'}</button>
                )}
              </div>
              <div className="flex-1 overflow-y-auto p-4 bg-white text-sm">
                {runningItem ? (
                  <div className="space-y-2">
                    <div><span className="font-semibold">Plan Name: </span><span className="text-teal-600">{runningItem.name}</span></div>
                    <div>
                      <div className="font-semibold">Parameters:</div>
                      <div className="pl-4 space-y-0.5 mt-0.5">
                        {Object.entries(runningItem.kwargs ?? {}).map(([k, v]) => (
                          <div key={k}><span className="font-semibold">{k}: </span><span className="text-gray-600">{JSON.stringify(v)}</span></div>
                        ))}
                      </div>
                    </div>
                    <div>
                      <div className="font-semibold">Runs:</div>
                      {(!reRuns?.run_list || reRuns.run_list.length === 0) ? (
                        <p className="pl-4 mt-0.5 text-xs text-gray-400 italic">Waiting for runs…</p>
                      ) : (
                        <div className="pl-4 space-y-2 mt-0.5">
                          {reRuns.run_list.map(run => (
                            <div key={run.uid} className="space-y-0.5">
                              <div><span className="font-semibold">uid: </span><span className="font-mono text-xs text-gray-500 break-all">{run.uid}</span></div>
                              {run.scan_id != null && <div><span className="font-semibold">scan_id: </span>{run.scan_id}</div>}
                              <div>
                                <span className="font-semibold">Exit status: </span>
                                {run.is_open
                                  ? <span className="text-sky-600">In progress…</span>
                                  : run.exit_status === 'success'
                                  ? <span className="text-green-600">success</span>
                                  : run.exit_status === 'failed'
                                  ? <span className="text-red-500">{run.exit_status}</span>
                                  : run.exit_status
                                  ? <span className="text-amber-500">{run.exit_status}</span>
                                  : <span className="text-gray-400">unknown</span>
                                }
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-gray-400">No plan running.</p>
                )}
              </div>
            </div>

            {/* Running Plan / Add Item vertical drag handle */}
            <div
              className="flex-none w-1 cursor-col-resize bg-gray-200 hover:bg-sky-400 transition-colors"
              onMouseDown={dragRunningPlan}
            />

            {/* Add Item */}
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="flex-none px-4 py-[14px] bg-white border-b border-gray-200">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Add Item</span>
              </div>
              <div className="flex-1 overflow-y-auto bg-white p-4">

            {allowedPlans.length === 0 ? (
              <p className="text-xs text-gray-400">
                {status ? 'No plans available — check QServer URL.' : 'Connect to a queue server to add plans.'}
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {/* Edit mode banner */}
                {editingItem && (
                  <div className="flex items-center gap-2 px-1 py-1 bg-amber-50 border border-amber-200 rounded text-xs text-amber-700">
                    <span className="flex-1">Editing item <span className="font-mono font-semibold">{editingItem.item_uid.slice(0, 8)}…</span></span>
                    <button onClick={() => { setEditingItem(null); setSubmitMsg(''); setSubmitError(''); }} className="text-amber-500 hover:text-amber-700 font-medium">Cancel</button>
                  </div>
                )}
                {/* Plan selector + action button */}
                <div className="flex items-center gap-3">
                  <label className="text-xs text-gray-500 w-20 shrink-0 text-right">Plan</label>
                  <select
                    value={selectedPlan}
                    onChange={e => setSelectedPlan(e.target.value)}
                    disabled={!!editingItem}
                    className="flex-1 text-sm border border-gray-200 rounded px-2 py-1 bg-white focus:outline-none focus:border-sky-400 disabled:bg-gray-50 disabled:text-gray-400"
                  >
                    {allowedPlans.map(p => (
                      <option key={p.name} value={p.name}>{p.name}</option>
                    ))}
                  </select>
                  {editingItem ? (
                    <button
                      onClick={handleUpdateQueue}
                      className="text-sm bg-amber-500 hover:bg-amber-400 text-white px-4 py-1 rounded font-medium transition-colors shrink-0"
                    >Update</button>
                  ) : (
                    <button
                      onClick={handleAddToQueue}
                      className="text-sm bg-sky-600 hover:bg-sky-500 text-white px-4 py-1 rounded font-medium transition-colors shrink-0"
                    >Add to Queue</button>
                  )}
                  {submitMsg && <span className="text-xs text-green-600 shrink-0">{submitMsg}</span>}
                  {submitError && <span className="text-xs text-red-500 shrink-0">{submitError}</span>}
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
              </div>
            )}
          </div>
        </div>{/* end Add Item column */}
        </div>{/* end top section */}

          {/* Top section / Console drag handle */}
          <div
            className="flex-none h-1 cursor-row-resize bg-gray-300 hover:bg-sky-400 transition-colors"
            onMouseDown={dragTopSection}
          />

          {/* Console */}
          <div className="flex-1 flex flex-col overflow-hidden bg-gray-900">
            <div className="flex-none flex items-center gap-3 px-3 py-4 bg-gray-800 border-b border-gray-700">
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide flex-1">
                Console Output
                {consoleError && <span className="ml-2 font-normal normal-case text-red-400">— {consoleError}</span>}
              </span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                wsStatus === 'open' ? 'bg-green-800 text-green-300' :
                wsStatus === 'connecting' ? 'bg-amber-800 text-amber-300' :
                wsStatus === 'error' ? 'bg-red-800 text-red-300' :
                'bg-gray-700 text-gray-400'
              }`}>{wsStatus}</span>
              <button
                onClick={() => setConsoleLines([])}
                className="text-xs text-gray-500 hover:text-gray-300"
              >Clear</button>
              <label className="flex items-center gap-1 text-xs text-gray-500">
                Max
                <input
                  type="number"
                  min={100}
                  step={100}
                  value={maxLines}
                  onChange={e => { const v = Math.max(100, Number(e.target.value) || 1000); setMaxLines(v); maxLinesRef.current = v; }}
                  className="w-16 bg-gray-700 text-gray-300 rounded px-1 py-0.5 text-xs text-right focus:outline-none focus:ring-1 focus:ring-sky-500"
                />
              </label>
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
            <div
              ref={consoleScrollRef}
              onScroll={() => {
                const el = consoleScrollRef.current;
                if (!el) return;
                autoScrollRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
              }}
              className="flex-1 overflow-y-auto p-3 font-mono text-xs text-green-300 leading-relaxed"
            >
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
