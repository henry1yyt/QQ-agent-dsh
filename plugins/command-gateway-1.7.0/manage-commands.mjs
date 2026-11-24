#!/usr/bin/env node
// 指令前置 · 开发者命令行：指令声明的 查 / 增删改 配套工具
//
//   node plugins/command-gateway-1.7.0/manage-commands.mjs list      列出当前声明（含白名单模式与参数格式）
//   node plugins/command-gateway-1.7.0/manage-commands.mjs check     校验声明，并比对 plugin.json 是否已同步
//   node plugins/command-gateway-1.7.0/manage-commands.mjs sync      把 command-spec.js 的声明写回 plugin.json
//   node plugins/command-gateway-1.7.0/manage-commands.mjs sync --dry-run   只看会改什么，不写文件
//
// 增删改的姿势：只改 command-spec.js 的 BUILTIN_SPECS，然后 sync。
//   · 加一条：BUILTIN_SPECS 里 push 一个对象（id/word/capability/description/permission 必填），
//     再去 builtin-commands.js 的 BUILTIN_COMMANDS 里实现同名能力（键 = capability）。
//   · 删一条：从 BUILTIN_SPECS 里删掉；记得把 builtin-commands.js 里的实现一起删。
//   · 改一条：直接改字段；改完 sync，清单里的 commands[] 与 capabilities[] 自动跟上。
//
// 为什么要有这个工具：清单里的 commands[] 与代码里的实现是"双份定义"，
// 手工同步容易漏掉 capabilities[]（漏了审计会报孤儿能力、插件也不会被调用）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_SPECS, validateSpec, specsToCommands, specsToCapabilities, scopeSummary
} from './command-spec.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = path.join(DIR, 'plugin.json');

const args = process.argv.slice(2);
const cmd = String(args[0] || 'list');
const dryRun = args.includes('--dry-run') || args.includes('-n');

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
}

function writeManifest(data) {
  fs.writeFileSync(MANIFEST, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/** 声明里的参数格式摘要。 */
function argsSummary(spec) {
  const a = spec?.args;
  if (!a) return '-';
  const pattern = a.pattern ? `/${a.pattern}/` : '(无参数)';
  return `${a.strict ? '严格 ' : ''}${pattern}`;
}

function cmdList() {
  const rows = BUILTIN_SPECS.map((s) => [
    s.id,
    s.word,
    (s.aliases || []).join(',') || '-',
    s.capability,
    String(s.permission ?? ''),
    s.timeoutMs ? `${s.timeoutMs}ms` : '-',
    scopeSummary(s.scope),
    argsSummary(s)
  ]);
  const head = ['id', '指令词', '别名', '能力', '权限', '超时', '白名单', '参数格式'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const line = (cells) => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
  console.log(line(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
  console.log(`\n共 ${BUILTIN_SPECS.length} 条。增删改都在 command-spec.js 的 BUILTIN_SPECS，改完跑 sync。`);
}

/** 校验声明 + 与清单比对，返回问题列表。 */
function collectProblems(manifest) {
  const problems = [];
  for (const spec of BUILTIN_SPECS) {
    for (const p of validateSpec(spec)) problems.push(`${spec?.id ?? '(无 id)'}: ${p}`);
  }
  const ids = new Set();
  for (const spec of BUILTIN_SPECS) {
    if (ids.has(spec.id)) problems.push(`${spec.id}: id 重复`);
    ids.add(spec.id);
  }
  const want = JSON.stringify(specsToCommands(), null, 2);
  const have = JSON.stringify(manifest.commands ?? [], null, 2);
  if (want !== have) problems.push('plugin.json 的 commands[] 与声明不一致 —— 跑一次 sync');
  const wantCaps = specsToCapabilities();
  const missing = wantCaps.filter((c) => !(manifest.capabilities || []).includes(c));
  if (missing.length) problems.push(`plugin.json 的 capabilities[] 缺：${missing.join(', ')}`);
  return problems;
}

function cmdCheck() {
  const manifest = readManifest();
  const problems = collectProblems(manifest);
  if (!problems.length) {
    console.log(`✓ 声明与 plugin.json 一致（${BUILTIN_SPECS.length} 条指令）`);
    return 0;
  }
  console.error('✗ 发现问题：');
  for (const p of problems) console.error(`  · ${p}`);
  return 1;
}

function cmdSync() {
  const manifest = readManifest();
  const problems = BUILTIN_SPECS.flatMap((spec) => validateSpec(spec).map((p) => `${spec?.id ?? '(无 id)'}: ${p}`));
  if (problems.length) {
    console.error('✗ 声明自身有问题，先修好再 sync：');
    for (const p of problems) console.error(`  · ${p}`);
    return 1;
  }

  const beforeCommands = manifest.commands ?? [];
  const afterCommands = specsToCommands();
  const beforeIds = beforeCommands.map((c) => c.id);
  const afterIds = afterCommands.map((c) => c.id);
  const added = afterIds.filter((id) => !beforeIds.includes(id));
  const removed = beforeIds.filter((id) => !afterIds.includes(id));
  const changed = afterIds.filter((id) => {
    const a = afterCommands.find((c) => c.id === id);
    const b = beforeCommands.find((c) => c.id === id);
    return b && JSON.stringify(a) !== JSON.stringify(b);
  });

  // capabilities：服务能力原样保留；指令能力跟着声明表走
  const caps = Array.isArray(manifest.capabilities) ? [...manifest.capabilities] : [];
  const oldCommandCaps = beforeCommands.map((c) => c.capability).filter(Boolean);
  const keep = caps.filter((c) => !oldCommandCaps.includes(c) || specsToCapabilities().includes(c));
  for (const c of specsToCapabilities()) if (!keep.includes(c)) keep.push(c);

  const changes = [];
  if (added.length) changes.push(`新增指令：${added.join(', ')}`);
  if (removed.length) changes.push(`删除指令：${removed.join(', ')}`);
  if (changed.length) changes.push(`更新指令：${changed.join(', ')}`);
  if (JSON.stringify(keep) !== JSON.stringify(caps)) changes.push(`capabilities：${caps.join(',')} → ${keep.join(',')}`);

  if (!changes.length) {
    console.log('✓ 已经是最新，无需改动');
    return 0;
  }
  console.log(dryRun ? '（dry-run）将做以下改动：' : '已同步以下改动：');
  for (const c of changes) console.log(`  · ${c}`);

  const next = { ...manifest, commands: afterCommands, capabilities: keep };
  if (dryRun) return 0;
  writeManifest(next);

  // 写盘后自查一次，别把清单写坏（解析得回来、声明与清单一致）
  const verify = readManifest();
  const left = collectProblems(verify);
  if (left.length) {
    console.error('✗ 写回后校验失败，请检查 plugin.json：');
    for (const p of left) console.error(`  · ${p}`);
    return 1;
  }
  console.log('✓ plugin.json 已更新并通过校验');
  return 0;
}

switch (cmd) {
  case 'list':
    cmdList();
    process.exit(0);
  case 'check':
    process.exit(cmdCheck());
  case 'sync':
    process.exit(cmdSync());
  default:
    console.error(`未知子命令：${cmd}`);
    console.error('用法：manage-commands.mjs <list|check|sync> [--dry-run]');
    process.exit(2);
}