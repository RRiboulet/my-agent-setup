# Jira Extension for Copilot CLI

Copilot CLI extension ([`extension.mjs`](extension.mjs)) that exposes 10 tools for Jira Server / Data Center (`/rest/api/2`) using a Personal Access Token (PAT).

## Tools

| Tool | Description |
| --- | --- |
| `jira_check_auth` | Verify Jira connectivity and PAT authentication (`/myself` and `/serverInfo`). |
| `jira_get_issue` | Fetch full details for an issue by key (fields, expand, comments, changelog). |
| `jira_search` | Search issues using a JQL query with pagination and field selection. |
| `jira_get_comments` | List comments on an issue with pagination (`startAt`, `maxResults`). |
| `jira_get_transitions` | List available workflow transitions for an issue. |
| `jira_get_project` | Get metadata for a project by key, or list all accessible projects when omitted. |
| `jira_add_comment` | Add a comment to an issue, with optional role/group visibility restriction. |
| `jira_transition_issue` | Transition an issue by `transitionId` or case-insensitive `transitionName`, with optional comment/resolution/fields. |
| `jira_create_issue` | Create a new issue (or subtask via `parentKey`) in a project. |
| `jira_update_issue` | Update fields on an existing issue (`summary`, `description`, `priority`, `assignee`, `labels`, `components`, `extraFields`). |

## Prerequisites & Installation

1. Enable experimental extensions in `~/.copilot/settings.json`:

   ```json
   {
     "experimental": true
   }
   ```

2. Link this extension into `~/.copilot/extensions` with [`scripts/install.sh`](../../scripts/install.sh):

   ```bash
   scripts/install.sh --copilot-extensions
   ```

3. Restart your Copilot CLI session (`/restart`) so the extension tools are loaded.

## Token Setup

1. In Jira, open **Profile → Personal Access Tokens** and create a token.
2. Save the token to `~/.config/jira/token` with `chmod 600` without echoing it into shell history:

   ```bash
   mkdir -p ~/.config/jira && chmod 700 ~/.config/jira
   umask 077 && cat > ~/.config/jira/token
   # Paste your token, press Enter, then Ctrl-D
   chmod 600 ~/.config/jira/token
   ```

The token file must contain a single-line PAT with no internal whitespace or control characters (a trailing newline is trimmed automatically).

## Usage

### On a host machine

Point `JIRA_TOKEN_FILE` to your token file before starting Copilot CLI:

```bash
export JIRA_TOKEN_FILE=~/.config/jira/token
```

### Inside a devcontainer

Mount the host token file as a read-only secret at the default container path (`/run/secrets/jira_token`) in `.devcontainer/devcontainer.json`:

```json
{
  "mounts": [
    "type=bind,source=${localEnv:HOME}/.config/jira/token,target=/run/secrets/jira_token,readonly"
  ]
}
```

Optionally ensure the file exists on the host before Docker creates the mount (so Docker does not create an empty directory instead) by adding an `initializeCommand`:

```json
{
  "initializeCommand": "mkdir -p ~/.config/jira && touch ~/.config/jira/token && chmod 600 ~/.config/jira/token"
}
```

## Configuration

| Environment Variable | Default | Description |
| --- | --- | --- |
| `JIRA_BASE_URL` | `https://central.jira.automotive.cloud` | Base URL of your Jira Server / Data Center instance (trailing slashes are stripped). |
| `JIRA_TOKEN_FILE` | `/run/secrets/jira_token` | Path to the file containing your Jira Personal Access Token. |

## Verification

Run `jira_check_auth` in Copilot CLI (or ask Copilot to check your Jira connection). A successful call confirms the active base URL, authenticated user, and server version without leaking your token.
