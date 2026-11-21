import { expect, test, type Locator, type Page } from '@playwright/test';
import { getBoxSize, type Operation, type VersionDiff, type WorkingStory } from '../src/shared/story.js';

test.use({ actionTimeout: 8_000, viewport: { width: 1440, height: 900 } });

function seedBox(id: string, title: string, x: number, y: number, parentId: string | null = null): Operation {
  return { op: 'add_box', box: { id, parentId, type: 'event', title, body: '', x, y } };
}

async function readStory(page: Page, path: string): Promise<WorkingStory> {
  const response = await page.request.get(path);
  expect(response.ok()).toBe(true);
  return response.json();
}

async function openProject(page: Page, name: string, operations: Operation[] = []) {
  const response = await page.request.post('/api/projects', { data: { name } });
  expect(response.ok()).toBe(true);
  const initial = await response.json() as WorkingStory;
  const projectPath = `/api/projects/${initial.project.id}`;
  const path = `${projectPath}/branches/${initial.branch.id}`;
  if (operations.length) {
    const seeded = await page.request.post(`${path}/changes`, { data: {
      baseRevisionId: initial.revisionId,
      requestId: 'canvas-fixture',
      operations,
    } });
    expect(seeded.ok()).toBe(true);
  }
  await page.goto(`/?project=${initial.project.id}&branch=${initial.branch.id}`);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  return { path, projectPath };
}

async function saveVersion(page: Page, path: string) {
  const saved = page.waitForResponse(response => response.url().endsWith(`${path}/save`)
    && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await saved).ok()).toBe(true);
  return (await readStory(page, path)).branch.headVersionId;
}

function card(page: Page, id: string) {
  return page.locator(`[data-box-id="${id}"]`);
}

function observeWrites(page: Page, path: string) {
  const writes: unknown[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith(`${path}/changes`)) {
      writes.push(request.postDataJSON());
    }
  });
  return writes;
}

async function center(locator: Locator) {
  await expect(locator).toBeVisible();
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return { x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2 };
}

async function startDrag(page: Page, locator: Locator) {
  // Let the inspector's opening refit settle before capturing the pointer.
  await locator.click({ trial: true });
  const position = await center(locator);
  await page.mouse.move(position.x, position.y);
  await page.mouse.down();
  return position;
}

