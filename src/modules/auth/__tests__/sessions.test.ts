import { describe, expect, it } from "vitest";
import { MemorySessionRepository } from "../../../database/repositories/session.repository.js";
import { MemoryUserRepository } from "../../../database/repositories/user.repository.js";
import { AccessControlService } from "../access-control.service.js";
import { hashSessionToken, LoginThrottle, SessionService } from "../session.service.js";

const PASSWORD = "clave-segura-de-prueba";

async function setup(ttlMs = 60 * 60 * 1000) {
  let now = new Date("2026-11-28T12:00:00.000Z");
  const repo = new MemorySessionRepository();
  const access = new AccessControlService(new MemoryUserRepository());
  const sessions = new SessionService(repo, access, { ttlMs, now: () => now });
  const user = await access.registerUser({ email: "ana@aysunat.test", fullName: "Ana Prueba", password: PASSWORD });
  return { repo, access, sessions, user, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

describe("Sesiones de usuario", () => {
  it("emite tokens opacos de 256 bits y guarda solo su hash", async () => {
    const { sessions, repo, user } = await setup();
    const issued = await sessions.login("ana@aysunat.test", PASSWORD);
    expect(issued?.token).toMatch(/^ays_[A-Za-z0-9_-]{43}$/);
    expect(await repo.findActiveByTokenHash(issued!.token, new Date())).toBeNull();
    expect(await repo.findActiveByTokenHash(hashSessionToken(issued!.token), new Date("2026-11-28T12:00:01Z"))).toMatchObject({ userId: user.id });
    expect(await sessions.login("ana@aysunat.test", "otra-clave-larga")).toBeNull();
  });

  it("rechaza tokens mal formados, vencidos y revocados", async () => {
    const { sessions, user, advance } = await setup(60 * 60 * 1000);
    expect(await sessions.authenticate(undefined)).toBeNull();
    expect(await sessions.authenticate("Bearer abc")).toBeNull();
    const issued = await sessions.issue(user);
    expect((await sessions.authenticate(issued.token))?.user.id).toBe(user.id);
    advance(60 * 60 * 1000);
    expect(await sessions.authenticate(issued.token)).toBeNull();

    const second = await sessions.issue(user);
    const auth = await sessions.authenticate(second.token);
    await sessions.logout(auth!.tokenHash);
    expect(await sessions.authenticate(second.token)).toBeNull();
  });

  it("corta la sesión cuando la cuenta se desactiva y limpia sesiones vencidas", async () => {
    const { sessions, access, user, advance } = await setup(60 * 60 * 1000);
    const issued = await sessions.issue(user);
    await access.deactivateUser(user.id);
    expect(await sessions.authenticate(issued.token)).toBeNull();
    advance(2 * 60 * 60 * 1000);
    expect(await sessions.purgeExpired()).toBe(1);
  });

  it("revoca las demás sesiones del usuario sin tocar la actual", async () => {
    const { sessions, user } = await setup();
    const current = await sessions.issue(user);
    const other = await sessions.issue(user);
    expect(await sessions.revokeOtherSessions(user.id, hashSessionToken(current.token))).toBe(1);
    expect(await sessions.authenticate(current.token)).not.toBeNull();
    expect(await sessions.authenticate(other.token)).toBeNull();
  });
});

describe("Freno de intentos de inicio de sesión", () => {
  it("bloquea por correo y por IP y se libera al pasar la ventana", () => {
    let now = 0;
    const throttle = new LoginThrottle({ maxFailuresPerEmail: 3, maxFailuresPerIp: 5, windowMs: 60_000, now: () => now });
    for (let i = 0; i < 3; i++) throttle.recordFailure("a@x.pe", "1.1.1.1");
    expect(throttle.retryAfterSeconds("a@x.pe", "2.2.2.2")).toBe(60);
    expect(throttle.retryAfterSeconds("b@x.pe", "1.1.1.1")).toBe(0);
    for (let i = 0; i < 2; i++) throttle.recordFailure(`otro${i}@x.pe`, "1.1.1.1");
    expect(throttle.retryAfterSeconds("c@x.pe", "1.1.1.1")).toBeGreaterThan(0);
    now = 60_000;
    expect(throttle.retryAfterSeconds("a@x.pe", "1.1.1.1")).toBe(0);
  });

  it("un acceso correcto reinicia el conteo del correo", () => {
    const throttle = new LoginThrottle({ maxFailuresPerEmail: 2 });
    throttle.recordFailure("a@x.pe", "ip");
    throttle.recordSuccess("a@x.pe");
    throttle.recordFailure("a@x.pe", "ip");
    expect(throttle.retryAfterSeconds("a@x.pe", "otra-ip")).toBe(0);
  });
});
