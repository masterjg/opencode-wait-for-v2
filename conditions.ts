import * as fs from "node:fs/promises"
import * as net from "node:net"
import * as path from "node:path"
import { createFileWatch, type FileWatch } from "./watch.ts"

export type WaitConditionType =
  | "file_exists"
  | "file_absent"
  | "file_changed"
  | "file_contains"
  | "process_exited"
  | "process_running"
  | "port_open"
  | "port_closed"
  | "http_status"
  | "http_json"
  | "http_body_contains"

export type WaitCondition =
  | { type: "file_exists"; path: string; stableForMs?: number }
  | { type: "file_absent"; path: string }
  | { type: "file_changed"; path: string; since?: number; stableForMs?: number }
  | { type: "file_contains"; path: string; pattern: string; regex: boolean; mustBeNew: boolean }
  | { type: "process_exited"; pid: number }
  | { type: "process_running"; pid: number }
  | { type: "port_open"; host: string; port: number }
  | { type: "port_closed"; host: string; port: number }
  | { type: "http_status"; url: string; status?: number | number[]; headers?: Record<string, string> }
  | { type: "http_json"; url: string; jsonPath: string; equals: unknown; headers?: Record<string, string> }
  | { type: "http_body_contains"; url: string; pattern: string; regex: boolean; headers?: Record<string, string> }

export interface WaitOptions {
  root: string
  timeoutMs?: number
  intervalMs?: number
  signal?: AbortSignal
  assertExternal?: (fullPath: string) => Promise<void>
  progress?: (event: { status: string }) => Promise<void> | void
  /** Test seam for the native watch fast path; defaults to a real watcher. */
  watch?: (fullPath: string) => Promise<FileWatch | null>
}

export interface WaitResult {
  matched: boolean
  timedOut: boolean
  aborted: boolean
  condition: string
  elapsedMs: number
  attempts: number
  observed: Record<string, unknown>
  excerpt?: string
  lastError?: string
}

type EvalResult = {
  matched: boolean
  observed: Record<string, unknown>
  excerpt?: string
  error?: string
}

type EvalState = {
  asserted?: Set<string>
  initial?: { exists: boolean; size?: number; mtimeMs?: number }
  initialSize?: number
  stable?: { size: number; mtimeMs: number; since: number }
  /** Compiled literal/regex matcher, created once per wait. */
  matcher?: (text: string) => { matched: boolean; index: number }
  /** Next byte offset for mustBeNew file_contains reads. */
  cursor?: number
  /** More unread new content remains after the last chunked read. */
  pending?: boolean
  /** Parsed dot/bracket path for http_json, created once per wait. */
  jsonParts?: string[]
}

const DEFAULT_TIMEOUT_MS = 60_000
const MIN_TIMEOUT_MS = 100
const MAX_TIMEOUT_MS = 600_000
const DEFAULT_INTERVAL_MS = 1_000
const MIN_INTERVAL_MS = 100
const MAX_INTERVAL_MS = 30_000
const TAIL_BYTES = 64 * 1024
const NEW_BYTES = 256 * 1024
const HTTP_BYTES = 256 * 1024
/** Re-read this much before the cursor so regex matches can span chunks. */
const REGEX_OVERLAP_BYTES = 4 * 1024
/** After this long, back off polling up to MAX_BACKOFF_MS. */
const BACKOFF_AFTER_MS = 30_000
const MAX_BACKOFF_MS = 5_000
/** Reconciliation cadence while a native watcher is active. */
const WATCH_RECONCILE_MS = 2_000

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Math.trunc(value)))

const has = (value: unknown, key: string): boolean =>
  typeof value === "object" && value !== null && Object.prototype.hasOwnProperty.call(value, key)

function stringField(value: any, key: string): string {
  const field = value?.[key]
  if (typeof field !== "string" || field.trim() === "") {
    throw new Error(`condition.${key} must be a non-empty string`)
  }
  return field.trim()
}

