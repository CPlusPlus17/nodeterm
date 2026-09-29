// The freshness probe is generated shell that runs on someone else's machine, so it is tested the
// way this repo tests every such script: for real, under /bin/sh, against a fake host tree — plus
// the pure halves (the report parser and the cadence) on their own.
import { execFileSync, spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatCksum, posixCksum } from '../../core/remote-ssh/posix-cksum'
import { mergeCanvasControlBlock, frameCanvasControlBlock, CANVAS_CONTROL_MARKERS } from '../../core/canvas-control-core'
import { posixQuote } from '../../shared/ssh'
import {
  AGENT_TOOLS_RECHECK_MS,
  agentToolsCheckCommand,
  agentToolsCheckDue,
  parseAgentToolsReport,
  recordAgentToolsCheck,
  type ProbeEntry
} from './agent-tools-freshness'

const sum = (text: string) => formatCksum(posixCksum(Buffer.from(text, 'utf8')))
/** The formatted checksum the report holds for entry `i`, or its state when it holds none. */
function sumAt(report: ReturnType<typeof parseAgentToolsReport>, i: number): string {
  if (report?.kind !== 'report') return String(report?.kind)
  const s = report.statuses[i]
  return s.state === 'present' ? formatCksum(s.sum) : s.state
}
const { start: S, end: E } = CANVAS_CONTROL_MARKERS

let home: string
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "nt-fresh-' h-"))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

function put(rel: string, content: string): string {
  const p = path.join(home, rel)
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, content)
  return p
}

function runProbe(entries: ProbeEntry[], env: Record<string, string> = {}, pathVar?: string): string {
  const cmd = agentToolsCheckCommand(`NT_H=${posixQuote(home)}; `, entries, 'COPILOT_HOME')
  const r = spawnSync('/bin/sh', ['-c', cmd], {
    env: { PATH: pathVar ?? process.env.PATH ?? '/usr/bin:/bin', HOME: home, ...env },
    encoding: 'utf8'
  })
  if (r.error) throw r.error
  expect(r.status).toBe(0)
  return r.stdout
}

const file = (p: string, gateDir?: string): ProbeEntry => ({
  kind: 'file',
  pathExpr: posixQuote(p),
  ...(gateDir ? { gateDirExpr: posixQuote(gateDir) } : {})
})
const block = (pathExpr: string): ProbeEntry => ({ kind: 'block', pathExpr, start: S, end: E })

