import { afterEach, describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { WorkspaceServer } from "../../src/control-plane/workspace-server/server"
import { Log } from "../../src/util/log"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await resetDatabase()
})

Log.init({ print: false })

async function read(res: Response) {
  return await new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).text()
}

describe("server compression", () => {
  test("compresses json responses on both server entry points", async () => {
    // Use real session routes so the middleware is exercised in the same way as production.
    await using tmp = await tmpdir({ git: true })
    const headers = {
      "accept-encoding": "gzip",
      "x-opencode-directory": tmp.path,
    }

    const app = Server.createApp({})
    const web = await app.request("/session", {
      headers,
    })

    expect(web.status).toBe(200)
    expect(web.headers.get("content-encoding")).toBe("gzip")
    expect(await read(web)).toBeString()

    const workspace = await WorkspaceServer.App().request("/session", {
      headers: {
        ...headers,
        "x-opencode-workspace": "wrk_test_workspace",
      },
    })

    expect(workspace.status).toBe(200)
    expect(workspace.headers.get("content-encoding")).toBe("gzip")
    expect(await read(workspace)).toBeString()
  })

  test("keeps sse responses uncompressed on both server entry points", async () => {
    // Streaming event routes must stay uncompressed so events can flush promptly.
    await using tmp = await tmpdir({ git: true })
    const stop = new AbortController()
    try {
      const app = Server.createApp({})
      const web = await app.request("/event", {
        signal: stop.signal,
        headers: {
          "accept-encoding": "gzip",
          "x-opencode-directory": tmp.path,
        },
      })

      expect(web.status).toBe(200)
      expect(web.headers.get("content-encoding")).toBeNull()
      await web.body?.cancel()

      const workspace = await WorkspaceServer.App().request("/event", {
        signal: stop.signal,
        headers: {
          "accept-encoding": "gzip",
          "x-opencode-directory": tmp.path,
          "x-opencode-workspace": "wrk_test_workspace",
        },
      })

      expect(workspace.status).toBe(200)
      expect(workspace.headers.get("content-encoding")).toBeNull()
      await workspace.body?.cancel()
    } finally {
      stop.abort()
    }
  })
})