function optionalNumber(value: any, key: string, min = 0): number | undefined {
  if (value?.[key] === undefined) return undefined
  const field = Number(value[key])
  if (!Number.isFinite(field) || field < min) {
    throw new Error(`condition.${key} must be a number >= ${min}`)
  }
  return field
}

function headersField(value: any): Record<string, string> | undefined {
  if (value?.headers === undefined) return undefined
  if (typeof value.headers !== "object" || value.headers === null || Array.isArray(value.headers)) {
    throw new Error("condition.headers must be an object of string values")
  }
  const headers: Record<string, string> = {}
  for (const [key, item] of Object.entries(value.headers)) {
    if (typeof item !== "string") throw new Error(`condition.headers.${key} must be a string`)
    headers[key] = item
  }
  return headers
}

function urlField(value: any): string {
  const raw = stringField(value, "url")
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error("condition.url must be a valid URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("condition.url must use http:// or https://")
  }
  return url.toString()
}

export function normalizeCondition(raw: unknown): WaitCondition {
  if (!raw || typeof raw !== "object") throw new Error("condition must be an object")
  const value = raw as any
  const type = value.type
  if (typeof type !== "string") throw new Error("condition.type must be a string")

  switch (type) {
    case "file_exists": {
      const stableForMs = optionalNumber(value, "stableForMs", 0)
      return {
        type,
        path: stringField(value, "path"),
        ...(stableForMs === undefined ? {} : { stableForMs }),
      }
    }
    case "file_absent":
      return { type, path: stringField(value, "path") }
    case "file_changed": {
      const since = optionalNumber(value, "since", 0)
      const stableForMs = optionalNumber(value, "stableForMs", 0)
      return {
        type,
        path: stringField(value, "path"),
        ...(since === undefined ? {} : { since }),
        ...(stableForMs === undefined ? {} : { stableForMs }),
      }
    }
    case "file_contains": {
      const pattern = stringField(value, "pattern")
      if (value.regex === true) {
        try {
          new RegExp(pattern, "m")
        } catch {
          throw new Error("condition.pattern is not a valid regular expression")
        }
      }
      return {
        type,
        path: stringField(value, "path"),
        pattern,
        regex: value.regex === true,
        mustBeNew: value.mustBeNew === true,
      }
    }
    case "process_exited":
    case "process_running": {
      const pid = Number(value.pid)
      if (!Number.isInteger(pid) || pid <= 0) throw new Error("condition.pid must be a positive integer")
      return { type, pid }
    }
    case "port_open":
    case "port_closed": {
      const host = stringField(value, "host")
      const port = Number(value.port)
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("condition.port must be an integer between 1 and 65535")
      }
      return { type, host, port }
    }
    case "http_status": {
      let status: number | number[] | undefined
      if (value.status !== undefined) {
        const values = Array.isArray(value.status) ? value.status : [value.status]
        if (values.length === 0) throw new Error("condition.status must not be empty")
        status = values.map((item: unknown) => {
          const number = Number(item)
          if (!Number.isInteger(number) || number < 100 || number > 599) {
            throw new Error("condition.status must contain HTTP status codes")
          }
          return number
        })
        if (!Array.isArray(value.status)) status = status[0]
      }
      const headers = headersField(value)
      return {
        type,
        url: urlField(value),
        ...(status === undefined ? {} : { status }),
        ...(headers === undefined ? {} : { headers }),
      }
    }
    case "http_json": {
      if (!has(value, "equals")) throw new Error("condition.equals is required for http_json")
      const headers = headersField(value)
      return {
        type,
        url: urlField(value),
        jsonPath: stringField(value, "jsonPath"),
        equals: value.equals,
        ...(headers === undefined ? {} : { headers }),
      }
    }
    case "http_body_contains": {
      const pattern = stringField(value, "pattern")
      if (value.regex === true) {
        try {
          new RegExp(pattern, "m")
        } catch {
          throw new Error("condition.pattern is not a valid regular expression")
        }
      }
      const headers = headersField(value)
      return {
        type,
        url: urlField(value),
        pattern,
        regex: value.regex === true,
        ...(headers === undefined ? {} : { headers }),
      }
    }
    default:
      throw new Error(`unsupported condition.type: ${type}`)
  }
}

