/**
 * Crea una cuenta de usuario desde la terminal del servidor (sin pasar por la API).
 * Uso:
 *   npm run user:create -- --email titular@empresa.pe --name "Nombre Apellido" [--owner-of <companyId>]
 * La contraseña se lee de la variable NEW_USER_PASSWORD o se pide por la terminal
 * (nunca como argumento, para que no quede en el historial).
 */
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { createPersistence } from "../../database/persistence.js";
import { AccessControlService } from "../../modules/auth/access-control.service.js";

async function readPassword(): Promise<string> {
  if (process.env.NEW_USER_PASSWORD) return process.env.NEW_USER_PASSWORD;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question("Contraseña (mínimo 10 caracteres): ");
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      name: { type: "string" },
      "owner-of": { type: "string" },
    },
  });
  if (!values.email || !values.name) {
    throw new Error('Uso: npm run user:create -- --email correo@dominio.pe --name "Nombre" [--owner-of <companyId>]');
  }
  const persistence = createPersistence({ databaseUrl: process.env.DATABASE_URL, allowMemory: false });
  try {
    const access = new AccessControlService(persistence.users);
    const user = await access.registerUser({ email: values.email, fullName: values.name, password: await readPassword() });
    process.stdout.write(`Usuario creado: ${user.email} (${user.id})\n`);
    if (values["owner-of"]) {
      await access.assignInitialOwner(values["owner-of"], user.id);
      process.stdout.write(`Asignado como titular de la empresa ${values["owner-of"]}.\n`);
    }
  } finally {
    await persistence.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
