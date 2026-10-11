import Decimal from 'decimal.js';
import {canonicalFixture as canonical, type FixtureOperations} from './fixture-protocol';
import type {BusinessSettings, FieldError} from './types';
import type {Ingredient, Movement, Price} from '../inventory/types';
import {formatCalendarDate} from '../lib/format';
import type {Order} from '../orders/types';
import type {CorrectionPreview, CorrectionResult, Preparation, PreparationCorrection, PreparationPreview, PreparationResult} from '../preparation/types';
import type {Recipe} from '../recipes/types';

const D = Decimal.clone({precision: 60, rounding: Decimal.ROUND_HALF_UP});
type Handler = (url: URL, init?: RequestInit) => Promise<Response | null>;
export type OrderBook = Handler & {allocate: (changes: {order_id: string; order_item_id: string; quantity: number}[]) => Order[]};
type Moved = {movements: Movement[]; ingredients: Ingredient[]};
export type Stockroom = Handler & {consume: (rows: {ingredient_id: string; base_quantity: string; preparation_id: string; operation_id: string}[]) => Moved;
  correct: (rows: {ingredient_id: string; delta_base_quantity: string; reason: string; preparation_id: string; corrects_movement_id: string; operation_id: string}[]) => Moved};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
const date = (value: unknown) => {try {return typeof value === 'string' && Boolean(formatCalendarDate(value));} catch {return false;}};
const units = (base: string) => base === 'g' ? ['g', 'kg'] : base === 'ml' ? ['ml', 'l'] : ['piece'];
const amount = (value: unknown, unit: string) => typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(value) && new D(value).gt(0) && new D(value).lte(Number.MAX_SAFE_INTEGER) && (unit !== 'piece' || new D(value).isInteger());
class Rejection {constructor(public status: number, public code: string, public message: string, public fields: FieldError[] = [], public details: Record<string, unknown> = {}) {}}

