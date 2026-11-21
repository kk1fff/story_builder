import type { StoryStore } from '../server/story-store.js';

export type History = ReturnType<StoryStore['getHistory']>;
export type Difference = ReturnType<StoryStore['compareVersions']>;
export type AppliedEdit = ReturnType<StoryStore['applyChanges']>;

export class RequestError extends Error {
  constructor(message: string, readonly code?: string, readonly details?: unknown) {
    super(message);
  }
}

export async function request<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { Accept: 'application/json', ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new RequestError(result.message ?? 'The story could not be updated.', result.code, result.details);
  return result as T;
}

export function projectPath(projectId: string) {
  return `/api/projects/${encodeURIComponent(projectId)}`;
}

export function branchPath(projectId: string, branchId: string) {
  return `${projectPath(projectId)}/branches/${encodeURIComponent(branchId)}`;
}
