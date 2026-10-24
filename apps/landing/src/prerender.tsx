import { renderToStaticMarkup } from "react-dom/server"
import { App } from "./App.tsx"

/** The page as HTML, written into index.html at build time (vite.config.ts), so it reads without JavaScript:
 * crawlers and link previews get its text. In the browser, main.tsx draws the page again in its place. */
export const render = () => renderToStaticMarkup(<App />)