export function createPreparationFixtures({orders, inventory, recipes, settings, operations}: {orders: OrderBook; inventory: Stockroom; recipes: Handler; settings: BusinessSettings; operations: FixtureOperations}): Handler {
  const preparations: Preparation[] = [], previews = new Map<string, {input: string; result: PreparationPreview}>();
  const corrections: PreparationCorrection[] = [], correctionPreviews = new Map<string, {input: string; result: CorrectionPreview}>();
  const changed = (type: 'order' | 'ingredient', latest: {id: string; version: number}, expected: unknown) => new Rejection(409, 'version_conflict', type === 'order' ? 'An order changed. Review the latest order.' : 'Stock changed. Review the latest ingredient.', [],
    {resource_type: type, resource_id: latest.id, expected_version: expected, current_version: latest.version, latest_resource: latest});
  async function read<T>(handler: Handler, path: string): Promise<T | null> {
    const response = await handler(new URL(`http://fixture.local/api/v1${path}`)); return response?.ok ? await response.json() as T : null;
  }
  // Checks a draft against current orders and stock and describes its effect; nothing is changed here.
  async function review(draft: any): Promise<PreparationPreview> {
    const fields: FieldError[] = [], field = (path: string, message: string) => fields.push({path, code: 'invalid', message});
    const unknown = (value: object, keys: string[], prefix: string) => Object.keys(value).filter(key => !keys.includes(key)).forEach(key => field(`${prefix}/${key}`, 'Unknown field.'));
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Rejection(422, 'validation_failed', 'Enter a preparation draft.', [{path: '/draft', code: 'invalid', message: 'Enter a preparation draft.'}]);
    unknown(draft, ['prepared_on', 'allocations', 'consumption', 'note'], '/draft');
    const note = draft.note ?? '', short: FieldError[] = [], stale: Rejection[] = [];
    if (!date(draft.prepared_on)) field('/draft/prepared_on', 'Choose a valid business date.');
    if (typeof note !== 'string' || note.length > 2000) field('/draft/note', 'Use up to 2000 characters.');
    else if (Array.isArray(draft.consumption) && !draft.consumption.length && !note.trim()) field('/draft/note', 'Explain a preparation that used no tracked ingredients.');
    if (!Array.isArray(draft.allocations) || !draft.allocations.length) field('/draft/allocations', 'Allocate at least one prepared quantity.');
    if (!Array.isArray(draft.consumption)) field('/draft/consumption', 'List the ingredients actually used.');
    const allocations: PreparationPreview['allocations'] = [], consumption: PreparationPreview['consumption'] = [], basis: PreparationPreview['cost_basis_snapshots'] = [];
    const variants = new Set<string>(); let cost: Decimal | null = new D(0);
    for (const [i, row] of (Array.isArray(draft.allocations) ? draft.allocations : []).entries()) {
      const prefix = `/draft/allocations/${i}`;
      if (!row || typeof row !== 'object') {field(prefix, 'Enter an allocation.'); continue;}
      unknown(row, ['order_id', 'expected_version', 'order_item_id', 'quantity'], prefix);
      const order = typeof row.order_id === 'string' ? await read<Order>(orders, `/orders/${encodeURIComponent(row.order_id)}`) : null;
      if (!order || order.preparation_tracking !== 'recorded' || !['confirmed', 'preparing', 'ready'].includes(order.status)) {field(`${prefix}/order_id`, 'Choose a confirmed, preparing or ready order.'); continue;}
      const item = order.items.find(value => value.id === row.order_item_id);
      if (!item || allocations.some(value => value.order_item_id === item.id)) {field(`${prefix}/order_item_id`, item ? 'Each order line may appear once.' : 'Choose a line of this order.'); continue;}
      if (!Number.isSafeInteger(row.quantity) || row.quantity < 1 || row.quantity > item.remaining_quantity!) {field(`${prefix}/quantity`, `Enter a whole quantity from 1 to ${item.remaining_quantity}.`); continue;}
      variants.add(item.variant_id);
      if (order.version !== row.expected_version) stale.push(changed('order', order, row.expected_version));
      allocations.push({order_id: order.id, reference: order.reference, order_item_id: item.id, variant_id: item.variant_id, expected_version: row.expected_version, food_name: item.food_name, variant_label: item.variant_label, selling_unit: item.selling_unit,
        package_contents: item.package_contents, ordered_quantity: item.quantity, prepared_before: item.prepared_quantity!, quantity: row.quantity, prepared_after: item.prepared_quantity! + row.quantity, remaining_after: item.remaining_quantity! - row.quantity});
    }
    for (const [i, row] of (Array.isArray(draft.consumption) ? draft.consumption : []).entries()) {
      const prefix = `/draft/consumption/${i}`;
      if (!row || typeof row !== 'object') {field(prefix, 'Enter an ingredient row.'); continue;}
      unknown(row, ['ingredient_id', 'expected_version', 'quantity', 'unit'], prefix);
      const item = typeof row.ingredient_id === 'string' ? await read<Ingredient>(inventory, `/ingredients/${encodeURIComponent(row.ingredient_id)}`) : null;
      if (!item || consumption.some(value => value.ingredient_id === item.id)) {field(`${prefix}/ingredient_id`, item ? 'Each ingredient may appear once.' : 'Choose an ingredient.'); continue;}
      if (!units(item.base_unit).includes(row.unit)) {field(`${prefix}/unit`, 'Unit must match the ingredient dimension.'); continue;}
      if (!amount(row.quantity, row.unit)) {field(`${prefix}/quantity`, 'Enter a positive quantity with up to three decimal places; pieces are whole counts.'); continue;}
      const used = new D(row.quantity).times(['kg', 'l'].includes(row.unit) ? 1000 : 1), before = new D(item.stock_on_hand);
      if (used.gt(before)) short.push({path: `${prefix}/quantity`, code: 'insufficient_stock', message: `Only ${item.stock_on_hand} ${item.base_unit} is in stock. Record a stock correction first if the count is wrong.`});
      if (item.version !== row.expected_version) stale.push(changed('ingredient', item, row.expected_version));
      // Actual usage is valued at the latest unrounded purchase basis; an ingredient never bought leaves the cost unknown.
      const latest = (await read<{items: Price[]}>(inventory, `/ingredients/${encodeURIComponent(item.id)}/prices?limit=1`))?.items[0];
      cost = latest && cost ? cost.plus(used.times(latest.total_cost_minor).div(new D(10).pow(latest.minor_digits).times(latest.base_quantity))) : null;
      basis.push({ingredient_id: item.id, purchase_id: latest?.purchase_id ?? null, purchase_line_id: latest?.id ?? null, purchased_on: latest?.purchased_on ?? null, unit_cost: latest?.unit_cost ?? null});
      consumption.push({ingredient_id: item.id, ingredient_name: item.name, base_unit: item.base_unit, expected_version: row.expected_version, quantity: row.quantity, unit: row.unit, base_quantity: used.toFixed(),
        before_quantity: before.toFixed(), after_quantity: before.minus(used).toFixed()});
    }
    if (fields.length) throw new Rejection(422, 'validation_failed', 'Check the highlighted fields.', fields);
    if (stale.length) throw stale[0];
    if (short.length) throw new Rejection(409, 'insufficient_stock', 'Physical stock does not cover this usage.', short);
    const snapshots = [];
    for (const variant_id of variants) {
      const recipe = await read<Recipe>(recipes, `/variants/${encodeURIComponent(variant_id)}/recipe`); snapshots.push({variant_id, recipe_id: recipe?.id ?? null, recipe_version: recipe?.version ?? null});
    }
    return {id: `fixture_preparation_preview_${crypto.randomUUID()}`, expires_at: new Date(Date.now() + 300000).toISOString(), prepared_on: draft.prepared_on, note: note.trim(), allocations, consumption,
      recipe_snapshots: snapshots, cost_basis_snapshots: basis, estimated_ingredient_cost_minor: cost ? cost.times(new D(10).pow(settings.minor_digits)).toDecimalPlaces(0).toNumber() : null,
      estimate_complete: cost !== null, currency: settings.currency, minor_digits: settings.minor_digits};
  }
  // What one preparation currently accounts for on a line: its own allocation and every later correction of it.
  const contributed = (record: Preparation, itemId: string) => record.allocations.find(row => row.order_item_id === itemId)!.quantity
    + corrections.filter(item => item.preparation_id === record.id).flatMap(item => item.allocations).filter(row => row.order_item_id === itemId).reduce((sum, row) => sum + row.delta_quantity, 0);
  // Checks a correction of one preparation against current orders and stock and describes its effect; nothing is changed here.
  async function amend(record: Preparation, draft: any): Promise<CorrectionPreview> {
    const fields: FieldError[] = [], field = (path: string, message: string) => fields.push({path, code: 'invalid', message}), stale: Rejection[] = [], short: FieldError[] = [];
    for (const key of Object.keys(draft).filter(name => !['reason', 'allocations', 'stock_corrections'].includes(name))) field(`/${key}`, 'Unknown field.');
    if (typeof draft.reason !== 'string' || !draft.reason.trim() || draft.reason.length > 2000) field('/reason', 'Enter a reason (up to 2000 characters).');
    const lines: any[] | null = Array.isArray(draft.allocations) ? draft.allocations : null, stock: any[] | null = Array.isArray(draft.stock_corrections) ? draft.stock_corrections : null;
    if (!lines) field('/allocations', 'List the prepared counts to change.');
    if (!stock) field('/stock_corrections', 'List the stock adjustments.');
    if (lines && stock && !lines.length && !stock.length) field('/allocations', 'Enter at least one change.');
    const allocations: CorrectionPreview['allocations'] = [], stock_corrections: CorrectionPreview['stock_corrections'] = [];
    for (const [i, row] of (lines ?? []).entries()) {
      const prefix = `/allocations/${i}`, original = record.allocations.find(item => item.order_item_id === row?.order_item_id && item.order_id === row?.order_id);
      const order = original ? await read<Order>(orders, `/orders/${encodeURIComponent(original.order_id)}`) : null, item = order?.items.find(value => value.id === original!.order_item_id);
      if (!original || !order || !item || allocations.some(value => value.order_item_id === original.order_item_id)) {field(`${prefix}/order_item_id`, original && order && item ? 'Each order line may appear once.' : 'Choose a line of this preparation.'); continue;}
      const before = item.prepared_quantity ?? 0, after = before + row.delta_quantity;
      if (!Number.isSafeInteger(row.delta_quantity) || row.delta_quantity === 0 || contributed(record, item.id) + row.delta_quantity < 0 || after < 0 || after > item.quantity) {
        field(`${prefix}/delta_quantity`, 'Enter a nonzero change that stays within what this preparation recorded and what was ordered.'); continue;
      }
      // Lowering a count would leave a Ready or Completed order inconsistent; an operator resolves that first.
      if (row.delta_quantity < 0 && ['ready', 'completed'].includes(order.status)) {field(`${prefix}/delta_quantity`, 'Prepared quantities cannot be lowered while the order is Ready or Completed.'); continue;}
      if (order.version !== row.expected_version) stale.push(changed('order', order, row.expected_version));
      const {quantity: _recorded, ...snapshot} = original;
      allocations.push({...snapshot, expected_version: row.expected_version, ordered_quantity: item.quantity, prepared_before: before, delta_quantity: row.delta_quantity, prepared_after: after, remaining_after: item.quantity - after});
    }
    for (const [i, row] of (stock ?? []).entries()) {
      const prefix = `/stock_corrections/${i}`, original = record.consumption.find(item => item.ingredient_id === row?.ingredient_id);
      const item = original ? await read<Ingredient>(inventory, `/ingredients/${encodeURIComponent(original.ingredient_id)}`) : null;
      if (!original || !item || stock_corrections.some(value => value.ingredient_id === original.ingredient_id)) {field(`${prefix}/ingredient_id`, original && item ? 'Each ingredient may appear once.' : 'Choose an ingredient this preparation used.'); continue;}
      if (row.corrects_movement_id !== original.stock_movement_id) {field(`${prefix}/corrects_movement_id`, 'Name the deduction this preparation recorded.'); continue;}
      if (typeof row.delta_base_quantity !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(row.delta_base_quantity) || new D(row.delta_base_quantity).isZero() || item.base_unit === 'piece' && !new D(row.delta_base_quantity).isInteger()) {
        field(`${prefix}/delta_base_quantity`, 'Enter a nonzero signed quantity in the base unit.'); continue;
      }
      const before = new D(item.stock_on_hand), after = before.plus(row.delta_base_quantity);
      if (after.lt(0)) short.push({path: `${prefix}/delta_base_quantity`, code: 'insufficient_stock', message: `Only ${item.stock_on_hand} ${item.base_unit} is in stock.`});
      if (item.version !== row.expected_version) stale.push(changed('ingredient', item, row.expected_version));
      stock_corrections.push({ingredient_id: item.id, ingredient_name: item.name, base_unit: item.base_unit, expected_version: row.expected_version, corrects_movement_id: original.stock_movement_id,
        delta_base_quantity: new D(row.delta_base_quantity).toFixed(), before_quantity: before.toFixed(), after_quantity: after.toFixed()});
    }
    if (fields.length) throw new Rejection(422, 'validation_failed', 'Check the highlighted fields.', fields);
    if (stale.length) throw stale[0];
    if (short.length) throw new Rejection(409, 'insufficient_stock', 'Physical stock does not cover this correction.', short);
    return {id: `fixture_correction_preview_${crypto.randomUUID()}`, expires_at: new Date(Date.now() + 300000).toISOString(), preparation_id: record.id, reason: draft.reason.trim(), allocations, stock_corrections};
  }
  return async (url, init) => {
    const path = url.pathname.replace('/api/v1', ''), method = init?.method ?? 'GET';
    if (!/^\/preparations(\/|$)/.test(path)) return null;
    const envelope = (failure: Rejection) => ({error: {code: failure.code, message: failure.message, field_errors: failure.fields, details: failure.details, request_id: 'preparation-development-fixture'}});
    const fail = (failure: Rejection) => json(envelope(failure), failure.status);
    if (!settings.capabilities.preparation_recording || !settings.capabilities.orders || !settings.capabilities.inventory) return fail(new Rejection(403, 'forbidden', 'Preparation recording unavailable.'));
    const amending = /^\/preparations\/([^/]+)\/(correction-preview|corrections)$/.exec(path);
    if (amending) {
      const record = preparations.find(item => item.id === decodeURIComponent(amending[1])), reviewing = amending[2] === 'correction-preview';
      if (!record) return fail(new Rejection(404, 'not_found', 'Preparation not found.'));
      if (method === 'GET' && !reviewing) return json({items: corrections.filter(item => item.preparation_id === record.id)});
      if (method !== 'POST') return fail(new Rejection(404, 'not_found', 'Preparation action unavailable.'));
      let body: any;
      try {body = JSON.parse(String(init?.body)); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();} catch {return fail(new Rejection(400, 'invalid_json', 'Send a JSON object.'));}
      const key = new Headers(init?.headers).get('Idempotency-Key'), fingerprint = `${method} ${path} ${canonical(body)}`;
      if (!reviewing && !key) return fail(new Rejection(422, 'validation_failed', 'An operation identifier is required.'));
      const replay = key && !reviewing ? operations.get(key) : null;
      if (replay) return replay.fingerprint === fingerprint ? json(replay.body, replay.status) : fail(new Rejection(409, 'operation_payload_mismatch', 'This operation belongs to another submission.'));
      let status = reviewing ? 200 : 201, response: unknown, saved: PreparationCorrection | undefined;
      try {
        const {preview_id, ...draft} = body, current = await amend(record, reviewing ? body : draft);
        if (reviewing) {correctionPreviews.set(current.id, {input: canonical(body), result: current}); response = current;}
        else {
          const reviewed = correctionPreviews.get(preview_id);
          if (!reviewed || reviewed.result.preparation_id !== record.id || reviewed.input !== canonical(draft) || Date.parse(reviewed.result.expires_at) <= Date.now()) throw new Rejection(409, 'quote_stale', 'Preview expired or changed. Review again.');
          // Prepared counts and stock are amended together, once per operation key; the original record is left as it was.
          const id = `fixture_correction_${crypto.randomUUID()}`, amended = orders.allocate(current.allocations.map(row => ({order_id: row.order_id, order_item_id: row.order_item_id, quantity: row.delta_quantity})));
          const moved = inventory.correct(current.stock_corrections.map(row => ({ingredient_id: row.ingredient_id, delta_base_quantity: row.delta_base_quantity, reason: current.reason, preparation_id: record.id, corrects_movement_id: row.corrects_movement_id, operation_id: key!})));
          saved = {id, preparation_id: record.id, reason: current.reason, allocations: current.allocations.map(({expected_version: _v, ...row}) => row),
            stock_corrections: current.stock_corrections.map(({expected_version: _v, ...row}, index) => ({...row, stock_movement_id: moved.movements[index].id})), operation_id: key!, recorded_at: new Date().toISOString(), recorded_by: 'Admin'};
          corrections.push(saved); const result: CorrectionResult = {correction: saved, orders: amended, ingredients: moved.ingredients}; response = result;
        }
      } catch (failure) {if (!(failure instanceof Rejection)) throw failure; status = failure.status; response = envelope(failure);}
      const snapshot = JSON.parse(JSON.stringify(response)), now = new Date().toISOString();
      if (key && !reviewing) operations.set(key, {fingerprint, body: snapshot, status, operation: {operation_id: key, state: status < 400 ? 'succeeded' : 'rejected', resource_type: saved ? 'preparation_correction' : null, resource_id: saved?.id ?? null,
        result: status < 400 ? {http_status: status, body: snapshot} : null, error: status >= 400 ? {http_status: status, ...snapshot} : null, started_at: now, completed_at: now}});
      return json(snapshot, status);
    }
    if (method === 'GET') {
      const found = preparations.find(item => item.id === decodeURIComponent(path.slice('/preparations/'.length)));
      return found ? json(found) : fail(new Rejection(404, 'not_found', 'Preparation not found.'));
    }
    const previewing = path === '/preparations/preview';
    if (method !== 'POST' || !previewing && path !== '/preparations') return fail(new Rejection(404, 'not_found', 'Preparation action unavailable.'));
    let body: any;
    try {body = JSON.parse(String(init?.body)); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();} catch {return fail(new Rejection(400, 'invalid_json', 'Send a JSON object.'));}
    const key = new Headers(init?.headers).get('Idempotency-Key'), fingerprint = `${method} ${path} ${canonical(body)}`;
    if (!previewing && !key) return fail(new Rejection(422, 'validation_failed', 'An operation identifier is required.'));
    const replay = key && !previewing ? operations.get(key) : null;
    if (replay) return replay.fingerprint === fingerprint ? json(replay.body, replay.status) : fail(new Rejection(409, 'operation_payload_mismatch', 'This operation belongs to another submission.'));
    let status = previewing ? 200 : 201, response: unknown, saved: Preparation | undefined;
    try {
      const extra = Object.keys(body).filter(name => !(previewing ? ['draft'] : ['draft', 'preview_id']).includes(name));
      if (extra.length) throw new Rejection(422, 'validation_failed', 'Unexpected fields were supplied.', extra.map(name => ({path: `/${name}`, code: 'invalid', message: 'Unknown field.'})));
      const current = await review(body.draft);
      if (previewing) {previews.set(current.id, {input: canonical(body.draft), result: current}); response = current;}
      else {
        const reviewed = previews.get(body.preview_id);
        if (!reviewed || reviewed.input !== canonical(body.draft) || Date.parse(reviewed.result.expires_at) <= Date.now()) throw new Rejection(409, 'quote_stale', 'Preview expired or changed. Review again.');
        // Prepared counts and stock move together, exactly once per operation key.
        const id = `fixture_preparation_${crypto.randomUUID()}`, changed = orders.allocate(current.allocations);
        const used = inventory.consume(current.consumption.map(row => ({ingredient_id: row.ingredient_id, base_quantity: row.base_quantity, preparation_id: id, operation_id: key!})));
        const {id: _preview, expires_at: _expires, allocations, consumption, ...costing} = current;
        saved = {...costing, id, allocations: allocations.map(({expected_version: _v, ordered_quantity: _o, prepared_before: _b, prepared_after: _a, remaining_after: _r, ...line}) => line),
          consumption: consumption.map(({expected_version: _v, ...row}, index) => ({...row, stock_movement_id: used.movements[index].id})),
          operation_id: key!, recorded_at: new Date().toISOString(), recorded_by: 'Admin'};
        preparations.push(saved); const result: PreparationResult = {preparation: saved, orders: changed, ingredients: used.ingredients}; response = result;
      }
    } catch (failure) {if (!(failure instanceof Rejection)) throw failure; status = failure.status; response = envelope(failure);}
    const snapshot = JSON.parse(JSON.stringify(response)), now = new Date().toISOString();
    if (key && !previewing) operations.set(key, {fingerprint, body: snapshot, status, operation: {operation_id: key, state: status < 400 ? 'succeeded' : 'rejected', resource_type: saved ? 'preparation' : null, resource_id: saved?.id ?? null,
      result: status < 400 ? {http_status: status, body: snapshot} : null, error: status >= 400 ? {http_status: status, ...snapshot} : null, started_at: now, completed_at: now}});
    return json(snapshot, status);
  };
}
