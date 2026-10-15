import type { Register } from 'claude-code'

// Windows only: a topmost no-focus-steal popup with a button that raises the terminal window hosting this session.
const SCRIPT = String.raw`
Add-Type -AssemblyName System.Windows.Forms,System.Drawing,UIAutomationClient,UIAutomationTypes
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition '
using System; using System.Text; using System.Runtime.InteropServices; using System.Windows.Forms;
public class Toast : Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x08000000 | 0x80; return p; } }
}
public static class Win {
  [DllImport("user32")] public static extern bool SetProcessDPIAware();
  delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("kernel32")] public static extern bool FreeConsole();
  [DllImport("kernel32")] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32")] public static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFile(string f, uint a, uint s, IntPtr sec, uint d, uint fl, IntPtr t);
  [DllImport("kernel32")] static extern bool WriteFile(IntPtr h, byte[] b, uint n, out uint w, IntPtr o);
  [DllImport("kernel32")] static extern bool CloseHandle(IntPtr h);
  [DllImport("user32")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32")] static extern bool EnumWindows(EP cb, IntPtr l);
  [DllImport("user32")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  // Titles of top-level windows starting with prefix (the other popups, hidden ones too).
  public static string[] Titles(string prefix) {
    var found = new System.Collections.Generic.List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
      if (sb.ToString().StartsWith(prefix)) found.Add(sb.ToString());
      return true; }, IntPtr.Zero);
    return found.ToArray();
  }
  public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  // Visible titled window of any listed process, matching names in order (deepest folder first):
  // a title segment ("file - folder - profile - app") equal to a name wins, then a substring, else the topmost window.
  public static IntPtr FindWindow(uint[] pids, string[] names) {
    var hs = new System.Collections.Generic.List<IntPtr>(); var ts = new System.Collections.Generic.List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h) || Array.IndexOf(pids, Pid(h)) < 0) return true;
      var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
      if (sb.Length > 0) { hs.Add(h); ts.Add(sb.ToString()); }
      return true; }, IntPtr.Zero);
    foreach (var n in names) for (int i = 0; i < hs.Count; i++)
      foreach (var seg in ts[i].Split(new string[] { " - " }, StringSplitOptions.None))
        if (string.Equals(seg.Replace(" (Workspace)", ""), n, StringComparison.OrdinalIgnoreCase)) return hs[i];
    foreach (var n in names) for (int i = 0; i < hs.Count; i++)
      if (ts[i].IndexOf(n, StringComparison.OrdinalIgnoreCase) >= 0) return hs[i];
    return hs.Count > 0 ? hs[0] : IntPtr.Zero;
  }
  // Sets the title of the console owned by pid (the tab or pane running it) via OSC 0.
  public static void SetTitle(uint pid, string title) {
    FreeConsole(); if (!AttachConsole(pid)) return;
    IntPtr h = CreateFile("CONOUT$", 0x40000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    byte[] b = Encoding.UTF8.GetBytes("\u001b]0;" + title + "\u0007"); uint n;
    WriteFile(h, b, (uint)b.Length, out n, IntPtr.Zero); CloseHandle(h); FreeConsole();
  }
}'
[Win]::SetProcessDPIAware() | Out-Null
$project = $env:CC_TITLE
$term = [IntPtr]::Zero; $conPid = 0; $isWT = $false
# Ancestors, nearest first.
$pids = @(); $p = $PID
for ($i = 0; $i -lt 12; $i++) {
  $p = (Get-CimInstance Win32_Process -Filter "ProcessId=$p").ParentProcessId
  if (-not $p) { break }; $pids += [uint32]$p
}
# A visible root-owner of an ancestor console = the terminal window (conhost, Windows Terminal).
[Win]::FreeConsole() | Out-Null
foreach ($p in $pids) {
  if ([Win]::AttachConsole($p)) {
    $c = [Win]::GetConsoleWindow(); [Win]::FreeConsole() | Out-Null
    if ($c -ne [IntPtr]::Zero) {
      $r = [Win]::GetAncestor($c, 3); if ($r -eq [IntPtr]::Zero) { $r = $c }
      if ([Win]::IsWindowVisible($r)) { $term = $r; $conPid = $p; break }
      if ($conPid -eq 0) { $conPid = $p }
    }
  }
}
# Hidden pseudo-console (VS Code etc.): fall back to a window of an ancestor process, by cwd folder (the workspace may be a parent of cwd).
$names = [string[]]@(($env:CC_CWD -split '[\\/]' | Where-Object { $_ })[-1..-2] | Where-Object { $_ })
if ($term -eq [IntPtr]::Zero) { $term = [Win]::FindWindow($pids, $names) }
if ($term -ne [IntPtr]::Zero) { $isWT = (Get-Process -Id ([Win]::Pid($term))).ProcessName -eq 'WindowsTerminal' }
if ($env:CC_DEBUG) { "term=$term wt=$isWT conPid=$conPid" }

function Select-Tab {
  # Marks this console's tab with a unique title, selects the tab carrying it, then names it after the project.
  $mark = 'cc-focus-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
  [Win]::SetTitle($conPid, $mark); Start-Sleep -Milliseconds 400
  $A = [Windows.Automation.AutomationElement]
  $cond = New-Object Windows.Automation.PropertyCondition($A::ControlTypeProperty, [Windows.Automation.ControlType]::TabItem)
  foreach ($t in $A::FromHandle($term).FindAll('Descendants', $cond)) {
    if ($t.Current.Name -like "*$mark*") { $t.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select(); break }
  }
  [Win]::SetTitle($conPid, $project)
}

# Layout in 96-dpi px, scaled to the screen's DPI; sized like a Windows toast (364 wide, 12 px from the corner).
$s = [Drawing.Graphics]::FromHwnd([IntPtr]::Zero).DpiX / 96
function S($n) { [int][Math]::Round($n * $s) }
function Pt($x, $y) { New-Object Drawing.Point((S $x), (S $y)) }
function Sz($x, $y) { New-Object Drawing.Size((S $x), (S $y)) }
function Rgb($hex) { [Drawing.ColorTranslator]::FromHtml($hex) }
$bg = Rgb '#262624'; $ink = Rgb '#F5F4EE'; $dim = Rgb '#A3A199'; $accent = Rgb '#D97757'; $accentHot = Rgb '#E58B6D'; $btn = Rgb '#3A3935'; $btnHot = Rgb '#4A4944'

# Claude-style starburst: 12 rounded rays, alternating long and short.
$px = S 36
$bmp = New-Object Drawing.Bitmap($px, $px)
$g = [Drawing.Graphics]::FromImage($bmp); $g.SmoothingMode = 'AntiAlias'
$pen = New-Object Drawing.Pen($accent, [single]($px * 0.085)); $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
$c = $px / 2
for ($i = 0; $i -lt 12; $i++) {
  $a = $i * [Math]::PI / 6; $r = if ($i % 2) { $px * 0.36 } else { $px * 0.47 }
  $g.DrawLine($pen, [single]($c + [Math]::Cos($a) * $px * 0.1), [single]($c + [Math]::Sin($a) * $px * 0.1), [single]($c + [Math]::Cos($a) * $r), [single]($c + [Math]::Sin($a) * $r))
}
$g.Dispose()

function Lbl($text, $font, $color, $x, $y, $w, $h) {
  New-Object Windows.Forms.Label -Property @{ Text = $text; Font = $font; ForeColor = $color; BackColor = [Drawing.Color]::Transparent; Location = (Pt $x $y); Size = (Sz $w $h); Cursor = 'Hand' }
}
function Btn($text, $x, $w, $back, $hot) {
  $b = New-Object Windows.Forms.Button -Property @{ Text = $text; Font = New-Object Drawing.Font('Segoe UI', 9); ForeColor = $ink; BackColor = $back; FlatStyle = 'Flat'; UseVisualStyleBackColor = $false; Location = (Pt $x 96); Size = (Sz $w 28); Cursor = 'Hand' }
  $b.FlatAppearance.BorderSize = 0; $b.FlatAppearance.MouseOverBackColor = $hot; $b.FlatAppearance.MouseDownBackColor = $hot
  $b
}

$f = New-Object Toast
$f.AutoScaleMode = 'None'; $f.FormBorderStyle = 'None'; $f.TopMost = $true; $f.ShowInTaskbar = $false; $f.StartPosition = 'Manual'
$f.Size = Sz 364 136; $f.BackColor = $bg
$wa = [Windows.Forms.Screen]::PrimaryScreen.WorkingArea
# Stacking: each popup's title carries its start time; newest sits at the bottom, older ones above it, like native toasts.
$born = [DateTime]::UtcNow.Ticks
$f.Text = "cc-finish-notify|$born"
# At most 3 show; older ones wait hidden (timer paused) and return when a newer one closes.
function Place {
  $slot = @([Win]::Titles('cc-finish-notify|') | Where-Object { [long]($_.Split('|')[1]) -gt $born }).Count
  if ($slot -ge 3) { if ($f.Visible) { $f.Visible = $false }; if ($timer) { $timer.Stop() }; return }
  $f.Location = New-Object Drawing.Point(($wa.Right - $f.Width - (S 12)), ($wa.Bottom - ($f.Height + (S 12)) * ($slot + 1)))
  if (-not $f.Visible) { $f.Visible = $true }
  if ($timer -and -not $timer.Enabled) { $timer.Start() }
}
Place
$f.Add_Shown({ Place })
$f.Add_Paint({ $edge = New-Object Drawing.Pen($btn); $_.Graphics.DrawRectangle($edge, 0, 0, $f.Width - 1, $f.Height - 1) })

$focus = {
  if ($term -ne [IntPtr]::Zero) {
    if ($isWT -and $conPid) { try { Select-Tab } catch {} }
    if ([Win]::IsIconic($term)) { [Win]::ShowWindow($term, 9) | Out-Null }
    [Win]::SetForegroundWindow($term) | Out-Null
  }
  $f.Close()
}
$icon = New-Object Windows.Forms.PictureBox -Property @{ Image = $bmp; Location = (Pt 16 16); Size = New-Object Drawing.Size($px, $px); BackColor = [Drawing.Color]::Transparent; Cursor = 'Hand' }
$app = Lbl 'Claude Code' (New-Object Drawing.Font('Segoe UI', 8.5)) $dim 64 12 280 16
$title = Lbl $env:CC_TITLE (New-Object Drawing.Font('Segoe UI Semibold', 11)) $ink 64 28 284 22
$body = Lbl $env:CC_BODY (New-Object Drawing.Font('Segoe UI', 9)) $dim 64 52 284 36
$go = Btn 'Focus terminal' 16 332 $accent $accentHot
$go.Add_Click($focus)
# Clicking anywhere else on the toast dismisses it.
foreach ($el in $f, $icon, $app, $title, $body) { $el.Add_Click({ $f.Close() }) }
$f.Controls.AddRange(@($icon, $app, $title, $body, $go))

$restack = New-Object Windows.Forms.Timer -Property @{ Interval = 250 }
$restack.Add_Tick({ Place }); $restack.Start()
$timer = New-Object Windows.Forms.Timer -Property @{ Interval = 20000 }
$timer.Add_Tick({ $f.Close() })
[Windows.Forms.Application]::Run($f)
`

export const register: Register = on => {
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId === undefined && !e.isAborted) {
      const cwd = await $.session.cwd()
      const project = cwd.split(/[\\/]/).filter(Boolean).pop() ?? 'Claude'
      const prefix = e.reason === 'answer' ? '' : `Stopped (${e.reason}): `
      const flat = prefix + e.answer.replace(/\s+/g, ' ').trim()
      const body = flat.length > 100 ? flat.slice(0, 99) + '…' : flat // two lines in the popup

      // not awaited: the popup lives until clicked or its 20 s timer
      void $.process
        .run(['powershell', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', 'iex $env:CC_PS'], {
          env: { CC_PS: SCRIPT, CC_TITLE: project, CC_CWD: cwd, CC_BODY: body },
          timeoutMs: 30000,
        })
        .catch(() => {})
    }

    return done
  })
}
