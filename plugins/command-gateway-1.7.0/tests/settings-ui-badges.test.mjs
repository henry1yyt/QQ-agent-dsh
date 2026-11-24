// 指令前置 · 设置页「气泡实时刷新」回归测试（jsdom，真事件真 DOM）
//
// 跑法（在仓库根目录）：node plugins/command-gateway-1.7.0/tests/settings-ui-badges.test.mjs
//
// 盯的是什么：折叠标题上的「独立白名单」「严格格式」两个气泡，以前是渲染时算死的 ——
// 勾选/取消勾选、加减名单、改正则都不会变，用户必须整页刷新才对。现在要求：
//   勾上 → 气泡立刻出现（并带上正确摘要）；取消 → 立刻消失。
// 这类"看起来没坏、其实要刷新"的问题只有真跑一遍 DOM 才抓得到。

import { JSDOM } from 'jsdom';

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !extra ? '' : ` —— ${extra}`}`);
};

const skills = [
  {
    id: 'command-gateway-1.7.0',
    name: '指令前置',
    enabled: true,
    loaded: true,
    commands: [
      {
        id: 'dice',
        word: '抛骰子',
        capability: 'command.dice',
        description: '随机掷一个骰子',
        permission: 0,
        scope: { mode: 'strict', groups: [], friends: [] },   // 默认开白名单
        args: { pattern: '^\\d*$', strict: true, usage: '/抛骰子 [面数=6]' }
      },
      {
        id: 'rps',
        word: '猜拳',
        capability: 'command.rps',
        description: '猜拳',
        permission: 0
        // 两样都不声明：默认关闭，用来验"取消勾选后气泡消失"
      }
    ]
  }
];

const config = {
  skills: {
    'command-gateway-1.7.0': { prefix: '/', permissions: [{ qq: 'default', level: 0 }], overrides: [] }
  }
};

const ctx = {
  pluginId: 'command-gateway-1.7.0',
  sectionId: 'command',
  entrySeq: 1,
  esc: (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
  api: async () => ({ groups: [], friends: [] }),
  skills: () => skills,
  config: () => config,
  pluginConfig: () => config.skills['command-gateway-1.7.0'],
  save: async () => {},
  setEnabled: async () => {},
  reload: async () => {},
  rerender: async () => {},
  modal: () => ({ querySelector: () => null, addEventListener: () => {} }),
  closeModal: () => {},
  noticeModal: () => {}
};

// jsdom 环境要在 import 之后、调用 bind 之前铺好（模块里 $/$$ 默认取全局 document）
const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:3210/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.HTMLElement = dom.window.HTMLElement;

const { render, bind } = await import('../settings-ui.js');

const root = document.getElementById('root');
root.innerHTML = render(ctx);
bind(root, ctx);

/** 找到某条指令的行。 */
const rowOf = (id) => root.querySelector(`#cg-routes .cg-row[data-kind="plugin"][data-id="${id}"]`);
const badgeOf = (row, which) => row.querySelector(`[data-badge="${which}"]`);
const toggleScope = (row, on) => { const el = row.querySelector('.cg-scope-on'); el.checked = on; el.dispatchEvent(new dom.window.Event('change', { bubbles: true })); };
const toggleArgs = (row, on) => { const el = row.querySelector('.cg-args-strict'); el.checked = on; el.dispatchEvent(new dom.window.Event('change', { bubbles: true })); };

check('两个气泡都在 DOM 里（带 data-badge 钩子，靠 hidden 控制显隐）',
  !!badgeOf(rowOf('dice'), 'scope') && !!badgeOf(rowOf('dice'), 'args'));

{
  const row = rowOf('dice');
  check('默认开启的指令：气泡初始可见且有 is-on',
    badgeOf(row, 'scope').hidden === false && badgeOf(row, 'scope').classList.contains('is-on')
    && badgeOf(row, 'args').hidden === false && badgeOf(row, 'args').classList.contains('is-on'));
  check('气泡 title 带摘要（白名单条数 / 正则）',
    badgeOf(row, 'scope').title.includes('独立白名单') && badgeOf(row, 'args').title.includes('严格要求'));
}

{
  const row = rowOf('dice');
  toggleScope(row, false);
  check('取消「独立白名单」→ 气泡立刻消失',
    badgeOf(row, 'scope').hidden === true, JSON.stringify({ hidden: badgeOf(row, 'scope').hidden }));
  check('取消后：该指令的参数格式气泡不受影响',
    badgeOf(row, 'args').hidden === false);
  toggleScope(row, true);
  check('再勾上 → 气泡立刻回来（摘要提示空名单）',
    badgeOf(row, 'scope').hidden === false && badgeOf(row, 'scope').title.includes('空'));
  toggleArgs(row, false);
  check('取消「严格要求参数格式」→ 气泡立刻消失',
    badgeOf(row, 'args').hidden === true);
  toggleArgs(row, true);
  check('再勾上 → 严格格式气泡立刻回来',
    badgeOf(row, 'args').hidden === false && badgeOf(row, 'args').title.includes('严格要求'));
}

{
  const row = rowOf('rps');       // 声明里两样都关
  check('默认关闭的指令：两个气泡初始都隐藏',
    badgeOf(row, 'scope').hidden === true && badgeOf(row, 'args').hidden === true);
  toggleScope(row, true);
  toggleArgs(row, true);
  check('勾上后（未保存、未重绘）两个气泡立刻出现',
    badgeOf(row, 'scope').hidden === false && badgeOf(row, 'args').hidden === false);
}

{
  // 白名单行数变化：点「加一行」（空行不算数）→ 填上 QQ → 摘要条数跟着变，全程不重绘
  const row = rowOf('rps');
  const before = badgeOf(row, 'scope').title;
  row.querySelector('[data-cg-act="scope-add"][data-list="friends"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const mid = badgeOf(row, 'scope').title;
  const input = row.querySelector('.cg-scope-rows[data-scope-list="friends"] .cg-list-row .cg-list-id');
  input.value = '10001';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const after = badgeOf(row, 'scope').title;
  check('「加一行」时空行不计入摘要（仍是 0 好友）', mid.includes('空'), mid);
  check('填上 QQ 后摘要实时变成 1 好友（不重绘、不刷新页面）',
    before !== after && after.includes('1 好友'), JSON.stringify({ before, after }));
}

{
  // 正则改动 → 气泡 title 跟着变
  const row = rowOf('dice');
  const input = row.querySelector('.cg-args-pattern');
  input.value = '^[0-9]{1,2}$';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  check('改正则 → 严格格式气泡的 title 同步成新正则',
    badgeOf(row, 'args').title.includes('[0-9]{1,2}'), badgeOf(row, 'args').title);
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);