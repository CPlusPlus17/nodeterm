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
    <>
      {/* The chip sits INSIDE a clickable card, a draggable node header and a sessions row that
          closes on a middle click, so its own click-related events stop here. Only those: keys, drags
          and the wheel pass, or with focus on the chip (where the popover hands it back) every global
          shortcut went dead, and a card dragged over another card's chip could not be dropped. The
          popover isolates ITS events at its own portal roots (LiveLinkPopover). */}
      <button
        type="button"
        className={`live-chip live-chip--${view.tone} nodrag${className ? ` ${className}` : ''}`}
        title={view.title}
        aria-label={unread > 0 ? `${view.label}, ${unread} unread chat ${unread === 1 ? 'message' : 'messages'}` : view.label}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        onMouseDown={stop}
        onPointerDown={stop}
        onDoubleClick={stop}
        onContextMenu={stop}
        onClick={(e) => {
          e.stopPropagation()
          const r = e.currentTarget.getBoundingClientRect()
          setAnchor((cur) => (cur ? null : { top: r.top, bottom: r.bottom, left: r.left }))
        }}
      >
        {/* The broadcast dot is the LIVE state's (spec: `● LIVE`); offline and refused carry none. */}
        {view.tone === 'live' && <span className="live-chip__dot" aria-hidden="true" />}
        {view.label}
        {unread > 0 && <span className="live-chip__unread" aria-hidden="true" />}
      </button>
      {anchor && <LiveLinkPopover nodeId={nodeId} anchor={anchor} onClose={close} />}
    </>
  )
})
