# push_camaras.ps1
# Lee el Excel sincronizado por OneDrive en esta PC y lo sube al servidor.
# Se ejecuta con una Tarea Programada de Windows (cada 15 min, por ejemplo).
# NO necesita Power Automate.

$ErrorActionPreference = 'Stop'

# === AJUSTAR ESTAS 3 LINEAS ===
$Excel  = "C:\Users\yayala\OneDrive - MUNICIPALIDAD DE PILAR\...\Proyecto Camaras 5 VIGENTE VERSION ACOTADA.xlsx"
$Server = "http://172.22.130.170/api/upload"
$Secret = "FXmbbIb3t0pdEVDrZvkiOPHszCMmni9MTbhjB25PbI"
# ===============================

if (-not (Test-Path $Excel)) { throw "No se encontro el Excel en: $Excel" }

$bytes   = [System.IO.File]::ReadAllBytes($Excel)
$headers = @{ 'x-upload-secret' = $Secret }

$resp = Invoke-RestMethod -Uri $Server -Method Post -Body $bytes -Headers $headers -ContentType 'application/octet-stream'
Write-Output ("[{0}] subido OK: {1} bytes" -f (Get-Date -Format 'yyyy-MM-dd HH:mm'), $resp.size)
