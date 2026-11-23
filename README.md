# wait

Condition, log-line, and process waiting for OpenCode. In Code Mode the tool is
`tools.wait.for`; it replaces guessed `sleep N` delays and manual `tail` polling.

This is a fork of
[`lcssos/opencode-wait-for-v2`](https://github.com/lcssos/opencode-wait-for-v2)
(MIT), merged with the local namespace, permission checks, and OpenCode V2
integration.

## Install

Plugin:

```bash
git clone git@github.com:masterjg/opencode-wait-for-v2.git \
  ~/.config/opencode/repos/opencode-wait-for-v2
```

Add it to the OpenCode plugin list, for example in `opencode.jsonc`:

```jsonc
{ "plugin": ["./repos/opencode-wait-for-v2"] }
```

Skill (recommended, so the agent sees the condition reference):

```bash
ln -s ~/.config/opencode/repos/opencode-wait-for-v2/skills/wait \
  ~/.config/opencode/skills/wait
```

Or add the path directly:

```jsonc
{ "skills": ["~/.config/opencode/repos/opencode-wait-for-v2/skills/wait"] }
```

Confirm with `opencode plugin list`. In Code Mode the tool is `tools.wait.for`.

## Modes

| Mode | Fields | Result |
|---|---|---|
| File appears | `path` | text with the file state |
| Log line | `path` + `pattern` | text with the log tail |
| Process exits | `pid`, optionally `path` + `pattern` | text with process/log state |
| Advanced condition | `condition` | JSON result |

`condition` takes precedence over `path`, `pattern`, `pid`, and `must_be_new`.

## Examples

```js
// Log line
await tools.wait.for({
  path: "/tmp/opencode/build.log",
  pattern: "BUILD (SUCCESS|FAILURE)",
  timeout_ms: 600000,
  tail_lines: 20,
})

// New content only
await tools.wait.for({
  path: "/tmp/opencode/deploy.log",
  pattern: "pod/ready",
  must_be_new: true,
})

// Process exit
await tools.wait.for({ pid: 12345, timeout_ms: 300000 })

// Advanced condition
const result = JSON.parse(
  await tools.wait.for({
    condition: { type: "port_open", host: "127.0.0.1", port: 3000 },
    timeout_ms: 30000,
  }),
)
```

## Conditions

| `type` | Required fields | Optional fields |
|---|---|---|
| `file_exists` | `path` | `stableForMs` |
| `file_absent` | `path` | |
| `file_changed` | `path` | `since`, `stableForMs` |
| `file_contains` | `path`, `pattern` | `regex`, `mustBeNew` |
| `process_exited` | `pid` | |
| `process_running` | `pid` | |
| `port_open` | `host`, `port` | |
| `port_closed` | `host`, `port` | |
| `http_status` | `url` | `status`, `headers` |
| `http_json` | `url`, `jsonPath`, `equals` | `headers` |
| `http_body_contains` | `url`, `pattern` | `regex`, `headers` |

`status` accepts a number or an array; omit it for any 2xx. `jsonPath` supports
dot and bracket paths such as `status` or `jobs[0].state`.

## Defaults and limits

- `timeout_ms` (alias `timeoutMs`): default `240000`, maximum `600000`.
- `poll_ms` (alias `intervalMs`): default `500`, minimum `100`.
- `tail_lines`: default `60`.
- Log reads are capped at the last 64 KB, or 256 KB of new content with
  `must_be_new`; HTTP bodies are capped at 256 KB.
- A timeout is a normal result, not an exception.

## Permissions

- Relative paths resolve from the project directory.
- A path outside the project requires the `external_directory` permission, like
  the filesystem tools. If the host does not expose the permission API, the read
  is refused.
- The tool uses the `wait_for` permission action.
- Process, port, and HTTP conditions are not filesystem-gated.
- The tool never runs shell commands.

## Test

```bash
bun test wait.test.ts        # or: node --test wait.test.ts
bun run check
```

## License

MIT. See [LICENSE](LICENSE). Original work copyright (c) 2026 lcssos.
