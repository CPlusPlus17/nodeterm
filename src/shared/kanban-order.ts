/**
 * Card order within a board column, and the one placement every writer uses.
 *
 * ORDER (`columnOrder`): an entry with a valid `rank` sorts by it; an entry without one (every
 * pre-rank board, an older build's move, a hand edit) sits right after the entry before it in the
 * ARRAY, so a board no build has ranked reads exactly as it always did. Ties keep array order, so
 * two machines that minted the same key still agree on the result.
 *
 * WRITE (`placeAssignment`): the moved card gets one new rank between its neighbours, and the
 * ARRAY is kept in rank order too — a build that ignores `rank` reads array order, and must show
 * the same column. The two goals pull against each other, and the resolution is to move as little
 * as the second one allows:
 *  - the moved entry stays at its array index when that index already sits between its new
 *    neighbours — a cross-column move whose slot fits is then a two-line diff (columnId + rank);
 *  - otherwise it moves next to its successor (else its predecessor), i.e. one block moves;
 *  - the destination column is repaired first when it must be — ranks that are missing, invalid or
 *    collide get fresh keys IN THE ORDER THE COLUMN WAS ALREADY SHOWING (only those entries change),
 *    and an array that disagrees with the ranks (a textual merge) is re-slotted within the column's
 *    own array positions. A board's first write into an unranked column therefore ranks it once.
 * A reorder WITHIN a column always moves a block: the array must change for an old build to see it.
 *
 * Generic over the entry type and spread-preserving, so the host core can run it on the raw
 * project-file objects (the relay's move verb) and every unknown field round-trips.
 */
import { isValidRank, rankBetween, ranksBetween } from './kanban-rank'

export interface RankedEntry {
  nodeId: string
  columnId: string
  rank?: string
}

/** Where a moved card goes: the top, the bottom, or just above a card of that column. */
export type CardAnchor = 'top' | 'end' | { before: string }

/** One column's entries in board order (see the module note). Never throws. */
export function columnOrder<A extends RankedEntry>(list: readonly A[], columnId: string): A[] {
  const entries: Array<{ a: A; idx: number; key: string }> = []
  let prev = ''
  list.forEach((a, idx) => {
    if (!a || a.columnId !== columnId) return
    const key = isValidRank(a.rank) ? a.rank : prev
    entries.push({ a, idx, key })
    prev = key
  })
  entries.sort((p, q) => (p.key < q.key ? -1 : p.key > q.key ? 1 : p.idx - q.idx))
  return entries.map((e) => e.a)
}

/** New ranks for the entries of an ordered column that lack a strictly increasing valid one
 *  (missing, invalid, or colliding with the one before). Kept entries are untouched. */
function repairRanks<A extends RankedEntry>(order: readonly A[]): Map<A, string> {
  const fixes = new Map<A, string>()
  let last: string | null = null
  const keep = order.map((e) => {
    if (isValidRank(e.rank) && (last === null || e.rank > last)) {
      last = e.rank
      return true
    }
    return false
  })
  for (let i = 0; i < order.length; ) {
    if (keep[i]) {
      i++
      continue
    }
    let j = i
    while (j < order.length && !keep[j]) j++
    const lo = i > 0 ? (order[i - 1].rank as string) : null
    const hi = j < order.length ? (order[j].rank as string) : null
    ranksBetween(lo, hi, j - i).forEach((k, t) => fixes.set(order[i + t], k))
    i = j
  }
  return fixes
}

/**
 * Move (or add) `nodeId` into `columnId` at `anchor`, returning the new assignments array — or the
 * SAME array when the card is already exactly there (nothing to write). A `before` that names no
 * card of that column is no anchor: the top. Ungrouped (removal) is the caller's, not this.
 */
export function placeAssignment<A extends RankedEntry>(
  list: readonly A[],
  nodeId: string,
  columnId: string,
  anchor: CardAnchor
): A[] {
  const i0 = list.findIndex((e) => e?.nodeId === nodeId)
  const old = i0 === -1 ? undefined : list[i0]
  const without = i0 === -1 ? [...list] : [...list.slice(0, i0), ...list.slice(i0 + 1)]
  let col = columnOrder(without, columnId)
  const anchorIdx = typeof anchor === 'object' ? col.findIndex((e) => e.nodeId === anchor.before) : -1
  const at = anchor === 'end' ? col.length : anchorIdx !== -1 ? anchorIdx : 0
  if (old && old.columnId === columnId && columnOrder(list, columnId).indexOf(old) === at) {
    return list as A[]
  }

  // Repair the destination column, then make its array slots agree with its order.
  let arr = without
  const fixes = repairRanks(col)
  if (fixes.size) {
    arr = arr.map((e) => (fixes.has(e) ? { ...e, rank: fixes.get(e)! } : e))
    col = columnOrder(arr, columnId)
  }
  const slots: number[] = []
  arr.forEach((e, i) => {
    if (e?.columnId === columnId) slots.push(i)
  })
  if (slots.some((s, k) => arr[s] !== col[k])) {
    arr = [...arr]
    slots.forEach((s, k) => {
      arr[s] = col[k]
    })
  }

  const prev = at > 0 ? col[at - 1] : undefined
  const next = at < col.length ? col[at] : undefined
  const rank = rankBetween(prev?.rank ?? null, next?.rank ?? null)
  const moved = (old ? { ...old, columnId, rank } : { nodeId, columnId, rank }) as A

  const pIdx = prev ? arr.indexOf(prev) : -1
  const sIdx = next ? arr.indexOf(next) : -1
  const fits = i0 !== -1 && (pIdx === -1 || pIdx < i0) && (sIdx === -1 || i0 <= sIdx)
  const pos = fits ? i0 : sIdx !== -1 ? sIdx : pIdx !== -1 ? pIdx + 1 : i0 !== -1 ? i0 : arr.length
  return [...arr.slice(0, pos), moved, ...arr.slice(pos)]
}
