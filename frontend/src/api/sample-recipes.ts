import type {Food} from './types';

type Handler = (url: URL, init?: RequestInit) => Promise<Response | null>;
// Lorem ipsum stands in for ingredients and quantities the business has not supplied; none of this is a real recipe.
const ingredients = [['Lorem', 'g'], ['Ipsum', 'g'], ['Dolor', 'ml'], ['Amet', 'piece']] as const;
const receipt = [['Lorem', '2', 'kg', 2400], ['Ipsum', '1', 'kg', 800], ['Dolor', '1', 'l', 400], ['Amet', '12', 'piece', 600]] as const;
// One selling unit per variant; every tray size is written out separately rather than scaled from another.
const recipes: Record<string, [string, string, string][]> = {
  'Beef Caldereta/Small': [['Lorem', '500', 'g'], ['Dolor', '100', 'ml']],
  'Beef Caldereta/Medium': [['Lorem', '750', 'g'], ['Dolor', '150', 'ml']],
  'Beef Caldereta/Large': [['Lorem', '1', 'kg'], ['Dolor', '0.2', 'l']],
  'Fresh Lumpia/Each': [['Ipsum', '40', 'g'], ['Amet', '1', 'piece']],
  'Shanghai Spring Rolls/100 pieces': [['Ipsum', '0.9', 'kg'], ['Amet', '6', 'piece']],
  'Development skewers/Each stick': [['Ipsum', '60', 'g']],
};

// Seeds through the fixture handlers themselves, so placeholders pass the same validation as staff entries.
export async function seedSampleRecipes({menu, inventory, recipes: recipeBook}: {menu: Handler; inventory: Handler; recipes: Handler}) {
  async function call<T>(handler: Handler, path: string, method = 'GET', body?: unknown, key?: string): Promise<T> {
    const response = await handler(new URL(`http://fixture.local/api/v1${path}`), {method, headers: key ? {'Idempotency-Key': key} : {}, body: body === undefined ? undefined : JSON.stringify(body)});
    if (!response?.ok) throw new Error(`Placeholder recipe seed failed at ${method} ${path}.`);
    return await response.json() as T;
  }
  const ids = new Map<string, string>();
  for (const [name, base_unit] of ingredients) ids.set(name, (await call<{id: string}>(inventory, '/ingredients', 'POST', {name, base_unit, low_stock_threshold: null}, `sample-ingredient-${name}`)).id);
  const draft = {purchased_on: '2026-10-01', supplier: 'Lorem ipsum supplier', note: 'Placeholder development receipt.',
    items: receipt.map(([name, quantity, unit, total_cost_minor]) => ({client_line_id: `sample-${name}`, ingredient_id: ids.get(name)!, quantity, unit, pack_contents: null, total_cost_minor}))};
  const preview = await call<{id: string}>(inventory, '/purchases/preview', 'POST', {draft});
  await call(inventory, '/purchases', 'POST', {draft, preview_id: preview.id}, 'sample-purchase');
  for (const food of (await call<{items: Food[]}>(menu, '/foods?limit=100')).items) for (const variant of food.variants) {
    const rows = recipes[`${food.name}/${variant.label}`]; if (!rows) continue;
    await call(recipeBook, `/variants/${encodeURIComponent(variant.id)}/recipe`, 'PUT', {expected_version: null,
      yield: {quantity: 1, selling_unit: variant.selling_unit, package_contents: variant.package_contents}, items: rows.map(([name, quantity, unit]) => ({ingredient_id: ids.get(name)!, quantity, unit}))});
  }
}
