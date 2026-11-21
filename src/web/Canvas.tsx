import { useEffect, useMemo, useRef } from "react";
import type { MouseEvent } from "react";
import {
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useNodesState,
} from "@xyflow/react";
import type { Edge, EdgeProps, Node, NodeProps, ReactFlowInstance, Viewport, XYPosition } from "@xyflow/react";
import type { Box, StorySnapshot } from "../shared/story.js";
import { boxPath, boxTypeLabels, projectCanvas } from "./graph.js";

type ChangeKind = "added" | "removed" | "changed" | "moved";
type ConnectorChangeKind = Exclude<ChangeKind, "moved">;

export type BoardProps = {
  snapshot: StorySnapshot;
  activeParentId: string | null;
  selectedIds: readonly string[] | ReadonlySet<string>;
  readOnly: boolean;
  selectBox: (boxId: string, extend: boolean) => void;
  openBox: (boxId: string) => void;
  beginMoveBox?: (boxId: string) => void;
  moveBox: (boxId: string, position: XYPosition) => void;
  inspectConnector: (connectorIds: string[]) => void;
  addBox?: () => void;
  changeKinds?: Readonly<Record<string, ChangeKind>>;
  connectorChangeKinds?: Readonly<Record<string, ConnectorChangeKind>>;
  nestedChangeCounts?: Readonly<Record<string, number>>;
};

type CardData = {
  box: Box;
  childCount: number;
  boundaryPath?: string;
  selected: boolean;
  derivedResult: boolean;
  change?: ChangeKind;
  nestedChanges?: number;
  selectBox: BoardProps["selectBox"];
  openBox: BoardProps["openBox"];
};

type WireData = {
  connectorIds: string[];
  label: string;
  accessibleLabel: string;
  projected: boolean;
  offset: number;
  change?: ConnectorChangeKind;
  changeLabel?: string;
  inspect: BoardProps["inspectConnector"];
};

type CanvasNode = Node<CardData, "story">;
type CanvasEdge = Edge<WireData, "story">;

const cardWidth = 224;
const portalSpacing = 176;
const fitOptions = { padding: 18, maxZoom: 1.08 };
const portSides = [Position.Left, Position.Right, Position.Top, Position.Bottom];
const vectors = {
  [Position.Left]: { x: -1, y: 0 },
  [Position.Right]: { x: 1, y: 0 },
  [Position.Top]: { x: 0, y: -1 },
  [Position.Bottom]: { x: 0, y: 1 },
};

function StoryCard({ data, graph = false }: { data: CardData; graph?: boolean }) {
  const { box, childCount, selected, boundaryPath, derivedResult, change, nestedChanges, selectBox, openBox } = data;
  const select = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    selectBox(box.id, event.shiftKey);
  };
  return (
    <article
      className={`story-card${boundaryPath ? " story-card--boundary" : ""}${selected ? " story-card--selected" : ""}`}
      data-box-id={graph ? box.id : undefined}
      data-list-box-id={graph ? undefined : box.id}
      data-box-type={box.type}
      data-change={change}
    >
      {graph && portSides.map((side) => (
        <Handle key={`source-${side}`} id={`source-${side}`} type="source" position={side} isConnectable={false} />
      ))}
      {graph && portSides.map((side) => (
        <Handle key={`target-${side}`} id={`target-${side}`} type="target" position={side} isConnectable={false} />
      ))}
      <div className="story-card__top">
        <span className="box-type" data-type={box.type}>{boxTypeLabels[box.type]}</span>
        {change && <span className="story-card__change">{change}</span>}
        {derivedResult && <span className="story-card__result">Derived result</span>}
      </div>
      <h3>
        <button className="story-card__title nodrag" type="button" aria-pressed={selected} onClick={select} title={box.title}>
          {box.title}
        </button>
      </h3>
      {boundaryPath && (
        <p className="story-card__path" title={boundaryPath}>
          {boundaryPath}
        </p>
      )}
      <footer className="story-card__footer">
        <span>
          {nestedChanges ? `${nestedChanges} nested ${nestedChanges === 1 ? "change" : "changes"}` :
            childCount ? `${childCount} ${childCount === 1 ? "box" : "boxes"} inside` : ""}
        </span>
        <button
          className="story-card__open nodrag"
          type="button"
          aria-label={`Open ${box.title}`}
          onClick={(event) => { event.stopPropagation(); openBox(box.id); }}
        >
          Open <span aria-hidden="true">↗</span>
        </button>
      </footer>
    </article>
  );
}

