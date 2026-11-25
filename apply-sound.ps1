#Requires -Version 5.1
<#
  大肥鱼 · 声音系统安装/重打脚本（幂等：重复运行不会重复插入）
  ------------------------------------------------------------------
  用法：
    pwsh -File apply-sound.ps1              # 安装/修复（不重启宠物）
    pwsh -File apply-sound.ps1 -Restart     # 安装后重启宠物窗口，让新代码生效
    pwsh -File apply-sound.ps1 -Status      # 只检查当前安装状态

  做的事：
    1. 把 sound.js / sound-hooks.js 复制进插件的 electron-helper 目录
    2. 在 index.html 里插入两个 <script>（已存在则跳过）
    3. 在 preload.js 末尾追加 petSoundBridge（暴露读配置能力，已存在则跳过）
    4. 首次安装时把 sound.jsonc 写到 ~/.dsh/dsh-pet/（已有则不覆盖，保住用户配置）

  为什么这样装：插件升级会整包替换 node_modules，声音文件会被冲掉。
  升级后重跑一次本脚本即可，用户配置（sound.jsonc）不在包里，不受影响。
#>
[CmdletBinding()]
param(
  [switch]$Restart,
  [switch]$Status
)

$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$pkg = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\@tuweizhi\dsh-pet'
if (-not (Test-Path $pkg)) {
  # 兼容自定义 DSH_HOME
  $pkg = Join-Path $dshHome 'profiles\desktop\node_modules\@tuweizhi\dsh-pet'
}
$helper = Join-Path $pkg 'runtime\electron-helper'
$indexHtml = Join-Path $helper 'index.html'
$preloadJs = Join-Path $helper 'preload.js'
$petHome = Join-Path $dshHome 'dsh-pet'
$userConfig = Join-Path $petHome 'sound.jsonc'

$MARKER = '==== dsh-pet sound system'

function Write-Step($msg) { Write-Host "  $msg" }
function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }
# 统一按 UTF-8 无 BOM 写：被改的 index.html / preload.js 原本就是无 BOM，
# 用 Set-Content -Encoding UTF8 会在 5.1 下加 BOM（浏览器/Node 能忍，但没必要动人家的字节）
function Write-Utf8NoBom([string]$Path, [string]$Text) {
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $enc)
}

if (-not (Test-Path $helper)) { Fail "找不到插件目录：$helper（桌宠插件没装？）" }
if (-not (Test-Path $indexHtml)) { Fail "找不到 $indexHtml" }
if (-not (Test-Path $preloadJs)) { Fail "找不到 $preloadJs" }

# ---------- 状态检查 ----------
if ($Status) {
  Write-Host "插件目录 : $helper"
  foreach ($f in @('sound.js', 'sound-hooks.js', 'sound-onecore.ps1')) {
    $p = Join-Path $helper $f
    Write-Step ("{0,-14} {1}" -f $f, $(if (Test-Path $p) { 'OK' } else { '缺失' }))
  }
  $html = Get-Content $indexHtml -Raw -Encoding UTF8
  Write-Step ("index.html  sound.js      {0}" -f $(if ($html -match '\./sound\.js') { 'OK' } else { '缺失' }))
  Write-Step ("index.html  sound-hooks.js {0}" -f $(if ($html -match '\./sound-hooks\.js') { 'OK' } else { '缺失' }))
  $pre = Get-Content $preloadJs -Raw -Encoding UTF8
  Write-Step ("preload.js  bridge         {0}" -f $(if ($pre -match [regex]::Escape($MARKER)) { 'OK' } else { '缺失' }))
  Write-Step ("用户配置    sound.jsonc     {0}" -f $(if (Test-Path $userConfig) { 'OK' } else { '未创建（用内置默认）' }))
  $proc = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*\.dsh\electron\electron.exe' }
  Write-Step ("宠物进程                   {0}" -f $(if ($proc) { "运行中 (PID $($proc.Id -join ','))" } else { '未运行' }))
  exit 0
}

