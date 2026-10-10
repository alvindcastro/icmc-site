import {createApiClient} from '../src/api/client';
import {createFixtureTransport} from '../src/api/fixtures';
export async function inventorySeed(base = 'g', name = 'Flour', threshold: string | null = '100') {
  const fixture = createFixtureTransport({latency: 0});
  const api = createApiClient({baseUrl: '/api/v1', transport: fixture.fetch});
  const session = await api.request<{csrf_token: string}>('/auth/sign-in', {method: 'POST', body: {username: 'admin', token: 'local-admin-token'}}); api.setCsrfToken(session.csrf_token);
  const item = await api.request<any>('/ingredients', {method: 'POST', operationId: crypto.randomUUID(), body: {name, base_unit: base, low_stock_threshold: threshold}});
  await api.request('/auth/sign-out', {method: 'POST'}); api.clearCredentials();
  return {fixture, api, item};
}
export async function purchaseSeed() {
  const seed = await inventorySeed(); const {api,item} = seed;
  const session = await api.request<{csrf_token:string}>('/auth/sign-in',{method:'POST',body:{username:'admin',token:'local-admin-token'}}); api.setCsrfToken(session.csrf_token);
  const draft = {purchased_on:'2026-10-07',supplier:'Market',note:'',items:[{client_line_id:'line',ingredient_id:item.id,quantity:'2',unit:'kg',pack_contents:null,total_cost_minor:2400}]};
  const preview = await api.request<any>('/purchases/preview',{method:'POST',body:{draft}}); const result = await api.request<any>('/purchases',{method:'POST',operationId:'seed-purchase',body:{draft,preview_id:preview.id}});
  await api.request('/auth/sign-out',{method:'POST'}); api.clearCredentials(); return {...seed,result};
}
