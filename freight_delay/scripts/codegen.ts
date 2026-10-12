/**
 * Regenerates `client/generated` — the typed client the lifecycle script uses.
 *
 * `anchor build` writes the program IDL to `target/idl/freight_delay.json`; this
 * turns that IDL into a Codama client (instruction builders, PDA helpers, account
 * codecs). Run it after any change to the program:
 *
 *   anchor build && bun run codegen
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderVisitor } from "@codama/renderers-js";
import { createFromRoot } from "codama";

const root = join(import.meta.dirname, "..");
const idl = JSON.parse(readFileSync(join(root, "target/idl/freight_delay.json"), "utf8"));

await createFromRoot(rootNodeFromAnchor(idl)).accept(
  renderVisitor(join(root, "client"), {
    generatedFolder: "generated",
    // `importExtension: 'ts'` matches this tree's explicit-extension imports;
    // `formatCode: false` avoids pulling prettier in — the file is generated.
    importExtension: "ts",
    formatCode: false,
    syncPackageJson: false,
    deleteFolderBeforeRendering: true,
  }),
);

console.log("regenerated client/generated from target/idl/freight_delay.json");
