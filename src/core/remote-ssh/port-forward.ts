// Same-port local forwards for an SSH project's dev servers, over the project's EXISTING
// ControlMaster (`ssh -O forward -L 127.0.0.1:P:<host-side addr>:P`). The point of the SAME number
// is that the URLs the tool prints — `http://localhost:5173` — just work on this machine.
//
// Rules, each a refusal rather than a guess:
//  - Only a port discovery attributed to THIS node, in a scan taken at click time, is forwarded;
//    the renderer names a node and a port, never a host-side address.
//  - The local side binds 127.0.0.1 only.
//  - A local port that is taken — by anything listening on 127.0.0.1 OR ::1, since a browser's
//    `localhost` tries IPv6 first and would silently show the LOCAL app — is refused with the
//    reason, never silently moved. A different local port is only ever the person's explicit
//    choice (`localPort` in the request), with a free one suggested.
//  - A privileged port (< 1024, on either side) is refused until the person confirmed it.
//  - Lifecycle: a forward is cancelled when its node's session ends, when a successful scan no
//    longer lists the host port, or dropped when the project disconnects (the master takes the
//    listener with it). A failed scan cancels nothing — a failed read is never evidence.
//  - A master rebuilt behind our back (`ControlMaster=auto`, issue #735's mechanism) carries no
//    `-L`: every successful scan re-checks that the local listener is still held and forgets a
//    forward whose listener is gone, so the menu offers to forward again instead of lying.

import net from 'net'
import type { SshConnection } from '../../shared/ssh'
import {
  devPortUrl,
  forwardRefusalText,
  isPrivilegedPort,
  isValidPort,
  type DevPortForward,
  type DevPortForwardRequest,
  type DevPortForwardResult,
  type DevPortsReport
} from '../../shared/dev-ports'
import { forwardTarget } from '../dev-ports'
import { localForwardArgs, localForwardCancelArgs } from './control-master'

export interface PortForwardDeps {
  refForProject(projectId: string): { conn: SshConnection; controlPath: string } | undefined
  run(args: string[]): Promise<{ code: number; stdout: string }>
  /** A fresh discovery of the project's host (coalesced by the caller). */
  scan(projectId: string): Promise<DevPortsReport>
  /** Is anything reachable on this machine's `localhost:<port>`, or is the loopback port unbindable? */
  localPortBusy(port: number): Promise<boolean>
  /** Is the loopback listener still there (i.e. can we NOT bind 127.0.0.1:<port>)? */
  localPortHeld(port: number): Promise<boolean>
}

interface Held extends DevPortForward {
  projectId: string
  target: string
  conn: SshConnection
  controlPath: string
}

/** How far past the requested port the suggestion looks for a free one. */
const SUGGEST_SPAN = 100

export class PortForwardRegistry {
  private readonly held = new Map<number, Held>() // keyed by LOCAL port — unique on this machine
  private readonly inFlight = new Map<string, Promise<DevPortForwardResult>>()

  constructor(private readonly d: PortForwardDeps) {}

  list(projectId: string): DevPortForward[] {
    return [...this.held.values()]
      .filter((h) => h.projectId === projectId)
      .map(({ nodeId, remotePort, localPort }) => ({ nodeId, remotePort, localPort }))
      .sort((a, b) => a.remotePort - b.remotePort)
  }

