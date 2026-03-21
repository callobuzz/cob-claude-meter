export type NumberFormat = 'short' | 'full';

export function formatTokens(n: number, mode: NumberFormat = 'short'): string {
  if (mode === 'full') {
    return n.toLocaleString('en-US');
  }
  if (n === 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

export function formatCost(n: number): string {
  if (n >= 1000) {
    return `$${(n / 1000).toFixed(1)}K`;
  }
  return `$${n.toFixed(2)}`;
}

export function formatPercentage(n: number): string {
  if (n === 0) return '0%';
  return `${n.toFixed(1)}%`;
}
