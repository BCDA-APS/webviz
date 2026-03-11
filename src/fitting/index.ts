// ─── Array helpers (avoid spread into Math.min/max — crashes on large arrays) ─

function arrMin(a: number[]): number { let m = Infinity; for (let i = 0; i < a.length; i++) if (a[i] < m) m = a[i]; return m; }
function arrMax(a: number[]): number { let m = -Infinity; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; }
function argMax(a: number[]): number { let idx = 0, m = -Infinity; for (let i = 0; i < a.length; i++) if (a[i] > m) { m = a[i]; idx = i; } return idx; }
function argMin(a: number[]): number { let idx = 0, m = Infinity; for (let i = 0; i < a.length; i++) if (a[i] < m) { m = a[i]; idx = i; } return idx; }

// ─── Math helpers ────────────────────────────────────────────────────────────

/** Abramowitz & Stegun erf approximation, max error 1.5e-7 */
function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - y * Math.exp(-x * x));
}

/** Solve A·x = b by Gaussian elimination with partial pivoting. Returns null if singular. */
function solveLU(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    let maxRow = i;
    for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[maxRow][i])) maxRow = k;
    [M[i], M[maxRow]] = [M[maxRow], M[i]];
    if (Math.abs(M[i][i]) < 1e-14) return null;
    for (let k = i + 1; k < n; k++) {
      const f = M[k][i] / M[i][i];
      for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    x[i] = M[i][n];
    for (let j = i + 1; j < n; j++) x[i] -= M[i][j] * x[j];
    x[i] /= M[i][i];
  }
  return x;
}

/** Polynomial least-squares fit. Returns coefficients [c0, c1, …, cd] (ascending order). */
function polyfit(xs: number[], ys: number[], degree: number): number[] {
  const m = degree + 1;
  const A = Array.from({ length: m }, (_, i) =>
    Array.from({ length: m }, (_, j) => xs.reduce((s, x) => s + Math.pow(x, i + j), 0))
  );
  const b = Array.from({ length: m }, (_, i) =>
    xs.reduce((s, x, k) => s + Math.pow(x, i) * ys[k], 0)
  );
  return solveLU(A, b) ?? new Array(m).fill(0);
}

// ─── Levenberg-Marquardt optimizer ──────────────────────────────────────────

function lmFit(
  fn: (x: number, p: number[]) => number,
  xs: number[], ys: number[], p0: number[],
  maxIter = 500,
): number[] {
  const m = p0.length;
  const eps = 1e-7;
  let p = [...p0];
  let lam = 0.01;

  const res = (p: number[]) => xs.map((x, i) => ys[i] - fn(x, p));
  const sse = (r: number[]) => r.reduce((s, ri) => s + ri * ri, 0);

  let r = res(p);
  let S = sse(r);

  for (let iter = 0; iter < maxIter; iter++) {
    // Jacobian via central differences
    const J: number[][] = xs.map((x) =>
      Array.from({ length: m }, (_, j) => {
        const ph = [...p]; ph[j] += eps;
        const pl = [...p]; pl[j] -= eps;
        return (fn(x, ph) - fn(x, pl)) / (2 * eps);
      })
    );

    // JᵀJ and Jᵀr
    const JtJ = Array.from({ length: m }, (_, i) =>
      Array.from({ length: m }, (_, j) => r.reduce((s, _, k) => s + J[k][i] * J[k][j], 0))
    );
    const Jtr = Array.from({ length: m }, (_, i) => r.reduce((s, rk, k) => s + J[k][i] * rk, 0));

    // Damped normal equations
    const A = JtJ.map((row, i) => row.map((v, j) => i === j ? v * (1 + lam) : v));
    const dp = solveLU(A, Jtr);
    if (!dp) { lam *= 10; continue; }

    const pNew = p.map((pi, i) => pi + dp[i]);
    const rNew = res(pNew);
    const SNew = sse(rNew);

    if (SNew < S) {
      if (dp.every((d, i) => Math.abs(d) < 1e-10 * (1 + Math.abs(p[i])))) break;
      p = pNew; r = rNew; S = SNew;
      lam = Math.max(lam / 10, 1e-7);
    } else {
      lam = Math.min(lam * 10, 1e7);
    }
  }
  return p;
}

