import {expect, test, type Page} from '@playwright/test';
import {financialApi, draftFor} from '../phase4-helpers';
import type {FetchTransport} from '../../src/api/types';
import type {Order} from '../../src/orders/types';

async function signIn(page: Page, id: string, transport: FetchTransport, print = false) {
  await page.route('**/api/v1/**', async route => {
    const request = route.request(); const response = await transport(request.url(), {method: request.method(), headers: request.headers(), body: request.postData() ?? undefined});
    await route.fulfill({status: response.status, body: await response.text(), contentType: 'application/json'});
  });
  await page.goto(`/orders/${id}${print ? '/print' : ''}`); await page.getByLabel('Token', {exact: true}).fill('local-admin-token'); await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'DEV-0001'})).toBeVisible();
}
async function noOverflow(page: Page) {expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);}
async function record(page: Page, kind: 'Payment' | 'Refund', amount: string) {
  await page.getByRole('button', {name: `Record ${kind.toLowerCase()}`, exact: true}).click(); await page.getByLabel(`${kind} amount`).fill(amount); await page.getByLabel(`${kind} date`).fill('2026-10-07');
  if (kind === 'Refund') await page.getByLabel('Refund reason').fill('Return to customer');
  await page.getByRole('button', {name: `Review ${kind.toLowerCase()}`, exact: true}).click(); await expect(page.getByRole('region', {name: `${kind} review`})).toBeVisible();
  await page.getByRole('button', {name: `Confirm ${kind.toLowerCase()}`, exact: true}).click(); await expect(page.getByRole('dialog')).not.toBeVisible();
}
for (const width of [320, 375, 768, 1280]) {
  test(`ledger, refund review and printable snapshot fit ${width}px`, async ({page}) => {
    await page.setViewportSize({width, height: 900}); const {api, fixture, order, payment} = await financialApi(); await payment(); await api.request('/auth/sign-out', {method: 'POST', body: {}}); await signIn(page, order.id, fixture.fetch);
    await noOverflow(page); await page.screenshot({path: `test-results/ledger-${width}.png`, fullPage: true});
    await page.getByRole('button', {name: 'Record refund', exact: true}).click(); await expect(page.getByLabel('Refund amount')).toBeFocused();
    await page.getByLabel('Refund amount').fill('30'); await page.getByLabel('Refund date').fill('2026-10-07'); await page.getByLabel('Refund reason').fill('Customer request '.repeat(40));
    await page.getByLabel('Refund reference').fill('LongReference'.repeat(15)); await page.getByLabel('Refund note').fill('Refund audit note '.repeat(100));
    expect(await page.getByRole('dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.getByRole('button', {name: 'Review refund', exact: true}).click(); await expect(page.getByRole('heading', {name: 'Refund review', exact: true})).toBeInViewport();
    expect(await page.getByRole('dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true); await page.screenshot({path: `test-results/refund-review-${width}.png`, fullPage: true});
    await page.getByRole('button', {name: 'Confirm refund', exact: true}).click(); await expect(page.getByText('Version 3', {exact: true})).toBeVisible(); await noOverflow(page);
    await page.getByRole('link', {name: 'Print order', exact: true}).click(); await expect(page.getByRole('region', {name: 'Printable order summary'})).toBeVisible();
    await page.emulateMedia({media: 'print'}); await expect(page.getByRole('navigation')).not.toBeVisible(); await expect(page.getByRole('button', {name: 'Print summary'})).not.toBeVisible(); await expect(page.getByRole('link', {name: 'Back to order', exact: true})).not.toBeVisible();
    expect(await page.locator('.snapshot-table').evaluate(element => getComputedStyle(element).display)).toBe('table');
    expect(await page.locator('.snapshot-table td').first().evaluate(element => getComputedStyle(element).display)).toBe('table-cell');
    await noOverflow(page); await page.screenshot({path: `test-results/order-print-${width}.png`, fullPage: true});
    if (width === 1280) await page.pdf({path: 'test-results/order-summary.pdf', format: 'A4', printBackground: true});
  });
}
test('deposit, reduced-order credit and separate refunds complete the cancellation pilot', async ({page}) => {
  const {api, fixture, order} = await financialApi(); await api.request('/auth/sign-out', {method: 'POST', body: {}}); await signIn(page, order.id, fixture.fetch);
  await record(page, 'Payment', '180'); await expect(page.getByText('Partial', {exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Edit order', exact: true}).click(); await page.getByLabel('Quantity for item 1', {exact: true}).fill('1'); await page.getByLabel('Tax amount').fill('15'); await page.getByRole('button', {name: 'Review order', exact: true}).click();
  const save = page.getByRole('button', {name: 'Save changes', exact: true}); await expect(save).toBeDisabled(); await page.getByRole('checkbox', {name: 'Acknowledge customer credit of $30.00'}).check(); await save.click(); await expect(page.getByText('Version 3', {exact: true})).toBeVisible(); await expect(page.getByText('Credit due', {exact: true})).toBeVisible();
  await record(page, 'Refund', '30'); await expect(page.getByText('Paid', {exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Cancel order', exact: true}).click(); await page.getByLabel('Cancellation reason').fill('Customer cancelled after deposit'); await page.getByRole('button', {name: 'Confirm cancellation', exact: true}).click();
  await expect(page.getByText('Version 5', {exact: true})).toBeVisible(); await expect(page.getByRole('button', {name: 'Record payment', exact: true})).toBeDisabled(); await record(page, 'Refund', '150');
  await expect(page.getByText('Version 6', {exact: true})).toBeVisible(); await expect(page.getByText('Paid', {exact: true})).toBeVisible(); await expect(page.getByRole('region', {name: 'Payments and refunds'}).locator('tbody tr')).toHaveCount(3);
  await page.getByRole('link', {name: 'Back to orders', exact: true}).click(); await expect(page.getByRole('heading', {name: 'Orders', exact: true})).toBeVisible(); await expect(page.getByRole('table').getByText('Cancelled', {exact: true})).toBeVisible(); await expect(page.getByText('Due $0.00', {exact: true})).toBeVisible();
});
test('keyboard focus, dirty history guard and sequential unpaid fulfillment', async ({page}) => {
  const {api, fixture, order} = await financialApi(); await api.request('/auth/sign-out', {method: 'POST', body: {}}); await signIn(page, order.id, fixture.fetch);
  await page.getByRole('link', {name: 'Back to orders', exact: true}).click(); await expect(page.getByRole('heading', {name: 'Orders', exact: true})).toBeVisible(); await page.getByRole('link', {name: 'DEV-0001', exact: true}).click();
  const deposit = page.getByRole('button', {name: 'Record payment', exact: true}); await deposit.focus(); await page.keyboard.press('Enter'); await expect(page.getByLabel('Payment amount')).toBeFocused();
  await page.keyboard.press('Shift+Tab'); expect(await page.getByRole('dialog').evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape'); await expect(deposit).toBeFocused(); await deposit.click(); await page.getByLabel('Payment method').selectOption('bank_transfer');
  await page.evaluate(() => history.back()); await expect(page.getByRole('heading', {name: 'Leave order?'})).toBeVisible(); await page.getByRole('button', {name: 'Stay editing'}).click(); await expect(page.getByRole('heading', {name: 'Leave order?'})).not.toBeVisible(); await expect(page.getByLabel('Payment method')).toHaveValue('bank_transfer'); await page.getByLabel('Payment amount').focus();
  await page.keyboard.press('Escape'); await page.getByRole('button', {name: 'Discard changes'}).click();
  await page.getByRole('button', {name: 'Start preparing', exact: true}).click(); await expect(page.getByRole('button', {name: 'Confirm preparing'})).toBeFocused(); await page.keyboard.press('Enter'); await expect(page.getByText('Version 2', {exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Mark ready', exact: true}).click(); await expect(page.getByRole('button', {name: 'Confirm ready'})).toBeDisabled(); await page.getByRole('checkbox', {name: 'Food is ready for pickup or delivery'}).check(); await page.getByRole('button', {name: 'Confirm ready'}).click();
  await page.getByRole('button', {name: 'Complete order', exact: true}).click(); await page.getByRole('checkbox', {name: 'Order has been fulfilled'}).check(); await page.getByRole('button', {name: 'Confirm completion'}).click(); await expect(page.getByText('Version 4', {exact: true})).toBeVisible(); await expect(page.getByText('Unpaid', {exact: true})).toBeVisible(); await expect(page.getByRole('button', {name: 'Cancel order', exact: true})).toBeDisabled();
});
test('malformed payment response reconciles once, expiry clears refund input and re-login recovers only the UUID', async ({page}) => {
  const {api, fixture, order} = await financialApi(); await api.request('/auth/sign-out', {method: 'POST', body: {}}); let posts = 0; let expire = false;
  await signIn(page, order.id, async (input, init) => {
    const response = await fixture.fetch(input, init);
    if (init?.method === 'POST' && /\/(payments|refunds)$/.test(String(input))) {posts++; if (expire) fixture.expire(); return new Response('{}', {status: 201});}
    return response;
  });
  await page.getByRole('button', {name: 'Record payment', exact: true}).click(); await page.getByLabel('Payment amount').fill('180'); await page.getByLabel('Payment date').fill('2026-10-07'); await page.getByRole('button', {name: 'Review payment'}).click(); await page.getByRole('button', {name: 'Confirm payment'}).click();
  await expect(page.getByRole('button', {name: 'Confirm payment'})).toBeDisabled(); await page.getByRole('button', {name: 'Check transaction status'}).click(); await expect(page.getByText('Version 2', {exact: true})).toBeVisible(); expect(posts).toBe(1);
  expire = true; await page.getByRole('button', {name: 'Record refund', exact: true}).click(); await page.getByLabel('Refund amount').fill('30'); await page.getByLabel('Refund date').fill('2026-10-07'); await page.getByLabel('Refund reason').fill('Private refund reason'); await page.getByRole('button', {name: 'Review refund'}).click(); await page.getByRole('button', {name: 'Confirm refund'}).click();
  await page.getByRole('button', {name: 'Check transaction status'}).click(); await expect(page.getByRole('button', {name: 'Sign in', exact: true})).toBeVisible(); expect(await page.evaluate(() => Object.values(sessionStorage))).not.toContain('Private refund reason');
  await page.getByLabel('Token', {exact: true}).fill('local-admin-token'); await page.getByRole('button', {name: 'Sign in', exact: true}).click(); await expect(page.getByRole('button', {name: 'Record payment', exact: true})).toBeDisabled();
  await page.getByRole('button', {name: 'Check save status'}).click(); await expect.poll(() => page.evaluate(() => sessionStorage.length)).toBe(0); await expect(page.getByText('Version 3', {exact: true})).toBeVisible(); expect(posts).toBe(2);
});
test('maximum safe money and long financial references fit 200 percent text zoom', async ({page}) => {
  await page.setViewportSize({width: 640, height: 900}); const {api, fixture, order} = await financialApi(); const draft = draftFor(order); draft.tax_minor = Number.MAX_SAFE_INTEGER - order.total_minor;
  const quote = await api.request<{id: string}>('/orders/quote', {method: 'POST', body: {order_id: order.id, expected_version: 1, draft}});
  await api.request<Order>(`/orders/${order.id}`, {method: 'PUT', operationId: 'max-money', body: {expected_version: 1, quote_id: quote.id, draft, acknowledge_credit: false}}); await api.request('/auth/sign-out', {method: 'POST', body: {}}); await signIn(page, order.id, fixture.fetch);
  await page.addStyleTag({content: 'html {font-size: 200% !important;}'}); await noOverflow(page); await page.getByRole('button', {name: 'Record payment', exact: true}).click(); await page.getByLabel('Payment amount').fill('90071992547409.91'); await page.getByLabel('Payment date').fill('2026-10-07'); await page.getByLabel('Payment reference').fill('LongReference'.repeat(15));
  await page.getByRole('button', {name: 'Review payment'}).click(); expect(await page.getByRole('dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true); await noOverflow(page); await page.screenshot({path: 'test-results/payment-text-zoom.png', fullPage: true});
  await page.getByRole('button', {name: 'Confirm payment'}).click(); await expect(page.getByText('Paid', {exact: true})).toBeVisible(); await noOverflow(page); await page.screenshot({path: 'test-results/ledger-text-zoom.png', fullPage: true});
});
