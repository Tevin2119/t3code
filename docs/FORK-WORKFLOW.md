# How this fork is run

This is a fork of `pingdotgg/t3code` that adds provider harnesses (Kimi, pi, Hermes and others)
and will carry the features our team builds on top. It is a PUBLIC repository. Read the last
section before you commit anything.

## Branches

| Branch   | What it is                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `master` | What the host runs. Only ever moved by merging `dev` into it. Always builds.                                              |
| `dev`    | Integration. Branch off it, do the work, merge back into it.                                                              |
| `main`   | A clean mirror of upstream `main`. Never commit to it. It exists so upstream changes can be pulled in without surprises. |

The pipeline:

```
git checkout dev && git pull
git checkout -b feat/<short-name>
# work, commit
git checkout dev && git merge --no-ff feat/<short-name> && git push
# when dev is tested and good:
git checkout master && git merge --no-ff dev && git push
```

## Taking upstream changes

Upstream is alpha software and moves quickly, so do this often. Small merges are easy; a
hundred commits at once is not.

```
git remote add upstream https://github.com/pingdotgg/t3code.git   # once
git fetch upstream
git checkout main && git merge --ff-only upstream/main && git push
git checkout dev && git merge main
# resolve, run `pnpm typecheck` in apps/server and apps/web, test, push
```

Our changes live mostly in the provider drivers, which keeps these merges small. Keep new
features in their own folders for the same reason.

## Running it on a host

Build and run from `master`, from source. Do NOT run `t3 update` on a host that runs this fork:
it downloads upstream's release and replaces our build, and the added harnesses disappear.

## This repository is public: no secrets, ever

GitHub does not allow a fork of a public repository to be made private. That is fine, because
nothing secret belongs in the source code:

- Sign-ins for each AI harness live in that harness's own store on the host.
- T3 Code's own state (threads, settings, pairing) lives under `~/.t3/userdata` on the host.
- Bot tokens and API keys are given to the running service through its environment on the host.

Never commit a key, a token, a `.env` file or a config file that holds one. If a feature needs
a secret, it reads it from the environment at run time.
