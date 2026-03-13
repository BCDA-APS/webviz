const PREC = 1e6;
const round = (v: number) => Math.round(v * PREC);

export interface ZMatrixResult {
  zMatrix: number[][];
  slowAxis: number[];
  fastAxis: number[];
}

/**
 * Reconstruct a 2D z-matrix and axis arrays from flat column data.
 * slowMotor values become rows (sorted ascending), fastMotor values become columns.
 * Missing points are filled with NaN. Floating-point positions are rounded to 1e-6
 * precision before uniqueness comparison to avoid spurious duplicates.
 *
 * When `shape` is provided (from start.shape in Bluesky metadata), range-based
 * binning is used instead of unique-value detection. This handles motor position
 * jitter where encoder readings differ slightly from setpoints, which would
 * otherwise produce a huge sparse matrix with mostly-NaN cells.
 */
export function buildZMatrix(
  data: Record<string, number[]>,
  zField: string,
  slowMotor: string,
  fastMotor: string,
  shape?: [number, number] | null,
): ZMatrixResult | null {
  const zFlat = data[zField];
  const m1Flat = data[slowMotor];
  const m2Flat = data[fastMotor];
  if (!zFlat || !m1Flat || !m2Flat) return null;

  const n = zFlat.length;

  if (shape && shape[0] > 0 && shape[1] > 0) {
    // Shape-constrained path: bin motor positions into exactly shape[0] × shape[1] cells.
    // Range-based rounding handles jitter where encoder readings differ from setpoints.
    const nR = shape[0];
    const nC = shape[1];

    let m1Min = Infinity, m1Max = -Infinity, m2Min = Infinity, m2Max = -Infinity;
    for (let k = 0; k < n; k++) {
      if (m1Flat[k] < m1Min) m1Min = m1Flat[k];
      if (m1Flat[k] > m1Max) m1Max = m1Flat[k];
      if (m2Flat[k] < m2Min) m2Min = m2Flat[k];
      if (m2Flat[k] > m2Max) m2Max = m2Flat[k];
    }

    const m1Span = m1Max - m1Min || 1;
    const m2Span = m2Max - m2Min || 1;

    const sums:   number[][] = Array.from({ length: nR }, () => new Array(nC).fill(0));
    const counts: number[][] = Array.from({ length: nR }, () => new Array(nC).fill(0));
    for (let k = 0; k < n; k++) {
      const ri = nR === 1 ? 0 : Math.min(nR - 1, Math.round(((m1Flat[k] - m1Min) / m1Span) * (nR - 1)));
      const ci = nC === 1 ? 0 : Math.min(nC - 1, Math.round(((m2Flat[k] - m2Min) / m2Span) * (nC - 1)));
      sums[ri][ci]   += zFlat[k];
      counts[ri][ci] += 1;
    }
    const rows = sums.map((row, ri) =>
      row.map((s, ci) => counts[ri][ci] > 0 ? s / counts[ri][ci] : NaN)
    );

    const slowAxis = Array.from({ length: nR }, (_, i) => m1Min + (i / Math.max(1, nR - 1)) * m1Span);
    const fastAxis = Array.from({ length: nC }, (_, i) => m2Min + (i / Math.max(1, nC - 1)) * m2Span);
    return { zMatrix: rows, slowAxis, fastAxis };
  }

  // Original path: find unique positions via Set + rounding.
  const m1Unique = [...new Set(m1Flat.map(round))].sort((a, b) => a - b);
  const m2Unique = [...new Set(m2Flat.map(round))].sort((a, b) => a - b);
  const m1Idx = new Map(m1Unique.map((v, i) => [v, i]));
  const m2Idx = new Map(m2Unique.map((v, i) => [v, i]));
  const nR = m1Unique.length;
  const nC = m2Unique.length;
  const rows: number[][] = Array.from({ length: nR }, () => new Array(nC).fill(NaN));
  for (let k = 0; k < n; k++) {
    const ri = m1Idx.get(round(m1Flat[k]));
    const ci = m2Idx.get(round(m2Flat[k]));
    if (ri !== undefined && ci !== undefined) rows[ri][ci] = zFlat[k];
  }
  return {
    zMatrix: rows,
    slowAxis: m1Unique.map(v => v / PREC),
    fastAxis: m2Unique.map(v => v / PREC),
  };
}

/** Min and max of all finite values in a 2D matrix. */
export function matrixRange(mat: number[][]): { min: number; max: number } {
  let mn = Infinity, mx = -Infinity;
  for (const row of mat) for (const v of row) {
    if (isFinite(v)) { if (v < mn) mn = v; if (v > mx) mx = v; }
  }
  return { min: mn, max: mx };
}