describe.skipIf(process.platform === 'win32')('the freshness probe (real /bin/sh)', () => {
  it('reports each owned file by the checksum of the bytes on disk', () => {
    const body = '#!/bin/sh\necho şimdi\n'
    const p = put('.nodeterm/nodeterm.sh', body)
    const report = parseAgentToolsReport(runProbe([file(p)]), 1)
    expect(report).toEqual({ kind: 'report', statuses: [{ state: 'present', sum: posixCksum(Buffer.from(body)) }], env: '' })
  })

  it('tells missing from unreadable, and never reads through a dangling link or a directory', () => {
    const dir = path.join(home, '.claude/skills/manage-nodeterm-canvas/SKILL.md')
    mkdirSync(dir, { recursive: true }) // a directory where the file should be
    const dangling = path.join(home, 'dangling.md')
    symlinkSync(path.join(home, 'nowhere'), dangling)
    const report = parseAgentToolsReport(
      runProbe([file(path.join(home, 'absent.sh')), file(dir), file(dangling)]),
      3
    )
    expect(report?.kind === 'report' && report.statuses.map((s) => s.state)).toEqual([
      'missing',
      'unreadable',
      'unreadable'
    ])
  })

  it('skips a gated file whose directory does not exist, and reads it when the directory does', () => {
    const acc = path.join(home, '.nodeterm/claude-accounts/acc-1')
    const gone = path.join(home, '.nodeterm/claude-accounts/gone')
    const skill = put('.nodeterm/claude-accounts/acc-1/skills/x/SKILL.md', 'x\n')
    const report = parseAgentToolsReport(
      runProbe([file(skill, acc), file(path.join(gone, 'skills/x/SKILL.md'), gone)]),
      2
    )
    expect(report?.kind === 'report' && report.statuses).toEqual([
      { state: 'present', sum: posixCksum(Buffer.from('x\n')) },
      { state: 'no-gate' }
    ])
  })

  it('checksums EXACTLY the span the merge would replace — so a current block matches, a stale one does not', () => {
    const current = mergeCanvasControlBlock('# my notes\r\n\r\nkeep me\n', 'the block\nsecond line')
    const p = put('.codex/AGENTS.md', `${current}trailing user text\n`)
    const stale = put('.gemini/GEMINI.md', mergeCanvasControlBlock('', 'an OLD block'))
    const report = parseAgentToolsReport(runProbe([block(posixQuote(p)), block(posixQuote(stale))]), 2)
    const want = frameCanvasControlBlock('the block\nsecond line')
    expect(report?.kind === 'report' && report.statuses[0]).toEqual({ state: 'present', sum: posixCksum(Buffer.from(want)) })
    expect(sumAt(report, 1)).not.toBe(sum(want))
  })

  it('an end marker BEFORE the start marker is no block at all, as the merge sees it', () => {
    // mergeCanvasControlBlock only replaces when the first end marker follows the first start
    // marker; otherwise it appends. The probe must not call such a file current.
    const p = put('.codex/AGENTS.md', `${E}\n${frameCanvasControlBlock('b')}\n`)
    const report = parseAgentToolsReport(runProbe([block(posixQuote(p))]), 1)
    expect(sumAt(report, 0)).toBe(sum(''))
  })

  it('evaluates a shell-expanded target through the $NT_H binding, and reports the env it was asked for', () => {
    put('.copilot/copilot-instructions.md', 'c\n')
    const expr = '"${COPILOT_HOME:-$NT_H/.copilot}/copilot-instructions.md"'
    const unset = parseAgentToolsReport(runProbe([{ kind: 'file', pathExpr: expr }]), 1)
    expect(unset).toEqual({ kind: 'report', statuses: [{ state: 'present', sum: posixCksum(Buffer.from('c\n')) }], env: '' })
    const hostile = '/x\nNT_END\n0 C 1 1'
    const set = parseAgentToolsReport(runProbe([{ kind: 'file', pathExpr: expr }], { COPILOT_HOME: hostile }), 1)
    // The env value is data: it can neither forge a status line nor end the report early.
    expect(set).toEqual({ kind: 'report', statuses: [{ state: 'missing' }], env: hostile })
  })

  it('a host with no cksum says so instead of reporting every file unreadable', () => {
    // A PATH holding every tool this machine has EXCEPT cksum (Ubuntu's own BusyBox build ships
    // without the applet, so "no cksum" is a real host, not a hypothetical one).
    const bin = mkdtempSync(path.join(tmpdir(), 'nt-no-cksum-'))
    try {
      for (const d of ['/usr/bin', '/bin']) {
        let names: string[] = []
        try {
          names = readdirSync(d)
        } catch {
          continue
        }
        for (const n of names) {
          if (n === 'cksum') continue
          try {
            symlinkSync(path.join(d, n), path.join(bin, n))
          } catch {
            // already linked from the other directory
          }
        }
      }
      const out = runProbe([file(put('a', 'a'))], {}, bin)
      expect(parseAgentToolsReport(out, 1)).toEqual({ kind: 'no-cksum', env: '' })
    } finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })

  it('agrees with the real cksum for the probe itself (no locale or newline drift)', () => {
    const body = 'x'.repeat(3000) + '\n'
    const p = put('f', body)
    const report = parseAgentToolsReport(runProbe([file(p)]), 1)
    const real = execFileSync('cksum', [p], { encoding: 'utf8' }).split(' ').slice(0, 2).join(' ')
    expect(sumAt(report, 0)).toBe(real)
  })
})

/**
 * The probe runs in the HOST's login shell with the host's awk: dash, bash, zsh or BusyBox ash, with
 * mawk, gawk, BusyBox awk or the one-true awk macOS ships. Every combination this machine has must
 * produce the same report, and the same checksums the local side computes. (Combinations that are
 * absent are skipped; `NT_PROBE_EXTRA_AWK` / `NT_PROBE_EXTRA_SH` add binaries for a one-off run —
 * e.g. an extracted `original-awk`, the macOS dialect.)
 */
