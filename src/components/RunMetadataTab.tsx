import { useState, useEffect } from 'react';

type Props = {
  serverUrl: string;
  catalog: string | null;
  runId: string;
  runAcquiring?: boolean;
};

const catSeg = (c: string | null) => c ? `/${c}` : '';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function MetaValue({ value, depth = 0 }: { value: any; depth?: number }) {
  const [open, setOpen] = useState(depth < 2);

  if (value === null || value === undefined) {
    return <span className="text-gray-400">null</span>;
  }
  if (typeof value === 'boolean') {
    return <span className="text-purple-600">{String(value)}</span>;
  }
  if (typeof value === 'number') {
    return <span className="text-blue-600 font-mono">{value}</span>;
  }
  if (typeof value === 'string') {
    return <span className="text-green-700">"{value}"</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-gray-400">[]</span>;
    if (value.every(v => typeof v === 'number' || typeof v === 'string')) {
      // Compact display for flat arrays
      const preview = value.slice(0, 5).join(', ');
      const suffix = value.length > 5 ? `, … (${value.length})` : '';
      return <span className="text-gray-600 font-mono">[{preview}{suffix}]</span>;
    }
    return (
      <span>
        <button
          onClick={() => setOpen(o => !o)}
          className="text-xs text-gray-400 hover:text-gray-600 mr-1"
        >
          {open ? '▾' : '▸'}
        </button>
        {open ? (
          <span className="block pl-4 border-l border-gray-200 ml-1">
            {value.map((v, i) => (
              <div key={i} className="my-0.5">
                <span className="text-gray-400 mr-1">[{i}]</span>
                <MetaValue value={v} depth={depth + 1} />
              </div>
            ))}
          </span>
        ) : (
          <span className="text-gray-400">[{value.length} items]</span>
        )}
      </span>
    );
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return <span className="text-gray-400">{'{}'}</span>;
    return (
      <span>
        <button
          onClick={() => setOpen(o => !o)}
          className="text-xs text-gray-400 hover:text-gray-600 mr-1"
        >
          {open ? '▾' : '▸'}
        </button>
        {open ? (
          <span className="block pl-4 border-l border-gray-200 ml-1">
            {keys.map(k => (
              <div key={k} className="my-0.5">
                <span className="text-gray-500 font-medium mr-1">{k}:</span>
                <MetaValue value={value[k]} depth={depth + 1} />
              </div>
            ))}
          </span>
        ) : (
          <span className="text-gray-400">{'{…}'}</span>
        )}
      </span>
    );
  }
  return <span>{String(value)}</span>;
}

function Section({ title, value }: { title: string; value: unknown }) {
  const [open, setOpen] = useState(true);
  if (!value || (typeof value === 'object' && Object.keys(value as object).length === 0)) return null;
  return (
    <div className="border border-gray-200 rounded mb-2">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-gray-50 text-left hover:bg-gray-100 transition-colors rounded-t"
      >
        <span className="text-xs text-gray-400">{open ? '▾' : '▸'}</span>
        <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">{title}</span>
      </button>
      {open && (
        <div className="px-3 py-2 text-xs leading-relaxed">
          <MetaValue value={value} depth={1} />
        </div>
      )}
    </div>
  );
}

export default function RunMetadataTab({ serverUrl, catalog, runId, runAcquiring }: Props) {
  const [meta, setMeta] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!serverUrl || catalog === null || !runId) { setMeta(null); return; }
    setLoading(true);
    setMeta(null);
    const fetchMeta = () =>
      fetch(`${serverUrl}/api/v1/metadata${catSeg(catalog)}/${runId}`)
        .then(r => r.json())
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .then((j: any) => setMeta(j.data?.attributes?.metadata ?? j.data?.attributes ?? j))
        .catch(() => {});
    fetchMeta().finally(() => setLoading(false));
    const id = runAcquiring ? setInterval(fetchMeta, 5000) : undefined;
    return () => { if (id) clearInterval(id); };
  }, [serverUrl, catalog, runId, runAcquiring]);

  if (!runId) {
    return (
      <div className="h-full flex items-center justify-center text-gray-400 text-sm">
        Select a run to view metadata
      </div>
    );
  }

  if (loading) {
    return <div className="flex items-center justify-center h-full text-gray-400 text-sm">Loading…</div>;
  }

  if (!meta) {
    return <div className="flex items-center justify-center h-full text-gray-400 text-sm">No metadata</div>;
  }

  // Bluesky runs have start/stop/descriptors sections; display them prominently
  const start = meta.start as Record<string, unknown> | undefined;
  const stop = meta.stop as Record<string, unknown> | undefined;
  const descriptors = meta.descriptors as unknown[] | undefined;
  const otherKeys = Object.keys(meta).filter(k => !['start', 'stop', 'descriptors'].includes(k));

  return (
    <div className="h-full overflow-auto p-3">
      {start && <Section title="Start" value={start} />}
      {stop && <Section title="Stop" value={stop} />}
      {descriptors && descriptors.length > 0 && (
        <Section title={`Descriptors (${descriptors.length})`} value={descriptors} />
      )}
      {otherKeys.map(k => (
        <Section key={k} title={k} value={meta[k]} />
      ))}
    </div>
  );
}
