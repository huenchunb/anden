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

Next to **Send**, click the model name to search Pi's catalog, or click **Reasoning** to choose a level supported by the model. `/model` and `/thinking` (also `/reasoning`) open those pickers; `/settings` gives access to both. You can also type an exact model (`/model provider/model`) or level (`/thinking high`). Settings are per session and can be changed between turns. Anden doesn't write Pi's global defaults.

Type `/` in the composer to search commands by name or description. Use Up/Down and Enter to select, or Escape to dismiss. The list groups **Anden**, **Extensions**, **Templates**, and **Skills**, showing the resources that Pi reports for the current session. Selecting a Pi extension, template, or skill inserts the command into the draft so you can add arguments before sending it. Some bundled commands need Pi's terminal interface and cannot run in Anden. Anden does not send unknown commands or unsupported terminal commands as prompts.

Anden commands run locally: `/new` opens the normal folder and trust flow, `/resume` browses saved sessions without starting Pi, `/name` or `/name New name` renames the session in Anden and Pi, `/copy` copies Pi's last reply, `/session` shows session information and usage, and `/hotkeys` shows Anden's keyboard shortcuts.

The desktop utility process communicates with Pi over RPC (`pi --mode rpc`). The reference version is Pi 1.5.2. Pi saves new sessions in its own session store (normally `~/.pi/agent/sessions/`); Anden does not override Pi's directory settings. The native record can contain more than Anden's history, including tool data, and may be visible in Pi's terminal session selector.

**History** retains session names, folders, messages and unsent drafts in the current local profile, including after closing a session or restarting Anden. Opening a saved conversation does not launch Pi, access its repository, or send anything. Once Pi has saved the native file, **Continue Session** verifies the original folder and its trust, reopens the same Pi conversation, and restores the draft without sending it. Older Pi sessions created before native persistence remain read-only. Records from other agents in older builds are not shown and are left untouched on disk. **New Session in This Folder** creates a fresh session with the normal trust check and can copy the saved draft into its composer without sending it. **Delete from History** removes the Anden conversation and draft, not Pi's native session file. History is not synced and does not retain tool output or interactive requests and answers. Messages and drafts are stored as readable text on disk, so avoid putting secrets in them. Older text may be shortened or omitted in very large conversations, and a forced exit can lose the most recent unsaved changes.

**Files** opens the session's folder and the native VS Code editor next to the chat. Drag the divider or focus it and use the arrow keys to resize. Use the file tree's context menu or **File Actions** to create files and folders, rename, or delete. The tree does not traverse symbolic links or show `.git` metadata. Save the active file with **Cmd+S** on macOS (**Ctrl+S** elsewhere) or **Save Active File**. Renaming or deleting an item that contains unsaved files requires resolving those edits first.

Each live session keeps its own tabs, editor position, and expanded folders, even with **Files** folded or **Changes** open. The same physical file opened in two sessions shares VS Code's working copy. Closing a session with unsaved edits lets you save, discard, or cancel before its Pi process stops. The native editor honors the profile's editor settings. Anden does not restore its editor tabs after restart; on normal exit it resolves unsaved files rather than hot-exiting into editor parts it cannot restore. Folder-based language features and the full VS Code Explorer command set are not guaranteed in the session workbench.

**Changes** opens a read-only Git review next to the chat. It compares HEAD to the index for staged files and the index to disk for unstaged files. **Open in Editor** opens an available working file inside the session folder. Unsaved editor text is not shown in the diff or automatically saved for Pi. Sessions in the same working copy share the branch and change summary; separate Git worktrees are independent. The `+` and `−` totals compare HEAD to disk, count new text files, and omit binaries. **Refresh** reads local state only. No Git write actions are available in this view.

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
