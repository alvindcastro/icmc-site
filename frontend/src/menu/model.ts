export function parsePrice(value: string, digits: number): number | null {
  if (!Number.isInteger(digits) || digits < 0 || digits > 9) return null;
  const parts = value.trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!parts || (parts[2]?.length ?? 0) > digits) return null;
  const amount = BigInt(parts[1]) * 10n ** BigInt(digits) + BigInt((parts[2] ?? '').padEnd(digits, '0') || '0');
  return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : null;
}
export function priceInput(amount: number, digits: number): string {
  const factor = 10n ** BigInt(digits);
  return `${BigInt(amount) / factor}${digits ? `.${(BigInt(amount) % factor).toString().padStart(digits, '0')}` : ''}`;
}
export function sellingLabel(unit: string, contents: {quantity: number; unit: string} | null): string {
  if (unit === 'package') return contents ? `1 package / ${contents.quantity} ${contents.quantity === 1 ? 'piece' : 'pieces'}` : 'Package contents missing';
  return ['tray', 'piece', 'stick'].includes(unit) ? `1 ${unit}` : 'Unknown unit';
}
