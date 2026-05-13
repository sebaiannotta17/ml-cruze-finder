# ========================================================
#  Mini servidor estático (sólo PowerShell + .NET)
#  Sirve los archivos de esta carpeta en http://127.0.0.1:5500/
#  No requiere instalar Python, Node ni nada.
# ========================================================

$port = 5500
$root = $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }

$prefix = "http://127.0.0.1:$port/"
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($prefix)

try {
    $listener.Start()
} catch {
    Write-Host "ERROR: no se pudo iniciar el listener en $prefix" -ForegroundColor Red
    Write-Host "Probá ejecutar PowerShell como administrador o cambiá el puerto." -ForegroundColor Yellow
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "  Cruze LTZ Finder" -ForegroundColor Cyan
Write-Host "  Servidor activo en: $prefix" -ForegroundColor Green
Write-Host "  Sirviendo archivos desde: $root" -ForegroundColor DarkGray
Write-Host "  Presioná Ctrl+C para detener." -ForegroundColor DarkGray
Write-Host ""

# Intentar abrir el navegador automáticamente
Start-Process $prefix | Out-Null

$mime = @{
    ".html" = "text/html; charset=utf-8"
    ".htm"  = "text/html; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".mjs"  = "application/javascript; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".png"  = "image/png"
    ".jpg"  = "image/jpeg"
    ".jpeg" = "image/jpeg"
    ".gif"  = "image/gif"
    ".svg"  = "image/svg+xml"
    ".webp" = "image/webp"
    ".ico"  = "image/x-icon"
    ".woff" = "font/woff"
    ".woff2"= "font/woff2"
    ".txt"  = "text/plain; charset=utf-8"
    ".md"   = "text/markdown; charset=utf-8"
}

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $req = $context.Request
        $res = $context.Response

        $local = [System.Web.HttpUtility]::UrlDecode($req.Url.LocalPath)
        if ([string]::IsNullOrEmpty($local) -or $local -eq "/") { $local = "/index.html" }

        # Sanitizar para evitar path traversal
        $clean = $local -replace '\\','/' -replace '\.\.',''
        $filePath = Join-Path $root $clean.TrimStart('/')

        Write-Host ("[{0}] {1} {2}" -f (Get-Date -Format "HH:mm:ss"), $req.HttpMethod, $local) -ForegroundColor DarkGray

        if (Test-Path $filePath -PathType Leaf) {
            $bytes = [System.IO.File]::ReadAllBytes($filePath)
            $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
            $ct  = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { "application/octet-stream" }
            $res.ContentType = $ct
            $res.ContentLength64 = $bytes.Length
            $res.Headers.Add("Cache-Control", "no-cache")
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $res.StatusCode = 404
            $msg = [System.Text.Encoding]::UTF8.GetBytes("404 - $local")
            $res.ContentType = "text/plain; charset=utf-8"
            $res.ContentLength64 = $msg.Length
            $res.OutputStream.Write($msg, 0, $msg.Length)
        }

        $res.Close()
    }
} finally {
    $listener.Stop()
    $listener.Close()
    Write-Host "Servidor detenido." -ForegroundColor Yellow
}
