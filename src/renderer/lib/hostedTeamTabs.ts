// The tabs a hosted team occupies on this desktop: one tab per project the host shares, all served
// by ONE relay connection. The store and the session registry are injected (`TeamTabOps`), so
// everything here is plain bookkeeping that runs under a test without either.
//
// - The tab id IS the host's project id. The relay api translates no ids, so a tab under any other
//   id would ask the host about a project it does not know. (An id an unrelated local project
//   already holds is the store's to resolve, exactly as the single-tab adopt always did.)
// - `place` runs on every (re)mount of the team's connection: on a reconnect it reuses the team's
//   greyed tabs by id, so their nodes and their place in the tab bar survive, and it removes the
//   tabs whose project the host stopped sharing while this desktop was away.
// - `sharedChanged` follows the host's share events while the connection is live: it opens a tab
//   for each newly shared project and closes the tabs of unshared ones.
// - `closeTab` is the user closing ONE of the team's tabs: it is remembered as dismissed (not
//   reopened while it stays shared) and the connection lives on for the team's other tabs. Only the
//   last tab's close leaves the binding alone, for the caller that ends the connection.
// - A team with nothing shared keeps one placeholder tab named after the team, so the team stays
//   visible and reconnectable instead of vanishing from the tab bar; the first shared project
//   replaces it.
//
// Removing a tab here is always a removal from THIS desktop only (`removeTab`), never the
// destroying delete: that would end the host's sessions through the relay transport.

import type { Project } from '@shared/types'
import { EMPTY_TAB_SET, dismissTab, planSharedChange, type HostedTabSet } from './hostedTabs'

export interface TeamTabOps {
  getProject(id: string): Project | undefined
  isOpenTab(id: string): boolean
  adoptProject(p: Project): { id: string }
  addPlaceholder(label: string): { id: string }
  /** Drop a hosted tab from THIS desktop only: never the destroying delete (which would kill the
   *  host's sessions through the relay transport). */
  removeTab(id: string): void
  activeProjectId(): string | null
  setActive(id: string): void
  bind(projectId: string, sessionId: string): void
  unbind(projectId: string): void
}

export interface TeamRef {
  hostId: string
  label: string
}

export interface TeamTabs {
  /** Place the host's shared projects as this team's tabs (host order), reusing `existing` tabs by
   *  id and removing the existing ones no longer shared. Never empty: nothing shared yields the
   *  team's placeholder. Binding the returned ids to the session is the caller's. */
  place(team: TeamRef, projects: Project[], existing: string[], opts: { keepActive: boolean }): string[]
  /** The host's shared set is now `projectIds`: close the tabs no longer shared, and open (and bind)
   *  the newly shared ones, calling `load` for the host's workspace only when something opens. */
  sharedChanged(
    team: TeamRef & { sessionId: string },
    projectIds: string[],
    load: () => Promise<Project[]>,
    opts: { keepActive: boolean }
  ): Promise<{ opened: string[]; closed: string[] }>
  /** The user closed one of a team's tabs. `remaining` names the team's other open tabs; empty means
   *  this was its last, and the caller owns ending the connection. */
  closeTab(projectId: string): { remaining: string[] }
  /** The team (host id) a tab belongs to, if any. */
  teamOf(projectId: string): string | undefined
}

export function createTeamTabs(ops: TeamTabOps): TeamTabs {
  const sets = new Map<string, HostedTabSet>()
  const placeholders = new Map<string, string>()
  const team = new Map<string, string>()

  // The store's adopt activates what it adopts; a share the user did not ask for must not take the
  // screen from the tab they are on.
  const restoreActive = (prev: string | null, keep: boolean): void => {
    if (keep && prev && ops.getProject(prev)) ops.setActive(prev)
  }
  const dropPlaceholder = (hostId: string): void => {
    const ph = placeholders.get(hostId)
    if (!ph) return
    placeholders.delete(hostId)
    team.delete(ph)
    ops.unbind(ph)
    ops.removeTab(ph)
  }

  return {
    place(t, projects, existing, opts) {
      const prev = ops.activeProjectId()
      const set = sets.get(t.hostId) ?? EMPTY_TAB_SET
      const reuse = new Set(existing)
      const ids: string[] = []
      for (const p of projects) {
        if (set.dismissed.includes(p.id)) continue
        ids.push(reuse.has(p.id) && ops.getProject(p.id) ? p.id : ops.adoptProject(p).id)
      }
      const ph = placeholders.get(t.hostId)
      for (const id of existing) {
        if (!ids.includes(id) && id !== ph) {
          team.delete(id)
          ops.removeTab(id)
        }
      }
      // A dismissal is remembered only while the host still shares that project.
      const dismissed = set.dismissed.filter((d) => projects.some((p) => p.id === d))
      if (ids.length === 0) {
        const keep = ph && ops.getProject(ph) ? ph : ops.addPlaceholder(t.label).id
        placeholders.set(t.hostId, keep)
        team.set(keep, t.hostId)
        restoreActive(prev, opts.keepActive)
        sets.set(t.hostId, { shown: [], dismissed })
        return [keep]
      }
      if (ph) dropPlaceholder(t.hostId)
      for (const id of ids) team.set(id, t.hostId)
      sets.set(t.hostId, { shown: ids, dismissed })
      restoreActive(prev, opts.keepActive)
      return ids
    },

    async sharedChanged(t, projectIds, load, opts) {
      const set = sets.get(t.hostId) ?? EMPTY_TAB_SET
      const plan = planSharedChange(set, projectIds)
      for (const id of plan.close) {
        team.delete(id)
        ops.unbind(id)
        ops.removeTab(id)
      }
      const opened: string[] = []
      if (plan.open.length) {
        const prev = ops.activeProjectId()
        for (const p of await load()) {
          if (!plan.open.includes(p.id) || ops.getProject(p.id)) continue
          const id = ops.adoptProject(p).id
          ops.bind(id, t.sessionId)
          team.set(id, t.hostId)
          opened.push(id)
        }
        restoreActive(prev, opts.keepActive)
      }
      // A newly shared project the load did not return opened no tab: it is not shown.
      const shown = plan.next.shown.filter((id) => ops.getProject(id))
      sets.set(t.hostId, { shown, dismissed: plan.next.dismissed })
      if (shown.length > 0) dropPlaceholder(t.hostId)
      else if (!placeholders.has(t.hostId)) {
        const ph = ops.addPlaceholder(t.label).id
        placeholders.set(t.hostId, ph)
        team.set(ph, t.hostId)
        ops.bind(ph, t.sessionId)
      }
      return { opened, closed: plan.close }
    },

    closeTab(projectId) {
      const hostId = team.get(projectId)
      if (!hostId) return { remaining: [] }
      const remaining = [...team]
        .filter(([id, h]) => h === hostId && id !== projectId && ops.isOpenTab(id))
        .map(([id]) => id)
      const set = sets.get(hostId)
      if (set?.shown.includes(projectId)) sets.set(hostId, dismissTab(set, projectId))
      if (placeholders.get(hostId) === projectId) placeholders.delete(hostId)
      team.delete(projectId)
      if (remaining.length) ops.unbind(projectId)
      return { remaining }
    },

    teamOf: (projectId) => team.get(projectId)
  }
}