function computeRSquared(ys: number[], yFit: number[]): number {
  const mean = ys.reduce((s, y) => s + y, 0) / ys.length;
  const sst = ys.reduce((s, y) => s + (y - mean) * (y - mean), 0);
  const sse = ys.reduce((s, y, i) => s + (y - yFit[i]) * (y - yFit[i]), 0);
  return sst === 0 ? 1 : 1 - sse / sst;
}

// ─── Fit result type ─────────────────────────────────────────────────────────

export type FitParam = { name: string; label: string; value: number };

export type FitResult = {
  model: string;
  params: FitParam[];
  rSquared: number;
  xFit: number[];
  yFit: number[];
};

// ─── Model definitions ───────────────────────────────────────────────────────

type ModelDef = {
  paramNames: string[];
  paramLabels: string[];
  fn: (x: number, p: number[]) => number;
  estimate: (xs: number[], ys: number[]) => number[];
};

const SQRT2 = Math.SQRT2;

function halfWidthEstimate(xs: number[], ys: number[], center: number, halfMax: number): number {
  // Find leftmost and rightmost crossing of half-max
  let left = xs[0], right = xs[xs.length - 1];
  for (let i = 0; i < xs.length - 1; i++) {
    if ((ys[i] - halfMax) * (ys[i + 1] - halfMax) < 0) {
      const t = (halfMax - ys[i]) / (ys[i + 1] - ys[i]);
      const x = xs[i] + t * (xs[i + 1] - xs[i]);
      if (x < center) left = x; else right = x;
    }
  }
  const fwhm = Math.max(right - left, (xs[xs.length - 1] - xs[0]) / 10);
  return fwhm / 2.355; // σ = FWHM / (2√(2ln2))
}

