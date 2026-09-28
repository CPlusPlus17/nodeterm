// opencode's conversation as the ⌘M panel's structured messages — and the bounded read behind it.
//
// Separate from `transcript-reader.ts`'s claude parser and from `grok-chat.ts`: opencode has no
// transcript FILE. Since 1.18 it keeps sessions in SQLite (a database that also holds its account
// tokens, so it is never opened here), and `opencode export <id>` is the contract — the same one
// Context Link reads (`linesFromOpencodeExport`). One export is ONE JSON document, so there are no
// byte offsets to page by: a read returns one page (`olderCursor: null`), exactly as grok does.
//
// MEASURED on opencode 1.18.25 (2026-09-28) — every shape below comes from its schema (the Effect
// structs `UserMessage` / `AssistantMessage` / `Part` in the shipped binary) and was checked against
// the 10 sessions, 25 messages and 65 parts on the measuring host:
//
//   document   {info: Session, messages: [{info: Message, parts: Part[]}]}; `info.id` is the session
//   user       info {id, sessionID, role:"user", time:{created}, agent, model:{providerID, modelID,
//              variant?}, summary?, system?, tools?}
//   assistant  info {id, sessionID, role:"assistant", parentID, modelID, providerID, mode, agent,
//              path, cost, tokens, time:{created, completed?}, finish?, variant?, summary?:true
//              (a compaction summary), error?: {name, data:{message?, …}}}
//   parts      text {text, synthetic?, ignored?, time?} · reasoning {text, time} · tool {callID,
//              tool, state} · file {mime, url, filename?} · agent {name} · subtask {prompt,
//              description, agent, command?} · compaction {auto, overflow?} · retry {attempt, error}
//              · step-start · step-finish · snapshot · patch
//   tool state pending {input, raw} · running {input, title?, time} · completed {input, output,
//              title, metadata, time} · error {input, error, time}
//   errors     ProviderAuthError · UnknownError · MessageOutputLengthError (data {}) ·
//              MessageAbortedError · StructuredOutputError · ContextOverflowError ·
//              ContentFilterError · APIError — all `{name, data}`
//
// Every mapping rule is written down in `src/shared/chat-fixtures/opencode/README.md` for the iOS
// port, and pinned by the golden fixtures there.
import type { ChatMessage, ChatPart, ChatTranscriptResult } from '../shared/types'
import { CHAT_TOOL_ARG_MAX } from '../shared/chat-command'
import { CHAT_PAGE_MAX_BYTES, type ChatTranscriptPage } from '../shared/chat-page'
import { findInLoginPath } from './exec-path'
import { isSafeOpencodeSessionId, runOpencodeExportAt, type OpencodeExportOutcome } from './opencode-export'

/** Same bounds as claude's reader (`summarizeResult` / `metaString`). */
const TOOL_RESULT_LINES = 3
const TOOL_RESULT_MAX = 500
const CHAT_META_MAX_CHARS = 100

type ToolPart = Extract<ChatPart, { kind: 'tool' }>

export interface OpencodeChatParse {
  messages: ChatMessage[]
  /** Records that could not be mapped (not an object, no `info`, an unknown role or part type, a
   *  message filed under another session, a malformed field). Skipped, never rendered raw. */
  skipped: number
  /** The newest assistant message's `modelID` — absent when it states none (never carried). */
  model?: string
  /** The newest assistant message's `variant` (opencode's reasoning-effort variant). */
  effort?: string
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function metaString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= CHAT_META_MAX_CHARS ? v : undefined
}

function summarize(text: string): string {
  return text.split('\n').slice(0, TOOL_RESULT_LINES).join(' ').slice(0, TOOL_RESULT_MAX)
}

/**
 * The one input worth showing on a collapsed tool chip, for opencode's builtin tools (bash
 * `command`, read/write/edit `filePath`, grep/glob `pattern`, list `path`, webfetch `url`,
 * websearch/codesearch `query`, task `description`/`prompt`, skill `name`, question
 * `questions[0].question`). The key ORDER is the rule: `pattern` before `path`, because a grep's
 * meaning is its pattern. Else the `title` opencode wrote for the call, else nothing. Capped like
 * every tool arg (`CHAT_TOOL_ARG_MAX` UTF-16 units).
 */
