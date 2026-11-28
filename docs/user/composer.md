# Messages and context

Use the composer to send prompts, attach files, reference threads or pull requests, invoke skills, and steer or queue follow-ups.

## Limits and large pastes

- **Message length**: Up to 120,000 characters.
- **Large pastes**: Pasting 32 KiB+ of text (or any paste that would exceed the message limit) turns it into a text-file attachment so it doesn't bloat the prompt. Use `Cmd+Shift+V` (Apple) or `Ctrl+Shift+V` (Windows/Linux) to paste inline instead.

## Team conversations and non-code delivery

On web and desktop, open the model picker and select **Orchestrator**. Choose the
orchestrator's provider and model, then a team. The team's seats are offered as
participants, each on the provider and model the team gives it; a seat with no model
of its own uses its provider's default. Untick a seat to leave it out, or change its
provider and model for this conversation only.

The orchestrator follows the instructions of the seat its provider holds in the team,
and that seat sits out as a participant unless you tick it. You are asked for a role
only when the provider holds no single seat in the team. A seat whose provider cannot
be used says why: fix the provider in Settings, choose another, or leave the seat out.
**Add participant** brings in any provider and model for this conversation only, in a
role of the team; untick the team's own seats to run a lineup that is entirely yours.
Nothing is saved to the team. Use **Lead** beside a participant to make that seat the orchestrator instead. **Edit team**
opens the team's profile, where its seats and defaults are kept, and **New team** starts
a profile of your own from the chosen team.
Choose between two and twelve participants. Two seats may use the same provider and model.

Sending starts a native T3 team conversation. Participants contribute independently,
then critique the findings before the lead brings the results together. The critique runs on the first message only unless you set **Critique round** to every message or never; follow-ups always get fresh contributions. Their
threads and results stay linked to the conversation. Follow-up messages use the
same team with the conversation's context. Participants only
discuss: the orchestrator decides who does what, does the work itself or hands each
piece to one participant, and checks the result. Participants are read-only unless
you say otherwise, so the orchestrator can hand them questions and reviews only. Set
**Participants' access** to full access, or to ask you before each change, to let the
orchestrator hand them work that changes things. Each
participant also has its own access beside its name, which comes first: give full
access only to the seats that should build. A seat the team's profile keeps read-only
stays read-only until you change it there. A provider
that cannot be held to read-only says so in the setup: leave it out or use full access.
The lead uses the project's folder and your selected access
settings. Use **Use ordinary chat** to leave Orchestrator before starting.

**When a seat is limited** decides what happens when a participant's model, or the
orchestrator's, has reached its usage limit. **Swap automatically**, the default, starts
that seat's next turn on the first free model in your Favorites: one that is available,
not limited itself, not on the limited model's account or provider, and not already used
in the conversation. A limited orchestrator continues in a new linked thread with a
summary, and the old thread stays readable and no longer resumes by itself. **Ask me**
shows a notice naming that model with one button to swap. **Leave it out** has the seat
sit the message out. A model you chose for a seat by hand is never swapped without
asking. With no favorite free, the seat waits and a notice says so. Put your Favorites
in order under Settings, Providers, **Favorites order**. The setting applies from your
next message; a board task's conversation follows its team's own setting instead.

Choose **No team** in the setup to run a conversation with participants of your own
only: add two or more, each with any provider and model. They join as themselves,
with no team instructions, and nothing is saved.

Once a conversation has started, open the model picker and choose **Orchestrator** to
change who joins: tick seats on or off, add or remove participants, or change the
critique round and access. Every change is saved as you make it, from your next
message on; messages already answered are not rerun. The same panel brings
participants into an ordinary conversation that has already started, from a team's
seats or of your own choosing, and **Use ordinary chat** sends them away again. A
conversation keeps the team it started with.

When that team's setup changes, the next discussion adopts the updated setup
automatically in the same conversation. Messages, context and recorded contributions
stay in place. A discussion already in progress keeps its original setup; a
participant whose setup changed waits for the next message.

