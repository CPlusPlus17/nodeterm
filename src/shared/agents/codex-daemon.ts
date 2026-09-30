/**
 * Keep every nodeterm-launched Codex TUI out of Codex's auto-started shared app-server.
 *
 * From codex-cli 0.157.0 the `daemon_auto_start` feature is `stable, true`: a plain `codex` TUI
 * starts (or joins) ONE background app-server per `CODEX_HOME`, and that daemon keeps the
 * environment of the pane that STARTED it. nodeterm tells a node apart by environment
 * (`NODETERM_NODE_ID`, the hook endpoint — `buildPtyEnv`), and the daemon is what spawns tool
 * shells and hook processes, so every later Codex node's hooks, canvas-control verbs and
 * context-link reads were attributed to the first pane's node. Measured on 0.159.2 (see
 * `codexNoDaemonFrom` in core/codex-cli.ts): `--no-daemon` fixes it, `-c
 * features.daemon_auto_start=false` does not (it still joins a running daemon), and there is no
 * environment switch.
 *
 * The flag goes on the line only when the CLI that will run it has been SEEN to accept it
 * (`caps.codexNoDaemon === true`): clap exits on an unknown option, so an unprobed or remote CLI
 * gets today's command line byte for byte. Never next to `--remote` — measured, codex refuses the
 * pair ("--no-daemon cannot be used with --remote") — which is also why the managed launcher strips
 * it again before its own `codex --remote unix:// resume` (core/codex-identity-proxy.ts) and keeps
 * it for its plain-codex fallbacks.
 */
import { argvHasFlag } from '../shell-quote'
import type { ApprovalCaps } from './approval-mode'
import type { AgentId } from './config'

export const CODEX_NO_DAEMON_FLAG = '--no-daemon'

/** Append `--no-daemon` to a codex launch/resume line. `agentId` is the CAPABILITY id (a custom
 *  agent whose `baseAgent` is codex passes `codex`, exactly as `withPermissionMode` is called). */
export function withCodexNoDaemon(cmd: string, agentId: AgentId, caps: ApprovalCaps = {}): string {
  if (agentId !== 'codex' || caps.codexNoDaemon !== true) return cmd
  if (argvHasFlag(cmd, CODEX_NO_DAEMON_FLAG) || argvHasFlag(cmd, '--remote')) return cmd
  return `${cmd} ${CODEX_NO_DAEMON_FLAG}`
}
