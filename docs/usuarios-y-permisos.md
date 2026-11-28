# Usuarios y permisos por empresa

Base de la autenticación. **Todavía no está conectada a las rutas HTTP**: la API sigue usando
`API_BEARER_TOKEN` hasta el siguiente paso (inicio de sesión y verificación de permisos en cada ruta).

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
