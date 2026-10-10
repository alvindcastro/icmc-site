import type {BaseUnit} from './types';
export function scaledQuantity(value: string): bigint {
  const negative = value.startsWith('-'), [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  return (negative ? -1n : 1n) * (BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0')));
}
export function validQuantity(value: unknown, unit: string, signed = false): value is string {
  if (typeof value !== 'string' || !(signed ? /^-?(?:0|[1-9]\d*)(?:\.\d{1,3})?$/ : /^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/).test(value)) return false;
  const scaled = scaledQuantity(value), absolute = scaled < 0n ? -scaled : scaled;
  return !(value.startsWith('-') && scaled === 0n) && absolute <= BigInt(Number.MAX_SAFE_INTEGER) * 1000n && (unit !== 'piece' || scaled % 1000n === 0n);
}
const nineDecimals = (value: string): bigint => {const [whole, fraction] = value.split('.'); return BigInt(whole) * 1000000000n + BigInt(fraction);};
function exactMoney(scaled: bigint, currency: string): string {
  const decimal = (scaled % 1000000000n).toString().padStart(9, '0').replace(/0+$/, '').padEnd(2, '0');
  return new Intl.NumberFormat('en-US', {style: 'currency', currency, minimumFractionDigits: decimal.length, maximumFractionDigits: decimal.length})
    .formatToParts(scaled / 1000000000n).map(part => part.type === 'fraction' ? decimal : part.value).join('');
}
export function comparableCost(value: string | null, unit: BaseUnit, currency: string): string {
  if (value === null) return 'Unknown';
  return `${exactMoney(nineDecimals(value) * (unit === 'piece' ? 1n : 1000n), currency)} / ${unit === 'g' ? 'kg' : unit === 'ml' ? 'l' : 'piece'}`;
}
// A nine-decimal major-currency amount shown exactly, without rounding it to minor units.
export function preciseAmount(value: string, currency: string): string {return exactMoney(nineDecimals(value), currency);}
