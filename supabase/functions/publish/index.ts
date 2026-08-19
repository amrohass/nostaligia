// Wrapped, not passed directly: Deno.serve calls its handler with (request, info), and a
// bare reference would quietly bind `info` to a second parameter one refactor from now.
import { handleRequest } from "./handler.ts";

Deno.serve((req) => handleRequest(req));
