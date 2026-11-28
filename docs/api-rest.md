# API REST

Servidor HTTP propio (`src/api`) sobre la capa de persistencia. Con `DATABASE_URL` guarda en PostgreSQL;
sin ella (solo fuera de producción) usa memoria.

```powershell
npm run api:dev          # http://127.0.0.1:3000
```

## Seguridad

- Todas las rutas, salvo `GET /health`, `POST /api/auth/login` y `POST /api/auth/register`, exigen una sesión de usuario:
  `Authorization: Bearer <token>` (el token lo entrega el inicio de sesión). Sin sesión, cualquier ruta responde 401.
- Cada ruta de empresa comprueba el rol del usuario **en esa empresa** (ver [usuarios-y-permisos.md](usuarios-y-permisos.md)).
  Quien no es miembro recibe 404, como si la empresa no existiera; un miembro sin permiso recibe 403.
- Quién cerró o reabrió un período se toma de la sesión, no del cuerpo de la solicitud.
- Fuera de localhost, publica la API solo detrás de HTTPS: el token viaja en cada solicitud.
- Las credenciales SOL nunca se aceptan ni se devuelven por la API (`hasSolCredentials` indica si existen).
- El certificado digital se carga en el servidor (`SUNAT_CERT_PATH`); nunca viaja en una solicitud.
  En producción no se firma sin certificado propio.
- El envío a SUNAT está apagado por defecto (`SUNAT_SEND_ENABLED=false`).
- Los errores internos responden `500 INTERNAL_ERROR` sin detalles; el detalle queda en el log del servidor.
- `API_BEARER_TOKEN` (token compartido) ya no se usa.

## Errores

```json
{ "error": { "code": "DUPLICATE_PURCHASE", "message": "..." } }
```

| Estado | Cuándo |
| --- | --- |
| 400 `INVALID_INPUT` | Estructura o formato inválido (campo faltante, código fuera de catálogo, período) |
| 401 `UNAUTHORIZED` / `INVALID_CREDENTIALS` | Sin sesión, sesión vencida o revocada, cuenta desactivada; correo o contraseña incorrectos |
| 403 `FORBIDDEN` | Tu rol en la empresa no permite la acción |
| 404 | Empresa, comprobante, compra o asiento inexistente, de otra empresa o de una empresa de la que no eres miembro |
| 409 | Duplicado, período cerrado, cambio concurrente, envío SUNAT desactivado, último titular (`LAST_OWNER`) |
| 429 `TOO_MANY_ATTEMPTS` | Demasiados inicios de sesión fallidos (cabecera `Retry-After`) |
| 422 | Regla tributaria o contable incumplida (RUC inválido, asiento descuadrado) |
| 503 `CERTIFICATE_NOT_CONFIGURED` | Falta el certificado del servidor |

## Rutas

### Sesión

| Método y ruta | Qué hace |
| --- | --- |
| `POST /api/auth/login` | `{ email, password }` → `{ token, tokenType, expiresAt, user }`. 5 fallos por correo (o 30 por IP) en 15 min bloquean nuevos intentos |
| `POST /api/auth/logout` | Revoca la sesión actual |
| `GET /api/auth/me` | Usuario y empresas a las que tiene acceso, con rol y permisos |
| `POST /api/auth/password` | `{ currentPassword, newPassword }`; cierra las demás sesiones del usuario |
| `POST /api/auth/register` | `{ email, fullName, password }`. Solo si `API_ALLOW_SIGNUP=true` |

Las sesiones duran `API_SESSION_TTL_HOURS` (12 h por defecto). En la base solo se guarda el SHA-256 del token.

### Miembros de una empresa

