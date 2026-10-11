import {render, screen, waitFor, within} from '@testing-library/react';
import userEvent, {type UserEvent} from '@testing-library/user-event';
import {MemoryRouter, useLocation} from 'react-router-dom';
import {describe, expect, it} from 'vitest';
import {App} from '../src/App';
import {createApiClient} from '../src/api/client';
import type {FetchTransport} from '../src/api/types';
import {planningSeed} from './planning-helpers';

function Location() {const route = useLocation(); return <output aria-label="Current route">{route.pathname + route.search}</output>;}
const day = '/planning?date_from=2026-10-10&date_to=2026-10-10';
const entry = '/planning/prepare?date_from=2026-10-10&date_to=2026-10-10';
const marker = 'food-reservations:preparation-operation';
// Two Medium trays of Beef Caldereta ordered for 2026-10-10, with 2000 g of Flour in stock.
async function recording(options: {preparation?: boolean} = {preparation: true}) {
  const seed = await planningSeed(options), saved = await seed.order('2026-10-10', [[seed.medium, 2]]);
  return {...seed, saved};
}
type Seed = Awaited<ReturnType<typeof recording>>;
async function start(seed: Seed, path = entry, transport: FetchTransport = seed.fixture.fetch) {
  await seed.signOut();
  const client = createApiClient({baseUrl: '/api/v1', transport}), user = userEvent.setup();
  render(<MemoryRouter initialEntries={[path]}><App client={client} mode="fixtures" /><Location /></MemoryRouter>);
  await user.type(await screen.findByLabelText('Token'), 'local-admin-token'); await user.click(screen.getByRole('button', {name: 'Sign in'}));
  return {client, user};
}
const route = () => screen.getByLabelText('Current route').textContent;
const cells = (row: HTMLElement) => within(row).getAllByRole('cell').map(cell => cell.textContent);
const count = (seed: Seed) => screen.findByLabelText(`Prepared now, ${seed.saved.reference} Medium of Beef Caldereta`);
async function fill(user: UserEvent, seed: Seed, flour: string | null = '0.8', prepared = '1') {
  await user.type(await count(seed), prepared);
  if (flour === null) return;
  await user.click(await screen.findByRole('button', {name: 'Add Flour'})); await user.type(screen.getByLabelText('Flour quantity used'), flour); await user.selectOptions(screen.getByLabelText('Flour unit'), 'kg');
}
const review = async (user: UserEvent) => {await user.click(screen.getByRole('button', {name: 'Review preparation'})); return within(await screen.findByRole('region', {name: 'Review before recording'}));};
const saves = (input: RequestInfo | URL, init?: RequestInit) => String(input).endsWith('/preparations') && init?.method === 'POST';

