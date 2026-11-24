
    // ── [[command-gateway:boot-heal]] 「指令前置」插件自动维护，不要手改这一段 ──
    // 启动期自愈（ADR 0013）：在核心代码 import **之前**，把「指令前置」缺失的补丁补上。
    // 补丁改的是磁盘文件，进程一旦把旧代码加载进内存，这次启动就吃不到 —— 上游升级
    // 覆盖 src/ 后，原本要「重启 → 自愈 → 再重启」两轮；这一块把它并成一轮。
    // 只在插件启用过（activate 写下的旗标文件还在）时动手；停用后旗标已摘，这里不做事。
    // 目录名带版本号（command-gateway-1.7.0），不能写死：先按目录名扫描，
    // 找"有 patch.mjs + patch-on-boot.flag"的那一个 —— 换版本号也不用改这里。
    try {
      const { pathToFileURL } = await import('node:url');
      const pluginsRoot = path.join(__dirname, '..', 'plugins');
      let cgDir = null;
      try {
        for (const name of fs.readdirSync(pluginsRoot)) {
          if (!name.startsWith('command-gateway')) continue;
          const dir = path.join(pluginsRoot, name);
          if (fs.existsSync(path.join(dir, 'patch.mjs')) && fs.existsSync(path.join(dir, 'patch-on-boot.flag'))) {
            cgDir = dir;
            break;
          }
        }
      } catch { /* plugins 目录不存在就当没装 */ }
      if (cgDir) {
        const cg = await import(pathToFileURL(path.join(cgDir, 'patch.mjs')).href);
        const result = cg.apply();
        if (result.changed?.length) {
          console.log('[指令前置] 启动前已自动补上核心补丁：', result.changed.join('、'));
        }
        if (result.conflicts?.length) {
          console.warn('[指令前置] 启动期补丁有冲突，已保持原样：',
            result.conflicts.map((c) => `${c.file}（${c.detail || ''}）`).join('；'));
        }
      }
    } catch (error) {
      console.warn('[指令前置] 启动期自愈失败（不影响本次启动）：', error?.message ?? error);
    }
    // ── [[/command-gateway:boot-heal]] ──

