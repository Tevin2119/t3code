# Task: bisect the Hermes ACP session/new hang to its root cause

Repo: C:\Users\Tevin\source\repos\t3code (branch add-pi-kimi-harnesses).

## Context
You already found that `hermes acp`'s `session/new` hangs against the full Hermes config (209 MCP tools from 6 servers, 57 plugins, tool_search, memory) but answers in 7.9s with a minimal HERMES_HOME (no MCP servers, toolsets off, memory off). The 6 MCP servers themselves connect fine (200 OK in the logs), so the hang is post-MCP-build. Now bisect which subsystem is the culprit.

## What you have
- The HermesAdapter + mock-agent + ACP test infra from the earlier work (apps/server/src/provider/acp/ + the Hermes driver). Use it to drive `session/new` against real Hermes.
- Hermes config: C:\Users\Tevin\AppData\Local\hermes\config.yaml. The 6 MCP servers: chargebee_live (remote), mongo_clubright (local node), taskboard (remote), payments (remote), payments-dev (remote), browser (local 127.0.0.1:8931).

## Do
Bisect by pointing HERMES_HOME at a temp dir with a trimmed config that enables ONE subsystem at a time, then drive `session/new` and time it:
1. MCP servers only (6 servers; no plugins, toolsets off, memory off).
2. Plugins only.
3. Toolsets / tool_search only.
4. Memory only.

Find which one causes `session/new` to hang (vs answer in seconds). If none of them alone hangs, test pairs. Report the culprit + the minimal config that reproduces the hang + the timing evidence.

## Constraints
- Do NOT commit.
- Do NOT leave stray `hermes acp` processes running.

## Report back
- The culprit subsystem (MCP / plugins / tool_search / memory) + the exact minimal config + timings.
- If it's one specific MCP server or plugin, name it.
