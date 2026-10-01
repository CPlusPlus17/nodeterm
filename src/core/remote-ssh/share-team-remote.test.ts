import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  shareProbeCommand, parseShareProbe, teamCliCommand, parseTeamCliOutput,
  killVerifyCommand, parseKillVerify, paneCommandsByNode, SHARE_INSTALL_SCRIPT, SERVER_INSTALL_URL
} from './share-team-remote'

const run = promisify(execFile)
let dir: string, home: string, bin: string, state: string

const write = (p: string, body: string, mode = 0o644): void => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body, { mode })
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-share-'))
  home = path.join(dir, 'home')
  bin = path.join(dir, 'bin')
  state = path.join(dir, 'tmux-state')
  fs.mkdirSync(state, { recursive: true })
  fs.mkdirSync(path.join(home, 'proj'), { recursive: true })
  write(path.join(bin, 'uname'), '#!/bin/sh\necho Linux\n', 0o755)
  write(path.join(bin, 'id'), '#!/bin/sh\ncase "$1" in -u) echo 1000;; -un) echo alice;; esac\n', 0o755)
  write(path.join(bin, 'git'), '#!/bin/sh\nexit 0\n', 0o755)
  // A fake tmux: sessions are files in $STATE; a "*.stuck" one survives kill-session. Like real
  // tmux, a target WITHOUT the leading `=` that matches no session exactly falls back to a prefix
  // match, so a missing `=` in the generated command would kill a longer id's session.
  write(
    path.join(bin, 'tmux'),
    [
      '#!/bin/sh',
      `S=${JSON.stringify(state)}`,
      'cmd=""; target=""',
      'while [ $# -gt 0 ]; do case "$1" in -L) shift;; -t) shift; target="$1";; kill-session|has-session|list-panes) cmd="$1";; esac; shift; done',
      'name="${target#=}"',
      'exact=0; [ "$name" != "$target" ] && exact=1',
      'resolve() {',
      '  { [ -e "$S/$name" ] || [ -e "$S/$name.stuck" ]; } && return 0',
      '  [ "$exact" = 1 ] && return 1',
      '  for f in "$S/$name"*; do [ -e "$f" ] || continue; b=$(basename "$f"); name="${b%.stuck}"; return 0; done',
      '  return 1',
      '}',
      'case "$cmd" in',
      '  list-panes) for f in "$S"/*; do [ -e "$f" ] || continue; b=$(basename "$f"); b="${b%.stuck}"; echo "$b|$(cat "$f")"; done; exit 0;;',
      '  kill-session) resolve || exit 1; [ -e "$S/$name.stuck" ] && exit 0; rm -f "$S/$name"; exit 0;;',
      '  has-session) resolve && exit 0; exit 1;;',
      'esac',
      'exit 1'
    ].join('\n'),
    0o755
  )
  // A fake node that answers `team --help`, `team … status --json` and echoes argv + stdin for other verbs.
  write(
    path.join(bin, 'node'),
    [
      '#!/bin/sh',
      'shift', // main.cjs
      'case "$*" in',
      `  "team --help") printf 'usage: team <command>\\n  init  create\\n  bootstrap --owner-key <key>  set up\\n';;`,
      `  *" status --json") printf '{\\n  "enabled": true,\\n  "off": null\\n}\\n';;`,
      `  *" --no-newline") printf '{"a":1}';;`,
      `  *) printf '{"argv":"%s","stdin":"%s"}\\n' "$*" "$(cat | tr -d '\\n"')";;`,
      'esac'
    ].join('\n'),
    0o755
  )
  const main = path.join(home, '.nodeterm-server-app', 'out', 'server', 'main.cjs')
  write(main, '')
  write(
    path.join(home, '.config', 'systemd', 'user', 'nodeterm-server.service'),
    `[Service]\nEnvironment=NODETERM_HEADLESS=1\nExecStart=${path.join(bin, 'node')} ${main}\n`
  )
  write(path.join(home, '.nodeterm-server', 'install-meta.json'), '{"commit":"abc1234","installedAt":"x","version":"0.4.0"}\n')
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const sh = async (command: string, stdin?: string): Promise<string> => {
  const p = run('/bin/sh', ['-c', command], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } })
  if (stdin !== undefined) p.child.stdin?.end(stdin)
  return (await p).stdout
}

