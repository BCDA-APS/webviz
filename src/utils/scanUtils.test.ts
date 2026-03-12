import { describe, it, expect } from 'vitest';
import { buildZMatrix, matrixRange } from './scanUtils';

describe('buildZMatrix', () => {
  const slowMotor = 'm1';
  const fastMotor = 'm2';

  it('returns null when required columns are missing', () => {
    expect(buildZMatrix({}, 'z', slowMotor, fastMotor)).toBeNull();
    expect(buildZMatrix({ z: [1], m1: [0] }, 'z', slowMotor, fastMotor)).toBeNull();
  });

  it('builds a correct 2×3 matrix from a complete 6-point grid', () => {
    const data = {
      m1: [0, 0, 0, 1, 1, 1],
      m2: [10, 20, 30, 10, 20, 30],
      z:  [1,  2,  3,  4,  5,  6],
    };
    const result = buildZMatrix(data, 'z', 'm1', 'm2');
    expect(result).not.toBeNull();
    expect(result!.zMatrix).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(result!.slowAxis).toEqual([0, 1]);
    expect(result!.fastAxis).toEqual([10, 20, 30]);
  });

  it('fills missing points with NaN', () => {
    // 2×2 grid with one point missing
    const data = {
      m1: [0, 0, 1],
      m2: [0, 1, 0],
      z:  [1, 2, 3],
    };
    const result = buildZMatrix(data, 'z', 'm1', 'm2');
    expect(result).not.toBeNull();
    expect(result!.zMatrix[1][1]).toBeNaN();
    expect(result!.zMatrix[0][0]).toBe(1);
  });

  it('handles floating-point motor positions without spurious duplicates', () => {
    const eps = 1e-10; // sub-micron noise — should still be treated as the same position
    const data = {
      m1: [0, 0, 1, 1],
      m2: [0.5, 1.5 + eps, 0.5, 1.5],
      z:  [10, 20, 30, 40],
    };
    const result = buildZMatrix(data, 'z', 'm1', 'm2');
    expect(result).not.toBeNull();
    expect(result!.zMatrix.length).toBe(2);
    expect(result!.zMatrix[0].length).toBe(2);
  });

  it('sorts slow and fast axes ascending', () => {
    const data = {
      m1: [2, 2, 1, 1],
      m2: [5, 3, 5, 3],
      z:  [4, 3, 2, 1],
    };
    const result = buildZMatrix(data, 'z', 'm1', 'm2');
    expect(result!.slowAxis).toEqual([1, 2]);
    expect(result!.fastAxis).toEqual([3, 5]);
    // row 0 = m1=1: z at m2=3 → 1, z at m2=5 → 2
    expect(result!.zMatrix[0]).toEqual([1, 2]);
    // row 1 = m1=2: z at m2=3 → 3, z at m2=5 → 4
    expect(result!.zMatrix[1]).toEqual([3, 4]);
  });
});

describe('matrixRange', () => {
  it('returns min and max of finite values', () => {
    const mat = [[1, 2], [3, 4]];
    expect(matrixRange(mat)).toEqual({ min: 1, max: 4 });
  });

  it('ignores NaN and Infinity', () => {
    const mat = [[NaN, 2], [Infinity, -5]];
    expect(matrixRange(mat)).toEqual({ min: -5, max: 2 });
  });

  it('returns Infinity/-Infinity for an all-NaN matrix', () => {
    const mat = [[NaN, NaN]];
    const { min, max } = matrixRange(mat);
    expect(min).toBe(Infinity);
    expect(max).toBe(-Infinity);
  });
});
