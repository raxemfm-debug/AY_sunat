import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

/**
 * Hash de contraseñas con scrypt (node:crypto), sin dependencias externas.
 * Formato: scrypt$N$r$p$salt(base64)$hash(base64). Los parámetros quedan guardados
 * para poder endurecerlos en el futuro sin invalidar contraseñas existentes.
 */
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 128 * N * R * 2;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password.normalize("NFKC"), salt, length, { N: n, r, p, maxmem: Math.max(MAX_MEMORY, 128 * n * r * 2) }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export function validatePasswordStrength(password: unknown): string[] {
  if (typeof password !== "string") return ["La contraseña es obligatoria."];
  const errors: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) errors.push(`La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`);
  if (password.length > PASSWORD_MAX_LENGTH) errors.push(`La contraseña no puede superar ${PASSWORD_MAX_LENGTH} caracteres.`);
  if (password.trim().length === 0) errors.push("La contraseña no puede estar en blanco.");
  return errors;
}

export async function hashPassword(password: string): Promise<string> {
  const errors = validatePasswordStrength(password);
  if (errors.length > 0) throw new Error(errors.join(" "));
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, N, R, P, KEY_LENGTH);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (typeof password !== "string" || password.length > PASSWORD_MAX_LENGTH) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (![n, r, p].every((value) => Number.isInteger(value) && value > 0) || n > 2 ** 20) return false;
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (salt.length < 16 || expected.length < 32) return false;
  const actual = await scrypt(password, salt, n, r, p, expected.length);
  return timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | undefined;
/** Hash fijo para gastar el mismo tiempo cuando el usuario no existe. */
export function getDummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(24).toString("base64"));
  return dummyHash;
}
