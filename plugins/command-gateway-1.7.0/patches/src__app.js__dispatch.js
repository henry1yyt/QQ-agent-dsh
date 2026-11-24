
    // ── [[command-gateway:dispatch]] 「指令前置」插件自动维护，不要手改这一段 ──
    // ── 指令前置：在存档与会话创建之前，给「指令前置」插件一次认领机会 ──
    // 约定（见 plugins/command-gateway/README.md）：
    //   · dispatch 必须**同步**返回 { handled }；认领后要做的异步工作放进 run()，
    //     这样消息热路径不等待网络/模型调用；
    //   · handled = true → 不存档、不触发会话，彻底不诞生这条会话；
    //   · run() 还可以再返回 { passthrough } 表达「指令执行完后放行」：
    //       true         → 按消息原文放行（存档 + 触发会话，和没认领过一样）；
    //       非空字符串   → 用这段文本替代原文放行（修改后再进会话）；
    //       false / 缺省 → 不放行，消息到此为止。
    //     放行走的是下面的 releaseClaimed()：**不重新过拦截链**（防止链上插件
    //     二次认领造成循环），但指令禁言检查、链接媒体转发这些常规动作照常执行，
    //     原消息的媒体段原样保留。
    //   · 未认领、插件没装、插件抛错 → 一律原样放行，行为与没装插件完全一致。
    try {
      const dispatch = skillManager.getCapabilityProviders('command.dispatch')[0]?.fn;
      if (dispatch) {
        const chatKey = `${kind}:${id}`;
        // 指令目录：只取「声明了 command 的插件」的清单元信息，不做可用性计算
        //（用 registry.list() 而不是 skillManager.list()，避免每条消息都跑一遍
        //  isActive 依赖链）。插件自己会用 api.hasCapability 判断能力是否可用。
        const catalog = skillManager.registry.list()
          .map((s) => ({
            id: s?.manifest?.id,
            name: s?.manifest?.name,
            commands: Array.isArray(s?.manifest?.commands) ? s.manifest.commands : [],
            // 消息入口拦截声明：{ capability, order }（见 manifest.js 的 normalizeIntercept）
            intercept: s?.manifest?.intercept || null
          }))
          .filter((s) => s.id && (s.commands.length || s.intercept));
        const decision = dispatch({
          text,
          segments,
          rawMessage: String(event.raw_message ?? (typeof event.message === 'string' ? event.message : '') ?? ''),
          messageId: event.message_id != null ? String(event.message_id) : '',
          kind,
          chatId: String(id),
          chatKey,
          senderId,
          senderName,
          catalog,
          // v6：@ 判定标记透传（0.4.0-bugfix 起核心在入口算 atMe/atNames）。
          // 旧核心没有这两个变量 —— typeof 守卫，求值不到就不透传，子插件照旧用 payload.ats。
          ...(typeof atMe === 'boolean' ? { atMe, atNames } : {}),
          ctx: {
            kind, chatId: String(id), chatKey, onebot, sender, store, memory, log, emit,
            // 核心句柄：给「指令前置」把它包装成对外服务能力（ai.ask / search.web / history.read…）。
            // 插件不该自己 import src/，所以由核心在这一处把实例交出去。
            // chat 单独再给一份：链上的拦截者（比如隐私模式）要"用核心的模型链路问一次 AI"，
            // 这个口子以前是它自己插补丁时自带的，现在由调用点统一提供。
            host: {
              store, sessions, reminders, stickers, sender, onebot, orchestrator, memory, emit, log,
              dataDir: DATA_DIR,
              getConfig, updateConfig,
              chat: (messages, options = {}) => import('./llm.js').then((m) => m.chatCompletionWithRetry({
                messages,
                temperature: options.temperature ?? null,
                maxTokens: Number(options.maxTokens) || 0
              })),
              search: (query) => import('./web-search.js').then((m) => m.webSearch(query)),
              personas: () => import('./personas.js').then((m) => m.PERSONAS)
            },
            chat: (messages, options = {}) => import('./llm.js').then((m) => m.chatCompletionWithRetry({
              messages,
              temperature: options.temperature ?? null,
              maxTokens: Number(options.maxTokens) || 0
            }))
          }
        });
        if (decision && decision.handled === true) {
          if (typeof decision.run === 'function') {
            Promise.resolve()
              .then(() => decision.run())
              .then((r) => releaseClaimed(kind, id, text, media, event, senderId, senderName, r))
              .catch((error) => log(`[指令前置] 执行失败：${error?.message ?? error}`));
          }
          return;
        }
      }
    } catch (error) {
      log(`[指令前置] 分发失败，已按普通消息放行：${error?.message ?? error}`);
    }

    /**
     * 「执行完后放行」：把已认领的消息按插件的要求放回正常聊天流程。
     * 独立成函数声明，是为了让上面那条 Promise 链在 try 块结束之后仍能调到它。
     * 顺序说明：指令的回复此刻多半已经发出并入档（appendSelf），这里补存的是
     * 用户那条原始消息 —— 存档时间用消息本来的时间，不用现在，避免历史错序。
     */
    function releaseClaimed(kind, id, text, media, event, senderId, senderName, result) {
      const pass = result ? result.passthrough : undefined;
      if (pass === undefined || pass === null || pass === false) return;
      let body;
      if (pass === true) {
        body = String(text ?? '');
      } else {
        body = String(pass).trim();
        if (!body) {
          log('[指令前置] 放行文本为空，已忽略本次放行');
          return;
        }
      }
      const chatKey = `${kind}:${id}`;
      if (kind === 'group') {
        maybeTriggerCommandMute(id, body, event, typeof atMe === 'boolean' ? atMe : null);
      }
      // v6：接住 appendIncoming 的返回值传给 onIncoming —— bugfix 的编排器用它
      // 精确标"这条已读"；旧核心的 onIncoming 只认一个参数，多传的会被忽略。
      const entry = store.appendIncoming(chatKey, {
        mid: event?.message_id,
        ts: event?.time ? Math.round(Number(event.time) * 1000) : Date.now(),
        senderId,
        senderName,
        text: body || '[图片]',
        media,
        ...(typeof atMe === 'boolean' ? { atMe, atNames } : {})
      });
      emit('chat-update', chatKey);
      orchestrator.onIncoming(chatKey, entry);
      forwardLinkedMedia(kind, id, body).catch((e) => log(`[media] 链接转发失败：${e?.message ?? e}`));
    }
    // ── [[/command-gateway:dispatch]] ──

