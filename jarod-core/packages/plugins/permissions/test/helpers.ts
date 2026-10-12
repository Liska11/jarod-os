import { cleanup, tempDir } from "@jarod/kernel/testing";
import { afterEach } from "vitest";

export { tempDir };

afterEach(cleanup);
