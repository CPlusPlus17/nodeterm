// Cmd/Ctrl+click links in terminal output. `createUrlLinkProvider` handles http(s) URLs;
// `createFileLinkProvider` handles path-like tokens: absolute (`/x/y`), dot-relative
// (`./x`, `../x`) and bare relatives with at least one slash (`src/a.ts`), with optional
// `:line[:col]` suffixes (compiler/grep output), and home-relative `~/x` paths. A `~` path stays
// `~`-rooted all the way to the filesystem call: the core that owns the filesystem expands it
// against ITS home (`expandHomePath` in core/fs-handlers.ts; an SSH project's remote shell does it
// for `sshFs`) — the renderer does not know that home, and on the Server Edition it is another
// machine's.
//
// Existence (and dir-ness) is verified before a file link is offered, via a short-TTL cache
// of parent-directory listings — one fs.list covers every sibling on a compiler-error screen.
//
// Long tokens span rows two different ways, and BOTH are joined into one logical paragraph
// (`paragraphContaining`) before matching:
//   - SOFT wrap — xterm wrapped a long streamed line itself; the continuation row carries
//     `isWrapped`. The easy, always-joined case.
//   - HARD wrap — tmux repaints (attach, resize, refresh) and an agent's fullscreen TUI PAINT
//     the screen row by row with explicit cursor moves, so a long line lands as separate
//     full-width rows with NO wrapped flags. This is what a `claude /login` OAuth URL looks
//     like in practice; matching per-row opened just the clicked row's fragment (a truncated,
//     wrong URL). A row is treated as continuing onto the next when it is full to the LAST
//     column and the next row starts at column 0 with a non-space — a heuristic (the buffer
//     genuinely cannot distinguish a repainted wrap from prose that exactly fills the row),
//     gated tightly and capped at MAX_JOIN_ROWS, and the regex still has to match across the
//     seam for a link to result.
import type { ILink, ILinkHandler, ILinkProvider, Terminal } from '@xterm/xterm'
import { linkOpenIntent } from './link-hover'

/** What a hovered link resolved to — what the host's hover tooltip names (see link-hover.ts). */
export type LinkHoverTarget = { kind: 'file'; abs: string; dir: boolean } | { kind: 'url'; url: string }

/** The host's hover tooltip. Optional everywhere: a host without one (the kanban card modal)
 *  keeps exactly the pre-tooltip behaviour. */
export interface LinkHoverSink {
  hover(target: LinkHoverTarget, event: MouseEvent): void
  leave(): void
}

export interface FileToken {
  /** The raw matched span (drives the underline range), incl. any :line:col suffix. */
  text: string
  /** 0-based index of `text` within the logical line. */
  startIndex: number
  /** The cleaned path portion. */
  path: string
  line?: number
}

// Path-ish token: an optional ./ ../ / prefix, then segments of path-safe chars with at
// least one internal slash — OR a prefixed single-segment (/tmp, ./x) — with an optional
// trailing :line[:col]. Trailing punctuation is cleaned afterwards, not in the regex.
const TOKEN_RE =
  /(?:(?:\.{1,2}\/|\/)?[\w.@+-]+(?:\/[\w.@+~-]+)+|(?:\.{1,2}\/|\/)[\w.@+-]+)(?::\d+(?::\d+)?)?/g

/**
 * The same shape with Windows separators, plus drive and UNC prefixes. Used ONLY when the
 * filesystem-owning core reports Windows — never just because the viewing browser is on Windows,
 * and never for an SSH project, whose paths are POSIX however the viewer is spelled.
 *
 * A SEPARATE regex rather than widening TOKEN_RE's separator class, deliberately: the POSIX path
 * is what every existing user runs, and it stays byte-identical. Widening it would also start
 * matching Windows-shaped text inside a POSIX session, where it can only ever be wrong.
 *
 * Four alternatives, in order: a UNC path (consumed whole so it can be refused), a drive-absolute
 * path, a dot-prefixed relative, or a plain multi-segment relative. Both separators are accepted,
 * because Windows tools emit both. A bare single word is deliberately not a token — `readme` in a
 * sentence is not a path, and TOKEN_RE takes the same position for POSIX.
 *
 * SPACES ARE NOT PART OF A SEGMENT, even though `C:\Program Files\…` is everywhere on Windows.
 * An unquoted path in terminal output gives no way to tell where it ends, so allowing spaces made
 * `C:\Users\me\src\a.ts for detail` match as one token — it swallowed the rest of the sentence.
 * The existence check would have rejected that, which means a path with a space would simply never
 * have linked while quietly breaking the ones around it. The POSIX matcher takes the same
 * position, so this is parity rather than a Windows-specific shortfall.
 */
const WIN_TOKEN_RE =
  /(?:(?:\\\\|\/\/)[\w.@+~-]+[\\/][\w.@+~-]+(?:[\\/][\w.@+~-]+)*|[A-Za-z]:[\\/][\w.@+~-]*(?:[\\/][\w.@+~-]+)*|\.{1,2}[\\/][\w.@+~-]+(?:[\\/][\w.@+~-]+)*|[\w.@+-]+(?:[\\/][\w.@+~-]+)+)(?::\d+(?::\d+)?)?/g