describe('preparation recording workflow', () => {
  it('offers preparation recording from planning when it is enabled', async () => {
    const seed = await recording(); await start(seed, day);
    expect(await screen.findByRole('link', {name: 'Record preparation'})).toHaveAttribute('href', entry);
  });

  it('does not offer preparation recording once nothing remains to prepare', async () => {
    const seed = await recording(); await seed.prepare(seed.draft(seed.saved, 2, '1.5')); await start(seed, day);
    const row = within(await screen.findByRole('region', {name: 'What to cook'})).getByRole('row', {name: /Beef Caldereta/});
    expect(cells(row).slice(0, 3)).toEqual(['2', '2', '0']); expect(screen.queryByRole('link', {name: 'Record preparation'})).not.toBeInTheDocument();
  });

  it('hides preparation recording while it is disabled', async () => {
    const seed = await recording({}); await start(seed, day);
    await screen.findByRole('region', {name: 'What to cook'}); expect(screen.queryByRole('link', {name: 'Record preparation'})).not.toBeInTheDocument();
  });

  it('explains that the entry page is unavailable while recording is disabled', async () => {
    const seed = await recording({}); await start(seed);
    expect(await screen.findByRole('heading', {name: 'Preparation recording unavailable'})).toBeVisible(); expect(screen.queryByRole('button', {name: 'Review preparation'})).not.toBeInTheDocument();
  });

  it('reviews the stock deduction and records a partial preparation once', async () => {
    const seed = await recording(), {user, client} = await start(seed);
    expect(await screen.findByRole('heading', {name: 'Record preparation'})).toBeVisible();
    const row = within(await screen.findByRole('region', {name: 'Food prepared'})).getByRole('row', {name: /Beef Caldereta/});
    expect(within(row).getByText('Medium / 1 tray')).toBeVisible(); expect(within(row).getByRole('link', {name: seed.saved.reference})).toHaveAttribute('href', `/orders/${seed.saved.id}`);
    expect(within(row).getByText('2 of 2 remaining')).toBeVisible(); expect(within(row).getByText('Confirmed')).toBeVisible();
    await user.type(await count(seed), '1'); await user.click(await screen.findByRole('button', {name: 'Add Flour'}));
    // A newly added ingredient takes focus, so its quantity can be typed straight away.
    expect(screen.getByLabelText('Flour quantity used')).toHaveFocus(); await user.keyboard('0.8'); await user.selectOptions(screen.getByLabelText('Flour unit'), 'kg');
    expect(within(screen.getByRole('region', {name: 'Ingredients used'})).getByText('In stock: 2000 g')).toBeVisible();
    const shown = await review(user);
    expect(shown.getByText('0 -> 1 of 2')).toBeVisible(); expect(shown.getByText('1 remaining')).toBeVisible(); expect(shown.getByText('0.8 kg')).toBeVisible();
    expect(shown.getByText('2000 g -> 1200 g')).toBeVisible(); expect(shown.getByText('$9.60')).toBeVisible(); expect(shown.getByText('Recipe version 1')).toBeVisible();
    // Nothing is deducted by a review.
    await expect(client.request(`/ingredients/${seed.flour.id}`)).resolves.toMatchObject({stock_on_hand: '2000'});
    await user.click(screen.getByRole('button', {name: 'Record preparation'}));
    expect(await screen.findByText('Preparation recorded.')).toBeVisible(); expect(route()).toMatch(/^\/preparations\/fixture_preparation_/); expect(screen.getByRole('heading', {name: 'Preparation record'})).toBeVisible();
    await expect(client.request(`/ingredients/${seed.flour.id}`)).resolves.toMatchObject({stock_on_hand: '1200'});
    const used = within(screen.getByRole('region', {name: 'Ingredients used'}));
    // The record points at the exact stock movement it created.
    const movement = (await client.request<any>(`/ingredients/${seed.flour.id}/movements`)).items[0].id;
    expect(used.getByRole('link', {name: 'Flour'})).toHaveAttribute('href', `/ingredients/${seed.flour.id}?movement_id=${movement}#movement-${movement}`); expect(used.getByText('2000 g -> 1200 g')).toBeVisible();
    await user.click(screen.getByRole('link', {name: 'Back to planning'})); expect(route()).toBe(day);
    const cook = within(await screen.findByRole('region', {name: 'What to cook'})); expect(cells(cook.getByRole('row', {name: /Beef Caldereta/})).slice(0, 3)).toEqual(['2', '1', '1']);
  });

  it('checks the entries before asking for a review, and accepts an explanation in place of ingredient usage', async () => {
    const seed = await recording(), {user} = await start(seed), field = await count(seed);
    await user.click(screen.getByRole('button', {name: 'Review preparation'})); expect(await screen.findByText('Enter a prepared quantity for at least one order line.')).toBeVisible();
    await user.type(field, '3'); await user.click(screen.getByRole('button', {name: 'Review preparation'})); expect(await screen.findByText('Enter a whole number from 0 to 2.')).toBeVisible();
    await user.clear(field); await user.type(field, '1'); await user.click(screen.getByRole('button', {name: 'Review preparation'}));
    expect(await screen.findByText('Add the ingredients used, or explain a preparation that used no tracked ingredients.')).toBeVisible();
    await user.click(screen.getByRole('button', {name: 'Add Flour'})); await user.type(screen.getByLabelText('Flour quantity used'), '0.8555'); await user.click(screen.getByRole('button', {name: 'Review preparation'}));
    expect(await screen.findByText('Enter a positive quantity with up to three decimal places.')).toBeVisible(); expect(screen.queryByRole('region', {name: 'Review before recording'})).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', {name: 'Remove Flour'})); await user.type(screen.getByLabelText('Note'), 'Assembled from prepared stock.');
    const shown = await review(user);
    expect(shown.getByText('No tracked ingredients were used.')).toBeVisible(); expect(shown.getByText('Assembled from prepared stock.')).toBeVisible();
    await user.click(screen.getByRole('button', {name: 'Edit entries'})); expect(await count(seed)).toHaveValue('1'); expect(screen.getByLabelText('Note')).toHaveValue('Assembled from prepared stock.');
  });

  it('keeps the entry when the backend refuses usage beyond physical stock', async () => {
    const seed = await recording(), {user} = await start(seed); await fill(user, seed, '3');
    await user.click(screen.getByRole('button', {name: 'Review preparation'}));
    expect(await screen.findByText('Only 2000 g is in stock. Record a stock correction first if the count is wrong.')).toBeVisible(); expect(screen.getByRole('alert')).toHaveTextContent('Physical stock does not cover this usage.');
    expect(screen.getByLabelText('Flour quantity used')).toHaveValue('3'); expect(screen.queryByRole('region', {name: 'Review before recording'})).not.toBeInTheDocument();
  });

  it('reloads the latest figures when an order changed after the page loaded', async () => {
    const seed = await recording(), {user, client} = await start(seed); await fill(user, seed);
    await client.request(`/orders/${seed.saved.id}/transitions`, {method: 'POST', operationId: crypto.randomUUID(), body: {expected_version: 1, to_status: 'preparing'}});
    await user.click(screen.getByRole('button', {name: 'Review preparation'}));
    expect(await screen.findByText('Orders or stock changed after this page loaded. The latest figures are shown; check your entries and review again.')).toBeVisible();
    await within(await screen.findByRole('region', {name: 'Food prepared'})).findByText('Preparing'); expect(await count(seed)).toHaveValue('1'); expect(screen.getByLabelText('Flour quantity used')).toHaveValue('0.8');
    expect((await review(user)).getByText('0 -> 1 of 2')).toBeVisible();
  });

  it('refuses a review that disagrees with the entry', async () => {
    const seed = await recording();
    const {user} = await start(seed, entry, async (input, init) => {
      const response = await seed.fixture.fetch(input, init); if (!String(input).endsWith('/preparations/preview') || !response.ok) return response;
      const preview = await response.json(); preview.consumption[0].after_quantity = '2000'; return new Response(JSON.stringify(preview));
    });
    await fill(user, seed); await user.click(screen.getByRole('button', {name: 'Review preparation'}));
    expect(await screen.findByText('The server returned an invalid preparation response.')).toBeVisible(); expect(screen.queryByRole('button', {name: 'Record preparation'})).not.toBeInTheDocument();
  });

  it('reconciles a lost response without deducting stock twice', async () => {
    const seed = await recording(); let sent = 0;
    const {user, client} = await start(seed, entry, async (input, init) => {const response = await seed.fixture.fetch(input, init); if (saves(input, init)) {sent++; throw new TypeError('Lost response');} return response;});
    await fill(user, seed); await review(user); await user.click(screen.getByRole('button', {name: 'Record preparation'}));
    expect(await screen.findByText(/Save result unconfirmed/)).toBeVisible(); expect(sessionStorage.getItem(marker)).toBeTruthy();
    expect(screen.queryByRole('button', {name: 'Record preparation'})).not.toBeInTheDocument(); expect(screen.getByRole('button', {name: 'Review preparation'})).toBeDisabled();
    await user.click(screen.getByRole('button', {name: 'Check save status'}));
    expect(await screen.findByText('Preparation recorded.')).toBeVisible(); expect(sent).toBe(1); expect(sessionStorage.getItem(marker)).toBeNull();
    await expect(client.request(`/ingredients/${seed.flour.id}`)).resolves.toMatchObject({stock_on_hand: '1200'});
  });

  it('allows only the identical retry when no operation was recorded', async () => {
    const seed = await recording(), attempts: {body: unknown; key: string | null}[] = [];
    const {user} = await start(seed, entry, async (input, init) => {
      if (saves(input, init)) {attempts.push({body: JSON.parse(String(init!.body)), key: new Headers(init!.headers).get('Idempotency-Key')}); if (attempts.length === 1) throw new TypeError('Offline before submission');}
      return seed.fixture.fetch(input, init);
    });
    await fill(user, seed); await review(user); await user.click(screen.getByRole('button', {name: 'Record preparation'}));
    await screen.findByText(/Save result unconfirmed/); expect(screen.queryByRole('button', {name: 'Retry identical save'})).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', {name: 'Check save status'})); await user.click(await screen.findByRole('button', {name: 'Retry identical save'}));
    expect(await screen.findByText('Preparation recorded.')).toBeVisible(); expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]);
  });

  it('reports a rejected earlier save, keeps the entry and allows a new reviewed attempt', async () => {
    const seed = await recording(); let lost = true;
    const {user, client} = await start(seed, entry, async (input, init) => {
      if (!saves(input, init) || !lost) return seed.fixture.fetch(input, init);
      // The backend refuses the save, and the refusal never reaches the browser.
      lost = false; await seed.fixture.fetch(input, {...init, body: JSON.stringify({...JSON.parse(String(init!.body)), preview_id: 'expired'})}); throw new TypeError('Lost response');
    });
    await fill(user, seed); await review(user); await user.click(screen.getByRole('button', {name: 'Record preparation'}));
    await screen.findByText(/Save result unconfirmed/); await user.click(screen.getByRole('button', {name: 'Check save status'}));
    expect(await screen.findByText('The earlier save was rejected: Preview expired or changed. Review again.')).toBeVisible(); expect(sessionStorage.getItem(marker)).toBeNull();
    expect(await count(seed)).toHaveValue('1'); await expect(client.request(`/ingredients/${seed.flour.id}`)).resolves.toMatchObject({stock_on_hand: '2000'});
    await review(user); await user.click(screen.getByRole('button', {name: 'Record preparation'})); expect(await screen.findByText('Preparation recorded.')).toBeVisible();
  });

  it('shows an unresolved save after a reload and leaves a missing operation to an operator', async () => {
    const seed = await recording(); sessionStorage.setItem(marker, 'lost-operation'); const {user} = await start(seed);
    expect(await screen.findByText(/Earlier preparation save unresolved. Operation: lost-operation/)).toBeVisible(); expect(screen.getByRole('button', {name: 'Review preparation'})).toBeDisabled();
    await user.click(screen.getByRole('button', {name: 'Check save status'}));
    expect(await screen.findByText(/This operation is not recorded. The original draft is no longer available/)).toBeVisible(); expect(screen.queryByRole('button', {name: 'Retry identical save'})).not.toBeInTheDocument();
  });

  it('opens a saved preparation by its address', async () => {
    const seed = await recording(), done = await seed.prepare(seed.draft(seed.saved, 1, '0.8')); await start(seed, `/preparations/${done.preparation.id}`);
    expect(await screen.findByRole('heading', {name: 'Preparation record'})).toBeVisible(); expect(screen.queryByText('Preparation recorded.')).not.toBeInTheDocument();
    const food = within(await screen.findByRole('region', {name: 'Food prepared'})).getByRole('row', {name: /Beef Caldereta/});
    expect(within(food).getByRole('link', {name: seed.saved.reference})).toHaveAttribute('href', `/orders/${seed.saved.id}`); expect(cells(food)).toContain('1');
    expect(within(screen.getByRole('region', {name: 'Ingredients used'})).getByText('0.8 kg')).toBeVisible(); expect(screen.getByText('$9.60')).toBeVisible(); expect(screen.getByText(/ by Admin$/)).toBeVisible();
    expect(screen.getByRole('link', {name: 'Back to planning'})).toHaveAttribute('href', '/planning');
  });

  it('links a consumption movement to its preparation record', async () => {
    const seed = await recording(), done = await seed.prepare(seed.draft(seed.saved, 1, '0.8')); await start(seed, `/ingredients/${seed.flour.id}`);
    expect(await screen.findByRole('link', {name: 'Preparation record'})).toHaveAttribute('href', `/preparations/${done.preparation.id}`);
  });
});

