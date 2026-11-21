import { isDeepStrictEqual } from "node:util";
import {
  inspectDeletion,
  type Actor,
  type AgentPolicy,
  type Box,
  type Connector,
  type EntityDiff,
  type Operation,
  type StorySnapshot,
} from "../shared/story.js";

export type StoryErrorCode = "not_found" | "invalid" | "conflict" | "locked";

export class StoryError extends Error {
  constructor(
    public readonly code: StoryErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "StoryError";
  }
}

function own<T>(items: Record<string, T>, id: string): T | undefined {
  return Object.hasOwn(items, id) ? items[id] : undefined;
}

function boxAt(snapshot: StorySnapshot, id: string): Box {
  const box = own(snapshot.boxes, id);
  if (!box) throw new StoryError("invalid", `Box ${id} does not exist.`);
  return box;
}

function connectorAt(snapshot: StorySnapshot, id: string): Connector {
  const connector = own(snapshot.connectors, id);
  if (!connector) throw new StoryError("invalid", `Connector ${id} does not exist.`);
  return connector;
}

function checkParent(snapshot: StorySnapshot, boxId: string, parentId: string | null) {
  let ancestorId = parentId;
  while (ancestorId !== null) {
    if (ancestorId === boxId) {
      throw new StoryError("invalid", "A box cannot contain itself or one of its ancestors.");
    }
    ancestorId = boxAt(snapshot, ancestorId).parentId;
  }
}

function resultOwners(snapshot: StorySnapshot, resultId: string | null) {
  if (resultId === null) return [];
  return Object.values(snapshot.boxes)
    .filter((box) => box.derivedResultId === resultId)
    .map(({ id }) => id)
    .sort();
}

function endpointIds(snapshot: StorySnapshot, connectorIds: string[]) {
  return connectorIds.flatMap((id) => {
    const { sourceId, targetId } = connectorAt(snapshot, id);
    return [sourceId, targetId];
  });
}

function affectedBoxes(snapshot: StorySnapshot, operation: Operation): (string | null)[] {
  switch (operation.op) {
    case "add_box":
      return [operation.box.id];
    case "update_box": {
      const box = boxAt(snapshot, operation.boxId);
      return [box.id, operation.patch.type && operation.patch.type !== "question" ? box.derivedResultId : null];
    }
    case "move_box": {
      const box = boxAt(snapshot, operation.boxId);
      if (box.parentId === operation.parentId) return [box.id];
      return [...inspectDeletion(snapshot, box.id).boxIds, box.parentId, operation.parentId];
    }
    case "delete_box": {
      const { boxIds, connectorIds, questionIds } = inspectDeletion(snapshot, operation.boxId);
      return [...boxIds, ...endpointIds(snapshot, connectorIds), ...questionIds];
    }
    case "add_connector":
      return [operation.connector.sourceId, operation.connector.targetId];
    case "update_connector":
    case "delete_connector":
      return endpointIds(snapshot, [operation.connectorId]);
    case "set_derived_result": {
      const question = boxAt(snapshot, operation.questionId);
      return [question.id, question.derivedResultId, operation.resultId];
    }
  }
}

function checkPolicy(snapshot: StorySnapshot, operation: Operation, policy: AgentPolicy, actor: Actor) {
  if (actor === "human" || policy.mode === "full") return;
  if (policy.mode === "add_only" && operation.op === "add_box") return;

  const unlocked = new Set(policy.boxIds);
  const blocked = affectedBoxes(snapshot, operation).filter((id): id is string =>
    id !== null && (policy.mode !== "selected" || !unlocked.has(id)));
  if (blocked.length || policy.mode !== "selected" || operation.op === "add_box") {
    throw new StoryError("locked", "The project's edit settings prevent this agent operation.", {
      boxIds: [...new Set(blocked)],
      operation,
    });
  }
}

