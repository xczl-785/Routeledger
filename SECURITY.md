# Security policy

Do not include credentials, tokens, personal paths, or managed-project data in
an issue or pull request. Report suspected vulnerabilities through the
repository's **Security → Advisories → Report a vulnerability** form, which
uses GitHub private vulnerability reporting. Do not open a public issue for an
unpatched vulnerability.

Before reporting a behavior, verify the active MCP binding with
`get_runtime_context`. A surprising binding or write target should be treated
as a safety incident: stop writes, preserve the relevant canonical JSON and
logs, and report the observed paths without publishing their contents.

Security fixes must preserve the server-side binding assertion, canonical JSON
validation, lock behavior, and L3 approval-artifact checks. Include focused
tests or an explanation of why a test cannot be added.

Security contributions are covered by the repository's
[Apache License 2.0](LICENSE).
