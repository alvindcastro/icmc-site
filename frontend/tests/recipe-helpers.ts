import {createApiClient} from '../src/api/client';
import {createFixtureTransport} from '../src/api/fixtures';
import type {Food, MenuVariant, PageResult} from '../src/api/types';

export const yieldOf = (variant: Pick<MenuVariant, 'selling_unit' | 'package_contents'>) => ({quantity: 1, selling_unit: variant.selling_unit, package_contents: variant.package_contents});
// Medium Beef Caldereta (8000 minor units) with a Flour ingredient; by default 2 kg bought for 2400 on 2026-10-07.
export async function recipeSeed(options: {purchase?: boolean; recipe?: boolean; preparation?: boolean} = {}) {
  const fixture = createFixtureTransport({latency: 0, preparation: options.preparation});
  const api = createApiClient({baseUrl: '/api/v1', transport: fixture.fetch});
  const signIn = async () => {const session = await api.request<{csrf_token: string}>('/auth/sign-in', {method: 'POST', body: {username: 'admin', token: 'local-admin-token'}}); api.setCsrfToken(session.csrf_token);};
  await signIn();
  const food = (await api.request<PageResult<Food>>('/foods?limit=100')).items.find(item => item.name === 'Beef Caldereta')!;
  const variant = food.variants.find(item => item.label === 'Medium')!;
  const ingredient = (name: string, base_unit = 'g') => api.request<any>('/ingredients', {method: 'POST', operationId: crypto.randomUUID(), body: {name, base_unit, low_stock_threshold: null}});
  const buy = async (ingredientId: string, changes: Record<string, unknown> = {}, purchased_on = '2026-10-07') => {
    const draft = {purchased_on, supplier: 'Market', note: '', items: [{client_line_id: crypto.randomUUID(), ingredient_id: ingredientId, quantity: '2', unit: 'kg', pack_contents: null, total_cost_minor: 2400, ...changes}]};
    const preview = await api.request<any>('/purchases/preview', {method: 'POST', body: {draft}});
    return (await api.request<any>('/purchases', {method: 'POST', operationId: crypto.randomUUID(), body: {draft, preview_id: preview.id}})).purchase;
  };
  const put = (items: {ingredient_id: string; quantity: string; unit: string}[], expected_version: number | null = null, target: MenuVariant = variant) =>
    api.request<any>(`/variants/${target.id}/recipe`, {method: 'PUT', body: {expected_version, yield: yieldOf(target), items}});
  const flour = await ingredient('Flour');
  const purchase = options.purchase === false ? null : await buy(flour.id);
  const recipe = options.recipe ? await put([{ingredient_id: flour.id, quantity: '750', unit: 'g'}]) : null;
  const signOut = async () => {await api.request('/auth/sign-out', {method: 'POST', body: {}}); api.clearCredentials();};
  return {fixture, api, food, variant, flour, purchase, recipe, ingredient, buy, put, signIn, signOut};
}
