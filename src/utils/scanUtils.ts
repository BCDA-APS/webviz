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
 */
export function buildZMatrix(
  data: Record<string, number[]>,
  zField: string,
  slowMotor: string,
  fastMotor: string,
): ZMatrixResult | null {
  const zFlat = data[zField];
  const m1Flat = data[slowMotor];
  const m2Flat = data[fastMotor];
  if (!zFlat || !m1Flat || !m2Flat) return null;

  const n = zFlat.length;
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
