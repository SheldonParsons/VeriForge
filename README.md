# VeriForge

让 AI 理解需求，让测试有据可循。

更新时间：2026-11-03。当前实现版本为图文指引版 0.2.1，已加入 AsyncTest 下载及知识库 MCP 标注示意图；新会话图片展示待真实验收。基础运行器与此前走读保留独立验证记录，尚未全局安装或上传平台。

VeriForge 是面向 AI Agent 的测试工作流 Skill 项目。本仓库集中维护设计、源码、测试和验证资料，后续仅维护 `main`。2026-11-02 从 GreeSalesCloud 的 `skill-development/` 独立迁移，并保留该目录的 21 次 Git 提交历史。

品牌和仓库名称为 VeriForge；现有技能标识、源码目录、CLI 及备份格式保留 `qa-workflow`，保持 0.2.1 及历史产物兼容。仓库改名没有新增业务自动化能力。

## 从这里开始

协作先读 [AGENTS.md](AGENTS.md)、[当前交接](HANDOFF.md) 和 [推进计划](roadmap.md)。使用入口见 [Skill](skills/qa-workflow/SKILL.md) 与 [0.2.1 图文指引说明](implementation-v0.2.1.md)；基础能力与走读见 [0.2.0 记录](implementation-v0.2.md)。迁移范围、来源和历史包见 [迁移记录](docs/migration/2026-11-02.md)。

第 3 步业务环节设计基线已齐备：需求分析、页面取证、UI 模块、用例编写与修订、测试执行、BUG 记录与提交、复验，以及 [3.8 最终知识沉淀](design/stages/knowledge-consolidation.md) 和 [3.9 收尾与复盘](design/stages/closeout-retrospective.md)。独立评审已并入编写与修订，下一步核对工具适配与实现范围。设计内容仍待实施及完整验证；正式上线后再沉淀知识的时机已在 0.2.1 修正，旧包保留历史内容。

UI 模块的当前依据为 [规范 v1](design/ui-modules.md)，覆盖最小内容、划分粒度、存放检索、形成验证、复用及更新。用户明确委托 Agent 决策定稿；[早期讨论](design/ui-modules-discussion.md) 保留为历史。设计定稿不表示已实现适配器或完成真实运行验证。

## 本地验证与打包

在仓库根目录使用 Python 3.11+：

```sh
python3 -m unittest discover -s tests -v
python3 skills/qa-workflow/scripts/qa.py --capabilities
python3 tools/package_skill.py --output dist/qa-workflow-0.2.1.zip
```

打包目标须不存在；运行器不依赖旧仓库或第三方 Python 包。这里的检查不操作业务系统。历史 0.1.0、0.2.0、0.2.1 ZIP 原样保存在 [历史包目录](releases/archives/)，新构建放入被忽略的 `dist/`。当前未执行全局安装或公司平台发布。

