// dsh-plugin-manager 浏览器 half（官方 __ModuleLoader__.load 契约，无构建步骤）。
//
// 手写为官方 lazy-CJS factory 格式：window.__ModuleLoader__.load({ id, factory }),
// factory 收到 loader 注入的 require（'react' 走平台种子模块表，与宿主渲染器共享实例），
// 返回 { name, inject, apply }。apply(ctx) 收到 client 根 ctx：
//   - ctx.slots / ctx.effect —— 由内核提供；
//   - ctx.settingsScope —— 声明 inject '@deepseek-ai/dsh-client-ui-settings' 后可用；
// 本文件不得 import 任何浏览器外模块，保持自包含（react 除外）。
//
// 页面：在「设置 → 插件」分区注册「插件管理」标签页 ——
//   粘贴整行 dsh plugin 安装命令（或 github:owner/repo#分支）→ 写 pending；
//   宿主 half 经 settings 通道收到后执行 pnpm，回写 busy/result/installed；
//   本页订阅同一 settingsScope 快照，自动刷新列表与结果。

window.__ModuleLoader__.load({
  id: 'dsh-plugin-manager',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    var NS = 'plugin-manager';

    // ------------------------------------------------------------------
    // 纯解析（与 lib/pm-core.mjs 语义一致，浏览器侧只做展示用提示）
    // ------------------------------------------------------------------
    var VERB_ALIASES = { add: 'add', install: 'add', rm: 'remove', remove: 'remove', uninstall: 'remove', up: 'update', update: 'update' };

    function looksLikeDshLine(text) {
      return /^\s*dsh\s+plugin\b/i.test(String(text || ''));
    }

    function isPlaceholderTarget(token) {
      return /^<[^>]+>$/.test(String(token || '').trim());
    }

    function looksLikeGithubUrl(text) {
      return /^https?:\/\/github\.com\//i.test(String(text || '').trim());
    }

    function githubUrlShort(raw) {
      // https://github.com/owner/repo(…/tree/branch|#branch) → github:owner/repo[#branch]
      var m = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\/tree\/([\w./-]+)|#([\w./-]+))?/.exec(String(raw || '').trim());
      if (m === null) return raw;
      var ref = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : undefined);
      return 'github:' + m[1] + '/' + m[2] + (ref !== undefined ? '#' + ref : '');
    }

    function localParse(text) {
      var raw = String(text || '').trim();
      if (raw === '') return { verb: 'add', targets: [] };
      if (!looksLikeDshLine(raw)) return { verb: 'add', targets: [raw] };
      var rest = raw.replace(/^\s*dsh\s+plugin\b/i, '').trim();
      var profile = undefined;
      var m = /--profile\s+([\w.-]+)/.exec(rest);
      if (m !== null) { profile = m[1]; rest = rest.replace(/--profile\s+([\w.-]+)/, '').trim(); }
      var tokens = rest.split(/\s+/).filter(Boolean);
      if (tokens.length === 0) return { verb: 'add', targets: [] };
      var verb = VERB_ALIASES[String(tokens[0]).toLowerCase()] || 'add';
      return { verb: verb, profile: profile, targets: tokens.slice(1) };
    }

    function githubShort(raw) {
      var trimmed = String(raw || '').trim();
      if (looksLikeGithubUrl(trimmed)) return githubUrlShort(trimmed);
      var m = /^([\w.-]+)\/([\w.-]+)(?:#([\w./-]+))?$/.exec(trimmed);
      if (m === null || trimmed.split('/').length !== 2) return raw;
      return 'github:' + m[1] + '/' + m[2] + (m[3] ? '#' + m[3] : '');
    }

    /** 本地展示用：把一段输入转换成"将要安装的 spec"提示（尽力而为，真实解析以宿主为准）。 */
    function previewSpec(text) {
      var raw = String(text || '').trim();
      if (raw === '') return null;
      // 整行命令里取 add 目标
      var parsed = localParse(raw);
      if (parsed.verb !== 'add' || parsed.targets.length === 0) return null;
      var candidate = parsed.targets[0];
      if (isPlaceholderTarget(candidate)) {
        // README 占位 <本项目路径>：尝试从整段文本提取 github 链接
        var urlMatch = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+/.exec(raw);
        if (urlMatch === null) return null;
        candidate = urlMatch[0];
      }
      var spec = githubShort(candidate);
      return spec === candidate ? candidate : spec;
    }

    // ------------------------------------------------------------------
    // 轻量样式（跟随设置面板既有观感；数据插件标签不引入 primitives 依赖）
    // ------------------------------------------------------------------
    var CSS = [
      '[data-plugin-manager-root] { display:flex; flex-direction:column; gap:14px; padding:2px 2px 18px; font-size:13px; line-height:1.55; color:var(--dsh-fg, #24292f); }',
      '[data-plugin-manager-root] h3 { margin:0 0 6px; font-size:13px; font-weight:600; }',
      '[data-plugin-manager-root] textarea { width:100%; min-height:74px; box-sizing:border-box; resize:vertical; font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; padding:8px 10px; border:1px solid var(--dsh-border,#d0d7de); border-radius:8px; background:var(--dsh-input-bg,#fff); color:inherit; }',
      '[data-plugin-manager-root] .pm-row { display:flex; gap:8px; align-items:flex-start; }',
      '[data-plugin-manager-root] .pm-row button { flex:0 0 auto; }',
      '[data-plugin-manager-root] button { font:inherit; padding:5px 12px; border-radius:8px; border:1px solid var(--dsh-border,#d0d7de); background:var(--dsh-btn-bg,#f6f8fa); color:inherit; cursor:pointer; }',
      '[data-plugin-manager-root] button:hover:not(:disabled) { background:var(--dsh-btn-bg-hover,#eef1f4); }',
      '[data-plugin-manager-root] button:disabled { opacity:.5; cursor:not-allowed; }',
      '[data-plugin-manager-root] button.primary { background:var(--dsh-accent,#1f6feb); border-color:var(--dsh-accent,#1f6feb); color:#fff; }',
      '[data-plugin-manager-root] button.danger { color:#cf222e; border-color:#cf222e; background:transparent; }',
      '[data-plugin-manager-root] .pm-meta { font-size:12px; color:var(--dsh-fg-weak,#57606a); }',
      '[data-plugin-manager-root] .pm-card { border:1px solid var(--dsh-border,#d0d7de); border-radius:10px; padding:10px 12px; background:var(--dsh-card-bg,#fff); display:flex; flex-direction:column; gap:8px; }',
      '[data-plugin-manager-root] .pm-card .head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }',
      '[data-plugin-manager-root] .pm-card .name { font-weight:600; }',
      '[data-plugin-manager-root] .pm-tag { font-size:11px; padding:1px 8px; border-radius:999px; border:1px solid var(--dsh-border,#d0d7de); }',
      '[data-plugin-manager-root] .pm-tag.on { color:#1a7f37; border-color:#1a7f37; }',
      '[data-plugin-manager-root] .pm-tag.off { color:#9a6700; border-color:#9a6700; }',
      '[data-plugin-manager-root] .pm-spec { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; color:var(--dsh-fg-weak,#57606a); word-break:break-all; }',
      '[data-plugin-manager-root] .pm-result { white-space:pre-wrap; font-size:12px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; background:var(--dsh-code-bg,#f6f8fa); border:1px solid var(--dsh-border,#d0d7de); border-radius:8px; padding:8px 10px; max-height:220px; overflow:auto; }',
      '[data-plugin-manager-root] .pm-empty { color:var(--dsh-fg-weak,#57606a); padding:8px 0; }',
      '[data-plugin-manager-root] .pm-busy { display:flex; gap:8px; align-items:center; color:var(--dsh-accent,#1f6feb); }',
      '[data-plugin-manager-root] .pm-spin { width:12px; height:12px; border-radius:50%; border:2px solid currentColor; border-top-color:transparent; animation:pm-spin .8s linear infinite; }',
      '@keyframes pm-spin { to { transform: rotate(360deg); } }',
    ].join('\n');

    // ------------------------------------------------------------------
    // UI 组件
    // ------------------------------------------------------------------
    var e = React.createElement;

    function PluginManagerTab(props) {
      var scope = props.scope;
      var useSyncExternalStore = React.useSyncExternalStore;
      // 实例方法需绑定 this 后再交给 useSyncExternalStore，否则挂载时 TypeError。
      var getSnapshot = React.useCallback(function () { return scope ? scope.getSnapshot() : { status: 'loading', value: {} }; }, [scope]);
      var subscribe = React.useCallback(function (listener) {
        if (!scope || typeof scope.subscribe !== 'function') return function () {};
        return scope.subscribe(listener);
      }, [scope]);
      var snapshot = useSyncExternalStore(subscribe, getSnapshot);
      var value = snapshot && snapshot.value ? snapshot.value : {};
      var status = snapshot ? snapshot.status : 'loading';
      var writable = snapshot ? snapshot.writable : false;
      var busy = value.busy === true;
      var pending = value.pending || null;
      var resultText = decodeResult(value.result);
      var installedPayload = decodeJson(value.installed);
      var [draft, setDraft] = React.useState('');
      var [localError, setLocalError] = React.useState(null);

      var installed = (installedPayload && installedPayload.installed) || [];
      var envMeta = installedPayload
        ? 'profile: ' + (installedPayload.profile || '?') + (installedPayload.home ? '  ·  目录: ' + installedPayload.home : '')
        : null;

      function run(op, arg) {
        if (busy) return;
        setLocalError(null);
        scope.set('pending', { op: op, arg: arg, at: Date.now() }).catch(function (error) {
          setLocalError('发送命令失败：' + String(error && error.message ? error.message : error));
        });
      }

      function onInstallClick() {
        var text = draft.trim();
        if (text === '') { setLocalError('请先粘贴安装命令或仓库地址。'); return; }
        var parsed = localParse(text);
        if (parsed.verb !== 'add') {
          setLocalError('识别为 ' + parsed.verb + ' 操作：请改用下方对应插件的操作按钮。');
          return;
        }
        run('add', text);
      }

      function onRowClick(op, row) {
        if (busy) return;
        if (op === 'remove' && !window.confirm('确认卸载插件 ' + row.name + '？卸载后需要时需重新安装。')) return;
        run(op, row.name);
      }

      return e('div', { 'data-plugin-manager-root': '' },
        e('div', null,
          e('h3', null, '安装插件'),
          e('div', { className: 'pm-row' },
            e('textarea', {
              placeholder: '粘贴安装命令、GitHub 链接或仓库地址，例如：\n\n  dsh plugin --profile web add github:Mungbean-Cake/dsh-plugin-whale-fenggu\n  https://github.com/Mungbean-Cake/dsh-plugin-whale-fenggu\n  dsh plugin --profile web add <本项目路径>\n    （README 占位 + 同段附 GitHub 链接也能识别）\n\n  owner/repo#分支  /  npm 包名',
              value: draft,
              disabled: busy,
              onChange: function (ev) { setDraft(ev.target.value); },
            })
          ),
          e('div', { className: 'pm-row' },
            e('button', { className: 'primary', disabled: busy, onClick: onInstallClick }, busy ? '执行中…' : '安装 / 更新'),
            e('button', { disabled: busy, onClick: function () { run('refresh', ''); } }, '刷新列表'),
            e('span', { className: 'pm-meta' }, '支持命令 / GitHub 链接 / 仓库简写')
          ),
          draft.trim() !== ''
            ? e('div', { className: 'pm-meta' }, previewSpec(draft) !== null
                ? '将安装：' + previewSpec(draft)
                : '（未识别为可直接安装的地址；可粘贴 https://github.com/owner/repo）')
            : null
        ),
        localError !== null ? e('div', { className: 'pm-result' }, localError) : null,

        e('div', null,
          e('h3', null, '已安装插件'),
          busy ? e('div', { className: 'pm-busy' }, e('span', { className: 'pm-spin' }), e('span', null, '正在执行操作，请稍候…')) : null,
          pending !== null && pending !== undefined ? e('div', { className: 'pm-meta' }, '等待执行：' + String(pending.op || '') + ' ' + String(pending.arg || '')) : null,
          renderList(installed, busy, onRowClick)
        ),

        e('div', null,
          e('h3', null, '最近结果'),
          e('div', { className: 'pm-result' }, resultText !== null ? resultText : '（暂无）')
        ),

        e('div', { className: 'pm-meta' },
          envMeta !== null ? e('div', null, envMeta) : null,
          e('div', null, '⚠️ 安装 / 停用 / 启用 / 更新后都需要重启 web 才会生效。'),
          status !== 'ready'
            ? e('div', null, statusHint(status))
            : (!writable ? e('div', null, '当前页面设置不可写（非本机回环访问时宿主持久化关闭），操作按钮将不可用。') : null)
        )
      );
    }

    function renderList(installed, busy, onRowClick) {
      if (installed.length === 0) {
        return e('div', { className: 'pm-empty' }, '还没有第三方插件。装一个试试：在输入框粘贴别人 README 里的 dsh plugin 安装命令。');
      }
      var rows = installed.map(function (row) {
        return e('div', { className: 'pm-card', key: row.name },
          e('div', { className: 'head' },
            e('span', { className: 'name' }, row.name + (row.version ? ' ' + row.version : '')),
            row.enabled
              ? e('span', { className: 'pm-tag on' }, '已启用')
              : e('span', { className: 'pm-tag off' }, '已停用'),
            e('span', { className: 'pm-spec' }, String(row.spec || ''))
          ),
          e('div', { className: 'pm-row' },
            row.enabled
              ? e('button', { disabled: busy, onClick: function () { onRowClick('off', row); } }, '停用')
              : e('button', { disabled: busy, onClick: function () { onRowClick('on', row); } }, '启用'),
            e('button', { disabled: busy, onClick: function () { onRowClick('update', row); } }, '更新'),
            e('button', { className: 'danger', disabled: busy, onClick: function () { onRowClick('remove', row); } }, '卸载')
          )
        );
      });
      return e('div', null, rows);
    }

    function decodeResult(raw) {
      if (raw === undefined || raw === null) return null;
      if (typeof raw === 'string') {
        try {
          var parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            return parsed.text !== undefined ? String(parsed.text) : String(parsed);
          }
        } catch (_) { /* 不是 JSON：按文本展示 */ }
        return raw;
      }
      if (typeof raw === 'object') return raw.text !== undefined ? String(raw.text) : JSON.stringify(raw);
      return String(raw);
    }

    function decodeJson(raw) {
      if (typeof raw !== 'string') return null;
      try {
        var parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch (_) {
        return null;
      }
    }

    function statusHint(status) {
      if (status === 'loading') return '正在读取宿主设置…';
      if (status === 'unavailable') return '宿主尚未提供 plugin-manager 命名空间：请确认插件已装好并重启过 web（宿主 half 需随 profile 启动）。';
      return '设置文档状态：' + String(status);
    }

    // 错误边界：任何渲染期异常都显示出来，避免“空白页”无法诊断。
    var PMBoundary = (function () {
      function PMBoundary(props) {
        React.Component.call(this, props);
        this.state = { error: null };
      }
      PMBoundary.prototype = Object.create(React.Component.prototype);
      PMBoundary.prototype.constructor = PMBoundary;
      PMBoundary.prototype.componentDidCatch = function (error) {
        // eslint-disable-next-line no-console
        console.error('[plugin-manager] tab 渲染错误：', error);
        this.setState({ error: error });
      };
      PMBoundary.prototype.render = function () {
        if (this.state.error !== null) {
          var message = String(this.state.error && this.state.error.message ? this.state.error.message : this.state.error);
          return e('div', { 'data-plugin-manager-root': '' },
            e('h3', null, '插件管理加载失败'),
            e('div', { className: 'pm-result' }, message),
            e('div', { className: 'pm-meta' }, '请把上面的错误信息发给插件作者。')
          );
        }
        return e(PluginManagerTab, this.props);
      };
      return PMBoundary;
    })();

    function SafePluginManagerTab(props) {
      return e(PMBoundary, props);
    }

    // ------------------------------------------------------------------
    // 插件入口
    // ------------------------------------------------------------------
    function apply(ctx) {
      // 幂等守卫：HMR/重复执行不重复注入。
      if (document.querySelector('style[data-plugin-manager-style]') !== null) return;

      var styleEl = document.createElement('style');
      styleEl.setAttribute('data-plugin-manager-style', '');
      styleEl.setAttribute('data-plugin', 'plugin-manager');
      styleEl.textContent = CSS;
      document.head.append(styleEl);

      // 绑定本插件的 settings 命名空间 scope（随插件 fiber 自动释放）。
      var scope;
      try {
        scope = ctx.settingsScope.bind({ namespace: NS });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('[plugin-manager] settingsScope 不可用：' + String(error && error.message ? error.message : error));
      }

      ctx.effect(function () {
        return function () { styleEl.remove(); };
      }, 'plugin-manager: styles');

      if (scope === undefined) return;

      // 「设置 → 插件」分区下的「插件管理」标签页。
      ctx.slots.inject('settings.plugins.tab', function () {
        return ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'plugin-manager',
          order: 25,
          label: function () { return '插件管理'; },
          inject: function () { return { scope: scope }; },
        }, SafePluginManagerTab);
      });
    }

    module.exports = { name: 'dsh-plugin-manager', inject: ['slots', 'settingsScope'], apply: apply };
    return module.exports;
  },
});
