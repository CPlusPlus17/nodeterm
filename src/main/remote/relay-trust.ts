// The desktop trust gate: a thin wrapper over the core gate (src/core/relay/relay-trust.ts), which
// holds the whole mechanism and its SECURITY obligations (a) and (b) — read them there before
// touching any call site. The only thing this layer adds is WHERE a mutual approval is pinned: the
// desktop's approved-devices store, exactly as before the gate moved to core (docs/hosted-team-relay.md).
import {
  createTrustGate as createCoreTrustGate,
  TRUST_CONFIRM,
  TRUST_DENIED,
  deniedFrame,
  parseDenied,
  type TrustGate,
  type TrustGateOptions as CoreTrustGateOptions,
  type TrustDeniedReason
} from '../../core/relay/relay-trust'
import { recordApproval } from '../../core/relay/mutual-approval-core'
import { loadApprovedDevices, saveApprovedDevices, updateApprovedDevices } from './approved-devices'
import type { ApprovedDevices } from './approved-devices-core'

export { TRUST_CONFIRM, TRUST_DENIED, deniedFrame, parseDenied, type TrustGate, type TrustDeniedReason }

export interface TrustGateOptions extends Omit<CoreTrustGateOptions, 'pins'> {
  load?: () => Promise<ApprovedDevices>
  save?: (s: ApprovedDevices) => Promise<void>
}

/** Desktop trust gate: pins go to the phone/desktop approved-devices store, exactly as before. */
export function createTrustGate(opts: TrustGateOptions): TrustGate {
  const { load, save, ...rest } = opts
  return createCoreTrustGate({
    ...rest,
    pins: {
      // recordApproval refuses unless BOTH confirmed, and pins only the key carried by the state.
      // Injected load/save keep their read-then-write path; the default goes through the serialized
      // updateApprovedDevices queue, so concurrent approvals never lose pins and a racing revoke is
      // never undone from a stale snapshot.
      async record(pinned) {
        if (load || save) {
          await (save ?? saveApprovedDevices)(recordApproval(await (load ?? loadApprovedDevices)(), pinned))
        } else {
          await updateApprovedDevices((store) => recordApproval(store, pinned))
        }
      }
    }
  })
}
