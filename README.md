# pi-session-review

Review code changes in your browser with line-level commenting. Comments are sent directly to pi as a follow-up message.

## Install

```bash
pi install git:github.com/siam/pi-session-review
```

## Usage

1. Make code changes in a git repository
2. Run `/changes` in your pi session
3. Browser opens with a diff view of all changes
4. Click any line to add a comment
5. Click **Send Comments** to deliver them to pi

pi receives all comments as a single follow-up message and addresses them.

## What it does

- Shows `git diff HEAD` for tracked changes
- Shows full-file diff for new/untracked files
- Live-refreshes when files change on disk
- Line-level commenting with batch delivery to pi
- Comments stored per-session in `~/.pi/agent/sessions/`