describe.skipIf(process.platform === 'win32')('the probe under every sh × awk on this machine', () => {
  const which = (bin: string) => {
    const r = spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' })
    return r.status === 0 ? r.stdout.trim() : null
  }
  const busybox = which('busybox')
  const busyboxHas = (applet: string) =>
    !!busybox && spawnSync(busybox, ['--list'], { encoding: 'utf8' }).stdout.split('\n').includes(applet)
  const shells: [string, string[]][] = [
    ...['dash', 'bash', 'zsh'].flatMap((n): [string, string[]][] => (which(n) ? [[n, [which(n)!]]] : [])),
    ...(busyboxHas('sh') ? [['busybox sh', [busybox!, 'sh']] as [string, string[]]] : []),
    ...(process.env.NT_PROBE_EXTRA_SH ?? '').split(':').filter(Boolean).map((p): [string, string[]] => [p, [p]])
  ]
  const awks: [string, string][] = [
    ...['mawk', 'gawk'].flatMap((n): [string, string][] => (which(n) ? [[n, which(n)!]] : [])),
    ...(busyboxHas('awk') ? [['busybox awk', busybox!] as [string, string]] : []),
    ...(process.env.NT_PROBE_EXTRA_AWK ?? '').split(':').filter(Boolean).map((p): [string, string] => [p, p])
  ]
  const combos = shells.flatMap(([sn, sh]) => awks.map(([an, awk]) => [`${sn} + ${an}`, sh, awk] as const))

  it.each(combos)('%s', (_name, sh, awk) => {
    const texts = {
      current: `# notes ş\n${frameCanvasControlBlock('line one\nline — two')}\nafter\n`,
      crlf: frameCanvasControlBlock('a\nb').replace(/\n/g, '\r\n'),
      endFirst: `${E}\n${frameCanvasControlBlock('b')}`,
      none: 'no block here\n',
      noNewline: `x${frameCanvasControlBlock('tail')}`
    }
    const entries: ProbeEntry[] = Object.entries(texts).map(([n, t]) => block(posixQuote(put(`${n}.md`, t))))
    entries.push(file(put('owned.sh', '#!/bin/sh\necho ğ\n')))
    // `awk` is whichever dialect this combination names; every other tool is the machine's own.
    const bin = mkdtempSync(path.join(tmpdir(), 'nt-probe-bin-'))
    try {
      if (awk.endsWith('busybox')) writeFileSync(path.join(bin, 'awk'), `#!/bin/sh\nexec ${awk} awk "$@"\n`, { mode: 0o755 })
      else symlinkSync(awk, path.join(bin, 'awk'))
      const cmd = agentToolsCheckCommand(`NT_H=${posixQuote(home)}; `, entries, 'COPILOT_HOME')
      const r = spawnSync(sh[0], [...sh.slice(1), '-c', cmd], {
        env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: home },
        encoding: 'utf8'
      })
      expect(r.status).toBe(0)
      const report = parseAgentToolsReport(r.stdout, entries.length)
      expect([0, 1, 2, 3, 4, 5].map((i) => sumAt(report, i))).toEqual([
        sum(frameCanvasControlBlock('line one\nline — two')),
        sum(texts.crlf), // CR stays inside its line: the span is the file's own bytes
        sum(''), // end before start: no block, as the merge sees it
        sum(''),
        sum(frameCanvasControlBlock('tail')),
        sum('#!/bin/sh\necho ğ\n')
      ])
    } finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })
})

