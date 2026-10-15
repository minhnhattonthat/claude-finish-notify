# finish-notify

Claude Code mod (Windows only): a Claude-styled popup when Claude finishes a response.

- Title is the project folder; click the popup to dismiss it.
- **Focus terminal** raises the terminal window running that session (selects the tab in Windows Terminal; finds the window in VS Code).
- Stacks up to 3 popups; older ones wait hidden and return as others close.

## Install

```
/plugin marketplace add minhnhattonthat/claude-finish-notify
/plugin install finish-notify@finish-notify
```

Needs Windows PowerShell 5.1 (built in).
