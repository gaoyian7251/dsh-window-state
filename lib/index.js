/**
 * Host half of dsh-window-state.
 *
 * The DSH desktop main window is owned by the Electron MAIN process, which
 * boots BEFORE the DSH Host (Node) and Client (renderer) plugin runtimes. There
 * is no IPC channel or Host service that lets a plugin reach the BrowserWindow
 * to maximize/minimize/fullscreen it (verified against app.asar: the only
 * window-state IPC is the one-way `dsh-desktop:window-fullscreen` notification
 * main→renderer, and main.js has no fullscreen/maximize/minimize entry point).
 *
 * So this plugin goes out-of-band: it uses the Win32 API (user32.dll) from a
 * child process to find the DSH main window by its HWND and apply the state.
 *
 *   - The window is located by `EnumWindows` + class `Chrome_WidgetWin_1` +
 *     a title ending in `DeepSeek Harness` (NOT by process id: the Host Node
 *     process and the Electron main process are different pids).
 *   - `ShowWindowAsync(hwnd, SW_MAXIMIZE | SW_MINIMIZE | SW_RESTORE)` handles
 *     maximize / minimize / restore.
 *   - Fullscreen is done the only way Win32 offers without Electron's
 *     cooperation: strip WS_CAPTION|WS_THICKFRAME and SetWindowPos to the full
 *     monitor, and re-add the styles + re-maximize to leave it.
 *
 * The state choice is persisted in localStorage by the client half and read
 * back here two ways:
 *   1. `webserver/index-inject` injects a synchronous <script> that applies the
 *      choice at boot (the earliest a plugin can act).
 *   2. `POST /dsh-window-state/apply` applies it immediately when the user
 *      changes the setting in the General settings row.
 *
 * @module dsh-window-state
 */

import { spawn } from 'node:child_process'

export const name = 'dsh-window-state'

/** client.js STATE_KEY / DEFAULT_STATE — keep in sync. */
const STATE_KEY = 'dsh-window-state:startup'
/** client.js STATE_VALUES — keep in sync. */
const STATE_VALUES = ['default', 'maximized', 'fullscreen']
const DEFAULT_STATE = 'default'

/** Windows SW_* constants. */
const SW_MINIMIZE = 6
const SW_RESTORE = 9
const SW_MAXIMIZE = 3

/**
 * One child PowerShell process that applies a state to the DSH window.
 *
 * The script is a single self-contained `Add-Type` + enumeration + apply
 * block. It locates the window fresh each run (HWNDs are not stable across the
 * app's lifetime, and this helper may run before or after the window exists).
 *
 * @param {string} state - 'default' | 'maximized' | 'fullscreen'
 * @returns {Promise<{ok: boolean, hwnd: number|null, error: string|null}>}
 */
