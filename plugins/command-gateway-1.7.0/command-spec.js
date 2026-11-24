// 指令声明表 + 「按指令独立白名单 / 参数格式」工具集（单一真相）
//
// 这个文件是新增/删除/修改「前置自带指令」的唯一入口：
//   1. 编辑下面的 BUILTIN_SPECS（加一条 / 删一条 / 改字段）；
//   2. 跑 sync 把清单同步过去：node plugins/command-gateway-1.7.0/manage-commands.mjs sync
//   3. 实现执行体：在 builtin-commands.js 的 BUILTIN_COMMANDS 里加同名能力键
//      （能力名 = spec.capability，必须与 plugin.json 的 capabilities[] 三处一致）。
// 查看当前指令表：node plugins/command-gateway-1.7.0/manage-commands.mjs list
// 校验声明与清单是否一致：node plugins/command-gateway-1.7.0/manage-commands.mjs check
//
// 谁在用这个文件：
//   · index.js（Node 运行时）—— 消费 normalize* / scopeAllows / matchArgsSpec / mergeRouteDeclaration
//   · manage-commands.mjs（开发者 CLI）—— list / sync / check
//   · settings-ui.js（浏览器设置页）**不 import 本文件**：设置页是浏览器模块，走的是
//     /plugin-assets/ 静态路由；为了不让一个 import 失败拖垮整个分区，那边按同一套
//     规则做了等价的最小实现（与 effectiveRows 的既有取舍一致）。
//
// 纯函数、无依赖：可以被 Node、Electron、测试脚本随便 import。

/** 白名单模式：inherit = 沿用全局规则（权限等级 + 群白名单 + 私聊开关）；strict = 只看自己的名单。 */
export const SCOPE_MODE_INHERIT = 'inherit';
export const SCOPE_MODE_STRICT = 'strict';

/**
 * 管理者门槛：权限表里勾了「管理者」，或等级达到这个值 —— 二者等价。
 * 管理者的特权只有一条：**不受「按指令独立白名单」限制**（可用所有指令）；
 * 指令静默、冷却、去重照样算在他头上。
 */
export const PERM_ADMIN_LEVEL = 100000;

/** 权限表里某一行是不是管理者（勾了 admin，或等级到顶）。 */
export function isAdminRow(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.admin === true) return true;
  return Number(row.level) >= PERM_ADMIN_LEVEL;
}

// ── 归一化 ──────────────────────────────────────────────────────────────

/**
 * 名单归一化：`[{ id, name? }]`，id 必须是纯数字，去重留第一次出现的。
 * 兼容直接存字符串（["12345"] / "12345"）与裸数字。
 */
