import { describe, expect, it } from "vitest";
import {
  assertMembershipChange,
  CompanyRole,
  MembershipChangeContext,
  MembershipRuleError,
  permissionsForRole,
  PERMISSIONS,
  roleHasPermission,
} from "../permissions.js";
import { hashPassword, verifyPassword } from "../password.js";

describe("matriz de permisos por rol", () => {
  it("titular y administrador tienen todos los permisos", () => {
    expect(permissionsForRole("OWNER")).toEqual([...PERMISSIONS]);
    expect(permissionsForRole("ADMIN")).toEqual([...PERMISSIONS]);
  });

  it("el contador lleva compras y contabilidad pero no emite ni administra miembros", () => {
    expect(roleHasPermission("ACCOUNTANT", "accounting:close_period")).toBe(true);
    expect(roleHasPermission("ACCOUNTANT", "accounting:annual_close")).toBe(true);
    expect(roleHasPermission("ACCOUNTANT", "purchases:write")).toBe(true);
    expect(roleHasPermission("ACCOUNTANT", "cpe:emit")).toBe(false);
    expect(roleHasPermission("ACCOUNTANT", "members:manage")).toBe(false);
    expect(roleHasPermission("ACCOUNTANT", "company:update")).toBe(false);
  });

  it("el facturador solo emite y consulta comprobantes", () => {
    expect(permissionsForRole("BILLING")).toEqual(["company:read", "series:read", "cpe:read", "cpe:emit", "cpe:send_sunat"]);
    expect(roleHasPermission("BILLING", "accounting:read")).toBe(false);
    expect(roleHasPermission("BILLING", "purchases:read")).toBe(false);
  });

  it("consulta no tiene ningún permiso de escritura", () => {
    const writes = permissionsForRole("VIEWER").filter((p) => !p.endsWith(":read"));
    expect(writes).toEqual([]);
    expect(roleHasPermission("VIEWER", "members:read")).toBe(false);
  });
});

describe("reglas de cambio de membresía", () => {
  const base: MembershipChangeContext = {
    actorRole: "OWNER",
    isSystem: false,
    isSelf: false,
    currentRole: null,
    newRole: "VIEWER",
    ownerCount: 1,
  };
  const code = (ctx: Partial<MembershipChangeContext>) => {
    try {
      assertMembershipChange({ ...base, ...ctx });
      return "OK";
    } catch (error) {
      return (error as MembershipRuleError).code;
    }
  };

  it("solo quien administra miembros puede agregarlos", () => {
    expect(code({ actorRole: "OWNER" })).toBe("OK");
    expect(code({ actorRole: "ADMIN" })).toBe("OK");
    for (const role of ["ACCOUNTANT", "BILLING", "VIEWER"] as CompanyRole[]) {
      expect(code({ actorRole: role })).toBe("FORBIDDEN");
    }
    expect(code({ actorRole: undefined })).toBe("FORBIDDEN");
  });

  it("solo un titular otorga o quita el rol de titular", () => {
    expect(code({ actorRole: "ADMIN", newRole: "OWNER" })).toBe("FORBIDDEN");
    expect(code({ actorRole: "ADMIN", currentRole: "OWNER", newRole: "VIEWER", ownerCount: 2 })).toBe("FORBIDDEN");
    expect(code({ actorRole: "ADMIN", currentRole: "OWNER", newRole: null, ownerCount: 2 })).toBe("FORBIDDEN");
    expect(code({ actorRole: "OWNER", newRole: "OWNER" })).toBe("OK");
  });

  it("nadie puede subirse su propio rol", () => {
    expect(code({ actorRole: "ADMIN", isSelf: true, currentRole: "ADMIN", newRole: "OWNER" })).toBe("FORBIDDEN");
    expect(code({ actorRole: "ADMIN", isSelf: true, currentRole: "ADMIN", newRole: "VIEWER" })).toBe("OK");
  });

  it("la empresa nunca se queda sin titular", () => {
    expect(code({ isSelf: true, currentRole: "OWNER", newRole: "ADMIN", ownerCount: 1 })).toBe("LAST_OWNER");
    expect(code({ isSelf: true, currentRole: "OWNER", newRole: null, ownerCount: 1 })).toBe("LAST_OWNER");
    expect(code({ currentRole: "OWNER", newRole: null, ownerCount: 2 })).toBe("OK");
  });

  it("cualquier miembro puede retirarse, salvo el último titular", () => {
    expect(code({ actorRole: "VIEWER", isSelf: true, currentRole: "VIEWER", newRole: null })).toBe("OK");
  });

  it("el sistema solo asigna el primer titular", () => {
    expect(code({ isSystem: true, actorRole: null, newRole: "OWNER", ownerCount: 0 })).toBe("OK");
    expect(code({ isSystem: true, actorRole: null, newRole: "OWNER", ownerCount: 1 })).toBe("FORBIDDEN");
    expect(code({ isSystem: true, actorRole: null, newRole: "ADMIN", ownerCount: 0 })).toBe("FORBIDDEN");
  });
});

describe("contraseñas", () => {
  it("guarda un hash scrypt con sal y lo verifica", async () => {
    const hash = await hashPassword("clave-segura-2026");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(hash).not.toContain("clave-segura-2026");
    expect(await hashPassword("clave-segura-2026")).not.toBe(hash);
    expect(await verifyPassword("clave-segura-2026", hash)).toBe(true);
    expect(await verifyPassword("clave-segura-2027", hash)).toBe(false);
  });

  it("rechaza contraseñas cortas y hashes mal formados", async () => {
    await expect(hashPassword("corta")).rejects.toThrow(/al menos 10/);
    expect(await verifyPassword("lo-que-sea-123", "md5$abc")).toBe(false);
    expect(await verifyPassword("lo-que-sea-123", "scrypt$99999999$8$1$AAAA$BBBB")).toBe(false);
  });
});
