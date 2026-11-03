---
name: qa-workflow
description: 使用 VeriForge 协助 Web 测试：澄清需求、主动查询历史业务和接口知识、取证页面、编写可执行用例、按授权执行、记录和提交 BUG、复验及上线后知识沉淀。适用于测试任务、新项目接入、续接会话、跨项目协作和交接；保存阶段、证据、产物、私密凭据引用与未完成事项。
compatibility: 本地工具需要 Node.js 20.19+ 与 npm；实际浏览器、Mind 和知识库操作需要宿主可用的 MCP。支持标准 Agent Skills 目录，宿主安装位置由当前 Agent 核对。
metadata:
  version: "0.4.0-rc.1"
---

# VeriForge

让用户用日常语言表达目标。Agent 负责整理范围、寻找依据、提出关键问题、执行获授权的工作并留下可恢复记录。不要让用户先填内部状态字段或背熟流程名称。

## 先判断当前需要什么

1. 问“这是什么、能做什么”时读 [使用帮助](references/help.md)，无需初始化或读全库。
2. 要开展工作时读当前项目入口及指定资料，定位工作空间、被测项目、系统、需求、当前阶段。已有记录先 `list` / `resume`；历史资料无标准记录也不能擅自重建或迁移。
3. 先读已有配置与结论，只问会改变下一步的信息。有同号需求或项目重名时核对身份；凭据按 [私密存储](references/privacy.md) 使用。
4. **主动补历史背景**：首次接入、需求分析、用例编写和失败调查，按 [项目理解](references/context-bootstrap.md) 查询相关 asynctest-kb；接口问题按需查 NexoFolio。先摘要后正文，保留来源和冲突。不是等用户点名才查，也不是加载全库。
5. 用户仅讨论时保持讨论。已授权工作连续推进；插问先答再继续，明确暂停时保存断点和在途动作。只读 `resume` 不等于恢复执行 `task.resume`。
6. 只在用户授权时创建会话或委派。多个会话共用持久化记录：范围和所有权明确、同一页面或导图协调占用、交接核对旧执行已停止；不声称后台持续监听。

自然回应示例：

> 我先看一下已有资料和上次停的位置。旧规则里已经解释过的部分我会自己补齐，只把影响这次测试的问题拿出来和你确认。

## 当前版本与运行方式

先在 Skill 目录执行 `npm ci --omit=dev`。本地统一入口：

```sh
node scripts/qa.mjs --capabilities
node scripts/qa.mjs --workspace <工作空间绝对路径> --request <请求JSON路径>
```

也可从标准输入传入一个 JSON 请求。返回结构化简洁回执；修改使用刚读取的 `expected_revision`，不猜版本或循环重试。实际范围见 [能力清单](assets/capabilities.json)、[CLI](references/cli.md)、[动作衔接](references/actions.md)。

本地工具提供状态、加密凭据、历史查询计划、UI 模块契约、宿主动作日志、HTTP 请求与回读、截图标注、BUG 草稿、备份恢复。浏览器、Mind、知识库仍由 **宿主原生 MCP** 实际调用；动作准备或派发记录不意味着已经调用。禅道协议按实例核对，上传、建单、补齐和关闭分别记录及回读。

## 按需读取

| 任务 | 说明 |
| --- | --- |
| 用途、能力、自然交流 | [帮助](references/help.md)、[引导](references/interaction.md) |
| 项目接入、隔离与共享 | [工作空间](references/workspaces.md)、[历史补全](references/context-bootstrap.md) |
| 账号、密码、Token | [私密存储](references/privacy.md) |
| 恢复、暂停、协作、未知动作 | [协作](references/operations.md)、[动作衔接](references/actions.md) |
| 历史、升级、备份和遗留事项 | [保全](references/preservation.md)、[记录](references/workflow-records.md) |
| 需求和验收条件 | [需求分析](references/stages/analysis.md) |
| 真实页面、未部署功能、步骤变化 | [页面取证](references/stages/page-evidence.md)、[UI 模块](references/ui-modules.md) |
| 写用例、补场景、评审反馈 | [用例编写](references/stages/test-cases.md) |
| 执行与结果 | [执行](references/stages/execution.md) |
| 问题记录、提交、复验和关闭 | [BUG](references/stages/defects.md)、[复验](references/stages/retest.md) |
| 上线后入库、阶段收尾和交接 | [知识沉淀](references/stages/knowledge.md)、[收尾](references/stages/closeout.md) |
| 工具接入 | [AsyncTest KB](references/asynctest-setup.md)、[Mind](references/integrations/asynctest-mind.md)、[Chrome](references/integrations/chrome-devtools.md)、[NexoFolio](references/integrations/nexofolio.md)、[禅道](references/integrations/zentao.md) |

## 关键行为

- 需求理解最重要，但澄清以足够支撑可判定场景为边界。区分原文、历史规则、用户结论、页面事实、接口样本和推断；缺口只阻塞相关场景。
- 强烈推荐 Mind，但尊重用户已有格式。每个独立场景包含准备、从 1 开始的操作步骤、对应预期。同场景跨角色才连续编号。保留少量贯穿完整业务链路的受控回归。
- 取证可在任何阶段进行。未部署时组合已有页面与需求原文形成待核实步骤，环境可用后更新；不能为了迁就异常页面改写业务预期。
- 默认专用 headless Chrome DevTools。未安装时协助接入当前宿主；用户明确要求才显式操作。模块复用核对项目、环境、系统、角色和当前页面，关键边界回读；不以业务写接口替代被测 UI。
- 执行、业务结果、Mind 同步、BUG 状态及数据恢复分别保存。HTTP 200、成功提示、工具连通和文件存在都不自动证明业务通过。
- 写操作先记录意图与派发，再调用工具并回读。未知结果保留待核实，不盲重试。知识库交互确认沿用同一个 pending 标识和原稿版本。
- BUG 先保存本地，简洁可复现，UI 问题至少一张经过标注的真实截图，放在结果中；默认严重程度和优先级为 3。提交、补字段、关闭均在具体授权范围内，回读正文、字段与图片归属。
- 凭据不写进状态、Git 或知识库。本机引用和宿主安全配置各自负责范围；加密库不随普通工作空间备份。
- 本期完成、正式上线且用户确认短期稳定后，强烈建议将最终规则沉淀到 asynctest-kb，让下一位用户和下一次需求少重复解释。过程仍持续本地保存，收尾不抹掉待上线、待修复和待同步事项。

交付说明完成了什么、依据在哪、哪些未验证和下一步。模拟验证、真实工具调用和业务验收分开报告；候选版本不宣称已兼容所有宿主。
