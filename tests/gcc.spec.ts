import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, test, type Page } from '@playwright/test';
import type { Box, BoxType, Review, StorySnapshot, Version, WorkingStory } from '../src/shared/story.js';

const questionTitle = 'Why did GNU need its own compiler?';
const decisionTitle = 'Write a new compiler';
const findingTitle = 'Pastel exceeds the target stack limit';
const reasonTitle = 'GNU needed a compiler that fit its target machine';
const answerTitle = 'Why GNU wrote a compiler';
const detail = 'The target allowed 64 KB of stack. Pastel needed several megabytes.';
const findingNote = 'Explain why Pastel was dropped.';
const answerNote = 'Show what Stallman kept from Pastel.';
const beforeName = 'Before Pastel review';
const afterName = 'Explain why Pastel was dropped';
const evidenceLabel = 'Pastel exceeded the target stack limit';

test.use({ actionTimeout: 8_000, viewport: { width: 1440, height: 900 } });

function boxCard(page: Page, title: string) {
  return page.locator('[data-box-id]').filter({ has: page.getByText(title, { exact: true }) });
}

async function selectBox(page: Page, title: string) {
  await boxCard(page, title).getByRole('button', { name: title, exact: true }).click();
}

async function addBox(page: Page, title: string, type: BoxType) {
  await page.getByRole('button', { name: 'Add box', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Add box', exact: true });
  await form.getByLabel('Title', { exact: true }).fill(title);
  await form.getByRole('combobox', { name: /^Type/ }).selectOption(type);
  await form.getByRole('button', { name: 'Add box', exact: true }).click();
  await expect(boxCard(page, title)).toBeVisible();
}

async function readTool<T>(agent: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await agent.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as T;
}

async function saveAndNameVersion(page: Page, name: string) {
  const saved = page.waitForResponse(response => response.url().endsWith('/save')
    && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const response = await saved;
  expect(response.ok()).toBe(true);
  const version = await response.json() as Version | null;
  await page.getByRole('button', { name: 'History', exact: true }).click();
  const graph = page.getByRole('region', { name: 'Version history' });
  const row = version
    ? graph.locator(`[data-version-id="${version.id}"]`)
    : graph.getByRole('button').last();
  await row.click();
  await page.getByRole('textbox', { name: 'Version name' }).fill(name);
  await page.getByRole('button', { name: 'Rename version' }).click();
  await expect(graph.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
  await page.getByRole('button', { name: 'Back to live', exact: true }).click();
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
}

test('builds and reviews a nested GCC story through the web UI and MCP', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Project name' }).fill('GCC walkthrough');
  const created = page.waitForResponse(response => response.url().endsWith('/api/projects')
    && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  const response = await created;
  expect(response.ok()).toBe(true);
  const initial = await response.json() as WorkingStory;
  await expect(page.getByRole('heading', { name: 'GCC walkthrough' })).toBeVisible();
  await expect(page.locator('[data-box-id]')).toHaveCount(0);

  await addBox(page, questionTitle, 'question');
  await addBox(page, decisionTitle, 'decision');
  await addBox(page, reasonTitle, 'reasoning');
  await addBox(page, answerTitle, 'reasoning');

  await boxCard(page, decisionTitle).getByRole('button', { name: `Open ${decisionTitle}`, exact: true }).click();
  await addBox(page, findingTitle, 'event');
  const findingId = await boxCard(page, findingTitle).getAttribute('data-box-id');
  expect(findingId).toBeTruthy();

  await selectBox(page, findingTitle);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  const connection = page.getByRole('dialog', { name: 'Connect', exact: true });
  await connection.getByRole('button', { name: new RegExp(reasonTitle) }).click();
  await connection.getByLabel('Relationship', { exact: true }).fill('supports');
  await connection.getByRole('button', { name: 'Connect', exact: true }).click();
  const connector = page.getByRole('button', { name: 'Inspect connector: supports', exact: true });
  await expect(connector).toHaveAttribute('data-connector-kind', 'solid');

  await page.getByRole('button', { name: 'Main canvas', exact: true }).click();
  await expect(connector).toHaveAttribute('data-connector-kind', 'projected');
  await connector.click();
  await page.getByRole('button', { name: 'Jump to source', exact: true }).click();
  await expect(boxCard(page, findingTitle)).toBeVisible();

  await page.getByRole('button', { name: 'Main canvas', exact: true }).click();
  await selectBox(page, questionTitle);
  await page.getByRole('button', { name: 'Set derived result', exact: true }).click();
  const resultPicker = page.getByRole('dialog', { name: 'Set derived result' });
  await resultPicker.getByRole('button', { name: new RegExp(answerTitle) }).click();
  await resultPicker.getByRole('button', { name: 'Mark result', exact: true }).click();
  await expect(boxCard(page, answerTitle).getByText('Derived result', { exact: true })).toBeVisible();

  await selectBox(page, answerTitle);
  await page.getByRole('button', { name: 'Edit box', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit box', exact: true });
  await edit.getByRole('textbox', { name: 'Text', exact: true }).fill('GNU needed a free compiler.');
  await edit.getByRole('button', { name: 'Save box', exact: true }).click();
  await expect(edit).not.toBeVisible();
  await saveAndNameVersion(page, beforeName);
  await page.reload();
  await expect(boxCard(page, answerTitle)).toBeVisible();

  const annotate = async (title: string, text: string) => {
    await selectBox(page, title);
    await page.getByRole('button', { name: 'Annotate', exact: true }).click();
    const annotation = page.getByRole('dialog', { name: /Annotate/ });
    await annotation.getByRole('textbox').fill(text);
    await annotation.getByRole('button', { name: 'Add annotation', exact: true }).click();
  };
  await annotate(answerTitle, answerNote);
  await boxCard(page, decisionTitle).getByRole('button', { name: `Open ${decisionTitle}`, exact: true }).click();
  await annotate(findingTitle, findingNote);

  const createdReview = page.waitForResponse(result => result.url().endsWith('/reviews')
    && result.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create review', exact: true }).click();
  const reviewResponse = await createdReview;
  expect(reviewResponse.ok()).toBe(true);
  const review = await reviewResponse.json() as Review;
  await expect(page.getByRole('region', { name: 'Saved review' }).getByText('Open', { exact: true })).toHaveCount(2);

  await page.getByRole('button', { name: 'Agent editing', exact: true }).click();
  await page.getByRole('radio', { name: /Selected boxes/ }).check();
  await page.getByRole('checkbox', { name: new RegExp(findingTitle) }).check();
  await page.getByRole('checkbox', { name: new RegExp(answerTitle) }).check();
  await page.getByRole('button', { name: 'Save permissions', exact: true }).click();
  await expect(page.getByText(/Agent permissions saved/)).toBeVisible();

  const agent = new Client({ name: 'gcc-browser-acceptance', version: '1.0.0' });
  await agent.connect(new StreamableHTTPClientTransport(new URL('/mcp', page.url())));
  try {
    const { session_id } = await readTool<{ session_id: string }>(agent, 'start_session', {
      project_id: initial.project.id,
    });
    const root = await readTool<{ boxes: Box[]; revision_id: string }>(agent, 'read_canvas', { session_id });
    expect(root.boxes.map(box => box.title)).toContain(decisionTitle);
    const decision = root.boxes.find(box => box.title === decisionTitle)!;
    const written = root.boxes.find(box => box.title === answerTitle)!;
    const nested = await readTool<{ boxes: Box[] }>(agent, 'read_canvas', {
      session_id,
      box_id: decision.id,
    });
    expect(nested.boxes).toEqual(expect.arrayContaining([expect.objectContaining({ id: findingId })]));
    const notes = await readTool<Review>(agent, 'read_review', { session_id, review_id: review.id });
    expect(notes.notes.map(note => note.text)).toEqual(expect.arrayContaining([findingNote, answerNote]));
    expect(notes.notes.every(note => note.appliedRevisionId === null)).toBe(true);

    const body = `[${evidenceLabel}](story:${findingId}). Stallman reused the C front end.`;
    const result = await readTool<{ snapshot: StorySnapshot; review: Review }>(agent, 'apply_changes', {
      session_id,
      base_revision_id: root.revision_id,
      request_id: 'gcc-review',
      review_id: review.id,
      completed_note_ids: notes.notes.map(note => note.id),
      operations: [
        { op: 'update_box', boxId: findingId, patch: { body: detail } },
        { op: 'update_box', boxId: written.id, patch: { body } },
      ],
    });
    expect(result.snapshot.boxes[written.id].body).toBe(body);
    expect(result.review.notes.every(note => note.appliedRevisionId !== null)).toBe(true);
  } finally {
    await agent.close();
  }

  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Saved review' }).getByText('Applied', { exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'Main canvas', exact: true }).click();
  await selectBox(page, questionTitle);
  await page.getByRole('button', { name: 'Open result', exact: true }).click();
  await page.getByRole('button', { name: evidenceLabel, exact: true }).click();
  await expect(boxCard(page, findingTitle)).toBeVisible();
  await expect(page.getByRole('complementary', { name: findingTitle }).getByText(detail, { exact: true })).toBeVisible();
  await saveAndNameVersion(page, afterName);

  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByRole('combobox', { name: /^From version/ }).selectOption({ label: beforeName });
  await page.getByRole('combobox', { name: /^To version/ }).selectOption({ label: afterName });
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  const changes = page.getByRole('region', { name: 'Version differences' });
  await expect(changes.getByRole('button', { name: findingTitle })).toBeVisible();
  await expect(changes.getByRole('button', { name: answerTitle })).toBeVisible();
  await changes.getByRole('button', { name: findingTitle }).click();
  await expect(boxCard(page, findingTitle)).toBeVisible();

  await page.getByRole('region', { name: 'Version history' }).getByRole('button', { name: new RegExp(`^${beforeName}`) }).click();
  await page.getByRole('textbox', { name: 'New branch name' }).fill('Alternative explanation');
  await page.getByRole('button', { name: 'Continue from here' }).click();
  await expect(page.getByRole('combobox', { name: /^Working branch/ }).locator('option:checked')).toHaveText('Alternative explanation');
  await expect(page.getByRole('region', { name: 'Version history' }).getByRole('button', { name: new RegExp(`^${afterName}`) })).toBeVisible();

  await selectBox(page, decisionTitle);
  await page.getByRole('button', { name: 'Delete box', exact: true }).click();
  const deletion = page.getByRole('dialog', { name: 'Delete box', exact: true });
  await expect(deletion.getByText(new RegExp(` › ${findingTitle}$`))).toBeVisible();
  await expect(deletion.getByText('supports', { exact: false })).toBeVisible();
  await deletion.getByRole('button', { name: 'Cancel', exact: true }).click();
});
