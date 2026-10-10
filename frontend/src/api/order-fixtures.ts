import { Temporal } from '@js-temporal/polyfill';
import { ApiError } from './client';
import type { BusinessSettings, Food, FieldError } from './types';
import type { Order, OrderDraft, OrderLine, Quote, QuoteLine, OrderSummary, OrderAction, Fulfillment, LedgerEntry } from '../orders/types';
import { canonicalFixture, type FixtureOperations } from './fixture-protocol';

const clone = <T,>(value: T): T => structuredClone(value);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
const envelope = (error: ApiError) => ({error: {code: error.code, message: error.message, field_errors: error.fieldErrors, details: error.details, request_id: 'order-development-fixture'}});
const statuses = ['pending', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled'];
const actions: OrderAction[] = ['edit', 'confirm', 'start_preparing', 'mark_ready', 'complete', 'cancel', 'record_payment', 'refund', 'record_preparation'];
const amount = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const required = (value: unknown) => typeof value === 'string' && Boolean(value.trim());
const dateValid = (value: string | null) => {if (value === null) return true; try {return /^\d{4}-\d{2}-\d{2}$/.test(value) && Temporal.PlainDate.from(value).toString() === value;} catch {return false;}};
function knownFields(value: unknown, allowed: string[], path = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(422, 'validation_failed', 'Send a valid object.');
  const fields = Object.keys(value).filter(key => !allowed.includes(key)).map(key => ({path: `${path}/${key}`, code: 'unknown_field', message: 'Unknown field.'}));
  if (fields.length) throw new ApiError(422, 'validation_failed', 'Unexpected fields were supplied.', fields);
}
const safeAmount = (value: bigint, path: string) => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ApiError(422, 'validation_failed', 'The order amount is too large.', [{path, code: 'overflow', message: 'Reduce the quantity or amount.'}]);
  return Number(value);
};
function permitted(status: string, order?: Order, payments = false): Order['permitted_actions'] {
  const prepared = !order || order.preparation_tracking === 'manual' || order.items.every(item => item.remaining_quantity === 0);
  const reasons: Partial<Record<OrderAction, string>> = {edit: 'Only pending or confirmed orders can be edited.', cancel: 'Completed or cancelled orders cannot be cancelled.',
    mark_ready: prepared ? 'Mark ready after preparation starts.' : 'Record all remaining preparation before marking ready.',
    complete: prepared ? 'Complete a ready order.' : 'Record all remaining preparation before completion.',
    record_payment: !payments ? 'Payments are not enabled.' : status === 'cancelled' ? 'Cancelled orders cannot accept payments.' : 'No balance is due.',
    refund: !payments ? 'Payments are not enabled.' : 'No refundable funds remain.'};
  return Object.fromEntries(actions.map(action => {
    const allowed = action === 'edit' && ['pending', 'confirmed'].includes(status) || action === 'confirm' && status === 'pending'
      || action === 'start_preparing' && status === 'confirmed' || action === 'mark_ready' && status === 'preparing' && prepared || action === 'complete' && status === 'ready' && prepared
      || action === 'cancel' && ['pending', 'confirmed', 'preparing', 'ready'].includes(status)
      || action === 'record_payment' && payments && status !== 'cancelled' && (order?.balance_due_minor ?? 0) > 0
      || action === 'refund' && payments && (order?.net_paid_minor ?? 0) > 0;
    return [action, {allowed, reason_code: allowed ? null : 'not_available', reason: allowed ? null : reasons[action] ?? 'This action is not available for this order.'}];
  })) as Order['permitted_actions'];
}
function summary(order: Order): OrderSummary {
  return {id: order.id, reference: order.reference, version: order.version, customer_name: order.customer.name, customer_phone: order.customer.phone,
    fulfillment_at: order.fulfillment.fulfillment_at, fulfillment_local_date: order.fulfillment.local_date, fulfillment_local_time: order.fulfillment.local_time,
    fulfillment_timezone: order.fulfillment.timezone, fulfillment_method: order.fulfillment.method, status: order.status, payment_status: order.payment_status,
    currency: order.currency, minor_digits: order.minor_digits, total_minor: order.total_minor, balance_due_minor: order.balance_due_minor, customer_credit_minor: order.customer_credit_minor};
}
function resolveFulfillment(input: OrderDraft['fulfillment'], settings: BusinessSettings): Fulfillment {
  const fields: FieldError[] = [];
  const invalid = (path: string, message: string) => fields.push({path: `/draft/fulfillment/${path}`, code: 'invalid', message});
  if (!input || !settings.fulfillment_methods.includes(input.method)) invalid('method', 'Choose an enabled fulfillment method.');
  if (input?.timezone !== settings.timezone) invalid('timezone', 'Use the business timezone.');
  if (input?.method === 'delivery' && !required(input.address)) invalid('address', 'Enter a delivery address.');
  if (input?.method === 'pickup' && input.address !== null) invalid('address', 'Pickup has no delivery address.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input?.local_date ?? '')) invalid('local_date', 'Enter a valid fulfillment date.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input?.local_time ?? '')) invalid('local_time', 'Enter a valid fulfillment time.');
  if (fields.length) throw new ApiError(422, 'validation_failed', 'Check fulfillment details.', fields);
  let local: Temporal.PlainDateTime;
  try {local = Temporal.PlainDateTime.from(`${input.local_date}T${input.local_time}`, {overflow: 'reject'});}
  catch {throw new ApiError(422, 'validation_failed', 'Check the date.', [{path: '/draft/fulfillment/local_date', code: 'invalid', message: 'Enter a valid calendar date.'}]);}
  const earlier = local.toZonedDateTime(settings.timezone, {disambiguation: 'earlier'});
  const later = local.toZonedDateTime(settings.timezone, {disambiguation: 'later'});
  const choices = [earlier, later].filter(value => value.toPlainDateTime().equals(local));
  if (!choices.length) throw new ApiError(422, 'validation_failed', 'This local time does not exist.', [{path: '/draft/fulfillment/local_time', code: 'nonexistent_time', message: 'Choose a time outside the daylight-saving gap.'}]);
  if (earlier.epochNanoseconds !== later.epochNanoseconds && !input.utc_offset) {
    throw new ApiError(422, 'validation_failed', 'Choose which occurrence of this time to use.', [{path: '/draft/fulfillment/utc_offset', code: 'ambiguous_time', message: 'Choose a UTC offset.'}], false, {utc_offsets: [...new Set(choices.map(value => value.offset))]});
  }
  const resolved = input.utc_offset ? choices.find(value => value.offset === input.utc_offset) : earlier;
  if (!resolved) throw new ApiError(422, 'validation_failed', 'The offset does not match this time.', [{path: '/draft/fulfillment/utc_offset', code: 'invalid', message: 'Choose a valid UTC offset.'}]);
  return {...input, utc_offset: resolved.offset, fulfillment_at: resolved.toInstant().toString(), pickup_location: input.method === 'pickup' ? settings.pickup_location : null};
}

