import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPersistence } from "../../database/persistence.js";
import { createTestDatabase, TestDatabase, truncateAll } from "../../database/__tests__/helpers/pg-test-database.js";
import type { CompanyRole } from "../../modules/auth/permissions.js";
import { AnnualCloseApplication } from "../accounting/annual-close.application.js";
import { MemoryAnnualCloseRepository } from "../accounting/memory-annual-close.repository.js";
import { PostgresAnnualCloseRepository } from "../accounting/postgres-annual-close.repository.js";
import { createApiServices } from "../app-services.js";
import {
  ApiTestClient,
  companyBody,
  entryBody,
  invoiceBody,
  purchaseBody,
  startApi,
  TestUser,
  TEST_PASSWORD,
} from "./api-test-client.js";

/**
 * Permisos por empresa en la API: sesión obligatoria, roles por empresa y
 * administración de miembros. Corre en memoria y, con TEST_DATABASE_URL, sobre PostgreSQL.
 */
const adminUrl = process.env.TEST_DATABASE_URL;

interface Env {
  api: ApiTestClient;
  reset(): Promise<void>;
  teardown(): Promise<void>;
}

const backends: { name: string; enabled: boolean; setup(): Promise<Env> }[] = [
  {
    name: "memoria",
    enabled: true,
    async setup() {
      const boot = () => {
        const services = createApiServices(createPersistence({ allowMemory: true }), {}, { allowSignup: true });
        return startApi({ services, application: new AnnualCloseApplication(new MemoryAnnualCloseRepository()) });
      };
      let api = await boot();
      return {
        get api() { return api; },
        async reset() {
          await api.close();
          api = await boot();
        },
        teardown: () => api.close(),
      };
    },
  },
  {
    name: "PostgreSQL",
    enabled: Boolean(adminUrl),
    async setup() {
      const db: TestDatabase = await createTestDatabase(adminUrl!);
      const services = createApiServices(createPersistence({ pool: db.pool }), {}, { allowSignup: true });
      const api = await startApi({ services, application: new AnnualCloseApplication(new PostgresAnnualCloseRepository(db.pool)) });
      return {
        api,
        async reset() {
          await truncateAll(db.pool);
          services.loginThrottle.clear();
          await api.resetDefaultUser();
        },
        async teardown() {
          await api.close();
          await db.drop();
        },
      };
    },
  },
];

