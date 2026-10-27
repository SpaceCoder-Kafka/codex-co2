# Changelog / 更新日志

Product versions describe releases; internal build numbers increase across all versions and channels. Bug fixes use patch versions (0.1.1); feature releases use minor versions (0.2.0).

产品版本按发布内容递增：修复使用补丁版本（0.1.1），功能更新使用次版本（0.2.0）。内部 Build 在所有版本和渠道之间持续递增。

统计以两个仓库已提交到远端 `main` 的代码、配置、测试和使用文档为依据；具体日期与提交边界见各版本说明。合并提交、验收记录、文案调整和中间试错不单列。

## 0.2.0

**跨平台协作、邀请恢复与后台共享**

内容范围：2026-10-23—2026-10-27（Asia/Shanghai），不含 0.1.0 的原 Build 17 功能基线。核对 `SpaceCoder-Kafka/codex-co2` 的远端 `main`（`ce3b15a` 之后至 `d4e2fda`）与 `SpaceCoder-Kafka/homebrew-tap` 的远端 `main`（`5384bc5` 之后至 `024fbc9`）；不纳入未提交工作区改动或非 `main` 分支独有内容。

**New Features:**

1. **为更多电脑提供安装包**：新增目标为 macOS 14+ 的 Universal 包（Apple Silicon／Intel），以及 Windows 10 1809+／Windows 11 x64 安装包和便携包，方便团队选择适合各自电脑的版本；Windows 需 WebView2 并手动更新，目标平台原生验收仍有缺口。
2. **从失效邀请申请恢复协作**：原入口仍可访问时，协作者可对到期或意外中断的共享提交恢复申请，并在同一浏览器查看结果，减少反复索取新链接和追问处理进度；分享者批准后只允许本次申请者加入，失败需明确重试，已拒绝或撤销的访问不会自动恢复。
3. **退出管理界面后继续共享**：macOS 启用后台运行并获系统允许后，退出管理界面仍可继续共享，重开时复用现有服务；内网服务重启后可在原地址、端口可用时保留恢复入口和待处理申请，进入会话仍需批准。关闭后台运行会清除持久恢复资格，公网临时地址不保证跨重启保留。

**Bug Fixes:**

无独立条目；兼容性与恢复体验改进已合并到对应功能项。

**Chore：**

1. **保护本机控制入口与私有文件**：为 Windows 接入和 macOS 后台服务补齐同用户身份、文件权限及异常路径检查，拒绝不符合要求的控制连接和附件读取，降低其他本机用户或异常路径绕过共享范围的风险。

### Upgrade / 升级方法

- macOS 0.1.0 and historical Build 17 or later: use About → Check for updates. Windows updates are manual downloads from this Release.
- Historical 0.3.3 Homebrew users migrating manually should stop sharing, disable background running if enabled, then quit Co². Keep official Codex Desktop running and run:

```sh
brew update
brew reinstall --cask SpaceCoder-Kafka/tap/codex-co2
```

- 从 0.1.0 或原 Build 17 升级，macOS 可使用「关于 → 检查更新」。旧 0.3.3 Homebrew 用户手动迁移时，本次使用上述重新安装命令；后续恢复普通升级。Windows 用户退出旧版后安装新版。

### Known limitations / 已知限制

- Experimental project. macOS is ad-hoc signed and not Apple-notarized; Windows is unsigned. Requires an already running compatible official Codex Desktop. Public TLS has no E2EE; intranet HTTP is unencrypted. Native tool approvals remain in Desktop.
- macOS 14, Intel, native Windows Desktop, native approvals, clean-machine installation, mobile devices, physical sleep/reboot/login recovery and cross-device long-running sharing remain unverified. Bundle and synthetic checks do not establish native acceptance.
- 项目仍处于实验阶段。macOS 采用临时签名、未经 Apple 公证，Windows 暂未签名。目标平台、原生工具审批、干净系统安装、真实移动设备与睡眠／重启／登录恢复等验收仍有缺口；常规发布不代表这些场景已经通过。

## 0.1.0