describe('orders after partial preparation', () => {
  // Three trays ordered and two prepared with 1.5 kg of Flour, leaving 500 g in stock.
  async function partly() {
    const seed = await planningSeed({preparation: true}), saved = await seed.order('2026-10-10', [[seed.medium, 3]]), done = await seed.prepare(seed.draft(saved, 2, '1.5'));
    return {...seed, saved, prepared: done.orders[0], record: done.preparation};
  }

  it('shows prepared and remaining quantities and links to preparation recording', async () => {
    const seed = await partly(); await start(seed, `/orders/${seed.saved.id}`);
    expect(await screen.findByText('2 prepared / 1 remaining')).toBeVisible(); expect(screen.getByRole('link', {name: 'Record preparation'})).toHaveAttribute('href', entry);
  });

  it('keeps manual orders free of prepared counts and preparation links', async () => {
    const seed = await recording({}); await start(seed, `/orders/${seed.saved.id}`);
    await screen.findByRole('heading', {name: seed.saved.reference}); expect(screen.queryByText(/ prepared \/ /)).not.toBeInTheDocument(); expect(screen.queryByRole('link', {name: 'Record preparation'})).not.toBeInTheDocument();
  });

  it('explains why an order with remaining preparation cannot be marked ready', async () => {
    const seed = await partly(); await seed.advance(seed.prepared, 'preparing'); await start(seed, `/orders/${seed.saved.id}`);
    expect(await screen.findByRole('button', {name: 'Mark ready'})).toBeDisabled(); expect(screen.getByText('Record all remaining preparation before marking ready.')).toBeVisible();
  });

  it('marks a fully prepared order ready without a staff attestation', async () => {
    const seed = await recording(), full = (await seed.prepare(seed.draft(seed.saved, 2, '1.5'))).orders[0]; await seed.advance(full, 'preparing');
    const {user} = await start(seed, `/orders/${seed.saved.id}`);
    await user.click(await screen.findByRole('button', {name: 'Mark ready'})); const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('All ordered quantities are recorded as prepared.')).toBeVisible(); expect(dialog.queryByRole('checkbox')).not.toBeInTheDocument();
    await user.click(dialog.getByRole('button', {name: 'Confirm ready'}));
    expect(await screen.findByText('Status updated.')).toBeVisible(); expect(screen.queryByRole('link', {name: 'Record preparation'})).not.toBeInTheDocument();
  });

  it('reviews prepared quantities and retained stock before cancelling', async () => {
    const seed = await partly(), {user, client} = await start(seed, `/orders/${seed.saved.id}`);
    await user.click(await screen.findByRole('button', {name: 'Cancel order'})); const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('2 of 3 Medium of Beef Caldereta already prepared')).toBeVisible();
    await user.type(dialog.getByLabelText('Cancellation reason'), 'Customer cancelled'); await user.click(dialog.getByRole('button', {name: 'Confirm cancellation'}));
    expect(await dialog.findByText('Acknowledge the consumed stock before cancelling.')).toBeVisible();
    await user.click(dialog.getByRole('checkbox', {name: /Consumed ingredients will not be restored/})); await user.click(dialog.getByRole('button', {name: 'Confirm cancellation'}));
    expect(await screen.findByText('Order cancelled.')).toBeVisible(); await expect(client.request(`/ingredients/${seed.flour.id}`)).resolves.toMatchObject({stock_on_hand: '500'});
  });

  it('keeps a prepared line and its prepared quantity when the order is edited', async () => {
    const seed = await partly(), {user} = await start(seed, `/orders/${seed.saved.id}`);
    await user.click(await screen.findByRole('button', {name: 'Edit order'})); const dialog = within(await screen.findByRole('dialog'));
    expect(await dialog.findByText('2 already prepared. This item cannot be removed or reduced below 2.')).toBeVisible(); expect(dialog.getByRole('button', {name: 'Remove item 1'})).toBeDisabled();
    const quantity = dialog.getByLabelText('Quantity for item 1'); await user.clear(quantity); await user.type(quantity, '1'); await user.click(dialog.getByRole('button', {name: 'Review order'}));
    expect(await dialog.findByText('Quantity cannot go below the 2 already prepared.')).toBeVisible();
    await user.clear(quantity); await user.type(quantity, '4'); await user.click(dialog.getByRole('button', {name: 'Review order'}));
    expect(await dialog.findByText('2 prepared / 2 remaining')).toBeVisible();
  });

  it('records returned stock as a correction linked to its preparation', async () => {
    const seed = await partly(), {user, client} = await start(seed, `/preparations/${seed.record.id}`);
    await user.click(await screen.findByRole('button', {name: 'Correct stock for Flour'})); const dialog = within(await screen.findByRole('dialog', {name: 'Correct stock'}));
    expect(dialog.getByText('This movement will be linked to the preparation record.')).toBeVisible();
    await user.type(dialog.getByLabelText('Stock change (g)'), '200'); await user.type(dialog.getByLabelText('Reason'), 'Unused flour returned');
    await user.click(dialog.getByRole('button', {name: 'Review movement'})); await dialog.findByText('500 g -> 700 g'); await user.click(dialog.getByRole('button', {name: 'Save movement'}));
    // The message is shown first and the ingredient page opens once the editor has closed.
    expect(await screen.findByText('Stock movement saved.')).toBeVisible(); await waitFor(() => expect(route()).toBe(`/ingredients/${seed.flour.id}`));
    expect((await client.request<any>(`/ingredients/${seed.flour.id}/movements`)).items[0]).toMatchObject({type: 'correction', delta_base_quantity: '200', after_quantity: '700',
      preparation_id: seed.record.id, corrects_movement_id: seed.record.consumption[0].stock_movement_id});
    expect(await screen.findAllByRole('link', {name: 'Preparation record'})).toHaveLength(2);
  });

  it('records waste against a preparation without calling it a correction of the deduction', async () => {
    const seed = await partly(), {user, client} = await start(seed, `/preparations/${seed.record.id}`);
    await user.click(await screen.findByRole('button', {name: 'Record waste for Flour'})); const dialog = within(await screen.findByRole('dialog', {name: 'Record waste'}));
    await user.type(dialog.getByLabelText('Stock change (g)'), '-100'); await user.type(dialog.getByLabelText('Reason'), 'Spilled');
    await user.click(dialog.getByRole('button', {name: 'Review movement'})); await dialog.findByText('500 g -> 400 g'); await user.click(dialog.getByRole('button', {name: 'Save movement'}));
    expect(await screen.findByText('Stock movement saved.')).toBeVisible();
    expect((await client.request<any>(`/ingredients/${seed.flour.id}/movements`)).items[0]).toMatchObject({type: 'waste', delta_base_quantity: '-100', preparation_id: seed.record.id, corrects_movement_id: null});
  });
});

