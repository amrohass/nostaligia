// Entrypoint. Everything real is in handler.ts — see request-upload/index.ts for why the
// serve call is separated from the handler.

import { handleRequest } from "./handler.ts";

// Wrapped rather than passed directly. Deno.serve calls its handler with (request, info),
// and handleRequest's second parameter is now its injectable dependencies — passing it bare
// would hand the connection info in as `deps` and the function would call undefined.rpc on
// the first request.
Deno.serve((req) => handleRequest(req));
