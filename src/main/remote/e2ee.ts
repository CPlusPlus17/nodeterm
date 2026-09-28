// Moved to src/core/relay/e2ee.ts so the Server Edition can host relay sessions
// (docs/superpowers/specs/2026-09-28-hosted-team-relay-design.md). This shim keeps every desktop
// import path — and every vi.mock('./e2ee') in the existing tests — working unchanged.
export * from '../../core/relay/e2ee'
