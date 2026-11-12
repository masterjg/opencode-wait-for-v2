import { open, stat } from "node:fs/promises"
import { normalizeCondition, runWait, type WaitResult } from "./conditions.ts"

/**
 * opencode-wait-for-v2 - a "wait for new output" primitive for OpenCode V2.
 *
 * Problem
 * -------
 * OpenCode's built-in shell tool returns only when the command finishes: the
 * whole conversation blocks during a long task, the UI shows no progress, and
 * the model spends another reasoning turn after it ends (P50 ~14s locally).
 *
 * It also has no "wait for a new log line" capability, so the model has to
 * build polling loops by hand:
 *
 *     sleep 60; tail -c 800 build.log | tail -12; ps -Ao pid,command | grep ...
 *
 * A long task often needs a dozen polls, each waiting a guessed number of
 * seconds and then reasoning again.
 *
 * Approach
 * --------
 * Put the wait into one tool call:
 *   - the command polls internally; the conversation uses one call
 *   - return as soon as the condition holds, not at the timeout
 *   - timeouts do not throw; return process state and the log tail so the
 *     model can tell "slow" from "stuck"
 *   - support AbortSignal so ESC stops the wait immediately
 *
 * This mirrors Codex CLI's `write_stdin` / `clock.sleep` design:
 * one blocking call, interruptible, returning output produced so far.
 */

const DEFAULT_TIMEOUT_MS = 240_000
const MAX_TIMEOUT_MS = 600_000
const DEFAULT_POLL_MS = 500
const MIN_POLL_MS = 100

/** Watch only this many bytes of the file tail; avoids loading tens of MB of build logs. */
const TAIL_BYTES = 64 * 1024

/** Maximum log text returned to the model; keep the tail when longer. */
const MAX_OUTPUT_CHARS = 4_000

/** Throttle progress updates to avoid flooding the UI. */
const PROGRESS_INTERVAL_MS = 1_000

interface WaitForInput {
  path?: string
  pattern?: string
  pid?: number
  timeout_ms?: number
  poll_ms?: number
  tail_lines?: number
  must_be_new?: boolean
  condition?: unknown
}

/**
 * Read from `from` to EOF in one open/read pass, up to maxBytes.
 *
 * Do not use readFile: build logs are often tens of MB, and reading the whole
 * file is slow and memory-heavy. The window starts at max(from, size - maxBytes)
 * so it never starts before `from` and never exceeds the byte budget.
 */
async function readFrom(path: string, from: number, maxBytes: number): Promise<string> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`${path} is not a regular file`)
  if (info.size <= from) return ""

  const start = Math.max(from, info.size - maxBytes)
  const length = info.size - start
  const handle = await open(path, "r")
  try {
    const buffer = Buffer.alloc(length)
    let offset = 0
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return buffer.subarray(0, offset).toString("utf8")
  } finally {
    await handle.close()
  }
}

/** Keep only the last n lines so the model does not receive the whole log tail. */
function tailLines(text: string, lines: number): string {
  const all = text.split("\n")
  if (all.length <= lines) return text
  return all.slice(all.length - lines).join("\n")
}

/** Keep the tail when text is too long - the conclusion is usually at the end. */
function compact(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text
  return `...(omitted ${text.length - limit} chars)...\n${text.slice(text.length - limit)}`
}

