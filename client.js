window.__ModuleLoader__.load({
  id: '@local/dsh-plugin-test-button',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // 只在“创造模式”（cordis 预设）的会话里出现；预设未知时保守显示，避免误藏。
    const ALLOWED_PRESETS = ['cordis', '创造']

    const ICON = h(
      'svg',
      {
        width: 13,
        height: 13,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('path', { d: 'M9 3h6' }),
      h('path', { d: 'M10 3v5.4a2 2 0 0 1-.3 1L6.7 15a3 3 0 0 0 2.5 4.6h5.6A3 3 0 0 0 17.3 15l-3-5.6a2 2 0 0 1-.3-1V3' }),
      h('path', { d: 'M7.4 13.4h9.2' }),
    )

    return {
      inject: ['slots'],
      apply(ctx) {
        const getSessions = () => {
          try {
            if (typeof ctx.get === 'function') return ctx.get('sessions')
          } catch {
            /* optional service */
          }
          return ctx.sessions
        }

        function bindingOf(sessionId) {
          const sessions = getSessions()
          if (!sessions || !sessionId || typeof sessions.binding !== 'function') return undefined
          try {
            return sessions.binding(sessionId)
          } catch {
            return undefined
          }
        }

        // 首选：Session projection `agentPreset`（Host 用会话头 + agent-preset/selected 事件维护）
        function presetFace(sessionId) {
          const binding = bindingOf(sessionId)
          const session = binding && binding.session
          const projections = session && session.projections
          if (!projections || typeof projections.faceOf !== 'function') return undefined
          try {
            return projections.faceOf('agentPreset')
          } catch {
            return undefined
          }
        }

        // 退路：直接从会话事件流里找最后一条 agent-preset/selected
        function eventPreset(sessionId) {
          const binding = bindingOf(sessionId)
          const source = binding && binding.eventSource
          if (!source || typeof source.getSnapshot !== 'function') return undefined
          let snapshot
          try {
            snapshot = source.getSnapshot()
          } catch {
            return undefined
          }
          const entries = snapshot && snapshot.entries
          if (!Array.isArray(entries)) return undefined
          let preset
          for (const entry of entries) {
            if (!entry || entry.type !== 'event') continue
            const event = entry.event
            if (event && event.type === 'agent-preset/selected' && event.data && typeof event.data.agentPreset === 'string') {
              preset = event.data.agentPreset
            }
          }
          return preset
        }

        function currentPreset(sessionId) {
          const face = presetFace(sessionId)
          if (face && typeof face.getSnapshot === 'function') {
            try {
              const value = face.getSnapshot()
              if (typeof value === 'string' && value.length > 0) return value
            } catch {
              /* ignore */
            }
          }
          return eventPreset(sessionId)
        }

        function isAllowed(preset) {
          if (preset === undefined) return false
          return ALLOWED_PRESETS.some((allowed) => preset === allowed)
        }

        // 读当前会话的 preset：绑定可能比组件挂载稍晚就绪，先吃一轮重试；拿到后订阅变化（切 preset 实时跟随）
        function usePreset(sessionId) {
          const [state, setState] = React.useState({ known: false, preset: undefined })
          React.useEffect(() => {
            let cancelled = false
            let timer = 0
            const adopt = (value) => {
              if (cancelled || value === undefined) return false
              setState((current) => (current.preset === value ? current : { known: true, preset: value }))
              return true
            }
            const settleUnknown = () => {
              setState((current) => (current.known ? current : { known: true, preset: undefined }))
            }
            if (!adopt(currentPreset(sessionId))) {
              let attempt = 0
              const tick = () => {
                if (cancelled) return
                if (adopt(currentPreset(sessionId))) return
                attempt += 1
                if (attempt >= 10) {
                  settleUnknown()
                  return
                }
                timer = window.setTimeout(tick, 300)
              }
              tick()
            }
            const subscriptions = []
            const listen = (source) => {
              if (!source || typeof source.subscribe !== 'function') return
              try {
                const off = source.subscribe(() => {
                  adopt(currentPreset(sessionId))
                })
                if (typeof off === 'function') subscriptions.push(off)
              } catch {
                /* ignore */
              }
            }
            listen(presetFace(sessionId))
            const binding = bindingOf(sessionId)
            listen(binding && binding.eventSource)
            return () => {
              cancelled = true
              if (timer) window.clearTimeout(timer)
              for (const off of subscriptions) off()
            }
          }, [sessionId])
          return state
        }

        async function sendTestCommand(props) {
          const sessionId = props && props.sessionId
          const sessions = getSessions()
          if (sessions && sessionId && typeof sessions.binding === 'function') {
            let binding
            try {
              binding = sessions.binding(sessionId)
            } catch {
              binding = undefined
            }
            const session = binding && binding.session
            if (session && typeof session.command === 'function') {
              const result = await session.command('/plugin-test')
              return !!(result && result.ok)
            }
          }
          // 退路：把命令写进草稿并提交
          const actions = props && props.inputActions
          if (actions && typeof actions.setDraft === 'function' && typeof actions.submit === 'function') {
            actions.setDraft('/plugin-test')
            window.setTimeout(() => {
              try {
                actions.submit()
              } catch {
                /* ignore */
              }
            }, 60)
            return true
          }
          return false
        }

        function TestPluginButton(props) {
          const [phase, setPhase] = React.useState('idle')
          const [hovered, setHovered] = React.useState(false)
          const sessionId = props && props.sessionId
          const presetState = usePreset(sessionId)

          const onClick = React.useCallback(async () => {
            setPhase((current) => (current === 'busy' ? current : 'busy'))
            let ok = false
            try {
              ok = await sendTestCommand(props)
            } catch {
              ok = false
            }
            setPhase(ok ? 'sent' : 'failed')
            window.setTimeout(() => setPhase('idle'), 1600)
          }, [props])

          if (presetState.known && !isAllowed(presetState.preset)) return null

          const label =
            phase === 'busy' ? '测试中…' : phase === 'sent' ? '已自检' : phase === 'failed' ? '未触发' : '测试插件'

          return h(
            'button',
            {
              type: 'button',
              title: '自检当前正在开发的插件（执行 /plugin-test：结构 + 语法 + 装载 + 运行测试）',
              'aria-label': '测试插件',
              'data-phase': phase,
              disabled: phase === 'busy',
              onClick,
              onMouseEnter: () => setHovered(true),
              onMouseLeave: () => setHovered(false),
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                height: 26,
                padding: '0 9px',
                marginInlineStart: 2,
                borderRadius: 999,
                border: '1px solid transparent',
                background: hovered ? 'rgba(127,127,127,0.20)' : 'transparent',
                color: 'inherit',
                font: 'inherit',
                fontSize: 12,
                lineHeight: 1,
                letterSpacing: 0,
                whiteSpace: 'nowrap',
                cursor: phase === 'busy' ? 'progress' : 'pointer',
                opacity: phase === 'busy' ? 0.65 : 0.95,
                transition: 'background 120ms ease, opacity 120ms ease',
                WebkitAppRegion: 'no-drag',
              },
            },
            ICON,
            h('span', null, label),
          )
        }

        ctx.slots.inject('conversation.session.header.actions', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.actions',
              id: 'plugin-test-button',
              order: 0,
              label: '测试插件',
            },
            TestPluginButton,
          ),
        )
      },
    }
  },
})
