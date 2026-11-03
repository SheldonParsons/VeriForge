# VeriForge 0.3.0：业务指引与本地工作流记录

日期：2026-11-03。用户明确授权第 5 步第一批实现，本次完成包内阶段指引、模板、接入图文、独立事实／交付物／遗留事项记录及旧格式兼容。没有迁移真实用户工作空间、执行真实页面或远端写入，没有全局安装、上传 SkillHub 或发布 GitHub Release。

## 已交付

- 八个业务阶段的按需指引：需求澄清、各阶段页面取证、业务用例与修订、执行、BUG、复验、上线后知识、收尾；独立评审不作为必经关卡。
- 五份轻量模板：需求、场景用例、BUG、知识、交接；用户自己的格式优先。
- 十四张接入图：AsyncTest 下载及 KB 两张、Mind 三张、NexoFolio 九张。只包含已核对输出，个人原始截图没有入包。
- 本地 workflow.record/read，分别保存业务准备、页面步骤、执行准备、实际评审、上线、稳定、知识和恢复事实；有证据要求和事实不一致提示。
- deliverable.set/list 固定交付物快照及版本；followup.record/list 保留未完事项、下一步和结束依据，支持分页、历史和归档后查阅。
- 执行结果新增 running、needs_verification、skipped、not_applicable；保留旧四种状态及历史，不将局部完成或跳过计为通过。修改结果后同步状态重新待核对。
- resume 和可重建摘要包含新记录，默认返回有明确截断标记的简洁信息；完整依据保留在记录中，按需展开。

入口为 [SKILL.md](skills/qa-workflow/SKILL.md)，参数与格式见 [调用说明](skills/qa-workflow/references/cli.md) 和 [记录与升级](skills/qa-workflow/references/workflow-records.md)。Python 3.11+ 标准库即可运行 CLI；新增图文不引入运行依赖。

## 格式兼容与恢复

运行器支持记录格式 1／2。新空间的根记录使用格式 2；旧空间只读不改文件，新增记录和扩展状态前须 workspace.upgrade。升级仅修改根标记并保留旧修订，活跃任务、未知操作或资源占用会阻止升级。

旧 0.2.1 运行器会明确拒绝格式 2 空间，避免静默漏掉新记录；不支持用旧代码继续写新空间。旧 review 及结果不重排、不重写，新字段与旧数据分别保留。回退应恢复升级前备份到新目录，不能手改根标记降级。

格式 2 历史单独保存在 history-v2，revision 链携带 previous_schema。这使根标记替换前中断产生的未提交新历史不会破坏旧版备份扫描。新版备份包括新记录和两种历史；备份容器格式仍为 1，记录格式与容器格式不同。恢复副本仍要求旧执行、未知动作和资源核对。

重要限制：这些是合作式本地状态约束，source_execution_stopped 是核对记录，不是自动停止外部进程。内容真实性和业务判断仍需实际证据，文件摘要只证明保存完整性。

## 验证

本地行为测试 35 项通过（原基础测试 24 项＋新工作流／兼容测试 11 项）。使用仓库中真实的 0.2.1 历史安装包生成旧格式工作空间，验证只读不变、评审和失败记录保留、显式升级、旧运行器拒绝新格式、旧备份可恢复、升级中断及未知动作阻止升级。

Skill 静态格式校验通过。独立临时目录解压新 ZIP 后完成 14 次合成 CLI 调用，包含预期的缺证据拒绝，检查独立事实、交付物、遗留事项、摘要、备份和恢复；68 个包内链接、14 张图像摘要与尺寸核对通过。不是独立 Agent 自主行为测试，也不是 Codex／WorkBuddy 图文渲染验收。

记录：[本地检查](verification/workflow-local-0.3.0.json)、[独立安装包检查](verification/workflow-bundle-0.3.0.json)。本轮没有新的业务 HTTP、MCP 写入、浏览器或禅道调用。

## 安装包

本机输出：`dist/qa-workflow-0.3.0.zip`，52 个文件，8,250,333 字节。

SHA-256：`4babb4b9c053d12c456ff0d75161b162ac21522e09fd6137b26d6eafc1e5d220`。

旧归档包保持原样，dist 是被忽略的本地构建产物。可从本次源码重建到一个尚不存在的目标：

```sh
python3 tools/package_skill.py --output dist/qa-workflow-0.3.0.zip
python3 tools/verify_workflow_bundle.py --archive dist/qa-workflow-0.3.0.zip --report .local/bundle-check.json
```

目标文件不得覆盖；本机已有同名产物时选择新路径。包内不依赖 VeriForge 开发目录或原 GreeSalesCloud 仓库。

## 下一批范围与未完成项

阶段规则和本地记录已交付，CLI 仍不执行外部业务。通用动作计划生成器、Mind 节点映射与写回适配、KB 确认转发、截图标注调用入口、UI 模块执行器、HTTP 执行器和禅道客户端尚未实现。已有合适工具可由获授权 Agent 按指引使用，但不能据此把上述通用适配标为已交付。

下一批优先推进 Mind／知识库的目标与回执映射、证据及标注集成，再接 UI／接口和禅道；真实写入在获授权测试空间验收。独立会话走读、WorkBuddy／Windows 实机、完整流程、性能对照、全局安装和平台上传仍待后续安排。
