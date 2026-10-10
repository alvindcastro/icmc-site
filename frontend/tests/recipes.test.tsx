import {render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {MemoryRouter, useLocation} from 'react-router-dom';
import {describe, expect, it, vi} from 'vitest';
import {App} from '../src/App';
import {createApiClient} from '../src/api/client';
import {createFixtureTransport} from '../src/api/fixtures';
import type {FetchTransport} from '../src/api/types';
import {recipeSeed} from './recipe-helpers';

type Seed = Awaited<ReturnType<typeof recipeSeed>>;
function Location() {const route = useLocation(); return <output aria-label="Current route">{route.pathname + route.search}</output>;}
const recipePath = (seed: Seed) => `/menu/${seed.food.id}/variants/${seed.variant.id}/recipe`;
const isPut = (input: RequestInfo | URL, init?: RequestInit) => String(input).endsWith('/recipe') && init?.method === 'PUT';
async function start(seed: Seed, path = recipePath(seed), transport: FetchTransport = seed.fixture.fetch) {
  await seed.signOut();
  const client = createApiClient({baseUrl: '/api/v1', transport}); const user = userEvent.setup();
  render(<MemoryRouter initialEntries={[path]}><App client={client} mode="fixtures" /><Location /></MemoryRouter>);
  await user.type(await screen.findByLabelText('Token'), 'local-admin-token'); await user.click(screen.getByRole('button', {name: 'Sign in'}));
  return {client, user};
}
const estimate = () => within(screen.getByRole('region', {name: 'Ingredient estimate'}));
const amount = (label: string) => estimate().getByText(label).parentElement!;
async function addFlour(user: ReturnType<typeof userEvent.setup>, quantity: string) {
  await user.type(screen.getByLabelText('Find ingredient'), 'flour'); await user.click(await screen.findByRole('button', {name: 'Add Flour'}));
  await user.type(screen.getByLabelText('Quantity of Flour'), quantity);
}
const settingsWith = (seed: Seed, change: (settings: any) => void): FetchTransport => async (input, init) => {
  const response = await seed.fixture.fetch(input, init);
  if (!String(input).endsWith('/settings')) return response;
  const settings = await response.json(); change(settings); return new Response(JSON.stringify(settings));
};

describe('recipe and ingredient estimate workflow', () => {
  it('links every variant to its recipe from Menu & Recipes and marks a variant without one as incomplete', async () => {
    const seed = await recipeSeed(); const {user} = await start(seed, '/menu?q=caldereta');
    const food = await screen.findByRole('region', {name: 'Beef Caldereta'});
    expect(screen.getByRole('link', {name: 'Menu & Recipes'})).toBeVisible();
    expect(within(food).getAllByText('No recipe')).toHaveLength(3);
    await user.click(within(food).getByRole('link', {name: 'Add recipe for Medium of Beef Caldereta'}));
    expect(await screen.findByRole('heading', {name: 'Beef Caldereta'})).toBeVisible();
    expect(screen.getByLabelText('Current route')).toHaveTextContent(recipePath(seed));
    expect(screen.getByText('Medium / 1 tray')).toBeVisible(); expect(screen.getByText('No recipe yet.')).toBeVisible();
    expect(screen.getByText('Sample development recipes')).toBeVisible();
    expect(estimate().getByText('Incomplete', {selector: '.status-label'})).toBeVisible(); expect(estimate().getByText('No recipe for this variant.')).toBeVisible();
    expect(amount('Selling price')).toHaveTextContent('$80.00'); expect(amount('Estimated ingredient cost')).toHaveTextContent('Incomplete');
    expect(amount('Ingredient contribution estimate')).toHaveTextContent('Incomplete'); expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
    expect(screen.getByRole('link', {name: 'Back to menu'})).toHaveAttribute('href', '/menu?q=caldereta');
  });

  it('validates and saves a one-tray recipe, then shows the $9 estimate, its purchase basis and the contribution', async () => {
    const seed = await recipeSeed(); const {user} = await start(seed);
    await user.click(await screen.findByRole('button', {name: 'Add recipe'}));
    expect(screen.getByText('Enter quantities for exactly 1 tray. Each selling size needs its own recipe.')).toBeVisible();
    await user.click(screen.getByRole('button', {name: 'Save recipe'})); expect(screen.getByText('Add at least one ingredient.')).toBeVisible();
    await addFlour(user, '0'); expect(screen.getByRole('button', {name: 'Add Flour'})).toBeDisabled();
    await user.click(screen.getByRole('button', {name: 'Save recipe'}));
    expect(screen.getByText('Enter a positive quantity with up to three decimal places; pieces are whole counts.')).toBeVisible(); expect(screen.getByLabelText('Quantity of Flour')).toHaveFocus();
    await user.clear(screen.getByLabelText('Quantity of Flour')); await user.type(screen.getByLabelText('Quantity of Flour'), '750');
    await user.click(screen.getByRole('button', {name: 'Save recipe'}));
    expect(await screen.findByText('Recipe saved.')).toBeVisible(); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const recipe = within(screen.getByRole('region', {name: 'Recipe'}));
    expect(recipe.getByText('Makes exactly 1 tray.')).toBeVisible(); expect(recipe.getByText('750 g')).toBeVisible(); expect(recipe.getByText('Recipe version 1')).toBeVisible();
    expect(recipe.getByRole('link', {name: 'Flour'})).toHaveAttribute('href', `/ingredients/${seed.flour.id}`);
    await waitFor(() => expect(estimate().getByText('Complete')).toBeVisible());
    expect(amount('Selling price')).toHaveTextContent('$80.00'); expect(amount('Estimated ingredient cost')).toHaveTextContent('$9.00'); expect(amount('Ingredient contribution estimate')).toHaveTextContent('$71.00');
    expect(estimate().getByText(/It is not net profit/)).toBeVisible();
    const basis = within(estimate().getByRole('row', {name: /Flour/}));
    expect(basis.getByText('Oct 7, 2026')).toBeVisible(); expect(basis.getByText('$12.00 / kg')).toBeVisible(); expect(basis.getByText('$9.00')).toBeVisible();
    expect(basis.getByRole('link', {name: 'Purchase receipt'})).toHaveAttribute('href', `/purchases/${seed.purchase.id}`);
  });

  it('keeps an unpriced ingredient incomplete with a link to its record, never a zero cost', async () => {
    const seed = await recipeSeed(), salt = await seed.ingredient('Salt');
    await seed.put([{ingredient_id: seed.flour.id, quantity: '750', unit: 'g'}, {ingredient_id: salt.id, quantity: '5', unit: 'g'}]); await start(seed);
    await screen.findByRole('region', {name: 'Ingredient estimate'}); expect(estimate().getByText('Incomplete', {selector: '.status-label'})).toBeVisible();
    expect(amount('Estimated ingredient cost')).toHaveTextContent('Incomplete'); expect(amount('Ingredient contribution estimate')).toHaveTextContent('Incomplete');
    const warning = within(estimate().getByRole('alert'));
    expect(warning.getByText(/No purchase price for/)).toBeVisible(); expect(warning.getByRole('link', {name: 'Salt'})).toHaveAttribute('href', `/ingredients/${salt.id}`);
    const unpriced = within(estimate().getByRole('row', {name: /Salt/}));
    expect(unpriced.getByText('No purchase price')).toBeVisible(); expect(unpriced.getAllByText('Unknown')).toHaveLength(2);
    expect(within(estimate().getByRole('row', {name: /Flour/})).getByText('$9.00')).toBeVisible(); expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('shows a known zero purchase cost as a complete $0.00 estimate', async () => {
    const seed = await recipeSeed({purchase: false}); await seed.buy(seed.flour.id, {total_cost_minor: 0});
    await seed.put([{ingredient_id: seed.flour.id, quantity: '750', unit: 'g'}]); await start(seed);
    await screen.findByRole('region', {name: 'Ingredient estimate'}); expect(estimate().getByText('Complete')).toBeVisible();
    expect(amount('Estimated ingredient cost')).toHaveTextContent('$0.00'); expect(amount('Ingredient contribution estimate')).toHaveTextContent('$80.00');
  });

  it('edits a saved recipe in kilograms and refreshes the estimate and the menu link', async () => {
    const seed = await recipeSeed({recipe: true}); const {user} = await start(seed);
    await user.click(await screen.findByRole('button', {name: 'Edit recipe'}));
    expect(screen.getByLabelText('Quantity of Flour')).toHaveValue('750'); expect(screen.getByLabelText('Unit for Flour')).toHaveValue('g');
    await user.selectOptions(screen.getByLabelText('Unit for Flour'), 'kg'); await user.clear(screen.getByLabelText('Quantity of Flour')); await user.type(screen.getByLabelText('Quantity of Flour'), '0.5');
    await user.click(screen.getByRole('button', {name: 'Save recipe'})); expect(await screen.findByText('Recipe saved.')).toBeVisible();
    const recipe = within(screen.getByRole('region', {name: 'Recipe'}));
    expect(recipe.getByText('0.5 kg')).toBeVisible(); expect(recipe.getByText('Recipe version 2')).toBeVisible();
    await waitFor(() => expect(amount('Estimated ingredient cost')).toHaveTextContent('$6.00')); expect(amount('Ingredient contribution estimate')).toHaveTextContent('$74.00');
    expect(within(estimate().getByRole('row', {name: /Flour/})).getByText('500 g')).toBeVisible();
    await user.click(screen.getByRole('link', {name: 'Back to menu'}));
    expect(await screen.findByRole('link', {name: 'Recipe and estimate for Medium of Beef Caldereta'})).toBeVisible();
    expect(screen.getByRole('link', {name: 'Add recipe for Small of Beef Caldereta'})).toBeVisible();
  });

  it('shows a selling price changed in the menu in the estimate without changing the ingredient cost', async () => {
    const seed = await recipeSeed({recipe: true}); const {user} = await start(seed, '/menu?q=caldereta');
    await user.click(await screen.findByRole('button', {name: 'Edit variant Medium of Beef Caldereta'}));
    await user.clear(screen.getByLabelText('Price (USD)')); await user.type(screen.getByLabelText('Price (USD)'), '90'); await user.click(screen.getByRole('button', {name: 'Save variant'}));
    expect(await screen.findByText('Variant saved.')).toBeVisible();
    await user.click(await screen.findByRole('link', {name: 'Recipe and estimate for Medium of Beef Caldereta'})); await screen.findByRole('region', {name: 'Ingredient estimate'});
    expect(amount('Selling price')).toHaveTextContent('$90.00'); expect(amount('Estimated ingredient cost')).toHaveTextContent('$9.00'); expect(amount('Ingredient contribution estimate')).toHaveTextContent('$81.00');
  });

  it.each(['Keep draft with reviewed version', 'Replace draft with latest'])('reviews the latest recipe after a version conflict: %s', async choice => {
    const seed = await recipeSeed({recipe: true}); let raced = false;
    const {user} = await start(seed, recipePath(seed), async (input, init) => {
      // Another staff member saves 600 g just before this draft arrives.
      if (isPut(input, init) && !raced) {raced = true; await seed.fixture.fetch(input, {...init, body: JSON.stringify({...JSON.parse(String(init!.body)), items: [{ingredient_id: seed.flour.id, quantity: '600', unit: 'g'}]})});}
      return seed.fixture.fetch(input, init);
    });
    await user.click(await screen.findByRole('button', {name: 'Edit recipe'})); await user.clear(screen.getByLabelText('Quantity of Flour')); await user.type(screen.getByLabelText('Quantity of Flour'), '500');
    await user.click(screen.getByRole('button', {name: 'Save recipe'}));
    const latest = within((await screen.findByRole('heading', {name: 'Latest saved recipe'})).closest('section')!);
    expect(latest.getByText('600 g')).toBeVisible(); expect(screen.getByLabelText('Quantity of Flour')).toHaveValue('500'); expect(screen.getByRole('button', {name: 'Save recipe'})).toBeDisabled();
    await user.click(screen.getByRole('button', {name: choice}));
    expect(screen.getByLabelText('Quantity of Flour')).toHaveValue(choice.startsWith('Keep') ? '500' : '600');
    if (choice.startsWith('Replace')) {await user.clear(screen.getByLabelText('Quantity of Flour')); await user.type(screen.getByLabelText('Quantity of Flour'), '650');}
    await user.click(screen.getByRole('button', {name: 'Save recipe'})); expect(await screen.findByText('Recipe saved.')).toBeVisible();
    const recipe = within(screen.getByRole('region', {name: 'Recipe'}));
    expect(recipe.getByText(choice.startsWith('Keep') ? '500 g' : '650 g')).toBeVisible(); expect(recipe.getByText('Recipe version 3')).toBeVisible();
  });

  it('resolves a lost reply by rereading the saved recipe instead of saving twice', async () => {
    const seed = await recipeSeed(); const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await seed.fixture.fetch(input, init); if (isPut(input, init)) throw new TypeError('lost response'); return response;
    });
    const {user} = await start(seed, recipePath(seed), transport);
    await user.click(await screen.findByRole('button', {name: 'Add recipe'})); await addFlour(user, '750'); await user.click(screen.getByRole('button', {name: 'Save recipe'}));
    expect(await screen.findByText('Save result unconfirmed. Check the saved recipe before saving again.')).toBeVisible();
    expect(screen.getByRole('button', {name: 'Save recipe'})).toBeDisabled(); expect(screen.getByLabelText('Quantity of Flour')).toBeDisabled();
    await user.click(screen.getByRole('button', {name: 'Check saved recipe'}));
    expect(await screen.findByText('Recipe saved.')).toBeVisible(); expect(within(screen.getByRole('region', {name: 'Recipe'})).getByText('750 g')).toBeVisible();
    expect(transport.mock.calls.filter(([input, init]) => isPut(input, init))).toHaveLength(1); expect(sessionStorage.length).toBe(0);
  });

  it('reports an unsent recipe as not saved and lets the same draft be saved again', async () => {
    const seed = await recipeSeed({recipe: true}); let offline = true;
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {if (offline && isPut(input, init)) throw new TypeError('offline before submission'); return seed.fixture.fetch(input, init);});
    const {user} = await start(seed, recipePath(seed), transport);
    await user.click(await screen.findByRole('button', {name: 'Edit recipe'})); await user.clear(screen.getByLabelText('Quantity of Flour')); await user.type(screen.getByLabelText('Quantity of Flour'), '500');
    await user.click(screen.getByRole('button', {name: 'Save recipe'})); await user.click(await screen.findByRole('button', {name: 'Check saved recipe'}));
    expect(await screen.findByText('The recipe was not saved. Review it and save again.')).toBeVisible();
    expect(screen.getByLabelText('Quantity of Flour')).toHaveValue('500'); expect(screen.getByLabelText('Quantity of Flour')).toBeEnabled();
    offline = false; await user.click(screen.getByRole('button', {name: 'Save recipe'})); expect(await screen.findByText('Recipe saved.')).toBeVisible();
    expect(within(screen.getByRole('region', {name: 'Recipe'})).getByText('Recipe version 2')).toBeVisible();
    expect(transport.mock.calls.filter(([input, init]) => isPut(input, init))).toHaveLength(2);
  });

  it('retains the draft and focuses the field for a backend-rejected quantity', async () => {
    const seed = await recipeSeed(); const {user} = await start(seed, recipePath(seed), async (input, init) => isPut(input, init)
      ? new Response(JSON.stringify({error: {code: 'validation_failed', message: 'Check the highlighted fields.', field_errors: [{path: '/items/0/quantity', code: 'invalid', message: 'Quantity is too large.'}], details: {}}}), {status: 422})
      : seed.fixture.fetch(input, init));
    await user.click(await screen.findByRole('button', {name: 'Add recipe'})); await addFlour(user, '750'); await user.click(screen.getByRole('button', {name: 'Save recipe'}));
    expect(await screen.findByText('Quantity is too large.')).toBeVisible(); expect(screen.getByText('Check the highlighted fields.')).toBeVisible();
    await waitFor(() => expect(screen.getByLabelText('Quantity of Flour')).toHaveFocus()); expect(screen.getByLabelText('Quantity of Flour')).toHaveValue('750');
  });

  it('protects a dirty recipe from dismissal and reload, discarding only on confirmation', async () => {
    const seed = await recipeSeed(); const transport = vi.fn(seed.fixture.fetch); const {user} = await start(seed, recipePath(seed), transport);
    await user.click(await screen.findByRole('button', {name: 'Add recipe'})); await addFlour(user, '750');
    const unload = new Event('beforeunload', {cancelable: true}); window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true);
    await user.keyboard('{Escape}'); expect(screen.getByRole('heading', {name: 'Discard changes?'})).toBeVisible();
    await user.click(screen.getByRole('button', {name: 'Keep editing'})); expect(screen.getByLabelText('Quantity of Flour')).toHaveValue('750');
    await user.click(screen.getByRole('button', {name: 'Remove Flour'})); expect(screen.queryByLabelText('Quantity of Flour')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', {name: 'Add Flour'})); await user.keyboard('{Escape}'); await user.click(screen.getByRole('button', {name: 'Discard changes'}));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(screen.getByText('No recipe yet.')).toBeVisible();
    expect(transport.mock.calls.some(([input, init]) => isPut(input, init))).toBe(false);
  });

  it('explains a recipe written for another selling format instead of estimating from it', async () => {
    const seed = await recipeSeed({recipe: true}); await seed.api.request(`/variants/${seed.variant.id}`, {method: 'PATCH', operationId: crypto.randomUUID(),
      body: {expected_version: seed.variant.version, selling_unit: 'package', package_contents: {quantity: 10, unit: 'piece'}}});
    const {user} = await start(seed);
    expect(await screen.findByText('This recipe was written for 1 tray. Review and save it for 1 package / 10 pieces.')).toBeVisible();
    expect(estimate().getByText('No recipe for the current selling format.')).toBeVisible(); expect(amount('Estimated ingredient cost')).toHaveTextContent('Incomplete');
    await user.click(screen.getByRole('button', {name: 'Edit recipe'})); expect(screen.getByText('Enter quantities for exactly 1 package / 10 pieces. Each selling size needs its own recipe.')).toBeVisible();
    await user.click(screen.getByRole('button', {name: 'Save recipe'})); expect(await screen.findByText('Recipe saved.')).toBeVisible();
    await waitFor(() => expect(amount('Estimated ingredient cost')).toHaveTextContent('$9.00')); expect(screen.getByText('Makes exactly 1 package / 10 pieces.')).toBeVisible();
  });

  it('rejects an estimate for another variant as a recoverable error', async () => {
    const seed = await recipeSeed({recipe: true}); let wrong = true;
    const {user} = await start(seed, recipePath(seed), async (input, init) => {
      const response = await seed.fixture.fetch(input, init);
      if (!wrong || !String(input).endsWith('/estimate')) return response;
      const body = await response.json(); return new Response(JSON.stringify({...body, variant_id: 'another-variant'}));
    });
    expect(await screen.findByText('The estimate does not match this variant.')).toBeVisible(); expect(screen.queryByText('$9.00')).not.toBeInTheDocument();
    wrong = false; await user.click(screen.getByRole('button', {name: 'Retry'})); await screen.findByRole('region', {name: 'Ingredient estimate'}); expect(estimate().getByText('Complete')).toBeVisible();
  });

  it.each(['recipes', 'inventory'])('hides recipe navigation, links and requests when the %s capability is disabled', async capability => {
    const seed = await recipeSeed(); const transport = vi.fn(settingsWith(seed, settings => {settings.capabilities[capability] = false;}));
    await start(seed, recipePath(seed), transport);
    expect(await screen.findByText('Recipes are not enabled for this workspace.')).toBeVisible();
    expect(screen.getByRole('link', {name: 'Menu'})).toBeVisible(); expect(screen.queryByRole('link', {name: 'Menu & Recipes'})).not.toBeInTheDocument();
    expect(transport.mock.calls.some(([input]) => /\/(recipe|estimate)$/.test(String(input)))).toBe(false);
  });

  it('shows no recipe links on the menu without the recipes capability', async () => {
    const seed = await recipeSeed(); await start(seed, '/menu', settingsWith(seed, settings => {settings.capabilities.recipes = false;}));
    expect(await screen.findByRole('region', {name: 'Beef Caldereta'})).toBeVisible();
    expect(screen.queryByRole('link', {name: /recipe/i})).not.toBeInTheDocument(); expect(screen.queryByText('No recipe')).not.toBeInTheDocument();
  });

  it('opens the sample fixture with lorem ipsum placeholder recipes on every listed variant', async () => {
    const client = createApiClient({baseUrl: '/api/v1', transport: createFixtureTransport({latency: 0, samples: true}).fetch}), user = userEvent.setup();
    render(<MemoryRouter initialEntries={['/menu?q=caldereta']}><App client={client} mode="fixtures" /></MemoryRouter>);
    await user.type(await screen.findByLabelText('Token'), 'local-admin-token'); await user.click(screen.getByRole('button', {name: 'Sign in'}));
    const food = await screen.findByRole('region', {name: 'Beef Caldereta'}); expect(within(food).queryByText('No recipe')).not.toBeInTheDocument();
    await user.click(within(food).getByRole('link', {name: 'Recipe and estimate for Medium of Beef Caldereta'})); await screen.findByRole('region', {name: 'Ingredient estimate'});
    expect(screen.getByText('Sample development recipes')).toBeVisible(); expect(within(screen.getByRole('region', {name: 'Recipe'})).getByRole('link', {name: 'Lorem'})).toBeVisible();
    expect(amount('Estimated ingredient cost')).toHaveTextContent('$9.60'); expect(amount('Ingredient contribution estimate')).toHaveTextContent('$70.40');
  });

  it('fails closed for live recipes until business currency and timezone are confirmed', async () => {
    const seed = await recipeSeed({recipe: true}); const transport = vi.fn(settingsWith(seed, settings => {settings.environment = 'live';}));
    await start(seed, recipePath(seed), transport);
    expect(await screen.findByText('Business currency and timezone require confirmation before live recipes and estimates.')).toBeVisible();
    expect(transport.mock.calls.some(([input]) => /\/(recipe|estimate)$/.test(String(input)))).toBe(false);
    expect(screen.queryByText('Sample development recipes')).not.toBeInTheDocument();
  });
});
