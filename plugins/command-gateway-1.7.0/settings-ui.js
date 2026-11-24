// 指令前置 · 控制台设置页（插件自带的分区）
//
// 这个文件**不是核心代码**：控制台按 plugin.json 里的 settingsUi 声明，
// 用 /plugin-assets/command-gateway/settings-ui.js 动态加载它，挂在设置页的一个分区里。
// 契约（见本目录 README.md）：
//   render(ctx) -> string        返回这块分区的 HTML
//   bind(root, ctx) -> cleanup?  绑定事件；可返回卸载函数
//   read(ctx) -> object|null     把界面上的输入读成"要保存的补丁"（核心的自动保存会调它）
//
// 为什么界面在插件里而不是核心的 ui/app.js 里：界面属于插件。
// 核心只需要知道"插件可以有自己的设置页"这一件事，之后再加指令插件就不用碰核心。

// 自己的插件 id 不写死：设置页的 ctx 里带着（核心按当前清单 id 传进来）
let PLUGIN_ID = 'command-gateway-1.5.0';
const STYLE_ID = 'command-gateway-settings-style';

/** 人的权限下限是 -1（-1 = 一律禁止使用指令）；指令等级一律 ≥ 0。 */
const PERM_MIN_LEVEL = -1;
const MAX_LEVEL = 100000;
/** 指令静默的默认值与上限（和 index.js 里的常量保持一致）。 */
const SILENCE_DEFAULT_SECONDS = 10;
const SILENCE_DEFAULT_HITS = 3;
const SILENCE_MAX_SECONDS = 2592000;   // 一个月
const SILENCE_MAX_HITS = 1000;
const ROUTE_DEFAULT_LEVEL = 1;   // 新接入项的默认权限等级
const NEW_ROW_LEVEL = 0;         // 手动加一行 / 选好友加进来的默认身份：普通成员
const PERM_HEAD_H = 30;          // 权限表表头高度
const PERM_ROW_H = 40;           // 每行占位（行高 + 行距）
const PERM_PAD = 12;             // 权限表上下内边距
const PERM_MAX_H = 900;
const PERM_HEIGHT_KEY = 'cg-perm-height';

/* 元指令：前置自带、不占接入列表。指令词与默认等级必须和插件里的 META_DEFS 一致
   （index.js）—— 改这里就要一起改那里，反之亦然。 */
const META_DEFS = [
  { id: 'help', name: '帮助', words: '帮助、help、指令', fallback: 0 },
  { id: 'permission', name: '权限查询', words: '权限查询、查询权限、perm', fallback: 1 }
];
/** 元指令与前置自带指令的指令词都是保留词：别的插件撞上来会让"谁先命中"变得不可预测。 */
const RESERVED_WORDS = new Set([
  '帮助', 'help', '指令', '权限查询', '查询权限', 'perm',
  '禁言', '解禁', '全体禁言', '全体解禁', '暂停', '继续', '抛骰子', '猜拳'
]);

/* ── 按指令独立白名单 / 参数格式 ─────────────────────────────────────────────
   这套规则与插件目录里的 command-spec.js 是同一套（那边是运行时/CLI 的单一真相）。
   设置页是**浏览器模块**，刻意不 import 插件目录里的 JS：/plugin-assets/ 这条路
   只要有一次取不到，整个分区就渲染不出来；而规则本身很小，重复一份更稳。
   ⚠️ 改这里的口径，记得同步 command-spec.js（反之亦然）—— 与 effectiveRows 的取舍相同。 */
const SCOPE_MODE_INHERIT = 'inherit';
const SCOPE_MODE_STRICT = 'strict';
const DEFAULT_SCOPE = { mode: SCOPE_MODE_INHERIT, groups: [], friends: [] };

