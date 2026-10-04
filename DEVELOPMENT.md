# dsh-window-state 开发过程记录（开发日志）

> 本文记录一次完整的 DSH 插件开发：从需求、逆向调研、方案决策、实现、验证到踩坑与后续风险。
> 目标读者是未来的维护者（或另一个 AI 会话），使其无需重新逆向 `app.asar` 即可继续工作。

- **需求提出**：希望 DSH 桌面窗口「每次启动最大化还是最小化」可在 **设置 → 通用设置** 中配置。
- **最终交付**：插件 `dsh-window-state`，在通用设置里新增一行「启动窗口状态」，支持 **默认 / 最大化 / 全屏**（Windows）。
- **状态**：已安装到 `desktop` profile，用户重启客户端后实测确认生效。

---

## 一、需求与范围演进

| 阶段 | 需求 | 变化原因 |
|------|------|----------|
| 初始 | 启动时最大化 **或** 最小化，可在通用设置配置 | 用户原始诉求 |
| 收敛 | 改为 **最大化 / 全屏 / 默认**（去掉最小化） | 排查后发现「最小化启动」在体验上无意义（窗口启动即最小化到任务栏），用户确认只需这三种 |

**最终范围**：`default`（记住上次，即 Electron 默认行为）、`maximized`、`fullscreen`。

---

## 二、关键调研：为什么普通插件做不到（决定性结论）

这是整个项目的分水岭。结论：**DSH 插件（Host=Node / Client=渲染进程）无法触达 Electron 主进程的 `BrowserWindow`**。

### 2.1 调研手段

`app.asar` 是打包格式（头部在字节偏移 16 处，headerSize 3392056 / jsonSize 3392052），环境里没有 `@electron/asar` 模块，因此用 Node 脚本直接读 121MB 二进制、按字节偏移抽取源码片段来逆向。

顶层结构：`dsh`（含 `desktop-runtime.json`）、`node_modules`、`lib`（`main.js`、`preload-*.cjs`）、`renderer`。

### 2.2 证据链

1. **窗口创建**：`main.js`（偏移 116972220，大小 490169 字节）中 `createWindow(preload, show=false, primary=false)` 创建
   `new BrowserWindow({ width:1280, height:820, minWidth:520, minHeight:600, show, ...webPreferences:{preload, nodeIntegration:false, contextIsolation:true, sandbox:true, webSecurity:true} })`。
   `createMainWindow()` 调 `createWindow(appPreload, false, true)`，窗口以 `show:false` 创建，之后 `enterWorkspace()` → `window.show()`。
   **启动过程没有任何 `maximize()` / `minimize()` 调用**，窗口按 Electron 自动记忆的 bounds 打开。

2. **唯一相关的 IPC 是单向的**：`DESKTOP_IPC.windowFullscreen = "dsh-desktop:window-fullscreen"`。
   主进程在 `enter-full-screen` / `leave-full-screen` / `did-finish-load` 时 `webContents.send(...isFullScreen())`；
   渲染进程侧 `syncWindowFullscreen` 只把结果写成 `document.documentElement.dataset.fullscreen="true"`（供 CSS 用）。
   **它不接受渲染进程「请进入全屏」的请求**。

3. **没有任何全屏入口**：整个 `main.js` 里 `fullscreen` / `maximize` / `minimize` / `setFullScreen` / `F11` / `kiosk` 零命中（唯一的 `setFullScreen(false)` 在 `hideMainWindow()` 里，隐藏窗口前先退出全屏）。
   没有菜单项、没有 accelerator、没有 F11 处理。**即 DSH 自带界面本身都没有「全屏」功能。**

4. **服务目录无窗口能力**：`listService` 里没有任何 window / desktop / BrowserWindow 相关服务。

5. **排除同名干扰**：`requestFullscreen` / `exitFullscreen` / `fullscreenchange` 出现的位置是（a）第三方 dock-panel 布局库的 `toggleFullscreen(target)`（面板级，不是 OS 窗口）；（b）内嵌 Emscripten `Browser` 模块（WebGL/WASM 运行时）。均与 OS 窗口无关。