| 文档 | 内容 | 状态 |
| --- | --- | --- |
| [当前图文指引](implementation-v0.2.1.md) | 下载、MCP 信息获取、素材来源及展示测试安排 | 0.2.1 已打包，真实新会话渲染待验证 |
| [此前引导实现](implementation-v0.2.md) | 引导写入、暂停修正、验证方法及限制 | 保留 0.2.0 验证依据 |
| [基础版历史记录](implementation-v0.1.md) | 原基础实现及当时验证范围 | 保留 0.1.0 依据 |
| [推进计划](roadmap.md) | 八步路线、当前进度、产物与完成依据 | 当前执行规划；具体设计仍逐项讨论 |
| [整体设计](design/overview.md) | 标准格式、包与工作目录、工具依赖、多会话边界 | 已确认方向与具体提议分开记录 |
| [首次使用与接入项目](design/onboarding.md) | 首次进入、新旧项目接入、接续任务 | 已写入 0.2.0，验证边界见实现说明 |
| [Skill 说明与使用问答](design/help-and-capabilities.md) | 用途、当前能力、测试流程与常见问题 | 基础帮助已实现；新增按需取证说明设计已确认、待写入包 |
| [工作过程中的自然表达](design/progress-guidance.md) | 用户口语输入与 Agent 回应、推进、记录的关系 | 已写入 0.2.0 并作者走读 |
| [继续、切换与找回](design/continuation.md) | 接续任务、切换项目、会话接手和查阅历史资料 | 已写入 0.2.0 并验证相关本地操作 |
| [缺失、冲突与阻塞](design/blockers.md) | 缺口说明、受影响范围、回查及独立工作 | 2.5 已确认并写入 0.2.0 |
| [需求理解与澄清](design/stages/requirements-analysis.md) | 历史概念与关系、可控追问、用例反推和最终入库时机 | 3.1 完整设计已确认，待实施及行为验证 |
| [页面取证与操作依据](design/stages/page-discovery.md) | 各阶段按需取证、未部署页面、步骤校准与 UI 模块维护 | 3.2 调整方案已确认，待实施 |
| [UI 模块规范 v1](design/ui-modules.md) | 最小契约、操作边界、存储、验证、复用、回执与更新 | 六项按用户授权决策定稿，待实施及真实验证 |
| [用例编写与修订设计 v1](design/stages/test-case-authoring.md) | 业务场景、受控回归与完整主链路、操作步骤、评审反馈修订及完成依据 | 已定稿；评审不再单列必经环节，待实施及真实验证 |
| [测试执行设计 v1](design/stages/test-execution.md) | 准备与数据、分工并发、业务判定、证据同步、异常恢复和交付 | 已按用户委托决策定稿，待实现及真实验证 |
| [BUG 记录与提交设计 v1](design/stages/bug-management.md) | 本地预提交、简洁图文描述、差异分流、去重与授权、API 保存核验及 URL 复验衔接 | 用户已确认定稿，待实现与真实验证 |
| [BUG 复验设计 v1](design/stages/bug-retest.md) | URL 接入、原条件复验、必要回归、条件关闭、证据与用例状态接续 | 用户已确认定稿，待实现与真实验证 |
| [最终知识沉淀设计 v1](design/stages/knowledge-consolidation.md) | 稳定业务主题、上线后入库、差异核对、版本历史、后续变更和共享 | 已按用户同意方案记录，待实现与真实验证 |
| [收尾与复盘设计 v1](design/stages/closeout-retrospective.md) | 轻量交付、独立状态、遗留事项、恢复与交接、归档保全和有据改进 | 按用户同意的四项方向收口，待实现与真实验证 |
| [截图标注集成](design/integrations/screenshot-annotator.md) | 固定上游源包、原图与标注证据、内置方式及边界 | 0.1.0 来源基线已纳入 vendor，尚未接入发布包或重测 |
| [Chrome DevTools 接入与隐式调用](design/integrations/chrome-devtools-onboarding.md) | 强推荐、默认 headless、仅明确要求才显式、缺失时自动帮助安装 | 用户要求已记录；官方参数已核对，安装与适配待实施 |
| [Mind MCP 接入指引](design/integrations/asynctest-mind-onboarding.md) | 从 AsyncTest 首页进入 Mind、打开配置、复制连接信息 | 三张标注与模糊处理素材已备齐；未入发布包，连接未实测 |
| [asynctest-kb 接入引导](design/integrations/asynctest-kb-onboarding.md) | 从 AsyncTest 获取信息，由当前 Agent 适配客户端 | 已有截图与下载菜单依据，完整接入未实测 |
| [多项目隔离与任务状态](design/project-scope.md) | 多项目、状态归属和跨项目需求 | 原则已确认；基础归属已实现 |
| [共享内容与项目差异](design/shared-resources.md) | 复用、适用范围、版本与差异 | 固定引用与配置差异已实现 |
| [状态与恢复](design/state-contract.md) | 进度、结果、同步及恢复依据 | 本地状态与恢复已验证 |
| [多会话协作](design/collaboration.md) | 分工、资源、汇总和交接 | 本地合作式管理可用；宿主派发未接入 |
| [长期维护与信息保全](design/data-lifecycle.md) | 归档、检索、备份、升级和长期验证 | 本地基础已验证；异地策略与跨格式迁移待处理 |

## 已确认的方向

依据用户本会话的明确要求：

1. 按标准 Skill 形式产出，并核对公司 SkillHub 的上传兼容性。
2. 引导是核心能力：表达自然、容易理解，帮助用户逐步开展测试。
3. 兼容用户的多会话工作方式，交接不能只依赖聊天历史。
4. 同时设计 Skill 自身目录和它引导用户建立的测试工作目录。
5. 考虑共享函数、配套 Skill、MCP 及不同测试环节，再逐环节设计。
6. 将设计与后续实现集中在本目录，区分“已确认／提议／待讨论”。
7. 兼顾多被测项目隔离、共用内容复用和任务状态保存；整理全局路线后逐步推进。
8. 支持长期使用与信息保全；后续每阶段都考虑历史资料、恢复能力和规模增长，不能仅作为收尾事项。

用户已于 2026-10-31 同意实施基础方案，并要求完成 2.6 的写入与走读。版本能力和验证边界分别记录；这不自动授权真实业务测试、知识库写入或平台上传。

## 当前工作与下一步

已交付基础源码、测试、打包工具和本机验证摘要，第 3 步业务设计已齐备。下一步按推进计划核对工具来源、实际能力、适配缺口和首版支持范围；再进入实现与验证。当前可用能力仍以实现说明为准。

## 目录维护约定

- 当前只创建有实际内容的设计文件。`skills/`、`tests/`、`dist/` 等在需要时创建。
- 讨论结论更新设计文档；实际实现推进时再更新 `skills/qa-workflow/`。
- 新建议先标为提议，不将助手建议自动升级为用户确认。
- 每次集中推进计划中的一个子项；新增想法归入对应阶段，需要影响当前设计时再提前处理。
- 每次更新说明文件位置和变化；仅提交、推送本次核对过的内容。
- 不把现有业务材料、测试账号、截图、浏览器会话或平台身份信息复制进通用 Skill 包。
- 当前为独立仓库；许可证和正式发布策略尚未决定，不因迁移自行添加许可证或发布 GitHub Release。

开发约定以 [AGENTS.md](AGENTS.md) 为准。原业务工作台的流程与治理资料保留为 [迁移来源引用](docs/migration/2026-11-02.md)，不是运行本 Skill 的外部依赖。
