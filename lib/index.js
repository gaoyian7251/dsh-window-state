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
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

/** Overall budget for one apply, including every interpreter retry. */
const APPLY_TIMEOUT_MS = 8000

/**
 * Interpreter-level startup failures that are worth retrying with the next
 * candidate — the interpreter could not be started at all. `ENOENT` is the
 * missing-from-PATH case; `EACCES`/`EPERM` cover a `powershell.exe` that exists
 * but is blocked (AppLocker/WDAC) or is a dangling WindowsApps alias.
 */
const RETRYABLE_SPAWN_CODES = ['ENOENT', 'EACCES', 'EPERM']

/**
 * Case-insensitive environment lookup. Windows spells the same variable `Path`,
 * `PATH` or `path` depending on who wrote it, and `process.env` keeps whatever
 * casing it was given.
 *
 * @param {Record<string, string|undefined>} env
 * @param {string} key
 * @returns {string|undefined}
 */
function envValue(env, key) {
  const wanted = key.toLowerCase()
  for (const name of Object.keys(env)) {
    const value = env[name]
    if (name.toLowerCase() === wanted && value) return value
  }
  return undefined
}

/**
 * Set `key` without leaving a differently-cased duplicate behind: two entries
 * that differ only in case would make the child's environment ambiguous.
 *
 * @param {Record<string, string|undefined>} env
 * @param {string} key
 * @param {string} value
 */
function setEnvValue(env, key, value) {
  const wanted = key.toLowerCase()
  for (const name of Object.keys(env)) {
    if (name.toLowerCase() === wanted && name !== key) delete env[name]
  }
  env[key] = value
}

/**
 * The Windows directory, derived from whichever environment variable survives.
 * A machine whose `SystemRoot`/`windir` were dropped is still normally right
 * through `SystemDrive`; `C:\Windows` is the last resort.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {string}
 */
function windowsDir(env) {
  const systemDrive = envValue(env, 'SystemDrive')
  return (
    envValue(env, 'SystemRoot') ||
    envValue(env, 'windir') ||
    (systemDrive ? join(systemDrive, 'Windows') : 'C:\\Windows')
  )
}

/**
 * Ordered PowerShell interpreter candidates.
 *
 * `powershell.exe` does NOT sit in `%SystemRoot%\System32` — it sits in the
 * `WindowsPowerShell\v1.0` subdirectory, which `CreateProcess` can only reach
 * through PATH. On a machine whose PATH was rewritten by an installer or a
 * "PATH cleaner" (the stock Windows entries dropped), a bare
 * `spawn('powershell.exe')` fails with ENOENT even though PowerShell is
 * installed, and the plugin silently does nothing.
 *
 * So: probe every absolute location that can hold an interpreter — PowerShell
 * 5.1, PowerShell 7 and 7-preview, both Program Files flavours on 64-bit
 * Windows, and the Store alias — before falling back to a plain PATH lookup.
 * Two literal `C:\` locations close the list, so an empty or lying environment
 * block still resolves on a stock Windows.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string[]} interpreter paths/names to try, in order.
 */
