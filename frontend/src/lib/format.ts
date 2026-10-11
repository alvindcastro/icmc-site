type CurrencySettings = { currency: string; minor_digits: number };

export function formatMoney(amount: number, settings: CurrencySettings): string {
  if (!Number.isSafeInteger(amount) || !Number.isInteger(settings.minor_digits)
    || settings.minor_digits < 0 || settings.minor_digits > 9) {
    throw new Error('Invalid monetary amount or precision.');
  }
  const factor = 10n ** BigInt(settings.minor_digits);
  const absolute = BigInt(Math.abs(amount));
  const whole = absolute / factor;
  const signedWhole = amount < 0 ? (whole === 0n ? -0 : -whole) : whole;
  const fraction = (absolute % factor).toString().padStart(settings.minor_digits, '0');
  // Format the integer part exactly; dividing a large number would lose minor units.
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: settings.currency,
    minimumFractionDigits: settings.minor_digits, maximumFractionDigits: settings.minor_digits,
  }).formatToParts(signedWhole).map(part => part.type === 'fraction' ? fraction : part.value).join('');
}
export function formatBusinessTime(instant: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).format(new Date(instant));
}
// The calendar date in the business timezone at the given instant.
export function businessDate(timezone: string, at: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(new Date(at));
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
}
export function formatCalendarDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid business date.');
  const value = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10) !== date) {
    throw new Error('Invalid business date.');
  }
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric',
  }).format(value);
}
export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: 'Pending', confirmed: 'Confirmed', preparing: 'Preparing', ready: 'Ready',
    completed: 'Completed', cancelled: 'Cancelled', unpaid: 'Unpaid', partial: 'Partial',
    paid: 'Paid', credit_due: 'Credit due',
  };
  return labels[status] ?? status;
}
export function paymentMethodLabel(method: string): string {
  return ({cash: 'Cash', bank_transfer: 'Bank transfer', other: 'Other'} as Record<string, string>)[method] ?? method;
}
