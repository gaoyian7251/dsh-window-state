# dsh-window-state

在 DSH 桌面客户端的 **设置 → 通用设置** 里增加一行「启动窗口状态」，可选择每次启动时窗口以 **默认 / 最大化 / 全屏** 打开（Windows）。

## 原理

DSH 桌面主窗口由 Electron 主进程创建，插件运行时（Host / Client）没有任何 IPC 或服务能触达 `BrowserWindow` 的 maximize / fullscreen（已反编译 `app.asar` 验证：唯一的窗口状态通道 `dsh-desktop:window-fullscreen` 是主进程→渲染进程的单向通知，且 `main.js` 里没有任何全屏/最大化入口）。

因此本插件走**越界机制**——通过 Win32 API（`user32.dll`）从子进程定位并控制窗口：

- 用 `EnumWindows` 按窗口类 `Chrome_WidgetWin_1` + 标题含 `DeepSeek Harness` 定位主窗口（不能用进程 pid，因为 Host Node 进程与 Electron 主进程是不同 pid）。
- `ShowWindowAsync(hwnd, SW_MAXIMIZE / SW_RESTORE)` 实现最大化 / 还原。
- 全屏：剥离 `WS_CAPTION | WS_THICKFRAME` 样式 + `SetWindowPos` 到全屏分辨率；退出时恢复样式并重新最大化。

选择持久化在 `localStorage`（`dsh-window-state:startup`），两条路径生效：

1. `webserver/index-inject` 注入一段同步脚本，在**启动最早时刻**读取并应用选择。
2. `POST /dsh-window-state/apply` 在用户修改设置时**立即**应用。

## 局限

- 仅 Windows（依赖 PowerShell + Win32 API）。
- 全屏是通过剥离窗口边框实现的「伪全屏」，等价于 `BrowserWindow.setFullScreen(true)` 的视觉效果（无系统标题栏、铺满整个显示器）。
- 依赖 PowerShell（`powershell.exe` 或 `pwsh.exe`）与 `user32.dll`，均为 Windows 自带或可免费安装的组件。**不要求它们出现在 PATH 里**：插件会先探测各个绝对安装位置（含 `%SystemRoot%\System32\WindowsPowerShell\v1.0`、PowerShell 7 / 7-preview、应用商店版 pwsh，以及两个 `C:\` 字面量兜底），全都不可用才退回 PATH 查找。即便如此，PATH 被清理过的机器仍建议修回来——见下面「常见问题」。

## 安装

**从 GitHub 安装**（推荐，尚未发布到 npm）：

```
github:gaoyian7251/dsh-window-state
```

在 DSH 的 **设置 → 插件 → 安装** 里填入上面的标识，或通过 CLI 安装到 profile：

```powershell
dsh plugin install github:gaoyian7251/dsh-window-state
```

也可以直接把仓库克隆到 profile 的 `node_modules` 下。**安装后需重启桌面客户端才生效**（profile 的插件图在进程启动时构建）。

## 使用

重启后打开 **设置 → 通用设置**，找到「**启动窗口状态**」一行，选择 **默认 / 最大化 / 全屏**：

- 选择会立刻应用到当前窗口，并持久化，下次启动自动生效；
- **默认** = 保持 Electron 记住的上次窗口位置与大小。

## 常见问题

### 换台电脑后就不好使了：提示「未能立即应用（spawn powershell.exe ENOENT）」

这台机器的 PATH 里没有 `powershell.exe`。它**不在** `C:\Windows\System32` 根目录，而在 `C:\Windows\System32\WindowsPowerShell\v1.0` —— 只有该子目录出现在 PATH 里时，`spawn('powershell.exe')` 才找得到它（Windows 的 `CreateProcess` / `SearchPathW` 不查 App Paths 注册表）。某些安装器或「PATH 优化 / 清理」工具会把系统 PATH 整段重置，连带丢掉 Windows 默认项，于是换台电脑就失效。

先确认（30 秒）：

```powershell
cmd /c "where powershell.exe"
# INFO: Could not find files for the given pattern(s).   ← 就是这个原因

