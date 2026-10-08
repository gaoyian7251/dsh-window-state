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

---

## 九、发布记录

### 9.1 GitHub（已完成）

- 仓库：<https://github.com/gaoyian7251/dsh-window-state> —— **公开**，默认分支 `main`
- 提交：
  - `95c15f4` `feat: dsh-window-state 0.1.0`（8 个文件：`.gitignore`、`DEVELOPMENT.md`、`LICENSE`、`README.md`、`cordis.patch.yml`、`lib/client.js`、`lib/index.js`、`package.json`）
  - `86c068d` `chore: 补充 repository / homepage / bugs / author 元数据`
  - `513767d` `docs: README 改为 GitHub 安装方式，补充使用说明`
- 仓库话题：`dsh`、`dsh-plugin`、`deepseek-harness`、`cordis`、`windows`、`maximize`、`fullscreen`
- 安装方式（已写进 README）：

  ```powershell
  dsh plugin install github:gaoyian7251/dsh-window-state
  ```

  或在 DSH「设置 → 插件 → 安装」里填 `github:gaoyian7251/dsh-window-state`；**必须重启桌面客户端**才会加载。

### 9.2 npm（已放弃）

- 包名 `dsh-window-state` **未被占用**（`npm view dsh-window-state` 返回 `E404`），`package.json` 的 `files` 白名单与 `repository`/`homepage`/`bugs`/`author` 均已就绪，包体也能正常打包（7 文件 / 16.3 kB，`shasum 1df38a45adba2de1365879bf3135962ecab2bffe`）。
- **但发布在机制上走不通**：该账号（`tfa.mode = auth-and-writes`）的 2FA 只支持**安全密钥 / WebAuthn**（Windows Hello、Touch ID、YubiKey），既没有验证器 App 的动态码，也不会发邮件验证码；非交互终端无法完成验证，`npm publish` 一律返回 403 且不给出任何授权 URL。详见 §9.4。
- **用户决定放弃 npm 发布**（原话：`算了，我放弃，不往npm上发了`、`这个插件暂时就开发到这`）。分发方式只保留 GitHub 安装：`dsh plugin install github:gaoyian7251/dsh-window-state`。

### 9.3 本次新增的操作经验

- **非 TTY 下 `git push` 会静默挂起**：不报错、无输出，卡在凭证交互上（实测 >2 分钟）。加 `$env:GIT_TERMINAL_PROMPT = "0"` 后立刻成功。
- **gh 的 git 凭证助手**由 `gh auth setup-git` 写入 `credential.https://github.com.helper`（值为 `!'C:\Program Files\GitHub CLI\gh.exe' auth git-credential`）。
- **`gh auth login` 在非 TTY 下**可用 `Set-Content $env:TEMP\e.txt -Value ""; Get-Content $env:TEMP\e.txt | & gh auth login --hostname github.com --git-protocol https --web` 越过 "Press Enter" 提示；设备码页面仍需人工在浏览器完成授权。
- **`gh` 不在 DSH 进程的 PATH 内**（winget 装到 `C:\Program Files\GitHub CLI\gh.exe`），脚本里必须用全路径。

### 9.4 npm 发布踩坑（机制性限制，非配置问题）

**1. npm 的 2FA 没有“验证码”**

- 唯一因子是**安全密钥 / WebAuthn**（官方文档 `about-two-factor-authentication.mdx`：*"You will be prompted to authenticate with a security-key… Apple Touch ID, Face ID or Windows Hello… as well as physical keys such as Yubikey"*），**不存在验证器 App 的 6 位动态码**。
- **邮件 OTP 只在账号未启用 2FA 时用于登录验证**（`receiving-a-one-time-password-over-email.mdx`，邮件主题 *"OTP for logging in to your account"*）。开 2FA 的账号发布时**永远收不到邮件码** → `npm publish --otp=<code>` 不可能成功。

**2. 非交互终端无法完成 WebAuthn**

- `npm publish` / `npm publish --auth-type=web`（npm 11.19 的 auth-type 默认就是 `web`）/ `npm publish --json` 一律返回：
  `npm error code E403 / 403 Forbidden - PUT https://registry.npmjs.org/dsh-window-state - Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.`
  **不打印任何授权 URL**，也没有第三方工具（keybridge）所述的 `EOTP + authUrl/doneUrl`。
