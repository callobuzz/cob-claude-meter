import { formatTokens, formatCost, formatPercentage } from '../../src/core/formatter.js';

describe('formatTokens', () => {
  it('formats numbers under 1000 as-is', () => {
    expect(formatTokens(500)).toBe('500');
  });
  it('formats thousands as K', () => {
    expect(formatTokens(1234)).toBe('1.2K');
  });
  it('formats millions as M', () => {
    expect(formatTokens(1234567)).toBe('1.2M');
  });
  it('formats billions as B', () => {
    expect(formatTokens(1234567890)).toBe('1.2B');
  });
  it('handles zero', () => {
    expect(formatTokens(0)).toBe('0');
  });
  it('formats exact thousands cleanly', () => {
    expect(formatTokens(1000)).toBe('1.0K');
  });
  it('formats full numbers when mode is full', () => {
    expect(formatTokens(1234567, 'full')).toBe('1,234,567');
  });
});

describe('formatCost', () => {
  it('formats small costs with 2 decimals', () => {
    expect(formatCost(29.48)).toBe('$29.48');
  });
  it('formats costs over 1000 with K suffix', () => {
    expect(formatCost(1243.50)).toBe('$1.2K');
  });
  it('formats zero cost', () => {
    expect(formatCost(0)).toBe('$0.00');
  });
  it('formats costs under a dollar', () => {
    expect(formatCost(0.42)).toBe('$0.42');
  });
});

describe('formatPercentage', () => {
  it('formats whole percentages', () => {
    expect(formatPercentage(92.3)).toBe('92.3%');
  });
  it('formats zero', () => {
    expect(formatPercentage(0)).toBe('0%');
  });
});
