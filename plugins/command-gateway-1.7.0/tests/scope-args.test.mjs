// 指令前置 · 按指令独立白名单 + 参数格式 + 「管理者 / 普通成员」的回归测试
//
// 跑法（在仓库根目录）：node plugins/command-gateway-1.7.0/tests/scope-args.test.mjs
//
// 为什么单独一个文件：这两道闸都在消息入口的同步返回里（handled 与否直接决定
// 这条消息要不要诞生会话），改错了不会报错、只会"指令没反应"，必须有断言盯着。
//
// 身份口径（本文件里的两个测试账号）：
//   9002 = 管理者（权限表里 admin: true）—— 不受按指令白名单限制
//   9001 = 普通成员（跟随默认权限 0）—— 必须命中每条指令自己的白名单

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// 测试期间把数据目录指到临时目录：插件会 import 核心 config.js 写"最近调用"，
// 不能污染用户真实的 data/config.json。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-scope-args-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const { setup, providers } = await import('../index.js');

const ADMIN = '9002';
const MEMBER = '9001';
const EXEMPT = '9004';        // 普通成员，但在 QQ 白名单里（全通豁免）
const BLOCKED = '9005';       // 在 QQ 黑名单里
const BLOCKED_ADMIN = '9006'; // 管理者，但也在 QQ 黑名单里（黑名单应压过管理者）

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !extra ? '' : ` —— ${extra}`}`);
}

// ── 假宿主 ────────────────────────────────────────────────────────────────
const CONFIG = {
  prefix: '/',
  cooldownMs: 0,
  privateEnabled: true,
  defaultTimeoutMs: 30000,
  silenceSeconds: 10,
  silenceHits: 0,                       // 关掉指令静默，别干扰断言
  permissions: [
    { qq: 'default', level: 0 },
    { qq: ADMIN, admin: true },          // 管理者：勾一下即可，等级自动等于 100000
    { qq: MEMBER, level: 0 },            // 普通成员
    { qq: EXEMPT, level: 0 },            // 普通成员 + QQ 白名单
    { qq: BLOCKED, level: 0 },           // QQ 黑名单
    { qq: BLOCKED_ADMIN, admin: true }   // 管理者 + QQ 黑名单
  ],
  metaCommands: [],
  // 三张全局名单（2026-11-03 起替代旧的「群黑名单 / 全局白名单」）。
  // 群白名单里放 111/999/888，让下面的「按指令白名单」用例能走到第二道闸；
  // 777 故意不在名单里，用来验「不在群白名单 → 指令被吞」。
  groupWhitelist: [{ id: '111' }, { id: '999' }, { id: '888' }],
  qqWhitelist: [{ id: EXEMPT }],
  qqBlacklist: [{ id: BLOCKED }, { id: BLOCKED_ADMIN }],
  moderation: { words: [], patterns: [] },
  overrides: [],
  stats: {},
  recentCalls: []
};

const DICE = {
  id: 'dice',
  word: '抛骰子',
  capability: 'command.dice',
  description: '随机掷一个骰子',
  argsHint: '[面数=6]',
  examples: ['/抛骰子 20'],
  permission: 0,
  args: { pattern: '^\\d*$', strict: true, usage: '/抛骰子 [面数=6]' },
  scope: { mode: 'strict', groups: [], friends: [] }      // 内置指令的开箱口径
};
const WEATHER = {
  id: 'weather',
  word: '天气',
  capability: 'plugin.weather',
  description: '查天气',
  permission: 0,
  scope: { mode: 'strict', groups: [{ id: '111' }], friends: [{ id: '222' }] }
};
const CATALOG = [{ id: 'command-gateway-1.7.0', name: '指令前置', commands: [DICE, WEATHER] }];

let calls = [];
let sent = [];
const api = {
  id: 'command-gateway-1.7.0',
  config: () => CONFIG,
  log: () => {},
  warn: () => {},
  error: () => {},
  hasCapability: (name) => ['command.dispatch', 'command.dice', 'plugin.weather'].includes(name),
  capability: (name, payload) => {
    calls.push({ name, args: payload?.args });
    return { text: `${name}:ok` };
  }
};

/** 造一条消息；执行 run() 之后 sent 里就是回执。 */
async function dispatch({ text, kind = 'group', chatId = '111', senderId = MEMBER, messageId = String(Math.random()) }) {
  calls = [];
  sent = [];
  const payload = {
    kind,
    chatId,
    senderId,
    chatKey: `${kind}:${chatId}`,
    text,
    messageId,
    segments: [],
    catalog: CATALOG,
    ctx: { sender: { sendTextBatch: async (_key, list) => { sent.push(...list); } } }
  };
  const decision = providers['command.dispatch'](payload);
  if (decision?.run) await decision.run();
  return decision;
}

const setOverrides = (list) => { CONFIG.overrides = list; };
const group = (chatId, senderId = MEMBER) => ({ kind: 'group', chatId, senderId });
const priv = (userId, senderId = userId) => ({ kind: 'private', chatId: userId, senderId });

setup(api);

// ── 1. 参数格式（管理者身份，避开白名单，单独验格式闸） ───────────────────
{
  setOverrides([]);
  const d = await dispatch({ text: '/抛骰子 20', ...group('111', ADMIN) });
  check('格式正确 → 正常执行', d.handled === true && calls.length === 1, JSON.stringify({ d, calls }));
}
{
  setOverrides([]);
  const d = await dispatch({ text: '/抛骰子 abc', ...group('111', ADMIN) });
  check('参数不匹配 → 回用法、不执行', d.handled === true && calls.length === 0 && sent.join('').includes('用法'), JSON.stringify({ sent }));
}
{
  setOverrides([]);
  await dispatch({ text: '/抛骰子 20 30', ...group('111', ADMIN) });
  check('多余参数也算不匹配', calls.length === 0 && sent.join('').includes('用法'), JSON.stringify({ sent }));
}
{
  setOverrides([{ pluginId: 'command-gateway-1.7.0', id: 'dice', args: { pattern: '', flags: '', strict: false, usage: '' } }]);
  await dispatch({ text: '/抛骰子 abc', ...group('111', ADMIN) });
  check('args.strict=false → 格式不再拦（回到旧行为）', calls.length === 1, JSON.stringify({ calls }));
}
{
  setOverrides([{ pluginId: 'command-gateway-1.7.0', id: 'dice', args: { pattern: '^[0-9]{1,2}$', strict: true, usage: '/抛骰子 两位数以内' } }]);
  await dispatch({ text: '/抛骰子 20', ...group('111', ADMIN) });
  check('自定义正则：匹配则执行', calls.length === 1, JSON.stringify({ calls }));
  await dispatch({ text: '/抛骰子 20000', ...group('111', ADMIN) });
  check('自定义正则：不匹配回自定义用法', calls.length === 0 && sent.join('').includes('两位数以内'), JSON.stringify({ sent }));
}
{
  setOverrides([{ pluginId: 'command-gateway-1.7.0', id: 'dice', args: { pattern: '([', strict: true, usage: '' } }]);
  await dispatch({ text: '/抛骰子 20', ...group('111', ADMIN) });
  check('正则写坏时运行时放行（不静默废掉指令）', calls.length === 1, JSON.stringify({ calls }));
}

// ── 2. 普通成员：必须命中该指令自己的白名单 ────────────────────────────────
{
  setOverrides([]);
  const inGroup = await dispatch({ text: '/天气 珠海', ...group('111') });
  check('普通成员 · 名单内的群 → 可用', inGroup.handled === true && calls.length === 1, JSON.stringify({ inGroup }));
}
{
  setOverrides([]);
  const other = await dispatch({ text: '/天气 珠海', ...group('999') });
  check('普通成员 · 不在名单的群 → 当没这条指令（放行给聊天流程）', other.handled === false && calls.length === 0, JSON.stringify({ other }));
}
{
  setOverrides([]);
  const dm = await dispatch({ text: '/天气 珠海', ...priv('222') });
  check('普通成员 · 名单内的好友（私聊）→ 可用', dm.handled === true && calls.length === 1, JSON.stringify({ dm }));
}
{
  setOverrides([]);
  const stranger = await dispatch({ text: '/天气 珠海', ...priv('777') });
  check('普通成员 · 不在名单的好友 → 当没这条指令', stranger.handled === false && calls.length === 0, JSON.stringify({ stranger }));
}
// 用户口径：群聊里「发言人 QQ 命中好友名单」也要放行，哪怕这个群不在「可用群」名单里
{
  setOverrides([]);
  const d = await dispatch({ text: '/天气 珠海', ...group('999', '222') });
  check('普通成员 · 群不在名单、但发言人 QQ 在好友名单 → 放行（跨群按人放行）',
    d.handled === true && calls.length === 1, JSON.stringify({ d, calls }));
}
{
  setOverrides([{ pluginId: 'command-gateway-1.7.0', id: 'dice', scope: { mode: 'strict', groups: [], friends: [{ id: MEMBER }] } }]);
  const d = await dispatch({ text: '/抛骰子 20', ...group('888', MEMBER) });
  check('普通成员 · 名单只有 QQ（无群）：在任意群里都能用', d.handled === true && calls.length === 1, JSON.stringify({ d, calls }));
  const other = await dispatch({ text: '/抛骰子 20', ...group('888', '9003') });
  check('普通成员 · 名单只有 QQ：没在名单里的群成员仍被拦', other.handled === false && calls.length === 0, JSON.stringify({ other }));
}
{
  setOverrides([{ pluginId: 'command-gateway-1.7.0', id: 'dice', scope: { mode: 'strict', groups: [], friends: [] } }]);
  const d = await dispatch({ text: '/抛骰子 20', ...group('111') });
  check('覆盖 strict 且名单为空 → 普通成员谁都不能用', d.handled === false && calls.length === 0, JSON.stringify({ d }));
}

// ── 3. 管理者：不受白名单限制 ─────────────────────────────────────────────
{
  setOverrides([{ pluginId: 'command-gateway-1.7.0', id: 'dice', scope: { mode: 'strict', groups: [], friends: [] } }]);
  const d = await dispatch({ text: '/抛骰子 20', ...group('111', ADMIN) });
  check('管理者 · 名单为空照常可用', d.handled === true && calls.length === 1, JSON.stringify({ d, calls }));
}
{
  setOverrides([]);
  const d = await dispatch({ text: '/天气 珠海', ...group('999', ADMIN) });
  check('管理者 · 不在名单的群照常可用', d.handled === true && calls.length === 1, JSON.stringify({ d }));
}
{
  setOverrides([]);
  const d = await dispatch({ text: '/天气 珠海', ...priv('777', ADMIN) });
  check('管理者 · 不在名单的好友照常可用（私聊）', d.handled === true && calls.length === 1, JSON.stringify({ d }));
}

// ── 4. 覆盖表：把声明的 strict 改回 inherit（不额外限制） ──────────────────
{
  setOverrides([{ pluginId: 'command-gateway-1.7.0', id: 'weather', scope: { mode: 'inherit', groups: [], friends: [] } }]);
  const d = await dispatch({ text: '/天气 珠海', ...group('888') });
  check('覆盖 inherit → 普通成员在任何群都能用（老行为）', d.handled === true && calls.length === 1, JSON.stringify({ d }));
}

// ── 5. /帮助 的可见性跟着身份走 ───────────────────────────────────────────
{
  setOverrides([]);
  const d = await dispatch({ text: '/帮助', ...group('999') });
  const help = sent.join('\n');
  check('普通成员 · /帮助 不列出被白名单挡住的指令',
    d.handled === true && !help.includes('/天气') , help.slice(0, 160));
}
{
  setOverrides([]);
  await dispatch({ text: '/帮助', ...group('999', ADMIN) });
  const help = sent.join('\n');
  check('管理者 · /帮助 列出全部指令', help.includes('/天气'), help.slice(0, 160));
}

// ── 6. 权限表归一化：admin 勾选等价于等级 100000 ──────────────────────────
{
  setOverrides([]);
  const d = await dispatch({ text: '/权限查询 9002', ...group('111', ADMIN) });
  check('管理者在 /权限查询 里显示为 100000', sent.join('').includes('100000'), sent.join('').slice(0, 160));
}

// ── 7. 全局名单：QQ 黑名单 > QQ 白名单 / 管理者；群聊还要过群白名单 ─────────
{
  setOverrides([]);
  const d = await dispatch({ text: '/抛骰子 20', ...group('777', MEMBER) });
  check('群不在群白名单 + 普通成员 → 指令被静默吞掉（不回执、不执行）',
    d.handled === true && calls.length === 0 && sent.length === 0, JSON.stringify({ d, sent, calls }));
}
{
  setOverrides([]);
  const d = await dispatch({ text: '大家好啊', ...group('777', MEMBER) });
  check('群不在群白名单 + 普通聊天（不像指令）→ 照常放行',
    d.handled === false, JSON.stringify({ d }));
}
{
  setOverrides([]);
  const d = await dispatch({ text: '/抛骰子 20', ...group('777', ADMIN) });
  check('群不在群白名单 + 管理者 → 豁免，照常可用', d.handled === true && calls.length === 1, JSON.stringify({ d, calls }));
}
{
  setOverrides([]);
  const d = await dispatch({ text: '/抛骰子 20', ...group('777', EXEMPT) });
  check('群不在群白名单 + QQ 白名单成员 → 豁免，照常可用', d.handled === true && calls.length === 1, JSON.stringify({ d, calls }));
}
{
  setOverrides([]);
  const d = await dispatch({ text: '/抛骰子 20', ...group('111', BLOCKED) });
  check('QQ 黑名单成员（哪怕群在白名单）→ 指令被吞', d.handled === true && calls.length === 0 && sent.length === 0, JSON.stringify({ d }));
}
{
  setOverrides([]);
  const d = await dispatch({ text: '/帮助', ...group('111', BLOCKED_ADMIN) });
  check('QQ 黑名单压过管理者（连 /帮助 也被吞）', d.handled === true && sent.length === 0, JSON.stringify({ d, sent }));
}
{
  setOverrides([{ pluginId: 'command-gateway-1.7.0', id: 'dice', scope: { mode: 'strict', groups: [], friends: [] } }]);
  const d = await dispatch({ text: '/抛骰子 20', ...group('111', EXEMPT) });
  check('QQ 白名单成员绕过「按指令独立白名单」（名单为空也照常可用）', d.handled === true && calls.length === 1, JSON.stringify({ d, calls }));
}

// 收尾：插件会把"最近调用"节流写盘，等它落完再退
await new Promise((r) => setTimeout(r, 700));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows 上偶发占用，留着也无妨 */ }

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);