// 指令前置 · 设置页渲染冒烟测试（不需要浏览器）
//
// 跑法（在仓库根目录）：node plugins/command-gateway-1.7.0/tests/settings-ui-render.test.mjs
//
// 为什么要有它：设置页是插件自带的浏览器模块，改坏了在控制台里只会表现为
// "这一块空白"，没有任何报错窗口能看。这里用假 ctx 调一次 render()，
// 至少保证 HTML 拼得出来、新加的白名单/参数格式控件在输出里。

import { render } from '../settings-ui.js';

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
        argsHint: '[面数=6]',
        permission: 0,
        args: { pattern: '^\\d*$', strict: true, usage: '/抛骰子 [面数=6]' }
      },
      {
        id: 'mute',
        word: '禁言',
        capability: 'command.mute',
        description: '禁言某人',
        permission: 100000,
        scope: { mode: 'strict', groups: [{ id: '111', name: '一群' }], friends: [] }
      }
    ]
  }
];

const config = {
  skills: {
    'command-gateway-1.7.0': {
      prefix: '/',
      permissions: [
        { qq: 'default', level: 0 },
        { qq: '1149225051', admin: true }
      ],
      overrides: [
        { pluginId: 'command-gateway-1.7.0', id: 'dice', args: { pattern: '^\\d{1,2}$', strict: true, usage: '/抛骰子 两位数' } }
      ]
    }
  }
};

const ctx = {
  pluginId: 'command-gateway-1.7.0',
  sectionId: 'command',
  entrySeq: 1,
  esc: (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
  api: async () => ({}),
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

let html = '';
try {
  html = render(ctx);
  check('render() 不抛异常', true);
} catch (error) {
  check('render() 不抛异常', false, error?.stack ?? String(error));
}

if (html) {
  check('返回的是 HTML 字符串', typeof html === 'string' && html.includes('cg-layout'), typeof html);
  check('基础段落还在（前缀 / 权限表 / 群白名单）',
    html.includes('id="cg-prefix"') && html.includes('cg-perm-rows') && html.includes('cg-gwhite-rows'));
  check('三张全局名单都在：「群白名单」「QQ 白名单」「QQ 黑名单」',
    html.includes('id="cg-gwhite-rows"') && html.includes('id="cg-qw-rows"') && html.includes('id="cg-qb-rows"')
    && html.includes('群白名单') && html.includes('QQ 白名单') && html.includes('QQ 黑名单'));
  check('旧的「群黑名单 / 全局白名单」已经不在页面里',
    !html.includes('cg-gblack-rows') && !html.includes('cg-wl-rows') && !html.includes('群黑名单'));
  check('指令表还在', html.includes('id="cg-routes"') && html.includes('data-id="dice"'));
  check('每条指令都有「独立白名单」控件', (html.match(/cg-scope-on/g) || []).length >= 2, String((html.match(/cg-scope-on/g) || []).length));
  check('每条指令都有「参数格式」控件', (html.match(/cg-args-pattern/g) || []).length >= 2, String((html.match(/cg-args-pattern/g) || []).length));
  check('声明了 scope/args 的指令渲染出对应值',
    html.includes('data-scope-list="groups"') && html.includes('value="111"') && html.includes('{1,2}$'),
    html.includes('{1,2}$') ? '' : '没找到覆盖后的正则');
  check('头部徽标：独立白名单 / 严格格式', html.includes('独立白名单</span>') && html.includes('严格格式</span>'));
  check('选择群 / 选择好友 / 加一行 按钮都在',
    html.includes('data-cg-act="scope-pick"') && html.includes('data-cg-act="scope-add"') && html.includes('选择群') && html.includes('选择好友'));
  check('权限表用「身份」下拉（管理者 / 普通成员 / 自定义等级），默认管理员行选中管理者',
    html.includes('cg-perm-role')
    && html.includes('>普通成员</option>') && html.includes('>管理者</option>') && html.includes('>自定义等级…</option>')
    && /value="admin" selected/.test(html),
    /value="admin" selected/.test(html) ? '' : '没找到被选中的管理者');
  check('指令行 / 元指令行用「可见范围」下拉（所有身份 / 仅管理者）',
    html.includes('cg-perm-kind') && html.includes('>所有身份</option>') && html.includes('>仅管理者</option>'));
  check('白名单提示是「普通成员 / 管理者」口径',
    html.includes('独立白名单（普通成员）') && html.includes('普通成员谁都不能用'));
} else {
  for (const name of ['返回的是 HTML 字符串']) check(name, false, 'render 没产出内容');
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);