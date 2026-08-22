<#
.SYNOPSIS
    Checks the Windows side of the Home CSI toolchain.

.DESCRIPTION
    The Windows half of the bring-up problem is different from the Linux half,
    so this is not a translation of doctor.sh. It checks the things only
    Windows can see: the USB serial bridge, its driver architecture, COM port
    visibility, usbipd-win, WSL2, and a native esptool for the
    "build in Linux, flash from Windows" path (bringup/README.md Option C).

    Like doctor.sh, it never merely fails: every problem prints the next
    command to run.

.PARAMETER Port
    Also probe this COM port with esptool chip_id, e.g. -Port COM5.

.EXAMPLE
    .\doctor.ps1
    .\doctor.ps1 -Port COM5
#>
[CmdletBinding()]
param(
    [string]$Port
)

$script:Pass = 0
$script:Warn = 0
$script:Fail = 0

function Write-Ok   ($m) { Write-Host "  [ ok ] $m" -ForegroundColor Green;  $script:Pass++ }
function Write-Warn ($m, $fix) {
    Write-Host "  [warn] $m" -ForegroundColor Yellow; $script:Warn++
    if ($fix) { Write-Host "         -> $fix" }
}
function Write-Bad  ($m, $fix) {
    Write-Host "  [FAIL] $m" -ForegroundColor Red; $script:Fail++
    if ($fix) { Write-Host "         -> $fix" }
}
function Write-Head ($m) { Write-Host ""; Write-Host $m -ForegroundColor Cyan }

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

Write-Host "Home CSI toolchain doctor (Windows)" -ForegroundColor Cyan
Write-Host ("  OS  : {0}" -f [System.Environment]::OSVersion.VersionString)
# PROCESSOR_ARCHITECTURE reports the *process* architecture, which lies when
# PowerShell itself is running x64-emulated on an ARM64 machine. OSArchitecture
# is the machine truth, and the machine is what decides whether ESP-IDF has a
# native toolchain.
$osArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
Write-Host ("  Arch: {0} (process: {1})" -f $osArch, $env:PROCESSOR_ARCHITECTURE)

# ------------------------------------------------------------------ platform
Write-Head "Platform"

if ("$osArch" -eq 'Arm64') {
    Write-Ok "Windows on ARM64"
    Write-Host "         Note: ESP-IDF has no native Windows-ARM64 support. Build in"
    Write-Host "         WSL2 (linux-arm64 IDF) or Docker; flash from here. See"
    Write-Host "         bringup/README.md Step 1."
} else {
    Write-Ok "Windows on $osArch"
}

# ----------------------------------------------------------------- Python
Write-Head "Python and esptool (needed for the flash-from-Windows path)"

$py = Get-Command python -ErrorAction SilentlyContinue
if ($py) {
    Write-Ok ("python: " + (& python --version 2>&1))
} else {
    Write-Bad "python not on PATH" "Install Python 3 for Windows (ARM64 build) from python.org, and tick 'Add to PATH'"
}

if ($py) {
    & python -c "import esptool" 2>$null
    if ($LASTEXITCODE -eq 0) {
        $ver = (& python -m esptool version 2>&1 | Select-Object -First 1)
        Write-Ok "esptool importable: $ver"
    } else {
        Write-Warn "esptool not installed for this Python" "pip install esptool   (this is what makes Option C work)"
    }
}

# --------------------------------------------------------------------- WSL2
Write-Head "WSL2"

$wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
if ($wsl) {
    $distros = (& wsl.exe -l -q 2>$null) -replace "`0", "" | Where-Object { $_.Trim() -ne "" }
    if ($distros) {
        Write-Ok ("WSL distributions: " + ($distros -join ", "))
        Write-Host "         Run bringup/doctor.sh INSIDE the distro to check ESP-IDF itself."
    } else {
        Write-Warn "WSL is installed but has no distributions" "wsl --install -d Ubuntu"
    }
} else {
    Write-Warn "WSL not installed" "wsl --install -d Ubuntu   (or use the Docker path, bringup/README.md Option B)"
}

$docker = Get-Command docker -ErrorAction SilentlyContinue
if ($docker) {
    Write-Ok "docker present (usable for BUILDING only)"
    Write-Host "         Docker Desktop on Windows cannot pass a COM port into a"
    Write-Host "         Linux container. Build in Docker, flash from Windows."
} else {
    Write-Host "  [info] docker not installed (only needed for README Option B)"
}

# ------------------------------------------------------------------ usbipd
Write-Head "USB passthrough (only needed if you flash from inside WSL2)"

$usbipd = Get-Command usbipd -ErrorAction SilentlyContinue
if ($usbipd) {
    Write-Ok "usbipd-win installed"
    try {
        $list = & usbipd list 2>&1
        $serial = $list | Select-String -Pattern "1a86|10c4|0403|CH34|CP210|FTDI|Serial" -CaseSensitive:$false
        if ($serial) {
            Write-Ok "usbipd sees a candidate serial device:"
            $serial | ForEach-Object { Write-Host "           $_" }
            Write-Host "         Attach with: usbipd bind --busid X-Y   (Administrator)"
            Write-Host "                      usbipd attach --wsl --busid X-Y"
        } else {
            Write-Warn "usbipd lists no obvious USB-serial device" "Plug the board in and re-run, or check the cable is a DATA cable"
        }
    } catch {
        Write-Warn "usbipd list failed" $_.Exception.Message
    }
} else {
    Write-Host "  [info] usbipd-win not installed."
    Write-Host "         Only needed to flash from inside WSL2. The simpler path is to"
    Write-Host "         flash from Windows (README Option C). To install it:"
    Write-Host "           winget install --interactive --exact dorssel.usbipd-win"
}

