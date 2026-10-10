import { describe, expect, it } from 'vitest';
import { parsePrice, priceInput, sellingLabel } from '../src/menu/model';

describe('menu money and selling identity', () => {
  it('converts exact configured-precision prices without floating-point rounding', () => {
    expect(parsePrice('80.01', 2)).toBe(8001);
    expect(parsePrice('0', 2)).toBe(0);
    expect(parsePrice('90071992547409.91', 2)).toBe(Number.MAX_SAFE_INTEGER);
    expect(parsePrice('5', 0)).toBe(5);
    expect(parsePrice('1.123', 3)).toBe(1123);
    expect(priceInput(8001, 2)).toBe('80.01');
    expect(priceInput(Number.MAX_SAFE_INTEGER, 2)).toBe('90071992547409.91');
  });
  it.each(['', '-1', '1e2', 'NaN', 'Infinity', '1.001', '90071992547409.92', '1,000', '.'])('rejects invalid price %s', value => {
    expect(parsePrice(value, 2)).toBeNull();
  });
  it('labels quantity as sellable units, not package pieces', () => {
    expect(sellingLabel('tr tray' as never, null)).toBe('Unknown unit');
    expect(sellingLabel('trAY' as never, null)).toBe('Unknown unit');
    expect(sellingLabel('tray', null)).toBe('1 tray');
    expect(sellingLabel('piece', null)).toBe('1 piece');
    expect(sellingLabel('stick', null)).toBe('1 stick');
    expect(sellingLabel('package', { quantity: 100, unit: 'piece' })).toBe('1 package / 100 pieces');
  });
});