export function opencodeToolArg(input: unknown, title?: unknown): string {
  let v: unknown
  if (isObj(input)) {
    for (const k of ['command', 'filePath', 'file_path', 'pattern', 'path', 'url', 'query', 'description', 'prompt', 'name']) {
      if (typeof input[k] === 'string') {
        v = input[k]
        break
      }
    }
    if (v === undefined && Array.isArray(input.questions) && isObj(input.questions[0])) {
      const q = input.questions[0].question
      if (typeof q === 'string') v = q
    }
  }
  if (v === undefined && typeof title === 'string') v = title
  return typeof v === 'string' ? v.slice(0, CHAT_TOOL_ARG_MAX) : ''
}

/** A tool part's chip. `null` = not a mappable tool part. */
function toolPart(p: Record<string, unknown>): ToolPart | null {
  const state = p.state
  if (!isObj(state)) return null
  const part: ToolPart = {
    kind: 'tool',
    name: typeof p.tool === 'string' && p.tool ? p.tool : 'tool',
    arg: opencodeToolArg(state.input, state.title)
  }
  // Claude-only card fields (`body`, `questions`) and the paged `id` are never set: opencode's
  // `question` tool looks like AskUserQuestion, but answer cards are claude's, and this reader does
  // not page.
  if (state.status === 'completed' && typeof state.output === 'string') {
    const s = summarize(state.output)
    if (s) part.result = s
  } else if (state.status === 'error' && typeof state.error === 'string') {
    part.result = summarize(`Error: ${state.error}`)
  }
  return part
}

/** The sentence an errored assistant message ends with. `null` = malformed (counted as skipped). */
function errorText(e: unknown): string | null {
  if (!isObj(e)) return null
  const name = typeof e.name === 'string' && e.name ? e.name : 'Error'
  const message = isObj(e.data) && typeof e.data.message === 'string' ? e.data.message.trim() : ''
  return message ? `[${name}] ${message}` : `[${name}]`
}

/** Parts dropped ON PURPOSE (not counted as skipped): model reasoning (the same product decision
 *  claude's and grok's readers make) and bookkeeping that is not conversation. `file` and `agent`
 *  are attachments and @-mentions; their text is already in the prompt, and claude's reader drops
 *  non-text user content the same way. */
const DROPPED_PARTS = new Set(['reasoning', 'step-start', 'step-finish', 'snapshot', 'patch', 'retry', 'file', 'agent'])

/**
 * One `opencode export` document → ordered bubbles. `null` when the text is not an export of
 * `sessionId` — not JSON, not an object, or `info.id` names another session. That check is what
 * makes "never another session's transcript" a property of the parser rather than of the caller.
 */
