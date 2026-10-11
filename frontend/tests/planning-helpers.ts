import type {MenuVariant} from '../src/api/types';
import type {Order} from '../src/orders/types';
import type {CorrectionDraft, PreparationDraft} from '../src/preparation/types';
import {recipeSeed} from './recipe-helpers';

// Medium Beef Caldereta needs 750 g of Flour per tray; 2000 g of Flour is in stock from the seeded purchase.
export async function planningSeed(options: {preparation?: boolean} = {}) {
  const seed = await recipeSeed({recipe: true, ...options}), {api} = seed;
  const order = async (date: string, items: [MenuVariant, number][], status: 'pending' | 'confirmed' = 'confirmed') => {
    const draft = {customer: {name: 'Sample Customer', phone: '555-0100', notes: ''},
      fulfillment: {method: 'pickup', local_date: date, local_time: '12:00', timezone: 'America/Los_Angeles', utc_offset: null, address: null},
      items: items.map(([variant, quantity], index) => ({client_line_id: `line-${index}`, variant_id: variant.id, quantity, preparation_notes: ''})), notes: '', delivery_charge_minor: 0, tax_minor: 0};
    const quote = await api.request<{id: string}>('/orders/quote', {method: 'POST', body: {draft}});
    return api.request<Order>('/orders', {method: 'POST', operationId: crypto.randomUUID(), body: {quote_id: quote.id, draft, initial_status: status, acknowledge_credit: false}});
  };
  const advance = async (target: Order, ...steps: ('preparing' | 'ready' | 'completed')[]) => {
    let current = target;
    for (const to_status of steps) current = await api.request<Order>(`/orders/${current.id}/transitions`, {method: 'POST', operationId: crypto.randomUUID(), body: {expected_version: current.version, to_status}});
    return current;
  };
  const cancel = (target: Order) => api.request<Order>(`/orders/${target.id}/cancel`, {method: 'POST', operationId: crypto.randomUUID(), body: {expected_version: target.version, reason: 'Customer cancelled', acknowledge_consumed_stock: false}});
  const small = seed.food.variants.find(item => item.label === 'Small')!;
  const planning = (from: string, to = from) => api.request<any>(`/planning?date_from=${from}&date_to=${to}`);
  const shopping = (from: string, to = from) => api.request<any>(`/planning/shopping-list?date_from=${from}&date_to=${to}`);
  // One allocation line and optional actual Flour usage, with the versions the draft was read at.
  const draft = (target: Order, quantity: number, flourKg: string | null, changes: Record<string, unknown> = {}): PreparationDraft => ({prepared_on: '2026-10-10', note: '',
    allocations: [{order_id: target.id, expected_version: target.version, order_item_id: target.items[0].id, quantity}],
    consumption: flourKg === null ? [] : [{ingredient_id: seed.flour.id, expected_version: 2, quantity: flourKg, unit: 'kg'}], ...changes} as PreparationDraft);
  const preview = (body: unknown) => api.request<any>('/preparations/preview', {method: 'POST', body: {draft: body}});
  const prepare = async (body: unknown, key: string = crypto.randomUUID()) => api.request<any>('/preparations', {method: 'POST', operationId: key, body: {preview_id: (await preview(body)).id, draft: body}});
  // A correction of one prepared count and, optionally, the Flour deduction it belongs to.
  const amend = (record: any, target: Order, delta: number, flourGrams: string | null, changes: Record<string, unknown> = {}): CorrectionDraft => ({reason: 'Only one tray was cooked',
    allocations: delta === 0 ? [] : [{order_id: target.id, expected_version: target.version, order_item_id: target.items[0].id, delta_quantity: delta}],
    stock_corrections: flourGrams === null ? [] : [{ingredient_id: seed.flour.id, expected_version: 3, delta_base_quantity: flourGrams, corrects_movement_id: record.consumption[0].stock_movement_id}], ...changes} as CorrectionDraft);
  const correctionPreview = (record: any, body: unknown) => api.request<any>(`/preparations/${record.id}/correction-preview`, {method: 'POST', body});
  const correct = async (record: any, body: unknown, key: string = crypto.randomUUID()) => api.request<any>(`/preparations/${record.id}/corrections`, {method: 'POST', operationId: key, body: {...(body as object), preview_id: (await correctionPreview(record, body)).id}});
  return {...seed, medium: seed.variant, small, order, advance, cancel, planning, shopping, draft, preview, prepare, amend, correctionPreview, correct};
}
