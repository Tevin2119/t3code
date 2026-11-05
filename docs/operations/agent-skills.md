# Agent skills on every machine

Instructions for a coding agent on any machine that runs this fork. Follow them in order and
report the result table at the end.

**Goal:** every coding harness this machine's T3 Code runs (Claude, Codex, OpenCode, Antigravity,
DeepSeek, Hermes, Kimi, Pi) can see the nine skills from
[t3dotgg/tstack](https://github.com/t3dotgg/tstack): `council`, `sol-loop`, `full-send`,
`full-stop`, `file-pr`, `babysit-pr`, `takeover`, `modernize`, `leaving-pr-comments`.

This is per-machine setup in the home folder. It changes nothing in this repository; do not commit
or open a PR for it.

## Rules

- Change only the skill folders listed below and `~/.local/bin/tstack-sync`. Never touch
  T3's database, settings, or any `skills/synced` folder (that is Claude.ai's own sync).
- Before copying, check each target for an existing skill with one of the nine names. If one
  exists and is not from tstack, stop and ask the person; do not overwrite it.
- Use real copies, not symlinks. Some harnesses skip symlinked skill folders.
- Do not kill or restart the running T3 server.

## Steps

### 1. Clone the skills

```bash
git clone https://github.com/t3dotgg/tstack ~/Projects/tstack   # or git -C ~/Projects/tstack pull
```

### 2. Find the folders T3's harnesses really use

T3's server may run with different config folders than your shell. Read the env of the running
T3 server process (the one running `bin.ts serve` or the T3 desktop app's server):

```bash
ps eww -o command= -p <t3-server-pid> | tr ' ' '\n' | grep -E '^(CLAUDE_CONFIG_DIR|CODEX_HOME|GEMINI_HOME|KIMI_CODE_HOME|HERMES_HOME|PI_CODING_AGENT_DIR|XDG_CONFIG_HOME|HOME)='
```

On Linux use `tr '\0' '\n' < /proc/<pid>/environ` instead. Export every variable you found in the
shell you run step 3 from. Unset ones fall back to defaults (`~/.claude`, `~/.codex`, ...).

Also check T3's `settings.json` (in its `userdata` folder) under `providerInstances`: a
`config.homePath` there overrides the env var for that provider. If one is set, export the
matching variable with that path.

### 3. Install the sync script and run it

Copy [`scripts/tstack-sync.sh`](../../scripts/tstack-sync.sh) from this repository to
`~/.local/bin/tstack-sync`, `chmod +x` it, then:

```bash
tstack-sync --dry-run   # shows each target folder; check they match step 2
tstack-sync
```

Where each harness reads skills (what the script writes):

| Harness         | Folder                                                                   |
| --------------- | ------------------------------------------------------------------------ |
| Claude          | `$CLAUDE_CONFIG_DIR/skills`                                              |
| Codex           | `$CODEX_HOME/skills`                                                     |
| OpenCode        | `~/.config/opencode/skills`                                              |
| Antigravity     | `~/.gemini/config/skills`                                                |
| Hermes          | `$HERMES_HOME/skills/tstack/` (Hermes groups skills in category folders) |
| Kimi            | `$KIMI_CODE_HOME/skills`                                                 |
| Pi, plus shared | `~/.agents/skills`                                                       |
| DeepSeek        | no folder of its own; it sees them through the shared folders            |

Pi reads both its own `skills` folder and `~/.agents/skills`. Do not copy into Pi's own folder or
it warns about duplicates. If Kimi warns about duplicates the same way, remove its line from the
script and delete its copies.

If `hermes` is installed, confirm with `hermes skills list | grep -E 'council|sol-loop'`.

### 4. Test every harness through T3

Call `orchestrator_capabilities`. For each enabled provider, start one `delegate_task` on its
cheapest model with this task, in parallel:

> Read-only check. Do not read files, search the disk, or run commands, and do not run any skill.
> From the skills your harness loaded for you in this session (your own available-skills list or
> system context only), answer: 1) Is a skill named `council` available? 2) `sol-loop`? 3) `full-send`? 4) List every other skill name you can see. 5) Quote the one-line description
> you were given for `council`, if any. If you cannot see a skills list at all, say exactly that.
> Reply in at most 12 lines.

A pass is `council`, `sol-loop` and `full-send` all present with the description
"Trigger this if the user says 'council'." Your own harness passes if the skills appear in your
own skill list.

If a child fails before answering (login expired, out of usage), that is a provider problem, not a
skill problem. Report it as untested with the error; do not count it as a pass.

### 5. Report

| Harness | Model | Result                                            |
| ------- | ----- | ------------------------------------------------- |
| ...     | ...   | pass / fail (what was missing) / untested (error) |

Plus the folders the script wrote to.

## Keeping it updated

When tstack changes, run `tstack-sync --pull` on each machine. When this guide or the script
changes, copy the script again.

## What the skills do and when they fire

| Skill                                            | Fires                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| `council`, `sol-loop`, `full-send`               | Only on those words                                                 |
| `full-stop`                                      | On "full stop", even as an emphatic sentence ending                 |
| `file-pr`, `babysit-pr`, `takeover`, `modernize` | Automatically when you ask to file, watch, take over or rebase a PR |
| `leaving-pr-comments`                            | Silently whenever an agent comments on GitHub                       |
