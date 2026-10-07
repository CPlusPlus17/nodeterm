// @vitest-environment jsdom
//
// Card modal parity with the canvas node: open on the ⌘M view when the card menu asked for it,
// set the node's color, and delete through the board's confirm — closing the modal first.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectKanban } from '@shared/types'
import { resetDialogStack } from '../dialog-stack'
import { CardModal } from './CardModal'
import type { KanbanSession } from './KanbanView'

vi.mock('../../session/session', () => ({
  useSession: () => ({ api: { pty: { generateName: vi.fn() }, shell: { openExternal: vi.fn() } } })
}))
vi.mock('./BoardLogPanel', () => ({ BoardLogPanel: () => null }))
vi.mock('./CardMetaBar', () => ({ CardMetaBar: () => null }))
vi.mock('../ContextMeter', () => ({ ContextMeter: () => null }))
vi.mock('./ModalTerminal', () => ({ ModalTerminal: () => <div className="kanban-modal__term" /> }))
vi.mock('../../nodes/TerminalMarkdownView', () => ({
  TerminalMarkdownView: () => <div className="md-view-mock" />
}))
vi.mock('../../nodes/ChatPanel', () => ({ ChatPanel: () => <div className="chat-panel-mock" /> }))

const board: ProjectKanban = { columns: [{ id: 'c1', title: 'To Do', color: '#fff' }], assignments: [] }
const session: KanbanSession = { id: 'n1', title: 'Shell', color: '#fff', kind: 'terminal', spawn: { cwd: '/p' } }

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  resetDialogStack()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = { onMarkdownToggle: () => () => {} }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  resetDialogStack()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

function render(extra: Partial<Parameters<typeof CardModal>[0]> = {}): void {
  act(() =>
    root.render(
      <CardModal
        projectId="p1"
        session={session}
        columnTitle="To Do"
        board={board}
        onChangeBoard={vi.fn()}
        onClose={vi.fn()}
        onOpenCanvas={vi.fn()}
        onRename={vi.fn()}
        onEditSticky={vi.fn()}
        onSetIcon={vi.fn()}
        onBrowserNav={vi.fn()}
        {...extra}
      />
    )
  )
}
const button = (label: string): HTMLButtonElement | null =>
  document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)

describe('CardModal — node actions in the header', () => {
  it('opens on the live terminal by default', () => {
    render()
    expect(document.querySelector('.md-view-mock')).toBeNull()
  })

  it('opens on the ⌘M view when the card menu asked for it', () => {
    render({ initialView: 'md' })
    expect(document.querySelector('.md-view-mock')).not.toBeNull()
    expect(button('Markdown view')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('Color opens the swatches and writes the picked color', () => {
    const onSetColor = vi.fn()
    render({ onSetColor })
    act(() => button('Color')!.click())
    act(() => document.body.querySelector<HTMLButtonElement>('button[aria-label="Blue"]')!.click())
    expect(onSetColor).toHaveBeenCalledWith('#0a84ff')
  })

  it('Delete closes the modal first, then asks the board (whose Delete confirms)', () => {
    const order: string[] = []
    render({ onClose: () => order.push('close'), onDelete: () => order.push('delete') })
    act(() => button('Delete')!.click())
    expect(order).toEqual(['close', 'delete'])
  })

  it('no Color or Delete button without a handler', () => {
    render()
    expect(button('Color')).toBeNull()
    expect(button('Delete')).toBeNull()
  })
})
