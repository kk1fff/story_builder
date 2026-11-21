import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createApp } from './app.js';
import { StoryStore } from './story-store.js';

const host = process.env.STORY_HOST ?? '127.0.0.1';
const port = Number(process.env.STORY_HTTP_PORT ?? '4310');
const path = resolve(process.env.STORY_DB ?? 'data/story.sqlite');
const allowedOrigins = (process.env.STORY_ALLOWED_ORIGINS ?? '').split(',').map(origin => origin.trim()).filter(Boolean);
for (const origin of allowedOrigins) {
  const url = new URL(origin);
  if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('STORY_ALLOWED_ORIGINS must contain exact HTTP origins.');
  }
}
mkdirSync(dirname(path), { recursive: true });
const store = new StoryStore(path);
store.flushDueVersions();
const app = createApp(store, { allowedOrigins, webDir: resolve('dist/web') });
const server = app.listen(port, host, () => console.log(`Story Builder listening on http://${host}:${port}`));
const timer = setInterval(() => {
  try {
    store.flushDueVersions();
  } catch (error) {
    console.error('Could not checkpoint a story branch', error);
  }
}, 200);
timer.unref();

function shutdown() {
  clearInterval(timer);
  server.close(() => store.close());
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
