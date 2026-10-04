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
- 依赖 `powershell.exe` 与 `user32.dll`，均为 Windows 自带组件。

## 安装

在 DSH 的 设置 → 插件 里安装 `dsh-window-state`（或通过 CLI 安装到非 desktop profile）。安装后重启客户端生效。

## 目录结构

```
lib/index.js    Host 半（Win32 helper + webServer 路由 + index-inject）
lib/client.js   Client 半（settings.general.item 行 + 分段控件）
cordis.patch.yml  挂载补丁
package.json      包清单（dsh.client / dsh.bundle.patch）
```
