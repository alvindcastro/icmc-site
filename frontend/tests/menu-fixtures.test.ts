import { describe, expect, it } from 'vitest';
import { createApiClient } from '../src/api/client';
import { createFixtureTransport } from '../src/api/fixtures';

async function client() {
  const fixture = createFixtureTransport({ latency: 0 });
  const api = createApiClient({ baseUrl: '/api/v1', transport: fixture.fetch });
  const session = await api.request<{csrf_token: string}>('/auth/sign-in', { method: 'POST', body: {username: 'admin', token: 'local-admin-token'} });
  api.setCsrfToken(session.csrf_token);
  return api;
}
const draft = { name: 'Test food', category_id: 'beef', description: 'Notes', available: true };

describe('menu development contract', () => {
  it('serves paginated categories, provisional foods, search/category/availability filters and no results', async () => {
    const api = await client();
    await expect(api.request('/settings')).resolves.toMatchObject({ capabilities: { menu: true } });
    const categories = await api.request<any>('/categories?limit=2');
    expect(categories).toMatchObject({page: 1, limit: 2, total: 4, has_next: true});
    expect(categories.items.map((item: any) => item.name)).toEqual(['Beef', 'Chicken']);
    const foods = await api.request<any>('/foods?q=caldereta&category_id=beef&available=true');
    expect(foods.items).toHaveLength(1);
    expect(foods.items[0]).toMatchObject({ name: 'Beef Caldereta', confirmation_status: 'provisional' });
    expect(foods.items[0].variants.every((item: any) => item.confirmation_status === 'provisional')).toBe(true);
    await expect(api.request('/foods?q=not-on-menu')).resolves.toMatchObject({ items: [], total: 0 });
    await expect(api.request('/foods?available=false')).resolves.toMatchObject({ total: 1 });
    await expect(api.request('/foods?limit=1&page=2')).resolves.toMatchObject({ page: 2, total: 4, has_next: true });
    await expect(api.request('/foods?available=invalid')).rejects.toMatchObject({ status: 422 });
  });

  it('creates food and all four units, updates price and availability, and returns authoritative versions', async () => {
    const api = await client();
    const food = await api.request<any>('/foods', {method: 'POST', body: draft, operationId: 'food-create'});
    expect(food).toMatchObject({ ...draft, version: 1, variants: [], confirmation_status: 'provisional' });
    for (const selling_unit of ['tray', 'piece', 'stick', 'package']) {
      const variant = await api.request<any>(`/foods/${food.id}/variants`, {method: 'POST', operationId: `variant-${selling_unit}`,
        body: {label: selling_unit, selling_unit, price_minor: 1234, available: true,
          package_contents: selling_unit === 'package' ? {quantity: 100, unit: 'piece'} : null} });
      expect(variant).toMatchObject({food_id: food.id, version: 1, selling_unit, price_minor: 1234, recipe_id: null});
    }
    const updated = await api.request<any>(`/foods/${food.id}`);
    expect(updated.variants).toHaveLength(4);
    const variant = updated.variants[0];
    await expect(api.request(`/variants/${variant.id}`, {method: 'PATCH', operationId: 'variant-edit',
      body: {expected_version: variant.version, price_minor: 2222, available: false}})).resolves.toMatchObject({version: 2, price_minor: 2222, available: false});
    const current = await api.request<any>(`/foods/${food.id}`);
    await expect(api.request(`/foods/${food.id}`, {method: 'PATCH', operationId: 'food-edit',
      body: {expected_version: current.version, available: false}})).resolves.toMatchObject({available: false});
    await expect(api.request(`/foods/${food.id}`)).resolves.toMatchObject({variants: expect.arrayContaining([expect.objectContaining({available: false, price_minor: 2222})])});
  });

  it('rejects invalid fields, package contents, unsafe amounts, missing operation IDs and stale versions without side effects', async () => {
    const api = await client();
    await expect(api.request('/foods', {method: 'POST', body: draft})).rejects.toMatchObject({status: 422});
    await expect(api.request('/foods', {method: 'POST', operationId: 'bad-food', body: {...draft, name: ''}}))
      .rejects.toMatchObject({status: 422, fieldErrors: expect.arrayContaining([expect.objectContaining({path: '/name'})])});
    const food = await api.request<any>('/foods', {method: 'POST', body: draft, operationId: 'new-food'});
    for (const [key, body] of [
      ['package', {label: 'Box', selling_unit: 'package', price_minor: 100, available: true, package_contents: {quantity: 0, unit: 'piece'}}],
      ['overflow', {label: 'Each', selling_unit: 'piece', price_minor: Number.MAX_SAFE_INTEGER + 1, available: true, package_contents: null}],
    ] as const) {
      await expect(api.request(`/foods/${food.id}/variants`, {method: 'POST', operationId: key, body})).rejects.toMatchObject({status: 422});
    }
    await api.request(`/foods/${food.id}`, {method: 'PATCH', operationId: 'first-edit', body: {expected_version: 1, name: 'Latest name'}});
    await expect(api.request(`/foods/${food.id}`, {method: 'PATCH', operationId: 'stale-edit', body: {expected_version: 1, name: 'Stale name'}}))
      .rejects.toMatchObject({status: 409, code: 'version_conflict', details: {latest_resource: expect.objectContaining({name: 'Latest name'})}});
    await expect(api.request(`/foods/${food.id}`)).resolves.toMatchObject({name: 'Latest name', variants: []});
  });

  it('deduplicates menu saves and reconciles committed results without accepting a different payload', async () => {
    const api = await client();
    const request = {method: 'POST', body: draft, operationId: 'same-key'};
    const first = await api.request<any>('/foods', request);
    await expect(api.request('/foods', request)).resolves.toEqual(first);
    await expect(api.request('/foods', {...request, body: {...draft, name: 'Different'}})).rejects.toMatchObject({code: 'operation_payload_mismatch'});
    await expect(api.request('/operations/same-key')).resolves.toMatchObject({state: 'succeeded', result: {http_status: 201, body: first}});
    await expect(api.request('/foods?q=Test%20food')).resolves.toMatchObject({total: 1});
    await expect(api.request('/operations/missing')).rejects.toMatchObject({status: 404});
  });
});
