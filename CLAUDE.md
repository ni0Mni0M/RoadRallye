# RoadRallye: working rules

## Before a major change

A major change is a new feature, removing a feature, or a redesign. Bug fixes, wording and small
tweaks can go straight to `main`.

1. Commit any pending work on `main`.
2. Tag the current `main` as a restore point and push it:
   `git tag -a before-<feature> -m "Last version before <feature>"`, then
   `git push origin main before-<feature>`.
3. Build the change on its own branch, in a worktree folder next to this one:
   `git worktree add ..\RoadRalley-<feature> -b <feature>`.
   Copy `config.local.json` and `web\data\` into the new folder (both are ignored by git).
4. Commit the work on that branch only. Never commit it to `main` directly.
5. The user compares the versions with `compare.bat` (this folder on port 8765, each worktree on
   8775, 8776, ...).
6. Only when the user says so:
   - keep it: `git switch main`, `git merge <feature>`, `git push`, then
     `git worktree remove ..\RoadRalley-<feature>` and `git branch -d <feature>`
   - drop it: `git worktree remove --force ..\RoadRalley-<feature>` and `git branch -D <feature>`
     (`main` was never changed)

## Project notes

- Tests: `node --test tests/matching.test.js tests/wayhome.test.js tests/ranking.test.js`
- Never commit `config.local.json` (the user's contact for Transitous), `web/data/` or `scraper/cache/`.
- Commits use the repo-local identity `RoadRalley <roadralley@users.noreply.github.com>`.
