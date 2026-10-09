import react from "@vitejs/plugin-react"
import { readFileSync } from "node:fs"
import { defineConfig, type Plugin } from "vite"

// The page for agents (src/agents.md) is also served as /llms.txt, from the one file.
const AGENTS = new URL("./src/agents.md", import.meta.url)
const llmsTxt = (): Plugin => ({
  name: "llms-txt",
  configureServer(server) {
    server.middlewares.use("/llms.txt", (_req, res) => {
      res.setHeader("Content-Type", "text/plain; charset=utf-8")
      res.end(readFileSync(AGENTS))
    })
  },
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "llms.txt", source: readFileSync(AGENTS, "utf8") })
  }
})

export default defineConfig({
  plugins: [react(), llmsTxt()]
})
