import { describe, expect, it } from 'vitest';
import { checkedFood, checkedVariant, checkedCategory, checkedPage, checkedOperation } from '../src/menu/responses';
const action = {allowed: true, reason_code: null, reason: null};
const variant = {id: 'v1', food_id: 'f1', version: 1, label: 'Small', selling_unit: 'tray', price_minor: 6000,
  available: true, confirmation_status: 'provisional', package_contents: null, recipe_id: null, permitted_actions: {edit: action}};
const food = {id: 'f1', version: 1, name: 'Food', category_id: 'beef', description: '', available: true,
  confirmation_status: 'provisional', variants: [variant], permitted_actions: {edit: action, add_variant: action}};
const page = {items: [food], page: 1, limit: 25, total: 1, has_next: false};
const operation = {operation_id: 'op', state: 'succeeded', resource_type: 'food', resource_id: 'f1',
  result: {http_status: 201, body: food}, error: null, started_at: new Date().toISOString(), completed_at: new Date().toISOString()};
describe('menu response validation', () => {
  it('accepts valid authoritative menu records, lists, categories and operation results', () => {
    expect(checkedFood(food)).toEqual(food); expect(checkedVariant(variant)).toEqual(variant);
    expect(checkedPage(page, checkedFood)).toEqual(page); expect(checkedCategory({id: 'beef', name: 'Beef'})).toEqual({id: 'beef', name: 'Beef'});
    expect(checkedOperation(operation, 'op')).toEqual(operation);
  });
  it.each([{name: ''}, {version: 0}, {variants: null}, {available: 'yes'}, {confirmation_status: 'unknown'}, {permitted_actions: {}},
    {variants: [{...variant, food_id: 'other'}]}])('rejects malformed food %j', change => {
    expect(() => checkedFood({...food, ...change})).toThrow('invalid food record');
  });
  it.each([{price_minor: -1}, {price_minor: 0.5}, {price_minor: Number.MAX_SAFE_INTEGER + 1}, {selling_unit: 'box'},
    {selling_unit: 'package', package_contents: {quantity: 0, unit: 'piece'}}, {selling_unit: 'package', package_contents: {quantity: 100, unit: 'gram'}},
    {selling_unit: 'package', package_contents: null}, {package_contents: {quantity: 100, unit: 'piece'}}, {permitted_actions: {}}])('rejects malformed variant %j', change => {
    expect(() => checkedVariant({...variant, ...change})).toThrow('invalid variant record');
  });
  it.each([{total: -1}, {page: 0}, {limit: 101}, {has_next: 'yes'}, {items: null}, {items: [food, food]}])('rejects malformed page %j', change => {
    expect(() => checkedPage({...page, ...change}, checkedFood)).toThrow();
  });
  it.each([{operation_id: 'different'}, {state: 'unknown'}, {result: {http_status: 201, body: {...food, name: ''}}},
    {result: null}, {resource_id: 'other'}, {result: {http_status: 500, body: food}}, {state: 'rejected', result: null, error: {http_status: 422, error: {}}}])('rejects invalid operation %j', change => {
    expect(() => checkedOperation({...operation, ...change}, 'op')).toThrow();
  });
});
