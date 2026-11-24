# 增删改「指令前置」自带指令 —— 开发者手册

面向改这个插件的人（也是 AI）。目标：**加一条指令 / 删一条指令 / 改一条指令的行为**，
只改一个文件、跑一条命令，别的都自动跟上。

相关文件：

| 文件 | 角色 | 要不要动 |
|---|---|---|
| `command-spec.js` | 指令声明表的**单一真相**（`BUILTIN_SPECS`）+ 白名单/参数格式工具 | ✅ 增删改指令改这里 |
| `manage-commands.mjs` | 开发者 CLI：`list` / `check` / `sync` | 工具，一般不动 |
| `plugin.json` | 清单：`commands[]` 与 `capabilities[]` **由 sync 生成** | ❌ 不要手改指令段 |
| `builtin-commands.js` | 指令的**执行体**（键 = `capability`） | ✅ 新增/删除指令要同步改 |
| `index.js` | 运行时：解析、权限、白名单闸、参数格式闸、路由 | 一般不动 |
| `settings-ui.js` | 设置页：逐条改启用/白名单/参数格式 | 一般不动 |
| `tests/*.test.mjs` | 回归测试 | 改了逻辑就加断言 |

---

## 0. 速查

```bash
cd plugins/command-gateway-1.7.0

node manage-commands.mjs list      # 查：当前指令表（含白名单模式与参数格式）
node manage-commands.mjs check     # 查：声明是否合法、plugin.json 是否已同步
node manage-commands.mjs sync      # 改：把声明写回 plugin.json（commands[] + capabilities[]）

node tests/scope-args.test.mjs          # 跑运行链路回归（19 条断言）
node tests/settings-ui-render.test.mjs  # 跑设置页渲染冒烟（9 条断言）
```

**加一条指令** = ① `command-spec.js` 里加一个 spec → ② `builtin-commands.js` 里加同名能力 →
③ `node manage-commands.mjs sync` → ④ 跑测试。**不需要重启**（插件代码与清单都是热生效）。

---

## 1. 加一条指令

### 1.1 在 `command-spec.js` 的 `BUILTIN_SPECS` 里加一条

```js
{
  id: 'weather',                       // 稳定标识，别复用；配置按 `插件id:id` 存
  word: '天气',                        // 默认指令词（用户在设置页可改）
  aliases: ['tq'],                     // 可选
  capability: 'command.weather',       // 执行能力名：必须与 providers 的键一致
  description: '查询城市天气',          // 必填，/帮助 里显示
  argsHint: '[城市名]',                 // 可选，/帮助 与用法提示用
  examples: ['/天气 珠海'],             // 可选，最多 5 条
  permission: 1,                       // 0~100000；不写按 1（比默认权限 0 高一级 = 默认没人能用）
  timeoutMs: 20000,                    // 可选，>= 1000；不写用前置默认 30000
  args: {                              // 可选：参数格式（见 §4）
    pattern: '^\\S+$',
    strict: true,
    usage: '/天气 城市名'
  },
  scope: {                             // 可选：这条指令自己的白名单（见 §5）
    mode: 'inherit',                   // inherit（默认，沿用全局规则）/ strict（只看名单）
    groups: [],
    friends: []
  }
}
```

### 1.2 在 `builtin-commands.js` 的 `BUILTIN_COMMANDS` 里实现它

键就是 `capability`，**必须是 async**：

```js
export const BUILTIN_COMMANDS = {
  'command.weather': async ({ args, ctx, chat }) => {
    if (!args) return { text: '用法：/天气 城市名' };
    return { text: `${args}：晴，25℃` };     // 返回文本 = 前置代发
  }
};
```

三条铁律（文件头注释也是这么写的）：

- 群管理动作走 `ctx.onebot.call(...)`，别自己建连接；
- **发送一律靠"返回文本"**让前置代发，不要自己碰发送队列；
- 失败用 `{ ok: false, error: '人话' }`；原始错误只进日志（`error` 会发到群里，别塞内部信息）。

### 1.3 同步清单

```bash
node manage-commands.mjs sync
```

它会：把 `commands[]` 整段重写成声明表的顺序；把缺的能力名补进 `capabilities[]`；
删掉的指令对应的能力名也会从 `capabilities[]` 里摘掉；**写盘后自查一次**（JSON 能解析、声明与清单一致），
不一致就报错退出、不会留下半截状态。

### 1.4 校验

```bash
node manage-commands.mjs check      # 应为 ✓
node tests/scope-args.test.mjs
node tests/settings-ui-render.test.mjs
```

---

## 2. 删一条指令

1. 从 `BUILTIN_SPECS` 里删掉那条；
2. 从 `BUILTIN_COMMANDS` 里删掉同名能力（留着也不会被调用，但审计会报"孤儿能力"）；
3. `node manage-commands.mjs sync`（会自动摘掉 `capabilities[]` 里的对应项）；
4. 跑测试。

**不要去清用户的 `overrides[]`**：那只是"差异记录"，指令没了它自然不匹配，留着不影响。
也不要动 `RESERVED_WORDS`（在 `settings-ui.js`）——只有当被删的指令词要"释放给别的插件"时才需要删那一项。