| Método y ruta | Permiso |
| --- | --- |
| `GET /api/companies/:companyId/members` | `members:read` |
| `GET /api/companies/:companyId/members/events` | `members:read` (historial de altas, cambios y bajas) |
| `POST /api/companies/:companyId/members` | `members:manage` · `{ email, role }`; el usuario debe tener cuenta |
| `PATCH /api/companies/:companyId/members/:userId` | `members:manage` · `{ role }` |
| `DELETE /api/companies/:companyId/members/:userId` | `members:manage`, o cualquier miembro para retirarse a sí mismo |

### Empresas

`GET /api/companies` lista solo las empresas de las que el usuario es miembro, con su rol.
`POST /api/companies` lo puede usar cualquier usuario autenticado y lo deja como titular.

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/api/companies?active=true` | Listar |
| POST | `/api/companies` | Registrar (crea series por defecto según régimen) |
| GET | `/api/companies/:companyId` | Detalle |
| PATCH | `/api/companies/:companyId` | Actualizar datos comerciales y de domicilio |
| GET / POST | `/api/companies/:companyId/series` | Listar / crear series |

### Comprobantes electrónicos (01, 03, 07)

| Método | Ruta | Descripción |
| --- | --- | --- |
| POST | `/api/companies/:companyId/cpe` | Emitir: cálculo, UBL 2.1, firma, ZIP, guardado |
| GET | `/api/companies/:companyId/cpe?cpeType&series&status&startDate&endDate&clientDocNumber&limit&offset` | Listar (máx. 200 por página) |
| GET | `/api/companies/:companyId/cpe/:cpeId` | Detalle con ítems |

```json
POST /api/companies/{id}/cpe
{
  "cpeType": "03",
  "series": "B001",
  "client": { "docType": "1", "docNumber": "45678912", "name": "CLIENTE FINAL" },
  "paymentMethod": "CONTADO",
  "items": [
    { "description": "Producto", "quantity": 2, "unitPrice": "59.00", "priceIncludesIgv": true, "affectationType": "10" }
  ],
  "options": { "returnFiles": ["pdf", "xml"], "validateXsd": true }
}
```

Sin `issueDate`/`issueTime` se usa la fecha y hora de Lima. `returnFiles` admite `xml`, `zip`, `pdf`, `ticket`, `cdr`
(binarios en Base64). La nota de crédito (07) exige `creditNoteInfo`.

### Compras (RCE)

| Método | Ruta | Descripción |
| --- | --- | --- |
| POST | `/api/companies/:companyId/purchases` | Registrar (409 si el comprobante ya existe) |
| GET | `/api/companies/:companyId/purchases?period=YYYY-MM` | Listar el período |
| GET | `/api/companies/:companyId/purchases/summary?period=YYYY-MM` | Resumen mensual |
| GET | `/api/companies/:companyId/purchases/:car` | Detalle por CAR |
| PATCH | `/api/companies/:companyId/purchases/:car/sire-status` | `{ "status": "ACEPTADO" }` |

La empresa compradora siempre es la de la ruta; un `companyRuc` en el cuerpo se ignora.

### Contabilidad

| Método | Ruta | Descripción |
| --- | --- | --- |
| POST | `/api/companies/:companyId/journal-entries` | Asiento (`status: "DRAFT"` o `"PENDING"` para borrador) |
| GET | `/api/companies/:companyId/journal-entries?period=YYYY-MM` | Libro Diario del período |
| POST | `/api/companies/:companyId/journal-entries/:entryId/post` | Contabilizar borrador |
| GET | `/api/companies/:companyId/periods/:period` | Estado del período |
| POST | `/api/companies/:companyId/periods/:period/close` | Cierre mensual |
| POST | `/api/companies/:companyId/periods/:period/reopen` | Reapertura (`reopenedBy`, `reason` obligatorios) |
| GET | `/api/companies/:companyId/trial-balance?period=YYYY-MM` | Balance de comprobación |
| GET | `/api/companies/:companyId/general-ledger?period=YYYY-MM` | Libro Mayor |
| POST | `/api/accounting/annual-close/preview` / `confirm` | Cierre anual (sin cambios) |
