# Changelog

## 0.2.0

[中文版 →](https://github.com/SpaceCoder-Kafka/codex-co2/blob/main/docs/release-notes/v0.2.0-zh.md)

**New Features**

1. **More desktop packages**: Choose Universal macOS 14+ or Windows 10 1809+/11 x64 setup and portable packages. Windows requires WebView2 and manual updates.
2. **Request invitation recovery**: Request host-approved recovery for expired or interrupted shares while the original entry remains reachable.
3. **Background sharing and LAN recovery**: On macOS, system-approved background running keeps sharing active after the manager closes. LAN restarts retain pending recovery requests when the original address and port remain available.

**Bug Fixes**

1. **macOS startup recovery (Build 25)**: Repair missing background-service registrations and show a clear error with retry and settings actions when startup fails. Preserve invitation recovery records during retries.

**Chore**

1. **Local access protection**: Check user identity, file permissions and attachment paths to reduce unauthorized access.

## 0.1.0

[中文版 →](https://github.com/SpaceCoder-Kafka/codex-co2/blob/main/docs/release-notes/v0.1.0-zh.md)

**New Features**

1. **Share a Codex conversation**: Collaborate in a browser after host approval, without repeatedly forwarding context.
2. **Preview images and attachments**: View images, videos and text in place, within supported format and size limits.
3. **Control sharing scope and expiry**: Choose public or LAN sharing and set LAN invitation lifetimes to fit each collaboration.
4. **Collaboration notifications**: Track join requests, pending messages and run completion; system notifications require permission.
5. **In-app updates**: Check the installed version and choose when to update, without searching for downloads.

**Bug Fixes**

1. **Keep message authors**: Preserve observed author labels across resharing and app restarts.
2. **Connection progress feedback**: Show check and rebuild progress and block repeated clicks.

**Chore**

1. **Simpler installation and verification**: Provide installers, checksums and license notices to reduce manual setup. Hosts require Apple Silicon and macOS 15+.
