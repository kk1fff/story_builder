import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  agentPolicySchema,
  idSchema,
  operationSchema,
  type Actor,
  type AgentPolicy,
  type Branch,
  type Project,
  type Review,
  type ReviewNote,
  type Session,
  type StorySnapshot,
  type Version,
  type VersionDiff,
  type WorkingStory,
} from "../shared/story.js";
import { applyOperations, compareBoxes, compareEntities, StoryError } from "./story-operations.js";

export { inspectDeletion } from "../shared/story.js";
export { StoryError } from "./story-operations.js";

const idleSaveMs = 5_000;
const maxSaveMs = 30_000;
const nameSchema = z.string().trim().min(1).max(200);
const nullableNameSchema = nameSchema.optional();
const noteSchema = z.strictObject({
  id: idSchema.optional(),
  boxIds: z.array(idSchema).min(1).max(100),
  text: z.string().trim().min(1).max(20_000),
});
const applyInputSchema = z.strictObject({
  projectId: idSchema,
  branchId: idSchema,
  baseRevisionId: idSchema,
  requestId: idSchema,
  actor: z.enum(["human", "agent"]),
  operations: z.array(operationSchema).min(1).max(500),
  reviewId: idSchema.optional(),
  completedNoteIds: z.array(idSchema).max(100).optional(),
});

type BranchRow = {
  id: string;
  project_id: string;
  name: string;
  head_revision_id: string;
  head_version_id: string;
  first_dirty_at: number | null;
  last_edit_at: number | null;
  contributors: string;
};

type ProjectRow = {
  id: string;
  name: string;
  default_branch_id: string;
  created_at: string;
  policy: string;
};

type VersionRow = {
  id: string;
  project_id: string;
  branch_id: string;
  parent_id: string | null;
  revision_id: string;
  name: string;
  created_at: string;
  contributors: string;
};

type ReviewRow = {
  id: string;
  project_id: string;
  branch_id: string;
  base_revision_id: string;
  created_at: string;
  notes: string;
};

type RevisionRow = { id: string; snapshot: string };
type ReceiptRow = { fingerprint: string; result: string };
type SessionRow = { id: string; project_id: string; branch_id: string; created_at: string };

export type ApplyChangesInput = z.input<typeof applyInputSchema>;
export type ApplyChangesResult = { revisionId: string; branch: Branch; snapshot: StorySnapshot; review?: Review };
export type ReadStoryInput = { projectId: string; branchId?: string; versionId?: string; revisionId?: string };
export type CreateReviewInput = {
  projectId: string;
  branchId: string;
  baseRevisionId: string;
  notes: z.input<typeof noteSchema>[];
};
export type History = { projectId: string; branches: Branch[]; versions: Version[] };

