import { describe, it, expect } from 'vitest'
import {
  VISIBLE_CAPTURE_FORMAT,
  exactPaneTarget,
  localCaptureVisibleArgs,
  parseVisibleCapture,
  unavailableCapture,
  visibleCaptureRoute
} from './capture-route'

describe('visibleCaptureRoute', () => {
  it('never routes to a capture that returns history', () => {
    expect(visibleCaptureRoute({ sessionHost: {} }, true)).toBe('none')
    expect(visibleCaptureRoute({ nativeWindowsPane: {} }, true)).toBe('none')
    expect(visibleCaptureRoute({ sshRemote: {} }, true)).toBe('ssh')
    expect(visibleCaptureRoute({ tmuxBacked: true }, true)).toBe('tmux')
    expect(visibleCaptureRoute({ tmuxBacked: true }, false)).toBe('none')
    expect(visibleCaptureRoute({ tmuxBacked: false }, true)).toBe('none')
  })

  it('a session-host session is none even when it is also marked tmux-backed or remote', () => {
    // The session host's only capture is ~200 lines of scrollback; nothing may route around that.
    expect(visibleCaptureRoute({ sessionHost: true, tmuxBacked: true }, true)).toBe('none')
    expect(visibleCaptureRoute({ sessionHost: true, sshRemote: {} }, true)).toBe('none')
    expect(visibleCaptureRoute({ nativeWindowsPane: {}, tmuxBacked: true }, true)).toBe('none')
  })
})

describe('exactPaneTarget', () => {
  it('is the exact-session, active-pane spelling measured on tmux 3.4', () => {
    // `=name` alone is "can't find pane" for capture-pane (and silently EMPTY for display-message);
    // a bare `name` prefix-matches another node's session. Only `=name:` is exact AND resolves.
    expect(exactPaneTarget('nt-abc')).toBe('=nt-abc:')
  })
})

describe('localCaptureVisibleArgs', () => {
  const args = localCaptureVisibleArgs('sock', 'nt-abc')

  it('captures the visible screen with SGR and asks for the cursor in the SAME invocation', () => {
    expect(args).toEqual([
      '-L',
      'sock',
      'capture-pane',
      '-p',
      '-e',
      '-t',
      '=nt-abc:',
      ';',
      'display-message',
      '-p',
      '-t',
      '=nt-abc:',
      VISIBLE_CAPTURE_FORMAT
    ])
  })

  it('never asks for history', () => {
    expect(args).not.toContain('-S')
    expect(args).not.toContain('-a')
  })

  it('targets EXACTLY — never a bare name tmux would prefix-match', () => {
    expect(args.filter((a) => a.includes('nt-abc'))).toEqual(['=nt-abc:', '=nt-abc:'])
  })

  it('asks for the cursor and the alternate-screen flag', () => {
    expect(VISIBLE_CAPTURE_FORMAT).toBe('#{cursor_x} #{cursor_y} #{alternate_on}')
  })
})

describe('parseVisibleCapture', () => {
  it('splits the trailing cursor line off a real tmux 3.4 reply', () => {
    // Measured: a 20x4 pane after 10 lines of output — only the visible rows, then the cursor line.
    expect(parseVisibleCapture('L8\nL9\nL10\n\n0 3 0\n')).toEqual({
      screen: 'L8\nL9\nL10\n\n',
      cursor: { x: 0, y: 3 },
      altScreen: false
    })
  })

  it('reads the alternate-screen flag', () => {
    expect(parseVisibleCapture('\n  ALT\n\n\n5 1 1\n')).toEqual({
      screen: '\n  ALT\n\n\n',
      cursor: { x: 5, y: 1 },
      altScreen: true
    })
  })

  it('keeps the screen byte-identical to what capture-pane printed on its own', () => {
    const screen = '\u001b[1mbold\u001b[0m\nplain\n'
    expect(parseVisibleCapture(`${screen}12 1 0\n`).screen).toBe(screen)
  })

  it('an empty screen is an empty string, not the cursor line', () => {
    expect(parseVisibleCapture('0 0 0\n')).toEqual({
      screen: '',
      cursor: { x: 0, y: 0 },
      altScreen: false
    })
  })

  it('a screen whose own last line looks like a cursor line keeps that line', () => {
    // Only the LAST line is the cursor; a numeric-ish row above it is screen text.
    expect(parseVisibleCapture('10 20 1\n3 4 0\n')).toEqual({
      screen: '10 20 1\n',
      cursor: { x: 3, y: 4 },
      altScreen: false
    })
  })

  it('reads CRLF line endings', () => {
    expect(parseVisibleCapture('a\r\nb\r\n7 1 1\r\n')).toEqual({
      screen: 'a\r\nb\r\n',
      cursor: { x: 7, y: 1 },
      altScreen: true
    })
  })

  it('without a cursor line the whole output is the screen and the cursor is unknown', () => {
    for (const out of ['a\nb\n', 'a\nb', 'a\n3 4 5\n', 'a\n3 4\n', 'a\nx 1 0\n', 'a\n  \n', '']) {
      expect(parseVisibleCapture(out)).toEqual({ screen: out, cursor: null, altScreen: null })
    }
  })

  it('does not accept a padded or signed cursor line', () => {
    for (const line of [' 1 2 0', '1 2 0 ', '-1 2 0', '1  2 0', '1\t2\t0']) {
      const out = `s\n${line}\n`
      expect(parseVisibleCapture(out)).toEqual({ screen: out, cursor: null, altScreen: null })
    }
  })
})

describe('unavailableCapture', () => {
  it('is an empty screen with nothing known', () => {
    expect(unavailableCapture()).toEqual({ screen: '', cursor: null, altScreen: null })
  })

  it('is a fresh object each time (a caller may mutate what it was handed)', () => {
    expect(unavailableCapture()).not.toBe(unavailableCapture())
  })
})
