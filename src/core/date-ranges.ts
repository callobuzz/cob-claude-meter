export type DateRangeLabel =
  | 'today'
  | 'yesterday'
  | 'this-week'
  | 'last-week'
  | 'this-month'
  | 'last-month'
  | 'this-year'
  | 'last30'
  | 'all'
  | 'range';

export interface DateRange {
  label: string;
  start: Date;
  end: Date;
}

export function getDateRange(
  label: DateRangeLabel,
  now: Date,
  rangeStart?: string,
  rangeEnd?: string,
): DateRange {
  switch (label) {
    case 'today': {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      return { label, start, end: new Date(now.getTime()) };
    }

    case 'yesterday': {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
      const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
      const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
      return { label, start, end };
    }

    case 'this-week': {
      // Week starts on Monday (1). getUTCDay(): 0=Sun, 1=Mon, ..., 6=Sat
      const day = now.getUTCDay();
      const diff = day === 0 ? 6 : day - 1; // days since Monday
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diff));
      return { label, start, end: new Date(now.getTime()) };
    }

    case 'last-week': {
      const day = now.getUTCDay();
      const diff = day === 0 ? 6 : day - 1;
      const thisMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diff));
      const lastMonday = new Date(Date.UTC(thisMonday.getUTCFullYear(), thisMonday.getUTCMonth(), thisMonday.getUTCDate() - 7));
      const lastSunday = new Date(Date.UTC(thisMonday.getUTCFullYear(), thisMonday.getUTCMonth(), thisMonday.getUTCDate() - 1, 23, 59, 59, 999));
      return { label, start: lastMonday, end: lastSunday };
    }

    case 'this-month': {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      return { label, start, end: new Date(now.getTime()) };
    }

    case 'last-month': {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 59, 999));
      return { label, start, end };
    }

    case 'this-year': {
      const start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      return { label, start, end: new Date(now.getTime()) };
    }

    case 'last30': {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 30,
        now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds(), now.getUTCMilliseconds()));
      return { label, start, end: new Date(now.getTime()) };
    }

    case 'all': {
      const start = new Date(Date.UTC(2020, 0, 1));
      return { label, start, end: new Date(now.getTime()) };
    }

    case 'range': {
      if (!rangeStart || !rangeEnd) {
        throw new Error('Custom range requires both start and end dates');
      }
      return {
        label,
        start: new Date(rangeStart),
        end: new Date(rangeEnd),
      };
    }

    default: {
      const _exhaustive: never = label;
      throw new Error(`Unknown date range label: ${_exhaustive}`);
    }
  }
}