test('resizes through numeric controls and through a single pointer write, then compares saved sizes', async ({ page }) => {
  const { path, projectPath } = await openProject(page, 'Canvas sizing');
  await page.getByRole('button', { name: 'Add box', exact: true }).click();
  const add = page.getByRole('dialog', { name: 'Add box' });
  await expect(add.getByRole('textbox', { name: 'Title', exact: true })).toBeFocused();
  await add.getByRole('textbox', { name: 'Title', exact: true }).fill('Resize this box');
  await add.getByRole('button', { name: 'Add box', exact: true }).click();
  await expect(add).not.toBeVisible();
  const before = await readStory(page, path);
  const box = Object.values(before.snapshot.boxes)[0]!;
  const boxCard = card(page, box.id);
  const title = boxCard.getByRole('button', { name: box.title, exact: true });
  await expect(title).toBeFocused();
  await expect(title).toHaveAttribute('aria-pressed', 'true');
  await expect(title).toBeInViewport();
  await expect(boxCard).toHaveCSS('width', '224px');
  const original = await saveVersion(page, path);

  const width = page.getByRole('spinbutton', { name: 'Width', exact: true });
  const height = page.getByRole('spinbutton', { name: 'Minimum height', exact: true });
  await expect(width).toHaveValue('224');
  await expect(height).toHaveValue('100');
  await expect(width).toHaveAttribute('min', '180');
  await expect(width).toHaveAttribute('max', '600');
  await expect(height).toHaveAttribute('min', '100');
  await expect(height).toHaveAttribute('max', '480');
  await width.fill('601');
  expect(await width.evaluate(input => (input as HTMLInputElement).validity.rangeOverflow)).toBe(true);
  await width.fill('320');
  await height.fill('150');
  await page.getByRole('button', { name: 'Apply size', exact: true }).click();
  await expect(boxCard).toHaveCSS('width', '320px');
  await expect(boxCard).toHaveCSS('min-height', '150px');
  const numeric = await readStory(page, path);
  expect(numeric.snapshot.boxes[box.id]).toMatchObject({ width: 320, minHeight: 150, x: box.x, y: box.y });

  const writes = observeWrites(page, path);
  const resize = boxCard.getByLabel(`Resize ${box.title}`, { exact: true });
  const grip = await startDrag(page, resize);
  try {
    await page.mouse.move(grip.x + 66, grip.y + 52, { steps: 7 });
    await expect.poll(() => boxCard.evaluate(element => element.clientWidth)).toBeGreaterThan(320);
    expect(writes).toHaveLength(0);
    expect((await readStory(page, path)).revisionId).toBe(numeric.revisionId);
    const saved = page.waitForResponse(response => response.url().endsWith(`${path}/changes`)
      && response.request().method() === 'POST');
    await page.mouse.up();
    expect((await saved).ok()).toBe(true);
  } finally {
    await page.mouse.up();
  }
  expect(writes).toHaveLength(1);
  const updated = (await readStory(page, path)).snapshot.boxes[box.id];
  expect(updated).toMatchObject({ x: box.x, y: box.y });
  expect(updated.width).toBeGreaterThan(320);
  expect(updated.minHeight).toBeGreaterThan(150);
  const expanded = await saveVersion(page, path);
  await page.reload();
  await expect(boxCard).toHaveCSS('width', `${updated.width}px`);
  await expect(boxCard).toHaveCSS('min-height', `${updated.minHeight}px`);

  await page.getByRole('button', { name: 'History', exact: true }).click();
  const graph = page.getByRole('region', { name: 'Version history' });
  await graph.locator(`[data-version-id="${original}"]`).click();
  await expect(boxCard).toHaveCSS('width', '224px');
  await title.click();
  await expect(resize).toBeHidden();
  await expect(boxCard.getByLabel(`Drag to connect from ${box.title}`, { exact: true })).toBeHidden();

  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByRole('combobox', { name: /^From version/ }).selectOption(original);
  await page.getByRole('combobox', { name: /^To version/ }).selectOption(expanded);
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  const changes = page.getByRole('region', { name: 'Version differences' });
  await expect(changes.getByRole('button', { name: box.title, exact: true })).toBeVisible();
  await expect(changes.getByText('Resized', { exact: true })).toBeVisible();
  await expect(changes.getByText(`224 × 100 → ${updated.width} × ${updated.minHeight} px`, { exact: true })).toBeVisible();
  const comparison = await page.request.get(`${projectPath}/compare?fromVersionId=${original}&toVersionId=${expanded}`);
  expect(comparison.ok()).toBe(true);
  const difference = await comparison.json() as VersionDiff;
  expect(difference.boxes.changed[0]?.fields).toEqual(expect.arrayContaining(['width', 'minHeight']));
});

test('keeps a concurrent resize and reports the stale pointer gesture', async ({ page }) => {
  const { path } = await openProject(page, 'Concurrent canvas resize', [seedBox('shared', 'Shared box', 0, 0)]);
  const box = card(page, 'shared');
  await box.getByRole('button', { name: 'Shared box', exact: true }).click();
  const before = await readStory(page, path);
  const position = await startDrag(page, box.getByLabel('Resize Shared box', { exact: true }));
  try {
    await page.mouse.move(position.x + 35, position.y + 29, { steps: 4 });
    await expect.poll(() => box.evaluate(element => element.clientWidth)).toBeGreaterThan(224);
    const anotherEditor = await page.request.post(`${path}/changes`, { data: {
      baseRevisionId: before.revisionId,
      requestId: 'resize-from-other-editor',
      operations: [{ op: 'resize_box', boxId: 'shared', width: 370, minHeight: 210 }],
    } });
    expect(anotherEditor.ok()).toBe(true);
    const conflicting = page.waitForResponse(response => response.url().endsWith(`${path}/changes`)
      && response.request().method() === 'POST');
    await page.mouse.up();
    expect((await conflicting).status()).toBe(409);
    await expect(page.getByRole('alert')).toContainText(/overlap|changed|conflict/i);
  } finally {
    await page.mouse.up();
  }
  const stored = (await readStory(page, path)).snapshot.boxes.shared;
  expect(stored).toMatchObject({ width: 370, minHeight: 210, x: 0, y: 0 });
  await expect(box).toHaveCSS('width', '370px');
});

