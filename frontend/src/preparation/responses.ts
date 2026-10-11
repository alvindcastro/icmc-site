import type {Operation} from '../api/types';
import {scaledQuantity, validQuantity} from '../inventory/model';
import {checkedIngredient} from '../inventory/responses';
import {formatCalendarDate} from '../lib/format';
import {checkedOrder} from '../orders/responses';
import type {CorrectionDraft, CorrectionPreview, CorrectionResult, CostBasisSnapshot, Preparation, PreparationCorrection, PreparationDraft, PreparationPreview, PreparationResult, RecipeSnapshot} from './types';
function fail(): never {throw new Error('The server returned an invalid preparation response.');}
const text = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim());
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const instant = (value: unknown) => text(value) && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const date = (value: unknown) => {try {return text(value) && Boolean(formatCalendarDate(value));} catch {return false;}};
const cost = (value: unknown) => typeof value === 'string' && /^(?:0|[1-9]\d*)\.\d{9}$/.test(value) && value.length <= 40;
type Line = Preparation['allocations'][number];
type Usage = Preparation['consumption'][number] | PreparationPreview['consumption'][number];
function line(row: Line) {
  if (!row || !text(row.order_id) || !text(row.reference) || !text(row.order_item_id) || !text(row.variant_id) || !text(row.food_name) || !text(row.variant_label) || !count(row.quantity) || row.quantity < 1
    || !['tray', 'piece', 'stick', 'package'].includes(row.selling_unit)
    || (row.selling_unit === 'package' ? !count(row.package_contents?.quantity) || row.package_contents.quantity < 1 || row.package_contents.unit !== 'piece' : row.package_contents !== null)) fail();
}
// Usage keeps the unit it was entered in; the normalized quantity and the stock effect must follow from it exactly.
function usage(row: Usage) {
  if (!row || !text(row.ingredient_id) || !text(row.ingredient_name) || !['g', 'ml', 'piece'].includes(row.base_unit)
    || !(row.base_unit === 'g' ? ['g', 'kg'] : row.base_unit === 'ml' ? ['ml', 'l'] : ['piece']).includes(row.unit)
    || ![row.quantity, row.base_quantity, row.before_quantity, row.after_quantity].every(quantity => validQuantity(quantity, row.base_unit === 'piece' ? 'piece' : 'g'))) fail();
  const used = scaledQuantity(row.quantity) * (['kg', 'l'].includes(row.unit) ? 1000n : 1n);
  if (used <= 0n || scaledQuantity(row.base_quantity) !== used || scaledQuantity(row.before_quantity) - used !== scaledQuantity(row.after_quantity)) fail();
}
// What a preview and a saved preparation share: unique rows, one recipe snapshot per prepared variant and one
// cost basis per used ingredient, with a total that is known only when every basis is.
function record(item: {id: string; prepared_on: string; note: string; allocations: Line[]; consumption: Usage[]; recipe_snapshots: RecipeSnapshot[]; cost_basis_snapshots: CostBasisSnapshot[];
  estimated_ingredient_cost_minor: number | null; estimate_complete: boolean; currency: string; minor_digits: number}) {
  if (!item || !text(item.id) || !date(item.prepared_on) || typeof item.note !== 'string' || !Array.isArray(item.allocations) || !item.allocations.length || !Array.isArray(item.consumption)
    || !Array.isArray(item.recipe_snapshots) || !Array.isArray(item.cost_basis_snapshots) || typeof item.estimate_complete !== 'boolean'
    || !/^[A-Z]{3}$/.test(item.currency) || !Number.isInteger(item.minor_digits) || item.minor_digits < 0 || item.minor_digits > 9) fail();
  item.allocations.forEach(line); item.consumption.forEach(usage);
  const variants = [...new Set(item.allocations.map(row => row.variant_id))];
  if (new Set(item.allocations.map(row => row.order_item_id)).size !== item.allocations.length || new Set(item.consumption.map(row => row.ingredient_id)).size !== item.consumption.length
    || item.recipe_snapshots.length !== variants.length || item.cost_basis_snapshots.length !== item.consumption.length) fail();
  for (const snapshot of item.recipe_snapshots) {
    if (!snapshot || !variants.includes(snapshot.variant_id) || item.recipe_snapshots.filter(other => other?.variant_id === snapshot.variant_id).length !== 1
      || (snapshot.recipe_id === null ? snapshot.recipe_version !== null : !text(snapshot.recipe_id) || !count(snapshot.recipe_version) || snapshot.recipe_version < 1)) fail();
  }
  item.cost_basis_snapshots.forEach((basis, index) => {
    if (!basis || basis.ingredient_id !== item.consumption[index].ingredient_id
      || (basis.unit_cost === null ? basis.purchase_id !== null || basis.purchase_line_id !== null || basis.purchased_on !== null : !cost(basis.unit_cost) || !text(basis.purchase_id) || !text(basis.purchase_line_id) || !date(basis.purchased_on))) fail();
  });
  const known = item.cost_basis_snapshots.every(basis => basis.unit_cost !== null);
  if (item.estimate_complete !== known || (known ? !count(item.estimated_ingredient_cost_minor) : item.estimated_ingredient_cost_minor !== null)) fail();
}
function sameDraft(item: {prepared_on: string; note: string; allocations: Line[]; consumption: Usage[]}, draft: PreparationDraft) {
  if (item.prepared_on !== draft.prepared_on || item.note !== draft.note.trim() || item.allocations.length !== draft.allocations.length || item.consumption.length !== draft.consumption.length) fail();
  draft.allocations.forEach((input, index) => {
    const row = item.allocations[index]; if (row.order_id !== input.order_id || row.order_item_id !== input.order_item_id || row.quantity !== input.quantity) fail();
  });
  draft.consumption.forEach((input, index) => {
    const row = item.consumption[index]; if (row.ingredient_id !== input.ingredient_id || row.unit !== input.unit || scaledQuantity(row.quantity) !== scaledQuantity(input.quantity)) fail();
  });
}