function StoryNode({ data }: NodeProps<CanvasNode>) {
  return <StoryCard data={data} graph />;
}

function StoryWire({ data, id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd }: EdgeProps<CanvasEdge>) {
  if (!data) return null;
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const distance = Math.hypot(dx, dy) || 1;
  const curve = Math.min(128, Math.max(32, distance * 0.36));
  const offsetX = -(dy / distance) * data.offset;
  const offsetY = (dx / distance) * data.offset;
  const from = vectors[sourcePosition];
  const to = vectors[targetPosition];
  const c1x = sourceX + from.x * curve + offsetX;
  const c1y = sourceY + from.y * curve + offsetY;
  const c2x = targetX + to.x * curve + offsetX;
  const c2y = targetY + to.y * curve + offsetY;
  const labelX = (sourceX + 3 * c1x + 3 * c2x + targetX) / 8;
  const labelY = (sourceY + 3 * c1y + 3 * c2y + targetY) / 8;
  const path = `M ${sourceX} ${sourceY} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${targetX} ${targetY}`;
  const kind = data.projected ? "projected" : "solid";

  return (
    <>
      <BaseEdge id={id} className={`story-wire story-wire--${kind}`} data-change={data.change} path={path} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <button
          className="story-wire__label nodrag nopan"
          data-connector-kind={kind}
          data-change={data.change}
          type="button"
          aria-label={data.accessibleLabel}
          aria-description={data.changeLabel}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          onClick={(event) => { event.stopPropagation(); data.inspect(data.connectorIds); }}
        >
          <span>{data.label}</span>
          {data.changeLabel && <span className="story-wire__change">{data.changeLabel}</span>}
        </button>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { story: StoryNode };
const edgeTypes = { story: StoryWire };

function connectionSides(source: XYPosition, target: XYPosition) {
  const x = target.x - source.x;
  const y = target.y - source.y;
  if (Math.abs(y) > Math.abs(x) * 0.72) {
    return [y > 0 ? Position.Bottom : Position.Top, y > 0 ? Position.Top : Position.Bottom];
  }
  return [x >= 0 ? Position.Right : Position.Left, x >= 0 ? Position.Left : Position.Right];
}

function buildModel(props: BoardProps): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const { snapshot, activeParentId, selectedIds, readOnly, selectBox, openBox, inspectConnector, changeKinds, connectorChangeKinds, nestedChangeCounts } = props;
  const { boxes, portals, connectors } = projectCanvas(snapshot, activeParentId);
  const selected = new Set(selectedIds);
  const childCounts = new Map<string, number>();
  const results = new Set<string>();
  for (const box of Object.values(snapshot.boxes)) {
    if (box.parentId !== null) childCounts.set(box.parentId, (childCounts.get(box.parentId) ?? 0) + 1);
    if (box.derivedResultId !== null) results.add(box.derivedResultId);
  }
  function card(box: Box, boundaryPath?: string): CardData {
    return {
      box, boundaryPath, selectBox, openBox,
      childCount: childCounts.get(box.id) ?? 0,
      selected: selected.has(box.id),
      derivedResult: results.has(box.id),
      change: changeKinds?.[box.id],
      nestedChanges: nestedChangeCounts?.[box.id],
    };
  }

  const nodes: CanvasNode[] = boxes.map((box) => ({
    id: box.id,
    type: "story",
    position: { x: box.x, y: box.y },
    width: cardWidth,
    draggable: !readOnly,
    data: card(box),
  }));
  const rightmost = boxes.reduce((x, box) => Math.max(x, box.x), -Infinity);
  const topmost = boxes.reduce((y, box) => Math.min(y, box.y), Infinity);
  const portalX = boxes.length ? rightmost + cardWidth + 150 : 0;
  const portalY = boxes.length ? topmost : 0;
  portals.forEach(({ box, nodeId }, index) => {
    const ancestors = boxPath(snapshot, box.id).slice(0, -1).map(({ title }) => title);
    nodes.push({
      id: nodeId,
      type: "story",
      position: { x: portalX, y: portalY + index * portalSpacing },
      width: cardWidth,
      draggable: false,
      data: card(box, box.id === activeParentId
        ? "Containing box"
        : `Outside this box · ${["Main canvas", ...ancestors].join(" / ")}`),
    });
  });

  const nodePositions = new Map<string, XYPosition>(nodes.map(({ id, position }) => [id, position]));
  const laneById = new Map<string, number>();
  const parallel = new Map<string, string[]>();
  connectors.forEach(({ id, source, target }) => {
    const pair = JSON.stringify([source, target].sort());
    const lanes = parallel.get(pair) ?? [];
    lanes.push(id);
    parallel.set(pair, lanes);
  });
  parallel.forEach((lanes) => lanes.forEach((id, index) => laneById.set(id, (index - (lanes.length - 1) / 2) * 39)));

  const edges: CanvasEdge[] = connectors.map(({ id, source, target, projected, connectors: members }) => {
    const [sourceSide, targetSide] = connectionSides(nodePositions.get(source)!, nodePositions.get(target)!);
    const many = members.length > 1;
    const label = many ? `${members.length} links` : members[0].label;
    const offset = (laneById.get(id) ?? 0) * (source < target ? 1 : -1);
    const changes = members.flatMap(({ id }) => connectorChangeKinds?.[id] ?? []);
    const change = changes.every((entry) => entry === changes[0]) ? changes[0] : "changed";
    const changeLabel = many && changes.length ? `${changes.length} ${changes.length === 1 ? "change" : "changes"}` : change;
    return {
      id, source, target,
      type: "story",
      sourceHandle: `source-${sourceSide}`,
      targetHandle: `target-${targetSide}`,
      markerEnd: { type: MarkerType.ArrowClosed, color: change ? `var(--connector-${change})` : projected ? "var(--wire-dashed)" : "var(--wire)", width: 18, height: 18 },
      data: {
        connectorIds: members.map(({ id: connectorId }) => connectorId),
        projected, label, offset, change, changeLabel,
        accessibleLabel: many ? `Inspect ${members.length} connectors` : `Inspect connector: ${label}`,
        inspect: inspectConnector,
      },
    };
  });

  return { nodes, edges };
}

function FlowCanvas({
  model, viewport, saveViewport, readOnly, beginMoveBox, moveBox,
}: {
  model: ReturnType<typeof buildModel>;
  viewport: Viewport | undefined;
  saveViewport: (viewport: Viewport) => void;
  readOnly: boolean;
  beginMoveBox?: BoardProps["beginMoveBox"];
  moveBox: BoardProps["moveBox"];
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState(model.nodes);
  const container = useRef<HTMLDivElement>(null);
  const flow = useRef<ReactFlowInstance<CanvasNode, CanvasEdge> | null>(null);
  const selectedId = model.nodes.find((node) => node.data.selected && !node.data.boundaryPath)?.id;

  useEffect(() => {
    if (!container.current) return;
    let previousWidth = 0;
    let scheduled = 0;
    const resize = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      if (width === 0) return;
      if (previousWidth && Math.abs(width - previousWidth) > 40) {
        cancelAnimationFrame(scheduled);
        scheduled = requestAnimationFrame(() => void flow.current?.fitView(fitOptions));
      }
      previousWidth = width;
    });
    resize.observe(container.current);
    return () => {
      resize.disconnect();
      cancelAnimationFrame(scheduled);
    };
  }, []);

  useEffect(() => {
    setNodes((previous) => {
      const dragging = new Map(previous.filter((node) => node.dragging).map((node) => [node.id, node.position]));
      return model.nodes.map((node) => {
        const position = dragging.get(node.id);
        return position ? { ...node, position, dragging: true } : node;
      });
    });
  }, [model.nodes, setNodes]);

  useEffect(() => {
    if (!selectedId) return;
    const scheduled = requestAnimationFrame(() => {
      const canvas = container.current;
      const instance = flow.current;
      const selected = instance?.getNode(selectedId);
      if (!canvas?.clientWidth || !instance || !selected) return;
      const { zoom, x, y } = instance.getViewport();
      const { position, measured } = selected;
      const width = measured?.width ?? cardWidth;
      const height = measured?.height ?? 116;
      const left = position.x * zoom + x;
      const top = position.y * zoom + y;
      if (left < 0 || top < 0 || left + width * zoom > canvas.clientWidth || top + height * zoom > canvas.clientHeight) {
        void instance.setCenter(position.x + width / 2, position.y + height / 2, { zoom });
      }
    });
    return () => cancelAnimationFrame(scheduled);
  }, [selectedId]);

  return (
    <div className="board__flow" ref={container}>
      <ReactFlow
        nodes={nodes}
        edges={model.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onInit={(instance) => { flow.current = instance; }}
        onNodesChange={onNodesChange}
        onNodeClick={(event, node) => node.data.selectBox(node.data.box.id, event.shiftKey)}
        onNodeDragStart={(_, node) => beginMoveBox?.(node.data.box.id)}
        onNodeDragStop={(_, node) => moveBox(node.data.box.id, node.position)}
        onEdgeClick={(_, edge) => edge.data?.inspect(edge.data.connectorIds)}
        onMoveEnd={(_, next) => saveViewport(next)}
        defaultViewport={viewport}
        nodesDraggable={!readOnly}
        nodesConnectable={false}
        edgesReconnectable={false}
        elementsSelectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        deleteKeyCode={null}
        fitView={!viewport}
        fitViewOptions={fitOptions}
        minZoom={0.25}
        maxZoom={2}
      >
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
    </div>
  );
}

export function Board(props: BoardProps) {
  const {
    snapshot, activeParentId, selectedIds, readOnly, selectBox, openBox, beginMoveBox, moveBox, inspectConnector, addBox, changeKinds, connectorChangeKinds, nestedChangeCounts,
  } = props;
  const model = useMemo(() => buildModel({
    snapshot, activeParentId, selectedIds, readOnly, selectBox, openBox, moveBox, inspectConnector, changeKinds, connectorChangeKinds, nestedChangeCounts,
  }), [snapshot, activeParentId, selectedIds, readOnly, selectBox, openBox, moveBox, inspectConnector, changeKinds, connectorChangeKinds, nestedChangeCounts]);
  const viewports = useRef(new Map<string | null, Viewport>());
  const titles = new Map(model.nodes.map(({ id, data }) => [id, data.box.title]));

  return (
    <div className={`board${activeParentId ? " board--nested" : ""}`} role="group" aria-label="Canvas map">
      {model.nodes.length > 0 ? (
        <>
          <FlowCanvas
            key={activeParentId ?? "__root__"}
            model={model}
            viewport={viewports.current.get(activeParentId)}
            saveViewport={(viewport) => viewports.current.set(activeParentId, viewport)}
            readOnly={readOnly}
            beginMoveBox={beginMoveBox}
            moveBox={moveBox}
          />
          <div className="board__list" aria-label="Canvas boxes and connections">
            {model.nodes.map(({ id, data }) => <StoryCard key={id} data={data} />)}
            {model.edges.length > 0 && (
              <section className="board__relations" aria-label="Connections">
                <h3>Connections</h3>
                {model.edges.map(({ id, source, target, data }) => data && (
                  <button key={id} type="button" aria-label={data.accessibleLabel} aria-description={data.changeLabel} onClick={() => data.inspect(data.connectorIds)}>
                    {titles.get(source)} <span className="board__relation-label" data-connector-kind={data.projected ? "projected" : "solid"}>{data.label} →</span> {titles.get(target)}
                    {data.changeLabel && <span className="story-wire__change" data-change={data.change}>{data.changeLabel}</span>}
                  </button>
                ))}
              </section>
            )}
          </div>
          {model.edges.some(({ data }) => data?.projected) && (
            <span className="board__legend"><span aria-hidden="true" /> Connects inside a box</span>
          )}
        </>
      ) : (
        <div className="board__empty">
          <span className="board__empty-icon" aria-hidden="true"><i /><i /><i /></span>
          <h2>{activeParentId ? "No boxes inside yet" : "Start your story"}</h2>
          {!readOnly && addBox && (
            <button className="button-primary" type="button" onClick={addBox}>Add a box</button>
          )}
        </div>
      )}
    </div>
  );
}
