import { getDateRange } from '../../src/core/date-ranges.js';

// Use a fixed local time for testing
const NOW = new Date(2026, 2, 22, 14, 30, 0); // Mar 22, 2026 14:30:00 local

describe('getDateRange', () => {
  it('today: local midnight to now', () => {
    const { start, end } = getDateRange('today', NOW);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getDate()).toBe(22);
    expect(end.getTime()).toBe(NOW.getTime());
  });

  it('yesterday: full previous local day', () => {
    const { start, end } = getDateRange('yesterday', NOW);
    expect(start.getDate()).toBe(21);
    expect(start.getHours()).toBe(0);
    expect(end.getDate()).toBe(21);
    expect(end.getHours()).toBe(23);
  });

  it('this-week: Monday to now', () => {
    const { start } = getDateRange('this-week', NOW);
    // Mar 22, 2026 is a Sunday, so Monday would be Mar 16
    expect(start.getDay()).toBe(1); // Monday
  });

  it('this-month: 1st to now', () => {
    const { start } = getDateRange('this-month', NOW);
    expect(start.getDate()).toBe(1);
    expect(start.getMonth()).toBe(2); // March
  });

  it('last-month: full previous month', () => {
    const { start, end } = getDateRange('last-month', NOW);
    expect(start.getMonth()).toBe(1); // February
    expect(start.getDate()).toBe(1);
  });

  it('this-year: Jan 1 to now', () => {
    const { start } = getDateRange('this-year', NOW);
    expect(start.getMonth()).toBe(0);
    expect(start.getDate()).toBe(1);
  });

  it('last30: 30 days ago to now', () => {
    const { start, end } = getDateRange('last30', NOW);
    const diff = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
    expect(diff).toBeCloseTo(30, 0);
  });

  it('all: very old start to now', () => {
    const { start, end } = getDateRange('all', NOW);
    expect(start.getFullYear()).toBeLessThan(2025);
    expect(end.getTime()).toBe(NOW.getTime());
  });

  it('custom range', () => {
    const { start, end } = getDateRange('range', NOW, '2026-02-01', '2026-02-28');
    expect(start.toISOString()).toContain('2026-02-01');
    expect(end.toISOString()).toContain('2026-02-28');
  });

  it('throws for range without dates', () => {
    expect(() => getDateRange('range', NOW)).toThrow();
  });

  it('returns label in result', () => {
    const result = getDateRange('today', NOW);
    expect(result.label).toBe('today');
  });
});
