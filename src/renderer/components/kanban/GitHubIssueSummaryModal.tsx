import { useEffect, useRef, useState } from 'react'
import type { GitHubIssueCardView } from '@shared/github-issues'
import type { KanbanColumn } from '@shared/types'
import { issueLogId, issueRefFromHtmlUrl } from '@shared/github-issue-ref'
import { useSession } from '../../session/session'
import { Button } from '@renderer/ui/Button'
import { Select } from '@renderer/ui/Select'
import { ContextMenu, type MenuItem } from '../ContextMenu'
import { NO_ISSUE_RUNS, type IssueRun } from '../../lib/issueRuns'
import { IssueRunChips } from './IssueRunChips'
import { BoardLogPanel } from './BoardLogPanel'

export function GitHubIssueSummaryModal({
  issue,
  columns,
  moving,
  readOnly,
  status,
  kind = 'issue',
  onMove,
  onClose,
  startMenu,
  runs = NO_ISSUE_RUNS,
  onOpenRun,
  showRunHistory = false
}: {
  issue: GitHubIssueCardView
  columns: KanbanColumn[]
  moving: boolean
  readOnly: boolean
  status?: string
  /** A pull request is read-only on the board, so its variant drops the Move control and the
   *  conflict hint — both name a write only an issue has. */
  kind?: 'issue' | 'pull'
  onMove: (columnId: string | null) => void
  onClose: () => void
  /** The "Start with agent ▸" rows (the canvas's own agent + account picker, pointed at this
   *  issue). Absent = no button — a pull request, or a board with no canvas behind it. */
  startMenu?: () => MenuItem[]
  /** Sessions already working on this issue — the same live chips the card shows. */
  runs?: readonly IssueRun[]
  onOpenRun?: (nodeId: string) => void
  /** Show the issue card's read-only run history (its board-log feed). */
  showRunHistory?: boolean
}): React.JSX.Element {
  const isPull = kind === 'pull'
  const { api } = useSession()
  const [startAt, setStartAt] = useState<{ x: number; y: number } | null>(null)
  // The run history is filed under the issue card's synthetic board-log id. No id (a card whose
  // URL did not parse) = no history panel, rather than a panel keyed on something made up.
  const logId = !isPull && showRunHistory
    ? issueLogId(issueRefFromHtmlUrl(issue.htmlUrl, issue.number))
    : undefined
  const close = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLElement>(null)
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  useEffect(() => {
    close.current?.focus()
    return () => opener.current?.focus()
  }, [])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'Tab' && dialog.current) {
        const focusable = [...dialog.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
        )]
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return (
    <div className="kanban-modal-scrim" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialog}
        className="github-issue-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="github-issue-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="github-issue-modal__header">
          <div>
            <div className="github-issue-modal__eyebrow">
              GitHub {isPull ? 'pull request' : 'issue'} #{issue.number}
            </div>
            <h2 id="github-issue-modal-title">{issue.title}</h2>
          </div>
          <button ref={close} className="github-issue-modal__close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="github-issue-modal__actions">
          {!isPull && (
            <label>
              <span>Move to</span>
              <Select
                aria-label={`Move issue #${issue.number}`}
                value={issue.columnId ?? ''}
                disabled={moving || readOnly}
                onChange={(event) => onMove(event.target.value || null)}
              >
                <option value="">Ungrouped</option>
                {columns.map((column) => <option key={column.id} value={column.id}>{column.title}</option>)}
              </Select>
            </label>
          )}
          {!isPull && startMenu && (
            <Button
              aria-haspopup="menu"
              onClick={(event) => {
                const r = (event.currentTarget as HTMLElement).getBoundingClientRect()
                setStartAt({ x: r.left, y: r.bottom + 4 })
              }}
            >
              Start with agent ▾
            </Button>
          )}
          <Button onClick={() => void api.shell.openExternal(issue.htmlUrl)}>Open on GitHub</Button>
        </div>
        {!isPull && onOpenRun && runs.length > 0 && (
          <div className="github-issue-modal__runs">
            <IssueRunChips runs={runs} onOpen={onOpenRun} />
          </div>
        )}
        {!isPull && issue.conflict && (
          <p className="github-issue-modal__warning">
            This issue has conflicting mapped labels. Choose a column to replace them with one exact label.
          </p>
        )}
        {status && <p className="github-issue-modal__warning" role="status">{status}</p>}
        <div className="github-issue-modal__body">
          {issue.body.trim() || 'No description provided.'}
        </div>
        {logId && (
          <div className="github-issue-modal__history">
            <BoardLogPanel
              card={{ id: logId }}
              title="Agent runs"
              readOnly
              emptyText="No agent has worked on this issue from this project yet. This history stays in the project's board log and is never posted to GitHub."
            />
          </div>
        )}
        {startAt && startMenu && (
          <ContextMenu
            x={startAt.x}
            y={startAt.y}
            zIndex={60}
            items={startMenu()}
            onClose={() => setStartAt(null)}
          />
        )}
      </section>
    </div>
  )
}