export function checkedPreparationPreview(value: unknown, draft: PreparationDraft): PreparationPreview {
  const item = value as PreparationPreview;
  record(item); if (!instant(item.expires_at)) fail(); sameDraft(item, draft);
  item.allocations.forEach((row, index) => {
    // Prepared counts stay between zero and what was ordered, and the review quotes the version the draft was read at.
    if (row.expected_version !== draft.allocations[index].expected_version || !count(row.ordered_quantity) || !count(row.prepared_before) || !count(row.remaining_after)
      || row.prepared_after !== row.prepared_before + row.quantity || row.remaining_after !== row.ordered_quantity - row.prepared_after) fail();
  });
  item.consumption.forEach((row, index) => {if (row.expected_version !== draft.consumption[index].expected_version) fail();});
  return item;
}
export function checkedPreparation(value: unknown): Preparation {
  const item = value as Preparation;
  record(item);
  if (!text(item.operation_id) || !instant(item.recorded_at) || !text(item.recorded_by) || item.consumption.some(row => !text(row.stock_movement_id))
    || new Set(item.consumption.map(row => row.stock_movement_id)).size !== item.consumption.length) fail();
  return item;
}
// A save answers with the record and everything it changed. Each order and ingredient it touched must be present
// once, moved past the version the draft was read at, and show the prepared counts and stock the record describes.
export function checkedPreparationResult(value: unknown, draft: PreparationDraft | null, operationId: string): PreparationResult {
  const item = value as PreparationResult;
  if (!item || typeof item !== 'object' || !Array.isArray(item.orders) || !Array.isArray(item.ingredients)) fail();
  const saved = checkedPreparation(item.preparation);
  if (saved.operation_id !== operationId) fail();
  if (draft) sameDraft(saved, draft);
  const orders = [...new Set(saved.allocations.map(row => row.order_id))];
  if (item.orders.length !== orders.length || item.ingredients.length !== saved.consumption.length) fail();
  item.orders.forEach(checkedOrder); item.ingredients.forEach(checkedIngredient);
  saved.allocations.forEach((row, index) => {
    const order = item.orders.find(candidate => candidate.id === row.order_id), entry = order?.items.find(candidate => candidate.id === row.order_item_id), read = draft?.allocations[index].expected_version;
    if (!order || !entry || order.preparation_tracking !== 'recorded' || read !== undefined && order.version <= read || entry.prepared_quantity === null || entry.prepared_quantity < row.quantity
      || entry.prepared_quantity > entry.quantity || entry.remaining_quantity !== entry.quantity - entry.prepared_quantity) fail();
  });
  saved.consumption.forEach((row, index) => {
    const ingredient = item.ingredients.find(candidate => candidate.id === row.ingredient_id), read = draft?.consumption[index].expected_version;
    if (!ingredient || ingredient.base_unit !== row.base_unit || read !== undefined && ingredient.version <= read || scaledQuantity(ingredient.stock_on_hand) !== scaledQuantity(row.after_quantity)) fail();
  });
  return item;
}
// An operation is trusted only when it names its own completed result of the expected kind, or a complete rejection.
function operation<T>(value: unknown, id: string, type: string, resource: (body: unknown) => string): Operation<T> {
  const item = value as Operation<T>;
  if (!item || item.operation_id !== id || !['processing', 'succeeded', 'rejected'].includes(item.state) || !instant(item.started_at)) fail();
  if (item.state === 'processing') {if (item.result !== null || item.error !== null || item.completed_at !== null) fail();}
  else if (!instant(item.completed_at)) fail();
  if (item.state === 'succeeded' && (item.error !== null || item.resource_type !== type || !item.result || ![200, 201].includes(item.result.http_status) || resource(item.result.body) !== item.resource_id)) fail();
  if (item.state === 'rejected') {
    const error = item.error;
    if (item.result !== null || !error || !Number.isInteger(error.http_status) || error.http_status < 400 || error.http_status >= 500 || !text(error.error?.code) || !text(error.error?.message)
      || !Array.isArray(error.error.field_errors) || error.error.field_errors.some(field => !text(field?.path) || !text(field?.code) || !text(field?.message)) || !error.error.details || typeof error.error.details !== 'object') fail();
  }
  return item;
}
export function checkedPreparationOperation(value: unknown, id: string): Operation<PreparationResult> {
  return operation(value, id, 'preparation', body => checkedPreparationResult(body, null, id).preparation.id);
}