export function describeCondition(condition: WaitCondition): string {
  switch (condition.type) {
    case "file_exists":
      return `file exists: ${condition.path}`
    case "file_absent":
      return `file absent: ${condition.path}`
    case "file_changed":
      return `file changed: ${condition.path}`
    case "file_contains":
      return `file contains ${JSON.stringify(condition.pattern)}: ${condition.path}`
    case "process_exited":
      return `process exited: pid ${condition.pid}`
    case "process_running":
      return `process running: pid ${condition.pid}`
    case "port_open":
      return `port open: ${condition.host}:${condition.port}`
    case "port_closed":
      return `port closed: ${condition.host}:${condition.port}`
    case "http_status":
      return `HTTP status ${condition.status ?? "2xx"}: ${condition.url}`
    case "http_json":
      return `HTTP JSON ${condition.jsonPath} == ${JSON.stringify(condition.equals)}: ${condition.url}`
    case "http_body_contains":
      return `HTTP body contains ${JSON.stringify(condition.pattern)}: ${condition.url}`
  }
}

export function jsonPathParts(pathText: string): string[] {
  return pathText
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean)
}

export function jsonPathFromParts(value: unknown, parts: readonly string[]): unknown {
  let current: any = value
  for (const part of parts) {
    if (current === null || current === undefined) return undefined
    current = current[part]
  }
  return current
}

export function jsonPath(value: unknown, pathText: string): unknown {
  return jsonPathFromParts(value, jsonPathParts(pathText))
}

export function sameJson(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true
  if (
    typeof expected === "string" &&
    (typeof actual === "number" || typeof actual === "boolean")
  ) {
    return String(actual) === expected
  }
  if (
    typeof actual === "string" &&
    (typeof expected === "number" || typeof expected === "boolean")
  ) {
    return actual === String(expected)
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return (
      actual.length === expected.length &&
      actual.every((value, index) => sameJson(value, expected[index]))
    )
  }
  if (
    actual !== null &&
    expected !== null &&
    typeof actual === "object" &&
    typeof expected === "object" &&
    !Array.isArray(actual) &&
    !Array.isArray(expected)
  ) {
    const actualRecord = actual as Record<string, unknown>
    const expectedRecord = expected as Record<string, unknown>
    const actualKeys = Object.keys(actualRecord)
    const expectedKeys = Object.keys(expectedRecord)
    return (
      actualKeys.length === expectedKeys.length &&
      expectedKeys.every((key) => sameJson(actualRecord[key], expectedRecord[key]))
    )
  }
  return false
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ESRCH") return false
    if (code === "EPERM") return true
    throw error
  }
}

export function portOpen(host: string, port: number, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const socket = net.connect({ host, port })
    const finish = (open: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(timeoutMs)
    socket.once("connect", () => finish(true))
    socket.once("timeout", () => finish(false))
    socket.once("error", () => finish(false))
    socket.once("close", () => finish(false))
  })
}

function resolvePath(root: string, value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(root, value)
}

function outsideRoot(root: string, fullPath: string): boolean {
  const relative = path.relative(root, fullPath)
  return relative.startsWith("..") || path.isAbsolute(relative)
}

async function assertPath(state: EvalState, options: WaitOptions, fullPath: string): Promise<void> {
  if (!outsideRoot(options.root, fullPath)) return
  if (!options.assertExternal) throw new Error(`path is outside the project: ${fullPath}`)
  state.asserted ??= new Set<string>()
  if (state.asserted.has(fullPath)) return
  await options.assertExternal(fullPath)
  state.asserted.add(fullPath)
}

