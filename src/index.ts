/**
 * Model-facing `local_model` tool and human-facing `/local-model` command over
 * local inference servers declared in plugin configuration, spawned through
 * `ctx.subprocess`.
 *
 * The plugin owns no model routing. A server it starts serves whatever protocol
 * its own configuration makes it serve; reaching that server from a model
 * request stays the job of an LLM adapter route (for example an
 * `@deepseek-ai/dsh-llm-pi-ai` provider whose `baseURL` is the server's port),
 * and `refs` reports the `provider/model` spelling a caller selects there.
 *
 * Both surfaces drive one server table and one set of owned process handles: an
 * agent calls the tool when a conversation asks for it, and a person types the
 * command when no model turn should mediate the start. The command registers
 * only where a composition mounts the `commands` service, so headless
 * compositions keep the tool alone.
 * @module dsh-tool-local-model
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-local-model'
export const inject = ['tools', 'subprocess']

/** HTTP path answering with the served model list on an OpenAI-compatible server. */
const DEFAULT_MODELS_PATH = '/v1/models'
/** Readiness budget when a cold start is not overridden by configuration. */
const DEFAULT_START_TIMEOUT_MS = 900_000
/** Budget for one HTTP readiness probe. */
const DEFAULT_PROBE_TIMEOUT_MS = 5_000
/** TERM-to-KILL grace for a server this plugin terminates. */
const KILL_GRACE_MS = 5_000
/** Readiness poll interval. */
const POLL_INTERVAL_MS = 500
/** Command grammar echoed when a `/local-model` invocation does not parse. */
const COMMAND_USAGE =
  'Usage: /local-model [status | list | start [server|all] | stop [server|all] | toggle [server] | diag <text>]'
/** Stand-in server name meaning every configured server. */
const ALL_SERVERS = 'all'
/** Append-only record of client-half reports, for diagnosing a client that renders nothing. */
const DIAG_LOG_PATH = join(homedir(), '.dsh', 'local-model', 'client-diag.log')


/**
 * One local inference server: how to start it and how to tell it is answering.
 *
 * `command`, `args`, and `cwd` are passed to the subprocess provider without
 * shell interpretation, so a deployment that needs a shell spells it out in
 * `command`/`args` itself.
 */
export interface LocalServerConfig {
  /** Executable name or absolute path, resolved by the subprocess provider. */
  command: string
  /** Arguments passed verbatim to the executable. */
  args?: string[]
  /** Working directory for the child process. */
  cwd: string
  /** Extra environment entries merged onto the provider's scrubbed ambient environment. */
  env?: Record<string, string>
  /** TCP port the server listens on. */
  port: number
  /** Route name used in `provider/model` references; defaults to the server's config key. */
  provider?: string
  /** HTTP path answering with the model list; defaults to `/v1/models`. */
  modelsPath?: string
  /** Readiness budget for this server, overriding the plugin-level budget (ms). */
  startTimeoutMs?: number
}

/** Plugin configuration: the local servers this composition may start. */
export interface Config {
  /** Servers by stable name. An empty table leaves the tool with nothing to start. */
  servers?: Record<string, LocalServerConfig>
  /** Readiness budget for one `start` call (ms). */
  startTimeoutMs?: number
  /** Budget for one HTTP readiness probe (ms). */
  probeTimeoutMs?: number
  /** Server the bare `toggle` acts on; defaults to the first configured server. */
  default?: string
  /**
   * Keep at most one server answering: starting one stops the others this plugin
   * owns. Defaults to true, because two local engines usually compete for the
   * same device memory.
   */
  exclusive?: boolean
}

export const Config: z<Config> = z.object({
  servers: z
    .dict(
      z.object({
        command: z.string().required(),
        args: z.array(String).default([]),
        cwd: z.string().required(),
        env: z.dict(String).default({}),
        port: z.number().min(1).max(65_535).required(),
        provider: z.string(),
        modelsPath: z.string().default(DEFAULT_MODELS_PATH),
        startTimeoutMs: z.number().min(1),
      }),
    )
    .default({}),
  startTimeoutMs: z.number().min(1).default(DEFAULT_START_TIMEOUT_MS),
  probeTimeoutMs: z.number().min(1).default(DEFAULT_PROBE_TIMEOUT_MS),
  default: z.string(),
  exclusive: z.boolean().default(true),
})

