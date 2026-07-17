# Parallel development — the two-window system

*(Design doc — nothing is set up yet. A nicer-to-read version: open `PARALLEL.html` in a browser.)*

## Activation (when you're ready — or ask Claude "set up parallel dev")

```
git worktree add ../mapstructor-B -b dev-B
```

…then drop a `serve-8001.bat` in the new folder (`python -m http.server 8001`) and copy this doc into it. One command undoes it all: `git worktree remove ../mapstructor-B`.

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
