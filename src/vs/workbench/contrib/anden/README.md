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

On macOS, the main window keeps the native window buttons in the Sessions header and uses the noninteractive areas of the header to move the window. Native tabs or simple fullscreen retain the standard system title bar for compatibility.

## Interface font

The desktop window uses a bundled Google Sans variable font for UI text. Its Latin subset covers Spanish; other scripts fall back to the workbench's platform and locale fonts. Terminal rendering, editor font settings, and native system controls are unchanged.

`browser/media/anden-google-sans.woff2` is derived from the normal Google Sans v14.000 font in [Google Fonts, revision `06bfe0d`](https://github.com/google/fonts/tree/06bfe0d62a98375cb09c942fa18e68bd32cff057/ofl/googlesans). The license and copyright notice are in [`licenses/google-sans-OFL.txt`](../../../../../licenses/google-sans-OFL.txt). To reproduce the asset from `GoogleSans[GRAD,opsz,wght].ttf` using FontTools 4.62.1 and Brotli 1.2.0:

```sh
pyftsubset 'GoogleSans[GRAD,opsz,wght].ttf' \
  --output-file=browser/media/anden-google-sans.woff2 \
  --flavor=woff2 \
  --unicodes='U+0000-024F,U+0300-036F,U+1E00-1EFF,U+2000-20CF,U+2122,U+2212' \
  --layout-features='*'
```