While a team conversation runs, the badge beside the composer says who receives the
next message. Use the **Team chat / Single chat** switch beside it to narrow the
conversation to the lead alone and to bring the team back: the team, lead model
included, is remembered for the conversation on the server, so it returns as it was
on any device. Picking another harness or model in the model picker while a team is
on switches straight to single chat with it, remembering the team the same way. In
the started conversation's Orchestrator panel, **Chat 1:1** beside a participant
keeps this conversation and routes the next messages to that participant's harness
and model until you switch the team back on. When a thread cannot switch harnesses
in place, such as a team-bound conversation, the switch continues in a native fork
that carries the discussion over.

Files and images attached to a message reach the orchestrator as usual. Participants
are given their paths to read.

Start a delivery task explicitly with **New task** on the Board. Existing engine
chats and their linked tasks remain available from the Board.

Enable **Non-code delivery** in the team's profile to produce stories, reports,
presentations or assignments. Choose its producer and validation seats, and set
whether evidence and references are required. Review-duty seats provide the final
review. Every active seat must use read-only access.

You can start non-code delivery directly, or discuss the brief first and use
**Create task from chat** to make a linked draft. Check that draft and submit it
when you want work to begin. Creation alone never starts the assignment.

The team plans, checks sources when needed, produces editable files, validates
them against the brief and reviews them independently. One revision round is
allowed before unresolved issues stop the task. Download the attached files and
validation record, then accept the deliverables using the normal sign-off dialog.
Acceptance records the reviewed file versions; it does not publish a code PR,
submit coursework or certify an official grade. Reflections requiring actual
feedback cannot be completed before you supply it.

Native T3 team conversations are stored as threads. Board tasks and engine chats
keep their history in the delivery engine. Native mobile does not yet provide the
delivery view.

## Formatting

The composer renders Markdown live as you type and reveals raw markers when your cursor enters styled text. The agent receives the exact Markdown you typed.

