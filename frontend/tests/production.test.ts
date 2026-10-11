// @vitest-environment node
import { expect, it } from 'vitest';
import { build } from 'vite';

it('excludes development fixture accounts and transport from production JavaScript', async () => {
  const previousEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const output = await build({ mode: 'production', logLevel: 'silent', build: { write: false } });
    if ('on' in output) throw new Error('Expected a one-off production build.');
    const outputs = Array.isArray(output) ? output : [output];
    const code = outputs.flatMap(bundle => bundle.output).filter(asset => asset.type === 'chunk').map(chunk => chunk.code).join('\n');
    expect(code.includes('local-demo')).toBe(false);
    expect(code.includes('local-admin-token')).toBe(false);
    expect(code.includes('fixture_admin')).toBe(false);
    expect(code.includes('fixture_caldereta')).toBe(false);
    expect(code.includes('Development skewers')).toBe(false);
    expect(code.includes('fixture_quote_')).toBe(false);
    expect(code.includes('fixture_order_')).toBe(false);
    expect(code.includes('fixture_ledger_')).toBe(false);
    expect(code.includes('fixture_ingredient_')).toBe(false);
    expect(code.includes('fixture_purchase_')).toBe(false);
    expect(code.includes('fixture_movement_')).toBe(false);
    expect(code.includes('fixture_inventory_preview_')).toBe(false);
    expect(code.includes('fixture_recipe_')).toBe(false);
    expect(code.includes('fixture_planning_')).toBe(false);
    expect(code.includes('fixture_preparation_')).toBe(false);
    expect(code.includes('fixture_correction_')).toBe(false);
    expect(code.includes('preparation-development-fixture')).toBe(false);
    expect(code.includes('Lorem ipsum supplier')).toBe(false);
    expect(code.includes('recipe-development-fixture')).toBe(false);
    expect(code.includes('ROUND_HALF_UP')).toBe(false);
  } finally { process.env.NODE_ENV = previousEnvironment; }
}, 20000);
