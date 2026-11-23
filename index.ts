import { open, stat } from "node:fs/promises"
import * as path from "node:path"
import { Plugin } from "@opencode/plugin"
import { normalizeCondition, runWait } from "./wait.ts"

const DEFAULT_TIMEOUT_MS = 240_000
const MAX_TIMEOUT_MS = 600_000
const DEFAULT_POLL_MS = 500
const MIN_POLL_MS = 100
const TAIL_BYTES = 64 * 1024
const MAX_OUTPUT_CHARS = 4_000
const PROGRESS_INTERVAL_MS = 1_000

const CONDITION_TYPES = [
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
] as const

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    condition: {
      type: "object",
      description:
        "Advanced condition. When set, path/pattern/pid/must_be_new are ignored. Set type, then the fields that type needs. File paths are relative to the project unless absolute; absolute paths outside the project require external_directory permission.",
      properties: {
        type: { type: "string", enum: [...CONDITION_TYPES] },
        path: { type: "string", description: "File path for file_exists, file_absent, file_changed, or file_contains." },
        pattern: {
          type: "string",
          description: "Literal text or regular expression for file_contains or http_body_contains.",
        },
        regex: { type: "boolean", description: "Treat pattern as a regular expression. Default false." },
        mustBeNew: {
          type: "boolean",
          description: "For file_contains: only match content appended after this call starts. Default false.",
        },
        since: {
          type: "number",
          description: "For file_changed: epoch milliseconds; match when mtime is newer. Defaults to the file state at call start.",
        },
        stableForMs: {
          type: "number",
          description: "For file_exists or file_changed: require the size and mtime to stay unchanged for this many milliseconds.",
        },
        pid: { type: "integer", description: "Process ID for process_exited or process_running." },
        host: { type: "string", description: "Host for port_open or port_closed." },
        port: { type: "integer", description: "TCP port for port_open or port_closed." },
        url: { type: "string", description: "http:// or https:// URL for HTTP conditions." },
        status: {
          anyOf: [{ type: "number" }, { type: "array", items: { type: "number" } }],
          description: "For http_status: expected status code or codes. Default any 2xx.",
        },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Optional request headers for HTTP conditions.",
        },
        jsonPath: {
          type: "string",
          description: "For http_json: dot/bracket path into the response, for example 'status' or 'jobs[0].status'.",
        },
        equals: {
          description: "For http_json: expected value at jsonPath. Strings compare to numbers/booleans by string form.",
        },
      },
      required: ["type"],
      additionalProperties: false,
    },
    path: {
      type: "string",
      description: "File to watch. Relative paths resolve against the project; absolute paths outside it require external_directory permission.",
    },
    pattern: {
      type: "string",
      description: "Regular expression for a log line. Requires path. Only the last 64 KB is watched.",
    },
    pid: { type: "integer", description: "Wait for this process to exit. Can be combined with path." },
    timeout_ms: {
      type: "integer",
      minimum: 100,
      maximum: MAX_TIMEOUT_MS,
      description: `Maximum wait in milliseconds. Default ${DEFAULT_TIMEOUT_MS}.`,
    },
    poll_ms: {
      type: "integer",
      minimum: MIN_POLL_MS,
      maximum: 30_000,
      description: `Poll interval in milliseconds. Default ${DEFAULT_POLL_MS}.`,
    },
    tail_lines: { type: "integer", minimum: 1, description: "Trailing log lines returned. Default 60." },
    must_be_new: {
      type: "boolean",
      description: "Only content written after the call starts counts. Useful when the log already contains an old match.",
    },
    timeoutMs: {
      type: "integer",
      minimum: 100,
      maximum: MAX_TIMEOUT_MS,
      description: "Alias for timeout_ms.",
    },
    intervalMs: {
      type: "integer",
      minimum: MIN_POLL_MS,
      maximum: 30_000,
      description: "Alias for poll_ms.",
    },
  },
  required: [],
  additionalProperties: false,
} as const

