/**
 * Where computer-use memory's files are in a tenant (Model.ts has the
 * layout), as plain functions: the hook finds them without Effect.
 */
import { join } from "node:path"

/** An app or a session as a file name: `127.0.0.1:5102` → `127.0.0.1_5102`. */
export const fileName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120)

export const computerPath = (tenantDir: string) => join(tenantDir, "computer")
export const saltPath = (tenantDir: string) => join(computerPath(tenantDir), "salt")
export const appPath = (tenantDir: string, app: string) => join(computerPath(tenantDir), "apps", fileName(app))
export const indexPath = (tenantDir: string, app: string) => join(appPath(tenantDir, app), "index.json")
export const trailPath = (tenantDir: string, app: string, session: string) => join(appPath(tenantDir, app), "trails", `${fileName(session)}.json`)
export const wordsPath = (tenantDir: string) => join(computerPath(tenantDir), "words.json")
export const givenPath =(tenantDir: string, session: string) => join(computerPath(tenantDir), "sessions", `${fileName(session)}.json`)
