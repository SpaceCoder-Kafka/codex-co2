# Changelog

## 0.3.0

[中文版 →](https://github.com/SpaceCoder-Kafka/codex-co2/blob/main/docs/release-notes/v0.3.0-zh.md)

**New Features**

1. **More artifact previews**: View assistant file outputs and attachments as audio, PDF, CSV/TSV, XLSX, Markdown, DOCX and PPTX, and download their original bytes. Office previews show common text, tables and embedded images with clear fallbacks for complex content.
2. **Rich text rendering**: Read formulas, Mermaid diagrams and highlighted code with source-view controls and self-hosted preview resources.
3. **Read-only activity cards**: Expand tool results, command output, file changes and plans supplied by Desktop IPC. Native approvals remain with the host; available states and results depend on Desktop's interface.
4. **Desktop-style conversation layout**: Read black sender bubbles, expandable long messages and compact activity summaries. Completed work folds separately from final replies, and explicit disclosure choices survive live updates.

**Bug Fixes**

1. **Conversation completeness**: Restore user instructions explicitly delivered from another chat and local Desktop history overlays. Keep direct replies to mid-turn answers visible; prioritize change and plan cards within the snapshot budget and show when older activity rows are omitted. Large histories no longer exhaust preview entry bookkeeping and leave blank cards.
2. **Native conversation presentation**: Read question replies and plan confirmations without protocol envelopes, retain messages sent during a run, and use one disclosure per turn. File links keep their labels and inline positions; change summaries merge by turn and use project-relative paths. Native timestamps and ChatGPT provenance appear when available.

## 0.2.0

[中文版 →](https://github.com/SpaceCoder-Kafka/codex-co2/blob/main/docs/release-notes/v0.2.0-zh.md)

**New Features**

1. **More desktop packages**: Choose Universal macOS 14+ or Windows 10 1809+/11 x64 setup and portable packages. Windows requires WebView2 and manual updates.
2. **Request invitation recovery**: Request host-approved recovery for expired or interrupted shares while the original entry remains reachable.
3. **Background sharing and LAN recovery**: On macOS, system-approved background running keeps sharing active after the manager closes. LAN restarts retain pending recovery requests when the original address and port remain available.

**Bug Fixes**

1. **macOS startup recovery (Build 27)**: Ad-hoc signed packages reuse an existing service or run with the management app, avoiding repeated rejected background launches. Quitting pauses foreground sharing; saved LAN recovery records remain available when enabled. Startup failures distinguish timeouts from process exit codes.

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
