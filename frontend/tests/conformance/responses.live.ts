// Part of the conformance run only. The screens refuse any response that fails their own checks,
// usually as "save result unconfirmed". This walks one working day through the real backend and
// puts every answer through those same checks, so a response the screens would refuse fails here.
import {describe, expect, it} from 'vitest';
import {createApiClient} from '../../src/api/client';
import {checkedIngredient, checkedInventoryOperation, checkedInventoryResult, checkedMovement, checkedMovementPreview, checkedPrice, checkedPurchase,
  checkedPurchasePreview, checkedPurchaseSummary} from '../../src/inventory/responses';
import type {Ingredient, Purchase, PurchaseDraft} from '../../src/inventory/types';
import {checkedCategory, checkedFood, checkedOperation, checkedVariant} from '../../src/menu/responses';
import {checkedDashboard, checkedLedgerResult, checkedOrder, checkedOrderOperation, checkedQuote, checkedSummary} from '../../src/orders/responses';
import type {OrderDraft} from '../../src/orders/types';
import {checkedPlanning, checkedShoppingList} from '../../src/planning/responses';
import {checkedCorrectionOperation, checkedCorrectionPreview, checkedCorrectionResult, checkedCorrections, checkedPreparation, checkedPreparationOperation,
  checkedPreparationPreview, checkedPreparationResult} from '../../src/preparation/responses';
import type {CorrectionDraft, PreparationDraft} from '../../src/preparation/types';
import {checkedEstimate, checkedRecipe} from '../../src/recipes/responses';
import {createFixtureTransport} from './live-fixtures';

