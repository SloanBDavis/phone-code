# Harnesses

A harness is an agent the daemon can run a chat with: Claude Code, Codex, an
ACP agent such as Gemini CLI, or Cursor's app. Each one is an `AgentAdapter`
(`types.ts`). The daemon core (sessions, history, push, the phone's pickers)
reads everything it needs about a harness from that adapter, so it never
checks for a particular agent id.

```
agents/
  types.ts        the contract: AgentAdapter, AgentSession, AgentEvents
  index.ts        the registry: NATIVE_HARNESSES, then the ACP agents
  shared/         helpers any harness can use (process spawning, diffs, guards)
  claude/         Claude Code (stream-json over stdio)
  codex/          Codex (app-server JSON-RPC)
  acp/            the generic Agent Client Protocol adapter and its presets
  cursor-app/     Cursor's desktop app, followed through its hooks
```

## Adding an agent that speaks ACP

If the agent has an ACP mode, you don't need any new code.

- **For everyone:** add a line to `ACP_PRESETS` in `acp/config.ts` with its
  id, display name, command and arguments (take them from the agent's entry
  in the [ACP registry](https://github.com/agentclientprotocol/registry)).
- **On one computer:** add an entry to `~/.phonecode/agents.json` (format in
  the header of `acp/config.ts`). An entry with a preset's id overrides that
  preset, and `"disabled": true` hides it.

## Adding a native harness

Write a native harness when the agent has its own protocol and no ACP mode,
or when its own protocol gives a much better chat.

1. **Make a folder** `agents/<id>/`. Put the adapter in `index.ts`, exported
   as `create<Name>Adapter(): AgentAdapter`. Split the rest as `claude/` and
   `codex/` do: `map.ts` (native events to ChatItems), `history.ts` (resume
   and replay) and `search.ts` (the "All chats" index).
2. **Fill in the adapter.** `kind`, `name`, `detect`, `start` and
   `listResumable` are required. The optional fields are each picked up by
   the core:

   | Field           | Used for                                                      |
   | --------------- | ------------------------------------------------------------- |
   | `shortName`     | "Message Claude", "Claude wants to…" (absent: `name`)         |
   | `monogram`      | the two letters on its glyph (absent: the id's first two)     |
   | `history`       | "All chats" text search over its own conversation files       |
   | `artifactRoots` | folders it saves generated images to, shown in the chat       |
   | `external`      | its chats start outside phone-code; not offered for new chats |

   `detect()` must be cheap and must not throw. When the agent is missing or
   logged out, return `available: false` or a `setupHint`.

3. **Register it** by adding its factory to `NATIVE_HARNESSES` in `index.ts`.
   The order of that list is the order the phone shows harnesses in. Its id is
   then reserved: an `agents.json` entry with the same id is ignored.
4. **Test it with a fake.** Read the binary from `PHONECODE_<ID>_BIN` (see
   `binEnvName` in `acp/config.ts`), add a scripted fake under `e2e/fakes/`
   that speaks the agent's protocol, and point the e2e daemon at it in
   `e2e/lib/daemon.ts`.

The phone needs no change. It gets the name, short name, monogram, models,
permission modes and slash commands from `HostInfo.agentCatalog`.
