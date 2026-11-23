---
name: Wait
description: Use when a task needs to wait for an external condition instead of fixed sleep loops - a file appears, changes, or contains a marker; a log line appears; a process exits; a TCP port opens or closes; or an HTTP status, JSON field, or body matches. Covers wait_for conditions, log/process waiting, timeouts, result handling, permissions, and polling limits.
---

# Wait

`wait_for` blocks until a real condition holds or the timeout expires. It checks
immediately, so an already-true condition returns after one attempt. It also
watches log files and process exits directly, without a separate `tail` loop.

## When to use

- after starting a background process, server, build, or test run
- after a push or deploy, waiting for CI or an npm version
- before reading a file another process is still writing
- when a fixed `sleep N` would be a guess
- when a service has a readiness endpoint or an open port

| Situation | Use |
|---|---|
| An external condition may become true | `wait_for` |
| There is no condition, only a fixed pause | Avoid; if unavoidable, a bounded `sleep` inside the work command, and state why |
| The state can be read now | `read`, `stat`, or one HTTP check |

Do not use `wait_for` for arbitrary shell predicates; it never runs a shell.

## Gotchas

- Never wrap `wait_for` in a shell `for`/`while` loop; that defeats it. One call
  with `timeout_ms` is the loop.
- If `wait_for` cannot reach a URL but the host can, report that and retry once
  with a longer timeout; do not substitute a `curl`/`sleep` script.
- Do not create a temporary polling script with `fs.tee` or a text tool.

## Call it

In Code Mode, use `tools.wait.for`. If a host exposes the direct tool, it is
`wait_for`; in this config, use `tools.wait.for` inside `execute`. At least one
of `condition`, `path`, or `pid` is required.

Four modes:

| Mode | Fields | Returns |
|---|---|---|
| File appears | `path` | text with the matched file state |
| Log line | `path` + `pattern` | text with the log tail |
| Process exits | `pid` (optionally `path` + `pattern`) | text with the process/log state |
| Advanced condition | `condition` | JSON result |

```js
// Advanced condition: JSON result
const raw = await tools.wait.for({
  condition: { type: "file_exists", path: "dist/app.js" },
  timeout_ms: 30000,
  poll_ms: 500,
})
const result = JSON.parse(raw)

// Log line: text result with the tail
const text = await tools.wait.for({
  path: "/tmp/build.log",
  pattern: "BUILD (SUCCESS|FAILURE)",
  timeout_ms: 600000,
  tail_lines: 20,
})
```

- `timeout_ms` (alias `timeoutMs`): default `240000`, minimum `100`, maximum `600000`.
- `poll_ms` (alias `intervalMs`): default `500`, minimum `100`, maximum `30000`.
- `tail_lines`: default `60`.
- `must_be_new`: only content written after the call starts counts.
- Advanced `condition` takes precedence over `path`/`pattern`/`pid`/`must_be_new`.

The advanced condition result is a JSON string with `matched`, `timedOut`,
`aborted`, `condition`, `elapsedMs`, `attempts`, `observed`, optional `excerpt`,
and optional `lastError`. The log/process modes return text plus `metadata` with
`reason`, `hit`, `waited_ms`, `idle_ms`, `path`, and `pid`.

## Conditions

| `type` | Required fields | Optional fields | Waits for |
|---|---|---|---|
| `file_exists` | `path` | `stableForMs` | path exists |
| `file_absent` | `path` | | path does not exist |
| `file_changed` | `path` | `since`, `stableForMs` | size or mtime change |
| `file_contains` | `path`, `pattern` | `regex`, `mustBeNew` | matching text in the file |
| `process_exited` | `pid` | | process is gone |
| `process_running` | `pid` | | process is alive |
| `port_open` | `host`, `port` | | TCP connection succeeds |
| `port_closed` | `host`, `port` | | TCP connection fails |
| `http_status` | `url` | `status`, `headers` | response status matches |
| `http_json` | `url`, `jsonPath`, `equals` | `headers` | JSON value at path equals |
| `http_body_contains` | `url`, `pattern` | `regex`, `headers` | response body matches |

`status` is a number or an array of numbers; omit it to accept any 2xx.
`jsonPath` accepts dot and bracket paths such as `status`, `jobs[0].status`, or
`data.items[0].state`.

## Recipes

Wait for a file to appear and settle:

```js
await tools.wait.for({
  condition: { type: "file_exists", path: "/tmp/opencode/wait-skill-appeared.log", stableForMs: 100 },
  timeout_ms: 5000,
  poll_ms: 100,
})
```

Wait for a new log line, ignoring old matches:

```js
await tools.wait.for({
  path: "/tmp/opencode/wait-skill.log",
  pattern: "READY",
  must_be_new: true,
  timeout_ms: 10000,
  poll_ms: 100,
})
```

Wait for a process to exit:

```js
await tools.wait.for({ pid: 12345, timeout_ms: 300000 })
// combine with a log match:
await tools.wait.for({ pid: 12345, path: "/tmp/build.log", pattern: "BUILD SUCCESS" })
```

Same via the advanced condition API (`mustBeNew`):

```js
await tools.wait.for({
  condition: {
    type: "file_contains",
    path: "/tmp/opencode/wait-skill.log",
    pattern: "READY",
    mustBeNew: true,
  },
  timeout_ms: 10000,
  poll_ms: 100,
})
```

Wait for a CI run:

```js
await tools.wait.for({
  condition: {
    type: "http_json",
    url: "https://api.github.com/repos/masterjg/opencode-fs-plugin/actions/runs/43231442916",
    jsonPath: "status",
    equals: "completed",
  },
  timeout_ms: 600000,
  poll_ms: 5000,
})
```

Wait for npm:

```js
await tools.wait.for({
  condition: {
    type: "http_status",
    url: "https://registry.npmjs.org/opencode-fs-plugin/1.0.2",
    status: 200,
  },
  timeout_ms: 120000,
  poll_ms: 2000,
})
```

Wait for a service port:

```js
await tools.wait.for({
  condition: { type: "port_open", host: "127.0.0.1", port: 49374 },
  timeout_ms: 5000,
})
```

Wait for a process to exit:

```js
await tools.wait.for({
  condition: { type: "process_exited", pid: 999999 },
  timeout_ms: 1000,
})
```

Handle a timeout:

```js
const result = JSON.parse(
  await tools.wait.for({
    condition: { type: "file_exists", path: "/tmp/opencode/wait-skill-never" },
    timeout_ms: 250,
    poll_ms: 100,
  }),
)
if (!result.matched) {
  // inspect result.observed and result.lastError before deciding to retry
}
```

## Handling results

- `matched: true` — the condition held.
- `timedOut: true` — the condition never held within the timeout. This is a
  normal result, not an exception.
- `aborted: true` — the session or user interrupted the wait.
- Check `observed` for the last state and `lastError` for transient HTTP or
  matching errors. Do not immediately repeat the same wait after a timeout;
  inspect the process, port, or endpoint first.
- Log/process modes return text plus `metadata` (`hit`, `reason`, `waited_ms`,
  `idle_ms`, `path`, `pid`). A timeout starts with `[wait_for] timed out` and
  includes the last log tail.

## Permissions and paths

- Relative paths resolve from the project directory; absolute paths are allowed.
- A path outside the project first requires the `external_directory`
  permission, like the filesystem tools.
- The tool itself uses the `wait_for` permission action.
- Process, port, and HTTP conditions are not filesystem-gated.
- The tool never runs a shell command.

## Gotchas

- It polls; it does not use `fs.watch`. Detection can take up to `poll_ms`.
- HTTP is polled too. Unauthenticated GitHub API requests are limited to 60 per
  hour; use `poll_ms: 5000` or supply `headers` when needed.
- `file_contains` reads the last 64 KB, or up to 256 KB of new content when
  `mustBeNew` is true. It is not a full-file search; if more than 256 KB arrives
  between polls, an earlier match in that new range can be missed.
- `mustBeNew: true` records the file size when the call starts; old matches do
  not count, but content written between starting the wait and the first read
  may be considered new.
- `file_changed` compares size and mtime. A rewrite with the same size and mtime
  may not trigger it.
- `stableForMs` is for files another process is still writing; without it a
  condition may match a partial file.
- `port_open` only proves a TCP listener exists. For application readiness, use
  `http_status` or `http_json`.
- `process_*` uses PID liveness; PIDs can be reused.
- `http_json` compares the exact value deeply. For objects and arrays, provide
  the complete expected value, not a subset.
- Timeouts and intervals are clamped to their documented ranges.

## Verification

An already-true condition returns quickly:

```js
const result = JSON.parse(
  await tools.wait.for({
    condition: { type: "file_exists", path: "/var/home/marius/.config/opencode/opencode.jsonc" },
    timeout_ms: 1000,
  }),
)
result.matched === true && result.attempts === 1
```

A condition that never happens returns a timeout result:

```js
const result = JSON.parse(
  await tools.wait.for({
    condition: { type: "file_exists", path: "/tmp/opencode/wait-skill-never" },
    timeout_ms: 250,
    poll_ms: 100,
  }),
)
result.matched === false && result.timedOut === true
```

Load this skill with `@wait` or the `skill` tool using id `wait`.
