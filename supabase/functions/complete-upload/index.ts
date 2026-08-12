// Entrypoint. Everything real is in handler.ts — see request-upload/index.ts for why the
// serve call is separated from the handler.

import { handleRequest } from "./handler.ts";

Deno.serve(handleRequest);