/** One server as this plugin currently observes it. */
export interface ServerStatus {
  /** Config key the caller names the server by. */
  name: string
  /** Whether the server answered its model listing. */
  running: boolean
  /** TCP port the server listens on. */
  port: number
  /** Model ids the server reports, empty while it is not answering. */
  models: string[]
  /** `provider/model` references a caller selects on an LLM adapter route. */
  refs: string[]
}

/** Tool result shared by every action. */
export interface LocalModelResult {
  /** Action this result answers. */
  action: 'list' | 'status' | 'start' | 'stop' | 'toggle'
  /** Observed servers, one entry per requested name. */
  servers: ServerStatus[]
}

const SERVER_STATUS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    running: { type: 'boolean', required: true },
    port: { type: 'integer', required: true },
    models: { type: 'array', required: true, items: { type: 'string' } },
    refs: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

/** Serve one line per server, naming the model references the caller can select. */
function describe(result: LocalModelResult): string {
  if (result.servers.length === 0) return 'No local server is configured.'
  const lines = result.servers.map((server) => {
    if (!server.running) return `${server.name}: not answering on port ${server.port}`
    const refs = server.refs.length === 0 ? '(no models reported)' : server.refs.join(', ')
    return `${server.name}: answering on port ${server.port} - ${refs}`
  })
  return lines.join('\n')
}

/** Refuse a start whose directory or port cannot produce a listener. */
function assertStartable(serverName: string, server: LocalServerConfig): void {
  if (server.cwd.length === 0) throw new Error(`local server "${serverName}" declares no cwd`)
  if (server.port < 1 || server.port > 65_535) {
    throw new Error(`local server "${serverName}" declares an out-of-range port ${server.port}`)
  }
}

/** Read the model ids out of an OpenAI-compatible or Ollama-shaped model listing. */
async function readModels(url: string, timeoutMs: number): Promise<string[]> {
  let body: unknown
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return []
    body = await response.json()
  } catch {
    // Not answering yet: readiness is the answer, not a failure to report.
    return []
  }
  if (typeof body !== 'object' || body === null) return []
  const listing = body as { data?: unknown; models?: unknown }
  const entries = Array.isArray(listing.data) ? listing.data : Array.isArray(listing.models) ? listing.models : []
  const ids: string[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const { id, name } = entry as { id?: unknown; name?: unknown }
    const value = typeof id === 'string' ? id : typeof name === 'string' ? name : undefined
    if (value !== undefined) ids.push(value)
  }
  return ids
}

/** Wait one poll interval without blocking the event loop. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Register the `local_model` tool over the configured local servers.
 * @param ctx - Cordis context providing the tools registry and subprocess provider.
 * @param config - server table and readiness budgets.
 */
