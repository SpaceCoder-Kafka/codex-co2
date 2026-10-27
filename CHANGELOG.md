# Changelog / 更新日志

Product versions describe releases; internal build numbers increase across all versions and channels. Bug fixes use patch versions (0.1.1); feature releases use minor versions (0.2.0).

产品版本按发布内容递增：修复使用补丁版本（0.1.1），功能更新使用次版本（0.2.0）。内部 Build 在所有版本和渠道之间持续递增。

## 0.2.0

### Highlights / 主要变化

- Add Universal macOS packages for Apple Silicon and Intel, targeting macOS 14+, and Windows 10 1809+ / Windows 11 x64 setup and portable packages. Windows requires Microsoft Edge WebView2 Runtime.
- Recover authorized invitations after service restarts, show connection recovery feedback, and reconcile missed message acknowledgements without automatically replaying uncertain submissions.
- Add an optional macOS background sharing service so authorized sharing can continue after the management interface quits.
- 在 0.1.0（原 Build 17）基础上，新增 macOS 14+ Universal 与 Windows x64 安装包、邀请与连接恢复，以及可选 macOS 后台共享服务。管理界面退出后，已启用且获系统允许的后台服务可继续共享。

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

### Highlights / 主要变化

- Establish the regular release baseline from **Codex Co² 0.3.3 Preview · Build 17**. Only release numbering, packaging metadata and documentation are normalized; later local features belong to 0.2.0.
- Share one selected conversation from an already running official Codex Desktop. Collaborators join in a browser, follow replies and images, and send messages to the same Agent. Hosts control admission and optional message review.
- Includes public TLS or explicit intranet-only sharing, invitation lifetimes, browser notifications, Chinese/English interfaces, and signed macOS in-app updates.
- 以已发布的 **0.3.3 Preview · Build 17** 为功能基线，重新编号为 0.1.0。支持单会话浏览器协作、图片展示、准入与可选消息审批、公网或内网共享、邀请有效期、通知与 macOS 应用内更新。后续本地新增功能归入 0.2.0。

### Upgrade / 升级方法

- Apple Silicon, macOS 15+. Historical Build 17 users can use About → Check for updates. The internal Build increases even though the displayed version becomes 0.1.0. Earlier builds require a manual DMG installation or Homebrew reinstall.
- 首版常规发布需要 Apple Silicon Mac 与 macOS 15+。原 Build 17 可通过「关于 → 检查更新」迁移；更早版本需先退出 Co²，再手动安装。旧 Homebrew 用户本次使用 `brew update` 和 `brew reinstall --cask SpaceCoder-Kafka/tap/codex-co2`。

### Known limitations / 已知限制

- Independent experimental project; ad-hoc signed and not Apple-notarized. Requires an already running compatible official Codex Desktop. Public TLS has no E2EE; intranet HTTP is unencrypted. Guest messages use the existing conversation's execution context; native tool approvals remain in Desktop.
- Native shared-session update confirmation, tool approvals, real network/mobile behavior, physical sleep/wake and clean-Mac installation remain unverified. This baseline does not include Universal macOS, Windows packages, invitation recovery or the persistent background service added in 0.2.0.
- 项目仍处于实验阶段，采用临时签名、未经 Apple 公证。真实共享会话升级、原生工具审批、跨设备网络、移动设备、睡眠唤醒与干净 Mac 安装仍待验收。0.1.0 不包含 0.2.0 新增的跨平台包、邀请恢复和持久后台服务。
