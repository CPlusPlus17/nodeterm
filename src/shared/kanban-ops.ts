// Item-level kanban mutations — the board half of the canvas:mut vocabulary. Pure: no DOM, no fs.
// Every surface that applies a board change from someone else (a peer client, the Server Edition
// canvas authority) goes through `applyKanbanOp`; every surface that publishes one builds it with
// `diffKanbanOps`. One implementation of each, so a board converges to the same bytes everywhere.
// See docs/team-presence.md for the ordering rules (seq, rule 4) these ops share with nodes/edges.

import { isRefId } from './canvas-mutations'
import { defaultKanbanFor } from './kanban-default-board'
import { KANBAN_LABEL_COLORS } from './kanban-labels'
import { isValidRank } from './kanban-rank'
import { sanitizeViews } from './kanban-views'
import type {
  KanbanAssignment, KanbanCardMeta, KanbanColumn, KanbanColumnCategory, KanbanLabel,
  KanbanLabelColor, KanbanOp, KanbanPriority, KanbanSavedView, ProjectKanban
} from './types'

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const TITLE_MAX = 200
const COLOR_MAX = 64
const NAME_MAX = 100
const LABEL_NAME_MAX = 60 // same bound as core/project-kanban-write.ts LABEL_NAME_MAX
const LIST_MAX = 500
const PRIORITIES: readonly KanbanPriority[] = ['low', 'medium', 'high', 'urgent']
const CATEGORIES: readonly KanbanColumnCategory[] = ['unstarted', 'started', 'done', 'closed']
/** 1970 … 3000: a real due date, not a sentinel. */
const DUE_MIN = 0
const DUE_MAX = 32_503_680_000_000

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const text = (x: unknown, max: number): string | null =>
  typeof x === 'string' && x.length <= max && !CONTROL.test(x) ? x : null
const idList = (x: unknown): string[] | null => {
  if (!Array.isArray(x) || x.length > LIST_MAX || !x.every(isRefId)) return null
  return [...new Set(x as string[])]
}

function column(x: unknown): KanbanColumn | null {
  if (!isObj(x) || !isRefId(x.id)) return null
  const title = text(x.title, TITLE_MAX)
  const color = text(x.color, COLOR_MAX)
  if (title === null || color === null) return null
  const out: KanbanColumn = { id: x.id, title, color }
  if (CATEGORIES.includes(x.category as KanbanColumnCategory)) out.category = x.category as KanbanColumnCategory
  return out
}

function assignment(x: unknown): KanbanAssignment | null {
  if (!isObj(x) || !isRefId(x.nodeId) || !isRefId(x.columnId)) return null
  const out: KanbanAssignment = { nodeId: x.nodeId, columnId: x.columnId }
  if (isValidRank(x.rank)) out.rank = x.rank
  return out
}

function meta(x: unknown): KanbanCardMeta | null {
  if (!isObj(x) || !isRefId(x.nodeId)) return null
  const out: KanbanCardMeta = { nodeId: x.nodeId }
  if (Array.isArray(x.assignees)) {
    const a = x.assignees
      .filter(isObj)
      .map((p) => ({ name: text(p.name, NAME_MAX), color: text(p.color, COLOR_MAX) }))
      .filter((p): p is { name: string; color: string } => !!p.name && p.color !== null)
      .slice(0, 50)
    if (a.length) out.assignees = a
  }
  if (typeof x.dueAt === 'number' && Number.isFinite(x.dueAt) && x.dueAt >= DUE_MIN && x.dueAt <= DUE_MAX)
    out.dueAt = x.dueAt
  if (PRIORITIES.includes(x.priority as KanbanPriority)) out.priority = x.priority as KanbanPriority
  const labels = x.labels === undefined ? null : idList(x.labels)
  if (labels && labels.length) out.labels = labels
  return out
}

function label(x: unknown): KanbanLabel | null {
  if (!isObj(x) || !isRefId(x.id) || typeof x.name !== 'string') return null
  const name = x.name.trim()
  if (!name || [...name].length > LABEL_NAME_MAX || CONTROL.test(name)) return null
  const color: KanbanLabelColor = KANBAN_LABEL_COLORS.includes(x.color as KanbanLabelColor)
    ? (x.color as KanbanLabelColor)
    : 'default'
  return { id: x.id, name, color }
}

function view(x: unknown): KanbanSavedView | null {
  const v = sanitizeViews([x])
  return v && v.length === 1 ? v[0] : null
}

/** Is this an op name this module owns? (Shape is `sanitizeKanbanOp`'s job.) */
export function isKanbanOp(m: { op?: unknown }): boolean {
  return typeof m.op === 'string' && m.op.startsWith('kb-')
}

/** The sanitized op, or null to REFUSE it. Refusals are whole-op (a bad id addresses the wrong
 *  thing); repairable fields (colour, rank, priority, dueAt, category) are repaired or dropped. */
