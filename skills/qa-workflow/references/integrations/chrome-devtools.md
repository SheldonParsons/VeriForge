# Chrome DevTools 与无界面执行

强烈推荐 Chrome DevTools MCP，任何相关操作默认专用 headless Chrome，保留截图、快照和证据；只有用户明确要求时才显式。登录、验证码或上传困难不自动授权切到可见模式，不接管日常浏览器。

需要此能力且已获相应接入／执行授权时，由 Agent 检查宿主、实际工具与配置、Node／npm／Chrome 依赖；缺失则帮助按可信官方来源安装和配置，已有连接直接复用。不能把全局开关或服务名含 headless 当运行模式证明。

官方入口：[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)、[配置](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md)。安装时核对当前要求和真实参数，记录实际版本；批次固定版本，更新后重新检查适用性。

显式启用 headless，使用本任务专用临时或持久目录，保留已有配置。临时目录关闭后的登录态不保证恢复；已有可见实例不会因传入 headless 自动转换。模式不明先停止对应页面动作，继续独立工作。

资源占用时核对归属，不删除他人锁或结束不明进程。新隔离目录不会自动登录；SSO 登录本身是测点时执行真实认证和回跳，不能用登录态注入替代。

配置就绪后先做实际模式及最小只读检查，再进入用户授权的业务范围。文件上传路径需对浏览器所在机器可见，下载需核对实际文件；tool 返回已选文件或点击完成不等于业务成功。

优先宿主原生 MCP，保留工具权限和停止机制。当前 CLI 不会自动配置浏览器或转发 MCP；可用工具和用户范围明确后由 Agent 执行，不以文档中的方案冒充内置适配器。
