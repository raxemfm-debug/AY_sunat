import { createHash, randomBytes } from "node:crypto";
import type { ISessionRepository } from "../../database/repositories/session.repository.js";
import type { AccessControlService } from "./access-control.service.js";
import type { PublicUser } from "./types.js";

const TOKEN_PREFIX = "ays_";
const TOKEN_PATTERN = /^ays_[A-Za-z0-9_-]{43}$/;
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** SHA-256 en hex: lo único que se guarda del token. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface IssuedSession {
  /** Token opaco: se entrega una sola vez al cliente y nunca se guarda en claro. */
  token: string;
  expiresAt: string;
  user: PublicUser;
}

export interface AuthenticatedSession {
  user: PublicUser;
  tokenHash: string;
  expiresAt: string;
}

export interface SessionServiceOptions {
  ttlMs?: number;
  /** Reloj inyectable para pruebas. */
  now?: () => Date;
}

/**
 * Sesiones con token opaco de 256 bits enviado como `Authorization: Bearer`.
 * Cada solicitud vuelve a comprobar que la sesión siga vigente y la cuenta activa,
 * así que revocar una sesión o desactivar un usuario corta el acceso al instante.
 */
export class SessionService {
  private readonly ttlMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly sessions: ISessionRepository,
    private readonly access: AccessControlService,
    options: SessionServiceOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs < 60_000) throw new Error("La duración de sesión debe ser de al menos 1 minuto.");
    this.now = options.now ?? (() => new Date());
  }

  /** Verifica correo y contraseña y abre una sesión; null si las credenciales no son válidas. */
  async login(email: unknown, password: unknown): Promise<IssuedSession | null> {
    const user = await this.access.verifyCredentials(email, password);
    return user ? this.issue(user) : null;
  }

  /** Abre una sesión para un usuario ya verificado. */
  async issue(user: PublicUser): Promise<IssuedSession> {
    const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + this.ttlMs);
    await this.sessions.create({ userId: user.id, tokenHash: hashSessionToken(token), createdAt, expiresAt });
    return { token, expiresAt: expiresAt.toISOString(), user };
  }

  /** Usuario de la sesión, o null si el token no existe, venció, fue revocado o la cuenta está inactiva. */
  async authenticate(token: string | undefined): Promise<AuthenticatedSession | null> {
    if (!token || !TOKEN_PATTERN.test(token)) return null;
    const tokenHash = hashSessionToken(token);
    const session = await this.sessions.findActiveByTokenHash(tokenHash, this.now());
    if (!session) return null;
    const user = await this.access.getUser(session.userId);
    if (!user?.isActive) return null;
    return { user, tokenHash, expiresAt: session.expiresAt };
  }

  logout(tokenHash: string): Promise<void> {
    return this.sessions.revokeByTokenHash(tokenHash, this.now());
  }

  /** Cierra todas las demás sesiones del usuario (por ejemplo, tras cambiar la contraseña). */
  revokeOtherSessions(userId: string, currentTokenHash: string): Promise<number> {
    return this.sessions.revokeAllForUser(userId, this.now(), currentTokenHash);
  }

  revokeAllSessions(userId: string): Promise<number> {
    return this.sessions.revokeAllForUser(userId, this.now());
  }

  purgeExpired(): Promise<number> {
    return this.sessions.deleteExpired(this.now());
  }
}

export interface LoginThrottleOptions {
  /** Intentos fallidos permitidos por correo dentro de la ventana. */
  maxFailuresPerEmail?: number;
  /** Intentos fallidos permitidos por dirección IP dentro de la ventana. */
  maxFailuresPerIp?: number;
  windowMs?: number;
  now?: () => number;
}

/**
 * Freno de fuerza bruta en memoria del proceso: tras demasiados intentos fallidos
 * por correo o por IP, rechaza nuevos intentos hasta que pasa la ventana.
 * Con varias instancias de la API, cada una lleva su propio conteo.
 */
export class LoginThrottle {
  private readonly failures = new Map<string, { count: number; firstAt: number }>();
  private readonly maxEmail: number;
  private readonly maxIp: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: LoginThrottleOptions = {}) {
    this.maxEmail = options.maxFailuresPerEmail ?? 5;
    this.maxIp = options.maxFailuresPerIp ?? 30;
    this.windowMs = options.windowMs ?? 15 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  /** Segundos que faltan para poder reintentar; 0 si se permite el intento. */
  retryAfterSeconds(email: string, ip: string): number {
    const blocked = [this.check(`email:${email}`, this.maxEmail), this.check(`ip:${ip}`, this.maxIp)];
    return Math.max(...blocked);
  }

  recordFailure(email: string, ip: string): void {
    this.bump(`email:${email}`);
    this.bump(`ip:${ip}`);
  }

  recordSuccess(email: string): void {
    this.failures.delete(`email:${email}`);
  }

  clear(): void {
    this.failures.clear();
  }

  private check(key: string, max: number): number {
    const entry = this.current(key);
    if (!entry || entry.count < max) return 0;
    return Math.max(1, Math.ceil((entry.firstAt + this.windowMs - this.now()) / 1000));
  }

  private bump(key: string): void {
    const entry = this.current(key);
    if (entry) entry.count++;
    else this.failures.set(key, { count: 1, firstAt: this.now() });
    if (this.failures.size > 10_000) this.prune();
  }

  private current(key: string) {
    const entry = this.failures.get(key);
    if (entry && this.now() - entry.firstAt >= this.windowMs) {
      this.failures.delete(key);
      return undefined;
    }
    return entry;
  }

  private prune(): void {
    for (const key of [...this.failures.keys()]) this.current(key);
  }
}
