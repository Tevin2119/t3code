# Fork upstream sync

The fork-only [upstream sync](../../.github/workflows/tevin-upstream-sync.yml) runs daily on
Tevin2119/t3code. It merges `master` and pingdotgg/t3code `main` into
`automation/tevin-upstream-sync` and keeps one PR, `chore: sync upstream pingdotgg/t3code`, open
against `master`, with the upstream range in its body. When upstream has nothing new it does
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
refs the PR names (`master` first, if listed, then the upstream commit), resolve the files, delete
the report, commit, and push to the same branch. The next run keeps your commits and marks the PR
ready once it merges cleanly.
