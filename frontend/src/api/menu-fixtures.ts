import type { Category, Food, MenuVariant, FieldError } from './types';
import { canonicalFixture as canonical, type FixtureOperations } from './fixture-protocol';

const allowed = { allowed: true, reason_code: null, reason: null };
const categories: Category[] = [
  {id: 'beef', name: 'Beef'}, {id: 'chicken', name: 'Chicken'},
  {id: 'fish-more', name: 'Fish, Lumpia & More'}, {id: 'pork', name: 'Pork'},
];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
const errorBody = (code: string, message: string, fields: FieldError[] = [], details = {}) => ({
  error: {code, message, field_errors: fields, details, request_id: 'menu-development-fixture'},
});
export function createMenuFixtures({operations = new Map(), usedVariants = new Set<string>(), recipeIds = new Map<string, string>()}: {operations?: FixtureOperations; usedVariants?: Set<string>; recipeIds?: Map<string, string>} = {}) {
  const foods: Food[] = [];
  const addFood = (id: string, name: string, category_id: string, available = true): Food => {
    const food: Food = {id, name, category_id, available, description: '', version: 1, confirmation_status: 'provisional',
      variants: [], permitted_actions: {edit: {...allowed}, add_variant: {...allowed}}};
    foods.push(food); return food;
  };
  const addVariant = (food: Food, label: string, selling_unit: MenuVariant['selling_unit'], price_minor: number, quantity?: number) => {
    food.variants.push({id: `fixture_variant_${crypto.randomUUID()}`, food_id: food.id, version: 1, label, selling_unit, price_minor,
      available: true, confirmation_status: 'provisional', recipe_id: null,
      package_contents: quantity ? {quantity, unit: 'piece'} : null, permitted_actions: {edit: {...allowed}}});
  };
  const beef = addFood('fixture_caldereta', 'Beef Caldereta', 'beef');
  addVariant(beef, 'Small', 'tray', 6000); addVariant(beef, 'Medium', 'tray', 8000); addVariant(beef, 'Large', 'tray', 10500);
  addVariant(addFood('fixture_fresh_lumpia', 'Fresh Lumpia', 'fish-more'), 'Each', 'piece', 300);
  addVariant(addFood('fixture_shanghai', 'Shanghai Spring Rolls', 'fish-more'), '100 pieces', 'package', 5500, 100);
  addVariant(addFood('fixture_development_skewers', 'Development skewers', 'pork', false), 'Each stick', 'stick', 150);

  return async (url: URL, init?: RequestInit): Promise<Response | null> => {
    const path = url.pathname.replace('/api/v1', '');
    const method = init?.method ?? 'GET';
    const fail = (status: number, code: string, message: string, fields: FieldError[] = [], details = {}) => json(errorBody(code, message, fields, details), status);
    foods.forEach(food => food.variants.forEach(variant => {variant.recipe_id = recipeIds.get(variant.id) ?? null;}));
    if (path.startsWith('/operations/') && method === 'GET') {
      const saved = operations.get(decodeURIComponent(path.slice('/operations/'.length)));
      return saved ? json(saved.operation) : fail(404, 'not_found', 'Operation not found.');
    }
    if (!/^\/(foods|variants|categories)(\/|$)/.test(path)) return null;
    if (method === 'GET') {
      if (path.startsWith('/foods/')) {
        const food = foods.find(item => item.id === decodeURIComponent(path.slice(7)));
        return food ? json(food) : fail(404, 'not_found', 'Food not found.');
      }
      if (path !== '/foods' && path !== '/categories') return fail(404, 'not_found', 'Menu record not found.');
      const page = Number(url.searchParams.get('page') ?? 1);
      const limit = Number(url.searchParams.get('limit') ?? 25);
      const q = (url.searchParams.get('q') ?? '').trim();
      const category = url.searchParams.get('category_id');
      const available = url.searchParams.get('available');
      if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || q.length > 200
        || (available !== null && !['true', 'false'].includes(available)) || (category && !categories.some(item => item.id === category))
        || [...url.searchParams.keys()].some(key => !['page', 'limit', ...(path === '/foods' ? ['q', 'category_id', 'available'] : [])].includes(key))) {
        return fail(422, 'validation_failed', 'Check menu filters.');
      }
      const matches = path === '/categories' ? categories : foods.filter(item => item.name.toLowerCase().includes(q.toLowerCase())
        && (!category || item.category_id === category) && (available === null || item.available === (available === 'true')))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      return json({items: matches.slice((page - 1) * limit, page * limit), page, limit, total: matches.length, has_next: page * limit < matches.length});
    }
    if (!['POST', 'PATCH'].includes(method)) return fail(404, 'not_found', 'Menu action not found.');
    const key = new Headers(init?.headers).get('Idempotency-Key');
    if (!key) return fail(422, 'validation_failed', 'An operation identifier is required.');
    let body: Record<string, unknown>;
    try { body = JSON.parse(String(init?.body)); if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error(); }
    catch { return fail(400, 'invalid_json', 'Send a JSON object.'); }
    const fingerprint = `${method} ${path} ${canonical(body)}`;
    const saved = operations.get(key);
    if (saved) return saved.fingerprint === fingerprint ? json(saved.body, saved.status) : fail(409, 'operation_payload_mismatch', 'This operation belongs to another submission.');
    const foodMatch = path.match(/^\/foods\/([^/]+)$/);
    const variantCreate = path.match(/^\/foods\/([^/]+)\/variants$/);
    const variantMatch = path.match(/^\/variants\/([^/]+)$/);
    const food = foods.find(item => item.id === decodeURIComponent(foodMatch?.[1] ?? variantCreate?.[1] ?? ''));
    const parent = variantMatch ? foods.find(item => item.variants.some(variant => variant.id === decodeURIComponent(variantMatch[1]))) : undefined;
    const variant = parent?.variants.find(item => item.id === decodeURIComponent(variantMatch![1]));
    const isFood = path === '/foods' && method === 'POST' || Boolean(foodMatch && method === 'PATCH');
    const isVariant = Boolean(variantCreate && method === 'POST' || variantMatch && method === 'PATCH');
    let responseBody: unknown;
    let status = method === 'POST' ? 201 : 200;
    let resource: Food | MenuVariant | undefined;
    const fields: FieldError[] = [];
    const field = (name: string, message: string) => fields.push({path: `/${name}`, code: 'invalid', message});
    if (!isFood && !isVariant || (foodMatch || variantCreate) && !food || variantMatch && !variant) {
      status = 404; responseBody = errorBody('not_found', 'Menu record not found.');
    } else {
      const existing = isFood ? food : variant;
      const merged: Record<string, unknown> = {...existing, ...body};
      const keys = isFood ? ['name', 'category_id', 'description', 'available'] : ['label', 'selling_unit', 'price_minor', 'available', 'package_contents'];
      Object.keys(body).filter(key => ![...keys, ...(method === 'PATCH' ? ['expected_version'] : [])].includes(key)).forEach(key => field(key, 'Unknown field.'));
      if (method === 'PATCH' && (!Number.isSafeInteger(body.expected_version) || Number(body.expected_version) < 1)) field('expected_version', 'A record version is required.');
      if (typeof merged.available !== 'boolean') field('available', 'Choose availability.');
      if (isFood) {
        if (typeof merged.name !== 'string' || !merged.name.trim() || merged.name.length > 200) field('name', 'Enter a food name (up to 200 characters).');
        if (!categories.some(item => item.id === merged.category_id)) field('category_id', 'Choose a category.');
        if (merged.description !== undefined && (typeof merged.description !== 'string' || merged.description.length > 2000)) field('description', 'Use up to 2000 characters.');
      } else {
        if (typeof merged.label !== 'string' || !merged.label.trim() || merged.label.length > 200) field('label', 'Enter a variant label (up to 200 characters).');
        if (!['tray', 'piece', 'stick', 'package'].includes(String(merged.selling_unit))) field('selling_unit', 'Choose a selling unit.');
        if (!Number.isSafeInteger(merged.price_minor) || Number(merged.price_minor) < 0) field('price_minor', 'Enter a nonnegative safe minor-unit amount.');
        const contents = merged.package_contents as {quantity?: number; unit?: string} | null;
        if (variant && usedVariants.has(variant.id) && (merged.selling_unit !== variant.selling_unit || canonical(contents) !== canonical(variant.package_contents))) {
          field('selling_unit', 'Selling unit and package contents cannot change after use on an order.');
        }
        if (merged.selling_unit === 'package' ? !contents || !Number.isSafeInteger(contents.quantity) || Number(contents.quantity) < 1 || contents.unit !== 'piece' : contents !== null) {
          field('package_contents/quantity', 'Packages require a positive whole piece count; other units have no package contents.');
        }
      }
      if (fields.length) {status = 422; responseBody = errorBody('validation_failed', 'Check the highlighted fields.', fields);}
      else if (existing && body.expected_version !== existing.version) {
        status = 409; responseBody = errorBody('version_conflict', 'Another staff member changed this record.', [],
          {resource_type: isFood ? 'food' : 'variant', resource_id: existing.id, expected_version: body.expected_version,
            current_version: existing.version, latest_resource: existing});
      } else if (isFood) {
        resource = food ?? addFood(`fixture_food_${crypto.randomUUID()}`, String(body.name).trim(), String(body.category_id));
        Object.assign(resource, {name: String(merged.name).trim(), category_id: merged.category_id, description: merged.description ?? '',
          available: merged.available, version: food ? food.version + 1 : 1, confirmation_status: 'provisional'});
        responseBody = resource;
      } else {
        resource = variant ?? {id: `fixture_variant_${crypto.randomUUID()}`, food_id: food!.id, version: 1, recipe_id: null,
          confirmation_status: 'provisional', permitted_actions: {edit: {...allowed}}} as MenuVariant;
        Object.assign(resource, {label: String(merged.label).trim(), selling_unit: merged.selling_unit, price_minor: merged.price_minor,
          available: merged.available, package_contents: merged.package_contents, version: variant ? variant.version + 1 : 1, confirmation_status: 'provisional'});
        if (!variant) food!.variants.push(resource as MenuVariant);
        (parent ?? food)!.version++;
        responseBody = resource;
      }
    }
    // Snapshot operation results so later edits cannot rewrite an earlier replay.
    const snapshot = JSON.parse(JSON.stringify(responseBody));
    const now = new Date().toISOString();
    operations.set(key, {fingerprint, body: snapshot, status, operation: {operation_id: key, state: status < 400 ? 'succeeded' : 'rejected',
      resource_type: resource ? isFood ? 'food' : 'variant' : null, resource_id: resource?.id ?? null,
      result: status < 400 ? {http_status: status, body: snapshot} : null,
      error: status >= 400 ? {http_status: status, ...snapshot} : null, started_at: now, completed_at: now}});
    return json(snapshot, status);
  };
}
