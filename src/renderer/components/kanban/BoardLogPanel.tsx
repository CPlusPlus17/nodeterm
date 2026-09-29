import { useEffect, useMemo, useState } from 'react'
import type { BoardLogEntry, BoardLogEvent } from '@shared/types'
import { formatTimeAgo } from '../../lib/usageFormat'
import { useSession } from '../../session/session'
import { useProjects } from '../../state/projects'
import { useBoardLog } from '../../state/boardLog'
import { collapseFeed } from '../../lib/boardLogCollapse'
import { stationTrigger } from '@shared/station-notice'
import type { KanbanSession } from './KanbanView'

interface BoardLogPanelProps {
  /** The card/node whose activity this panel shows — feed + composer are scoped to `card.id`.
   *  Only the id is needed, so the canvas node flyout can use this panel without building a
   *  full KanbanSession. A GitHub issue card passes its synthetic board-log id (`issueLogId`). */
  card: Pick<KanbanSession, 'id'>
  /** Panel heading. Defaults to the session card's "Comments & activity". */
  title?: string
  /** Hide the comment composer — the issue card's run history is read-only, because a comment box
   *  under a GitHub issue reads as "post to GitHub", and this log never leaves the project. */
  readOnly?: boolean
  /** Shown when the feed is empty (defaults to nothing). */
  emptyText?: string
}

/** The activity sentence WITHOUT the leading author name — the name is rendered separately in
 *  the author's color, so the feed reads like Trello (colored actor + muted action). column-*
 *  events carry no nodeId and so never reach a card-scoped feed; kept for completeness. */
export function eventBody(e: BoardLogEvent): string {
  switch (e.type) {
    case 'card-created':
      return `created this card in ${e.to ?? 'Ungrouped'}`
    case 'card-moved':
      // `title` is the reason when the board moved the card itself ("PR #12 merged").
      return `moved this card ${e.from ?? 'Ungrouped'} → ${e.to ?? 'Ungrouped'}${e.title ? ` (${e.title})` : ''}`
    case 'column-added':
      return `added column ${e.title ?? ''}`.trimEnd()
    case 'column-renamed':
      return `renamed column ${e.from ?? ''} → ${e.to ?? ''}`
    case 'column-deleted':
      return `deleted column ${e.title ?? ''}`.trimEnd()
    case 'member-assigned':
      return `assigned ${e.to ?? 'someone'}`
    case 'member-unassigned':
      return `removed ${e.to ?? 'someone'}`
    case 'due-set':
      return `set the due date → ${e.to ? formatStamp(Date.parse(e.to)) : ''}`.trimEnd()
    case 'due-cleared':
      return `removed the due date`
    case 'priority-set':
      return `set priority → ${e.to ?? ''}`.trimEnd()
    case 'priority-cleared':
      return `removed the priority`
    case 'agent-message':
      return `sent a message to ${e.to ?? 'another node'} (${e.title ?? 'unknown outcome'})`
    case 'agent-read-cookies':
      // A loud, human-visible line for a cookie read (the whole point of the trace). `from` names the
      // agent, `to` the domain it read; `title` names the browser node it drove.
      return `read cookies for ${e.to ?? 'a site'}${e.title ? ` via ${e.title}` : ''}`
    case 'run-started':
      // The run's fields come from a git-shared file like everything else here: rendered as text
      // only (React escapes it), and never turned into an action.
      return `started ${runName(e)} on this issue`
    case 'run-ended':
      return `closed ${runName(e)}${e.run?.end ? ` (last state: ${e.run.end})` : ''}`
    case 'station-failed':
      // Rendered from the closed reason table, never from anything the station wrote: `to` is a
      // reason CODE, and an unknown one (a newer peer, a hand edit) reads as a plain "stopped".
      return `told this agent that station ${stationName(e)} stopped: ${stationTrigger(e.to)?.label ?? 'it stopped'}`
    default:
      // A newer peer may write event types this build doesn't know — show them neutrally.
      return `updated this card`
  }
}

/** `"Build UI" (term-1a2b)` — the station as the notice named it. Text only, like `runName`. */
function stationName(e: BoardLogEvent): string {
  const id = typeof e.from === 'string' && e.from ? ` (${e.from})` : ''
  return typeof e.title === 'string' && e.title ? `"${e.title}"${id}` : `${e.from ?? 'a station'}`
}

/** "Claude session term-1a2b" — the node title when the event recorded one, else the node id. */
function runName(e: BoardLogEvent): string {
  const who = typeof e.title === 'string' && e.title ? e.title : 'a session'
  const id = typeof e.run?.nodeId === 'string' ? ` (${e.run.nodeId})` : ''
  return `${who}${id}`
}

/** Absolute, Trello-style stamp ("19 Jul 2026, 22:50") — the feed shows dates, not "2h ago"
 *  (the relative form stays in the row's tooltip). */