for (const backend of backends) {
  describe.skipIf(!backend.enabled)(`Permisos por empresa en la API (${backend.name})`, () => {
    let env: Env;
    let api: ApiTestClient;
    let companyId: string;
    let base: string;
    let counter = 0;

    beforeAll(async () => {
      env = await backend.setup();
    });
    afterAll(async () => env?.teardown());
    beforeEach(async () => {
      await env.reset();
      api = env.api;
      const created = await api.request("POST", "/api/companies", companyBody());
      expect(created.status).toBe(201);
      companyId = created.json.id;
      base = `/api/companies/${companyId}`;
    });

    async function member(role: CompanyRole): Promise<TestUser> {
      const user = await api.createUser(`${role.toLowerCase()}-${++counter}@aysunat.test`);
      const added = await api.request("POST", `${base}/members`, { email: user.email, role });
      expect(added.status).toBe(201);
      return user;
    }

    describe("sesión", () => {
      it("sin sesión responde 401 en toda ruta, exista o no", async () => {
        const anonymous = api.as(null);
        for (const [method, path] of [
          ["GET", "/api/companies"],
          ["GET", base],
          ["POST", `${base}/cpe`],
          ["GET", "/api/no-existe"],
          ["DELETE", "/api/companies"],
          ["GET", "/api/auth/me"],
        ]) {
          expect((await anonymous.request(method, path)).status, `${method} ${path}`).toBe(401);
        }
      });

      it("inicia sesión, identifica al usuario con sus empresas y cierra sesión", async () => {
        const anonymous = api.as(null);
        const wrong = await anonymous.request("POST", "/api/auth/login", { email: api.user.email, password: "incorrecta-123" });
        expect(wrong.status).toBe(401);
        expect(wrong.json.error.code).toBe("INVALID_CREDENTIALS");
        const unknown = await anonymous.request("POST", "/api/auth/login", { email: "nadie@aysunat.test", password: TEST_PASSWORD });
        expect(unknown.json.error.code).toBe("INVALID_CREDENTIALS");

        const login = await anonymous.request("POST", "/api/auth/login", { email: "TITULAR@aysunat.test ", password: TEST_PASSWORD });
        expect(login.status).toBe(200);
        expect(login.json.token).toMatch(/^ays_/);
        expect(login.json.user).not.toHaveProperty("passwordHash");
        const session = { ...api.user, token: login.json.token };

        const me = await api.as(session).request("GET", "/api/auth/me");
        expect(me.json.user.email).toBe("titular@aysunat.test");
        expect(me.json.companies).toEqual([
          expect.objectContaining({ companyId, role: "OWNER", roleLabel: "Titular", permissions: expect.arrayContaining(["members:manage"]) }),
        ]);

        expect((await api.as(session).request("POST", "/api/auth/logout")).status).toBe(200);
        expect((await api.as(session).request("GET", "/api/auth/me")).status).toBe(401);
        // Las demás sesiones del usuario siguen vigentes.
        expect((await api.request("GET", "/api/auth/me")).status).toBe(200);
      });

      it("frena la fuerza bruta: tras 5 intentos fallidos responde 429 aun con la contraseña correcta", async () => {
        const anonymous = api.as(null);
        for (let i = 0; i < 5; i++) {
          await anonymous.request("POST", "/api/auth/login", { email: api.user.email, password: `mala-clave-${i}` });
        }
        const blocked = await anonymous.request("POST", "/api/auth/login", { email: api.user.email, password: TEST_PASSWORD });
        expect(blocked.status).toBe(429);
        expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
      });

      it("registra usuarios solo si está permitido y nunca devuelve el hash", async () => {
        const anonymous = api.as(null);
        const created = await anonymous.request("POST", "/api/auth/register", {
          email: "nuevo@aysunat.test",
          fullName: "Usuario Nuevo",
          password: "una-clave-larga-1",
        });
        expect(created.status).toBe(201);
        expect(created.json.user).not.toHaveProperty("passwordHash");
        const repeated = await anonymous.request("POST", "/api/auth/register", {
          email: "nuevo@aysunat.test",
          fullName: "Otra Persona",
          password: "una-clave-larga-2",
        });
        expect(repeated.status).toBe(409);
        const weak = await anonymous.request("POST", "/api/auth/register", { email: "x@aysunat.test", fullName: "Corta", password: "123" });
        expect(weak.status).toBe(422);
      });

      it("al cambiar la contraseña cierra las demás sesiones del usuario", async () => {
        const other = await api.as(null).request("POST", "/api/auth/login", { email: api.user.email, password: TEST_PASSWORD });
        const otherSession = { ...api.user, token: other.json.token };
        const badCurrent = await api.request("POST", "/api/auth/password", { currentPassword: "no-es-esta-123", newPassword: "nueva-clave-segura" });
        expect(badCurrent.status).toBe(403);
        const changed = await api.request("POST", "/api/auth/password", { currentPassword: TEST_PASSWORD, newPassword: "nueva-clave-segura" });
        expect(changed.status).toBe(200);
        expect(changed.json.revokedSessions).toBe(1);
        expect((await api.as(otherSession).request("GET", "/api/auth/me")).status).toBe(401);
        expect((await api.request("GET", "/api/auth/me")).status).toBe(200);
      });
    });

    describe("empresas", () => {
      it("quien crea la empresa queda como titular; un usuario ajeno no la ve ni puede tocarla", async () => {
        const outsider = await api.createUser("ajeno@aysunat.test");
        const asOutsider = api.as(outsider);
        expect((await asOutsider.request("GET", "/api/companies")).json.data).toEqual([]);
        for (const [method, path, body] of [
          ["GET", base, undefined],
          ["PATCH", base, { tradeName: "INTRUSO" }],
          ["GET", `${base}/cpe`, undefined],
          ["POST", `${base}/cpe`, invoiceBody()],
          ["POST", `${base}/purchases`, purchaseBody()],
          ["GET", `${base}/trial-balance?period=2026-03`, undefined],
          ["GET", `${base}/members`, undefined],
          ["POST", `${base}/members`, { email: outsider.email, role: "OWNER" }],
        ] as const) {
          const response = await asOutsider.request(method, path, body);
          expect(response.status, `${method} ${path}`).toBe(404);
          expect(response.json.error.code).toBe("COMPANY_NOT_FOUND");
        }
        // Su propia empresa sí la gestiona, y el titular original no la ve.
        const own = await asOutsider.request("POST", "/api/companies", companyBody({ ruc: "20123456786" }));
        expect(own.json.role).toBe("OWNER");
        expect((await api.request("GET", "/api/companies")).json.data.map((c: { id: string }) => c.id)).toEqual([companyId]);
      });

      it("Consulta lee todo pero no puede escribir nada", async () => {
        const viewer = api.as(await member("VIEWER"));
        for (const path of [base, `${base}/series`, `${base}/cpe`, `${base}/purchases?period=2026-03`, `${base}/trial-balance?period=2026-03`]) {
          expect((await viewer.request("GET", path)).status, path).toBe(200);
        }
        for (const [method, path, body] of [
          ["PATCH", base, { tradeName: "X" }],
          ["POST", `${base}/series`, { cpeType: "01", series: "F002" }],
          ["POST", `${base}/cpe`, invoiceBody()],
          ["POST", `${base}/purchases`, purchaseBody()],
          ["POST", `${base}/journal-entries`, entryBody()],
          ["POST", `${base}/periods/2026-03/close`, {}],
          ["GET", `${base}/members`, undefined],
        ] as const) {
          const response = await viewer.request(method, path, body);
          expect(response.status, `${method} ${path}`).toBe(403);
          expect(response.json.error.code).toBe("FORBIDDEN");
        }
      });

      it("Facturador emite comprobantes pero no ve compras ni contabilidad", async () => {
        const billing = api.as(await member("BILLING"));
        expect((await billing.request("POST", `${base}/cpe`, invoiceBody())).status).toBe(201);
        expect((await billing.request("GET", `${base}/cpe`)).json.data).toHaveLength(1);
        expect((await billing.request("GET", `${base}/purchases?period=2026-03`)).status).toBe(403);
        expect((await billing.request("GET", `${base}/journal-entries?period=2026-03`)).status).toBe(403);
        expect((await billing.request("POST", `${base}/series`, { cpeType: "01", series: "F002" })).status).toBe(403);
      });

      it("Contador registra compras, asientos y cierra períodos, pero no emite", async () => {
        const accountant = api.as(await member("ACCOUNTANT"));
        expect((await accountant.request("POST", `${base}/purchases`, purchaseBody())).status).toBe(201);
        expect((await accountant.request("POST", `${base}/journal-entries`, entryBody())).status).toBe(201);
        const closed = await accountant.request("POST", `${base}/periods/2026-03/close`, { closedBy: "otra persona" });
        expect(closed.status).toBe(200);
        // Queda registrado quién cerró según la sesión, no según el cuerpo.
        expect(closed.json.closedBy).toMatch(/^accountant-\d+@aysunat\.test$/);
        expect((await accountant.request("POST", `${base}/cpe`, invoiceBody())).status).toBe(403);
        expect((await accountant.request("PATCH", base, { tradeName: "X" })).status).toBe(403);
      });

      it("el cierre anual exige permiso en la empresa indicada en el cuerpo", async () => {
        const billing = api.as(await member("BILLING"));
        const outsider = api.as(await api.createUser("ajeno-anual@aysunat.test"));
        const body = { companyId, fiscalYear: "2026" };
        expect((await billing.request("POST", "/api/accounting/annual-close/preview", body)).status).toBe(403);
        expect((await outsider.request("POST", "/api/accounting/annual-close/preview", body)).status).toBe(404);
        expect((await outsider.request("POST", "/api/accounting/annual-close/confirm", { ...body, expectedRevision: 0 })).status).toBe(404);
        expect((await api.request("POST", "/api/accounting/annual-close/preview", { companyId: "no-es-uuid", fiscalYear: "2026" })).status).toBe(404);
        const viewer = api.as(await member("VIEWER"));
        expect((await viewer.request("POST", "/api/accounting/annual-close/confirm", { ...body, expectedRevision: 0 })).status).toBe(403);
      });
    });

    describe("miembros", () => {
      it("el titular agrega, cambia y quita miembros; el acceso cambia al instante", async () => {
        const user = await member("VIEWER");
        const asUser = api.as(user);
        expect((await asUser.request("POST", `${base}/cpe`, invoiceBody())).status).toBe(403);

        const promoted = await api.request("PATCH", `${base}/members/${user.id}`, { role: "BILLING" });
        expect(promoted.status).toBe(200);
        expect((await asUser.request("POST", `${base}/cpe`, invoiceBody())).status).toBe(201);

        const list = await api.request("GET", `${base}/members`);
        expect(list.json.data.map((m: { email: string; role: string }) => [m.email, m.role])).toEqual(
          expect.arrayContaining([[api.user.email, "OWNER"], [user.email, "BILLING"]]),
        );
        expect(JSON.stringify(list.json)).not.toContain("scrypt$");
        const events = await api.request("GET", `${base}/members/events`);
        expect(events.json.data.length).toBeGreaterThanOrEqual(3);

        expect((await api.request("DELETE", `${base}/members/${user.id}`)).status).toBe(200);
        expect((await asUser.request("GET", base)).status).toBe(404);
      });

      it("valida altas: correo inexistente 404, miembro repetido 409", async () => {
        const user = await member("VIEWER");
        expect((await api.request("POST", `${base}/members`, { email: "nadie@aysunat.test", role: "VIEWER" })).status).toBe(404);
        const repeated = await api.request("POST", `${base}/members`, { email: user.email, role: "ADMIN" });
        expect(repeated.status).toBe(409);
        expect(repeated.json.error.code).toBe("ALREADY_MEMBER");
        expect((await api.request("PATCH", `${base}/members/${(await api.createUser("libre@aysunat.test")).id}`, { role: "VIEWER" })).status).toBe(404);
      });

      it("un administrador no puede otorgar ni quitar el rol de titular, ni subirse de rol", async () => {
        const admin = await member("ADMIN");
        const asAdmin = api.as(admin);
        const target = await api.createUser("candidato@aysunat.test");
        const grant = await asAdmin.request("POST", `${base}/members`, { email: target.email, role: "OWNER" });
        expect(grant.status).toBe(403);
        expect((await asAdmin.request("DELETE", `${base}/members/${api.user.id}`)).status).toBe(403);
        expect((await asAdmin.request("PATCH", `${base}/members/${admin.id}`, { role: "OWNER" })).status).toBe(403);
        // Pero sí administra roles no titulares.
        expect((await asAdmin.request("POST", `${base}/members`, { email: target.email, role: "ACCOUNTANT" })).status).toBe(201);
      });

      it("cualquier miembro puede retirarse, salvo el último titular", async () => {
        const viewer = await member("VIEWER");
        expect((await api.as(viewer).request("DELETE", `${base}/members/${viewer.id}`)).status).toBe(200);
        expect((await api.as(viewer).request("GET", base)).status).toBe(404);
        const lastOwner = await api.request("DELETE", `${base}/members/${api.user.id}`);
        expect(lastOwner.status).toBe(409);
        expect(lastOwner.json.error.code).toBe("LAST_OWNER");
        // Un consultor no puede quitar a otros.
        const other = await member("VIEWER");
        const another = await member("VIEWER");
        expect((await api.as(other).request("DELETE", `${base}/members/${another.id}`)).status).toBe(403);
      });

      it("un usuario desactivado pierde la sesión y el acceso de inmediato", async () => {
        const billing = await member("BILLING");
        expect((await api.as(billing).request("GET", base)).status).toBe(200);
        await api.services.access.deactivateUser(billing.id);
        expect((await api.as(billing).request("GET", base)).status).toBe(401);
        const login = await api.as(null).request("POST", "/api/auth/login", { email: billing.email, password: TEST_PASSWORD });
        expect(login.status).toBe(401);
      });
    });
  });
}
