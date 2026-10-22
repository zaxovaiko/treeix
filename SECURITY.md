# Security

## Reporting

Report a vulnerability privately through GitHub's "Report a vulnerability" button on the Security tab, or by email to the repository owner. Please do not open a public issue. Expect a first reply within a week.

## What the app touches

- **Local repositories.** Treeix runs `git` in the folders you add and can create worktrees and branches. It never runs `git push`: branches and worktrees stay local.
- **Command line tools.** `gh`, `glab`, `acli`, `claude` and `codex` run with your own accounts and their existing sessions. Treeix never handles those passwords.
- **Terminal sessions.** Shell, Claude and Codex sessions are real processes with your permissions.
- **Secrets.** The Notion token is the one secret the app stores itself. It goes to the system keychain, or to a file readable only by you where there is none (Linux without a secret service), and never reaches the webview or the logs. It leaves the machine only in requests to your own Notion workspace. Jira uses the sign-in of `acli`.
- **The webview has no direct system access.** Every privileged action is a typed Tauri command, and the capability file lists what the window may call. Remote markdown and HTML are sanitized before rendering.
- **The terminal daemon** listens on a Unix socket in the app's data folder, readable only by you, and checks the peer's user id.
- **The MCP server and routine webhooks** bind 127.0.0.1 only. The MCP server requires a bearer token.
