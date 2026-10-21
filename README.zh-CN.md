# Codex Co²

**共享一条 Codex 会话，一起推进工作。** · [English](README.md)

你继续在官方 Codex Desktop 工作，协作者通过浏览器加入同一条会话，一起讨论、补充上下文、跟进 Agent 的回复。协作者无需 SSH、主机权限或本地 Codex 安装。

[![Codex Co²：共享一条 Codex 会话，协作者一起推进工作](assets/promotional_image_cn.png)](assets/promotional_video_cn.mp4)

▶ [观看宣传视频](assets/promotional_video_cn.mp4)

Codex Co² 全称 **Codex Conversation Collaboration**。这是独立实验项目，并非 OpenAI 官方产品，也未获 OpenAI 背书。

## 体验预览版

分享者需要 Apple Silicon Mac 和已运行的官方 Codex Desktop。安装包最低要求 macOS **15.0**；原生检查仅记录于 macOS **26.4.1**、Desktop **26.1007.30912**，其他组合尚未验证。协作者使用支持 JavaScript 和 WebSocket 的浏览器；手机真机验收仍待完成。双方网络需能访问生成的公网地址。

发布后，DMG 和对应 `.sha256` 文件会放在本仓库 **Releases**。当前尚未配置公开下载地址。下载后可执行：

```sh
shasum -a 256 -c Codex-Co2-0.3.3-build10-arm64-preview.dmg.sha256
```

预览包采用临时签名，**未经 Apple 公证**，首次打开可能受系统拦截。请阅读 DMG 中的安装说明及 [Apple 指引](https://support.apple.com/zh-cn/102445)，只为确认来源可信的应用放行。摘要能检查下载是否变化，不能证明发布者身份。

### 分享者操作

1. 将 DMG 中的 Codex Co² 拖入 Applications。升级前先停止共享并退出旧版 Co²。
2. 保持官方 Desktop 运行，从 Applications 启动 Co²。
3. 在设置中检查显示名称和消息审批选项。
4. 选择已有消息的会话，生成邀请。需要加载目标会话时，Codex 可能出现在前台。
5. 私下发送邀请，确认协作者身份后批准加入。

### 协作者操作

1. 用浏览器打开邀请，填写名称并申请加入。
2. 获准后阅读共享会话，向同一个 Agent 发送消息。
3. 默认直接接收新消息；分享者开启消息审批时，需等待逐条确认。

分享者可移除协作者、停止单条或全部共享。关闭窗口后应用继续驻留菜单栏，退出应用才结束共享。结束共享不会取消已经派发给 Agent 的工作。

## 共享前需要知道

- 分享包括所选会话投影出的历史与后续消息，不只限于生成邀请之后。长历史可能截断；受支持的用户图片、MP4 和文本附件也可查看，不能完整展示所有 Desktop 内容。
- 协作者消息进入现有 Agent，沿用会话的工具、沙箱、权限及计费或额度。**共享不会新建执行沙箱**，请只邀请可信任的人。
- 只有本机分享者能改变消息策略；只影响新消息，已有待审批消息仍需决定。原生工具审批继续在官方 Desktop 处理，消息审批不能替代工具审批。
- 本机管理页只查询会话 ID、标题、更新时间和项目路径，目录不发给中继或协作者；所选正文经 Desktop IPC 读取，不复制默认认证或会话文件。
- 公网使用普通 TLS，信任中继和隧道基础设施，**不提供端到端加密**。主机离线暂停协作，部分故障需新邀请。临时地址可能变化，不保证可用性；[Quick Tunnels 定位为测试开发用途](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)。
- 邀请和访客恢复文件属于敏感凭据，浏览器可能保存访客身份。撤权停止后续传输，无法收回对方已复制或保存的内容。

分享前请检查历史与附件，避免泄露秘密或无权披露的材料。协作者无需单独登录 Codex，使用分享者当前运行会话及其额度。

## 常见问题

**无法连接？** 确认官方 Desktop 正在运行、至少有一条非空会话且接口兼容。接口不可用时停止接入，不重启 Desktop、不替换 profile，也不创建备用后端。Desktop 更新可能影响兼容性。

**邀请失效或连接中断？** 分享会过期，断线与撤权可能要求重新准入或新邀请。回到 Co² 明确重新分享。发送结果不确定时，先在 Desktop 核对，避免重复发送。

**验证到哪一步？** 合成测试覆盖准入、消息策略、会话传输和撤权；此前人工验证过部分本机与公网协作。当前候选仍需完成最终安装包的官方 Desktop、原生工具审批及干净 Mac 下载与安装验收。RPC 测试不能证明原生窗口行为。

## 从源码运行与构建

使用 Node.js **22.23.3**、npm、兼容且已运行的官方 Desktop；公网另需 `cloudflared` **2026.10.1**。在克隆的仓库执行：

```sh
npm ci --ignore-scripts
npm run host -- --attach --public --open
```

打开命令输出的本地管理页。不加 `--public` 仅本地访问。日常接入无需另装 Codex CLI。

构建另需 Apple Silicon macOS、Xcode 命令行工具、Python 3.9+ 和网络：

```sh
npm run build:macos
npm run check:macos
```

产物位于忽略提交的 `dist/`。构建使用锁文件安装干净依赖，包含第三方声明并运行本地回归。开发测试见 [CONTRIBUTING](CONTRIBUTING.md)。

## 反馈与许可

普通问题通过 Issues 反馈，附应用构建号与 Desktop 版本，删除私密正文、个人路径、邀请和恢复凭据。安全问题按 [SECURITY](SECURITY.md) 私下报告。

项目代码使用 [MIT](LICENSE)，第三方组件保留[各自许可](THIRD_PARTY_NOTICES.md)。图标及示意图来源见[素材声明](ASSET_PROVENANCE.md)。
