import { describe, it, expect } from 'vitest';
import { isImageField, matchesDev, devSortKey, sortFields, type FieldInfo } from './fieldUtils';

const f = (name: string, shape: number[], dtype = 'float64'): FieldInfo => ({ name, shape, dtype });

describe('isImageField', () => {
  it('returns true for a 2D field with both dims > 1', () => {
    expect(isImageField(f('img', [512, 512]))).toBe(true);
  });

  it('returns true for a 3D field (nFrames × H × W)', () => {
    expect(isImageField(f('img', [10, 128, 128]))).toBe(true);
  });

  it('returns false for a 1D field', () => {
    expect(isImageField(f('x', [100]))).toBe(false);
  });

  it('returns false when last dim is 1', () => {
    expect(isImageField(f('col', [512, 1]))).toBe(false);
  });

  it('returns false when second-to-last dim is 1', () => {
    expect(isImageField(f('row', [1, 512]))).toBe(false);
  });

  it('returns false for scalar (no shape)', () => {
    expect(isImageField(f('s', []))).toBe(false);
  });
});

describe('matchesDev', () => {
  it('matches exact device name', () => {
    expect(matchesDev('det1', ['det1', 'det2'])).toBe(true);
  });

  it('matches field with device prefix', () => {
    expect(matchesDev('det1_current', ['det1'])).toBe(true);
  });

  it('does not match partial prefix without underscore', () => {
    expect(matchesDev('det10_x', ['det1'])).toBe(false);
  });

  it('returns false when no device matches', () => {
    expect(matchesDev('motor1', ['det1', 'det2'])).toBe(false);
  });
});

describe('devSortKey', () => {
  it('returns the index of the matching device', () => {
    expect(devSortKey('det2_ch1', ['det1', 'det2', 'det3'])).toBe(1);
  });

  it('returns Infinity for unmatched fields', () => {
    expect(devSortKey('unknown', ['det1'])).toBe(Infinity);
  });
});

describe('sortFields', () => {
  const time = f('time', [100]);
  const motor1 = f('m1', [100]);
  const motor2 = f('m2', [100]);
  const det1 = f('d1_counts', [100]);
  const det2 = f('d2_counts', [100]);
  const other = f('other', [100]);

  it('places time first, then motors, then other, then detectors', () => {
    const fields = [det2, other, motor1, time, det1, motor2];
    const sorted = sortFields(fields, ['m1', 'm2'], ['d1', 'd2']);
    expect(sorted.map(fi => fi.name)).toEqual(['time', 'm1', 'm2', 'other', 'd1_counts', 'd2_counts']);
  });

  it('preserves device-list order for motors', () => {
    const fields = [motor2, motor1];
    const sorted = sortFields(fields, ['m1', 'm2'], []);
    expect(sorted.map(fi => fi.name)).toEqual(['m1', 'm2']);
  });

  it('preserves device-list order for detectors', () => {
    const fields = [det2, det1];
    const sorted = sortFields(fields, [], ['d1', 'd2']);
    expect(sorted.map(fi => fi.name)).toEqual(['d1_counts', 'd2_counts']);
  });

  it('handles empty field list', () => {
    expect(sortFields([], ['m1'], ['d1'])).toEqual([]);
  });
});