function uiNormalizeIdList(raw) {
  const list = Array.isArray(raw) ? raw : (raw != null && raw !== '' ? [raw] : []);
  const out = [];
  const seen = new Set();
  for (const r of list) {
    const isObj = r && typeof r === 'object';
    const id = String(isObj ? (r.id ?? r.qq ?? r.group ?? '') : r).trim();
    if (!/^\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const name = String(isObj ? (r.name ?? '') : '').trim();
    out.push(name ? { id, name } : { id });
  }
  return out;
}

/** 白名单归一化；键不存在（undefined/null）返回 null，空对象 = 显式"跟随全局规则"。 */
function uiNormalizeScope(raw) {
  if (raw === undefined || raw === null) return null;
  const r = (typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const mode = String(r.mode ?? '').trim().toLowerCase() === SCOPE_MODE_STRICT ? SCOPE_MODE_STRICT : SCOPE_MODE_INHERIT;
  return { mode, groups: uiNormalizeIdList(r.groups), friends: uiNormalizeIdList(r.friends) };
}

/** 参数格式归一化；键不存在返回 null。 */
function uiNormalizeArgs(raw) {
  if (raw === undefined || raw === null) return null;
  const r = (typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  return {
    pattern: String(r.pattern ?? '').trim(),
    flags: String(r.flags ?? '').replace(/[^gimsuy]/g, ''),
    strict: r.strict === true,
    usage: String(r.usage ?? '').trim()
  };
}

function uiScopeSummary(scope) {
  const s = uiNormalizeScope(scope) || DEFAULT_SCOPE;
  if (s.mode !== SCOPE_MODE_STRICT) return '跟随全局规则（不限制普通成员）';
  const g = s.groups.length;
  const f = s.friends.length;
  if (!g && !f) return '独立白名单 · 空（普通成员谁都不能用）';
  return `独立白名单 · ${g} 群 / ${f} 好友（群内按群号或发言人 QQ 命中）`;
}

function uiArgsSummary(args) {
  const a = uiNormalizeArgs(args);
  if (!a || !a.strict) return '不校验格式';
  return a.pattern ? `严格要求：/${a.pattern}/` : '严格要求：不带参数';
}

/** 正则写坏了要当场提示，别等保存后指令静默失守。 */
function uiArgsProblem(args) {
  const a = uiNormalizeArgs(args);
  if (!a?.pattern) return null;
  try {
    // eslint-disable-next-line no-new
    new RegExp(a.pattern, a.flags || '');
    return null;
  } catch (error) {
    return `正则无效：${error?.message ?? error}`;
  }
}

/** 覆盖值与声明值是否不同（决定要不要写进覆盖表）。 */
function uiScopeDiffers(scope, declaredScope) {
  const a = uiNormalizeScope(scope) || DEFAULT_SCOPE;
  const b = uiNormalizeScope(declaredScope) || DEFAULT_SCOPE;
  return JSON.stringify(a) !== JSON.stringify(b);
}

function uiArgsDiffers(args, declaredArgs) {
  return JSON.stringify(uiNormalizeArgs(args)) !== JSON.stringify(uiNormalizeArgs(declaredArgs));
}

/** 一行名单的 HTML（群 / 好友共用；.cg-list-* 复用全局名单的样式）。 */
function scopeRowHtml(ctx, id = '', name = '', placeholder = '群号 / QQ号') {
  return `
    <div class="cg-list-row">
      <input class="cg-list-id" value="${ctx.esc(String(id))}" placeholder="${ctx.esc(placeholder)}" inputmode="numeric" />
      <input class="cg-list-name" value="${ctx.esc(String(name))}" placeholder="备注（选填）" />
      <button class="btn btn-small btn-danger" type="button" data-list-act="del">删除</button>
    </div>`;
}

/* 样式跟着界面走：核心的 style.css 里不再有 .cg-* 规则。
   只用到核心已有的 CSS 变量（--border/--muted/--accent…），两套主题自动跟着变。 */
const CSS = `
.cg-section-head {
  display: flex; align-items: center; gap: 12px;
  margin-top: 22px; margin-bottom: 10px;
}
.cg-section-head h3 { margin: 0; }
.cg-section-head .btn { margin-left: auto; }
.cg-ok { color: var(--green); min-height: 16px; }
.cg-warn { color: #e6a23c; min-height: 16px; }
.cg-err { color: #e06666; }
.cg-row {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 12px;
}
.cg-row-head {
  display: flex; align-items: center; gap: 10px;
  margin-bottom: 8px; flex-wrap: wrap;
}
.cg-row-actions { margin-left: auto; display: flex; gap: 6px; }
.cg-calls { display: flex; flex-direction: column; gap: 4px; }
.cg-call {
  display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap;
  padding: 4px 6px; border-radius: 6px; font-size: 12px;
}
.cg-call.is-error { background: rgba(224, 102, 102, .08); }
.cg-call-cmd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

/* 权限表：第一列是行名（默认权限 = 固定文本，其它行 = 可编辑的 QQ 号），
   表头 sticky：表格滚动时列名不跟着跑。 */
.cg-perm-wrap {
  min-height: 70px;
  overflow-y: auto; overflow-x: hidden;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--inset-bg);
  box-shadow: var(--inset-edge);
}
.cg-perm-head, .cg-perm-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 96px 132px 76px;
  gap: 10px; align-items: center;
  padding: 0 10px;
}
.cg-perm-head {
  position: sticky; top: 0; z-index: 2;
  height: 30px;
  font-size: 12px; color: var(--muted);
  background: var(--layer-2, var(--inset-bg));
  border-bottom: 1px solid var(--edge);
}
.cg-perm-rows { display: flex; flex-direction: column; gap: 6px; padding: 6px 0; }
.cg-perm-row { height: 34px; }
.cg-perm-row input { width: 100%; }
.cg-perm-name { color: var(--muted); font-size: 13px; }
.cg-perm-hold { color: var(--faint); text-align: center; }

/* 群黑名单 / 白名单：三列（id / 备注 / 删除），复用权限表的行距手感 */
.cg-list-head, .cg-list-row {
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr) 76px;
  gap: 10px; align-items: center;
  padding: 0 10px;
}
.cg-list-head { height: 26px; font-size: 12px; color: var(--muted); }
.cg-list-rows { display: flex; flex-direction: column; gap: 6px; padding: 4px 0; }
.cg-list-row { height: 34px; }
.cg-list-row input { width: 100%; }

/* 拖拽把手：视觉上是一条短横线，hover 时亮起来告诉用户"这里能拖" */
.cg-perm-grip {
  height: 12px; display: flex; align-items: center; justify-content: center;
  cursor: ns-resize; user-select: none;
}
.cg-perm-grip span {
  width: 46px; height: 4px; border-radius: 2px;
  background: var(--border); transition: background .15s;
}
.cg-perm-grip:hover span { background: var(--accent); }
body.cg-resizing { cursor: ns-resize; user-select: none; }
.cg-perm-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

/* 指令列表：每行默认折叠（只占一行），展开后才露出指令词/别名/超时。
   权限等级与启用勾选框放在标题栏里 —— 它们是最常改的两个东西。 */
.cg-row.cg-compact { padding: 9px 12px; margin-bottom: 8px; }
.cg-row.cg-compact .cg-row-head { margin-bottom: 0; }
.cg-row.cg-compact.is-open { padding-bottom: 12px; }
.cg-toggle {
  width: 18px; height: 18px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  background: none; border: none; cursor: pointer;
  color: var(--muted); font-size: 11px; line-height: 1;
}
.cg-toggle:hover { color: var(--accent); }
.cg-toggle-ghost { cursor: default; visibility: hidden; }
.cg-inline {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 12.5px; color: var(--muted); white-space: nowrap;
}
.cg-inline input[type="number"] { width: 82px; padding: 3px 6px; }
.cg-inline input[type="checkbox"] { margin: 0; }
.cg-row-body { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--edge); }
.cg-row-body[hidden] { display: none; }
.cg-fields { display: flex; gap: 10px; flex-wrap: wrap; }
.cg-fields > label {
  flex: 1 1 150px; display: flex; flex-direction: column; gap: 4px;
  font-size: 12.5px; color: var(--muted);
}
.cg-fields input { width: 100%; }
.cg-meta-row { background: color-mix(in srgb, var(--inset-bg) 60%, transparent); }

/* 批量修改弹窗 */
.cg-batch-head { display: flex; align-items: center; gap: 8px; }
.cg-batch-list {
  max-height: 320px; overflow-y: auto;
  border: 1px solid var(--edge); border-radius: 10px;
  padding: 4px;
}
.cg-batch-ops { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cg-batch-ops label { color: var(--muted); font-size: 13px; }
.cg-batch-ops input { width: 110px; }
.pick-item.is-dim { opacity: .5; }

/* 目录 + 两栏：页面越来越长，左窄栏目录点一下平滑滚到对应段落。 */
.cg-layout { display: flex; gap: 18px; align-items: flex-start; }
.cg-toc {
  flex: 0 0 172px; position: sticky; top: 0; align-self: flex-start;
  display: flex; flex-direction: column; gap: 2px;
  padding: 10px 8px; border: 1px solid var(--border); border-radius: 10px;
  background: color-mix(in srgb, var(--bg-2) 60%, transparent);
}
.cg-toc-title { font-size: 11.5px; color: var(--muted); margin: 0 6px 6px; letter-spacing: .04em; }
.cg-toc-item {
  text-align: left; border: 0; background: none; color: var(--text);
  font: inherit; font-size: 12.5px; padding: 5px 8px; border-radius: 7px; cursor: pointer;
}
.cg-toc-item:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.cg-toc-item.is-active { background: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--accent); font-weight: 600; }
.cg-main { flex: 1; min-width: 0; }
.cg-about {
  margin-top: 22px; padding: 12px 14px; border: 1px dashed var(--border); border-radius: 10px;
  color: var(--muted); font-size: 12.5px; line-height: 1.7;
}
/* 按指令独立白名单 + 参数格式 */
.cg-scope { margin-top: 10px; }
.cg-scope-fields { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 8px; }
.cg-scope-fields[hidden] { display: none; }
.cg-scope-col { flex: 1 1 280px; min-width: 0; }
.cg-scope-head { font-size: 12.5px; color: var(--muted); margin-bottom: 6px; }
.cg-scope-actions { display: flex; gap: 8px; margin-top: 6px; }
.cg-args { margin-top: 12px; }
.cg-args .cg-fields { margin-top: 8px; }
.cg-badge {
  font-size: 11.5px; padding: 1px 7px; border-radius: 999px;
  border: 1px solid var(--edge); color: var(--muted); white-space: nowrap;
}
.cg-badge.is-on { border-color: var(--accent); color: var(--accent); }
.cg-badge[hidden] { display: none; }
@media (max-width: 900px) {
  .cg-layout { flex-direction: column; }
  .cg-toc { position: static; flex-direction: row; flex-wrap: wrap; }
}
`;

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

/** 上一次为哪一次"进入分区"刷过数据（ctx.entrySeq 每次点侧栏 +1）。 */
let lastEntrySeq = -1;
/** 哪些指令行是展开的（默认全部折叠）。键是 `插件id:指令id`，只活在本次页面里。 */
const expandedKeys = new Set();

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function clampLevel(raw, fallback = 0) {
  if (raw === '' || raw === null || raw === undefined) return fallback;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_LEVEL, Math.max(PERM_MIN_LEVEL, n));
}

/** 展示用的权限表：保证「默认权限」行存在（插件那边也会兜这一层）。 */
function permRows(gw) {
  const list = Array.isArray(gw.permissions) ? gw.permissions : [];
  const rows = list.map((r) => {
    // 管理者 = 勾了「管理者」，或等级已经是 100000（两种写法等价，勾选才是给人看的形态）
    const admin = r?.admin === true || Number(r?.level) >= MAX_LEVEL;
    return {
      qq: String(r?.qq ?? ''),
      level: admin ? MAX_LEVEL : clampLevel(r?.level, 0),
      admin,
      unlimited: r?.unlimited === true          // 不受触发次数限制（指令静默的白名单）
    };
  });
  if (!rows.some((r) => r.qq === 'default')) rows.unshift({ qq: 'default', level: 0, admin: false, unlimited: false });
  return rows;
}

/** 元指令权限表：缺行/脏值一律回落到 META_DEFS 的默认等级。 */
function metaRows(gw) {
  const list = Array.isArray(gw.metaCommands) ? gw.metaCommands : [];
  return META_DEFS.map((d) => {
    const row = list.find((r) => String(r?.id ?? '') === d.id);
    return {
      id: d.id,
      permission: clampLevel(row?.permission, d.fallback),
      enabled: row ? row.enabled !== false : true,
      noCount: row?.noCount === true          // 不计入触发次数
    };
  });
}

/**
 * 有效指令表 = 插件清单声明 + 覆盖表。
 *
 * ⚠️ 这里和插件运行时（index.js 的 effectiveRoutes）是同一套合并规则，改一处要改两处。
 * 设置页自己算一份，是为了不必为了渲染一张表再向核心要一个接口。
 */
function effectiveRows(gw, skills) {
  const overrides = Array.isArray(gw.overrides) ? gw.overrides : [];
  const stats = (gw.stats && typeof gw.stats === 'object') ? gw.stats : {};
  const out = [];
  for (const s of skills || []) {
    if (s?.loaded === false || !Array.isArray(s?.commands) || !s.commands.length) continue;
    for (const decl of s.commands) {
      const ov = overrides.find((o) => String(o?.pluginId) === String(s.id) && String(o?.id) === String(decl.id)) || null;
      const declared = {
        word: decl.word || '',
        aliases: Array.isArray(decl.aliases) ? decl.aliases : [],
        permission: decl.permission == null ? ROUTE_DEFAULT_LEVEL : decl.permission,
        timeoutMs: decl.timeoutMs || 0,
        scope: uiNormalizeScope(decl.scope) || DEFAULT_SCOPE,
        args: uiNormalizeArgs(decl.args)
      };
      // 覆盖优先：显式写了 scope/args 就算数（包括把它改回"跟随全局规则"）
      const scope = (ov?.scope !== undefined && ov?.scope !== null)
        ? (uiNormalizeScope(ov.scope) || DEFAULT_SCOPE)
        : declared.scope;
      const args = (ov?.args !== undefined && ov?.args !== null) ? uiNormalizeArgs(ov.args) : declared.args;
      out.push({
        id: decl.id,
        pluginId: s.id,
        capability: decl.capability,
        word: ov?.word || declared.word,
        aliases: ov?.aliases === undefined ? declared.aliases : ov.aliases,
        permission: ov?.permission === undefined ? declared.permission : ov.permission,
        timeoutMs: ov?.timeoutMs === undefined ? declared.timeoutMs : ov.timeoutMs,
        enabled: ov ? ov.enabled !== false : true,
        noCount: ov?.noCount === undefined ? decl.noCount === true : ov.noCount === true,
        scope,
        args,
        customized: !!ov,
        calls: Number(stats[`${s.id}:${decl.id}`]?.calls) || 0,
        description: decl.description,
        argsHint: decl.argsHint,
        examples: decl.examples,
        declared
      });
    }
  }
  return out;
}

/** 原样读界面上的表（含还没填 QQ 的空行），保证下标和用户看到的一致。 */
function readPermDom() {
  return $$('#cg-perm-rows .cg-perm-row').map((row) => {
    const isDefault = row.dataset.default === '1';
    const role = String($('.cg-perm-role', row)?.value || 'member');
    const admin = role === 'admin';
    return {
      qq: isDefault ? 'default' : String($('.cg-perm-qq', row)?.value || '').trim(),
      role,
      // 管理者 / 普通成员都不看数字；只有选「自定义等级…」才读输入框
      level: admin ? MAX_LEVEL : (role === 'custom' ? clampLevel($('.cg-perm-level', row)?.value, 0) : 0),
      admin,
      unlimited: $('.cg-perm-unlimited', row)?.checked === true
    };
  });
}

/** 指令行的「可见范围」→ 权限数值：所有身份 = 0 / 仅管理者 = 100000 / 自定义 = 输入框。 */
function routePermissionOf(row) {
  const kind = String($('.cg-perm-kind[data-route="1"]', row)?.value || 'all');
  if (kind === 'admin') return MAX_LEVEL;
  if (kind === 'all') return 0;
  return clampLevel($('.cg-permission', row)?.value, ROUTE_DEFAULT_LEVEL);
}

/** 读一条指令行里的「独立白名单」：开关 + 两张名单（含还没填完的临时行，交给归一化丢）。 */
function readScopeDom(row) {
  const on = $('.cg-scope-on', row)?.checked === true;
  const readList = (which) => $$(`.cg-scope-rows[data-scope-list="${which}"] .cg-list-row`, row).map((x) => ({
    id: String($('.cg-list-id', x)?.value || '').trim(),
    name: String($('.cg-list-name', x)?.value || '').trim()
  })).filter((x) => /^\d+$/.test(x.id));
  return {
    mode: on ? SCOPE_MODE_STRICT : SCOPE_MODE_INHERIT,
    groups: readList('groups'),
    friends: readList('friends')
  };
}

/** 读一条指令行里的「参数格式」。 */
function readArgsDom(row) {
  return {
    pattern: String($('.cg-args-pattern', row)?.value || '').trim(),
    flags: '',
    strict: $('.cg-args-strict', row)?.checked === true,
    usage: String($('.cg-args-usage', row)?.value || '').trim()
  };
}

/**
 * 让折叠标题上的两个气泡跟着输入**实时**变（不等自动保存、不等整页重绘）：
 *   · 独立白名单：开关状态 + 名单条数
 *   · 严格格式：勾选状态 + 当前正则
 * 顺带把白名单那一行右侧的摘要文字一起刷新。
 */
function refreshRowBadges(row) {
  if (!row || typeof row.querySelector !== 'function') return;
  const scope = readScopeDom(row);
  const args = readArgsDom(row);
  const scopeOn = scope.mode === SCOPE_MODE_STRICT;
  const argsOn = args.strict === true;
  const scopeBadge = row.querySelector('[data-badge="scope"]');
  const argsBadge = row.querySelector('[data-badge="args"]');
  if (scopeBadge) {
    scopeBadge.hidden = !scopeOn;
    scopeBadge.classList.toggle('is-on', scopeOn);
    scopeBadge.title = uiScopeSummary(scope);
  }
  if (argsBadge) {
    argsBadge.hidden = !argsOn;
    argsBadge.classList.toggle('is-on', argsOn);
    argsBadge.title = uiArgsSummary(args);
  }
  const summary = row.querySelector('.cg-scope > .hint');
  if (summary) summary.textContent = uiScopeSummary(scope);
}

/** 过滤出可写入配置的权限表；problems 非空时调用方**不要写**，保留上一次的有效表。 */
function validatePermRows(rows) {
  const out = [];
  const problems = [];
  const seen = new Set();
  for (const r of rows) {
    if (!r.qq) continue;                       // 还没填 QQ 的临时行
    if (r.qq !== 'default' && !/^\d{1,15}$/.test(r.qq)) { problems.push(`「${r.qq}」不是纯数字的 QQ 号`); continue; }
    if (seen.has(r.qq)) { problems.push(`QQ ${r.qq} 重复`); continue; }
    seen.add(r.qq);
    // unlimited = 这个人不参与指令静默（怎么用都不会被静默）
    out.push({
      qq: r.qq,
      level: r.role === 'admin' ? MAX_LEVEL : (r.role === 'member' ? 0 : clampLevel(r.level, 0)),
      ...(r.role === 'admin' ? { admin: true } : {}),
      ...(r.unlimited === true ? { unlimited: true } : {})
    });
  }
  if (!seen.has('default')) out.unshift({ qq: 'default', level: 0 });
  return { rows: out, problems };
}

/** 默认高度正好显示 5 行。 */
function permDefaultHeight() {
  return PERM_HEAD_H + PERM_ROW_H * 5 + PERM_PAD;
}

/** 高度是浏览器本地偏好，不进配置：换台机器回默认值就行。 */
function permStoredHeight() {
  try {
    const n = Number(localStorage.getItem(PERM_HEIGHT_KEY));
    const min = PERM_HEAD_H + PERM_ROW_H + PERM_PAD;
    if (Number.isFinite(n) && n >= min) return Math.min(PERM_MAX_H, Math.round(n));
  } catch { /* 隐私模式/测试沙箱里没有 localStorage */ }
  return permDefaultHeight();
}

/** 刷新按钮旁边的一行反馈；2.5 秒后自己消失（只改文本，不重绘，免得打断输入）。 */
function flash(text, isError = false) {
  const el = $('#cg-flash');
  if (!el) return;
  el.textContent = text;
  el.className = isError ? 'hint cg-warn' : 'hint cg-ok';
  setTimeout(() => {
    const now = $('#cg-flash');
    if (now) now.textContent = '';
  }, 2500);
}

/**
 * 顶部那行"核心补丁状态"。
 *
 * 为什么必须有它：补丁改的是**已经加载进内存**的核心文件，打完要重启才生效。
 * 界面上不写清楚，用户打完补丁发现指令没反应，只会以为插件坏了。
 */
function describePatch(info) {
  if (!info || !info.state) return '核心补丁：还没有检查过（插件启用后会自动检查一次）。';
  const when = String(info.checkedAt || '').replace('T', ' ').slice(0, 16);
  const version = `v${info.version ?? '?'}`;
  if (info.state === 'conflict' || info.applyFailed) {
    const files = (info.conflicts || []).map((c) => `${c.file}（${c.detail || '有冲突'}）`).join('；') || '见日志';
    return `核心补丁：<span class="cg-warn">有冲突，没有自动改动文件</span> —— ${escText(files)}`;
  }
  if (info.state === 'patched') {
    const restart = info.needsRestart ? ' <span class="cg-warn">需要重启软件才生效</span>' : '';
    const changed = (info.changed || []).length ? `，本次改动了 ${escText(info.changed.join('、'))}` : '';
    return `核心补丁：<span class="cg-ok">已打（${version}）</span>${restart}${changed}${when ? ` · 检查于 ${escText(when)}` : ''}`;
  }
  if (info.state === 'clean') {
    return `核心补丁：<span class="cg-ok">已摘除（${version}）</span>，核心文件是干净状态${when ? ` · 检查于 ${escText(when)}` : ''}`;
  }
  return `核心补丁：状态 ${escText(info.state)}${when ? ` · 检查于 ${escText(when)}` : ''}`;
}

/** describePatch 在 render 之前跑，拿不到 ctx.esc —— 这里做一次最小的转义。 */
function escText(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── 渲染 ─────────────────────────────────────────────────────────────────

export function render(ctx) {
  if (ctx?.pluginId) PLUGIN_ID = String(ctx.pluginId);
  const gw = ctx.pluginConfig() || {};
  const skills = ctx.skills() || [];
  const skill = skills.find((s) => s.id === PLUGIN_ID);
  const installed = !!skill;
  const enabled = installed && skill.enabled !== false && skill.loaded !== false;
  const routes = effectiveRows(gw, skills);
  const recent = Array.isArray(gw.recentCalls) ? gw.recentCalls : [];
  const prefix = String(gw.prefix ?? '/') || '/';
  const patchLine = describePatch(gw.patch);
  // 指令静默：默认值 / 上限与 index.js 里的常量保持一致
  const silenceSeconds = Math.min(SILENCE_MAX_SECONDS,
    Math.max(1, Math.round(Number(gw.silenceSeconds ?? SILENCE_DEFAULT_SECONDS)) || SILENCE_DEFAULT_SECONDS));
  const silenceHits = (() => {
    const n = Math.round(Number(gw.silenceHits ?? SILENCE_DEFAULT_HITS));
    return Number.isFinite(n) ? Math.min(SILENCE_MAX_HITS, Math.max(0, n)) : SILENCE_DEFAULT_HITS;
  })();
  // 当前静默中的成员：插件运行时写回一份快照到配置里，这里按"还没到点"过滤一遍
  const silenceLiveHtml = (() => {
    const now = Date.now();
    const live = (Array.isArray(gw.silenceLive) ? gw.silenceLive : []).filter((x) => Number(x?.until) > now);
    if (!live.length) return '当前静默中：暂无';
    return '当前静默中：' + live
      .map((x) => `${ctx.esc(String(x.qq ?? ''))}（剩 ${Math.max(1, Math.ceil((Number(x.until) - now) / 1000))} 秒）`)
      .join('、');
  })();
  /** 本页目录：只列这一页真正有的段落 */
  const TOC_ITEMS = [
    ['sec-basic', '基础设置'],
    ['sec-perm', '权限'],
    ['sec-silence', '指令静默'],
    ['sec-gwhite', '群白名单'],
    ['sec-qqlist', 'QQ 名单'],
    ['sec-routes', '指令'],
    ['sec-mod', '内容检查'],
    ['sec-about', '关于'],
    ['sec-recent', '最近调用']
  ];

  const nameOf = (id) => skills.find((s) => s.id === id)?.name || id;
  const statusOf = (id) => {
    const s = skills.find((x) => x.id === id);
    if (!s) return '插件未安装';
    if (s.loaded === false) return '插件加载失败';
    if (s.enabled === false) return '插件未启用';
    return '';
  };

  // 权限表：**两档身份**（管理者 / 普通成员）+ 可选的「自定义等级…」。
  // 默认权限行固定在第一行、行名不可改、不给删除按钮。
  const permHtml = permRows(gw).map((r) => {
    const isDefault = r.qq === 'default';
    const role = r.admin ? 'admin' : (Number(r.level) === 0 ? 'member' : 'custom');
    return `
      <div class="cg-perm-row" data-default="${isDefault ? '1' : '0'}">
        ${isDefault
          ? '<span class="cg-perm-name" title="不在表里的 QQ 都用这一行">默认权限</span>'
          : `<input class="cg-perm-qq" value="${ctx.esc(r.qq)}" placeholder="QQ 号" inputmode="numeric" />`}
        <select class="cg-perm-role" title="管理者 = 全局身份：所有指令都能用，不受按指令独立白名单限制。普通成员 = 必须命中每条指令自己的可用群 / 可用好友白名单才能用。">
          <option value="member"${role === 'member' ? ' selected' : ''}>普通成员</option>
          <option value="admin"${role === 'admin' ? ' selected' : ''}>管理者</option>
          <option value="custom"${role === 'custom' ? ' selected' : ''}>自定义等级…</option>
        </select>
        <input type="number" class="cg-perm-level" value="${r.level}" min="-1" max="100000" step="1" title="自定义等级：-1 = 一律禁止用指令；只影响指令声明的等级闸，不改变管理者 / 普通成员身份" ${role === 'custom' ? '' : 'hidden'} />
        <label class="cg-inline" title="勾上后这个人不参与指令静默：怎么用都不会被静默">
          <input type="checkbox" class="cg-perm-unlimited" ${r.unlimited ? 'checked' : ''} /> 不受次数限制</label>
        ${isDefault
          ? '<span class="cg-perm-hold" aria-hidden="true">—</span>'
          : '<button class="btn btn-small btn-danger" type="button" data-perm-act="del">删除</button>'}
      </div>`;
  }).join('');

  // 三张全局名单：三列（id / 备注 / 删除）。id 空着 = 还没填的临时行，read() 会丢掉
  const idListRowsHtml = (list, idPlaceholder) => (Array.isArray(list) ? list : []).map((r) => `
      <div class="cg-list-row">
        <input class="cg-list-id" value="${ctx.esc(r?.id ?? '')}" placeholder="${ctx.esc(idPlaceholder)}" inputmode="numeric" />
        <input class="cg-list-name" value="${ctx.esc(r?.name ?? '')}" placeholder="备注（选填）" />
        <button class="btn btn-small btn-danger" type="button" data-list-act="del">删除</button>
      </div>`).join('');

  // 指令行：标题栏放"权限等级 + 启用 + 恢复声明值"，展开后才露出指令词/别名/超时。
  // 默认全部折叠 —— 一个插件声明 8 条指令时，一屏就能看完。
  // 元指令：和普通指令同处一张表，但只有"权限 + 启用"两个可改项（指令词是内置的保留词）
  const metaRowHtml = metaRows(gw).map((m) => {
    const d = META_DEFS.find((x) => x.id === m.id);
    const words = String(d.words || '').split('、').filter(Boolean).map((w) => prefix + w).join(' / ');
    return `
      <div class="cg-row cg-compact cg-meta-row" data-kind="meta" data-id="${ctx.esc(m.id)}" data-plugin-id="${PLUGIN_ID}">
        <div class="cg-row-head">
          <span class="cg-toggle cg-toggle-ghost" aria-hidden="true"></span>
          <span class="tool-name-flow">${ctx.esc(d.name)}</span>
          <span class="muted">${ctx.esc(words)} · 元指令（前置自带，指令词固定）</span>
          <span class="cg-row-actions">
            <label class="cg-inline" title="权限不够的人发出来会被当普通消息放行。所有身份 = 任何触发者都能用；仅管理者 = 只有管理者能用">可见范围
              <select class="cg-perm-kind" data-meta-id="${ctx.esc(m.id)}">
                <option value="all"${Number(m.permission) === 0 ? ' selected' : ''}>所有身份</option>
                <option value="admin"${Number(m.permission) >= 100000 ? ' selected' : ''}>仅管理者</option>
                <option value="custom"${Number(m.permission) !== 0 && Number(m.permission) < 100000 ? ' selected' : ''}>自定义等级…</option>
              </select></label>
            <input type="number" class="cg-meta-level" data-meta-id="${ctx.esc(m.id)}" value="${m.permission}" min="0" max="100000" step="1" ${Number(m.permission) !== 0 && Number(m.permission) < 100000 ? '' : 'hidden'} />
            <label class="cg-inline" title="关掉后它不再响应，消息按普通消息放行"><input type="checkbox" class="cg-meta-enabled" data-meta-id="${ctx.esc(m.id)}" ${m.enabled !== false ? 'checked' : ''} /> 启用</label>
            <label class="cg-inline" title="用它不增加指令静默的计数（静默期内照样会被拦）"><input type="checkbox" class="cg-meta-nocount" data-meta-id="${ctx.esc(m.id)}" ${m.noCount ? 'checked' : ''} /> 不计入次数</label>
          </span>
        </div>
      </div>`;
  }).join('');

  const routeRows = routes.map((r, i) => `
    <div class="cg-row cg-compact ${expandedKeys.has(`${r.pluginId}:${r.id}`) ? 'is-open' : ''}"
      data-kind="plugin" data-index="${i}" data-id="${ctx.esc(r.id)}" data-plugin-id="${ctx.esc(r.pluginId || '')}"
      data-capability="${ctx.esc(r.capability || '')}" data-calls="${Number(r.calls) || 0}"
      data-declared="${ctx.esc(JSON.stringify(r.declared))}">
      <div class="cg-row-head">
        <button class="cg-toggle" type="button" data-cg-act="toggle" title="展开 / 折叠">${expandedKeys.has(`${r.pluginId}:${r.id}`) ? '▾' : '▸'}</button>
        <span class="tool-name-flow">${ctx.esc(nameOf(r.pluginId))}</span>
        <span class="muted">${ctx.esc(prefix + (r.word || ''))} · ${ctx.esc(String(r.pluginId || ''))} / ${ctx.esc(r.id)} · 已调用 ${Number(r.calls) || 0} 次${statusOf(r.pluginId) ? ` · ${ctx.esc(statusOf(r.pluginId))}` : ''}${r.customized ? ' · <span class="cg-ok">已自定义</span>' : ''}</span>
        <span class="cg-badge${r.scope?.mode === SCOPE_MODE_STRICT ? ' is-on' : ''}" data-badge="scope" title="${ctx.esc(uiScopeSummary(r.scope))}"${r.scope?.mode === SCOPE_MODE_STRICT ? '' : ' hidden'}>独立白名单</span>
        <span class="cg-badge${r.args?.strict ? ' is-on' : ''}" data-badge="args" title="${ctx.esc(uiArgsSummary(r.args))}"${r.args?.strict ? '' : ' hidden'}>严格格式</span>
        <span class="cg-row-actions">
          <label class="cg-inline" title="谁有资格触发这条指令：所有身份 = 都能进（普通成员还要再过这条指令自己的白名单）；仅管理者 = 只有管理者能用">可见范围
            <select class="cg-perm-kind" data-route="1">
              <option value="all"${clampLevel(r.permission, ROUTE_DEFAULT_LEVEL) === 0 ? ' selected' : ''}>所有身份</option>
              <option value="admin"${clampLevel(r.permission, ROUTE_DEFAULT_LEVEL) >= 100000 ? ' selected' : ''}>仅管理者</option>
              <option value="custom"${clampLevel(r.permission, ROUTE_DEFAULT_LEVEL) !== 0 && clampLevel(r.permission, ROUTE_DEFAULT_LEVEL) < 100000 ? ' selected' : ''}>自定义等级…</option>
            </select></label>
          <input type="number" class="cg-permission" value="${clampLevel(r.permission, ROUTE_DEFAULT_LEVEL)}" min="0" max="100000" step="1" ${clampLevel(r.permission, ROUTE_DEFAULT_LEVEL) !== 0 && clampLevel(r.permission, ROUTE_DEFAULT_LEVEL) < 100000 ? '' : 'hidden'} />
          <label class="cg-inline" title="关掉这条指令：消息按普通消息放行"><input type="checkbox" class="cg-enabled" ${r.enabled !== false ? 'checked' : ''} /> 启用</label>
          <button class="btn btn-small" type="button" data-cg-act="reset" title="丢弃本地改动，回到插件清单里声明的值"${r.customized ? '' : ' disabled'}>恢复声明值</button>
        </span>
      </div>
      <div class="cg-row-body"${expandedKeys.has(`${r.pluginId}:${r.id}`) ? '' : ' hidden'}>
        ${(r.description || r.argsHint) ? `<div class="hint">${r.argsHint ? `<code>${ctx.esc(prefix + (r.word || '') + ' ' + r.argsHint)}</code> ` : ''}${ctx.esc(r.description || '')}${Array.isArray(r.examples) && r.examples.length ? ` · 例：${ctx.esc(r.examples[0])}` : ''}</div>` : ''}
        <div class="cg-fields">
          <label>指令词（不含前缀）<input class="cg-word" value="${ctx.esc(r.word || '')}" placeholder="如 天气" /></label>
          <label>别名（逗号分隔）<input class="cg-aliases" value="${ctx.esc((Array.isArray(r.aliases) ? r.aliases : []).join(', '))}" placeholder="如 tq, weather" /></label>
          <label title="0 = 用插件声明的超时；没声明就用上面的默认超时">超时（毫秒）<input type="number" class="cg-timeout" value="${Number(r.timeoutMs) || 0}" /></label>
          <label title="用它不增加指令静默的计数（静默期内照样会被拦）">
            <span class="cg-inline"><input type="checkbox" class="cg-nocount" ${r.noCount ? 'checked' : ''} /> 不计入触发次数</span></label>
        </div>

        <div class="cg-scope">
          <label class="cg-inline" title="打开后：普通成员必须命中下面的名单才能用这条指令（两个名单都空 = 普通成员谁都不能用）；管理者与 QQ 白名单成员是全通的，不受名单限制。群聊里「可用群」按群号放行整群、「可用好友 / 成员 QQ」按发言人 QQ 放行本人（在别的群里也生效）；私聊按对方 QQ。它和全局的三张名单（群白名单 / QQ 白名单 / QQ 黑名单）互不影响。">
            <input type="checkbox" class="cg-scope-on" ${r.scope?.mode === SCOPE_MODE_STRICT ? 'checked' : ''} /> 独立白名单（普通成员）
          </label>
          <span class="hint">${ctx.esc(uiScopeSummary(r.scope))}</span>
          <div class="cg-scope-fields"${r.scope?.mode === SCOPE_MODE_STRICT ? '' : ' hidden'}>
            <div class="cg-scope-col">
              <div class="cg-scope-head">可用群 · <span class="muted">群号命中 = 该群所有普通成员可用</span></div>
              <div class="cg-list-rows cg-scope-rows" data-scope-list="groups">
                ${(r.scope?.groups || []).map((x) => scopeRowHtml(ctx, x.id, x.name, '群号')).join('')}
              </div>
              <div class="cg-scope-actions">
                <button class="btn btn-small" type="button" data-cg-act="scope-add" data-list="groups">加一行</button>
                <button class="btn btn-small" type="button" data-cg-act="scope-pick" data-list="groups">选择群</button>
              </div>
            </div>
            <div class="cg-scope-col">
              <div class="cg-scope-head">可用好友 / 成员 QQ · <span class="muted">私聊是他本人；群里按发言人 QQ 命中（跨群生效）</span></div>
              <div class="cg-list-rows cg-scope-rows" data-scope-list="friends">
                ${(r.scope?.friends || []).map((x) => scopeRowHtml(ctx, x.id, x.name, 'QQ号')).join('')}
              </div>
              <div class="cg-scope-actions">
                <button class="btn btn-small" type="button" data-cg-act="scope-add" data-list="friends">加一行</button>
                <button class="btn btn-small" type="button" data-cg-act="scope-pick" data-list="friends">选择好友</button>
              </div>
            </div>
          </div>
        </div>

        <div class="cg-args">
          <label class="cg-inline" title="打开后：参数必须匹配下面的正则，格式不对会回一句用法提示（而不是把垃圾参数丢给模型）。">
            <input type="checkbox" class="cg-args-strict" ${r.args?.strict ? 'checked' : ''} /> 严格要求参数格式
          </label>
          <div class="cg-fields">
            <label title="对「去掉前缀和指令词之后的参数原文」做整串匹配；留空表示这条指令不许带参数。">参数格式（正则，可留空）
              <input class="cg-args-pattern" value="${ctx.esc(r.args?.pattern || '')}" placeholder="如 ^\\d+$ ，留空 = 不许带参数" /></label>
            <label title="格式不对时回给用户的一句话；留空则用上面的用法提示">用法提示
              <input class="cg-args-usage" value="${ctx.esc(r.args?.usage || '')}" placeholder="如 /禁言 &quot;QQ号&quot; [时间]" /></label>
          </div>
          <div class="hint cg-args-hint"></div>
        </div>
      </div>
    </div>`).join('');

  const recentRows = recent.map((r) => `
    <div class="cg-call ${r.ok ? '' : 'is-error'}">
      <span class="muted">${ctx.esc(String(r.at || '').replace('T', ' ').slice(0, 19))}</span>
      <span class="cg-call-cmd">${ctx.esc(prefix + String(r.command || ''))}</span>
      <span>${ctx.esc(String(r.sender || ''))}</span>
      <span class="muted">${ctx.esc(String(r.chatKey || ''))}</span>
      <span class="${r.ok ? 'muted' : 'cg-err'}">${r.ok ? `成功 · ${Number(r.ms) || 0}ms` : `失败：${ctx.esc(String(r.error || ''))}`}</span>
    </div>`).join('');

  return `
    <div class="cg-layout">
    <nav class="cg-toc" id="cg-toc">
      <div class="cg-toc-title">本页目录</div>
      ${TOC_ITEMS.map(([id, label]) => `<button type="button" class="cg-toc-item" data-target="${id}">${ctx.esc(label)}</button>`).join('')}
    </nav>
    <div class="cg-main">
    <div class="cg-section-head" id="sec-basic">
      <h3>指令前置</h3>
      <span class="hint cg-ok" id="cg-flash"></span>
      <button class="btn btn-small" type="button" id="cg-refresh-btn"
        title="重新拉取设置与插件状态（调用记录由插件运行时写回，页面开着时会过期）">刷新</button>
    </div>
    <div class="hint" style="margin-bottom:10px">
      消息进入会话之前先看这里：命中指令就直接执行，不存档、不产生会话记录；没命中的消息照常进入聊天流程。
      指令格式：<code>${ctx.esc(prefix)}指令名 [参数]</code>，例如 <code>${ctx.esc(prefix)}天气 珠海</code>。
      <b>首次启用（或换了新版本）后要重启一次软件</b>：前置需要在核心文件里接一个调用点，运行中的进程改不动已经加载的代码。
    </div>
    <div class="hint" id="cg-patch-line">${patchLine}</div>
    <div class="field"><label>插件开关</label>
      <label class="skill-toggle-row">
        <input type="checkbox" id="cg-enabled" ${enabled ? 'checked' : ''} ${installed ? '' : 'disabled'} />
        <span class="st-text">${installed ? (enabled ? '已启用' : '已关闭') : '未安装或加载失败'}</span>
      </label>
      <div class="hint">关闭后所有指令失效，消息照常进入聊天流程。</div>
    </div>

    <div class="cg-section-head" style="margin-top:22px"><h3 id="sec-perm">权限</h3></div>
    <div class="hint" style="margin-bottom:8px">
      不在表里的 QQ 用「默认权限」那一行的等级。<b>-1 = 不能用任何指令</b>；0~100000 数字越大权限越高。
      「不受次数限制」= 这个人不参与<b>指令静默</b>（怎么用都不会被静默）。
    </div>
    <div class="cg-perm-wrap" id="cg-perm-wrap" style="height:${permStoredHeight()}px">
      <div class="cg-perm-head"><span>QQ号</span><span>权限等级</span><span>不受次数限制</span><span></span></div>
      <div class="cg-perm-rows" id="cg-perm-rows">${permHtml}</div>
    </div>
    <div class="cg-perm-grip" id="cg-perm-grip" title="拖动调整高度（双击恢复默认）"><span></span></div>
    <div class="cg-perm-actions">
      <button class="btn btn-small" type="button" id="cg-perm-add">➕ 添加一行</button>
      <button class="btn btn-small" type="button" id="cg-perm-pick">选择好友</button>
      <span class="hint cg-warn" id="cg-perm-hint"></span>
    </div>

    <div class="field"><label>指令前缀</label>
      <input id="cg-prefix" value="${ctx.esc(prefix)}" maxlength="4" />
      <div class="hint">默认 /。改掉后要用新前缀发指令。</div>
    </div>
    <div class="field"><label>冷却（毫秒）</label>
      <input type="number" id="cg-cooldown" value="${Number(gw.cooldownMs ?? 3000) || 0}" />
      <div class="hint">同一会话同一指令的最小间隔，0 = 关闭。默认 3000（3 秒）；冷却中的连点会被静默忽略。</div>
    </div>
    <div class="field"><label>默认超时（毫秒）</label>
      <input type="number" id="cg-timeout" value="${Number(gw.defaultTimeoutMs ?? 30000) || 30000}" />
      <div class="hint">指令插件没声明超时时用它，默认 30000。超过就回执失败，不让长任务被误判。</div>
    </div>
    <label class="checkbox-row"><input type="checkbox" id="cg-private" ${gw.privateEnabled !== false ? 'checked' : ''} />
      私聊也响应指令</label>

    <div class="cg-section-head" style="margin-top:22px"><h3 id="sec-silence">指令静默</h3></div>
    <div class="hint" style="margin-bottom:8px">
      同一个 QQ 在一个静默期内用掉 <b>触发次数</b> 条指令（元指令也算）就静默一个静默期：
      这段时间他用不了任何指令，<b>正常聊天不受影响</b>；静默时间既是统计窗口、也是封锁时长。
      计数只算<b>真正执行了</b>的指令（权限不足、被冷却吞掉的不算）；触发时清空窗口，解封后从 0 开始。
    </div>
    <div class="field"><label>静默时间（秒）</label>
      <input type="number" id="cg-silence-seconds" value="${silenceSeconds}" min="1" max="${SILENCE_MAX_SECONDS}" step="1" />
      <div class="hint">默认 ${SILENCE_DEFAULT_SECONDS}。最大 ${SILENCE_MAX_SECONDS}（一个月）—— 填满就是"一个月内用满 N 条 → 封一个月"。</div>
    </div>
    <div class="field"><label>触发次数</label>
      <input type="number" id="cg-silence-hits" value="${silenceHits}" min="0" max="${SILENCE_MAX_HITS}" step="1" />
      <div class="hint">默认 ${SILENCE_DEFAULT_HITS}。<b>0 = 关闭这个功能</b>。第 N 次照常执行，从那一刻起封一个静默期。</div>
    </div>
    <div class="hint" id="cg-silence-live">${silenceLiveHtml}</div>

    <div class="cg-section-head" style="margin-top:22px"><h3 id="sec-gwhite">群白名单</h3></div>
    <div class="hint" style="margin-bottom:8px">
      只有名单里的群才响应指令：不在名单的群，<b>指令尝试被静默吞掉</b>（不回执，记进最近调用），普通聊天完全不受影响。
      <b>名单为空 = 哪个群都不能用</b>。<b>管理者</b>与<b>QQ 白名单</b>里的人不受这道闸限制。
    </div>
    <div class="cg-list-head"><span>群号</span><span>群名（备注，选填）</span><span></span></div>
    <div class="cg-list-rows" id="cg-gwhite-rows">${idListRowsHtml(gw.groupWhitelist, '群号') || '<div class="hint" style="padding:0 10px">（名单为空 —— 哪个群都不会响应指令，请把要用的群加进来）</div>'}</div>
    <div class="cg-perm-actions">
      <button class="btn btn-small" type="button" id="cg-gwhite-add">➕ 添加一行</button>
      <button class="btn btn-small" type="button" id="cg-gwhite-pick">选择群</button>
    </div>

    <div class="cg-section-head"><h3 id="sec-qqlist">QQ 名单</h3></div>
    <div class="hint" style="margin-bottom:8px">
      <b>QQ 白名单</b>：全通豁免 —— 不受「群白名单」与「每条指令自己的白名单」限制，能用所有指令。
      <b>QQ 黑名单</b>：<b>最高优先</b> —— 名单里的人一律不能用任何指令，连管理者身份也压不过。
      两张表都只认纯数字 QQ 号。
    </div>
    <div class="cg-list-head"><span>QQ 白名单</span><span>备注（选填）</span><span></span></div>
    <div class="cg-list-rows" id="cg-qw-rows">${idListRowsHtml(gw.qqWhitelist, 'QQ号') || '<div class="hint" style="padding:0 10px">（名单为空）</div>'}</div>
    <div class="cg-perm-actions">
      <button class="btn btn-small" type="button" id="cg-qw-add">➕ 添加一行</button>
      <button class="btn btn-small" type="button" id="cg-qw-pick">选择好友</button>
    </div>
    <div class="cg-list-head" style="margin-top:14px"><span>QQ 黑名单</span><span>备注（选填）</span><span></span></div>
    <div class="cg-list-rows" id="cg-qb-rows">${idListRowsHtml(gw.qqBlacklist, 'QQ号') || '<div class="hint" style="padding:0 10px">（名单为空）</div>'}</div>
    <div class="cg-perm-actions">
      <button class="btn btn-small" type="button" id="cg-qb-add">➕ 添加一行</button>
      <button class="btn btn-small" type="button" id="cg-qb-pick">选择好友</button>
    </div>

    <div class="cg-section-head">
      <h3 id="sec-routes">指令</h3>
      <button class="btn btn-small" type="button" id="cg-batch-btn">批量修改权限</button>
    </div>
    <div class="hint" style="margin-bottom:8px">
      元指令是前置自带的；其余来自各插件清单里的 <code>commands</code> 声明 —— <b>装了就生效</b>，不需要"接入"。
      在这里改动只记差异（覆盖表），插件升级新增指令时你会自动拿到；点左边的 <b>▸</b> 展开改指令词 / 别名 / 超时。
    </div>
    <div id="cg-routes">${metaRowHtml}${routeRows || '<div class="hint">还没有任何插件声明指令。</div>'}</div>
    <div class="hint">用户权限要大于等于该指令权限等级才能使用该指令。</div>
    <div id="cg-dup-hint" class="hint cg-warn"></div>

    <div class="cg-section-head" style="margin-top:22px"><h3 id="sec-mod">内容检查</h3></div>
    <div class="hint" style="margin-bottom:8px">
      给 <code>moderation.check</code> 能力用的规则：别的插件（比如审核类指令）可以直接调它，
      不用自己维护一份词表。每行一条。
    </div>
    <div class="field"><label>关键词（每行一个）</label>
      <textarea id="cg-mod-words" rows="3" style="width:100%">${ctx.esc((gw.moderation?.words || []).join('\n'))}</textarea></div>
    <div class="field"><label>正则（每行一个）</label>
      <textarea id="cg-mod-patterns" rows="3" style="width:100%">${ctx.esc((gw.moderation?.patterns || []).join('\n'))}</textarea>
      <div class="hint">写坏的正则会被跳过，不影响其它规则。</div></div>

    <div class="cg-about" id="sec-about">
      <b>关于</b><br />
      如有 bug 或建议，请来官方群找 <b>林枫灬寒霜</b>（1353446252）说明。
    </div>

    <div class="cg-section-head" style="margin-top:22px"><h3 id="sec-recent">最近调用</h3></div>
    <div class="hint" style="margin-bottom:6px">最多保留 20 条，由插件运行时写回配置。</div>
    <div class="cg-calls">${recentRows || '<div class="hint">暂无记录。</div>'}</div>
    </div>
    </div>`;
}

// ── 自动保存：把界面上的输入读成补丁 ─────────────────────────────────────

/**
 * 核心的自动保存（输入停止 600ms）会调它。返回 null = 这次不写
 * （比如分区已经切走、界面不在了）。
 *
 * 每张表各自校验：有问题的表这一轮不写入，保留上一次的有效值，只把原因写进提示行 ——
 * 别让一个手滑把整页设置都卡住。
 */
export function read(ctx) {
  if (ctx?.pluginId) PLUGIN_ID = String(ctx.pluginId);
  if (!$('#cg-perm-rows') && !$('#cg-routes')) return null;
  const gw = ctx.pluginConfig() || {};
  const patch = {};
  const linesOf = (lines) => `插件设置本次未保存：${[...new Set(lines)].join('；')}`;

  patch.cooldownMs = Math.max(0, Number($('#cg-cooldown')?.value ?? gw.cooldownMs ?? 3000) || 0);
  patch.privateEnabled = $('#cg-private') ? $('#cg-private').checked : gw.privateEnabled !== false;
  patch.defaultTimeoutMs = Math.max(1000, Number($('#cg-timeout')?.value ?? gw.defaultTimeoutMs ?? 30000) || 30000);
  // 指令静默：静默时间（1 秒 ~ 一个月）、触发次数（0 = 关闭）
  patch.silenceSeconds = Math.min(SILENCE_MAX_SECONDS,
    Math.max(1, Math.round(Number($('#cg-silence-seconds')?.value ?? gw.silenceSeconds ?? SILENCE_DEFAULT_SECONDS)) || SILENCE_DEFAULT_SECONDS));
  patch.silenceHits = (() => {
    const n = Math.round(Number($('#cg-silence-hits')?.value ?? gw.silenceHits ?? SILENCE_DEFAULT_HITS));
    return Number.isFinite(n) ? Math.min(SILENCE_MAX_HITS, Math.max(0, n)) : SILENCE_DEFAULT_HITS;
  })();

  // 权限表
  const permRead = validatePermRows(readPermDom());
  const permHint = $('#cg-perm-hint');
  if (permRead.problems.length) {
    if (permHint) permHint.textContent = linesOf(permRead.problems);
  } else if ($('#cg-perm-rows')) {
    if (permHint) permHint.textContent = '';
    patch.permissions = permRead.rows;
  }

  // 三张全局名单：id 空白或非数字的行丢弃（与主进程 idListRows 的口径一致）
  const readIdList = (sel) => $$(sel).map((row) => ({
    id: String($('.cg-list-id', row)?.value || '').trim(),
    name: String($('.cg-list-name', row)?.value || '').trim()
  })).filter((r) => /^\d+$/.test(r.id));
  if ($('#cg-gwhite-rows')) patch.groupWhitelist = readIdList('#cg-gwhite-rows .cg-list-row');
  if ($('#cg-qw-rows')) patch.qqWhitelist = readIdList('#cg-qw-rows .cg-list-row');
  if ($('#cg-qb-rows')) patch.qqBlacklist = readIdList('#cg-qb-rows .cg-list-row');

  // 元指令（和普通指令同处一张表）：可见范围 + 是否启用
  const metas = $$('.cg-perm-kind[data-meta-id]')
    .map((el) => {
      const id = String(el.dataset.metaId || '');
      if (!id) return null;
      const fallback = META_DEFS.find((d) => d.id === id)?.fallback ?? 0;
      const kind = String(el.value || 'all');
      const permission = kind === 'admin'
        ? MAX_LEVEL
        : (kind === 'all' ? 0 : clampLevel($(`.cg-meta-level[data-meta-id="${id}"]`)?.value, fallback));
      const enabled = $(`.cg-meta-enabled[data-meta-id="${id}"]`)?.checked !== false;
      const noCount = $(`.cg-meta-nocount[data-meta-id="${id}"]`)?.checked === true;
      return { id, permission, enabled, ...(noCount ? { noCount: true } : {}) };
    })
    .filter((r) => r && r.id);
  if (metas.length) patch.metaCommands = metas;

  // 内容检查规则
  const lines = (sel) => String($(sel)?.value || '').split('\n').map((x) => x.trim()).filter(Boolean);
  if ($('#cg-mod-words') || $('#cg-mod-patterns')) {
    patch.moderation = { words: lines('#cg-mod-words'), patterns: lines('#cg-mod-patterns') };
  }

  // 指令覆盖表：**只写差异** —— 与清单声明一致的行走不产生覆盖记录，
  // 这样插件升级改了默认值，没动过这一行的用户会自动跟着变。
  const rows = $$('#cg-routes .cg-row[data-kind="plugin"]').map((row) => ({
    pluginId: String(row.dataset.pluginId || ''),
    id: String(row.dataset.id || ''),
    capability: String(row.dataset.capability || ''),
    word: String($('.cg-word', row)?.value || '').trim(),
    aliases: String($('.cg-aliases', row)?.value || '')
      .split(/[,，]/).map((x) => x.trim()).filter(Boolean),
    enabled: $('.cg-enabled', row)?.checked !== false,
    permission: routePermissionOf(row),
    timeoutMs: Math.max(0, Number($('.cg-timeout', row)?.value) || 0),
    noCount: $('.cg-nocount', row)?.checked === true,
    scope: readScopeDom(row),
    args: readArgsDom(row),
    declared: safeJson(row.dataset.declared)
  })).filter((r) => r.pluginId && r.id);

  const prefixRaw = String($('#cg-prefix')?.value ?? gw.prefix ?? '/').trim();
  const problems = [];
  const seenWords = new Set();
  for (const r of rows) {
    if (!r.word && r.aliases.length) problems.push(`${r.pluginId || '未命名'}：填了别名却没填主指令词`);
    for (const w of [r.word, ...r.aliases].filter(Boolean)) {
      const key = w.toLowerCase();
      if (/\s/.test(w)) problems.push(`「${w}」含空格`);
      // 前置自带指令的那几行不受限：用户随时可以给它们改名
      if (r.pluginId !== PLUGIN_ID && RESERVED_WORDS.has(key)) problems.push(`「${w}」是内置指令词`);
      if (seenWords.has(key)) problems.push(`指令词「${w}」重复`);
      seenWords.add(key);
    }
    // 参数格式写坏了必须拦下：否则保存后这条指令的格式校验会静默失效
    const badArgs = uiArgsProblem(r.args);
    if (badArgs) problems.push(`${prefix}${r.word || r.id}：${badArgs}`);
  }
  if (!prefixRaw || /\s/.test(prefixRaw)) problems.push('前缀不能为空或含空格');
  else patch.prefix = prefixRaw;

  const routeHint = $('#cg-dup-hint');
  if (problems.length) {
    if (routeHint) routeHint.textContent = linesOf(problems);
  } else if ($('#cg-routes')) {
    if (routeHint) routeHint.textContent = '';
    patch.overrides = rows.filter((r) => isCustomized(r)).map((r) => ({
      pluginId: r.pluginId,
      id: r.id,
      word: r.word,
      aliases: r.aliases,
      permission: r.permission,
      timeoutMs: r.timeoutMs,
      // 指令静默白名单：只记差异 —— 勾了才写这个键
      ...(r.noCount === true ? { noCount: true } : {}),
      ...(r.enabled === false ? { enabled: false } : {}),
      // 独立白名单 / 参数格式：同样只记差异（与声明一致就不写，插件升级改了默认值能自动跟上）
      ...(uiScopeDiffers(r.scope, r.declared?.scope) ? { scope: r.scope } : {}),
      ...(uiArgsDiffers(r.args, r.declared?.args) ? { args: r.args } : {})
    }));
  }
  return patch;
}

/** 这一行和清单声明比，用户改过什么没有？ */
function isCustomized(row) {
  const d = row.declared || {};
  if (row.enabled === false) return true;
  if ((row.word || '') !== String(d.word || '')) return true;
  if (JSON.stringify(row.aliases || []) !== JSON.stringify(d.aliases || [])) return true;
  if (Number(row.permission) !== Number(d.permission ?? ROUTE_DEFAULT_LEVEL)) return true;
  if (Number(row.timeoutMs || 0) !== Number(d.timeoutMs || 0)) return true;
  if ((row.noCount === true) !== (d.noCount === true)) return true;
  // 独立白名单 / 参数格式：与声明不同才算自定义（否则插件升级改了默认值会自动跟上）
  if (uiScopeDiffers(row.scope, d.scope)) return true;
  if (uiArgsDiffers(row.args, d.args)) return true;
  return false;
}

function safeJson(text) {
  try { return JSON.parse(String(text || '{}')) || {}; } catch { return {}; }
}

// ── 交互 ─────────────────────────────────────────────────────────────────

export function bind(root, ctx) {
  injectStyle();

  // 本页目录：点一下平滑滚到对应段落（顺手把"当前点的那一项"标出来）。
  // 目录项是页面里的一排按钮，逐个挂监听；root 卸载时它们跟着一起走。
  for (const btn of root?.querySelectorAll?.('.cg-toc-item') || []) {
    btn.addEventListener('click', () => {
      const target = document.getElementById(String(btn.dataset?.target || ''));
      target?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      for (const b of root.querySelectorAll('.cg-toc-item')) b.classList.remove('is-active');
      btn.classList.add('is-active');
    });
  }

  // 用户每次重新点进这个分区：静默重拉一次（调用记录、累计次数是插件运行时写回配置的）
  if (lastEntrySeq !== ctx.entrySeq) {
    lastEntrySeq = ctx.entrySeq;
    refresh(ctx, { silent: true });
  }

  $('#cg-refresh-btn')?.addEventListener('click', () => refresh(ctx));

  const toggle = $('#cg-enabled');
  toggle?.addEventListener('change', async () => {
    const label = toggle.parentElement?.querySelector('.st-text');
    if (label) label.textContent = toggle.checked ? '已启用' : '已关闭';
    toggle.disabled = true;
    try {
      await ctx.setEnabled(toggle.checked);
    } catch (error) {
      console.error('切换指令前置失败:', error);
      flash('切换失败，详情见控制台', true);
    } finally {
      toggle.disabled = false;
      await ctx.rerender();
    }
  });

  $$('#cg-routes [data-cg-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = btn.closest('.cg-row');
      if (!row) return;
      const act = btn.dataset.cgAct;

      // 展开/折叠：只动 DOM 与一份内存状态，不重绘 —— 重绘会把没保存的输入吃掉
      if (act === 'toggle') {
        const body = $('.cg-row-body', row);
        if (!body) return;
        const open = body.hidden;
        body.hidden = !open;
        row.classList.toggle('is-open', open);
        btn.textContent = open ? '▾' : '▸';
        const key = `${row.dataset.pluginId}:${row.dataset.id}`;
        if (open) expandedKeys.add(key); else expandedKeys.delete(key);
        return;
      }
      if (act !== 'reset') return;
      // 「恢复声明值」= 丢掉这一条的覆盖记录（不是删掉指令本身）
      saveOverrides(ctx, (list) => {
        const at = list.findIndex((o) => String(o?.pluginId) === String(row.dataset.pluginId)
          && String(o?.id) === String(row.dataset.id));
        if (at >= 0) list.splice(at, 1);
      });
    });
  });

  // ── 指令行内的「独立白名单 / 参数格式」 ─────────────────────────────────
  // 名单行的增删直接动 DOM、不重绘：值由 600ms 防抖的自动保存经 read() 收走，
  // 免得"点一下加一行"就把用户还没敲完的其它输入冲掉。
  const routesBox = root?.querySelector?.('#cg-routes');
  routesBox?.addEventListener('click', (e) => {
    const del = e.target.closest?.('.cg-scope-rows [data-list-act="del"]');
    if (del) {
      const row = del.closest('.cg-row');
      del.closest('.cg-list-row')?.remove();
      refreshRowBadges(row);          // 名单条数变了，气泡摘要也跟着变
      return;
    }
    const add = e.target.closest?.('[data-cg-act="scope-add"]');
    if (add) {
      const row = add.closest('.cg-row');
      const box = row?.querySelector(`.cg-scope-rows[data-scope-list="${add.dataset.list}"]`);
      if (box) box.insertAdjacentHTML('beforeend', scopeRowHtml(ctx, '', '', add.dataset.list === 'groups' ? '群号' : 'QQ号'));
      refreshRowBadges(row);
      return;
    }
    const pick = e.target.closest?.('[data-cg-act="scope-pick"]');
    if (pick) openScopePicker(ctx, pick.closest('.cg-row'), pick.dataset.list);
  });
  // 手打名单里的 QQ / 群号：条数摘要要跟着变（空行不算数，填进去才算）
  routesBox?.addEventListener('input', (e) => {
    if (e.target.closest?.('.cg-scope-rows .cg-list-id')) refreshRowBadges(e.target.closest('.cg-row'));
  });
  // 独立白名单开关：切换名单区显示，并**立刻**刷新折叠标题上的气泡
  $$('#cg-routes .cg-scope-on').forEach((el) => el.addEventListener('change', () => {
    const row = el.closest('.cg-row');
    const fields = el.closest('.cg-scope')?.querySelector('.cg-scope-fields');
    if (fields) fields.hidden = !el.checked;
    refreshRowBadges(row);
  }));
  // 严格格式开关：同样立刻刷新气泡
  $$('#cg-routes .cg-args-strict').forEach((el) => el.addEventListener('change', () => {
    refreshRowBadges(el.closest('.cg-row'));
  }));
  // 参数格式：当场校验正则，写坏了立刻提示（保存时 read() 还会再拦一次）；气泡摘要同步
  $$('#cg-routes .cg-args-pattern').forEach((el) => el.addEventListener('input', () => {
    const box = el.closest('.cg-args');
    const hintEl = box?.querySelector('.cg-args-hint');
    const strict = box?.querySelector('.cg-args-strict')?.checked === true;
    if (hintEl) {
      const problem = uiArgsProblem({ pattern: el.value });
      hintEl.textContent = problem || (strict && !String(el.value).trim() ? '留空 = 这条指令不许带参数' : '');
      hintEl.className = problem ? 'hint cg-warn' : 'hint';
    }
    refreshRowBadges(el.closest('.cg-row'));
  }));

  $('#cg-perm-add')?.addEventListener('click', () => {
    savePerm(ctx, (rows) => rows.push({ qq: '', level: NEW_ROW_LEVEL }));
  });
  // 身份下拉：管理者 / 普通成员都不看数字；只有「自定义等级…」才露出输入框
  $$('#cg-perm-rows .cg-perm-role').forEach((el) => el.addEventListener('change', () => {
    const row = el.closest('.cg-perm-row');
    const levelInput = $('.cg-perm-level', row);
    if (!levelInput) return;
    const custom = el.value === 'custom';
    levelInput.hidden = !custom;
    if (!custom) levelInput.value = el.value === 'admin' ? String(MAX_LEVEL) : '0';
  }));
  // 指令行 / 元指令行的「可见范围」下拉：同上，只有自定义才显示数字框
  $$('.cg-perm-kind').forEach((el) => el.addEventListener('change', () => {
    const row = el.closest('.cg-row') || el.closest('.cg-perm-row') || document;
    const levelInput = el.dataset?.metaId
      ? $(`.cg-meta-level[data-meta-id="${el.dataset.metaId}"]`, row)
      : $('.cg-permission', row);
    if (!levelInput) return;
    const custom = el.value === 'custom';
    levelInput.hidden = !custom;
    if (!custom) levelInput.value = el.value === 'admin' ? String(MAX_LEVEL) : '0';
  }));
  $$('#cg-perm-rows [data-perm-act="del"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = btn.closest('.cg-perm-row');
      const idx = $$('#cg-perm-rows .cg-perm-row').indexOf(row);
      if (idx < 0) return;
      savePerm(ctx, (rows) => rows.splice(idx, 1));
    });
  });
  $('#cg-perm-pick')?.addEventListener('click', () => { openFriendPicker(ctx); });
  // 三张全局名单：群白名单 / QQ 白名单 / QQ 黑名单（容器 id ↔ 配置键 一一对应）
  const ID_LISTS = [
    { key: 'groupWhitelist', id: 'cg-gwhite-rows', endpoint: 'groups' },
    { key: 'qqWhitelist', id: 'cg-qw-rows', endpoint: 'friends' },
    { key: 'qqBlacklist', id: 'cg-qb-rows', endpoint: 'friends' }
  ];
  const listOf = (id) => ID_LISTS.find((l) => l.id === id) || null;
  for (const list of ID_LISTS) {
    $(`#${list.id.replace('-rows', '-add')}`)?.addEventListener('click', () => {
      saveIdList(ctx, list.key, `#${list.id}`, (rows) => rows.push({ id: '', name: '' }));
    });
    $(`#${list.id.replace('-rows', '-pick')}`)?.addEventListener('click', () => { openIdListPicker(ctx, list); });
  }
  $$(`#${ID_LISTS.map((l) => l.id).join(' [data-list-act="del"], #')} [data-list-act="del"]`).forEach((btn) => {
    btn.addEventListener('click', () => {
      const container = btn.closest('.cg-list-rows');
      const meta = listOf(container?.id);
      if (!meta || !container) return;
      const rows = [...container.querySelectorAll('.cg-list-row')];
      const idx = rows.indexOf(btn.closest('.cg-list-row'));
      if (idx < 0) return;
      saveIdList(ctx, meta.key, `#${container.id}`, (list) => list.splice(idx, 1));
    });
  });
  $('#cg-batch-btn')?.addEventListener('click', () => { openBatchModal(ctx); });
  bindPermResize();

  return () => { /* 目前没有需要清理的全局监听：拖拽的监听只在按下时临时挂 */ };
}

