import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectDeletion, type Actor, type Operation } from "../src/shared/story.js";
import { StoryStore } from "../src/server/story-store.js";

const addBox = (id: string, parentId: string | null = null, type: "question" | "decision" | "event" = "event") =>
  ({ op: "add_box", box: { id, parentId, type, title: id, body: "", x: 0, y: 0 } }) satisfies Operation;
const editTitle = (boxId: string, title: string) => ({ op: "update_box", boxId, patch: { title } }) satisfies Operation;
const addLink = (id: string, sourceId: string, targetId: string) => ({
  op: "add_connector",
  connector: { id, sourceId, targetId, label: "supports", reverseLabel: "supported by" },
}) satisfies Operation;
const deleteBox = (boxId: string) => ({ op: "delete_box", boxId }) satisfies Operation;

describe("StoryStore", () => {
  let now: number;
  let store: StoryStore;
  let projectId: string;
  let branchId: string;
  let initialRevisionId: string;
  let initialVersionId: string;
  let requests: number;

  beforeEach(() => {
    now = 1000;
    requests = 0;
    store = new StoryStore(":memory:", { clock: () => now });
    const story = store.createProject({ name: "GCC" });
    projectId = story.project.id;
    branchId = story.branch.id;
    initialRevisionId = story.revisionId;
    initialVersionId = story.branch.headVersionId;
  });

  afterEach(() => store.close());

  function apply(operations: Operation[], baseRevisionId: string, actor: Actor = "human", branch = branchId) {
    requests += 1;
    return store.applyChanges({ projectId, branchId: branch, baseRevisionId, actor, operations, requestId: `r-${requests}` });
  }

  it("starts with an empty canvas and a project-scoped working session", () => {
    expect(store.listProjects()).toEqual([expect.objectContaining({ id: projectId, name: "GCC" })]);
    expect(store.readStory({ projectId }).snapshot).toEqual({ boxes: {}, connectors: {} });
    const session = store.startSession({ projectId });
    expect(store.getSession(session.id)).toEqual(expect.objectContaining({ projectId, branchId }));
    expect(() => store.startSession({ projectId: "missing" })).toThrow(expect.objectContaining({ code: "not_found" }));
  });

  it("groups edits by both contributors until the canvas has been idle for five seconds", () => {
    const first = apply([addBox("pastel")], initialRevisionId);
    now = 5900;
    expect(store.flushDueVersions()).toEqual([]);
    const second = apply([editTitle("pastel", "Pastel")], first.revisionId, "agent");
    now = 10_899;
    expect(store.flushDueVersions()).toEqual([]);
    now = 10_900;
    const [saved] = store.flushDueVersions();
    expect(saved).toMatchObject({
      branchId, parentId: initialVersionId, revisionId: second.revisionId, contributors: ["agent", "human"],
    });
    expect(store.flushDueVersions()).toEqual([]);
    expect(store.saveVersion({ projectId, branchId })).toBeNull();
  });

  it("closes a busy window after thirty seconds before accepting another edit", () => {
    let revisionId = apply([addBox("box")], initialRevisionId).revisionId;
    for (let step = 1; step < 8; step++) {
      now = 1000 + step * 4000;
      revisionId = apply([editTitle("box", `Step ${step}`)], revisionId).revisionId;
    }
    now = 31_000;
    const newest = apply([editTitle("box", "Next window")], revisionId);
    const history = store.getHistory(projectId);
    expect(history.versions).toHaveLength(2);
    expect(history.versions.at(-1)?.revisionId).toBe(revisionId);
    expect(store.readStory({ projectId }).revisionId).toBe(newest.revisionId);

    const manual = store.saveVersion({ projectId, branchId, name: "Named checkpoint" });
    expect(manual).toMatchObject({ revisionId: newest.revisionId, name: "Named checkpoint" });
    now += 35_000;
    expect(store.flushDueVersions()).toEqual([]);
  });

  it("rebases independent fields and rejects an overlapping batch before writing any operation", () => {
    const base = apply([addBox("finding"), addBox("decision")], initialRevisionId);
    const head = apply([editTitle("finding", "My newer title")], base.revisionId);
    const merged = apply([
      { op: "update_box", boxId: "finding", patch: { body: "Memory limit" } },
    ], base.revisionId, "agent");
    expect(merged.snapshot.boxes.finding).toMatchObject({ title: "My newer title", body: "Memory limit" });
    expect(() => apply([addLink("evidence", "finding", "decision"), editTitle("finding", "Proposed title")],
      base.revisionId, "agent")).toThrow(expect.objectContaining({
      code: "conflict",
      details: expect.objectContaining({
        before: { title: "finding" }, current: { title: "My newer title" }, proposed: { title: "Proposed title" },
      }),
    }));
    expect(head.revisionId).not.toBe(merged.revisionId);
    expect(store.readStory({ projectId }).snapshot.connectors).toEqual({});
    expect(store.readStory({ projectId }).revisionId).toBe(merged.revisionId);
  });

  it("validates lock scope against the live canvas and preserves the rest of a rejected batch", () => {
    const base = apply([addBox("first"), addBox("second"), addLink("link", "first", "second")], initialRevisionId);
    store.setAgentPolicy(projectId, { mode: "locked", boxIds: [] });
    expect(() => apply([addBox("blocked")], base.revisionId, "agent")).toThrow(expect.objectContaining({ code: "locked" }));
    store.setAgentPolicy(projectId, { mode: "add_only", boxIds: [] });
    expect(() => apply([addBox("third"), addLink("blocked-link", "first", "third")], base.revisionId, "agent"))
      .toThrow(expect.objectContaining({ code: "locked" }));
    expect(Object.hasOwn(store.readStory({ projectId }).snapshot.boxes, "third")).toBe(false);
    const added = apply([addBox("third")], base.revisionId, "agent");

    store.setAgentPolicy(projectId, { mode: "selected", boxIds: ["first"] });
    expect(() => apply([{ op: "delete_connector", connectorId: "link" }], added.revisionId, "agent"))
      .toThrow(expect.objectContaining({ code: "locked", details: expect.objectContaining({ boxIds: ["second"] }) }));
    const edited = apply([editTitle("first", "Allowed")], added.revisionId, "agent");
    expect(edited.snapshot.boxes.first.title).toBe("Allowed");
    const manual = apply([editTitle("second", "Manual edit")], edited.revisionId);
    expect(manual.snapshot.boxes.second.title).toBe("Manual edit");
  });

  it("rejects stale nested deletion impact and removes outside links and result markers atomically", () => {
    const base = apply([
      addBox("question", null, "question"), addBox("decision", null, "decision"), addBox("pastel", "decision"),
      { op: "set_derived_result", questionId: "question", resultId: "pastel" },
    ], initialRevisionId);
    expect(inspectDeletion(base.snapshot, "decision")).toEqual({
      boxIds: ["decision", "pastel"], connectorIds: [], questionIds: ["question"],
    });
    const added = apply([addLink("outside", "question", "pastel")], base.revisionId);
    expect(() => apply([deleteBox("decision")], base.revisionId)).toThrow(expect.objectContaining({ code: "conflict" }));
    store.setAgentPolicy(projectId, { mode: "selected", boxIds: ["decision", "pastel"] });
    expect(() => apply([deleteBox("decision")], added.revisionId, "agent"))
      .toThrow(expect.objectContaining({ code: "locked", details: expect.objectContaining({ boxIds: ["question"] }) }));
    const removed = apply([deleteBox("decision")], added.revisionId);
    expect(Object.keys(removed.snapshot.boxes)).toEqual(["question"]);
    expect(removed.snapshot.boxes.question.derivedResultId).toBeNull();
    expect(removed.snapshot.connectors).toEqual({});
  });

  it("persists review resolutions only alongside an applied revision and deduplicates an exact retry", () => {
    const base = apply([addBox("pastel"), addBox("vuck")], initialRevisionId);
    const review = store.createReview({
      projectId, branchId, baseRevisionId: base.revisionId,
      notes: [{ id: "pastel-note", boxIds: ["pastel"], text: "Explain the memory limit" },
        { id: "vuck-note", boxIds: ["vuck"], text: "Explain the licensing limitation" }],
    });
    const input = {
      projectId, branchId, baseRevisionId: base.revisionId, requestId: "agent-review-1",
      actor: "agent" as const, operations: [editTitle("pastel", "64 KB available")],
      reviewId: review.id, completedNoteIds: ["pastel-note"],
    };
    const result = store.applyChanges(input);
    expect(store.applyChanges(input)).toEqual(result);
    expect(() => store.applyChanges({ ...input, operations: [editTitle("vuck", "Different batch")] }))
      .toThrow(expect.objectContaining({ code: "conflict" }));
    expect(store.readReview({ projectId, reviewId: review.id }).notes).toEqual([
      expect.objectContaining({ id: "pastel-note", appliedRevisionId: result.revisionId }),
      expect.objectContaining({ id: "vuck-note", appliedRevisionId: null }),
    ]);
    expect(store.readStory({ projectId, revisionId: review.baseRevisionId }).snapshot.boxes.pastel.title).toBe("pastel");
  });

  it("forks earlier canvas content and compares moves by stable identity across branches", () => {
    const original = apply([addBox("decision"), addBox("finding", "decision"), addBox("target"),
      addLink("reasons", "finding", "target")], initialRevisionId);
    const first = store.saveVersion({ projectId, branchId, name: "Original" })!;
    const moved = apply([{ op: "move_box", boxId: "finding", parentId: "target", x: 10, y: 20 }], original.revisionId);
    const second = store.saveVersion({ projectId, branchId, name: "Moved" })!;
    const branch = store.branchFromVersion({ projectId, versionId: first.id, name: "Alternate account" });
    expect(store.readStory({ projectId, branchId: branch.id }).snapshot.boxes.finding.parentId).toBe("decision");
    expect(() => apply([editTitle("finding", "Foreign base")], moved.revisionId, "human", branch.id))
      .toThrow(expect.objectContaining({ code: "conflict" }));
    apply([editTitle("finding", "Alternate finding")], branch.headRevisionId, "human", branch.id);
    const alternate = store.saveVersion({ projectId, branchId: branch.id, name: "Alternate" })!;
    expect(alternate.parentId).toBe(first.id);
    const diff = store.compareVersions({ projectId, fromVersionId: second.id, toVersionId: alternate.id });
    expect(diff.boxes.added).toEqual([]);
    expect(diff.boxes.removed).toEqual([]);
    expect(diff.boxes.changed[0]?.fields).toEqual(expect.arrayContaining(["parentId", "x", "y", "title"]));
    expect(diff.connectors).toEqual({ added: [], removed: [], changed: [] });
    expect(store.readStory({ projectId }).revisionId).toBe(moved.revisionId);
  });

  it("preserves node identities and validates parent cycles, even during a stale rebase", () => {
    const base = apply([addBox("a"), addBox("b")], initialRevisionId);
    const head = apply([{ op: "move_box", boxId: "a", parentId: "b", x: 0, y: 0 }], base.revisionId);
    expect(() => apply([{ op: "move_box", boxId: "b", parentId: "a", x: 0, y: 0 }], base.revisionId))
      .toThrow(expect.objectContaining({ code: "conflict" }));
    const removed = apply([deleteBox("a")], head.revisionId);
    expect(() => apply([addBox("a")], removed.revisionId))
      .toThrow(expect.objectContaining({ code: "conflict" }));
  });
});

it("recovers a durable pending version across a service restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "story-store-test-"));
  let now = 1000;
  const path = join(directory, "story.sqlite");
  const first = new StoryStore(path, { clock: () => now });
  const started = first.createProject({ name: "Persistent GCC" });
  const projectId = started.project.id;
  const branchId = started.branch.id;
  const applied = first.applyChanges({
    projectId, branchId, baseRevisionId: started.revisionId, requestId: "first-edit", actor: "human",
    operations: [addBox("pastel")],
  });
  first.close();

  now = 7000;
  const restarted = new StoryStore(path, { clock: () => now });
  try {
    expect(restarted.readStory({ projectId, branchId }).snapshot.boxes.pastel).toBeDefined();
    expect(restarted.getHistory(projectId).versions).toHaveLength(2);
    expect(restarted.getHistory(projectId).versions.at(-1)?.revisionId).toBe(applied.revisionId);
    expect(restarted.flushDueVersions()).toEqual([]);
  } finally {
    restarted.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
