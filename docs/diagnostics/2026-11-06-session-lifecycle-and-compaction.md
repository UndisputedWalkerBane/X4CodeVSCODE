# Session lifecycle and compaction investigation — 2026-11-06

## Scope and limits

This investigation covers the Agent Hub Stop/start lifecycle and the parent Codex sessions associated with Tests and the active BuyerWhiteGenerator NEW tile. It does not establish the cause of every long-running task or inspect every historical session. No provider credentials or conversation text are included here.

Repository baseline: main at `2368198`, package version 0.0.63. At intake, VS Code's extension inventory selected Agent Hub 0.0.62. A matching source branch in another installed directory does not prove that directory was loaded.

## Confirmed Stop race

A stopped turn A scheduled a six-second fallback keyed only by the chat/project key. If A completed and turn B started before that fallback, A's callback removed B from the live-run map and published `busy:false`. B still owned the CLI-session writer. Another send then reported that the CLI session was running in another chat, although B belonged to the same chat.

The fix captures A's controller and allows the fallback to act only while that exact controller owns the run key. The writer guard remains necessary: two genuine concurrent writers must not resume the same native session.

Regression evidence before the fix: both the ordinary-chat and multichat cases failed with the reported false conflict. Coverage also preserves legitimate shared-record/shared-CLI-ID rejection and the fallback for an actually unresponsive original turn.

## Startup behavior

The original app-server resume requested complete thread history even though the extension used only thread metadata. The startup fix requests `excludeTurns: true` and bounds the initial JSON-RPC exchanges. A startup deadline is separate from the duration of model execution, tools, approvals, or user questions. An ambiguous `turn/start` timeout must never automatically replay a potentially accepted task through another transport.

The long-history request is a plausible contributor to the observed startup delay; the available telemetry does not prove it was the sole cause of that live delay.

## Parent-session evidence

| Observation | Result |
| --- | --- |
| Tests original turn started | 2026-11-05 19:30:43 UTC |
| Tests original turn completed | 2026-11-06 03:17:53 UTC |
| Duration | About 7 hours 47 minutes |
| Compactions in that turn | Seven: 20:16, 21:14, 22:04, 23:03, 00:16, 01:48, 03:01 UTC |
| Original task retained | Exact internal comparisons found it in all seven replacement histories |
| Model-selected collaboration calls | 36 `spawn_agent`, 99 `followup_task`, 224 `send_message` calls |
| Later Tests turn | Started at 03:39:14 UTC, followed by a new user-message item at 03:39:19 UTC |
| Active BuyerWhiteGenerator NEW turn | Started at 03:23:36 UTC; zero compactions through the aggregated 03:50:36 UTC snapshot |

A separate saved BuyerWhiteGenerator tile referred to a record missing from the current session store. Its provider session was not guessed or investigated as though it were the active tile.

## What the evidence supports

Compaction happened during the long Tests turn, but the original request was retained. This does not support the specific claim that compaction erased the task and thereby caused the work to continue. It cannot rule out lost intermediate decisions, an inaccurate summary, or model scope drift. Collaboration-call counts show extensive model-directed delegation, but counts alone cannot establish that the delegated work exceeded the user's request.

The inspected extension code reports compaction events and finishes after the main provider turn completes. It does not start another model turn merely because compaction occurred or because a task completed successfully. Continuations in this code come from explicit user steering, queued messages, deferred question answers, or bounded pre-execution transport recovery.

Both inspected parent sessions used `gpt-6-astra` with effort `max`. Claude's configured `maxTurns: 0` means unlimited. The inspected Codex integration has no work budget setting. The context-window setting controls the displayed occupancy indicator; it is not a stopping condition. Manual task notes are not automatically sent to a provider and do not enforce completion.

## Completion discipline

Long tasks need concrete acceptance criteria and a durable distinction between requested work, completed checks, and unrelated findings. Repeating a review or test should identify a relevant code or assumption change. Once the requested checks pass, unrelated improvements should be reported for a later task instead of silently extending the current one. This investigation does not introduce an arbitrary runtime cutoff or disable native compaction.

## Provider references

The [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server) describes metadata-only resume, main-turn completion, native history forks, and conversation reversion. The [Claude SDK session guide](https://code.claude.com/docs/en/agent-sdk/sessions) distinguishes persistent conversation history from filesystem state and documents native session forks. Native conversation editing must preserve that distinction.
