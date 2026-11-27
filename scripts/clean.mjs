// Removes the build output, so files deleted or moved in src/ don't linger in out/ and get loaded instead.
import { rmSync } from "node:fs";

rmSync(new URL("../out", import.meta.url), { recursive: true, force: true });
