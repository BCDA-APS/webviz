export interface FieldInfo {
  name: string;
  shape: number[];
  dtype: string;
}

/** A field is a 2D image if it has ≥2 shape dimensions with the last two both > 1. */
export function isImageField(f: FieldInfo): boolean {
  return f.shape.length >= 2 && f.shape[f.shape.length - 1] > 1 && f.shape[f.shape.length - 2] > 1;
}

/**
 * Returns true if fieldName matches a device name exactly or as a prefix.
 * e.g. "tetramm1" matches "tetramm1_current1".
 */
export function matchesDev(fieldName: string, devNames: string[]): boolean {
  return devNames.some(d => fieldName === d || fieldName.startsWith(d + '_'));
}

/**
 * Sort key for a field name within a device list — the index of the first matching device,
 * or Infinity if it doesn't match any.
 */
export function devSortKey(fieldName: string, devNames: string[]): number {
  const idx = devNames.findIndex(d => fieldName === d || fieldName.startsWith(d + '_'));
  return idx === -1 ? Infinity : idx;
}

/**
 * Sort fields into display order: time → motors → other → detectors.
 * Within motors and detectors, order follows the device list order.
 */
export function sortFields(
  fields: FieldInfo[],
  motors: string[],
  detectors: string[],
): FieldInfo[] {
  const timeFields = fields.filter(f => f.name === 'time');
  const motorFields = fields
    .filter(f => f.name !== 'time' && matchesDev(f.name, motors))
    .sort((a, b) => devSortKey(a.name, motors) - devSortKey(b.name, motors));
  const detectorFields = fields
    .filter(f => matchesDev(f.name, detectors))
    .sort((a, b) => devSortKey(a.name, detectors) - devSortKey(b.name, detectors));
  const otherFields = fields.filter(
    f => f.name !== 'time' && !matchesDev(f.name, motors) && !matchesDev(f.name, detectors),
  );
  return [...timeFields, ...motorFields, ...otherFields, ...detectorFields];
}