- 官方唯一可行路径（`configuring-two-factor-authentication.mdx`）：*"If you have enabled 2FA auth-and-writes, authentication will be handled automatically when using security-keys… you will be prompted to authenticate with your configured 2FA method."* → 必须**真人在交互式终端**执行 `npm publish`。

**3. GAT 三处配错，症状被 403/404 掩盖**

`GET https://registry.npmjs.org/-/npm/v1/tokens`（用网页登录 token 裸读）显示 `cidr: ["0.0.0.0/24"]`、`bypass_2fa: false`、`scopes: [@gaoyian, @gaoyian7251]`：

- `scopes` 不含无 scope 的新包名 → npm 用 **404 Not Found** 掩盖“无权限创建新包”；
- `bypass_2fa: false` → 仍需 2FA；
- IP 白名单 `0.0.0.0/24` 等于全封 → 连 `GET /-/whoami` 都是 **403 + 空 body**。

正确建法：**Bypass 2FA 开 + Packages and scopes 选 All packages + IP 白名单留空**（npm 已宣布 bypass-2FA token 约 2027-01 起失去直接发布权，属过渡方案）。

**4. 网页登录 ≠ CLI 有凭证**

在 npmjs.com 登录后 `npm whoami` 仍报 `ENEEDAUTH / need auth`，`C:\Users\MSI-Z390\.npmrc` 不存在；必须跑一次 `npm login --auth-type=web` 才会写入 `//registry.npmjs.org/:_authToken=npm_…`（约 12 小时有效，过期后 `npm publish` 报 E401）。

**5. 可复用技法：非 TTY 下驱动 npm 的 web 登录**

- ✅ .NET `System.Diagnostics.ProcessStartInfo` 起 `cmd.exe /c npm login --auth-type=web`，`RedirectStandardInput/Output/Error = $true`、`UseShellExecute = $false`、UTF8；启动约 2 秒后写一个空行满足 "Press ENTER to open in the browser"，再用 `$t = $p.StandardOutput.ReadLineAsync(); $t.Wait(250)` 轮询读输出判 EOF；然后 `Start-Process <URL>` 打开浏览器，用户授权后日志出现 `Logged in on https://registry.npmjs.org/.`。
- ❌ 管道喂空行（`while($true){Start-Sleep 1; ""} | npm login`）→ npm 完全无输出；
- ❌ `add_OutputDataReceived(scriptblock)` → `PSInvalidOperationException: 此线程中没有可用于运行脚本的运行空间`（事件回调需要 runspace）；
- ❌ 非交互下 `npm login --auth-type=web` 打印 URL 后卡在 `Username:` 并退出 1。

**6. 资料获取技法**

`docs.npmjs.com` 是 JS 渲染，`web_fetch` 只拿到导航外壳；应改读源码仓库 `npm/documentation` 的 raw mdx：`https://raw.githubusercontent.com/npm/documentation/main/content/getting-started/setting-up-your-npm-user-account/<file>.mdx`（列目录用 `https://api.github.com/repos/npm/documentation/contents/content/...`）。

**7. 将来若要发布**

- **A（推荐）**：真人在交互式 PowerShell 执行 `cd R:\Dsh\dbaWorkspace\dsh-window-state` 后 `npm publish`，按提示用 Windows Hello 完成验证。
- **B**：把账号 2FA 从 `auth-and-writes` 改为 `auth-only`（`npm profile enable-2fa auth-only`），此后仅凭 session token 即可发布、无需任何手势；代价是写操作不再强制第二因子。
- **C**：按第 3 条重建正确的 GAT（过渡方案）。
- 长期最优：首次人工发布后配置 **Trusted Publishing（GitHub Actions OIDC）**，此后发版无需 token 与验证码。

### 9.5 安装/卸载踩坑：本地路径安装残留 Junction → 重装 `ERR_PNPM_EPERM`

**症状**：先用**本地路径**安装（pnpm 记为 `link:`），之后卸载再改从 git 安装时失败：

```
[ERR_PNPM_EPERM] [importPackage C:\Users\MSI-Z390\.dsh\profiles\desktop\node_modules\dsh-window-state]
EPERM: operation not permitted, rename '...\dsh-window-state_tmp_8996_4' -> '...\dsh-window-state'
```

