import { memo, useCallback, useEffect, useState } from 'react'
import { chipView } from '../lib/liveLink'
import { EMPTY_LINKS, liveChipSig, useWatchLinks } from '../state/watchLinks'
import { LiveLinkPopover, type PopoverAnchor } from './LiveLinkPopover'

/**
 * "This terminal is being broadcast." ONE component on the canvas node header, the kanban card, the
 * card modal header and the sessions sidebar row, so one session seen four times speaks with one
 * voice (CONTRIBUTING: the canvas and the board are two views of the same nodes). It is deliberately
 * NOT user-hideable (lib/live-link.guard.test.ts): it is the owner's signal that someone may be
 * watching this terminal right now.
 *
 * It subscribes to a PRIMITIVE signature of its own node's links (`liveChipSig`), never to a map,
 * so a push about another node's link — or any hook event — re-renders nothing here.
 */
export const LiveLinkChip = memo(function LiveLinkChip({
  nodeId,
  className
}: {
  nodeId: string
  className?: string
}): React.JSX.Element | null {
  const sig = useWatchLinks((s) => liveChipSig(s, nodeId))
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null)
  const close = useCallback(() => setAnchor(null), [])
  // The last link went away while the popover was open: forget it was open, or the NEXT link on
  // this node would bring the popover back by itself.
  useEffect(() => {
    if (!sig) setAnchor(null)
  }, [sig])
  if (!sig) return null
  const s = useWatchLinks.getState()
  const links = s.byNode[nodeId] ?? EMPTY_LINKS
  const view = chipView(links)
  const unread = links.reduce((n, l) => n + (s.unread[l.linkId] ?? 0), 0)
  const stop = (e: React.SyntheticEvent): void => e.stopPropagation()
  return (
    // The chip sits INSIDE a clickable card, a draggable node header and a sessions row that
    // closes on a middle click, and the popover is a body portal whose React events still bubble
    // through this tree. Every event is stopped here, or a click in the popover would also open the
    // card, a middle click would end the session, and a text drag would start a card drag.
    <span
      className="live-chip-wrap"
      onClick={stop}
      onDoubleClick={stop}
      onMouseDown={stop}
      onMouseUp={stop}
      onPointerDown={stop}
      onPointerUp={stop}
      onContextMenu={stop}
      onKeyDown={stop}
      onKeyUp={stop}
      onDragStart={stop}
      onDragOver={stop}
      onDrop={stop}
      onWheel={stop}
    >
      <button
        type="button"
        className={`live-chip live-chip--${view.tone} nodrag${className ? ` ${className}` : ''}`}
        title={view.title}
        aria-label={unread > 0 ? `${view.label}, ${unread} unread chat ${unread === 1 ? 'message' : 'messages'}` : view.label}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setAnchor((cur) => (cur ? null : { top: r.top, bottom: r.bottom, left: r.left }))
        }}
      >
        <span className="live-chip__dot" aria-hidden="true" />
        {view.label}
        {unread > 0 && <span className="live-chip__unread" aria-hidden="true" />}
      </button>
      {anchor && <LiveLinkPopover nodeId={nodeId} anchor={anchor} onClose={close} />}
    </span>
  )
})