function fileConditionPath(condition: WaitCondition): string | undefined {
  switch (condition.type) {
    case "file_exists":
    case "file_absent":
    case "file_changed":
    case "file_contains":
      return condition.path
    default:
      return undefined
  }
}

/**
 * Do not let a reconciliation poll overshoot a `stableForMs` deadline. Without
 * this, a watcher could report no new events and the wait would discover
 * stability up to one reconciliation interval late.
 */
function stableWaitMs(condition: WaitCondition, state: EvalState, base: number): number {
  if (
    (condition.type === "file_exists" || condition.type === "file_changed") &&
    condition.stableForMs
  ) {
    if (state.stable) {
      const remaining = condition.stableForMs - (Date.now() - state.stable.since)
      return Math.max(1, Math.min(base, remaining))
    }
  }
  return base
}

/**
 * `file_contains` with `mustBeNew` processes at most NEW_BYTES per check. If
 * more new content is waiting, re-check immediately instead of making the
 * reconciliation timer split a large append into 2-second slices.
 */
function pendingFileContent(condition: WaitCondition, state: EvalState): boolean {
  return condition.type === "file_contains" && condition.mustBeNew && state.pending === true
}

async function statMaybe(fullPath: string) {
  try {
    return await fs.stat(fullPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return null
    throw error
  }
}

async function readRange(
  fullPath: string,
  start: number,
  length: number,
): Promise<{ text: string; bytesRead: number }> {
  const handle = await fs.open(fullPath, "r")
  try {
    const buffer = Buffer.alloc(Math.max(0, length))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), bytesRead }
  } finally {
    await handle.close()
  }
}

function excerptOf(text: string, index: number, length = 500): string {
  const start = Math.max(0, index - Math.floor(length / 2))
  return text.slice(start, start + length)
}

function patternMatcher(pattern: string, regex: boolean): (text: string) => { matched: boolean; index: number } {
  if (!regex) {
    return (text) => {
      const index = text.indexOf(pattern)
      return { matched: index >= 0, index: Math.max(0, index) }
    }
  }
  const compiled = new RegExp(pattern, "m")
  return (text) => {
    const match = compiled.exec(text)
    return { matched: match !== null, index: Math.max(0, match?.index ?? 0) }
  }
}

function limitJson(value: unknown, max = 2_000): unknown {
  if (value === undefined || value === null) return value
  const text = JSON.stringify(value)
  if (text.length <= max) return value
  return `${text.slice(0, max)}…`
}