**根因**：`link:` 安装会在 `node_modules` 下建立 **Junction**；`pnpm` 卸载只删掉 `package.json`/lockfile 里的依赖记录（日志写 `Already up to date`），**不会删除磁盘上的 Junction**。随后安装新版时 pnpm 以 `rename(tmp → dsh-window-state)` 落位，而 Windows 不允许把目录改名覆盖到已存在的 Junction 上 → `EPERM`。

**证据（`.plugin-manager\logs`）**：

| 日志 | 内容 |
| --- | --- |
| `operation-Uzpxgx` | `+ dsh-window-state link:R:/Dsh/dbaWorkspace/dsh-window-state`（建立 Junction） |
| `operation-tNLrVE` | `- dsh-window-state link:…` + `Already up to date`，卸载成功但**留下 Junction** |
| `operation-aSZiYA` | `[ERR_PNPM_EPERM] … rename dsh-window-state_tmp_8996_4` |
| `operation-EDNWvT` | `dsh-pet` 同样报 `[ERR_PNPM_EPERM]`（残留 `dsh-pet_tmp_*`），说明与具体插件无关 |

**修复**（已在本机执行并验证）：

```powershell
# 只删链接，不动目标目录。不要用 Remove-Item -Recurse —— 它会跟着删目标内容
cmd /c rmdir "C:\Users\MSI-Z390\.dsh\profiles\desktop\node_modules\dsh-window-state"
# 并清掉同批产生的 *_tmp_* 残留目录
```

清理后 `dsh plugin install github:gaoyian7251/dsh-window-state` 一次成功。git 安装的是**真实目录**（`LinkType` 为空），此后卸载/升级都能被 pnpm 正常替换。

**⚠️ 真实事故（本机，2026-10-05）**：清理 Junction 之前，有人对 `node_modules\dsh-window-state` 用了 PowerShell `Remove-Item -Recurse -Force`。因为它是 Junction，删除**穿透到了源码仓库** `R:\Dsh\dbaWorkspace\dsh-window-state`：`.git` 在字母序最前，`HEAD`/`config`/`index`/`logs`/`hooks`/`info` 被逐个删掉，删到 `objects` 时中断 —— 于是 Junction 本身和其余源码文件都还在，只有 `.git` 被掏空。表现是：

```
git -C R:\Dsh\dbaWorkspace\dsh-window-state status
fatal: not a git repository (or any of the parent directories): .git
# 而 .git 目录确实存在，里面只剩 objects（47 项）与 refs（7 项）
```

源码仓库未受损（工作区文件完好，`lib/`、`package.json`、`cordis.patch.yml`、`LICENSE` 与 git 安装快照逐字节一致），且远端有全部提交，按下面的方式原地恢复即可（**不会删除任何工作区文件**）：

```powershell
$env:GIT_TERMINAL_PROMPT = "0"                          # 非 TTY 下必须，否则 git 会静默挂起
cd R:\Dsh\dbaWorkspace\dsh-window-state
git init -b main                                        # 重建 HEAD/config/hooks/info，复用残留的 objects
git remote add origin https://github.com/gaoyian7251/dsh-window-state.git
git fetch origin
git reset --mixed origin/main                           # 索引对齐远端 HEAD，本地未提交改动全部保留
git status --porcelain                                  # 应只剩你自己的未提交改动
```

**铁律**：对 Junction **永远不要用 `Remove-Item -Recurse`** —— Node 的 `fs.rm` 不穿透链接，PowerShell 的 `Remove-Item -Recurse` 会穿透；删链接只认 `cmd /c rmdir`。

**验证（完整往返）**：卸载 → `node_modules` 无残留、`package.json` 的依赖与 `dsh.profile.bundles` 条目均被移除；再安装 → 目录/依赖/bundle 三处齐备（`dsh-window-state = github:gaoyian7251/dsh-window-state`），`node --check` 对 `lib/index.js`、`lib/client.js` 均通过。

**结论**：优先用 `github:gaoyian7251/dsh-window-state` 安装；只有本地开发才用路径安装，且每次重装前先 `cmd /c rmdir` 掉 Junction。

## 十、换机失效事故：系统 PATH 缺 `WindowsPowerShell\v1.0`（2026-10-08）

### 10.1 症状

换到新电脑（新机用户目录 `C:\Users\Ds`；旧机是 `C:\Users\MSI-Z390`）后插件「不好使」：设置行还在、也能选「最大化 / 全屏」，但点下去提示「未能立即应用（spawn powershell.exe ENOENT）」，开机注入脚本的 `fetch` 也静默失败。

