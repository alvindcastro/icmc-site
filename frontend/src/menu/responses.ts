import type { Category, Food, MenuVariant, MenuOperation, PageResult, PermittedAction } from '../api/types';
const text = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim());
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const confirmed = (value: unknown) => value === 'provisional' || value === 'confirmed';
const action = (value: PermittedAction | undefined) => value && typeof value.allowed === 'boolean'
  && (value.allowed || text(value.reason));
export function checkedFood(value: unknown): Food {
  const food = value as Food;
  if (!food || !text(food.id) || !positive(food.version) || !text(food.name) || !text(food.category_id) || typeof food.description !== 'string'
    || typeof food.available !== 'boolean' || !confirmed(food.confirmation_status) || !Array.isArray(food.variants)
    || !action(food.permitted_actions?.edit) || !action(food.permitted_actions?.add_variant)) throw new Error('The server returned an invalid food record.');
  food.variants.forEach(checkedVariant);
  if (food.variants.some(variant => variant.food_id !== food.id) || new Set(food.variants.map(variant => variant.id)).size !== food.variants.length) {
    throw new Error('The server returned an invalid food record.');
  }
  return food;
}
export function checkedVariant(value: unknown): MenuVariant {
  const variant = value as MenuVariant;
  if (!variant || !text(variant.id) || !text(variant.food_id) || !positive(variant.version) || !text(variant.label)
    || !['tray', 'piece', 'stick', 'package'].includes(variant.selling_unit) || !Number.isSafeInteger(variant.price_minor) || variant.price_minor < 0
    || typeof variant.available !== 'boolean' || !confirmed(variant.confirmation_status) || !action(variant.permitted_actions?.edit)
    || (variant.recipe_id !== null && !text(variant.recipe_id))
    || (variant.selling_unit === 'package' ? !positive(variant.package_contents?.quantity) || variant.package_contents?.unit !== 'piece' : variant.package_contents !== null)) {
    throw new Error('The server returned an invalid variant record.');
  }
  return variant;
}
export function checkedCategory(value: unknown): Category {
  const category = value as Category;
  if (!category || !text(category.id) || !text(category.name)) throw new Error('The server returned invalid categories.');
  return category;
}
export function checkedPage<T extends {id: string}>(value: unknown, item: (value: unknown) => T): PageResult<T> {
  const page = value as PageResult<T>;
  if (!page || !Array.isArray(page.items) || !positive(page.page) || !positive(page.limit) || page.limit > 100
    || !Number.isSafeInteger(page.total) || page.total < 0 || typeof page.has_next !== 'boolean' || page.items.length > page.limit || page.items.length > page.total
    || new Set(page.items.map(record => record?.id)).size !== page.items.length) throw new Error('The server returned an invalid menu page.');
  page.items.forEach(item);
  return page;
}
export function checkedOperation(value: unknown, id: string): MenuOperation {
  const operation = value as MenuOperation;
  if (!operation || operation.operation_id !== id || !['processing', 'succeeded', 'rejected'].includes(operation.state)) throw new Error('The server returned an invalid save status.');
  if (operation.state === 'succeeded') {
    if (!operation.result || ![200, 201].includes(operation.result.http_status) || !['food', 'variant'].includes(operation.resource_type ?? '')) throw new Error('The server returned an invalid save status.');
    const result = operation.resource_type === 'food' ? checkedFood(operation.result.body) : checkedVariant(operation.result.body);
    if (result.id !== operation.resource_id) throw new Error('The server returned an invalid save status.');
  }
  if (operation.state === 'rejected') {
    const error = operation.error;
    if (!error || !Number.isInteger(error.http_status) || error.http_status < 400 || error.http_status >= 500 || !text(error.error?.code)
      || !text(error.error?.message) || !Array.isArray(error.error.field_errors)
      || error.error.field_errors.some(field => !text(field.path) || !text(field.code) || !text(field.message))
      || !error.error.details || typeof error.error.details !== 'object') throw new Error('The server returned an invalid save status.');
  }
  return operation;
}