**浏览器协作、共享管理与应用更新**

内容范围：2026-10-21—2026-10-23（Asia/Shanghai），按首个公开版本至原 Build 17 归纳首版能力。核对 `SpaceCoder-Kafka/codex-co2` 的远端 `main`（`2ab18c4` 至 `ce3b15a`）与 `SpaceCoder-Kafka/homebrew-tap` 的远端 `main`（`edcd68b` 至 `5384bc5`）。版本于 2026-10-27 以 0.1.0 发布；重新编号不作为新增能力单列。

**New Features:**

1. **共享同一条 Codex 会话**：分享者继续在已运行的官方 Codex Desktop 工作，协作者获准后在浏览器阅读对话、补充需求并向同一个 Agent 发消息，减少来回复制上下文；可开启逐条消息审批，原生工具审批仍由分享者在 Desktop 处理。
2. **直接查看图文与附件**：在协作页阅读 Markdown 回复、放大图片、播放 MP4 和查看文本附件，减少另开软件核对内容的步骤；图片支持 PNG、JPEG、WebP，文本支持 UTF-8／UTF-16，预览受共享范围、格式与大小限制。
3. **管理共享范围、有效期与列表**：可选择公网或指定内网地址共享；公网在连接正常且中继支持时自动续期，内网邀请可设固定时长或永久，减少反复生成链接。最近共享优先显示，已结束卡片可收起并保留历史；内网 HTTP 不加密，永久邀请也受主机和网络可用性限制。
4. **及时收到协作提醒**：汇总访客申请、待审批消息、共享异常和任务结束提醒，减少一直盯着会话的负担；浏览器系统通知需授权并保持页面连接，内网 HTTP 使用页内提醒，任务结束不代表执行成功。
5. **查看版本并在应用内更新**：在「关于」中确认安装版本、检查并下载安装新版，减少手动找包和混用版本的麻烦；下载会核验签名，安装由用户触发，共享仍在进行时先确认结束共享。

**Bug Fixes:**

1. **保留重新分享和重启后的消息署名**：保留已观察到的消息作者，减少把协作者发言误认成分享者的情况；没有可靠记录的历史消息不猜测作者。
2. **看清连接检查与重建进度**：检查和重建时显示明确状态，处理中禁用重复操作，减少误以为没有响应而反复点击的情况；重建入口前会提示旧邀请失效。

**Chore：**

1. **简化安装并提供校验材料**：通过 Homebrew 或 DMG 安装，内置所需辅助运行环境，并提供文件校验、源码清单和第三方许可，减少手工配置，便于核对下载完整性与组件许可；此版分享端面向 Apple Silicon、macOS 15+。

### Upgrade / 升级方法

- Apple Silicon, macOS 15+. Historical Build 17 users can use About → Check for updates. The internal Build increases even though the displayed version becomes 0.1.0. Earlier builds require a manual DMG installation or Homebrew reinstall.
- 首版常规发布需要 Apple Silicon Mac 与 macOS 15+。原 Build 17 可通过「关于 → 检查更新」迁移；更早版本需先退出 Co²，再手动安装。旧 Homebrew 用户本次使用 `brew update` 和 `brew reinstall --cask SpaceCoder-Kafka/tap/codex-co2`。

### Known limitations / 已知限制

- Independent experimental project; ad-hoc signed and not Apple-notarized. Requires an already running compatible official Codex Desktop. Public TLS has no E2EE; intranet HTTP is unencrypted. Guest messages use the existing conversation's execution context; native tool approvals remain in Desktop.
- Native shared-session update confirmation, tool approvals, real network/mobile behavior, physical sleep/wake and clean-Mac installation remain unverified. This baseline does not include Universal macOS, Windows packages, invitation recovery or the persistent background service added in 0.2.0.
- 项目仍处于实验阶段，采用临时签名、未经 Apple 公证。真实共享会话升级、原生工具审批、跨设备网络、移动设备、睡眠唤醒与干净 Mac 安装仍待验收。0.1.0 不包含 0.2.0 新增的跨平台包、邀请恢复和持久后台服务。
