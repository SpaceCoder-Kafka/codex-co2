# Changelog

## 0.4.0

[中文版 →](https://github.com/SpaceCoder-Kafka/codex-co2/blob/main/docs/release-notes/v0.4.0-zh.md)

**New Features**

1. **Guest file uploads**: Select, paste or drop files and send attachment-only messages through the existing admission and message-approval flow. Upload up to 8 files per message, 32 MiB per file and 64 MiB total through acknowledged chunks and private host storage. Images use native image input; other files use Desktop attachment references.
2. **Desktop-style attachment composer**: Browse attachments in a horizontal strip above the text input. Supported images, videos, documents and text show local previews; other files show a type icon and filename. Removing, sending or disconnecting releases preview resources.
3. **Document cards and legacy Office downloads**: Show common document attachments and standalone generated documents as compact file cards. Download original DOC, XLS and PPT files with a clear notice when browser preview is unavailable.

**Bug Fixes**

1. **Duplicate image attachments**: Hide a redundant file card when the same structured image is displayed. Image zoom and download remain available; unavailable images retain an original-file fallback. Video cards keep their existing behavior.
2. **File presentation**: Keep filenames, format badges and link labels on document cards while preserving inline links in ordinary prose. A display label or matching filename never grants file access or suppresses an unrelated attachment.
3. **Sender labels**: Preserve host and collaborator attribution when Desktop turns become persistent or a conversation is shared again. Earlier unconfirmed guest submissions no longer block unrelated native host input; messages without sufficient attribution evidence remain unknown.

Audio understanding depends on Desktop and model support. Remote/cloud execution without host-file transfer remains unavailable. Native Desktop acceptance is still pending; synthetic transport and browser checks do not establish full file-type parity.

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