test('preserves a concurrent dimension until the numeric editor reloads the current size', async ({ page }) => {
  const { path } = await openProject(page, 'Concurrent numeric size', [seedBox('shared', 'Shared box', 0, 0)]);
  await card(page, 'shared').getByRole('button', { name: 'Shared box', exact: true }).click();
  const width = page.getByRole('spinbutton', { name: 'Width', exact: true });
  const height = page.getByRole('spinbutton', { name: 'Minimum height', exact: true });
  await width.fill('310');
  const before = await readStory(page, path);
  const anotherEditor = await page.request.post(`${path}/changes`, { data: {
    baseRevisionId: before.revisionId,
    requestId: 'height-from-other-editor',
    operations: [{ op: 'resize_box', boxId: 'shared', width: 224, minHeight: 215 }],
  } });
  expect(anotherEditor.ok()).toBe(true);
  const revised = await anotherEditor.json() as WorkingStory;
  await page.waitForResponse(async response => response.url().endsWith(path)
    && response.request().method() === 'GET'
    && (await response.json()).revisionId === revised.revisionId);

  const apply = page.getByRole('button', { name: 'Apply size', exact: true });
  async function submitSize() {
    const saved = page.waitForResponse(response => response.url().endsWith(`${path}/changes`)
      && response.request().method() === 'POST');
    await apply.click();
    return saved;
  }
  expect((await submitSize()).status()).toBe(409);
  await expect(page.getByRole('alert')).toContainText(/overlap|changed|conflict/i);
  expect((await submitSize()).status()).toBe(409);
  expect(getBoxSize((await readStory(page, path)).snapshot.boxes.shared)).toEqual({ width: 224, minHeight: 215 });

  await page.getByRole('button', { name: 'Load current size', exact: true }).click();
  await expect(width).toHaveValue('224');
  await expect(height).toHaveValue('215');
  await width.fill('310');
  expect((await submitSize()).ok()).toBe(true);
  expect(getBoxSize((await readStory(page, path)).snapshot.boxes.shared)).toEqual({ width: 310, minHeight: 215 });
});

test('cancels connection drags, then confirms links to a visible card and an actual outside box', async ({ page }) => {
  const { path } = await openProject(page, 'Canvas connectors', [
    seedBox('source', 'Source box', 0, 0),
    seedBox('target', 'Destination box', 340, 0),
    seedBox('container', 'Nested canvas', 0, 175),
    seedBox('inside', 'Nested finding', 0, 0, 'container'),
    seedBox('anchor', 'Existing reference', 0, 155, 'container'),
    { op: 'add_connector', connector: {
      id: 'existing', sourceId: 'anchor', targetId: 'target', label: 'supports', reverseLabel: 'supported by',
    } },
  ]);
  await card(page, 'source').getByRole('button', { name: 'Source box', exact: true }).click();
  const port = card(page, 'source').getByLabel('Drag to connect from Source box', { exact: true });
  const destination = card(page, 'target');
  const connect = page.getByRole('dialog', { name: 'Connect', exact: true });
  const pane = await page.locator('.react-flow__pane').boundingBox();
  expect(pane).not.toBeNull();
  const background = { x: pane!.x + pane!.width / 2, y: pane!.y + pane!.height - 30 };
  expect(await page.evaluate(point => !document.elementFromPoint(point.x, point.y)?.closest('[data-box-id]'), background)).toBe(true);

  const original = await readStory(page, path);
  const writes = observeWrites(page, path);
  await startDrag(page, port);
  const targetPoint = await center(destination.getByRole('button', { name: 'Destination box', exact: true }));
  await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 7 });
  await expect(destination).toHaveClass(/story-card--connect-target/);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(connect).toBeHidden();
  const ownPoint = await center(card(page, 'source').getByRole('button', { name: 'Source box', exact: true }));
  for (const point of [ownPoint, background]) {
    await card(page, 'source').getByRole('button', { name: 'Source box', exact: true }).click();
    await startDrag(page, port);
    await page.mouse.move(point.x, point.y, { steps: 7 });
    await page.mouse.up();
    await expect(connect).toBeHidden();
  }
  expect(writes).toHaveLength(0);
  expect((await readStory(page, path)).revisionId).toBe(original.revisionId);

  async function dropAndConfirm(from: Locator, to: Locator, relation: string) {
    const oldCount = writes.length;
    await startDrag(page, from);
    try {
      const landing = await center(to);
      await page.mouse.move(landing.x, landing.y, { steps: 7 });
    } finally {
      await page.mouse.up();
    }
    await expect(connect).toBeVisible();
    await expect(connect.getByRole('button', { name: /^Destination box/ })).toHaveAttribute('aria-pressed', 'true');
    const relationship = connect.getByLabel('Relationship', { exact: true });
    await expect(relationship).toBeFocused();
    await relationship.fill(relation);
    expect(writes).toHaveLength(oldCount);
    await connect.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(connect).toBeHidden();
    expect(writes).toHaveLength(oldCount + 1);
  }

  await card(page, 'source').getByRole('button', { name: 'Source box', exact: true }).click();
  await dropAndConfirm(port, destination.getByRole('button', { name: 'Destination box', exact: true }), 'causes');
  const connected = await readStory(page, path);
  expect(Object.values(connected.snapshot.connectors)).toEqual(expect.arrayContaining([
    expect.objectContaining({ sourceId: 'source', targetId: 'target', label: 'causes' }),
  ]));

  await card(page, 'container').getByRole('button', { name: 'Open Nested canvas', exact: true }).click();
  await expect(destination.getByText(/Outside this box/)).toBeVisible();
  const inside = card(page, 'inside');
  await inside.getByRole('button', { name: 'Nested finding', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Nested finding', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Fit View', exact: true }).click();
  await dropAndConfirm(
    inside.getByLabel('Drag to connect from Nested finding', { exact: true }),
    destination.getByRole('button', { name: 'Destination box', exact: true }),
    'solves',
  );
  const scoped = await readStory(page, path);
  expect(Object.values(scoped.snapshot.connectors)).toHaveLength(3);
  expect(Object.values(scoped.snapshot.connectors)).toEqual(expect.arrayContaining([
    expect.objectContaining({ sourceId: 'inside', targetId: 'target', label: 'solves' }),
  ]));
});

