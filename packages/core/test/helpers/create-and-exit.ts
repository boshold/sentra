import { createSentra } from "#src/sentra.js";

// Intentionally never closed: the retention timer must not keep the process alive.
await createSentra();
