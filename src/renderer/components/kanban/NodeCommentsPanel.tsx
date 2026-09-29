import { useMemo } from 'react'
import { useStore } from '@xyflow/react'
import { mentionCandidatesFromNodes } from '../../lib/boardMentions'
import type { CanvasNode } from '../../state/workspace'
import { BoardLogPanel } from './BoardLogPanel'

/**
 * The canvas node's comments flyout: the same `BoardLogPanel` the card modal shows, with the same
 * @mention candidates — the agent sessions on this canvas, built through the board's own mapping.
 * Mounted only while the flyout is open, and it re-renders only when that candidate list changes
 * (the selector returns a string), not on every drag frame's new node array.
 */
export function NodeCommentsPanel({ id }: { id: string }) {
  const signature = useStore((s) =>
    JSON.stringify(mentionCandidatesFromNodes(s.nodes as unknown as CanvasNode[]))
  )
  const mentionables = useMemo(
    () => JSON.parse(signature) as ReturnType<typeof mentionCandidatesFromNodes>,
    [signature]
  )
  return <BoardLogPanel card={{ id }} mentionables={mentionables} />
}