两个半其实都**加载正常**：Host 侧 `plugin_manager` 显示 `fiberPhase: "active"`，Client 侧 `settings.general.item` 的 occupants 里有 `{ registrant: "dsh-window-state", id: "dsh-window-state", order: 25, active: true }`；插件目录与仓库 HEAD 逐字节一致，安装日志（`.plugin-manager/logs/operation-e5SzKu/pnpm.log`）也是一次成功。所以问题不在加载、不在安装。

### 10.2 根因

`lib/index.js` 用**裸名** spawn：`spawn('powershell.exe', ['-NoProfile', …])`。

`powershell.exe` 并**不**在 `%SystemRoot%\System32` 根目录，而在 `%SystemRoot%\System32\WindowsPowerShell\v1.0` 子目录。Windows 的 `CreateProcess` / `SearchPathW` 搜索顺序是「父进程目录 → 当前目录 → System32 → Windows 目录 → PATH」，且**不查 `App Paths` 注册表**（那只对 `ShellExecute` 生效）。所以该子目录一旦不在 PATH 里，Node 必然 `ENOENT`，插件所有窗口操作全部落空。

新机的 PATH 被整段重置过（Oracle 客户端、Kingbase、maven、PostgreSQL、Git、gradle、cygwin…… 一长串应用目录），丢掉了 Windows 默认项：

| 位置 | 缺失项 |
| --- | --- |
| `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment` → `Path` | `%SystemRoot%\System32\WindowsPowerShell\v1.0`、`%SystemRoot%`、`%SystemRoot%\System32\Wbem` |
| `HKCU\Environment` → `Path` | 同样都没有 |

旧机 PATH 是出厂默认（含这些项），所以一直好用 —— 这就是「换了台电脑就不好使」的全部原因。

### 10.3 证据链

| 探针 | 结果 |
| --- | --- |
| `cmd /c "where powershell.exe"` | `INFO: Could not find files for the given pattern(s).`，exit=1 |
| `cmd /c "where pwsh.exe"` | 命中 `…\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\pwsh.exe`，exit=0 |
| `Test-Path "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"` | True —— 文件在，只是不在 PATH |
| 进程链 | `pwsh.exe(14608) ← DeepSeek Harness.exe(9736) ← (17748) ← (17432) ← explorer.exe(10028)`：探针是 DSH Host 的**直接子进程**，继承的就是 Host 自己的环境块，排除「只是我的 shell 环境特殊」 |
| Node 复现（`_probe_spawn.mjs`，与插件**同款** spawn 参数 `windowsHide:true, stdio:['ignore','pipe','pipe']`） | A) `spawn('powershell.exe')` → `ERROR code=ENOENT message=spawn powershell.exe ENOENT`；B) 绝对路径 → `closed code=0 stdout="5.1.19041.6456"`；C) `spawn('pwsh.exe')` → `closed code=0 stdout="7.6.6"`；`PATH has WindowsPowerShell\v1.0 = false` |
| 插件 PowerShell 体本身（`_probe_locate.ps1`：逐字照抄 `Add-Type` 定义 + `EnumWindows` 定位，**只定位不修改窗口**） | `RESULT: found hwnd=395280 zoomed=True iconic=False style=0x15C70000 screen=1920x1080`，`PSVersion=5.1.19041.6456 Edition=Desktop` —— 脚本没问题，纯粹是解释器找不到 |

顺带确认了标题消歧是必要的：本机同时存在 `hwnd=1902506 title="dsh-pet 桌宠（桌面模式）"`，窗口类同为 `Chrome_WidgetWin_1`，靠 `$t -match 'DeepSeek Harness'` 才能选中主窗口。

**同一个坑的连带影响**：`dshmarket/lib/restart.js:299` 也是 `file: 'powershell.exe'`，所以 DSH Market 的「重启应用」在这台机器上同样失效 —— 可作为快速旁证。

### 10.4 修复

**（a）插件侧：解释器回落链**（`lib/index.js`）

新增 `powershellCandidates()` 返回有序候选，`applyState()` 逐个 spawn：只有「解释器本身起不来」的错误才换下一个候选；其他错误（脚本超时、脚本报错、`window-not-found`）立即返回，不重试。

