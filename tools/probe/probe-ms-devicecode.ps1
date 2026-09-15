# Verify the Microsoft device-code PROTOCOL REQUEST SHAPE against the live endpoint.
#
# NOTE: this file is ASCII-only on purpose. PowerShell 5.1 reads BOM-less .ps1 as
#       ANSI, which corrupts non-ASCII literals and turns them into parse errors.
#       (Same trap tools/deploy-desktop.ps1 documents at its top.)
#
# WHY: the auth module cannot be fully exercised without a human completing the
#      browser consent. But the *request shape* (URL + form fields) can be: send
#      it with a real, registered public client id and see whether Microsoft
#      accepts it (HTTP 200 + real device_code/user_code) or rejects it as
#      malformed (HTTP 400 + invalid_request).
#
# The client id below is Prism Launcher's public application id, from their
# CMakeLists.txt (GPL-3.0). Used here ONLY as a probe, never shipped.
$ErrorActionPreference = 'Stop'
$cid = 'c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb'   # Prism Launcher, public
$scope = 'XboxLive.signin offline_access'
$deviceCodeUrl = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode'
$tokenUrl = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token'

# POST that survives non-2xx and always hands back (status, body)
function Post-Form([string]$url, $form) {
  $body = ($form.GetEnumerator() | ForEach-Object {
    "$([uri]::EscapeDataString($_.Key))=$([uri]::EscapeDataString([string]$_.Value))"
  }) -join '&'
  $req = [System.Net.HttpWebRequest]::Create($url)
  $req.Method = 'POST'
  $req.ContentType = 'application/x-www-form-urlencoded'
  $req.Timeout = 40000
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  $req.ContentLength = $bytes.Length
  $s = $req.GetRequestStream(); $s.Write($bytes, 0, $bytes.Length); $s.Close()
  try {
    $resp = $req.GetResponse()
    $code = [int]$resp.StatusCode
    $text = (New-Object System.IO.StreamReader($resp.GetResponseStream())).ReadToEnd()
    $resp.Close()
  } catch [System.Net.WebException] {
    $resp = $_.Exception.Response
    if (-not $resp) { return @{ status = 0; text = $_.Exception.Message } }
    $code = [int]$resp.StatusCode
    $text = (New-Object System.IO.StreamReader($resp.GetResponseStream())).ReadToEnd()
    $resp.Close()
  }
  return @{ status = $code; text = $text }
}

function Get-DeviceCode {
  $r = Post-Form $deviceCodeUrl @{ client_id = $cid; scope = $scope }
  if ($r.status -ne 200) { throw "devicecode endpoint returned $($r.status): $($r.text)" }
  return $r.text | ConvertFrom-Json
}

Write-Host '=== (A) devicecode endpoint: client_id + scope (PCL / HMCL / IEML shape) ==='
$dc = Get-DeviceCode
Write-Host "  HTTP 200"
Write-Host "  user_code       : $($dc.user_code)"
Write-Host "  verification_uri: $($dc.verification_uri)"
Write-Host "  expires_in      : $($dc.expires_in)"
Write-Host "  interval        : $($dc.interval)"
Write-Host "  device_code len : $($dc.device_code.Length)"
Write-Host '  -> Microsoft accepted our request shape and issued a real device code.'

Write-Host ''
Write-Host '=== (B) token endpoint: must ACCEPT our field set ==='
# Always use a FRESH device code: a device code is consumed the moment it is
# exchanged, so reusing one turns "already consumed" into a false "bad format".
$dc2 = Get-DeviceCode
$rB = Post-Form $tokenUrl @{
  client_id   = $cid
  grant_type  = 'urn:ietf:params:oauth:grant-type:device_code'
  device_code = $dc2.device_code
  scope       = $scope
}
Write-Host "  HTTP $($rB.status)"
Write-Host "  $($rB.text)"
$jB = $null; try { $jB = $rB.text | ConvertFrom-Json } catch {}
$okB = ($jB -and $jB.error -eq 'authorization_pending')
Write-Host ''
if ($okB) {
  Write-Host '  OK: Microsoft parsed and accepted our field set.'
  Write-Host '      authorization_pending means "request understood, user has not consented yet".'
  Write-Host '      It is NOT invalid_request, so client_id/grant_type/device_code/scope are all valid.'
} else {
  Write-Host "  FAIL: expected authorization_pending, got error='$($jB.error)'"
}

Write-Host ''
Write-Host '=== (C) control: a request missing fields MUST be rejected ==='
$rC = Post-Form $tokenUrl @{ client_id = $cid }
Write-Host "  HTTP $($rC.status)"
Write-Host "  $($rC.text)"
$jC = $null; try { $jC = $rC.text | ConvertFrom-Json } catch {}
$okC = ($rC.status -ge 400)
Write-Host ''
if ($okC) {
  Write-Host "  OK: control rejected (error='$($jC.error)') -> (B) is meaningful."
} else {
  Write-Host '  FAIL: control succeeded, so (B) proves nothing.'
}

Write-Host ''
if ($okB -and $okC) {
  Write-Host 'PASS: the Microsoft login request shape is verified against the live endpoint'
  exit 0
}
Write-Host 'FAIL: some check did not pass'
exit 1
