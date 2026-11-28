# Usuarios y permisos por empresa

Cada solicitud a la API lleva la sesión del usuario y cada ruta de empresa comprueba su rol en esa
empresa (`src/api/http/access.ts`). Rutas de sesión y miembros: [api-rest.md](api-rest.md).

## Modelo

| Tabla (`private`) | Qué guarda |
| --- | --- |
| `app_users` | Correo (normalizado, único), nombre, hash scrypt de la contraseña, activo/inactivo, último ingreso |
| `company_memberships` | Rol de cada usuario **en cada empresa**. Los roles nunca se guardan en el usuario |
| `company_membership_events` | Historial inmutable de altas, cambios de rol y bajas, con quién lo hizo |

Las tablas tienen RLS activado y ningún permiso para `anon`/`authenticated`: solo el servidor accede.

## Roles

| Permiso | Titular | Administrador | Contador | Facturador | Consulta |
| --- | :-: | :-: | :-: | :-: | :-: |
| Ver empresa, series, comprobantes | ✓ | ✓ | ✓ | ✓ | ✓ |
| Ver compras y contabilidad | ✓ | ✓ | ✓ | | ✓ |
| Editar empresa, crear series | ✓ | ✓ | | | |
| Emitir comprobantes / enviar a SUNAT | ✓ | ✓ | | ✓ | |
| Registrar compras y asientos | ✓ | ✓ | ✓ | | |
| Cerrar, reabrir períodos y cierre anual | ✓ | ✓ | ✓ | | |
| Ver y administrar miembros | ✓ | ✓ | | | |

La matriz está en `src/modules/auth/permissions.ts`.

## Reglas de miembros

- Solo Titular y Administrador agregan, cambian o quitan miembros.
- Solo un Titular otorga, cambia o quita el rol de Titular.
- Nadie puede subirse su propio rol; cualquiera puede retirarse.
- La empresa nunca se queda sin Titular, ni siquiera con dos cambios simultáneos
  (la fila de la empresa se bloquea durante el cambio).
- Un usuario desactivado pierde todos sus permisos y no puede iniciar sesión.

## Uso en el servidor

```ts
const access = services.access; // AccessControlService

const user = await access.registerUser({ email, fullName, password });
await access.assignInitialOwner(companyId, user.id);           // al crear la empresa
await access.setMemberRole(user.id, companyId, otroId, "ACCOUNTANT");

await access.authorize(userId, companyId, "cpe:emit");         // lanza AccessDeniedError
const ok = await access.verifyCredentials(email, password);    // usuario o null
```

Contraseñas: mínimo 10 caracteres, hash scrypt con sal (`node:crypto`), comparación en tiempo constante.

## Permiso por ruta

| Rutas | Permiso |
| --- | --- |
| `GET` empresa · `PATCH` empresa | `company:read` · `company:update` |
| `GET` / `POST` series | `series:read` · `series:create` |
| `GET` comprobantes · `POST` comprobante | `cpe:read` · `cpe:emit` (+ `cpe:send_sunat` si se envía) |
| `GET` compras y resumen · `POST` compra, `PATCH` estado SIRE | `purchases:read` · `purchases:write` |
| `GET` asientos, período, balance, Mayor · `POST` asiento y contabilizar | `accounting:read` · `accounting:write` |
| Cerrar · reabrir período | `accounting:close_period` · `accounting:reopen_period` |
| Vista previa · confirmación del cierre anual | `accounting:read` · `accounting:annual_close` |
| Miembros | `members:read` · `members:manage` |

## Primeros usuarios

- Desarrollo: `API_ALLOW_SIGNUP=true` y `POST /api/auth/register`.
- Producción: `npm run user:create -- --email titular@empresa.pe --name "Nombre"` (pide la contraseña
  por la terminal o la lee de `NEW_USER_PASSWORD`).
- Empresas creadas antes de este cambio no tienen titular y nadie las ve. Asígnales uno con
  `npm run user:create -- --email ... --name ... --owner-of <companyId>` (solo funciona si la empresa no tiene titular).
