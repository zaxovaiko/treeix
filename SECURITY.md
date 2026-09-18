# Security

## Reporting

Report a vulnerability privately through GitHub's "Report a vulnerability" button on the Security tab, or by email to the repository owner. Please do not open a public issue. Expect a first reply within a week.

## What the app touches

- **Local repositories.** Treeix runs `git` in the folders you add and can create worktrees and branches. It never runs `git push`: branches and worktrees stay local.
- **Command line tools.** `gh`, `glab`, `acli`, `claude` and `codex` run with your own accounts and their existing sessions. Treeix never handles those passwords.
- **Terminal sessions.** Shell, Claude and Codex sessions are real processes with your permissions.
- **The Atlassian API token** is the one secret the app stores itself. It is encrypted with the system keychain through Electron's `safeStorage` and never leaves the machine except in requests to your own Atlassian site.
- **The renderer has no Node access**: context isolation is on and `nodeIntegration` is off, so every privileged action goes through the preload bridge. The preload itself runs unsandboxed (`sandbox: false`), which native modules such as the pty need. Remote markdown and HTML are sanitized before rendering.

Plugins run in the same processes as the host and are not sandboxed. Only install plugins you trust.