- Disable live styling in **Settings → Chat → Rich text composer**.
- Standard Markdown triggers (`- `, `1. `, `- [ ] `, `> `, `# `, `---`, and ` ``` ` + Enter) create lists, quotes, headings, rules, and code blocks.
- In lists/quotes, `Shift+Enter` continues (or exits on an empty line), and `Tab` / `Shift+Tab` indents or outdents.
- In code blocks, `Enter` keeps indentation, `Tab` / `Shift+Tab` indents selected lines, and closing ` ``` ` + Enter (or two blank lines) exits the block.

## Attach files

Attach up to **100 files** per message:

- **Images**: Up to 10 MiB each, 80 MiB total per message. HEIC/HEIF photos are converted to JPEG, and oversized photos are resized automatically.
- **Other files (including videos)**: Up to 50 MiB each (subject to environment limits). Video attachments pass a file path; only [Antigravity](./providers-antigravity.md#skills-and-attachments) sends supported videos natively to Gemini models.

Files upload to the environment's machine as soon as you attach them, and all uploads must finish before sending. Provider and model limits still apply.

- **Web and desktop**: Drag, paste, or pick files. Reloading before an upload finishes requires re-attaching.
- **Mobile**: Pick files, share into T3 Code via the system share sheet, or drag images in Android split screen.

See [images and videos](#images-and-videos-in-messages) for previewing and saving media.

## Send while the agent is working

Choose your default follow-up behavior in **Settings → Chat → Follow-up behavior** (per client):

- **Queue**: Holds the message on the server for the next turn.
- **Steer**: Injects the message into the running turn (when supported by the agent).

Shortcuts while a turn is running:

- **Opposite action**: `Cmd+Enter` (macOS) or `Ctrl+Enter` (Windows/Linux) uses the non-default action. If your send shortcut already requires `Cmd/Ctrl+Enter`, add `Shift`. On mobile, long-press the send button or use `Cmd/Ctrl+Return` on a hardware keyboard.
- **Steer oldest queued message**: `Cmd+Shift+Enter` (macOS) or `Ctrl+Shift+Enter` (Windows/Linux) sends the first queued message as a steer without touching your current draft. Remap `thread.steerQueuedMessage` in **Settings → Keybindings**, or add a rule in your [keybindings file](./keybindings.md#edit-the-configuration-file) to trigger it on `mod+enter` when the composer is empty:

```json
{
  "key": "mod+enter",
  "command": "thread.steerQueuedMessage",
  "when": "composerFocus && turnRunning && composerEmpty"
}
```

- **Edit most recently queued message**: `Option+Up` (macOS) or `Alt+Up` (Windows/Linux) at the start of the composer (`thread.editQueuedMessage`).

Slash commands (such as `/compact` or `/context`) wait for the current turn to finish rather than steering into it. [Goal](#goals) commands are the exception.

## Queue messages offline on mobile

Mobile keeps local copies of draft attachments so you can preview them and queue messages offline. Uploads resume on reconnect, and drafts/queued messages survive app restarts and T3 Connect sign-out (restored when signing back into the same account).

## Custom models and defaults

- **Remembered defaults**: T3 Code remembers your last provider, model, and options for new threads. A project's configured model overrides this. Leaving reasoning level or service tier unset uses the provider's default.
- **Custom models**: Add unlisted models in **Settings → Providers → Models** (web and desktop; not supported for Antigravity, which uses its account catalog).
- **Rename a built-in model across all clients**: Add an entry in the server's `userdata/settings.json`:

```json
{
  "providerInstances": {
    "codex": {
      "driver": "codex",
      "config": { "customModels": [{ "slug": "gpt-5.5", "name": "Team GPT" }] }
    }
  }
}
```

## Quote an assistant response

- **Web and desktop**: Select text in an assistant message and click **Cite in composer**. Click the pencil on the chip to add or edit a comment; click the chip to jump back to the source.
- **Mobile**: Long-press an assistant response, select text, and tap **Cite**. Tap a quote chip to edit its comment, remove it, or jump to the source message.

Quoted text and comments count toward the message length limit and are preserved across copy/paste and [stashed prompts](#prompt-stash).

## Recall a sent prompt

Press `ArrowUp` in an empty composer to cycle backward through earlier prompts in the thread, and `ArrowDown` to move forward. Only prompt text is restored (not attachments or context chips). Editing a recalled prompt turns it into a normal draft.

## Suggested next prompt

Enable **Settings → Labs → Suggest next prompt** (web and desktop) to show a predicted next message in the empty composer after a Claude or Codex turn completes.

- Press `Tab` to accept or `Escape` to dismiss.
- Each suggestion uses one cached request against your plan's usage. Claude skips suggestions on the first turn and near usage limits.
- Codex requires CLI version 0.165+ (update in **Settings → Providers**). Open Claude threads pick up the setting after restarting.

## Edit an earlier prompt

On web and desktop, select **Edit from here** under a sent message to rewind the conversation to before that message and return it to the composer:

- **Revert and keep changes**: Rewinds the conversation only.
- **Revert files too**: Restores workspace files to the checkpoint before that message (including your own edits). Only available for worktree threads when no other thread or active session shares that directory.

Rewinding removes later messages from the active thread and provider history (requires provider rewind support), but cannot undo external actions or separate provider memory.

## Prompt stash

On web and desktop, press `Cmd+S` (macOS) or `Ctrl+S` (Windows/Linux) to stash the current draft and its attachments (wait for uploads to finish first). Press the same shortcut in an empty composer to restore the stash (or open the stash menu if you have multiple).

- Holds up to 100 prompts in browser storage; stashes are never auto-deleted.
- Stashes with uploaded files must be restored in their original environment. Uploads expire after 24 hours; use **Attach again** or remove expired files before sending.

## Voice input

Dictate into the composer with the microphone button or `mod+shift+d` (web and desktop). Audio stays on-device or goes only to an environment/provider you explicitly choose in **Settings → Voice**. See [Voice input](./voice-input.md) for setup, mobile dictation, and microphone priority.

## Queued messages

Queued messages appear at the end of the thread (web/desktop) or above the composer (mobile). From a queued message you can:

- **Send now**: Injects it immediately into a running turn (or moves a slash command to the front of the queue).
- **Edit**: Opens the message and its attachments in the composer without losing your existing draft.
- **Remove**: Cancels the queued message.

If you stop the agent or the server restarts, queued messages pause in order. Click **Resume** in an empty composer (or send a new message) to continue. When the provider supports native continuation, **Resume** continues without sending a new prompt.

## Commands and skills

Type `/` for commands or `$` for skills from the selected environment and provider.

- Skills also appear in the `/` menu unless you disable **Settings → Chat → Show skills in slash menu** (under Advanced).
- Provider commands must start the message; T3 Code commands (like `/model`) and `$` skills work on any line.
- `/compact` reduces context usage when supported by the provider.
- `/clear` starts a fresh provider session in the same thread (earlier messages and diffs stay visible above a **New session** divider).
- After adding or changing skills, plugins, or MCP servers, run **Restart agent session** from the command palette so your next message picks up the new config.
- Turn on **Settings → Appearance → Thread details → Context window** to view reported context usage. For automatic idle compaction on Claude, see [compact long conversations](./providers-claude.md#compact-long-conversations).

## Goals

With Codex, Claude, and OpenCode 2.2.5+, send `/goal <criteria>` (for example, `/goal all tests in packages/api pass`) so the agent keeps working across turns until the goal is met.

- `/goal` shows the current goal; `/goal clear` removes it.
- Codex and OpenCode support `/goal pause` and `/goal resume` (stopping pauses the goal).
- On Claude, stopping ends the current turn but keeps the goal active for your next message.
- Sending a new goal or `/goal resume` while working interrupts the current turn unless queued; `/goal clear` and `/goal pause` interrupt only when the agent is actively working on the goal.

## Context in your message

Attached context—files, terminal excerpts, diff/file review comments, preview annotations, pull requests, and threads—appears as inline chips at your cursor. Click a chip to inspect or open its source; copy/paste and [Prompt stash](#prompt-stash) preserve chips across drafts.

- **Pull requests (`#`)**: On web and desktop, type `#` to browse recent PRs in the current repository (linked PRs appear first), type digits to match by number, or type a word to search by text.
- **Threads (`@`)**: Type `@` and part of a thread title to reference a thread on the same server (or on a linked machine when Linked environments is enabled). You can also drag threads from the sidebar onto the composer, or paste a copied thread link. The prompt carries only a reference—the agent reads the thread on demand. Dropping a thread from an unlinked environment attaches a snapshot transcript file instead.
- **Models (`@`)**: Type `@` and part of a model or provider name (e.g. `@opus` or `@opus:opencode`) to reference a model in your prompt (such as for delegation) without changing the thread's model.
- **Images vs. files**: Images keep a thumbnail shelf above the composer plus optional inline chips; files live only as inline chips (deleting the last chip removes the file).

## Attached files

Select any file chip in a draft or sent message to preview it (syntax-highlighted code/JSON, rendered/raw Markdown/HTML/CSV/TSV, audio playback, and ZIP folder browsing up to 50 MB). Large text files show a truncated preview—save the file to read it in full.

When a preview asks for a file password, enter it and select **Unlock**. T3 Code uses the password on your device. Web and desktop can unlock supported PDF, ZIP, Office, and OpenDocument files. The mobile app can unlock ZIP attachments, and Android can unlock PDFs. Ebooks protected by DRM need a compatible reader.

## Images and videos in messages

Select an image or video attachment or link to preview it.

- **Web and desktop**: Right-click media to save it or copy its path/URL.
- **Mobile**: Long-press a thumbnail and choose **Save or share**.

File links point to the file on the environment's machine, so moving or deleting the original breaks the preview—save a copy if you need to keep it.

## Files outside the workspace

Following an agent's file link to a file outside the workspace opens it read-only. External HTML files cannot load neighboring scripts, styles, or images.

## HTML and PDF files in the file viewer

On web and desktop, HTML and PDF files open rendered (HTML previews are sandboxed from your T3 Code session; line-specific HTML links open source view). On mobile, PDFs open in the native iOS viewer or an installed Android viewer.