/** Serialize large JSON observations only when a wait result is returned. */
function summarizeObserved(observed: Record<string, unknown>): Record<string, unknown> {
  if (!("value" in observed)) return observed
  return { ...observed, value: limitJson(observed.value) }
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ""
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      const chunk = Buffer.from(value).subarray(0, maxBytes - total)
      chunks.push(chunk)
      total += chunk.byteLength
    }
  } finally {
    try {
      await reader.cancel()
    } catch {}
  }
  return Buffer.concat(chunks).toString("utf8")
}

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function fetchOnce(
  url: string,
  headers: Record<string, string> | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Response> {
  return fetch(url, {
    headers,
    redirect: "follow",
    signal: combinedSignal(signal, timeoutMs),
  })
}

/** Drain an unused response body so undici can reuse the connection. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {}
}

async function evaluate(
  condition: WaitCondition,
  state: EvalState,
  options: WaitOptions,
  intervalMs: number,
): Promise<EvalResult> {
  switch (condition.type) {
    case "file_exists":
    case "file_absent":
    case "file_changed": {
      const fullPath = resolvePath(options.root, condition.path)
      await assertPath(state, options, fullPath)
      const stat = await statMaybe(fullPath)

      if (condition.type === "file_absent") {
        return { matched: stat === null, observed: { path: fullPath, exists: stat !== null } }
      }

      if (!stat) {
        if (condition.type === "file_changed") {
          state.initial ??= { exists: false }
        }
        state.stable = undefined
        return { matched: false, observed: { path: fullPath, exists: false } }
      }

      if (condition.type === "file_exists") {
        if (!condition.stableForMs) {
          return {
            matched: true,
            observed: { path: fullPath, exists: true, size: stat.size, mtimeMs: stat.mtimeMs },
          }
        }
        if (
          state.stable &&
          state.stable.size === stat.size &&
          state.stable.mtimeMs === stat.mtimeMs
        ) {
          const elapsed = Date.now() - state.stable.since
          return {
            matched: elapsed >= condition.stableForMs,
            observed: {
              path: fullPath,
              exists: true,
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              stableMs: elapsed,
            },
          }
        }
        state.stable = { size: stat.size, mtimeMs: stat.mtimeMs, since: Date.now() }
        return {
          matched: false,
          observed: { path: fullPath, exists: true, size: stat.size, mtimeMs: stat.mtimeMs, stableMs: 0 },
        }
      }

      state.initial ??= { exists: true, size: stat.size, mtimeMs: stat.mtimeMs }
      const initial = state.initial
      const changed = condition.since !== undefined
        ? stat.mtimeMs > condition.since
        : !initial.exists || initial.size !== stat.size || initial.mtimeMs !== stat.mtimeMs

      if (!changed) {
        return {
          matched: false,
          observed: {
            path: fullPath,
            exists: true,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            changed: false,
          },
        }
      }

      if (!condition.stableForMs) {
        return {
          matched: true,
          observed: {
            path: fullPath,
            exists: true,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            changed: true,
          },
        }
      }

      if (state.stable && state.stable.size === stat.size && state.stable.mtimeMs === stat.mtimeMs) {
        const elapsed = Date.now() - state.stable.since
        return {
          matched: elapsed >= condition.stableForMs,
          observed: {
            path: fullPath,
            exists: true,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            changed: true,
            stableMs: elapsed,
          },
        }
      }
      state.stable = { size: stat.size, mtimeMs: stat.mtimeMs, since: Date.now() }
      return {
        matched: false,
        observed: {
          path: fullPath,
          exists: true,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          changed: true,
          stableMs: 0,
        },
      }
    }

    case "file_contains": {
      const fullPath = resolvePath(options.root, condition.path)
      await assertPath(state, options, fullPath)
      const stat = await statMaybe(fullPath)
      if (!stat) {
        state.initialSize ??= 0
        state.pending = false
        return { matched: false, observed: { path: fullPath, exists: false } }
      }

      if (state.initialSize === undefined) state.initialSize = stat.size
      if (stat.size < state.initialSize) {
        state.initialSize = 0
        state.cursor = 0
      }
      state.matcher ??= patternMatcher(condition.pattern, condition.regex)
      if (condition.mustBeNew && state.cursor === undefined) state.cursor = state.initialSize

      const start = condition.mustBeNew
        ? Math.max(state.cursor ?? state.initialSize, 0)
        : Math.max(0, stat.size - TAIL_BYTES)
      const length = Math.min(condition.mustBeNew ? NEW_BYTES : TAIL_BYTES, stat.size - start)
      const read = length > 0 ? await readRange(fullPath, start, length) : { text: "", bytesRead: 0 }
      const text = read.text
      const match = state.matcher(text)
      if (!match.matched) {
        if (condition.mustBeNew && read.bytesRead > 0) {
          const overlap = condition.regex
            ? REGEX_OVERLAP_BYTES
            : Math.max(0, condition.pattern.length - 1)
          state.cursor = Math.max(start, start + read.bytesRead - overlap)
          // Only ask for an immediate re-check when the chunk was capped and
          // unread bytes remain. The cursor intentionally backs up by an
          // overlap, so `cursor < size` alone would spin at EOF.
          state.pending = start + read.bytesRead < stat.size
        } else {
          state.pending = false
        }
        return {
          matched: false,
          observed: {
            path: fullPath,
            exists: true,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            offset: start,
          },
        }
      }
      state.pending = false
      return {
        matched: true,
        observed: {
          path: fullPath,
          exists: true,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          offset: start,
        },
        excerpt: excerptOf(text, match.index),
      }
    }

    case "process_exited":
    case "process_running": {
      const alive = pidAlive(condition.pid)
      return {
        matched: condition.type === "process_exited" ? !alive : alive,
        observed: { pid: condition.pid, alive },
      }
    }

    case "port_open":
    case "port_closed": {
      const open = await portOpen(condition.host, condition.port)
      return {
        matched: condition.type === "port_open" ? open : !open,
        observed: { host: condition.host, port: condition.port, open },
      }
    }

    case "http_status": {
      const perAttempt = Math.max(2_000, Math.min(10_000, intervalMs))
      try {
        const response = await fetchOnce(condition.url, condition.headers, options.signal, perAttempt)
        await discardBody(response)
        const expected = condition.status === undefined
          ? response.status >= 200 && response.status < 300
          : Array.isArray(condition.status)
            ? condition.status.includes(response.status)
            : condition.status === response.status
        return {
          matched: expected,
          observed: { url: condition.url, status: response.status },
        }
      } catch (error) {
        return {
          matched: false,
          observed: { url: condition.url },
          error: String((error as Error)?.message ?? error),
        }
      }
    }

    case "http_json": {
      const perAttempt = Math.max(2_000, Math.min(10_000, intervalMs))
      try {
        const response = await fetchOnce(condition.url, condition.headers, options.signal, perAttempt)
        if (response.status < 200 || response.status >= 300) {
          await discardBody(response)
          return {
            matched: false,
            observed: { url: condition.url, status: response.status },
          }
        }
        const text = await readLimited(response, HTTP_BYTES)
        let body: unknown
        try {
          body = JSON.parse(text)
        } catch {
          return {
            matched: false,
            observed: { url: condition.url, status: response.status, body: text.slice(0, 500) },
            error: "response is not valid JSON",
          }
        }
        state.jsonParts ??= jsonPathParts(condition.jsonPath)
        const actual = jsonPathFromParts(body, state.jsonParts)
        return {
          matched: sameJson(actual, condition.equals),
          observed: {
            url: condition.url,
            status: response.status,
            value: actual,
          },
        }
      } catch (error) {
        return {
          matched: false,
          observed: { url: condition.url },
          error: String((error as Error)?.message ?? error),
        }
      }
    }

    case "http_body_contains": {
      const perAttempt = Math.max(2_000, Math.min(10_000, intervalMs))
      try {
        const response = await fetchOnce(condition.url, condition.headers, options.signal, perAttempt)
        if (response.status < 200 || response.status >= 300) {
          await discardBody(response)
          return {
            matched: false,
            observed: { url: condition.url, status: response.status },
          }
        }
        const text = await readLimited(response, HTTP_BYTES)
        state.matcher ??= patternMatcher(condition.pattern, condition.regex)
        const match = state.matcher(text)
        return {
          matched: match.matched,
          observed: { url: condition.url, status: response.status },
          ...(match.matched ? { excerpt: excerptOf(text, match.index) } : {}),
        }
      } catch (error) {
        return {
          matched: false,
          observed: { url: condition.url },
          error: String((error as Error)?.message ?? error),
        }
      }
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error("aborted"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export async function runWait(condition: WaitCondition, options: WaitOptions): Promise<WaitResult> {
  const timeoutMs = clamp(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
  const intervalMs = clamp(options.intervalMs ?? DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS)
  const started = Date.now()
  const state: EvalState = {}
  let attempts = 0
  let last: EvalResult = { matched: false, observed: {} }
  let lastProgress = 0
  let delay = intervalMs

  // Create the watcher only after the first condition check fails. An
  // already-satisfied wait should not pay for statfs + fs.watch setup.
  let watch: FileWatch | null | undefined
  let watchPath: string | undefined
  const filePath = fileConditionPath(condition)
  if (filePath) {
    watchPath = resolvePath(options.root, filePath)
    await assertPath(state, options, watchPath)
  }

  try {
    while (true) {
      if (options.signal?.aborted) {
        return {
          matched: false,
          timedOut: false,
          aborted: true,
          condition: describeCondition(condition),
          elapsedMs: Date.now() - started,
          attempts,
          observed: summarizeObserved(last.observed),
          ...(last.excerpt ? { excerpt: last.excerpt } : {}),
          ...(last.error ? { lastError: last.error } : {}),
        }
      }

      attempts += 1
      last = await evaluate(condition, state, options, intervalMs)

      if (last.matched) {
        return {
          matched: true,
          timedOut: false,
          aborted: false,
          condition: describeCondition(condition),
          elapsedMs: Date.now() - started,
          attempts,
          observed: summarizeObserved(last.observed),
          ...(last.excerpt ? { excerpt: last.excerpt } : {}),
        }
      }

      const elapsed = Date.now() - started
      if (elapsed >= timeoutMs) {
        return {
          matched: false,
          timedOut: true,
          aborted: false,
          condition: describeCondition(condition),
          elapsedMs: elapsed,
          attempts,
          observed: summarizeObserved(last.observed),
          ...(last.excerpt ? { excerpt: last.excerpt } : {}),
          ...(last.error ? { lastError: last.error } : {}),
        }
      }

      if (options.progress && Date.now() - lastProgress >= 1_000) {
        lastProgress = Date.now()
        try {
          // Do not let a slow UI progress update delay the next condition check.
          void Promise.resolve(
            options.progress({
              status: `waiting for ${describeCondition(condition)} (${Math.round(elapsed / 1000)}s)`,
            }),
          ).catch(() => {})
        } catch {}
      }

      if (watch === undefined && watchPath) {
        try {
          watch = await (options.watch ?? createFileWatch)(watchPath)
        } catch {
          watch = null
        }
      }

      if (watch) {
        const base = Math.max(1_000, Math.min(WATCH_RECONCILE_MS, intervalMs * 2))
        const waitMs = pendingFileContent(condition, state)
          ? 1
          : Math.max(1, Math.min(timeoutMs - elapsed, stableWaitMs(condition, state, base)))
        let outcome: Awaited<ReturnType<FileWatch["next"]>>
        try {
          outcome = await watch.next(waitMs, options.signal)
        } catch {
          watch.close()
          watch = null
          delay = intervalMs
          continue
        }
        if (outcome === "event") {
          delay = intervalMs
          continue
        }
        if (outcome === "closed") {
          watch.close()
          watch = null
          delay = intervalMs
          continue
        }
        if (outcome === "aborted") {
          if (options.signal?.aborted) continue
          watch.close()
          watch = null
          delay = intervalMs
          continue
        }
      } else {
        if (elapsed > BACKOFF_AFTER_MS) {
          delay = Math.min(MAX_BACKOFF_MS, Math.max(intervalMs, delay * 2))
        }

        try {
          await sleep(Math.min(delay, timeoutMs - elapsed), options.signal)
        } catch {
          return {
            matched: false,
            timedOut: false,
            aborted: true,
            condition: describeCondition(condition),
            elapsedMs: Date.now() - started,
            attempts,
            observed: summarizeObserved(last.observed),
            ...(last.excerpt ? { excerpt: last.excerpt } : {}),
            ...(last.error ? { lastError: last.error } : {}),
          }
        }
      }
    }
  } finally {
    watch?.close()
  }
}
