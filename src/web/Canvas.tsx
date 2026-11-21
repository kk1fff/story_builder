import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent, PointerEvent } from "react";
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
import { boxSizeLimits, getBoxSize, type Box, type StorySnapshot } from "../shared/story.js";
import { boxPath, boxTypeLabels, projectCanvas } from "./graph.js";

type ChangeKind = "added" | "removed" | "changed" | "moved";
type ConnectorChangeKind = Exclude<ChangeKind, "moved">;
type BoxSize = ReturnType<typeof getBoxSize>;

export type BoardProps = {
  snapshot: StorySnapshot;
  activeParentId: string | null;
  selectedIds: readonly string[] | ReadonlySet<string>;
  readOnly: boolean;
  revisionId?: string;
  revealBoxId?: string;
  onRevealBox?: (boxId: string) => void;
  selectBox: (boxId: string, extend: boolean) => void;
  openBox: (boxId: string) => void;
  beginMoveBox?: (boxId: string) => void;
  moveBox: (boxId: string, position: XYPosition) => void;
  resizeBox?: (boxId: string, size: BoxSize, revisionId: string) => Promise<unknown>;
  focusSize?: (boxId: string) => void;
  connectBox?: (sourceId: string, targetId?: string, revisionId?: string) => void;
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
  editable: boolean;
  minHeight: number;
  connectionTarget?: "eligible" | "current";
  derivedResult: boolean;
  change?: ChangeKind;
  nestedChanges?: number;
  selectBox: BoardProps["selectBox"];
  openBox: BoardProps["openBox"];
  connectBox?: BoardProps["connectBox"];
  focusSize?: BoardProps["focusSize"];
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
  const {
    box, childCount, selected, editable, minHeight, boundaryPath, derivedResult, change, nestedChanges,
    connectionTarget, selectBox, openBox, connectBox, focusSize,
  } = data;
  const cardClass = [
    "story-card",
    boundaryPath && "story-card--boundary",
    selected && "story-card--selected",
    connectionTarget === "eligible" && "story-card--connect-eligible",
    connectionTarget === "current" && "story-card--connect-target",
  ].filter(Boolean).join(" ");
  const select = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    selectBox(box.id, event.shiftKey);
  };
  return (
    <article
      className={cardClass}
      data-box-id={graph ? box.id : undefined}
      data-list-box-id={graph ? undefined : box.id}
      data-box-type={box.type}
      data-change={change}
      style={graph ? { minHeight } : undefined}
    >
      {graph && portSides.map((side) => (
        <Handle key={`source-${side}`} id={`source-${side}`} type="source" position={side} isConnectable={false} />
      ))}
      {graph && portSides.map((side) => (
        <Handle key={`target-${side}`} id={`target-${side}`} type="target" position={side} isConnectable={false} />
      ))}
      {graph && editable && selected && connectBox && (
        <button
          type="button"
          className="react-flow__handle react-flow__handle-right story-card__connector nodrag nopan"
          data-canvas-tool="connect"
          aria-label={`Drag to connect from ${box.title}`}
          onClick={(event) => {
            event.stopPropagation();
            if (event.detail === 0) connectBox(box.id);
          }}
        />
      )}
      {graph && editable && selected && focusSize && (
        <button
          type="button"
          className="story-card__resize nodrag nopan"
          data-canvas-tool="resize"
          aria-label={`Resize ${box.title}`}
          onClick={(event) => {
            event.stopPropagation();
            if (event.detail === 0) focusSize(box.id);
          }}
        />
      )}
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
        <div className="story-card__footer-actions">
          {selected && editable && connectBox && (
            <button
              type="button"
              className="story-card__connect nodrag nopan"
              aria-label={`Connect from ${box.title}`}
              onClick={(event) => { event.stopPropagation(); connectBox(box.id); }}
            >Connect</button>
          )}
          <button
            className="story-card__open nodrag"
            type="button"
            aria-label={`Open ${box.title}`}
            onClick={(event) => { event.stopPropagation(); openBox(box.id); }}
          >
            Open <span aria-hidden="true">↗</span>
          </button>
        </div>
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
  const { snapshot, activeParentId, selectedIds, readOnly, selectBox, openBox, inspectConnector, connectBox, focusSize, changeKinds, connectorChangeKinds, nestedChangeCounts } = props;
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
      box, boundaryPath, selectBox, openBox, connectBox, focusSize,
      minHeight: getBoxSize(box).minHeight,
      editable: !readOnly && !boundaryPath,
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
    width: getBoxSize(box).width,
    draggable: !readOnly,
    data: card(box),
  }));
  const rightmost = boxes.reduce((x, box) => Math.max(x, box.x + getBoxSize(box).width), -Infinity);
  const topmost = boxes.reduce((y, box) => Math.min(y, box.y), Infinity);
  const portalX = boxes.length ? rightmost + 150 : 0;
  let portalY = boxes.length ? topmost : 0;
  portals.forEach(({ box, nodeId }) => {
    const ancestors = boxPath(snapshot, box.id).slice(0, -1).map(({ title }) => title);
    const { width, minHeight } = getBoxSize(box);
    nodes.push({
      id: nodeId,
      type: "story",
      position: { x: portalX, y: portalY },
      width,
      draggable: false,
      data: card(box, box.id === activeParentId
        ? "Containing box"
        : `Outside this box · ${["Main canvas", ...ancestors].join(" / ")}`),
    });
    portalY += Math.max(portalSpacing, minHeight + 56);
  });

  const nodePositions = new Map<string, XYPosition>(nodes.map(({ id, position, width, data }) => [
    id, { x: position.x + (width ?? getBoxSize(data.box).width) / 2, y: position.y + data.minHeight / 2 },
  ]));
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

