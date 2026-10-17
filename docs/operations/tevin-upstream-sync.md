# Fork upstream sync

The fork-only [upstream sync](../../.github/workflows/tevin-upstream-sync.yml) runs daily on
Tevin2119/t3code. Each run fetches current `master` and merges pingdotgg/t3code `main`
into a fresh branch, `automation/upstream-sync-YYYY-MM-DD` (UTC). If any same-day branch exists
locally or remotely, it chooses a numeric suffix above every existing same-day local and remote
suffix, so a fresh checkout still supersedes earlier runs. A clean merge opens
a normal PR, `chore: sync upstream pingdotgg/t3code`, against `master`, with the upstream range
in its body. After the replacement PR exists, the workflow comments with its link and closes
older open sync PRs, including the legacy `automation/tevin-upstream-sync` PR. Branches remain
available for recovery. When upstream has nothing new it does
nothing. It never pushes `master` and never force-pushes.

It needs the repository secret `UPSTREAM_SYNC_TOKEN`: a fine-grained token for Tevin2119/t3code
with Contents, Pull requests and Workflows read and write. Without it the run fails and names the
secret. Renew the token before it expires. Actions must be enabled for the fork. GitHub runs
schedules only from the default branch, and turns them off in public repositories after 60 days
without activity. CI on the sync PR needs the Blacksmith runners that `ci.yml` uses.

Start a run by hand with `gh workflow run tevin-upstream-sync.yml --ref master`, or from the
Actions tab. Runs from other branches are skipped.

When the merge conflicts, the PR is a draft that lists the conflicting files and adds only
`.github/tevin-upstream-sync-conflicts.md`. To resolve it, check out the sync branch, merge the
upstream commit the PR names, resolve the files, delete the report, commit, and push to the
same branch. Mark the PR ready for review when your resolution is complete.

The next run starts from current `master` again; it does not carry unmerged human commits from
older sync branches. Before a daily replacement, merge a reviewed resolution if it is ready.
If a PR was superseded first, follow its replacement link and recover work from the retained
old branch: fetch both branches, inspect their diff, and manually apply the resolutions still
needed on the replacement. Do not blindly cherry-pick its report or merge commits. No branch
is deleted automatically.

If publication fails because the remote branch changed during the run, rerun the workflow to
prepare a new candidate with an unused name. A retry of just the PR step uses the saved prepared
branch and preserves reviewer text outside the automation section.