const MODELS: Record<string, ModelDef> = {
  'Gaussian': {
    paramNames: ['amplitude', 'center', 'sigma', 'offset'],
    paramLabels: ['Amplitude', 'Center', 'Sigma', 'Offset'],
    fn: (x, [A, c, s, o]) => A * Math.exp(-(x - c) * (x - c) / (2 * s * s)) + o,
    estimate: (xs, ys) => {
      const o = arrMin(ys);
      const A = arrMax(ys) - o;
      const c = xs[argMax(ys)];
      const s = halfWidthEstimate(xs, ys, c, o + A / 2);
      return [A, c, s, o];
    },
  },

  'Negative Gaussian': {
    paramNames: ['amplitude', 'center', 'sigma', 'offset'],
    paramLabels: ['Amplitude', 'Center', 'Sigma', 'Offset'],
    fn: (x, [A, c, s, o]) => -Math.abs(A) * Math.exp(-(x - c) * (x - c) / (2 * s * s)) + o,
    estimate: (xs, ys) => {
      const o = arrMax(ys);
      const A = o - arrMin(ys);
      const c = xs[argMin(ys)];
      const s = halfWidthEstimate(xs, ys.map(y => -y), c, -o + A / 2);
      return [A, c, Math.abs(s), o];
    },
  },

  'Lorentzian': {
    paramNames: ['amplitude', 'center', 'gamma', 'offset'],
    paramLabels: ['Amplitude', 'Center', 'Gamma', 'Offset'],
    fn: (x, [A, c, g, o]) => A * g * g / ((x - c) * (x - c) + g * g) + o,
    estimate: (xs, ys) => {
      const o = arrMin(ys);
      const A = arrMax(ys) - o;
      const c = xs[argMax(ys)];
      const s = halfWidthEstimate(xs, ys, c, o + A / 2);
      return [A, c, Math.abs(s), o];
    },
  },

  'Negative Lorentzian': {
    paramNames: ['amplitude', 'center', 'gamma', 'offset'],
    paramLabels: ['Amplitude', 'Center', 'Gamma', 'Offset'],
    fn: (x, [A, c, g, o]) => -Math.abs(A) * g * g / ((x - c) * (x - c) + g * g) + o,
    estimate: (xs, ys) => {
      const o = arrMax(ys);
      const A = o - arrMin(ys);
      const c = xs[argMin(ys)];
      const s = halfWidthEstimate(xs, ys.map(y => -y), c, -o + A / 2);
      return [A, c, Math.abs(s), o];
    },
  },

  'Linear': {
    paramNames: ['slope', 'intercept'],
    paramLabels: ['Slope', 'Intercept'],
    fn: (x, [m, b]) => m * x + b,
    estimate: (xs, ys) => {
      const [b, m] = polyfit(xs, ys, 1);
      return [m, b];
    },
  },

  'Exponential': {
    paramNames: ['amplitude', 'decay', 'offset'],
    paramLabels: ['Amplitude', 'Decay', 'Offset'],
    fn: (x, [A, d, o]) => A * Math.exp(-d * x) + o,
    estimate: (xs, ys) => {
      const o = arrMin(ys);
      const A = arrMax(ys) - o;
      const xRange = arrMax(xs) - arrMin(xs);
      return [A, 1 / (xRange || 1), o];
    },
  },

  'Quadratic': {
    paramNames: ['c0', 'c1', 'c2'],
    paramLabels: ['c₀ (offset)', 'c₁ (linear)', 'c₂ (quadratic)'],
    fn: (x, [c0, c1, c2]) => c0 + c1 * x + c2 * x * x,
    estimate: (xs, ys) => {
      const [c0, c1, c2] = polyfit(xs, ys, 2);
      return [c0, c1, c2];
    },
  },

  'Cubic': {
    paramNames: ['c0', 'c1', 'c2', 'c3'],
    paramLabels: ['c₀ (offset)', 'c₁ (linear)', 'c₂ (quadratic)', 'c₃ (cubic)'],
    fn: (x, [c0, c1, c2, c3]) => c0 + c1 * x + c2 * x * x + c3 * x * x * x,
    estimate: (xs, ys) => {
      const [c0, c1, c2, c3] = polyfit(xs, ys, 3);
      return [c0, c1, c2, c3];
    },
  },

  'Error Function': {
    paramNames: ['amplitude', 'center', 'sigma', 'offset'],
    paramLabels: ['Amplitude', 'Center', 'Sigma', 'Offset'],
    fn: (x, [A, c, s, o]) => A * erf((x - c) / (s * SQRT2)) + o,
    estimate: (xs, ys) => {
      const yMid = (arrMax(ys) + arrMin(ys)) / 2;
      const A = (arrMax(ys) - arrMin(ys)) / 2;
      const o = yMid;
      // center where y is closest to yMid
      let cIdx = 0;
      let minDist = Infinity;
      for (let i = 0; i < ys.length; i++) {
        const d = Math.abs(ys[i] - yMid);
        if (d < minDist) { minDist = d; cIdx = i; }
      }
      const c = xs[cIdx];
      const xRange = arrMax(xs) - arrMin(xs);
      return [A, c, xRange / 4, o];
    },
  },

  'Top Hat': {
    paramNames: ['amplitude', 'left', 'right', 'sigma', 'offset'],
    paramLabels: ['Amplitude', 'Left edge', 'Right edge', 'Edge width (sigma)', 'Offset'],
    fn: (x, [A, a, b, s, o]) =>
      (A / 2) * (erf((x - a) / (s * SQRT2)) - erf((x - b) / (s * SQRT2))) + o,
    estimate: (xs, ys) => {
      const o = arrMin(ys);
      const A = arrMax(ys) - o;
      const xMin = arrMin(xs);
      const xMax = arrMax(xs);
      const xRange = xMax - xMin;
      const a = xMin + xRange / 4;
      const b = xMin + 3 * xRange / 4;
      return [A, a, b, xRange / 20, o];
    },
  },
};

export const MODEL_NAMES = Object.keys(MODELS);

// ─── Main fit function ───────────────────────────────────────────────────────

export function fitData(modelName: string, xs: number[], ys: number[]): FitResult | null {
  const model = MODELS[modelName];
  if (!model) return null;

  // Filter out NaN / Inf
  const valid = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => isFinite(x) && isFinite(y));
  if (valid.length < model.paramNames.length + 1) return null;
  const xv = valid.map(([x]) => x);
  const yv = valid.map(([, y]) => y);

  const p0 = model.estimate(xv, yv);
  const pFit = lmFit(model.fn, xv, yv, p0);

  // Generate dense fit curve
  const xMin = arrMin(xv);
  const xMax = arrMax(xv);
  const nPts = 300;
  const xFit = Array.from({ length: nPts }, (_, i) => xMin + (i / (nPts - 1)) * (xMax - xMin));
  const yFit = xFit.map(x => model.fn(x, pFit));

  const yFitAtData = xv.map(x => model.fn(x, pFit));
  const rSquared = computeRSquared(yv, yFitAtData);

  const params: FitParam[] = model.paramNames.map((name, i) => ({
    name,
    label: model.paramLabels[i],
    value: pFit[i],
  }));

  return { model: modelName, params, rSquared, xFit, yFit };
}