export function apply(ctx: Context, config: Config): void {
  const servers = config.servers ?? {}
  const startTimeoutMs = config.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
  const probeTimeoutMs = config.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const owned = new Map<string, SubprocessHandle>()
  const exclusive = config.exclusive ?? true

  const modelsUrl = (server: LocalServerConfig): string =>
    `http://127.0.0.1:${server.port}${server.modelsPath ?? DEFAULT_MODELS_PATH}`

  const resolve = (serverName: string): LocalServerConfig => {
    const server = servers[serverName]
    if (server === undefined) {
      const known = Object.keys(servers)
      throw new Error(
        `unknown local server "${serverName}"; configured: ${known.length === 0 ? '(none)' : known.join(', ')}`,
      )
    }
    return server
  }

  const snapshot = async (serverName: string, server: LocalServerConfig): Promise<ServerStatus> => {
    const models = await readModels(modelsUrl(server), probeTimeoutMs)
    const route = server.provider ?? serverName
    const status: ServerStatus = {
      name: serverName,
      running: models.length > 0,
      port: server.port,
      models,
      refs: models.map(model => `${route}/${model}`),
    }
    return status
  }

  const allSnapshots = async (onlyRunning: boolean): Promise<ServerStatus[]> => {
    const statuses: ServerStatus[] = []
    for (const serverName of Object.keys(servers)) {
      const server = servers[serverName]
      if (server === undefined) continue
      const status = await snapshot(serverName, server)
      if (onlyRunning && !status.running) continue
      statuses.push(status)
    }
    return statuses
  }

  const defaultServer = (): string => {
    const configured = config.default
    if (configured !== undefined && configured.length > 0) {
      resolve(configured)
      return configured
    }
    const first = Object.keys(servers)[0]
    if (first === undefined) throw new Error('No local server is configured.')
    return first
  }

  const startServer = async (serverName: string): Promise<ServerStatus> => {
    const server = resolve(serverName)
    assertStartable(serverName, server)
    const before = await snapshot(serverName, server)
    await stopSiblings(serverName)
    if (before.running) return before

    const handle = ctx.subprocess.spawn({
      argv: [server.command, ...(server.args ?? [])],
      cwd: server.cwd,
      env: server.env ?? {},
      stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
      graceMs: KILL_GRACE_MS,
    })
    owned.set(serverName, handle)

    const budget = server.startTimeoutMs ?? startTimeoutMs
    const deadline = Date.now() + budget
    while (Date.now() < deadline) {
      const status = await snapshot(serverName, server)
      if (status.running) return status
      await pause(POLL_INTERVAL_MS)
    }
    handle.terminate()
    owned.delete(serverName)
    throw new Error(
      `local server "${serverName}" did not answer ${modelsUrl(server)} within ${budget}ms; it was terminated`,
    )
  }

  const stopServer = async (serverName: string): Promise<ServerStatus> => {
    const server = resolve(serverName)
    const handle = owned.get(serverName)
    if (handle === undefined) {
      const status = await snapshot(serverName, server)
      if (status.running) {
        throw new Error(
          `local server "${serverName}" is answering on port ${server.port} but this plugin did not start it; stop it where it was started`,
        )
      }
      return status
    }
    handle.terminate()
    await handle.done
    owned.delete(serverName)
    return snapshot(serverName, server)
  }

  /** Stop every other server this plugin owns, so only one engine stays resident. */
  const stopSiblings = async (keep: string): Promise<void> => {
    if (!exclusive) return
    for (const other of [...owned.keys()]) {
      if (other === keep) continue
      try {
        await stopServer(other)
      } catch {
        // A sibling that refuses to stop must not block the server that was asked for.
      }
    }
  }

  const startMany = async (serverNames: string[]): Promise<{ statuses: ServerStatus[]; failures: string[] }> => {
    const statuses: ServerStatus[] = []
    const failures: string[] = []
    for (const serverName of serverNames) {
      try {
        statuses.push(await startServer(serverName))
      } catch (error: unknown) {
        failures.push(error instanceof Error ? error.message : String(error))
        statuses.push(await snapshot(serverName, resolve(serverName)))
      }
    }
    return { statuses, failures }
  }

  const stopMany = async (serverNames: string[]): Promise<{ statuses: ServerStatus[]; failures: string[] }> => {
    const statuses: ServerStatus[] = []
    const failures: string[] = []
    for (const serverName of serverNames) {
      try {
        statuses.push(await stopServer(serverName))
      } catch (error: unknown) {
        failures.push(error instanceof Error ? error.message : String(error))
        statuses.push(await snapshot(serverName, resolve(serverName)))
      }
    }
    return { statuses, failures }
  }

  /** Expand a command target: a server name, `all`, or the default server when omitted. */
  const targetsOf = (target: string | undefined): string[] => {
    if (target === undefined || target.length === 0) return [defaultServer()]
    if (target === ALL_SERVERS) return Object.keys(servers)
    resolve(target)
    return [target]
  }

  /** Flip one server: start it when it is down, stop it when it answers. */
  const toggle = async (target?: string): Promise<{ statuses: ServerStatus[]; failures: string[] }> => {
    if (target === ALL_SERVERS) {
      const running = (await allSnapshots(true)).map(status => status.name)
      return running.length > 0 ? stopMany(running) : startMany(Object.keys(servers))
    }
    const serverName = target === undefined || target.length === 0 ? defaultServer() : target
    const server = resolve(serverName)
    const status = await snapshot(serverName, server)
    if (status.running) return { statuses: [await stopServer(serverName)], failures: [] }
    return startMany([serverName])
  }

  const report = (action: LocalModelResult['action'], outcome: { statuses: ServerStatus[]; failures: string[] }): string => {
    const text = describe({ action, servers: outcome.statuses })
    return outcome.failures.length === 0 ? text : `${text}\n${outcome.failures.join('\n')}`
  }

  /** Append one client-half report to the diagnostic log. */
  const recordDiag = (text: string): string => {
    try {
      mkdirSync(join(homedir(), '.dsh', 'local-model'), { recursive: true })
      appendFileSync(DIAG_LOG_PATH, `${new Date().toISOString()} ${text}\n`, 'utf8')
    } catch (error: unknown) {
      return `diag write failed: ${error instanceof Error ? error.message : String(error)}`
    }
    return `diag recorded: ${text}`
  }

  ctx.tools.register(
    defineTool({
      name: 'local_model',
      description:
        'Start, stop, toggle, or inspect local inference servers configured for this composition. `start` waits until the server answers its model listing, so a cold start is one call, and starting one server stops the others this plugin owns so only one engine stays resident. `server` accepts one configured name or "all"; `toggle` without a name flips only the configured default server. `list` reports only servers that are answering; `status` reports every configured server. Result `refs` give the provider/model reference to select on the model route that fronts that server.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'status', 'start', 'stop', 'toggle'],
          description: 'list | status | start | stop | toggle',
        },
        server: {
          type: 'string',
          description: `Configured server name, or "${ALL_SERVERS}". Required for start and stop; optional for toggle, which defaults to the configured default server.`,
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', required: true, enum: ['list', 'status', 'start', 'stop', 'toggle'] },
            servers: { type: 'array', required: true, items: SERVER_STATUS },
          },
        },
        render: (_args, value) => [{ type: 'text', text: describe(value) }],
      },
      isConcurrencySafe: args => args.action === 'list' || args.action === 'status',
      async execute(args) {
        const action = args.action
        if (action === 'list') return { action, servers: await allSnapshots(true) }
        if (action === 'status') return { action, servers: await allSnapshots(false) }
        if (action === 'toggle') return { action, servers: (await toggle(args.server)).statuses }

        const serverName = args.server
        if (serverName === undefined || serverName.length === 0) {
          const known = Object.keys(servers).join(', ') || '(none)'
          throw new Error(`local_model ${action} requires a server name; configured: ${known}`)
        }
        const targets = targetsOf(serverName)
        const statuses: ServerStatus[] = []
        for (const target of targets) {
          const status = action === 'start' ? await startServer(target) : await stopServer(target)
          statuses.push(status)
        }
        return { action, servers: statuses }
      },
    }),
  )

  const runCommand = async (invocation: CommandInvocation): Promise<CommandResult> => {
    const trimmed = invocation.rawInput.trim()
    const tokens = trimmed.length === 0 ? [] : trimmed.split(/\s+/)
    const [verb, target, ...rest] = tokens
    try {
      if (verb === undefined || verb === 'status' || verb === 'list') {
        const action = verb === 'list' ? 'list' : 'status'
        return { kind: 'success', text: describe({ action, servers: await allSnapshots(action === 'list') }) }
      }
      if (verb === 'toggle') {
        return { kind: 'success', text: report('toggle', await toggle(target)) }
      }
      if (verb === 'diag') {
        const text = [target, ...rest].filter(part => part !== undefined && part.length > 0).join(' ')
        if (text.length === 0) return { kind: 'error', text: COMMAND_USAGE }
        return { kind: 'success', text: recordDiag(text) }
      }
      if (verb !== 'start' && verb !== 'stop') return { kind: 'error', text: COMMAND_USAGE }
      const targets = targetsOf(target)
      if (targets.length === 0) return { kind: 'success', text: 'No local server is configured.' }
      const outcome = verb === 'start' ? await startMany(targets) : await stopMany(targets)
      return { kind: 'success', text: report(verb, outcome) }
    } catch (error: unknown) {
      return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
    }
  }

  ctx.inject(['commands'], (commandCtx: Context) => {
    commandCtx.effect(() =>
      commandCtx.commands.register({
        name: 'local-model',
        description: 'Start, stop, toggle, or inspect the local inference servers this composition declares',
        input: { hint: `status | list | start [server|${ALL_SERVERS}] | stop [server|${ALL_SERVERS}] | toggle [server]`, attachments: false },
        handler: runCommand,
      }),
    )
  })

  ctx.effect(() => () => {
    for (const handle of owned.values()) handle.terminate()
    owned.clear()
  })
}
