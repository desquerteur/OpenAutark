---
name: import-agent-system
description: I read this when the person drops an existing agent system into a chat or names a folder or repository that holds one - CrewAI (agents.yaml, tasks.yaml), Claude Code subagents (.claude/agents/*.md or a --agents JSON), Codex AGENTS.md, a JSON or Markdown list of roles, or an exported agent folder - and I bring it into this team.
metadata:
  modes:
    - manager
    - general
---

# Import an existing agent system

I read the files myself and hire the agents with `agents.create`. There is no import wizard.

## Where the definitions are
- **CrewAI**: `config/agents.yaml` (per agent: `role`, `goal`, `backstory`) and `config/tasks.yaml`
  (per task: `description`, `expected_output`, `agent`). `{placeholders}` are filled at run time -
  they stay words, and I guess no values.
- **Claude Code subagents**: `.claude/agents/<name>.md` (user level: `~/.claude/agents/`). Front matter
  `name`, `description`, optional `tools`, `model`; the body is the system prompt. A `claude --agents`
  JSON maps a name to `{ description, prompt }`.
- **Codex / AGENTS.md**: one project agent. Its first heading or the project name is the name; the text
  is its instructions.
- **Role lists** (JSON or Markdown): each entry or heading is one agent; lines like "Role:", "Reports to:",
  "Mode:" say what they look like.
- **An agent folder of this app** (`agents/<id>/` with `SYSTEM.md`, `agent.json`, `skills/`): the
  `SYSTEM.md` part from "## My role" on (older files: "## Your role") is its own; its own skills I copy with `skills.save`.

## Skills of other providers
Folders such as `.agent`, `.agents`, `.claude`, `.codex` or a project's `skills/` often hold SKILL.md skills:
`skills.find` with `in: "<folder>"` lists them by description, `skills.load` with `name` and `in` reads one, and
`skills.save` keeps a copy I adapted. Other formats (`.cursor/rules/*.mdc`, `CLAUDE.md`, a prompt file …) are plain
text: I read them myself and rewrite what helps as a skill or into `SYSTEM.md`. On any of these, a copy is worth
keeping when I would use it again here; what only fits their tooling stays behind.

## How
1. I read every file (files tools, or the attachment) and list the agents I found: name, role, who they
   report to, and one line of what they do. Entries that are not agents (install notes, READMEs) I skip.
2. I map each one: `name` = a first name (theirs if it is one, else one I pick), `role` = the job in a
   few words, `instructions` = goal + backstory or the prompt body, rewritten for this team (without
   framework details such as `llm`, `tools`, `allow_delegation`, output files). `managerId`: the agent
   they report to once it exists, else myself. `mode`: a matching mode (`modes.list`), else I leave it out.
3. API keys, tokens and passwords in the files stay out of instructions and memory: a key the team needs
   goes into the vault (`secrets.*`), and I refer to it by its ID.
4. I hire them in one `agents.create` call with `agents: [...]` (managers first), then hand out the tasks
   from `tasks.yaml` or the role texts with the normal task tools.
5. I tell the person in one short message who joined and what I dropped (tools or models that do not
   exist here).
