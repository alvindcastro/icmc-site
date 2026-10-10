import { describe, expect, it } from 'vitest';
import { formatMoney, formatBusinessTime, formatCalendarDate, statusLabel } from '../src/lib/format';

describe('central business formatting', () => {
  it('uses the configured currency precision rather than assuming cents', () => {
    expect(formatMoney(21500, { currency: 'USD', minor_digits: 2 })).toBe('$215.00');
    expect(formatMoney(215, { currency: 'JPY', minor_digits: 0 })).toBe('\u00a5215');
    expect(formatMoney(1234, { currency: 'KWD', minor_digits: 3 })).toContain('1.234');
  });

  it('preserves minor units at the maximum safe integer and negative subunit values', () => {
    expect(formatMoney(Number.MAX_SAFE_INTEGER, { currency: 'USD', minor_digits: 2 }))
      .toBe('$90,071,992,547,409.91');
    expect(formatMoney(-1, { currency: 'USD', minor_digits: 2 })).toBe('-$0.01');
  });

  it('rejects non-integer or unsafe money instead of showing rounded financial data', () => {
    expect(() => formatMoney(1.5, { currency: 'USD', minor_digits: 2 })).toThrow();
    expect(() => formatMoney(Number.MAX_SAFE_INTEGER + 1, { currency: 'USD', minor_digits: 2 })).toThrow();
  });

  it('formats an instant in business time regardless of browser time', () => {
    expect(formatBusinessTime('2026-10-08T02:30:00Z', 'America/Los_Angeles')).toContain('7:30 PM');
  });

  it('keeps a calendar date unchanged across timezones and rejects invalid dates', () => {
    expect(formatCalendarDate('2026-10-07')).toBe('Oct 7, 2026');
    expect(() => formatCalendarDate('2026-02-30')).toThrow();
  });

  it('labels preparation and payment status independently', () => {
    expect(statusLabel('preparing')).toBe('Preparing');
    expect(statusLabel('credit_due')).toBe('Credit due');
  });
});
