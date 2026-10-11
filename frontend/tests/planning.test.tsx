import {fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {MemoryRouter, useLocation} from 'react-router-dom';
import {describe, expect, it, vi} from 'vitest';
import {App} from '../src/App';
import {createApiClient} from '../src/api/client';
import type {FetchTransport} from '../src/api/types';
import {planningSeed} from './planning-helpers';

type Seed = Awaited<ReturnType<typeof planningSeed>>;
function Location() {const route = useLocation(); return <output aria-label="Current route">{route.pathname + route.search}</output>;}
const day = '/planning?date_from=2026-10-10&date_to=2026-10-10';
const shop = '/planning/shopping-list?date_from=2026-10-10&date_to=2026-10-10';
async function start(seed: Seed, path = day, transport: FetchTransport = seed.fixture.fetch) {
  await seed.signOut();
  const client = createApiClient({baseUrl: '/api/v1', transport}), user = userEvent.setup();
  render(<MemoryRouter initialEntries={[path]}><App client={client} mode="fixtures" /><Location /></MemoryRouter>);
  await user.type(await screen.findByLabelText('Token'), 'local-admin-token'); await user.click(screen.getByRole('button', {name: 'Sign in'}));
  return {client, user};
}
const cells = (row: HTMLElement) => within(row).getAllByRole('cell').map(cell => cell.textContent);
const cook = () => within(screen.getByRole('region', {name: 'What to cook'}));
const needs = () => within(screen.getByRole('region', {name: 'Ingredients needed'}));
const loaded = () => screen.findByRole('region', {name: 'Ingredients needed'});
const withPlan = (seed: Seed, change: (plan: any) => void): FetchTransport => async (input, init) => {
  const response = await seed.fixture.fetch(input, init);
  if (!String(input).includes('/planning') || !response.ok) return response;
  const plan = await response.json(); change(plan); return new Response(JSON.stringify(plan));
};

describe('preparation planning workflow', () => {
  it('shows what to cook and the ingredients needed for the selected business date', async () => {
    const seed = await planningSeed(), saved = await seed.order('2026-10-10', [[seed.medium, 2]]); await start(seed);
    expect(await screen.findByRole('heading', {name: 'Planning'})).toBeVisible(); expect(screen.getByRole('link', {name: 'Planning'})).toBeVisible();
    await loaded(); const row = cook().getByRole('row', {name: /Beef Caldereta/});
    expect(within(row).getByText('Medium / 1 tray')).toBeVisible(); expect(cells(row).slice(0, 3)).toEqual(['2', '0', '2']);
    expect(within(row).getByRole('link', {name: saved.reference})).toHaveAttribute('href', `/orders/${saved.id}`); expect(within(row).getByText('2 remaining / Confirmed')).toBeVisible();
    const flour = needs().getByRole('row', {name: /Flour/});
    expect(within(flour).getByRole('link', {name: 'Flour'})).toHaveAttribute('href', `/ingredients/${seed.flour.id}`);
    expect(cells(flour)).toEqual(['2000 g', '0 g', '1500 g', '2000 g', 'None']);
    expect(screen.getByText('Complete')).toBeVisible(); expect(screen.getByText('Oct 10, 2026')).toBeVisible();
    expect(screen.getByLabelText('From date')).toHaveValue('2026-10-10'); expect(screen.getByLabelText('To date')).toHaveValue('2026-10-10'); expect(screen.getByText('America/Los_Angeles')).toBeVisible();
  });

  it('shows earlier commitments, the stock left after them and shortages, and follows a changed period in the URL', async () => {
    const seed = await planningSeed();
    await seed.order('2026-10-08', [[seed.medium, 2]]); await seed.order('2026-10-09', [[seed.medium, 1]]); await seed.order('2026-10-10', [[seed.medium, 1]]); await start(seed);
    await loaded(); const flour = needs().getByRole('row', {name: /Flour/});
    expect(cells(flour).slice(0, 4)).toEqual(['2000 g', '2250 g', '750 g', '-250 g']);
    expect(within(flour).getByText('750 g this period')).toBeVisible(); expect(within(flour).getByText('1000 g through this period')).toBeVisible();
    expect(cells(cook().getByRole('row', {name: /Beef Caldereta/})).slice(0, 3)).toEqual(['1', '0', '1']);
    fireEvent.change(screen.getByLabelText('From date'), {target: {value: '2026-10-08'}});
    await waitFor(() => expect(screen.getByLabelText('Current route')).toHaveTextContent('/planning?date_from=2026-10-08&date_to=2026-10-10'));
    await waitFor(() => expect(cells(cook().getByRole('row', {name: /Beef Caldereta/})).slice(0, 3)).toEqual(['4', '0', '4']));
    expect(cells(needs().getByRole('row', {name: /Flour/})).slice(0, 4)).toEqual(['2000 g', '0 g', '3000 g', '2000 g']); expect(screen.getByText('Oct 8, 2026 to Oct 10, 2026')).toBeVisible();
    fireEvent.change(screen.getByLabelText('From date'), {target: {value: '2026-10-12'}});
    await waitFor(() => expect(screen.getByLabelText('Current route')).toHaveTextContent('/planning?date_from=2026-10-12&date_to=2026-10-12'));
    expect(await screen.findByText('Nothing to prepare for this period.')).toBeVisible(); expect(cells(needs().getByRole('row', {name: /Flour/})).slice(0, 4)).toEqual(['2000 g', '3000 g', '0 g', '-1000 g']);
  });

  it('marks demand without a recipe incomplete with links to the recipe editor and the affected order', async () => {
    const seed = await planningSeed(), mixed = await seed.order('2026-10-10', [[seed.medium, 1], [seed.small, 2]]); await start(seed);
    const warning = within(await screen.findByRole('alert'));
    expect(warning.getByText('Planning is incomplete. Quantities below are a lower bound until every ordered variant has a recipe.')).toBeVisible();
    expect(warning.getByRole('link', {name: 'Add recipe for Small of Beef Caldereta'})).toHaveAttribute('href', `/menu/${seed.food.id}/variants/${seed.small.id}/recipe`);
    expect(warning.getByRole('link', {name: mixed.reference})).toHaveAttribute('href', `/orders/${mixed.id}`);
    expect(screen.getByText('Incomplete')).toBeVisible(); expect(screen.queryByText('Complete')).not.toBeInTheDocument();
    expect(cook().getAllByRole('row', {name: /Beef Caldereta/})).toHaveLength(2); expect(cells(needs().getByRole('row', {name: /Flour/}))[2]).toBe('750 g');
  });

  it('says plainly when nothing needs preparing and defaults to the business date', async () => {
    const seed = await planningSeed(), today = (await seed.api.request<any>('/dashboard')).business_date; await start(seed, '/planning');
    expect(await screen.findByText('Nothing to prepare for this period.')).toBeVisible(); expect(screen.getByText('No ingredient demand for this period.')).toBeVisible();
    expect(screen.getByText('Complete')).toBeVisible(); expect(screen.getByLabelText('From date')).toHaveValue(today); expect(screen.getByLabelText('To date')).toHaveValue(today);
  });

  it('summarises preparation on the dashboard for its date and links to planning', async () => {
    const seed = await planningSeed(); await seed.order('2026-10-08', [[seed.medium, 1]]); await seed.order('2026-10-10', [[seed.medium, 2]]);
    const {user} = await start(seed, '/dashboard?date=2026-10-10');
    const summary = within(await screen.findByRole('region', {name: 'Preparation'}));
    expect(await summary.findByText('2 units of 1 variant')).toBeVisible(); expect(summary.getByText('1 ingredient short')).toBeVisible(); expect(summary.queryByText('Incomplete')).not.toBeInTheDocument();
    expect(summary.getByRole('link', {name: 'Open planning'})).toHaveAttribute('href', day);
    await user.click(summary.getByRole('link', {name: 'Open planning'}));
    expect(await screen.findByRole('heading', {name: 'Planning'})).toBeVisible(); expect(screen.getByLabelText('From date')).toHaveValue('2026-10-10');
  });

  it('flags an incomplete dashboard summary and an idle day', async () => {
    const seed = await planningSeed(); await seed.order('2026-10-10', [[seed.small, 1]]); await start(seed, '/dashboard?date=2026-10-10');
    const summary = within(await screen.findByRole('region', {name: 'Preparation'}));
    expect(await summary.findByText('Incomplete')).toBeVisible(); expect(summary.getByText('1 variant without a recipe')).toBeVisible();
    expect(summary.getByText('1 unit of 1 variant')).toBeVisible(); expect(summary.getByText('None')).toBeVisible();
  });

  it('rejects a plan that hides a shortage as a recoverable error', async () => {
    const seed = await planningSeed(); await seed.order('2026-10-10', [[seed.medium, 3]]); let wrong = true;
    const {user} = await start(seed, day, withPlan(seed, plan => {if (wrong) plan.ingredients[0].period_shortage = '0';}));
    expect(await screen.findByText('The server returned an invalid planning response.')).toBeVisible(); expect(screen.queryByRole('region', {name: 'What to cook'})).not.toBeInTheDocument();
    wrong = false; await user.click(screen.getByRole('button', {name: 'Retry'}));
    expect(await within(await screen.findByRole('region', {name: 'Ingredients needed'})).findByText('250 g this period')).toBeVisible();
  });

  it('shows the backend rejection of an oversized period with a way back', async () => {
    const seed = await planningSeed(); await start(seed, '/planning?date_from=2026-01-01&date_to=2027-06-01');
    expect(await screen.findByText('Choose a planning period of at most 366 days.')).toBeVisible();
    fireEvent.change(screen.getByLabelText('To date'), {target: {value: ''}});
    expect(await screen.findByText('Nothing to prepare for this period.')).toBeVisible(); expect(screen.getByLabelText('Current route')).toHaveTextContent('/planning');
  });

  it('lists what to buy for the period with stock and commitments, prints it and returns to the same plan', async () => {
    const seed = await planningSeed(); await seed.order('2026-10-08', [[seed.medium, 2]]); await seed.order('2026-10-10', [[seed.medium, 2]]);
    const print = vi.spyOn(window, 'print').mockImplementation(() => {}); const {user} = await start(seed, shop);
    const list = within(await screen.findByRole('region', {name: 'Printable shopping list'}));
    expect(list.getByRole('heading', {name: 'Shopping list'})).toBeVisible(); expect(list.getByText('Oct 10, 2026 / America/Los_Angeles')).toBeVisible(); expect(list.getByText('Complete')).toBeVisible();
    const flour = list.getByRole('row', {name: /Flour/});
    expect(cells(flour)).toEqual(['1000 g', '2000 g', '1500 g', '1500 g']); expect(within(flour).getByRole('link', {name: 'Flour'})).toHaveAttribute('href', `/ingredients/${seed.flour.id}`);
    await user.click(screen.getByRole('button', {name: 'Print shopping list'})); expect(print).toHaveBeenCalledOnce();
    expect(screen.getByRole('link', {name: 'Back to planning'})).toHaveAttribute('href', day);
    await user.click(screen.getByRole('link', {name: 'Back to planning'})); expect(await screen.findByRole('heading', {name: 'Planning'})).toBeVisible(); expect(screen.getByLabelText('From date')).toHaveValue('2026-10-10');
  });

  it('prints an incomplete shopping list as a lower bound with a link to the missing recipe', async () => {
    const seed = await planningSeed(); await seed.order('2026-10-10', [[seed.medium, 3], [seed.small, 1]]); await start(seed, shop);
    const list = within(await screen.findByRole('region', {name: 'Printable shopping list'})), warning = within(list.getByRole('alert'));
    expect(warning.getByText('This list is incomplete. Quantities are a lower bound until every ordered variant has a recipe.')).toBeVisible();
    expect(warning.getByRole('link', {name: 'Add recipe for Small of Beef Caldereta'})).toHaveAttribute('href', `/menu/${seed.food.id}/variants/${seed.small.id}/recipe`);
    expect(list.getByText('Incomplete')).toBeVisible(); expect(cells(list.getByRole('row', {name: /Flour/}))[0]).toBe('250 g');
  });

  it('says when nothing needs buying and still allows printing', async () => {
    const seed = await planningSeed(); await seed.order('2026-10-10', [[seed.medium, 1]]); await start(seed, shop);
    expect(await screen.findByText('Nothing to buy for this period.')).toBeVisible(); expect(screen.getByRole('button', {name: 'Print shopping list'})).toBeEnabled();
  });

  it('links to the shopping list from planning and the dashboard, keeping the period', async () => {
    const seed = await planningSeed(); await seed.order('2026-10-10', [[seed.medium, 3]]); const {user} = await start(seed, '/dashboard?date=2026-10-10');
    const summary = within(await screen.findByRole('region', {name: 'Preparation'}));
    expect(summary.getByRole('link', {name: 'Shopping list'})).toHaveAttribute('href', shop);
    await user.click(summary.getByRole('link', {name: 'Open planning'})); await loaded();
    expect(screen.getByRole('link', {name: 'Shopping list'})).toHaveAttribute('href', shop);
    await user.click(screen.getByRole('link', {name: 'Shopping list'}));
    expect(await screen.findByRole('heading', {name: 'Shopping list'})).toBeVisible(); expect(screen.getByLabelText('Current route')).toHaveTextContent(shop);
  });

  it('rejects a shopping list that understates a shortage and keeps printing off until it is verified', async () => {
    const seed = await planningSeed(); await seed.order('2026-10-10', [[seed.medium, 3]]); let wrong = true;
    const {user} = await start(seed, shop, withPlan(seed, list => {if (wrong && list.items) list.items[0].cumulative_shortage = '100';}));
    expect(await screen.findByText('The server returned an invalid shopping list response.')).toBeVisible(); expect(screen.getByRole('button', {name: 'Print shopping list'})).toBeDisabled();
    wrong = false; await user.click(screen.getByRole('button', {name: 'Retry'}));
    expect(cells(within(await screen.findByRole('region', {name: 'Printable shopping list'})).getByRole('row', {name: /Flour/}))[0]).toBe('250 g'); expect(screen.getByRole('button', {name: 'Print shopping list'})).toBeEnabled();
  });

  it('hides planning navigation, the page and the dashboard summary without the capability', async () => {
    const seed = await planningSeed(); await seed.order('2026-10-10', [[seed.medium, 2]]);
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await seed.fixture.fetch(input, init); if (!String(input).endsWith('/settings')) return response;
      const settings = await response.json(); settings.capabilities.planning = false; return new Response(JSON.stringify(settings));
    });
    const {user} = await start(seed, day, transport);
    expect(await screen.findByText('Planning is not enabled for this workspace.')).toBeVisible(); expect(screen.queryByRole('link', {name: 'Planning'})).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', {name: 'Dashboard'})); await screen.findByRole('heading', {name: 'Dashboard'}); await screen.findByRole('heading', {name: 'Low physical stock'});
    expect(screen.queryByRole('region', {name: 'Preparation'})).not.toBeInTheDocument();
    expect(transport.mock.calls.some(([input]) => String(input).includes('/planning'))).toBe(false);
  });
});
