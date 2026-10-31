# 调用约定

Python 3.11+ 标准库；`<skill>` 是包目录，`<workspace>` 是用户明确的工作目录。

```sh
python3 <skill>/scripts/qa.py --workspace <workspace> --request /path/to/request.json
```

也可从标准输入传入一个 JSON 对象。成功返回 ok:true；校验错误 ok:false、退出码 2；IO 错误退出码 3，先回读确认是否部分保存。请求不含口令、Cookie 或授权头。

## 通用字段

- action 为下表名称；项目级请求有 project；需求级请求同时有 project、requirement。
- 任务级写入有 task、actor。actor 是协作标签，不是宿主认证。
- 更新有最新读取的 expected_revision。创建固定对象使用修订 0，重复创建不会产生另一个同号对象。
- 标识为 1—64 位小写字母、数字、下划线或连字符；名称可中文。
- 回执时间为 UTC，展示给用户时按其时区转换。

## 接入、读取与状态

| action | 参数（? 表示可选） | 说明 |
| --- | --- | --- |
| workspace.init | title, actor | 创建空间与维护者，已有空间不覆盖 |
| project.create | project, title, actor, systems?, coordinator? | systems 如 `{"client":"客户端"}` |
| requirement.create | project, requirement, title, actor, systems?, coordinator?, next? | 系统引用如 `[{"project":"orders","system":"client"}]` |
| list | project?, requirement?, query?, include_archived?, offset?, limit? | 元数据分页 |
| record.read | path, revision? | 读取回执中的相对路径或历史版本 |
| record.history | path, limit? | 查看可达历史 |
| resume | project, requirement, task?, offset?, limit? | 恢复摘要，检查分页和警告总数 |
| index.rebuild | 无 | 重建派生索引 |
| lock.inspect | 无 | 查看锁，不清除 |
| state.update | actor, project, requirement, expected_revision, stages?, next?, systems? | 协调者维护阶段 |
| requirement.archive | actor, project, requirement, archived, reason, expected_revision | 标记归档或重新开启 |
| summary.write | actor, project, requirement | 协调者生成摘要，不覆盖人工 README |

阶段：analysis/page_evidence/cases/review/execution/defects/retest/knowledge/closeout。状态：not_started/in_progress/ready_for_review/completed/blocked/skipped。completed、blocked、skipped 须说明 basis。

```json
{"action":"state.update","project":"orders","requirement":"12345","actor":"lead","expected_revision":1,"stages":{"analysis":{"status":"completed","basis":"已取得用户确认，依据见已保存结论"},"cases":{"status":"in_progress"}},"next":"补齐审批场景"}
```

仅在真实依据满足时使用，不能把示例文字当成业务确认。

## 共享

| action | 参数 | 说明 |
| --- | --- | --- |
| shared.publish | actor, shared, kind, title, projects, source, content, overridable_keys?, expected_revision? | kind 为 guidance/template/rule/capability/config；仅 config 允许覆盖字段 |
| shared.attach | actor, project, shared, revision, expected_revision, overrides? | expected_revision 对应项目记录；固定共享版本 |
| shared.resolve | project, shared?, include_content? | 展开正文须指定单个 shared，默认摘要 |

## 任务、资源与操作

以下操作均包含 project、requirement：

| action | 其他参数 | 说明 |
| --- | --- | --- |
| task.create | actor, task, owner, scope, run?, cases?, inputs?, context?, session_ref? | inputs 为来源快照标识列表；context 可保存 environment/build/roles/data_refs/systems；不创建真实会话 |
| task.finish | actor, task, status, note, expected_revision | closed/paused/blocked，不表示全通过 |
| task.transfer | actor, task, new_owner, previous_owner_stopped:true, note, expected_revision, session_ref? | 核实停止后记录交接 |
| resource.acquire | actor, task, resource | 返回资源修订，相同真实资源一致命名 |
| resource.release | actor, task, resource, expected_revision | 先处理未知操作 |
| operation.prepare | actor, task, operation, resource, resource_revision, intent, correlation, target | 保存意图及回查线索，不保存请求秘密 |
| operation.dispatch | actor, task, operation, expected_revision | 只记录派发状态，没有发业务请求 |
| operation.resolve | actor, task, operation, result, evidence, note, expected_revision | result 为 confirmed/not_applied，evidence 为快照标识列表 |

## 产物、结果和备份

| action | 参数 | 说明 |
| --- | --- | --- |
| artifact.import | actor, project, requirement, artifact, source_path, purpose, sensitive?, task? | 保存授权文件快照；已有标识不覆盖 |
| case.record | actor, project, requirement, task, case, status, basis, evidence?, bugs?, expected_revision | passed/failed/blocked/not_run；通过、失败须证据；首次 expected_revision=0 |
| case.sync | actor, project, requirement, task, case, receipt, expected_revision | 任务负责人或协调者登记实际回执，receipt 是快照标识 |
| run.summary | project, requirement, run | 用例与去重 BUG 分开统计 |
| backup.create | actor, destination, include_sensitive?, allow_partial? | 本地 ZIP，目标父目录存在且文件不存在，位于工作空间外 |
| backup.verify | archive | 校验清单、格式、摘要和快照关系 |
| backup.restore | archive, destination | 只恢复到新目录 |
| restore.activate | actor, source_execution_stopped:true, note, expected_revision | 在恢复目录调用，修订对应 `.qa/recovery.json` |

case.record 首次为 sync:pending。实际写回并回读 Mind 后保存回执，再 case.sync；不能以本地标记代替远端写入。

## 错误和边界

REVISION_CONFLICT 先比较新旧记录；RESOURCE_BUSY 继续独立工作；PENDING_WORK 回查原操作；EVIDENCE_REQUIRED 补实际证据；BACKUP_INCOMPLETE 核对缺口；RECOVERY_REVIEW 先核对恢复。细节见 [信息保全](preservation.md)。

同一空间的写入短时串行，读取可并行。本版没有业务网络调用、加密备份、定时执行、进程停止或跨格式迁移。记录成功与实际业务成功分别判断。
