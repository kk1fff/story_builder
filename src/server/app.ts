import express, { type ErrorRequestHandler } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { agentPolicySchema, inspectDeletion, operationSchema } from '../shared/story.js';
import { createMcpRoutes } from './mcp.js';
import { StoryError, type StoryStore } from './story-store.js';

const id = z.string().min(1).max(200);
const name = z.string().trim().min(1).max(200);
const revision = z.object({ versionId: id.optional(), revisionId: id.optional() });
const batch = z.object({
  baseRevisionId: id,
  requestId: id,
  operations: z.array(operationSchema).min(1).max(200),
  reviewId: id.optional(),
  completedNoteIds: z.array(id).max(200).optional(),
});
const review = z.object({
  baseRevisionId: id,
  notes: z.array(z.object({
    boxIds: z.array(id).min(1).max(100),
    text: z.string().trim().min(1).max(12_000),
  })).min(1).max(100),
});

export function createApp(store: StoryStore, options: {
  webDir?: string;
  allowedOrigins?: string[];
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  const origins = new Set(options.allowedOrigins ?? []);

  app.use((req, res, next) => {
    const host = req.get('host');
    const origin = req.get('origin');
    const hostname = req.hostname;
    const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname);
    const allowedHost = loopback || Boolean(host && [...origins].some(entry => new URL(entry).host === host));
    const allowedOrigin = !origin || origin === `http://${host}` || origins.has(origin);
    if (!allowedHost || !allowedOrigin) {
      res.status(403).json({ code: 'forbidden', message: 'This host or origin is outside the configured internal deployment.' });
      return;
    }
    next();
  });
  app.get('/healthz', (_req, res) => {
    store.flushDueVersions();
    res.json({ status: 'ok' });
  });
  const mcp = createMcpRoutes(store);
  app.get('/mcp', (req, res) => {
    if (req.get('accept')?.split(',').some(value => value.trim().startsWith('text/event-stream'))) {
      res.sendStatus(405);
      return;
    }
    res.set('Cache-Control', 'no-store');
    if (req.accepts(['html', 'json']) === 'json') res.json(mcp.catalog);
    else res.type('html').send(mcp.guide);
  });
  app.post('/mcp', mcp.handler);

  app.use('/api', express.json({ limit: '1mb' }), (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/projects', (_req, res) => res.json(store.listProjects()));
  app.post('/api/projects', (req, res) => res.status(201).json(store.createProject(z.object({ name }).parse(req.body))));
  app.get('/api/projects/:projectId/history', (req, res) => res.json(store.getHistory(req.params.projectId)));
  app.patch('/api/projects/:projectId/versions/:versionId', (req, res) => {
    res.json(store.renameVersion({ ...req.params, ...z.object({ name }).parse(req.body) }));
  });
  app.get('/api/projects/:projectId/compare', (req, res) => {
    const query = z.object({ fromVersionId: id, toVersionId: id }).parse(req.query);
    res.json(store.compareVersions({ ...req.params, ...query }));
  });
  app.post('/api/projects/:projectId/branches', (req, res) => {
    res.status(201).json(store.branchFromVersion({
      ...req.params, ...z.object({ versionId: id, name }).parse(req.body),
    }));
  });
  app.put('/api/projects/:projectId/agent-editing', (req, res) => {
    res.json(store.setAgentPolicy(req.params.projectId, agentPolicySchema.parse(req.body)));
  });
  app.get('/api/projects/:projectId/branches/:branchId', (req, res) => {
    res.json(store.readStory({ ...req.params, ...revision.parse(req.query) }));
  });
  app.post('/api/projects/:projectId/branches/:branchId/changes', (req, res) => {
    res.json(store.applyChanges({ ...req.params, ...batch.parse(req.body), actor: 'human' }));
  });
  app.post('/api/projects/:projectId/branches/:branchId/save', (req, res) => {
    res.json(store.saveVersion({ ...req.params, ...z.object({ name: name.optional() }).parse(req.body ?? {}) }));
  });
  app.get('/api/projects/:projectId/branches/:branchId/delete-impact/:boxId', (req, res) => {
    const { projectId, branchId, boxId } = req.params;
    const working = store.readStory({ projectId, branchId });
    res.json({ ...inspectDeletion(working.snapshot, boxId), revisionId: working.revisionId });
  });
  app.get('/api/projects/:projectId/branches/:branchId/reviews', (req, res) => res.json(store.listReviews(req.params)));
  app.post('/api/projects/:projectId/branches/:branchId/reviews', (req, res) => {
    res.status(201).json(store.createReview({ ...req.params, ...review.parse(req.body) }));
  });
  app.get('/api/projects/:projectId/reviews/:reviewId', (req, res) => res.json(store.readReview(req.params)));
  app.use('/api', (_req, res) => res.status(404).json({ code: 'not_found', message: 'Unknown API endpoint.' }));

  if (options.webDir && existsSync(join(options.webDir, 'index.html'))) {
    app.use(express.static(options.webDir));
  }
  const handleError: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) { next(error); return; }
    if (error instanceof StoryError) {
      const status = { not_found: 404, invalid: 400, conflict: 409, locked: 403 }[error.code];
      res.status(status).json({ code: error.code, message: error.message, details: error.details });
    } else if (error instanceof z.ZodError || error instanceof SyntaxError) {
      res.status(400).json({ code: 'invalid', message: 'Invalid request.', details: error instanceof z.ZodError ? error.issues : undefined });
    } else if (error?.status === 413) {
      res.status(413).json({ code: 'invalid', message: 'The request exceeds the size limit.' });
    } else {
      console.error('Request failed', error);
      res.status(500).json({ code: 'internal', message: 'The story service could not complete the request.' });
    }
  };
  app.use(handleError);
  return app;
}
