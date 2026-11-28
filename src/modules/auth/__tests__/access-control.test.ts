import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPersistence, Persistence } from "../../../database/persistence.js";
import { createTestDatabase, TestDatabase, truncateAll } from "../../../database/__tests__/helpers/pg-test-database.js";
import { AccessControlService } from "../access-control.service.js";
import { MembershipRuleError } from "../permissions.js";
import { AccessDeniedError, DuplicateUserError, PublicUser } from "../types.js";

const adminUrl = process.env.TEST_DATABASE_URL;

const companyDto = (ruc: string) => ({
  ruc,
  legalName: `EMPRESA ${ruc}`,
  taxRegime: "RMT" as const,
  ubigeo: "150101",
  department: "LIMA",
  province: "LIMA",
  district: "LIMA",
  addressLine: "Av. Principal 123",
});

const backends = [
  { name: "memoria", enabled: true },
  { name: "PostgreSQL", enabled: Boolean(adminUrl) },
];

for (const backend of backends) {
  describe.skipIf(!backend.enabled)(`Usuarios y permisos por empresa (${backend.name})`, () => {
    let db: TestDatabase | undefined;
    let persistence: Persistence;
    let access: AccessControlService;
    let companyA: string;
    let companyB: string;
    let owner: PublicUser;
    let other: PublicUser;

    const register = (email: string) => access.registerUser({ email, fullName: "Usuario Prueba", password: "clave-segura-2026" });
    const ruleCode = async (promise: Promise<unknown>) => {
      try {
        await promise;
        return "OK";
      } catch (error) {
        if (error instanceof MembershipRuleError) return error.code;
        throw error;
      }
    };

    beforeAll(async () => {
      if (backend.name === "PostgreSQL") db = await createTestDatabase(adminUrl!);
    });
    afterAll(async () => db?.drop());

    beforeEach(async () => {
      if (db) {
        await truncateAll(db.pool);
        persistence = createPersistence({ pool: db.pool });
      } else {
        persistence = createPersistence({ allowMemory: true });
      }
      access = new AccessControlService(persistence.users);
      companyA = (await persistence.companies.create(companyDto("10445533811"))).id;
      companyB = (await persistence.companies.create(companyDto("20123456786"))).id;
      owner = await register("Titular@Empresa.pe ");
      other = await register("otro@empresa.pe");
      await access.assignInitialOwner(companyA, owner.id);
    });

    describe("usuarios y credenciales", () => {
      it("normaliza el correo, no expone el hash y rechaza correos repetidos", async () => {
        expect(owner.email).toBe("titular@empresa.pe");
        expect(owner).not.toHaveProperty("passwordHash");
        await expect(register("TITULAR@empresa.pe")).rejects.toBeInstanceOf(DuplicateUserError);
        await expect(register("no-es-correo")).rejects.toThrow(/formato/);
      });

      it("verifica credenciales y bloquea cuentas desactivadas", async () => {
        const ok = await access.verifyCredentials("TITULAR@empresa.pe", "clave-segura-2026");
        expect(ok?.id).toBe(owner.id);
        expect(ok).not.toHaveProperty("passwordHash");
        expect((await access.getUser(owner.id))?.lastLoginAt).toBeTruthy();
        expect(await access.verifyCredentials("titular@empresa.pe", "clave-incorrecta")).toBeNull();
        expect(await access.verifyCredentials("nadie@empresa.pe", "clave-segura-2026")).toBeNull();

        await access.deactivateUser(owner.id);
        expect(await access.verifyCredentials("titular@empresa.pe", "clave-segura-2026")).toBeNull();
        expect(await access.can(owner.id, companyA, "company:read")).toBe(false);
      });

      it("cambia la contraseña solo con la actual correcta", async () => {
        await expect(access.changePassword(owner.id, "otra-clave-mala", "nueva-clave-2026")).rejects.toBeInstanceOf(AccessDeniedError);
        await access.changePassword(owner.id, "clave-segura-2026", "nueva-clave-2026");
        expect(await access.verifyCredentials("titular@empresa.pe", "clave-segura-2026")).toBeNull();
        expect(await access.verifyCredentials("titular@empresa.pe", "nueva-clave-2026")).not.toBeNull();
      });
    });

    describe("permisos por empresa", () => {
      it("el titular de A no tiene ningún permiso en B", async () => {
        expect(await access.can(owner.id, companyA, "members:manage")).toBe(true);
        expect(await access.can(owner.id, companyB, "company:read")).toBe(false);
        await expect(access.authorize(owner.id, companyB, "cpe:read")).rejects.toBeInstanceOf(AccessDeniedError);
        expect(await access.listAccessibleCompanies(owner.id)).toEqual([
          expect.objectContaining({ companyId: companyA, role: "OWNER" }),
        ]);
      });

      it("un mismo usuario puede tener roles distintos en cada empresa", async () => {
        const ownerB = await register("titular-b@empresa.pe");
        await access.assignInitialOwner(companyB, ownerB.id);
        await access.setMemberRole(owner.id, companyA, other.id, "BILLING");
        await access.setMemberRole(ownerB.id, companyB, other.id, "ACCOUNTANT");

        expect(await access.can(other.id, companyA, "cpe:emit")).toBe(true);
        expect(await access.can(other.id, companyA, "accounting:write")).toBe(false);
        expect(await access.can(other.id, companyB, "cpe:emit")).toBe(false);
        expect(await access.can(other.id, companyB, "accounting:write")).toBe(true);
        expect((await access.listAccessibleCompanies(other.id)).map((c) => c.role).sort()).toEqual(["ACCOUNTANT", "BILLING"]);
      });

      it("el titular de A no puede agregar ni cambiar miembros en B", async () => {
        const ownerB = await register("titular-b@empresa.pe");
        await access.assignInitialOwner(companyB, ownerB.id);
        expect(await ruleCode(access.setMemberRole(owner.id, companyB, owner.id, "ADMIN"))).toBe("FORBIDDEN");
        expect(await ruleCode(access.setMemberRole(owner.id, companyB, other.id, "VIEWER"))).toBe("FORBIDDEN");
        expect(await ruleCode(access.removeMember(owner.id, companyB, ownerB.id))).toBe("FORBIDDEN");
        await expect(access.listMembers(owner.id, companyB)).rejects.toBeInstanceOf(AccessDeniedError);
        expect(await access.getRole(ownerB.id, companyB)).toBe("OWNER");
      });

      it("solo asigna el primer titular una vez", async () => {
        expect(await ruleCode(access.assignInitialOwner(companyA, other.id))).toBe("FORBIDDEN");
      });
    });

    describe("administración de miembros", () => {
      it("un administrador gestiona miembros pero no toca titulares", async () => {
        await access.setMemberRole(owner.id, companyA, other.id, "ADMIN");
        const third = await register("tercero@empresa.pe");
        expect(await ruleCode(access.setMemberRole(other.id, companyA, third.id, "ACCOUNTANT"))).toBe("OK");
        expect(await ruleCode(access.setMemberRole(other.id, companyA, third.id, "OWNER"))).toBe("FORBIDDEN");
        expect(await ruleCode(access.removeMember(other.id, companyA, owner.id))).toBe("FORBIDDEN");
        expect(await ruleCode(access.setMemberRole(other.id, companyA, other.id, "OWNER"))).toBe("FORBIDDEN");
      });

      it("roles sin members:manage no pueden agregar a nadie", async () => {
        await access.setMemberRole(owner.id, companyA, other.id, "ACCOUNTANT");
        const third = await register("tercero@empresa.pe");
        expect(await ruleCode(access.setMemberRole(other.id, companyA, third.id, "VIEWER"))).toBe("FORBIDDEN");
        await expect(access.listMembers(other.id, companyA)).rejects.toBeInstanceOf(AccessDeniedError);
      });

      it("un usuario desactivado pierde la administración", async () => {
        await access.setMemberRole(owner.id, companyA, other.id, "ADMIN");
        await access.deactivateUser(other.id);
        const third = await register("tercero@empresa.pe");
        expect(await ruleCode(access.setMemberRole(other.id, companyA, third.id, "VIEWER"))).toBe("FORBIDDEN");
      });

      it("protege al último titular y permite traspasar la titularidad", async () => {
        expect(await ruleCode(access.removeMember(owner.id, companyA, owner.id))).toBe("LAST_OWNER");
        expect(await ruleCode(access.setMemberRole(owner.id, companyA, owner.id, "ADMIN"))).toBe("LAST_OWNER");

        await access.setMemberRole(owner.id, companyA, other.id, "OWNER");
        await access.setMemberRole(owner.id, companyA, owner.id, "ACCOUNTANT");
        expect(await access.getRole(other.id, companyA)).toBe("OWNER");
        expect(await access.getRole(owner.id, companyA)).toBe("ACCOUNTANT");
      });

      it("lista miembros sin hashes y guarda el historial de cambios", async () => {
        await access.setMemberRole(owner.id, companyA, other.id, "VIEWER");
        await access.setMemberRole(owner.id, companyA, other.id, "BILLING");
        await access.removeMember(other.id, companyA, other.id);

        const members = await access.listMembers(owner.id, companyA);
        expect(members.map((m) => m.user.email)).toEqual(["titular@empresa.pe"]);
        expect(JSON.stringify(members)).not.toContain("scrypt");

        const history = await access.listMembershipHistory(owner.id, companyA);
        expect(history.map((e) => [e.previousRole, e.newRole])).toEqual([
          [null, "OWNER"],
          [null, "VIEWER"],
          ["VIEWER", "BILLING"],
          ["BILLING", null],
        ]);
        expect(history[3].actorUserId).toBe(other.id);
      });

      it("dos titulares que se degradan a la vez no dejan la empresa sin titular", async () => {
        // Se repite varias veces: con el pool ya abierto ambas transacciones sí se solapan.
        for (let round = 0; round < 10; round++) {
          const owners = (await persistence.users.listMembersByCompany(companyA)).filter((m) => m.role === "OWNER");
          const remaining = owners[0].userId;
          const demoted = remaining === owner.id ? other.id : owner.id;
          await access.setMemberRole(remaining, companyA, demoted, "OWNER");

          const results = await Promise.allSettled([
            access.setMemberRole(owner.id, companyA, owner.id, "VIEWER"),
            access.setMemberRole(other.id, companyA, other.id, "VIEWER"),
          ]);
          expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
          const after = (await persistence.users.listMembersByCompany(companyA)).filter((m) => m.role === "OWNER");
          expect(after).toHaveLength(1);
        }
      });
    });
  });
}
