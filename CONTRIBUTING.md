# Contributing

Thanks for taking the time to improve `opencode-wait-for-v2`. This document covers the development setup, the conventions used by the project, and how releases are made.

## Requirements

- **Bun** (used for tests and build checks)
- **Node.js >= 22.14** (declared in `package.json` `engines`)
- **OpenCode V2** if you want to try the plugin end to end

## Setup

```bash
git clone https://github.com/lcssos/opencode-wait-for-v2.git
cd opencode-wait-for-v2
bun install
bun test
```

`bun install` only needs the host SDK (`@opencode/plugin`). The plugin itself has no other runtime dependencies — it uses Node built-ins (`fs`, `net`, `fetch`).

## Project layout

| File | Responsibility |
| --- | --- |
| `index.ts` | The `tools.wait.for` tool: namespace, project-root/permission checks, input schema, progress reporting, result formatting. |
| `wait.ts` | Unified `condition` API: normalization, per-type checks, polling loop, metadata and timeout reporting. |
| `wait.test.ts` | Legacy log/pid waiting, progress, interruption, and every condition type. |
| `skills/wait/SKILL.md` | Bundled agent skill: conditions, defaults, limits, and permission behavior. |
| `scripts/release.sh` | Version bump, commit, tag, push (maintainers only). |

## Making changes

1. **Open an issue first** for new condition types or behavior changes, so the API stays consistent.
2. **Add tests.** Any new condition type needs a test in `wait.test.ts` that fails before the change and passes after it.
3. **Run the checks** before opening a PR:

   ```bash
   bun test
   bun build index.ts --target=node --outfile=/tmp/check.js
   bash -n scripts/release.sh
   ```

4. **Keep the diff focused.** One concern per PR: a feature PR should not carry a translation, and a docs PR should not change behavior.
5. **Use English** in code, comments, tests, and PR descriptions.

## Conventions

- **Timeouts are normal results, not exceptions.** `tools.wait.for` returns `matched: false` with `timedOut: true` and the last `observed` state. Do not turn this into a thrown error.
- **`condition` takes precedence** over the legacy `path` / `pattern` / `pid` / `must_be_new` fields. Preserve that behavior.
- **Never read whole files.** File checks read the tail (64 KB) or the range written after the call starts (up to 256 KB). HTTP bodies are capped at 256 KB.
- **Honor `AbortSignal`.** Every wait must stop promptly when the caller interrupts (ESC in the UI).
- **No new runtime dependencies** unless there is a strong reason; zero dependencies is a feature of this plugin.
- **Do not modify built-in tools.** The plugin only adds `tools.wait.for`; it does not wrap `shell` or other tools.
- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `chore:`.

## Pull requests

- Describe the motivation, the API surface (if any), the timeout/interrupt behavior, and what you tested.
- Link the related issue when there is one.
- CI runs `bun test` and a build check. A PR is not ready while CI is red.
- Maintainers may squash or ask for the PR to be split if it mixes concerns.

## Releases

Releases are done by maintainers only:

```bash
./scripts/release.sh patch    # 0.2.0 -> 0.2.1
./scripts/release.sh minor    # 0.2.1 -> 0.3.0
./scripts/release.sh 1.2.3    # explicit version
```

The script requires a clean `main`, runs the tests, bumps `package.json`, commits, creates an annotated tag, and pushes both. Pushing a `v*` tag triggers `.github/workflows/publish.yml`, which publishes to npm via OIDC trusted publishing — no npm token is stored. The workflow fails if the tag does not match `package.json` or if that version already exists on npm.

Update `CHANGELOG.md` as part of the release PR or the release commit.

## License

By contributing, you agree that your work is licensed under the project's [MIT License](LICENSE).
