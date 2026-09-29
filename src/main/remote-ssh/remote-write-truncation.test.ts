// A remote write must never leave a truncated file — run for real, under /bin/sh, against a fake
// host tree.
//
// THE INCIDENT (2026-09-28): after the desktop's SSH reconnect, a host's `~/.nodeterm/nodeterm.sh`
// and `context.sh` were 0 bytes, and every agent's `sh nodeterm.sh <verb>` exited 0 with no
// output. The writer was `mkdir -p … && cat > <file> && chmod 755 <file>`, body on stdin. `cat >`
// truncates the file the moment the remote shell starts, and when the ssh channel ends before the
// body arrives `cat` reads EOF and EXITS 0 — so the chmod ran and the runner's non-zero ssh status
// was never looked at. Measured against OpenSSH 9.6 (master SIGKILLed, and the ssh child
// SIGTERMed as the runner's timeout does, both before the body arrived): the target went to
// 0 bytes and 644 → 755 every time. A stand-in ssh that closed stdin reproduced it with the runner
// resolving `code: 0`.
//
// The `cut` runner below is that failure: every command that carries a body gets NO body — the
// host sees stdin at EOF, exactly as when the channel dies first. Read commands run untouched.
import { spawnSync } from 'child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONTROL_SHIM_SCRIPT } from '../../core/canvas-control-core'
import { CONTEXT_SHIM_SCRIPT } from '../../core/context-link-core'
import { RemoteHooks, type RemoteRunner } from './remote-hooks'

const conn = { host: 'fixture', user: 'fixture' }
let home: string
let warn: { mock: { calls: unknown[][] } }

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "nt-remote-write-' h-"))
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(home, { recursive: true, force: true })
})

/** `cut`: every body is lost; a predicate: only the bodies of the commands it names are lost. */
function hostRunner(mode: 'deliver' | 'cut' | ((command: string) => boolean)): RemoteRunner & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    run: async (args, stdin) => {
      const command = args.at(-1)!
      calls.push(command)
      const lose = mode === 'cut' || (typeof mode === 'function' && mode(command))
      const result = spawnSync('/bin/sh', ['-c', command], {
        // Only what the host shell would have: no GROK_HOME / COPILOT_HOME / XDG_* of the machine
        // running the tests may leak into the fake host.
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home },
        input: stdin === undefined ? undefined : lose ? '' : stdin,
        encoding: 'utf8'
      })
      if (result.error) throw result.error
      return { code: result.status ?? 1, stdout: result.stdout }
    }
  }
}

function seed(rel: string, content: string, mode = 0o644): string {
  const file = path.join(home, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
  chmodSync(file, mode)
  return file
}
const read = (rel: string) => readFileSync(path.join(home, rel), 'utf8')
const modeOf = (rel: string) => statSync(path.join(home, rel)).mode & 0o777
/** Every temp an interrupted write owns must be gone — they do not self-heal on the next write. */
function leftovers(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name)
      if (/^\.nodeterm-/.test(name) || name.endsWith('.nodeterm-lock')) out.push(path.relative(home, p))
      if (lstatSync(p).isDirectory()) walk(p)
    }
  }
  walk(home)
  return out
}
const warned = (needle: string) =>
  warn.mock.calls.some((args: unknown[]) => args.some((a) => typeof a === 'string' && a.includes(needle)))

