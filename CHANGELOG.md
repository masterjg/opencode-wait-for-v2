# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Local namespace integration: `tools.wait.for` with project-root and `external_directory` permission checks.
- Bundled `skills/wait/SKILL.md` and install instructions.

## [0.2.0] - 2026-11-14

### Added

- Unified `condition` parameter for `wait_for`, covering 11 condition types ([#1](https://github.com/lcssos/opencode-wait-for-v2/pull/1)):
  - files: `file_exists`, `file_absent`, `file_changed`, `file_contains`
  - processes: `process_exited`, `process_running`
  - ports: `port_open`, `port_closed`
  - HTTP: `http_status`, `http_json`, `http_body_contains`
- Condition waits return `metadata.attempts` and the last `metadata.observed` state. A timeout is still a normal result (`hit: false`, `reason: "timeout"`) rather than an error.
- README section documenting every condition type, with CI, registry, port, and file examples.

### Changed

- All project text — README, tool descriptions, error messages, tests, CI workflows, and release script — translated to English ([#2](https://github.com/lcssos/opencode-wait-for-v2/pull/2)).

### Contributors

- [@masterjg](https://github.com/masterjg) (Marius Guščius) — unified conditions ([#1](https://github.com/lcssos/opencode-wait-for-v2/pull/1)) and English translation ([#2](https://github.com/lcssos/opencode-wait-for-v2/pull/2)).

## [0.1.1] - 2026-11-01

### Added

- Comparison with related OpenCode plugins (opencode-pty, opencode-background-jobs, background task managers).

## [0.1.0] - 2026-11-01

### Added

- Initial release of the `wait_for` tool: block until a log pattern appears or a PID exits, replacing `sleep N; tail ...` polling.
- Interruptible via `AbortSignal`, progress reported once per second, and log matching limited to the last 64 KB.

[0.2.0]: https://github.com/lcssos/opencode-wait-for-v2/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/lcssos/opencode-wait-for-v2/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/lcssos/opencode-wait-for-v2/releases/tag/v0.1.0
