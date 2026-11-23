import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import * as fs from "node:fs/promises"
import * as http from "node:http"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import test from "node:test"
import { jsonPath, normalizeCondition, runWait, sameJson } from "./wait.ts"

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function tempDir(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-wait-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

function listen(server: net.Server | http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") reject(new Error("no address"))
      else resolve(address.port)
    })
  })
}

function close(server: net.Server | http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

test("jsonPath supports dot and bracket paths", () => {
  const value = { jobs: [{ status: "completed", steps: [{ name: "build" }] }] }
  assert.equal(jsonPath(value, "jobs[0].status"), "completed")
  assert.equal(jsonPath(value, "jobs.0.steps[0].name"), "build")
  assert.equal(jsonPath(value, "missing.path"), undefined)
})

test("sameJson compares objects independent of key order", () => {
  assert.equal(sameJson({ a: 1, b: [2, 3] }, { b: [2, 3], a: 1 }), true)
  assert.equal(sameJson("1", 1), true)
  assert.equal(sameJson(null, undefined), false)
})

test("normalizeCondition rejects incomplete conditions", () => {
  assert.throws(() => normalizeCondition({ type: "file_exists" }), /path/)
  assert.throws(() => normalizeCondition({ type: "http_json", url: "http://example.com", jsonPath: "x" }), /equals/)
  assert.throws(() => normalizeCondition({ type: "nope" }), /unsupported/)
})

test("waits for a file that appears", async (t) => {
  const dir = await tempDir(t)
  const full = path.join(dir, "appeared.txt")
  setTimeout(() => void fs.writeFile(full, "hello"), 120)
  const result = await runWait({ type: "file_exists", path: full }, { root: dir, timeoutMs: 2_000, intervalMs: 50 })
  assert.equal(result.matched, true)
  assert.equal(result.timedOut, false)
  assert.ok(result.elapsedMs >= 50)
})

test("waits for a file to disappear", async (t) => {
  const dir = await tempDir(t)
  const full = path.join(dir, "gone.txt")
  await fs.writeFile(full, "bye")
  setTimeout(() => void fs.rm(full, { force: true }), 120)
  const result = await runWait({ type: "file_absent", path: full }, { root: dir, timeoutMs: 2_000, intervalMs: 50 })
  assert.equal(result.matched, true)
})

test("waits for a file to change", async (t) => {
  const dir = await tempDir(t)
  const full = path.join(dir, "change.txt")
  await fs.writeFile(full, "before")
  setTimeout(() => void fs.appendFile(full, "\nafter"), 120)
  const result = await runWait({ type: "file_changed", path: full }, { root: dir, timeoutMs: 2_000, intervalMs: 50 })
  assert.equal(result.matched, true)
  assert.equal(result.observed.changed, true)
})

test("file_contains matches only new content when requested", async (t) => {
  const dir = await tempDir(t)
  const full = path.join(dir, "app.log")
  await fs.writeFile(full, "old line\n")
  setTimeout(() => void fs.appendFile(full, "hello\n"), 120)
  const result = await runWait(
    { type: "file_contains", path: full, pattern: "hello", regex: false, mustBeNew: true },
    { root: dir, timeoutMs: 2_000, intervalMs: 50 },
  )
  assert.equal(result.matched, true)
  assert.match(result.excerpt ?? "", /hello/)
})

test("file_contains sees existing content without mustBeNew", async (t) => {
  const dir = await tempDir(t)
  const full = path.join(dir, "ready.txt")
  await fs.writeFile(full, "ready\n")
  const result = await runWait(
    { type: "file_contains", path: full, pattern: "ready", regex: false, mustBeNew: false },
    { root: dir, timeoutMs: 500, intervalMs: 50 },
  )
  assert.equal(result.matched, true)
  assert.ok(result.elapsedMs < 400)
})

test("file_contains waits for a file created after the call", async (t) => {
  const dir = await tempDir(t)
  const full = path.join(dir, "created.log")
  setTimeout(() => void fs.writeFile(full, "first line\nready\n"), 120)
  const result = await runWait(
    { type: "file_contains", path: full, pattern: "ready", regex: false, mustBeNew: true },
    { root: dir, timeoutMs: 2_000, intervalMs: 50 },
  )
  assert.equal(result.matched, true)
  assert.match(result.excerpt ?? "", /ready/)
})

test("file_exists with stableForMs waits for the file to settle", async (t) => {
  const dir = await tempDir(t)
  const full = path.join(dir, "stable.txt")
  await fs.writeFile(full, "x")
  const result = await runWait(
    { type: "file_exists", path: full, stableForMs: 200 },
    { root: dir, timeoutMs: 2_000, intervalMs: 50 },
  )
  assert.equal(result.matched, true)
  assert.ok(result.elapsedMs >= 150)
})

test("waits for a process to exit", async (t) => {
  const child = spawn("sleep", ["0.25"], { stdio: "ignore" })
  t.after(() => child.kill("SIGKILL"))
  const result = await runWait(
    { type: "process_exited", pid: child.pid! },
    { root: os.tmpdir(), timeoutMs: 3_000, intervalMs: 50 },
  )
  assert.equal(result.matched, true)
})

test("waits for a process that is running", async () => {
  const result = await runWait(
    { type: "process_running", pid: process.pid },
    { root: os.tmpdir(), timeoutMs: 500, intervalMs: 50 },
  )
  assert.equal(result.matched, true)
})

test("waits for a TCP port to open and close", async (t) => {
  const server = net.createServer()
  const port = await listen(server)
  const opened = await runWait(
    { type: "port_open", host: "127.0.0.1", port },
    { root: os.tmpdir(), timeoutMs: 2_000, intervalMs: 50 },
  )
  assert.equal(opened.matched, true)
  await close(server)
  const closed = await runWait(
    { type: "port_closed", host: "127.0.0.1", port },
    { root: os.tmpdir(), timeoutMs: 2_000, intervalMs: 50 },
  )
  assert.equal(closed.matched, true)
})

test("waits for HTTP status, JSON path, and body text", async (t) => {
  const server = http.createServer((request, response) => {
    if (request.url === "/json") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ status: "completed", jobs: [{ conclusion: "success" }] }))
      return
    }
    response.writeHead(200, { "content-type": "text/plain" })
    response.end("service ready\n")
  })
  const port = await listen(server)
  t.after(() => close(server))

  const status = await runWait(
    { type: "http_status", url: `http://127.0.0.1:${port}/`, status: 200 },
    { root: os.tmpdir(), timeoutMs: 2_000, intervalMs: 50 },
  )
  assert.equal(status.matched, true)

  const any2xx = await runWait(
    { type: "http_status", url: `http://127.0.0.1:${port}/` },
    { root: os.tmpdir(), timeoutMs: 2_000, intervalMs: 50 },
  )
  assert.equal(any2xx.matched, true)

  const json = await runWait(
    {
      type: "http_json",
      url: `http://127.0.0.1:${port}/json`,
      jsonPath: "jobs[0].conclusion",
      equals: "success",
    },
    { root: os.tmpdir(), timeoutMs: 2_000, intervalMs: 50 },
  )
  assert.equal(json.matched, true)

  const body = await runWait(
    { type: "http_body_contains", url: `http://127.0.0.1:${port}/`, pattern: "ready", regex: false },
    { root: os.tmpdir(), timeoutMs: 2_000, intervalMs: 50 },
  )
  assert.equal(body.matched, true)
})

