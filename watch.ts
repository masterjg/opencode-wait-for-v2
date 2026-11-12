import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"

export type WatchOutcome = "event" | "timeout" | "closed" | "aborted"

export interface FileWatch {
  /**
   * Wait for the next filesystem hint, a reconciliation timeout, or abort.
   * Events are hints only: the caller must re-check the actual condition.
   */
  next(timeoutMs: number, signal?: AbortSignal): Promise<WatchOutcome>
  close(): void
}

export interface FileWatchOptions {
  /** Test seam for filesystem classification. */
  remote?: (directory: string) => Promise<boolean>
}

interface Waiter {
  resolve: (outcome: WatchOutcome) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
}

interface ArmedWatcher {
  watcher: fs.FSWatcher
  dispose: () => void
}

/**
 * Filesystem magic values for network and remote-ish filesystems where inotify
 * is not a reliable notification source. The list is intentionally
 * conservative: a false positive only costs polling latency, while treating a
 * remote filesystem as local would make delivery depend on missed events.
 */
const REMOTE_FS_TYPES = new Set<number>([
  0x6969, // NFS
  0xff534d42, // CIFS / SMB1
  0xfe534d42, // SMB2
  0x65735546, // FUSE (sshfs, rclone, etc.)
  0x01021997, // 9p
  0x5346414f, // AFS
  0x00c36400, // Ceph
  0x01161970, // GFS2
  0x7461636f, // OCFS2
  0x0bd00bd0, // Lustre
  0x47504653, // GPFS
])

export function isRemoteFsType(type: number): boolean {
  return REMOTE_FS_TYPES.has(type >>> 0)
}

async function isRemoteDirectory(directory: string): Promise<boolean> {
  try {
    const stats = await fsp.statfs(directory)
    return isRemoteFsType(Number(stats.type))
  } catch {
    // Unknown filesystem: try the native watcher. If it fails, the caller
    // falls back to polling, so this cannot make correctness worse.
    return false
  }
}

interface NearestDirectory {
  directory: string
  /** First path component below the watched directory. */
  interest: string
}

/**
 * Walk up to the nearest existing directory. Watching an ancestor is how a
 * wait can detect a chain like `a/` -> `a/b/` -> `a/b/file` being created
 * without recursively watching the whole tree.
 */
async function nearestExistingDirectory(target: string): Promise<NearestDirectory | null> {
  let current = path.dirname(target)
  for (;;) {
    try {
      const stats = await fsp.stat(current)
      if (stats.isDirectory()) {
        const relative = path.relative(current, target)
        const [interest] = relative.split(path.sep)
        if (!interest || interest === "..") return null
        return { directory: current, interest }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOTDIR") return null
    }
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

class NativeFileWatch implements FileWatch {
  private readonly target: string
  private readonly remote: (directory: string) => Promise<boolean>
  private readonly waiters = new Set<Waiter>()
  private armed: ArmedWatcher | null = null
  private armedDirectory: string | null = null
  private armedInterest: string | null = null
  private pending = false
  private closed = false
  private broken = false

  constructor(target: string, remote: (directory: string) => Promise<boolean>) {
    this.target = target
    this.remote = remote
  }

  async next(timeoutMs: number, signal?: AbortSignal): Promise<WatchOutcome> {
    if (this.closed) return "closed"
    if (signal?.aborted) return "aborted"
    if (this.pending) {
      this.pending = false
      return "event"
    }
    if (this.broken) return "closed"

    await this.rearm()
    if (this.closed) return "closed"
    if (this.broken) return "closed"
    if (signal?.aborted) return "aborted"
    if (this.pending) {
      this.pending = false
      return "event"
    }

    return new Promise<WatchOutcome>((resolve) => {
      const waiter: Waiter = {
        resolve,
        signal,
        timer: setTimeout(() => {
          this.waiters.delete(waiter)
          this.detachAbort(waiter)
          resolve("timeout")
        }, Math.max(1, timeoutMs)),
      }
      if (signal) {
        waiter.onAbort = () => {
          this.waiters.delete(waiter)
          clearTimeout(waiter.timer)
          resolve("aborted")
        }
        signal.addEventListener("abort", waiter.onAbort, { once: true })
      }
      this.waiters.add(waiter)
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.disarm()
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer)
      this.detachAbort(waiter)
      waiter.resolve("closed")
    }
    this.waiters.clear()
  }

  private notify(): void {
    if (this.closed) return
    if (this.waiters.size === 0) {
      this.pending = true
      return
    }
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer)
      this.detachAbort(waiter)
      waiter.resolve("event")
    }
    this.waiters.clear()
  }

  private fail(): void {
    if (this.closed || this.broken) return
    this.broken = true
    this.disarm()
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer)
      this.detachAbort(waiter)
      waiter.resolve("closed")
    }
    this.waiters.clear()
  }

  private detachAbort(waiter: Waiter): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort)
    }
    waiter.onAbort = undefined
  }

  private async rearm(): Promise<void> {
    const nearest = await nearestExistingDirectory(this.target)
    if (!nearest) {
      this.fail()
      return
    }
    if (
      this.armed &&
      this.armedDirectory === nearest.directory &&
      this.armedInterest === nearest.interest
    ) {
      return
    }

    this.disarm()
    let remote = false
    try {
      remote = await this.remote(nearest.directory)
    } catch {
      remote = true
    }
    if (remote) {
      this.fail()
      return
    }

    try {
      const watcher = fs.watch(nearest.directory, { persistent: false }, (_event, filename) => {
        // A null filename means the platform did not tell us which entry
        // changed. Treat it as relevant rather than risk missing the event.
        if (filename !== null && filename !== undefined) {
          if (String(filename) !== nearest.interest) return
        }
        this.notify()
      })
      const onFailure = () => this.fail()
      watcher.once("error", onFailure)
      watcher.once("close", onFailure)
      this.armed = {
        watcher,
        dispose: () => {
          watcher.off("error", onFailure)
          watcher.off("close", onFailure)
          try {
            watcher.close()
          } catch {}
        },
      }
      this.armedDirectory = nearest.directory
      this.armedInterest = nearest.interest
    } catch {
      this.fail()
    }
  }

  private disarm(): void {
    this.armed?.dispose()
    this.armed = null
    this.armedDirectory = null
    this.armedInterest = null
  }
}

/**
 * Create a native watcher for a file condition. Returns null when the path is
 * on a known remote filesystem or no existing ancestor can be watched; the
 * caller must then use polling.
 *
 * The watcher is deliberately a hint source: every event still triggers a full
 * condition check, and the wait loop keeps a reconciliation poll so remote
 * mounts, missed inotify events, watcher errors, and atomic renames cannot make
 * the wait hang forever.
 */
export async function createFileWatch(
  target: string,
  options: FileWatchOptions = {},
): Promise<FileWatch | null> {
  const nearest = await nearestExistingDirectory(target)
  if (!nearest) return null
  const remote = options.remote ?? isRemoteDirectory
  try {
    if (await remote(nearest.directory)) return null
  } catch {
    return null
  }
  return new NativeFileWatch(target, remote)
}
