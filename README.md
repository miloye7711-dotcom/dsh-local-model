# dsh-local-model

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that lets the model start, stop, and inspect local inference servers — Strata, Ollama, llama.cpp, or anything else that answers an OpenAI-compatible model listing.

The agent asks for a server by name and gets back `provider/model` references it can select on the model route that fronts that server. No shell script in the middle, no per-machine hardcoding in the plugin: the servers are deployment configuration.

```text
> 帮我把本地的 ollama 拉起来，用 qwen2.5:7b

local_model start ollama
→ ollama: answering on port 11434 - ollama-local/qwen2.5:7b
```

## Install

Not on npm yet. Vendor it into a harness checkout or link it from a profile:

```bash
git clone https://github.com/miloye7711-dotcom/dsh-local-model.git
cd dsh-local-model
pnpm install
pnpm run build
```

Then mount the built package by absolute path, or `pnpm link` it into the harness that will load it.

A `file:` dependency copies the package into the profile's `node_modules`; after editing sources, rebuild and copy `lib/` plus `client/` there again, or reinstall the profile.


## Configure

Declare the servers this composition may start. `command`, `args`, and `cwd` go to the subprocess provider verbatim — no shell, so anything shell-shaped has to be spelled out.

```yaml
- id: local-model
  name: 'dsh-tool-local-model'
  config:
    default: strata        # what the bare `toggle` and the composer chip act on
    exclusive: true        # starting one engine stops the others
    servers:
      ollama:
        command: 'ollama'
        args: ['serve']
        cwd: '%USERPROFILE%'
        port: 11434
        provider: 'ollama-local'

      strata:
        command: 'D:\Strata\.venv\Scripts\python.exe'
        args:
          - 'D:\Strata\serve\server.py'
          - '--engine'
          - 'strata'
          - '--config'
          - 'D:\Strata\strata-iq2_xs.json'
          - '--port'
          - '8080'
        cwd: 'D:\Strata'
        port: 8080
        provider: 'strata-local'

    startTimeoutMs: 900000   # cold start budget (default 15 min)
    probeTimeoutMs: 5000     # one readiness probe (default 5 s)
```

| Field | Meaning |
|---|---|
| `command` | executable name or absolute path |
| `args` | arguments, passed verbatim |
| `cwd` | working directory for the child process |
| `env` | extra environment entries, merged onto the provider's environment |
| `port` | the port the server listens on |
| `provider` | route name in `provider/model` refs; defaults to the config key |
| `modelsPath` | HTTP path answering the model list; defaults to `/v1/models` |

An empty `servers` table is valid: the tool is registered with nothing to start.

## Actions

| `action` | Behaviour |
|---|---|
| `list` | only servers that are answering |
| `status` | every configured server, answering or not |
| `start` | spawn if down, then wait until the model listing answers; idempotent when already up; terminates the child if the budget runs out; `server: "all"` starts every configured server |
| `stop` | terminate, wait for exit — only for servers **this plugin** started; `server: "all"` stops every server it owns |
| `toggle` | flip one server: stop it when it answers, start it when it is down; without a name it acts on `default` |

Starting a server stops the others this plugin owns, because `exclusive` defaults to true: two local engines usually compete for the same device memory. Set `exclusive: false` to keep several resident at once.

Readiness is one HTTP `GET <modelsPath>`: a server counts as up when it lists at least one model. That rule works for OpenAI-compatible servers and for Ollama-shaped listings (`data[].id` or `models[].name`).

## Slash command

`/local-model [status | list | start [server|all] | stop [server|all] | toggle [server] | diag <text>]` — the same actions from the composer. `diag` appends a timestamped line to `~/.dsh/local-model/client-diag.log`.

## Composer control and shortcut

The client half registers two 11px chips in `conversation.composer.dock`: `本地模型` toggles the `default` server only, `▾` opens a 272px panel with `状态`, one `● name` / `○ name` chip per configured server, one `用 <provider/model>` button per advertised ref, and the last result text. The panel only exists while open, so the dock row keeps its normal width; status text also lands in the transcript through the host command output.

`Ctrl+Shift+L` (`Cmd+Shift+L` on macOS) runs the same toggle from anywhere in the page. Defaults are bound per platform profile in `SHORTCUT_DEFAULTS`, so rebinding goes through the harness shortcut settings.

## What this plugin does not do

It owns process lifecycle, not routing. To actually send a model request to a server it started, add an LLM adapter route whose `baseURL` is that server's port — for example an `@deepseek-ai/dsh-llm-pi-ai` provider:

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      ollama-local:
        api: openai-completions
        baseURL: http://127.0.0.1:11434/v1
        headers: { Authorization: 'Bearer ollama' }   # placeholder: keyless server
        models:
          - id: qwen2.5:7b
            name: 'Qwen2.5 7B (Ollama)'
            contextWindow: 32768
            maxTokens: 8192
```

`refs` in the result gives exactly the `provider/model` spelling to select there.

## Design notes

- **No new capability seam.** This is a Consumer over the existing `subprocess` capability; a second service definition would have no second consumer.
- **Termination is process-tree-wide**, because it goes through the same subprocess provider the rest of the harness uses — a killed server leaves no orphan worker processes.
- **No KV-cache churn.** The tool description and parameter schema are fixed text; nothing here changes between turns.
- **Ownership is enforced, not assumed.** `stop` refuses a server that answers on the port but was started elsewhere, rather than killing a process the plugin did not create.

## Development

```bash
pnpm install
pnpm run typecheck   # strict, no emit
pnpm test            # 7 tests over a real ToolRuntime
pnpm run build       # lib/ + declarations
```

The subprocess provider is faked in tests at the seam's shape, so the shipping plugin body runs unmodified against a real `ToolRuntime` and a real HTTP listener.

## License

MIT