# ---------- 1. 复制运行时代码 ----------
Write-Host "==> 安装声音系统到 dsh-pet"
foreach ($f in @('sound.js', 'sound-hooks.js', 'sound-onecore.ps1')) {
  $src = Join-Path $here $f
  if (-not (Test-Path $src)) { Fail "源文件缺失：$src" }
  $dst = Join-Path $helper $f
  Copy-Item $src $dst -Force
  # .ps1 必须带 UTF-8 BOM：PowerShell 5.1 读无 BOM 的中文脚本会按 ANSI 解析而报错
  if ($f -like '*.ps1') {
    $txt = [System.IO.File]::ReadAllText($dst, [System.Text.Encoding]::UTF8)
    [System.IO.File]::WriteAllText($dst, $txt, (New-Object System.Text.UTF8Encoding($true)))
  }
  Write-Step "复制 $f"
}

# ---------- 2. index.html 插 script ----------
$html = Get-Content $indexHtml -Raw -Encoding UTF8
$changedHtml = $false

if ($html -notmatch '\./sound\.js') {
  $anchor = '    <script src="./sprite.js"></script>'
  if ($html.Contains($anchor)) {
    $html = $html.Replace($anchor, "    <script src=`"./sound.js`"></script>`r`n" + $anchor)
    $changedHtml = $true
    Write-Step "index.html 插入 ./sound.js（sprite.js 之前）"
  } else {
    Fail 'index.html 结构变了：找不到 <script src="./sprite.js"></script>，无法定位插入点'
  }
}

if ($html -notmatch '\./sound-hooks\.js') {
  $anchor = '    <script src="./renderer.js"></script>'
  if ($html.Contains($anchor)) {
    $html = $html.Replace($anchor, $anchor + "`r`n    <script src=`"./sound-hooks.js`"></script>")
    $changedHtml = $true
    Write-Step "index.html 插入 ./sound-hooks.js（renderer.js 之后）"
  } else {
    Fail 'index.html 结构变了：找不到 <script src="./renderer.js"></script>，无法定位插入点'
  }
}

if ($changedHtml) {
  $backup = $indexHtml + '.pet-sound.bak'
  if (-not (Test-Path $backup)) { Copy-Item $indexHtml $backup }
  Write-Utf8NoBom $indexHtml $html
}

# ---------- 3. preload.js 追加 bridge ----------
$pre = Get-Content $preloadJs -Raw -Encoding UTF8
$block = @'

// ==== dsh-pet sound system (added by apply-sound.ps1) ====
// 读用户声音配置：$DSH_HOME/dsh-pet/sound.jsonc（JSONC：允许 // 与 块注释、尾逗号）
// reportDiag：把渲染层的真实能力（有几个语音、TTS 是否出声）写到
// $DSH_HOME/dsh-pet/sound-diag.log —— 只有宠物自己的进程能给出不受沙箱干扰的答案。
// 为什么放在 preload：窗口是 sandbox:false + contextIsolation:true，preload 有完整 Node
// 能力，而页面主世界没有 require —— 这是唯一能把本地文件能力安全送进渲染层的通道。
try {
  const __sf = require('fs');
  const __sp = require('path');
  const __so = require('os');
  function __home() {
    return process.env.DSH_HOME || __sp.join(__so.homedir(), '.dsh');
  }
  function __stripJsonc(src) {
    return String(src)
      .replace(/^\uFEFF/, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^\\:])\/\/.*$/gm, '$1')
      .replace(/,(\s*[}\]])/g, '$1');
  }
  let __sapiChild = null;
  // OneCore 常驻语音进程的共享状态（同一窗口内复用一个 PowerShell）
  let __ocChild = null;
  let __ocReady = false;
  let __ocBusy = false;
  let __ocQueue = [];
  function __ocLog(payload) {
    try {
      const dir = __sp.join(__home(), 'dsh-pet');
      if (!__sf.existsSync(dir)) __sf.mkdirSync(dir, { recursive: true });
      __sf.appendFileSync(
        __sp.join(dir, 'sound-diag.log'),
        JSON.stringify(Object.assign({ ts: Date.now(), pid: process.pid }, payload || {})) + '\n',
      );
    } catch (e) {}
  }
  function __ocPump() {
    try {
      if (!__ocReady || __ocBusy || !__ocChild || __ocQueue.length === 0) return;
      const next = __ocQueue.shift();
      __ocBusy = true;
      __ocChild.stdin.write(next + '\n');
    } catch (e) {
      __ocBusy = false;
    }
  }
  contextBridge.exposeInMainWorld('petSoundBridge', {
    readSoundConfig() {
      try {
        const file = __sp.join(__home(), 'dsh-pet', 'sound.jsonc');
        if (!__sf.existsSync(file)) return null;
        const json = __stripJsonc(__sf.readFileSync(file, 'utf8')).trim();
        if (!json) return null;
        return JSON.parse(json);
      } catch (e) {
        return null;
      }
    },
    reportDiag(payload) {
      try {
        const dir = __sp.join(__home(), 'dsh-pet');
        if (!__sf.existsSync(dir)) __sf.mkdirSync(dir, { recursive: true });
        const line = JSON.stringify(Object.assign({ ts: Date.now(), pid: process.pid }, payload || {}));
        __sf.appendFileSync(__sp.join(dir, 'sound-diag.log'), line + '\n');
        return true;
      } catch (e) {
        return false;
      }
    },
    // ---- SAPI 直连：绕开 Chromium 的 speechSynthesis ----
    // 实测这套 Electron 里 speechSynthesis.getVoices() 恒为 0（Chrome 侧看不到系统语音），
    // 但系统 SAPI5 本身是好的（Huihui 中文女声可用）。preload 有完整 Node 能力，
    // 所以直接起 PowerShell 调 SAPI —— 这才是这台机器上唯一能出真人声的路。
    sapiProbe() {
      return new Promise((resolve) => {
        try {
          const cp = require('child_process');
          const wav = __sp.join(__so.tmpdir(), 'dsh-pet-sapi-probe.wav');
          const esc = wav.replace(/\\/g, '\\\\');
          const script =
            "$ErrorActionPreference='Stop';" +
            '$v = New-Object -ComObject SAPI.SpVoice;' +
            '$names = @(); for ($i=0; $i -lt $v.GetVoices().Count; $i++) { $names += $v.GetVoices().Item($i).GetDescription() };' +
            '$fs = New-Object -ComObject SAPI.SpFileStream;' +
            "$fs.Open('" + esc + "', 3, $false);" +
            '$v.AudioOutputStream = $fs;' +
            '$v.Speak("test", 0);' +
            '$fs.Close();' +
            "Write-Output ('VOICES|' + ($names -join ';'));" +
            "Write-Output ('WAV|' + (Get-Item '" + esc + "').Length)";
          const child = cp.spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let out = '';
          let err = '';
          child.stdout.on('data', (d) => { if (out.length < 8000) out += d.toString(); });
          child.stderr.on('data', (d) => { if (err.length < 2000) err += d.toString(); });
          child.on('error', (e) => resolve('ERR|' + (e && e.message)));
          child.on('exit', (code) => resolve('EXIT|' + code + '\n' + out + (err ? '\nERR:' + err : '')));
          setTimeout(() => { try { child.kill(); } catch (e) {} resolve('TIMEOUT'); }, 20000);
        } catch (e) {
          resolve('ERR|' + (e && e.message));
        }
      });
    },
    sapiSay(b64, rate, volume) {
      try {
        const cp = require('child_process');
        // 新句覆盖旧句：上一句还在念就直接掐掉，避免两个 PowerShell 同时说话
        if (__sapiChild) {
          try { __sapiChild.kill(); } catch (e) {}
          __sapiChild = null;
        }
        const script =
          "$ErrorActionPreference='Stop';" +
          '$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PET_SAY_B64));' +
          '$v = New-Object -ComObject SAPI.SpVoice;' +
          '$vs = $v.GetVoices();' +
          "for ($i=0; $i -lt $vs.Count; $i++) { if ($vs.Item($i).GetDescription() -match 'Chinese|Huihui|Yaoyao|Kangkang') { $v.Voice = $vs.Item($i); break } };" +
          '$v.Rate = [int]$env:PET_RATE;' +
          '$v.Volume = [int]$env:PET_VOL;' +
          '$v.Speak($t, 0)';
        const child = cp.spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
          env: Object.assign({}, process.env, {
            PET_SAY_B64: String(b64 || ''),
            PET_RATE: String(rate | 0),
            PET_VOL: String(volume | 0),
          }),
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let err = '';
        child.stderr.on('data', (d) => { if (err.length < 2000) err += d.toString(); });
        child.on('error', () => {});
        child.on('exit', (code) => {
          if (code) {
            try {
              __sf.appendFileSync(
                __sp.join(__home(), 'dsh-pet', 'sound-diag.log'),
                JSON.stringify({ ts: Date.now(), ev: 'sapi-exit', code: code, err: err.slice(0, 400) }) + '\n',
              );
            } catch (e) {}
          }
        });
        child.unref();
        __sapiChild = child;
        child.on('exit', () => { if (__sapiChild === child) __sapiChild = null; });
        return true;
      } catch (e) {
        return false;
      }
    },
    sapiStop() {
      try {
        if (__sapiChild) {
          try { __sapiChild.kill(); } catch (e) {}
          __sapiChild = null;
        }
        return true;
      } catch (e) {
        return false;
      }
    },
    // ---- OneCore 常驻语音：Yaoyao（更年轻的中文女声）----
    // 起一个常驻 PowerShell 跑 sound-onecore.ps1：它初始化一次 WinRT，然后从 stdin
    // 按行收 base64 文本，合成→播放→回 "OK"。首句慢（约 1~2 秒），之后每句只付合成时间。
    ocStart(cfg) {
      return new Promise((resolve) => {
        try {
          const cp = require('child_process');
          if (__ocChild) {
            try { __ocChild.kill(); } catch (e) {}
            __ocChild = null;
          }
          __ocQueue = [];
          __ocBusy = false;
          __ocReady = false;
          const worker = __sp.join(__dirname, 'sound-onecore.ps1');
          const c = cfg || {};
          const child = cp.spawn(
            'powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', worker],
            {
              env: Object.assign({}, process.env, {
                PET_VOICE: String(c.voice || 'Yaoyao'),
                PET_RATE: String(c.ratePct == null ? 100 : c.ratePct),
                PET_PITCH: String(c.pitchHz == null ? 0 : c.pitchHz),
                PET_VOLUME: String(c.volume == null ? 100 : c.volume),
              }),
              windowsHide: true,
              stdio: ['pipe', 'pipe', 'pipe'],
            },
          );
          __ocChild = child;
          let buf = '';
          let settled = false;
          const done = (s) => {
            if (!settled) {
              settled = true;
              resolve(s);
            }
          };
          child.stdout.on('data', (d) => {
            buf += d.toString();
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, idx).trim();
              buf = buf.slice(idx + 1);
              if (!line) continue;
              if (line.indexOf('RDY') === 0) {
                __ocReady = true;
                done(line);
                __ocPump();
              } else if (line === 'OK') {
                __ocBusy = false;
                __ocPump();
              } else if (line.indexOf('ERR') === 0) {
                __ocBusy = false;
                __ocLog({ ev: 'oc-err', msg: line.slice(0, 200) });
                __ocPump();
              }
            }
          });
          child.stderr.on('data', (d) => __ocLog({ ev: 'oc-stderr', msg: String(d).slice(0, 300) }));
          child.on('error', (e) => {
            __ocLog({ ev: 'oc-spawn-err', msg: String((e && e.message) || e).slice(0, 200) });
            done('ERR spawn');
          });
          child.on('exit', (code) => {
            __ocLog({ ev: 'oc-exit', code: code });
            if (__ocChild === child) {
              __ocChild = null;
              __ocReady = false;
              __ocBusy = false;
            }
            done('ERR exit ' + code);
          });
          setTimeout(() => done('ERR timeout'), 15000);
        } catch (e) {
          resolve('ERR ' + (e && e.message));
        }
      });
    },
    ocSpeak(b64) {
      try {
        if (!__ocChild) return false;
        // 队列最多留两句：宠物话不多，堆多了说明前面卡住了，直接丢掉旧的
        if (__ocQueue.length > 2) __ocQueue.shift();
        __ocQueue.push(String(b64 || ''));
        __ocPump();
        return true;
      } catch (e) {
        return false;
      }
    },
    ocStop() {
      try {
        __ocQueue = [];
        __ocBusy = false;
        if (__ocChild) {
          try { __ocChild.kill(); } catch (e) {}
          __ocChild = null;
        }
        __ocReady = false;
        return true;
      } catch (e) {
        return false;
      }
    },
  });
} catch (e) {
  console.warn('[pet-sound] bridge expose failed: ' + (e && e.message));
}
// ==== end dsh-pet sound system ====
'@
$backup = $preloadJs + '.pet-sound.bak'
if (-not (Test-Path $backup)) { Copy-Item $preloadJs $backup }
$startMarker = '// ==== dsh-pet sound system (added by apply-sound.ps1) ===='
$endMarker = '// ==== end dsh-pet sound system ===='
if ($pre -match [regex]::Escape($startMarker)) {
  # 已装过：整块替换，保证 bridge 的能力随脚本一起升级
  $pattern = '(?s)' + [regex]::Escape($startMarker) + '.*?' + [regex]::Escape($endMarker)
  $replacement = $block.TrimStart()
  $newPre = [regex]::Replace($pre, $pattern, [System.Text.RegularExpressions.MatchEvaluator] { param($m) $replacement })
  Write-Utf8NoBom $preloadJs $newPre
  Write-Step 'preload.js 更新 petSoundBridge 块'
} else {
  Write-Utf8NoBom $preloadJs ($pre + $block)
  Write-Step 'preload.js 追加 petSoundBridge'
}

