<#
.SYNOPSIS
    Build the Adversaria Windows installer (NSIS) on a Windows machine.

.DESCRIPTION
    The Windows counterpart to scripts/build-dmg.sh. Freezes the Python ML
    service with PyInstaller, then builds the Tauri app; tauri.windows.conf.json
    is merged automatically and selects the NSIS bundle.

    This must run ON Windows. PyInstaller does not cross-compile and NSIS
    bundling is Windows-only, so the installer cannot be produced from the Mac
    release runner.

.PARAMETER Channel
    Updater channel — 'beta' (default) or 'stable'. Selects
    src-tauri/tauri.<channel>.conf.json, which only overrides the updater endpoint.

.PARAMETER BundleCuda
    Bundle the CUDA runtime into the sidecar. OFF by default because the result
    (~2.4 GB) exceeds what NSIS can package — makensis fails with "Internal
    compiler error #12345: error mmapping datablock". Only useful for producing
    a zip-distributed GPU build. See docs/LESSONS_LEARNED.md.

    Without it, transcription runs int8 on CPU, and a machine with the NVIDIA
    CUDA Toolkit installed still gets GPU via _patch_cuda_path().

.PARAMETER SkipGates
    Skip lint/test gates. For iterating locally only — never for a release.

.EXAMPLE
    ./scripts/build-windows.ps1
    ./scripts/build-windows.ps1 -Channel stable
    ./scripts/build-windows.ps1 -SkipGates
#>
[CmdletBinding()]
param(
    [ValidateSet('beta', 'stable')]
    [string]$Channel = 'beta',
    [switch]$BundleCuda,
    [switch]$SkipGates
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Write-Step($message) { Write-Host "`n==> $message" -ForegroundColor Cyan }
function Write-Warn($message) { Write-Host "WARNING: $message" -ForegroundColor Yellow }

# --- Prerequisites ----------------------------------------------------------
Write-Step 'Checking prerequisites'

foreach ($tool in @('cargo', 'rustc', 'node', 'npm', 'uv')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "$tool is not on PATH. See docs/HANDOFF.md 'Building the Windows app'."
    }
}

# rustup must be on an MSVC host: the -gnu triple cannot link the WASAPI/COM
# bindings in src-tauri/src/audio/wasapi.rs.
$hostTriple = (rustc -vV | Select-String '^host:').ToString().Split(' ')[1]
if ($hostTriple -notlike '*-msvc') {
    throw "Rust host is '$hostTriple' — an MSVC host is required. Run: rustup default stable-x86_64-pc-windows-msvc"
}

# rusqlite builds SQLCipher against a vendored OpenSSL, whose Configure script
# is Perl. Git for Windows ships an MSYS perl that is NOT sufficient — it lacks
# Locale::Maketext::Simple and emits POSIX paths, so the build fails deep in
# openssl-sys with a confusing 'perl reported failure with exit code: 2'.
$perl = Get-Command perl -ErrorAction SilentlyContinue
$perlIsMsys = $perl -and ($perl.Source -like '*\Git\*')
if (-not $perl -or $perlIsMsys) {
    $detail = if ($perlIsMsys) { "only Git's MSYS perl was found at $($perl.Source)" } else { 'perl was not found' }
    throw @"
A native Windows Perl is required to build the vendored OpenSSL that SQLCipher
links against, but $detail.

Install Strawberry Perl and open a new shell:
    winget install --id StrawberryPerl.StrawberryPerl --source winget

(NASM is NOT needed — openssl-src configures with 'no-asm'.)
"@
}

# --- Python sidecar ---------------------------------------------------------
$bundleCuda = if ($BundleCuda) { '1' } else { '0' }
if ($BundleCuda) {
    Write-Warn 'Bundling CUDA — the NSIS step is EXPECTED TO FAIL on size (~2.4 GB vs a ~2 GB ceiling).'
}
Write-Step "Syncing Python dependencies (CUDA bundled: $bundleCuda)"
Push-Location python-service
try {
    if ($BundleCuda) { uv sync --frozen --extra dev --extra cuda } else { uv sync --frozen --extra dev }
    if ($LASTEXITCODE -ne 0) { throw 'uv sync failed' }

    if (-not $SkipGates) {
        Write-Step 'Python gates (ruff, pytest)'
        uv run --frozen ruff check .
        if ($LASTEXITCODE -ne 0) { throw 'ruff failed' }
        uv run --frozen pytest -q
        if ($LASTEXITCODE -ne 0) { throw 'pytest failed' }
    }

    Write-Step 'Freezing the ML service sidecar (PyInstaller)'
    $env:ADVERSARIA_BUNDLE_CUDA = $bundleCuda
    uv run --with pyinstaller pyinstaller adversaria-service-windows.spec --noconfirm
    if ($LASTEXITCODE -ne 0) { throw 'PyInstaller failed' }
} finally {
    Pop-Location
}

$sidecar = Join-Path $repoRoot 'python-service\dist\adversaria-service\adversaria-service.exe'
if (-not (Test-Path $sidecar)) { throw "Sidecar missing after freeze: $sidecar" }

# --- Desktop app ------------------------------------------------------------
Write-Step 'Installing frontend dependencies'
npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }

if (-not $SkipGates) {
    Write-Step 'Rust + frontend gates'
    npm run build;   if ($LASTEXITCODE -ne 0) { throw 'frontend build failed' }
    npm test;        if ($LASTEXITCODE -ne 0) { throw 'frontend tests failed' }
    cargo fmt --manifest-path src-tauri/Cargo.toml --check
    if ($LASTEXITCODE -ne 0) { throw 'cargo fmt failed' }
    cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
    if ($LASTEXITCODE -ne 0) { throw 'clippy failed' }
    cargo test --manifest-path src-tauri/Cargo.toml --all-targets
    if ($LASTEXITCODE -ne 0) { throw 'cargo test failed' }
}

# Unset means tauri still builds, but emits no signed updater artifact, so the
# in-app updater has nothing to serve for this release.
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    Write-Warn 'TAURI_SIGNING_PRIVATE_KEY is not set — no signed updater artifact will be produced.'
}

Write-Step "Building the NSIS installer (channel: $Channel)"
npm run tauri build -- --config "src-tauri/tauri.$Channel.conf.json"
if ($LASTEXITCODE -ne 0) { throw 'tauri build failed' }

$nsisDir = Join-Path $repoRoot 'src-tauri\target\release\bundle\nsis'
$installer = Get-ChildItem (Join-Path $nsisDir '*-setup.exe') -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $installer) { throw "No installer found in $nsisDir" }

Write-Host "`nInstaller: $($installer.FullName)" -ForegroundColor Green
Write-Host ("Size:      {0:N0} MB" -f ($installer.Length / 1MB)) -ForegroundColor Green
Write-Host @'

Unsigned builds trigger SmartScreen ("Windows protected your PC" -> More info ->
Run anyway). See docs/HANDOFF.md "Code signing (2026)" for the options.
'@ -ForegroundColor DarkGray
