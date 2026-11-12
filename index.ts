import { open, stat } from "node:fs/promises"
import { normalizeCondition, runWait, type WaitResult } from "./conditions.ts"

/**
 * opencode-wait-for-v2 —— 给 OpenCode V2 补一个「等新输出」的原语。
 *
 * 问题
 * ----
 * OpenCode 内置的 shell 工具是「跑完才返回」：长任务执行期间整轮对话阻塞，
 * UI 没有任何进度，结束后模型还要再推理一轮（本机实测这一轮 P50 约 14 秒）。
 *
 * 更麻烦的是它没有「等日志刷出某一行」的能力。模型于是只能自己拼：
 *
 *     sleep 60; tail -c 800 build.log | tail -12; ps -Ao pid,command | grep ...
 *
 * 一条长任务往往要轮询十几次，每次都是「白等 N 秒 + 重新推理一轮」。
 *
 * 做法
 * ----
 * 把「等」收进一次工具调用：
 *   - 命令在内部轮询，对话只占一次
 *   - 条件成立立刻返回，不傻等到 timeout
 *   - 超时不抛错，返回里带进程状态和日志尾部，让模型能判断是「慢」还是「卡死」
 *   - 支持 AbortSignal，用户按 ESC 中断会话立刻停
 *
 * 这是对标 Codex CLI 的 `write_stdin` / `clock.sleep` 的设计：
 * 那边同样是「一次调用阻塞等待 + 可中断 + 返回已产出输出」。
 */

const DEFAULT_TIMEOUT_MS = 240_000
const MAX_TIMEOUT_MS = 600_000
const DEFAULT_POLL_MS = 500
const MIN_POLL_MS = 100

/** 只监视文件尾部这么多字节，避免把几十 MB 的构建日志读进内存。 */
const TAIL_BYTES = 64 * 1024

/** 返回给模型的日志上限，超长时保留尾部。 */
const MAX_OUTPUT_CHARS = 4_000

/** progress 上报节流，避免刷屏。 */
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
 * 从 from 偏移读到文件末尾，一次 open/read 完成，最多读 maxBytes 字节。
 *
 * 不用 readFile：构建日志动辄几十 MB，整体读入既慢又占内存。
 * 窗口左边界取 max(from, size - maxBytes)，保证既不早于 from 也不超过容量。
 */
async function readFrom(path: string, from: number, maxBytes: number): Promise<string> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`${path} 不是普通文件`)
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

/** 只保留最后 n 行，避免把整个日志尾部丢给模型。 */
function tailLines(text: string, lines: number): string {
  const all = text.split("\n")
  if (all.length <= lines) return text
  return all.slice(all.length - lines).join("\n")
}

/** 超长时保留尾部——日志的结论总在最后。 */
function compact(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text
  return `...(省略前 ${text.length - limit} 字符)...\n${text.slice(text.length - limit)}`
}

