# Security

Only the latest experimental preview is considered for fixes. There is no guaranteed response time or production support commitment.

**Do not post vulnerabilities, live invitations, recovery credentials, raw conversations or authentication files in public Issues.**

Use **Security → Advisories → Report a vulnerability** when private reporting is enabled. If absent, no private reporting channel is configured: do not publish exploit details or private data. A general Issue may ask the maintainer to enable private reporting without describing the vulnerability. Maintainers must enable this channel before public launch.

Provide a synthetic reproduction, affected app/build and Desktop versions, expected access boundary and observed impact. Never attach default authentication, SQLite databases, session JSONL, full diagnostic archives or recovery files. Revoke accidentally disclosed invitations and visitor credentials immediately.

Sharing grants access to a conversation and its existing Agent, not a separate execution sandbox. Guest messages use the host conversation's existing tools and allowance. Native tool approval remains with the host. Relay/tunnel infrastructure is trusted under ordinary TLS; there is no E2EE claim. Revocation cannot erase copies already received.

Application updates are a local host capability. Guests and the relay cannot initiate update checks, choose download URLs or install software. Updater-enabled releases require signed update metadata and archives; failed verification must prevent installation. Update signing keys are separate from Codex authentication and must never be included in source exports or application bundles. Sparkle's standard system caches contain only public update packages and metadata, not conversations or credentials.
