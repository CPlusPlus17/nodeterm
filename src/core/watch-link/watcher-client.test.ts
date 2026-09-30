import { describe, it, expect } from 'vitest'
import {
  WATCHER_CLIENT_FLAGS,
  WINDOW_SIZE_FORMAT,
  localWatcherAttachArgs,
  localWindowSizeArgs,
  parseTmuxVersion,
  parseWindowSize,
  supportsWatcherClient
} from './watcher-client'

describe('localWatcherAttachArgs', () => {
  const args = localWatcherAttachArgs('sock', 'nt-abc')

  it('attaches (never creates), skips update-environment, and never sizes or types into the window', () => {
    expect(args).toEqual(['-L', 'sock', 'attach-session', '-E', '-f', 'ignore-size,read-only', '-t', '=nt-abc:'])
    expect(WATCHER_CLIENT_FLAGS).toBe('ignore-size,read-only')
  })

  it('has no create or take-over flag', () => {
    expect(args).not.toContain('new-session')
    expect(args).not.toContain('-A')
    expect(args).not.toContain('-D')
    expect(args).not.toContain('-d')
  })

  it('targets the session EXACTLY', () => {
    expect(args.filter((a) => a.includes('nt-abc'))).toEqual(['=nt-abc:'])
  })
})

describe('localWindowSizeArgs / parseWindowSize', () => {
  it('reads the window size of exactly this session', () => {
    expect(WINDOW_SIZE_FORMAT).toBe('#{window_width} #{window_height}')
    expect(localWindowSizeArgs('sock', 'nt-abc')).toEqual([
      '-L',
      'sock',
      'display-message',
      '-p',
      '-t',
      '=nt-abc:',
      '#{window_width} #{window_height}'
    ])
  })

  it('parses a real reply, CRLF included', () => {
    expect(parseWindowSize('120 39\n')).toEqual({ cols: 120, rows: 39 })
    expect(parseWindowSize('80 24')).toEqual({ cols: 80, rows: 24 })
    expect(parseWindowSize('80 24\r\n')).toEqual({ cols: 80, rows: 24 })
  })

  it('an exact-target miss (exit 0, every format empty) is no size, never 0x0', () => {
    for (const out of ['', ' \n', '\n', '0 24\n', '80 0\n', 'a b\n', '80\n', '80 24 1\n', ' 80 24\n']) {
      expect(parseWindowSize(out)).toBeUndefined()
    }
  })
})

describe('parseTmuxVersion / supportsWatcherClient', () => {
  it('reads the versions tmux actually prints', () => {
    expect(parseTmuxVersion('tmux 3.4\n')).toEqual({ major: 3, minor: 4 })
    expect(parseTmuxVersion('tmux 3.2a\n')).toEqual({ major: 3, minor: 2 })
    expect(parseTmuxVersion('tmux 3.1c')).toEqual({ major: 3, minor: 1 })
    expect(parseTmuxVersion('tmux next-3.6')).toEqual({ major: 3, minor: 6 })
    expect(parseTmuxVersion('tmux 2.9a')).toEqual({ major: 2, minor: 9 })
    expect(parseTmuxVersion('tmux 10.0')).toEqual({ major: 10, minor: 0 })
  })

  it('an unreadable version is null', () => {
    for (const out of ['', 'tmux master', 'not tmux', 'tmux 3']) expect(parseTmuxVersion(out)).toBeNull()
  })

  it('client flags (-f ignore-size,read-only) need tmux 3.2; unknown fails closed', () => {
    expect(supportsWatcherClient({ major: 3, minor: 2 })).toBe(true)
    expect(supportsWatcherClient({ major: 3, minor: 4 })).toBe(true)
    expect(supportsWatcherClient({ major: 4, minor: 0 })).toBe(true)
    expect(supportsWatcherClient({ major: 3, minor: 1 })).toBe(false)
    expect(supportsWatcherClient({ major: 2, minor: 9 })).toBe(false)
    expect(supportsWatcherClient(null)).toBe(false)
  })
})
