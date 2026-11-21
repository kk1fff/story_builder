import { z } from "zod";

export const boxTypes = [
  "problem",
  "event",
  "proposal",
  "reasoning",
  "question",
  "action",
  "decision",
] as const;

export const connectorPresets = [
  { label: "motivates", reverseLabel: "motivated by" },
  { label: "solves", reverseLabel: "solved by" },
  { label: "causes", reverseLabel: "caused by" },
  { label: "supports", reverseLabel: "supported by" },
  { label: "illustrates", reverseLabel: "illustrated by" },
  { label: "grounds", reverseLabel: "grounded in" },
  { label: "raises", reverseLabel: "raised by" },
  { label: "answers", reverseLabel: "answered by" },
  { label: "intended to enable", reverseLabel: "intended outcome of" },
  { label: "tests", reverseLabel: "tested by" },
  { label: "achieves", reverseLabel: "achieved by" },
  { label: "implemented in", reverseLabel: "implements" },
  { label: "depends on", reverseLabel: "needed by" },
] as const;

export const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const nameSchema = z.string().trim().min(1).max(200);
const bodySchema = z.string().max(100_000);
const labelSchema = z.string().trim().min(1).max(120);
const boxTypeSchema = z.enum(boxTypes);

const newBoxSchema = z.strictObject({
  id: idSchema,
  parentId: idSchema.nullable(),
  type: boxTypeSchema,
  title: nameSchema,
  body: bodySchema,
  x: z.number(),
  y: z.number(),
});

export const boxSchema = newBoxSchema.extend({ derivedResultId: idSchema.nullable() });

export const connectorSchema = z.strictObject({
  id: idSchema,
  sourceId: idSchema,
  targetId: idSchema,
  label: labelSchema,
  reverseLabel: labelSchema.nullable(),
});

export const operationSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("add_box"), box: newBoxSchema }),
  z.strictObject({
    op: z.literal("update_box"),
    boxId: idSchema,
    patch: z.strictObject({
      title: nameSchema.optional(),
      body: bodySchema.optional(),
      type: boxTypeSchema.optional(),
    }),
  }),
  z.strictObject({
    op: z.literal("move_box"),
    boxId: idSchema,
    parentId: idSchema.nullable(),
    x: z.number(),
    y: z.number(),
  }),
  z.strictObject({ op: z.literal("delete_box"), boxId: idSchema }),
  z.strictObject({ op: z.literal("add_connector"), connector: connectorSchema }),
  z.strictObject({
    op: z.literal("update_connector"),
    connectorId: idSchema,
    patch: z.strictObject({ label: labelSchema.optional(), reverseLabel: labelSchema.nullable().optional() }),
  }),
  z.strictObject({ op: z.literal("delete_connector"), connectorId: idSchema }),
  z.strictObject({
    op: z.literal("set_derived_result"),
    questionId: idSchema,
    resultId: idSchema.nullable(),
  }),
]);

export const agentPolicySchema = z.strictObject({
  mode: z.enum(["locked", "selected", "add_only", "full"]),
  boxIds: z.array(idSchema).max(10_000),
});

export type Actor = "human" | "agent";
export type BoxType = (typeof boxTypes)[number];
export type Box = z.infer<typeof boxSchema>;
export type Connector = z.infer<typeof connectorSchema>;
export type Operation = z.infer<typeof operationSchema>;
export type AgentPolicy = z.infer<typeof agentPolicySchema>;

export type StorySnapshot = {
  boxes: Record<string, Box>;
  connectors: Record<string, Connector>;
};

export type Project = {
  id: string;
  name: string;
  defaultBranchId: string;
  createdAt: string;
};

export type Branch = {
  id: string;
  projectId: string;
  name: string;
  headRevisionId: string;
  headVersionId: string;
};

export type Version = {
  id: string;
  projectId: string;
  branchId: string;
  parentId: string | null;
  revisionId: string;
  name: string;
  createdAt: string;
  contributors: Actor[];
};

export type WorkingStory = {
  project: Project;
  branch: Branch;
  revisionId: string;
  snapshot: StorySnapshot;
  policy: AgentPolicy;
};

export type ReviewNote = {
  id: string;
  boxIds: string[];
  text: string;
  appliedRevisionId: string | null;
};

export type Review = {
  id: string;
  projectId: string;
  branchId: string;
  baseRevisionId: string;
  createdAt: string;
  notes: ReviewNote[];
};

export type Session = {
  id: string;
  projectId: string;
  branchId: string;
  createdAt: string;
};

export type EntityDiff<T> = {
  added: T[];
  removed: T[];
  changed: { before: T; after: T; fields: string[] }[];
};

export type VersionDiff = {
  from: Version;
  to: Version;
  boxes: EntityDiff<Box>;
  connectors: EntityDiff<Connector>;
};

export type DeleteImpact = {
  boxIds: string[];
  connectorIds: string[];
  questionIds: string[];
};

export function inspectDeletion(snapshot: StorySnapshot, boxId: string): DeleteImpact {
  const childrenByParent = new Map<string, string[]>();
  for (const box of Object.values(snapshot.boxes)) {
    if (box.parentId === null) continue;
    const children = childrenByParent.get(box.parentId) ?? [];
    children.push(box.id);
    childrenByParent.set(box.parentId, children);
  }

  const removed = new Set<string>();
  const pending = Object.hasOwn(snapshot.boxes, boxId) ? [boxId] : [];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (removed.has(id)) continue;
    removed.add(id);
    pending.push(...(childrenByParent.get(id) ?? []));
  }

  const connectorIds = Object.values(snapshot.connectors)
    .filter(({ sourceId, targetId }) => removed.has(sourceId) || removed.has(targetId))
    .map(({ id }) => id)
    .sort();
  const questionIds = Object.values(snapshot.boxes)
    .filter((box) => !removed.has(box.id) && box.derivedResultId !== null && removed.has(box.derivedResultId))
    .map(({ id }) => id)
    .sort();

  return { boxIds: [...removed].sort(), connectorIds, questionIds };
}
