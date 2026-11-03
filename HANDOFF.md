# VeriForge 当前交接

更新日期：2026-11-03。

## 当前任务和完成情况

用户明确授权第 5 步第一批实现。当前已交付 0.3.0：八个业务阶段按需指引、五份模板、十四张接入图，以及独立事实、交付物映射、遗留事项、扩展用例状态和格式 1／2 兼容。说明见 [本版实现记录](implementation-v0.3.md)，实际能力见 [包内能力说明](skills/qa-workflow/assets/capabilities.json)。

35 项本地行为测试通过，包括真实 0.2.1 历史包生成的旧资料兼容检查；静态 Skill 校验通过。新 ZIP 解压到独立临时目录完成 14 次合成 CLI 调用，68 个包内链接与 14 张图摘要／尺寸核对通过。依据见 [本地记录](verification/workflow-local-0.3.0.json) 和 [安装包记录](verification/workflow-bundle-0.3.0.json)。没有独立 Agent、真实业务或宿主兼容验收。

本机产物为 `dist/qa-workflow-0.3.0.zip`，52 个文件，8,250,333 字节；包摘要见实现记录。dist 被 Git 忽略，其他人可用打包工具从本版源码重建到新路径。未全局安装、上传公司平台或发布 GitHub Release。旧归档包未改。

仅维护 main，不建 worktree；没有创建新聊天或子代理，不跟进生产点检会话。本轮没有真实用户资料迁移、浏览器业务操作、知识库写入或禅道提交。

## 本轮代码边界

- workflow.record/read 分别保存业务理解、页面步骤、执行准备、实际评审、上线、稳定、知识和恢复事实，不自动判定整个需求完成。
- deliverable.set/list 固定本需求快照及版本，外部引用不等于远端已验证。
- followup.record/list 保存未完事项、下一步与结束依据，分页和归档后仍可查阅，不自动通知责任人。
- 扩展状态为 running／needs_verification／skipped／not_applicable；旧四种状态及历史 review 保留。更新结果重新置同步待核对，跳过不计通过。
- resume 和摘要新增上述资料，默认简洁，长依据有截断标记，可按引用读完整；本地历史与备份保留完整记录。
- 新空间根标记为格式 2；旧空间只读不写，使用新能力前显式 workspace.upgrade。活动任务、未知操作、资源占用阻止升级，旧运行器拒绝新空间，不能手改标记降级。
- 格式 2 修订使用 history-v2，避免升级中断的未提交新修订破坏旧备份扫描；新备份覆盖两种修订，旧备份可在新版恢复。恢复仍需要旧执行／资源核对。

CLI 仍没有外部自动调用。通用动作计划生成器、UI 契约执行器、HTTP 执行器、禅道客户端、Mind 自动节点映射和 KB 确认转发、截图标注统一入口均未交付。已有工具由获授权 Agent 按包内指引使用，不等于通用适配已实现。

## 下一批从哪里开始

按 [工具与适配范围](design/tool-adapters.md) 推进第二批：Mind／知识库目标与回执映射、证据和标注集成，再接 UI／HTTP 与禅道。先使用合成资料验证本地约定，外部写入在获授权测试空间验收。不要因本地检查通过就自动开始真实需求测试。

三项约定已经有依据，不需要重新讨论：

1. [知识库确认](design/contracts/knowledge-confirmation.md)：真实 schema 已留存；本地源码的 pending 绑定用户与 MCP 凭证、有 30 分钟有效期，pending_resolved 不等于成功。超时按 confirmation_id 查关联记录并回读；用户选择不由 Agent 代填，源码版本不等于现场部署版本。
2. [禅道 API](design/contracts/zentao-api.md)：已有四条历史 v1 POST 关闭回执，编码为 multipart comment + uid；创建图片的同会话 REST 上传和关联已有历史经验，独立 Token 上传绑定仍需验收。当前权限、事务 uid 来源和状态转换按实际实例核对，不写入真实 BUG 试探接口。
3. [宿主派发](design/contracts/host-dispatch.md)：本地动作计划 → Agent 调用宿主原生 MCP → 保存真实回执；额外 JavaScript 桥不是前置，不能新建连接绕过宿主工具限制。当前还没有新动作计划命令。

来源范围见 [工具核对](verification/tool-inventory-20261103.json)、[KB schema](verification/asynctest-kb-input-schemas-20261103.json)、[契约记录](verification/adapter-contracts-20261103.json)。WorkBuddy 与 Windows 为明确的后续验收目标，当前不称已兼容。

## 已准备的资源

原业务设计均保留在 design/stages/；3.4 评审已并入 3.3，后续编号不重排。包内 references/stages/ 是按需执行指引，设计文档不是唯一运行依赖。

Mind 三图、NexoFolio 九图和原 AsyncTest 两图已纳入当前包，输出字节与已核对素材一致；只含允许分发的导航输出，个人原图仅本地保留。图片在包中可读取，新会话回复区显示仍待真实验收。来源见 [素材清单](skills/qa-workflow/assets/guides/manifest.json) 和对应设计接入记录。

screenshot-annotator 0.1.0 源包、MIT 许可和摘要保留在 vendor，曾用于七张 NexoFolio 公开文档导航图，未改上游源码；没有纳入 0.3.0 自动标注入口。两张个人 NexoFolio 图使用 imagegen 遮挡，不能作为像素保真的测试证据。详情见 [标注基线](design/integrations/screenshot-annotator.md)。

迁移来源、21 次目录历史及旧包见 [迁移记录](docs/migration/2026-11-02.md)。旧 GreeSalesCloud 的业务模块和数据保留原处，不在两个仓库维护同一份 Skill。

## 必须延续的用户要求

自然引导；需求澄清追查必要历史且以支撑用例为边界；页面随时补采；用例分场景并独立编号，保留少量相关完整链路；默认专用 headless Chrome DevTools；UI BUG 简洁并有真实标注图；提交关闭按授权 API；知识最终入库等正式上线和短期稳定确认；阶段收尾不消除遗留事项。

多项目隔离和共享引用明确，长期留存原文及版本；记录、实际外部操作、同步与备份恢复分别说明。无自动化时不声称持续监听、自动醒来或通知。源码、验证和产物变更只提交本次核对范围并及时推送 main。
