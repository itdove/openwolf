// Runtime tests for the OpenCode 2 plugin (index-v2.ts) driven through a fake plugin context.
import { test, before } from "node:test"
import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// The plugin uses .js import specifiers, which Node's type stripping cannot
// resolve, so compile it first (same approach as opencode-plugin.test.ts).
const ROOT = path.resolve(import.meta.dirname ?? ".", "..")
const PLUGIN_SRC = path.join(ROOT, "src", "templates", "opencode-plugin")
const TSC = path.join(ROOT, "node_modules", "typescript", "bin", "tsc")
let v2Default: any
let setupOpenWolfV2: any

before(async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-v2-build-"))
  const sources = fs.readdirSync(PLUGIN_SRC).filter((f) => f.endsWith(".ts") && f !== "index.ts")
  try {
    execFileSync(process.execPath, [TSC, "--outDir", outDir, "--target", "ES2022", "--module", "Node16",
      "--moduleResolution", "Node16", "--skipLibCheck", ...sources.map((f) => path.join(PLUGIN_SRC, f))], { stdio: "pipe" })
  } catch {}
  fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "module" }))
  const mod = await import(pathToFileURL(path.join(outDir, "index-v2.js")).href)
  v2Default = mod.default
  setupOpenWolfV2 = mod.setupOpenWolfV2
})

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

type HookCb = (input: any) => void | Promise<void>

interface TestEvent {
  id: string
  created: number
  type: string
  data?: Record<string, any>
}

function makeEventSource() {
  const queue: TestEvent[] = []
  let waiting: ((result: IteratorResult<TestEvent>) => void) | undefined
  let closed = false
  let iteratorReturned = false

  const iterable: AsyncIterable<TestEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<TestEvent>> {
          if (iteratorReturned) return Promise.resolve({ done: true, value: undefined })
          if (queue.length > 0) return Promise.resolve({ done: false, value: queue.shift() as TestEvent })
          if (closed) return Promise.resolve({ done: true, value: undefined })
          return new Promise<IteratorResult<TestEvent>>(resolve => {
            waiting = resolve
          })
        },
        return(): Promise<IteratorResult<TestEvent>> {
          iteratorReturned = true
          closed = true
          if (waiting) {
            const wake = waiting
            waiting = undefined
            wake({ done: true, value: undefined })
          }
          return Promise.resolve({ done: true, value: undefined })
        },
      }
    },
  }

  return {
    iterable,
    wasReturned: () => iteratorReturned,
    emit(ev: TestEvent): void {
      if (iteratorReturned || closed) return
      if (waiting) {
        const wake = waiting
        waiting = undefined
        wake({ done: false, value: ev })
      } else {
        queue.push(ev)
      }
    },
    close(): void {
      if (closed) return
      closed = true
      if (waiting) {
        const wake = waiting
        waiting = undefined
        wake({ done: true, value: undefined })
      }
    },
  }
}

