# dsh-notify

给 DeepSeek Harness 加上**真正的操作系统通知**：Windows 通知中心 toast、macOS 通知中心横幅，或 Linux 通知守护进程的消息；在 DSH 需要你回到窗口时提醒你。

## 什么时候会通知

| 时刻 | 来源 |
|---|---|
| 一轮任务完成 | `api-session/status` 远程事件，`running` 由 true 变 false |
| 本轮运行失败 | `api-session/error` 远程事件 |
| 后台作业结束 | 客户端会话列表上的 `jobsBySession` 镜像 |
| Agent 在等你确认 | `uiSession.pendingInteractions`（审批、提问、计划评审） |

点击通知会把窗口切到前台，并打开该通知所属的会话。

## 安装

### 方式一：预构建包（推荐，无需构建授权）

从 [Releases](https://github.com/Zhiyi-Zhao/dsh-notify/releases) 下载 `dsh-notify-0.1.0.tgz`：

```sh
dsh plugin --profile desktop add ./dsh-notify-0.1.0.tgz
```

构建产物已打进包里，安装时不跑任何构建脚本（已在隔离 profile 上实测）。

### 方式二：直接从 GitHub 安装

```sh
dsh plugin --profile desktop add github:Zhiyi-Zhao/dsh-notify
```

`lib/` 构建产物随仓库一起提交，因此不需要本地工具链。不过 pnpm 对 git 依赖可能仍要求显式允许其构建脚本；若命令提示需要授权，把它打印的键加进该 profile 的 `pnpm-workspace.yaml` 后重试：

```yaml
allowBuilds:
  dsh-notify: true
```

### 方式三：本地目录（开发时）

```sh
dsh plugin --profile <profile> add /绝对路径/dsh-notify
```

该包同时声明 `dsh.bundle` 层（负责挂载插件行）与 `dsh.client` 浏览器半。装进 **desktop** profile 后需要**重启 DeepSeek Harness 应用**：profile 组合在启动时读取，而 desktop profile 由 Electron 壳独占，CLI 无法替你热加载。

安装后的第一次加载会发一条自检通知，这样不必等长任务就能确认通道可用。

卸载：

```sh
dsh plugin --profile desktop remove dsh-notify
```

## 噪音控制

默认只在你真的需要被打扰时通知：窗口在前台且可见时完全静默；短于 10 秒的轮次不发通知；同一个停下来的 agent 只产生一条通知——等待确认或报错会顶替同一轮的"已完成"。

运行时开关从 `localStorage['dsh-notify.options']` 读取（JSON）。客户端半**不会**收到它在 `cordis.yml` 里的配置（Web 启动内核用 `loader.create({ name })` 创建每个 entry），所以这个 key 就是本独立插件的配置通道：

```js
localStorage.setItem('dsh-notify.options', JSON.stringify({ onlyWhenUnfocused: false, minRunMs: 0 }))
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `onlyWhenUnfocused` | `true` | 窗口在前台且可见时保持静默 |
| `minRunMs` | `10000` | 短于此值的轮次不通知 |
| `silent` | `false` | 不发声音，只进通知中心 |
| `selfTest` | `true` | 首次安装时发一条自检通知 |
| `replaceTurnEndMs` | `2000` | 轮次结束通知为"更好的通知"让路而等待的时长 |

自检标志位是 `localStorage['dsh-notify.selfTestShown']`。

## 工作原理

插件只有浏览器半；宿主半的作用是让 profile 行能挂载这个包。所有通知都由页面通过 Web Notification API 发出——这既让它同时适用于桌面壳和普通浏览器窗口，也让它不需要程序包标识符，更不需要 PowerShell 辅助进程。

桌面壳对主窗口除 `media` 外的权限请求一律放行，因此 toast 不会弹授权框。普通浏览器窗口需要一次用户手势才允许申请权限：插件在第一次指针或键盘事件时申请，未授权前保持静默。环境没有 Web Notification API、或权限被拒绝时，插件记录一条警告并自行停用。

## 投递与排查

第一条通知同时会把应用注册进 **设置 → 系统 → 通知**（Windows 里显示为 *DeepSeek Harness*）——那个开关就是"横幅有没有被允许"的检查点，而通知中心（Win+N）里能看到被抑制或错过的横幅。

窗口在前台且可见时插件保持静默，这是默认行为（`onlyWhenUnfocused`），不是故障：想确认通道本身是否工作，就切到别的窗口再让一轮任务结束。排查顺序建议：通知设置里的开关 → 通知中心历史 → `%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db`（系统侧是否真的收到）。

**绝不要传 `tag`。** 这台机器上实测：带 `tag` 的 `new Notification()` 会被浏览器接受，但 toast **永远不会进 Windows**；同一调用去掉 `tag` 则 100% 送达（自检、探针与真实通知都验证过）。代价是同一会话的多次通知不再互相替换，而是各自堆叠。

## 已知限制与待办

- **没有 `cordis.yml` 选项。** 客户端 entry 不接收配置，因此本插件从 `localStorage` 读开关。上游版本应改为宿主侧提供 settings 命名空间加设置卡片。
- **运行中途重载已尽量覆盖。** 插件激活时会把列表中 `running` 的会话补种为"进行中"，因此重载后该轮结束仍会通知；若客户端不把运行状态投影进列表，则无法补种，那一轮会漏掉。
- **不做同会话替换。** 为能真正投递而不传 `tag`（见上），因此重复通知会堆叠而非替换。
- **按客户端各自投递。** 同时开着的两个客户端（桌面窗口 + 浏览器标签页）会各发一次；跨客户端去重目前没有归属方。
- **仅限 Web GUI。** 插件注入的是客户端服务（`remote`、`sessions`、`locale`，外加可选的 `uiSession`）；headless 与 ACP 运行没有浏览器半，不会收到通知。
- **重跑的作业可能重复通知。** 作业行从镜像里消失、之后带着同样的 id 与状态回来时，只按身份去重，不按时间去重。

## 激活安全

客户端 entry 一旦抛错就会让 Web boot 审计失败，而桌面壳把审计失败当作致命错误：应用起不来，随后它的崩溃恢复会重写 profile。下面两个错误都曾在真实 profile 上造成过这个后果，所以现在它们是实现的硬规则：

- **服务只在 apply 时解析一次。** `ctx.<service>` 是按当前运行的 fiber 解析的，因此在本插件 fiber 之外运行的回调（store 通知、通知点击、延后计时器）必须使用捕获下来的值。在那里走 `ctx` 会抛 `cannot get required service "sessions" in inactive context`。
- **把发布出来的状态当作可能不完整。** 会话列表 store 会发布没有 `jobsBySession` 的状态；假设该成员一定存在的规则会抛 `Cannot convert undefined or null to object` 并使激活失败。

此外 `apply` 把整段激活都兜住了：任何意外错误只记一行日志并把通知关掉，不会走到 boot 审计。任何改动都请对着**独立 profile** 验证，绝不要对着你正在使用的那一个 —— `dsh --profile <scratch>` 配合它自己的 `DSH_HOME` 能复现真实启动，而底层异常出现在浏览器控制台里。

## 客户端版本兼容

插件用到的三个客户端成员在 DSH 不同版本上形状不同，代码对两种都做了兼容（在本机 0.2.0-rc.2 桌面版上实测）：

| 信号 | 当前版本 | 较早版本（本机实测） | 本插件的处理 |
|---|---|---|---|
| 待确认（审批/提问） | `uiSession.pendingInteractions`（可订阅） | 只有 `uiSession.pendingSnapshot`，且该字段**每次变更被整体替换**（`this.pendingSnapshot = projected`） | 有可订阅面就订阅；否则按 1 Hz 轮询，并**每次重新读取该字段**——缓存 Map 对象会让轮询永远读到最初那个空 Map |
| 后台作业终态 | 列表状态里的 `jobsBySession` | 列表状态只有 `ids/byId/phase/projectionsBySession` | 缺失即视为空；**较早版本上作业通知不生效** |
| 点击回会话 | `sessions.open(id)` | 无此方法 | 存在才调用；否则只把窗口切到前台 |
| 运行状态 | 列表行含 `running` | 同样含 `running` | 激活时按 `running` 补种"进行中"的会话，使重载不丢当前轮 |

## 上游化形态

要把它落进 deepseek-harness 仓库，代码迁到 `packages/client/ui-notify/`，包名 `@deepseek-ai/dsh-client-ui-notify`：

1. 用共享预设替换 `tsdown.config.mjs`：`clientBundle('@deepseek-ai/dsh-client-ui-notify', ['lib/types/index.js'])`。
2. 把 `src/client/types.ts` 里的本地服务视图换成真实类型（`import type {} from '@deepseek-ai/dsh-api-session-controller/client'`、`…/dsh-client-ui-session/client`、`…/dsh-client-locale/client`）。
3. 在三处注册：`tsconfig.client.json` 聚合、`packages/bundle/web-app/cordis.patch.yml` 里一行 `disabled: true`、以及 `packages/bundle/web-app/package.json` 依赖。
4. 把开关改成 settings 命名空间，并补一份描述触发规则的 Agent Note。
