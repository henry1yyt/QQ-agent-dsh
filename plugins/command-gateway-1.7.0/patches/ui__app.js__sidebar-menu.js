  // ── [[command-gateway:sidebar-menu]] 「指令前置」插件自动维护，不要手改这一段 ──
  // 插件自带设置页（清单里声明了 settingsUi 的插件）的侧栏入口。
  // 追加到菜单末尾（排在彩蛋按钮之前）：锚点挂在**渲染侧栏的那条语句**上，
  // 与菜单里有哪些子页面无关 —— 魔改版删项 / 加项都不会让补丁失效。
  // （注：这段注释里刻意不写锚点原文，否则它自己会被锚点唯一性检查数进去。）
  menu.push(...pluginSections().map((p) => [p.key, p.label]));
  // ── [[/command-gateway:sidebar-menu]] ──
