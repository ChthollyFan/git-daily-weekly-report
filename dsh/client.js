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

    /** ISO 星期 1-7 的中文名，与 host 半 push-config.js 的取值顺序保持一致 */
    const WEEKDAY_LABELS = [
      { value: 1, label: '周一' },
      { value: 2, label: '周二' },
      { value: 3, label: '周三' },
      { value: 4, label: '周四' },
      { value: 5, label: '周五' },
      { value: 6, label: '周六' },
      { value: 7, label: '周日' },
    ]

    /** 与 WEEKDAY_LABELS 同序的纯文本：拼字符串时必须用这个，写成数组对象会显示成 [object Object] */
    const WEEKDAY_NAMES = WEEKDAY_LABELS.map((day) => day.label)

    /**
     * 把 ISO 星期数组压成中文：连续三天以上合并成区间，全周直接写「每天」
     * @note 规则与 host 侧 dsh/push-config.js 的 describeWeekdays 保持一致，
     *       客户端拿不到那个模块，只能各写一份
     */
    const weekdayText = (list) => {
      const days = (Array.isArray(list) ? list : [])
        .filter((day) => typeof day === 'number' && day >= 1 && day <= 7)
        .sort((left, right) => left - right)
      if (days.length === 0) return '（未设置）'
      if (days.length === 7) return '每天'

      const groups = []
      let start = 0
      for (let index = 1; index <= days.length; index += 1) {
        const atEnd = index === days.length
        if (!atEnd && days[index] === days[index - 1] + 1) continue
        const span = index - start
        if (span >= 3) {
          groups.push(`${WEEKDAY_NAMES[days[start] - 1]}至${WEEKDAY_NAMES[days[index - 1] - 1]}`)
        } else {
          for (let cursor = start; cursor < index; cursor += 1) {
            groups.push(WEEKDAY_NAMES[days[cursor] - 1])
          }
        }
        start = index
      }
      return groups.join('、')
    }

    /**
     * 时区下拉的候选：只列中国常用时区，省得手敲 IANA 名打错
     * @note push-config.js 侧仍按 IANA 名校验，手改配置文件写别的时区照样可用；
     *       界面只在「值不在列表里」时补一项显示出来，不会覆盖原值
     */
    const TIME_ZONE_CHOICES = [
      { value: 'Asia/Shanghai', label: 'Asia/Shanghai（北京，UTC+8）' },
      { value: 'Asia/Hong_Kong', label: 'Asia/Hong_Kong（香港，UTC+8）' },
      { value: 'Asia/Macau', label: 'Asia/Macau（澳门，UTC+8）' },
      { value: 'Asia/Taipei', label: 'Asia/Taipei（台北，UTC+8）' },
      { value: 'Asia/Urumqi', label: 'Asia/Urumqi（乌鲁木齐，UTC+6）' },
    ]

    /** 把当前值折进候选：列表外的值追加一项，避免下拉缺项时显示空白 */
    const timeZoneOptions = (current) => {
      const text = typeof current === 'string' ? current.trim() : ''
      if (text === '' || TIME_ZONE_CHOICES.some((item) => item.value === text)) {
        return TIME_ZONE_CHOICES
      }
      return [...TIME_ZONE_CHOICES, { value: text, label: `${text}（当前配置，不在常用列表）` }]
    }

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
.gdr-status { font-size:12px; padding:7px 10px; border-radius:8px; white-space:pre-wrap;
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1)); background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04)); }
/* 状态条吸顶：按钮都在页面下方，不吸顶的话改了哪步都看不见结果 */
.gdr-status-sticky { position:sticky; top:0; z-index:3; backdrop-filter:blur(6px); }
.gdr-status-err { border-color:var(--dsw-alias-state-error-primary,#e5484d);
  color:var(--dsw-alias-state-error-primary,#c62a2f); }
.gdr-status-ok { border-color:var(--dsw-alias-state-success-primary,#128a3a);
  color:var(--dsw-alias-state-success-primary,#0f7a33); }
.gdr-meta { font-size:11px; color:var(--dsw-alias-label-secondary,#8a9099); word-break:break-all; }
.gdr-meta b { font-weight:500; color:var(--dsw-alias-label-primary,#1f2329); }
/* 自动推送分区新增：勾选行、星期选择、只读指令块 */
.gdr-inline { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.gdr-check { display:flex; align-items:center; gap:6px; font-size:12px; cursor:pointer; }
.gdr-check input { margin:0; cursor:pointer; }
.gdr-days { display:flex; gap:6px; flex-wrap:wrap; }
.gdr-code { margin:0; font-family:ui-monospace,Consolas,monospace; font-size:11px; line-height:1.6;
  white-space:pre-wrap; word-break:break-all; padding:9px 10px; border-radius:8px; max-height:240px;
  overflow:auto; border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));
  background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04)); }
/* 通道卡片折叠：三个通道的字段加起来太长，收起后用标题行的摘要顶替 */
.gdr-card-fold { padding:0; overflow:hidden; }
.gdr-card-head { display:flex; align-items:center; gap:8px; width:100%; box-sizing:border-box;
  padding:12px 15px; border:0; background:none; font-family:inherit; font-size:13px; font-weight:600;
  color:inherit; text-align:left; cursor:pointer; }
.gdr-card-head:hover { background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04)); }
.gdr-caret { flex:none; width:10px; font-size:10px; color:var(--dsw-alias-label-secondary,#8a9099);
  transition:transform .15s ease; }
.gdr-caret-open { transform:rotate(90deg); }
.gdr-card-title { flex:none; }
.gdr-chip { margin-left:auto; max-width:54%; padding:2px 9px; border-radius:999px; font-size:11px; font-weight:400;
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));
  color:var(--dsw-alias-label-secondary,#8a9099);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.gdr-chip-on { color:var(--dsw-alias-state-success-primary,#0f7a33);
  border-color:var(--dsw-alias-state-success-primary,#128a3a); }
.gdr-card-body { display:flex; flex-direction:column; gap:10px; padding:0 15px 14px; }
.gdr-card-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding-top:2px; }
/* 定时任务列表与创建失败时的三按钮弹层 */
.gdr-task { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:12px; padding:8px 10px;
  border-radius:8px; border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1)); }
.gdr-task-main { flex:1; min-width:180px; }
.gdr-task-sub { font-size:11px; color:var(--dsw-alias-label-secondary,#8a9099); word-break:break-all; }
.gdr-modal-mask { position:fixed; inset:0; z-index:20; display:flex; align-items:center; justify-content:center;
  padding:20px; background:rgba(0,0,0,.36); }
.gdr-modal { width:min(620px,100%); max-height:80vh; overflow:auto; display:flex; flex-direction:column; gap:10px;
  padding:16px; border-radius:12px; border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));
  /* 弹层必须不透明：兜底值同时给出深色主题会用的底色，避免变量缺失时白底浅字 */
  color:var(--dsw-alias-label-primary,#1f2329);
  background:var(--dsw-alias-bg-layer-1,#fff); }
/* 合并后的单页外壳：顶栏（标题 + 版本号 + 更新）与页内分区切换条 */
.gdr-topbar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.gdr-topbar .gdr-h { margin:0; }
.gdr-version { font-family:ui-monospace,Consolas,monospace; font-size:11px; padding:1px 8px; border-radius:999px;
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));
  color:var(--dsw-alias-label-secondary,#8a9099); }
.gdr-update { margin-left:auto; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.gdr-tabs { display:flex; gap:4px; padding:3px; border-radius:10px;
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));
  background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04)); align-self:flex-start; }
.gdr-tab { border:0; background:none; color:inherit; font-family:inherit; font-size:12px;
  padding:5px 14px; border-radius:8px; cursor:pointer; }
.gdr-tab:hover { background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.6)); }
.gdr-tab-on { background:var(--dsw-alias-bg-layer-1,#fff); font-weight:600;
  box-shadow:0 1px 2px rgba(0,0,0,.08); }
/* 子页嵌在外壳里时不再自带外边距与最大宽度，否则会出现双层留白 */
.gdr-embedded { display:flex; flex-direction:column; gap:14px; }
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
     * @param method snapshot / save / reset / push-snapshot / push-save / push-reset / push-test
     * @param args 传给 host 的参数
     * @param options.allowFail 为 true 时 ok:false 也返回数据而不是抛错
     * @return 解析后的响应体
     * @note 非 2xx 或 ok:false 都抛错，由调用方统一显示到状态行；
     *       「测试发送」要读出失败明细，所以它走 allowFail
     */
    async function callApi(method, args, options) {
      const allowFail = options !== undefined && options.allowFail === true
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
      if (!response.ok || (data.ok !== true && !allowFail)) {
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
          // 密钥类字段用 password 遮住屏幕上的明文；它本来就以明文存在本地配置文件里
          type: props.multiline ? undefined : (props.secret ? 'password' : 'text'),
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
     * @brief 固定选项下拉框
     * @note 自动推送的取值都是有限枚举（消息类型、加密方式），用下拉而不是自由输入
     */
    function SelectField(props) {
      return h('label', { className: 'gdr-field' },
        h('span', { className: 'gdr-label' }, props.label,
          props.hint ? h('em', { className: 'gdr-hint' }, props.hint) : null),
        h('select', {
          className: 'gdr-select',
          value: props.value ?? '',
          onChange: (event) => props.onChange(event.target.value),
        },
          (props.options ?? []).map((option) => h('option', {
            key: String(option.value),
            value: option.value,
          }, option.label))))
    }

    /**
     * @brief 勾选开关
     */
    function ToggleField(props) {
      return h('label', { className: 'gdr-check' },
        h('input', {
          type: 'checkbox',
          checked: props.value === true,
          onChange: (event) => props.onChange(event.target.checked),
        }),
        h('span', null, props.label),
        props.hint ? h('em', { className: 'gdr-hint' }, props.hint) : null)
    }

    /**
     * @brief 整数输入框，空串交给 host 回退到默认值
     */
    function NumberField(props) {
      return h('label', { className: 'gdr-field' },
        h('span', { className: 'gdr-label' }, props.label,
          props.hint ? h('em', { className: 'gdr-hint' }, props.hint) : null),
        h('input', {
          className: 'gdr-input',
          type: 'number',
          min: props.min ?? undefined,
          max: props.max ?? undefined,
          value: props.value ?? '',
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
     * @brief 星期多选
     * @note 默认收在周报卡片里：weekly 的 weekdays 为空时 host 会回退成周五
     */
    function WeekdayField(props) {
      const selected = Array.isArray(props.value) ? props.value : []
      const toggle = (day) => {
        const next = selected.includes(day)
          ? selected.filter((item) => item !== day)
          : [...selected, day].sort((a, b) => a - b)
        props.onChange(next)
      }
      return h('div', { className: 'gdr-field' },
        h('span', { className: 'gdr-label' }, props.label,
          props.hint ? h('em', { className: 'gdr-hint' }, props.hint) : null),
        h('div', { className: 'gdr-days' },
          WEEKDAY_LABELS.map((day) => h('label', { key: day.value, className: 'gdr-check' },
            h('input', {
              type: 'checkbox',
              checked: selected.includes(day.value),
              onChange: () => toggle(day.value),
            }),
            h('span', null, day.label)))))
    }

    /**
     * @brief 可折叠的通道卡片
     * @param props.title 通道名
     * @param props.chip 标题行右侧的状态摘要
     * @param props.chipOn 摘要是否用「已启用」的高亮色
     * @param props.open 当前是否展开
     * @param props.onToggle 点击标题行时切换展开状态
     * @param props.onTest 点「测试此通道」时的回调
     * @param props.testing 该通道正在测试中
     * @param props.children 展开后的表单内容
     * @note 收起时不渲染 children：表单全是受控输入，重新展开会按草稿值重建不会丢数据，
     *       但能省掉大量节点，也让三个通道能一屏看全
     */
    function ChannelCard(props) {
      return h('section', { className: 'gdr-card gdr-card-fold' },
        h('button', {
          className: 'gdr-card-head',
          type: 'button',
          'aria-expanded': props.open === true,
          onClick: () => props.onToggle(!props.open),
        },
          h('span', { className: 'gdr-caret' + (props.open ? ' gdr-caret-open' : '') }, '▶'),
          h('span', { className: 'gdr-card-title' }, props.title),
          h('span', { className: 'gdr-chip' + (props.chipOn ? ' gdr-chip-on' : '') }, props.chip)),
        props.open
          ? h('div', { className: 'gdr-card-body' },
            props.children,
            h('div', { className: 'gdr-card-actions' },
              h('button', {
                className: 'gdr-btn',
                type: 'button',
                disabled: props.testing === true,
                onClick: () => props.onTest(),
              }, props.testing === true ? '测试中…' : '测试此通道')))
          : null)
    }

    /**
     * @brief 逗号/顿号/分号分隔的列表 → 数组
     * @note 邮件收件人与 @人 ID 都按这个口径拆，顺手容忍用户从别处粘来的中英文标点
     */
    function splitList(text) {
      return String(text ?? '')
        .split(/[,，;；\n]/)
        .map((item) => item.trim())
        .filter((item) => item !== '')
    }

    /** 数组 → 面板上显示的文本 */
    function joinList(list) {
      return Array.isArray(list) ? list.join('，') : ''
    }

    /**
     * @brief 请求头对象 → 每行一条 Key: Value 的文本
     * @note 表单里编辑对象太别扭，用文本中转，提交时再还原成对象
     */
    function headersToText(headers) {
      if (headers === null || typeof headers !== 'object') return ''
      return Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\n')
    }

    /** 每行一条 Key: Value 的文本 → 请求头对象，非法行直接丢弃 */
    function textToHeaders(text) {
      const result = {}
      String(text ?? '').split(/\r?\n/).forEach((line) => {
        const index = line.indexOf(':')
        if (index <= 0) return
        const key = line.slice(0, index).trim()
        const value = line.slice(index + 1).trim()
        if (key !== '') result[key] = value
      })
      return result
    }

    /**
     * @brief 克隆自动推送配置草稿
     * @param config 规范化后的配置
     * @return 深拷贝的副本
     * @note 配置里全是纯 JSON 值，用序列化做深拷贝足够，且不用担心漏拷新增的嵌套对象
     */
    function clonePushConfig(config) {
      return JSON.parse(JSON.stringify(config))
    }

    /**
     * @brief 客户端侧的版本比较，与 host 半同口径：只看前三段数字
     * @param candidate 待比较版本
     * @param base 基准版本
     * @return candidate 更大时返回 true
     */
    function isNewer(candidate, base) {
      const parse = (text) => String(text ?? '').split('.').slice(0, 3).map((part) => {
        const value = Number.parseInt(part, 10)
        return Number.isFinite(value) ? value : 0
      })
      const left = parse(candidate)
      const right = parse(base)
      for (let index = 0; index < 3; index += 1) {
        if (left[index] !== right[index]) return left[index] > right[index]
      }
      return false
    }

    /**
     * @brief 「报告总结」设置页外壳：版本号、更新按钮与两个分区的切换
     * @note 报告设置与自动推送合并成一个导航项，靠页内切换条换视图。两个子页始终挂载、
     *       只切换显示，所以切走再切回来时没保存的草稿还在
     */
    function SettingsShell() {
      const [tab, setTab] = React.useState('summary')
      const [info, setInfo] = React.useState(null)
      const [checking, setChecking] = React.useState(false)
      const [installing, setInstalling] = React.useState(false)
      const [updateNote, setUpdateNote] = React.useState('')

      React.useEffect(() => {
        let alive = true
        void (async () => {
          try {
            const data = await callApi('plugin-info', null)
            if (alive) setInfo(data.info ?? null)
          } catch {
            // 版本号取不到不影响两个分区自身的读写，静默跳过
          }
        })()
        return () => {
          alive = false
        }
      }, [])

      const current = info !== null && typeof info.version === 'string' ? info.version : ''
      const latest = info !== null && typeof info.latest === 'string' ? info.latest : ''
      const hasUpdate = current !== '' && latest !== '' && isNewer(latest, current)
      // link 形态下代码就是工作区那份，安装会把链接换成实体包，所以只提示不安装
      const isLinkMode = info !== null && info.installMode === 'link'

      const check = async () => {
        setChecking(true)
        setUpdateNote('')
        try {
          const data = await callApi('check-update', null)
          if (data.info) setInfo(data.info)
          setUpdateNote(data.message ?? '')
        } catch (error) {
          setUpdateNote(`检查更新失败：${error.message}`)
        } finally {
          setChecking(false)
        }
      }

      const install = async () => {
        if (latest === '' || info === null) return
        const confirmed = window.confirm(
          `将从 npm 安装 ${info.name}@${latest}，安装完成后需要重启 dsh 才会生效。继续？`)
        if (!confirmed) return
        setInstalling(true)
        setUpdateNote('')
        try {
          const data = await callApi('install-update', { version: latest }, { allowFail: true })
          if (data.info) setInfo(data.info)
          setUpdateNote(data.message ?? '')
        } catch (error) {
          setUpdateNote(`安装失败：${error.message}`)
        } finally {
          setInstalling(false)
        }
      }

      let updateControl = null
      if (hasUpdate && !isLinkMode) {
        updateControl = h('button', {
          className: 'gdr-btn gdr-btn-primary',
          disabled: installing,
          onClick: () => void install(),
        }, installing ? '安装中…' : `安装更新 v${latest}`)
      } else {
        updateControl = h('button', {
          className: 'gdr-btn',
          disabled: checking || info === null,
          onClick: () => void check(),
        }, checking ? '检查中…' : '检查更新')
      }

      return h('div', { className: 'gdr-root' },
        h('div', { className: 'gdr-topbar' },
          h('h3', { className: 'gdr-h' }, '报告总结'),
          h('span', { className: 'gdr-version' }, current === '' ? '读取中…' : `v${current}`),
          h('div', { className: 'gdr-update' }, updateControl)),

        // link 形态先说明清楚，否则用户点了半天检查更新也不知道为什么不给装
        isLinkMode
          ? h('div', { className: 'gdr-meta' },
            `当前为开发链接形态，代码指向 ${info.linkTarget}；需要更新时在该目录执行 git pull。`)
          : null,

        updateNote === '' ? null : h('div', { className: 'gdr-meta' }, updateNote),

        h('div', { className: 'gdr-tabs' },
          h('button', {
            className: 'gdr-tab' + (tab === 'summary' ? ' gdr-tab-on' : ''),
            onClick: () => setTab('summary'),
          }, '报告设置'),
          h('button', {
            className: 'gdr-tab' + (tab === 'push' ? ' gdr-tab-on' : ''),
            onClick: () => setTab('push'),
          }, '自动推送')),

        h('div', { style: { display: tab === 'summary' ? undefined : 'none' } },
          h(Panel, { embedded: true })),
        h('div', { style: { display: tab === 'push' ? undefined : 'none' } },
          h(PushPanel, { embedded: true })))
    }

    /**
     * @brief 设置页主体
     * @note 初始加载失败时保留错误提示，表单不渲染，避免用户对着空表单改名
     */
    function Panel(props) {
      // 嵌在合并页里时由外壳提供标题与版本号，自己不再重复渲染页头
      const embedded = props !== null && props !== undefined && props.embedded === true
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
        return h('div', { className: embedded ? 'gdr-embedded' : 'gdr-root' },
          embedded ? null : h('header', null,
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
          // 有降级说明时算「保存了但要看一眼」，与纯成功区分开
          const notes = Array.isArray(data.warnings) ? data.warnings : []
          setStatus({ kind: notes.length > 0 ? 'err' : 'ok', text: data.message || okText })
        } catch (error) {
          setStatus({ kind: 'err', text: `操作失败：${error.message}` })
        } finally {
          setBusy(false)
        }
      }

      const defaults = snapshot.defaults ?? { output: {}, writing: {}, style: {}, fallback: {} }
      const orDefault = (value, fallback) => value ?? fallback ?? ''

      return h('div', { className: embedded ? 'gdr-embedded' : 'gdr-root' },
        embedded ? null : h('header', null,
          h('h3', { className: 'gdr-h' }, '报告总结'),
          h('p', { className: 'gdr-sub' },
            '留空的字段表示沿用技能里的默认规则；填了才会覆盖。设置只在 dsh 端生效，Codex 端不受影响。')),

        h('div', {
          className: 'gdr-status gdr-status-sticky'
            + (status.kind === 'err' ? ' gdr-status-err' : status.kind === 'ok' ? ' gdr-status-ok' : ''),
        }, status.text),

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
     * @brief 「自动推送」设置分区
     * @note 之所以与「报告总结」拆成两个导航项：这一页会碰真实的外部凭证与网络请求，
     *       独立成页便于单独确认，也避免在写作规则页里误触测试发送
     */
    /** 通道的中文名，测试结果与摘要行都用这套叫法，避免前后不一 */
    const CHANNEL_LABELS = { wecom: '企业微信', webhook: '自定义 Webhook', smtp: '邮件' }

    function PushPanel(props) {
      // 与「报告设置」一样：嵌入合并页时不重复渲染页头
      const embedded = props !== null && props !== undefined && props.embedded === true
      const [snapshot, setSnapshot] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [status, setStatus] = React.useState({ kind: 'idle', text: '正在读取自动推送配置…' })
      // 三个通道各自是否展开；null 表示还没从配置里推断过
      const [expanded, setExpanded] = React.useState(null)
      const [testingChannel, setTestingChannel] = React.useState('')
      // 已创建的日报/周报定时任务，由 schedule-list 拉取
      const [tasks, setTasks] = React.useState([])
      // 正在创建/取消的任务标识：type 或任务 id，非空时按钮禁用
      const [taskBusy, setTaskBusy] = React.useState('')
      // 创建失败时把降级指令摆进弹层，由用户决定粘贴、重试还是放弃
      const [failPrompt, setFailPrompt] = React.useState(null)

      /** 载入快照并把配置深拷成草稿，后续所有编辑都只动草稿 */
      const adopt = React.useCallback((data) => {
        setSnapshot(data.snapshot)
        setDraft(clonePushConfig(data.snapshot.config))
        // 三个通道一律默认收起：是否启用由标题右侧的状态标签体现，不再据配置自动展开
        setExpanded((prev) => prev ?? { wecom: false, webhook: false, smtp: false })
        const notes = Array.isArray(data.snapshot.warnings) ? [...data.snapshot.warnings] : []
        // 这两项是「保存了也不会生效」的典型原因，载入时就摆出来，不等定时到点才暴露
        if (data.snapshot.scriptExists === false) notes.push('随包脚本 send_report.py 不存在，推送一定失败')
        if (data.snapshot.incomplete === true) notes.push('有通道已开启但关键字段为空')
        setStatus({
          kind: notes.length > 0 ? 'err' : 'idle',
          text: notes.length > 0 ? notes.join('；') : '已载入自动推送配置',
        })
      }, [])

      /** 拉取已创建的日报/周报定时任务；失败不影响配置本身 */
      const refreshTasks = React.useCallback(async () => {
        try {
          const data = await callApi('schedule-list', null, { allowFail: true })
          setTasks(Array.isArray(data.tasks) ? data.tasks : [])
          // 调度服务没起来时列表必然为空，这里把原因说清楚，免得看起来像「建了却不见了」；
          // 但旧版宿主不认这个方法，那种情况只在点「创建」时才提示，不在这里刷红条
          const message = typeof data.message === 'string' ? data.message : ''
          if (data.ok !== true && message !== '' && !message.includes('未知方法')) {
            setStatus({ kind: 'err', text: message })
          }
        } catch {
          setTasks([])
        }
      }, [])

      /** 只刷新快照里的定时段，不动草稿：避免把用户没保存的编辑冲掉 */
      const refreshScheduleStatus = React.useCallback(async () => {
        try {
          const data = await callApi('push-snapshot', null, { allowFail: true })
          const schedule = data.snapshot === null || data.snapshot === undefined
            ? undefined
            : data.snapshot.schedule
          if (schedule !== undefined) {
            setSnapshot((prev) => (prev === null ? prev : { ...prev, schedule }))
          }
        } catch {
          // 刷新失败不影响任务列表，承载会话那行保持原样
        }
      }, [])

      const load = React.useCallback(async () => {
        setStatus({ kind: 'idle', text: '正在读取自动推送配置…' })
        try {
          adopt(await callApi('push-snapshot', null))
          void refreshTasks()
        } catch (error) {
          setStatus({ kind: 'err', text: `读取失败：${error.message}` })
        }
      }, [adopt, refreshTasks])

      React.useEffect(() => {
        void load()
      }, [load])

      if (draft === null || snapshot === null) {
        return h('div', { className: embedded ? 'gdr-embedded' : 'gdr-root' },
          embedded ? null : h('header', null,
            h('h3', { className: 'gdr-h' }, '自动推送'),
            h('p', { className: 'gdr-sub' }, '定时生成日报/周报后推送到企业微信、自定义 webhook 或邮件。')),
          h('div', { className: 'gdr-status' + (status.kind === 'err' ? ' gdr-status-err' : '') }, status.text))
      }

      /** 只改草稿的一个分支，不整体替换，避免输入时丢焦点 */
      const patch = (mutate) => {
        setDraft((prev) => {
          const next = clonePushConfig(prev)
          mutate(next)
          return next
        })
      }

      const run = async (method, args) => {
        setBusy(true)
        setStatus({ kind: 'idle', text: '正在保存…' })
        try {
          const data = await callApi(method, args)
          adopt(data)
          // host 会把降级与半填说明一起放进 warnings，有它就不再是纯成功
          const notes = Array.isArray(data.warnings) ? data.warnings : []
          setStatus({ kind: notes.length > 0 ? 'err' : 'ok', text: data.message || '已保存' })
        } catch (error) {
          setStatus({ kind: 'err', text: `操作失败：${error.message}` })
        } finally {
          setBusy(false)
        }
      }

      /** 切换某个通道卡片的展开状态 */
      const toggleExpanded = (channelName, open) => {
        setExpanded((prev) => ({ ...(prev ?? {}), [channelName]: open }))
      }

      /** 标题行右侧的摘要：收起状态下也要能看出这个通道配到哪一步了 */
      const channelChip = (channelName) => {
        const channels = draft.channels
        if (channelName === 'wecom') {
          if (!channels.wecom.enabled) return '未启用'
          return channels.wecom.webhookUrl === '' ? '已启用 · 缺 Webhook' : '已启用 · 群机器人'
        }
        if (channelName === 'webhook') {
          if (!channels.webhook.enabled) return '未启用'
          return channels.webhook.url === '' ? '已启用 · 缺地址' : '已启用 · ' + channels.webhook.url
        }
        if (!channels.smtp.enabled) return '未启用'
        return channels.smtp.host === ''
          ? '已启用 · 缺服务器'
          : `已启用 · ${channels.smtp.host}:${channels.smtp.port}`
      }

      /** 单个通道的就绪检查：本地先拦一道，省得白跑一次请求 */
      const channelProblem = (channelName) => {
        const channels = draft.channels
        if (channelName === 'wecom' && String(channels.wecom.webhookUrl ?? '').trim() === '') {
          return '企业微信：请先填 Webhook 地址'
        }
        if (channelName === 'webhook' && String(channels.webhook.url ?? '').trim() === '') {
          return '自定义 Webhook：请先填地址'
        }
        if (channelName === 'smtp') {
          if (String(channels.smtp.host ?? '').trim() === '') return '邮件：请先填 SMTP 服务器'
          if (!Array.isArray(channels.smtp.to) || channels.smtp.to.length === 0) return '邮件：请先填收件人'
        }
        return ''
      }

      /** 测试单个通道：用当前草稿真发一条固定正文，不落盘、不写归档 */
      const testChannel = async (channelName) => {
        const problem = channelProblem(channelName)
        if (problem !== '') {
          setStatus({ kind: 'err', text: problem })
          return
        }
        const label = CHANNEL_LABELS[channelName]
        if (!window.confirm(`将向「${label}」真实发送一条测试报告，确认继续？`)) return

        setTestingChannel(channelName)
        setStatus({ kind: 'idle', text: `正在测试${label}…` })
        try {
          // channel 必须传：脚本收到 --channel 才会跳过「总开关未启用」那道拦截
          const data = await callApi(
            'push-test',
            { config: draft, type: 'daily', channel: channelName },
            { allowFail: true },
          )
          setSnapshot(data.snapshot)
          const test = data.test ?? {}
          const lines = [`${label}：${data.message || (test.ok ? '测试发送成功' : '测试发送失败')}`]
          if (test.reason) lines.push(`原因：${test.reason}`)
          if (test.stdout) lines.push(`脚本输出：${test.stdout}`)
          setStatus({ kind: test.ok ? 'ok' : 'err', text: lines.join('\n') })
        } catch (error) {
          setStatus({ kind: 'err', text: `${label}测试失败：${error.message}` })
        } finally {
          setTestingChannel('')
        }
      }

      /** 复制创建指令；传 text 时复制指定文本（失败弹层里的那一份） */
      const copyInstruction = async (text) => {
        const content = typeof text === 'string' && text !== '' ? text : (snapshot.scheduleInstruction ?? '')
        if (content === '') {
          setCopyTip('先生成定时配置并保存，再复制指令')
          return
        }
        try {
          await navigator.clipboard.writeText(content)
          setCopyTip('已复制，粘贴给任意 dsh 会话即可创建定时任务')
        } catch {
          setCopyTip('复制失败，请手动选中下面的指令复制')
        }
      }

      /** 任务行的时间摘要：按 kind 拼「每天/每周几 + 时区 + 下次时间」 */
      const describeTask = (task) => {
        const parts = []
        if (task.kind === 'daily') {
          parts.push(`每天 ${task.time} ${task.timeZone}`.trim())
        } else if (task.kind === 'weekly') {
          const days = weekdayText(task.weekdays)
          // 全勾时 days 已经是「每天」，前面再加「每」会变成「每每天」
          const prefix = days === '每天' ? '每天' : `每${days}`
          parts.push(`${prefix} ${task.time} ${task.timeZone}`.trim())
        } else if (task.kind === 'cron') {
          parts.push(`cron ${task.expression}`)
        } else if (task.kind !== '') {
          parts.push(task.kind)
        }
        if (task.scheduledAt !== '') parts.push(`下次 ${task.scheduledAt}`)
        return parts.filter((item) => item !== '').join(' · ')
      }

      /**
       * 用页面上已保存的配置直接创建定时任务
       * @note 必须用已保存的配置：草稿未落盘时建的会是旧参数，确认框里先说清楚
       */
      const createTask = async (type) => {
        const label = type === 'weekly' ? '周报' : '日报'
        const schedule = snapshot.schedule ?? {}
        if (schedule.canCreate !== true) {
          // 三种原因分开说：宿主没重启时快照里根本没有 schedule 字段、bundle 没启用、
          // 服务在但建不了承载会话。混成一句「服务不可用」会把人带偏
          const reason = snapshot.schedule === undefined || snapshot.schedule === null
            ? '当前宿主还没加载新版插件接口，请重启 dsh 后重试'
            : (schedule.reason || '官方调度服务不可用；请先在插件管理页启用「自动化任务」并重启 dsh')
          setStatus({ kind: 'err', text: reason })
          setFailPrompt({ type, label, reason, instruction: '' })
          return
        }
        const confirmed = window.confirm(
          `将按当前已保存的配置创建${label}定时任务，确认继续？\n（刚改过时间或标题的话，要先点底部「保存」，否则建的是旧参数）`,
        )
        if (!confirmed) return

        setTaskBusy(type)
        setStatus({ kind: 'idle', text: `正在创建${label}定时任务…` })
        try {
          const data = await callApi('schedule-create', { type }, { allowFail: true })
          setTasks(Array.isArray(data.tasks) ? data.tasks : [])
          if (data.ok === true) {
            setStatus({ kind: 'ok', text: data.message || `已创建${label}定时任务` })
          } else {
            setStatus({ kind: 'err', text: data.message || `创建${label}定时任务失败` })
            setFailPrompt({
              type,
              label,
              reason: data.reason || data.message || '',
              instruction: data.instruction || '',
            })
          }
        } catch (error) {
          setStatus({ kind: 'err', text: `创建${label}定时任务失败：${error.message}` })
        } finally {
          setTaskBusy('')
          // 承载会话可能刚被新建，把快照里的定时段换掉（不动草稿）
          void refreshScheduleStatus()
        }
      }

      /** 取消一条已创建的任务；dsh 侧是硬删除，连投递记录一起没 */
      const cancelTask = async (task) => {
        const name = task.title === '' ? task.id : task.title
        if (!window.confirm(`取消「${name}」这条定时任务？取消后不会再自动生成。`)) return

        setTaskBusy(task.id)
        try {
          const data = await callApi('schedule-delete', { id: task.id }, { allowFail: true })
          setTasks(Array.isArray(data.tasks) ? data.tasks : [])
          setStatus({
            kind: data.ok === true ? 'ok' : 'err',
            text: data.message || (data.ok === true ? '已取消定时任务' : '取消失败'),
          })
        } catch (error) {
          setStatus({ kind: 'err', text: `取消定时任务失败：${error.message}` })
        } finally {
          setTaskBusy('')
        }
      }

      const wecom = draft.channels.wecom
      const webhook = draft.channels.webhook
      const smtp = draft.channels.smtp
      // 官方调度是可选 bundle：快照里没有 schedule 段时一律按「未启用」呈现
      const schedule = snapshot.schedule ?? {}
      const carrierId = typeof schedule.session?.id === 'string' ? schedule.session.id : ''

      return h('div', { className: embedded ? 'gdr-embedded' : 'gdr-root' },
        embedded ? null : h('header', null,
          h('h3', { className: 'gdr-h' }, '自动推送'),
          h('p', { className: 'gdr-sub' },
            '定时由 dsh 的调度任务触发：到点后 agent 生成正文并调用技能里的 send_report.py 发送。',
            '所有开关默认关闭；每个通道填完先点「测试此通道」确认能收到，再开总开关与定时。')),

        h('div', {
          className: 'gdr-status gdr-status-sticky'
            + (status.kind === 'err' ? ' gdr-status-err' : status.kind === 'ok' ? ' gdr-status-ok' : ''),
        }, status.text),

        // 总开关与运行参数
        h('section', { className: 'gdr-card' },
          h('h4', { className: 'gdr-card-h' }, '总开关'),
          h(ToggleField, {
            label: '启用自动推送', value: draft.enabled,
            onChange: (value) => patch((config) => { config.enabled = value }),
          }),
          h(TextField, {
            label: '目标仓库路径', value: draft.repo,
            hint: '定时任务里 agent 靠这个路径认仓库，留空会每次反问你',
            placeholder: '例如 C:/Users/you/VscodeProject/some-repo',
            onChange: (value) => patch((config) => { config.repo = value }),
          }),
          h(TextField, {
            label: '归档目录', value: draft.archiveDir,
            hint: '每次推送前把正文存一份，同日重复推送会被拦下',
            onChange: (value) => patch((config) => { config.archiveDir = value }),
          })),

        // 企业微信群机器人
        h(ChannelCard, {
          title: '企业微信群机器人',
          chip: channelChip('wecom'),
          chipOn: wecom.enabled === true,
          open: expanded !== null && expanded.wecom === true,
          onToggle: (open) => toggleExpanded('wecom', open),
          onTest: () => void testChannel('wecom'),
          testing: testingChannel === 'wecom',
        },
          h(ToggleField, {
            label: '启用', value: wecom.enabled,
            onChange: (value) => patch((config) => { config.channels.wecom.enabled = value }),
          }),
          h(TextField, {
            label: 'Webhook 地址', value: wecom.webhookUrl, secret: true,
            hint: '群设置 → 群机器人 → 添加后复制，key 就是全部凭证',
            placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...',
            onChange: (value) => patch((config) => { config.channels.wecom.webhookUrl = value }),
          }),
          h('div', { className: 'gdr-grid2' },
            h(SelectField, {
              label: '消息类型', value: wecom.messageType,
              options: [{ value: 'markdown', label: 'markdown' }, { value: 'text', label: 'text' }],
              onChange: (value) => patch((config) => { config.channels.wecom.messageType = value }),
            }),
            h(NumberField, {
              label: '单条字节上限', value: wecom.maxBytes, min: 500, max: 4096,
              hint: '超长正文按段拆分发送',
              onChange: (value) => patch((config) => { config.channels.wecom.maxBytes = value }),
            })),
          h(ToggleField, {
            label: '@所有人', value: wecom.mentionAll,
            onChange: (value) => patch((config) => { config.channels.wecom.mentionAll = value }),
          }),
          h('div', { className: 'gdr-grid2' },
            h(TextField, {
              label: '@成员 ID', value: joinList(wecom.mentionedList),
              hint: '逗号分隔，留空则只 @所有人',
              onChange: (value) => patch((config) => { config.channels.wecom.mentionedList = splitList(value) }),
            }),
            h(TextField, {
              label: '@成员手机号', value: joinList(wecom.mentionedMobileList),
              hint: '逗号分隔',
              onChange: (value) => patch((config) => {
                config.channels.wecom.mentionedMobileList = splitList(value)
              }),
            }))),

        // 通用 webhook
        h(ChannelCard, {
          title: '自定义 Webhook',
          chip: channelChip('webhook'),
          chipOn: webhook.enabled === true,
          open: expanded !== null && expanded.webhook === true,
          onToggle: (open) => toggleExpanded('webhook', open),
          onTest: () => void testChannel('webhook'),
          testing: testingChannel === 'webhook',
        },
          h(ToggleField, {
            label: '启用', value: webhook.enabled,
            onChange: (value) => patch((config) => { config.channels.webhook.enabled = value }),
          }),
          h(TextField, {
            label: '地址', value: webhook.url,
            placeholder: 'https://example.com/hook',
            onChange: (value) => patch((config) => { config.channels.webhook.url = value }),
          }),
          h(TextField, {
            label: '请求体模板', multiline: true, value: webhook.bodyTemplate,
            hint: '支持 {{content}} {{title}} {{date}} {{type}} 占位符',
            onChange: (value) => patch((config) => { config.channels.webhook.bodyTemplate = value }),
          }),
          h(TextField, {
            label: '请求头', multiline: true, value: headersToText(webhook.headers),
            hint: '每行一条 Key: Value，用于钉钉/飞书这类需要签名或 token 的服务',
            placeholder: 'Content-Type: application/json',
            onChange: (value) => patch((config) => { config.channels.webhook.headers = textToHeaders(value) }),
          }),
          h(NumberField, {
            label: '超时秒数', value: webhook.timeoutSeconds, min: 1, max: 120,
            onChange: (value) => patch((config) => { config.channels.webhook.timeoutSeconds = value }),
          })),

        // 邮件
        h(ChannelCard, {
          title: '邮件（SMTP）',
          chip: channelChip('smtp'),
          chipOn: smtp.enabled === true,
          open: expanded !== null && expanded.smtp === true,
          onToggle: (open) => toggleExpanded('smtp', open),
          onTest: () => void testChannel('smtp'),
          testing: testingChannel === 'smtp',
        },
          h(ToggleField, {
            label: '启用', value: smtp.enabled,
            onChange: (value) => patch((config) => { config.channels.smtp.enabled = value }),
          }),
          h('div', { className: 'gdr-grid2' },
            h(TextField, {
              label: 'SMTP 服务器', value: smtp.host,
              placeholder: 'smtp.example.com',
              onChange: (value) => patch((config) => { config.channels.smtp.host = value }),
            }),
            h(NumberField, {
              label: '端口', value: smtp.port, min: 1, max: 65535,
              onChange: (value) => patch((config) => { config.channels.smtp.port = value }),
            })),
          h(SelectField, {
            label: '加密方式', value: smtp.security,
            options: [
              { value: 'ssl', label: 'SSL（465）' },
              { value: 'starttls', label: 'STARTTLS（587）' },
              { value: 'none', label: '不加密（仅内网）' },
            ],
            onChange: (value) => patch((config) => { config.channels.smtp.security = value }),
          }),
          h('div', { className: 'gdr-grid2' },
            h(TextField, {
              label: '账号', value: smtp.username,
              onChange: (value) => patch((config) => { config.channels.smtp.username = value }),
            }),
            h(TextField, {
              label: '密码 / 授权码', value: smtp.password, secret: true,
              hint: '明文保存在本地配置文件',
              onChange: (value) => patch((config) => { config.channels.smtp.password = value }),
            })),
          h(TextField, {
            label: '发件人', value: smtp.from,
            hint: '留空则用账号本身',
            placeholder: 'me@example.com',
            onChange: (value) => patch((config) => { config.channels.smtp.from = value }),
          }),
          h(TextField, {
            label: '收件人', value: joinList(smtp.to),
            hint: '逗号分隔多个地址',
            onChange: (value) => patch((config) => { config.channels.smtp.to = splitList(value) }),
          }),
          h(TextField, {
            label: '抄送', value: joinList(smtp.cc),
            hint: '逗号分隔，可留空',
            onChange: (value) => patch((config) => { config.channels.smtp.cc = splitList(value) }),
          }),
          h('div', { className: 'gdr-grid2' },
            h(TextField, {
              label: '主题模板', value: smtp.subjectTemplate,
              hint: '支持 {{title}} {{date}} {{type}}',
              onChange: (value) => patch((config) => { config.channels.smtp.subjectTemplate = value }),
            }),
            h(ToggleField, {
              label: '正文用 HTML', value: smtp.html,
              onChange: (value) => patch((config) => { config.channels.smtp.html = value }),
            })),
          h(NumberField, {
            label: '超时秒数', value: smtp.timeoutSeconds, min: 1, max: 120,
            onChange: (value) => patch((config) => { config.channels.smtp.timeoutSeconds = value }),
          })),

        // 定时
        h('section', { className: 'gdr-card' },
          h('h4', { className: 'gdr-card-h' }, '定时任务'),
          h('p', { className: 'gdr-sub' },
            '点下面按钮直接创建：到点后由 dsh 调度服务把提醒投递到承载会话，',
            'agent 再按技能步骤生成正文并调用 send_report.py 发送。',
            '改了时间或标题要先点底部「保存」，创建时用的是已保存的参数。'),
          h('div', { className: 'gdr-meta' },
            h('div', null, '承载会话：',
              carrierId === ''
                ? '尚未创建（首次建任务时自动新建，落在「未分组」）'
                : h('b', null, carrierId)),
            h('div', null, '调度服务：',
              // 旧宿主返回的快照里没有 schedule 字段，这种情况是「没重启」而不是「没启用」
              snapshot.schedule === undefined || snapshot.schedule === null
                ? '宿主未加载新接口（请重启 dsh）'
                : schedule.available === true
                  ? (schedule.canCreate === true ? '可用' : '已启用，但会话服务不可用')
                  : '未启用（需在插件管理页启用「自动化任务」）')),
          h('div', { className: 'gdr-grid2' },
            h(TextField, {
              label: '日报时间', value: draft.schedule.daily.time,
              hint: 'HH:mm，24 小时制',
              onChange: (value) => patch((config) => { config.schedule.daily.time = value }),
            }),
            h(SelectField, {
              label: '日报时区', value: draft.schedule.daily.timeZone,
              options: timeZoneOptions(draft.schedule.daily.timeZone),
              onChange: (value) => patch((config) => { config.schedule.daily.timeZone = value }),
            })),
          // 日报也要能挑星期：全勾等于每天，只勾工作日就是工作日报
          h(WeekdayField, {
            label: '日报发送日', value: draft.schedule.daily.weekdays,
            hint: '可多选，当前：' + snapshot.dailyWeekdayText,
            onChange: (value) => patch((config) => { config.schedule.daily.weekdays = value }),
          }),
          h('div', { className: 'gdr-grid2' },
            h(TextField, {
              label: '周报时间', value: draft.schedule.weekly.time,
              hint: 'HH:mm，24 小时制',
              onChange: (value) => patch((config) => { config.schedule.weekly.time = value }),
            }),
            h(SelectField, {
              label: '周报时区', value: draft.schedule.weekly.timeZone,
              options: timeZoneOptions(draft.schedule.weekly.timeZone),
              onChange: (value) => patch((config) => { config.schedule.weekly.timeZone = value }),
            })),
          h(WeekdayField, {
            label: '周报发送日', value: draft.schedule.weekly.weekdays,
            hint: '可多选，当前：' + snapshot.weekdayText,
            onChange: (value) => patch((config) => { config.schedule.weekly.weekdays = value }),
          }),
          h('div', { className: 'gdr-grid2' },
            h(TextField, {
              label: '日报任务标题', value: draft.schedule.taskTitles.daily,
              hint: '显示在 dsh 任务列表里',
              onChange: (value) => patch((config) => { config.schedule.taskTitles.daily = value }),
            }),
            h(TextField, {
              label: '周报任务标题', value: draft.schedule.taskTitles.weekly,
              onChange: (value) => patch((config) => { config.schedule.taskTitles.weekly = value }),
            })),
          h('div', { className: 'gdr-card-actions' },
            // 两个创建按钮都是次要操作：和「保存」不同级，不用强调样式
            h('button', {
              className: 'gdr-btn', type: 'button',
              disabled: busy || taskBusy !== '',
              onClick: () => void createTask('daily'),
            }, taskBusy === 'daily' ? '创建中…' : '创建日报定时任务'),
            h('button', {
              className: 'gdr-btn', type: 'button',
              disabled: busy || taskBusy !== '',
              onClick: () => void createTask('weekly'),
            }, taskBusy === 'weekly' ? '创建中…' : '创建周报定时任务'),
            h('button', {
              className: 'gdr-btn', type: 'button', disabled: taskBusy !== '',
              onClick: () => void refreshTasks(),
            }, '刷新任务列表')),
          h('div', { className: 'gdr-field' },
            h('span', { className: 'gdr-label' }, '已创建的定时任务'),
            tasks.length === 0
              ? h('p', { className: 'gdr-hint' }, '还没有创建定时任务')
              : h('div', { className: 'gdr-field' }, tasks.map((task) => h('div', {
                  className: 'gdr-task', key: task.id,
                },
                  h('div', { className: 'gdr-task-main' },
                    h('div', null,
                      h('b', null, task.type === 'weekly' ? '周报' : '日报'), ' · ', task.title),
                    h('div', { className: 'gdr-task-sub' }, describeTask(task))),
                  h('button', {
                    className: 'gdr-btn', type: 'button', disabled: taskBusy !== '',
                    onClick: () => void cancelTask(task),
                  }, taskBusy === task.id ? '取消中…' : '取消')))))),
          // 兜底指令不再常驻页面：只有直接创建失败时，才在弹层里给出可复制的指令

        // 校验与状态
        h('section', { className: 'gdr-card' },
          h('h4', { className: 'gdr-card-h' }, '校验与状态'),
          h(ToggleField, {
            label: '发送前校验正文', value: draft.validation.enabled,
            hint: '检查标题、序号连续，不合格直接拒发，避免把半成品发到群里',
            onChange: (value) => patch((config) => { config.validation.enabled = value }),
          }),
          // 解释器只影响本页「测试此通道」的试发，定时推送由 agent 用自己的环境执行脚本；
          // 放在校验与状态区，避免被当成定时推送的必需项
          h(TextField, {
            label: 'Python 解释器', value: draft.runtime.pythonPath,
            hint: '仅用于本页「测试此通道」试发；留 python 即可，用虚拟环境时填绝对路径',
            onChange: (value) => patch((config) => { config.runtime.pythonPath = value }),
          }),
          h('div', { className: 'gdr-meta' },
            h('div', null, '配置文件：', h('b', null, snapshot.configPath),
              snapshot.existed ? '' : '（尚未生成，保存后创建）'),
            h('div', null, '推送脚本：', h('b', null, snapshot.scriptPath),
              snapshot.scriptExists ? '' : '（缺失）'),
            h('div', null, '可用通道：',
              h('b', null, snapshot.channels.length === 0 ? '无' : snapshot.channels.join('、'))))),

        h('div', { className: 'gdr-actions' },
          h('button', {
            className: 'gdr-btn gdr-btn-primary', type: 'button', disabled: busy,
            onClick: () => void run('push-save', { config: draft }),
          }, busy ? '处理中…' : '保存'),
          h('button', {
            className: 'gdr-btn', type: 'button', disabled: busy,
            onClick: () => void run('push-reset', null),
          }, '恢复默认'),
          h('button', {
            className: 'gdr-btn', type: 'button', disabled: busy,
            onClick: () => void load(),
          }, '重新载入')),

        // 创建失败的降级弹层：确认（我自己粘贴）/ 重试 / 取消，三选一
        failPrompt === null ? null : h('div', { className: 'gdr-modal-mask' },
          h('div', { className: 'gdr-modal' },
            h('h4', { className: 'gdr-card-h' }, `${failPrompt.label}定时任务没有创建成功`),
            h('p', { className: 'gdr-sub' }, `原因：${failPrompt.reason === '' ? '未知' : failPrompt.reason}`),
            h('p', { className: 'gdr-sub' },
              '可以把下面这段指令粘贴到任意 dsh 会话里，由它代为创建同样的定时任务。'),
            h('pre', { className: 'gdr-code' },
              (failPrompt.instruction === '' ? (snapshot.scheduleInstruction ?? '') : failPrompt.instruction)
                || '暂无可用指令'),
            h('div', { className: 'gdr-actions' },
              h('button', {
                className: 'gdr-btn gdr-btn-primary', type: 'button',
                onClick: () => {
                  const text = failPrompt.instruction === ''
                    ? (snapshot.scheduleInstruction ?? '')
                    : failPrompt.instruction
                  setFailPrompt(null)
                  void copyInstruction(text)
                },
              }, '确认，我自己粘贴'),
              h('button', {
                className: 'gdr-btn', type: 'button', disabled: taskBusy !== '',
                onClick: () => {
                  const type = failPrompt.type
                  setFailPrompt(null)
                  void createTask(type)
                },
              }, '重试'),
              h('button', {
                className: 'gdr-btn', type: 'button',
                onClick: () => setFailPrompt(null),
              }, '取消')))))
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
        // 「报告设置」与「自动推送」合成一页，由壳内的切换条分区：
        // 导航项少一个，两页共用同一处版本号与更新入口
        () => h(SettingsShell, null),
      )))
    }

    exports.name = 'git-daily-weekly-report'
    // 缺了它运行时会立刻调用 apply，那时 slot 服务还没发布，设置页会静默不注册
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
