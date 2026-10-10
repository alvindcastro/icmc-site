import type {Ingredient, InventoryResult, Movement, MovementPreview, Price, Purchase, PurchaseDraft, PurchasePreview, PurchaseSummary} from './types';
import type {Operation} from '../api/types';
import {scaledQuantity, validQuantity} from './model';
import {formatCalendarDate} from '../lib/format';
function fail(): never {throw new Error('The server returned an invalid inventory response.');}
const text = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim());
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const money = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const instant = (value: unknown) => text(value) && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const date = (value: unknown) => {try {return text(value) && Boolean(formatCalendarDate(value));} catch {return false;}};
const cost = (value: unknown) => typeof value === 'string' && /^(?:0|[1-9]\d*)\.\d{9}$/.test(value) && value.length <= 40;
const base = (value: unknown) => ['g', 'ml', 'piece'].includes(String(value));
const nullable = (value: unknown) => value === null || text(value);
function currency(value: {currency: string; minor_digits: number}) {
  if (!/^[A-Z]{3}$/.test(value.currency) || !Number.isInteger(value.minor_digits) || value.minor_digits < 0 || value.minor_digits > 9) fail();
}
function effect(value: {before_quantity: string; after_quantity: string; delta_base_quantity: string}, unit: string) {
  if (!validQuantity(value.before_quantity, unit) || !validQuantity(value.after_quantity, unit) || !validQuantity(value.delta_base_quantity, unit, true)
    || scaledQuantity(value.before_quantity) + scaledQuantity(value.delta_base_quantity) !== scaledQuantity(value.after_quantity)) fail();
}
export function checkedIngredient(value: unknown): Ingredient {
  const item = value as Ingredient;
  if (!item || !text(item.id) || !text(item.name) || !positive(item.version) || !base(item.base_unit) || !validQuantity(item.stock_on_hand, item.base_unit)
    || (item.low_stock_threshold !== null && !validQuantity(item.low_stock_threshold, item.base_unit)) || typeof item.low_stock !== 'boolean'
    || item.low_stock !== (item.low_stock_threshold !== null && scaledQuantity(item.stock_on_hand) <= scaledQuantity(item.low_stock_threshold))
    || (item.latest_unit_cost === null ? item.latest_purchase_date !== null : !cost(item.latest_unit_cost) || !date(item.latest_purchase_date))) fail();
  for (const key of ['edit', 'opening', 'waste', 'correction'] as const) {
    const action = item.permitted_actions?.[key]; if (!action || typeof action.allowed !== 'boolean' || !action.allowed && (!text(action.reason) || !text(action.reason_code))) fail();
  }
  return item;
}
export function checkedMovement(value: unknown): Movement {
  const item = value as Movement;
  if (!item || !text(item.id) || !text(item.ingredient_id) || !['opening', 'waste', 'correction', 'purchase', 'consumption'].includes(item.type)
    || !text(item.reason) || !text(item.operation_id) || !text(item.recorded_by) || !instant(item.recorded_at)
    || !nullable(item.purchase_id) || !nullable(item.preparation_id) || !nullable(item.corrects_movement_id)
    || item.type === 'purchase' && !text(item.purchase_id)) fail();
  effect(item, 'g');
  const delta = scaledQuantity(item.delta_base_quantity);
  if (delta === 0n || ['waste', 'consumption'].includes(item.type) && delta > 0n || ['opening', 'purchase'].includes(item.type) && delta < 0n) fail();
  return item;
}
function receiptLine(item: Purchase['items'][number]) {
  if (!item || !text(item.id) || !text(item.ingredient_id) || !text(item.ingredient_name) || !base(item.base_unit) || !validQuantity(item.base_quantity, item.base_unit)
    || scaledQuantity(item.base_quantity) <= 0n || !cost(item.unit_cost) || !money(item.total_cost_minor) || !text(item.stock_movement_id)) fail();
  const packed = ['bag', 'bottle', 'box'].includes(item.unit), compatible = item.base_unit === 'g' ? ['g', 'kg'] : item.base_unit === 'ml' ? ['ml', 'l'] : ['piece'];
  if (!validQuantity(item.quantity, packed ? 'piece' : item.base_unit === 'piece' ? 'piece' : 'g') || scaledQuantity(item.quantity) <= 0n
    || (packed ? !item.pack_contents || !compatible.includes(item.pack_contents.unit) || !validQuantity(item.pack_contents.quantity, item.base_unit)
      || scaledQuantity(item.pack_contents.quantity) <= 0n : item.pack_contents !== null || !compatible.includes(item.unit))) fail();
}
export function checkedPrice(value: unknown): Price {
  const item = value as Price; receiptLine(item); currency(item);
  if (!text(item.purchase_id) || !text(item.reference) || !text(item.supplier) || !date(item.purchased_on) || !instant(item.recorded_at)) fail(); return item;
}
export function checkedPurchase(value: unknown): Purchase {
  const item = value as Purchase;
  if (!item || !text(item.id) || !text(item.reference) || !text(item.supplier) || !date(item.purchased_on) || typeof item.note !== 'string'
    || !instant(item.recorded_at) || !text(item.recorded_by) || !text(item.operation_id) || !money(item.total_cost_minor)
    || !Array.isArray(item.items) || !item.items.length || new Set(item.items.map(row => row?.id)).size !== item.items.length) fail();
  currency(item); item.items.forEach(receiptLine);
  if (item.items.reduce((sum, row) => sum + BigInt(row.total_cost_minor), 0n) !== BigInt(item.total_cost_minor)) fail(); return item;
}
export function checkedPurchaseSummary(value: unknown): PurchaseSummary {
  const item = value as PurchaseSummary;
  if (!item || !text(item.id) || !text(item.reference) || !text(item.supplier) || !date(item.purchased_on) || !instant(item.recorded_at) || !money(item.total_cost_minor)) fail();
  currency(item); return item;
}
export function checkedPurchasePreview(value: unknown, draft?: PurchaseDraft): PurchasePreview {
  const item = value as PurchasePreview;
  if (!item || !text(item.id) || !instant(item.expires_at) || !money(item.total_cost_minor) || !Array.isArray(item.items) || !item.items.length
    || new Set(item.items.map(row => row?.client_line_id)).size !== item.items.length) fail();
  currency(item);
  item.items.forEach(row => {
    if (!text(row.client_line_id) || !text(row.ingredient_id) || !base(row.base_unit) || !validQuantity(row.base_quantity, row.base_unit) || scaledQuantity(row.base_quantity) <= 0n
      || !cost(row.unit_cost) || !money(row.total_cost_minor) || !positive(row.ingredient_version)) fail();
    effect({...row, delta_base_quantity: row.base_quantity}, row.base_unit);
  });
  if (item.items.reduce((sum, row) => sum + BigInt(row.total_cost_minor), 0n) !== BigInt(item.total_cost_minor)) fail();
  if (draft && (draft.items.length !== item.items.length || draft.items.some((row, i) => {
    const unit = row.pack_contents?.unit ?? row.unit, expected = ['g','kg'].includes(unit) ? 'g' : ['ml','l'].includes(unit) ? 'ml' : 'piece';
    return row.client_line_id !== item.items[i].client_line_id || row.ingredient_id !== item.items[i].ingredient_id
      || row.total_cost_minor !== item.items[i].total_cost_minor || expected !== item.items[i].base_unit;
  }))) fail(); return item;
}
export function checkedMovementPreview(value: unknown): MovementPreview {
  const item = value as MovementPreview;
  if (!item || !text(item.id) || !instant(item.expires_at) || !text(item.ingredient_id) || !positive(item.expected_version)) fail(); effect(item, 'g'); return item;
}
export function checkedInventoryResult(value: unknown): InventoryResult {
  if (!value || typeof value !== 'object') fail();
  if ('purchase' in value && 'ingredients' in value) {
    const item = value as {purchase: Purchase; ingredients: Ingredient[]}; checkedPurchase(item.purchase);
    if (!Array.isArray(item.ingredients) || !item.ingredients.length || new Set(item.ingredients.map(row => row?.id)).size !== item.ingredients.length) fail();
    item.ingredients.forEach(checkedIngredient);
    if (new Set(item.purchase.items.map(row => row.ingredient_id)).size !== item.ingredients.length || item.purchase.items.some(row => !item.ingredients.some(ingredient => ingredient.id === row.ingredient_id && ingredient.base_unit === row.base_unit))) fail(); return item;
  }
  if ('ingredient' in value && 'movement' in value) {
    const item = value as {ingredient: Ingredient; movement: Movement}; checkedIngredient(item.ingredient); checkedMovement(item.movement);
    if (item.ingredient.id !== item.movement.ingredient_id || item.ingredient.stock_on_hand !== item.movement.after_quantity) fail(); effect(item.movement, item.ingredient.base_unit); return item;
  }
  return checkedIngredient(value);
}
export function checkedInventoryOperation(value: unknown, id: string): Operation<InventoryResult> {
  const item = value as Operation<InventoryResult>;
  if (!item || item.operation_id !== id || !['processing', 'succeeded', 'rejected'].includes(item.state) || !instant(item.started_at)) fail();
  if (item.state === 'processing') {if (item.result !== null || item.error !== null || item.completed_at !== null) fail();}
  else {
    if (!instant(item.completed_at)) fail();
    if (item.state === 'succeeded') {
      if (item.error !== null || !item.result || ![200,201].includes(item.result.http_status)) fail();
      const result = checkedInventoryResult(item.result.body);
      const resource = 'purchase' in result ? result.purchase : 'ingredient' in result ? result.ingredient : result;
      if (item.resource_type !== ('purchase' in result ? 'purchase' : 'ingredient') || item.resource_id !== resource.id
        || 'purchase' in result && result.purchase.operation_id !== id || 'movement' in result && result.movement.operation_id !== id) fail();
    } else {
      const error = item.error;
      if (item.result !== null || !error || !Number.isInteger(error.http_status) || error.http_status < 400 || error.http_status >= 500
        || !text(error.error?.code) || !text(error.error?.message) || !Array.isArray(error.error.field_errors) || !error.error.details
        || error.error.field_errors.some(field => !text(field.path) || !text(field.code) || !text(field.message))) fail();
    }
  }
  return item;
}
