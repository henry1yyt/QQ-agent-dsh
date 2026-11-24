  // ── [[command-gateway:render-settings]] 「指令前置」插件自动维护，不要手改这一段 ──
  // 插件设置页的内容是异步加载的（动态 import 插件目录里的模块），
  // 所以同步把壳放好之后在这里启动挂载；不是插件分区时它会顺手卸载上一个。
  pluginSectionMount = mountPluginSection();
  // ── [[/command-gateway:render-settings]] ──