function apply(snapshot: StorySnapshot, operation: Operation) {
  switch (operation.op) {
    case "add_box": {
      const { box } = operation;
      if (own(snapshot.boxes, box.id)) throw new StoryError("invalid", `Box ${box.id} already exists.`);
      checkParent(snapshot, box.id, box.parentId);
      snapshot.boxes[box.id] = { ...box, derivedResultId: null };
      break;
    }
    case "update_box": {
      const box = { ...boxAt(snapshot, operation.boxId), ...operation.patch };
      if (box.type !== "question") box.derivedResultId = null;
      snapshot.boxes[box.id] = box;
      break;
    }
    case "move_box": {
      const { boxId, parentId, x, y } = operation;
      const box = boxAt(snapshot, boxId);
      checkParent(snapshot, boxId, parentId);
      snapshot.boxes[boxId] = { ...box, parentId, x, y };
      break;
    }
    case "delete_box": {
      boxAt(snapshot, operation.boxId);
      const { boxIds, connectorIds, questionIds } = inspectDeletion(snapshot, operation.boxId);
      for (const id of questionIds) snapshot.boxes[id] = { ...snapshot.boxes[id], derivedResultId: null };
      for (const id of connectorIds) delete snapshot.connectors[id];
      for (const id of boxIds) delete snapshot.boxes[id];
      break;
    }
    case "add_connector": {
      const { connector } = operation;
      if (connector.sourceId === connector.targetId) {
        throw new StoryError("invalid", "Choose two different boxes for the connection.");
      }
      if (own(snapshot.connectors, connector.id)) {
        throw new StoryError("invalid", `Connector ${connector.id} already exists.`);
      }
      boxAt(snapshot, connector.sourceId);
      boxAt(snapshot, connector.targetId);
      snapshot.connectors[connector.id] = connector;
      break;
    }
    case "update_connector": {
      const connector = connectorAt(snapshot, operation.connectorId);
      snapshot.connectors[connector.id] = { ...connector, ...operation.patch };
      break;
    }
    case "delete_connector":
      connectorAt(snapshot, operation.connectorId);
      delete snapshot.connectors[operation.connectorId];
      break;
    case "set_derived_result": {
      const question = boxAt(snapshot, operation.questionId);
      if (question.type !== "question") {
        throw new StoryError("invalid", "Only a Question can have a derived result.");
      }
      const { resultId } = operation;
      if (resultId !== null) {
        boxAt(snapshot, resultId);
        if (resultId === question.id || resultOwners(snapshot, resultId).some((id) => id !== question.id)) {
          throw new StoryError("invalid", "Choose a different box for this Question's derived result.");
        }
      }
      snapshot.boxes[question.id] = { ...question, derivedResultId: resultId };
      break;
    }
  }
}

function selectFields<T extends object>(entity: T | undefined, keys: string[]) {
  if (!entity) return null;
  return Object.fromEntries(keys.map((key) => [key, entity[key as keyof T]]));
}

function deleteState(snapshot: StorySnapshot, boxId: string) {
  const { boxIds, connectorIds, questionIds } = inspectDeletion(snapshot, boxId);
  return {
    boxes: boxIds.map((id) => snapshot.boxes[id]),
    connectors: connectorIds.map((id) => snapshot.connectors[id]),
    questions: questionIds,
  };
}

function footprint(snapshot: StorySnapshot, operation: Operation): unknown {
  const exists = (id: string | null) => id === null || Object.hasOwn(snapshot.boxes, id);
  switch (operation.op) {
    case "add_box":
      return [own(snapshot.boxes, operation.box.id), exists(operation.box.parentId)];
    case "update_box": {
      const fields = Object.keys(operation.patch);
      if (operation.patch.type && operation.patch.type !== "question") fields.push("derivedResultId");
      return selectFields(own(snapshot.boxes, operation.boxId), fields);
    }
    case "move_box":
      return [selectFields(own(snapshot.boxes, operation.boxId), ["parentId", "x", "y"]), exists(operation.parentId)];
    case "delete_box":
      return deleteState(snapshot, operation.boxId);
    case "add_connector":
      return [own(snapshot.connectors, operation.connector.id), exists(operation.connector.sourceId),
        exists(operation.connector.targetId)];
    case "update_connector":
      return selectFields(own(snapshot.connectors, operation.connectorId), Object.keys(operation.patch));
    case "delete_connector":
      return own(snapshot.connectors, operation.connectorId);
    case "set_derived_result":
      return [selectFields(own(snapshot.boxes, operation.questionId), ["type", "derivedResultId"]),
        exists(operation.resultId), resultOwners(snapshot, operation.resultId)];
  }
}

export function applyOperations(
  base: StorySnapshot,
  head: StorySnapshot,
  operations: Operation[],
  policy: AgentPolicy,
  actor: Actor,
): StorySnapshot {
  const baseDraft = base === head ? null : structuredClone(base);
  const draft = structuredClone(head);
  for (const operation of operations) {
    if (baseDraft) {
      const before = footprint(baseDraft, operation);
      const current = footprint(draft, operation);
      apply(baseDraft, operation);
      const proposed = footprint(baseDraft, operation);
      if (!isDeepStrictEqual(before, current)) {
        throw new StoryError("conflict", "The canvas changed since this edit was prepared.", {
          operation,
          before,
          current,
          proposed,
        });
      }
      checkPolicy(draft, operation, policy, actor);
      try {
        apply(draft, operation);
      } catch (error) {
        if (!(error instanceof StoryError)) throw error;
        throw new StoryError("conflict", error.message, { operation, before, current, proposed });
      }
    } else {
      checkPolicy(draft, operation, policy, actor);
      apply(draft, operation);
    }
  }
  return draft;
}

export function compareEntities<T extends { id: string }>(
  before: Record<string, T>,
  after: Record<string, T>,
): EntityDiff<T> {
  const diff: EntityDiff<T> = { added: [], removed: [], changed: [] };
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const id of [...ids].sort()) {
    const previous = own(before, id);
    const latest = own(after, id);
    if (!previous && latest) {
      diff.added.push(latest);
    } else if (previous && !latest) {
      diff.removed.push(previous);
    } else if (previous && latest) {
      const keys = new Set([...Object.keys(previous), ...Object.keys(latest)]) as Set<keyof T>;
      const fields = [...keys].filter((key) => !isDeepStrictEqual(previous[key], latest[key])).map(String);
      if (fields.length) diff.changed.push({ before: previous, after: latest, fields });
    }
  }
  return diff;
}
