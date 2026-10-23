# Security

Only the latest experimental preview is considered for fixes. There is no guaranteed response time or production support commitment.

**Do not post vulnerabilities, live invitations, recovery credentials, raw conversations or authentication files in public Issues.**

Use **Security → Advisories → Report a vulnerability** when private reporting is enabled. If absent, no private reporting channel is configured: do not publish exploit details or private data. A general Issue may ask the maintainer to enable private reporting without describing the vulnerability. Maintainers must enable this channel before public launch.

Provide a synthetic reproduction, affected app/build and Desktop versions, expected access boundary and observed impact. Never attach default authentication, SQLite databases, session JSONL, full diagnostic archives or recovery files. Revoke accidentally disclosed invitations and visitor credentials immediately.

Sharing grants access to a conversation and its existing Agent, not a separate execution sandbox. Guest messages use the host conversation's existing tools and allowance. Native tool approval remains with the host. Public relay/tunnel infrastructure is trusted under ordinary TLS; there is no E2EE claim. Direct intranet mode binds a selected private IPv4 listener, rejects public socket peers and creates no public tunnel. Its HTTP traffic, including credentials and conversation content, is unencrypted. Deliberate gateway SNAT or separately configured forwarding is outside that network boundary. Intranet mode does not restrict the existing Agent's model or tool traffic. Revocation cannot erase copies already received.

Timed intranet invitations have a fixed deadline: expiry ends sharing and rejects new admission and further messages. Short relay leases and online visitor credentials must not renew beyond that deadline. Permanent means no fixed invitation deadline, not a durable URL or perpetual access; revocation, app exit, entry changes and host/network availability still apply. Public invitation renewal is unchanged.
