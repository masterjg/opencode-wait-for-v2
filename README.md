# opencode-wait-for-v2

An OpenCode **V2** plugin that gives the agent a `wait_for` tool for **blocking until a log line appears or a process exits**, replacing foreground `sleep N; tail ...` polling.

```ts
wait_for({ path: "/tmp/build.log", pattern: "BUILD (SUCCESS|FAILURE)", timeout_ms: 600_000 })
```

## What problem does it solve?

OpenCode's built-in shell tool returns only when a command finishes. That costs long-running tasks twice:

1. **The whole conversation blocks while the command runs**, with no progress in the UI, so it looks stuck.
2. **There is no "wait for new output" primitive**, so the model has to build polling loops itself:

```bash
sleep 60; tail -c 800 build.log | tr '\r' '\n' | tail -12
ps -Ao pid,user,etime,command | grep -E '[m]vnd' | head -3
```

A 10-minute build often needs a dozen of these polls. Each one waits a guessed number of seconds and then spends another reasoning turn after it wakes up. In local measurements, the pause between a tool ending and the next assistant message had a P50 of **13.7 seconds**, so ten polls waste roughly 2-3 minutes, not counting the sleep itself.

`wait_for` compresses those polls into **one call**.

## Comparison

| | `sleep` polling | `wait_for` |
| --- | --- | --- |
| Conversation cost | N tool calls | **1 call** |
| When it returns | Fixed delay; too early or too late | **Immediately** when the condition holds |
| Timeout behavior | No bound; can poll forever | Returns explicitly with process state |
| UI feedback | Blank wait | Reports `waiting` progress every second |
| Interruption | Waits for sleep to finish | Stops immediately on ESC |
| Large logs | Repeatedly `tail` the whole file | Reads only the last 64 KB |

Measured: on an 11 MB build log, match detection took **3 ms**.

## Install

```bash
opencode plugin add opencode-wait-for-v2
```

Or add it to the global plugin directory manually (hot reload applies changes without a restart):

```bash
git clone https://github.com/lcssos/opencode-wait-for-v2 \
  ~/.config/opencode/plugins/opencode-wait-for-v2
```

Confirm it is loaded:

```bash
opencode plugin list
```

## Usage

### 1. Wait for a build or test run to finish

```bash
# Step 1: run the long task in the background with output redirected
mvnd -o clean install > /tmp/build.log 2>&1    # background: true
```

```ts
// Step 2: wait for the end marker in one call
wait_for({ path: "/tmp/build.log", pattern: "BUILD (SUCCESS|FAILURE)", timeout_ms: 600_000 })
```

The result includes the log tail, so **you do not need a separate `tail`**:

```text
[wait_for] condition met after 42.318s | path: /tmp/build.log

--- log tail ---
[INFO] BUILD SUCCESS
[INFO] Total time:  41.902 s
```

### 2. Wait for a port to come up

```ts
wait_for({ path: "/tmp/dev.log", pattern: "listening on|Started .* in .* seconds", timeout_ms: 120_000 })
```

### 3. Wait for a background process to exit

```ts
wait_for({ pid: 12345, timeout_ms: 300_000 })
// You can also provide path; both conditions must hold, and the log is returned
wait_for({ pid: 12345, path: "/tmp/build.log", pattern: "BUILD SUCCESS" })
```

### 4. The log already contains an old match

Use `must_be_new: true` to consider only content written **after the call starts**:

```ts
wait_for({ path: "/tmp/app.log", pattern: "ERROR", must_be_new: true })
```

## Parameters

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | string | — | File to watch (absolute path). |
| `pattern` | string | — | Regular expression; requires `path`. Matches only the last 64 KB. |
| `pid` | number | — | Wait for this process to exit. Can be combined with `path`. |
| `timeout_ms` | number | `240000` | Maximum wait; capped at `600000`. |
| `poll_ms` | number | `500` | Poll interval; minimum `100`. With a native watcher this remains the low-frequency fallback cadence; remote filesystems poll at the full interval. |
| `tail_lines` | number | `60` | Number of log lines returned. |
| `must_be_new` | boolean | `false` | Only consider content written after the call starts. |

At least one of `path` or `pid` is required.

## A timeout is not a failure

A timeout **returns normally** instead of throwing, because "did not arrive" is information:

```text
[wait_for] timed out after 120.0s
Reason: pid 12345 is still running; log did not match /BUILD SUCCESS/
Last change: 118.3s ago
pid 12345 is still running - the task may simply be slow, not stuck
Next step: use ps / lsof to check the process; do not call wait_for again immediately.
```

The result deliberately separates two signals:

- `idle_ms` (time since the last change) - distinguishes "slow task" from "stuck task".
- `pidAlive` - if the process is alive, waiting longer may be worthwhile; if it is gone, the task really failed.

## Design trade-offs

**Why native notifications with a polling fallback instead of polling only?** On local filesystems, `fs.watch` cuts the default 1-second discovery delay to tens of milliseconds. But `fs.watch` misses events or is unsupported on NFS, SMB, sshfs/FUSE, 9p, and some container mounts. Notifications are therefore only **wake-up hints** and never carry correctness:

