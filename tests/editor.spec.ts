import { expect, test, type Page } from '@playwright/test';
import type { WorkingStory } from '../src/shared/story.js';

async function project(page: Page, name: string) {
  const response = await page.request.post('/api/projects', { data: { name } });
  expect(response.ok()).toBe(true);
  const result = await response.json() as WorkingStory;
  const { project, branch } = result;
  await page.goto(`/?project=${project.id}&branch=${branch.id}`);
  await expect(page.getByRole('heading', { name })).toBeVisible();
  return `/api/projects/${project.id}/branches/${branch.id}`;
}

async function addBox(page: Page, title: string) {
  await page.getByRole('button', { name: 'Add box', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add box' });
  const input = dialog.getByLabel('Title');
  await expect(input).toBeFocused();
  await input.fill(title);
  await dialog.getByRole('button', { name: 'Add box', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

async function annotate(page: Page, text: string) {
  await page.getByRole('button', { name: 'Annotate', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Annotate' });
  await dialog.getByLabel('Annotation').fill(text);
  await dialog.getByRole('button', { name: 'Add annotation' }).click();
}

test('a review can include a box added after the first note', async ({ page }) => {
  await project(page, 'Growing review');
  await addBox(page, 'Initial problem');
  await annotate(page, 'Add context.');
  await addBox(page, 'New observation');
  await annotate(page, 'Check the reasoning.');
  await page.getByRole('button', { name: 'Create review' }).click();
  const review = page.getByRole('region', { name: 'Saved review' });
  await expect(review.getByText('Add context.')).toBeVisible();
  await expect(review.getByText('Check the reasoning.')).toBeVisible();
});

test('an Add response completes the edit even if the following read fails', async ({ page }) => {
  const path = await project(page, 'Interrupted refresh');
  let rejectRead = false;
  await page.route(`**${path}`, async route => {
    if (rejectRead) { rejectRead = false; await route.abort(); }
    else await route.continue();
  });
  await page.route(`**${path}/changes`, async route => {
    const response = await route.fetch();
    rejectRead = true;
    await route.fulfill({ response });
  });
  await addBox(page, 'One event');
  await expect(page.locator('[data-box-id]')).toHaveCount(1);
  const response = await page.request.get(path);
  const story = await response.json() as WorkingStory;
  expect(Object.values(story.snapshot.boxes)).toHaveLength(1);
});

test('a drag reports a conflict when another editor moves the box mid-gesture', async ({ page }) => {
  const path = await project(page, 'Concurrent moves');
  await addBox(page, 'Observed event');
  const before = await page.request.get(path).then(response => response.json()) as WorkingStory;
  const box = Object.values(before.snapshot.boxes)[0]!;
  const card = page.locator(`[data-box-id="${box.id}"]`);
  const dragSurface = card.locator('.box-type');
  const bounds = await dragSurface.boundingBox();
  expect(bounds).not.toBeNull();
  const x = bounds!.x + 8, y = bounds!.y + 5;
  await page.mouse.move(x, y);
  await page.mouse.down();
  try {
    await page.mouse.move(x + 25, y + 16, { steps: 4 });
    const changed = await page.request.post(`${path}/changes`, { data: {
      baseRevisionId: before.revisionId,
      requestId: 'move-from-other-editor',
      operations: [{ op: 'move_box', boxId: box.id, parentId: box.parentId, x: 650, y: 300 }],
    } });
    expect(changed.ok()).toBe(true);
    const newer = await changed.json();
    await page.waitForResponse(async response => {
      if (!response.url().endsWith(path) || response.request().method() !== 'GET') return false;
      return (await response.json()).revisionId === newer.revisionId;
    });
    const revisionCheck = page.waitForResponse(response => response.url().endsWith(`${path}/changes`) && response.request().method() === 'POST', { timeout: 5_000 });
    await page.mouse.move(x + 68, y + 35, { steps: 4 });
    if (!page.isClosed()) await page.mouse.up();
    expect((await revisionCheck).status()).toBe(409);
    await expect(page.getByRole('alert')).toContainText(/concurrent|overlap|changed/i);
    const after = await page.request.get(path).then(response => response.json()) as WorkingStory;
    expect(after.snapshot.boxes[box.id]).toMatchObject({ x: 650, y: 300 });
  } finally {
    await page.mouse.up();
  }
});
