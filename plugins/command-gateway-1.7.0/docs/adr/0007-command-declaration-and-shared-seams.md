# 指令「声明即生效」，共享缝改由指令前置统一提供

**Status**: accepted

原来是"插件声明 + 用户再去设置页接入一次"两步走。用户在装好 `shutdown-command` 之后发了 `/关闭电脑` 毫无反应 —— 因为清单里的声明只是"可以接入"的意思，没接入就不生效；`/帮助` 也只列已接入的，于是看起来像插件坏了。现在改成：**清单里的 `commands[]` 声明即生效**，插件装好、启用，指令就能用；设置页那张表变成**覆盖表**——用户改过的字段（指令词、别名、权限等级、超时、停用）才写进 `config.skills['command-gateway'].overrides`，其余仍读声明。这样插件升级新增一条指令时，用户不用做任何操作就能拿到。

同一轮里把"消息入口的拦截位"从"每个插件各自插一块补丁"改成**一条拦截链**：清单里声明 `intercept: { capability, order }` 的插件由指令前置按 order 依次询问，谁先返回 `{ handled: true }` 谁独占这条消息。隐私模式从"自己插补丁"改成"挂到链上"（order 10，排在指令前置的 50 之前），它的 `patch.mjs` 里已经没有补丁条目。

服务能力只补**官方确实没有给的那几个**：`ai.ask`（问模型）、`search.web`、`session.control`、`schedule.cron`、`sticker.pick`、`moderation.check`、`persona.apply`，外加每个插件独占的 `api.storage`。一开始还包了 `history.read` / `export.chat`（读存档）、`group.moderate`（群管理）、`ui.notify`（控制台通知），后来按"官方已有的注入点不重复实现"这条原则**全部删掉**了 —— 指令插件的 `payload.ctx` 里本来就有 `store` / `onebot` / `emit`，再包一层只会多一套要维护的说法。

## Considered Options

- 保持"声明 + 接入"两步：多一遍活，而且第二遍很容易忘（真实踩过）。权限安全性并不依赖"接入"这一步 —— 声明的默认等级照样拦得住人。
- 每个插件各自插自己的拦截补丁：`src/app.js` 上已经出现两块几乎同构的代码（隐私模式 + 指令前置），每多一个拦截类插件就多一块，上游一升级就多一个撞锚点的地方。
- 建一个只提供共享缝的「平台插件」（core-bridge）：职责更干净，但要多维护一个"只为别人服务"的插件，而且用户必须记得启用它；既然指令前置本来就是这个体系的前置，把缝放它那里即可。
- 声明即生效 + 指令前置提供共享缝（本决策）：少一层概念、少一类补丁；代价是指令前置成为"平台插件"，别的插件想用这些缝就得让它启用（缺了会显示「依赖未就绪」，不是静默失效）。

## Consequences

- **覆盖表只存差异**：设置页保存时会把每一行与声明值比对，一样的行不产生覆盖记录；`/帮助` 与运行时分发都读"声明 + 覆盖"合成后的有效指令表。
- **隐私模式依赖指令前置**：ADR-0006 当初担心的耦合现在被显式接受 —— 换来的是同一处缝只有一块补丁，而且"缺依赖"会在插件页写明。
- **拦截者必须同步返回** `{ handled }`：核心要立刻决定这条消息要不要诞生会话。写成 `async` 的拦截者会被明确警告并跳过（异步工作放进 `run()`）。
- **服务能力是公开 API**：清单里的 `exposes[]` 声明它们，审计脚本据此不再把"仓库里没有调用者"判成孤儿能力。
- 插件数据目录放在**数据根**下（`data/command_data/<插件 id>/`）而不是仓库根目录：多实例 profile、测试隔离、备份、打包排除都已经按数据根来；放仓库根会被打进安装包，还会被多个 profile 共用。
- **不重复实现官方注入点**：核心已经消费的能力（`chat.ban-state`、`llm.request-params`、`llm.response`、`llm.usage`、`tool.guard`、`message.owner-check`、`media.transcribe`…）与 5 个钩子、`activate/deactivate`、`configSchema` 自动渲染的设置页，都不再另造一套。当初设想过的 `ingest.rewrite` / `session.context`（= `before-context`）、`session.gate`（= `chat.ban-state`）、`ai.request-params` / `ai.response`（= `llm.*`）、`app.lifecycle`（= `activate/deactivate`）因此全部取消。
