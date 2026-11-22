# Anden: session-first desktop window

From the repository root, using the Node and pnpm versions pinned in `.nvmrc` and `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm run build-fast
./scripts/code.sh --new-window
```

**New Session** opens the folder picker and starts Pi in the selected local folder. The folder opens as the session's working directory, not as a new workbench window. Anden asks before using a folder that is not already trusted. Accept the suggested name (for example, `anden · Pi`) or enter your own. Use the session row’s **…** menu to rename it without restarting the agent. Select a session on the left or press **Cmd+Option+J** on macOS (**Ctrl+Alt+J** elsewhere). Close a session with its **×** button. Switching sessions leaves drafts and in-flight turns intact; closing a session stops only its own agent.

If an executable is not found on the shell PATH, add `anden.pi.executablePath` to the profile's `User/settings.json`. Use an absolute path to a directly executable file. Anden doesn't install Pi or sign in for you. Use Pi's normal authentication and configuration. Anden does not override its tool approval policies or sandbox settings.

New sessions open as native chats, not terminals. **Enter** sends; **Shift+Enter** inserts a newline. You can draft during a turn, but Anden won't queue or send the draft automatically. **Stop** interrupts the current turn. The transcript shows Markdown, tool results and interactive requests. Trusting the folder is not approval to use a tool. Pi's custom terminal widgets and requests Anden cannot represent are not supported.

Next to **Send**, click the model name to search the active agent's catalog, or click **Reasoning** to choose a level supported by the model. `/model` and `/reasoning` open those same pickers; `/settings` gives keyboard access to both. These commands are handled locally; they are not sent as prompts. Settings are per session and can be changed between turns. Anden does not write Pi's global defaults.

The desktop utility process communicates with Pi over RPC (`pi --mode rpc`). The reference version is Pi 1.5.2. Pi saves new sessions in its own session store (normally `~/.pi/agent/sessions/`); Anden does not override Pi's directory settings. The native record can contain more than Anden's history, including tool data, and may be visible in Pi's terminal session selector.

**History** retains session names, folders, messages and unsent drafts in the current local profile, including after closing a session or restarting Anden. Opening a saved conversation does not launch Pi, access its repository, or send anything. Once Pi has saved the native file, **Continue Session** verifies the original folder and its trust, reopens the same Pi conversation, and restores the draft without sending it. Older Pi sessions created before native persistence remain read-only. Records from other agents in older builds are not shown and are left untouched on disk. **New Session in This Folder** creates a fresh session with the normal trust check and can copy the saved draft into its composer without sending it. **Delete from History** removes the Anden conversation and draft, not Pi's native session file. History is not synced and does not retain tool output or interactive requests and answers. Messages and drafts are stored as readable text on disk, so avoid putting secrets in them. Older text may be shortened or omitted in very large conversations, and a forced exit can lose the most recent unsaved changes.

**Changes** opens a read-only view of the session’s Git working copy without stopping the chat. It compares HEAD to the index for staged files and the index to disk for unstaged files. Sessions in the same working copy share the branch and change summary; separate Git worktrees are independent. The `+` and `−` totals compare HEAD to disk, count new text files, and omit binaries. The button shows **Changes** without numbers when the total is zero or unavailable. **Refresh** reads local state only. **Back to Chat** returns to the same conversation. The full IDE and GitHub views are not part of this window yet.

Anden Icons are original SVG assets bundled with the workbench under [`browser/media/icons/`](browser/media/icons/). They are local to this UI, not a global file icon theme.

On macOS, the main window keeps the native window buttons in the Sessions header and uses the noninteractive areas of the header to move the window. Native tabs or simple fullscreen retain the standard system title bar for compatibility.

## Interface font

The desktop window uses a bundled Google Sans variable font for UI text. Its Latin subset covers Spanish; other scripts fall back to the workbench's platform and locale fonts. The interface font does not affect terminal rendering, editor font settings, or native system controls.

`browser/media/anden-google-sans.woff2` is derived from the normal Google Sans v14.000 font in [Google Fonts, revision `06bfe0d`](https://github.com/google/fonts/tree/06bfe0d62a98375cb09c942fa18e68bd32cff057/ofl/googlesans). The license and copyright notice are in [`licenses/google-sans-OFL.txt`](../../../../../licenses/google-sans-OFL.txt). To reproduce the asset from `GoogleSans[GRAD,opsz,wght].ttf` using FontTools 4.62.1 and Brotli 1.2.0:

```sh
pyftsubset 'GoogleSans[GRAD,opsz,wght].ttf' \
  --output-file=browser/media/anden-google-sans.woff2 \
  --flavor=woff2 \
  --unicodes='U+0000-024F,U+0300-036F,U+1E00-1EFF,U+2000-20CF,U+2122,U+2212' \
  --layout-features='*'
```

## Code font

Anden’s diff and chat code use **Agave Nerd Font Mono**, 14 px, at weight 500. The bundled faces are Regular (400) and Bold (700). These surfaces use the Anden font even if the profile specifies another font for VS Code’s standard editor or terminal; the profile itself is not changed.

The two `anden-agave-nerd-font-mono-*.woff2` assets in `browser/media` come from `AgaveNerdFontMono-{Regular,Bold}.ttf` in the [Nerd Fonts v3.5.1 Agave archive](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/Agave.tar.xz). They were converted with FontTools 4.62.1 and Brotli 1.2.0 (`TTFont` with `recalcTimestamp=False`, saved with `flavor='woff2'`) without subsetting so the Nerd Font icons remain available. The distribution includes the [OFL license](../../../../../licenses/agave-nerd-font-OFL.txt) and [upstream glyph notices](../../../../../licenses/agave-nerd-font-notices.md).
