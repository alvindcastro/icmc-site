import { expect, test, type Page } from '@playwright/test';
import { sampleSession, sampleSettings } from '../helpers';

async function api(page: Page, name = 'Admin') {
  let signedIn = false;
  let expired = false;
  let signOutFails = false;
  const calls: string[] = [];
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    calls.push(`${route.request().method()} ${path}`);
    const session = sampleSession();
    session.user.display_name = name;
    const failure = (code: string, message: string) => ({ error: { code, message, request_id: 'browser-test', field_errors: [], details: {} } });
    if (path === '/auth/csrf') return route.fulfill({ json: { csrf_token: 'token' } });
    if (path === '/auth/sign-in') {
      expect(route.request().postDataJSON()).toEqual({ username: 'admin', token: 'local-admin-token' });
      signedIn = true; expired = false; return route.fulfill({ json: session });
    }
    if (path === '/auth/sign-out') {
      if (signOutFails) return route.abort('failed');
      signedIn = false; return route.fulfill({ status: 204 });
    }
    if (!signedIn || expired) return route.fulfill({ status: 401, json: failure(expired ? 'session_expired' : 'unauthenticated', 'Sign in to continue.') });
    if (path === '/auth/session') return route.fulfill({ json: session });
    if (path === '/settings') return route.fulfill({ json: sampleSettings });
    return route.fulfill({ status: 404, json: failure('not_found', 'Not available.') });
  });
  return { calls, expire: () => { expired = true; }, failSignOut: (value: boolean) => { signOutFails = value; } };
}

async function signIn(page: Page) {
  await expect(page.getByLabel('Username')).toHaveValue('admin');
  await page.getByLabel('Token', { exact: true }).fill('local-admin-token');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('keyboard sign-in, protected return, focus, expiry, and sign-out', async ({ page }) => {
  const server = await api(page);
  await page.goto('/account');
  await expect(page.getByLabel('Username')).toBeVisible();
  await page.getByLabel('Username').focus();
  await expect(page.getByLabel('Username')).toHaveValue('admin');
  await page.keyboard.press('Tab');
  await page.keyboard.type('local-admin-token');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Show token' })).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'My account' })).toBeVisible();
  server.expire();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('Your session expired. Sign in to continue.')).toBeVisible();
  await expect(page.getByText('Admin', { exact: true })).toHaveCount(0);
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'My account' })).toBeVisible();
  expect(server.calls.filter(call => call.startsWith('POST ') && !call.startsWith('POST /auth/'))).toHaveLength(0);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByText('Signed out.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Username')).toBeVisible();
});

test('phone navigation traps focus and returns it when closed', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await api(page);
  await page.goto('/');
  await signIn(page);
  const trigger = page.getByRole('button', { name: 'Open navigation' });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Shift+Tab');
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await dialog.getByRole('link', { name: 'My account' }).click();
  await expect(page.getByRole('heading', { name: 'My account' })).toBeVisible();
  await expect(dialog).not.toBeVisible();
});

for (const width of [320, 375, 768, 1280]) {
  test(`renders assets and avoids overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await api(page, 'Very Long Staff Name '.repeat(8));
    await page.goto('/');
    await expect(page.getByLabel('Username')).toBeVisible();
    await expect(page.locator('.food-strip')).toHaveJSProperty('complete', true);
    expect(await page.locator('.food-strip').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/sign-in-${width}.png`, fullPage: true });
    await signIn(page);
    await expect(page.getByText('USD')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const settings = page.getByRole('heading', { name: 'Business settings' });
    await expect(settings).toBeVisible();
    await page.screenshot({ path: `test-results/workspace-${width}.png`, fullPage: true });
  });
}

test('200 percent text zoom does not clip controls or business settings', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 900 });
  await api(page);
  await page.goto('/');
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
  await signIn(page);
  await expect(page.getByText('America/Los_Angeles')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/workspace-text-zoom.png', fullPage: true });
});

test('uncertain sign-out survives reload until explicitly confirmed', async ({ page }) => {
  const server = await api(page);
  await page.goto('/');
  await signIn(page);
  server.failSignOut(true);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry sign-out' })).toBeEnabled();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeDisabled();
  await expect(page.getByText('USD')).toHaveCount(0);
  server.failSignOut(false);
  await page.getByRole('button', { name: 'Retry sign-out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
});
