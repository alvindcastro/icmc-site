import Decimal from 'decimal.js';
import type {BusinessSettings, FieldError} from './types';
import {canonicalFixture as canonical, type FixtureOperations} from './fixture-protocol';
import type {Ingredient, Movement, MovementPreview, Purchase, PurchaseDraft, PurchasePreview, Price, BaseUnit} from '../inventory/types';
import {formatCalendarDate} from '../lib/format';

const D = Decimal.clone({precision: 60, rounding: Decimal.ROUND_HALF_UP});
const allow = {allowed: true, reason: null, reason_code: null};
const responseBodies = new WeakMap<Response, unknown>();
const json = (body: unknown, status = 200) => {
  const serialized = JSON.stringify(body), response = new Response(serialized, {status, headers: {'Content-Type': 'application/json'}});
  responseBodies.set(response, JSON.parse(serialized)); return response;
};
const quantity = (value: unknown, unit: string, signed = false) => typeof value === 'string'
  && (signed ? /^-?(?:0|[1-9]\d*)(?:\.\d{1,3})?$/ : /^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/).test(value)
  && !(value.startsWith('-') && new D(value).isZero()) && new D(value).abs().lte(Number.MAX_SAFE_INTEGER)
  && (unit !== 'piece' || new D(value).isInteger());
const date = (value: unknown) => {try {return typeof value === 'string' && Boolean(formatCalendarDate(value));} catch {return false;}};
const units = (unit: BaseUnit) => unit === 'g' ? ['g', 'kg'] : unit === 'ml' ? ['ml', 'l'] : ['piece'];

