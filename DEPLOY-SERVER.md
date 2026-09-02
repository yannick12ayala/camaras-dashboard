# Despliegue en el servidor propio (coin-server)

Dashboard privado en la red interna de la Municipalidad. Se accede por
`http://172.22.130.170` con usuario y contraseña. Los datos (Excel) se guardan
en disco en el servidor; una tarea de Windows los actualiza.

```
PC Windows (Excel de OneDrive)  --POST /api/upload-->  coin-server (Docker)  <--http--  navegadores autorizados (login)
```

## 1. En el servidor (por SSH)

```bash
ssh yannick@172.22.130.170

# Clonar el repo
git clone https://github.com/yannick12ayala/camaras-dashboard.git
cd camaras-dashboard

# Crear el archivo de secretos (NO se sube al repo)
cat > .env <<'EOF'
UPLOAD_SECRET=FXmbbIb3t0pdEVDrZvkiOPHszCMmni9MTbhjB25PbI
VIEW_USER=camaras
VIEW_PASS=CAMBIA-ESTA-CLAVE
EOF

# Levantar el contenedor
docker compose up -d --build

# Ver que quedó corriendo
docker compose ps
docker compose logs --tail=20
```

El dashboard queda en **http://172.22.130.170** (puerto 80). Al entrar pide
usuario/clave (los de `.env`).

### Actualizar el dashboard más adelante
```bash
cd ~/camaras-dashboard && git pull && docker compose up -d --build
```

## 2. En la PC Windows (subir el Excel, sin Power Automate)

1. Editá `push_camaras.ps1` y ajustá las 3 líneas:
   - `$Excel`  → la ruta REAL del Excel sincronizado por OneDrive.
   - `$Server` → `http://172.22.130.170/api/upload` (ya está).
   - `$Secret` → el mismo `UPLOAD_SECRET` del `.env`.
2. Probalo a mano una vez (PowerShell):
   ```powershell
   powershell -ExecutionPolicy Bypass -File "C:\ruta\push_camaras.ps1"
   ```
   Tiene que decir `subido OK: NNNN bytes`.
3. Programalo cada 15 min (PowerShell como admin):
   ```powershell
   $accion  = New-ScheduledTaskAction -Execute "powershell.exe" -Argument '-ExecutionPolicy Bypass -File "C:\ruta\push_camaras.ps1"'
   $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 15)
   Register-ScheduledTask -TaskName "Camaras - subir Excel" -Action $accion -Trigger $trigger -Description "Sube el Excel al dashboard"
   ```

## Notas
- **Solo red interna:** el dashboard no se ve desde internet; entra solo quien
  esté en la red municipal y tenga la clave.
- **Persistencia:** el Excel vive en `~/camaras-dashboard/data/camaras.xlsx`.
- **Cambiar la clave / usuarios:** editá `.env` y `docker compose up -d`.
- **Respaldo manual:** el dashboard mantiene el botón "Cargar archivo manual"
  (lee un Excel local solo en tu navegador, sin tocar el servidor).
