# 执行落盘与交付核对

这是实际执行、续测和收尾前必读的操作约定。用户只需说“测一下”“接着做”“整理结果”，以下登记由 Agent 完成，不要求用户理解内部 ID 或填写 JSON。

## 先固定身份，再执行

1. 读取当前 case_set、来源说明和稳定编号映射。**表格行号、展示顺序与稳定场景 ID 是不同信息。** 插入、排序或改名不能重新分配旧 ID；用户说“前 3 条”时，按当前展示顺序选择，再转换成原稳定 ID。
2. 保存一份规范化身份清单并用 `artifact.import` 登记。已有编号从原映射沿用；没有编号时只分配一次，再持久化。不要把编号加到用户的场景标题里。
3. `task.create` 绑定本轮 run、稳定 cases、用例与映射快照、环境、版本和角色。先核对原执行者已停止；不是用手写“已开始”代替任务登记。
4. 页面步骤逐项映射真实入口、字段、按钮、身份切换和同一数据。只把“内容”替换成“申请说明”不等于完成 1:1 步骤核对。未核对部分继续标记待验证。

身份清单例子：

```json
{
  "source_artifact": "cases-v2",
  "identity_artifact": "cases-v2-identities",
  "cases": [
    {"id": "first-submit", "title": "首次提交后显示当前版本"},
    {"id": "rejected-edit", "title": "驳回修改后保留旧内容"}
  ]
}
```

`source_artifact` 指向展示用例的快照；`identity_artifact` 指向原始身份依据。四列表格 JSON 可配 `{"case_ids_in_display_order":["first-submit","rejected-edit"]}`；其他载体先经其原生工具取得规范化的 `{"cases":[{"id":"...","title":"..."}]}` 身份依据。关键是保留原载体的版本与真实映射，不能凭本次展示顺序生成一份自证清单。

## 每条结果的最短闭环

- `artifact.import` 登记必要执行记录、截图、标注清单和工具回执。工作目录中的普通文件不会自动进入受管备份。
- `case.record` 保存结果，提供稳定 `case`、与来源一致的 `case_title`、依据、证据和关联 BUG；首次修订为 0。未核实的断言不能算通过。
- 需要更新 Mind 时使用已核对的节点映射。保存并读回后登记回执，再 `case.sync`；写图成功与磁盘保存是两步，不以本地记录冒充远端同步。
- 有 BUG 时读取并使用默认模板，或用户明确指定的格式。通过 `bug.draft` 生成，或修订已有唯一稿件后登记快照及 bug 交付物。截图和标注凭证也分别登记。

```json
{
  "action":"case.record","project":"example","requirement":"change-1",
  "actor":"tester","task":"ui-batch","run":"run-1",
  "case":"first-submit","case_title":"首次提交后显示当前版本",
  "status":"passed","basis":"按该场景全部预期核对，同一申请在两角色下结果一致",
  "evidence":["first-submit-observation"],"bugs":[],"expected_revision":0
}
```

原始日志可以追加，**当前摘要必须反映最新状态**。不能在正文开头仍写“全部未执行”，只在文件末尾追加通过/失败。旧结论保留在历史段落或历史修订中。

## 暂停、交接或最终回复前

1. `run.summary` 回读本轮真实记录；核对授权范围、未执行、失败、阻塞和待同步数量。
2. 刷新阶段状态、独立事实、当前产物引用、遗留项和交接摘要。当前入口应指向已保存的结果版本，旧用例稿可留档。
3. 运行只读 `delivery.audit`，输入原始身份清单、本次明确选定的 runs、场景范围和 BUG 稿映射。`ready:false` 时补登记或如实报告缺口，不能只交一份手写成功日志。
4. 用 `resume` 再读一次，确认下一会话能找到当前范围、结果、未知操作及遗留项。协作暂停不表示其他进程已被强制停止。

```json
{
  "action":"delivery.audit","project":"example","requirement":"change-1",
  "case_map_artifact":"case-map-v2","runs":["run-1"],
  "case_ids":["first-submit","rejected-edit"],"require_sync":true,
  "bugs":[{"id":"bug-001","artifact":"bug-001-draft",
    "path":"projects/example/requirements/change-1/bugs/bug-001.md","kind":"ui"}]
}
```

核对器检查原始编号/标题映射、正式结果、证据完整性、同步登记和 BUG 稿格式。`ready:true` 只代表这些本地交付关系成立；失败和阻塞也可以被完整交付，**不代表业务全通过、截图内容已人工验证或远端图片对他人可见**。远端图像和用户自定义 BUG 格式会给出需另外复核的提示。

## 遇到旧记录不完整

先保留现场，比较原用例、旧日志、真实截图/回执、导图和已登记结果。依据不足的保留待核实，不重新跑已授权范围之外的业务操作来“补证据”。

有充分证据时可以补登记历史结果，但明确这是记录修复，不是再次执行。保留原记录、原失败和新复验，标明归并关系；不要把多个 run 的相同场景简单累加。稳定 ID 冲突按原始身份依据修正，不能把已错置的编号继续当作事实。
