import { useLayoutEffect, useRef, useState } from 'react';
import type { Node, XYPosition } from '@xyflow/react';

const DURATION = 320;
const positionKey = (nodes: Node[]) => JSON.stringify(nodes.map(node => [node.id, node.position.x, node.position.y]));

// Animate graph coordinates, not DOM transforms: React Flow keeps the edges and
// controls attached throughout insertion. Polls and ordinary card expansion do
// not start animations. Measurements arriving during insertion retarget it.
export function usePipelineLayout<T extends Node>(nodes: T[], invitationId: string): T[] {
  const [positions, setPositions] = useState(() => new Map(nodes.map(node => [node.id, node.position])));
  const [entering, setEntering] = useState<Set<string>>(() => new Set());
  const shown = useRef(positions), previousIds = useRef(nodes.map(node => node.id).join('|'));
  const deadline = useRef(0);
  const target = useRef(nodes);
  target.current = nodes;
  const key = positionKey(nodes);

  useLayoutEffect(() => {
    const nodes = target.current;
    const next = new Map(nodes.map(node => [node.id, node.position]));
    const ids = nodes.map(node => node.id).join('|');
    const changed = previousIds.current !== ids;
    previousIds.current = ids;
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    const now = performance.now();
    if (changed && shown.current.size) deadline.current = now + DURATION;
    const finish = () => { shown.current = next; setPositions(next); setEntering(new Set()); deadline.current = 0; };
    if (preference.matches || now >= deadline.current) { finish(); return; }

    const added = nodes.filter(node => !shown.current.has(node.id));
    if (changed) setEntering(new Set(added.map(node => node.id)));
    const start = new Map(nodes.map(node => [node.id, shown.current.get(node.id)
      ?? (added.length === 1 ? shown.current.get(invitationId) : undefined) ?? node.position]));
    shown.current = start;
    setPositions(start);
    const duration = deadline.current - now;
    let frame = 0;
    const tick = (time: number) => {
      const progress = Math.min(1, Math.max(0, (time - now) / duration));
      if (progress === 1) { finish(); return; }
      const eased = 1 - (1 - progress) ** 3;
      const moved = new Map<string, XYPosition>();
      for (const [id, to] of next) {
        const from = start.get(id)!;
        moved.set(id, { x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased });
      }
      shown.current = moved;
      setPositions(moved);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const reduce = () => { if (preference.matches) { cancelAnimationFrame(frame); finish(); } };
    preference.addEventListener('change', reduce);
    return () => { cancelAnimationFrame(frame); preference.removeEventListener('change', reduce); };
  }, [key, invitationId]);

  return nodes.map(node => ({ ...node, position: positions.get(node.id) ?? node.position,
    className: entering.has(node.id) ? `${node.className || ''} stage-inserting` : node.className }));
}