// ── 动作 ─────────────────────────────────────────────────────────────────

/** 重新拉配置与插件状态 → 重绘。手动点刷新时先把界面上没落盘的输入存一次。 */
async function refresh(ctx, { silent = false } = {}) {
  try {
    const draft = read(ctx);
    if (draft) await ctx.save(draft);
  } catch { /* 保存失败也要继续刷新 */ }
  try {
    await ctx.reload();
    if (!silent) flash('已刷新');
  } catch (error) {
    console.error('刷新指令前置失败:', error);
    if (!silent) flash('刷新失败，详情见控制台', true);
  }
}

/** 改覆盖表：改配置 → 立即保存 → 重绘（列表操作没有"输入后再保存"的概念）。 */
async function saveOverrides(ctx, mutator) {
  const gw = ctx.pluginConfig() || {};
  const list = Array.isArray(gw.overrides) ? JSON.parse(JSON.stringify(gw.overrides)) : [];
  mutator(list);
  try {
    await ctx.save({ overrides: list });
  } catch (error) {
    console.error('保存覆盖表失败:', error);
    flash('保存失败，详情见控制台', true);
  }
  await ctx.rerender();
}

/** 给某条指令写一条覆盖记录（没有就新建）。 */
function upsertOverride(list, row, patch) {
  const at = list.findIndex((o) => String(o?.pluginId) === String(row.pluginId) && String(o?.id) === String(row.id));
  const next = {
    pluginId: row.pluginId,
    id: row.id,
    word: row.word,
    aliases: row.aliases,
    permission: row.permission,
    timeoutMs: row.timeoutMs,
    ...(row.enabled === false ? { enabled: false } : {}),
    // 独立白名单 / 参数格式：批量改权限时不能把这两样丢掉
    ...(row.scope !== undefined && uiScopeDiffers(row.scope, row.declared?.scope) ? { scope: row.scope } : {}),
    ...(row.args !== undefined && uiArgsDiffers(row.args, row.declared?.args) ? { args: row.args } : {}),
    ...patch
  };
  if (at >= 0) list[at] = next;
  else list.push(next);
}

