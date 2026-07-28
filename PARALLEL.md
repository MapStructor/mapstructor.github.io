# Parallel development — the two-window system

*(Set up 2026-07-27. A nicer-to-read version: open `PARALLEL.html` in a browser.)*

## ⚠ How to always know you're in B, not A

Three signals, on every surface you touch — you never have to remember:

| Surface | Window A (main) | Window B (side) |
|---|---|---|
| **Browser** | green **WINDOW A · master** badge at top-center; URL is **:8000** | **orange WINDOW B · dev-B** badge at top-center; URL is **:8001**; the tab title starts with **🅱** |
| **Terminal** (the serve window) | green screen titled *WINDOW A* | **yellow screen titled ## WINDOW B ##** |
| **VS Code** | default title bar | **bright-orange title bar + activity bar**, title starts with **🅱** |

The browser badge is **injected at serve time by `mapstructor-B/serve.py`** (via `platform/window-badge.js`) — it is **never** in the committed platform code, so it can never reach A or production. The VS Code coloring lives in `mapstructor-B/.vscode/settings.json`. Both are B-only (see below).

**The one rule that makes the port reliable:** always start each folder with **its own** serve script — the plain server for A on :8000, `serve-8001.bat` (→ `serve.py`) for B on :8001. Same port ⇒ same window, every time.

## B-only — never travels to master

Some files exist **only in B** and must never be committed to `dev-B` and merged into `master` (they're dev aids / would pollute production):

| B-only file | What it is |
|---|---|
| `serve.py` | local dev server that injects the window badge |
| `serve-8001.bat` | B's launcher (calls `serve.py 8001`) |
| `platform/window-badge.js` | the badge markup/logic, injected by `serve.py` |
| `.vscode/settings.json` | B's orange editor chrome |

**How they're kept B-only:** each is listed in `.git/info/exclude` (the repo's *local, un-committed* ignore list, shared by both worktrees). Git therefore treats them as untracked in B — they never appear in `git status`, can't be `git add`ed by accident, and never enter a commit. To add a new B-only file, append its path to `.git/info/exclude`.

**Rule of the road:** the badge and any window-identity aid go in `serve.py` / `window-badge.js` (B-only), **never** in shared platform files. That keeps A and production completely unaware they exist.

## Before any git operation in B — check nothing is running

Git operations that rewrite many files at once (`merge`, `stash`, `checkout <branch>`) can collide with a live server or an open editor mid-write. **Plain file edits are safe anytime; branch-level git ops are not.** Check first:

```
netstat -ano | findstr ":8001 .*LISTENING"     # a line = B's server is live
```

If B's server (or a task) is running, finish/stop it before merging or switching. Simple edits and commits are fine.

## Already set up (2026-07-27)

```
git worktree add ../mapstructor-B -b dev-B     # done — the B worktree exists
```

- `c:\repos\mapstructor-B` — the B worktree on branch `dev-B`
- `mapstructor-B\serve-8001.bat` and `mapstructor.github.io\serve-8000.bat` — double-click to serve each window
- `mapstructor-B\.vscode\settings.json` — the orange B chrome (git-ignored)
- the `platform/topbar.js` badge — in both worktrees

Undo it all: `git worktree remove ../mapstructor-B` (from the main folder), then `git branch -d dev-B` once merged.

## The two folders

| | Window A (main) | Window B (side) |
|---|---|---|
| Folder | `c:\repos\mapstructor.github.io` | `c:\repos\mapstructor-B` |
| Branch | `master` | `dev-B` |
| Server | `serve-8000.bat` → **:8000** | `serve-8001.bat` → **:8001** |
| Role | The product; day-to-day work | A feature at a time (joins, JSON, experiments) |

Both folders are the **same git repository** (a "worktree") — one shared history, two checkouts.
GitHub Desktop sees them as one repo; whichever folder you have open determines which branch you're committing to. You never switch branches — you switch folders.

## The rules of the road

1. **One window = one folder = one port.** Never open the same folder in both VSCode windows; never serve both folders on the same port.
2. **Commit often, in the window where the work happened.** Prefix Window B commit messages with `B:` so history reads cleanly.
3. **The database is shared.** There is only ONE Supabase — schema changes, SQL runs, and feature edits made from either window hit both immediately. For destructive experiments, use test-prefixed tables/maps.
4. **Gitignored files don't travel.** Secrets, tokens, local settings — git never copies them into B. If B needs one, copy it by hand.
5. **B starts at the last commit.** Anything uncommitted in A does not exist in B. Commit in A first, then in B run `git merge master` to catch up.

## The daily loop

1. Open A in one VSCode window, B in another. Start each folder's serve bat once.
2. Give A's Claude a task; while it runs, switch to B and work there.
3. Test A at `localhost:8000`, B at `localhost:8001` — separate logins, storage, service workers; they can't contaminate each other.
4. Commit each side's finished work in its own window.

## Bringing B's work into the product ("merge B")

In Window A's terminal (or ask Claude: "merge B"):

```
git merge dev-B
```

- **No overlap** → done instantly; A now contains B's feature.
- **Overlapping edits** (you both changed the same lines, e.g. in editing.js) → git pauses and marks each spot in the file with `<<<<<<<` / `>>>>>>>`; pick which side wins (or keep both), save, then `git add . && git commit`. VSCode shows Accept Current / Accept Incoming buttons on each conflict — resolving is a few clicks.

Keeping B fresh (do this regularly, it keeps future conflicts small): in Window B run `git merge master`.

## Disposal / renewal

- Retire B: `git worktree remove ../mapstructor-B` (from A), then `git branch -d dev-B` once merged.
- New feature, fresh B: `git worktree add ../mapstructor-B -b dev-B2`.
- B is disposable; the history it committed is not — merged commits live in the repo forever.
