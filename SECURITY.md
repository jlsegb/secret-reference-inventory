# Security Policy

## Supported versions

This project is pre-1.0. Security fixes are provided for the current `main`
branch and the latest published release, when a release exists. Older releases
and unreleased development branches are not supported unless a maintainer states
otherwise in the relevant advisory or release notes.

## Reporting a vulnerability

Please report suspected vulnerabilities privately.

- Use GitHub private vulnerability reporting for this repository when it is
  available.
- If private reporting is not available, open a public GitHub issue that says
  you need to report a security issue, but do not include exploit details,
  sensitive paths, customer data, or secret values. A maintainer will arrange a
  private channel for details.

Do not include real credentials, tokens, private keys, environment variable
values, or proprietary inventories in a report. Use synthetic examples whenever
possible. If a real name or path is needed to explain impact, redact the value
and describe only the minimum structure needed to reproduce the issue.

Useful reports include:

- affected version, commit, or package artifact;
- operating system and Node.js version;
- the command or API call used;
- a minimal synthetic reproduction case;
- observed behavior and expected behavior;
- whether the issue can expose secret values, read or write files outside the
  requested inputs, execute code, make network requests, or corrupt reports.

## Scope

Security issues in scope include vulnerabilities that could cause this tool to:

- expose secret values that should remain redacted;
- read files outside user-selected repository roots or input documents;
- write files outside explicit output paths;
- execute repository code, shell commands, build scripts, plugins, or package
  hooks while analyzing input;
- make unexpected network requests or send telemetry;
- produce HTML, SARIF, JSON, or workspace reports that enable injection or
  script execution when opened in a supported viewer;
- mishandle malicious input files in a way that causes denial of service beyond
  documented resource limits.

Out-of-scope reports include:

- requests to identify, rotate, or validate leaked third-party credentials;
- reports that include only inaccurate scan results without a security impact;
- vulnerabilities in repositories being scanned, unless this tool mishandles
  them in one of the ways listed above;
- dependency vulnerabilities that are not reachable through this project.

## Disclosure and response

Maintainers will make a best-effort attempt to acknowledge valid private reports
within 7 days, provide a status update within 14 days, and coordinate disclosure
after a fix or mitigation is available. These targets are not a service-level
agreement.

Please allow maintainers time to investigate before public disclosure. When a
fix is released, the advisory or release notes should describe the affected
versions, impact, and mitigation steps without disclosing user secrets or
unnecessary exploit detail.

## Handling secrets during development

This repository is for a local-only static analysis tool that inventories secret
references, not secret values. Development, tests, fixtures, documentation, and
issue reports must use synthetic values. Do not commit real `.env` files,
tokens, credentials, private keys, customer inventories, or production binding
exports.