---

## 3. 改一条指令

| 想改什么 | 改哪里 | 注意 |
|---|---|---|
| 指令词 / 别名 | `command-spec.js` 的 `word` / `aliases` | 改完 sync；`settings-ui.js` 的 `RESERVED_WORDS` 要跟着改 |
| 描述 / 用法提示 / 示例 | `description` / `argsHint` / `examples` | `/帮助`、设置页都读它 |
| 权限等级 | `permission` | 0~100000；设置页显示成「可见范围」下拉：所有身份 = 0 / 仅管理者 = 100000 / 自定义等级…。**两档身份模型下这不是普通成员的主要闸门** —— 普通成员由该指令自己的 `scope` 白名单把关 |
| 超时 | `timeoutMs` | `>= 1000`；不写用前置默认 |
| 参数格式 | `args` | 见 §4 |
| 白名单默认值 | `scope` | 见 §5 |
| 行为本身 | `builtin-commands.js` 里的实现 | 参数解析的公共件在 `args.js`（`pickTarget` / `parseDuration` / `resolveMemberName` …） |
| 执行后放行 | spec 里的 `passthrough` | `"original"` / `"prefix"` / `"args"` 或 `{ mode, onFail }` |

改完照旧：`sync` → `check` → 跑测试。

---

## 4. 参数格式（`args`）

```js
args: {
  pattern: '^(?:"?\\d{5,12}"?|@\\S+)(?:\\s+.*)?$',  // 正则源码，对"参数原文"整串匹配
  flags: '',                                        // 只认 gimsuy
  strict: true,                                     // false（或不写）= 完全不校验
  usage: '/禁言 "QQ号" [时间=30分钟]'                // 格式不对时回给用户的那句话
}
```

口径：

| 情况 | 行为 |
|---|---|
| `strict` 不为真 | 不校验（老行为） |
| `strict` 为真、`pattern` 非空、参数匹配 | 正常执行 |
| `strict` 为真、`pattern` 非空、参数不匹配 | **不执行**，回 `usage`（没写 `usage` 就回「前缀+指令词+argsHint」加一条示例） |
| `strict` 为真、`pattern` 为空 | 要求**不带参数**（`/暂停 吧` 会被拒） |
| 正则写坏了 | 运行时**一律放行**（宁可放行也不把指令整条废掉），但设置页会当场提示并拒绝保存 |

"参数原文"= `commandPayload.args`，即**去掉前缀与指令词、剥掉前导引用/艾特之后**剩下的那段文本。
注意：前置艾特形式（`@机器人 /禁言 10001`）会把前导 `@` 剥进 `ats`，而 `/禁言 @张三 10` 里的 `@张三` 留在参数里 ——
两条路都要能在 `pattern` 里覆盖到。

内置 8 条的默认写法（都在 `command-spec.js` 里，可照抄）：

| 指令 | pattern | 说明 |
|---|---|---|
| 禁言 / 解禁 | `^(?:"?\d{5,12}"?|@\S+)(?:\s+.*)?$` | 目标必须是 `@某人` 或 QQ 号（可带引号），后面可跟时间等参数 |
| 全体禁言 / 全体解禁 / 暂停 | （空） | 不许带参数 |
| 继续 | `^(?:丢弃积压|丢弃|丢掉|不要积压)?$` | 只认这几种写法 |
| 抛骰子 | `^\d*$` | 只认数字 |
| 猜拳 | `^(?:石头|剪刀|布)?$` | 只认三种出拳 |

---

## 5. 按指令独立白名单（`scope`）

```js
scope: {
  mode: 'strict',                             // inherit = 不额外限制；strict = 普通成员必须命中名单
  groups: [{ id: '123456', name: '测试群' }], // 群聊可用群（只对普通成员生效）
  friends: [{ id: '10001', name: '小明' }]    // 私聊可用好友（只对普通成员生效）
}
```

口径（两档身份：**管理者** = 权限表里勾了「管理者」或等级 ≥ 100000；其余都是**普通成员**）：

| 情况 | 行为 |
|---|---|
| 发送者是管理者 | **一律放行**，不看名单（之后照旧过权限等级、静默、冷却） |
| 不写 / `mode: 'inherit'` | 不额外限制：沿用全局规则（权限等级 + 群黑名单 + 私聊开关），与老版本一致 |
| `mode: 'strict'` + 普通成员**命中名单** | 群聊：**群号命中**（整群可用）**或发言人 QQ 命中好友名单**（本人可用，跨群生效）；私聊：对方 QQ 命中好友名单。放行后照旧过权限等级、静默、冷却 |
| `mode: 'strict'` + 普通成员没命中（含两个名单都为空） | 与「权限不足」同处理：**不拦截、不回执**，消息按普通消息走聊天流程；只记一条「最近调用」（原因 `不在指令白名单`） |
| 拿不到会话类型 + strict + 普通成员 | 拒绝 |

两条要点：

