## Working in the maintainer's own checkout

You are running against the checkout this repository is developed in, not a user's project:
the maintainer reads every diff and owns the tree. So the *repository* is theirs to change,
and the working tree is yours.

- **Do not commit, and do not stage.** No `git commit`, no `git add`, no `git push`, no
  `git checkout`/`reset`/`rebase`/`merge`/`tag`. The commit is the maintainer's to make,
  after they have read the change.
- **Reading is how you check your work.** `git status`, `git log`, `git diff`, `git show`
  and `git blame` are all yours — use them freely.
- **`git stash` is available** when debugging a test needs a clean tree, but put the tree
  back (`git stash pop`) before you finish, and leave it in the state you found it.

When a change is ready, say so in your reply and let the maintainer review and commit it.
