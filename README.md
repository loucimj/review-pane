# review-pane

A code review pane that sits beside the chat, modelled on the Codex app's review pane.

- `/review-pane` opens it (it opens by itself in the desktop app), and a **Review** button above the prompt toggles it, with counts of changed files and pending comments (hidden when there are none). `/review-pane add <path>` adds a repository it did not find.
- Repositories: the session's own, any git repo one or two folders below it, its submodules, and any repo Claude edits a file in. The picker shows only the repos this session touched (an Edit or Write there, a turn that changed its files or HEAD, or `/review-pane add`), each with its count of changed files; before anything is touched, the session's own repo alone. Other changed repos sit behind a **+N other changed** toggle, and clean ones are never listed. What a session touched is remembered across reloads and restarts.
- Size: the pane draws at most 50 diff lines at a time, since the desktop drops a pane past about a thousand elements; generated files (source maps, build info, lockfiles) start folded.
- Scopes, per selected repo: **Unstaged** (with untracked files), **Staged**, **Branch** (against a base branch's merge base, remembered per repo), **Commit** (one of the last 20). **Last turn** spans every repo and shows only what Claude's latest turn changed, from a `git stash create` snapshot of each repo taken as the turn starts.
- Diffs are drawn as rows with old/new line numbers and light syntax highlighting. Files start unfolded; click a name to fold it.
- Hover a line and click **+** to comment (on the terminal the **+** is always shown). Pending comments go to Claude with your next message as context; **Send to Claude** fills the prompt with a ready request to address them.
- The diff refreshes after every Edit, Write and Bash call and at the end of each turn.

Needs `git` on the PATH. Commenting needs a surface with text input (not mobile).

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install review-pane --marketplace loucimj/review-pane
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```bash
claude plugin install review-pane --marketplace loucimj/review-pane
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `loucimj/review-pane`, then **Add plugin**.
