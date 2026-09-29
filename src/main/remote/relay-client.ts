// The desktop relay client: a thin wrapper over the core client (src/core/relay/relay-client.ts),
// which holds the whole mechanism and its SECURITY obligations — read them there before touching
// any call site. The only thing this layer adds is WHERE a mutual approval is pinned: the desktop's
// approved-devices store, exactly as before the client moved to core (docs/hosted-team-relay.md).
import {
  connectRelayClient as connectCoreRelayClient,
  type RelayClientSession,
  type ConnectRelayClientOptions as CoreOptions
} from '../../core/relay/relay-client'
import { recordApproval } from '../../core/relay/mutual-approval-core'
import { updateApprovedDevices } from './approved-devices'

export type { RelayClientSession }
export type ConnectRelayClientOptions = Omit<CoreOptions, 'pins'>

export function connectRelayClient(opts: ConnectRelayClientOptions): RelayClientSession {
  return connectCoreRelayClient({
    ...opts,
    // recordApproval refuses unless BOTH confirmed and pins only the key carried by the state; the
    // serialized updateApprovedDevices queue keeps concurrent approvals and a racing revoke intact.
    pins: { record: (pinned) => updateApprovedDevices((store) => recordApproval(store, pinned)) }
  })
}
