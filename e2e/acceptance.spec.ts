import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Acceptance tests mapped to SRS V1.5 §14 (AT-xx) and §5.3 (Drive add actions).
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, ADMIN_KEY (defaults match the local seed).
const URL_ = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON = process.env.SUPABASE_ANON_KEY ?? '';
const ADMIN = process.env.ADMIN_KEY ?? 'local-dev-admin-key-0000';
const run = Date.now().toString(36);
const EDCS = `e2e-edcs-${run}`;
const DIE = `e2e-die-${run}`;
const fn = (path: string) => `${URL_}/functions/v1/admin-api${path}`;

const headers = (admin = true) => ({ apikey: ANON, authorization: `Bearer ${ANON}`, ...(admin ? { 'x-admin-key': ADMIN } : {}) });
const fixture = (name: string) => ({ name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: readFileSync(`e2e/fixtures/${name}`) });

async function upload(api: APIRequestContext, projectId: string, mainModuleId: string, file: string, connectionId?: string): Promise<string> {
  const res = await api.post(fn(`/projects/${projectId}/sources/upload`), {
    headers: headers(),
    multipart: { file: fixture(file), confirmProjectId: projectId, ...(connectionId ? { connectionId } : { mainModuleId }) },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).connectionId;
}
async function snapshot(api: APIRequestContext, projectId: string) {
  const res = await api.get(`${URL_}/rest/v1/v_published_snapshot?project_id=eq.${projectId}&select=*`, { headers: headers(false) });
  return ((await res.json()) as any[])[0] ?? null;
}
async function state(api: APIRequestContext, projectId: string) {
  const res = await api.get(`${URL_}/rest/v1/project_state?project_id=eq.${projectId}&select=*`, { headers: headers(false) });
  return ((await res.json()) as any[])[0] ?? null;
}
async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v)) {
    if (Date.now() > end) throw new Error(`timed out; last value ${JSON.stringify(v)?.slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 1000));
    v = await fn();
  }
  return v;
}
const kpi = (page: Page, label: string) => page.locator('section', { has: page.getByText(label, { exact: true }) }).first();

test.describe.configure({ mode: 'serial' });
let umConn = '';
let dieConn = '';

test('AT-05: homepage shows the product name and Open Dashboard; no company name, no logo, no login form', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('QA LiveSync');
  await expect(page.getByRole('heading', { name: 'QA LiveSync' })).toBeVisible();
  await expect(page.getByText(/Informatics/i)).toHaveCount(0);
  await expect(page.locator('img')).toHaveCount(0);
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  await page.getByRole('link', { name: 'Open Dashboard' }).click();
  await expect(page).toHaveURL(/\/projects$/);
});

test('AT-21: management and Drive endpoints reject callers without an admin key', async ({ request }) => {
  for (const [method, path] of [['post', '/projects'], ['post', '/projects/preview-from-folder'], ['get', '/picker-config']] as const) {
    const res = await request[method](fn(path), { headers: headers(false), data: {} });
    expect(res.status(), path).toBe(401);
  }
  const raw = await request.get(`${URL_}/rest/v1/mapping_reviews?select=*`, { headers: headers(false) });
  expect([401, 403, 404]).toContain(raw.status());
});

test('FR-GD-001/005: without a connected Google account the Drive flow explains itself and creates nothing', async ({ request }) => {
  const before = await (await request.get(`${URL_}/rest/v1/v_project_directory?select=project_id`, { headers: headers(false) })).json();
  const res = await request.post(fn('/projects/preview-from-folder'), { headers: headers(), data: { folderId: '1AbCdEfGhIjKlMnOpQrStUvWxYz' } });
  expect([409, 501]).toContain(res.status());
  const after = await (await request.get(`${URL_}/rest/v1/v_project_directory?select=project_id`, { headers: headers(false) })).json();
  expect(after.length).toBe(before.length);
  const create = await request.post(fn('/projects/from-folder'), { headers: headers(), data: { folderId: '1AbCdEfGhIjKlMnOpQrStUvWxYz', name: 'X', id: 'x-test' } });
  expect(create.status()).toBe(400); // NO / missing YES confirmation → nothing created
});

test('AT-06: EDCS and DIE created without code changes; distinct, empty, isolated', async ({ request, page }) => {
  for (const [id, name] of [[EDCS, 'EDCS e2e'], [DIE, 'DIE e2e']]) {
    expect((await request.post(fn('/projects'), { headers: headers(), data: { id, name } })).status()).toBe(201);
  }
  for (const [pid, mid, name] of [[EDCS, 'user-management', 'User Management'], [EDCS, 'hrms', 'HRMS'], [DIE, 'user-management', 'User Management']]) {
    const r = await request.post(fn(`/projects/${pid}/main-modules`), { headers: headers(), data: { id: mid, name } });
    expect(r.status(), await r.text()).toBe(201);
  }
  await page.goto('/projects');
  await expect(page.getByRole('heading', { name: 'EDCS e2e' })).toBeVisible();
  await page.goto(`/projects/${DIE}`);
  await expect(page.getByText('No validated snapshot yet')).toBeVisible();
});

test('+ Add scope: a source attached to User Management feeds only User Management', async ({ request }) => {
  umConn = await upload(request, EDCS, 'user-management', 'um-v1.xlsx');
  await upload(request, EDCS, 'hrms', 'hrms-v1.xlsx');
  const s = await waitFor(() => snapshot(request, EDCS), (v) => v?.payload?.table?.overall?.totalTc === 11);
  const um = s.payload.hierarchy.find((m: any) => m.mainModuleId === 'user-management');
  expect(um.submodules.map((x: any) => x.name)).toEqual(['User Creation', 'User Roles']);
  const hr = s.payload.table.mainModules.find((m: any) => m.mainModuleId === 'hrms');
  expect(hr.totalTc).toBe(3);
  expect(s.payload.kpis).toMatchObject({ totalTc: 11, passed: 6, openDefects: 1 });
  expect(await snapshot(request, DIE)).toBeNull();
});

test('AT-07/AT-11/AT-14: sidebar tree, Overall Dashboard scoped to one main module, exact KPI and chart titles', async ({ page }) => {
  await page.goto(`/projects/${EDCS}`);
  const nav = page.getByRole('navigation', { name: 'Projects and modules' });
  await nav.getByRole('button', { name: 'User Management' }).click();
  await expect(nav.getByRole('link', { name: 'User Creation' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Overall Dashboard' }).first()).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Add Google Drive sources to User Management' })).toBeVisible();
  await nav.getByRole('link', { name: 'Overall Dashboard' }).first().click();
  await expect(page).toHaveURL(/\/main\/user-management\/overall$/);
  for (const t of ['Total Number of TC', 'Test Cases Passed', 'Total Open Defects', 'Test Pass Ratio']) await expect(page.getByText(t, { exact: true }).first()).toBeVisible();
  await expect(kpi(page, 'Total Number of TC')).toContainText('8'); // User Management only — HRMS excluded
  for (const t of [
    '1 · Module Registration by Total Number of TC', '2 · Module by OverAll', '3 · Test Status by Module', '4 · Total Open Defects vs. Closed Defects',
    '5 · Total Open Defects vs. Closed Defects by Module', '6 · Defect Severity By Module', '7 · Defect Priority by Module', '8 · DSI by Module',
  ]) await expect(page.getByRole('heading', { name: t })).toBeVisible();
});

test('AT-12: Detailed Dashboard submodule filter updates KPIs, charts and table consistently', async ({ page }) => {
  await page.goto(`/projects/${EDCS}/main/user-management/detailed`);
  await expect(page.getByText('All Submodules (2)')).toBeVisible();
  await expect(kpi(page, 'Total Number of TC')).toContainText('8');
  await page.getByRole('button', { name: /User Roles/ }).click();
  await expect(page).toHaveURL(/sub=user-roles/);
  await expect(kpi(page, 'Total Number of TC')).toContainText('3');
  await expect(page.getByRole('cell', { name: /User Creation/ })).toHaveCount(0);
  await page.getByRole('button', { name: /User Creation/ }).click();
  await expect(kpi(page, 'Total Number of TC')).toContainText('8');
  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(page.getByText('All Submodules (2)')).toBeVisible();
});

test('AT-09/AT-19: a new tab becomes a new submodule after sync; open viewers update without refresh', async ({ request, page }) => {
  const before = await snapshot(request, EDCS);
  await page.goto(`/projects/${EDCS}/main/user-management/overall`);
  await expect(kpi(page, 'Total Number of TC')).toContainText('8');
  await upload(request, EDCS, 'user-management', 'um-v2.xlsx', umConn);
  const after = await waitFor(() => snapshot(request, EDCS), (v) => v && v.snapshot_id !== before.snapshot_id);
  expect(after.payload.hierarchy.find((m: any) => m.mainModuleId === 'user-management').submodules.map((x: any) => x.name)).toContain('Permissions');
  await expect(kpi(page, 'Total Number of TC')).toContainText('10');
  await expect(page.getByRole('navigation', { name: 'Projects and modules' }).getByRole('link', { name: 'Permissions' })).toBeVisible();
});

test('AT-10: an ambiguous tab is quarantined for review, not counted', async ({ request }) => {
  const before = await snapshot(request, EDCS);
  await upload(request, EDCS, 'user-management', 'um-collision.xlsx');
  const reviews = await waitFor(async () => (await request.get(fn(`/projects/${EDCS}/reviews`), { headers: headers() })).json(), (r: any[]) => r.some((x) => x.kind === 'submodule-name-collision'));
  expect(reviews.find((x: any) => x.kind === 'submodule-name-collision').status).toBe('open');
  const s = await snapshot(request, EDCS);
  expect(s.payload.kpis.totalTc).toBe(before.payload.kpis.totalTc);
});

test('AT-13: same main module, submodule names and TC ids in DIE never merge with EDCS', async ({ request }) => {
  dieConn = await upload(request, DIE, 'user-management', 'die-um.xlsx');
  const d = await waitFor(() => snapshot(request, DIE), (v) => v?.payload?.table?.rows?.length === 1);
  expect(d.payload.kpis.totalTc).toBe(2);
  expect((await snapshot(request, EDCS)).payload.kpis.totalTc).toBe(13);
});

test('AT-18: a failed validation keeps the last valid snapshot and shows the failure', async ({ request, page }) => {
  const before = await snapshot(request, DIE);
  await upload(request, DIE, 'user-management', 'die-invalid.xlsx', dieConn);
  await waitFor(() => state(request, DIE), (s) => s?.run_state === 'Validation Failed');
  expect((await snapshot(request, DIE)).snapshot_id).toBe(before.snapshot_id);
  await page.goto(`/projects/${DIE}`);
  await expect(page.getByText('Latest update failed validation')).toBeVisible();
});

test('Renaming a worksheet keeps the submodule (no duplicate)', async ({ request }) => {
  await upload(request, DIE, 'user-management', 'die-renamed.xlsx', dieConn);
  const s = await waitFor(() => snapshot(request, DIE), (v) => v?.payload.kpis.passed === 2);
  expect(s.payload.table.rows).toHaveLength(1);
  expect(s.payload.table.rows[0].moduleId).toBe('user-roles');
});

test('AT-22: mobile navigation drawer exposes the hierarchy and pages do not scroll sideways', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  await p.goto(`/projects/${EDCS}/main/user-management/overall`);
  await expect(p.getByText('Total Number of TC').first()).toBeVisible();
  expect(await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  await p.getByRole('button', { name: 'Open navigation' }).click();
  await expect(p.getByRole('dialog', { name: 'Navigation' }).getByRole('link', { name: 'Detailed Dashboard' }).first()).toBeVisible();
  await ctx.close();
});

test.afterAll(async ({ request }) => {
  for (const id of [EDCS, DIE]) await request.post(fn(`/projects/${id}/archive`), { headers: headers(), data: { confirm: id } });
});
