import type { Role } from "./server-files";

/** viewer < editor < owner; each role can do everything the ones below can. */
const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

/** Whether `role` (null: no access to this place) is at least `required`. */
export function hasRole(role: Role | null, required: Role) {
  return role !== null && ROLE_RANK[role] >= ROLE_RANK[required];
}

/** "a viewer", "an owner", "without access": for hints and errors. */
export function roleName(role: Role | null) {
  return role ? `a${role === "owner" ? "n" : ""} ${role}` : "without access";
}
