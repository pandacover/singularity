import react from "@vitejs/plugin-react"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { defineConfig, type Plugin, runnerImport } from "vite"

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

// The built index.html carries the page itself, drawn by src/prerender.tsx, in place of <!--app-->.
const prerender = (): Plugin => ({
  name: "prerender",
  apply: "build",
  async transformIndexHtml(html) {
    const { module } = await runnerImport<{ render: () => string }>(fileURLToPath(new URL("./src/prerender.tsx", import.meta.url)), {
      root: fileURLToPath(new URL(".", import.meta.url)),
      plugins: [react()],
      logLevel: "warn"
    })
    return html.replace("<!--app-->", module.render())
  }
})

export default defineConfig({
  plugins: [react(), llmsTxt(), prerender()]
})