/** 改权限表：先把界面上的表读回内存（别丢掉刚输入的值）→ 改 → 立即保存 → 重绘。 */
async function savePerm(ctx, mutator) {
  const list = readPermDom();
  if (!list.length) list.push({ qq: 'default', level: 0 });
  if (!list.some((r) => r.qq === 'default')) list.unshift({ qq: 'default', level: 0 });
  mutator(list);
  try {
    await ctx.save({ permissions: list });
  } catch (error) {
    console.error('保存权限表失败:', error);
    flash('保存失败，详情见控制台', true);
  }
  await ctx.rerender();
}

/** 改三张全局名单：与 savePerm 同一套路 —— 读回当前 DOM → 改 → 保存 → 重绘。 */
async function saveIdList(ctx, key, containerSel, mutator) {
  const list = $$(containerSel).map((row) => ({
    id: String($('.cg-list-id', row)?.value || '').trim(),
    name: String($('.cg-list-name', row)?.value || '').trim()
  }));
  mutator(list);
  try {
    await ctx.save({ [key]: list });
  } catch (error) {
    console.error(`保存「${key}」失败:`, error);
    flash('保存失败，详情见控制台', true);
  }
  await ctx.rerender();
}

/** 表格高度拖拽（把手在表格下方），双击恢复默认。 */
function bindPermResize() {
  const wrap = $('#cg-perm-wrap');
  const grip = $('#cg-perm-grip');
  if (!wrap || !grip) return;
  const minH = PERM_HEAD_H + PERM_ROW_H + PERM_PAD;
  const remember = (h) => {
    try { localStorage.setItem(PERM_HEIGHT_KEY, String(Math.round(h))); } catch { /* 存不下就只在本次会话生效 */ }
  };
  grip.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = wrap.getBoundingClientRect().height;
    document.body.classList.add('cg-resizing');
    const onMove = (ev) => {
      wrap.style.height = `${Math.round(Math.min(PERM_MAX_H, Math.max(minH, startH + (ev.clientY - startY))))}px`;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('cg-resizing');
      remember(wrap.getBoundingClientRect().height);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  grip.addEventListener('dblclick', () => {
    wrap.style.height = `${permDefaultHeight()}px`;
    remember(permDefaultHeight());
  });
}

/**
 * 群 / 好友可视化选择器（通用）：拉 OneBot 列表 → 勾选 → 把选中的 {id, name} 交给 onPick。
 * 已在 existingIds 里的条目置灰禁选（要不要跳过由 onPick 决定，这里只负责提示）。
 */
async function openContactPicker(ctx, { endpoint, head, emptyTitle, emptyText, existingIds = new Set(), onPick }) {
  let list;
  try {
    const data = await ctx.api(`/api/onebot/${endpoint}`);
    list = endpoint === 'groups' ? data.groups : data.friends;
  } catch (e) {
    ctx.noticeModal('拉取失败', `${e.message}（OneBot 没连上？）`);
    return;
  }
  if (!list?.length) {
    ctx.noticeModal(emptyTitle, emptyText);
    return;
  }
  const overlay = ctx.modal({
    head: `${head}（${list.length} 个）`,
    body: `<div class="modal-list">${list.map((f) => {
      const id = String(f.id);
      const dup = existingIds.has(id);
      return `
        <label class="pick-item${dup ? ' is-dim' : ''}">
          <input type="checkbox" class="cg-pick-item" value="${ctx.esc(id)}" data-name="${ctx.esc(f.name || '')}" ${dup ? 'disabled' : ''} />
          <span>${ctx.esc(f.name || id)}</span>
          <span class="muted">${ctx.esc(id)}${dup ? ' · 已在名单里' : ''}</span>
        </label>`;
    }).join('')}</div>`,
    foot: '<button class="btn btn-primary" type="button" id="cg-pick-apply">添加所选</button>'
  });
  overlay.querySelector('#cg-pick-apply')?.addEventListener('click', () => {
    const picked = $$('.cg-pick-item:checked', overlay).map((el) => ({ id: el.value, name: el.dataset.name || '' }));
    ctx.closeModal(overlay);
    if (!picked.length) return;
    onPick(picked);
  });
}

/** 「选择好友」（权限表）：勾中的好友追加成权限行，已有的跳过，不覆盖已设等级。 */
function openFriendPicker(ctx) {
  const existing = new Set(permRows(ctx.pluginConfig() || {}).map((r) => r.qq).filter((qq) => qq && qq !== 'default'));
  openContactPicker(ctx, {
    endpoint: 'friends',
    head: '选择好友',
    emptyTitle: '没有拉到好友',
    emptyText: '没拉到好友列表，检查 SnowLuma 是否在运行。',
    existingIds: existing,
    onPick: (picked) => {
      savePerm(ctx, (rows) => {
        for (const { id } of picked) {
          if (rows.some((r) => r.qq === id)) continue;
          rows.push({ qq: id, level: NEW_ROW_LEVEL });
        }
      });
    }
  });
}

/** 「选择群 / 选择好友」（三张全局名单共用）：勾中的追加进对应名单，已有的跳过。 */
function openIdListPicker(ctx, list) {
  const existing = new Set(readIdDom(`#${list.id}`).map((r) => r.id));
  const isGroups = list.endpoint === 'groups';
  openContactPicker(ctx, {
    endpoint: list.endpoint,
    head: isGroups ? '选择群' : '选择好友',
    emptyTitle: isGroups ? '没有拉到群列表' : '没有拉到好友',
    emptyText: '没拉到列表，检查 SnowLuma 是否在运行。',
    existingIds: existing,
    onPick: (picked) => {
      saveIdList(ctx, list.key, `#${list.id}`, (rows) => {
        for (const p of picked) {
          if (rows.some((r) => r.id === p.id)) continue;
          rows.push(p);
        }
      });
    }
  });
}

/** 「选择群 / 选择好友」（某一条指令自己的白名单）：勾中的直接追加成名单行（动 DOM，不重绘）。 */
function openScopePicker(ctx, row, which) {
  if (!row) return;
  const box = row.querySelector(`.cg-scope-rows[data-scope-list="${which}"]`);
  if (!box) return;
  const isGroups = which === 'groups';
  const existing = new Set($$('.cg-list-row', box).map((x) => String($('.cg-list-id', x)?.value || '').trim()));
  openContactPicker(ctx, {
    endpoint: isGroups ? 'groups' : 'friends',
    head: isGroups ? '选择可用群' : '选择可用好友',
    emptyTitle: isGroups ? '没有拉到群列表' : '没有拉到好友',
    emptyText: '没拉到列表，检查 SnowLuma 是否在运行。',
    existingIds: existing,
    onPick: (picked) => {
      for (const p of picked) {
        box.insertAdjacentHTML('beforeend', scopeRowHtml(ctx, p.id, p.name, isGroups ? '群号' : 'QQ号'));
      }
      refreshRowBadges(row);        // 选完好友/群，折叠标题上的气泡摘要立刻更新
    }
  });
}

/** 读出三张全局名单容器里当前各行的 id / 备注（含还没填完的临时行）。 */
function readIdDom(containerSel) {
  return $$(containerSel).map((row) => ({
    id: String($('.cg-list-id', row)?.value || '').trim(),
    name: String($('.cg-list-name', row)?.value || '').trim()
  }));
}

/** 批量修改：多选指令 → 统一改权限等级，或统一启用/停用（写进覆盖表）。 */
function openBatchModal(ctx) {
  const gw = ctx.pluginConfig() || {};
  const skills = ctx.skills() || [];
  const routes = effectiveRows(gw, skills);
  if (!routes.length) {
    ctx.noticeModal('还没有任何指令', '等有插件在清单里声明 commands 之后，再来批量改权限。');
    return;
  }
  const nameOf = (id) => skills.find((s) => s.id === id)?.name || id;
  const prefix = String(gw.prefix || '/') || '/';
  const overlay = ctx.modal({
    head: `批量修改（${routes.length} 条指令）`,
    body: `
      <div class="cg-batch-head">
        <button class="btn btn-small" type="button" id="cg-batch-all">全选</button>
        <button class="btn btn-small" type="button" id="cg-batch-none">清空</button>
        <span class="hint" id="cg-batch-count"></span>
      </div>
      <div class="cg-batch-list">
        ${routes.map((r, i) => `
          <label class="pick-item">
            <input type="checkbox" class="cg-batch-item" value="${i}" />
            <span>${ctx.esc(nameOf(r.pluginId))} · ${ctx.esc(prefix + String(r.word || ''))}</span>
            <span class="muted">等级 ${clampLevel(r.permission, ROUTE_DEFAULT_LEVEL)}${r.enabled === false ? ' · 已停用' : ''}</span>
          </label>`).join('')}
      </div>
      <div class="cg-batch-ops">
        <label for="cg-batch-level">统一设为</label>
        <input type="number" id="cg-batch-level" value="${ROUTE_DEFAULT_LEVEL}" min="0" max="100000" step="1" />
        <button class="btn btn-primary btn-small" type="button" id="cg-batch-apply">应用权限</button>
        <button class="btn btn-small" type="button" id="cg-batch-enable">启用所选</button>
        <button class="btn btn-small" type="button" id="cg-batch-disable">停用所选</button>
      </div>
      <div class="hint">只影响勾选的指令；权限等级 0~100000。改动会记进覆盖表。</div>`,
    foot: '<button class="btn" type="button" id="cg-batch-close">关闭</button>'
  });
  const countEl = overlay.querySelector('#cg-batch-count');
  const picked = () => $$('.cg-batch-item:checked', overlay)
    .map((el) => Number(el.value))
    .filter((n) => Number.isFinite(n));
  const refreshCount = () => { if (countEl) countEl.textContent = `已选 ${picked().length} 条`; };
  overlay.addEventListener('change', (e) => {
    if (e.target.classList?.contains('cg-batch-item')) refreshCount();
  });
  overlay.querySelector('#cg-batch-all')?.addEventListener('click', () => {
    $$('.cg-batch-item', overlay).forEach((el) => { el.checked = true; });
    refreshCount();
  });
  overlay.querySelector('#cg-batch-none')?.addEventListener('click', () => {
    $$('.cg-batch-item', overlay).forEach((el) => { el.checked = false; });
    refreshCount();
  });
  // 一个都没勾时只提示、不关弹窗：否则用户得重新打开一遍
  const applyToPicked = (mutator) => {
    const list = picked();
    if (!list.length) { if (countEl) countEl.textContent = '先勾选要修改的指令'; return; }
    ctx.closeModal(overlay);
    saveOverrides(ctx, (overrides) => {
      for (const i of list) {
        const row = routes[i];
        if (!row) continue;
        const patch = mutator({ ...row });
        upsertOverride(overrides, row, patch);
      }
    });
  };
  overlay.querySelector('#cg-batch-apply')?.addEventListener('click', () => {
    const level = clampLevel(overlay.querySelector('#cg-batch-level')?.value, ROUTE_DEFAULT_LEVEL);
    applyToPicked(() => ({ permission: level }));
  });
  overlay.querySelector('#cg-batch-enable')?.addEventListener('click', () => applyToPicked(() => ({ enabled: true })));
  overlay.querySelector('#cg-batch-disable')?.addEventListener('click', () => applyToPicked(() => ({ enabled: false })));
  overlay.querySelector('#cg-batch-close')?.addEventListener('click', () => ctx.closeModal(overlay));
  refreshCount();
}
