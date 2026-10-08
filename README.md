# dsh-notify

Real operating-system notifications for DeepSeek Harness: a Windows Action Center toast, a macOS Notification Center banner, or a Linux notification-daemon message, raised when DSH needs you back at the window.

## What it notifies

| Moment | Source |
|---|---|
| A turn finished | `api-session/status` remote event, `running` true → false |
| A turn failed | `api-session/error` remote event |
| A background job settled | the `jobsBySession` mirror on the client session list |
| An agent is waiting for confirmation | `uiSession.pendingInteractions` (approval, user question, plan review) |

Clicking a notification focuses the window and opens the session it came from.

## Install

### Option 1: the prebuilt tarball (recommended, no build authorization)

Download `dsh-notify-0.1.0.tgz` from [Releases](https://github.com/Zhiyi-Zhao/dsh-notify/releases):

```sh
dsh plugin --profile desktop add ./dsh-notify-0.1.0.tgz
```

The built artifacts ship inside the package and no build script runs during installation (verified against an isolated profile).

### Option 2: straight from GitHub

```sh
dsh plugin --profile desktop add github:Zhiyi-Zhao/dsh-notify
```

The built artifacts (`lib/`) are committed, so no local toolchain is needed. pnpm may still require explicit approval for a git dependency's build script; if the command asks for that, add the key it prints to the profile's `pnpm-workspace.yaml` and retry:

```yaml
allowBuilds:
  dsh-notify: true
```

### Option 3: a local directory (development)

```sh
dsh plugin --profile <profile> add /absolute/path/to/dsh-notify
```

The package declares both a `dsh.bundle` layer (which mounts the row) and a `dsh.client` browser half. After installing into the **desktop** profile, restart the DeepSeek Harness application: profile composition is read at startup, and the profile is owned by the Electron shell, so the CLI cannot reload it for you.

The first load after installation shows one self-test notification, so you can tell the channel works without waiting for a long task.

Uninstall:

```sh
dsh plugin --profile desktop remove dsh-notify
```

## Noise control

Notifications default to *attention only*: nothing is shown while the window is focused and visible, a completed run shorter than 10 seconds is ignored, and one stopped agent produces one notification — a pending confirmation or an error replaces the "finished" notice for the same run.

Runtime tunables are read from `localStorage['dsh-notify.options']` as a JSON object. Client halves do not receive their `cordis.yml` row config (the Web boot kernel creates every entry with `loader.create({ name })`), so this key is the standalone plugin's configuration channel:

```js
localStorage.setItem('dsh-notify.options', JSON.stringify({ onlyWhenUnfocused: false, minRunMs: 0 }))
```

| Field | Default | Meaning |
|---|---|---|
| `onlyWhenUnfocused` | `true` | Stay silent while the window is focused and visible |
| `minRunMs` | `10000` | Ignore completed runs shorter than this |
| `silent` | `false` | Show notifications without the platform sound |
| `selfTest` | `true` | Show the one-time installation notification |
| `replaceTurnEndMs` | `2000` | How long a turn-end notice waits for a better notice about the same run |

The self-test flag is `localStorage['dsh-notify.selfTestShown']`.

## How it runs

The plugin is a browser half only; the host half exists so a profile row can mount the package. Every notification is rendered by the page through the Web Notification API, which is why the plugin works in the desktop shell and in a plain browser window alike, and why it needs no packaging identity or PowerShell helper.

The desktop shell grants notification permission to its main window (only `media` requests are routed elsewhere), so toasts arrive without a prompt. A plain browser window needs one user gesture before it may ask; the plugin requests permission on the first pointer or keyboard event and stays silent until it is granted. Without a Web Notification API, or with permission denied, the plugin logs one warning and disables itself.

## Delivery and diagnosis

The first notification also registers the application under **Settings → System → Notifications** (Windows lists it as *DeepSeek Harness*). That entry is where to confirm banners are allowed, and the notification center (`Win+N`) is where a suppressed or missed banner still appears.

Nothing is shown while the window is focused and visible: that is the default `onlyWhenUnfocused` behaviour, not a failure. To check the channel itself, switch to another window and let a turn finish. When a notification is expected and absent, check in that order: the per-app switch in notification settings, the notification-center history, and `%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db` for whether the system received it at all.

**Never pass `tag`.** Measured on this machine: a tagged `new Notification()` is accepted by the browser but the toast **never reaches Windows**, while the identical call without a tag arrives every time — the installation notification, the probes, and the real turn-end notice all confirm it. Per-session replacement is the price, so repeated notices in one session stack.

## Known limitations and deferred work

- **No `cordis.yml` options.** Client entries receive no config, so this plugin reads its tunables from `localStorage`. An upstream package should serve a host-side settings namespace and a settings card instead.
- **A reload during a run is compensated, not eliminated.** On activation the plugin seeds every session whose list row is already `running`, so the completion of a turn that was in flight still notifies. A client that does not project running state into its list leaves that turn unannounced.
- **No same-session replacement.** Notifications carry no `tag` (see above), so repeated notices stack instead of replacing each other.
- **Per-client delivery.** Two attached clients (desktop window plus a browser tab) each notify. Cross-client de-duplication has no owner today.
- **Web GUI only.** The plugin injects client services (`remote`, `sessions`, `locale`, plus optional `uiSession`); headless and ACP runs have no browser half and receive nothing.
- **A repeat run can re-notify a job.** A job whose row disappears from the mirror and later returns with the same id and status is suppressed only by identity, not by time.

## Activation safety

A client entry that throws fails the Web boot audit, and the desktop shell treats that audit failure as fatal: the application does not start, and its crash recovery rewrites the profile. Two mistakes here each caused exactly that on a live profile before they were fixed, so both are now rules of the implementation:

- **Resolve services once, at apply time.** `ctx.<service>` resolves against the running fiber, so a callback that runs outside this plugin's fiber — a store notification, a notification click, the deferral timer — must use a captured value. Reaching through `ctx` there throws `cannot get required service "sessions" in inactive context`.
- **Treat published state as partial.** The session-list store publishes states without `jobsBySession`; a rule that assumes the member exists throws `Cannot convert undefined or null to object` and fails activation.

`apply` additionally contains its whole activation: any unexpected error logs one line and turns notifications off instead of reaching the boot audit. Verify any change against a **separate profile**, never the one you are working in — `dsh --profile <scratch>` with its own `DSH_HOME` reproduces the real boot, and the browser console is where the underlying error appears.

## Client version compatibility

Three client members this plugin reads differ across DSH versions; the code accepts both (verified against the 0.2.0-rc.2 desktop build installed here):

| Signal | Current clients | Older clients here | Handling |
|---|---|---|---|
| Pending confirmation (approval, question) | `uiSession.pendingInteractions` (subscribable) | only `uiSession.pendingSnapshot`, and that field is **replaced wholesale** on every change (`this.pendingSnapshot = projected`) | subscribe when the observable exists, otherwise poll at 1 Hz **re-reading the field each time** — capturing the map object once makes every poll read the original empty map |
| Settled background job | `jobsBySession` on the list state | list state carries `ids/byId/phase/projectionsBySession` only | a missing mirror reads as empty; **job notifications stay off on older clients** |
| Click opens the session | `sessions.open(id)` | no such method | called only when present; the click still focuses the window |
| Running state | `running` on list rows | also `running` | activation seeds sessions already running, so a reload does not lose the current turn |

## Upstream shape

To land this in the deepseek-harness repository, the code moves to `packages/client/ui-notify/` as `@deepseek-ai/dsh-client-ui-notify`:

1. Replace `tsdown.config.mjs` with the shared preset: `clientBundle('@deepseek-ai/dsh-client-ui-notify', ['lib/types/index.js'])`.
2. Replace the local service views in `src/client/types.ts` with the real types (`import type {} from '@deepseek-ai/dsh-api-session-controller/client'`, `…/dsh-client-ui-session/client`, `…/dsh-client-locale/client`).
3. Register in three places: the `tsconfig.client.json` aggregate, a `disabled: true` row in `packages/bundle/web-app/cordis.patch.yml`, and a dependency in `packages/bundle/web-app/package.json`.
4. Convert the tunables to a settings namespace and an Agent Note describing the trigger rules.