export function createInventoryFixtures(settings: BusinessSettings, operations: FixtureOperations) {
  const ingredients: Ingredient[] = [], movements: Movement[] = [], purchases: Purchase[] = [], prices: Price[] = [];
  const previews = new Map<string, {input: string; result: PurchasePreview | MovementPreview}>();
  const refresh = (item: Ingredient) => {
    item.low_stock = item.low_stock_threshold !== null && new D(item.stock_on_hand).lte(item.low_stock_threshold);
    const used = movements.some(row => row.ingredient_id === item.id);
    item.permitted_actions.opening = used ? {allowed: false, reason_code: 'opening_used', reason: 'Opening stock is only available before the first movement.'} : {...allow};
  };
  return async (url: URL, init?: RequestInit): Promise<Response | null> => {
    const path = url.pathname.replace('/api/v1', ''), method = init?.method ?? 'GET';
    if (!/^\/(ingredients|purchases)(\/|$)/.test(path)) return null;
    const err = (code: string, message: string, field_errors: FieldError[] = [], details = {}) => ({error: {code, message, field_errors, details, request_id: 'inventory-development-fixture'}});
    const fail = (status: number, code: string, message: string, fields: FieldError[] = [], details = {}) => json(err(code, message, fields, details), status);
    if (!settings.capabilities.inventory || path.startsWith('/purchases') && !settings.capabilities.purchases) return fail(403, 'forbidden', 'Inventory workflow unavailable.');
    const match = path.match(/^\/ingredients\/([^/]+)(?:\/(movements|movement-preview|prices))?$/);
    const current = ingredients.find(item => item.id === decodeURIComponent(match?.[1] ?? ''));
    if (match && !current) return fail(404, 'not_found', 'Ingredient not found.');
    if (method === 'GET') {
      if (match && !match[2]) return json(current);
      const receipt = path.match(/^\/purchases\/([^/]+)$/);
      if (receipt) {const item = purchases.find(row => row.id === decodeURIComponent(receipt[1])); return item ? json(item) : fail(404, 'not_found', 'Receipt not found.');}
      const page = Number(url.searchParams.get('page') ?? 1), limit = Number(url.searchParams.get('limit') ?? 25);
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase(), low = url.searchParams.get('low_stock'), supplier = url.searchParams.get('supplier');
      const from = url.searchParams.get('date_from'), to = url.searchParams.get('date_to');
      const keys = path === '/ingredients' ? ['q', 'low_stock'] : path === '/purchases' ? ['q', 'supplier', 'date_from', 'date_to'] : [];
      if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || q.length > 200
        || low !== null && !['true', 'false'].includes(low) || from !== null && !date(from) || to !== null && !date(to) || from && to && from > to
        || [...url.searchParams.keys()].some(key => !['page', 'limit', ...keys].includes(key))) return fail(422, 'validation_failed', 'Check inventory filters.');
      let rows: unknown[];
      if (path === '/ingredients') rows = ingredients.filter(item => item.name.toLowerCase().includes(q) && (low === null || item.low_stock === (low === 'true'))).sort((a,b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      else if (path === '/purchases') rows = purchases.filter(item => `${item.supplier} ${item.reference}`.toLowerCase().includes(q) && (!supplier || item.supplier.toLowerCase().includes(supplier.toLowerCase())) && (!from || item.purchased_on >= from) && (!to || item.purchased_on <= to)).sort((a,b) => b.purchased_on.localeCompare(a.purchased_on) || b.id.localeCompare(a.id))
        .map(({id, reference, supplier, purchased_on, currency, minor_digits, total_cost_minor, recorded_at}) => ({id, reference, supplier, purchased_on, currency, minor_digits, total_cost_minor, recorded_at}));
      else if (match?.[2] === 'movements') rows = movements.filter(item => item.ingredient_id === current!.id).sort((a,b) => b.recorded_at.localeCompare(a.recorded_at) || b.id.localeCompare(a.id));
      else if (match?.[2] === 'prices') rows = prices.filter(item => item.ingredient_id === current!.id).sort((a,b) => b.purchased_on.localeCompare(a.purchased_on) || b.recorded_at.localeCompare(a.recorded_at) || b.id.localeCompare(a.id));
      else return fail(404, 'not_found', 'Inventory record unavailable.');
      return json({items: rows.slice((page - 1) * limit, page * limit), page, limit, total: rows.length, has_next: page * limit < rows.length});
    }
    let body: any;
    try {body = JSON.parse(String(init?.body)); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();} catch {return fail(400, 'invalid_json', 'Send a JSON object.');}
    const previewRequest = path === '/purchases/preview' || match?.[2] === 'movement-preview';
    const key = new Headers(init?.headers).get('Idempotency-Key'), fingerprint = `${method} ${path} ${canonical(body)}`;
    if (!previewRequest && !key) return fail(422, 'validation_failed', 'An operation identifier is required.');
    const saved = key ? operations.get(key) : null;
    if (saved) return saved.fingerprint === fingerprint ? json(saved.body, saved.status) : fail(409, 'operation_payload_mismatch', 'This operation belongs to another submission.');
    const fields: FieldError[] = [];
    const field = (path: string, message: string) => fields.push({path, code: 'invalid', message});
    const unknown = (value: any, keys: string[], prefix = '') => Object.keys(value).filter(key => !keys.includes(key)).forEach(key => field(`${prefix}/${key}`, 'Unknown field.'));
    const conflict = (item: Ingredient, expected: unknown) => fail(409, 'version_conflict', 'Stock or ingredient details changed. Review the latest record.', [], {resource_type: 'ingredient', resource_id: item.id, expected_version: expected, current_version: item.version, latest_resource: item});
    const finish = (response: Response, resource_type: string | null = null, resource_id: string | null = null) => {
      if (!previewRequest && key) {
        // Admit and snapshot synchronously, before another request can reuse the key.
        const snapshot = responseBodies.get(response) as any, now = new Date().toISOString(); operations.set(key, {fingerprint, body: snapshot, status: response.status, operation: {
          operation_id: key, state: response.ok ? 'succeeded' : 'rejected', resource_type, resource_id, result: response.ok ? {http_status: response.status, body: snapshot} : null,
          error: response.ok ? null : {http_status: response.status, ...snapshot}, started_at: now, completed_at: now}});
      }
      return Promise.resolve(response);
    };
    const stale = () => finish(fail(409, 'quote_stale', 'Preview expired or changed. Review again.'));
    if (path === '/ingredients' && method === 'POST' || match && !match[2] && method === 'PATCH') {
      unknown(body, ['name', 'low_stock_threshold', ...(current ? ['expected_version'] : ['base_unit'])]);
      const name = body.name ?? current?.name, base = current?.base_unit ?? body.base_unit;
      const threshold = body.low_stock_threshold === undefined ? current?.low_stock_threshold ?? null : body.low_stock_threshold;
      if (typeof name !== 'string' || !name.trim() || name.length > 200) field('/name', 'Enter an ingredient name (up to 200 characters).');
      if (!['g', 'ml', 'piece'].includes(base)) field('/base_unit', 'Choose grams, milliliters or pieces.');
      if (threshold !== null && !quantity(threshold, base)) field('/low_stock_threshold', 'Enter a nonnegative compatible quantity with supported precision.');
      if (current && (!Number.isSafeInteger(body.expected_version) || body.expected_version < 1)) field('/expected_version', 'A version is required.');
      if (fields.length) return finish(fail(422, 'validation_failed', 'Check the highlighted fields.', fields));
      if (current && current.version !== body.expected_version) return finish(conflict(current, body.expected_version));
      const item: Ingredient = current ?? {id: `fixture_ingredient_${crypto.randomUUID()}`, version: 0, name, base_unit: base, stock_on_hand: '0', low_stock: false,
        low_stock_threshold: threshold, latest_unit_cost: null, latest_purchase_date: null, permitted_actions: {edit: {...allow}, opening: {...allow}, waste: {...allow}, correction: {...allow}}};
      Object.assign(item, {name: name.trim(), low_stock_threshold: threshold === null ? null : new D(threshold).toFixed(), version: item.version + 1});
      if (!current) ingredients.push(item); refresh(item);
      return finish(json(item, current ? 200 : 201), 'ingredient', item.id);
    }
    if (match && ['movement-preview', 'movements'].includes(match[2]) && method === 'POST') {
      unknown(body, ['expected_version', 'type', 'delta_base_quantity', 'reason', 'preparation_id', 'corrects_movement_id', ...(!previewRequest ? ['preview_id'] : [])]);
      const action = current!.permitted_actions[body.type as 'opening'];
      if (!['opening', 'waste', 'correction'].includes(body.type) || !action?.allowed) field('/type', action?.reason ?? 'Choose a permitted stock movement.');
      if (!Number.isSafeInteger(body.expected_version) || body.expected_version < 1) field('/expected_version', 'A version is required.');
      if (!quantity(body.delta_base_quantity, current!.base_unit, true) || new D(body.delta_base_quantity || 0).isZero()) field('/delta_base_quantity', 'Enter a nonzero quantity in the base unit.');
      if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 2000) field('/reason', 'Enter a reason (up to 2000 characters).');
      if (body.preparation_id != null) field('/preparation_id', 'Preparation recording is not enabled.');
      if (body.corrects_movement_id != null && !movements.some(item => item.ingredient_id === current!.id && item.id === body.corrects_movement_id)) field('/corrects_movement_id', 'Choose a movement for this ingredient.');
      if (fields.length) return finish(fail(422, 'validation_failed', 'Check the highlighted fields.', fields));
      const delta = new D(body.delta_base_quantity), after = new D(current!.stock_on_hand).plus(delta);
      if (after.lt(0) || after.gt(Number.MAX_SAFE_INTEGER) || body.type === 'waste' && delta.gt(0) || body.type === 'opening' && delta.lt(0)) return finish(fail(422, 'validation_failed', 'Check the movement quantity.', [{path: '/delta_base_quantity', code: 'invalid', message: 'Movement must leave nonnegative stock; waste removes and opening adds.'}]));
      if (current!.version !== body.expected_version) return finish(conflict(current!, body.expected_version));
      const {preview_id, ...input} = body;
      if (previewRequest) {
        const result: MovementPreview = {id: `fixture_inventory_preview_${crypto.randomUUID()}`, expires_at: new Date(Date.now() + 300000).toISOString(), ingredient_id: current!.id,
          expected_version: current!.version, before_quantity: current!.stock_on_hand, delta_base_quantity: delta.toFixed(), after_quantity: after.toFixed()};
        previews.set(result.id, {input: canonical(input), result}); return json(result);
      }
      const preview = previews.get(preview_id);
      if (!preview || preview.input !== canonical(input) || Date.parse(preview.result.expires_at) <= Date.now() || !('ingredient_id' in preview.result) || preview.result.ingredient_id !== current!.id) return stale();
      const movement: Movement = {id: `fixture_movement_${crypto.randomUUID()}`, ingredient_id: current!.id, type: body.type, reason: body.reason.trim(),
        delta_base_quantity: delta.toFixed(), before_quantity: current!.stock_on_hand, after_quantity: after.toFixed(), purchase_id: null,
        preparation_id: null, corrects_movement_id: body.corrects_movement_id ?? null, operation_id: key!, recorded_at: new Date().toISOString(), recorded_by: 'Admin'};
      movements.push(movement); current!.stock_on_hand = after.toFixed(); current!.version++; refresh(current!);
      return finish(json({movement, ingredient: current}, 201), 'ingredient', current!.id);
    }
    if (['/purchases', '/purchases/preview'].includes(path) && method === 'POST') {
      unknown(body, previewRequest ? ['draft'] : ['draft', 'preview_id']);
      const draft: PurchaseDraft = body.draft;
      if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return finish(fail(422, 'validation_failed', 'Enter a purchase draft.'));
      unknown(draft, ['purchased_on', 'supplier', 'note', 'items'], '/draft');
      if (!date(draft.purchased_on)) field('/draft/purchased_on', 'Choose a valid business date.');
      if (typeof draft.supplier !== 'string' || !draft.supplier.trim() || draft.supplier.length > 200) field('/draft/supplier', 'Enter a supplier (up to 200 characters).');
      if (draft.note !== undefined && (typeof draft.note !== 'string' || draft.note.length > 2000)) field('/draft/note', 'Use up to 2000 characters.');
      if (!Array.isArray(draft.items) || !draft.items.length || draft.items.length > 100) field('/draft/items', 'Enter 1 to 100 purchase lines.');
      const rows: PurchasePreview['items'] = [], running = new Map<string, Decimal>(), ids = new Set<string>();
      let total = new D(0);
      if (Array.isArray(draft.items)) draft.items.forEach((row, i) => {
        const prefix = `/draft/items/${i}`, start = fields.length;
        if (!row || typeof row !== 'object') {field(prefix, 'Enter an ingredient row.'); return;}
        unknown(row, ['client_line_id', 'ingredient_id', 'quantity', 'unit', 'pack_contents', 'total_cost_minor'], prefix);
        const item = ingredients.find(item => item.id === row.ingredient_id), packed = ['bag', 'bottle', 'box'].includes(row.unit);
        if (typeof row.client_line_id !== 'string' || !row.client_line_id || ids.has(row.client_line_id)) field(`${prefix}/client_line_id`, 'Use unique line identifiers.'); ids.add(row.client_line_id);
        if (!item) field(`${prefix}/ingredient_id`, 'Choose an ingredient.');
        if (!quantity(row.quantity, packed || row.unit === 'piece' ? 'piece' : 'g') || new D(row.quantity || 0).lte(0)) field(`${prefix}/quantity`, 'Enter a positive quantity; packs and pieces use whole counts.');
        const physical = packed ? row.pack_contents?.unit : row.unit;
        if (!item || !units(item.base_unit).includes(physical ?? '')) field(`${prefix}/unit`, 'Purchase unit must match the ingredient dimension.');
        if (packed ? !row.pack_contents || !quantity(row.pack_contents.quantity, row.pack_contents.unit) || new D(row.pack_contents.quantity || 0).lte(0) : row.pack_contents !== null) field(`${prefix}/pack_contents/quantity`, 'Declare positive compatible contents for each pack; physical units have no pack contents.');
        if (packed && row.pack_contents) unknown(row.pack_contents, ['quantity', 'unit'], `${prefix}/pack_contents`);
        if (!Number.isSafeInteger(row.total_cost_minor) || row.total_cost_minor < 0) field(`${prefix}/total_cost_minor`, 'Enter a nonnegative safe total ingredient cost.');
        if (fields.length !== start) return;
        const base = new D(row.quantity).times(packed ? row.pack_contents!.quantity : 1).times(['kg', 'l'].includes(physical ?? '') ? 1000 : 1);
        const before = running.get(item!.id) ?? new D(item!.stock_on_hand), after = before.plus(base);
        if (!quantity(base.toFixed(), item!.base_unit) || after.gt(Number.MAX_SAFE_INTEGER)) {field(`${prefix}/quantity`, 'Normalized stock exceeds supported precision or range.'); return;}
        running.set(item!.id, after); total = total.plus(row.total_cost_minor);
        rows.push({client_line_id: row.client_line_id, ingredient_id: item!.id, base_quantity: base.toFixed(), base_unit: item!.base_unit, total_cost_minor: row.total_cost_minor,
          unit_cost: new D(row.total_cost_minor).div(new D(10).pow(settings.minor_digits)).div(base).toFixed(9), ingredient_version: item!.version, before_quantity: before.toFixed(), after_quantity: after.toFixed()});
      });
      if (total.gt(Number.MAX_SAFE_INTEGER)) field('/draft/items', 'Receipt total exceeds the supported range.');
      if (fields.length) return finish(fail(422, 'validation_failed', 'Check the highlighted fields.', fields));
      if (previewRequest) {
        const result: PurchasePreview = {id: `fixture_inventory_preview_${crypto.randomUUID()}`, expires_at: new Date(Date.now() + 300000).toISOString(), currency: settings.currency,
          minor_digits: settings.minor_digits, total_cost_minor: total.toNumber(), items: rows};
        previews.set(result.id, {input: canonical(draft), result}); return json(result);
      }
      const preview = previews.get(body.preview_id);
      if (!preview || preview.input !== canonical(draft) || Date.parse(preview.result.expires_at) <= Date.now() || !('items' in preview.result)) return stale();
      for (const row of preview.result.items) {const item = ingredients.find(item => item.id === row.ingredient_id)!; if (row.ingredient_version !== item.version) return finish(conflict(item, row.ingredient_version));}
      const now = new Date().toISOString(), receipt: Purchase = {id: `fixture_purchase_${crypto.randomUUID()}`, reference: `DEV-P${String(purchases.length + 1).padStart(4,'0')}`, purchased_on: draft.purchased_on,
        supplier: draft.supplier.trim(), note: draft.note ?? '', currency: settings.currency, minor_digits: settings.minor_digits, total_cost_minor: total.toNumber(), items: [], operation_id: key!, recorded_at: now, recorded_by: 'Admin'};
      rows.forEach((row, i) => {
        const item = ingredients.find(item => item.id === row.ingredient_id)!;
        const movement: Movement = {id: `fixture_movement_${crypto.randomUUID()}`, ingredient_id: item.id, delta_base_quantity: row.base_quantity, before_quantity: row.before_quantity, after_quantity: row.after_quantity,
          type: 'purchase', reason: receipt.reference, purchase_id: receipt.id, preparation_id: null, corrects_movement_id: null, operation_id: key!, recorded_at: now, recorded_by: 'Admin'};
        const {client_line_id: _client, ...input} = draft.items[i];
        const entry = {...input, id: crypto.randomUUID(), ingredient_name: item.name, base_unit: item.base_unit, base_quantity: row.base_quantity, unit_cost: row.unit_cost, stock_movement_id: movement.id};
        receipt.items.push(entry); movements.push(movement); prices.push({...entry, purchase_id: receipt.id, reference: receipt.reference, supplier: receipt.supplier, purchased_on: receipt.purchased_on, recorded_at: now, currency: receipt.currency, minor_digits: receipt.minor_digits});
      });
      const changed = [...running].map(([id, stock]) => {const item = ingredients.find(item => item.id === id)!; item.stock_on_hand = stock.toFixed(); item.version++;
        const latest = prices.filter(row => row.ingredient_id === id).sort((a,b) => b.purchased_on.localeCompare(a.purchased_on) || b.recorded_at.localeCompare(a.recorded_at) || b.id.localeCompare(a.id))[0];
        item.latest_unit_cost = latest.unit_cost; item.latest_purchase_date = latest.purchased_on; refresh(item); return item;});
      purchases.push(receipt); return finish(json({purchase: receipt, ingredients: changed}, 201), 'purchase', receipt.id);
    }
    return fail(404, 'not_found', 'Inventory action unavailable.');
  };
}
