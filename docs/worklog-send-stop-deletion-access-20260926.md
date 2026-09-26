# Explicit Send, Stop/status, conversation deletion and local access

This follow-up preserves the earlier rich-content, models, compaction and optional dictation
work. It repairs existing owners instead of adding independent message queues, background retry
loops or permission bypasses. Private diagnostics, recordings, credentials and local installers
are not included in this contribution.

## Send and Stop ownership

A due explicit Send could remain queued while the selected browser was already running but
its companion was unavailable. The old startup owner only handled positive process absence.
The explicit immediate-input path now allows its owned URL handoff to a positively running
selected browser when neither the wake socket nor recent authenticated HTTP proves reachability.
Automatic recovery and discovery retain the absence-only rule. Current input/controller/source
checks apply across asynchronous probes and before every executable attempt.

A timed-out Windows launcher is an unconfirmed handoff, not a known failure. It stops executable
fallback instead of risking a second open. Within the current process, a successful or unconfirmed
same-URL launch is not refunded by a later startup-status write failure. Replayed accepted input
UUIDs cannot reacquire startup permission after transient controller reset. This does not establish
cross-restart retry safety for an unconfirmed operating-system wrapper.

Native Stop no longer requires the assistant section to have mounted. An exact accepted question
and current turn can authorize that operation, checked again after command redemption. A later
question, old assistant or unknown reopened owner cannot. Main's existing pending Stop receipt
also reaches `/activity` after its command is acknowledged; a click still does not prove remote
cancellation. Expiry reconciles already-observed exact subsequent work without inventing a new
activity timestamp, extending the deadline or retrying the Stop.

## Sidebar and status consistency

Two additional regressions were reproduced independently:

1. A slow completion read could finish after the recorder's earlier 400 ms notification. The
   sidebar read the still-active grant, and its later retirement produced no notification.
   `endActivity` now projects actual retirement through the existing coalesced recorder notice.
2. A delayed finish belonging to an older request retired the newer turn's activity. The exact
   request/turn check now precedes the finish verdict, instead of applying only to ordinary work.

The selected-chat status and sidebar use the same activity projection. Where only recent activity
remains, the status says **Recent activity · completion not confirmed**, rather than claiming the
provider has stopped or is definitely generating. This wording has no execution authority.

## Deliberate conversation deletion

The old action removed only local history and did not communicate that scope clearly. The native
application confirmation now distinguishes local-only removal from removing the current ChatGPT
conversation too. Cancel is the default. Older compaction-source chats, project files and provider
Library files are explicitly out of scope; no entire-account or project-wide deletion is added.

The main process rechecks the original session/binding, activity, queued input and continuation
before handing out a fixed UI-only browser operation. That operation requires an exact native
conversation menu, its owned confirmation and a still-current empty editor/question/document.
Changed or ambiguous controls refuse deletion. A bounded passive observation of the request made
by that native confirmation establishes success; CoS does not send a private provider API request.
Unconfirmed remote deletion retains the recording instead of reporting both sides deleted.

Confirmed remote IDs are durably retained before local removal. Existing recording queues drain
before their directory is removed. Late observations cannot resurrect the deleted recording, even
after restart, and a failed local removal retains the current mapping. A corrupt deletion ledger
is not silently treated as empty. Local-only removal deliberately retains the possibility of
re-recording an open web chat, as the confirmation explains.

Native observation is limited to non-destructive inspection of the current conversation menu.
No real account conversation was deleted as part of acceptance. An attempted disposable-chat
diagnostic was blocked before execution and was not rerouted; it is not counted as a passing
native test. The deletion transaction/receipt/negative cases are covered with synthetic fixtures.

## Full local access without changing other authorities

Settings and Chat options open one permission-status panel. Applying its one preset requires
an explicit native confirmation and the same validated permission/root snapshot. Only supported
capability flags and Read-only change. Approved roots, blocked chats, exact caller/process custody,
unattributed policy, automation, microphones, external plugins and ChatGPT/OS approvals stay intact.
The UI explains that shell commands run as the logged-in user and are not confined to file-tool
roots. The main writer persists first, then publishes runtime changes outside the config queue
to avoid a dependency deadlock. Cancelled, obsolete and failed saves never report a new grant.

The production preload, IPC handler, configuration writer and UI were exercised in isolated
Electron with synthetic settings and a mocked native consent response. One accepted grant left
roots, automation, attribution policy and the authored draft unchanged. The panel fit 1200/900/520
pixel widths. This does not change or test the user's actual permissions. The new renderer copy
is translated in all six shipped non-English catalogs; native main-process confirmations remain
English.

## Repair installation

The reported R8 inventory failure coincided with six temporary diagnostic files in the enabled
companion directory. Those files were preserved in a private backup; the unchanged R8 preflight
then passed. There was no basis to delete conversation data or replace credentials.

The new inventory helper includes hidden files, refuses links/junctions, and names missing,
changed or additional files rather than reporting only a count mismatch. Replacement package
files remain strictly hash-checked. Extra existing files may be retained in a verified complete
directory backup, not blindly shipped or executed. Required code changes still fail closed.
An isolated execution of the exact local installer checks backup preservation, idempotent replay,
candidate hashes and refusal while an application is running. The final installed-payload check
and signed-in Send/Stop/deletion round trip remain distinct from these fixtures.

## Validation

The first complete run had 6,190 passing tests, 47 skips and one failure in the unchanged Skills
retarget-race test. Its expected error depended on the containing directory's metadata changing,
although the linked package's canonical target had already changed. The existing assertion was
kept and strengthened with a deterministic unchanged-root-metadata variant. A witnessed change
to an approved linked package now invalidates that scan explicitly instead of publishing a
misleading empty catalog. No unapproved file is opened and stable invalid entries remain excluded.
The strengthened case failed before the fix; the relevant two-suite run then passed 19 tests.

Targeted startup, Stop, late-finish/sidebar, deletion, permission, localization and inventory
tests exercise current source, including deterministic before/after failures. The browser worker's
real Chromium startup/import/transport verifier and the new isolated Electron access-panel verifier
also run independently of the installed app. Final software-suite, shutdown, build, staging and
publication results are recorded in the accompanying PR update; component checks do not certify
every provider rollout, native accessibility implementation or real account action.
