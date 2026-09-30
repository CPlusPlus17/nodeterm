// Removes every STRING-type escape sequence (OSC, DCS, SOS, PM, APC; 7- and 8-bit introducers)
// from a live link's pty stream. They carry what is not text on the screen: the clipboard (OSC 52,
// which tmux emits on every copy with `set-clipboard on`), window titles, hyperlink targets, file
// transfers, palette changes. Everything else (CSI, other ESC sequences, text) passes unchanged.
//
// Stateful across chunks, and it must see EVERY byte of the stream even while nothing is being
// forwarded: a frame that skipped the parser would leave it mid-sequence and print the tail of an
// OSC 52 (the clipboard) as text. That is also why it is reset only for a new pty session.
// An unterminated string is swallowed until its terminator; only past `maxStringChars` (UTF-16
// units, i.e. string length) does the parser give up and return to text.
//
// Where a string starts and ends follows xterm.js 5.5's VT500 table (EscapeSequenceParser.ts), which
// renders the owner's node, the session host's emulator and the viewer page. Every rule below that
// goes past "ESC + ] P X ^ _" closes a way the viewer would receive bytes the owner's terminal
// treats as string payload:
// - BEL ends an OSC only. Inside DCS it is data, inside SOS/PM/APC it is ignored, so the owner never
//   sees what follows it.
// - In ESCAPE, xterm executes C0 controls and ignores DEL without leaving it, restarts it on a second
//   ESC, and takes an 8-bit introducer as a string start: `ESC \n ]52;…` is still an OSC 52.
// - An 8-bit introducer inside a string starts a new string of ITS kind (an OSC turned DCS no longer
//   ends at BEL), with a fresh count toward the cap.
// Where xterm ENDS a string on something this parser does not (CAN, SUB, other C1 controls, and a
// non-ASCII char, U+00A0 and up, inside SOS/PM/APC or a DCS before its final byte: ERROR → GROUND),
// the viewer misses a little text until the next terminator; it never sees more than the owner.
//
// A viewer that joins a RUNNING session (`midStream`) cannot know where in the stream its first byte
// falls: inside an OSC 52, or right after an ESC the previous read ended on (`]52;c;…` would then
// read as text, the whole clipboard). So it starts as if an unknown string had just begun: nothing
// is shown until the next ESC, ST or 8-bit introducer, where xterm's state is known again whatever
// it was (ESCAPE, GROUND, a new string). The cost is the text between the join and the first
// escape: the viewer misses it until those cells are painted again.
//
// The output guarantee the caller relies on: no push emits an 8-bit introducer or ends on ESC, and
// every ESC it emits is followed by a char that leaves ESCAPE without starting a string. So the
// viewer's parser can never be put into a string state, even by output that is dropped in part
// (drop-and-redraw) or starts on a keyframe.
//
// It runs on the owner's process for every byte, once per viewer, so text is copied by the slice
// between escapes rather than char by char: about 3x faster, measured on a captured tmux stream of
// colored output (an ESC every ~8 bytes) on a loaded host: 22-39 MB/s char by char, 64-130 MB/s by
// slice. Such a flood reaches a tmux 3.4 client at ~2.7 MB/s.

const ESC = '\x1b'
// Fast path: a chunk with none of these, read in text mode, is returned as it is.
const TEXT_SPECIAL = /[\x1b\x90\x98\x9d-\x9f]/
const INTRO_8_ANY = /[\x90\x98\x9d-\x9f]/

// OSC, DCS, SOS, PM, APC: `ESC ] P X ^ _` and their 8-bit forms.
function isIntro7(c: number): boolean {
  return c === 0x5d || c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f
}
function isIntro8(c: number): boolean {
  return c === 0x9d || c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f
}
// The C0 controls xterm executes while staying in ESCAPE: all but CAN, SUB and ESC itself.
function isC0Executable(c: number): boolean {
  return c <= 0x17 || c === 0x19 || (c >= 0x1c && c <= 0x1f)
}

export interface StreamFilterOptions {
  /**
   * The first byte may fall anywhere in the stream. Every viewer that co-attaches to a running
   * session must set it, and so must every `reset()` onto a session that is already running;
   * without it a join inside a string, or right after an ESC, sends the string's payload as text.
   * Starts exactly as if an 8-bit DCS introducer had just been read: nothing is shown until the
   * next ESC (an `ESC \` ST is dropped), ST or 8-bit introducer; BEL does not end it (the unknown
   * string may be a DCS or APC, where BEL is data); the cap counts from the join.
   */
  midStream?: boolean
}

export interface StreamFilter {
  push(chunk: string): string
  /** Forget the current sequence, for a new pty session; `midStream` as for `createStreamFilter`. */
  reset(opts?: StreamFilterOptions): void
}

export function createStreamFilter(maxStringChars = 1_048_576, opts?: StreamFilterOptions): StreamFilter {
  // 'esc' is ESCAPE after a plain ESC; 'stringEsc' is ESCAPE after the ESC that ended a string,
  // where `ESC \` is that string's ST and is dropped with it.
  let mode: 'text' | 'esc' | 'string' | 'stringEsc' = 'text'
  let osc = false
  let len = 0
  const enterString = (introducer: number): void => {
    mode = 'string'
    osc = introducer === 0x5d || introducer === 0x9d
    len = 0
  }
  const start = (o: StreamFilterOptions | undefined): void => {
    if (o?.midStream) enterString(0x90)
    else {
      mode = 'text'
      osc = false
      len = 0
    }
  }
  start(opts)
  return {
    reset(o) {
      start(o)
    },
    push(chunk) {
      if (mode === 'text' && !TEXT_SPECIAL.test(chunk)) return chunk
      // An 8-bit introducer is rare (a decoded stream carries one only if a program wrote the
      // two-byte UTF-8 form), so in most chunks ESC is the only char text mode stops at.
      const has8 = INTRO_8_ANY.test(chunk)
      const n = chunk.length
      let out = ''
      let i = 0
      while (i < n) {
        if (mode === 'text') {
          let j = chunk.indexOf(ESC, i)
          if (j === -1) j = n
          if (has8) {
            for (let k = i; k < j; k++) {
              if (isIntro8(chunk.charCodeAt(k))) {
                j = k
                break
              }
            }
          }
          out += chunk.slice(i, j)
          if (j === n) break
          const c = chunk.charCodeAt(j)
          if (c === 0x1b) mode = 'esc'
          else enterString(c)
          i = j + 1
        } else if (mode === 'string') {
          const c = chunk.charCodeAt(i++)
          if (c === 0x9c || (c === 0x07 && osc)) mode = 'text'
          else if (c === 0x1b) mode = 'stringEsc'
          else if (isIntro8(c)) enterString(c)
          else if (++len > maxStringChars) {
            mode = 'text'
            len = 0
          }
        } else {
          // ESCAPE. The ESC is held until the char that decides what it starts arrives.
          const c = chunk.charCodeAt(i)
          if (isIntro7(c) || isIntro8(c)) enterString(c)
          else if (c === 0x1b) mode = 'esc'
          else if (isC0Executable(c)) out += chunk[i]
          else if (c === 0x7f) {
            // DEL: ignored in ESCAPE.
          } else if (c === 0x5c && mode === 'stringEsc') mode = 'text'
          else {
            out += ESC + chunk[i]
            mode = 'text'
          }
          i++
        }
      }
      return out
    }
  }
}