- 它**与全局的 `groupBlacklist` / `userWhitelist` 互不影响** —— 全局白名单只豁免群黑名单那道闸，不会让某条指令的独立白名单失效；
- `/帮助` 对普通成员不列出被独立白名单挡住的指令；管理者看到全部。

用户在设置页（指令前置 → 指令 → 展开某一行 → 独立白名单）可以逐条打开/关闭并维护两张名单，
覆盖写进 `overrides[].scope`，**声明里的默认值不变**（插件升级改了默认值，没动过的用户会自动跟上）。

---

## 6. 运行时判定顺序（改了会影响谁）

`index.js` 的 `dispatchSelf()`，一条指令要依次过这些闸：

```
解析前缀/指令词 → 权限 -1（明令禁止）→ 指令静默 → 元指令分支
  → findRoute（命中哪条指令）
  → 权限等级：level < permission  → 放行（当没这条指令）
  → 独立白名单：scopeAllows(...)  → 放行（当没这条指令）
  → 参数格式：matchArgsSpec(...)  → 回一句用法
  → 去重 → 冷却 → 记静默计数 → 执行
```

新增闸门时的两条约定：

- 「这条指令对你不可见」类（权限、白名单）→ 返回 `{ handled: false }`，**不要回执**；
- 「你用错了」类（参数格式）→ 返回 `{ handled: true, run: () => 回一句用法 }`。

---

## 7. 设置页能改什么

设置页 → 侧栏「指令前置」→ 「指令」段落，每条指令一行（点 `▸` 展开）：

| 能改 | 存到哪 |
|---|---|
| 启用 / 停用 | `overrides[].enabled` |
| 可见范围（所有身份 / 仅管理者 / 自定义等级…） | `overrides[].permission`（0 / 100000 / 自定义数字） |
| 指令词 / 别名 / 超时 / 不计入触发次数 | `overrides[]` 对应字段 |
| **独立白名单**（开关 + 可用群 + 可用好友，支持"选择群/选择好友"；只约束普通成员） | `overrides[].scope` |
| **参数格式**（严格开关 + 正则 + 用法提示） | `overrides[].args` |
| 「恢复声明值」 | 删掉这条 `overrides` 记录 |

> 折叠标题上的 `独立白名单`、`严格格式` 两个气泡是**实时**的：勾选/取消开关、改正则、
> 加减名单、手打 QQ/群号都会当场更新（`refreshRowBadges()`），不用等自动保存或整页刷新。

权限表（人员身份）同理：**身份下拉**（管理者 / 普通成员 / 自定义等级…）写进 `permissions[]`，
管理者写 `{ "qq": "...", "admin": true }`，普通成员写 `{ "qq": "...", "level": 0 }`。

只写差异：与声明一致就不落盘，所以插件升级调整了默认值，没动过那一行的用户会自动跟上。

---

## 8. 测试

```bash
node tests/scope-args.test.mjs           # 真实 dispatch 链路：白名单闸 / 参数格式闸 / 覆盖优先 / /帮助 过滤
node tests/settings-ui-render.test.mjs   # 假 ctx 渲染设置页：新控件都在、值渲染正确
```

`scope-args.test.mjs` 会把 `QQ_AGENT_DATA_DIR` 指到临时目录（插件要写"最近调用"，别污染真实配置），
用假 `api`/假 `ctx` 跑 `providers['command.dispatch']`。加新闸门时照抄它最后的断言写法即可。

改了 `settings-ui.js` 之后，除了渲染冒烟，**建议真开一次控制台看一眼**（改动只在浏览器里跑，
Node 解析通过不代表运行时不炸 —— 这是这个插件历史上真出过白屏的地方）。

---

## 9. 常见坑

| 坑 | 说明 |
|---|---|
| 三处一致 | `spec.capability` = `plugin.json.capabilities[]` 里的项 = `BUILTIN_COMMANDS` 的键，缺一不可（sync 只管前两处） |
| 能力必须 async | 同步抛错会被前置的错误隔离吞掉，表现为"静默成功、无回复" |
| 改了 `RESERVED_WORDS` | 在 `settings-ui.js` 顶部；新增/删除指令词要同步，否则别的插件可以占用同名指令词 |
| 忘了 sync | `manage-commands.mjs check` 会报「plugin.json 的 commands[] 与声明不一致」，CI/自查跑一下就知道 |
| 不要手改 `plugin.json` 的 `commands[]` | 下次 sync 会覆盖掉；声明以 `command-spec.js` 为准 |
| 重启？ | 改插件代码/清单**不需要**重启（热重载）；只有核心补丁块的首次打入或内容升级才要重启 |
| 白名单开了却是空的 | 这是有意为之（空 = 普通成员谁都不能用），要么把要用的人/群填进去，要么把开关关掉；管理者不受名单限制，始终能用 |
| 声明了 `scope`/`args` 却没生效 | 核心侧的清单归一化是**白名单式**的：不显式收进来的键会被丢掉。这两个字段由补丁块 `manifest-normalizers`（v7 起）保留；如果你的核心是别处来的、或把补丁摘了，声明就传不到插件。改这一块要 `PATCH_VERSION` +1 并重启一次 |