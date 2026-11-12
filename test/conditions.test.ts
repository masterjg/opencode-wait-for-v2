import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer as createHttpServer } from "node:http"
import { createServer as createTcpServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../index.ts"

type Exec = (input: any, context: any) => Promise<{ content: string; metadata: any }>

let exec: Exec
let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "wait-for-conditions-"))
  let captured: any
  await plugin.setup({
    tool: {
      transform: async (callback: (editor: any) => void) => {
        callback({ add: (tool: any) => (captured = tool) })
        return { dispose: async () => {} }
      },
    },
  } as any)
  exec = captured.execute
  if (!exec) throw new Error("plugin did not register wait_for")
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const noSignal = { signal: new AbortController().signal, progress: async () => {} }

describe("unified conditions", () => {
  test("registers the condition schema alongside legacy fields", () => {
    let captured: any
    return plugin.setup({
      tool: {
        transform: async (callback: (editor: any) => void) => {
          callback({ add: (tool: any) => (captured = tool) })
          return { dispose: async () => {} }
        },
      },
    } as any).then(() => {
      expect(captured.name).toBe("wait_for")
      expect(captured.input.properties.condition).toBeDefined()
      expect(captured.input.properties.path).toBeDefined()
    })
  })

  test("file_exists waits for a path that appears", async () => {
    const path = join(dir, "appeared.txt")
    setTimeout(() => void writeFile(path, "hello"), 100)
    const result = await exec(
      { condition: { type: "file_exists", path }, timeout_ms: 2000, poll_ms: 50 },
      noSignal,
    )
    expect(result.metadata.hit).toBe(true)
    expect(result.metadata.observed.exists).toBe(true)
  })

  test("file_absent waits for a path to disappear", async () => {
    const path = join(dir, "gone.txt")
    await writeFile(path, "bye")
    setTimeout(() => void rm(path, { force: true }), 100)
    const result = await exec(
      { condition: { type: "file_absent", path }, timeout_ms: 2000, poll_ms: 50 },
      noSignal,
    )
    expect(result.metadata.hit).toBe(true)
  })

  test("file_changed waits for a size or mtime change", async () => {
    const path = join(dir, "change.txt")
    await writeFile(path, "before")
    setTimeout(() => void appendFile(path, "\nafter"), 100)
    const result = await exec(
      { condition: { type: "file_changed", path }, timeout_ms: 2000, poll_ms: 50 },
      noSignal,
    )
    expect(result.metadata.hit).toBe(true)
    expect(result.metadata.observed.changed).toBe(true)
  })

  test("file_contains can restrict matches to new content", async () => {
    const path = join(dir, "app.log")
    await writeFile(path, "old line\n")
    setTimeout(() => void appendFile(path, "ready\n"), 100)
    const result = await exec(
      {
        condition: {
          type: "file_contains",
          path,
          pattern: "ready",
          mustBeNew: true,
        },
        timeout_ms: 2000,
        poll_ms: 50,
      },
      noSignal,
    )
    expect(result.metadata.hit).toBe(true)
    expect(result.content).toContain("ready")
  })

  test("process_exited waits for a process to exit", async () => {
    const child = spawn("sleep", ["0.2"], { stdio: "ignore" })
    const result = await exec(
      { condition: { type: "process_exited", pid: child.pid }, timeout_ms: 3000, poll_ms: 50 },
      noSignal,
    )
    expect(result.metadata.hit).toBe(true)
  })

  test("port_open and port_closed wait for TCP state", async () => {
    const server = createTcpServer()
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("no port")
    const opened = await exec(
      { condition: { type: "port_open", host: "127.0.0.1", port: address.port }, timeout_ms: 2000, poll_ms: 50 },
      noSignal,
    )
    expect(opened.metadata.hit).toBe(true)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const closed = await exec(
      { condition: { type: "port_closed", host: "127.0.0.1", port: address.port }, timeout_ms: 2000, poll_ms: 50 },
      noSignal,
    )
    expect(closed.metadata.hit).toBe(true)
  })

  test("HTTP status, JSON path, and body conditions", async () => {
    const server = createHttpServer((request, response) => {
      if (request.url === "/json") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ status: "completed", jobs: [{ conclusion: "success" }] }))
        return
      }
      response.writeHead(200, { "content-type": "text/plain" })
      response.end("service ready\n")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("no port")
    const base = `http://127.0.0.1:${address.port}`

    const status = await exec(
      { condition: { type: "http_status", url: `${base}/` }, timeout_ms: 2000, poll_ms: 50 },
      noSignal,
    )
    expect(status.metadata.hit).toBe(true)

    const json = await exec(
      {
        condition: {
          type: "http_json",
          url: `${base}/json`,
          jsonPath: "jobs[0].conclusion",
          equals: "success",
        },
        timeout_ms: 2000,
        poll_ms: 50,
      },
      noSignal,
    )
    expect(json.metadata.hit).toBe(true)

    const body = await exec(
      {
        condition: { type: "http_body_contains", url: `${base}/`, pattern: "ready" },
        timeout_ms: 2000,
        poll_ms: 50,
      },
      noSignal,
    )
    expect(body.metadata.hit).toBe(true)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  test("timeout returns a result instead of throwing", async () => {
    const result = await exec(
      { condition: { type: "file_exists", path: join(dir, "never.txt") }, timeout_ms: 250, poll_ms: 50 },
      noSignal,
    )
    expect(result.metadata.hit).toBe(false)
    expect(result.metadata.reason).toBe("timeout")
    expect(result.content).toContain("timed out")
  })

  test("legacy path/pattern input still works", async () => {
    const path = join(dir, "legacy.log")
    await writeFile(path, "BUILD SUCCESS\n")
    const result = await exec({ path, pattern: "BUILD SUCCESS", timeout_ms: 1000 }, noSignal)
    expect(result.metadata.hit).toBe(true)
    expect(result.content).toContain("BUILD SUCCESS")
  })

  test("invalid conditions are rejected", async () => {
    await expect(
      exec({ condition: { type: "process_exited", pid: 0 }, timeout_ms: 100 }, noSignal),
    ).rejects.toThrow()
  })
})