/** Whether the process is alive. EPERM means it exists but belongs to another user, so it is alive too. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const DESCRIPTION = [
  "Block until a condition holds, up to timeout_ms. Use this instead of foreground `sleep N; tail ...` polling.",
  "",
  "Three ways to use it (they can be combined; all must hold):",
  "  1. Wait for a file to appear: pass only path",
  "  2. Wait for a log line: path + pattern (regular expression)",
  "  3. Wait for a process to exit: pid",
  "",
  "Returns as soon as the condition holds; does not wait for the timeout. A timeout also returns normally (output starts with `[wait_for] timed out`,",
  "with process state and the log tail attached). When that happens, check whether the process is still alive instead of calling wait_for again immediately.",
  "",
  "Typical cases:",
  "  - Start a long task with shell's background: true and redirect it to a log, then wait for an end marker:",
  "      path: '/tmp/build.log', pattern: 'BUILD (SUCCESS|FAILURE)'",
  "  - Wait for a port: path: '/tmp/dev.log', pattern: 'listening on'",
  "  - Wait for a background process to exit: pid: 12345",
  "",
  "The result is the log tail at match time (or timeout), so no separate tail is needed.",
].join("\n")

function conditionResult(result: WaitResult) {
  const seconds = (result.elapsedMs / 1000).toFixed(result.matched ? 3 : 1)
  const lines = result.matched
    ? [`[wait_for] condition met after ${seconds}s`, `condition: ${result.condition}`, `attempts: ${result.attempts}`]
    : result.aborted
      ? [`[wait_for] aborted after ${seconds}s`, `condition: ${result.condition}`, `attempts: ${result.attempts}`]
      : [
          `[wait_for] timed out after ${seconds}s`,
          `condition: ${result.condition}`,
          `attempts: ${result.attempts}`,
          `last error: ${result.lastError ?? "none"}`,
          "Next step: inspect the observed state; do not call wait_for again immediately.",
        ]
  if (result.excerpt) lines.push("", "--- log tail ---", compact(result.excerpt))
  lines.push(`observed: ${JSON.stringify(result.observed)}`)
  return {
    content: lines.join("\n"),
    metadata: {
      reason: result.matched ? "condition met" : result.aborted ? "aborted" : "timeout",
      hit: result.matched,
      waited_ms: result.elapsedMs,
      attempts: result.attempts,
      observed: result.observed,
      ...(result.excerpt ? { excerpt: result.excerpt } : {}),
    },
  }
}

export default {
  id: "wait-for",

  async setup(ctx: any) {
    const registration = await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "wait_for",
        description: DESCRIPTION,
        input: {
          type: "object",
          properties: {
            condition: {
              type: "object",
              description:
                "Advanced condition. When set, path/pattern/pid/must_be_new are ignored. Set type, then the fields that type needs.",
              properties: {
                type: {
                  type: "string",
                  enum: [
                    "file_exists",
                    "file_absent",
                    "file_changed",
                    "file_contains",
                    "process_exited",
                    "process_running",
                    "port_open",
                    "port_closed",
                    "http_status",
                    "http_json",
                    "http_body_contains",
                  ],
                },
                path: { type: "string" },
                pattern: { type: "string" },
                regex: { type: "boolean" },
                mustBeNew: { type: "boolean" },
                since: { type: "number" },
                stableForMs: { type: "number" },
                pid: { type: "number" },
                host: { type: "string" },
                port: { type: "number" },
                url: { type: "string" },
                status: {
                  anyOf: [{ type: "number" }, { type: "array", items: { type: "number" } }],
                },
                headers: {
                  type: "object",
                  additionalProperties: { type: "string" },
                },
                jsonPath: { type: "string" },
                equals: {},
              },
              required: ["type"],
              additionalProperties: false,
            },
            path: {
              type: "string",
              description: "File to watch (absolute path). Usually a log written by a background shell.",
            },
            pattern: {
              type: "string",
              description:
                "Regular expression. The condition holds when the file content matches. Only the last 64 KB is watched, so do not expect very old content. Requires path.",
            },
            pid: {
              type: "number",
              description: "Wait for this process to exit instead. Can be combined with path, in which case both the exit and the log match must hold.",
            },
            timeout_ms: {
              type: "number",
              description: `Maximum wait in milliseconds. Default ${DEFAULT_TIMEOUT_MS}, cap ${MAX_TIMEOUT_MS}.`,
            },
            poll_ms: {
              type: "number",
              description: `Poll interval in milliseconds. Default ${DEFAULT_POLL_MS}, minimum ${MIN_POLL_MS}. Usually not needed.`,
            },
            tail_lines: {
              type: "number",
              description: "Number of trailing log lines to return. Default 60.",
            },
            must_be_new: {
              type: "boolean",
              description:
                "When true, only content written after the call starts counts (the current file size is recorded first). Useful when the log already contains an old match.",
            },
          },
          required: [],
          additionalProperties: false,
        },
        options: { codemode: true },
        execute: async (raw: WaitForInput, context: any) => {
          const input = raw ?? {}

          if (input.condition) {
            const condition = normalizeCondition(input.condition)
            const result = await runWait(condition, {
              root: context?.directory ?? process.cwd(),
              timeoutMs: input.timeout_ms,
              intervalMs: input.poll_ms,
              signal: context?.signal,
              // Keep the upstream plugin's existing behavior: absolute paths are
              // accepted without the host permission API. The local fork adds
              // external_directory checks separately.
              assertExternal: async () => {},
              progress: context?.progress
                ? async (event: { status: string }) => {
                    try {
                      await context.progress({ status: "waiting", note: event.status })
                    } catch {}
                  }
                : undefined,
            })
            return conditionResult(result)
          }

          const path = input.path
          const pid = typeof input.pid === "number" ? input.pid : undefined

          if (input.pattern && !path) {
            throw new Error("pattern requires path")
          }
          if (!path && pid === undefined) {
            throw new Error("wait_for requires at least one of path or pid")
          }

          const timeoutMs = Math.min(
            Math.max(1, Math.floor(input.timeout_ms ?? DEFAULT_TIMEOUT_MS)),
            MAX_TIMEOUT_MS,
          )
          const pollMs = Math.max(MIN_POLL_MS, Math.floor(input.poll_ms ?? DEFAULT_POLL_MS))
          const wantedLines = Math.max(1, Math.floor(input.tail_lines ?? 60))

          let regex: RegExp | undefined
          if (input.pattern) {
            try {
              regex = new RegExp(input.pattern, "m")
            } catch (error) {
              throw new Error(`pattern is not a valid regular expression: ${(error as Error).message}`)
            }
          }

          // must_be_new: record the starting size and only consider new content
          let baseSize = 0
          if (path && input.must_be_new) {
            try {
              baseSize = (await stat(path)).size
            } catch {
              baseSize = 0
            }
          }

          const startedAt = Date.now()
          const deadline = startedAt + timeoutMs
          let lastSize = -1
          let lastChangeAt = startedAt
          let lastProgressAt = 0

          /** Report progress so the UI does not appear frozen during the wait - the worst part of sleep polling. */
          const reportProgress = async (note: string) => {
            const now = Date.now()
            if (now - lastProgressAt < PROGRESS_INTERVAL_MS) return
            lastProgressAt = now
            try {
              await context?.progress?.({
                status: "waiting",
                waited_ms: now - startedAt,
                idle_ms: now - lastChangeAt,
                note,
              })
            } catch {
              // A failed progress update must not affect the wait itself
            }
          }

          const buildResult = (reason: string, hit: boolean, body: string) => ({
            content: body,
            metadata: {
              reason,
              hit,
              waited_ms: Date.now() - startedAt,
              // Time since the last content change - distinguishes "slow" from "stuck".
              idle_ms: Date.now() - lastChangeAt,
              ...(path ? { path } : {}),
              ...(pid !== undefined ? { pid } : {}),
            },
          })

          while (true) {
            if (context?.signal?.aborted) {
              throw new Error("wait_for aborted")
            }

            const problems: string[] = []
            let matched = true
            let snapshot = ""
            let pidAlive = false

            // Evaluate each condition independently and record its own reason so one failure does not hide the others.
            if (pid !== undefined) {
              pidAlive = processAlive(pid)
              if (pidAlive) {
                matched = false
                problems.push(`pid ${pid} is still running`)
              }
            }

            // Read the log even when the pid is still alive; otherwise a timeout cannot include the log tail.
            if (path) {
              try {
                const info = await stat(path)
                if (info.size !== lastSize) {
                  lastSize = info.size
                  lastChangeAt = Date.now()
                }

                snapshot = tailLines(await readFrom(path, 0, TAIL_BYTES), wantedLines)

                if (input.must_be_new && info.size <= baseSize) {
                  matched = false
                  problems.push(`file has not grown (current ${info.size} bytes, starting ${baseSize} bytes)`)
                } else if (regex) {
                  // With must_be_new, match only the new range and read only that range.
                  const from = input.must_be_new && baseSize > 0 ? baseSize : 0
                  const scoped = await readFrom(path, from, TAIL_BYTES)
                  if (!regex.test(scoped)) {
                    matched = false
                    problems.push(`log did not match /${input.pattern}/`)
                  }
                }
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                  matched = false
                  problems.push(`file does not exist yet: ${path}`)
                } else {
                  throw error
                }
              }
            }

            if (matched) {
              const head = [
                `[wait_for] condition met after ${((Date.now() - startedAt) / 1000).toFixed(3)}s`,
                pid !== undefined ? `pid: ${pid} exited` : "",
                path ? `path: ${path}` : "",
              ]
                .filter(Boolean)
                .join(" | ")
              const body = snapshot ? `${head}\n\n--- log tail ---\n${compact(snapshot)}` : head
              return buildResult("condition met", true, body)
            }

            if (Date.now() >= deadline) {
              const head = [
                `[wait_for] timed out after ${(timeoutMs / 1000).toFixed(1)}s`,
                `Reason: ${problems.join("; ")}`,
                `Last change: ${((Date.now() - lastChangeAt) / 1000).toFixed(1)}s ago`,
                pidAlive ? `pid ${pid} is still running - the task may simply be slow, not stuck` : "",
                "Next step: use ps / lsof to check the process; do not call wait_for again immediately.",
              ]
                .filter(Boolean)
                .join("\n")
              const body = snapshot ? `${head}\n\n--- log tail ---\n${compact(snapshot)}` : head
              return buildResult("timeout", false, body)
            }

            await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())))
            await reportProgress(problems.join("; ") || "waiting")
          }
        },
      })
    })

    return () => void registration?.dispose?.()
  },
}