export function sanitizeKanbanOp(m: unknown): KanbanOp | null {
  if (!isObj(m)) return null
  switch (m.op) {
    case 'kb-column': { const c = column(m.column); return c && { op: 'kb-column', column: c } }
    case 'kb-column-remove': return isRefId(m.id) ? { op: 'kb-column-remove', id: m.id } : null
    case 'kb-column-order': { const ids = idList(m.ids); return ids && { op: 'kb-column-order', ids } }
    case 'kb-card': { const a = assignment(m.assignment); return a && { op: 'kb-card', assignment: a } }
    case 'kb-card-remove': return isRefId(m.nodeId) ? { op: 'kb-card-remove', nodeId: m.nodeId } : null
    case 'kb-meta': { const x = meta(m.meta); return x && { op: 'kb-meta', meta: x } }
    case 'kb-meta-remove': return isRefId(m.nodeId) ? { op: 'kb-meta-remove', nodeId: m.nodeId } : null
    case 'kb-label': { const l = label(m.label); return l && { op: 'kb-label', label: l } }
    case 'kb-label-remove': return isRefId(m.id) ? { op: 'kb-label-remove', id: m.id } : null
    case 'kb-label-order': { const ids = idList(m.ids); return ids && { op: 'kb-label-order', ids } }
    case 'kb-view': { const v = view(m.view); return v && { op: 'kb-view', view: v } }
    case 'kb-view-remove': return isRefId(m.id) ? { op: 'kb-view-remove', id: m.id } : null
    default: return null
  }
}

/** The ordering key (canvas-order): one `k:` space with a sub-prefix per item kind. */
export function kanbanOpKey(m: KanbanOp): string {
  switch (m.op) {
    case 'kb-column': return `k:col:${m.column.id}`
    case 'kb-column-remove': return `k:col:${m.id}`
    case 'kb-column-order': return 'k:colorder'
    case 'kb-card': return `k:card:${m.assignment.nodeId}`
    case 'kb-card-remove': return `k:card:${m.nodeId}`
    case 'kb-meta': return `k:meta:${m.meta.nodeId}`
    case 'kb-meta-remove': return `k:meta:${m.nodeId}`
    case 'kb-label': return `k:label:${m.label.id}`
    case 'kb-label-remove': return `k:label:${m.id}`
    case 'kb-label-order': return 'k:labelorder'
    case 'kb-view': return `k:view:${m.view.id}`
    case 'kb-view-remove': return `k:view:${m.id}`
  }
}

/** Rule-4 deletions: the thing is gone. A card/meta removal is a VALUE ("no placement", "no meta")
 *  and orders like any other write. */
export function isKanbanDeletion(m: KanbanOp): boolean {
  return m.op === 'kb-column-remove' || m.op === 'kb-label-remove' || m.op === 'kb-view-remove'
}

function reorder<T extends { id: string }>(list: T[], ids: string[]): T[] {
  const byId = new Map(list.map((x) => [x.id, x]))
  const head = ids.map((id) => byId.get(id)).filter((x): x is T => !!x)
  const listed = new Set(head.map((x) => x.id))
  return [...head, ...list.filter((x) => !listed.has(x.id))]
}

function upsertById<T extends { id: string }>(list: T[] | undefined, item: T): T[] {
  const cur = list ?? []
  const i = cur.findIndex((x) => x.id === item.id)
  if (i === -1) return [...cur, item]
  const next = cur.slice()
  next[i] = item
  return next
}

/** Insert a placement so its column stays in rank order in the ARRAY (a build that ignores `rank`
 *  reads array order, see ProjectKanban.assignments). */
function placeCard(assignments: KanbanAssignment[], a: KanbanAssignment): KanbanAssignment[] {
  const rest = assignments.filter((x) => x.nodeId !== a.nodeId)
  const sameCol: number[] = []
  rest.forEach((x, i) => { if (x.columnId === a.columnId) sameCol.push(i) })
  if (!sameCol.length) return [...rest, a]
  const before = a.rank === undefined
    ? undefined
    : sameCol.find((i) => { const r = rest[i].rank; return r !== undefined && r > (a.rank as string) })
  const at = before ?? sameCol[sameCol.length - 1] + 1
  return [...rest.slice(0, at), a, ...rest.slice(at)]
}

/** Apply one (already sanitized) op. Pure; returns a new board. An absent board is the project's
 *  deterministic lazy default — exactly what every client was showing. */
