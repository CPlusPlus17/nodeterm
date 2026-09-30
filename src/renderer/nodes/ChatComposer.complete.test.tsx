// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The ⌘M composer's `/` and `@` completion against the REAL component: it lists the node's catalog
 * and files, the keyboard drives it, accepting only INSERTS text (nothing reaches the pane, the send
 * stays the composer's own gated Enter), and hostile catalog text renders as text.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { api } = vi.hoisted(() => ({
  api: {
    pty: { sendText: vi.fn(async () => true as const) },
    chat: { catalog: vi.fn() },
    files: { quickOpen: vi.fn() }
  }
}))
vi.mock('../session/session', () => ({ useSession: () => ({ api }) }))

import { ChatComposer } from './ChatComposer'

let host: HTMLDivElement
let root: Root
let onSend: ReturnType<typeof vi.fn<() => void>>
let draft: () => string

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  onSend = vi.fn<() => void>()
  api.pty.sendText.mockClear()
  api.chat.catalog.mockReset()
  api.files.quickOpen.mockReset()
  api.chat.catalog.mockResolvedValue({
    version: 1,
    entries: [
      { name: 'git:commit', description: 'Commit staged work', kind: 'command', scope: 'project' },
      { name: 'co evil', description: 'dropped', kind: 'command', scope: 'project' },
      { name: 'xss', description: '<img src=x onerror=alert(1)>', kind: 'skill', scope: 'user' },
      { name: 'compact', description: 'Summarize', kind: 'builtin', scope: 'builtin' }
    ]
  })
  api.files.quickOpen.mockResolvedValue(['src/renderer/app.ts', 'src/renderer/my file.ts', 'README.md'])
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

function Harness({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState('')
  draft = () => value
  return (
    <ChatComposer
      nodeId="n1"
      agentId="claude"
      agentLabel="Agent"
      value={value}
      onChange={setValue}
      onSend={onSend}
      placeholder="Message"
      disabled={disabled}
      onWriteRefused={() => {}}
      cwd="/proj"
    />
  )
}

const ta = () => host.querySelector('textarea') as HTMLTextAreaElement
const options = () => [...host.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? '')

async function type(text: string): Promise<void> {
  const el = ta()
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, text)
    el.setSelectionRange(text.length, text.length)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  // Let the catalog / file promises settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}
async function key(k: string): Promise<KeyboardEvent> {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
  await act(async () => {
    ta().dispatchEvent(ev)
  })
  return ev
}

async function mount(disabled = false): Promise<void> {
  await act(async () => root.render(<Harness disabled={disabled} />))
}

describe('ChatComposer completion', () => {
  it('`/` lists the node catalog (asked with node, agent, account, cwd) and drops a bad name', async () => {
    await mount()
    await type('/co')
    expect(api.chat.catalog).toHaveBeenCalledWith('n1', 'claude', undefined, '/proj')
    const o = options()
    expect(o.some((t) => t.startsWith('/compact'))).toBe(true)
    expect(o.some((t) => t.startsWith('/git:commit'))).toBe(true)
    expect(o.some((t) => t.includes('evil'))).toBe(false)
    expect(ta().getAttribute('aria-expanded')).toBe('true')
  })

  it('a hostile description is text, never markup', async () => {
    await mount()
    await type('/xs')
    expect(options()[0]).toContain('<img src=x onerror=alert(1)>')
    expect(host.querySelector('.term-chat__complete img')).toBeNull()
  })

  it('Enter ACCEPTS (inserts text) and never sends or types into the pane; the next Enter sends', async () => {
    await mount()
    await type('/compa')
    const ev = await key('Enter')
    expect(ev.defaultPrevented).toBe(true)
    expect(draft()).toBe('/compact ')
    expect(onSend).not.toHaveBeenCalled()
    expect(api.pty.sendText).not.toHaveBeenCalled()
    expect(options()).toEqual([])
    await key('Enter')
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('a fully typed command is a message: Enter sends it (the menu does not swallow it)', async () => {
    await mount()
    await type('/compact')
    expect(options()[0]).toMatch(/^\/compact/)
    await key('Enter')
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(draft()).toBe('/compact')
  })

  it('arrows move the selection; Escape closes the menu without closing anything around it', async () => {
    await mount()
    await type('/')
    const first = host.querySelector('[aria-selected="true"]')?.textContent
    await key('ArrowDown')
    expect(host.querySelector('[aria-selected="true"]')?.textContent).not.toBe(first)
    const esc = await key('Escape')
    expect(esc.defaultPrevented).toBe(true)
    expect(options()).toEqual([])
    // With the menu closed, Enter is the ordinary send again.
    await key('Enter')
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('`@` lists the node files (no path with a space) and inserts `@path `', async () => {
    await mount()
    await type('look at @rend')
    expect(api.files.quickOpen).toHaveBeenCalledWith('/proj')
    expect(options()).toContain('@src/renderer/app.ts')
    expect(options().some((t) => t.includes('my file'))).toBe(false)
    await key('Tab')
    expect(draft()).toBe('look at @src/renderer/app.ts ')
  })

  it('a surface with no catalog (rejects) still offers the measured built-ins', async () => {
    api.chat.catalog.mockRejectedValue(Object.assign(new Error('x'), { code: 'E_UNSUPPORTED' }))
    await mount()
    await type('/mod')
    expect(options().some((t) => t.startsWith('/model'))).toBe(true)
  })

  it('mid-sentence slashes and a disabled composer open nothing', async () => {
    await mount()
    await type('see /us')
    expect(options()).toEqual([])
    await act(async () => root.render(<Harness disabled />))
    await type('/co')
    expect(options()).toEqual([])
  })
})
