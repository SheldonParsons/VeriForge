# NexoFolio：接口知识、Fetcher 与 MCP

NexoFolio 为 Agent 提供可追溯的接口目录、请求和响应字段、样本及来源。它补充“系统怎样交互”；asynctest-kb 补充“业务规则为什么这样”。两者不能互相替代，也不等于真实业务执行结果。

- [公网平台](https://nexofolio.net/)
- [使用文档](https://nexofolio.net/docs)
- [Fetcher 安装与采集](https://nexofolio.net/docs/fetcher)
- [MCP 说明](https://nexofolio.net/docs/mcp)

私有部署使用用户提供的实际服务地址和文档，不在 Skill 中写死某个组织的地址。以下截图为导航参考，当前版本及按钮以实际页面为准。

## 阅读现有接口资料

登录自己的实例 → 选择项目 → 核对环境 → 进入接口文档。先看相关目录或搜索业务关键词，再展开接口、字段与来源。区分正式内容、候选整理、样本观察和已废弃资料；读到旧响应样本不能推导当前业务已经成功。

## 需要采集时安装 Fetcher

只读取已有接口知识无需安装 Fetcher。用户要采集页面请求时：

1. 在文档顶部 **Fetcher** 下载适用渠道的扩展 ZIP，并解压到固定目录。
2. 根据当前文档进入浏览器扩展管理页，加载包含 `manifest.json` 的解压目录，打开扩展侧栏。
3. 配置 NexoFolio **服务地址**并登录；这不是被测业务站点地址。
4. 切换到被测站点，授权适当的站点范围，绑定正确的项目、环境。
5. 在授权测试范围内操作页面，核对请求记录的上传状态，再到同一项目、环境确认记录。采集器启用前的旧请求不假定已经被采集。

![加载 Fetcher](../../assets/guides/nexofolio/02-fetcher-install.annotated.png)
![连接服务](../../assets/guides/nexofolio/03-fetcher-connect.annotated.png)
![绑定项目和环境](../../assets/guides/nexofolio/04-fetcher-binding.annotated.png)
![核对采集记录](../../assets/guides/nexofolio/05-fetcher-capture.annotated.png)

Fetcher 涉及采集并上传请求资料，接入前明确数据范围。不得为了补资料擅自进行业务写操作。默认 headless 测试浏览器与扩展运行方式能否结合，要按实际浏览器和版本验证，不承诺安装后自动覆盖所有测试请求。

## 让 Agent 连接 MCP

1. 登录后打开顶部 **接口文档 → MCP 凭证**。
2. 复制页面展示的服务地址，为当前 Agent 创建专用凭证。
3. 在接入说明中复制客户端模板。使用自己的完整 Token，通过宿主安全配置机制填写；不把密码或 Token 写进工作空间的 JSON、源码、截图或 Git。
4. Agent 核对当前可用工具，再读取有权限的项目、环境和一条相关接口详情，确认字段和来源可用。

![MCP 菜单入口](../../assets/guides/nexofolio/08-mcp-menu.guide.png)
![MCP 凭证页面](../../assets/guides/nexofolio/09-mcp-settings.guide.png)
![创建专用凭证](../../assets/guides/nexofolio/06-mcp-credential.annotated.png)
![连接配置示意](../../assets/guides/nexofolio/07-mcp-config.annotated.png)

模板里的 `YOUR_MCP_TOKEN` 是占位符。MCP 凭证、网页登录凭据与被测接口认证是不同用途，不能混用。配置写完不等于当前会话已经加载工具；必要时按宿主要求重连后再检查。

## 查询时机

新成员接入先补项目和环境范围；需求分析和用例编写按相关字段、状态和上下游关系展开；失败调查、复验再查受影响接口。先看 [历史知识与项目补全](../context-bootstrap.md)。不批量读取无关项目，不触发后台整理或业务请求来代替知识检索。
