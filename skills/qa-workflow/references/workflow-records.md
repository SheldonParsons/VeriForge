# 工作流记录与旧资料升级

此处命令只维护本地记录；网络执行使用独立的 `http.execute` 或宿主工具。阶段概况继续使用 state.update；本版新增独立事实、交付物引用和遗留事项，避免“测试结束”覆盖未上线、未同步或待复验等情况。

## 格式与升级

新版读取格式 1、2、3。新工作空间使用格式 3 的根记录；旧空间只读 resume／record.read 不修改文件，原 review 和四种历史用例结果保留原义，不自动合并或升级。

旧空间使用新增上下文、凭据关联、动作或工作流维护前：

1. 读取 workspace.json 与 resume，核对旧执行已停止、活跃任务、在途写入和资源；需要保留恢复点时先 backup.create 并验证。
2. 使用 `workspace.upgrade`，传 actor、最新 expected_revision、source_execution_stopped:true 和 note。活跃任务、未知操作或占用会拒绝升级，不能靠口头“卡住”强行抢占。
3. 只升级根记录的格式标记，保留它的旧修订，原需求、用例结果和快照不重写。新增记录再按正常命令保存。

格式 3 根记录使旧运行器拒绝操作；不支持用旧运行器继续写升级后的空间。需要回到旧版本时，从升级前备份恢复到新目录，核对恢复边界，不能只把根记录改回旧格式 来隐藏新资料。新版可以恢复旧备份；旧程序不保证读取新备份。

升级是有版本保护的本地变更，不能代替全量资料备份或自动证明旧执行停止。升级中断后读取根记录及修订，不盲目重发或删除旧历史。

## 独立事实

`workflow.record`：project、requirement、actor、expected_revision、facts。首次 revision 为 0；facts 按传入键合并，未传键保留。`workflow.read` 默认返回同一记录的简洁摘要及当前修订，basis 最多 240 字并标明截断，只带证据数量；完整内容用 include_details:true 或 record.read。旧空间无此文件时返回 exists:false、revision:0，不创建文件。

每个事实包含 status、basis 和可选 evidence 快照 ID 列表。状态表：

| 事实 | 可用状态 |
| --- | --- |
| business | pending / ready / blocked |
| page_steps | pending / partial / verified / blocked / not_applicable |
| execution | pending / ready / blocked / not_applicable |
| review | not_requested / pending / completed / not_applicable |
| release | unknown / not_released / released / rolled_back |
| stability | unknown / confirmed / changing |
| knowledge | not_requested / draft / final_local / pending_confirmation / submitted_unverified / synced / cancelled |
| restoration | not_required / pending / completed / blocked |

ready、verified 及明确完成的关键事实需要已保存依据；具体由返回的 EVIDENCE_REQUIRED 指明。工具验证引用及摘要，业务真实性仍须实际核对。知识已记为最终或同步，但上线／稳定状态不满足时返回 KNOWLEDGE_BEFORE_STABILITY 警告，保留实际记录，提示核对事实与用户特定指令；不据此自动发起、撤销或重放知识写入。

```json
{"action":"workflow.record","project":"orders","requirement":"123","actor":"lead","expected_revision":0,"facts":{"release":{"status":"not_released","basis":"用户说明尚未上线"},"knowledge":{"status":"draft","basis":"候选文本已整理"}}}
```

这些事实不自动更新阶段概况、关闭任务或授权发布。证据快照可先用 artifact.import 导入已获授权文件。

## 交付物

`deliverable.set`：project、requirement、actor、deliverable（稳定 ID）、role、title、artifact（已登记快照 ID）、basis、expected_revision；status 可为 draft／ready／superseded，默认 draft；external_ref 为可选来源或远端引用，不构成远端验证。

role 为 requirement／case_set／page_evidence／bug／knowledge／run_evidence／handoff／user_requested。交付物引用固定快照及摘要，修订用新快照并保留历史；ready 表示作者登记的交付状态，不代表全部测试通过。

`deliverable.list` 按项目需求读取，支持 role、offset、limit（1—100），只列身份、版本与入口，不重复正文依据；record.read／record.history 可查看完整记录和历史版本。引用不能跨需求借用同名快照。

## 遗留事项

`followup.record`：project、requirement、actor、followup（稳定 ID）、title、status、basis、expected_revision；open／waiting 必填 next；done／cancelled 必须有 evidence 快照依据；owner_ref 可选，只记录已知责任引用，不自动通知或派发。

重新打开事项保留理由和旧修订。`followup.list` 默认列 open／waiting，支持 include_completed:true、offset、limit，并始终返回各状态数量；next 最多返回 240 字并标明截断，完整依据通过返回的 path 读取。归档后仍可读取，不能通过归档抹掉问题；改动前明确重开需求。

## 新用例结果、摘要和备份

旧 passed／failed／blocked／not_run 继续有效；新增 running／needs_verification／skipped／not_applicable 需要格式 2。跳过和不适用须保存范围依据，不能计为通过。run.summary 保留四种旧计数键，有扩展状态时追加对应键，总数不丢失。

每次更新结果会重新置 sync:pending，旧同步回执保留在历史修订。case.sync 仍只登记已回读的真实载体回执，不操作导图。

resume 返回 workflow、deliverables、followups；后两者有独立 next_offset，继续读取可用 deliverable_offset／followup_offset。摘要列出本页数量，不能将第一页当成全部。summary.write 仅更新自己生成的摘要，不覆盖人工 README。

本版备份包含新增事实、交付物和遗留记录及历史，快照覆盖仍以原备份约定为准。恢复副本仍需核对旧执行、未知动作和资源；记录恢复成功不是实际业务恢复验证。