# ---------- 4. 用户配置 ----------
if (-not (Test-Path $petHome)) { New-Item -ItemType Directory -Path $petHome -Force | Out-Null }
if (-not (Test-Path $userConfig)) {
  $srcCfg = Join-Path $here 'sound.jsonc'
  if (Test-Path $srcCfg) {
    Copy-Item $srcCfg $userConfig
    Write-Step "写入默认配置 $userConfig"
  }
} else {
  Write-Step "保留已有配置 $userConfig（未覆盖）"
}

# ---------- 5. 重启宠物（可选） ----------
if ($Restart) {
  $procs = Get-Process electron -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like '*\.dsh\electron\electron.exe' }
  if ($procs) {
    foreach ($p in $procs) {
      try {
        Stop-Process -Id $p.Id -Force
        Write-Step "结束宠物进程 PID $($p.Id)（宿主会自动重启它）"
      } catch {
        Write-Step "结束 PID $($p.Id) 失败：$($_.Exception.Message)"
      }
    }
    Start-Sleep -Seconds 3
    $again = Get-Process electron -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -like '*\.dsh\electron\electron.exe' }
    Write-Step ("重启后宠物进程：" + $(if ($again) { "运行中 (PID $($again.Id -join ','))" } else { '未自动重启，请右键宠物→重载配置，或重启 DSH' }))
  } else {
    Write-Step '宠物进程未在运行；下次启动即带声音'
  }
}

Write-Host "==> 完成。声音配置：$userConfig" -ForegroundColor Green
Write-Host "    改完配置后：右键宠物 →「重载配置」" -ForegroundColor DarkGray