export function parseOpencodeExport(raw: string, sessionId: string): OpencodeChatParse | null {
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObj(doc) || !isObj(doc.info) || doc.info.id !== sessionId) return null

  const messages: ChatMessage[] = []
  let skipped = 0
  let lastAssistant: Record<string, unknown> | undefined
  const entries = Array.isArray(doc.messages) ? doc.messages : []
  for (const entry of entries) {
    if (!isObj(entry) || !isObj(entry.info)) {
      skipped++
      continue
    }
    const info = entry.info
    // A message filed under another session is never shown, even inside this session's export.
    if (info.sessionID !== undefined && info.sessionID !== sessionId) {
      skipped++
      continue
    }
    const role = info.role
    if ((role !== 'user' && role !== 'assistant') || !Array.isArray(entry.parts)) {
      skipped++
      continue
    }
    const created = isObj(info.time) ? info.time.created : undefined
    const at = typeof created === 'number' && Number.isFinite(created) ? created : undefined
    const stamp = (m: ChatMessage): ChatMessage => (at === undefined ? m : { ...m, at })

    // `own` = the speaker's parts; `chips` = what a USER message carries that the human did not
    // type (a compaction, a subtask): an assistant-side tool chip right after, never a user bubble.
    const own: ChatPart[] = []
    const chips: ChatPart[] = []
    for (const p of entry.parts) {
      if (!isObj(p) || typeof p.type !== 'string') {
        skipped++
        continue
      }
      switch (p.type) {
        case 'text':
          if (typeof p.text !== 'string') {
            skipped++
            break
          }
          // Harness text (`synthetic`: an @-mentioned file read in full, "the following tool was
          // executed by the user") and `ignored` text were not written by the speaker.
          if (p.synthetic === true || p.ignored === true || !p.text) break
          own.push({ kind: 'text', text: p.text })
          break
        case 'tool': {
          const t = toolPart(p)
          if (t) (role === 'user' ? chips : own).push(t)
          else skipped++
          break
        }
        case 'compaction':
          chips.push({ kind: 'tool', name: 'compaction', arg: p.auto === true ? 'auto' : '' })
          break
        case 'subtask':
          chips.push({ kind: 'tool', name: 'task', arg: opencodeToolArg({ description: p.description, prompt: p.prompt }) })
          break
        default:
          if (!DROPPED_PARTS.has(p.type)) skipped++
      }
    }

    if (role === 'assistant') {
      lastAssistant = info
      if (info.error !== undefined) {
        const t = errorText(info.error)
        if (t === null) skipped++
        else own.push({ kind: 'text', text: t })
      }
      const parts = [...own, ...chips]
      if (parts.length) messages.push(stamp({ role: 'assistant', parts }))
    } else {
      if (own.length) messages.push(stamp({ role: 'user', parts: own }))
      if (chips.length) messages.push(stamp({ role: 'assistant', parts: chips }))
    }
  }

  const out: OpencodeChatParse = { messages, skipped }
  // ONE message answers both fields; an absent field is absent, never carried from an older one.
  const model = metaString(lastAssistant?.modelID)
  const effort = metaString(lastAssistant?.variant)
  if (model !== undefined) out.model = model
  if (effort !== undefined) out.effort = effort
  return out
}

/** The newest messages whose JSON fits in `maxBytes` (UTF-8), in order. One export is one page,
 *  and a page stays within the legacy read's cap (`CHAT_PAGE_MAX_BYTES`) — it crosses the relay
 *  to a phone. Like grok's capped tail, the cut is not announced (`olderCursor` stays null). */
export function newestWithinBytes(messages: ChatMessage[], maxBytes: number): ChatMessage[] {
  let total = 0
  let i = messages.length
  while (i > 0) {
    const size = Buffer.byteLength(JSON.stringify(messages[i - 1]))
    if (total + size > maxBytes) break
    total += size
    i--
  }
  return messages.slice(i)
}

// ── The export gate ─────────────────────────────────────────────────────────────────────────────

export type OpencodeExportRun = (sessionId: string) => Promise<OpencodeExportOutcome>

