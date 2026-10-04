# Hook replies — owned approval rules and complete questions (v2 contract)

The managed Claude hook answers held requests through a private file on the computer running the
agent. A phone can reach that file over SSH, or use the standing desktop's typed relay verbs. The
answer is hook JSON; it does not depend on a permission dialog's numbering or which terminal pane
has keyboard focus. Legacy one-line `allow` and `deny` replies remain unchanged.

Claude documents rule updates through `PermissionRequest.decision.updatedPermissions` and question
answers through `PreToolUse.updatedInput`. The latter must retain the questions and provide the
chosen answers; allowing the tool alone does not answer it. See the official [permission update
entries](https://code.claude.com/docs/en/hooks#permission-update-entries), [tools requiring user
interaction](https://code.claude.com/docs/en/hooks#tools-that-require-user-interaction), and [question
answer representation](https://code.claude.com/docs/en/agent-sdk/user-input#return-answers-to-claude).

## Hold and release

`managed-script.ts` revision 5 holds a Claude `PermissionRequest`, or a parent `PreToolUse` for
`AskUserQuestion`, only while `NODETERM_PERM_WAIT_SECS` is positive. The default injected wait is
45 seconds when `hookReplyApprovals` is enabled. With no wait environment, the hook remains inert
for this feature; ordinary tool events and child question events are not held.

The script writes the original stdin JSON to
`~/.nodeterm/pending/<nodeId>-<epoch-ms>-<pid>.json` under `umask 077`, then reports the ticket and
`nodeterm_hook_reply=2` through the ordinary hook POST. It polls the corresponding `.answer` every
0.5 seconds. After reading an accepted reply it removes the request and answer, reports the consumed
answer through the existing hook endpoint, prints the decision JSON and exits. Timeout removes the
request, prints no decision and returns to the CLI's normal interactive flow.

The feature still uses the existing managed hook, endpoint and credentials. It creates no hosted
service, account, permission-mode bypass or independent prompt simulator.

## Answer formats

An ordinary permission reply is still exactly `allow` or `deny`. A v2 reply is:

```text
nodeterm-hook-reply-v2
<one compact JSON object containing hookSpecificOutput>
```

The marker lets the managed consumer distinguish the additive format from legacy files. It accepts
only the output kind matching the hold: a remembered rule is a `PermissionRequest` decision, and a
question is a `PreToolUse` decision. Plain permission replies cannot answer a held question.

The builders in `src/shared/hook-answers.ts` and Android's `HookReplies.kt` validate the original
request and produce this JSON. UI/RPC callers supply indexes, never arbitrary rules or hook output.
Structured writers refuse original requests larger than 128 KiB, and generated decision JSON is
bounded to the same size; the marker is separate framing.

## Allow and remember

An approval may advertise `permissionSuggestions: [{index, label}]`. Each index points to a
concrete `addRules` suggestion from that request's original `permission_suggestions`, with `allow`
behavior, the same tool, explicit nonblank rule content, and one of `session`, `localSettings`,
`projectSettings` or `userSettings`. Omitted whole-tool scope, a literal `*` scope, other tools,
`setMode`, replacements and unsupported destinations are not offered.

The Android card opens a confirmation showing each exact rule and destination. The desktop/Server
canvas offers the same request-derived rule scopes beside Approve and Deny. A remembered reply
uses the original rule contents and destination under
`hookSpecificOutput.decision.updatedPermissions`; it does not change the session permission mode.
A session destination lasts for that CLI session; settings destinations write the scope named by
the original request. The UI does not claim the rule was applied merely because a file was written.

Over the relay, `approvals.answer` retains `allow` and `deny` and adds
`{nodeId, pendingId, decision:"allow-always", suggestionIndex}`. The host rechecks saved node
ownership, the exact unresolved capability card, and the original request. Over direct SSH, the
phone reads that request and builds the same reply, refusing nodes owned on another SSH host.
An older host, a request with no eligible scope, or an unsupported response offers Open session;
there is no fallback to a guessed `2`.

## Complete question answers

A held question advertises `questionPendingId` and `questions`, including every question's full
text, header, option labels/descriptions and `multiSelect`. The supported schema is 1–4 questions
with 2–4 distinct options each. Duplicate question text, duplicate labels, malformed fields,
clipped/unsupported schema and incomplete selections are refused.

Android renders radio choices for single-select questions and checkboxes for multi-select. Send
answers stays disabled until every question has at least one permitted selection. It sends
`questions.answer {nodeId, pendingId, selections:number[][]}`, where each inner list contains
option indexes for one question. Both host and direct-SSH builders rederive the exact labels from
the live original request. They preserve the complete original `tool_input`, including the original
`questions`, and add an `answers` object keyed by exact question text. Multi-select labels are
ordered by their original option positions and joined with comma-space. This sends all questions,
not only the first picker.

When a v2 question is held, its published card omits legacy `options` and `multiSelect`, including
when the full schema cannot be answered. An older phone therefore offers Open session rather than
typing a digit before a picker exists. An unheld legacy question keeps its existing behavior:
measured single-choice quick keys, otherwise read-only choices and Open session. After a hold
expires, the CLI may display its ordinary picker; no premature legacy action is republished by
this v2 card. Free-text question entry and option-preview rendering are not added.

## Ownership, races and outcomes

New structured writers require a pending id belonging to the selected node. A fresh unresolved
card must still carry the same ticket and advertised rules/questions before the phone submits.
The host additionally rereads the original request. A missing or settled card never authorizes
input into a newer prompt.

The local writer stages a unique private reply file, then rechecks the request's regular-file
identity, device/inode, modification time and size before atomic publication. SSH writers require a
regular nonsymlink request, bound its read, retain a checksum and stream the reply through stdin.
They recheck the request **after stdin completes and immediately before rename**, so an expiry or
replacement during a suspended transfer cannot publish a stale answer. Exact temporary files are
removed on refusal. The final check and rename remain separate operations; this is not a
transaction with the hook's poller.

Writers report `sent`, `gone` or `failed`. SSH requires a confirmed exit status and expected success
output; a missing exit status or lost write acknowledgement is not success. An unanswered write is
never retried through another connection or replaced with keystrokes. Android handles a gone hold
as expired unless a fresh listing proves its own event resolved; unsupported responses open the
session. Per-host/event native admission blocks rapid duplicate taps while an action is pending.

Structured cards settle when the managed hook actually consumes the reply and sends its correlated
POST. Legacy ordinary Approve/Deny retains its existing optimistic update. A consumed question
settles only its own question id; concurrent child permission tickets remain open. Existing boot
and hourly pending sweeps remove old orphan files after ten minutes.

## Surfaces and verification limits

Desktop routes local requests through its private writer and SSH-project requests through that
project's retained ControlMaster. Its standing relay uses those same writers. Server Edition's
canvas supports local remembered rules; its existing SSH-project refusal remains, and it does not
serve this legacy standing-phone relay. Direct SSH remains POSIX and writes only the selected
computer's own hook tickets.

Android parses the additive mirror fields, implements both relay verbs and the SSH reply contract,
and exercises the real mirror producer/host router through its interop fixture. The bridges behind
relay fixture answer verbs record calls; they are not a live Claude process. Separate regressions
execute the shipped POSIX managed hook over real stdin/stdout and suspend real shell writers to
exercise timeout/replacement before publication.

The installed Claude 2.1.289 public bundle and official schemas were inspected. That evidence does
not verify live CLI persistent-rule application, actual picker completion, an older CLI version or
new physical phone behavior. Those remain explicit follow-up checks.

**iOS implication — @eneskirca:** adopt `permissionSuggestions`, `questionPendingId`, full `questions`,
`allow-always` plus `suggestionIndex`, `questions.answer` and the v2 SSH answer marker together.
Keep legacy `allow`/`deny`, ticket ownership, full-input preservation, post-stdin expiry checks and
unsupported-host degradation. Replace any blind Always allow digit with a request-owned rule;
held question cards no longer expose the old numbered choices.