Test-Path "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
# True                                                  ← 文件在，只是不在 PATH
```

修法（二选一，**改完都必须重启 DSH 桌面客户端**，进程环境变量只在新进程里生效）：

**1. 把目录加回 PATH**（推荐，顺便修好其他依赖 `powershell.exe` 的工具，例如 DSH Market 的「重启应用」）

以管理员身份把下面这一项加回**系统** PATH（「此电脑 → 属性 → 高级系统设置 → 环境变量」的「系统变量 → Path」），加不了管理员就加进**用户** PATH，效果一样：

```
%SystemRoot%\System32\WindowsPowerShell\v1.0
```

顺手建议确认 `%SystemRoot%` 和 `%SystemRoot%\System32\Wbem` 也在。

**2. 依赖插件自带的解释器探测与环境修正**（v0.1.1+ 起）

插件**不假设 PATH / 环境变量是对的**。它按顺序尝试下面这些位置，任何一个能启动就成功：

```
1. <Windows>\System32\WindowsPowerShell\v1.0\powershell.exe   ← 5.1，正常位置
2. <PF>\PowerShell\7\pwsh.exe                                 ← PowerShell 7
3. <PF>\PowerShell\7-preview\pwsh.exe                         ← PowerShell 7 预览版
4. %LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe              ← 应用商店版 pwsh 的执行别名
5. C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe  ← 环境变量取不到时的字面兜底
6. C:\Program Files\PowerShell\7\pwsh.exe                     ← 同上
7. powershell.exe                                             ← 最后才退回 PATH 查找
8. pwsh.exe

<PF> 依次取 %ProgramW6432%、%ProgramFiles%、字面 C:\Program Files
```

绝对路径候选会先用 `existsSync` 过滤、按大小写不敏感去重，所以上面这串在多数机器上实际只会保留 2～4 条。

（`%SystemRoot%` 本身取不到时，会依次用 `%windir%`、`%SystemDrive%\Windows`、`C:\Windows`。）

所以只装一个 PowerShell 7 也能用：

```powershell
winget install --id Microsoft.PowerShell
```

另外，插件在起子进程前会**修正子进程的环境变量**，而不是原样透传：

- **PATH**：缺哪补哪，把 `%SystemRoot%\System32`、`%SystemRoot%`、`%SystemRoot%\System32\Wbem`、`…\WindowsPowerShell\v1.0` 补到最前，**不删你原有的任何条目**；
- **`SystemRoot` / `windir`**：父进程缺就按同样的回落链补上；
- **`TEMP` / `TMP`**：指向不存在的目录时改用系统临时目录（`Add-Type` 每次都要编译 C#，需要可写的临时目录）；
- 环境变量名在 Windows 上大小写不统一（`Path` / `PATH`），插件做大小写不敏感读写，不会产生重复键。

只有所有候选都起不来时才会报错，此时设置行会明确告诉你：

> 本机启动不了 PowerShell：%SystemRoot%\System32\WindowsPowerShell\v1.0 下没有 powershell.exe，PATH 里也找不到 powershell.exe 或 pwsh.exe。请把该目录加回 PATH，或安装 PowerShell 7，然后重启 DSH

而不是只丢一个 `ENOENT`。

**从本地路径装过之后，重装报 `ERR_PNPM_EPERM ... rename ..._tmp_... -> ...dsh-window-state`**

用本地路径安装（`dsh plugin install <本地目录>`）时 pnpm 会建立一个 Junction 链接，而卸载时**不会**把它从 `node_modules` 里删掉；之后新版本无法 rename 落位，就会报 `EPERM`。清掉这个链接再装即可（`rmdir` 只删链接，不会动你的源码目录）：

```powershell
cmd /c rmdir "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-window-state"
dsh plugin install github:gaoyian7251/dsh-window-state
```

从 git 安装的是真实目录，之后卸载 / 升级都不会再有这个问题。

> **⚠️ 只能用 `cmd /c rmdir` 删这个链接。** 不要用 PowerShell 的 `Remove-Item -Recurse`：它会穿透 Junction 去删链接指向的目录 —— 也就是你的插件源码（曾因此把源码仓库的 `.git` 删坏）。

## 目录结构

```
lib/index.js    Host 半（Win32 helper + webServer 路由 + index-inject）
lib/client.js   Client 半（settings.general.item 行 + 分段控件）
cordis.patch.yml  挂载补丁
package.json      包清单（dsh.client / dsh.bundle.patch）
```
