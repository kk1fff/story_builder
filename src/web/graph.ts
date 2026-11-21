import { defaultBoxSize, getBoxSize, type Box, type Connector, type StorySnapshot } from "../shared/story.js";

export const boxTypeLabels = {
  problem: "Problem",
  event: "Event",
  proposal: "Proposal",
  reasoning: "Reasoning",
  question: "Question",
  action: "Action",
  decision: "Decision",
} as const;

export function boxPath(snapshot: StorySnapshot, boxId: string): Box[] {
  const path: Box[] = [];
  const visited = new Set<string>();
  let id: string | null = boxId;
  while (id !== null && !visited.has(id)) {
    const box: Box | undefined = snapshot.boxes[id];
    if (!box) break;
    path.push(box);
    visited.add(id);
    id = box.parentId;
  }
  return path.reverse();
}

const placementGap = 56;

export function findBoxPosition(
  boxes: StorySnapshot["boxes"],
  parentId: string | null,
  options: { moving?: Box; measuredHeights?: ReadonlyMap<string, number> } = {},
) {
  const { moving, measuredHeights } = options;
  const size = moving ? getBoxSize(moving) : defaultBoxSize;
  const height = Math.max(size.minHeight, moving ? measuredHeights?.get(moving.id) ?? 0 : 0);
  const occupied = Object.values(boxes).filter((box) => box.parentId === parentId && box.id !== moving?.id)
    .map((box) => {
      const { width, minHeight } = getBoxSize(box);
      return {
        x: box.x, y: box.y, width,
        height: Math.max(minHeight, measuredHeights?.get(box.id) ?? 0),
      };
    });
  for (let index = 0; ; index++) {
    const x = (index % 3) * (defaultBoxSize.width + placementGap);
    const y = Math.floor(index / 3) * (defaultBoxSize.minHeight + 70);
    const overlaps = occupied.some((other) => (
      x < other.x + other.width + placementGap && x + size.width + placementGap > other.x
      && y < other.y + other.height + placementGap && y + height + placementGap > other.y
    ));
    if (!overlaps) return { x, y };
  }
}

type VisibleEndpoint = {
  box: Box;
  nodeId: string;
  boundary: boolean;
  projected: boolean;
  inside: boolean;
};

export type VisibleConnector = {
  id: string;
  source: string;
  target: string;
  projected: boolean;
  connectors: Connector[];
};

export function projectCanvas(snapshot: StorySnapshot, parentId: string | null) {
  const localBoxes = Object.values(snapshot.boxes).filter((box) => box.parentId === parentId);
  const parentPath = parentId === null ? [] : boxPath(snapshot, parentId);
  const parentAncestry = new Set<string | null>([null, ...parentPath.map((box) => box.id)]);
  const endpoints = new Map<string, VisibleEndpoint | undefined>();
  const portals = new Map<string, VisibleEndpoint>();
  const visibleConnectors = new Map<string, VisibleConnector>();

  function endpoint(id: string): VisibleEndpoint | undefined {
    if (endpoints.has(id)) return endpoints.get(id);
    const path = boxPath(snapshot, id);
    const parentIndex = parentId === null ? -1 : path.findIndex((box) => box.id === parentId);
    const inside = parentId === null || parentIndex >= 0;
    const local = inside ? path[parentIndex + 1] : undefined;
    const visible = local ?? path.findLast((box) => parentAncestry.has(box.parentId));
    const result = visible && {
      box: visible,
      nodeId: local ? visible.id : `outside:${visible.id}`,
      boundary: !local,
      projected: visible.id !== id,
      inside,
    };
    endpoints.set(id, result);
    return result;
  }

  for (const connector of Object.values(snapshot.connectors)) {
    const source = endpoint(connector.sourceId);
    const target = endpoint(connector.targetId);
    if (!source || !target || (!source.inside && !target.inside) || source.nodeId === target.nodeId) continue;
    if (source.boundary) portals.set(source.nodeId, source);
    if (target.boundary) portals.set(target.nodeId, target);
    const projected = source.projected || target.projected;
    const id = projected ? `projected:${source.nodeId}:${target.nodeId}` : connector.id;
    const matching = visibleConnectors.get(id);
    if (matching) {
      matching.connectors.push(connector);
    } else {
      visibleConnectors.set(id, { id, source: source.nodeId, target: target.nodeId, projected, connectors: [connector] });
    }
  }

  return {
    boxes: localBoxes,
    parentPath,
    portals: [...portals.values()].sort((a, b) => a.box.title.localeCompare(b.box.title)),
    connectors: [...visibleConnectors.values()],
  };
}