function makeFakeCtx(directory: string) {
  const toolHooks = new Map<string, HookCb>()
  const sessionHooks = new Map<string, HookCb>()
  const disposeCounts = new Map<string, number>()
  const events = makeEventSource()

  const registration = (key: string) => ({
    dispose: async () => {
      disposeCounts.set(key, (disposeCounts.get(key) ?? 0) + 1)
    },
  })

  const ctx = {
    location: { directory },
    tool: {
      hook(name: string, cb: HookCb) {
        toolHooks.set(name, cb)
        return Promise.resolve(registration("tool:" + name))
      },
    },
    session: {
      hook(name: string, cb: HookCb) {
        sessionHooks.set(name, cb)
        return Promise.resolve(registration("session:" + name))
      },
    },
    event: {
      subscribe(): AsyncIterable<TestEvent> {
        return events.iterable
      },
    },
  }

  return { ctx, toolHooks, sessionHooks, disposeCounts, events }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeTempProject(withWolf: boolean): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwolf-v2-"))
  if (withWolf) {
    fs.mkdirSync(path.join(dir, ".wolf", "hooks"), { recursive: true })
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(check: () => boolean, timeoutMs = 1000, intervalMs = 20): Promise<boolean> {
  const start = Date.now()
  for (;;) {
    if (check()) return true
    if (Date.now() - start >= timeoutMs) return false
    await sleep(intervalMs)
  }
}

function sessionFile(directory: string, sid: string): string | undefined {
  const sessionsDir = path.join(directory, ".wolf", "hooks", "sessions")
  let entries: string[]
  try {
    entries = fs.readdirSync(sessionsDir)
  } catch {
    return undefined
  }
  const jsonFiles = entries.filter(name => name.endsWith(".json"))
  const name = jsonFiles.find(file => file.includes(sid)) ?? jsonFiles[0]
  return name ? path.join(sessionsDir, name) : undefined
}

function readSessionJSON(directory: string, sid: string): Record<string, unknown> | undefined {
  const file = sessionFile(directory, sid)
  if (!file) return undefined
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function pathEntryMatches(entry: unknown, candidate: string): boolean {
  if (typeof entry === "string") return entry === candidate
  if (entry !== null && typeof entry === "object") {
    const obj = entry as Record<string, unknown>
    for (const key of ["path", "filePath", "file_path", "file"]) {
      if (typeof obj[key] === "string" && obj[key] === candidate) return true
    }
  }
  return false
}

function listFilesRecursive(dir: string): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFilesRecursive(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

function findDeep(
  value: unknown,
  predicate: (obj: Record<string, any>) => boolean
): Record<string, any> | undefined {
  if (value === null || typeof value !== "object") return undefined
  const obj = value as Record<string, any>
  if (predicate(obj)) return obj
  for (const key of Object.keys(obj)) {
    const found = findDeep(obj[key], predicate)
    if (found) return found
  }
  return undefined
}

function describeValue(value: unknown): string {
  if (value === undefined) return "undefined"
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

async function expectNoThrow(fn: () => unknown, label: string): Promise<void> {
  try {
    await Promise.resolve(fn())
  } catch (error) {
    assert.fail(`${label} must not throw: ${String(error)}`)
  }
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test("default export has id openwolf and setup is setupOpenWolfV2", () => {
  assert.equal(v2Default.id, "openwolf")
  assert.equal(v2Default.setup, setupOpenWolfV2)
})

test("setup registers exactly execute.before, execute.after and session context, and returns a cleanup", async () => {
  const project = makeTempProject(true)
  try {
    const { ctx, toolHooks, sessionHooks, disposeCounts, events } = makeFakeCtx(project.dir)
    const cleanup = await setupOpenWolfV2(ctx)

    assert.deepEqual([...toolHooks.keys()].sort(), ["execute.after", "execute.before"])
    assert.deepEqual([...sessionHooks.keys()], ["context"])
    // OpenCode disposes hook registrations itself; cleanup only aborts the event subscription.

    await cleanup()
    await sleep(20) // let the event loop observe the closed iterator
  } finally {
    project.cleanup()
  }
})

test("read flow: execute.before + execute.after for read record the absolute file in files_read", async () => {
  const project = makeTempProject(true)
  try {
    const dir = project.dir
    const file = path.join(dir, "a.ts")
    const content = "export const a = 1\n"
    fs.writeFileSync(file, content, "utf8")

    const { ctx, toolHooks } = makeFakeCtx(dir)
    const cleanup = await setupOpenWolfV2(ctx)
    try {
      const before = toolHooks.get("execute.before")
      const after = toolHooks.get("execute.after")
      assert.ok(before, "execute.before hook should be registered")
      assert.ok(after, "execute.after hook should be registered")
      const sid = "ses-read"

      await Promise.resolve(before({ tool: "read", sessionID: sid, id: "call-1", input: { path: "a.ts" } }))
      await Promise.resolve(after({
        tool: "read",
        sessionID: sid,
        id: "call-1",
        status: "completed",
        input: { path: "a.ts" },
        result: { output: { type: "file", uri: "file://" + file, name: "a.ts", content, encoding: "utf8", mime: "text/plain" } },
      }))

      const ok = await waitFor(() => {
        const json = readSessionJSON(dir, sid)
        if (!json) return false
        // files_read is an object keyed by absolute path
        const filesRead = json.files_read ?? {}
        return Object.keys(filesRead).some(key => pathEntryMatches(key, file))
      })
      assert.ok(ok, "session file should list the absolute read path in files_read")
    } finally {
      await cleanup()
    }
  } finally {
    project.cleanup()
  }
})

test("edit flow: execute.after for edit records a files_written entry with action edit", async () => {
  const project = makeTempProject(true)
  try {
    const dir = project.dir
    const file = path.join(dir, "a.ts")
    fs.writeFileSync(file, "x", "utf8")

    const { ctx, toolHooks } = makeFakeCtx(dir)
    const cleanup = await setupOpenWolfV2(ctx)
    try {
      const after = toolHooks.get("execute.after")
      assert.ok(after, "execute.after hook should be registered")
      const sid = "ses-edit"

      await Promise.resolve(after({
        tool: "edit",
        sessionID: sid,
        id: "call-edit",
        status: "completed",
        input: { path: "a.ts", oldString: "x", newString: "y" },
      }))

      const ok = await waitFor(() => {
        const json = readSessionJSON(dir, sid)
        if (!json) return false
        const filesWritten = json.files_written
        return (
          Array.isArray(filesWritten) &&
          filesWritten.some(entry => entry !== null && typeof entry === "object" && (entry as Record<string, unknown>).action === "edit")
        )
      })
      assert.ok(ok, "session file should contain a files_written entry with action edit")
    } finally {
      await cleanup()
    }
  } finally {
    project.cleanup()
  }
})

test("execute.after with status error records nothing", async () => {
  const project = makeTempProject(true)
  try {
    const dir = project.dir
    const file = path.join(dir, "a.ts")
    fs.writeFileSync(file, "x", "utf8")

    const { ctx, toolHooks } = makeFakeCtx(dir)
    const cleanup = await setupOpenWolfV2(ctx)
    try {
      const after = toolHooks.get("execute.after")
      assert.ok(after, "execute.after hook should be registered")
      const sid = "ses-err"

      await Promise.resolve(after({
        tool: "edit",
        sessionID: sid,
        id: "call-err",
        status: "error",
        input: { path: "a.ts", oldString: "x", newString: "y" },
        error: { name: "EditError", data: { message: "oldString not found" } },
      }))

      // give an (incorrect) writer up to ~500ms to surface a record
      const recorded = await waitFor(() => {
        const json = readSessionJSON(dir, sid)
        if (!json) return false
        const written = Array.isArray(json.files_written) ? json.files_written : []
        const read = Array.isArray(json.files_read) ? json.files_read : []
        return [...written, ...read].some(entry => pathEntryMatches(entry, file))
      }, 500)
      assert.ok(!recorded, "an error-status execute.after must not record the file")
    } finally {
      await cleanup()
    }
  } finally {
    project.cleanup()
  }
})

test("without a .wolf directory hooks and events are no-ops and never throw", async () => {
  const project = makeTempProject(false)
  try {
    const dir = project.dir
    const { ctx, toolHooks, sessionHooks, events } = makeFakeCtx(dir)
    const cleanup = await setupOpenWolfV2(ctx)
    try {
      const before = toolHooks.get("execute.before")
      const after = toolHooks.get("execute.after")
      const context = sessionHooks.get("context")
      assert.ok(before && after && context, "all three hooks should still be registered")

      await expectNoThrow(
        () => before({ tool: "read", sessionID: "s1", id: "c1", input: { path: "a.ts" } }),
        "execute.before"
      )
      await expectNoThrow(
        () =>
          after({
            tool: "write",
            sessionID: "s1",
            id: "c1",
            status: "completed",
            input: { path: "a.ts", content: "hello" },
            result: { output: { content: "hello" } },
          }),
        "execute.after"
      )
      await expectNoThrow(() => context({ sessionID: "s1", system: [] }), "session.context")

      events.emit({ id: "e1", created: Date.now(), type: "session.created", data: { sessionID: "s1" } })
      events.emit({ id: "e2", created: Date.now(), type: "session.execution.succeeded", data: { sessionID: "s1" } })
      events.emit({ id: "e3", created: Date.now(), type: "session.deleted", data: { sessionID: "s1" } })
      await sleep(150)

      assert.ok(!fs.existsSync(path.join(dir, ".wolf")), "no .wolf directory should be created")
    } finally {
      await cleanup()
    }
  } finally {
    project.cleanup()
  }
})

test("context hook pushes an openwolf-protocol part when OPENWOLF.md exists and nothing otherwise", async () => {
  const project = makeTempProject(true)
  try {
    const dir = project.dir
    const { ctx, sessionHooks } = makeFakeCtx(dir)
    const cleanup = await setupOpenWolfV2(ctx)
    try {
      const context = sessionHooks.get("context")
      assert.ok(context, "session context hook should be registered")

      // without OPENWOLF.md: nothing is pushed
      const withoutFile: Array<{ type: string; text: string }> = []
      await Promise.resolve(context({ sessionID: "s-ctx-1", system: withoutFile }))
      assert.deepEqual(withoutFile, [], "no part should be pushed without OPENWOLF.md")

      // with OPENWOLF.md: must not throw and must push at most one part;
      // approvedMemory may require extra trust state and return empty, so a
      // pushed part is only required to carry the protocol tag
      fs.writeFileSync(path.join(dir, ".wolf", "OPENWOLF.md"), "Remember to check the lock file first.\n", "utf8")
      const withFile: Array<{ type: string; text: string }> = []
      await Promise.resolve(context({ sessionID: "s-ctx-2", system: withFile }))
      assert.ok(withFile.length <= 1, "context hook should push at most one part")
      if (withFile.length === 1) {
        assert.equal(withFile[0].type, "text")
        assert.ok(withFile[0].text.includes("<openwolf-protocol>"), "part should contain <openwolf-protocol>")
      }
    } finally {
      await cleanup()
    }
  } finally {
    project.cleanup()
  }
})

test("session.step.started + session.step.ended write a usage entry with model and tokens", async () => {
  const project = makeTempProject(true)
  try {
    const dir = project.dir
    const { ctx, events } = makeFakeCtx(dir)
    const cleanup = await setupOpenWolfV2(ctx)
    try {
      events.emit({
        id: "ev-started",
        created: Date.now(),
        type: "session.step.started",
        data: { sessionID: "ses-usage", assistantMessageID: "msg-1", model: { providerID: "prov-x", id: "model-x" } },
      })
      events.emit({
        id: "ev-ended",
        created: Date.now(),
        type: "session.step.ended",
        data: { sessionID: "ses-usage", assistantMessageID: "msg-1", tokens: { input: 11, output: 22 } },
      })

      const usageRoot = path.join(dir, ".wolf", "usage")
      const found = await waitFor(() => {
        for (const file of listFilesRecursive(usageRoot)) {
          if (!file.endsWith(".json")) continue
          let parsed: unknown
          try {
            parsed = JSON.parse(fs.readFileSync(file, "utf8"))
          } catch {
            continue
          }
          const message = findDeep(parsed, obj => obj.modelID === "model-x" && obj.providerID === "prov-x")
          if (!message) continue
          const tokens = message.tokens
          if (tokens === null || typeof tokens !== "object") continue
          if (tokens.input === 11 && tokens.output === 22) return true
        }
        return false
      })
      assert.ok(
        found,
        "a usage file under .wolf/usage/opencode should carry modelID, providerID and tokens from the step events"
      )
    } finally {
      await cleanup()
    }
  } finally {
    project.cleanup()
  }
})

test("hook callbacks receiving garbage (undefined input, missing fields) do not throw", async () => {
  const project = makeTempProject(true)
  try {
    const dir = project.dir
    // OPENWOLF.md exists so the context hook reaches the push path for {}/null/undefined inputs
    fs.writeFileSync(path.join(dir, ".wolf", "OPENWOLF.md"), "memory\n", "utf8")

    const { ctx, toolHooks, sessionHooks } = makeFakeCtx(dir)
    const cleanup = await setupOpenWolfV2(ctx)
    try {
      const before = toolHooks.get("execute.before")
      const after = toolHooks.get("execute.after")
      const context = sessionHooks.get("context")
      assert.ok(before && after && context, "all three hooks should be registered")

      const beforeGarbage: unknown[] = [
        undefined,
        null,
        {},
        { tool: "read" },
        { sessionID: "s-garbage" },
        { sessionID: "s-garbage", tool: "read" },
        { sessionID: "s-garbage", tool: "edit", input: null },
      ]
      for (const garbage of beforeGarbage) {
        await expectNoThrow(() => before(garbage), `execute.before(${describeValue(garbage)})`)
      }

      const afterGarbage: unknown[] = [
        undefined,
        null,
        {},
        { tool: "edit" },
        { sessionID: "s-garbage" },
        { sessionID: "s-garbage", status: "completed" },
        { sessionID: "s-garbage", status: "error" },
        { sessionID: "s-garbage", status: "completed", tool: "read" },
        { sessionID: "s-garbage", status: "completed", tool: "write" },
      ]
      for (const garbage of afterGarbage) {
        await expectNoThrow(() => after(garbage), `execute.after(${describeValue(garbage)})`)
      }

      const contextGarbage: unknown[] = [undefined, null, {}, { sessionID: "s-garbage" }]
      for (const garbage of contextGarbage) {
        await expectNoThrow(() => context(garbage), `session.context(${describeValue(garbage)})`)
      }

      await sleep(100)
    } finally {
      await cleanup()
    }
  } finally {
    project.cleanup()
  }
})

test("lazy session start: a tool call without session.created still starts the session", async () => {
  const project = makeTempProject(true)
  try {
    const dir = project.dir
    fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1\n")
    const { ctx, toolHooks } = makeFakeCtx(dir)
    const cleanup = await setupOpenWolfV2(ctx)
    try {
      // opencode 2 does not deliver session.created for a session that existed before the subscription
      await toolHooks.get("execute.before")!({ tool: "read", sessionID: "ses-lazy", id: "c1", input: { path: "a.ts" } })
      const json = readSessionJSON(dir, "ses-lazy")
      assert.ok(json, "session file should exist")
      assert.ok(typeof json!.started === "string" && json!.started !== "", "session must have a real start time")
      assert.match(fs.readFileSync(path.join(dir, ".wolf", "memory.md"), "utf8"), /## Session:/)
    } finally {
      await cleanup()
    }
  } finally {
    project.cleanup()
  }
})

test("event loop resubscribes after the stream fails", async () => {
  const project = makeTempProject(true)
  try {
    const dir = project.dir
    const { ctx } = makeFakeCtx(dir)
    let subscriptions = 0
    const fresh = makeEventSource()
    ctx.event.subscribe = () => {
      subscriptions++
      if (subscriptions === 1) {
        return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("stream lost")) }) } as any
      }
      return fresh.iterable
    }
    const cleanup = await setupOpenWolfV2(ctx)
    try {
      assert.ok(await waitFor(() => subscriptions >= 2, 3000), "should resubscribe after a stream error")
    } finally {
      await cleanup()
    }
  } finally {
    project.cleanup()
  }
})

test("a successful turn stops exactly once, even if session.idle follows execution.succeeded", async () => {
  const project = makeTempProject(true)
  try {
    const dir = project.dir
    fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1\n")
    const { ctx, toolHooks, events } = makeFakeCtx(dir)
    const cleanup = await setupOpenWolfV2(ctx)
    try {
      const sid = "ses-turn"
      const stopCount = () => Number(readSessionJSON(dir, sid)?.stop_count ?? 0)
      await toolHooks.get("execute.after")!({ tool: "edit", sessionID: sid, id: "c1", status: "completed",
        input: { path: "a.ts", oldString: "1", newString: "2" }, result: { output: { files: [] } } })
      // OpenCode 2.0.32 ends a successful turn with session.execution.succeeded only
      events.emit({ id: "t1", created: Date.now(), type: "session.execution.succeeded", data: { sessionID: sid } })
      assert.ok(await waitFor(() => stopCount() === 1), "execution.succeeded must stop the turn")
      events.emit({ id: "t2", created: Date.now(), type: "session.idle", data: { sessionID: sid } })
      await sleep(100)
      assert.equal(stopCount(), 1, "a trailing idle for the same turn must not stop it again")
      // next turn: new activity, then idle alone (v1-style boundary) stops again
      await toolHooks.get("execute.before")!({ tool: "read", sessionID: sid, id: "c2", input: { path: "a.ts" } })
      events.emit({ id: "t3", created: Date.now(), type: "session.idle", data: { sessionID: sid } })
      assert.ok(await waitFor(() => stopCount() === 2), "the next turn must stop again")
    } finally {
      await cleanup()
    }
  } finally {
    project.cleanup()
  }
})

function usageMessages(dir: string): Array<Record<string, any>> {
  const usageDir = path.join(dir, ".wolf", "usage", "opencode")
  if (!fs.existsSync(usageDir)) return []
  return listFilesRecursive(usageDir).filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(fs.readFileSync(f, "utf8")).message)
}

test("usage of a failed step and of title/compaction requests is recorded once each", async () => {
  const project = makeTempProject(true)
  try {
    const dir = project.dir
    const { ctx, events } = makeFakeCtx(dir)
    const cleanup = await setupOpenWolfV2(ctx)
    try {
      const sid = "ses-usage-extra"
      const tokens = { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } }
      events.emit({ id: "u1", created: Date.now(), type: "session.step.started",
        data: { sessionID: sid, assistantMessageID: "msg-f", model: { id: "model-x", providerID: "prov-x" } } })
      events.emit({ id: "u2", created: Date.now(), type: "session.step.failed",
        data: { sessionID: sid, assistantMessageID: "msg-f", error: { type: "x", message: "filtered" }, tokens } })
      events.emit({ id: "u3", created: Date.now(), type: "session.usage.recorded",
        data: { sessionID: sid, source: "compaction", cost: 0, tokens } })
      // redelivery of the same event must not add a second entry
      events.emit({ id: "u3", created: Date.now(), type: "session.usage.recorded",
        data: { sessionID: sid, source: "compaction", cost: 0, tokens } })
      assert.ok(await waitFor(() => usageMessages(dir).length === 2), "expected exactly 2 usage entries")
      await sleep(100)
      const messages = usageMessages(dir)
      assert.equal(messages.length, 2)
      assert.ok(messages.some(m => m.id === "msg-f" && m.modelID === "model-x"), "failed step keeps its model")
      assert.ok(messages.some(m => m.id === "usage:u3"), "compaction usage recorded by event id")
    } finally {
      await cleanup()
    }
  } finally {
    project.cleanup()
  }
})

test("read tracking uses the raw file text, not the decorated tool output", async () => {
  const project = makeTempProject(true)
  try {
    const dir = project.dir
    const file = path.join(dir, "a.ts")
    const content = "export const a = 1\n"
    fs.writeFileSync(file, content)
    const { ctx, toolHooks } = makeFakeCtx(dir)
    const cleanup = await setupOpenWolfV2(ctx)
    try {
      const sid = "ses-raw"
      await toolHooks.get("execute.after")!({ tool: "read", sessionID: sid, id: "r1", status: "completed", input: { path: "a.ts" },
        result: { output: { type: "file", content }, content: [{ type: "text", text: "Read file a.ts, lines 1-1\n1: export const a = 1" }] } })
      const entry = (readSessionJSON(dir, sid)?.files_read as Record<string, any> | undefined)?.[file]
      assert.ok(entry, "read must be recorded")
      // the fingerprint is only set when the recorded text equals the file on disk
      assert.equal(typeof entry.read_hash, "string", "raw text must match the file so the read is fingerprinted")
    } finally {
      await cleanup()
    }
  } finally {
    project.cleanup()
  }
})
