// Copies the web-ifc WASM (matching the installed web-ifc version) into public/wasm/
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const src = require.resolve("web-ifc/web-ifc.wasm");
const here = dirname(fileURLToPath(import.meta.url)); // works on Windows, macOS and Linux
const outDir = join(here, "..", "public", "wasm");
// const outDir = join(dirname(new URL(import.meta.url).pathname), "..", "public", "wasm");
mkdirSync(outDir, { recursive: true });
copyFileSync(src, join(outDir, "web-ifc.wasm"));
console.log("Copied web-ifc.wasm to public/wasm/");