### 2.3 为什么插件运行时够不到

Electron 主进程在 DSH Host（Node）与 Client（渲染进程）插件运行时**之前**启动。插件只能跑在 Host / Client 两侧，而窗口归主进程所有，两侧既无 IPC 通道也无服务句柄。

**推论**：任何真正的实现都必须走「越界」机制。

---

## 三、方案对比与决策

| 方案 | 原理 | 评价 |
|------|------|------|
| **A. Win32 外部 helper** | 子进程用 `user32.dll` 定位 HWND 并施加窗口状态 | ✅ **已选**：不改动受保护程序文件，可随插件独立升级 |
| B. 修改 `app.asar` | 在 `createMainWindow` 后补 `window.maximize()` | ❌ 每次 DSH 升级被覆盖，且改动受保护文件 |
| C. 只做配置 UI | 仅持久化配置，不实现效果 | ❌ 半成品，UI 与行为脱节 |

**用户明确选择方案 A**，并确认要支持的窗口状态为：最大化、全屏、默认（记住上次）。

---

## 四、插件实现

### 4.1 包结构

```
R:\Dsh\dbaWorkspace\dsh-window-state\
├── package.json        包清单（dsh.client.inject / dsh.bundle.patch / dsh.engines.dsh）
├── cordis.patch.yml    挂载补丁：- insert: [{ id: dsh-window-state, name: dsh-window-state }]
├── lib/index.js        Host 半
├── lib/client.js       Client 半
├── README.md
└── LICENSE
```

`package.json` 要点：`"type":"module"`、`main:./lib/index.js`、`exports` 暴露 `.` 与 `./client`、`dsh.bundle.patch:./cordis.patch.yml`、
`dsh.client = { inject:["@deepseek-ai/dsh-client-ui-slots","@deepseek-ai/dsh-client-ui-settings"], platform:"web" }`、`dsh.engines.dsh: ">=0.2.0-rc.1"`。

### 4.2 Host 半（`lib/index.js`）

- 导出 `name = 'dsh-window-state'`、`apply(ctx)`。
- `applyState(state)` 生成一段自包含的 PowerShell `Add-Type` 脚本并以
  `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <script>` 执行（8s 超时，状态经环境变量 `DSH_WINDOW_STATE` 传入，避免引号转义陷阱）：
  1. `EnumWindows` 遍历 → 类名 `Chrome_WidgetWin_1` + `IsWindowVisible` + 标题 `-match 'DeepSeek Harness'` 定位主窗口；
  2. **最大化**：`ShowWindowAsync(hwnd, SW_RESTORE=9)` → `SW_MAXIMIZE=3`，用 `IsZoomed` 校验；
  3. **全屏**：`GetWindowLongPtr(GWL_STYLE=-16)` 去掉 `WS_CAPTION(0x00C00000) | WS_THICKFRAME(0x00040000)`，
     `SetWindowLongPtr` 写回 + `SetWindowPos(0,0,SM_CXSCREEN,SM_CYSCREEN, SWP_FRAMECHANGED|SWP_NOZORDER)`；
  4. **默认**：恢复边框样式 + `SW_RESTORE`。
  结果从 stdout 的 JSON 行解析为 `{ ok, hwnd, error }`。
- **两条生效路径**：
  1. `ctx.on('webserver/index-inject', table => table.push({ kind:'script', placement:'head', text: readStateScript() }))`
     —— 注入一段同步 IIFE，读取 `localStorage['dsh-window-state:startup']` 并 `fetch('/dsh-window-state/apply')`，在**启动最早时刻**应用；
  2. `ctx.inject(['webServer'], wc => wc.effect(() => wc.webServer.register({ kind:'exact', path:'/dsh-window-state/apply', handler: applyHandler })))`
     —— 用户改设置时**立即**应用。
- 常量：`STATE_KEY='dsh-window-state:startup'`、`STATE_VALUES=['default','maximized','fullscreen']`。

`IndexInjection` 类型已通过 Service provider 核对，`{ kind:'script', placement:'head', text }` 是合法行形。

### 4.3 Client 半（`lib/client.js`）

