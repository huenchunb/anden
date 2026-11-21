# Anden: terminal sessions

Anden opens Pi and Codex as independent processes in the integrated terminal. It doesn't install the CLIs, sign in for you, or send them prompts.

## Try it in Code OSS

From the repository root, with the Node and pnpm versions pinned in `.nvmrc` and `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm run build-fast
./scripts/code.sh /absolute/path/to/a/local/repository
```

On Windows, use `scripts\code.bat` instead of `scripts/code.sh`. To recompile just Anden after a code change, run `pnpm run gulp compile-extension:anden`, then reload the Code OSS window.

1. Open **Anden** in the Activity Bar and choose **New Session** (or run **Anden: New Session** from the Command Palette). Select **Pi**, then repeat for **Codex**. You can open more than one instance of either.
2. Click a session to focus its terminal, or press `⌘K`, then `J` on macOS (`Ctrl+K`, then `J` elsewhere). The shortcut is reassignable under **Keyboard Shortcuts → Anden: Switch Session**.
3. Open a file or a source control diff and edit it. Return to either running agent with the shortcut. Closing one terminal removes only that session from the list.

Anden launches only in local, trusted workspaces. When multiple folders are open, it uses the folder of the active file if possible; otherwise it asks. Sessions in the same folder share the working tree. Anden doesn't restore sessions after a window reload or restart.

### If a CLI is missing

Anden looks for `pi` and `codex` on the application's `PATH` (`pi.exe` and `codex.exe` on Windows). A graphical launch can see a different `PATH` than your shell. Set the absolute path to each executable in **User Settings** if needed:

```json
{
  "anden.pi.executablePath": "/absolute/path/to/pi",
  "anden.codex.executablePath": "/absolute/path/to/codex"
}
```

The configured file must be directly executable by the integrated terminal; shell aliases and Windows `.cmd` launchers are not supported. Sign in through each CLI if prompted.

### Focused tests

```sh
pnpm run gulp compile-extension:anden
node --test extensions/anden/out/test/*.test.js
```
