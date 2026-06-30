'use client';

import { useMemo } from 'react';
import {
  ReactFlow, Background, Controls, Handle, Position, MarkerType,
  type Node, type Edge, type Connection, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { BranchGraph } from 'shared/src/generated/client-v1';

// n8n-style visual map (Phase 3). Nodes are sequences; edges are 'sequence' choices.
// Dragging a node persists its position; connecting two nodes creates a choice edge.
// Non-sequence destinations (back/restart/end/external) are listed inside the node.

type SeqNodeData = {
  label: string;
  isEntry: boolean;
  clipCount: number;
  choiceCount: number;
  terminals: string[];
};

function SequenceNode({ data }: NodeProps) {
  const d = data as SeqNodeData;
  return (
    <div className={`rounded-lg border bg-card px-3 py-2 text-xs shadow-sm ${d.isEntry ? 'border-cyan-500' : 'border-border'}`} style={{ minWidth: 160 }}>
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-1.5">
        {d.isEntry && <span className="rounded bg-cyan-100 px-1 text-[9px] font-bold uppercase text-cyan-700">Start</span>}
        <span className="truncate font-semibold">{d.label}</span>
      </div>
      <div className="mt-1 text-[10px] text-muted-foreground">{d.clipCount} clip{d.clipCount === 1 ? '' : 's'} · {d.choiceCount} choice{d.choiceCount === 1 ? '' : 's'}</div>
      {d.terminals.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {d.terminals.map((t, i) => <span key={i} className="rounded bg-muted px-1 text-[9px] text-muted-foreground">{t}</span>)}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { sequence: SequenceNode };

const TERMINAL_LABEL: Record<string, string> = {
  back: 'Back', restart: 'Restart', end: 'End', external_url: 'Link', project: 'Project', playlist: 'Playlist', simulation_full: 'Simulation', quiz: 'Quiz',
};

export function BranchGraphView({
  graph,
  onMoveNode,
  onConnectSequences,
  onSelectNode,
}: {
  graph: BranchGraph;
  onMoveNode: (sequenceId: string, x: number, y: number) => void;
  onConnectSequences: (sourceSequenceId: string, targetSequenceId: string) => void;
  onSelectNode: (sequenceId: string) => void;
}) {
  const { nodes, edges } = useMemo(() => {
    const cpSeq = new Map<string, string>();  // choice_point_id -> sequence_id
    for (const cp of graph.choice_points) cpSeq.set(cp.id, cp.sequence_id);
    const clipCountBySeq = new Map<string, number>();
    for (const v of graph.videos) if (v.sequence_id) clipCountBySeq.set(v.sequence_id, (clipCountBySeq.get(v.sequence_id) ?? 0) + 1);

    const terminalsBySeq = new Map<string, string[]>();
    const choiceCountBySeq = new Map<string, number>();
    const flowEdges: Edge[] = [];
    for (const e of graph.edges) {
      const sourceSeq = e.choice_point_id ? cpSeq.get(e.choice_point_id) : undefined;
      if (!sourceSeq) continue;
      choiceCountBySeq.set(sourceSeq, (choiceCountBySeq.get(sourceSeq) ?? 0) + 1);
      if (e.destination_type === 'sequence' && e.dest_sequence_id) {
        flowEdges.push({
          id: e.id,
          source: sourceSeq,
          target: e.dest_sequence_id,
          label: e.label ?? '',
          markerEnd: { type: MarkerType.ArrowClosed },
        });
      } else {
        const list = terminalsBySeq.get(sourceSeq) ?? [];
        list.push(TERMINAL_LABEL[e.destination_type] ?? e.destination_type);
        terminalsBySeq.set(sourceSeq, list);
      }
    }

    const flowNodes: Node[] = graph.sequences.map((s, i) => ({
      id: s.id,
      type: 'sequence',
      position: (s.graph_x || s.graph_y) ? { x: s.graph_x, y: s.graph_y } : { x: i * 240, y: 80 },
      data: {
        label: s.label,
        isEntry: s.is_entry,
        clipCount: clipCountBySeq.get(s.id) ?? 0,
        choiceCount: choiceCountBySeq.get(s.id) ?? 0,
        terminals: terminalsBySeq.get(s.id) ?? [],
      } satisfies SeqNodeData,
    }));

    return { nodes: flowNodes, edges: flowEdges };
  }, [graph]);

  return (
    <div className="h-full min-h-[420px] overflow-hidden rounded-xl border border-border bg-card shadow-sm-soft">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        onNodeDragStop={(_e, node) => onMoveNode(node.id, Math.round(node.position.x), Math.round(node.position.y))}
        onNodeClick={(_e, node) => onSelectNode(node.id)}
        onConnect={(c: Connection) => { if (c.source && c.target && c.source !== c.target) onConnectSequences(c.source, c.target); }}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