describe.skipIf(process.platform === 'win32')('remote writes never leave a truncated file (real /bin/sh)', () => {
  it('a normal connect lands both shims whole, executable, with no temp left behind', async () => {
    const rh = new RemoteHooks(hostRunner('deliver'))
    await rh.installCanvasControl(conn, '/fixture.sock', home)
    await rh.installContextLink(conn, '/fixture.sock', home)

    expect(read('.nodeterm/nodeterm.sh')).toBe(CONTROL_SHIM_SCRIPT)
    expect(read('.nodeterm/context.sh')).toBe(CONTEXT_SHIM_SCRIPT)
    expect(modeOf('.nodeterm/nodeterm.sh')).toBe(0o755)
    expect(modeOf('.nodeterm/context.sh')).toBe(0o755)
    expect(read('.claude/skills/manage-nodeterm-canvas/SKILL.md')).toContain('name: manage-nodeterm-canvas')
    expect(read('.codex/AGENTS.md')).toContain('nodeterm:manage-canvas:start')
    expect(read('.codex/AGENTS.md')).toContain('nodeterm:get-linked-context:start')
    // opencode's path is expanded by the host shell ($XDG_CONFIG_HOME unset → $HOME/.config).
    expect(read('.config/opencode/AGENTS.md')).toContain('nodeterm:manage-canvas:start')
    expect(leftovers()).toEqual([])
  })

  it('the incident: a channel that dies before the body leaves the previous shims intact, and says so', async () => {
    seed('.nodeterm/nodeterm.sh', '#!/bin/sh\necho previous-good-shim\n', 0o755)
    seed('.nodeterm/context.sh', '#!/bin/sh\necho previous-good-context\n', 0o755)
    seed('.claude/skills/manage-nodeterm-canvas/SKILL.md', 'previous skill\n')

    const rh = new RemoteHooks(hostRunner('cut'))
    await rh.installCanvasControl(conn, '/fixture.sock', home)
    await rh.installContextLink(conn, '/fixture.sock', home)

    // On the old code both were 0 bytes here, and an agent's `sh nodeterm.sh list` exited 0.
    expect(read('.nodeterm/nodeterm.sh')).toBe('#!/bin/sh\necho previous-good-shim\n')
    expect(read('.nodeterm/context.sh')).toBe('#!/bin/sh\necho previous-good-context\n')
    expect(read('.claude/skills/manage-nodeterm-canvas/SKILL.md')).toBe('previous skill\n')
    expect(leftovers()).toEqual([])
    // Not a silent success: the failure is reported, naming the file and the cause.
    expect(warned(`${home}/.nodeterm/nodeterm.sh did not land (exit 65: the body did not arrive in full)`)).toBe(true)
    expect(warned(`${home}/.nodeterm/context.sh did not land`)).toBe(true)
  })

  it('a channel that dies before the body leaves every agent hook script intact', async () => {
    const agents = ['claude', 'gemini', 'codex', 'grok', 'copilot']
    for (const a of agents) seed(`.nodeterm/agent-hooks/${a}.sh`, `#!/bin/sh\n# previous ${a}\n`, 0o755)
    const rh = new RemoteHooks(hostRunner('cut'))
    const remoteDir = `${home}/.nodeterm`
    await rh['installJsonAgentRemote'](conn, '/fixture.sock', home, remoteDir, {
      agentId: 'claude', config: '.claude/settings.json', events: ['Stop']
    })
    await rh['installJsonAgentRemote'](conn, '/fixture.sock', home, remoteDir, {
      agentId: 'gemini', config: '.gemini/settings.json', events: ['AfterAgent']
    })
    await rh['installCodexRemote'](conn, '/fixture.sock', home, remoteDir)
    await rh['installGrokRemote'](conn, '/fixture.sock', home, remoteDir)
    await rh['installCopilotRemote'](conn, '/fixture.sock', home, remoteDir)
    await rh.installIntoAccountDir(conn, '/fixture.sock', home, 'acc')

    for (const a of agents) expect(read(`.nodeterm/agent-hooks/${a}.sh`)).toBe(`#!/bin/sh\n# previous ${a}\n`)
    expect(leftovers()).toEqual([])
    for (const a of ['claude', 'gemini', 'codex', 'grok', 'copilot']) expect(warned(`${a} status hook not installed`)).toBe(true)
  })

  it("the USER's config files keep their previous content when the body never arrives", async () => {
    const toml = 'model = "o3"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n'
    const hooks = '{\n  "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "my-own-hook" } ] } ] }\n}\n'
    const agents = '# my own agent notes\n'
    seed('.codex/config.toml', toml, 0o600)
    seed('.codex/hooks.json', hooks)
    seed('.codex/AGENTS.md', agents)
    seed('.gemini/GEMINI.md', agents)
    seed('.claude/settings.json', '{"model":"opus"}')

    // Only the bodies bound for the user's files are lost; our own scripts and shims land, so the
    // installers really do reach — and publish nothing into — the user's files.
    const usersFile = /(config\.toml|hooks\.json|AGENTS\.md|GEMINI\.md|settings\.json)/
    const rh = new RemoteHooks(hostRunner((command) => usersFile.test(command)))
    await rh['installCodexRemote'](conn, '/fixture.sock', home, `${home}/.nodeterm`)
    await rh['installJsonAgentRemote'](conn, '/fixture.sock', home, `${home}/.nodeterm`, {
      agentId: 'claude', config: '.claude/settings.json', events: ['Stop']
    })
    await rh.installCanvasControl(conn, '/fixture.sock', home)
    await rh.installContextLink(conn, '/fixture.sock', home)

    expect(read('.codex/config.toml')).toBe(toml)
    expect(read('.codex/hooks.json')).toBe(hooks)
    expect(read('.codex/AGENTS.md')).toBe(agents)
    expect(read('.gemini/GEMINI.md')).toBe(agents)
    expect(read('.claude/settings.json')).toBe('{"model":"opus"}')
    expect(modeOf('.codex/config.toml')).toBe(0o600)
    expect(leftovers()).toEqual([])
    // The installers did run: our own files landed beside the untouched user files.
    expect(read('.nodeterm/agent-hooks/codex.sh')).toContain('#!/bin/sh')
    expect(read('.nodeterm/nodeterm.sh')).toBe(CONTROL_SHIM_SCRIPT)
    expect(warned(`Remote file unchanged: ${home}/.codex/hooks.json`)).toBe(true)
    // The instruction files are named by their quoted path expression (this $HOME has a quote in it).
    expect(
      warn.mock.calls.some((args: unknown[]) =>
        args.some((a) => typeof a === 'string' && a.includes('Remote file unchanged') && a.includes('/.codex/AGENTS.md'))
      )
    ).toBe(true)
  })

  it("a delivered connect merges into the user's codex files, keeping their content, mode and links", async () => {
    const toml = 'model = "o3"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n'
    seed('.codex/config.toml', toml, 0o600)
    seed('.codex/hooks.json', '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"my-own-hook"}]}]}}')
    // A dotfile-managed AGENTS.md: the link must still be a link afterwards.
    const real = seed('dotfiles/AGENTS.md', '# my own agent notes\n')
    symlinkSync(real, path.join(home, '.codex', 'AGENTS.md'))

    const rh = new RemoteHooks(hostRunner('deliver'))
    await rh['installCodexRemote'](conn, '/fixture.sock', home, `${home}/.nodeterm`)
    await rh.installCanvasControl(conn, '/fixture.sock', home)

    const nextToml = read('.codex/config.toml')
    expect(nextToml.startsWith(toml)).toBe(true)
    expect(nextToml).toContain('trusted_hash = "sha256:')
    expect(modeOf('.codex/config.toml')).toBe(0o600)
    const nextHooks = JSON.parse(read('.codex/hooks.json'))
    expect(JSON.stringify(nextHooks)).toContain('my-own-hook')
    expect(JSON.stringify(nextHooks)).toContain('agent-hooks/codex.sh')
    expect(read('.nodeterm/agent-hooks/codex.sh')).toContain('#!/bin/sh')
    expect(modeOf('.nodeterm/agent-hooks/codex.sh')).toBe(0o755)
    expect(lstatSync(path.join(home, '.codex', 'AGENTS.md')).isSymbolicLink()).toBe(true)
    expect(readFileSync(real, 'utf8')).toMatch(/^# my own agent notes\n[\s\S]*nodeterm:manage-canvas:start/)
    expect(leftovers()).toEqual([])
  })

  it('an unreadable instruction file is left alone, not read as empty and replaced by our block', async () => {
    // The old `cat file 2>/dev/null || true` turned a read failure into '' and then wrote our block
    // alone over the user's file. A directory in the file's place is the portable read failure.
    mkdirSync(path.join(home, '.gemini', 'GEMINI.md'), { recursive: true })
    const rh = new RemoteHooks(hostRunner('deliver'))
    await rh.installCanvasControl(conn, '/fixture.sock', home)
    expect(lstatSync(path.join(home, '.gemini', 'GEMINI.md')).isDirectory()).toBe(true)
    expect(warned('Remote file unchanged')).toBe(true)
  })

  it('an empty body is refused before any ssh', async () => {
    const runner = hostRunner('deliver')
    const rh = new RemoteHooks(runner)
    await expect(
      rh['writeOwnedFile'](conn, '/fixture.sock', `${home}/.nodeterm/nodeterm.sh`, '', { mode: '755' })
    ).rejects.toThrow(/empty body/)
    expect(runner.calls).toEqual([])
    expect(existsSync(path.join(home, '.nodeterm'))).toBe(false)
  })
})