test("returns a timeout result instead of throwing", async (t) => {
  const dir = await tempDir(t)
  const result = await runWait(
    { type: "file_exists", path: path.join(dir, "never.txt") },
    { root: dir, timeoutMs: 250, intervalMs: 50 },
  )
  assert.equal(result.matched, false)
  assert.equal(result.timedOut, true)
  assert.ok(result.attempts >= 2)
})

test("returns an aborted result when the signal fires", async (t) => {
  const dir = await tempDir(t)
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 100)
  const result = await runWait(
    { type: "file_exists", path: path.join(dir, "never.txt") },
    { root: dir, timeoutMs: 2_000, intervalMs: 50, signal: controller.signal },
  )
  assert.equal(result.aborted, true)
  assert.equal(result.timedOut, false)
})

test("asserts external paths before reading them", async (t) => {
  const root = await tempDir(t)
  const outside = path.join(os.tmpdir(), `opencode-wait-outside-${process.pid}.txt`)
  await fs.writeFile(outside, "outside")
  t.after(() => fs.rm(outside, { force: true }))
  let asserted = ""
  const result = await runWait(
    { type: "file_exists", path: outside },
    {
      root,
      timeoutMs: 500,
      intervalMs: 50,
      assertExternal: async (full) => {
        asserted = full
      },
    },
  )
  assert.equal(result.matched, true)
  assert.equal(asserted, outside)
})