function applyState(state) {
  return new Promise((resolve) => {
    if (STATE_VALUES.indexOf(state) < 0) state = DEFAULT_STATE

    // The PowerShell body. `--%` is NOT used so $args stay interpolable; the
    // state is passed through an env var to avoid quoting pitfalls entirely.
    const ps = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class DshWin {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern long GetWindowLongPtr(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern long SetWindowLongPtr(IntPtr h, int idx, long v);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int idx);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
}
'@

$found = [IntPtr]::Zero
$cb = [DshWin+EnumWindowsProc]{ param($h,$l)
  $cn = New-Object System.Text.StringBuilder 256
  [void][DshWin]::GetClassName($h,$cn,256)
  if ($cn.ToString() -ne 'Chrome_WidgetWin_1') { return $true }
  $sb = New-Object System.Text.StringBuilder 512
  [void][DshWin]::GetWindowText($h,$sb,512)
  $t = $sb.ToString()
  if ($t -match 'DeepSeek Harness' -and [DshWin]::IsWindowVisible($h)) {
    $script:found = $h
    return $false
  }
  return $true
}
[void][DshWin]::EnumWindows($cb,[IntPtr]::Zero)

if ($found -eq [IntPtr]::Zero) {
  Write-Output '{"ok":false,"hwnd":null,"error":"window-not-found"}'
  exit 0
}

$hwnd = $found
$state = $env:DSH_WINDOW_STATE
$GWL_STYLE = -16
$WS_CAPTION = 0x00C00000
$WS_THICKFRAME = 0x00040000

if ($state -eq 'maximized') {
  [void][DshWin]::ShowWindowAsync($hwnd, $SW_RESTORE)
  [void][DshWin]::ShowWindowAsync($hwnd, $SW_MAXIMIZE)
  Start-Sleep -Milliseconds 150
  $zoomed = [DshWin]::IsZoomed($hwnd)
  Write-Output ('{"ok":' + ($zoomed.ToString().ToLower()) + ',"hwnd":' + $hwnd.ToInt64() + ',"error":null,"zoomed":' + ($zoomed.ToString().ToLower()) + '}')
} elseif ($state -eq 'fullscreen') {
  $style = [DshWin]::GetWindowLongPtr($hwnd, $GWL_STYLE)
  $newStyle = $style -band (-bnot ($WS_CAPTION -bor $WS_THICKFRAME))
  [void][DshWin]::SetWindowLongPtr($hwnd, $GWL_STYLE, $newStyle)
  $sw = [DshWin]::GetSystemMetrics(0); $sh = [DshWin]::GetSystemMetrics(1)
  $flags = 0x20 -bor 0x4  # SWP_FRAMECHANGED | SWP_NOZORDER
  [void][DshWin]::SetWindowPos($hwnd, [IntPtr]::Zero, 0, 0, $sw, $sh, $flags)
  Start-Sleep -Milliseconds 150
  Write-Output ('{"ok":true,"hwnd":' + $hwnd.ToInt64() + ',"error":null,"fullscreen":true}')
} else {
  # 'default' — leave the window as Electron would have opened it (restore from
  # any prior minimize, re-add the frame styles, then re-maximize to Electron's
  # remembered bounds).
  $style = [DshWin]::GetWindowLongPtr($hwnd, $GWL_STYLE)
  $newStyle = $style -bor ($WS_CAPTION -bor $WS_THICKFRAME)
  [void][DshWin]::SetWindowLongPtr($hwnd, $GWL_STYLE, $newStyle)
  $flags = 0x20 -bor 0x4
  [void][DshWin]::SetWindowPos($hwnd, [IntPtr]::Zero, 0, 0, 0, 0, $flags)
  [void][DshWin]::ShowWindowAsync($hwnd, $SW_RESTORE)
  Start-Sleep -Milliseconds 150
  Write-Output ('{"ok":true,"hwnd":' + $hwnd.ToInt64() + ',"error":null,"default":true}')
}
`.replace(/\$SW_RESTORE/g, String(SW_RESTORE)).replace(/\$SW_MAXIMIZE/g, String(SW_MAXIMIZE))

    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      env: { ...process.env, DSH_WINDOW_STATE: state },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, hwnd: null, error: 'timeout' })
    }, 8000)
    child.stdout.on('data', (c) => { out += c.toString('utf8') })
    child.stderr.on('data', (c) => { err += c.toString('utf8') })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, hwnd: null, error: e.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const line = out.trim().split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop()
      if (line !== undefined) {
        try {
          const parsed = JSON.parse(line)
          resolve({ ok: !!parsed.ok, hwnd: parsed.hwnd ?? null, error: parsed.error ?? null })
          return
        } catch {
          /* fall through to the raw-output path */
        }
      }
      resolve({ ok: false, hwnd: null, error: err.trim() || `exit ${code}` })
    })
  })
}

/**
 * Read the persisted state from localStorage, injected as a synchronous script
 * row so the choice is applied at the earliest possible boot moment.
 */
function readStateScript() {
  return (
    '(function(){' +
    'var s=null;' +
    'try{s=window.localStorage.getItem(' + JSON.stringify(STATE_KEY) + ')}catch(e){}' +
    'var v=[' + STATE_VALUES.map((x) => JSON.stringify(x)).join(',') + '];' +
    'if(v.indexOf(s)<0)s=' + JSON.stringify(DEFAULT_STATE) + ';' +
    'if(s!=="default"){' +
    'try{window.fetch("/dsh-window-state/apply",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({state:s})})}catch(e){}' +
    '}' +
    '})()'
  )
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

/**
 * POST /dsh-window-state/apply  { state } -> { ok, hwnd, error }
 * GET  /dsh-window-state/status -> { state } (the persisted value, for the row)
 */
async function applyHandler(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'method-not-allowed' }))
    return
  }
  let state = DEFAULT_STATE
  try {
    const body = JSON.parse(await readBody(req))
    if (typeof body.state === 'string' && STATE_VALUES.indexOf(body.state) >= 0) state = body.state
  } catch {
    /* no body -> default */
  }
  const result = await applyState(state)
  res.writeHead(result.ok ? 200 : 500, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(result))
}

/**
 * Plugin body.
 *
 * The webServer routes are registered through an optional injection so a
 * profile without an HTTP carrier still gets the injected boot script; only the
 * settings row loses its apply path.
 *
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'script', placement: 'head', text: readStateScript() })
  })

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/dsh-window-state/apply',
          handler: applyHandler,
        }),
      'dsh-window-state: POST /dsh-window-state/apply',
    )
  })
}
