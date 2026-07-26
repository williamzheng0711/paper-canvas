export const minimumFontSize = 13;
export const maximumFontSize = 30;

export function normalizeFontSize(value: string, fallback: number): number {
  if (!value.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimumFontSize, Math.min(maximumFontSize, Math.round(parsed)));
}
