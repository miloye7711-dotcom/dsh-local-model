/**
 * Client half of `dsh-tool-local-model`: two compact chips in the composer dock
 * (a toggle plus a menu) and a toggle hotkey, both driving the host's
 * `/local-model` command.
 *
 * The bundle loads through the host module table, so `react` and the client
 * context services arrive as `require` and `ctx` respectively. Every step of
 * loading writes to `localStorage` under `TRACE_KEY`, because a client package
 * that loads but renders nothing leaves no other trace a host-side process can
 * read; `/local-model diag` forwards the same text to the host log.
 *
 * The chips stay in `conversation.composer.dock` rather than the header: the
 * dock row is the one place the composer already reserves for plugin entries,
 * the chips are small enough not to crowd its neighbours, and the host prints
 * the full report into the transcript anyway.
 */
window.__ModuleLoader__.load({
  id: 'dsh-tool-local-model',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var el = React.createElement

    var TRACE_KEY = 'dsh-tool-local-model:trace'
    var REF = /([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.:-]+)/g

    /** Append one loading or rendering step to the on-disk client trace. */
    function trace(step, detail) {
      try {
        var raw = window.localStorage.getItem(TRACE_KEY)
        var list = raw === null ? [] : JSON.parse(raw)
        if (!Array.isArray(list)) list = []
        list.push({ at: new Date().toISOString(), step: step, detail: detail === undefined ? null : String(detail) })
        if (list.length > 40) list = list.slice(list.length - 40)
        window.localStorage.setItem(TRACE_KEY, JSON.stringify(list))
      } catch {
        // A storage-denied renderer must not break the plugin itself.
      }
    }

    /** Read the `provider/model` references out of a status report. */
    function refsOf(text) {
      if (typeof text !== 'string') return []
      var seen = {}
      var refs = []
      REF.lastIndex = 0
      var match = REF.exec(text)
      while (match !== null) {
        var id = match[1] + '/' + match[2]
        if (!seen[id]) {
          seen[id] = true
          refs.push({ provider: match[1], model: match[2], id: id })
        }
        match = REF.exec(text)
      }
      REF.lastIndex = 0
      return refs
    }

    /** Read the per-server lines out of a status report. */
    function serversOf(text) {
      if (typeof text !== 'string') return []
      var out = []
      var lines = text.split('\n')
      for (var i = 0; i < lines.length; i += 1) {
        var match = /^([A-Za-z0-9_.-]+): (answering|not answering) on port (\d+)/.exec(lines[i].trim())
        if (match !== null) out.push({ name: match[1], running: match[2] === 'answering', port: Number(match[3]) })
      }
      return out
    }

    /** Normalize a host RPC answer into rendered text. */
    function outcomeOf(response) {
      var value = response && response.value
      var result = value && value.result
      var text = result && typeof result.text === 'string' ? result.text : ''
      var failed = !response || response.ok === false || (result !== undefined && result !== null && result.kind === 'error')
      return { failed: failed, text: text }
    }

    var ROW = { position: 'relative', display: 'inline-flex', alignItems: 'center', gap: '2px', minWidth: '0' }

    var CHIP = {
      font: 'inherit',
      fontSize: '11px',
      lineHeight: '1.1',
      height: '22px',
      padding: '0 8px',
      borderRadius: '999px',
      border: '1px solid transparent',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      flex: '0 0 auto',
      opacity: '0.8',
    }

    var CARET = {
      font: 'inherit',
      fontSize: '10px',
      lineHeight: '1.1',
      height: '22px',
      width: '18px',
      padding: '0',
      borderRadius: '6px',
      border: '1px solid transparent',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      flex: '0 0 auto',
      opacity: '0.7',
    }

    var PANEL = {
      position: 'absolute',
      bottom: '22px',
      right: '0',
      zIndex: '40',
      width: '272px',
      boxSizing: 'border-box',
      padding: '8px',
      borderRadius: '10px',
      border: '1px solid rgba(127,127,127,0.35)',
      background: 'Canvas',
      color: 'CanvasText',
      boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
      fontSize: '11px',
      lineHeight: '1.4',
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
    }

    var PANEL_ROW = { display: 'flex', flexWrap: 'wrap', gap: '4px' }

    var PANEL_BUTTON = {
      font: 'inherit',
      fontSize: '11px',
      height: '20px',
      padding: '0 8px',
      borderRadius: '999px',
      border: '1px solid rgba(127,127,127,0.4)',
      background: 'rgba(127,127,127,0.10)',
      color: 'inherit',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }

    var PANEL_NOTE = {
      opacity: '0.75',
      maxHeight: '120px',
      overflowY: 'auto',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    }

    /** Header control: one chip toggling the engine, one caret opening the menu. */
    function LocalModelDock(props) {
      var api = props && props.api ? props.api : {}
      var pair = React.useState(null)
      var state = pair[0]
      var setState = pair[1]
      var openPair = React.useState(false)
      var open = openPair[0]
      var setOpen = openPair[1]
      var rootPair = React.useState(null)
      var root = rootPair[0]
      var setRoot = rootPair[1]

      React.useEffect(function () {
        trace('dock-rendered', api.sessionId)
      }, [])

      React.useEffect(function () {
        if (!open) return undefined
        function onPointerDown(event) {
          if (root !== null && event.target instanceof Node && root.contains(event.target)) return
          setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        return function () {
          document.removeEventListener('pointerdown', onPointerDown, true)
        }
      }, [open, root])

      function run(line) {
        setState({ phase: 'busy', text: '正在执行 ' + line + ' …', refs: [] })
        Promise.resolve()
          .then(function () {
            return api.run(line)
          })
          .then(function (response) {
            var outcome = outcomeOf(response)
            setState({
              phase: outcome.failed ? 'error' : 'done',
              text: outcome.text || (outcome.failed ? '主机拒绝了这次请求' : '完成'),
              refs: outcome.failed ? [] : refsOf(outcome.text),
              servers: outcome.failed ? [] : serversOf(outcome.text),
            })
          }, function (error) {
            setState({ phase: 'error', text: '执行失败：' + String((error && error.message) || error), refs: [] })
          })
      }

      function select(ref) {
        setState({ phase: 'busy', text: '切换到 ' + ref.id + ' …', refs: [] })
        Promise.resolve()
          .then(function () {
            return api.select(ref.provider, ref.model)
          })
          .then(function (response) {
            var outcome = outcomeOf(response)
            setState({
              phase: outcome.failed ? 'error' : 'done',
              text: outcome.failed ? '切换失败：' + (outcome.text || '主机拒绝了这次选择') : '已切换到 ' + ref.id,
              refs: outcome.failed ? [ref] : [],
            })
          }, function (error) {
            setState({ phase: 'error', text: '切换失败：' + String((error && error.message) || error), refs: [ref] })
          })
      }

      var busy = state !== null && state.phase === 'busy'
      var engines = state !== null && Array.isArray(state.servers) ? state.servers : []
      var children = [
        el('button', {
          key: 'toggle',
          type: 'button',
          style: CHIP,
          disabled: busy,
          title: '启动或停止默认本地引擎（Ctrl+Shift+L）',
          onClick: function () { run('/local-model toggle') },
        }, busy ? '本地模型…' : '本地模型'),
        el('button', {
          key: 'caret',
          type: 'button',
          style: CARET,
          disabled: busy,
          'aria-expanded': open ? 'true' : 'false',
          title: '本地模型菜单：状态、启停与切换模型',
          onClick: function () { setOpen(!open) },
        }, '▾'),
      ]

      if (open) {
        var panel = [
          el('div', { key: 'actions', style: PANEL_ROW }, [
            el('button', { key: 'status', type: 'button', style: PANEL_BUTTON, disabled: busy, onClick: function () { run('/local-model status') } }, '状态'),
          ]),
        ]
        if (engines.length > 0) {
          panel.push(el('div', { key: 'engines', style: PANEL_ROW }, engines.map(function (engine) {
            return el('button', {
              key: 'engine-' + engine.name,
              type: 'button',
              style: PANEL_BUTTON,
              disabled: busy,
              title: (engine.running ? '停止 ' : '启动 ') + engine.name + '（另一台会先停下）',
              onClick: function () { run('/local-model toggle ' + engine.name) },
            }, (engine.running ? '● ' : '○ ') + engine.name)
          })))
        }
        if (state !== null && state.refs.length > 0) {
          panel.push(el('div', { key: 'refs', style: PANEL_ROW }, state.refs.map(function (ref) {
            return el('button', {
              key: 'use-' + ref.id,
              type: 'button',
              style: PANEL_BUTTON,
              disabled: busy,
              title: '把本会话切到 ' + ref.id,
              onClick: function () { select(ref) },
            }, '用 ' + ref.id)
          })))
        }
        if (state !== null && state.text) panel.push(el('div', { key: 'note', style: PANEL_NOTE }, state.text))
        children.push(el('div', { key: 'panel', style: PANEL, role: 'menu' }, panel))
      }

      return el('div', { ref: setRoot, style: ROW, 'data-local-model': 'dock' }, children)
    }

    /** Keyboard defaults: the same chord on every profile that admits it. Linux Web admits no letter chord, so it stays unbound there. */
    var SHORTCUT_DEFAULTS = {
      'desktop:windows': { code: 'KeyL', modifiers: ['primary', 'shift'] },
      'web:windows': { code: 'KeyL', modifiers: ['primary', 'shift'] },
      'desktop:macos': { code: 'KeyL', modifiers: ['primary', 'shift'] },
      'web:macos': { code: 'KeyL', modifiers: ['primary', 'shift'] },
    }

    /**
     * Seat the header control and the toggle shortcut on a client context.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      trace('apply', ctx === undefined ? 'no-ctx' : 'ctx')
      var lastSessionId

      /** Run one host command line for the session the header last reported. */
      function execute(line) {
        var remote = ctx.remote
        if (lastSessionId === undefined) return Promise.reject(new Error('还没有打开的会话'))
        if (!remote || !remote.commands) return Promise.reject(new Error('主机命令服务不可用'))
        return remote.commands.execute(lastSessionId, line, [])
      }

      try {
        ctx.inject(['shortcuts'], function (scoped) {
          trace('shortcuts-injected')
          var off
          try {
            off = scoped.shortcuts.register({
              id: 'local-model.toggle',
              label: function () { return '启动/停止本地模型' },
              defaults: SHORTCUT_DEFAULTS,
              regions: ['page', 'editable'],
              resolve: function () {
                return {
                  status: 'handled',
                  run: function () {
                    trace('shortcut-fired', lastSessionId)
                    execute('/local-model toggle').catch(function (error) {
                      trace('shortcut-failed', (error && error.message) || error)
                    })
                  },
                }
              },
            })
            trace('shortcut-registered', typeof off)
          } catch (error) {
            trace('shortcut-register-failed', (error && error.message) || String(error))
          }
          if (typeof off === 'function') ctx.effect(function () { return off }, 'local-model: toggle shortcut')
        })
      } catch (error) {
        trace('shortcuts-failed', (error && error.message) || error)
      }

      if (!ctx.slots) {
        trace('slots-missing')
        return
      }
      try {
        ctx.slots.inject('conversation.composer.dock', function () {
          trace('dock-slot-available')
          ctx.effect(function () {
            return ctx.slots.register({
              name: 'conversation.composer.dock',
              id: 'local-model',
              order: 10,
              label: function () { return '本地模型' },
              inject: function (sessionId) {
                lastSessionId = sessionId
                var remote = ctx.remote
                return {
                  api: {
                    sessionId: sessionId,
                    run: function (line) {
                      if (!remote || !remote.commands) throw new Error('主机命令服务不可用')
                      return remote.commands.execute(sessionId, line, [])
                    },
                    select: function (provider, model) {
                      var sessions = ctx.sessions
                      if (!sessions) throw new Error('主机会话服务不可用')
                      return sessions.selectModel({ sessionId: sessionId, provider: provider, model: model })
                    },
                  },
                }
              },
            }, LocalModelDock)
          }, 'local-model: dock control')
          trace('dock-registered')
        })
      } catch (error) {
        trace('dock-failed', (error && error.message) || error)
      }
    }

    exports.name = 'dsh-tool-local-model'
    exports.inject = ['slots', 'remote', 'remote.commands', 'sessions']
    exports.apply = apply
    trace('module-evaluated')
    return module.exports
  },
})
