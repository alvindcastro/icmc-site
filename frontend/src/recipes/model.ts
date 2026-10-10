import type {BusinessSettings, MenuVariant} from '../api/types';
import {scaledQuantity} from '../inventory/model';
import type {RecipeItemInput, RecipeYield} from './types';
// Recipes belong to menu variants and are built from ingredient records, so all three workflows must be available.
export const recipesEnabled = (settings: BusinessSettings) => settings.capabilities.menu && settings.capabilities.recipes && settings.capabilities.inventory;
export const yieldOf = (variant: Pick<MenuVariant, 'selling_unit' | 'package_contents'>): RecipeYield => ({quantity: 1, selling_unit: variant.selling_unit, package_contents: variant.package_contents});
export function sameYield(a: RecipeYield, b: RecipeYield): boolean {
  return a.quantity === b.quantity && a.selling_unit === b.selling_unit && (a.package_contents?.quantity ?? null) === (b.package_contents?.quantity ?? null);
}
// Quantities are decimal strings, so "0.75" and "0.750" are the same saved amount.
export function sameItems(a: RecipeItemInput[], b: RecipeItemInput[]): boolean {
  return a.length === b.length && a.every((item, i) => item.ingredient_id === b[i].ingredient_id && item.unit === b[i].unit && scaledQuantity(item.quantity) === scaledQuantity(b[i].quantity));
}
