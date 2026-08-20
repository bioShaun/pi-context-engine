/**
 * Pressure thresholds (spec §9, §26).
 */

export interface PressureBands {
  green: number;
  yellow: number;
  orange: number;
  red: number;
}

export const DEFAULT_BANDS: PressureBands = {
  green: 0.55,
  yellow: 0.7,
  orange: 0.82,
  red: 0.9,
};

export function bandLabel(pressure: number, bands: PressureBands = DEFAULT_BANDS): string {
  if (pressure < bands.green) return "green";
  if (pressure < bands.yellow) return "yellow";
  if (pressure < bands.orange) return "orange";
  if (pressure < bands.red) return "red";
  return "critical";
}