const DESCRIPTION = [
  "Wait for a real condition instead of fixed sleep loops. Checks immediately, then polls until the condition matches or the timeout expires.",
  "",
  "Four ways to use it:",
  "  1. Wait for a file to appear: pass only path",
  "  2. Wait for a log line: path + pattern (regular expression)",
  "  3. Wait for a process to exit: pid",
  "  4. Wait for an advanced condition: condition (file, process, port, or HTTP). condition takes precedence over 1-3.",
  "",
  "Conditions: file_exists, file_absent, file_changed, file_contains (log lines, optional mustBeNew), process_exited, process_running, port_open, port_closed, http_status, http_json (dot-path equals), http_body_contains.",
  "Returns immediately when the condition holds; a timeout is a normal result, not a thrown error. File paths respect external_directory permissions.",
].join("\n")

function slash(value: string): string {
  return value.split(path.sep).join("/")
}

function outsideRoot(root: string, fullPath: string): boolean {
  const relative = path.relative(root, fullPath)
  return relative !== "" && (relative.startsWith("..") || path.isAbsolute(relative))
}

async function readFrom(fullPath: string, from: number, maxBytes: number): Promise<string> {
  const info = await stat(fullPath)
  if (!info.isFile()) throw new Error(`${fullPath} is not a regular file`)
  if (info.size <= from) return ""

  const start = Math.max(from, info.size - maxBytes)
  const length = info.size - start
  const handle = await open(fullPath, "r")
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

function tailLines(text: string, lines: number): string {
  const all = text.split("\n")
  if (all.length <= lines) return text
  return all.slice(all.length - lines).join("\n")
}

function compact(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text
  return `...(omitted ${text.length - limit} chars)...\n${text.slice(text.length - limit)}`
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export default Plugin.define({
  id: "wait",
  async setup(ctx) {
    const root = path.resolve(
      (typeof ctx.options?.root === "string" && ctx.options.root) ||
        ctx.location?.project?.canonical ||
        ctx.location?.directory ||
        process.cwd(),
    )

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "wait",
        description: "Wait for filesystem, process, port, or HTTP conditions without shell sleep loops.",
      })

      editor.add({
        name: "for",
        description: DESCRIPTION,
        input: INPUT_SCHEMA,
        options: { namespace: "wait", codemode: true, permission: "wait_for" },
        execute: async (input: any, context: any) => {
          const data = input ?? {}
          const timeoutMs = data.timeout_ms ?? data.timeoutMs
          const pollMs = data.poll_ms ?? data.intervalMs

          const assertExternal = async (fullPath: string) => {
            if (!outsideRoot(root, fullPath)) return
            const assert = (ctx as any).permission?.assert
            if (typeof assert !== "function") {
              throw new Error("wait_for: permission API is unavailable; refusing to read outside the project")
            }
            await assert({
              sessionID: context?.sessionID,
              agent: context?.agent,
              source: {
                type: "tool",
                messageID: context?.messageID,
                id: context?.id,
              },
              action: "external_directory",
              resources: [`${slash(path.dirname(fullPath))}/*`],
              save: [`${slash(root)}/*`],
            })
          }

          if (data.condition) {
            const condition = normalizeCondition(data.condition)
            const result = await runWait(condition, {
              root,
              timeoutMs,
              intervalMs: pollMs,
              signal: context?.signal,
              assertExternal,
              progress: context?.progress
                ? (event: { status: string }) => context.progress(event)
                : undefined,
            })
            return { content: JSON.stringify(result, null, 2) }
          }

          const rawPath = typeof data.path === "string" && data.path.trim() ? data.path.trim() : undefined
          const pid = typeof data.pid === "number" ? data.pid : undefined

          if (data.pattern && !rawPath) throw new Error("wait_for: pattern requires path")
          if (!rawPath && pid === undefined) {
            throw new Error("wait_for requires at least one of condition, path, or pid")
          }

          const fullPath = rawPath
            ? path.isAbsolute(rawPath)
              ? path.normalize(rawPath)
              : path.resolve(root, rawPath)
            : undefined
          if (fullPath) await assertExternal(fullPath)

          const waitTimeout = Math.min(
            Math.max(1, Math.floor(timeoutMs ?? DEFAULT_TIMEOUT_MS)),
            MAX_TIMEOUT_MS,
          )
          const pollInterval = Math.max(MIN_POLL_MS, Math.floor(pollMs ?? DEFAULT_POLL_MS))
          const wantedLines = Math.max(1, Math.floor(data.tail_lines ?? 60))

          let regex: RegExp | undefined
          if (data.pattern) {
            try {
              regex = new RegExp(data.pattern, "m")
            } catch (error) {
              throw new Error(`wait_for: pattern is not a valid regular expression: ${(error as Error).message}`)
            }
          }

          let baseSize = 0
          if (fullPath && data.must_be_new) {
            try {
              baseSize = (await stat(fullPath)).size
            } catch {
              baseSize = 0
            }
          }

          const startedAt = Date.now()
          const deadline = startedAt + waitTimeout
          let lastSize = -1
          let lastChangeAt = startedAt
          let lastProgressAt = 0

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
            } catch {}
          }

          const buildResult = (reason: string, hit: boolean, body: string) => ({
            content: body,
            metadata: {
              reason,
              hit,
              waited_ms: Date.now() - startedAt,
              idle_ms: Date.now() - lastChangeAt,
              ...(fullPath ? { path: fullPath } : {}),
              ...(pid !== undefined ? { pid } : {}),
            },
          })

          while (true) {
            if (context?.signal?.aborted) throw new Error("wait_for aborted")

            const problems: string[] = []
            let matched = true
            let snapshot = ""
            let pidAlive = false

            if (pid !== undefined) {
              pidAlive = processAlive(pid)
              if (pidAlive) {
                matched = false
                problems.push(`pid ${pid} is still running`)
              }
            }

            if (fullPath) {
              try {
                const info = await stat(fullPath)
                if (info.size !== lastSize) {
                  lastSize = info.size
                  lastChangeAt = Date.now()
                }

                snapshot = tailLines(await readFrom(fullPath, 0, TAIL_BYTES), wantedLines)

                if (data.must_be_new && info.size <= baseSize) {
                  matched = false
                  problems.push(`file has not grown (current ${info.size} bytes, starting ${baseSize} bytes)`)
                } else if (regex) {
                  const from = data.must_be_new && baseSize > 0 ? baseSize : 0
                  const scoped = await readFrom(fullPath, from, TAIL_BYTES)
                  if (!regex.test(scoped)) {
                    matched = false
                    problems.push(`log did not match /${data.pattern}/`)
                  }
                }
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                  matched = false
                  problems.push(`file does not exist yet: ${fullPath}`)
                } else {
                  throw error
                }
              }
            }

            if (matched) {
              const head = [
                `[wait_for] condition met after ${((Date.now() - startedAt) / 1000).toFixed(3)}s`,
                pid !== undefined ? `pid: ${pid} exited` : "",
                fullPath ? `path: ${fullPath}` : "",
              ]
                .filter(Boolean)
                .join(" | ")
              const body = snapshot ? `${head}\n\n--- log tail ---\n${compact(snapshot)}` : head
              return buildResult("condition met", true, body)
            }

            if (Date.now() >= deadline) {
              const head = [
                `[wait_for] timed out after ${(waitTimeout / 1000).toFixed(1)}s`,
                `Reason: ${problems.join("; ")}`,
                `Last change: ${((Date.now() - lastChangeAt) / 1000).toFixed(1)}s ago`,
                pidAlive ? `pid ${pid} is still running - the task may simply be slow, not stuck` : "",
                "Next step: inspect the observed state; do not call wait_for again immediately.",
              ]
                .filter(Boolean)
                .join("\n")
              const body = snapshot ? `${head}\n\n--- log tail ---\n${compact(snapshot)}` : head
              return buildResult("timeout", false, body)
            }

            await sleep(Math.min(pollInterval, Math.max(1, deadline - Date.now())))
            await reportProgress(problems.join("; ") || "waiting")
          }
        },
      })
    })
  },
})
