# Codex Co²

**共享同一条 Codex 会话，一起推进工作。** · [English](README.md)

作为分享者，你可以继续在 Codex Desktop 工作，协作者则通过浏览器加入同一条会话，一起讨论、补充上下文、跟进 Agent 的回复。

![Codex Co²：共享同一条 Codex 会话，一起推进工作](assets/promotional_image_cn.png)

https://github.com/user-attachments/assets/b1c2f544-3684-432e-9e03-f32ac15b9370

[下载宣传视频](assets/promotional_video_cn.mp4)

Codex Co² 全称是 **Codex Conversation Collaboration**。这是独立实验项目，并非 OpenAI 官方产品，也未获 OpenAI 背书。

## 体验预览版

分享者需要 Apple Silicon Mac 和已运行的官方 Codex Desktop。安装包最低要求 macOS **15.0**；原生检查仅记录于 macOS **26.4.1**、Desktop **26.1007.30912**，其他组合尚未验证。协作者使用支持 JavaScript 和 WebSocket 的浏览器；双方网络需能访问生成的公网地址。

### 新用户使用（Homebrew）

以下步骤供分享者使用。协作者只需在浏览器打开邀请，无需安装应用。

如果尚未安装，请先安装 [Homebrew](https://brew.sh/)，并保持官方 Codex Desktop 运行。随后通过[项目 Tap](https://github.com/SpaceCoder-Kafka/homebrew-tap) 安装：

```sh
brew tap SpaceCoder-Kafka/tap
brew install --cask SpaceCoder-Kafka/tap/codex-co2 && open "$(brew --repository SpaceCoder-Kafka/tap)/guides/homebrew.html"
```

如果你的 Homebrew 版本提示需要显式信任 Cask，先检查定义，再执行 `brew trust --cask SpaceCoder-Kafka/tap/codex-co2`，随后重试安装。

安装成功后，上述命令会在默认浏览器打开本地首次使用引导，页面顶部提供 **中文 / English** 切换按钮。Homebrew 已将应用放入 Applications，无需再次拖拽。如果已经安装，只需执行 `brew update`，再单独执行上面的 `open` 命令，无需重新安装。

### 通过 DMG 安装

也可以从 [Releases](https://github.com/SpaceCoder-Kafka/codex-co2/releases/tag/v0.3.3-preview.11) 下载 DMG 和对应 `.sha256` 文件，下载后执行：

```sh
shasum -a 256 -c Codex-Co2-0.3.3-build11-arm64-preview.dmg.sha256
```

预览包采用临时签名，**未经 Apple 公证**，首次打开可能受系统拦截。先尝试从 Applications 打开 Co²，再到「系统设置 → 隐私与安全性 → 仍要打开」确认。Homebrew 会直接安装应用，不会展示 DMG 的安装引导窗口。请参考 [Apple 指引](https://support.apple.com/zh-cn/102445)。

### 分享者操作

1. 通过 Homebrew 安装，或将 DMG 中的 Codex Co² 拖入 Applications。升级前先停止共享，并从菜单栏退出旧版 Co²。
2. 保持官方 Desktop 运行，从 Applications 启动 Co²。
3. 在设置中检查显示名称和消息审批选项。
4. 选择已有消息的会话，生成邀请。需要加载目标会话时，Codex 可能会跳转到前台，可无视，切回 Co² 即可。
5. 私下发送邀请，确认协作者身份后批准加入。

### 协作者操作

1. 用浏览器打开邀请，填写名称并申请加入。
2. 获准后阅读共享会话，向同一个 Agent 发送消息。
3. 默认直接接收新消息；分享者开启消息审批时，需等待逐条确认。
4. 批准加入后，网页会在尚未授权时自动尝试申请通知权限；浏览器拦截自动申请时，点击页内「开启通知」即可，也可在「协作详情 → 使用帮助」中开启。重连不重复申请，主动关闭后不自动申请。可点击「发送测试通知」验证显示与点击。更换邀请的网站地址后需重新允许通知；若测试提示已交给浏览器但没有弹窗，请检查系统中的 Chrome 通知设置和专注模式。需保留页面并保持连接；支持的浏览器可在页面处于后台时发送系统通知，点击回到原页面查看结果。运行结束不一定表示执行成功。

分享者可移除协作者、停止单条或全部共享。关闭窗口后应用继续驻留菜单栏，退出应用才结束共享。结束共享不会取消已经派发给 Agent 的工作。

## 共享前需要知道

- 分享包括所选会话投影出的历史与后续消息，不只限于生成邀请之后。长历史可能截断；受支持的用户图片、MP4 和文本附件也可查看。回复中的 Markdown 图片可在原位置显示并点击放大：绝对路径的本地 PNG、JPEG、WebP 图片（每张不超过 8 MiB）通过已准入的房间连接传输；HTTP(S) 图片由访客浏览器直接加载，不发送来源页面地址。不能完整展示所有 Desktop 内容。
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
