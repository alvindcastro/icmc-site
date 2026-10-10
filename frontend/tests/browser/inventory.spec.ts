import {expect, test, type Page} from '@playwright/test';
import {inventorySeed,purchaseSeed} from '../inventory-helpers';
import type {FetchTransport} from '../../src/api/types';
async function signIn(page: Page, transport: FetchTransport, path = '/purchases', heading = 'Purchases') {
  await page.route('**/api/v1/**', async route => {const request = route.request(); const response = await transport(request.url(),{method:request.method(),headers:request.headers(),body:request.postData() ?? undefined}); await route.fulfill({status:response.status,body:await response.text(),contentType:'application/json'});});
  await page.goto(path); await page.getByLabel('Token',{exact:true}).fill('local-admin-token'); await page.getByRole('button',{name:'Sign in',exact:true}).click(); await expect(page.getByRole('heading',{name:heading,exact:true})).toBeVisible();
}
async function fill(page: Page, amount = '24') {
  await page.getByRole('button',{name:'Record purchase',exact:true}).click(); await expect(page.getByLabel('Purchased on',{exact:true})).toBeFocused();
  await page.getByLabel('Purchased on',{exact:true}).fill('2026-10-07'); await page.getByLabel('Supplier',{exact:true}).fill('SupplierLongName'.repeat(12)); await page.getByLabel('Purchase note').fill('Receipt note '.repeat(120));
  await page.getByLabel('Find ingredient').fill('flour'); await page.getByRole('button',{name:'Add Flour',exact:true}).click(); await page.getByLabel('Quantity 1',{exact:true}).fill('2'); await page.getByLabel('Purchase unit 1',{exact:true}).selectOption('kg'); await page.getByLabel('Total ingredient cost 1 (USD)',{exact:true}).fill(amount);
}
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (await page.getByRole('dialog').count()) expect(await page.getByRole('dialog').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
}
for (const width of [320,375,768,1280]) test(`ingredients, pack purchase review, receipt and history fit ${width}px`,async ({page}) => {
  await page.setViewportSize({width,height:900}); const {fixture,item} = await inventorySeed(); await signIn(page,fixture.fetch); await fill(page);
  await page.getByLabel('Purchase unit 1',{exact:true}).selectOption('bag'); await page.getByLabel('Contents per pack 1',{exact:true}).fill('1000');
  await fits(page); await page.screenshot({path:`test-results/purchase-entry-${width}.png`,fullPage:true});
  await page.getByRole('button',{name:'Review purchase',exact:true}).click(); await expect(page.locator('.transaction-review td[data-label="Normalized quantity"]')).toContainText('2000 g'); await fits(page); await page.screenshot({path:`test-results/purchase-review-${width}.png`,fullPage:true});
  await page.getByRole('button',{name:'Save purchase',exact:true}).click(); await expect(page.getByRole('heading',{name:'DEV-P0001',exact:true})).toBeVisible(); await fits(page); await page.screenshot({path:`test-results/purchase-receipt-${width}.png`,fullPage:true});
  if(width <= 768) {const audit=page.getByRole('link',{name:'Stock movement',exact:true});expect(await audit.evaluate(el=>getComputedStyle(el).gridColumnStart)).toBe('2');expect((await audit.boundingBox())!.height).toBeGreaterThanOrEqual(44);}
  await page.getByRole('link',{name:'Flour',exact:true}).click(); await expect(page.getByRole('heading',{name:'Flour',exact:true})).toBeVisible(); await expect(page.getByRole('link',{name:'DEV-P0001',exact:true})).toBeVisible(); await fits(page); await page.screenshot({path:`test-results/ingredient-history-${width}.png`,fullPage:true});
  await page.getByRole('button',{name:'Record waste',exact:true}).click(); await page.getByLabel('Stock change (g)').fill('-100'); await page.getByLabel('Reason',{exact:true}).fill('Spilled'); await page.getByRole('button',{name:'Review movement',exact:true}).click(); await expect(page.getByText('2000 g -> 1900 g',{exact:true})).toBeVisible(); await fits(page); await page.getByRole('button',{name:'Save movement',exact:true}).click(); await expect(page.getByText('Version 3',{exact:true})).toBeVisible();
  expect(item.id).toBeTruthy();
});
test('keyboard focus returns and dirty history navigation names the inventory workflow',async ({page}) => {
  const {fixture} = await inventorySeed(); await signIn(page,fixture.fetch,'/ingredients','Ingredients'); await page.getByRole('link',{name:'Flour',exact:true}).click();
  const edit = page.getByRole('button',{name:'Edit ingredient',exact:true}); await edit.focus(); await page.keyboard.press('Enter'); await expect(page.getByLabel('Ingredient name')).toBeFocused();
  await page.keyboard.press('Shift+Tab'); expect(await page.getByRole('dialog').evaluate(el => el.contains(document.activeElement))).toBe(true); await page.keyboard.press('Escape'); await expect(edit).toBeFocused();
  await edit.click(); await page.getByLabel('Ingredient name').fill('Retained flour'); await page.evaluate(() => history.back()); await expect(page.getByRole('heading',{name:'Leave inventory?'})).toBeVisible();
  await page.getByRole('button',{name:'Stay editing'}).click(); await expect(page.getByRole('heading',{name:'Leave inventory?'})).not.toBeVisible(); await expect(page.getByLabel('Ingredient name')).toHaveValue('Retained flour');
  await page.getByLabel('Ingredient name').focus(); await page.keyboard.press('Escape'); await page.getByRole('button',{name:'Discard changes'}).click(); await expect(edit).toBeFocused();
});
test('maximum safe cost and long text fit 200 percent text zoom',async ({page}) => {
  await page.setViewportSize({width:640,height:900}); const {fixture} = await inventorySeed('g','Flour','9007199254740991'); await signIn(page,fixture.fetch);
  await page.addStyleTag({content:'html {font-size:200% !important;}'}); await fill(page,'90071992547409.91'); await fits(page);
  await page.getByRole('button',{name:'Review purchase',exact:true}).click(); await expect(page.locator('.transaction-review td[data-label="Normalized quantity"]')).toContainText('2000 g'); await fits(page); await page.screenshot({path:'test-results/purchase-zoom.png',fullPage:true});
  await page.getByRole('button',{name:'Save purchase',exact:true}).click(); await expect(page.getByRole('heading',{name:'DEV-P0001',exact:true})).toBeVisible(); await fits(page);
});
test('receipt stock link locates its original movement beyond the first history page',async ({page}) => {
  const {fixture,api,item} = await inventorySeed(); const session = await api.request<any>('/auth/sign-in',{method:'POST',body:{username:'admin',token:'local-admin-token'}}); api.setCsrfToken(session.csrf_token);
  const draft = {purchased_on:'2026-10-07',supplier:'Market',note:'',items:[{client_line_id:'line',ingredient_id:item.id,quantity:'2',unit:'kg',pack_contents:null,total_cost_minor:2400}]};
  const preview = await api.request<any>('/purchases/preview',{method:'POST',body:{draft}}); const {purchase} = await api.request<any>('/purchases',{method:'POST',operationId:'receipt',body:{draft,preview_id:preview.id}});
  for (let i = 0; i < 26; i++) {const body = {expected_version:i+2,type:'correction',delta_base_quantity:'1',reason:`Later recount ${i}`,preparation_id:null,corrects_movement_id:null}; const p = await api.request<any>(`/ingredients/${item.id}/movement-preview`,{method:'POST',body}); await api.request(`/ingredients/${item.id}/movements`,{method:'POST',operationId:`movement-${i}`,body:{...body,preview_id:p.id}});}
  await api.request('/auth/sign-out',{method:'POST'}); await signIn(page,fixture.fetch,`/purchases/${purchase.id}`,'DEV-P0001'); await page.getByRole('link',{name:'Stock movement',exact:true}).click();
  await expect(page.locator(`#movement-${purchase.items[0].stock_movement_id}`)).toBeVisible(); await expect(page.getByRole('link',{name:'Purchase receipt',exact:true})).toBeVisible();
});
test('expiry clears purchase entry and re-login recovers a committed save without replay',async({page})=>{
  const {fixture}=await inventorySeed();let posts=0;
  await signIn(page,async(input,init)=>{const response=await fixture.fetch(input,init);if(String(input).endsWith('/purchases') && init?.method==='POST'){posts++;fixture.expire();return new Response('{}',{status:201});}return response;});
  await fill(page);await page.getByRole('button',{name:'Review purchase',exact:true}).click();await page.getByRole('button',{name:'Save purchase',exact:true}).click();await expect(page.getByText(/Save result unconfirmed/)).toBeVisible();
  await page.getByRole('button',{name:'Check save status'}).click();await expect(page.getByRole('heading',{name:'Sign in',exact:true})).toBeVisible();expect(await page.getByLabel('Purchase note').count()).toBe(0);
  const stored=await page.evaluate(()=>Object.values(sessionStorage));expect(stored).toHaveLength(1);expect(stored[0]).toMatch(/^[0-9a-f-]{36}$/);
  await page.getByLabel('Token',{exact:true}).fill('local-admin-token');await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('button',{name:'Record purchase',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Check save status'}).click();await expect(page.getByRole('heading',{name:'DEV-P0001',exact:true})).toBeVisible();expect(posts).toBe(1);expect(await page.evaluate(()=>sessionStorage.length)).toBe(0);
});
test('ingredient filters, pagination and scroll position survive detail return',async({page})=>{
  const {fixture,api}=await purchaseSeed();const session=await api.request<any>('/auth/sign-in',{method:'POST',body:{username:'admin',token:'local-admin-token'}});api.setCsrfToken(session.csrf_token);
  for(let i=0;i<26;i++)await api.request('/ingredients',{method:'POST',operationId:`ingredient-${i}`,body:{name:`Ingredient ${String(i).padStart(2,'0')}`,base_unit:'g',low_stock_threshold:'100'}});
  await api.request('/auth/sign-out',{method:'POST'});await signIn(page,fixture.fetch,'/ingredients?low_stock=true','Ingredients');await page.getByRole('button',{name:'Next ingredients page'}).click();await expect(page).toHaveURL(/page=2/);await expect(page.getByRole('link',{name:'Ingredient 25',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Previous ingredients page'}).click();const link=page.locator('.order-table tbody tr').nth(9).getByRole('link');const name=await link.innerText();await link.scrollIntoViewIfNeeded();const scroll=await page.evaluate(()=>scrollY);expect(scroll).toBeGreaterThan(0);await link.click();await expect(page.getByRole('heading',{name,exact:true})).toBeVisible();
  await page.getByRole('link',{name:'Back to ingredients',exact:true}).click();await expect(page).toHaveURL(/low_stock=true/);await expect(page.getByRole('link',{name,exact:true})).toBeVisible();await expect.poll(()=>page.evaluate(previous=>Math.abs(scrollY-previous),scroll)).toBeLessThan(3);
});