type Amendment = {id: string; preparation_id: string; reason: string; allocations: PreparationCorrection['allocations']; stock_corrections: (PreparationCorrection['stock_corrections'][number] | CorrectionPreview['stock_corrections'][number])[]};
// What a correction preview and a saved correction share: it belongs to one preparation, changes something, keeps each
// prepared count between zero and what was ordered, and leaves stock equal to what it was plus the signed change.
function amendment(item: Amendment, preparationId: string) {
  if (!item || !text(item.id) || item.preparation_id !== preparationId || !text(item.reason) || !Array.isArray(item.allocations) || !Array.isArray(item.stock_corrections) || !item.allocations.length && !item.stock_corrections.length
    || new Set(item.allocations.map(row => row?.order_item_id)).size !== item.allocations.length || new Set(item.stock_corrections.map(row => row?.ingredient_id)).size !== item.stock_corrections.length) fail();
  for (const row of item.allocations) {
    line({...row, quantity: 1});
    if (!count(row.ordered_quantity) || !count(row.prepared_before) || !count(row.prepared_after) || !Number.isSafeInteger(row.delta_quantity) || row.delta_quantity === 0
      || row.prepared_after !== row.prepared_before + row.delta_quantity || row.prepared_after > row.ordered_quantity || row.remaining_after !== row.ordered_quantity - row.prepared_after) fail();
  }
  for (const row of item.stock_corrections) {
    if (!row || !text(row.ingredient_id) || !text(row.ingredient_name) || !['g', 'ml', 'piece'].includes(row.base_unit) || !text(row.corrects_movement_id) || !validQuantity(row.before_quantity, row.base_unit)
      || !validQuantity(row.after_quantity, row.base_unit) || !validQuantity(row.delta_base_quantity, row.base_unit, true) || scaledQuantity(row.delta_base_quantity) === 0n
      || scaledQuantity(row.before_quantity) + scaledQuantity(row.delta_base_quantity) !== scaledQuantity(row.after_quantity)) fail();
  }
}
function sameCorrection(item: Amendment, draft: CorrectionDraft) {
  if (item.reason !== draft.reason.trim() || item.allocations.length !== draft.allocations.length || item.stock_corrections.length !== draft.stock_corrections.length) fail();
  draft.allocations.forEach((input, index) => {
    const row = item.allocations[index]; if (row.order_id !== input.order_id || row.order_item_id !== input.order_item_id || row.delta_quantity !== input.delta_quantity) fail();
  });
  draft.stock_corrections.forEach((input, index) => {
    const row = item.stock_corrections[index];
    if (row.ingredient_id !== input.ingredient_id || row.corrects_movement_id !== input.corrects_movement_id || scaledQuantity(row.delta_base_quantity) !== scaledQuantity(input.delta_base_quantity)) fail();
  });
}
export function checkedCorrectionPreview(value: unknown, draft: CorrectionDraft, preparationId: string): CorrectionPreview {
  const item = value as CorrectionPreview;
  amendment(item, preparationId); if (!instant(item.expires_at)) fail(); sameCorrection(item, draft);
  if (item.allocations.some((row, index) => row.expected_version !== draft.allocations[index].expected_version) || item.stock_corrections.some((row, index) => row.expected_version !== draft.stock_corrections[index].expected_version)) fail();
  return item;
}
export function checkedCorrection(value: unknown, preparationId: string): PreparationCorrection {
  const item = value as PreparationCorrection;
  amendment(item, preparationId);
  if (!text(item.operation_id) || !instant(item.recorded_at) || !text(item.recorded_by) || item.stock_corrections.some(row => !text(row.stock_movement_id))
    || new Set(item.stock_corrections.map(row => row.stock_movement_id)).size !== item.stock_corrections.length) fail();
  return item;
}
// A saved correction answers with every order and ingredient it changed, each showing the count or stock the correction describes.
export function checkedCorrectionResult(value: unknown, draft: CorrectionDraft | null, operationId: string, preparationId: string): CorrectionResult {
  const item = value as CorrectionResult;
  if (!item || typeof item !== 'object' || !Array.isArray(item.orders) || !Array.isArray(item.ingredients)) fail();
  const saved = checkedCorrection(item.correction, preparationId);
  if (saved.operation_id !== operationId) fail();
  if (draft) sameCorrection(saved, draft);
  if (item.orders.length !== new Set(saved.allocations.map(row => row.order_id)).size || item.ingredients.length !== saved.stock_corrections.length) fail();
  item.orders.forEach(checkedOrder); item.ingredients.forEach(checkedIngredient);
  saved.allocations.forEach((row, index) => {
    const order = item.orders.find(candidate => candidate.id === row.order_id), entry = order?.items.find(candidate => candidate.id === row.order_item_id), read = draft?.allocations[index].expected_version;
    if (!order || !entry || read !== undefined && order.version <= read || entry.quantity !== row.ordered_quantity || entry.prepared_quantity !== row.prepared_after || entry.remaining_quantity !== row.remaining_after) fail();
  });
  saved.stock_corrections.forEach((row, index) => {
    const ingredient = item.ingredients.find(candidate => candidate.id === row.ingredient_id), read = draft?.stock_corrections[index].expected_version;
    if (!ingredient || ingredient.base_unit !== row.base_unit || read !== undefined && ingredient.version <= read || scaledQuantity(ingredient.stock_on_hand) !== scaledQuantity(row.after_quantity)) fail();
  });
  return item;
}
export function checkedCorrections(value: unknown, preparationId: string): PreparationCorrection[] {
  const items = (value as {items?: PreparationCorrection[]} | null)?.items;
  if (!Array.isArray(items) || new Set(items.map(item => item?.id)).size !== items.length) fail();
  items.forEach(item => checkedCorrection(item, preparationId));
  return items;
}
export function checkedCorrectionOperation(value: unknown, id: string, preparationId: string): Operation<CorrectionResult> {
  return operation(value, id, 'preparation_correction', body => checkedCorrectionResult(body, null, id, preparationId).correction.id);
}