- 用 `window.__ModuleLoader__.load({ id:'dsh-window-state', factory:(require)=>{...} })` 包裹；`const React = require('react')`；
  导出 `{ name, inject:['slots'], apply }`。
- 挂载点：
  `ctx.slots.inject('settings.general.item', () => ctx.slots.register({ name:'settings.general.item', id:'dsh-window-state', order:25 }, SettingsRow))`
  —— **槽名字面量必须内联**：注入器的静态预检读源码，无法跟随常量。
- `SettingsRow` 用 `React.createElement`（无 JSX）构建「启动窗口状态」行：标题 + 说明 + 分段控件（默认 / 最大化 / 全屏）+ 结果提示。
  样式用 DSH 主题 token（`--dsw-alias-label-primary`、`--dsw-alias-border-l2`、`--dsw-alias-brand-primary` 等），类前缀 `dshws-`，
  经 `<style>` 注入 `document.head`；布局刻意对齐 `dsh-550c-boot` 的行样式，使新行与其视觉一致。
- 持久化：`localStorage`；改动后 `POST /dsh-window-state/apply` 立即应用并显示结果（`default` 无需应用）。

### 4.4 为什么用 localStorage 而不是 settings + schemastery

平台确实有 `settings` 服务（`@deepseek-ai/dsh-settings`，方法 `configure/describe/update/replace/mutate`）可把插件 Config 的 JSON Schema 自动投影成设置表单。但：

- 通用设置页是 `ui-settings-general` 的**固定 React UI**，不是 schema 驱动（其 Config 只有 `welcomeNoticeVersion`），所以走 schema 路线并不能自动出现在通用设置里；
- 且 schemastery 必须用 DSH 的构建 `@deepseek-ai/schemastery`（它把 `.volatile()` 字段包装成 cosmokit Volatile ref 才能被 loader 持久化），用公开的 `schemastery` 包会**静默丢写**。

参照已装插件 `dsh-550c-boot` 的同类做法，本插件直接自绘行 + 用 `localStorage`，更简单且无隐性依赖。代价：配置不进 DSH 的设置文档/同步，只在本机浏览器存储里。

---

## 五、验证记录

### 5.1 离线/静态验证（全部通过）

- `lib/index.js`、`lib/client.js` 均通过 `node --check`。
- 槽位核对（`cordis_inspect_query` → `Slots.listSubTree`）：`settings.general.item` 出现占位者
  `dsh-window-state`，`order: 25`（介于 `composer-enter=20` 与 `boot-550c=26` 之间）、`active: true`。
- 配置条目核对（`Config.listConfigs`）：出现 `include:dsh-window-state`（`status: "absent"`，因为它不走 schema 路线，符合预期），
  `packageDir` 指向 profile 的 `node_modules\dsh-window-state`。
- 安装核对：`plugin_manager install_bundle` 成功；profile 里生成了 **Junction** `C:\Users\MSI-Z390\.dsh\profiles\desktop\node_modules\dsh-window-state` → `R:\Dsh\dbaWorkspace\dsh-window-state`；
  `dsh-window-state` 被追加进 `C:\Users\MSI-Z390\.dsh\profiles\desktop\package.json` 的 `dsh.profile.bundles` 列表。
  （注意：bundle 的 `insert` 走**bundle 层**，因此用户 patch 层 `cordis.patch.yml` 里查不到它——这是预期行为。）

### 5.2 Win32 操作实测（全部通过）

用真实 PowerShell 直接调用目标窗口验证：

- `ShowWindowAsync` 最大化 / 还原 / 最小化均生效；
- 全屏（剥离样式 + 调整到 1920×1080）生效且可恢复。

窗口定位实测：DSH 主窗口 = **pid 8004 / hwnd 1639884 / class `Chrome_WidgetWin_1` / 标题 "… — DeepSeek Harness"**。
**重要**：`dsh-pet` 桌宠是**另一个** `Chrome_WidgetWin_1` 窗口（标题 "dsh-pet 桌宠"），所以必须用标题匹配消歧，不能只按类名取第一个。

### 5.3 端到端验证