describe('the screens accept what the backend answers', () => {
  it('passes every response of a working day through the screens\' own checks', async () => {
    const live = createFixtureTransport({preparation: true});
    const api = createApiClient({baseUrl: '/api/v1', transport: live.fetch});
    const session = await api.request<{csrf_token: string}>('/auth/sign-in', {method: 'POST', body: {username: 'admin', token: 'local-admin-token'}});
    api.setCsrfToken(session.csrf_token);
    const key = () => crypto.randomUUID();
    const save = <T>(path: string, body: unknown, operationId: string = key(), method = 'POST') => api.request<T>(path, {method, operationId, body});
    // A list page never holds more than its limit or its total, and never the same record twice.
    async function page<T extends {id: string}>(path: string, check: (value: unknown) => T): Promise<T[]> {
      const result = await api.request<{items: unknown[]; total: number; limit: number}>(path), items = result.items.map(check);
      expect(items.length).toBeLessThanOrEqual(Math.min(result.limit, result.total));
      expect(new Set(items.map(item => item.id)).size).toBe(items.length);
      return items;
    }

    // Menu.
    expect(await page('/categories', checkedCategory)).toHaveLength(4);
    expect(await page('/foods?limit=100', checkedFood)).toHaveLength(4);
    const made = key(), food = checkedFood(await save('/foods', {name: 'Conformance stew', category_id: 'beef', description: '', available: true}, made));
    checkedOperation(await api.request(`/operations/${made}`), made);
    const variant = checkedVariant(await save(`/foods/${food.id}/variants`, {label: 'Tray', selling_unit: 'tray', price_minor: 8000, available: true, package_contents: null}));

    // Stockroom: an opening count, two receipts, and the lists they appear in.
    const stocked = key();
    let flour: Ingredient = checkedIngredient(await save('/ingredients', {name: 'Flour', base_unit: 'g', low_stock_threshold: '500'}, stocked));
    checkedInventoryOperation(await api.request(`/operations/${stocked}`), stocked);
    let salt: Ingredient = checkedIngredient(await save('/ingredients', {name: 'Salt', base_unit: 'g', low_stock_threshold: null}));
    const opening = {expected_version: salt.version, type: 'opening', delta_base_quantity: '250', reason: 'Counted on the shelf', preparation_id: null, corrects_movement_id: null};
    const counted = checkedMovementPreview(await api.request(`/ingredients/${salt.id}/movement-preview`, {method: 'POST', body: opening}));
    const moved = checkedInventoryResult(await save(`/ingredients/${salt.id}/movements`, {...opening, preview_id: counted.id})) as {ingredient: Ingredient};
    salt = moved.ingredient;
    async function buy(ingredient: Ingredient, cost: number): Promise<{purchase: Purchase; ingredients: Ingredient[]}> {
      const draft: PurchaseDraft = {purchased_on: '2026-10-07', supplier: 'Market', note: '', items: [{client_line_id: 'a', ingredient_id: ingredient.id, quantity: '2', unit: 'kg', pack_contents: null, total_cost_minor: cost}]};
      const preview = checkedPurchasePreview(await api.request('/purchases/preview', {method: 'POST', body: {draft}}), draft), operation = key();
      const result = checkedInventoryResult(await save('/purchases', {preview_id: preview.id, draft}, operation)) as {purchase: Purchase; ingredients: Ingredient[]};
      checkedInventoryOperation(await api.request(`/operations/${operation}`), operation);
      return result;
    }
    const receipt = await buy(flour, 2400);
    flour = receipt.ingredients[0];
    checkedPurchase(await api.request(`/purchases/${receipt.purchase.id}`));

    // Recipe and estimate: incomplete while salt has no price, complete once it has.
    const recipe = checkedRecipe(await api.request(`/variants/${variant.id}/recipe`, {method: 'PUT', body: {expected_version: null,
      yield: {quantity: 1, selling_unit: 'tray', package_contents: null}, items: [{ingredient_id: flour.id, quantity: '750', unit: 'g'}, {ingredient_id: salt.id, quantity: '5', unit: 'g'}]}}));
    expect(checkedEstimate(await api.request(`/variants/${variant.id}/estimate`))).toMatchObject({complete: false, recipe_version: recipe.version, ingredient_cost_minor: null});
    salt = (await buy(salt, 200)).ingredients[0];
    expect(checkedEstimate(await api.request(`/variants/${variant.id}/estimate`))).toMatchObject({complete: true, ingredient_cost_minor: 901, ingredient_contribution_minor: 7099});
    expect(checkedFood(await api.request(`/foods/${food.id}`)).variants[0].recipe_id).toBe(recipe.id);
    await page('/ingredients', checkedIngredient); await page(`/ingredients/${flour.id}/movements`, checkedMovement);
    await page(`/ingredients/${flour.id}/prices`, checkedPrice); await page('/purchases', checkedPurchaseSummary);

    // An order: quoted, placed, paid, partly refunded and started.
    const day = checkedDashboard(await api.request('/dashboard')).business_date;
    const draft: OrderDraft = {customer: {name: 'Sample Customer', phone: '555-0100', notes: ''},
      fulfillment: {method: 'pickup', local_date: day, local_time: '12:00', timezone: 'America/Los_Angeles', utc_offset: null, address: null},
      items: [{client_line_id: 'a', variant_id: variant.id, quantity: 2, preparation_notes: ''}], notes: '', delivery_charge_minor: 0, tax_minor: 0};
    const quote = checkedQuote(await api.request('/orders/quote', {method: 'POST', body: {draft}})), placed = key();
    let order = checkedOrder(await save('/orders', {quote_id: quote.id, draft, initial_status: 'confirmed', acknowledge_credit: false}, placed));
    checkedOrderOperation(await api.request(`/operations/${placed}`), placed);
    const paid = key(), payment = checkedLedgerResult(await save(`/orders/${order.id}/payments`, {expected_version: order.version, amount_minor: 10000, paid_on: day, method: 'cash', reference: 'Receipt 1', note: ''}, paid));
    checkedOrderOperation(await api.request(`/operations/${paid}`), paid);
    const refund = checkedLedgerResult(await save(`/orders/${order.id}/refunds`, {expected_version: payment.order.version, payment_id: payment.entry.id, amount_minor: 1000, refunded_on: day, method: 'cash', reason: 'Paid too much'}));
    order = checkedOrder(await save(`/orders/${order.id}/transitions`, {expected_version: refund.order.version, to_status: 'preparing'}));
    await page('/orders', checkedSummary); checkedDashboard(await api.request(`/dashboard?date=${day}`));
    expect(checkedPlanning(await api.request('/planning')).foods).toHaveLength(1);
    checkedShoppingList(await api.request('/planning/shopping-list'));

    // Cooking: reviewed, recorded, looked up, then corrected.
    const cooking: PreparationDraft = {prepared_on: day, allocations: [{order_id: order.id, expected_version: order.version, order_item_id: order.items[0].id, quantity: 2}],
      consumption: [{ingredient_id: flour.id, expected_version: flour.version, quantity: '1.5', unit: 'kg'}], note: ''};
    const reviewed = checkedPreparationPreview(await api.request('/preparations/preview', {method: 'POST', body: {draft: cooking}}), cooking), cooked = key();
    const done = checkedPreparationResult(await save('/preparations', {preview_id: reviewed.id, draft: cooking}, cooked), cooking, cooked), record = done.preparation.id;
    checkedPreparationOperation(await api.request(`/operations/${cooked}`), cooked);
    checkedPreparation(await api.request(`/preparations/${record}`));
    const change: CorrectionDraft = {reason: 'One tray too many', allocations: [{order_id: order.id, expected_version: done.orders[0].version, order_item_id: order.items[0].id, delta_quantity: -1}],
      stock_corrections: [{ingredient_id: flour.id, expected_version: done.ingredients[0].version, delta_base_quantity: '750', corrects_movement_id: done.preparation.consumption[0].stock_movement_id}]};
    const amending = checkedCorrectionPreview(await api.request(`/preparations/${record}/correction-preview`, {method: 'POST', body: change}), change, record), amended = key();
    const corrected = checkedCorrectionResult(await save(`/preparations/${record}/corrections`, {...change, preview_id: amending.id}, amended), change, amended, record);
    checkedCorrectionOperation(await api.request(`/operations/${amended}`), amended, record);
    expect(checkedCorrections(await api.request(`/preparations/${record}/corrections`), record)).toHaveLength(1);
    checkedPlanning(await api.request('/planning'));
    await page(`/ingredients/${flour.id}/movements`, checkedMovement);

    // Cancelling keeps the counts and the ledger; the order is still one the screens can show.
    const cancelled = checkedOrder(await save(`/orders/${order.id}/cancel`, {expected_version: corrected.orders[0].version, reason: 'Customer called it off', acknowledge_consumed_stock: true}));
    expect(cancelled).toMatchObject({status: 'cancelled', settlement_total_minor: 0, customer_credit_minor: 9000, items: [{prepared_quantity: 1, remaining_quantity: 1}]});
    expect(checkedPlanning(await api.request('/planning')).foods).toEqual([]);
  });
});
