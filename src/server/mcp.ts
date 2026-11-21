import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { operationSchema, type Box } from '../shared/story.js';
import { StoryError, type StoryStore } from './story-store.js';

const identifier = z.string().min(1).max(200);
const session = { session_id: identifier };
const instructions = [
  'Open only the project the human named. Pass its application session ID to every Story Builder tool after start_session.',
  'Read the current canvas and relevant nested boxes. For a review, read the notes and their base revision before proposing a change.',
  'Trace conclusions to the events, constraints, and premises behind them. Connect supporting boxes, and distinguish inferences from the human’s stated reasoning.',
  'When depth or scope is ambiguous, show a small representative breakdown in chat and ask one focused question. Wait for their answer before applying the affected edit.',
  'Submit agreed edits as one batch. Respect the web UI editing policy. On a conflict, show the competing changes in chat and ask how to resolve them.',
  'Edit a Derived result only when instructed. Link supporting passages to story:BLOCK_ID when adding evidence references.',
].join('\n');

function pathFor(boxes: Record<string, Box>, id: string) {
  const chain: { id: string; title: string }[] = [];
  let box: Box | undefined = boxes[id];
  while (box) {
    chain.unshift({ id: box.id, title: box.title });
    box = box.parentId ? boxes[box.parentId] : undefined;
  }
  return chain;
}

export function createMcpRoutes(store: StoryStore) {
  const registrations: ((server: McpServer) => void)[] = [];
  const tools: { name: string; description: string; inputSchema: unknown }[] = [];
  function tool<S extends z.ZodObject>(
    name: string, description: string, inputSchema: S,
    call: (args: z.output<S>) => Record<string, unknown>, readOnlyHint = true,
  ) {
    tools.push({ name, description, inputSchema: z.toJSONSchema(inputSchema) });
    registrations.push(server => {
      server.registerTool(name, { description, inputSchema: inputSchema as z.ZodObject, annotations: { readOnlyHint } }, async args => {
        try {
          const result = call(inputSchema.parse(args));
          return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
        } catch (error) {
          const result = error instanceof StoryError
            ? { code: error.code, message: error.message, details: error.details }
            : { code: 'internal', message: 'The story service could not complete the tool call.' };
          if (!(error instanceof StoryError)) console.error(name, error);
          return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
        }
      });
    });
  }

  tool('start_session', 'Start an application session scoped to the named project and branch. The default is the project’s main branch.',
    z.object({ project_id: identifier, branch_id: identifier.optional() }), args => {
      const started = store.startSession({ projectId: args.project_id, branchId: args.branch_id });
      const story = store.readStory({ projectId: started.projectId, branchId: started.branchId });
      return { session_id: started.id, project_id: started.projectId, branch_id: started.branchId, revision_id: story.revisionId, policy: story.policy };
    });
  tool('read_canvas', 'Read the top-level canvas or the contents of one nested box. Includes exact connector endpoints and paths.',
    z.object({ ...session, box_id: identifier.optional(), revision_id: identifier.optional() }), args => {
      const scoped = store.getSession(args.session_id);
      const story = store.readStory({ ...scoped, revisionId: args.revision_id });
      const { boxes, connectors } = story.snapshot;
      const parent = args.box_id && Object.hasOwn(boxes, args.box_id) ? boxes[args.box_id] : undefined;
      if (args.box_id && !parent) throw new StoryError('not_found', 'The requested box is not present in this canvas.');
      const parentId = parent?.id ?? null;
      const children = Object.values(boxes).filter(box => box.parentId === parentId);
      const visible = new Set(children.map(box => box.id));
      const endpoints = parent ? new Set([...visible, parent.id]) : visible;
      const links = Object.values(connectors).flatMap(link => {
        const sourcePath = pathFor(boxes, link.sourceId);
        const targetPath = pathFor(boxes, link.targetId);
        if (![...sourcePath, ...targetPath].some(entry => endpoints.has(entry.id))) return [];
        return [{ ...link, sourcePath, targetPath }];
      });
      const parents = new Set(Object.values(boxes).map(child => child.parentId));
      return {
        revision_id: story.revisionId, project: story.project, branch: story.branch, policy: story.policy,
        box: parent ?? null, boxes: children.map(box => ({ ...box, hasChildren: parents.has(box.id) })),
        connectors: links,
      };
    });
  tool('read_review', 'Read an annotated review pinned to a working revision of the session branch.',
    z.object({ ...session, review_id: identifier }), args => {
      const scoped = store.getSession(args.session_id);
      const review = store.readReview({ projectId: scoped.projectId, reviewId: args.review_id });
      if (review.branchId !== scoped.branchId) throw new StoryError('not_found', 'This review is on another branch.');
      return { ...review };
    });
  tool('apply_changes', 'Apply one atomic batch of agreed edits. Reuse the same request ID for a retry. Uses the live revision and current web editing policy.',
    z.object({
      ...session, base_revision_id: identifier, request_id: identifier,
      operations: z.array(operationSchema).min(1).max(200),
      review_id: identifier.optional(), completed_note_ids: z.array(identifier).max(200).optional(),
    }), args => {
      const scoped = store.getSession(args.session_id);
      return store.applyChanges({
        projectId: scoped.projectId, branchId: scoped.branchId, actor: 'agent',
        baseRevisionId: args.base_revision_id, requestId: args.request_id,
        operations: args.operations, reviewId: args.review_id, completedNoteIds: args.completed_note_ids,
      });
    }, false);

  const handler = toNodeHandler(createMcpHandler(() => {
    const server = new McpServer({ name: 'story-builder', version: '0.1.0' }, { instructions });
    registrations.forEach(register => register(server));
    return server;
  }, { legacy: 'stateless' }));
  const catalog = { name: 'story-builder', endpoint: '/mcp', transport: 'streamable-http', instructions, tools };
  const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const guide = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Story Builder MCP</title>
  <style>html{color-scheme:light dark}body{font:1rem/1.55 system-ui;max-width:45rem;margin:3rem auto;padding:0 1rem}pre{overflow:auto;padding:1rem;border:1px solid #888;border-radius:.5rem}</style></head><body>
  <h1>Story Builder MCP</h1><p>Add this page’s URL as the Streamable HTTP server in your agent app. Then provide the project ID and, for an annotated review, its review ID.</p>
  <h2>Working agreement</h2><ul>${instructions.split('\n').map(line => `<li>${escape(line)}</li>`).join('')}</ul>
  <h2>Tools</h2>${tools.map(entry => `<details><summary><code>${escape(entry.name)}</code> · ${escape(entry.description)}</summary><pre>${escape(JSON.stringify(entry.inputSchema, null, 2))}</pre></details>`).join('')}
  </body></html>`;
  return { handler, guide, catalog };
}