export function applyKanbanOp(board: ProjectKanban | undefined, m: KanbanOp, projectId: string): ProjectKanban {
  const b: ProjectKanban = board ?? defaultKanbanFor(projectId)
  switch (m.op) {
    case 'kb-column': return { ...b, columns: upsertById(b.columns, m.column) }
    case 'kb-column-remove':
      return {
        ...b,
        columns: b.columns.filter((c) => c.id !== m.id),
        assignments: b.assignments.filter((a) => a.columnId !== m.id)
      }
    case 'kb-column-order': return { ...b, columns: reorder(b.columns, m.ids) }
    case 'kb-card': return { ...b, assignments: placeCard(b.assignments, m.assignment) }
    case 'kb-card-remove': return { ...b, assignments: b.assignments.filter((a) => a.nodeId !== m.nodeId) }
    case 'kb-meta': {
      const cur = b.meta ?? []
      const i = cur.findIndex((x) => x.nodeId === m.meta.nodeId)
      const next = i === -1 ? [...cur, m.meta] : cur.map((x, j) => (j === i ? m.meta : x))
      return { ...b, meta: next }
    }
    case 'kb-meta-remove': {
      const next = (b.meta ?? []).filter((x) => x.nodeId !== m.nodeId)
      return { ...b, meta: next }
    }
    case 'kb-label': return { ...b, labels: upsertById(b.labels, m.label) }
    case 'kb-label-remove': {
      const meta = (b.meta ?? [])
        .map((x) => (x.labels?.includes(m.id) ? { ...x, labels: x.labels.filter((l) => l !== m.id) } : x))
        .map((x) => (x.labels && x.labels.length === 0 ? (({ labels: _l, ...rest }) => rest)(x) : x))
        .filter((x) => Object.keys(x).length > 1) // an entry with only nodeId is "no metadata"
      return { ...b, labels: (b.labels ?? []).filter((l) => l.id !== m.id), meta }
    }
    case 'kb-label-order': return { ...b, labels: reorder(b.labels ?? [], m.ids) }
    case 'kb-view': return { ...b, views: upsertById(b.views, m.view) }
    case 'kb-view-remove': return { ...b, views: (b.views ?? []).filter((v) => v.id !== m.id) }
  }
}

function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    isObj(val) ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]])) : val)
}
const same = (a: unknown, b: unknown): boolean => stable(a) === stable(b)

/**
 * The item-level ops that turn `prev` into `next`. Never casts `github` / `pullLinks` (outside the
 * vocabulary). Never casts the removal of a DEAD card's placement or meta: pruning is a local, lazy
 * cleanup, and a peer whose node op has not arrived yet would otherwise delete a fresh card.
 * Batch order: upserts (columns, column order, labels, label order, views, cards, meta), then
 * removals (meta, cards, views, labels, columns).
 */
export function diffKanbanOps(
  prev: ProjectKanban | undefined,
  next: ProjectKanban | undefined,
  projectId: string,
  liveNodeIds: ReadonlySet<string>
): KanbanOp[] {
  if (!next) return []
  const p = prev ?? defaultKanbanFor(projectId)
  const up: KanbanOp[] = []
  const down: KanbanOp[] = []

  const pCols = new Map(p.columns.map((c) => [c.id, c]))
  for (const c of next.columns) if (!same(pCols.get(c.id), c)) up.push({ op: 'kb-column', column: c })
  const nColIds = next.columns.map((c) => c.id)
  const common = p.columns.map((c) => c.id).filter((id) => nColIds.includes(id))
  if (!same(common, nColIds.filter((id) => common.includes(id)))) up.push({ op: 'kb-column-order', ids: nColIds })

  const pLabels = new Map((p.labels ?? []).map((l) => [l.id, l]))
  for (const l of next.labels ?? []) if (!same(pLabels.get(l.id), l)) up.push({ op: 'kb-label', label: l })
  const nLabelIds = (next.labels ?? []).map((l) => l.id)
  const commonL = (p.labels ?? []).map((l) => l.id).filter((id) => nLabelIds.includes(id))
  if (!same(commonL, nLabelIds.filter((id) => commonL.includes(id)))) up.push({ op: 'kb-label-order', ids: nLabelIds })

  const pViews = new Map((p.views ?? []).map((v) => [v.id, v]))
  for (const v of next.views ?? []) if (!same(pViews.get(v.id), v)) up.push({ op: 'kb-view', view: v })

  const pCards = new Map(p.assignments.map((a) => [a.nodeId, a]))
  for (const a of next.assignments) if (!same(pCards.get(a.nodeId), a)) up.push({ op: 'kb-card', assignment: a })
  const pMeta = new Map((p.meta ?? []).map((x) => [x.nodeId, x]))
  for (const x of next.meta ?? []) if (!same(pMeta.get(x.nodeId), x)) up.push({ op: 'kb-meta', meta: x })

  const nMeta = new Set((next.meta ?? []).map((x) => x.nodeId))
  for (const x of p.meta ?? []) if (!nMeta.has(x.nodeId) && liveNodeIds.has(x.nodeId)) down.push({ op: 'kb-meta-remove', nodeId: x.nodeId })
  const nCards = new Set(next.assignments.map((a) => a.nodeId))
  const nColSet = new Set(nColIds)
  for (const a of p.assignments) {
    // A placement that vanished because its COLUMN was removed is covered by kb-column-remove.
    if (!nCards.has(a.nodeId) && liveNodeIds.has(a.nodeId) && nColSet.has(a.columnId))
      down.push({ op: 'kb-card-remove', nodeId: a.nodeId })
  }
  const nViews = new Set((next.views ?? []).map((v) => v.id))
  for (const v of p.views ?? []) if (!nViews.has(v.id)) down.push({ op: 'kb-view-remove', id: v.id })
  const nLabels = new Set(nLabelIds)
  for (const l of p.labels ?? []) if (!nLabels.has(l.id)) down.push({ op: 'kb-label-remove', id: l.id })
  for (const c of p.columns) if (!nColSet.has(c.id)) down.push({ op: 'kb-column-remove', id: c.id })

  return [...up, ...down]
}
