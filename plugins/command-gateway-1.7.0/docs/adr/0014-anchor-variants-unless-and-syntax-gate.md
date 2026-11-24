# 补丁引擎加固：候选锚点、unless/optional 门控、写盘前语法检查

**Status**: accepted（2026-09-28，补丁引擎 v6）

一份插件要同时活在一串核心版本上（0.3.1 / 0.4.0 / 0.4.0-bugfix），锚点被上游改一行就整块失效
—— 0.4.0-bugfix 就真实地改了两处（插件日志加 `util.format`、snowluma 监听改
`scheduleSnowlumaReload`）。引擎在 v6 加三道防线，原则不变：**宁可不打，也不打坏**。

1. **候选锚点**（1.3.1 起已有，v6 用足）：一个块带一串候选位置按序试。给 bugfix 的
   一律**新增**在旧候选之后，旧核心照常命中旧锚点 —— 一份补丁表服务所有版本。
   `loader-api` 的教训：锚点横跨的注释被上游扩成多行就断了，v6 起新候选只锚
   稳定的**那一行代码**，不捎带注释。
2. **unless / optional**：候选位置声明 `unless: '<子串>'` —— 文件里已有这个内容说明
   核心已内置同样能力，块在本核心记 `skipped`（不算冲突、不打、状态页不报警），
   首个使用处是 `reload-shortcut` 退役（bugfix 的壳自带 F5/Ctrl+R，不叠第二层监听）。
   块声明 `optional: true` —— 锚点在本核心不存在时同样 `skipped`，用于 `boot-heal`
   （headless 部署没有那条 import 语句）。这两种 `skipped` 都不阻塞 `apply()`。
3. **语法门禁**：`apply()` 在写盘前把"打完补丁的每个文件"交给 Node 解析器
   （`spawnSync(execPath, ['--check', tmp])`，Electron 下加 `ELECTRON_RUN_AS_NODE=1`）。
   解析目标按加载方式选：`src/`、`electron/` 与 `ui/app.js`（0.3.1 单文件入口，
   `<script type="module">`）按 ESM；`ui/app/0x-*.js` 是经典脚本（defer、共享全局作用域）
   按 CommonJS/Script 目标。解析不过 → 一个文件都不写，报 `conflict`。
   锚点唯一 + 行首两道检查挡不住"锚点其实落在字符串/模板里"这类事故，
   这一层的意义是**把语法坏文件从"重启后白屏"提前到"打补丁时就报错"**。

## Considered Options

- 用 AST（`acorn` / `espree`）做精确解析与锚点定位：最正确，但插件要保持零依赖、
  且要在 Electron 主进程里跑 —— `node --check` 是同一条解析器路径的零依赖近似。
- 锚点改成结构化（AST 节点匹配）：同上，且把"补丁表"从可读的文本行变成了抽象谓词，
  出冲突时人没法对着 UPGRADE.md 手工核对。
- 语法检查失败时只跳过该文件、其余照写：违反原子原则 —— 半新半旧的补丁状态
  比全没打更难排查。
- 检查器起不来（spawn 失败/超时）也报冲突：门禁自身的故障不该把插件卡死，
  此时放行并记录（锚点检查还兜着底）。

## Consequences

- 每次真实写盘多花几个子进程（约每文件几十毫秒，且只在有文件要写时发生；
  `apply()` 无事可做时在语法门禁之前就返回了）。
- `skipped` 成为与 `clean`/`patched` 并列的正常状态；设置页顶部那行不显示它
  （它描述整体状态，`skipped` 块既不冲突也不待办）。
- `ui/app/0x-*.js` 若哪天被核心改成 ES 模块，语法门禁的解析目标要跟着改
  —— 判据写在 `patch.mjs` 的 `syntaxCheck` 里，一条表达式，改起来一眼可见。