第一版只做了 4 个候选（5.1 绝对路径、PowerShell 7、`powershell.exe`、`pwsh.exe`），且只对 `ENOENT` 重试；后来为「换任何一台机器都不该失效」做了加固，**最终实现见 §11**。全部候选都起不来时返回可诊断的中文提示（`NO_POWERSHELL_HINT`），而不是把 `spawn powershell.exe ENOENT` 直接甩进设置行。总预算仍是 8s（`APPLY_TIMEOUT_MS`），每次尝试的超时取「剩余预算」，避免重试把总时长翻倍。

**（b）机器侧：补回 PATH**

把 `%SystemRoot%\System32\WindowsPowerShell\v1.0` 加回 PATH（本机已执行，系统 PATH 已同时补回 `%SystemRoot%` 与 `%SystemRoot%\System32\Wbem`）。改 PATH 只影响**新进程**，所以必须重启 DSH 桌面客户端；重启前插件靠回落链（a）也能正常工作。

### 10.5 顺手修掉的潜伏 bug

`lib/index.js` 的 `default` 分支原本是：

```powershell
$flags = 0x20 -bor 0x4          # SWP_FRAMECHANGED | SWP_NOZORDER
[void][DshWin]::SetWindowPos($hwnd, [IntPtr]::Zero, 0, 0, 0, 0, $flags)
```

`0x20 | 0x4` 里**没有** `SWP_NOMOVE(0x2)` / `SWP_NOSIZE(0x1)`，却把 x/y/cx/cy 全传 0 —— 会把窗口挪到 (0,0) 并缩成 0×0。已改为 `0x20 -bor 0x4 -bor 0x2 -bor 0x1`。

**注意：这个分支目前打不到。** `lib/client.js` 选中「默认」时直接 return、不发请求，`lib/index.js` 的注入脚本对 `default` 也不发 `fetch`（`if(s!=="default")`），所以只有手工 POST `/dsh-window-state/apply` 才会触发。属于「哪天顺手改了就爆」的雷，一并补上。

### 10.6 教训

- **不要用裸名 spawn Windows 自带可执行文件。** `powershell.exe`、`wmic.exe`、`where.exe` 是否在 PATH 里取决于机器，不取决于 Windows 版本。要么用 `%SystemRoot%\System32\...` 绝对路径，要么带回落链。
- **「换台电脑就不好使」优先怀疑环境依赖，而不是代码逻辑。** 本插件唯一的机器相关依赖就是 PATH 能否解析 `powershell.exe`；窗口定位条件（类 + 标题 + 可见）在新机上是满足的。
- 排查顺序建议：进程链确认环境继承 → `where` 确认解析 → 读注册表 PATH 确认源头 → Node 侧同款 spawn 参数做最小复现 → 最后才怀疑业务脚本。
- 只在 PATH 里补 `C:\Windows\System32` 是**不够**的：`powershell.exe` 从来不在那个目录里。

## 十一、跨机器通用性加固：解释器探测 + 子进程环境修正（v0.1.1）

> 起因：用户要求「确保该插件的通用性，避免在其他机器上因为环境变量不同导致插件功能失效」。§10 的修复只覆盖了「PATH 里没有 `WindowsPowerShell\v1.0`」这一种环境差异，而且仍把一个可能残缺的环境块原样传给了子进程。

### 11.1 加固点一：候选清单不再押注单一环境变量

`powershellCandidates(env = process.env)` 的候选顺序（绝对路径经 `existsSync` 过滤、大小写不敏感去重，列表末尾永远保留两个裸名做 PATH 查找）：

| # | 位置 | 取自 |
|---|---|---|
| 1 | `<Windows>\System32\WindowsPowerShell\v1.0\powershell.exe` | `SystemRoot` → `windir` → `SystemDrive`+`\Windows` → `C:\Windows` |
| 2–5 | `…\PowerShell\7\pwsh.exe`、`…\PowerShell\7-preview\pwsh.exe` | `ProgramW6432`、`ProgramFiles`、字面 `C:\Program Files` |
| 6 | `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe` | `LOCALAPPDATA`（应用商店版 pwsh 的执行别名） |
| 7 | `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` | 字面量兜底 |
| 8 | `C:\Program Files\PowerShell\7\pwsh.exe` | 字面量兜底 |
| 9 | `powershell.exe` | PATH 查找 |
| 10 | `pwsh.exe` | PATH 查找 |

