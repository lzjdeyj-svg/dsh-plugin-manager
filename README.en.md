# dsh-plugin-manager · plugin manager for the DSH Web GUI

Install / disable / enable / update / uninstall dsh plugins hosted on GitHub
(bundle plugins such as gal-view) right from the DeepSeek Harness Web GUI.

> Paste a full install command copied from a README, e.g.:
> `dsh plugin --profile web add github:Ayase34/gal-view#main`

## Features

- **Paste-to-install**: paste any `dsh plugin …` install command (or a bare
  `github:owner/repo#branch`, `owner/repo`, npm package name) into the
  **Settings → Plugins → 插件管理** tab and click install.
- **Installed list**: package name / version / source / enabled state per plugin.
- **Disable / Enable**: disable keeps the dependency installed but removes it
  from the profile layer stack (`dsh.profile.bundles`); re-enable puts it back
  without re-downloading.
- **Update / Uninstall**: one click for `pnpm update` / `pnpm remove`, with the
  official bundle reconciliation logic applied automatically.
- **pnpm build gating**: git packages with `prepare` scripts blocked by pnpm are
  allowed automatically (`pnpm.onlyBuiltDependencies`) and rebuilt.
- **Consistent restart notice**: after every install/disable/enable/update the UI
  says "restart web to take effect".

The manager itself is a standard dsh bundle plugin (same format as gal-view), so
it can be distributed to any dsh web user with a single command.

## Install

```sh
dsh plugin --profile web add github:<owner>/dsh-plugin-manager#main
# or from a local checkout:
#   cd <profile directory> && pnpm add /absolute/path/to/dsh-plugin-manager
```

Then **restart web** and open **Settings → Plugins → 插件管理**.

## Usage

### GUI

1. **Install**: paste a command or repo address and press install.
2. **Manage**: use Disable / Enable / Update / Uninstall on each row.
3. Results appear below; restart web when prompted.

### CLI (`dshpm`, same engine)

```sh
dshpm ls                                   # list installed plugins
dshpm add github:owner/repo#main           # install
dshpm rm gal-view                          # uninstall
dshpm up gal-view                          # update
dshpm off gal-view                         # disable (keep dependency)
dshpm on gal-view                          # enable
```

- Default profile: `$DSH_PROFILE` or `web`; override with `--profile <name>`.
- Harness home: `$DSH_HOME`, default `~/.dsh`.
- pnpm resolution: `$DSHPM_PNPM` > `pnpm` on PATH > `corepack pnpm`.
- A whole `dsh plugin --profile web add …` line can be pasted as the only argument.

## Semantics

- **Disable ≠ uninstall**: disable removes the plugin from the profile layer
  list while keeping the dependency in `package.json`; enable puts it back.
- **Uninstall**: real `pnpm remove` plus layer-list cleanup.
- Git source specs (`github:owner/repo#ref`) are preserved in `dependencies`.

## Implementation notes

- The browser half (`.dsh-plugin/client.js`) follows the official
  `__ModuleLoader__.load` lazy-CJS factory contract, hand-written with **no build
  step and no runtime deps** (only the platform-injected `react`). The package has
  no `prepare` script, so installing it never trips pnpm build gating.
- The host half (`.dsh-plugin/index.mjs`) is a loader-row plugin registering its
  own settings namespace `plugin-manager`; UI ↔ host traffic uses only the
  official settings domain (client `settingsScope` ↔ host `ctx.settings`) — no
  private Typert/Remote registration.
- All execution logic lives in `lib/pm-core.mjs`, shared by the CLI and the host
  half. Reconciliation mirrors official `dsh plugin` semantics (by installed
  state, not by dependency diff).

## Development

```sh
node --test tests/*.test.mjs     # pure-logic unit tests (temp dirs only)
node bin/dshpm.mjs ls            # read-only walkthrough
node bin/dshpm.mjs check         # pre-boot health check (manifest / layers / cordis.patch.yml single-doc)
```

## Troubleshooting: web fails to start (exit code 1)

At boot dsh strictly parses the profile's `cordis.patch.yml` (loader patch layer).
The classic failure: appending a README snippet right after the template's `[]`
— the file then contains two YAML documents and fails to parse, so **every** dsh
command on that profile exits with code 1. Fix: merge the snippet into one list
(remove the `[]` so the list itself is the file body). Run
`dshpm check --profile <name>` before restarting: it checks that dependencies are
installed, that every layer resolves and declares `dsh.bundle`, and that the
patch file is a single valid YAML document, reporting exact locations on error.

## Known limitations

- Install the manager into each profile you want to manage (it manages the
  profile it runs in); the default profile is `web`.
- Install/update requires the dsh process to reach `pnpm` (or `corepack pnpm`)
  and git/network.
- The first run needs one web restart so the host serves the `plugin-manager`
  settings namespace.

## License

MIT

## Open-source / publish

Want to publish this project on GitHub? The beginner-friendly step-by-step guide
(in Chinese, web-only workflow, no coding needed) lives at
[`docs/PUBLISH-TO-GITHUB.zh.md`](docs/PUBLISH-TO-GITHUB.zh.md).