- **插件是在桌面应用当前进程启动之后安装的**，因此 Host 半（index-inject + apply 路由）在当次进程里不生效；
- 用户**重启 DSH 桌面客户端**后实测：**插件效果实现，确认生效** ✅

---

## 六、踩坑与经验

1. **不要按 pid 找主窗口**：Host Node 进程与 Electron 主进程 pid 不同（实测 host pid 2600、窗口 pid 8004），必须按窗口类 + 标题定位。
2. **`Chrome_WidgetWin_1` 不是唯一**：`dsh-pet` 桌宠用同类名，必须加标题匹配消歧。
3. **槽名字面量必须内联**：`ctx.slots.register({ name: 'settings.general.item', ... })` 中的槽名不能写成常量引用，静态预检跟不上。
4. **HWND 不稳定**：每次应用都要**重新枚举**定位，不能缓存句柄跨进程生命周期使用。
5. **状态经环境变量传参**：PowerShell 里内插字符串跨越 `-Command` 时引号极易出错，用 `DSH_WINDOW_STATE` 环境变量最稳。
6. **插件安装需重启客户端**：profile 插件图在进程启动时构建，装完必须重启桌面客户端才能生效；不要误判为「插件坏了」。
7. **`127.0.0.1:19387` 是 DSH 自己的 Web GUI**，需要 dsh web token 才能访问（桌面的 7690/7691/9538/19387 均 401），
   因此**不能**用它来验证桌面窗口行为；桌面应用的原生窗口才是用户看到的界面。
8. **`schemastery` 陷阱**：若将来改走 settings 服务，必须 `import z from '@deepseek-ai/schemastery'`，公开包会静默丢写 `.volatile()` 字段。

---

## 七、局限与后续风险

- **仅 Windows**：依赖 `powershell.exe` + `user32.dll`（均为系统自带）。
- **「伪全屏」**：通过剥离窗口边框 + 铺满显示器实现，视觉等价于 `BrowserWindow.setFullScreen(true)`，但不是 Chromium 的 HTML Fullscreen API 状态，因此不触发 `enter-full-screen` 事件、`data-fullscreen` 不会置位。
- **对 DSH 升级的鲁棒性**：Win32 层面不依赖 DSH 内部实现（只依赖窗口类名与标题），因此升级相对安全；但若 DSH 未来改了窗口标题或窗口类，标题匹配会失败——失败时脚本返回 `window-not-found`，设置行会提示「未能立即应用」并保留配置，不会崩溃。
- **`localStorage` 的边界**：配置随浏览器存储（按 profile 的 origin）走，不参与 DSH 设置文档同步；清空站点数据会丢失该偏好（回落到 `default`）。
- **社区插件规范尚未遵循的部分**：未提供 `dshWorkshop` 市场元数据；未走 settings 服务（见 4.4 的取舍）。

---

## 八、复现/维护速查

```powershell
# 安装（开发态：装到 desktop profile）
#   在 DSH 里用插件管理安装 R:\Dsh\dbaWorkspace\dsh-window-state
# 或 CLI：
#   dsh plugin install R:\Dsh\dbaWorkspace\dsh-window-state

# 语法检查
node --check R:\Dsh\dbaWorkspace\dsh-window-state\lib\index.js
node --check R:\Dsh\dbaWorkspace\dsh-window-state\lib\client.js

# 手工验证 Win32 定位（应打印出主窗口 hwnd）
#   类 Chrome_WidgetWin_1 + 标题含 DeepSeek Harness + IsWindowVisible

# 改完代码后：重启 DSH 桌面客户端才生效
```

关键路径：

- 插件源码：`R:\Dsh\dbaWorkspace\dsh-window-state\`
- profile 链接：`C:\Users\MSI-Z390\.dsh\profiles\desktop\node_modules\dsh-window-state`（Junction）
- profile 清单：`C:\Users\MSI-Z390\.dsh\profiles\desktop\package.json`（`dsh.profile.bundles`）
- 桌面程序：`R:\Program Files\DeepSeek Harness\resources\app.asar`（`lib/main.js`、`lib/preload-*.cjs`）
