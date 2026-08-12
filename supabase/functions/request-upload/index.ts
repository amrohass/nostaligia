// Entrypoint. Everything real is in handler.ts.
//
// The split exists so a test can import the handler and call it with a constructed
// Request. Importing a module that calls Deno.serve at top level starts a listener as a
// side effect of the import, which is not something a unit test should do — and the
// alternative, guarding the serve with `import.meta.main`, stakes the whole function on
// the edge runtime treating this file as the main module. If that assumption were ever
// wrong the function would serve nothing at all. A two-line entrypoint has no such
// assumption to be wrong about.

import { handleRequest } from "./handler.ts";

Deno.serve(handleRequest);
