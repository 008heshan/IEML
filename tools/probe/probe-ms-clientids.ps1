# Which public client_id (application id) can actually drive the Microsoft
# device-code flow?  Ask the live endpoint, one candidate at a time.
#
# NOTE: ASCII-only on purpose. PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
#       which corrupts non-ASCII literals and turns them into parse errors.
#
# Background: the launcher used to hard-code 00000000402b5328 (the id the
# official Minecraft launcher shipped with). A later round measured
# AADSTS700016 for it and switched to "user supplies their own id". The user
# then asked for that exact id back. So: measure again, do not argue from
# memory. This script prints the raw answer for every candidate.
$ErrorActionPreference = 'Stop'

$candidates = @(
  @{ id = '00000000402b5328';                 who = 'official Minecraft launcher (what the user asked for)' }
  @{ id = 'c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb'; who = 'Prism Launcher (public)' }
  @{ id = '6b2f7b41-5b3a-4a3f-9a1e-0f2b6d3c8e11'; who = 'deliberately bogus (control)' }
)

$scope = 'XboxLive.signin offline_access'
$tenants = @('consumers', 'common')

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

foreach ($t in $tenants) {
  foreach ($c in $candidates) {
    $url = "https://login.microsoftonline.com/$t/oauth2/v2.0/devicecode"
    Write-Host "=== tenant=$t  client_id=$($c.id)"
    Write-Host "    ($($c.who))"
    $r = Post-Form $url @{ client_id = $c.id; scope = $scope }
    Write-Host "    HTTP $($r.status)"
    $j = $null; try { $j = $r.text | ConvertFrom-Json } catch {}
    if ($j -and $j.user_code) {
      Write-Host "    ACCEPTED  user_code=$($j.user_code)  uri=$($j.verification_uri)  expires=$($j.expires_in)s"
    } elseif ($j -and $j.error) {
      Write-Host "    REJECTED  error=$($j.error)"
      Write-Host "              $($j.error_description)"
    } else {
      Write-Host "    RAW: $($r.text)"
    }
    Write-Host ''
  }
}