describe('parseAgentToolsReport', () => {
  const ok = 'NT_AGENT_TOOLS_CHECK 1\n0 C 1 2\n1 M\n2 U\n3 D\nNT_ENV COPILOT_HOME=/c\nNT_END\n'

  it('reads a well-formed report, tolerating a login banner before it', () => {
    expect(parseAgentToolsReport(`Welcome!\n${ok}`, 4)).toEqual({
      kind: 'report',
      statuses: [
        { state: 'present', sum: { crc: 1, size: 2 } },
        { state: 'missing' },
        { state: 'unreadable' },
        { state: 'no-gate' }
      ],
      env: '/c'
    })
  })

  it('refuses a report that is cut short, out of order, over-long or malformed — never guesses', () => {
    const bad = [
      '',
      'NT_AGENT_TOOLS_CHECK 1\n0 C 1 2\n', // no end
      ok.replace('\nNT_END\n', '\n'), // no end sentinel
      ok.replace('1 M', '2 M'), // out of order
      ok.replace('3 D\n', ''), // too few
      ok.replace('3 D\n', '3 D\n4 M\n'), // too many
      ok.replace('0 C 1 2', '0 C one 2'), // not a checksum
      ok.replace('2 U', '2 X'), // unknown status
      ok.replace('NT_AGENT_TOOLS_CHECK 1', 'NT_AGENT_TOOLS_CHECK 2') // a version we do not speak
    ]
    for (const b of bad) expect(parseAgentToolsReport(b, 4)).toBeNull()
  })
})

describe('agentToolsCheckDue — how often a host is looked at', () => {
  const t0 = 1_000_000_000

  it('a connect or a tunnel repair always checks: a master just came up', () => {
    const verified = recordAgentToolsCheck(undefined, 'set', true, t0)
    expect(agentToolsCheckDue(verified, 'set', t0 + 1, 'connect')).toBe(true)
    expect(agentToolsCheckDue(verified, 'set', t0 + 1, 'repair')).toBe(true)
  })

  it('the 45 s reuse branch costs nothing once this run has confirmed the host', () => {
    const verified = recordAgentToolsCheck(undefined, 'set', true, t0)
    expect(agentToolsCheckDue(verified, 'set', t0 + 45_000, 'reuse')).toBe(false)
    expect(agentToolsCheckDue(verified, 'set', t0 + AGENT_TOOLS_RECHECK_MS - 1, 'reuse')).toBe(false)
  })

  it('…and looks again once an hour, because another desktop may have written its own version', () => {
    const verified = recordAgentToolsCheck(undefined, 'set', true, t0)
    expect(agentToolsCheckDue(verified, 'set', t0 + AGENT_TOOLS_RECHECK_MS, 'reuse')).toBe(true)
  })

  it('a host never confirmed this run is checked on the next reuse tick', () => {
    expect(agentToolsCheckDue(undefined, 'set', t0, 'reuse')).toBe(true)
  })

  it('a different expected set (an account added, a new home) is unconfirmed', () => {
    const verified = recordAgentToolsCheck(undefined, 'set', true, t0)
    expect(agentToolsCheckDue(verified, 'other', t0 + 1, 'reuse')).toBe(true)
  })

  it('a failing host backs off on the reuse branch instead of retrying every tick', () => {
    let s = recordAgentToolsCheck(undefined, 'set', false, t0)
    expect(agentToolsCheckDue(s, 'set', t0 + 45_000, 'reuse')).toBe(false)
    expect(agentToolsCheckDue(s, 'set', t0 + 60_000, 'reuse')).toBe(true)
    s = recordAgentToolsCheck(s, 'set', false, t0 + 60_000)
    s = recordAgentToolsCheck(s, 'set', false, t0 + 400_000)
    // settles at one attempt per 15 minutes
    expect(agentToolsCheckDue(s, 'set', t0 + 400_000 + 899_000, 'reuse')).toBe(false)
    expect(agentToolsCheckDue(s, 'set', t0 + 400_000 + 900_000, 'reuse')).toBe(true)
  })

  it('a success resets the backoff and a failure keeps the earlier confirmation', () => {
    let s = recordAgentToolsCheck(undefined, 'set', true, t0)
    s = recordAgentToolsCheck(s, 'set', false, t0 + AGENT_TOOLS_RECHECK_MS)
    expect(s.verified).toEqual({ setId: 'set', at: t0 })
    expect(s.failures).toBe(1)
    s = recordAgentToolsCheck(s, 'set', true, t0 + AGENT_TOOLS_RECHECK_MS + 60_000)
    expect(s.failures).toBe(0)
  })
})