# -------------------------------------------------------------- serial ports
Write-Head "Serial bridge and COM ports"

$ports = [System.IO.Ports.SerialPort]::GetPortNames()
if ($ports) {
    Write-Ok ("COM ports present: " + ($ports -join ", "))
} else {
    Write-Warn "no COM ports found" "Plug the board in. If Windows shows nothing at all, suspect a charge-only USB cable first"
}

# Known USB-to-UART bridges. VID:PID -> what to install if the driver is bad.
$bridges = @{
    'VID_1A86&PID_7523' = 'WCH CH340/CH341  -> install the ARM64 CH341SER driver'
    'VID_1A86&PID_5523' = 'WCH CH341        -> install the ARM64 CH341SER driver'
    'VID_1A86&PID_55D4' = 'WCH CH9102       -> install the ARM64 CH343SER driver'
    'VID_10C4&PID_EA60' = 'Silicon Labs CP210x -> CP210x Universal Windows Driver (has ARM64)'
    'VID_0403&PID_6001' = 'FTDI FT232R      -> FTDI VCP driver (has ARM64)'
    'VID_0403&PID_6015' = 'FTDI FT231X      -> FTDI VCP driver (has ARM64)'
}

$devices = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
           Where-Object { $_.InstanceId -match 'USB\\VID_' }

$foundBridge = $false
foreach ($d in $devices) {
    foreach ($key in $bridges.Keys) {
        if ($d.InstanceId -like "*$key*") {
            $foundBridge = $true
            if ($d.Status -eq 'OK') {
                Write-Ok ("bridge: {0}  [{1}]" -f $d.FriendlyName, $key)
                Write-Host ("           " + $bridges[$key])
            } else {
                Write-Bad ("bridge present but NOT working: {0} (status {1})" -f $d.FriendlyName, $d.Status) `
                          ("Almost always a wrong-architecture driver on ARM64. Uninstall it (tick 'Attempt to remove the driver'), reboot, then: " + $bridges[$key])
            }
            Write-Host ("           InstanceId: " + $d.InstanceId)
            Write-Host "           Record the VID:PID and driver in the bring-up table."
        }
    }
}

if (-not $foundBridge) {
    Write-Warn "no recognised USB-to-UART bridge found" "Plug the board in. If it enumerates as an unknown device, open Device Manager -> Properties -> Details -> Hardware Ids and match the VID:PID against the table in bringup/README.md Step 2"
}

$problem = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
           Where-Object { $_.Status -ne 'OK' -and $_.Class -in @('Ports','USB') }
foreach ($p in $problem) {
    Write-Warn ("device with a problem: {0} (status {1})" -f $p.FriendlyName, $p.Status) `
               "Check Device Manager for a Code 10 / Code 52, which on ARM64 usually means an x64-only driver"
}

# ------------------------------------------------------------- probe a port
if ($Port) {
    Write-Head "Probing $Port"
    if ($ports -contains $Port) {
        Write-Ok "$Port exists"
        if ($py) {
            Write-Host "         running esptool chip_id ..."
            $out = & python -m esptool --port $Port chip_id 2>&1
            if ($LASTEXITCODE -eq 0) {
                Write-Ok "esptool talked to the board:"
                $out | Select-String -Pattern 'Chip is|Features|MAC:|Crystal' |
                    ForEach-Object { Write-Host "           $_" }
                Write-Host "         Now run flash_id and then the Step 4 BACKUP:" -ForegroundColor Yellow
                Write-Host "           python -m esptool --port $Port flash_id"
                Write-Host "           python -m esptool --port $Port --baud 460800 read_flash 0x0 0x400000 halocode-stock-4MB.bin"
            } else {
                Write-Bad "esptool could not connect on $Port" `
                          "Hold BOOT/IO0, tap EN/RESET, release BOOT, retry. Try --baud 115200. Close any serial monitor or mBlock holding the port."
            }
        } else {
            Write-Warn "cannot probe without python + esptool" "pip install esptool"
        }
    } else {
        Write-Bad "$Port is not in the list of COM ports" "Available: $($ports -join ', ')"
    }
}

# ---------------------------------------------------------------- host tests
Write-Head "Host tests (no hardware needed)"

if (Test-Path (Join-Path $repo 'firmware\tests\run_tests.py')) {
    Write-Ok "firmware/tests/run_tests.py present"
    Write-Host "         cd $repo\firmware\tests; python run_tests.py"
    Write-Host "         (needs a host C compiler; if you have none on Windows,"
    Write-Host "          run them inside WSL2 instead)"
} else {
    Write-Bad "firmware/tests/run_tests.py missing" "Are you running this from inside the repository?"
}

# -------------------------------------------------------------------- summary
Write-Head "Summary"
Write-Host ("  {0} ok, {1} warnings, {2} failures" -f $script:Pass, $script:Warn, $script:Fail)

if ($script:Fail -gt 0) {
    Write-Host ""
    Write-Host "  Blocking problems above. Fix the [FAIL] lines, then re-run." -ForegroundColor Red
    exit 1
}
if ($script:Warn -gt 0) {
    Write-Host ""
    Write-Host "  Usable, with caveats. The [warn] lines will bite you later." -ForegroundColor Yellow
} else {
    Write-Host ""
    Write-Host "  Windows side looks good. Next: bringup/README.md Step 3, then the Step 4 backup." -ForegroundColor Green
}
exit 0
