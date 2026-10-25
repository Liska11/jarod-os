# Workspace: code tasks, agents, and writing while the agent works

Two features borrowed from [PandaCode](https://github.com/aicodeking/pandacode): code tasks that each live in their own git worktree, and a message queue with mid-turn steering in the chat.

## Code tasks (Workspace page)

The **Workspace** page (sidebar, or "open workspace" in the command bar) works on one git repository, chosen with the native folder picker.

| Tab | What it does |
| --- | --- |
| Changes | Lists the repository's task worktrees. A task is a branch plus a folder next to the repository (`<repo>-worktrees/<branch>`), created from the current `HEAD`. Shows the selected task's changed files and a coloured diff, and merges the task into the main checkout's current branch (`--no-ff`). |
| Agents | Runs **Claude Code** (`claude -p`) or **Codex CLI** (`codex exec`) inside a task worktree, with the user's own login. Never in the main checkout. |
| GitHub | Pull requests and issues of the repository, read through the GitHub CLI (`gh`) already signed in on the machine. |

Rules the engine enforces (`jarod-core/packages/bridge/src/main/handlers/codespace.ts`):

- The renderer never types a path. The repository comes from `select-folder` and passes the file gate on every call; a worktree is accepted only if it is in `git worktree list` for that repository.
- Creating a worktree, merging and running an agent each ask for a **native confirmation** (cancel by default). With no native dialog (headless), they are refused.
- A merge is refused when the main checkout has uncommitted changes, and is aborted on conflict.
- The agent's prompt goes through standard input, never the command line. Only the model name (validated) is a variable argument.

The same operations are available to Jarod's own agent as tools: `worktree_create`, `worktree_diff`, `worktree_merge`, `cli_agent_run`, `team_run` (up to three workers in parallel, one worktree each), `github_list`, `github_pr_view`, `github_pr_create`, `deploy_run` (Vercel, Cloudflare Workers, Railway, Google Cloud), `simulator_list`, `simulator_screenshot`. Everything that writes or leaves the machine is a `dangerous` tool, so it goes through the usual approval.

Code: `jarod-core/packages/plugins/workspace` (services and tools), `apps/desktop/src/features/workspace` (page).

## Writing while the agent works (chat)

While a turn is running the composer stays usable:

- **Enter** puts the message in the **queue**. It leaves, in order, when the turn ends.
- **Ctrl/Cmd+Enter** **steers** the turn in progress: the agent reads the note before its next step, without being interrupted. A note written during the very last answer makes the turn continue instead of being lost.
- After a turn that was **stopped or failed**, the queue waits (the strip above the composer says so) until the user resumes or clears it.
- A steering note the turn ended before reading goes to the front of the queue.

Gateway protocol (JSON-RPC, beside `prompt.submit`):

| Method | Effect |
| --- | --- |
| `prompt.queue` `{session_id, text}` | Queues the message; with no turn running it starts one at once. |
| `prompt.steer` `{session_id, text}` | Hands a note to the running turn. Errors with "no turn is running" otherwise. |
| `prompt.queue.list` / `.remove` `{id}` / `.clear` / `.resume` | Manage the queue. |

Notifications: `queue.update` `{session_id, items}` whenever the queue changes, and `prompt.started` `{session_id, id, text, from_queue}` when a queued message begins its turn.

The queue lives in the gateway process (`gateway/prompt-queue.ts`), per conversation: it does not survive a restart of the engine. The agent loop reads steering through `AgentHooks.steering` (`plugins/agent/src/agent.ts`); callers without it (scheduled tasks, bots, sub-agents) are unchanged.

## Not covered

- Cloud sandboxes (Daytona, Cloudflare, AWS) and AWS as a deploy target.
- A graphical team launcher: `team_run` is a tool for the agent, not a button.
- Codex's JSON event format is read from its documented `exec --json` events but was not run against a real Codex here; Claude Code's `stream-json` likewise. Both are covered by tests against a fake agent only.