describe('preparation corrections', () => {
  const correctionMarker = 'food-reservations:preparation-correction-operation';
  // Three trays ordered and two recorded as prepared with 1.5 kg of Flour, leaving 500 g in stock.
  async function recorded() {
    const seed = await planningSeed({preparation: true}), saved = await seed.order('2026-10-10', [[seed.medium, 3]]), done = await seed.prepare(seed.draft(saved, 2, '1.5'));
    return {...seed, saved, record: done.preparation, page: `/preparations/${done.preparation.id}/correct`};
  }
  const change = (seed: {saved: {reference: string}}) => screen.findByLabelText(`Change in prepared count, ${seed.saved.reference} Medium of Beef Caldereta`);
  async function fillCorrection(user: UserEvent, seed: {saved: {reference: string}}, delta = '-1', flour: string | null = '750') {
    await user.type(await change(seed), delta); await user.type(screen.getByLabelText('Reason for correction'), 'Only one tray was cooked');
    if (flour !== null) await user.type(screen.getByLabelText('Flour stock change (g)'), flour);
  }
  const reviewCorrection = async (user: UserEvent) => {await user.click(screen.getByRole('button', {name: 'Review correction'})); return within(await screen.findByRole('region', {name: 'Review correction'}));};
  const corrects = (input: RequestInfo | URL, init?: RequestInit) => String(input).endsWith('/corrections') && init?.method === 'POST';

  it('offers a correction from the preparation record', async () => {
    const seed = await recorded(); await start(seed, `/preparations/${seed.record.id}`);
    expect(await screen.findByRole('link', {name: 'Correct prepared counts'})).toHaveAttribute('href', seed.page); expect(screen.queryByRole('region', {name: 'Corrections'})).not.toBeInTheDocument();
  });

  it('reviews and records a corrected count together with its stock adjustment', async () => {
    const seed = await recorded(), {user, client} = await start(seed, seed.page);
    expect(await screen.findByRole('heading', {name: 'Correct preparation'})).toBeVisible();
    const counts = within(await screen.findByRole('region', {name: 'Prepared counts'})); expect(counts.getByText('2 of 3 prepared')).toBeVisible(); expect(counts.getByRole('link', {name: seed.saved.reference})).toHaveAttribute('href', `/orders/${seed.saved.id}`);
    const stock = within(screen.getByRole('region', {name: 'Stock adjustments'})); expect(stock.getByText('Deducted here: 1500 g')).toBeVisible(); expect(stock.getByText('In stock: 500 g')).toBeVisible();
    await fillCorrection(user, seed); const shown = await reviewCorrection(user);
    expect(shown.getByText('2 -> 1 of 3')).toBeVisible(); expect(shown.getByText('2 remaining')).toBeVisible(); expect(shown.getByText('+750 g')).toBeVisible(); expect(shown.getByText('500 g -> 1250 g')).toBeVisible(); expect(shown.getByText('Only one tray was cooked')).toBeVisible();
    // A review changes nothing.
    await expect(client.request(`/ingredients/${seed.flour.id}`)).resolves.toMatchObject({stock_on_hand: '500'});
    await user.click(screen.getByRole('button', {name: 'Record correction'}));
    expect(await screen.findByText('Correction recorded.')).toBeVisible(); expect(route()).toBe(`/preparations/${seed.record.id}`);
    const listed = within(await screen.findByRole('region', {name: 'Corrections'}));
    expect(listed.getByText('Only one tray was cooked')).toBeVisible(); expect(listed.getByText('2 -> 1 of 3')).toBeVisible(); expect(listed.getByText('500 g -> 1250 g')).toBeVisible();
    await expect(client.request(`/ingredients/${seed.flour.id}`)).resolves.toMatchObject({stock_on_hand: '1250'}); await expect(client.request(`/orders/${seed.saved.id}`)).resolves.toMatchObject({items: [{prepared_quantity: 1, remaining_quantity: 2}]});
  });

  it('checks a correction before asking for a review', async () => {
    const seed = await recorded(), {user} = await start(seed, seed.page), field = await change(seed);
    await user.click(screen.getByRole('button', {name: 'Review correction'}));
    expect(await screen.findByText('Enter at least one change to a prepared count or to stock.')).toBeVisible(); expect(screen.getByText('Enter a reason.')).toBeVisible();
    await user.type(field, 'x'); await user.type(screen.getByLabelText('Flour stock change (g)'), '1.2345'); await user.click(screen.getByRole('button', {name: 'Review correction'}));
    expect(await screen.findByText('Enter a whole number such as -1 or 1.')).toBeVisible(); expect(screen.getByText('Enter a signed quantity with up to three decimal places.')).toBeVisible(); expect(screen.queryByRole('region', {name: 'Review correction'})).not.toBeInTheDocument();
  });

  it('shows a backend refusal on the line it concerns and keeps the entries', async () => {
    const seed = await recorded(), {user} = await start(seed, seed.page); await fillCorrection(user, seed, '-3', null); await user.click(screen.getByRole('button', {name: 'Review correction'}));
    expect(await screen.findByText('Enter a nonzero change that stays within what this preparation recorded and what was ordered.')).toBeVisible(); expect(await change(seed)).toHaveValue('-3');
    expect(screen.queryByRole('region', {name: 'Review correction'})).not.toBeInTheDocument();
  });

  it('reloads the latest versions when the order changed after the page loaded', async () => {
    const seed = await recorded(), {user, client} = await start(seed, seed.page); await fillCorrection(user, seed);
    await client.request(`/orders/${seed.saved.id}/transitions`, {method: 'POST', operationId: crypto.randomUUID(), body: {expected_version: 2, to_status: 'preparing'}});
    await user.click(screen.getByRole('button', {name: 'Review correction'}));
    expect(await screen.findByText('Orders or stock changed after this page loaded. The latest figures are shown; check your entries and review again.')).toBeVisible();
    await within(await screen.findByRole('region', {name: 'Prepared counts'})).findByText('Preparing'); expect(await change(seed)).toHaveValue('-1');
    expect((await reviewCorrection(user)).getByText('2 -> 1 of 3')).toBeVisible();
  });

  it('reconciles a lost correction response without applying it twice', async () => {
    const seed = await recorded(); let sent = 0;
    const {user, client} = await start(seed, seed.page, async (input, init) => {const response = await seed.fixture.fetch(input, init); if (corrects(input, init)) {sent++; throw new TypeError('Lost response');} return response;});
    await fillCorrection(user, seed); await reviewCorrection(user); await user.click(screen.getByRole('button', {name: 'Record correction'}));
    expect(await screen.findByText(/Save result unconfirmed/)).toBeVisible(); expect(sessionStorage.getItem(correctionMarker)).toBeTruthy(); expect(screen.getByRole('button', {name: 'Review correction'})).toBeDisabled();
    await user.click(screen.getByRole('button', {name: 'Check save status'}));
    expect(await screen.findByText('Correction recorded.')).toBeVisible(); expect(sent).toBe(1); expect(sessionStorage.getItem(correctionMarker)).toBeNull();
    await expect(client.request(`/ingredients/${seed.flour.id}`)).resolves.toMatchObject({stock_on_hand: '1250'});
  });

  it('allows only the identical correction to be retried when no operation was recorded', async () => {
    const seed = await recorded(), attempts: {body: unknown; key: string | null}[] = [];
    const {user} = await start(seed, seed.page, async (input, init) => {
      if (corrects(input, init)) {attempts.push({body: JSON.parse(String(init!.body)), key: new Headers(init!.headers).get('Idempotency-Key')}); if (attempts.length === 1) throw new TypeError('Offline before submission');}
      return seed.fixture.fetch(input, init);
    });
    await fillCorrection(user, seed); await reviewCorrection(user); await user.click(screen.getByRole('button', {name: 'Record correction'}));
    await screen.findByText(/Save result unconfirmed/); expect(screen.queryByRole('button', {name: 'Retry identical save'})).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', {name: 'Check save status'})); await user.click(await screen.findByRole('button', {name: 'Retry identical save'}));
    expect(await screen.findByText('Correction recorded.')).toBeVisible(); expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]);
  });

  it('refuses a correction review that disagrees with the entry', async () => {
    const seed = await recorded();
    const {user} = await start(seed, seed.page, async (input, init) => {
      const response = await seed.fixture.fetch(input, init); if (!String(input).endsWith('/correction-preview') || !response.ok) return response;
      const preview = await response.json(); preview.allocations[0].prepared_after = 2; return new Response(JSON.stringify(preview));
    });
    await fillCorrection(user, seed); await user.click(screen.getByRole('button', {name: 'Review correction'}));
    expect(await screen.findByText('The server returned an invalid preparation response.')).toBeVisible(); expect(screen.queryByRole('button', {name: 'Record correction'})).not.toBeInTheDocument();
  });
});
