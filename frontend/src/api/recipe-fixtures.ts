import Decimal from 'decimal.js';
import type {BusinessSettings, FieldError, Food, MenuVariant} from './types';
import {canonicalFixture as canonical} from './fixture-protocol';
import type {Ingredient, Price} from '../inventory/types';
import type {Estimate, Recipe, RecipeItem, RecipeYield} from '../recipes/types';

const D = Decimal.clone({precision: 60, rounding: Decimal.ROUND_HALF_UP});
type Handler = (url: URL, init?: RequestInit) => Promise<Response | null>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
const units = (base: string) => base === 'g' ? ['g', 'kg'] : base === 'ml' ? ['ml', 'l'] : ['piece'];
const quantity = (value: unknown, unit: string) => typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(value)
  && new D(value).gt(0) && new D(value).lte(Number.MAX_SAFE_INTEGER) && (unit !== 'piece' || new D(value).isInteger());

export function createRecipeFixtures({menu, inventory, settings, recipeIds}: {menu: Handler; inventory: Handler; settings: BusinessSettings; recipeIds: Map<string, string>}): Handler {
  const recipes = new Map<string, Recipe>();
  // Menu and inventory records are read through their own fixture handlers, as a backend would read its own tables.
  async function read<T>(handler: Handler, path: string): Promise<T | null> {
    const response = await handler(new URL(`http://fixture.local/api/v1${path}`)); return response?.ok ? await response.json() as T : null;
  }
  async function findVariant(id: string): Promise<MenuVariant | null> {
    for (let page = 1; ; page++) {
      const result = await read<{items: Food[]; has_next: boolean}>(menu, `/foods?limit=100&page=${page}`); if (!result) return null;
      for (const food of result.items) {const variant = food.variants.find(item => item.id === id); if (variant) return variant;}
      if (!result.has_next) return null;
    }
  }
  const ingredient = (id: string) => read<Ingredient>(inventory, `/ingredients/${encodeURIComponent(id)}`);
  async function present(recipe: Recipe): Promise<Recipe> {
    return {...recipe, items: await Promise.all(recipe.items.map(async item => ({...item, ingredient_name: (await ingredient(item.ingredient_id))?.name ?? item.ingredient_name})))};
  }
  return async (url, init) => {
    const match = url.pathname.replace('/api/v1', '').match(/^\/variants\/([^/]+)\/(recipe|estimate)$/), method = init?.method ?? 'GET';
    if (!match) return null;
    const fail = (status: number, code: string, message: string, field_errors: FieldError[] = [], details = {}) => json({error: {code, message, field_errors, details, request_id: 'recipe-development-fixture'}}, status);
    if (!settings.capabilities.recipes || !settings.capabilities.inventory) return fail(403, 'forbidden', 'Recipe workflow unavailable.');
    const variant = await findVariant(decodeURIComponent(match[1]));
    if (!variant) return fail(404, 'not_found', 'Variant not found.');
    const saved = recipes.get(variant.id), sellingYield: RecipeYield = {quantity: 1, selling_unit: variant.selling_unit, package_contents: variant.package_contents};
    if (match[2] === 'recipe' && method === 'GET') return saved ? json(await present(saved)) : fail(404, 'not_found', 'Recipe not found.');
    if (match[2] === 'estimate' && method === 'GET') {
      const estimate: Estimate = {variant_id: variant.id, recipe_version: saved?.version ?? null, currency: settings.currency, selling_price_minor: variant.price_minor,
        ingredient_cost_minor: null, ingredient_contribution_minor: null, complete: false, missing: [], basis: [], calculated_at: new Date().toISOString()};
      // A recipe written for a different selling format does not describe this variant.
      if (!saved || canonical(saved.yield) !== canonical(sellingYield)) return json({...estimate, missing: [{code: 'recipe_missing', ingredient_id: null, variant_id: variant.id}]});
      let total = new D(0);
      for (const item of (await present(saved)).items) {
        const latest = (await read<{items: Price[]}>(inventory, `/ingredients/${encodeURIComponent(item.ingredient_id)}/prices?limit=1`))?.items[0];
        const row = {ingredient_id: item.ingredient_id, ingredient_name: item.ingredient_name, base_unit: item.base_unit, base_quantity: new D(item.quantity).times(['kg', 'l'].includes(item.unit) ? 1000 : 1)};
        if (!latest) {
          estimate.missing.push({code: 'price_missing', ingredient_id: item.ingredient_id, variant_id: variant.id});
          estimate.basis.push({...row, base_quantity: row.base_quantity.toFixed(), purchase_id: null, purchase_line_id: null, purchased_on: null, unit_cost: null, estimated_cost: null}); continue;
        }
        // Cost from the unrounded receipt basis, never from the nine-decimal display cost.
        const amount = row.base_quantity.times(latest.total_cost_minor).div(new D(10).pow(latest.minor_digits).times(latest.base_quantity));
        total = total.plus(amount);
        estimate.basis.push({...row, base_quantity: row.base_quantity.toFixed(), purchase_id: latest.purchase_id, purchase_line_id: latest.id, purchased_on: latest.purchased_on, unit_cost: latest.unit_cost, estimated_cost: amount.toFixed(9)});
      }
      if (estimate.missing.length) return json(estimate);
      const cost = total.times(new D(10).pow(settings.minor_digits)).toDecimalPlaces(0).toNumber();
      return json({...estimate, ingredient_cost_minor: cost, ingredient_contribution_minor: variant.price_minor - cost, complete: true});
    }
    if (match[2] !== 'recipe' || method !== 'PUT') return fail(404, 'not_found', 'Recipe action unavailable.');
    let body: any;
    try {body = JSON.parse(String(init?.body)); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();} catch {return fail(400, 'invalid_json', 'Send a JSON object.');}
    const fields: FieldError[] = [], field = (path: string, message: string) => fields.push({path, code: 'invalid', message}), rows: RecipeItem[] = [];
    Object.keys(body).filter(key => !['expected_version', 'yield', 'items'].includes(key)).forEach(key => field(`/${key}`, 'Unknown field.'));
    const expected = body.expected_version;
    if (expected !== null && (!Number.isSafeInteger(expected) || expected < 1) || !saved && expected !== null) field('/expected_version', saved ? 'Send the recipe version being replaced.' : 'Send a null version when creating a recipe.');
    if (canonical(body.yield) !== canonical(sellingYield)) field('/yield', 'Recipe yield must be exactly one current selling unit of this variant.');
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 100) field('/items', 'Enter 1 to 100 recipe ingredients.');
    else for (const [i, row] of body.items.entries()) {
      const prefix = `/items/${i}`;
      if (!row || typeof row !== 'object' || Array.isArray(row)) {field(prefix, 'Enter an ingredient row.'); continue;}
      Object.keys(row).filter(key => !['ingredient_id', 'quantity', 'unit'].includes(key)).forEach(key => field(`${prefix}/${key}`, 'Unknown field.'));
      const item = typeof row.ingredient_id === 'string' ? await ingredient(row.ingredient_id) : null;
      if (!item) {field(`${prefix}/ingredient_id`, 'Choose an ingredient.'); continue;}
      if (rows.some(existing => existing.ingredient_id === item.id)) {field(`${prefix}/ingredient_id`, 'Each ingredient may appear once.'); continue;}
      if (!units(item.base_unit).includes(row.unit)) {field(`${prefix}/unit`, 'Unit must match the ingredient dimension.'); continue;}
      if (!quantity(row.quantity, row.unit)) {field(`${prefix}/quantity`, 'Enter a positive quantity with up to three decimal places; pieces are whole counts.'); continue;}
      rows.push({ingredient_id: item.id, ingredient_name: item.name, base_unit: item.base_unit, quantity: row.quantity, unit: row.unit});
    }
    if (fields.length) return fail(422, 'validation_failed', 'Check the highlighted fields.', fields);
    if (saved && expected !== saved.version) return fail(409, 'version_conflict', 'Another staff member changed this recipe.', [],
      {resource_type: 'recipe', resource_id: saved.id, expected_version: expected, current_version: saved.version, latest_resource: await present(saved)});
    const now = new Date().toISOString();
    const recipe: Recipe = {id: saved?.id ?? `fixture_recipe_${crypto.randomUUID()}`, version: (saved?.version ?? 0) + 1, variant_id: variant.id, yield: sellingYield, items: rows, recorded_at: saved?.recorded_at ?? now, updated_at: now};
    recipes.set(variant.id, recipe); recipeIds.set(variant.id, recipe.id);
    return json(recipe, saved ? 200 : 201);
  };
}