- A file or parent-directory change triggers a real condition check; the event itself is not a result.
- Every wait keeps a low-frequency reconciliation poll (~2s); `poll_ms` is still the interval for polling-only mode.
- `statfs` identifies network/FUSE filesystems and skips the watcher entirely.
- Watcher errors, closes, inotify limits, and atomic `rename` replacement fall back to polling or re-arm the monitor.
- `stableForMs` computes the remaining stability time, so reconciliation cannot delay a stable result.
- `mustBeNew` / `must_be_new` chunked reads continue immediately when unread new content remains, instead of waiting for the next poll.

Measured with the default 1-second poll, a local file appearing after 50 ms: polling only **1003 ms**, watch wake-up **50 ms**. Remote files still use polling only, and correctness never depends on notifications.

**Why read only the last 64 KB?** Maven/Gradle logs are often tens of megabytes. The plugin uses `open` plus an offset read instead of `readFile`, so it never pulls the whole file into memory. The same `must_be_new` check reads only the new range.

**Why not throw on timeout?** Throwing makes the model likely to retry, while the correct action is to inspect the process state. Putting diagnostics in the result lets the model make the right call.

**Why report progress only once per second?** Calling `context.progress` too often floods the UI, but reporting nothing gives a blank-screen experience. One second is an upper bound that does not interfere with reading.

## How it differs from other OpenCode plugins

`wait_for` does one thing: **wait**. It does not start processes and does not take over built-in tools. Start work with the shell's `background: true`; wait for it with `wait_for`.

The most easily confused projects (data from 2026-11):

| Project | ★ | Purpose | Relationship |
| --- | --- | --- | --- |
| **shekohex/opencode-pty** | 607 | Interactive PTY management (spawn/write/read/kill) | Overlapping features, different goal; see below |
| A8Cl233395/opencode-background-jobs | 1 | Replaces built-in `shell`; timeouts become background jobs | Closest idea, but takes over the `shell` tool |
| zeigarnick/opencode-background-task | 3 | Runs **agent tasks** in the background | Unrelated; manages subagents, not processes |
| PrismKitty/opencode-background-tasks | 1 | Sidebar display for running shells/subagents | Unrelated; UI only |

### vs opencode-pty

It is the most mature project in this space, but it solves a **different layer**:

| Dimension | opencode-wait-for-v2 | opencode-pty |
| --- | --- | --- |
| Core model | Block until a condition holds | Run in background and read on demand |
| Tools | 1 (`wait_for`) | 5 (`pty_spawn` / `pty_write` / `pty_read` / `pty_list` / `pty_kill`) |
| Start a process | No; use built-in `shell` | Yes, native `pty_spawn` |
| Send input | No | Yes, including Ctrl+C and arrow keys |
| Wait for completion | `wait_for(path, pattern)` in one call | `pty_spawn(notifyOnExit: true)` and wait for notification |
| Timeout | Normal return + process state + log tail | `timeoutSeconds` **kills the process** |
| Interrupt (ESC) | Yes, `AbortSignal` | Depends on the SDK |
| Progress | Yes, `context.progress` | No |
| Large logs | Reads last 64 KB; 3 ms on 11 MB | Full ring buffer (50k-line cap) |
| Resident memory | Nearly zero (no buffer) | 50k-line buffer per session |
| Dependencies | Zero (Node built-in `fs`) | `bun-pty` native module |
| Extra components | None | Web UI + TUI sidebar + REST API + WebSocket |
| Permission limits | None | An `ask` rule is treated as `deny` |
| Size | 12.5 KB, one file | Full frontend/backend project |

**Which one to use:**

| Need | Recommendation |
| --- | --- |
| Wait for `mvnd install` to finish | **wait_for** |
| Wait for a service port to be ready | **wait_for** |
| Start `npm run dev` and keep the dev server alive | opencode-pty |
| Interactive REPL / database CLI | opencode-pty |
| Let the agent send Ctrl+C to a process | opencode-pty |

They **can be installed together** without conflict: let pty own the dev server and wait_for own builds.

### vs opencode-background-jobs

Conceptually it is the closest project - both agree that a conversation should not block on a long command. The differences:

- It **replaces the built-in `shell` tool** (`timeout: 0` moves work to the background; a timeout becomes a job instead of killing the process), which is more invasive.
- It needs `job_list` / `job_read` / `job_kill` together, so the call chain is longer.
- `wait_for` does not modify any built-in tool; it only **adds** one tool that can be removed at any time.

If you already use its `job_read({ timeout })` blocking wait, that overlaps with `wait_for`; pick one.

## Compatibility

Developed and verified on OpenCode **v2.2.5**. It relies on `@opencode/plugin`'s `ctx.tool.transform` and the `ctx.tool` `execute(input, context)` contract, where `context.signal` is used for interruption and `context.progress` for progress reporting.

The tool declares `options: { codemode: true }`, so it is also available in Code Mode as `tools.wait_for(...)`.

## Development

```bash
bun test          # 19 cases
bun build index.ts --target=node --outfile=/tmp/check.js   # build check
```

## License

MIT