  /** Coalesces a double click on the same row into one attempt. */
  forward(req: DevPortForwardRequest): Promise<DevPortForwardResult> {
    const key = `${req.projectId}\u0000${req.nodeId}\u0000${req.port}\u0000${req.localPort ?? ''}`
    const pending = this.inFlight.get(key)
    if (pending) return pending
    const p = this.forwardOnce(req).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, p)
    return p
  }

  private refuse(
    reason: Parameters<typeof forwardRefusalText>[0],
    port: number,
    localPort?: number,
    suggestedLocalPort?: number
  ): DevPortForwardResult {
    return {
      ok: false,
      reason,
      message: forwardRefusalText(reason, port, localPort),
      ...(suggestedLocalPort !== undefined ? { suggestedLocalPort } : {})
    }
  }

  private async forwardOnce(req: DevPortForwardRequest): Promise<DevPortForwardResult> {
    const remotePort = req.port
    const localPort = req.localPort ?? remotePort
    if (!isValidPort(remotePort) || !isValidPort(localPort) || typeof req.nodeId !== 'string' || !req.nodeId) {
      return this.refuse('invalid-port', Number(remotePort))
    }
    if (!this.d.refForProject(req.projectId)) return this.refuse('not-connected', remotePort)

    // The host side is decided HERE, from a scan taken now — never from the renderer.
    const report = await this.d.scan(req.projectId)
    if (!report.ok) return this.refuse('not-connected', remotePort)
    const found = report.nodes[req.nodeId]?.find((p) => p.port === remotePort)
    if (!found) return this.refuse('not-listening', remotePort)
    const target = forwardTarget(found.addresses)
    if (!target) return this.refuse('forward-failed', remotePort)

    // Already forwarded for this project's port: hand back the live one, forget a dead one.
    for (const h of this.held.values()) {
      if (h.projectId !== req.projectId || h.remotePort !== remotePort) continue
      if (req.localPort !== undefined && h.localPort !== req.localPort) continue
      if (await this.d.localPortHeld(h.localPort)) {
        return { ok: true, localPort: h.localPort, url: devPortUrl(h.localPort), reused: true }
      }
      this.held.delete(h.localPort)
    }

    if ((isPrivilegedPort(remotePort) || isPrivilegedPort(localPort)) && req.allowPrivileged !== true) {
      return this.refuse('privileged', remotePort, localPort)
    }

    const ours = this.held.get(localPort)
    if (ours || (await this.d.localPortBusy(localPort))) {
      return this.refuse('local-port-busy', remotePort, localPort, await this.suggest(localPort))
    }

    // Re-read the ref: the scan was a round trip, and the master may have gone meanwhile.
    const ref = this.d.refForProject(req.projectId)
    if (!ref) return this.refuse('not-connected', remotePort)
    let code: number
    try {
      ;({ code } = await this.d.run(localForwardArgs(ref.conn, ref.controlPath, localPort, target, remotePort)))
    } catch {
      code = -1
    }
    if (code !== 0) return this.refuse('forward-failed', remotePort, localPort)
    this.held.set(localPort, {
      projectId: req.projectId,
      nodeId: req.nodeId,
      remotePort,
      localPort,
      target,
      conn: ref.conn,
      controlPath: ref.controlPath
    })
    return { ok: true, localPort, url: devPortUrl(localPort), reused: false }
  }

  /** The first free, non-privileged, not-ours local port after `from` — a suggestion only. */
  private async suggest(from: number): Promise<number | undefined> {
    for (let p = Math.max(from + 1, 1024); p <= Math.min(from + SUGGEST_SPAN, 65535); p++) {
      if (this.held.has(p)) continue
      if (!(await this.d.localPortBusy(p))) return p
    }
    return undefined
  }

  private async cancel(h: Held): Promise<void> {
    this.held.delete(h.localPort)
    try {
      await this.d.run(localForwardCancelArgs(h.conn, h.controlPath, h.localPort, h.target, h.remotePort))
    } catch {
      // Best effort: the master may already be gone, taking the listener with it.
    }
  }

  async unforward(projectId: string, localPort: number): Promise<boolean> {
    const h = this.held.get(localPort)
    if (!h || h.projectId !== projectId) return false
    await this.cancel(h)
    return true
  }

  /** After a SUCCESSFUL scan of the project: cancel forwards whose host port stopped listening,
   *  forget forwards whose local listener vanished (a rebuilt master). A failed scan changes nothing. */
  async reconcile(projectId: string, report: DevPortsReport): Promise<void> {
    if (!report.ok) return
    const listening = new Set<number>()
    for (const ports of Object.values(report.nodes)) for (const p of ports) listening.add(p.port)
    for (const h of [...this.held.values()]) {
      if (h.projectId !== projectId) continue
      if (!listening.has(h.remotePort)) await this.cancel(h)
      else if (!(await this.d.localPortHeld(h.localPort))) this.held.delete(h.localPort)
    }
  }

  /** The node's session ended (delete, recycle): its dev server went with it. */
  async nodeEnded(nodeId: string): Promise<void> {
    for (const h of [...this.held.values()]) if (h.nodeId === nodeId) await this.cancel(h)
  }

  /** The project's master is gone; its listeners died with it — nothing to cancel over ssh. */
  projectDisconnected(projectId: string): void {
    for (const h of [...this.held.values()]) if (h.projectId === projectId) this.held.delete(h.localPort)
  }
}

/** Can a TCP connection to `host:port` on this machine be opened within `timeoutMs`? */
export function canConnect(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port })
    const done = (v: boolean): void => {
      sock.removeAllListeners()
      sock.destroy()
      resolve(v)
    }
    sock.setTimeout(timeoutMs, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

/** Could this process bind `host:port` right now? (Released immediately.) */
export function canBind(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen({ host, port, exclusive: true }, () => srv.close(() => resolve(true)))
  })
}

/**
 * Busy = something answers on `localhost:<port>` over either family, or 127.0.0.1 cannot be bound.
 * The ::1 connect check is the one that matters for correctness: a local app bound only to ::1
 * leaves 127.0.0.1 free, the forward would succeed, and the browser node's `localhost` (IPv6
 * first) would show the local app instead of the host's.
 */
export async function defaultLocalPortBusy(port: number): Promise<boolean> {
  const [v4, v6] = await Promise.all([canConnect('127.0.0.1', port), canConnect('::1', port)])
  if (v4 || v6) return true
  return !(await canBind('127.0.0.1', port))
}

export async function defaultLocalPortHeld(port: number): Promise<boolean> {
  return !(await canBind('127.0.0.1', port))
}
