import { expect, test, type Page } from '@playwright/test';
import type { BoxType, WorkingStory } from '../src/shared/story.js';

const title = 'The target Unix system allowed 64 KB of stack';
const description = 'Describe the conditions already in place.';
const destinations = [
  { type: 'reasoning', title: 'Pastel needed more stack', label: 'informs', reverseLabel: 'informed by' },
  { type: 'proposal', title: 'Build a compiler that fits the target', label: 'motivates', reverseLabel: 'motivated by' },
  { type: 'event', title: 'Stallman tried the Pastel port', label: 'provides context for', reverseLabel: 'has context' },
] as const;

async function openProject(page: Page) {
  const response = await page.request.post('/api/projects', { data: { name: 'GCC context' } });
  expect(response.ok()).toBe(true);
  const { project, branch } = await response.json() as WorkingStory;
  await page.goto(`/?project=${project.id}&branch=${branch.id}`);
  await expect(page.getByRole('heading', { name: 'GCC context', exact: true })).toBeVisible();
  return `/api/projects/${project.id}/branches/${branch.id}`;
}

async function addBox(page: Page, boxTitle: string, type: BoxType) {
  await page.getByRole('button', { name: 'Add box', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add box', exact: true });
  await dialog.getByLabel('Title', { exact: true }).fill(boxTitle);
  const picker = dialog.getByRole('combobox', { name: 'Type', exact: true });
  await picker.selectOption(type === 'context' ? { label: 'Context' } : type);
  if (type === 'context') await expect(picker).toHaveAccessibleDescription(description);
  await dialog.getByRole('button', { name: 'Add box', exact: true }).click();
  await expect(dialog).toBeHidden();
}

test('saves and reloads Context and its three suggested relationships', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const path = await openProject(page);
  for (const destination of destinations) await addBox(page, destination.title, destination.type);
  await addBox(page, title, 'context');

  const card = page.locator('[data-box-id][data-box-type="context"]');
  const badge = card.locator('.box-type[data-type="context"]');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText('Context');
  const connect = card.getByRole('button', { name: `Connect from ${title}`, exact: true });
  const dialog = page.getByRole('dialog', { name: 'Connect', exact: true });
  for (const destination of destinations) {
    await connect.click();
    await dialog.getByRole('button', { name: new RegExp(`^${destination.title}`) }).click();
    await expect(dialog.locator(`datalist option[value="${destination.label}"]`)).toHaveCount(1);
    await dialog.getByLabel('Relationship', { exact: true }).fill(destination.label);
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(dialog).toBeHidden();
  }

  const saved = page.waitForResponse(response => response.url().endsWith(`${path}/save`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await page.reload();
  await expect(badge).toHaveText('Context');
  for (const { label } of destinations) {
    await expect(page.locator('.story-wire__label').getByText(label, { exact: true })).toBeVisible();
  }
  const live = await page.request.get(path);
  expect(live.ok()).toBe(true);
  const working = await live.json() as WorkingStory;
  const persisted = await page.request.get(`${path}?versionId=${working.branch.headVersionId}`);
  expect(persisted.ok()).toBe(true);
  const { revisionId, snapshot } = await persisted.json() as WorkingStory;
  expect(revisionId).toBe(working.revisionId);
  const boxes = Object.values(snapshot.boxes);
  const context = boxes.find(box => box.type === 'context');
  expect(context).toMatchObject({ type: 'context', title });
  const links = Object.values(snapshot.connectors);
  expect(links).toHaveLength(destinations.length);
  for (const { title, label, reverseLabel } of destinations) {
    const target = boxes.find(box => box.title === title);
    expect(links).toContainEqual(expect.objectContaining({ sourceId: context?.id, targetId: target?.id, label, reverseLabel }));
  }
});

test.describe('Context on a narrow canvas', () => {
  test.use({ viewport: { width: 320, height: 780 }, hasTouch: true });

  test('shows the Context badge and help when adding and editing', async ({ page }) => {
    await openProject(page);
    await addBox(page, title, 'context');
    const card = page.locator('[data-list-box-id][data-box-type="context"]');
    const badge = card.locator('.box-type[data-type="context"]');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText('Context');
    await page.getByRole('button', { name: 'Edit box', exact: true }).tap();
    const dialog = page.getByRole('dialog', { name: 'Edit box', exact: true });
    const picker = dialog.getByRole('combobox', { name: 'Type', exact: true });
    await expect(picker).toHaveValue('context');
    await expect(picker).toHaveAccessibleDescription(description);
    await expect(dialog.getByText(description, { exact: true })).toBeVisible();
    await picker.selectOption('event');
    await expect(dialog.getByText(description, { exact: true })).toBeHidden();
    await picker.selectOption({ label: 'Context' });
    await dialog.getByLabel('Title', { exact: true }).fill('Unix stack limit');
    await dialog.getByRole('button', { name: 'Save box', exact: true }).tap();
    await expect(card.getByRole('button', { name: 'Unix stack limit', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  });
});
