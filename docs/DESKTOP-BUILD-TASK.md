# Task: build and run the t3code desktop app from source (Windows)

Repo: C:\Users\Tevin\source\repos\t3code (branch add-pi-kimi-harnesses — this fork already has pi/kimi/Hermes harnesses + auth controllers + registration fix + timeout + icons committed).

## Goal
Get the Electron desktop app building and running locally from source on Windows, so the fork can actually be used.

## Read first
- docs/internals/overview.md (the build-from-source entry point).
- README.md (the `t3` CLI + how to run locally).
- apps/desktop/package.json (how the Electron app builds/runs).
- package.json (root scripts: dev = `node scripts/dev-runner.ts dev`, build = `vp run --filter './apps/*' build`).

## Then
1. Install deps (pnpm@11.10.0, node v24 — deps are already partially installed, but verify/complete with `pnpm install`).
2. Build the apps (server + web + desktop) per the docs.
3. Get it running locally — either the Electron desktop app or the `t3` server + local web app (whichever the docs describe as the canonical local dev path).
4. Report the exact working commands + any errors + fixes.

## Constraints
- Do NOT commit anything (build/run task, not a code change).
- Report the exact build/run commands and whether the app actually launches.
- If the build fails, report the exact error + everything you tried.

## Report back
- The working build/run commands.
- Whether the app launches (and whether the new pi/kimi/Hermes providers show up in Settings -> Providers).
- Any blockers (e.g. a native dep that doesn't build on Windows).
