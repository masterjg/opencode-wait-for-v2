import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { normalizeCondition, runWait } from "../conditions.ts"
import { createFileWatch, isRemoteFsType, type FileWatch } from "../watch.ts"

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "wait-for-watch-"))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const remoteFsTypes = [
  0x6969, // NFS
  0xff534d42, // CIFS
  0xfe534d42, // SMB2
  0x65735546, // FUSE / sshfs
  0x01021997, // 9p
]

describe("filesystem classification", () => {
  test("classifies network and FUSE filesystems as remote", () => {
    for (const type of remoteFsTypes) expect(isRemoteFsType(type)).toBe(true)
  })

  test("keeps local filesystems on the native watch path", () => {
    expect(isRemoteFsType(0x01021994)).toBe(false) // tmpfs
    expect(isRemoteFsType(0x794c7630)).toBe(false) // overlayfs
    expect(isRemoteFsType(0xef53)).toBe(false) // ext4
  })

  test("returns no watcher for a remote directory", async () => {
    const target = join(dir, "remote.txt")
    const watch = await createFileWatch(target, { remote: async () => true })
    expect(watch).toBeNull()
  })
})

describe("native file watch", () => {
  test("reports a file creation", async () => {
    const target = join(dir, "created.txt")
    const watch = await createFileWatch(target)
    expect(watch).not.toBeNull()
    const pending = watch!.next(2_000)
    setTimeout(() => void writeFile(target, "hello"), 50)
    expect(await pending).toBe("event")
    watch!.close()
  })

  test("follows a chain of missing parent directories", async () => {
    const target = join(dir, "chain", "deep", "file.txt")
    const watch = await createFileWatch(target)
    expect(watch).not.toBeNull()

    setTimeout(() => void mkdir(join(dir, "chain")), 50)
    expect(await watch!.next(2_000)).toBe("event")

    setTimeout(() => void mkdir(join(dir, "chain", "deep")), 50)
    expect(await watch!.next(2_000)).toBe("event")

    setTimeout(() => void writeFile(target, "ready"), 50)
    expect(await watch!.next(2_000)).toBe("event")
    watch!.close()
  })

  test("sees an atomic rename into place", async () => {
    const target = join(dir, "atomic.txt")
    const temporary = join(dir, "atomic.txt.tmp")
    const watch = await createFileWatch(target)
    expect(watch).not.toBeNull()

    const pending = watch!.next(2_000)
    setTimeout(() => {
      void writeFile(temporary, "built").then(() => rename(temporary, target))
    }, 50)
    expect(await pending).toBe("event")
    watch!.close()
  })

  test("times out, aborts, and closes cleanly", async () => {
    const target = join(dir, "quiet.txt")
    const watch = await createFileWatch(target)
    expect(watch).not.toBeNull()

    expect(await watch!.next(50)).toBe("timeout")

    const controller = new AbortController()
    const aborted = watch!.next(2_000, controller.signal)
    setTimeout(() => controller.abort(), 50)
    expect(await aborted).toBe("aborted")

    const closed = watch!.next(5_000)
    watch!.close()
    expect(await closed).toBe("closed")
    expect(await watch!.next(10)).toBe("closed")
  })
})

const noSignal = new AbortController().signal

describe("watch-accelerated waits", () => {
  test("matches on a watch event even with a very long poll interval", async () => {
    const target = join(dir, "fast.log")
    setTimeout(() => void writeFile(target, "ready\n"), 100)

    const result = await runWait(normalizeCondition({ type: "file_exists", path: target }), {
      root: dir,
      timeoutMs: 3_000,
      intervalMs: 5_000,
      signal: noSignal,
    })

    expect(result.matched).toBe(true)
    // Polling alone would need ~5s and time out at 3s.
    expect(result.elapsedMs).toBeLessThan(1_200)
  })

  test("honors stableForMs without waiting for reconciliation", async () => {
    const target = join(dir, "stable.log")
    setTimeout(() => void writeFile(target, "stable\n"), 50)

    const result = await runWait(
      normalizeCondition({ type: "file_exists", path: target, stableForMs: 300 }),
      { root: dir, timeoutMs: 3_000, intervalMs: 5_000, signal: noSignal },
    )

    expect(result.matched).toBe(true)
    expect(result.elapsedMs).toBeLessThan(1_500)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(300)
  })

  test("falls back to polling when the watcher closes", async () => {
    const target = join(dir, "fallback.log")
    const broken: FileWatch = {
      next: async () => "closed",
      close: () => {},
    }
    setTimeout(() => void writeFile(target, "ready\n"), 150)

    const result = await runWait(normalizeCondition({ type: "file_exists", path: target }), {
      root: dir,
      timeoutMs: 2_000,
      intervalMs: 100,
      signal: noSignal,
      watch: async () => broken,
    })

    expect(result.matched).toBe(true)
    expect(result.elapsedMs).toBeLessThan(1_000)
  })

  test("does not split a large mustBeNew append across reconciliation polls", async () => {
    const target = join(dir, "large-watch.log")
    await writeFile(target, "")
    setTimeout(() => void writeFile(target, `${"x".repeat(280 * 1024)}\nNEEDLE\n`), 100)

    const result = await runWait(
      normalizeCondition({
        type: "file_contains",
        path: target,
        pattern: "NEEDLE",
        regex: false,
        mustBeNew: true,
      }),
      { root: dir, timeoutMs: 3_000, intervalMs: 5_000, signal: noSignal },
    )

    expect(result.matched).toBe(true)
    expect(result.elapsedMs).toBeLessThan(1_500)
  })

  test("does not spin when a mustBeNew chunk ends at EOF", async () => {
    const target = join(dir, "eof.log")
    await writeFile(target, "")
    setTimeout(() => void writeFile(target, "x".repeat(300)), 50)

    const result = await runWait(
      normalizeCondition({
        type: "file_contains",
        path: target,
        pattern: "NEVER",
        regex: false,
        mustBeNew: true,
      }),
      { root: dir, timeoutMs: 500, intervalMs: 5_000, signal: noSignal },
    )

    expect(result.matched).toBe(false)
    expect(result.timedOut).toBe(true)
    // The overlap cursor must not be mistaken for unread data at EOF.
    expect(result.attempts).toBeLessThan(10)
  })

  test("aborts a watch-backed wait promptly", async () => {
    const target = join(dir, "abort.log")
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)

    const started = Date.now()
    const result = await runWait(normalizeCondition({ type: "file_exists", path: target }), {
      root: dir,
      timeoutMs: 5_000,
      intervalMs: 5_000,
      signal: controller.signal,
    })

    expect(result.aborted).toBe(true)
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
