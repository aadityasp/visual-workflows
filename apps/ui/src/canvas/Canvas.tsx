/**
 * The workflow canvas (docs/UI_SPEC.md "Canvas & layout"). React Flow with
 * custom AgentPanel nodes and FlowEdges. Positions come from the dagre LR
 * layout; dragging a panel pins it. The camera refits on topology change
 * only when the user hasn't touched the viewport for 10s (never fight the
 * user), follows the most recent agent in follow mode, and answers explicit
 * fit/center intents from the ui store.
 */
import { useCallback, useEffect, useRef } from 'react';
import {
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import type {
  Edge,
  Node,
  NodeChange,
  NodeMouseHandler,
  NodeProps,
  OnNodeDrag,
} from '@xyflow/react';
import { AgentPanelNode } from './AgentPanelNode';
import { FlowEdge } from './FlowEdge';
import { buildGraph, nodeHeight, topologySignature } from './graph';
import type { PhaseBandData } from './graph';
import { PANEL_W } from './layout';
import { lifecycleColor } from './status';
import { useWorkspace } from '../store/workspace';
import { useUi, agentCollapsed } from '../store/ui';
import { useReducedMotion } from '../app/hooks';
import { activeSession, latestActiveAgentId } from '../store/selectors';
import type { XY } from './layout';

function PhaseBandNodeImpl({ data }: NodeProps) {
  const { title } = data as PhaseBandData;
  return (
    <div className="vw-phase-band-node">
      <span>{title}</span>
    </div>
  );
}

const nodeTypes = { agentPanel: AgentPanelNode, phaseBand: PhaseBandNodeImpl };
const edgeTypes = { flowEdge: FlowEdge };
const IDLE_MS = 10_000;
/**
 * A change in node count this large counts as a material topology change: the
 * graph's footprint moved enough that we refit even if the user recently
 * touched the camera (e.g. a fan-out of many new agents that overflows the
 * viewport). Smaller drifts respect the "never fight the user" idle guard.
 */
const MATERIAL_NODE_DELTA = 6;

function CanvasInner() {
  const rf = useReactFlow();
  const reduced = useReducedMotion();
  const sessionId = useUi((s) => s.activeSessionId);
  const viewMode = useUi((s) => s.viewMode);
  const minimapVisible = useUi((s) => s.minimapVisible);
  const fitNonce = useUi((s) => s.fitNonce);
  const centerNonce = useUi((s) => s.centerNonce);
  const select = useUi((s) => s.select);
  const setFocus = useUi((s) => s.setFocus);

  const collapsedMap = useUi((s) => s.collapsed);
  const replayRecordingId = useUi((s) => s.replay.recordingId);
  const signature = useWorkspace((s) => topologySignature(activeSession(s.state, sessionId)));
  const latestActive = useWorkspace((s) => latestActiveAgentId(activeSession(s.state, sessionId)));

  const [nodes, setNodes, onNodesChangeBase] = useNodesState<Node>([]);
  const [edges, setEdges] = useEdgesState<Edge>([]);

  const pinnedRef = useRef<Map<string, XY>>(new Map());
  const lastUserMove = useRef(0);
  const hasFit = useRef(false);
  const lastFitCount = useRef(0);
  const dur = reduced ? 0 : 400;

  // Switching session/recording is a clean slate: drop pins/camera memory from
  // the previous graph (agent ids like 'main' recur across sessions) and refit.
  // The topology effect below rebuilds nodes with the cleared pins next.
  useEffect(() => {
    pinnedRef.current.clear();
    hasFit.current = false;
    lastFitCount.current = 0;
    lastUserMove.current = 0;
  }, [sessionId, replayRecordingId]);

  // Rebuild nodes/edges only when the graph's shape changes (topology sig).
  useEffect(() => {
    const session = sessionId ? useWorkspace.getState().state.sessions[sessionId] : undefined;
    if (!session || !sessionId) {
      setNodes([]);
      setEdges([]);
      return;
    }
    const built = buildGraph(session, sessionId, pinnedRef.current, collapsedMap);
    setNodes(built.nodes);
    setEdges(built.edges);
  }, [signature, sessionId, collapsedMap, setNodes, setEdges]);

  const onNodesChange = useCallback(
    (changes: NodeChange<Node>[]) => {
      for (const ch of changes) {
        if (ch.type === 'position' && ch.dragging === false && ch.position) {
          pinnedRef.current.set(ch.id, ch.position);
        }
      }
      onNodesChangeBase(changes);
    },
    [onNodesChangeBase],
  );

  const onNodeDragStop = useCallback<OnNodeDrag<Node>>(
    (_e, node) => {
      pinnedRef.current.set(node.id, node.position);
      setNodes((ns) =>
        ns.map((n) =>
          n.id === node.id && n.type === 'agentPanel'
            ? { ...n, data: { ...n.data, pinned: true } }
            : n,
        ),
      );
    },
    [setNodes],
  );

  const onMoveStart = useCallback((event: unknown) => {
    if (event) lastUserMove.current = Date.now();
  }, []);

  const resetLayout = useCallback(() => {
    pinnedRef.current.clear();
    lastUserMove.current = 0;
    // Rebuild from the auto-layout so the pinned flags clear and nodes reflow.
    const session = sessionId ? useWorkspace.getState().state.sessions[sessionId] : undefined;
    if (session && sessionId) {
      const built = buildGraph(session, sessionId, pinnedRef.current, useUi.getState().collapsed);
      setNodes(built.nodes);
      setEdges(built.edges);
    }
    useUi.getState().requestFit();
  }, [sessionId, setNodes, setEdges]);

  const onNodeClick = useCallback<NodeMouseHandler>(
    (_e, node) => {
      if (node.type === 'agentPanel') select(node.id);
    },
    [select],
  );

  const onNodeDoubleClick = useCallback<NodeMouseHandler>(
    (_e, node) => {
      if (node.type === 'agentPanel') setFocus(node.id);
    },
    [setFocus],
  );

  // Refit on the first layout, on a material topology change (node count moved a
  // lot — the graph likely no longer fits), or when the user has been idle for a
  // while. A material change overrides the idle guard on purpose: a burst of new
  // agents should always be reframed, or the graph runs off-screen.
  useEffect(() => {
    if (nodes.length === 0) return undefined;
    const idle = Date.now() - lastUserMove.current > IDLE_MS;
    const material = Math.abs(nodes.length - lastFitCount.current) >= MATERIAL_NODE_DELTA;
    if (!hasFit.current || material || idle) {
      hasFit.current = true;
      lastFitCount.current = nodes.length;
      const id = requestAnimationFrame(() => rf.fitView({ duration: dur, padding: 0.2 }));
      return () => cancelAnimationFrame(id);
    }
    return undefined;
  }, [signature, sessionId, nodes.length, rf, dur]);

  // Explicit "fit" intent (o key, empty-state, reset layout).
  useEffect(() => {
    if (fitNonce === 0) return;
    lastUserMove.current = 0;
    rf.fitView({ duration: dur, padding: 0.2 });
  }, [fitNonce, rf, dur]);

  // Explicit "center this agent" intent (attention rail).
  useEffect(() => {
    if (centerNonce === 0) return;
    const id = useUi.getState().centerAgentId;
    if (!id) return;
    const node = rf.getNode(id);
    if (!node) return;
    const lc =
      useWorkspace.getState().state.sessions[sessionId ?? '']?.agents[id]?.lifecycle ?? 'running';
    const h = nodeHeight(agentCollapsed(useUi.getState().collapsed, id, lc));
    rf.setCenter(node.position.x + PANEL_W / 2, node.position.y + h / 2, {
      zoom: 1,
      duration: dur,
    });
  }, [centerNonce, rf, sessionId, dur]);

  // Follow mode: gently track the most recently active agent.
  useEffect(() => {
    if (viewMode !== 'follow' || !latestActive) return;
    const node = rf.getNode(latestActive);
    if (!node) return;
    // xyflow v12 exposes the measured size as node.measured, not node.height;
    // fall back to the layout height so 56px chips center correctly.
    const lc =
      useWorkspace.getState().state.sessions[sessionId ?? '']?.agents[latestActive]?.lifecycle ??
      'running';
    const h =
      node.measured?.height ??
      nodeHeight(agentCollapsed(useUi.getState().collapsed, latestActive, lc));
    rf.setCenter(node.position.x + PANEL_W / 2, node.position.y + h / 2, {
      zoom: 1,
      duration: dur,
    });
  }, [viewMode, latestActive, rf, sessionId, dur]);

  const minimapColor = useCallback(
    (node: Node) => {
      if (node.type === 'phaseBand') return 'transparent';
      const lc =
        useWorkspace.getState().state.sessions[sessionId ?? '']?.agents[node.id]?.lifecycle;
      return lifecycleColor(lc);
    },
    [sessionId],
  );

  // Derived from node data (set on drag-stop, cleared by rebuild) — no extra state.
  const hasPins = nodes.some((n) => n.type === 'agentPanel' && Boolean(n.data?.pinned));

  return (
    <ReactFlow
      className="vw-flow"
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStop={onNodeDragStop}
      onNodeClick={onNodeClick}
      onNodeDoubleClick={onNodeDoubleClick}
      onMoveStart={onMoveStart}
      onlyRenderVisibleElements
      minZoom={0.2}
      maxZoom={1.8}
      proOptions={{ hideAttribution: true }}
      nodesConnectable={false}
      elementsSelectable
      fitView
    >
      <Background variant={BackgroundVariant.Dots} gap={26} size={1} color="var(--vw-hairline)" />
      {minimapVisible ? (
        <MiniMap
          pannable
          zoomable
          nodeColor={minimapColor}
          nodeStrokeWidth={0}
          ariaLabel="Workflow minimap"
        />
      ) : null}
      {hasPins ? (
        <Panel position="top-left">
          <button className="vw-btn" onClick={resetLayout}>
            Reset layout
          </button>
        </Panel>
      ) : null}
    </ReactFlow>
  );
}

export function Canvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}
