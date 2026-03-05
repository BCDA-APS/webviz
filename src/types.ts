export type DatasetPanel = {
  id: string;
  type: 'dataset';
  url: string;
  title: string;
};

export type XYTrace = {
  x: number[];
  y: number[];
  xLabel: string;
  yLabel: string;
  runLabel: string;
  runId: string;
};

export type XYPanel = {
  id: string;
  type: 'xy';
  traces: XYTrace[];
  title: string;
  liveConfig?: {
    serverUrl: string;
    catalog: string;
    stream: string;
    runId: string;
    dataSubNode: string;
    dataNodeFamily: 'array' | 'table';
  };
};

export type Panel = DatasetPanel | XYPanel;