function formatStamp(ts: number): string {
  if (!Number.isFinite(ts)) return ''
  return new Date(ts).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** Right panel of the card modal (all card kinds): a composer on top and the card's own
 *  comments + activity feed newest-first. Reads/writes the board log for the ACTIVE project via
 *  its session api — resolved here (not threaded from Canvas). Subscribes on mount, so a teammate's
 *  comment or a board change lands live; unsubscribes on unmount / card swap. */
export function BoardLogPanel({ card, title, readOnly, emptyText }: BoardLogPanelProps) {
  const { api } = useSession()
  const projectId = useProjects((s) => s.activeProjectId)
  const entries = useBoardLog((s) => s.entriesFor(projectId))
  const unsupported = useBoardLog((s) => !!s.unsupportedByProject[projectId])
  const error = useBoardLog((s) => !!s.errorByProject[projectId])
  const [draft, setDraft] = useState('')

  useEffect(() => {
    if (!projectId) return
    void useBoardLog.getState().load(api, projectId)
    const unsub = useBoardLog.getState().subscribeChanged(api, projectId)
    return unsub
  }, [api, projectId])

  const send = () => {
    const text = draft.trim()
    if (!text) return
    useBoardLog.getState().append(api, projectId, { kind: 'comment', nodeId: card.id, text })
    setDraft('')
  }

  // Card-scoped: this card's comments + its own events. Column events (no nodeId) never match.
  const feed = (entries ?? []).filter((e) => e.nodeId === card.id)

  return (
    <div className="board-log">
      <div className="board-log__title">{title ?? 'Comments & activity'}</div>
      {unsupported ? (
        <div className="board-log__hint">Board history needs a project folder</div>
      ) : readOnly ? null : (
        <textarea
          className="board-log__composer"
          value={draft}
          placeholder="Write a comment…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter inserts a newline (default textarea behavior).
            // Never submit mid-IME-composition (e.g. selecting a kanji candidate with Enter).
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
        />
      )}
      {!unsupported && error && (
        <div className="board-log__error">Some board history couldn’t be saved.</div>
      )}
      {!unsupported && feed.length === 0 && emptyText && (
        <div className="board-log__hint">{emptyText}</div>
      )}
      <BoardLogFeed feed={feed} />
    </div>
  )
}

/** The feed itself, newest first. Runs of like events render folded as one "×N" row that expands
 *  in place (lib/boardLogCollapse — a VIEW; the log is never rewritten). Comments and the audit
 *  types are always one row each. Which groups are open is component state keyed by the group's
 *  newest entry id, so a new entry landing on top does not collapse a row the user just opened. */
export function BoardLogFeed({ feed }: { feed: readonly BoardLogEntry[] }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const items = useMemo(() => collapseFeed(feed), [feed])
  const toggle = (key: string): void =>
    setOpen((cur) => {
      const next = new Set(cur)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  return (
    <div className="board-log__feed">
      {items.map((item) => {
        if (item.kind === 'single') return <FeedRow key={item.entry.id} entry={item.entry} />
        const expanded = open.has(item.key)
        const fold = (
          <button
            className="board-log__fold"
            aria-expanded={expanded}
            title={expanded ? 'Collapse' : `Show all ${item.entries.length}`}
            onClick={() => toggle(item.key)}
          >
            ×{item.entries.length}
          </button>
        )
        return expanded ? (
          <div key={item.key} className="board-log__group board-log__group--open">
            {item.entries.map((entry, i) => (
              <FeedRow key={entry.id} entry={entry} fold={i === 0 ? fold : undefined} />
            ))}
          </div>
        ) : (
          <FeedRow key={item.key} entry={item.entries[0]} fold={fold} />
        )
      })}
    </div>
  )
}

function FeedRow({ entry, fold }: { entry: BoardLogEntry; fold?: React.ReactNode }) {
  const when = formatStamp(entry.ts)
  const whenAgo = formatTimeAgo(entry.ts)
  if (entry.kind === 'event' && entry.event) {
    return (
      <div className="board-log__event" title={whenAgo}>
        <span className="board-log__dot" style={{ background: entry.author.color }} />
        <span className="board-log__author" style={{ color: entry.author.color }}>
          {entry.author.name}
        </span>{' '}
        <span className="board-log__event-body">{eventBody(entry.event)}</span>
        {fold}
        <span className="board-log__time">{when}</span>
      </div>
    )
  }
  return (
    <div className="board-log__comment">
      <div className="board-log__meta">
        <span className="board-log__dot" style={{ background: entry.author.color }} />
        <span className="board-log__author" style={{ color: entry.author.color }}>
          {entry.author.name}
        </span>
        <span className="board-log__time" title={whenAgo}>{when}</span>
      </div>
      <div className="board-log__text">{entry.text}</div>
    </div>
  )
}