test.describe('touch and keyboard at 320 px', () => {
  test.use({ viewport: { width: 320, height: 780 }, hasTouch: true });

  test('connects to a hidden destination and resizes without a pointer gesture', async ({ page }) => {
    const { path } = await openProject(page, 'Narrow connection picker', [
      seedBox('from', 'Starting box', 0, 0),
      seedBox('outer', 'Outer box', 320, 0),
      seedBox('inner', 'Inner box', 0, 0, 'outer'),
      seedBox('hidden', 'Hidden finding', 0, 0, 'inner'),
    ]);
    const source = page.locator('[data-list-box-id="from"]');
    await source.getByRole('button', { name: 'Starting box', exact: true }).tap();
    const footer = source.getByRole('button', { name: 'Connect from Starting box', exact: true });
    await expect(footer).toBeVisible();
    expect((await footer.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await footer.focus();
    await page.keyboard.press('Enter');
    const connect = page.getByRole('dialog', { name: 'Connect', exact: true });
    await expect(connect).toBeVisible();
    await connect.getByRole('button', { name: 'Expand Outer box', exact: true }).tap();
    await connect.getByRole('button', { name: 'Expand Inner box', exact: true }).tap();
    await connect.getByRole('button', { name: /^Hidden finding/ }).tap();
    await connect.getByLabel('Relationship', { exact: true }).fill('answers');
    await connect.getByRole('button', { name: 'Connect', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(connect).toBeHidden();
    const relations = await readStory(page, path);
    expect(Object.values(relations.snapshot.connectors)).toEqual([
      expect.objectContaining({ sourceId: 'from', targetId: 'hidden', label: 'answers' }),
    ]);

    await source.getByRole('button', { name: 'Starting box', exact: true }).tap();
    await expect(page.getByLabel('Resize Starting box', { exact: true })).toBeHidden();
    await page.getByRole('spinbutton', { name: 'Width', exact: true }).fill('285');
    await page.getByRole('spinbutton', { name: 'Minimum height', exact: true }).fill('140');
    await page.getByRole('button', { name: 'Apply size', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await readStory(page, path)).snapshot.boxes.from).toMatchObject({
      width: 285, minHeight: 140,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  });
});
