// Wrapped: Deno.serve calls its handler with (request, info).
import { handleRequest } from "./handler.ts";

Deno.serve((req) => handleRequest(req));