`windowsDir()` 的回落链让「环境块被清空 / 撒谎 / 只有 `SystemDrive`」的机器也能定位系统目录。两个 `C:\` 字面量则让**完全空的环境块**在标准 Windows 上仍然可用。

### 11.2 加固点二：修正子进程环境，而不是原样透传

`childEnvironment(state, env = process.env)` 构造子进程环境时修三处：

- **PATH**：缺失才补、且**不删用户任何条目** —— 把 `<Windows>\System32`、`<Windows>`、`<Windows>\System32\Wbem`、`<Windows>\System32\WindowsPowerShell\v1.0` 前置到 PATH 最前（与 Windows 自身搜索顺序一致）。这条同时消除了「父进程 PATH 缺项 → 子进程自己也起不来/加载不了依赖」的隐患。
- **`SystemRoot` / `windir`**：父进程缺就用 `windowsDir()` 的结果补上。
- **`TEMP` / `TMP`**：指向不存在的目录时改用 `os.tmpdir()`。`Add-Type` 每次运行都要编译 C#，没有可写临时目录会以「无法写入输出文件」之类的方式整体失败。
- 配套 `envValue()` / `setEnvValue()` 做**大小写不敏感**读写：`Path`、`PATH`、`path` 在不同机器上都出现过，直接 `env.PATH = x` 会在 `{ ...process.env }` 上留下两个只差大小写的键，让子进程环境产生歧义。

### 11.3 加固点三：重试判据从 `ENOENT` 放宽到「解释器起不来」

`RETRYABLE_SPAWN_CODES = ['ENOENT', 'EACCES', 'EPERM']`。`EACCES`/`EPERM` 覆盖「文件在但被安全策略拦住（AppLocker/WDAC）」和「WindowsApps 别名是坏的」。业务层错误（脚本超时、脚本报错、`window-not-found`）依旧**不**重试 —— 换解释器不会让它们变好。

### 11.4 验证

- **spawn 替身**（`node --import file:///…/_e2e_shim.mjs`，见 §5.3）驱动真实插件的重试循环：
  - `SHIM_MODE=first-enoent` 且父进程 `PATH` 里**没有** `WindowsPowerShell`：`attempt#1` 绝对路径被伪造为 ENOENT → `attempt#2` 裸名 `powershell.exe` **成功**。替身日志同时显示 `childPath-hasWindowsPowerShell=true`，即子进程 PATH 确实被修正过（父进程那份是没有的）→ `HTTP 200 {"ok":true,…}`。
  - `SHIM_MODE=all-enoent`：3 次尝试后 `HTTP 500` + `NO_POWERSHELL_HINT`。
- **纯函数单测** `E:\dsh\dsh_workspace\_ws_evidence\_unit_env.mjs`：把 `lib/index.js` 去掉 `import`/`export` 后丢进 `node:vm` 上下文，直接调用未导出的 `windowsDir` / `envValue` / `childEnvironment` / `powershellCandidates`，21 项断言全过 —— 覆盖每条回落链、大小写、补 PATH 不丢用户条目、坏 `TEMP` 替换、空环境仍给出字面量候选、候选去重。
- ⚠️ **不能拿 `SystemRoot` 当测试杠杆**：Node 24.14.1 在 `SystemRoot` 缺失或撒谎时会自己崩掉 —— `Assertion failed: ncrypto::CSPRNG(nullptr, 0)`，exit 134，栈顶 `node::InitializeOncePerProcessInternal … src\node.cc:1221`（同一环境下 `node --version` 却正常）。这是 Node 自身的脆弱点，与插件无关，所以改用 vm 单测。

### 11.5 教训

- **「环境变量」不止 PATH 一个。** `SystemRoot` / `windir` / `SystemDrive` / `ProgramFiles` / `ProgramW6432` / `LOCALAPPDATA` / `TEMP` 都会在别人的机器上以你没想到的方式出错。要么给回落链，要么自己补齐，别假设它们是好的。
- **Windows 环境变量名大小写不统一**（`Path` vs `PATH`）；在 Node 里 `{ ...process.env }` 之后按键名写回会产生重复键，必须做大小写不敏感读写。
- 想验证「环境变量坏掉时会怎样」，**优先用测试替身（拦截 spawn / 注入假 env）而不是真的去破坏当前进程的环境** —— 破坏宿主环境经常先把运行时本身搞崩，测不到被测代码。
