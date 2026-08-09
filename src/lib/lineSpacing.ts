export const minimumLineSpacing = 1;
export const maximumLineSpacing = 3;

export function normalizeLineSpacing(value: string | number, fallback: number): number {
  if (typeof value === 'string' && !value.trim()) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isFinite(parsed)) return fallback;
  const clamped = Math.max(minimumLineSpacing, Math.min(maximumLineSpacing, parsed));
  return Math.round(clamped * 100) / 100;
}
