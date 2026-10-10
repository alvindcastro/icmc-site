import {act, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {MemoryRouter} from 'react-router-dom';
import {describe, expect, it} from 'vitest';
import {App} from '../src/App';
import {createApiClient} from '../src/api/client';
import {createFixtureTransport} from '../src/api/fixtures';
import type {FetchTransport} from '../src/api/types';
import {inventorySeed, purchaseSeed} from './inventory-helpers';
import {behindServer} from './helpers';

async function start(transport: FetchTransport = createFixtureTransport({latency: 0}).fetch, path = '/ingredients', heading = 'Ingredients') {
  const api = createApiClient({baseUrl: '/api/v1', transport}); const user = userEvent.setup();
  render(<MemoryRouter initialEntries={[path]}><App client={api} mode="fixtures" /></MemoryRouter>);
  await user.type(await screen.findByLabelText('Token'), 'local-admin-token'); await user.click(screen.getByRole('button', {name: 'Sign in'}));
  await screen.findByRole('heading', {name: heading}); return {api, user};
}
async function fillPurchase(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', {name: 'Record purchase'}));
  await user.clear(screen.getByLabelText('Purchased on')); await user.type(screen.getByLabelText('Purchased on'), '2026-10-07');
  await user.type(screen.getByLabelText('Supplier'), 'Market');
  await user.type(screen.getByLabelText('Find ingredient'), 'flour');
  await user.click(await screen.findByRole('button', {name: 'Add Flour'}));
  await user.type(screen.getByLabelText('Quantity 1'), '2'); await user.selectOptions(screen.getByLabelText('Purchase unit 1'), 'kg');
  await user.type(screen.getByLabelText('Total ingredient cost 1 (USD)'), '24');
}

describe('inventory staff workflow', () => {
  it('returns to the protected ingredient route, validates and retains dirty creation, then edits a threshold', async () => {
    const {user} = await start();
    expect(screen.getByRole('link', {name: 'Ingredients'})).toBeVisible(); expect(screen.getByRole('link', {name: 'Purchases'})).toBeVisible();
    expect(await screen.findByText('No ingredients yet.')).toBeVisible();
    await user.click(screen.getByRole('button', {name: 'Add ingredient'})); await user.click(screen.getByRole('button', {name: 'Save ingredient'}));
    expect(screen.getByLabelText('Ingredient name')).toHaveFocus();
    await user.type(screen.getByLabelText('Ingredient name'), 'Flour'); await user.type(screen.getByLabelText('Low-stock threshold'), '100');
    await user.keyboard('{Escape}'); expect(screen.getByRole('heading', {name: 'Discard changes?'})).toBeVisible();
    await user.click(screen.getByRole('button', {name: 'Keep editing'})); expect(screen.getByLabelText('Ingredient name')).toHaveValue('Flour');
    await user.click(screen.getByRole('button', {name: 'Save ingredient'})); expect(await screen.findByText('Ingredient saved.')).toBeVisible();
    await screen.findByRole('heading', {name: 'Flour'}); expect(screen.getByText('Unknown')).toBeVisible();
    await user.click(screen.getByRole('button', {name: 'Edit ingredient'})); expect(screen.getByLabelText('Base unit')).toBeDisabled();
    await user.clear(screen.getByLabelText('Low-stock threshold')); await user.click(screen.getByRole('button', {name: 'Save ingredient'}));
    expect(await screen.findByText('Not set')).toBeVisible();
  });
  it('searches and filters low stock without treating an error as empty inventory', async () => {
    const {fixture} = await inventorySeed(); let failed = true;
    const {user} = await start(async (input, init) => String(input).includes('/ingredients?') && failed ? new Response(JSON.stringify({error: {code: 'unavailable', message: 'Inventory unavailable', field_errors: []}}), {status: 503}) : fixture.fetch(input, init));
    expect(await screen.findByText('Inventory unavailable')).toBeVisible(); expect(screen.queryByText('No ingredients yet.')).not.toBeInTheDocument();
    failed = false; await user.click(screen.getByRole('button', {name: 'Retry'})); await screen.findByRole('link', {name: 'Flour'});
    await user.click(screen.getByLabelText('Low stock only')); expect(await screen.findByRole('link', {name: 'Flour'})).toBeVisible();
    await user.type(screen.getByLabelText('Search ingredients'), 'missing'); expect(await screen.findByText('No ingredients match these filters.')).toBeVisible();
    await user.click(screen.getByRole('button', {name: 'Clear inventory filters'})); expect(await screen.findByRole('link', {name: 'Flour'})).toBeVisible();
  });
  it('reviews opening, waste and a linked correction with stock before/after and chronological history', async () => {
    const {fixture, item} = await inventorySeed('piece', 'Egg'); const {user} = await start(fixture.fetch, `/ingredients/${item.id}`, 'Egg');
    await user.click(screen.getByRole('button', {name: 'Opening stock'})); await user.type(screen.getByLabelText('Stock change (piece)'), '10'); await user.type(screen.getByLabelText('Reason'), 'Opening count');
    await user.click(screen.getByRole('button', {name: 'Review movement'})); expect(await screen.findByText('0 piece -> 10 piece')).toBeVisible();
    await user.click(screen.getByRole('button', {name: 'Save movement'})); expect(await screen.findByText('Stock movement saved.')).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', {name: 'Opening stock'})).toBeDisabled());
    await user.click(screen.getByRole('button', {name: 'Record waste'})); await user.type(screen.getByLabelText('Stock change (piece)'), '-2'); await user.type(screen.getByLabelText('Reason'), 'Broken eggs');
    await user.click(screen.getByRole('button', {name: 'Review movement'})); expect(await screen.findByText('10 piece -> 8 piece')).toBeVisible(); expect(screen.getByText('-2 piece')).toBeVisible(); await user.click(screen.getByRole('button', {name: 'Save movement'}));
    await screen.findByText('Broken eggs'); await user.click(screen.getByRole('button', {name: 'Correct stock'}));
    await user.type(screen.getByLabelText('Stock change (piece)'), '1'); await user.type(screen.getByLabelText('Reason'), 'Recount');
    await user.selectOptions(screen.getByLabelText('Related movement'), await screen.findByRole('option', {name: /Broken eggs/}).then(option => (option as HTMLOptionElement).value));
    await user.click(screen.getByRole('button', {name: 'Review movement'})); await screen.findByText('8 piece -> 9 piece'); await user.click(screen.getByRole('button', {name: 'Save movement'}));
    expect(await screen.findByText('Recount')).toBeVisible(); expect(screen.getByRole('link', {name: 'Corrected movement'})).toBeVisible();
  });
  it('reviews 2kg/$24, saves a linked receipt, updates stock and comparable price history', async () => {
    const {fixture, item} = await inventorySeed(); const {user} = await start(fixture.fetch, '/purchases', 'Purchases');
    expect(await screen.findByText('No purchases yet.')).toBeVisible(); await fillPurchase(user);
    await user.click(screen.getByRole('button', {name: 'Review purchase'})); expect(await screen.findByText('2000 g')).toBeVisible(); expect(screen.getByText('$12.00 / kg')).toBeVisible();
    expect(screen.getByText('0 g -> 2000 g')).toBeVisible(); await user.click(screen.getByRole('button', {name: 'Save purchase'}));
    expect(await screen.findByText('Purchase saved.')).toBeVisible(); await screen.findByRole('heading', {name: 'DEV-P0001'});
    expect(screen.getByText('2 kg')).toBeVisible(); await user.click(screen.getByRole('link', {name: 'Flour'}));
    await screen.findByRole('heading', {name: 'Flour'}); expect(screen.getAllByText('$12.00 / kg').length).toBeGreaterThan(0);
    expect(await screen.findByRole('link', {name: 'DEV-P0001'})).toBeVisible(); expect(screen.getByRole('link', {name: 'Purchase receipt'})).toBeVisible();
    await user.click(screen.getByRole('link', {name: 'Purchases'}));
    await user.type(screen.getByLabelText('Supplier filter'), 'missing'); expect(await screen.findByText('No purchases match these filters.')).toBeVisible();
    await user.click(screen.getByRole('button', {name: 'Clear inventory filters'})); expect(await screen.findByRole('link', {name: 'DEV-P0001'})).toBeVisible();
    expect(item.id).toBeTruthy();
  });
  it('handles declared packs and repeatable rows without discarding invalid conversion inputs', async () => {
    const {fixture} = await inventorySeed(); const {user} = await start(fixture.fetch, '/purchases', 'Purchases'); await fillPurchase(user);
    await user.selectOptions(screen.getByLabelText('Purchase unit 1'), 'bag');
    await user.click(screen.getByRole('button', {name: 'Review purchase'})); expect(screen.getByLabelText('Contents per pack 1')).toHaveFocus();
    await user.type(screen.getByLabelText('Contents per pack 1'), '500');
    await user.click(screen.getByRole('button', {name: 'Add Flour'})); await user.type(screen.getByLabelText('Quantity 2'), '1'); await user.type(screen.getByLabelText('Total ingredient cost 2 (USD)'), '0');
    await user.click(screen.getByRole('button', {name: 'Review purchase'})); expect(await screen.findByText('1000 g')).toBeVisible(); expect(screen.getByText('500 g per bag')).toBeVisible();
    await user.click(screen.getByRole('button', {name: 'Back to entry'})); expect(screen.getByLabelText('Contents per pack 1')).toHaveValue('500');
    await user.click(screen.getByRole('button', {name: 'Remove purchase line 2'})); expect(screen.queryByLabelText('Quantity 2')).not.toBeInTheDocument();
  });
  it('adds linked current physical low-stock warnings to the dashboard', async () => {
    const {fixture} = await inventorySeed(); await start(fixture.fetch, '/dashboard', 'Dashboard');
    expect(await screen.findByRole('heading', {name: 'Low physical stock'})).toBeVisible(); expect(await screen.findByRole('link', {name: 'Flour'})).toBeVisible();
    expect(screen.getByRole('link', {name: 'View all low-stock ingredients'})).toHaveAttribute('href', '/ingredients?low_stock=true');
  });
  it('hides unavailable capability navigation and blocks direct purchase routes', async () => {
    const fixture = createFixtureTransport({latency: 0});
    const transport: FetchTransport = async (input, init) => {const response = await fixture.fetch(input, init); if (String(input).endsWith('/settings')) {const settings = await response.json(); settings.capabilities.purchases = false; return new Response(JSON.stringify(settings));} return response;};
    await start(transport, '/purchases', 'Purchases unavailable'); expect(screen.queryByRole('link', {name: 'Purchases'})).not.toBeInTheDocument(); expect(screen.queryByRole('button', {name: 'Record purchase'})).not.toBeInTheDocument();
  });
  it('retains field errors from a failed preview and focuses the backend-rejected field', async () => {
    const {fixture} = await inventorySeed(); const {user} = await start(async (input, init) => String(input).endsWith('/purchases/preview') ? new Response(JSON.stringify({error: {code: 'validation_failed', message: 'Unit rejected', field_errors: [{path: '/draft/items/0/quantity', code: 'invalid', message: 'Check quantity'}]}}), {status: 422}) : fixture.fetch(input, init), '/purchases', 'Purchases');
    await fillPurchase(user); await user.click(screen.getByRole('button', {name: 'Review purchase'})); expect(await screen.findByText('Check quantity')).toBeVisible(); expect(screen.getByLabelText('Quantity 1')).toHaveFocus(); expect(screen.getByLabelText('Supplier')).toHaveValue('Market');
  });
  it('reconciles a committed response loss without submitting a second purchase', async () => {
    const {fixture} = await inventorySeed(); let saves = 0;
    const {user} = await start(async (input, init) => {const response = await fixture.fetch(input, init); if (String(input).endsWith('/purchases') && init?.method === 'POST') {saves++; throw new TypeError('Lost response');} return response;}, '/purchases', 'Purchases');
    await fillPurchase(user); await user.click(screen.getByRole('button', {name: 'Review purchase'})); await screen.findByText('2000 g'); await user.click(screen.getByRole('button', {name: 'Save purchase'}));
    expect(await screen.findByText(/Save result unconfirmed/)).toBeVisible(); expect(screen.getByLabelText('Supplier')).toBeDisabled();
    await user.click(screen.getByRole('button', {name: 'Check save status'})); expect(await screen.findByText('Purchase saved.')).toBeVisible(); expect(saves).toBe(1);
  });
  it('allows only an explicit original-body/key retry after a missing operation lookup', async () => {
    const {fixture} = await inventorySeed(); const attempts: {body: unknown; key: string | null}[] = [];
    const {user} = await start(async (input, init) => {if (String(input).endsWith('/purchases') && init?.method === 'POST') {attempts.push({body: JSON.parse(String(init.body)), key: new Headers(init.headers).get('Idempotency-Key')}); if (attempts.length === 1) throw new TypeError('Offline before submission');} return fixture.fetch(input, init);}, '/purchases', 'Purchases');
    await fillPurchase(user); await user.click(screen.getByRole('button', {name: 'Review purchase'})); await screen.findByText('2000 g'); await user.click(screen.getByRole('button', {name: 'Save purchase'}));
    await screen.findByText(/Save result unconfirmed/); expect(screen.queryByRole('button', {name: 'Retry original save'})).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', {name: 'Check save status'})); await user.click(await screen.findByRole('button', {name: 'Retry original save'}));
    expect(await screen.findByText('Purchase saved.')).toBeVisible(); expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]);
  });
  it('retains a stale purchase draft for explicit latest-stock review and fresh preview', async () => {
    const {fixture} = await inventorySeed(); let once = true;
    const {user} = await start(async (input, init) => {
      if (String(input).endsWith('/purchases') && init?.method === 'POST' && once) {
        once = false; const body = JSON.parse(String(init.body)); const id = body.draft.items[0].ingredient_id;
        const current = await fixture.fetch(`/api/v1/ingredients/${id}`, {method: 'GET'}).then(r => r.json());
        await fixture.fetch(`/api/v1/ingredients/${id}`, {method: 'PATCH', headers: {...Object.fromEntries(new Headers(init.headers)), 'Idempotency-Key': 'concurrent-edit'}, body: JSON.stringify({expected_version: current.version, name: 'Latest flour'})});
      }
      return fixture.fetch(input, init);
    }, '/purchases', 'Purchases');
    await fillPurchase(user); await user.click(screen.getByRole('button', {name: 'Review purchase'})); await screen.findByText('2000 g'); await user.click(screen.getByRole('button', {name: 'Save purchase'}));
    expect(await screen.findByRole('heading', {name: 'Latest saved ingredient'})).toBeVisible(); expect(screen.getByText('Latest flour / 2')).toBeVisible();
    await user.click(screen.getByRole('button', {name: 'Keep draft with reviewed version'})); expect(screen.getByLabelText('Supplier')).toHaveValue('Market');
    await user.click(screen.getByRole('button', {name: 'Review purchase'})); await screen.findByText('2000 g'); await user.click(screen.getByRole('button', {name: 'Save purchase'})); expect(await screen.findByText('Purchase saved.')).toBeVisible();
  });
  it('blocks an orphan operation after reload, stores only its UUID, and never recreates a missing draft', async () => {
    const {fixture} = await inventorySeed(); sessionStorage.setItem('food-reservations:inventory-operation', '00000000-0000-4000-8000-000000000005');
    const {user} = await start(fixture.fetch, '/purchases', 'Purchases'); expect(screen.getByRole('button', {name: 'Record purchase'})).toBeDisabled();
    await user.click(screen.getByRole('button', {name: 'Check save status'})); expect(await screen.findByText(/original draft is no longer available/)).toBeVisible(); expect(screen.getByRole('button', {name: 'Record purchase'})).toBeDisabled();
    expect(sessionStorage.getItem('food-reservations:inventory-operation')).toBe('00000000-0000-4000-8000-000000000005');
  });
  it('blocks unconfirmed live currency/timezone settings for purchases', async () => {
    const fixture = createFixtureTransport({latency: 0});
    await start(async (input, init) => {const response = await fixture.fetch(input, init); if (String(input).endsWith('/settings')) {const settings = await response.json(); settings.environment = 'live'; return new Response(JSON.stringify(settings));} return response;}, '/purchases', 'Purchases');
    expect(await screen.findByText(/Business currency and timezone require confirmation/)).toBeVisible(); expect(screen.queryByRole('button', {name: 'Record purchase'})).not.toBeInTheDocument();
  });
  it('blocks an unverifiable conflict until the latest ingredient is explicitly fetched and reviewed', async () => {
    const {fixture,item} = await inventorySeed(); let fail = true;
    const {user} = await start(async (input, init) => String(input).endsWith('/purchases') && init?.method === 'POST' && fail ? new Response(JSON.stringify({error:{code:'version_conflict',message:'Changed stock',field_errors:[],details:{resource_id:item.id,latest_resource:{id:item.id}}}}),{status:409}) : fixture.fetch(input,init),'/purchases','Purchases');
    await fillPurchase(user); await user.click(screen.getByRole('button',{name:'Review purchase'})); await screen.findByText('2000 g'); await user.click(screen.getByRole('button',{name:'Save purchase'}));
    await screen.findByText(/Latest stock could not be verified/); expect(screen.getByRole('button',{name:'Review purchase'})).toBeDisabled();
    await user.click(screen.getByRole('button',{name:'Retry latest ingredient'})); await screen.findByRole('heading',{name:'Latest saved ingredient'}); await user.click(screen.getByRole('button',{name:'Keep draft with reviewed version'}));
    fail = false; await user.click(screen.getByRole('button',{name:'Review purchase'})); await screen.findByText('2000 g'); await user.click(screen.getByRole('button',{name:'Save purchase'})); expect(await screen.findByText('Purchase saved.')).toBeVisible();
  });
  it.each(['quantity','note'])('reconciles a structurally valid but mismatched saved receipt %s', async field => {
    const {fixture} = await inventorySeed(); const {user} = await start(async(input,init) => {const response = await fixture.fetch(input,init); if (String(input).endsWith('/purchases') && init?.method === 'POST') {const result = await response.json(); if (field === 'quantity') result.purchase.items[0].quantity = '3'; else result.purchase.note = 'Not the reviewed note'; return new Response(JSON.stringify(result),{status:201});} return response;},'/purchases','Purchases');
    await fillPurchase(user); await user.click(screen.getByRole('button',{name:'Review purchase'})); await screen.findByText('2000 g'); await user.click(screen.getByRole('button',{name:'Save purchase'}));
    expect(await screen.findByText(/Save result unconfirmed/)).toBeVisible(); await user.click(screen.getByRole('button',{name:'Check save status'})); expect(await screen.findByText('Purchase saved.')).toBeVisible();
  });
  it('does not read a nonexistent ingredient movement collection during purchase entry', async () => {
    const {fixture} = await inventorySeed(); const paths:string[] = [];
    const {user} = await start(async(input,init) => {paths.push(String(input));return fixture.fetch(input,init);},'/purchases','Purchases'); await fillPurchase(user);
    expect(paths.some(path => path.includes('/ingredients//movements'))).toBe(false);
  });
  it('rejects a preview in a different ingredient dimension and retains the purchase input', async () => {
    const {fixture} = await inventorySeed(); const {user} = await start(async(input,init) => {const response = await fixture.fetch(input,init); if(String(input).endsWith('/purchases/preview')) {const preview = await response.json(); preview.items[0].base_unit='ml'; return new Response(JSON.stringify(preview));}return response;},'/purchases','Purchases'); await fillPurchase(user); await user.click(screen.getByRole('button',{name:'Review purchase'}));
    expect(await screen.findByText(/invalid inventory response/)).toBeVisible(); expect(screen.queryByRole('button',{name:'Save purchase'})).not.toBeInTheDocument(); expect(screen.getByLabelText('Quantity 1')).toHaveValue('2');
  });
  it.each(['movements','prices'])('rejects %s belonging to another ingredient', async collection => {
    const {fixture,item} = await purchaseSeed();
    await start(async(input,init) => {const response = await fixture.fetch(input,init); if(String(input).includes(`/ingredients/${item.id}/${collection}?`)) {const page=await response.json();page.items[0].ingredient_id='another-ingredient';return new Response(JSON.stringify(page));}return response;},`/ingredients/${item.id}`,'Flour');
    expect(await screen.findByText(`${collection === 'movements' ? 'Movement' : 'Price'} history does not match this ingredient.`)).toBeVisible();
  });
  it('clears private purchase input on expiry and ignores a late committed response while retaining only its UUID', async () => {
    const {fixture} = await inventorySeed(); let release: (()=>void) | undefined, posts=0;
    const {api,user} = await start(async(input,init) => {const response = await fixture.fetch(input,init); if(String(input).endsWith('/purchases') && init?.method === 'POST') {posts++;await new Promise<void>(resolve => {release=resolve;});}return response;},'/purchases','Purchases');
    await fillPurchase(user); await user.type(screen.getByLabelText('Purchase note'),'Private receipt note'); await user.click(screen.getByRole('button',{name:'Review purchase'})); await screen.findByText('2000 g'); await user.click(screen.getByRole('button',{name:'Save purchase'}));
    await waitFor(()=>expect(posts).toBe(1)); fixture.expire(); await act(async()=>{await expect(api.request('/auth/session')).rejects.toMatchObject({status:401});});
    expect(await screen.findByRole('heading',{name:'Sign in'})).toBeVisible(); expect(screen.queryByLabelText('Purchase note')).not.toBeInTheDocument();
    const marker=sessionStorage.getItem('food-reservations:inventory-operation');expect(marker).toMatch(/^[0-9a-f-]{36}$/);expect(Object.values(sessionStorage)).not.toContain('Private receipt note');
    await act(async()=>{release?.();}); expect(sessionStorage.getItem('food-reservations:inventory-operation')).toBe(marker);
    await user.type(screen.getByLabelText('Token'),'local-admin-token');await user.click(screen.getByRole('button',{name:'Sign in'}));await screen.findByRole('heading',{name:'Purchases'});expect(screen.getByRole('button',{name:'Record purchase'})).toBeDisabled();expect(posts).toBe(1);
    await user.click(screen.getByRole('button',{name:'Check save status'}));expect(await screen.findByText('Purchase saved.')).toBeVisible();expect(posts).toBe(1);
  });
  it('honors a newly denied edit after explicit conflict review',async()=>{
    const {fixture,item}=await inventorySeed();const latest={...item,version:2,permitted_actions:{...item.permitted_actions,edit:{allowed:false,reason_code:'forbidden',reason:'Ingredient editing is no longer permitted.'}}};
    const {user}=await start(async(input,init)=>String(input).endsWith(`/ingredients/${item.id}`) && init?.method==='PATCH' ? new Response(JSON.stringify({error:{code:'version_conflict',message:'Permission changed',field_errors:[],details:{latest_resource:latest}}}),{status:409}) : fixture.fetch(input,init),`/ingredients/${item.id}`,'Flour');
    await user.click(screen.getByRole('button',{name:'Edit ingredient'}));await user.type(screen.getByLabelText('Ingredient name'),' retained');await user.click(screen.getByRole('button',{name:'Save ingredient'}));await screen.findByRole('heading',{name:'Latest saved ingredient'});await user.click(screen.getByRole('button',{name:'Keep draft with reviewed version'}));
    expect(screen.getByRole('button',{name:'Save ingredient'})).toBeDisabled();expect(screen.getByText('Ingredient editing is no longer permitted.')).toBeVisible();
  });
  it.each(['version','threshold'])('reconciles an ingredient edit with mismatched saved %s',async field=>{
    const {fixture,item}=await inventorySeed();const {user}=await start(async(input,init)=>{const response=await fixture.fetch(input,init);if(String(input).endsWith(`/ingredients/${item.id}`) && init?.method==='PATCH'){const saved=await response.json();if(field==='version')saved.version=1;else saved.low_stock_threshold='100';return new Response(JSON.stringify(saved));}return response;},`/ingredients/${item.id}`,'Flour');
    await user.click(screen.getByRole('button',{name:'Edit ingredient'}));await user.clear(screen.getByLabelText('Low-stock threshold'));await user.type(screen.getByLabelText('Low-stock threshold'),'25');await user.click(screen.getByRole('button',{name:'Save ingredient'}));expect(await screen.findByText(/Save result unconfirmed/)).toBeVisible();await user.click(screen.getByRole('button',{name:'Check save status'}));expect(await screen.findByText('Ingredient saved.')).toBeVisible();
  });
  it('accepts paginated purchase summaries without requiring full receipt items on the list',async()=>{
    const {fixture}=await purchaseSeed();await start(async(input,init)=>{const response=await fixture.fetch(input,init);if(String(input).includes('/purchases?')){const page=await response.json();page.items=page.items.map(({id,reference,supplier,purchased_on,currency,minor_digits,total_cost_minor,recorded_at}:any)=>({id,reference,supplier,purchased_on,currency,minor_digits,total_cost_minor,recorded_at}));return new Response(JSON.stringify(page));}return response;},'/purchases','Purchases');
    expect(await screen.findByRole('link',{name:'DEV-P0001'})).toBeVisible();expect(screen.getByText('Market')).toBeVisible();
  });
  it('confirms before closing an unresolved save and keeps its exact request retryable from the page', async () => {
    const fixture = createFixtureTransport({latency: 0}); const attempts: {body: unknown; key: string | null}[] = [];
    const {user} = await start(async (input, init) => {if (String(input).endsWith('/ingredients') && init?.method === 'POST') {attempts.push({body: JSON.parse(String(init.body)), key: new Headers(init.headers).get('Idempotency-Key')}); if (attempts.length === 1) throw new TypeError('Offline before submission');} return fixture.fetch(input, init);});
    await user.click(screen.getByRole('button', {name: 'Add ingredient'})); await user.type(screen.getByLabelText('Ingredient name'), 'Flour'); await user.click(screen.getByRole('button', {name: 'Save ingredient'}));
    await screen.findByText(/Save result unconfirmed/); await user.keyboard('{Escape}');
    expect(screen.getByText(/still unresolved/)).toBeVisible(); await user.click(screen.getByRole('button', {name: 'Keep editing'})); expect(screen.getByLabelText('Ingredient name')).toHaveValue('Flour');
    await user.keyboard('{Escape}'); await user.click(screen.getByRole('button', {name: 'Discard changes'})); expect(screen.getByRole('button', {name: 'Add ingredient'})).toBeDisabled();
    await user.click(screen.getByRole('button', {name: 'Check save status'})); await user.click(await screen.findByRole('button', {name: 'Retry original save'}));
    expect(await screen.findByText('Ingredient saved.')).toBeVisible(); await screen.findByRole('heading', {name: 'Flour'});
    expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]); expect(sessionStorage.length).toBe(0);
  });
  it('accepts a created ingredient whose zero stock is written with fixed decimals', async () => {
    const fixture = createFixtureTransport({latency: 0});
    const {user} = await start(async (input, init) => {const response = await fixture.fetch(input, init); if (String(input).endsWith('/ingredients') && init?.method === 'POST') {const saved = await response.json(); saved.stock_on_hand = '0.000'; return new Response(JSON.stringify(saved), {status: 201});} return response;});
    await user.click(screen.getByRole('button', {name: 'Add ingredient'})); await user.type(screen.getByLabelText('Ingredient name'), 'Flour'); await user.click(screen.getByRole('button', {name: 'Save ingredient'}));
    expect(await screen.findByText('Ingredient saved.')).toBeVisible(); expect(sessionStorage.length).toBe(0);
  });
  it('saves a reviewed purchase when the device clock runs ahead of the server', async () => {
    const {fixture} = await inventorySeed(); const {user} = await start(behindServer(fixture.fetch, 6 * 60000), '/purchases', 'Purchases');
    await fillPurchase(user); await user.click(screen.getByRole('button', {name: 'Review purchase'})); await screen.findByText('2000 g'); await user.click(screen.getByRole('button', {name: 'Save purchase'}));
    expect(await screen.findByText('Purchase saved.')).toBeVisible();
  });
});
