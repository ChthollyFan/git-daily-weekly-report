/**
 * git-daily-weekly-report — Client half（设置页「报告总结」）。
 *
 * 手写成 web shell 期望的浏览器模块加载器格式（window.__ModuleLoader__.load +
 * require），因此不需要任何构建步骤：package.json 的 dsh.client 指到这里，
 * 宿主装配时直接加载本文件。
 *
 * 只做一件事：在设置页注册一个独立导航项，表单读写 host 半提供的同源路由。
 * 真正的配置与技能注入都在 host 半（index.js + dsh/report-summary.js）。
 */
window.__ModuleLoader__.load({
  // 这个 id 是加载器的注册键，必须与 npm 包名完全一致：加载器按包名查找已注册的
  // 客户端模块，id 写成短名会让模块执行完却注册不上，宿主随即报
  // “loaded without registering”。
  id: '@chtholly-fan/git-daily-weekly-report',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    /** 与 host 半 index.js 的 API_PREFIX 必须一致 */
    const API = '/git-daily-weekly-report/api'

    /** 样式全部走 .gdr- 前缀，避免与其它插件的规则相互覆盖 */
    const CSS = `
.gdr-root { display:flex; flex-direction:column; gap:14px; padding:6px 2px 56px; max-width:880px;
  color:var(--dsw-alias-label-primary,#1f2329); font-size:13px; line-height:1.6; }
.gdr-h { margin:0; font-size:14px; font-weight:600; }
.gdr-sub { margin:3px 0 0; font-size:12px; color:var(--dsw-alias-label-secondary,#8a9099); }
.gdr-card { display:flex; flex-direction:column; gap:10px; padding:14px 15px; border-radius:12px;
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1)); background:var(--dsw-alias-bg-layer-1,#fff); }
.gdr-card-h { margin:0 0 2px; font-size:13px; font-weight:600; }
.gdr-field { display:flex; flex-direction:column; gap:4px; }
.gdr-label { font-size:12px; font-weight:500; display:flex; align-items:baseline; gap:6px; flex-wrap:wrap; }
.gdr-hint { font-style:normal; font-size:11px; font-weight:400; color:var(--dsw-alias-label-secondary,#8a9099); }
.gdr-input, .gdr-textarea, .gdr-select { width:100%; box-sizing:border-box; font-family:inherit; font-size:12px;
  color:inherit; padding:6px 9px; border-radius:8px;
  border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18));
  background:var(--dsw-alias-bg-layer-1,#fff); }
.gdr-textarea { min-height:72px; resize:vertical; line-height:1.55; }
.gdr-grid2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.gdr-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.gdr-btn { border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18));
  background:var(--dsw-alias-bg-layer-1,#fff); color:inherit; border-radius:8px;
  padding:5px 12px; font-size:12px; font-family:inherit; cursor:pointer; }
.gdr-btn:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05)); }
.gdr-btn:disabled { opacity:.5; cursor:not-allowed; }
/* 主按钮的前景色必须用 label-primary-foreground：brand-primary 在浅色下近黑、
   在深色下近白，写死 #fff 会在深色模式下变成白底白字。 */
.gdr-btn-primary { background:var(--dsw-alias-brand-primary,#3b6cff); border-color:transparent;
  color:var(--dsw-alias-label-primary-foreground,#fff); }
.gdr-status { font-size:12px; padding:7px 10px; border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1)); background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04)); }
.gdr-status-err { border-color:var(--dsw-alias-state-error-primary,#e5484d);
  color:var(--dsw-alias-state-error-primary,#c62a2f); }
.gdr-meta { font-size:11px; color:var(--dsw-alias-label-secondary,#8a9099); word-break:break-all; }
.gdr-meta b { font-weight:500; color:var(--dsw-alias-label-primary,#1f2329); }
`

    /**
     * @brief 克隆一份配置草稿，避免直接改动 snapshot 里的对象
     * @param config 规范化后的配置
     * @return 深一层的副本
     */
    function cloneConfig(config) {
      return {
        schemaVersion: config.schemaVersion,
        output: { ...config.output },
        writing: { ...config.writing },
        style: { ...config.style },
        fallback: { ...config.fallback },
        extraPrompt: config.extraPrompt,
      }
    }

    /**
     * @brief 调用 host 半的接口
     * @param method snapshot / save / reset
     * @param args 传给 host 的参数
     * @return 解析后的响应体
     * @note 非 2xx 或 ok:false 都抛错，由调用方统一显示到状态行
     */
    async function callApi(method, args) {
      const response = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, args }),
      })
      let data = null
      try {
        data = await response.json()
      } catch {
        throw new Error(`接口返回的不是 JSON（HTTP ${response.status}）`)
      }
      if (!response.ok || data.ok !== true) {
        throw new Error(data && data.message ? data.message : `HTTP ${response.status}`)
      }
      return data
    }

    /**
     * @brief 把草稿收敛成待提交的配置：全空白文本与空数字统一成 null（即沿用默认）
     * @param draft 表单草稿
     * @return 可交给 host 校验的对象
     */
    function buildPayload(draft) {
      const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value : null)
      return {
        schemaVersion: draft.schemaVersion,
        output: {
          dailyTitle: text(draft.output.dailyTitle),
          weeklyTitle: text(draft.output.weeklyTitle),
          numberingStyle: text(draft.output.numberingStyle),
          numberingContinuous: draft.output.numberingContinuous,
          blankLineBetweenItems: draft.output.blankLineBetweenItems,
        },
        writing: {
          rules: text(draft.writing.rules),
          dailyMin: draft.writing.dailyMin,
          dailyMax: draft.writing.dailyMax,
          weeklyMin: draft.writing.weeklyMin,
          weeklyMax: draft.writing.weeklyMax,
          verbFirst: draft.writing.verbFirst,
        },
        style: {
          rules: text(draft.style.rules),
          samples: text(draft.style.samples),
        },
        fallback: { strategy: text(draft.fallback.strategy) },
        extraPrompt: text(draft.extraPrompt),
      }
    }

    /**
     * @brief 三态布尔 → select 的字符串值
     * @param value null / true / false
     * @return 'inherit' / 'yes' / 'no'
     */
    function triToSelect(value) {
      if (value === null || value === undefined) return 'inherit'
      return value ? 'yes' : 'no'
    }

    /**
     * @brief select 的字符串值 → 三态布尔
     * @param raw 'inherit' / 'yes' / 'no'
     * @return null / true / false
     */
    function selectToTri(raw) {
      if (raw === 'yes') return true
      if (raw === 'no') return false
      return null
    }

    /**
     * @brief 单行/多行文本字段
     * @note placeholder 展示技能里的当前默认值，让“留空即沿用默认”可见
     */
    function TextField(props) {
      const Control = props.multiline ? 'textarea' : 'input'
      return h('label', { className: 'gdr-field' },
        h('span', { className: 'gdr-label' }, props.label,
          props.hint ? h('em', { className: 'gdr-hint' }, props.hint) : null),
        h(Control, {
          className: props.multiline ? 'gdr-textarea' : 'gdr-input',
          value: props.value ?? '',
          placeholder: props.placeholder ?? '',
          spellCheck: false,
          onChange: (event) => props.onChange(event.target.value),
        }))
    }

    /**
     * @brief 条数输入框，空串表示沿用默认
     */
    function CountField(props) {
      return h('label', { className: 'gdr-field' },
        h('span', { className: 'gdr-label' }, props.label,
          props.hint ? h('em', { className: 'gdr-hint' }, props.hint) : null),
        h('input', {
          className: 'gdr-input',
          type: 'number',
          min: 1,
          max: 20,
          value: props.value ?? '',
          placeholder: props.placeholder ?? '',
          onChange: (event) => {
            const raw = event.target.value
            if (raw === '') {
              props.onChange(null)
              return
            }
            const num = Number(raw)
            props.onChange(Number.isInteger(num) ? num : null)
          },
        }))
    }

    /**
     * @brief 三态开关：沿用默认 / 是 / 否
     */
    function TriField(props) {
      return h('label', { className: 'gdr-field' },
        h('span', { className: 'gdr-label' }, props.label,
          props.hint ? h('em', { className: 'gdr-hint' }, props.hint) : null),
        h('select', {
          className: 'gdr-select',
          value: triToSelect(props.value),
          onChange: (event) => props.onChange(selectToTri(event.target.value)),
        },
          h('option', { value: 'inherit' }, '沿用默认'),
          h('option', { value: 'yes' }, '是'),
          h('option', { value: 'no' }, '否')))
    }

    /**
     * @brief 设置页主体
     * @note 初始加载失败时保留错误提示，表单不渲染，避免用户对着空表单改名
     */
    function Panel() {
      const [snapshot, setSnapshot] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [status, setStatus] = React.useState({ kind: 'idle', text: '正在读取当前设置…' })

      // 把接口返回的快照装进 state 与草稿
      const adopt = React.useCallback((data) => {
        setSnapshot(data.snapshot)
        setDraft(cloneConfig(data.snapshot.config))
        const warnings = Array.isArray(data.snapshot.warnings) ? data.snapshot.warnings : []
        setStatus({
          kind: warnings.length > 0 ? 'err' : 'idle',
          text: warnings.length > 0 ? warnings.join('；') : '已载入当前设置',
        })
      }, [])

      const load = React.useCallback(async () => {
        setStatus({ kind: 'idle', text: '正在读取当前设置…' })
        try {
          adopt(await callApi('snapshot', null))
        } catch (error) {
          setStatus({ kind: 'err', text: `读取失败：${error.message}` })
        }
      }, [adopt])

      React.useEffect(() => {
        void load()
      }, [load])

      if (draft === null || snapshot === null) {
        return h('div', { className: 'gdr-root' },
          h('header', null,
            h('h3', { className: 'gdr-h' }, '报告总结'),
            h('p', { className: 'gdr-sub' }, '这里的设置只在 dsh 端生效，Codex 端仍使用技能目录里的默认内容。')),
          h('div', { className: 'gdr-status' + (status.kind === 'err' ? ' gdr-status-err' : '') }, status.text))
      }

      const setField = (group, key, value) => {
        setDraft((prev) => {
          const next = cloneConfig(prev)
          next[group][key] = value
          return next
        })
      }
      const setExtra = (value) => {
        setDraft((prev) => {
          const next = cloneConfig(prev)
          next.extraPrompt = value
          return next
        })
      }

      const run = async (method, args, okText) => {
        setBusy(true)
        setStatus({ kind: 'idle', text: '正在保存…' })
        try {
          const data = await callApi(method, args)
          adopt(data)
          setStatus({ kind: 'idle', text: data.message || okText })
        } catch (error) {
          setStatus({ kind: 'err', text: `操作失败：${error.message}` })
        } finally {
          setBusy(false)
        }
      }

      const defaults = snapshot.defaults ?? { output: {}, writing: {}, style: {}, fallback: {} }
      const orDefault = (value, fallback) => value ?? fallback ?? ''

      return h('div', { className: 'gdr-root' },
        h('header', null,
          h('h3', { className: 'gdr-h' }, '报告总结'),
          h('p', { className: 'gdr-sub' },
            '留空的字段表示沿用技能里的默认规则；填了才会覆盖。设置只在 dsh 端生效，Codex 端不受影响。')),

        h('div', { className: 'gdr-status' + (status.kind === 'err' ? ' gdr-status-err' : '') }, status.text),

        // 输出格式
        h('section', { className: 'gdr-card' },
          h('h4', { className: 'gdr-card-h' }, '输出格式'),
          h('div', { className: 'gdr-grid2' },
            h(TextField, {
              label: '日报标题', value: draft.output.dailyTitle,
              placeholder: '沿用默认：' + orDefault(defaults.output.dailyTitle, '—'),
              onChange: (value) => setField('output', 'dailyTitle', value),
            }),
            h(TextField, {
              label: '周报标题', value: draft.output.weeklyTitle,
              placeholder: '沿用默认：' + orDefault(defaults.output.weeklyTitle, '—'),
              onChange: (value) => setField('output', 'weeklyTitle', value),
            })),
          h(TextField, {
            label: '序号格式', value: draft.output.numberingStyle,
            hint: '写序号前缀即可，例如 1、',
            placeholder: '沿用默认：' + orDefault(defaults.output.numberingStyle, '—'),
            onChange: (value) => setField('output', 'numberingStyle', value),
          }),
          h('div', { className: 'gdr-grid2' },
            h(TriField, {
              label: '序号跨条连续', value: draft.output.numberingContinuous,
              onChange: (value) => setField('output', 'numberingContinuous', value),
            }),
            h(TriField, {
              label: '条与条之间空一行', value: draft.output.blankLineBetweenItems,
              onChange: (value) => setField('output', 'blankLineBetweenItems', value),
            }))),

        // 写作规则
        h('section', { className: 'gdr-card' },
          h('h4', { className: 'gdr-card-h' }, '写作规则'),
          h(TextField, {
            label: '写作规则文本', multiline: true, value: draft.writing.rules,
            hint: '整段替换技能里的写作规则',
            placeholder: orDefault(defaults.writing.rules, '留空则沿用技能默认写作规则'),
            onChange: (value) => setField('writing', 'rules', value),
          }),
          h('div', { className: 'gdr-grid2' },
            h(CountField, {
              label: '日报条数下限', value: draft.writing.dailyMin,
              placeholder: String(orDefault(defaults.writing.dailyMin, '')),
              onChange: (value) => setField('writing', 'dailyMin', value),
            }),
            h(CountField, {
              label: '日报条数上限', value: draft.writing.dailyMax,
              placeholder: String(orDefault(defaults.writing.dailyMax, '')),
              onChange: (value) => setField('writing', 'dailyMax', value),
            })),
          h('div', { className: 'gdr-grid2' },
            h(CountField, {
              label: '周报条数下限', value: draft.writing.weeklyMin,
              placeholder: String(orDefault(defaults.writing.weeklyMin, '')),
              onChange: (value) => setField('writing', 'weeklyMin', value),
            }),
            h(CountField, {
              label: '周报条数上限', value: draft.writing.weeklyMax,
              placeholder: String(orDefault(defaults.writing.weeklyMax, '')),
              onChange: (value) => setField('writing', 'weeklyMax', value),
            })),
          h(TriField, {
            label: '每条以动词开头', value: draft.writing.verbFirst,
            onChange: (value) => setField('writing', 'verbFirst', value),
          })),

        // 风格规则
        h('section', { className: 'gdr-card' },
          h('h4', { className: 'gdr-card-h' }, '风格规则'),
          h(TextField, {
            label: '风格规则文本', multiline: true, value: draft.style.rules,
            hint: '整段替换 references/report-style.md 的风格规则',
            placeholder: orDefault(defaults.style.rules, '留空则沿用技能默认风格规则'),
            onChange: (value) => setField('style', 'rules', value),
          })),

        // 样例库
        h('section', { className: 'gdr-card' },
          h('h4', { className: 'gdr-card-h' }, '样例库'),
          h(TextField, {
            label: '风格样例', multiline: true, value: draft.style.samples,
            hint: '替换默认的代表性样例与完整原始样例',
            placeholder: orDefault(defaults.style.samples, '留空则沿用技能默认样例库'),
            onChange: (value) => setField('style', 'samples', value),
          })),

        // 兜底
        h('section', { className: 'gdr-card' },
          h('h4', { className: 'gdr-card-h' }, '无提交时的兜底'),
          h(TextField, {
            label: '兜底策略', multiline: true, value: draft.fallback.strategy,
            placeholder: orDefault(defaults.fallback.strategy, '留空则沿用技能默认兜底规则'),
            onChange: (value) => setField('fallback', 'strategy', value),
          })),

        // 额外要求
        h('section', { className: 'gdr-card' },
          h('h4', { className: 'gdr-card-h' }, '额外提示词要求'),
          h(TextField, {
            label: '追加要求', multiline: true, value: draft.extraPrompt,
            hint: '纯追加，不覆盖任何现有规则',
            placeholder: '例如：涉及数据精度时，一定要写清是哪个指标',
            onChange: setExtra,
          })),

        h('div', { className: 'gdr-actions' },
          h('button', {
            className: 'gdr-btn gdr-btn-primary', type: 'button', disabled: busy,
            onClick: () => void run('save', { config: buildPayload(draft) }, '已保存并生效'),
          }, busy ? '处理中…' : '保存'),
          h('button', {
            className: 'gdr-btn', type: 'button', disabled: busy,
            onClick: () => void run('reset', null, '已恢复全部默认'),
          }, '恢复全部默认'),
          h('button', {
            className: 'gdr-btn', type: 'button', disabled: busy,
            onClick: () => void load(),
          }, '重新载入')),

        h('div', { className: 'gdr-meta' },
          h('div', null, '配置文件：', h('b', null, snapshot.configPath)),
          h('div', null, '技能目录：', h('b', null, snapshot.skillDir)),
          h('div', null,
            '当前状态：',
            h('b', null, snapshot.skillRegistered ? (snapshot.injected ? '已接管技能并注入设置' : '已接管技能，未注入任何设置') : '技能未接管'),
            ' · 技能植入：', h('b', null, snapshot.planted ?? '未知')),
          h('div', null, '注入段长度：', h('b', null, String(snapshot.injectionChars ?? 0)), ' 字符')))
    }

    /**
     * @brief 客户端半入口
     * @param ctx cordis 客户端上下文
     */
    function apply(ctx) {
      // slots 是声明依赖（见文末 exports.inject），运行时会在服务就绪后才调用本函数
      const slots = ctx.slots !== undefined ? ctx.slots : ctx.get('slots')
      if (slots === undefined) {
        console.error('[git-daily-weekly-report] slots 服务不可用，设置页未注册')
        return
      }

      // 自绘样式随本插件生命周期挂载与卸载
      const styleEl = document.createElement('style')
      styleEl.setAttribute('data-dsh-plugin', 'git-daily-weekly-report')
      styleEl.textContent = CSS
      document.head.appendChild(styleEl)
      ctx.effect(() => () => {
        if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
      })

      // 等设置 shell 声明该 slot 后再注册，避免在 slot 尚不存在时抛错
      ctx.effect(() => slots.inject('settings.section', () => slots.register(
        {
          name: 'settings.section',
          id: 'report-summary',
          // 排在官方（0/10/15/20/25）与常见第三方（20~140）之后
          order: 1300,
          // 用普通字符串而不是函数：无 locale 服务的 shell 会直接渲染 options.label
          label: '报告总结',
        },
        () => h(Panel, null),
      )))
    }

    exports.name = 'git-daily-weekly-report'
    // 缺了它运行时会立刻调用 apply，那时 slot 服务还没发布，设置页会静默不注册
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