/** 进程是否还活着。EPERM 表示进程存在但不属于当前用户，同样算活着。 */
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
  "阻塞等待一个条件成立，最多等到 timeout_ms。用来替代 `sleep N; tail ...` 这种前台轮询。",
  "",
  "三种用法（可组合，全部满足才返回）：",
  "  1. 等文件出现：只给 path",
  "  2. 等日志出现某行：path + pattern（正则）",
  "  3. 等进程退出：pid",
  "",
  "条件成立立刻返回，不会傻等到 timeout。超时也会正常返回（输出以 `[wait_for] timed out` 开头，",
  "并附上进程状态和日志尾部），这时应当先检查进程是否还活着，而不是再调一次 wait_for 重复等待。",
  "",
  "典型场景：",
  "  - 长任务用 shell 的 background: true 启动并重定向到日志，然后等结束标记：",
  "      path: '/tmp/build.log', pattern: 'BUILD (SUCCESS|FAILURE)'",
  "  - 等端口起来：path: '/tmp/dev.log', pattern: 'listening on'",
  "  - 等后台进程结束：pid: 12345",
  "",
  "返回内容是命中时的日志尾部（或超时时的日志尾部），不需要再单独 tail。",
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
              description: "要监视的文件路径（绝对路径）。通常是 background shell 重定向生成的日志。",
            },
            pattern: {
              type: "string",
              description:
                "正则表达式。文件内容匹配到它才算条件成立。只监视文件尾部 64KB，不要指望匹配很久以前的内容。需要配合 path 使用。",
            },
            pid: {
              type: "number",
              description: "改为等待这个进程退出。可以同时给 path，这样进程结束和日志匹配都要满足。",
            },
            timeout_ms: {
              type: "number",
              description: `最长等待毫秒数，默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}。`,
            },
            poll_ms: {
              type: "number",
              description: `轮询间隔毫秒数，默认 ${DEFAULT_POLL_MS}，最小 ${MIN_POLL_MS}。一般不用改。`,
            },
            tail_lines: {
              type: "number",
              description: "返回日志的最后多少行，默认 60。",
            },
            must_be_new: {
              type: "boolean",
              description:
                "true 表示只有调用之后新写入的内容才算数（先记下当前文件大小）。适合日志里已经存在旧匹配的情况。",
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
            throw new Error("pattern 需要配合 path 使用")
          }
          if (!path && pid === undefined) {
            throw new Error("wait_for 至少需要 path 或 pid 其中之一")
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
              throw new Error(`pattern 不是合法正则: ${(error as Error).message}`)
            }
          }

          // must_be_new：记下起始大小，之后只认新增部分
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
          let snapshotKey = ""
          let snapshotRaw = ""

          /** 上报进度，避免阻塞期间 UI 完全没反应——那正是 sleep 轮询最糟的体验。 */
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
              // 进度上报失败不影响等待本身
            }
          }

          const buildResult = (reason: string, hit: boolean, body: string) => ({
            content: body,
            metadata: {
              reason,
              hit,
              waited_ms: Date.now() - startedAt,
              // 最后一次内容变化距今多久 —— 用来区分「慢」和「卡死」
              idle_ms: Date.now() - lastChangeAt,
              ...(path ? { path } : {}),
              ...(pid !== undefined ? { pid } : {}),
            },
          })

          while (true) {
            if (context?.signal?.aborted) {
              throw new Error("wait_for 被中止")
            }

            const problems: string[] = []
            let matched = true
            let snapshot = ""
            let pidAlive = false

            // 各条件独立判定、独立记录原因，避免一个条件失败就吞掉其他诊断信息
            if (pid !== undefined) {
              pidAlive = processAlive(pid)
              if (pidAlive) {
                matched = false
                problems.push(`pid ${pid} 仍在运行`)
              }
            }

            // 注意：即使 pid 还活着也要读日志，否则超时时拿不到日志尾部
            if (path) {
              try {
                const info = await stat(path)
                if (info.size !== lastSize) {
                  lastSize = info.size
                  lastChangeAt = Date.now()
                }

                const key = `${info.size}:${info.mtimeMs}`
                if (key !== snapshotKey) {
                  snapshotRaw = await readFrom(path, 0, TAIL_BYTES)
                  snapshotKey = key
                }
                snapshot = tailLines(snapshotRaw, wantedLines)

                if (input.must_be_new && info.size <= baseSize) {
                  matched = false
                  problems.push(`文件尚未增长（当前 ${info.size} 字节，起始 ${baseSize} 字节）`)
                } else if (regex) {
                  // must_be_new 时只匹配新增区段，避免命中历史日志；也只读该区段
                  const from = input.must_be_new && baseSize > 0 ? baseSize : 0
                  const scoped = from === 0 ? snapshotRaw : await readFrom(path, from, TAIL_BYTES)
                  if (!regex.test(scoped)) {
                    matched = false
                    problems.push(`日志未匹配 /${input.pattern}/`)
                  }
                }
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                  matched = false
                  problems.push(`文件还不存在: ${path}`)
                } else {
                  throw error
                }
              }
            }

            if (matched) {
              const head = [
                `[wait_for] 条件成立，等待 ${((Date.now() - startedAt) / 1000).toFixed(3)}s`,
                pid !== undefined ? `pid: ${pid} 已退出` : "",
                path ? `path: ${path}` : "",
              ]
                .filter(Boolean)
                .join(" | ")
              const body = snapshot ? `${head}\n\n--- 日志尾部 ---\n${compact(snapshot)}` : head
              return buildResult("condition met", true, body)
            }

            if (Date.now() >= deadline) {
              const head = [
                `[wait_for] timed out 等了 ${(timeoutMs / 1000).toFixed(1)}s`,
                `原因: ${problems.join("；")}`,
                `最后变化: ${((Date.now() - lastChangeAt) / 1000).toFixed(1)}s 前`,
                pidAlive ? `pid ${pid} 仍在运行 —— 任务可能只是慢，不是卡死` : "",
                "下一步建议: 用 ps / lsof 确认进程状态，不要直接再调一次 wait_for 重复等待。",
              ]
                .filter(Boolean)
                .join("\n")
              const body = snapshot ? `${head}\n\n--- 日志尾部 ---\n${compact(snapshot)}` : head
              return buildResult("timeout", false, body)
            }

            await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())))
            void reportProgress(problems.join("；") || "等待中")
          }
        },
      })
    })

    return () => void registration?.dispose?.()
  },
}