function powershellCandidates(env = process.env) {
  const winDir = windowsDir(env)
  const localAppData = envValue(env, 'LOCALAPPDATA')
  const programDirs = [
    envValue(env, 'ProgramW6432'),
    envValue(env, 'ProgramFiles'),
    'C:\\Program Files',
  ].filter(Boolean)

  const absolute = [
    join(winDir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ...programDirs.flatMap((dir) => [
      join(dir, 'PowerShell', '7', 'pwsh.exe'),
      join(dir, 'PowerShell', '7-preview', 'pwsh.exe'),
    ]),
    ...(localAppData ? [join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe')] : []),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  ]

  const seen = new Set()
  const present = []
  for (const candidate of absolute) {
    const key = candidate.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (existsSync(candidate)) present.push(candidate)
  }
  // The bare names stay for PATH lookup; a missing one fails fast and falls through.
  return present.concat(['powershell.exe', 'pwsh.exe'])
}

/**
 * The environment handed to the interpreter.
 *
 * Three variables are repaired rather than trusted, because a machine that
 * misconfigures any one of them breaks the plugin even though PowerShell itself
 * is fine:
 *   - `PATH`: the stock Windows directories are re-added, in front, matching
 *     Windows' own search order, so the child can load its own dependencies.
 *   - `SystemRoot`/`windir`: filled in when the parent lacks them.
 *   - `TEMP`/`TMP`: `Add-Type` compiles C# on every run and needs a writable
 *     temp directory; a missing or dangling one fails the whole apply.
 *
 * @param {string} state
 * @param {Record<string, string|undefined>} [env]
 * @returns {Record<string, string|undefined>} environment for the child.
 */
function childEnvironment(state, env = process.env) {
  const child = { ...env, DSH_WINDOW_STATE: state }
  const winDir = windowsDir(env)

  setEnvValue(child, 'SystemRoot', winDir)
  setEnvValue(child, 'windir', winDir)

  const required = [
    join(winDir, 'System32'),
    winDir,
    join(winDir, 'System32', 'Wbem'),
    join(winDir, 'System32', 'WindowsPowerShell', 'v1.0'),
  ]
  const current = (envValue(child, 'Path') || '').split(';').filter(Boolean)
  const present = new Set(current.map((entry) => entry.replace(/[\\/]+$/, '').toLowerCase()))
  const missing = required.filter((dir) => !present.has(dir.replace(/[\\/]+$/, '').toLowerCase()))
  if (missing.length > 0) setEnvValue(child, 'Path', missing.concat(current).join(';'))

  const temp = envValue(child, 'TEMP') || envValue(child, 'TMP')
  if (!temp || !existsSync(temp)) {
    const fallback = tmpdir()
    setEnvValue(child, 'TEMP', fallback)
    setEnvValue(child, 'TMP', fallback)
  }

  return child
}

/** Shown in the settings row when no interpreter could be started at all. */
const NO_POWERSHELL_HINT =
  '本机启动不了 PowerShell：%SystemRoot%\\System32\\WindowsPowerShell\\v1.0 下没有 powershell.exe，' +
  'PATH 里也找不到 powershell.exe 或 pwsh.exe。' +
  '请把该目录加回 PATH，或安装 PowerShell 7，然后重启 DSH'

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
  # SWP_FRAMECHANGED | SWP_NOZORDER | SWP_NOMOVE | SWP_NOSIZE. Without
  # NOMOVE/NOSIZE the zeroed x/y/cx/cy below would move the window to (0,0)
  # and resize it to 0x0.
  $flags = 0x20 -bor 0x4 -bor 0x2 -bor 0x1
  [void][DshWin]::SetWindowPos($hwnd, [IntPtr]::Zero, 0, 0, 0, 0, $flags)
  [void][DshWin]::ShowWindowAsync($hwnd, $SW_RESTORE)
  Start-Sleep -Milliseconds 150
  Write-Output ('{"ok":true,"hwnd":' + $hwnd.ToInt64() + ',"error":null,"default":true}')
}
`.replace(/\$SW_RESTORE/g, String(SW_RESTORE)).replace(/\$SW_MAXIMIZE/g, String(SW_MAXIMIZE))

    const candidates = powershellCandidates()
    const childEnv = childEnvironment(state)
    const deadline = Date.now() + APPLY_TIMEOUT_MS

    /**
     * One spawn attempt. `missing` is true only when the interpreter itself
     * could not be started (see RETRYABLE_SPAWN_CODES) — the one class of
     * failure worth retrying with the next candidate.
     */
    const attempt = (file) =>
      new Promise((done) => {
        let settled = false
        const finish = (result, missing) => {
          if (settled) return
          settled = true
          done({ result, missing })
        }

        const child = spawn(file, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
          env: childEnv,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })

        let out = ''
        let err = ''
        const timer = setTimeout(() => {
          child.kill()
          finish({ ok: false, hwnd: null, error: 'timeout' }, false)
        }, Math.max(1000, deadline - Date.now()))
        child.stdout.on('data', (c) => { out += c.toString('utf8') })
        child.stderr.on('data', (c) => { err += c.toString('utf8') })
        child.on('error', (e) => {
          clearTimeout(timer)
          finish({ ok: false, hwnd: null, error: e.message }, RETRYABLE_SPAWN_CODES.indexOf(e.code) >= 0)
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          const line = out.trim().split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop()
          if (line !== undefined) {
            try {
              const parsed = JSON.parse(line)
              finish({ ok: !!parsed.ok, hwnd: parsed.hwnd ?? null, error: parsed.error ?? null }, false)
              return
            } catch {
              /* fall through to the raw-output path */
            }
          }
          finish({ ok: false, hwnd: null, error: err.trim() || `exit ${code}` }, false)
        })
      })

    ;(async () => {
      let lastError = null
      for (const file of candidates) {
        const { result, missing } = await attempt(file)
        if (!missing) {
          resolve(result)
          return
        }
        lastError = result.error
        if (Date.now() >= deadline) break
      }
      resolve({ ok: false, hwnd: null, error: `${NO_POWERSHELL_HINT}（最后一次尝试：${lastError || 'unknown'}）` })
    })()
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
