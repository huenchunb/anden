# Anden: session-first desktop window

From the repository root, using the Node and pnpm versions pinned in `.nvmrc` and `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm run build-fast
./scripts/code.sh --new-window
```

**New Session** launches Pi or Codex in a selected local folder. The folder opens as the session's working directory, not as a new workbench window. Anden asks before using a folder that is not already trusted. Select a session on the left or press **Cmd+Option+J** on macOS (**Ctrl+Alt+J** elsewhere). Close a session with its **×** button. Only the visible session receives keyboard input; other terminal processes keep running.

If an executable is not found on the shell PATH, add `anden.pi.executablePath` or `anden.codex.executablePath` to the profile's `User/settings.json`. Use an absolute path to a directly executable file. Anden doesn't install the CLIs, sign in for you, or send prompts.

Sessions use the existing integrated terminal engine but are not editor tabs or bottom-panel terminals. They are transient: closing or reloading the window does not restore them. The IDE and GitHub views are not part of this window yet.
