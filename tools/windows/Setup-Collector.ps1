param(
  [Parameter(Mandatory=$true)][string]$EcsHost,
  [Parameter(Mandatory=$true)][string]$VerifiedHostKey,
  [string]$GitRoot='D:\Git\Git',
  [string]$OpenCliRoot='C:\nvm4w\nodejs\node_modules\@jackwener\opencli'
)
$ErrorActionPreference='Stop'
if($EcsHost -notmatch '^[a-zA-Z0-9.-]+$'){throw 'Invalid ECS host'}
if($VerifiedHostKey -notmatch '^ssh-ed25519 [A-Za-z0-9+/=]+$'){throw 'Use the server public key verified through the existing authorized connection'}
$root=Join-Path $env:LOCALAPPDATA 'QuietRiverCollector'
New-Item -ItemType Directory -Force $root | Out-Null
$ssh=Join-Path $GitRoot 'usr\bin\ssh.exe'
$keygen=Join-Path $GitRoot 'usr\bin\ssh-keygen.exe'
$cli=Join-Path $OpenCliRoot 'dist\src\main.js'
foreach($p in @($ssh,$keygen,$cli)){if(!(Test-Path $p)){throw ('Missing runtime: '+$p)}}
$key=Join-Path $root 'collector_ed25519'
$proxyKey=Join-Path $root 'proxy_tunnel_ed25519'
foreach($spec in @(@($key,'quiet-river-Shervin'),@($proxyKey,'quiet-river-proxy-tunnel'))){
  if(!(Test-Path $spec[0])){
    & $keygen -t ed25519 -N '""' -C $spec[1] -f $spec[0]
    if($LASTEXITCODE -ne 0){throw 'Dedicated key creation failed'}
  }
}
$utf8=New-Object System.Text.UTF8Encoding($false)
$known=Join-Path $root 'known_hosts'
$line=$EcsHost+' '+$VerifiedHostKey+"`n"
if((Test-Path $known) -and ([IO.File]::ReadAllText($known) -ne $line)){throw 'Existing server key differs; reverify it, do not disable SSH verification'}
[IO.File]::WriteAllText($known,$line,$utf8)
$config=Join-Path $root 'config.json'
$value=@{host=$EcsHost;port=22;user='qr-collector';identityFile=$key;knownHostsFile=$known;ssh=$ssh;opencliMain=$cli;profile=''}
if(Test-Path $config){Copy-Item $config ($config+'.before-'+(Get-Date -Format 'yyyyMMddHHmmss'))}
[IO.File]::WriteAllText($config,($value|ConvertTo-Json),$utf8)
icacls $root /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
if($LASTEXITCODE -ne 0){throw 'Could not restrict collector folder permissions'}
Write-Output 'Collector configured. Existing project, browser cookies and user SSH config were not changed.'
Write-Output 'Register these PUBLIC keys on ECS; private keys stay on Windows:'
Write-Output 'Collector ingestion key:'
Get-Content ($key+'.pub')
Write-Output 'Restricted reverse-proxy tunnel key:'
Get-Content ($proxyKey+'.pub')
Write-Output 'Then run Check-Connection.cmd, Sync-Now.cmd or Start-Watch.cmd.'
