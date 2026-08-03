# Dashboard Proyecto Cámaras V — Municipalidad de Pilar

Dashboard de seguimiento de instalación de cámaras. Los datos salen de un
Excel en OneDrive; **Power Automate** los empuja a **Vercel**, y el dashboard
los lee desde el mismo dominio. No hay tokens ni links privados en el código
del cliente.

## Arquitectura

```
Excel en OneDrive
      │  (Power Automate: "Get file content")
      ▼
POST https://<tu-proyecto>.vercel.app/api/upload
      │  header  x-upload-secret: <UPLOAD_SECRET>
      │  body    = el .xlsx
      ▼
Vercel Blob  (guarda camaras/data.xlsx)
      ▲
      │  GET /api/data   (mismo origen, sin caché)
      │
Dashboard (index.html)  →  lo parsea con SheetJS y dibuja todo
```

- **`index.html`** — el dashboard (diseño sin cambios). Lee `/api/data`.
- **`api/upload.js`** — recibe el Excel de Power Automate (protegido por secreto) y lo guarda en Blob.
- **`api/data.js`** — devuelve el último Excel guardado.
- Fallback manual: el botón **"Cargar archivo manual"** sigue funcionando sin backend.

## Puesta en marcha (una sola vez)

### 1. Subir a GitHub
Este proyecto ya es un repo git. Creá un repo en GitHub y subilo (ver más abajo).

### 2. Importar en Vercel
1. Entrá a <https://vercel.com/new> e importá el repo de GitHub.
2. Framework preset: **Other**. Dejá todo por defecto y deployá.

### 3. Crear el Blob Store
1. En el proyecto de Vercel: **Storage → Create Database → Blob**.
2. Al conectarlo, Vercel agrega solo la variable `BLOB_READ_WRITE_TOKEN`. No hace falta tocarla.

### 4. Configurar el secreto de subida
1. **Settings → Environment Variables → Add New**.
2. Nombre: `UPLOAD_SECRET`  ·  Valor: un texto largo y aleatorio (guardalo, lo vas a usar en Power Automate).
3. Aplicá a *Production* (y *Preview* si querés). **Redeploy** para que tome la variable.

### 5. Armar el flujo de Power Automate
Flujo recomendado: **"When a file is modified" (OneDrive for Business)** apuntando al Excel, o un **Recurrence** (ej. cada 15 min).

Pasos del flujo:
1. **Get file content** (OneDrive for Business) → seleccioná el Excel. Salida: *File Content*.
2. **HTTP** (acción premium):
   - **Method:** `POST`
   - **URI:** `https://<tu-proyecto>.vercel.app/api/upload`
   - **Headers:**
     - `x-upload-secret` : `<el mismo UPLOAD_SECRET del paso 4>`
     - `Content-Type` : `application/json`
   - **Body:** JSON con el contenido del archivo en base64 (una expresión):
     ```
     { "b64": "@{body('Obtener_contenido_de_archivo')?['$content']}" }
     ```
3. Guardá y probá con **Test → Manually**. Debe responder `200` con `{ "ok": true, ... }`.

> **Importante — por qué así:** Power Automate representa el archivo como
> `{"$content-type": "...", "$content": "<base64>"}`. Si se manda como binario
> (`application/octet-stream`) o sin `Content-Type`, el runtime de Vercel no
> bufferea el cuerpo y llega vacío (400 "El cuerpo está vacío"). Mandándolo como
> **JSON** con el base64 en `b64`, Vercel lo parsea y el endpoint lo decodifica.
> El endpoint `/api/upload` acepta además `$content` y `content` como campos
> equivalentes, por robustez.

> **Nota:** la acción *HTTP* es un conector premium de Power Automate. Si no
> tenés licencia premium, avisá y vemos una alternativa (que Vercel lea el
> OneDrive del lado del servidor, o subir el Excel con un pequeño script).

### 6. Listo
Abrí `https://<tu-proyecto>.vercel.app`. Cada vez que Power Automate corra,
el dashboard mostrará los datos nuevos (botón **Actualizar** para refrescar).

## Estructura del Excel esperada

El dashboard busca (por nombre aproximado de columna) en la **primera hoja**:
`Conectividad`, `ISP`, `MB`, `Localidad`, `Relevado`, `Instalación de gabinete`,
tipo de cámara (fijas / LPR / domos), coordenadas (lat/lon), fechas de
gabinete/columna/cámara y `pdfUrl`. Una hoja opcional **"Observaciones"**
alimenta el feed de comentarios.

## Desarrollo local (opcional)

```bash
npm i -g vercel
vercel dev
```

Requiere las variables de entorno cargadas (`vercel env pull`).