const SUFFIX_RE = /^(.*?):(\d+)(?::\d+)?$/
const TRAILING_PUNCT = /[.,;:!?'")\]}>]+$/
/** `C:\…`, `C:/…`, or a UNC `\\host\share` / `//host/share`. */
const WIN_ABSOLUTE_RE = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/

export interface PathConventionOpts {
  /** Match and resolve Windows-shaped paths. Off by default, so POSIX behaviour is unchanged. */
  windows?: boolean
}

/** Characters that, right before a `~`, mean it is not the start of a home path (`a~/x`). */
const HOME_LEAD_BLOCK_RE = /[\w.@+~\/-]/

export function matchFileTokens(lineText: string, opts: PathConventionOpts = {}): FileToken[] {
  const out: FileToken[] = []
  if (opts.windows) return matchWindowsFileTokens(lineText)
  for (const m of lineText.matchAll(TOKEN_RE)) {
    let text = m[0]
    let start = m.index
    // URLs (and protocol-ish tokens) belong to the web-links addon.
    const before = lineText.slice(Math.max(0, m.index - 8), m.index)
    // `\w+:\/{1,2}$` (not just `://`): the optional leading-`/` in TOKEN_RE can swallow the
    // second slash of `://`, so a URL's token starts at that slash and `before` ends `https:/`.
    if (/\w+:\/{1,2}$/.test(before) || text.includes('//')) continue
    // A token preceded by `~` is a home-relative path minus its tilde. Re-attach the tilde when it
    // stands at a word start (`~/x`, ` ~/x`, `(~/x`) so it never mis-resolves as the absolute `/x`.
    // Anything else before the `~` (`a~/x`, `~user/x`) is not a home path — skip it, as before.
    if (m.index > 0 && lineText[m.index - 1] === '~') {
      const lead = m.index > 1 ? lineText[m.index - 2] : ''
      if (!text.startsWith('/') || HOME_LEAD_BLOCK_RE.test(lead)) continue
      text = '~' + text
      start = m.index - 1
    }
    text = text.replace(TRAILING_PUNCT, '')
    if (text.length < 3) continue
    let path = text
    let line: number | undefined
    const suffix = SUFFIX_RE.exec(text)
    if (suffix) {
      path = suffix[1]
      line = parseInt(suffix[2], 10)
    }
    if (!path || !path.includes('/')) continue
    out.push({ text, startIndex: start, path, line })
  }
  return out
}

/**
 * The Windows half of `matchFileTokens`. Kept separate so the POSIX path above is untouched.
 *
 * The existence check downstream (`makeDirListingLookup`) is what makes a slightly generous
 * matcher safe: a token that is not a real file simply never becomes a link. So this errs toward
 * matching, and lets the filesystem decide — the opposite trade from the traversal guards
 * elsewhere in this codebase, where guessing wrong has a cost.
 */
function matchWindowsFileTokens(lineText: string): FileToken[] {
  const out: FileToken[] = []
  for (const m of lineText.matchAll(WIN_TOKEN_RE)) {
    let text = m[0]
    const before = lineText.slice(Math.max(0, m.index - 8), m.index)
    // A URL's token can begin at the second slash of `://` — same guard as the POSIX branch.
    if (/\w+:\/{1,2}$/.test(before) || text.includes('//')) continue
    text = text.replace(TRAILING_PUNCT, '')
    if (text.length < 3) continue
    let path = text
    // Refuse the WHOLE UNC token here. Without the explicit UNC alternative in WIN_TOKEN_RE the
    // matcher started two characters in (`server\share\a.ts`), turning the network path into a
    // relative path under cwd and bypassing resolveWindowsFileToken's UNC refusal.
    if (/^(?:\\\\|\/\/)/.test(path)) continue
    let line: number | undefined
    const suffix = SUFFIX_RE.exec(text)
    // `C:\src\a.ts:12` splits correctly because SUFFIX_RE anchors the digits at the END — the
    // drive's own colon is not followed by digits-then-end. `C:12` would split into path `C`,
    // which the separator requirement below then rejects.
    if (suffix) {
      path = suffix[1]
      line = parseInt(suffix[2], 10)
    }
    if (!path) continue
    // Must look like a path, not a bare word: either drive/UNC-qualified, or containing a
    // separator. Without this a `:line` suffix on any word would produce a token.
    if (!WIN_ABSOLUTE_RE.test(path) && !/[\\/]/.test(path)) continue
    out.push({ text, startIndex: m.index, path, line })
  }
  return out
}

// http(s) URLs. Shared by createUrlLinkProvider (hover underline + click outside tmux) and
// the mouse-up click fallback (below), which hit-tests URLs and file paths in one pass —
// under tmux/agent mouse-reporting a provider's own click never fires (see
// installLinkClickFallback).
const URL_RE = /\bhttps?:\/\/[^\s"'`<>()[\]{}|\\^]+/gi

export interface UrlToken {
  text: string
  startIndex: number
  url: string
}

export function matchUrlTokens(lineText: string): UrlToken[] {
  const out: UrlToken[] = []
  for (const m of lineText.matchAll(URL_RE)) {
    const text = m[0].replace(TRAILING_PUNCT, '')
    if (text.length < 8) continue // "http://x" is the shortest sane URL
    if (!isHttpUrl(text)) continue
    out.push({ text, startIndex: m.index, url: text })
  }
  return out
}

function isHttpUrl(text: string): boolean {
  try {
    const u = new URL(text)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * OSC 8 hyperlinks — a visible label with the URL riding in an escape sequence (what Claude
 * Code, gh and systemd emit), so the text-matching providers above never see the URL. xterm
 * parses the sequence natively but activates nothing unless `options.linkHandler` is set (its
 * built-in fallback is a window.confirm). The URI is invisible text the label hides, so a
 * `javascript:`/`file:` link must never reach openExternal.
 */
export function createOsc8LinkHandler(
  openUrl: (url: string) => void,
  hoverSink?: LinkHoverSink
): ILinkHandler {
  return {
    activate: (event: MouseEvent, text: string): void => {
      if (!(event.metaKey || event.ctrlKey)) return
      hoverSink?.leave()
      if (isHttpUrl(text)) openUrl(text)
    },
    // The one link whose target the screen never shows — the hover is where the user learns it.
    ...(hoverSink
      ? {
          hover: (event: MouseEvent, text: string): void => {
            if (isHttpUrl(text)) hoverSink.hover({ kind: 'url', url: text }, event)
          },
          leave: (): void => hoverSink.leave()
        }
      : {})
  }
}

/**
 * The OSC 8 URI at a buffer cell, or null. Private API (`CellData.extended.urlId` +
 * `_core._oscLinkService`), because the public buffer API exposes no hyperlink data and the
 * tmux click fallback below has nothing else to hit-test one with.
 */
export function osc8UrlAt(term: Terminal, row: number, col: number): string | null {
  const cell = term.buffer.active.getLine(row)?.getCell(col)
  const urlId = (cell as unknown as { extended?: { urlId?: number } } | undefined)?.extended?.urlId
  if (!urlId) return null
  const uri = (
    term as unknown as {
      _core?: { _oscLinkService?: { getLinkData(id: number): { uri: string } | undefined } }
    }
  )._core?._oscLinkService?.getLinkData(urlId)?.uri
  return uri && isHttpUrl(uri) ? uri : null
}

/** Absolute path for a token: absolutes pass through, relatives resolve against cwd,
 *  `.`/`..` segments normalized. Null when unresolvable or when `..` escapes the root.
 *  A home-relative cwd (`~` or `~/proj`, the SSH-project default) keeps its leading `~` as
 *  the first segment — the downstream sshFs stack tilde-expands it via quoteRemotePath, so
 *  `/`-prefixing it (→ `/~/proj`) would break the remote listing. `..` may not pop the `~`. */
export function resolveFileToken(
  path: string,
  cwd: string | undefined,
  opts: PathConventionOpts = {}
): string | null {
  if (opts.windows) return resolveWindowsFileToken(path, cwd)
  // `~/x` is rooted at the home dir, never at cwd; the `~` is kept for the core to expand.
  const raw =
    path.startsWith('/') || path.startsWith('~/')
      ? path
      : cwd
        ? `${cwd.replace(/\/+$/, '')}/${path}`
        : null
  if (!raw) return null
  const segs = raw.split('/').filter((s) => s && s !== '.')
  const tilde = segs[0] === '~'
  const out: string[] = tilde ? ['~'] : []
  const floor = tilde ? 1 : 0 // the `~` root is fixed; `..` may not pop below it
  for (const seg of tilde ? segs.slice(1) : segs) {
    if (seg === '..') {
      if (out.length <= floor) return null
      out.pop()
    } else out.push(seg)
  }
  return tilde ? out.join('/') : '/' + out.join('/')
}

/**
 * Windows counterpart. Returns a `/`-separated path that KEEPS its drive prefix
 * (`C:/Users/me/src/a.ts`).
 *
 * Forward slashes on purpose, even though the input is backslashed: Windows accepts either for
 * filesystem calls, and `makeDirListingLookup` finds the parent directory with
 * `lastIndexOf('/')`. Returning a native path would make that split fail and the link would never
 * resolve — silently, since a failed lookup just means no link.
 *
 * A UNC path is refused rather than half-handled: `\\host\share\x` has no drive to anchor on, its
 * first two segments are a host and a share rather than directories, and getting that wrong would
 * send a directory listing at a network host. Nobody has asked for it, and refusing costs a link
 * that would not have worked anyway.
 */
function resolveWindowsFileToken(path: string, cwd: string | undefined): string | null {
  const slash = (p: string): string => p.replace(/\\/g, '/')
  if (/^(?:\\\\|\/\/)/.test(path)) return null // UNC — see above
  const abs = /^[A-Za-z]:[\\/]/.test(path)
  const raw = abs ? slash(path) : cwd ? `${slash(cwd).replace(/\/+$/, '')}/${slash(path)}` : null
  if (!raw) return null
  // Split off the drive so `..` can never pop past it, the same way the POSIX branch protects `~`.
  const drive = /^([A-Za-z]:)\//.exec(raw)?.[1]
  const rest = drive ? raw.slice(drive.length + 1) : raw
  const segs = rest.split('/').filter((s) => s && s !== '.')
  const out: string[] = []
  for (const seg of segs) {
    if (seg === '..') {
      if (out.length === 0) return null
      out.pop()
    } else out.push(seg)
  }
  if (!drive) return null // relative with no drive-qualified cwd — nothing to anchor on
  return `${drive}/${out.join('/')}`
}

/** The two cwds a relative path can be anchored on, in order. `getCwd` is the node's LAUNCH cwd
 *  (persisted, synchronous); `getLiveCwd` is the pane's CURRENT directory (tmux
 *  `#{pane_current_path}`, async, may be unknown). An agent printing `var/x/y.sql` prints it relative
 *  to wherever IT runs, which is not always where the node was opened — the launch cwd alone left
 *  every such path dead with no hint why. */
export interface CwdSources {
  getCwd(): string | undefined
  getLiveCwd?(): Promise<string | undefined>
}

/**
 * What one existence check knows about one absolute path. `exists: false` WITHOUT `unverified` is a
 * verified absence (the parent listed real entries and ours is not among them); WITH it, nothing is
 * known and `unverified` says why. "Could not read" must never be laundered into "nothing there" —
 * a dead ControlMaster is not evidence that a file is gone.
 */
export interface PathLookup {
  exists: boolean
  dir: boolean
  unverified?: string
}

/** A candidate path that could not be checked, and why. */
export interface UnverifiedPath {
  abs: string
  reason: string
}

/** Where a path token resolved: an existing entry, or every absolute path that was tried. A miss
 *  carries `unverified` (non-empty) when any candidate could not be checked — then the answer is
 *  "unknown", not "missing". Absent means every candidate was a verified absence. */
export type PathResolution =
  | { found: true; abs: string; dir: boolean }
  | { found: false; tried: string[]; unverified?: UnverifiedPath[] }

/** The short reason an error carries, for a toast or a menu row. */
function reasonOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return msg.trim() || 'the lookup failed'
}

/**
 * Resolve a path token to an EXISTING file or directory: absolute (and `~/`) tokens are tried as
 * they are; a relative token against the launch cwd first, then the pane's live cwd. The launch cwd
 * wins when both hold a match, so a link never changes meaning just because the pane moved. The
 * live cwd is only asked when the first candidate misses — it is a tmux round trip, and the common
 * case never pays it.
 *
 * Three outcomes, not two: found, a verified miss, or unknown. A lookup that throws or answers
 * `unverified` records that candidate as UNCHECKED; if nothing is found, the result carries those
 * so the caller says "couldn't check", never "not found".
 *
 * An unchecked launch-cwd candidate still lets the live cwd be tried. A hit there is real evidence
 * (a listing returned the entry), whereas stopping would turn one flaky listing into a dead link for
 * a file we can prove exists. The cost is the tie-break: if the launch cwd ALSO held a same-named
 * file, the one we could not see would have won. Opening a file that provably exists at the path
 * the pane is standing in is the lesser surprise than a toast saying we could not check.
 */
export async function findExistingPath(
  token: string,
  convention: PathConventionOpts,
  deps: CwdSources & { lookup(abs: string): Promise<PathLookup> }
): Promise<PathResolution> {
  const tried: string[] = []
  const unverified: UnverifiedPath[] = []
  const attempt = async (cwd: string | undefined): Promise<PathResolution | null> => {
    const abs = resolveFileToken(token, cwd, convention)
    if (!abs || tried.includes(abs)) return null
    tried.push(abs)
    const f: PathLookup = await deps
      .lookup(abs)
      .catch((err: unknown) => ({ exists: false, dir: false, unverified: reasonOf(err) }))
    if (f.exists) return { found: true, abs, dir: f.dir }
    if (f.unverified !== undefined) unverified.push({ abs, reason: f.unverified || 'the lookup failed' })
    return null
  }
  const miss = (): PathResolution =>
    unverified.length ? { found: false, tried, unverified } : { found: false, tried }
  const first = await attempt(deps.getCwd())
  if (first) return first
  if (deps.getLiveCwd && !isAnchoredToken(token, convention)) {
    const live = await deps.getLiveCwd().catch(() => undefined)
    if (live) {
      const second = await attempt(live)
      if (second) return second
    }
  }
  return miss()
}

/** Does the token carry its own root (so no cwd can change where it points)? */
function isAnchoredToken(token: string, convention: PathConventionOpts): boolean {
  if (convention.windows) return WIN_ABSOLUTE_RE.test(token)
  return token.startsWith('/') || token.startsWith('~/')
}

/**
 * Memoize an async cwd read for `ttlMs`, coalescing concurrent calls. xterm asks every link
 * provider on each hovered row, and a live-cwd read is a tmux (or ssh) exec — uncached, a mouse
 * sweep over agent output would fire one per row. A failure reads as unknown and is not cached.
 */
export function cachedCwd(
  read: () => Promise<string | null>,
  ttlMs = 3000,
  now: () => number = Date.now
): () => Promise<string | undefined> {
  let hit: { at: number; value: string } | null = null
  let inFlight: Promise<string | undefined> | null = null
  return () => {
    if (hit && now() - hit.at < ttlMs) return Promise.resolve(hit.value)
    if (inFlight) return inFlight
    inFlight = read()
      .then((v) => {
        hit = v ? { at: now(), value: v } : null
        return v || undefined
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }
}

/** The toast text for a Cmd/Ctrl+click on a path that exists nowhere we looked. Only for a
 *  VERIFIED miss — see `fileMissMessage`. */
export function missingFileMessage(token: string, tried: string[]): string {
  if (!tried.length) return `File not found: ${token} (no working directory to resolve it against)`
  return tried.length === 1
    ? `File not found: ${tried[0]}`
    : `File not found: ${token} — looked in ${tried.join(' and ')}`
}

/** The toast text when at least one candidate could not be checked and none was found. It must
 *  not claim the file is gone: it names what it could not check and why, and a candidate that WAS
 *  a verified miss is mentioned as exactly that. */
export function unverifiableFileMessage(
  token: string,
  tried: string[],
  unverified: UnverifiedPath[]
): string {
  const reasons = [...new Set(unverified.map((u) => u.reason))].join('; ')
  const unchecked = unverified.map((u) => u.abs)
  const missed = tried.filter((t) => !unchecked.includes(t))
  const head =
    unverified.length === 1
      ? `Couldn't check ${unchecked[0]}: ${reasons}`
      : `Couldn't check ${token} at ${unchecked.join(' or ')}: ${reasons}`
  return missed.length ? `${head} (not found at ${missed.join(' or ')})` : head
}

/** The honest sentence for a Cmd/Ctrl+click miss: "couldn't check" when any candidate was
 *  unchecked, "not found" only when every one was a verified absence. */
export function fileMissMessage(
  token: string,
  miss: { tried: string[]; unverified?: UnverifiedPath[] }
): string {
  return miss.unverified?.length
    ? unverifiableFileMessage(token, miss.tried, miss.unverified)
    : missingFileMessage(token, miss.tried)
}

export interface FileLinkDeps extends CwdSources {
  /** Static compatibility option for direct unit consumers. Live terminals use `convention`. */
  windows?: boolean
  /** Dynamic host decision. `null` means the owning core's dialect was not observed, so file
   *  links fail closed instead of borrowing the browser's OS. Takes precedence over `windows`. */
  convention?: () => PathConventionOpts | null
  lookup(abs: string): Promise<PathLookup>
  activate(abs: string, dir: boolean): void
  /** Shift+Cmd/Ctrl+click: hand the path to the OS default app (the host decides per surface —
   *  see `systemOpenRefusal`). Absent = the plain `activate`, so a host that never wired it keeps
   *  its old behaviour for the Shift variant too. */
  openWithSystem?(abs: string, dir: boolean): void
  /** Hover tooltip naming the resolved path. */
  hoverSink?: LinkHoverSink
}

/** The minimal buffer slice paragraph joining needs — unit tests drive a fake. */
export interface BufferView {
  cols: number
  length: number
  line(row: number): { isWrapped: boolean; text(trimRight: boolean): string } | undefined
}

export function bufferView(term: Terminal): BufferView {
  const buf = term.buffer.active
  return {
    cols: term.cols,
    length: buf.length,
    line: (row) => {
      const l = buf.getLine(row)
      return l
        ? { isWrapped: l.isWrapped, text: (trim: boolean) => l.translateToString(trim) }
        : undefined
    }
  }
}

/** Upper bound on rows joined in each direction — bounds hover work on pathological
 *  full-width walls of text; a wrapped OAuth URL is ~7 rows at 80 cols. */
const MAX_JOIN_ROWS = 32

// Whether `row` runs into `row + 1`: the successor carries xterm's soft-wrap flag, OR the
// hard-wrap heuristic holds — `row` is full to its last column (untrimmed non-space in the
// final cell) and the successor starts at column 0 with a non-space. See the header comment.
function continuesOnNextRow(view: BufferView, row: number): boolean {
  const next = view.line(row + 1)
  if (!next) return false
  if (next.isWrapped) return true
  const cur = view.line(row)
  if (!cur) return false
  const raw = cur.text(false)
  if (raw.length < view.cols || raw[view.cols - 1] === ' ') return false
  const nextRaw = next.text(false)
  return nextRaw.length > 0 && nextRaw[0] !== ' '
}

/**
 * The logical paragraph containing `row` (0-based): walks up to the paragraph's first row,
 * then joins downward across soft AND hard wraps. Every row that continues contributes
 * EXACTLY `cols` characters (padded/truncated untrimmed read), so an index into `text` maps
 * back to the buffer as `(startRow + idx / cols, idx % cols)`; the final row is right-trimmed.
 */
export function paragraphContaining(
  view: BufferView,
  row: number
): { text: string; startRow: number; rows: number } | null {
  if (!view.line(row)) return null
  let start = row
  while (start > 0 && row - start < MAX_JOIN_ROWS && continuesOnNextRow(view, start - 1)) start--
  let text = ''
  let r = start
  for (;;) {
    const joins = r - start + 1 < MAX_JOIN_ROWS && continuesOnNextRow(view, r)
    const lineText = view.line(r)!.text(!joins)
    // Continuing rows must contribute exactly `cols` chars so the index math above holds.
    text += joins ? lineText.padEnd(view.cols).slice(0, view.cols) : lineText
    if (!joins) break
    r++
  }
  return { text, startRow: start, rows: r - start + 1 }
}

/** ILink range (1-based, inclusive) for a token at `startIndex..+len` of a paragraph. */
function tokenRange(
  startRow: number,
  cols: number,
  startIndex: number,
  len: number
): ILink['range'] {
  const endIndex = startIndex + len - 1
  return {
    start: { x: (startIndex % cols) + 1, y: startRow + Math.floor(startIndex / cols) + 1 },
    end: { x: (endIndex % cols) + 1, y: startRow + Math.floor(endIndex / cols) + 1 }
  }
}

/** xterm link provider for file paths. Register once per terminal with a reachable filesystem. */
export function createFileLinkProvider(term: Terminal, deps: FileLinkDeps): ILinkProvider {
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      // Resolve the paragraph CONTAINING the hovered row (not just one starting at it), so
      // hovering any wrapped tail row of a long path underlines and activates the whole token.
      const logical = paragraphContaining(bufferView(term), bufferLineNumber - 1)
      if (!logical) {
        callback(undefined)
        return
      }
      const convention = deps.convention ? deps.convention() : { windows: deps.windows }
      if (!convention) {
        callback(undefined)
        return
      }
      const tokens = matchFileTokens(logical.text, convention)
      if (!tokens.length) {
        callback(undefined)
        return
      }
      const cols = term.cols
      void Promise.all(
        tokens.map(async (t): Promise<ILink | null> => {
          const found = await findExistingPath(t.path, convention, deps)
          if (!found.found) return null
          const { abs, dir } = found
          const sink = deps.hoverSink
          return {
            text: t.text,
            range: tokenRange(logical.startRow, cols, t.startIndex, t.text.length),
            activate: (event: MouseEvent) => {
              const intent = linkOpenIntent(event)
              if (intent === 'none') return
              sink?.leave()
              if (intent === 'system') {
                // Shift also extends an xterm selection: a Shift+Cmd click that left one behind
                // was a selection gesture, not an open.
                if (term.hasSelection()) return
                ;(deps.openWithSystem ?? deps.activate)(abs, dir)
                return
              }
              deps.activate(abs, dir)
            },
            ...(sink
              ? {
                  hover: (event: MouseEvent) => sink.hover({ kind: 'file', abs, dir }, event),
                  leave: () => sink.leave()
                }
              : {})
          }
        })
      ).then((links) => {
        const real = links.filter((l): l is ILink => !!l)
        callback(real.length ? real : undefined)
      })
    }
  }
}

/**
 * xterm link provider for http(s) URLs — replaces the WebLinksAddon, which joined soft-wrapped
 * rows but not the hard-wrapped rows a tmux repaint / fullscreen TUI paints (the addon
 * underlined and opened just the first row's fragment of a long OAuth URL). Modifier-gated in
 * activate like the file provider, so plain clicks stay selections.
 */
export function createUrlLinkProvider(
  term: Terminal,
  openUrl: (url: string) => void,
  hoverSink?: LinkHoverSink
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      const logical = paragraphContaining(bufferView(term), bufferLineNumber - 1)
      if (!logical) {
        callback(undefined)
        return
      }
      const links = matchUrlTokens(logical.text).map(
        (u): ILink => ({
          text: u.text,
          range: tokenRange(logical.startRow, term.cols, u.startIndex, u.text.length),
          activate: (event: MouseEvent) => {
            if (!(event.metaKey || event.ctrlKey)) return
            hoverSink?.leave()
            openUrl(u.url)
          },
          ...(hoverSink
            ? {
                hover: (event: MouseEvent) => hoverSink.hover({ kind: 'url', url: u.url }, event),
                leave: () => hoverSink.leave()
              }
            : {})
        })
      )
      callback(links.length ? links : undefined)
    }
  }
}

/**
 * Existence+dir-ness via cached parent-dir listings (one list covers all siblings).
 *
 * Only a listing that came back WITH entries can prove absence. Two answers cannot, and are
 * reported as `unverified` instead of a miss (the rule `lib/filesNode.ts classifyEmptyListing`
 * states at length):
 *  - a `list` that REJECTS (a transport failure, a relay refusal, a dropped bridge);
 *  - a listing that is EMPTY. `FsApi` is fail-open by contract — `core/fs-ops.listDir` and
 *    `SshFs.listDir` end `catch { return [] }`, and the SSH IPC resolves `[]` for a project whose
 *    ControlMaster is down — so `[]` is what a dead master, a permission error or a timeout looks
 *    like. It is also what a directory that does not exist looks like; we cannot tell those apart
 *    from here, so the answer names the doubt rather than telling the user their file is gone.
 * Plus one shape the listing can never answer: a `.git` entry, which both listing legs strip.
 *
 * A failure is cached as a FAILURE, for `failureTtlMs` (short: it only keeps a hover sweep from
 * re-listing the same dead directory per row) — never as an empty directory for the full TTL, which
 * used to turn one hiccup into three seconds of "not found".
 */
export function makeDirListingLookup(
  list: (dir: string) => Promise<Array<{ name: string; dir: boolean }>>,
  ttlMs = 3000,
  convention: () => PathConventionOpts | null = () => ({}),
  opts: { failureTtlMs?: number; now?: () => number } = {}
): (abs: string) => Promise<PathLookup> {
  const failureTtlMs = opts.failureTtlMs ?? Math.min(1000, ttlMs)
  const now = opts.now ?? Date.now
  type Listing = { at: number; entries: Array<{ name: string; dir: boolean }> } | { at: number; error: string }
  const cache = new Map<string, Listing>()
  const fresh = (l: Listing | undefined): l is Listing =>
    !!l && now() - l.at < ('error' in l ? failureTtlMs : ttlMs)
  return async (abs) => {
    const conv = convention()
    if (!conv) return { exists: false, dir: false, unverified: 'no filesystem to check it on' }
    // On POSIX a backslash is legal filename text, not a separator. Only the Windows dialect may
    // split on it; resolved Windows tokens normally use `/`, but accepting a native path here keeps
    // this boundary honest if another caller supplies one later.
    const i = conv.windows
      ? Math.max(abs.lastIndexOf('/'), abs.lastIndexOf('\\'))
      : abs.lastIndexOf('/')
    // `C:/a.ts` splits to a dir of `C:`, which on Windows means "the current directory on drive
    // C" rather than its root — a listing of somewhere else entirely. Keep the separator.
    const separator = i >= 0 ? abs[i] : '/'
    const dir =
      i <= 0
        ? '/'
        : /^[A-Za-z]:$/.test(abs.slice(0, i))
          ? abs.slice(0, i) + separator
          : abs.slice(0, i)
    const name = abs.slice(i + 1)
    const same = (a: string, b: string): boolean =>
      conv.windows ? a.toLowerCase() === b.toLowerCase() : a === b
    if (same(name, '.git')) return { exists: false, dir: false, unverified: 'directory listings hide .git' }
    const cacheKey = conv.windows ? dir.toLowerCase() : dir
    const cached = cache.get(cacheKey)
    let listing: Listing
    if (fresh(cached)) listing = cached
    else {
      listing = await list(dir).then(
        (entries): Listing =>
          entries.length
            ? { at: now(), entries }
            : { at: now(), error: `nothing listed in ${dir} (it may not exist, or the filesystem is unreachable)` },
        (err: unknown): Listing => ({ at: now(), error: reasonOf(err) })
      )
      cache.set(cacheKey, listing)
    }
    if ('error' in listing) return { exists: false, dir: false, unverified: listing.error }
    const e = listing.entries.find((x) => same(x.name, name))
    return { exists: !!e, dir: !!e?.dir }
  }
}

// Cell (0-based col, 0-based buffer row) under a mouse event. The canvas applies zoom as a CSS
// transform, so getBoundingClientRect() is already the on-screen (scaled) size — dividing the
// scaled offset by the scaled cell size cancels the zoom, keeping cols/rows constant.
function bufferPosFromEvent(term: Terminal, ev: MouseEvent): { col: number; row: number } | null {
  const screen = term.element?.querySelector('.xterm-screen') as HTMLElement | null
  if (!screen || term.cols <= 0 || term.rows <= 0) return null
  const rect = screen.getBoundingClientRect()
  const x = ev.clientX - rect.left
  const y = ev.clientY - rect.top
  if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return null
  const cw = rect.width / term.cols
  const ch = rect.height / term.rows
  if (cw <= 0 || ch <= 0) return null
  return {
    col: Math.floor(x / cw),
    row: Math.floor(y / ch) + term.buffer.active.viewportY
  }
}

/** What sits under a buffer cell: a web URL (typed or OSC 8), or a path resolved to absolute.
 *  A path is NOT yet known to exist — that is the async `lookup`'s answer, taken by the caller. */
export type LinkHit =
  | { kind: 'url'; url: string }
  /** `token` is the path as printed; `abs` its resolution against the LAUNCH cwd (null when that
   *  cannot anchor it — a relative token on a cwd-less node — which the live cwd may still). */
  | { kind: 'path'; token: string; abs: string | null }

/** What `linkAtCell` needs to turn text into a path: the cwd and dialect the file providers use. */
export interface LinkHitDeps extends CwdSources {
  /** See FileLinkDeps.windows. */
  windows?: boolean
  /** See FileLinkDeps.convention. */
  convention?: () => PathConventionOpts | null
  /** False while no correctly-routed filesystem/dialect is available. */
  fileEnabled(): boolean
}

/**
 * The link at buffer cell (row, col), in the order the providers rank them: an OSC 8 hyperlink
 * (its URL is invisible — the label is all the text shows), then a typed URL, then a path-shaped
 * token. ONE hit-test for both mouse gestures — Cmd/Ctrl+click opens what this returns, a
 * right-click offers a menu for it — so the two can never disagree about what is under the pointer.
 */
export function linkAtCell(
  term: Terminal,
  row: number,
  col: number,
  deps: LinkHitDeps
): LinkHit | null {
  const osc8 = osc8UrlAt(term, row, col)
  if (osc8) return { kind: 'url', url: osc8 }
  const logical = paragraphContaining(bufferView(term), row)
  if (!logical) return null
  const idx = (row - logical.startRow) * term.cols + col
  const inRange = (startIndex: number, len: number): boolean =>
    idx >= startIndex && idx < startIndex + len

  for (const u of matchUrlTokens(logical.text)) {
    if (inRange(u.startIndex, u.text.length)) return { kind: 'url', url: u.url }
  }
  if (!deps.fileEnabled()) return null
  const convention = deps.convention ? deps.convention() : { windows: deps.windows }
  if (!convention) return null
  for (const t of matchFileTokens(logical.text, convention)) {
    if (inRange(t.startIndex, t.text.length)) {
      const abs = resolveFileToken(t.path, deps.getCwd(), convention)
      // Unanchorable against the launch cwd is still a hit when a live cwd can be asked.
      return abs || deps.getLiveCwd ? { kind: 'path', token: t.path, abs } : null
    }
  }
  return null
}

export interface LinkClickDeps extends LinkHitDeps {
  lookup(abs: string): Promise<PathLookup>
  activateFile(abs: string, dir: boolean): void
  /** Shift+Cmd/Ctrl+click on a file — see FileLinkDeps.openWithSystem. Absent = `activateFile`. */
  openFileWithSystem?(abs: string, dir: boolean): void
  openUrl(url: string): void
  /** A Cmd/Ctrl+click on a path found under neither cwd. The click is already swallowed (it
   *  must be, before the async lookup), so without this it would do nothing at all — the host says
   *  where it looked instead. `tried` may be empty (nothing could anchor the token); `unverified`
   *  (non-empty when present) lists candidates that could NOT be checked, in which case the host
   *  must not say the file is missing (`fileMissMessage`). */
  onMissing?(token: string, miss: { tried: string[]; unverified?: UnverifiedPath[] }): void
}

/**
 * Cmd/Ctrl+click link opening that works INSIDE tmux / an agent's fullscreen TUI. There, the
 * app has mouse-reporting on, so xterm consumes a click as a mouse escape and never runs the
 * registered link provider's `activate` (xterm: `areMouseEventsActive && !shouldForceSelection`
 * ⇒ early return). This capture-phase `mouseup` listener runs BEFORE xterm's mouse handler:
 * gated on the modifier, it hit-tests the buffer itself, opens the link, and stops propagation
 * so the mouse report is never sent. Non-modifier clicks/drags fall through untouched, so tmux
 * copy-mode selection and scrolling are unaffected. Shift added to the modifier routes a file to
 * `openFileWithSystem` (`linkOpenIntent`); a modified press released on another cell is a drag
 * and is left alone. Hover is NOT this listener's job: xterm's linkifier listens to `mousemove`
 * on its screen element whatever the mouse-tracking mode, so the providers' `hover` fires in a
 * tmux pane too. Attach to `term.element` so the listener travels with the terminal across
 * park/adopt. Returns a disposer.
 */
export function installLinkClickFallback(
  term: Terminal,
  host: HTMLElement,
  deps: LinkClickDeps
): { dispose(): void } {
  // The cell a modified press landed on. A release on a DIFFERENT cell is a drag (off-mac,
  // Shift+Ctrl+drag is xterm's forced selection even with mouse reporting on), never a click —
  // opening whatever link the drag happened to end on would hijack the selection.
  let down: { row: number; col: number } | null = null
  const onMouseDown = (ev: MouseEvent): void => {
    down = ev.button === 0 && linkOpenIntent(ev) !== 'none' ? bufferPosFromEvent(term, ev) : null
  }
  const onMouseUp = (ev: MouseEvent): void => {
    const pressed = down
    down = null
    const intent = linkOpenIntent(ev)
    if (ev.button !== 0 || intent === 'none') return
    // Only take over when the app has mouse-reporting on (tmux mouse / agent TUI) — that is the
    // exact case where xterm's own link `activate` never fires. With reporting OFF (a plain shell
    // when tmux is unavailable) the registered providers handle the click, so stepping in
    // here would open the link twice.
    if (term.modes.mouseTrackingMode === 'none') return
    const pos = bufferPosFromEvent(term, ev)
    if (!pos) return
    if (pressed && (pressed.row !== pos.row || pressed.col !== pos.col)) return
    const hit = linkAtCell(term, pos.row, pos.col, deps)
    if (!hit) return
    // Swallow the click NOW so tmux never gets the mouse report. For a path, existence is async
    // and a Cmd/Ctrl+click on a path-shaped token is a deliberate open regardless of the outcome.
    ev.preventDefault()
    ev.stopPropagation()
    term.clearSelection()
    if (hit.kind === 'url') {
      deps.openUrl(hit.url)
      return
    }
    const convention = (deps.convention ? deps.convention() : { windows: deps.windows }) ?? {}
    const open =
      intent === 'system' ? (deps.openFileWithSystem ?? deps.activateFile) : deps.activateFile
    void findExistingPath(hit.token, convention, deps).then((r) => {
      if (r.found) open(r.abs, r.dir)
      else deps.onMissing?.(hit.token, r)
    })
  }
  host.addEventListener('mousedown', onMouseDown, { capture: true })
  host.addEventListener('mouseup', onMouseUp, { capture: true })
  return {
    dispose: () => {
      host.removeEventListener('mousedown', onMouseDown, { capture: true })
      host.removeEventListener('mouseup', onMouseUp, { capture: true })
    }
  }
}

export interface LinkContextMenuDeps extends LinkHitDeps {
  /** A right-click landed on `hit` at viewport point (x, y) — the host shows its menu there. */
  openMenu(hit: LinkHit, x: number, y: number): void
}

/**
 * Right-click on a link → the host's link menu (open / reveal / download / copy — see
 * link-menu.ts). A right-click anywhere else is left EXACTLY as it was: tmux's own pane menu in a
 * plain shell (tmux 3.x binds MouseDown3Pane to `display-menu` unless the app took the mouse), the
 * press forwarded to an agent TUI that did, and the node's context menu bubbling up to React Flow.
 *
 * The decision is made on the PRESS, because that is what reaches tmux: xterm reports a
 * right-button press as a mouse escape, and once it is sent tmux has already opened its menu. So
 * the capture-phase `mousedown` hit-tests, and on a link swallows the press, its release and the
 * `contextmenu` that follows (that one is also what would open the node menu and xterm's own
 * right-click handling). The menu opens on `contextmenu`, the event every platform fires for the
 * gesture — after the press on macOS/Linux, after the release on Windows. A `contextmenu` with no
 * right press on a link before it (Shift+F10, the Menu key) is not ours. Unlike the Cmd+click
 * fallback this runs whatever the mouse-tracking mode: with reporting off there is no tmux to
 * protect, but the node menu and xterm's own right-click still must not open over ours.
 */
export function installLinkContextMenu(
  term: Terminal,
  host: HTMLElement,
  deps: LinkContextMenuDeps
): { dispose(): void } {
  let pending: LinkHit | null = null
  const swallow = (ev: Event): void => {
    ev.preventDefault()
    ev.stopPropagation()
  }
  const onMouseDown = (ev: MouseEvent): void => {
    pending = null
    if (ev.button !== 2) return
    const pos = bufferPosFromEvent(term, ev)
    pending = pos ? linkAtCell(term, pos.row, pos.col, deps) : null
    if (pending) swallow(ev)
  }
  const onMouseUp = (ev: MouseEvent): void => {
    if (ev.button === 2 && pending) swallow(ev)
  }
  const onContextMenu = (ev: MouseEvent): void => {
    const hit = pending
    if (!hit) return
    pending = null
    swallow(ev)
    deps.openMenu(hit, ev.clientX, ev.clientY)
  }
  host.addEventListener('mousedown', onMouseDown, { capture: true })
  host.addEventListener('mouseup', onMouseUp, { capture: true })
  host.addEventListener('contextmenu', onContextMenu, { capture: true })
  return {
    dispose: () => {
      host.removeEventListener('mousedown', onMouseDown, { capture: true })
      host.removeEventListener('mouseup', onMouseUp, { capture: true })
      host.removeEventListener('contextmenu', onContextMenu, { capture: true })
    }
  }
}