export function createOrderFixtures({menu, settings, usedVariants, operations}: {
  menu: (url: URL, init?: RequestInit) => Promise<Response | null>; settings: BusinessSettings; usedVariants: Set<string>; operations: FixtureOperations;
}) {
  const orders: Order[] = [];
  const quotes = new Map<string, {quote: Quote; fingerprint: string; dependencies: string}>();
  const conflict = (order: Order, version: unknown) => {
    if (!Number.isSafeInteger(version) || Number(version) < 1) throw new ApiError(422, 'validation_failed', 'A record version is required.', [{path: '/expected_version', code: 'required', message: 'Reload the order version.'}]);
    if (version !== order.version) throw new ApiError(409, 'version_conflict', 'Another staff member changed this order.', [], false,
      {resource_type: 'order', resource_id: order.id, expected_version: version, current_version: order.version, latest_resource: clone(order)});
  };
  async function menuFoods(): Promise<Food[]> {
    const foods: Food[] = [];
    for (let page = 1; ; page++) {
      const response = await menu(new URL(`http://fixture.local/api/v1/foods?limit=100&page=${page}`));
      const result = await response!.json(); foods.push(...result.items);
      if (!result.has_next) return foods;
    }
  }
  async function calculate(draft: OrderDraft, order?: Order): Promise<{quote: Quote; dependencies: string}> {
    knownFields(draft, ['customer', 'fulfillment', 'items', 'notes', 'delivery_charge_minor', 'tax_minor'], '/draft');
    knownFields(draft.customer, ['name', 'phone', 'notes'], '/draft/customer');
    knownFields(draft.fulfillment, ['method', 'local_date', 'local_time', 'timezone', 'utc_offset', 'address'], '/draft/fulfillment');
    if (settings.environment === 'live' && Object.entries(settings.confirmation).some(([key, value]) => key !== 'confirmed_at' && value !== true)) throw new ApiError(409, 'settings_unconfirmed', 'Business settings require confirmation.');
    const fields: FieldError[] = [];
    const invalid = (path: string, message: string) => fields.push({path: `/draft/${path}`, code: 'invalid', message});
    if (!draft || !required(draft.customer?.name)) invalid('customer/name', 'Enter the customer name.');
    if (!required(draft?.customer?.phone)) invalid('customer/phone', 'Enter a contact phone.');
    if (typeof draft.customer.name === 'string' && draft.customer.name.trim().length > 200) invalid('customer/name', 'Use at most 200 characters.');
    if (typeof draft.customer.phone === 'string' && draft.customer.phone.trim().length > 50) invalid('customer/phone', 'Use at most 50 characters.');
    const note = (value: unknown, path: string, limit: number) => {if (value !== undefined && (typeof value !== 'string' || value.length > limit)) invalid(path, `Use text of at most ${limit} characters.`);};
    note(draft.customer.notes, 'customer/notes', 2000); note(draft.notes, 'notes', 2000);
    if (typeof draft.fulfillment.address === 'string' && draft.fulfillment.address.length > 1000) invalid('fulfillment/address', 'Use at most 1000 characters.');
    if (!Array.isArray(draft?.items) || !draft.items.length) invalid('items', 'Add at least one item.');
    if (!amount(draft?.delivery_charge_minor)) invalid('delivery_charge_minor', 'Enter a nonnegative delivery charge.');
    if (!amount(draft?.tax_minor)) invalid('tax_minor', 'Enter a nonnegative tax amount.');
    if (draft?.fulfillment?.method === 'pickup' && draft.delivery_charge_minor !== 0) invalid('delivery_charge_minor', 'Pickup delivery charge must be zero.');
    if (draft?.fulfillment?.method === 'delivery' && settings.delivery_policy.mode === 'disabled') invalid('fulfillment/method', 'Delivery is not enabled.');
    if (fields.length) throw new ApiError(422, 'validation_failed', 'Check the highlighted fields.', fields);
    const fulfillment = resolveFulfillment(draft.fulfillment, settings);
    const foods = await menuFoods();
    const lines: QuoteLine[] = [];
    const dependencies: unknown[] = [];
    const clientIds = new Set<string>(); const savedIds = new Set<string>();
    for (const [index, item] of draft.items.entries()) {
      knownFields(item, ['client_line_id', 'order_item_id', 'variant_id', 'quantity', 'preparation_notes'], `/draft/items/${index}`);
      const field = (name: string, message: string) => invalid(`items/${index}/${name}`, message);
      note(item.preparation_notes, `items/${index}/preparation_notes`, 1000);
      if (!required(item.client_line_id) || clientIds.has(item.client_line_id)) field('client_line_id', 'Item row identifiers must be unique.');
      clientIds.add(item.client_line_id);
      if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) {field('quantity', 'Enter a positive whole selling quantity.'); continue;}
      const food = foods.find(value => value.variants.some(variant => variant.id === item.variant_id));
      const variant = food?.variants.find(value => value.id === item.variant_id);
      const saved = item.order_item_id ? order?.items.find(value => value.id === item.order_item_id) : undefined;
      if (item.order_item_id && (!saved || saved.variant_id !== item.variant_id || savedIds.has(item.order_item_id))) {field('variant_id', 'Saved item identity cannot be replaced; remove it and add a new line.'); continue;}
      if (item.order_item_id) savedIds.add(item.order_item_id);
      if (!food || !variant || ((!food.available || !variant.available) && (!saved || item.quantity > saved.quantity))) {field('variant_id', 'This variant is unavailable for new or increased quantities.'); continue;}
      if ((!saved || item.quantity > saved.quantity) && settings.environment === 'live' && (food.confirmation_status !== 'confirmed' || variant.confirmation_status !== 'confirmed')) throw new ApiError(409, 'menu_unconfirmed', 'This menu item requires confirmation.');
      const snapshot = saved ?? {variant_id: variant.id, food_name: food.name, variant_label: variant.label, selling_unit: variant.selling_unit,
        package_contents: clone(variant.package_contents), unit_price_minor: variant.price_minor, prepared_quantity: null, remaining_quantity: null};
      if (!saved || item.quantity > saved.quantity) dependencies.push({food_id: food.id, food_version: food.version, variant_id: variant.id, variant_version: variant.version});
      lines.push({...snapshot, client_line_id: item.client_line_id, order_item_id: saved?.id ?? null, quantity: item.quantity,
        preparation_notes: item.preparation_notes ?? '', line_total_minor: safeAmount(BigInt(snapshot.unit_price_minor) * BigInt(item.quantity), `/draft/items/${index}/quantity`)});
    }
    if (fields.length) throw new ApiError(422, 'validation_failed', 'Check the highlighted fields.', fields);
    const subtotal = safeAmount(lines.reduce((total, item) => total + BigInt(item.line_total_minor), 0n), '/draft/items');
    const charge = fulfillment.method === 'pickup' ? 0 : settings.delivery_policy.mode === 'fixed_amount' ? settings.delivery_policy.fixed_charge_minor! : draft.delivery_charge_minor;
    if (!amount(charge)) throw new ApiError(409, 'settings_unconfirmed', 'Delivery charge is not configured.');
    const total = safeAmount(BigInt(subtotal) + BigInt(charge) + BigInt(draft.tax_minor), '/draft/tax_minor');
    const paid = order?.net_paid_minor ?? 0;
    return {dependencies: canonicalFixture({menu: dependencies, settings_version: settings.version}), quote: {
      id: `fixture_quote_${crypto.randomUUID()}`, expires_at: new Date(Date.now() + 300000).toISOString(), order_id: order?.id ?? null, expected_version: order?.version ?? null,
      settings_version: settings.version, currency: settings.currency, minor_digits: settings.minor_digits, fulfillment, lines, subtotal_minor: subtotal,
      delivery_charge_minor: charge, tax_minor: draft.tax_minor, total_minor: total, settlement_total_minor: total, net_paid_minor: paid,
      balance_due_minor: Math.max(total - paid, 0), customer_credit_minor: Math.max(paid - total, 0), credit_acknowledgment_required: paid > total,
    }};
  }
  function history(from_status: Order['status'] | null, to_status: Order['status'], reason: string | null = null) {
    return {id: crypto.randomUUID(), from_status, to_status, reason, changed_at: new Date().toISOString(), actor: {id: 'fixture_admin', display_name: 'Admin'}};
  }
  function settle(order: Order) {
    order.payments_minor = safeAmount(order.ledger.filter(entry => entry.type === 'payment').reduce((sum, entry) => sum + BigInt(entry.amount_minor), 0n), '/amount_minor');
    order.refunds_minor = safeAmount(order.ledger.filter(entry => entry.type === 'refund').reduce((sum, entry) => sum + BigInt(entry.amount_minor), 0n), '/amount_minor');
    order.net_paid_minor = order.payments_minor - order.refunds_minor;
    order.settlement_total_minor = order.status === 'cancelled' ? 0 : order.total_minor;
    order.balance_due_minor = Math.max(0, order.settlement_total_minor - order.net_paid_minor); order.customer_credit_minor = Math.max(0, order.net_paid_minor - order.settlement_total_minor);
    order.payment_status = order.customer_credit_minor > 0 ? 'credit_due' : order.balance_due_minor > 0 ? order.net_paid_minor > 0 ? 'partial' : 'unpaid' : 'paid';
    for (const entry of order.ledger) if (entry.type === 'payment') entry.refundable_minor = entry.amount_minor - order.ledger.filter(refund => refund.payment_id === entry.id).reduce((sum, refund) => sum + refund.amount_minor, 0);
    order.permitted_actions = permitted(order.status, order, settings.capabilities.payments);
  }
  return async (url: URL, init?: RequestInit): Promise<Response | null> => {
    const path = url.pathname.replace('/api/v1', ''); const method = init?.method ?? 'GET';
    if (!/^\/(orders|dashboard)(\/|$)/.test(path)) return null;
    try {
      if (method === 'GET') {
        if (path.startsWith('/orders/')) {
          const order = orders.find(value => value.id === decodeURIComponent(path.slice(8)));
          if (!order) throw new ApiError(404, 'not_found', 'Order not found.');
          return json(order);
        }
        const page = Number(url.searchParams.get('page') ?? 1), limit = Number(url.searchParams.get('limit') ?? 25);
        const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
        const from = url.searchParams.get('date_from'), to = url.searchParams.get('date_to');
        const selected = url.searchParams.get('status')?.split(',') ?? [];
        const sort = url.searchParams.get('sort') ?? 'fulfillment_asc';
        if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || q.length > 200 || !dateValid(from) || !dateValid(to)
          || (from && to && from > to) || selected.some(value => !statuses.includes(value)) || !['fulfillment_asc', 'fulfillment_desc'].includes(sort)
          || [...url.searchParams.keys()].some(key => !(path === '/dashboard' ? ['date'] : ['page', 'limit', 'q', 'date_from', 'date_to', 'status', 'sort']).includes(key))) throw new ApiError(422, 'validation_failed', 'Check the order filters.');
        const sorted = orders.slice().sort((a, b) => (a.fulfillment.fulfillment_at.localeCompare(b.fulfillment.fulfillment_at) || a.id.localeCompare(b.id)) * (sort === 'fulfillment_desc' ? -1 : 1));
        const collection = (values: Order[], p = page, size = limit) => ({items: values.slice((p - 1) * size, p * size).map(summary), page: p, limit: size, total: values.length, has_next: p * size < values.length});
        if (path === '/dashboard') {
          const date = url.searchParams.get('date') ?? Temporal.Now.zonedDateTimeISO(settings.timezone).toPlainDate().toString();
          if (!dateValid(date)) throw new ApiError(422, 'validation_failed', 'Choose a valid dashboard date.');
          return json({business_date: date, timezone: settings.timezone, today: collection(sorted.filter(value => value.fulfillment.local_date === date && value.status !== 'cancelled'), 1, 25),
            upcoming: collection(sorted.filter(value => value.fulfillment.local_date > date && !['cancelled', 'completed'].includes(value.status)), 1, 25)});
        }
        if (path !== '/orders') throw new ApiError(404, 'not_found', 'Not available.');
        return json(collection(sorted.filter(order => (!q || `${order.reference} ${order.customer.name} ${order.customer.phone}`.toLowerCase().includes(q))
          && (!from || order.fulfillment.local_date >= from) && (!to || order.fulfillment.local_date <= to) && (!selected.length || selected.includes(order.status)))));
      }
      let body: Record<string, unknown>;
      try {body = JSON.parse(String(init?.body)); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();}
      catch {throw new ApiError(400, 'invalid_json', 'Send a JSON object.');}
      const idMatch = path.match(/^\/orders\/([^/]+)(\/(?:transitions|cancel|payments|refunds))?$/);
      const order = idMatch ? orders.find(value => value.id === decodeURIComponent(idMatch[1])) : undefined;
      if (path === '/orders/quote' && method === 'POST') {
        knownFields(body, ['draft', 'order_id', 'expected_version']);
        const existing = body.order_id ? orders.find(value => value.id === body.order_id) : undefined;
        if (body.order_id && !existing) throw new ApiError(404, 'not_found', 'Order not found.');
        if (existing) {conflict(existing, body.expected_version); if (!existing.permitted_actions.edit.allowed) throw new ApiError(403, 'action_forbidden', 'This order cannot be edited.');}
        else if (body.expected_version !== undefined) throw new ApiError(422, 'validation_failed', 'Supply an order and version together.');
        const result = await calculate(body.draft as OrderDraft, existing);
        quotes.set(result.quote.id, {quote: clone(result.quote), fingerprint: canonicalFixture(body.draft), dependencies: result.dependencies});
        return json(result.quote);
      }
      if (!(path === '/orders' && method === 'POST' || idMatch && (method === 'PUT' || method === 'POST' && idMatch[2]))) throw new ApiError(404, 'not_found', 'This workflow is not available.');
      const key = new Headers(init?.headers).get('Idempotency-Key');
      if (!key) throw new ApiError(422, 'validation_failed', 'An operation identifier is required.');
      const fingerprint = `${method} ${path} ${canonicalFixture(body)}`;
      const saved = operations.get(key);
      if (saved) return saved.fingerprint === fingerprint ? json(saved.body, saved.status) : json(envelope(new ApiError(409, 'operation_payload_mismatch', 'This key belongs to another attempt.')), 409);
      let status = path === '/orders' || ['/payments', '/refunds'].includes(idMatch?.[2] ?? '') ? 201 : 200; let responseBody: unknown; let result: Order | undefined; let entryResult: LedgerEntry | undefined;
      try {
        const suffix = idMatch?.[2];
        knownFields(body, suffix === '/transitions' ? ['expected_version', 'to_status'] : suffix === '/cancel' ? ['expected_version', 'reason', 'acknowledge_consumed_stock']
          : suffix === '/payments' ? ['expected_version', 'amount_minor', 'paid_on', 'method', 'reference', 'note'] : suffix === '/refunds' ? ['expected_version', 'payment_id', 'amount_minor', 'refunded_on', 'method', 'reason', 'reference', 'note']
          : path === '/orders' ? ['quote_id', 'draft', 'initial_status', 'acknowledge_credit'] : ['expected_version', 'quote_id', 'draft', 'acknowledge_credit']);
        if (idMatch && !order) throw new ApiError(404, 'not_found', 'Order not found.');
        if (order) conflict(order, body.expected_version);
        if (suffix === '/transitions' || suffix === '/cancel') {
          let next: Order['status']; let reason: string | null = null;
          if (suffix === '/cancel') {
            if (!order!.permitted_actions.cancel.allowed) throw new ApiError(409, 'action_not_allowed', order!.permitted_actions.cancel.reason!);
            if (!required(body.reason) || String(body.reason).trim().length > 1000) throw new ApiError(422, 'validation_failed', 'Enter a cancellation reason.', [{path: '/reason', code: 'required', message: 'Enter a reason of at most 1000 characters.'}]);
            if (typeof body.acknowledge_consumed_stock !== 'boolean' || order!.cancellation_requires_stock_acknowledgment && !body.acknowledge_consumed_stock) throw new ApiError(422, 'validation_failed', 'Acknowledge retained consumed stock.', [{path: '/acknowledge_consumed_stock', code: 'required', message: 'Acknowledge that consumed stock will not be restored.'}]);
            next = 'cancelled'; reason = String(body.reason).trim();
          } else {
            const actionsByStatus: Record<string, OrderAction> = {confirmed: 'confirm', preparing: 'start_preparing', ready: 'mark_ready', completed: 'complete'};
            const action = actionsByStatus[String(body.to_status)];
            if (!action || !order!.permitted_actions[action].allowed) throw new ApiError(409, 'action_not_allowed', action ? order!.permitted_actions[action].reason! : 'Only the next fulfillment step is allowed.');
            next = body.to_status as Order['status'];
          }
          order!.status_history.push(history(order!.status, next, reason)); order!.status = next; order!.version++;
          order!.updated_at = new Date().toISOString(); settle(order!); result = order;
        } else if (suffix === '/payments' || suffix === '/refunds') {
          const refund = suffix === '/refunds'; const action = order!.permitted_actions[refund ? 'refund' : 'record_payment'];
          if (!settings.capabilities.payments || !action.allowed) throw new ApiError(403, 'action_forbidden', action.reason ?? 'Payments are not enabled.');
          const fields: FieldError[] = []; const invalid = (path: string, message: string) => fields.push({path, code: 'invalid', message});
          const original = refund ? order!.ledger.find(entry => entry.id === body.payment_id && entry.type === 'payment') : undefined;
          if (refund && !original) invalid('/payment_id', 'Choose a refundable original payment.');
          const limit = refund ? original?.refundable_minor ?? 0 : order!.balance_due_minor;
          if (!amount(body.amount_minor) || Number(body.amount_minor) < 1 || Number(body.amount_minor) > limit) invalid('/amount_minor', `Enter a positive amount no greater than ${limit} minor units.`);
          const dateKey = refund ? 'refunded_on' : 'paid_on';
          if (typeof body[dateKey] !== 'string' || !dateValid(body[dateKey] as string)) invalid(`/${dateKey}`, 'Enter a valid business date.');
          if (!settings.payment_methods.includes(body.method as LedgerEntry['method'])) invalid('/method', 'Choose an enabled payment method.');
          if (refund && (!required(body.reason) || String(body.reason).trim().length > 1000)) invalid('/reason', 'Enter a reason of at most 1000 characters.');
          for (const [name, limit] of [['reference', 200], ['note', 2000]] as const) if (body[name] !== undefined && (typeof body[name] !== 'string' || String(body[name]).length > limit)) invalid(`/${name}`, `Use at most ${limit} characters.`);
          if (fields.length) throw new ApiError(422, 'validation_failed', 'Check the highlighted fields.', fields, false, {maximum_amount_minor: limit});
          safeAmount(BigInt(refund ? order!.refunds_minor : order!.payments_minor) + BigInt(body.amount_minor as number), '/amount_minor');
          entryResult = {id: `fixture_ledger_${crypto.randomUUID()}`, type: refund ? 'refund' : 'payment', payment_id: original?.id ?? null,
            amount_minor: body.amount_minor as number, refundable_minor: refund ? null : body.amount_minor as number, business_date: body[dateKey] as string,
            method: body.method as LedgerEntry['method'], reference: body.reference as string ?? '', note: body.note as string ?? '', reason: refund ? String(body.reason).trim() : null,
            operation_id: key, recorded_at: new Date().toISOString(), recorded_by: {id: 'fixture_admin', display_name: 'Admin'}};
          order!.ledger.push(entryResult); order!.version++; order!.updated_at = entryResult.recorded_at; settle(order!); result = order;
        } else {
          if (order && !order.permitted_actions.edit.allowed) throw new ApiError(403, 'action_forbidden', 'This order cannot be edited.');
          if (!order && !['pending', 'confirmed'].includes(String(body.initial_status))) throw new ApiError(422, 'validation_failed', 'Choose pending or confirmed.');
          const stored = quotes.get(String(body.quote_id));
          if (!stored || Date.parse(stored.quote.expires_at) <= Date.now() || stored.quote.order_id !== (order?.id ?? null) || stored.fingerprint !== canonicalFixture(body.draft)) throw new ApiError(409, 'quote_stale', 'Refresh and review the order quote.');
          const current = await calculate(body.draft as OrderDraft, order);
          if (order) conflict(order, body.expected_version);
          if (current.dependencies !== stored.dependencies) throw new ApiError(409, 'quote_stale', 'Menu or business settings changed. Refresh and review the quote.');
          if (stored.quote.credit_acknowledgment_required && body.acknowledge_credit !== true) throw new ApiError(422, 'validation_failed', 'Acknowledge the customer credit.', [{path: '/acknowledge_credit', code: 'required', message: 'Acknowledge the credit before saving.'}]);
          const quote = stored.quote, draft = body.draft as OrderDraft;
          const items: OrderLine[] = quote.lines.map(({client_line_id: _client, order_item_id, ...line}) => ({...line, id: order_item_id ?? `fixture_order_item_${crypto.randomUUID()}`}));
          const now = new Date().toISOString();
          const {id: _id, expires_at: _expires, order_id: _order, expected_version: _version, settings_version: _settings, lines: _lines, credit_acknowledgment_required: _credit, ...totals} = quote;
          result = order ?? {...totals, id: `fixture_order_${crypto.randomUUID()}`, reference: `DEV-${String(orders.length + 1).padStart(4, '0')}`,
            version: 0, status: body.initial_status as Order['status'], status_history: [history(null, 'pending')], ledger: [], created_at: now,
            payments_minor: 0, refunds_minor: 0, payment_status: 'unpaid', preparation_tracking: 'manual', cancellation_requires_stock_acknowledgment: false, customer: clone(draft.customer),
            notes: draft.notes ?? '', items, updated_at: now, permitted_actions: permitted(body.initial_status as string)};
          if (!order && result.status === 'confirmed') result.status_history.push(history('pending', 'confirmed'));
          Object.assign(result, totals, {customer: {name: draft.customer.name.trim(), phone: draft.customer.phone.trim(), notes: draft.customer.notes ?? ''}, notes: draft.notes ?? '', items, version: result.version + 1,
            payment_status: quote.customer_credit_minor > 0 ? 'credit_due' : quote.balance_due_minor > 0 ? quote.net_paid_minor > 0 ? 'partial' : 'unpaid' : 'paid',
            updated_at: now, permitted_actions: permitted(result.status)});
          settle(result);
          if (!order) orders.push(result);
          items.forEach(item => usedVariants.add(item.variant_id));
        }
        responseBody = entryResult ? {entry: clone(entryResult), order: clone(result)} : clone(result);
      } catch (failure) {const error = failure as ApiError; status = error.status; responseBody = envelope(error);}
      const snapshot = clone(responseBody); const now = new Date().toISOString();
      operations.set(key, {fingerprint, body: snapshot, status, operation: {operation_id: key, state: status < 400 ? 'succeeded' : 'rejected', resource_type: result ? 'order' : null,
        resource_id: result?.id ?? null, result: status < 400 ? {http_status: status, body: snapshot} : null,
        error: status >= 400 ? {http_status: status, ...(snapshot as ReturnType<typeof envelope>)} : null, started_at: now, completed_at: now}});
      return json(snapshot, status);
    } catch (failure) {const error = failure as ApiError; return json(envelope(error), error.status);}
  };
}
