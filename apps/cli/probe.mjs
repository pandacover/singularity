const lap = async (label, f) => { const t = performance.now(); await f(); console.log(label.padEnd(26), Math.round(performance.now() - t) + "ms") }
await lap("effect", () => import("effect"))
await lap("effect/cli", () => import("effect/cli"))
await lap("@effect/platform-node", () => import("@effect/platform-node"))
await lap("src/setup/Status.ts", () => import("./src/setup/Status.ts"))
await lap("src/commands/Setup.ts", () => import("./src/commands/Setup.ts"))
