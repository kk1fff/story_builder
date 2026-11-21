import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.js';
import { StoryStore } from '../src/server/story-store.js';

let store: StoryStore;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let endpoint: URL;

beforeEach(async () => {
  store = new StoryStore(':memory:');
  server = createApp(store).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  endpoint = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  store.close();
});

describe('Streamable HTTP MCP endpoint', () => {
  test.each(['legacy', 'modern'] as const)('catalog and project tools work for a %s client', async era => {
    const created = store.createProject({ name: 'GCC' });
    const client = new Client({ name: 'story-builder-contract', version: '1.0.0' }, {
      versionNegotiation: { mode: era === 'modern' ? { pin: '2026-07-28' } : 'legacy' },
    });
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    try {
      expect(client.getProtocolEra()).toBe(era);
      const manifest = await fetch(endpoint, { headers: { Accept: 'application/json' } }).then(res => res.json());
      const catalog = await client.listTools();
      expect(catalog.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(manifest.tools.map((tool: { name: string }) => tool.name)));
      expect((await fetch(endpoint)).headers.get('content-type')).toContain('text/html');

      const started = await client.callTool({ name: 'start_session', arguments: { project_id: created.project.id } });
      expect(started.isError).not.toBe(true);
      const session_id = (started.structuredContent as { session_id?: unknown } | undefined)?.session_id;
      expect(typeof session_id).toBe('string');
      const result = await client.callTool({ name: 'read_canvas', arguments: { session_id } });
      expect(result.structuredContent).toMatchObject({ revision_id: created.revisionId, boxes: [], connectors: [] });
      const invalid = await client.callTool({ name: 'read_canvas', arguments: { session_id: 'absent' } });
      expect(invalid.isError).toBe(true);

      const change = {
        session_id, base_revision_id: created.revisionId, request_id: 'write-question',
        operations: [{ op: 'add_box', box: { id: 'question', parentId: null, type: 'question', title: 'How did GCC begin?', body: '', x: 0, y: 0 } }],
      };
      store.setAgentPolicy(created.project.id, { mode: 'locked', boxIds: [] });
      const denied = await client.callTool({ name: 'apply_changes', arguments: change });
      expect(denied.structuredContent).toMatchObject({ code: 'locked' });
      store.setAgentPolicy(created.project.id, { mode: 'add_only', boxIds: [] });
      const applied = await client.callTool({ name: 'apply_changes', arguments: change });
      expect(applied.isError).not.toBe(true);
      expect(applied.structuredContent).toMatchObject({ snapshot: { boxes: { question: { id: 'question' } } } });
      const retry = await client.callTool({ name: 'apply_changes', arguments: change });
      expect(retry.structuredContent).toEqual(applied.structuredContent);

      const resized = {
        session_id,
        base_revision_id: (applied.structuredContent as { revisionId: string }).revisionId,
        request_id: 'resize-question',
        operations: [{ op: 'resize_box', boxId: 'question', width: 360, minHeight: 180 }],
      };
      const resizeDenied = await client.callTool({ name: 'apply_changes', arguments: resized });
      expect(resizeDenied.structuredContent).toMatchObject({ code: 'locked' });
      store.setAgentPolicy(created.project.id, { mode: 'selected', boxIds: ['question'] });
      const resizeApplied = await client.callTool({ name: 'apply_changes', arguments: resized });
      expect(resizeApplied.isError).not.toBe(true);
      const canvas = await client.callTool({ name: 'read_canvas', arguments: { session_id } });
      expect(canvas.structuredContent).toMatchObject({ boxes: [{ id: 'question', x: 0, y: 0, width: 360, minHeight: 180 }] });
    } finally {
      await client.close();
    }
  });

  test('rejects a foreign browser origin while accepting local setup requests', async () => {
    const response = await fetch(endpoint, { headers: { Origin: 'https://outside.example' } });
    expect(response.status).toBe(403);
    expect((await fetch(endpoint)).status).toBe(200);
  });
});