export interface OpencodeExportGateOptions {
  /** Minimum time between two export STARTS for one session. */
  minSpacingMs: number
  /** Most exports running at once, across sessions. */
  maxConcurrent: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * One export costs 1.0–1.7 s and ~320 MB (measured), and the ⌘M panel re-reads on every hook event
 * while the agent works — from the canvas node, the card modal and the phone at once. The gate:
 *
 *  - joins a caller to an export that has not STARTED yet (its answer is still fresh for them);
 *  - gives a caller arriving while one RUNS a new export started after it — never a stale answer,
 *    which would leave the panel's final turn-end read one turn behind — shared by every such caller;
 *  - spaces starts for one session by `minSpacingMs`, and caps exports running at once;
 *  - caches nothing: a failure is answered once and the next call runs again.
 */
export function createOpencodeExportGate(run: OpencodeExportRun, opts: OpencodeExportGateOptions): OpencodeExportRun {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  interface Session {
    waiting?: Promise<OpencodeExportOutcome>
    running?: Promise<OpencodeExportOutcome>
    lastStart: number
  }
  const sessions = new Map<string, Session>()
  let active = 0
  const queue: Array<() => void> = []
  const acquire = (): Promise<void> => {
    if (active < opts.maxConcurrent) {
      active++
      return Promise.resolve()
    }
    return new Promise((r) => queue.push(r))
  }
  const release = (): void => {
    const next = queue.shift()
    if (next) next()
    else active--
  }
  const prune = (): void => {
    const t = now()
    for (const [id, s] of sessions) {
      if (!s.waiting && !s.running && t - s.lastStart > opts.minSpacingMs) sessions.delete(id)
    }
  }

  return (sessionId) => {
    prune()
    let s = sessions.get(sessionId)
    if (!s) {
      s = { lastStart: -Infinity }
      sessions.set(sessionId, s)
    }
    const st = s
    if (st.waiting) return st.waiting
    // Assigned before its body's first `await` returns, so the body can recognise itself.
    let job!: Promise<OpencodeExportOutcome>
    job = (async () => {
      if (st.running) await st.running
      const wait = st.lastStart + opts.minSpacingMs - now()
      if (wait > 0) await sleep(wait)
      await acquire()
      // Started: later callers get the NEXT export, not this one.
      if (st.waiting === job) st.waiting = undefined
      st.lastStart = now()
      const running = (async (): Promise<OpencodeExportOutcome> => {
        try {
          return await run(sessionId)
        } catch {
          return { ok: false }
        } finally {
          release()
        }
      })()
      st.running = running
      const out = await running
      if (st.running === running) st.running = undefined
      return out
    })()
    st.waiting = job
    return job
  }
}

/** A chat export is interactive: 20 s is ~10× the measured cost, and a wedged CLI must not hold the
 *  panel's single-flight read for Context Link's full minute. */
export const OPENCODE_CHAT_EXPORT_TIMEOUT_MS = 20_000

let defaultExport: OpencodeExportRun | undefined
/** The real, gated `opencode export` — resolved through the login PATH like Context Link's. */
export function defaultOpencodeExport(): OpencodeExportRun {
  defaultExport ??= createOpencodeExportGate(
    async (sessionId) => {
      const bin = await findInLoginPath('opencode')
      return bin ? runOpencodeExportAt(bin, sessionId, OPENCODE_CHAT_EXPORT_TIMEOUT_MS) : { ok: false }
    },
    { minSpacingMs: 2000, maxConcurrent: 2 }
  )
  return defaultExport
}

// ── The read ────────────────────────────────────────────────────────────────────────────────────

/**
 * `chat:read-transcript` for an opencode node. Rules, each a refusal:
 *
 *  - A REMOTE node (`remoteOnly`) is refused before anything runs: its sessions live in the HOST's
 *    database, and an export here would answer from the wrong machine (or find a same-id session
 *    that is not this one). There is no remote leg yet — see CLAUDE.md.
 *  - No session id, or one we would not put on argv, is not found and runs nothing: a bare
 *    `opencode export` opens a picker over the NEWEST sessions — someone else's.
 *  - `absent` (opencode looked) is a clean miss; any other export failure is `unreadable`.
 *  - An export whose `info.id` is not this session is `unreadable`, and none of it is shown.
 *  - An OLDER-page request has nothing to give (this reader never hands out a cursor).
 */
export async function readOpencodeChat(
  q: { sessionId?: string; remoteOnly?: boolean },
  page: ChatTranscriptPage | null,
  run: OpencodeExportRun = defaultOpencodeExport()
): Promise<ChatTranscriptResult> {
  const notFound = (): ChatTranscriptResult =>
    page ? { messages: [], found: false, olderCursor: null, unmatchedResults: [] } : { messages: [], found: false }
  const unreadable = (): ChatTranscriptResult => (page ? { ...notFound(), unreadable: true } : notFound())
  if (q.remoteOnly) return unreadable()
  if (page && page.before !== null) return { messages: [], found: true, olderCursor: null, unmatchedResults: [] }
  const sessionId = q.sessionId
  if (!sessionId || !isSafeOpencodeSessionId(sessionId)) return notFound()
  const out = await run(sessionId)
  if (!out.ok) return out.absent ? notFound() : unreadable()
  const parsed = parseOpencodeExport(out.stdout, sessionId)
  if (!parsed) return unreadable()
  const messages = newestWithinBytes(parsed.messages, CHAT_PAGE_MAX_BYTES)
  if (!page) return { messages, found: true }
  return {
    messages,
    found: true,
    olderCursor: null,
    unmatchedResults: [],
    ...(parsed.model !== undefined ? { model: parsed.model } : {}),
    ...(parsed.effort !== undefined ? { effort: parsed.effort } : {})
  }
}