const schema = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    default_branch_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    policy TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS branches (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    name TEXT NOT NULL,
    head_revision_id TEXT NOT NULL,
    head_version_id TEXT NOT NULL,
    first_dirty_at INTEGER,
    last_edit_at INTEGER,
    contributors TEXT NOT NULL,
    UNIQUE (project_id, name)
  );
  CREATE TABLE IF NOT EXISTS revisions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    parent_revision_id TEXT REFERENCES revisions(id),
    snapshot TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS versions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    branch_id TEXT NOT NULL REFERENCES branches(id),
    parent_id TEXT REFERENCES versions(id),
    revision_id TEXT NOT NULL REFERENCES revisions(id),
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    contributors TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    branch_id TEXT NOT NULL REFERENCES branches(id),
    base_revision_id TEXT NOT NULL REFERENCES revisions(id),
    created_at TEXT NOT NULL,
    notes TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS requests (
    branch_id TEXT NOT NULL REFERENCES branches(id),
    request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    result TEXT NOT NULL,
    PRIMARY KEY (branch_id, request_id)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    branch_id TEXT NOT NULL REFERENCES branches(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS identities (
    project_id TEXT NOT NULL REFERENCES projects(id),
    kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    PRIMARY KEY (project_id, kind, entity_id)
  );
  CREATE INDEX IF NOT EXISTS branches_project_idx ON branches(project_id);
  CREATE INDEX IF NOT EXISTS versions_project_idx ON versions(project_id);
  CREATE INDEX IF NOT EXISTS reviews_branch_idx ON reviews(branch_id);
`;

function decode<T>(json: string): T {
  return JSON.parse(json) as T;
}

function parse<T>(validator: z.ZodType<T>, input: unknown): T {
  const result = validator.safeParse(input);
  if (!result.success) {
    throw new StoryError("invalid", "The request contains invalid data.", result.error.issues);
  }
  return result.data;
}

function projectDto(row: ProjectRow): Project {
  return { id: row.id, name: row.name, defaultBranchId: row.default_branch_id, createdAt: row.created_at };
}

function branchDto(row: BranchRow): Branch {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    headRevisionId: row.head_revision_id,
    headVersionId: row.head_version_id,
  };
}

function versionDto(row: VersionRow): Version {
  return {
    id: row.id,
    projectId: row.project_id,
    branchId: row.branch_id,
    parentId: row.parent_id,
    revisionId: row.revision_id,
    name: row.name,
    createdAt: row.created_at,
    contributors: decode<Actor[]>(row.contributors),
  };
}

function reviewDto(row: ReviewRow): Review {
  return {
    id: row.id,
    projectId: row.project_id,
    branchId: row.branch_id,
    baseRevisionId: row.base_revision_id,
    createdAt: row.created_at,
    notes: decode<ReviewNote[]>(row.notes),
  };
}

function sessionDto(row: SessionRow): Session {
  return { id: row.id, projectId: row.project_id, branchId: row.branch_id, createdAt: row.created_at };
}

export class StoryStore {
  private readonly db: DatabaseSync;
  private readonly clock: () => number;

  constructor(path: string, options: { clock?: () => number } = {}) {
    this.db = new DatabaseSync(path);
    this.clock = options.clock ?? Date.now;
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(schema);
    this.flushDueVersions();
  }

  close() {
    this.db.close();
  }

  private get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  private all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  private run(sql: string, ...params: SQLInputValue[]) {
    this.db.prepare(sql).run(...params);
  }

  private transact<T>(perform: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = perform();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private projectRow(projectId: string): ProjectRow {
    const row = this.get<ProjectRow>("SELECT * FROM projects WHERE id = ?", projectId);
    if (!row) throw new StoryError("not_found", "The project does not exist.", { projectId });
    return row;
  }

  private branchRow(projectId: string, branchId: string): BranchRow {
    const row = this.get<BranchRow>("SELECT * FROM branches WHERE id = ? AND project_id = ?", branchId, projectId);
    if (!row) throw new StoryError("not_found", "The branch does not exist in this project.", { branchId });
    return row;
  }

  private versionRow(projectId: string, versionId: string): VersionRow {
    const row = this.get<VersionRow>("SELECT * FROM versions WHERE id = ? AND project_id = ?", versionId, projectId);
    if (!row) throw new StoryError("not_found", "The version does not exist in this project.", { versionId });
    return row;
  }

  private revision(projectId: string, revisionId: string): StorySnapshot {
    const row = this.get<RevisionRow>("SELECT id, snapshot FROM revisions WHERE id = ? AND project_id = ?",
      revisionId, projectId);
    if (!row) throw new StoryError("not_found", "The revision does not exist in this project.", { revisionId });
    return decode<StorySnapshot>(row.snapshot);
  }

  private branchRevision(branch: BranchRow, revisionId: string): StorySnapshot {
    const row = this.get<RevisionRow>(`
      WITH RECURSIVE ancestry(id, parent_revision_id) AS (
        SELECT id, parent_revision_id FROM revisions WHERE project_id = ? AND id = ?
        UNION ALL
        SELECT revisions.id, revisions.parent_revision_id
          FROM revisions JOIN ancestry ON revisions.id = ancestry.parent_revision_id
         WHERE revisions.project_id = ?
      )
      SELECT revisions.id, snapshot FROM ancestry JOIN revisions USING (id) WHERE revisions.id = ?
    `, branch.project_id, branch.head_revision_id, branch.project_id, revisionId);
    if (!row) {
      throw new StoryError("conflict", "The starting revision is outside this branch's history.", {
        revisionId,
        headRevisionId: branch.head_revision_id,
      });
    }
    return decode<StorySnapshot>(row.snapshot);
  }

  private insertRevision(projectId: string, parentId: string | null, snapshot: StorySnapshot) {
    const id = randomUUID();
    this.run("INSERT INTO revisions (id, project_id, parent_revision_id, snapshot) VALUES (?, ?, ?, ?)",
      id, projectId, parentId, JSON.stringify(snapshot));
    return id;
  }

  createProject(input: { name: string }): WorkingStory {
    const name = parse(nameSchema, input?.name);
    return this.transact(() => {
      const id = randomUUID();
      const branchId = randomUUID();
      const versionId = randomUUID();
      const createdAt = new Date(this.clock()).toISOString();
      const project = { id, name, defaultBranchId: branchId, createdAt };
      const policy: AgentPolicy = { mode: "full", boxIds: [] };
      const snapshot: StorySnapshot = { boxes: {}, connectors: {} };
      this.run("INSERT INTO projects VALUES (?, ?, ?, ?, ?)", id, name, branchId, createdAt, JSON.stringify(policy));
      const revisionId = this.insertRevision(id, null, snapshot);
      this.run("INSERT INTO branches VALUES (?, ?, ?, ?, ?, NULL, NULL, '[]')",
        branchId, id, "main", revisionId, versionId);
      this.run("INSERT INTO versions VALUES (?, ?, ?, NULL, ?, ?, ?, '[]')",
        versionId, id, branchId, revisionId, "Initial canvas", createdAt);
      return { project, branch: branchDto(this.branchRow(id, branchId)), revisionId, snapshot, policy };
    });
  }

  listProjects(): Project[] {
    return this.all<ProjectRow>("SELECT * FROM projects ORDER BY created_at DESC, rowid DESC").map(projectDto);
  }

  readStory(input: ReadStoryInput): WorkingStory {
    if (input.versionId && input.revisionId) {
      throw new StoryError("invalid", "Choose a version or a working revision.");
    }
    this.flushDueVersions();
    const project = this.projectRow(input.projectId);
    const selectedVersion = input.versionId ? this.versionRow(project.id, input.versionId) : undefined;
    const branch = this.branchRow(project.id, input.branchId ?? selectedVersion?.branch_id ?? project.default_branch_id);
    const revisionId = selectedVersion?.revision_id ?? input.revisionId ?? branch.head_revision_id;
    const snapshot = input.revisionId
      ? this.branchRevision(branch, revisionId)
      : this.revision(project.id, revisionId);
    return {
      project: projectDto(project),
      branch: branchDto(branch),
      revisionId,
      snapshot,
      policy: decode<AgentPolicy>(project.policy),
    };
  }

  private checkpoint(branch: BranchRow, now: number, name?: string): Version | null {
    if (branch.first_dirty_at === null) return null;
    const id = randomUUID();
    const count = this.get<{ total: number }>("SELECT COUNT(*) AS total FROM versions WHERE project_id = ?",
      branch.project_id)?.total ?? 0;
    this.run("INSERT INTO versions VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id, branch.project_id, branch.id, branch.head_version_id, branch.head_revision_id,
      name ?? `Version ${count + 1}`, new Date(now).toISOString(), branch.contributors);
    this.run(`
      UPDATE branches SET head_version_id = ?, first_dirty_at = NULL, last_edit_at = NULL, contributors = '[]'
       WHERE id = ?
    `, id, branch.id);
    return versionDto(this.versionRow(branch.project_id, id));
  }

  private checkpointIfDue(branch: BranchRow, now: number): Version | null {
    if (branch.first_dirty_at === null || branch.last_edit_at === null) return null;
    const deadline = Math.min(branch.first_dirty_at + maxSaveMs, branch.last_edit_at + idleSaveMs);
    return now >= deadline ? this.checkpoint(branch, now) : null;
  }

  flushDueVersions(): Version[] {
    const now = this.clock();
    return this.transact(() => {
      const branches = this.all<BranchRow>(`
        SELECT * FROM branches
         WHERE first_dirty_at IS NOT NULL AND (first_dirty_at <= ? OR last_edit_at <= ?)
         ORDER BY first_dirty_at, id
      `, now - maxSaveMs, now - idleSaveMs);
      return branches.flatMap((branch) => this.checkpointIfDue(branch, now) ?? []);
    });
  }

  saveVersion(input: { projectId: string; branchId: string; name?: string }): Version | null {
    const name = parse(nullableNameSchema, input.name);
    return this.transact(() => this.checkpoint(this.branchRow(input.projectId, input.branchId), this.clock(), name));
  }

  getHistory(projectId: string): History {
    this.flushDueVersions();
    this.projectRow(projectId);
    return {
      projectId,
      branches: this.all<BranchRow>("SELECT * FROM branches WHERE project_id = ? ORDER BY rowid", projectId)
        .map(branchDto),
      versions: this.all<VersionRow>("SELECT * FROM versions WHERE project_id = ? ORDER BY rowid", projectId)
        .map(versionDto),
    };
  }

  renameVersion(input: { projectId: string; versionId: string; name: string }): Version {
    const name = parse(nameSchema, input.name);
    return this.transact(() => {
      const version = this.versionRow(input.projectId, input.versionId);
      this.run("UPDATE versions SET name = ? WHERE id = ?", name, version.id);
      return versionDto({ ...version, name });
    });
  }

  compareVersions(input: { projectId: string; fromVersionId: string; toVersionId: string }): VersionDiff {
    const from = versionDto(this.versionRow(input.projectId, input.fromVersionId));
    const to = versionDto(this.versionRow(input.projectId, input.toVersionId));
    const before = this.revision(input.projectId, from.revisionId);
    const after = this.revision(input.projectId, to.revisionId);
    return {
      from,
      to,
      boxes: compareBoxes(before.boxes, after.boxes),
      connectors: compareEntities(before.connectors, after.connectors),
    };
  }

  branchFromVersion(input: { projectId: string; versionId: string; name: string }): Branch {
    const name = parse(nameSchema, input.name);
    return this.transact(() => {
      const version = this.versionRow(input.projectId, input.versionId);
      if (this.get("SELECT id FROM branches WHERE project_id = ? AND name = ?", input.projectId, name)) {
        throw new StoryError("invalid", "A branch with this name already exists.");
      }
      const id = randomUUID();
      this.run("INSERT INTO branches VALUES (?, ?, ?, ?, ?, NULL, NULL, '[]')",
        id, input.projectId, name, version.revision_id, version.id);
      return branchDto(this.branchRow(input.projectId, id));
    });
  }

  getAgentPolicy(projectId: string): AgentPolicy {
    return decode<AgentPolicy>(this.projectRow(projectId).policy);
  }

  setAgentPolicy(projectId: string, input: AgentPolicy): AgentPolicy {
    const { mode, boxIds } = parse(agentPolicySchema, input);
    return this.transact(() => {
      this.projectRow(projectId);
      const policy = { mode, boxIds: mode === "selected" ? [...new Set(boxIds)] : [] };
      this.run("UPDATE projects SET policy = ? WHERE id = ?", JSON.stringify(policy), projectId);
      return policy;
    });
  }

  createReview(input: CreateReviewInput): Review {
    const notes = parse(z.array(noteSchema).min(1).max(100), input.notes);
    return this.transact(() => {
      const branch = this.branchRow(input.projectId, input.branchId);
      const snapshot = this.branchRevision(branch, input.baseRevisionId);
      const noteIds = new Set<string>();
      const savedNotes: ReviewNote[] = notes.map((note) => {
        const id = note.id ?? randomUUID();
        if (noteIds.has(id)) throw new StoryError("invalid", "Review note IDs must be unique.");
        noteIds.add(id);
        const boxIds = [...new Set(note.boxIds)];
        for (const boxId of boxIds) {
          if (!Object.hasOwn(snapshot.boxes, boxId)) {
            throw new StoryError("invalid", "A review note points to a box outside its starting revision.", { boxId });
          }
        }
        return { id, boxIds, text: note.text, appliedRevisionId: null };
      });
      const id = randomUUID();
      const createdAt = new Date(this.clock()).toISOString();
      this.run("INSERT INTO reviews VALUES (?, ?, ?, ?, ?, ?)",
        id, input.projectId, input.branchId, input.baseRevisionId, createdAt, JSON.stringify(savedNotes));
      return { id, projectId: input.projectId, branchId: input.branchId, baseRevisionId: input.baseRevisionId,
        createdAt, notes: savedNotes };
    });
  }

  listReviews(input: { projectId: string; branchId: string }): Review[] {
    this.branchRow(input.projectId, input.branchId);
    return this.all<ReviewRow>("SELECT * FROM reviews WHERE branch_id = ? ORDER BY rowid DESC", input.branchId)
      .map(reviewDto);
  }

  readReview(input: { projectId: string; reviewId: string }): Review {
    const row = this.get<ReviewRow>("SELECT * FROM reviews WHERE project_id = ? AND id = ?",
      input.projectId, input.reviewId);
    if (!row) throw new StoryError("not_found", "The review does not exist in this project.", { reviewId: input.reviewId });
    return reviewDto(row);
  }

  private reserveId(projectId: string, kind: "box" | "connector", id: string) {
    if (this.get("SELECT entity_id FROM identities WHERE project_id = ? AND kind = ? AND entity_id = ?",
      projectId, kind, id)) {
      throw new StoryError("conflict", `This ${kind} ID was already used in this project.`, { id });
    }
    this.run("INSERT INTO identities VALUES (?, ?, ?)", projectId, kind, id);
  }

  applyChanges(raw: ApplyChangesInput): ApplyChangesResult {
    const input = parse(applyInputSchema, raw);
    const completedNoteIds = [...new Set(input.completedNoteIds ?? [])].sort();
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ ...input, completedNoteIds }))
      .digest("hex");

    return this.transact(() => {
      const project = this.projectRow(input.projectId);
      let branch = this.branchRow(project.id, input.branchId);
      const receipt = this.get<ReceiptRow>("SELECT fingerprint, result FROM requests WHERE branch_id = ? AND request_id = ?",
        branch.id, input.requestId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) {
          throw new StoryError("conflict", "This request ID already belongs to a different edit batch.");
        }
        return decode<ApplyChangesResult>(receipt.result);
      }
      const now = this.clock();
      if (this.checkpointIfDue(branch, now)) branch = this.branchRow(project.id, branch.id);
      const head = this.revision(project.id, branch.head_revision_id);
      const base = input.baseRevisionId === branch.head_revision_id ? head : this.branchRevision(branch, input.baseRevisionId);
      const policy = decode<AgentPolicy>(project.policy);
      const snapshot = applyOperations(base, head, input.operations, policy, input.actor);
      const changed = !isDeepStrictEqual(head, snapshot);

      let review = input.reviewId ? this.readReview({ projectId: project.id, reviewId: input.reviewId }) : undefined;
      if (review && review.branchId !== branch.id) {
        throw new StoryError("conflict", "This review belongs to a different branch.");
      }
      if (completedNoteIds.length) {
        if (!review || !changed || completedNoteIds.some((id) =>
          !review?.notes.some((note) => note.id === id && note.appliedRevisionId === null))) {
          throw new StoryError("invalid", "Completed notes must belong to this review and point to an applied change.");
        }
      }

      let revisionId = branch.head_revision_id;
      if (changed) {
        for (const operation of input.operations) {
          if (operation.op === "add_box") this.reserveId(project.id, "box", operation.box.id);
          if (operation.op === "add_connector") this.reserveId(project.id, "connector", operation.connector.id);
        }
        revisionId = this.insertRevision(project.id, branch.head_revision_id, snapshot);
        const contributors = [...new Set([...decode<Actor[]>(branch.contributors), input.actor])].sort();
        this.run(`
          UPDATE branches SET head_revision_id = ?, first_dirty_at = COALESCE(first_dirty_at, ?),
                              last_edit_at = ?, contributors = ? WHERE id = ?
        `, revisionId, now, now, JSON.stringify(contributors), branch.id);
        branch = this.branchRow(project.id, branch.id);
        if (review && completedNoteIds.length) {
          const notes = review.notes.map((note) =>
            completedNoteIds.includes(note.id) ? { ...note, appliedRevisionId: revisionId } : note);
          this.run("UPDATE reviews SET notes = ? WHERE id = ?", JSON.stringify(notes), review.id);
          review = { ...review, notes };
        }
      }

      const result = { revisionId, branch: branchDto(branch), snapshot, ...(review && { review }) };
      this.run("INSERT INTO requests VALUES (?, ?, ?, ?)",
        branch.id, input.requestId, fingerprint, JSON.stringify(result));
      return result;
    });
  }

  startSession(input: { projectId: string; branchId?: string }): Session {
    return this.transact(() => {
      const project = this.projectRow(input.projectId);
      const branch = this.branchRow(project.id, input.branchId ?? project.default_branch_id);
      const id = randomUUID();
      const createdAt = new Date(this.clock()).toISOString();
      this.run("INSERT INTO sessions VALUES (?, ?, ?, ?)", id, project.id, branch.id, createdAt);
      return { id, projectId: project.id, branchId: branch.id, createdAt };
    });
  }

  getSession(sessionId: string): Session {
    const row = this.get<SessionRow>("SELECT * FROM sessions WHERE id = ?", sessionId);
    if (!row) throw new StoryError("not_found", "The agent session does not exist.", { sessionId });
    return sessionDto(row);
  }
}