describe.skipIf(process.platform === 'win32')('share-team remote shell (real /bin/sh, fake host)', () => {
  it('probes a user install: unit, node, main, data dir, meta, bootstrap verb, status, real cwd, panes', async () => {
    fs.writeFileSync(path.join(state, 'nt-term-a'), 'claude')
    fs.writeFileSync(path.join(state, 'nt-term-b'), 'bash')
    const p = parseShareProbe(await sh(shareProbeCommand('~/proj')))
    if ('error' in p) throw new Error(p.error)
    expect(p).toMatchObject({
      os: 'Linux', uid: 1000, user: 'alice', home, unit: 'user', node: path.join(bin, 'node'),
      dataDir: path.join(home, '.nodeterm-server'), meta: { version: '0.4.0', commit: 'abc1234' },
      hasBootstrap: true, statusRc: 0, teamExists: true, adoptCwd: fs.realpathSync(path.join(home, 'proj')),
      have: { git: true, curl: expect.any(Boolean) } // curl is whatever /usr/bin holds on the test machine
    })
    expect(p.panes).toEqual(expect.arrayContaining([{ session: 'nt-term-a', command: 'claude' }, { session: 'nt-term-b', command: 'bash' }]))
    fs.rmSync(path.join(state, 'nt-term-a'))
    fs.rmSync(path.join(state, 'nt-term-b'))
  })
  // The system unit is an absolute host path, and a test machine may well run nodeterm-server as a
  // system service itself, so these point the check into the fake tree.
  it('a host with nothing installed and a missing folder', async () => {
    const bare = path.join(dir, 'bare-home')
    fs.mkdirSync(bare, { recursive: true })
    const cmd = shareProbeCommand('~/nope', path.join(dir, 'etc', 'no-such.service'))
    const out = (await run('/bin/sh', ['-c', cmd], { env: { HOME: bare, PATH: `${bin}:/usr/bin:/bin` } })).stdout
    const p = parseShareProbe(out)
    if ('error' in p) throw new Error(p.error)
    expect(p).toMatchObject({ unit: 'none', node: '', main: '', hasBootstrap: false, statusRc: null, adoptCwd: null, meta: null })
  })
  it('a system unit with no user unit is reported as system', async () => {
    const bare = path.join(dir, 'sys-home')
    fs.mkdirSync(bare, { recursive: true })
    const unit = path.join(dir, 'etc', 'nodeterm-server.service')
    write(unit, '[Service]\nExecStart=/usr/bin/node /opt/nodeterm/out/server/main.cjs\n')
    const out = (await run('/bin/sh', ['-c', shareProbeCommand('~', unit)], { env: { HOME: bare, PATH: `${bin}:/usr/bin:/bin` } })).stdout
    const p = parseShareProbe(out)
    if ('error' in p) throw new Error(p.error)
    expect(p).toMatchObject({ unit: 'system', node: '', main: '', adoptCwd: fs.realpathSync(bare) })
  })
  it('a cut-off probe is an error, never a half-filled probe', () => {
    expect(parseShareProbe("##NTP 1\n##OS Linux\n")).toMatchObject({ error: expect.any(String) })
    expect(parseShareProbe('')).toMatchObject({ error: expect.any(String) })
    // Cut after the unit line, and cut inside a block: neither reached ##END.
    expect(parseShareProbe('##NTP 1\n##OS Linux\n##UNIT none\n##CWD /p\n')).toMatchObject({ error: expect.any(String) })
    expect(parseShareProbe('##NTP 1\n##UNIT none\n##CWD /p\n##PANES\nnt-a|bash\n')).toMatchObject({ error: expect.any(String) })
    expect(parseShareProbe('##NTP 1\n##UNIT bogus\n##END\n')).toMatchObject({ error: expect.any(String) })
  })
  it('a hostile folder name cannot inject shell', async () => {
    const out = await sh(shareProbeCommand("~/x'; touch /tmp/nt-pwned-$$; '"))
    expect('error' in parseShareProbe(out)).toBe(false)
    expect(fs.readdirSync('/tmp').some((f) => f.startsWith('nt-pwned-'))).toBe(false)
    // Unquoted breakouts too: a separator and a command substitution in the folder name.
    for (const [name, marker] of [
      [`~/x; touch ${path.join(dir, 'pwned-a')}`, 'pwned-a'],
      [`/x$(touch ${path.join(dir, 'pwned-b')})`, 'pwned-b'],
      ['~/x`touch ' + path.join(dir, 'pwned-c') + '`', 'pwned-c']
    ]) {
      const p = parseShareProbe(await sh(shareProbeCommand(name)))
      expect(p).toMatchObject({ adoptCwd: null })
      expect(fs.existsSync(path.join(dir, marker))).toBe(false)
    }
  })
  it('runs the team CLI with argv quoted and stdin passed, fenced so login noise cannot corrupt it', async () => {
    const cmd = teamCliCommand({ node: path.join(bin, 'node'), main: '/x/main.cjs', dataDir: '/d d' }, ['resume', '--project', "p'1", '--json'])
    const r = parseTeamCliOutput('motd line\n' + (await sh(cmd, '[{"a":1}]')))
    if ('error' in r) throw new Error(r.error)
    expect(r.rc).toBe(0)
    expect(r.body).toEqual({ argv: "team --data-dir /d d resume --project p'1 --json", stdin: '[{a:1}]' })
  })
  it('a non-JSON CLI reply is an error that quotes it (bounded)', () => {
    expect(parseTeamCliOutput("##NTB\nboom\n##NTRC 1\n")).toMatchObject({ error: expect.stringContaining('boom') })
    const long = parseTeamCliOutput(`##NTB\n${'x'.repeat(5000)}\n##NTRC 1\n`)
    expect('error' in long && long.error.length < 400).toBe(true)
  })
  it('a quoted reply carries no control or text-direction characters', () => {
    const r = parseTeamCliOutput('##NTB\nab\u202Ecd\u001b[31m\n##NTRC 1\n')
    if (!('error' in r)) throw new Error('expected an error')
    expect(r.error).toContain('ab cd [31m')
  })
  it('a pretty-printed multi-line success parses as one value; a reply without a final newline keeps its rc', async () => {
    expect(parseTeamCliOutput('##NTB\n{\n  "ok": true\n}\n\n##NTRC 0\n')).toEqual({ rc: 0, body: { ok: true } })
    // The fake CLI prints its reply with no trailing newline: the rc marker must still land on its own line.
    const cmd = teamCliCommand({ node: path.join(bin, 'node'), main: '/x/main.cjs', dataDir: '/d' }, ['info', '--no-newline'])
    expect(parseTeamCliOutput(await sh(cmd))).toEqual({ rc: 0, body: { a: 1 } })
  })
  it('kills exactly the named sessions on nodeterm-rmt and verifies each; a dotted id maps through sessionName', async () => {
    for (const s of ['nt-term-1', 'nt-term-a_1', 'nt-term-12', 'nt-term-stuck.stuck']) fs.writeFileSync(path.join(state, s), 'x')
    const ids = ['term-1', 'term-a.1', 'term-stuck', 'term-never']
    const r = parseKillVerify(await sh(killVerifyCommand(ids)), ids)
    expect(r).toEqual([
      { nodeId: 'term-1', state: 'gone' },
      { nodeId: 'term-a.1', state: 'gone' },
      { nodeId: 'term-stuck', state: 'alive' },
      { nodeId: 'term-never', state: 'gone' }
    ])
    expect(fs.existsSync(path.join(state, 'nt-term-12'))).toBe(true) // exact target: a longer id is untouched
    for (const f of fs.readdirSync(state)) fs.rmSync(path.join(state, f))
  })
  it('a node with no session is gone without touching a session whose name it prefixes', async () => {
    fs.writeFileSync(path.join(state, 'nt-term-9x'), 'x')
    const r = parseKillVerify(await sh(killVerifyCommand(['term-9'])), ['term-9'])
    expect(r).toEqual([{ nodeId: 'term-9', state: 'gone' }])
    expect(fs.existsSync(path.join(state, 'nt-term-9x'))).toBe(true)
    fs.rmSync(path.join(state, 'nt-term-9x'))
  })
  it('a host where tmux cannot run reports every node unknown, never gone', async () => {
    const noTmux = path.join(dir, 'bin-notmux')
    fs.mkdirSync(noTmux, { recursive: true })
    write(path.join(noTmux, 'tmux'), '#!/bin/sh\nexit 127\n', 0o755)
    const out = (await run('/bin/sh', ['-c', killVerifyCommand(['term-1'])], { env: { HOME: home, PATH: `${noTmux}:/usr/bin:/bin` } })).stdout
    expect(parseKillVerify(out, ['term-1'])).toEqual([{ nodeId: 'term-1', state: 'unknown' }])
  })
  it('a kill reply missing a node is unknown for that node; a cut-off reply is an error', () => {
    expect(parseKillVerify("##NTK\n##K nt-a gone\n##NTKEND\n", ['a', 'b'])).toEqual([
      { nodeId: 'a', state: 'gone' }, { nodeId: 'b', state: 'unknown' }
    ])
    expect(parseKillVerify("##NTK\n##K nt-a gone\n", ['a'])).toMatchObject({ error: expect.any(String) })
  })
  it('maps panes to node ids through sessionName', () => {
    expect(paneCommandsByNode([{ session: 'nt-term-a_1', command: 'npm' }], ['term-a.1', 'term-b'])).toEqual({ 'term-a.1': 'npm' })
  })
  it('the install script downloads to a temp file (a curl failure is an error, not an empty bash run)', () => {
    expect(SHARE_INSTALL_SCRIPT).toContain(SERVER_INSTALL_URL)
    expect(SHARE_INSTALL_SCRIPT).not.toMatch(/\|\s*bash/)
  })
  it('the install script runs the download, passes its exit code through and removes the temp file', async () => {
    const curlBin = path.join(dir, 'bin-curl')
    const tmp = path.join(dir, 'install-tmp')
    fs.mkdirSync(tmp, { recursive: true })
    write(
      path.join(curlBin, 'curl'),
      [
        '#!/bin/sh',
        'out=""; url=""',
        'while [ $# -gt 0 ]; do case "$1" in -o) shift; out="$1";; -*) ;; *) url="$1";; esac; shift; done',
        '[ -n "$FAKE_CURL_FAIL" ] && exit 22',
        `printf 'echo "installer from %s"; exit 3\\n' "$url" > "$out"`
      ].join('\n'),
      0o755
    )
    const runInstall = async (fail: boolean): Promise<{ code: number; stdout: string; stderr: string }> => {
      const env = { HOME: home, TMPDIR: tmp, PATH: `${curlBin}:/usr/bin:/bin`, ...(fail ? { FAKE_CURL_FAIL: '1' } : {}) }
      try {
        const r = await run('/bin/sh', ['-c', SHARE_INSTALL_SCRIPT], { env })
        return { code: 0, stdout: r.stdout, stderr: r.stderr }
      } catch (e) {
        const err = e as { code: number; stdout: string; stderr: string }
        return { code: err.code, stdout: err.stdout, stderr: err.stderr }
      }
    }
    const ok = await runInstall(false)
    expect(ok).toMatchObject({ code: 3, stdout: `installer from ${SERVER_INSTALL_URL}\n` })
    const failed = await runInstall(true)
    expect(failed.code).toBe(1)
    expect(failed.stdout).toBe('')
    expect(failed.stderr).toContain('could not download the installer')
    expect(fs.readdirSync(tmp)).toEqual([])
  })
})