type ConnectPreview = {
  sourceId: string;
  targetId?: string;
  from: XYPosition;
  to: XYPosition;
};

type SizePreview = { boxId: string; size: BoxSize };
type PointerDrag = {
  handle: HTMLButtonElement;
  card: HTMLElement;
  pointerId: number;
  boxId: string;
  revisionId: string;
} & ({
  kind: "connect";
} | {
  kind: "resize";
  start: XYPosition;
  zoom: number;
  originalSize: BoxSize;
  renderedHeight: number;
});

function adjustedSize(drag: Extract<PointerDrag, { kind: "resize" }>, { clientX, clientY }: PointerEvent): BoxSize {
  const deltaX = Math.round((clientX - drag.start.x) / drag.zoom);
  const deltaY = Math.round((clientY - drag.start.y) / drag.zoom);
  const { minWidth, maxWidth, minHeight, maxHeight } = boxSizeLimits;
  return {
    width: Math.min(maxWidth, Math.max(minWidth, drag.originalSize.width + deltaX)),
    minHeight: deltaY === 0
      ? drag.originalSize.minHeight
      : Math.min(maxHeight, Math.max(minHeight, Math.round(drag.renderedHeight + deltaY))),
  };
}

function releasePointer(drag: PointerDrag) {
  if (drag.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
}

function FlowCanvas({
  model, viewport, saveViewport, readOnly, revisionId, beginMoveBox, moveBox, resizeBox, connectBox,
}: {
  model: ReturnType<typeof buildModel>;
  viewport: Viewport | undefined;
  saveViewport: (viewport: Viewport) => void;
  readOnly: boolean;
  revisionId?: string;
  beginMoveBox?: BoardProps["beginMoveBox"];
  moveBox: BoardProps["moveBox"];
  resizeBox?: BoardProps["resizeBox"];
  connectBox?: BoardProps["connectBox"];
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState(model.nodes);
  const [wire, setWire] = useState<ConnectPreview | null>(null);
  const [resize, setResize] = useState<SizePreview | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const flow = useRef<ReactFlowInstance<CanvasNode, CanvasEdge> | null>(null);
  const dragRef = useRef<PointerDrag | null>(null);
  const selectedId = model.nodes.find((node) => node.data.selected && !node.data.boundaryPath)?.id;

  function targetAt(drag: PointerDrag, { clientX, clientY }: PointerEvent) {
    const card = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-box-id]");
    const boxId = card?.dataset.boxId;
    return card && boxId && boxId !== drag.boxId && container.current?.contains(card) ? boxId : undefined;
  }

  function drawWire(drag: PointerDrag, event: PointerEvent) {
    const containerBounds = container.current!.getBoundingClientRect();
    const handle = drag.handle.getBoundingClientRect();
    setWire({
      sourceId: drag.boxId,
      targetId: targetAt(drag, event),
      from: { x: handle.left + handle.width / 2 - containerBounds.left, y: handle.top + handle.height / 2 - containerBounds.top },
      to: { x: event.clientX - containerBounds.left, y: event.clientY - containerBounds.top },
    });
  }

  function startPointer(event: PointerEvent<HTMLDivElement>) {
    if (readOnly || !revisionId || dragRef.current || !event.isPrimary || event.button !== 0 || !(event.target instanceof Element)) return;
    const handle = event.target.closest<HTMLButtonElement>("button[data-canvas-tool]");
    const card = handle?.closest<HTMLElement>("[data-box-id]");
    const boxId = card?.dataset.boxId;
    if (!handle || !card || !boxId) return;
    const node = model.nodes.find((entry) => entry.id === boxId);
    if (!node?.data.editable || !node.data.selected) return;

    let drag: PointerDrag;
    if (handle.dataset.canvasTool === "connect" && connectBox) {
      drag = { kind: "connect", handle, card, boxId, revisionId, pointerId: event.pointerId };
    } else if (handle.dataset.canvasTool === "resize" && resizeBox) {
      const zoom = flow.current?.getZoom() ?? 1;
      drag = {
        kind: "resize", handle, card, boxId, pointerId: event.pointerId, revisionId, zoom,
        start: { x: event.clientX, y: event.clientY },
        originalSize: getBoxSize(node.data.box),
        renderedHeight: card.getBoundingClientRect().height / zoom,
      };
    } else return;

    event.preventDefault();
    event.stopPropagation();
    handle.setPointerCapture(event.pointerId);
    dragRef.current = drag;
    if (drag.kind === "connect") drawWire(drag, event);
  }

  function movePointer(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.stopPropagation();
    if (drag.kind === "connect") drawWire(drag, event);
    else setResize({ boxId: drag.boxId, size: adjustedSize(drag, event) });
  }

  function finishPointer(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.stopPropagation();
    dragRef.current = null;
    releasePointer(drag);
    if (drag.kind === "connect") {
      const targetId = targetAt(drag, event);
      setWire(null);
      drag.card.querySelector<HTMLButtonElement>(".story-card__connect, .story-card__title")?.focus({ preventScroll: true });
      if (targetId) connectBox?.(drag.boxId, targetId, drag.revisionId);
      return;
    }
    const size = adjustedSize(drag, event);
    if (size.width === drag.originalSize.width && size.minHeight === drag.originalSize.minHeight) {
      setResize(null);
      return;
    }
    const preview = { boxId: drag.boxId, size };
    setResize(preview);
    const saved = resizeBox?.(drag.boxId, size, drag.revisionId);
    if (saved) void saved.finally(() => setResize((current) => current === preview ? null : current));
  }

  function cancelPointer(pointerId: number) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    dragRef.current = null;
    releasePointer(drag);
    setWire(null);
    setResize(null);
    drag.card.querySelector<HTMLButtonElement>(".story-card__title")?.focus({ preventScroll: true });
  }

  useEffect(() => {
    function escape(event: KeyboardEvent) {
      const drag = dragRef.current;
      if (event.key !== "Escape" || !drag) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelPointer(drag.pointerId);
    }
    function cancel(event: globalThis.PointerEvent) {
      cancelPointer(event.pointerId);
    }
    function finishOutside(event: globalThis.PointerEvent) {
      if (!(event.target instanceof Node) || !container.current?.contains(event.target)) cancel(event);
    }
    window.addEventListener("keydown", escape, true);
    window.addEventListener("lostpointercapture", cancel, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("pointerup", finishOutside, true);
    return () => {
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("lostpointercapture", cancel, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("pointerup", finishOutside, true);
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag) releasePointer(drag);
    };
  }, []);

  useEffect(() => {
    const drag = dragRef.current;
    if (!drag) return;
    const source = model.nodes.find((node) => node.id === drag.boxId)?.data;
    if (readOnly || !source?.editable || !source.selected || !drag.handle.isConnected) {
      cancelPointer(drag.pointerId);
    }
  }, [model.nodes, readOnly]);

  useEffect(() => {
    if (!container.current) return;
    let previousWidth = 0;
    let scheduled = 0;
    const resize = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      if (width === 0) return;
      if (previousWidth && Math.abs(width - previousWidth) > 40) {
        cancelAnimationFrame(scheduled);
        scheduled = requestAnimationFrame(() => { if (!dragRef.current) void flow.current?.fitView(fitOptions); });
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
      const existing = new Map(previous.map((node) => [node.id, node]));
      return model.nodes.map((node) => {
        const current = existing.get(node.id);
        return {
          ...node,
          measured: current?.measured,
          ...(current?.dragging && { position: current.position, dragging: true }),
        };
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
      const width = measured?.width ?? getBoxSize(selected.data.box).width;
      const height = measured?.height ?? getBoxSize(selected.data.box).minHeight;
      const left = position.x * zoom + x;
      const top = position.y * zoom + y;
      if (left < 0 || top < 0 || left + width * zoom > canvas.clientWidth || top + height * zoom > canvas.clientHeight) {
        void instance.setCenter(position.x + width / 2, position.y + height / 2, { zoom });
      }
    });
    return () => cancelAnimationFrame(scheduled);
  }, [selectedId]);

  const shown = useMemo(() => {
    if (!resize && !wire) return nodes;
    return nodes.map((node) => {
      const size = resize?.boxId === node.id ? resize.size : undefined;
      const target = wire && wire.sourceId !== node.data.box.id
        ? wire.targetId === node.data.box.id ? "current" : "eligible"
        : undefined;
      return {
        ...node,
        width: size?.width ?? node.width,
        data: { ...node.data, minHeight: size?.minHeight ?? node.data.minHeight, connectionTarget: target },
      } satisfies CanvasNode;
    });
  }, [nodes, resize, wire]);

  return (
    <div
      className="board__flow"
      ref={container}
      onPointerDownCapture={startPointer}
      onPointerMove={movePointer}
      onPointerUp={finishPointer}
    >
      <ReactFlow
        nodes={shown}
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
      {wire && (
        <svg className="board__connector-preview" aria-hidden="true">
          <path
            className="react-flow__connection-path"
            fill="none"
            d={`M ${wire.from.x} ${wire.from.y} C ${wire.from.x + 50} ${wire.from.y}, ${wire.to.x - 40} ${wire.to.y}, ${wire.to.x} ${wire.to.y}`}
          />
        </svg>
      )}
    </div>
  );
}

export function Board(props: BoardProps) {
  const {
    snapshot, activeParentId, selectedIds, readOnly, revisionId, revealBoxId, onRevealBox,
    selectBox, openBox, beginMoveBox, moveBox, resizeBox, focusSize, connectBox, inspectConnector, addBox,
    changeKinds, connectorChangeKinds, nestedChangeCounts,
  } = props;
  const model = useMemo(() => buildModel({
    snapshot, activeParentId, selectedIds, readOnly, selectBox, openBox, moveBox, focusSize, connectBox,
    inspectConnector, changeKinds, connectorChangeKinds, nestedChangeCounts,
  }), [snapshot, activeParentId, selectedIds, readOnly, selectBox, openBox, moveBox, focusSize, connectBox,
    inspectConnector, changeKinds, connectorChangeKinds, nestedChangeCounts]);
  const viewports = useRef(new Map<string | null, Viewport>());
  const board = useRef<HTMLDivElement>(null);
  const titles = new Map(model.nodes.map(({ id, data }) => [id, data.box.title]));

  useEffect(() => {
    if (!revealBoxId || snapshot.boxes[revealBoxId]?.parentId !== activeParentId) return;
    let frame: number;
    let tries = 0;
    let focused: HTMLElement | undefined;
    const boxId = revealBoxId;
    const id = CSS.escape(revealBoxId);
    function reveal() {
      const buttons = board.current?.querySelectorAll<HTMLElement>(
        `[data-box-id="${id}"] .story-card__title, [data-list-box-id="${id}"] .story-card__title`,
      );
      const button = buttons && [...buttons].find((candidate) =>
        candidate.getClientRects().length > 0 && getComputedStyle(candidate).visibility === "visible");
      if (button && document.activeElement === button && focused === button) {
        onRevealBox?.(boxId);
        return;
      }
      if (button && document.activeElement !== button) {
        button.focus({ preventScroll: Boolean(button.closest("[data-box-id]")) });
      }
      focused = button;
      if (++tries < 30) frame = requestAnimationFrame(reveal);
    }
    frame = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(frame);
  }, [activeParentId, onRevealBox, revealBoxId, snapshot]);

  return (
    <div className={`board${activeParentId ? " board--nested" : ""}`} ref={board} role="group" aria-label="Canvas map">
      {model.nodes.length > 0 ? (
        <>
          <FlowCanvas
            key={activeParentId ?? "__root__"}
            model={model}
            viewport={viewports.current.get(activeParentId)}
            saveViewport={(viewport) => viewports.current.set(activeParentId, viewport)}
            readOnly={readOnly}
            revisionId={revisionId}
            beginMoveBox={beginMoveBox}
            moveBox={moveBox}
            resizeBox={resizeBox}
            connectBox={connectBox}
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
