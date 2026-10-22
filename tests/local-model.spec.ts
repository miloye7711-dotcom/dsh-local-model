import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

import * as tool from '../src/index.ts'

const testToolSignal = new AbortController().signal
const cleanup: (() => Promise<void>)[] = []

/** Answer the model listing `local_model` reads, and nothing else. */
const listingHandler = (models: string[]) => (request: IncomingMessage, response: ServerResponse): void => {
  if (request.url !== '/v1/models') {
    response.statusCode = 404
    response.end()
    return
  }
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ object: 'list', data: models.map(id => ({ id, object: 'model' })) }))
}

/** Create a listing server without awaiting the bind; `close` awaits it first. */
function openListing(models: string[], port = 0): { server: Server; close: () => Promise<void> } {
  const server = createServer(listingHandler(models))
  const listening = new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', resolve)
  })
  return {
    server,
    close: async () => {
      await listening
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    },
  }
}

/** Await one listing's bind and return its port, registering its teardown. */
async function serveListing(models: string[], port = 0): Promise<number> {
  const listing = openListing(models, port)
  await new Promise<void>((resolve) => {
    listing.server.once('listening', resolve)
  })
  cleanup.push(listing.close)
  return (listing.server.address() as AddressInfo).port
}

/** A port no longer bound: probing it is refused, so the server reads as down. */
async function releasedPort(): Promise<number> {
  const listing = openListing([])
  await new Promise<void>((resolve) => {
    listing.server.once('listening', resolve)
  })
  const port = (listing.server.address() as AddressInfo).port
  await listing.close()
  return port
}

/**
 * Stand-in subprocess provider returning a handle shaped like the seam's, so
 * the shipping plugin body runs unmodified against a real `ToolRuntime`.
 * `onSpawn` lets a test bring a server up at the moment the plugin spawns it.
 */
class FakeSubprocess extends Service {
  readonly specs: SubprocessSpawnSpec[] = []
  onSpawn: ((spec: SubprocessSpawnSpec) => void) | undefined

  constructor(ctx: Context) {
    super(ctx, 'subprocess')
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(spec)
    this.onSpawn?.(spec)
    let settle: () => void = () => {}
    const done = new Promise<{ exitCode: number | null; signal: null }>((resolve) => {
      settle = () => {
        resolve({ exitCode: 0, signal: null })
      }
    })
    return {
      pid: 4242,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: {},
      done,
      terminate: () => {
        settle()
      },
      waitForExit: () => done.then(() => undefined),
    } as unknown as SubprocessHandle
  }
}

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

async function setup(config: tool.Config): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FakeSubprocess)
  await ctx.plugin(tool, config)
  return ctx
}

function callLocalModel(ctx: Context, args: unknown) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${Math.random().toString(16).slice(2)}`),
    name: 'local_model',
    arguments: args,
  })
}

function body(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

function errorMessage(result: { isError?: boolean; error?: { message?: string } }): string {
  return result.error?.message ?? ''
}

describe('dsh-tool-local-model', () => {
  it('refuses a server name the composition does not declare', async () => {
    const ctx = await setup({ servers: {} })
    expect(errorMessage(await callLocalModel(ctx, { action: 'start', server: 'missing' }))).toMatch(/unknown local server/)
  })

  it('requires a server name for start', async () => {
    const ctx = await setup({ servers: {} })
    expect(errorMessage(await callLocalModel(ctx, { action: 'start' }))).toMatch(/requires a server name/)
  })

  it('reports an answering server with provider-qualified refs', async () => {
    const port = await serveListing(['qwen3.8-flash-next-iq2_xs'])
    const ctx = await setup({ servers: { strata: { command: 'strata', cwd: process.cwd(), port, provider: 'strata-local' } } })

    expect(body(await callLocalModel(ctx, { action: 'status' }))).toContain('strata-local/qwen3.8-flash-next-iq2_xs')
  })

  it('starts through the subprocess seam and reports the served models', async () => {
    const port = await releasedPort()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const provider = new FakeSubprocess(ctx)
    provider.onSpawn = () => {
      cleanup.push(openListing(['qwen2.5:7b'], port).close)
    }
    await ctx.plugin(tool, {
      servers: { ollama: { command: 'ollama', args: ['serve'], cwd: process.cwd(), port } },
      startTimeoutMs: 15_000,
    })

    expect(body(await callLocalModel(ctx, { action: 'start', server: 'ollama' }))).toContain('ollama/qwen2.5:7b')
    expect(provider.specs).toHaveLength(1)
    expect(provider.specs[0]?.argv).toEqual(['ollama', 'serve'])
  })

  it('does not spawn a server that already answers', async () => {
    const port = await serveListing(['qwen2.5:7b'])
    const ctx = await setup({ servers: { ollama: { command: 'ollama', args: ['serve'], cwd: process.cwd(), port } } })

    await callLocalModel(ctx, { action: 'start', server: 'ollama' })
    expect((ctx.get('subprocess') as unknown as FakeSubprocess).specs).toHaveLength(0)
  })

  it('lists only servers that answer', async () => {
    const port = await serveListing(['qwen2.5:7b'])
    const dark = await releasedPort()
    const ctx = await setup({
      servers: {
        live: { command: 'a', cwd: process.cwd(), port },
        dark: { command: 'b', cwd: process.cwd(), port: dark },
      },
    })

    const text = body(await callLocalModel(ctx, { action: 'list' }))
    expect(text).toContain('live:')
    expect(text).not.toContain('dark:')
  })

  it('refuses to stop a server it did not start', async () => {
    const port = await serveListing(['qwen2.5:7b'])
    const ctx = await setup({ servers: { external: { command: 'x', cwd: process.cwd(), port } } })

    expect(errorMessage(await callLocalModel(ctx, { action: 'stop', server: 'external' }))).toMatch(/did not start it/)
  })
})
