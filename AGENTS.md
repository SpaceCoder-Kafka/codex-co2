# Codex Co² project conventions

- Repository/package: `codex-co2`; display name **Codex Co²**; full name **Codex Conversation Collaboration**.
- English subtitle: **Real-time collaboration for Codex**. Chinese introduction: **共享一条 Codex 会话，一起推进工作。**
- Public README files explain value, installation, usage and essential boundaries. Maintainer architecture, historical evidence and acceptance archives are kept separately and are not part of the public export.
- Preserve legacy protocol identifiers, `.coop/` state and retired SSH cleanup markers. Do not rewrite historical evidence as if it used new paths or versions.

## Runtime and authorization

- Keep one authoritative Codex runtime: host in official Desktop, guest in browser. Attach to the already-running Desktop without restart, profile replacement, patches or process injection. Fail closed when its existing interface is unavailable or incompatible. Do not silently add a backend or downgrade Desktop.
- Guests may access only the explicitly shared conversation. Enforce request, response, notification, approval and execution-capability boundaries; hiding lists is not authorization. Host-level SSH sharing is retired. Preserve cleanup compatibility without recommending or re-enabling that route.
- After admission, guest messages enter the shared Agent directly by default. Only the authenticated local manager can enable per-message approval. Changes affect new messages; already pending proposals need an explicit decision. Native tool approvals remain with the host.
- Sharing uses outbound public relay infrastructure with ordinary TLS trust, without E2EE. Host disconnection pauses collaboration. Guest messages retain the conversation's existing execution context; sharing does not create a new sandbox.
- Default authentication and conversation body files must never be read, copied or synchronized. The authenticated host manager may read only thread ID, title, updated time and project path from a read-only SQLite index, filtering archived entries. Do not select previews, first messages, rollout paths, settings or credentials. Read the chosen conversation's body only through existing Desktop IPC after the host selects it for sharing. Tests and automated exploration must not inspect the user's real index, credentials or JSONL.
- Runtime state, isolated authentication and observations belong in ignored `.coop/`, mode 0700. Do not include these or real conversations in export, diagnostics or visual assets.
- Sparkle may use its standard macOS caches and preferences for public update packages, signatures and update scheduling. These contain no conversations or credentials and are excluded from exports and diagnostics; Co² service runtime state remains in `.coop/`.

## Verification and distribution

- Pin Codex CLI 0.163.0 for isolated synthetic integration tests only. Tests use temporary homes, synthetic credentials and local model fixtures: no real model calls or external messages.
- Run `npm test` and `npm run test:integration:required` for transport/lifecycle changes. The required runner must not pass with skipped integrations. Scripted RPC clients do not prove native Desktop behavior.
- Distinguish implemented, automatically verified, manually verified and untested behavior. Record exact observed versions and remaining native acceptance gaps in private maintainer records. Never claim clean-Mac installation or native approval acceptance from bundle checks.
- Run `npm run check:public` and `npm run notices:check` before export. Export only the explicit public file list to a new independent repository; do not copy history or invent a remote, public identity or release URL.
- Keep lockfiles, third-party license notices and the source digest associated with release assets. Do not package arbitrary local dependencies. Preview packages are ad-hoc signed and unnotarized until explicitly changed and verified.
- Do not change global shell configuration or replace an active installation during tests.
