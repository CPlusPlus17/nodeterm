import { describe, expect, it, vi } from 'vitest'
import { resolveIssueFlagFor } from './issueFlag'

const withBoard = (repository?: string) => ({
  id: 'p1',
  kanban: { github: repository === undefined ? {} : { repository } }
})

describe('resolveIssueFlagFor (open-agent --issue on the desktop)', () => {
  it('is a no-op without the flag', async () => {
    const ask = vi.fn()
    expect(await resolveIssueFlagFor(undefined, 'open-agent', withBoard(), ask)).toEqual({ ok: true })
    expect(ask).not.toHaveBeenCalled()
  })

  it('takes a full owner/repo#N as given, board or no board — and asks nobody', async () => {
    const ask = vi.fn(async () => 'x/y')
    expect(await resolveIssueFlagFor('a/b#3', 'open-agent', undefined, ask)).toEqual({
      ok: true,
      ref: { owner: 'a', repo: 'b', number: 3 }
    })
    expect(await resolveIssueFlagFor('a/b#3', 'open-agent', withBoard(), ask)).toMatchObject({ ok: true })
    // A full reference must not cost a host round trip (git remote, gh auth) before the open.
    expect(ask).not.toHaveBeenCalled()
  })

  it('resolves #N against the repository the board syncs with (the host controller answer)', async () => {
    const ask = vi.fn(async () => 'eneskirca/nodeterm')
    expect(await resolveIssueFlagFor('#9', 'open-agent', withBoard(), ask)).toEqual({
      ok: true,
      ref: { owner: 'eneskirca', repo: 'nodeterm', number: 9 }
    })
    expect(ask).toHaveBeenCalledWith('p1')
  })

  it('falls back to the explicitly configured repository when the controller cannot answer', async () => {
    const ask = vi.fn(async () => {
      throw new Error('E_UNSUPPORTED')
    })
    expect(await resolveIssueFlagFor('#9', 'open-claude', withBoard('o/r'), ask)).toEqual({
      ok: true,
      ref: { owner: 'o', repo: 'r', number: 9 }
    })
  })

  it('treats a controller that throws synchronously (no GitHub api on this session) as unknown', async () => {
    const ask = (): Promise<string | null> => {
      throw new TypeError('githubControl is undefined')
    }
    expect(await resolveIssueFlagFor('#9', 'open-agent', withBoard('o/r'), ask)).toEqual({
      ok: true,
      ref: { owner: 'o', repo: 'r', number: 9 }
    })
  })

  it('refuses #N when the project has no GitHub board at all — without asking anyone', async () => {
    const ask = vi.fn(async () => 'o/r')
    const r = await resolveIssueFlagFor('#9', 'open-agent', { id: 'p1' }, ask)
    expect(r).toEqual({
      ok: false,
      error:
        "open-agent: --issue #9 needs this project's kanban board to be connected to a GitHub repository — pass owner/repo#9 instead"
    })
    expect(ask).not.toHaveBeenCalled()
  })

  it('refuses #N when the board exists but nobody can name its repository', async () => {
    const r = await resolveIssueFlagFor('#9', 'open-agent', withBoard(), async () => null)
    expect(r.ok).toBe(false)
  })

  it.each(['o/r#1; rm -rf ~', 'o/r#`id`', 'o/r#$(id)', 'o/r#1\nx', '#1 && x', '#', 'o/r'])(
    'refuses %j even if a malformed value got past main',
    async (raw) => {
      const r = await resolveIssueFlagFor(raw, 'open-agent', withBoard('o/r'), async () => 'o/r')
      expect(r.ok).toBe(false)
    }
  )

  it('refuses #N against a hostile configured repository instead of splicing it', async () => {
    const r = await resolveIssueFlagFor('#1', 'open-agent', withBoard('o/r;rm -rf ~'), async () => {
      throw new Error('down')
    })
    expect(r.ok).toBe(false)
  })
})