export function normalizeIdList(raw) {
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

/**
 * 白名单声明/覆盖归一化。
 *
 * 返回 null 只在"这个键根本不存在"时发生 —— 空对象 `{}` 也会归一成
 * `{ mode:'inherit', groups:[], friends:[] }`，因为**显式写 inherit 是有意义的**：
 * 它用来把声明里的 strict 覆盖回"跟随全局规则"。
 */
export function normalizeScopeSpec(raw) {
  if (raw === undefined || raw === null) return null;
  const r = (typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const mode = String(r.mode ?? '').trim().toLowerCase() === SCOPE_MODE_STRICT ? SCOPE_MODE_STRICT : SCOPE_MODE_INHERIT;
  return { mode, groups: normalizeIdList(r.groups), friends: normalizeIdList(r.friends) };
}

/** 声明里没写 scope 时用的默认值（= 老行为）。 */
export function defaultScopeSpec() {
  return { mode: SCOPE_MODE_INHERIT, groups: [], friends: [] };
}

/**
 * 参数格式声明/覆盖归一化。返回 null 只在键不存在时；`{}` = 显式"不限制、不提示"。
 *
 * pattern: 正则源码（对"去掉前缀与指令词之后的参数原文"做整串匹配）
 * flags:   正则旗标（只留 gimsuy，默认空）
 * strict:  true = 参数必须匹配；pattern 为空时表示"不许带参数"
 * usage:   格式不对时回给用户的一句话（空则回退到 argsHint）
 */
export function normalizeArgsSpec(raw) {
  if (raw === undefined || raw === null) return null;
  const r = (typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  return {
    pattern: String(r.pattern ?? '').trim(),
    flags: String(r.flags ?? '').replace(/[^gimsuy]/g, ''),
    strict: r.strict === true,
    usage: String(r.usage ?? '').trim()
  };
}

/** 一个参数格式声明是不是"什么都没设"（用于覆盖表只存差异）。 */
export function isEmptyArgsSpec(spec) {
  if (!spec) return true;
  return !spec.pattern && !spec.strict && !spec.usage && !spec.flags;
}

/** 一个白名单声明是不是"跟随全局规则、且名单为空"（用于覆盖表只存差异）。 */
export function isEmptyScopeSpec(spec) {
  if (!spec) return true;
  return spec.mode !== SCOPE_MODE_STRICT && !spec.groups.length && !spec.friends.length;
}

// ── 判定（运行时与测试共用） ─────────────────────────────────────────────

/** 正则编译；pattern 为空或写坏了返回 null（写坏的由 check/设置页提示，运行时一律不拦）。 */
export function compileArgsSpec(spec) {
  const pattern = String(spec?.pattern ?? '').trim();
  if (!pattern) return null;
  try {
    return new RegExp(pattern, String(spec?.flags ?? ''));
  } catch {
    return null;
  }
}

/** 参数格式有什么问题（设置页/CLI 提示用）。没问题返回 null。 */
export function argsSpecProblem(spec) {
  if (!spec) return null;
  if (spec.pattern) {
    try {
      // eslint-disable-next-line no-new
      new RegExp(spec.pattern, spec.flags || '');
    } catch (error) {
      return `正则无效：${error?.message ?? error}`;
    }
  }
  return null;
}

/**
 * 参数是否满足声明。
 *
 * 口径：只有 strict === true 才拦；pattern 为空 = 必须不带参数；
 * 正则写坏 → 不拦（宁可放行也不把指令整条废掉）。
 */
export function matchArgsSpec(spec, args) {
  if (!spec || spec.strict !== true) return true;
  const text = String(args ?? '').trim();
  if (!spec.pattern) return text === '';
  const re = compileArgsSpec(spec);
  if (!re) return true;
  return re.test(text);
}

/**
 * 这条指令能不能在这个会话里用。
 *
 * scope 为空或 mode=inherit → true（沿用调用方已有的权限/黑名单判定）。
 * mode=strict → **非管理者**必须命中名单，命中口径：
 *   · 群聊：**群号命中**（该群所有普通成员可用）**或发言人 QQ 命中**（本人可用，跨群生效）；
 *   · 私聊：发言人（= 对方）QQ 命中好友名单。
 * 两个名单都为空 = 普通成员谁都不能用。管理者由调用方先行豁免，不走这里。
 * 未知会话类型在 strict 下按拒绝处理。
 */
export function scopeAllows(scope, { kind, chatId, senderId } = {}) {
  if (!scope || scope.mode !== SCOPE_MODE_STRICT) return true;
  const uid = String(senderId ?? '').trim();
  const userHit = !!uid && (scope.friends || []).some((r) => String(r?.id ?? r) === uid);
  const k = String(kind ?? '').trim();
  if (k === 'group') {
    const gid = String(chatId ?? '').trim();
    const groupHit = !!gid && (scope.groups || []).some((r) => String(r?.id ?? r) === gid);
    // 群号放行整群；QQ 名单放行这个人本人 —— 两条任一命中即可（在非名单群里也能靠 QQ 命中）
    return groupHit || userHit;
  }
  if (k === 'private') return userHit;
  return false;
}

/** 给人看的一句话摘要（设置页徽标、日志、CLI 共用）。 */
export function scopeSummary(scope) {
  if (!scope || scope.mode !== SCOPE_MODE_STRICT) return '跟随全局规则';
  const g = (scope.groups || []).length;
  const f = (scope.friends || []).length;
  if (!g && !f) return '独立白名单：空（普通成员谁都不能用）';
  return `独立白名单：${g} 个群 / ${f} 个好友（群内按群号或发言人 QQ 命中）`;
}

// ── 覆盖表 CRUD（配置里的 config.skills[<插件id>].overrides） ─────────────

/** 找一条覆盖记录；没有返回 null。 */
export function findOverride(list, pluginId, id) {
  const rows = Array.isArray(list) ? list : [];
  const pid = String(pluginId ?? '');
  const cid = String(id ?? '');
  return rows.find((o) => String(o?.pluginId ?? '') === pid && String(o?.id ?? '') === cid) || null;
}

/**
 * 写入/更新一条覆盖记录（返回新数组，不改原数组）。
 *
 * changes 里值为 undefined 的键会被忽略；scope/args 是整体替换（传 null = 删掉这个键）。
 * base 用于新建时补齐声明值（word/aliases/permission/timeoutMs）。
 */
export function patchOverride(list, { pluginId, id }, changes = {}, base = {}) {
  const rows = (Array.isArray(list) ? list : []).map((o) => ({ ...o }));
  const at = rows.findIndex((o) => String(o?.pluginId ?? '') === String(pluginId) && String(o?.id ?? '') === String(id));
  const row = at >= 0 ? rows[at] : {
    pluginId: String(pluginId),
    id: String(id),
    word: base.word,
    aliases: Array.isArray(base.aliases) ? base.aliases.slice() : [],
    permission: base.permission,
    timeoutMs: base.timeoutMs
  };
  for (const [key, value] of Object.entries(changes || {})) {
    if (value === undefined) continue;
    if (value === null) delete row[key];
    else row[key] = value;
  }
  if (at >= 0) rows[at] = row; else rows.push(row);
  return rows;
}

/** 删掉一条覆盖记录（返回新数组）。 */
export function dropOverride(list, pluginId, id) {
  return (Array.isArray(list) ? list : [])
    .filter((o) => !(String(o?.pluginId ?? '') === String(pluginId) && String(o?.id ?? '') === String(id)));
}

// ── 声明 + 覆盖 → 生效值（index.js 的 effectiveRoutes 用这一个口） ────────

export function mergeScopeDeclaration(declared, override) {
  if (override !== undefined) {
    const o = normalizeScopeSpec(override);
    if (o) return o;                       // 显式覆盖（含显式 inherit）优先
  }
  return normalizeScopeSpec(declared) || defaultScopeSpec();
}

export function mergeArgsDeclaration(declared, override) {
  if (override !== undefined) {
    const o = normalizeArgsSpec(override);
    if (o) return o;
  }
  return normalizeArgsSpec(declared);
}

/**
 * 把「清单声明」与「用户覆盖」合成一条生效指令。
 * index.js 的 effectiveRoutes 与测试都用它，避免两处各写一遍合并规则。
 */
export function mergeRouteDeclaration(decl, ov) {
  const d = decl && typeof decl === 'object' ? decl : {};
  return {
    word: ov?.word || d.word,
    aliases: (ov?.aliases === undefined ? d.aliases : ov.aliases),
    permission: ov?.permission === undefined ? d.permission : ov.permission,
    timeoutMs: (ov?.timeoutMs === undefined ? d.timeoutMs : ov.timeoutMs),
    enabled: ov ? ov.enabled !== false : true,
    noCount: ov?.noCount === undefined ? d.noCount === true : ov.noCount === true,
    scope: mergeScopeDeclaration(d.scope, ov?.scope),
    args: mergeArgsDeclaration(d.args, ov?.args)
  };
}

// ── 自带指令的声明表（唯一入口） ─────────────────────────────────────────
//
// 字段与 plugin.json 的 commands[] 一一对应，另加两个新字段：
//   args  —— 参数格式（见 normalizeArgsSpec 的注释）
//   scope —— 按指令独立白名单（见 normalizeScopeSpec 的注释）
//
// 约定（照抄 README §5 的硬规定，别漏）：
//   · capability 必须与 plugin.json 的 capabilities[]、builtin-commands.js 的
//     BUILTIN_COMMANDS 键三处一致；
//   · permission 是"谁有资格触发"的**数字闸**（0 = 所有身份，100000 = 仅管理者）。
//     两档身份模型下它退居次要：管理者全通，普通成员由每条指令自己的 scope 白名单把关。
//     所以内置 8 条一律 permission: 0（能进到白名单判定），想收紧就在设置页把某条
//     改成「仅管理者」——那会写成该指令的 overrides[].permission = 100000；
//   · 指令词 + 元指令词都是保留词，settings-ui.js 的 RESERVED_WORDS 要同步。

/** 只匹配"@某人 / QQ号 / 带引号的 QQ号"开头，后面可以跟时间之类的参数。 */
const TARGET_PATTERN = '^(?:"?\\d{5,12}"?|@\\S+)(?:\\s+.*)?$';

export const BUILTIN_SPECS = [
  {
    id: 'mute',
    word: '禁言',
    capability: 'command.mute',
    description: '在群里禁言某人（仅群聊；需要机器人是该群管理员，且不能禁言群主或管理员）。时间不写默认 30 分钟，纯数字按分钟算。',
    argsHint: '"QQ号" [时间=30分钟]',
    examples: ['/禁言 "10001"', '/禁言 @张三 2小时', '/禁言 10001 10'],
    permission: 0,
    timeoutMs: 15000,
    args: { pattern: TARGET_PATTERN, strict: true, usage: '/禁言 "QQ号" [时间=30分钟]（也可以 @某人）' },
    scope: { mode: SCOPE_MODE_STRICT, groups: [], friends: [] }
  },
  {
    id: 'unmute',
    word: '解禁',
    capability: 'command.unmute',
    description: '解除某人的禁言（仅群聊；需要机器人是该群管理员）。',
    argsHint: '"QQ号"',
    examples: ['/解禁 "10001"', '/解禁 @张三'],
    permission: 0,
    timeoutMs: 15000,
    args: { pattern: TARGET_PATTERN, strict: true, usage: '/解禁 "QQ号"（也可以 @某人）' },
    scope: { mode: SCOPE_MODE_STRICT, groups: [], friends: [] }
  },
  {
    id: 'whole-mute',
    word: '全体禁言',
    capability: 'command.whole-mute',
    description: '开启全员禁言（仅群聊；需要机器人是该群管理员）。',
    argsHint: '',
    examples: [],
    permission: 0,
    timeoutMs: 15000,
    args: { pattern: '', strict: true, usage: '/全体禁言（不带参数）' },
    scope: { mode: SCOPE_MODE_STRICT, groups: [], friends: [] }
  },
  {
    id: 'whole-unmute',
    word: '全体解禁',
    capability: 'command.whole-unmute',
    description: '解除全员禁言（仅群聊；需要机器人是该群管理员）。',
    argsHint: '',
    examples: [],
    permission: 0,
    timeoutMs: 15000,
    args: { pattern: '', strict: true, usage: '/全体解禁（不带参数）' },
    scope: { mode: SCOPE_MODE_STRICT, groups: [], friends: [] }
  },
  {
    id: 'pause',
    word: '暂停',
    capability: 'command.pause',
    description: '暂停模型调用：之后的群消息不再交给模型回复，指令类功能照常可用；正在跑的那一轮不会被打断。发 /继续 恢复。',
    argsHint: '',
    examples: [],
    permission: 0,
    timeoutMs: 10000,
    args: { pattern: '', strict: true, usage: '/暂停（不带参数）' },
    scope: { mode: SCOPE_MODE_STRICT, groups: [], friends: [] }
  },
  {
    id: 'resume',
    word: '继续',
    capability: 'command.resume',
    description: '恢复模型调用。默认把暂停期间积压的消息接着处理，写「丢弃积压」就丢掉不处理。',
    argsHint: '[丢弃积压]',
    examples: ['/继续', '/继续 丢弃积压'],
    permission: 0,
    timeoutMs: 15000,
    args: { pattern: '^(?:丢弃积压|丢弃|丢掉|不要积压)?$', strict: true, usage: '/继续 [丢弃积压]' },
    scope: { mode: SCOPE_MODE_STRICT, groups: [], friends: [] }
  },
  {
    id: 'dice',
    word: '抛骰子',
    capability: 'command.dice',
    description: '随机掷一个骰子，默认 6 面。',
    argsHint: '[面数=6]',
    examples: ['/抛骰子', '/抛骰子 20'],
    permission: 0,
    timeoutMs: 5000,
    args: { pattern: '^\\d*$', strict: true, usage: '/抛骰子 [面数=6]' },
    scope: { mode: SCOPE_MODE_STRICT, groups: [], friends: [] }
  },
  {
    id: 'rps',
    word: '猜拳',
    capability: 'command.rps',
    description: '和机器人猜拳：不写参数就只让它出，写了石头/剪刀/布就分胜负。',
    argsHint: '[石头|剪刀|布]',
    examples: ['/猜拳', '/猜拳 石头'],
    permission: 0,
    timeoutMs: 5000,
    args: { pattern: '^(?:石头|剪刀|布)?$', strict: true, usage: '/猜拳 [石头|剪刀|布]' },
    scope: { mode: SCOPE_MODE_STRICT, groups: [], friends: [] }
  }
];

// ── 声明表的增删改查（给 CLI / 测试 / 以后的可视化编辑器用） ──────────────

/** 当前声明表（副本，改它不会影响 BUILTIN_SPECS）。 */
export function listSpecs() {
  return BUILTIN_SPECS.map((s) => ({ ...s, aliases: s.aliases ? [...s.aliases] : [], examples: s.examples ? [...s.examples] : [] }));
}

/** 按 id 取一条声明；没有返回 null。 */
export function specById(id) {
  return listSpecs().find((s) => String(s.id) === String(id)) || null;
}

/** 加一条声明（返回新数组）；id 重复会被拒绝。 */
export function addSpec(specs, spec) {
  const list = Array.isArray(specs) ? specs.map((s) => ({ ...s })) : [];
  const problems = validateSpec(spec);
  if (problems.length) return { ok: false, problems, specs: list };
  if (list.some((s) => String(s.id) === String(spec.id))) {
    return { ok: false, problems: [`id 已存在：${spec.id}`], specs: list };
  }
  list.push({ ...spec });
  return { ok: true, problems: [], specs: list };
}

/** 删一条声明（返回新数组）。 */
export function removeSpec(specs, id) {
  return (Array.isArray(specs) ? specs : []).filter((s) => String(s.id) !== String(id));
}

/** 改一条声明（浅合并；返回新数组）。 */
export function updateSpec(specs, id, changes = {}) {
  return (Array.isArray(specs) ? specs : []).map((s) => (String(s.id) === String(id) ? { ...s, ...changes } : { ...s }));
}

/**
 * 校验一条声明能不能用。返回问题列表（空 = 没问题）。
 * 规则与核心清单归一化保持一致（能力名格式、权限范围、超时下限、正则可编译）。
 */
export function validateSpec(spec) {
  const problems = [];
  const s = spec && typeof spec === 'object' ? spec : {};
  if (!String(s.id ?? '').trim()) problems.push('缺 id');
  if (!String(s.word ?? '').trim()) problems.push('缺 word（指令词）');
  if (/\s/.test(String(s.word ?? ''))) problems.push('指令词不能含空白');
  const capability = String(s.capability ?? '').trim();
  if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/.test(capability)) problems.push(`capability 格式不合法：${capability || '(空)'}`);
  if (!String(s.description ?? '').trim()) problems.push('缺 description（/帮助 会显示它）');
  const permission = Number(s.permission);
  if (!Number.isFinite(permission) || permission < 0 || permission > 100000) problems.push(`permission 要在 0~100000：${s.permission}`);
  const timeout = Number(s.timeoutMs);
  if (Number.isFinite(timeout) && timeout !== 0 && timeout < 1000) problems.push(`timeoutMs 要么不写，要么 >= 1000：${s.timeoutMs}`);
  const args = normalizeArgsSpec(s.args);
  const argsProblem = argsSpecProblem(args);
  if (argsProblem) problems.push(argsProblem);
  return problems;
}

// ── 声明 → plugin.json 的 commands[] ─────────────────────────────────────

/** 一条声明 → 清单里的 commands[] 项（默认值不落盘，保持清单整洁）。 */
export function specToCommand(spec) {
  const s = spec && typeof spec === 'object' ? spec : {};
  const out = {
    id: String(s.id ?? ''),
    word: String(s.word ?? ''),
    capability: String(s.capability ?? ''),
    description: String(s.description ?? '')
  };
  if (s.aliases && s.aliases.length) out.aliases = [...s.aliases];
  if (s.argsHint) out.argsHint = String(s.argsHint);
  if (s.examples && s.examples.length) out.examples = [...s.examples].slice(0, 5);
  if (s.permission !== undefined && s.permission !== null) out.permission = Number(s.permission);
  if (s.timeoutMs) out.timeoutMs = Number(s.timeoutMs);
  if (s.noCount === true) out.noCount = true;
  if (s.passthrough) out.passthrough = s.passthrough;
  const scope = normalizeScopeSpec(s.scope);
  if (scope && !isEmptyScopeSpec(scope)) out.scope = scope;
  const args = normalizeArgsSpec(s.args);
  if (args && !isEmptyArgsSpec(args)) out.args = args;
  return out;
}

/** 整张声明表 → commands[]（顺序即展示顺序）。 */
export function specsToCommands(specs = BUILTIN_SPECS) {
  return (Array.isArray(specs) ? specs : []).map(specToCommand);
}

/** 声明表里的全部能力名（sync 时并进 plugin.json 的 capabilities[]）。 */
export function specsToCapabilities(specs = BUILTIN_SPECS) {
  return (Array.isArray(specs) ? specs : []).map((s) => String(s?.capability ?? '')).filter(Boolean);
}