/** Rebuild at the URL boundary: NextRequest and Node's Request can use different
 * Fetch implementations, so new Request(nextRequest) is not portable to Node 26.
 * CopilotKit requests contain JSON; buffering also avoids stream duplex options.
 */
export async function requestWithHeaders(req: Request, headers: Headers): Promise<Request> {
  return new Request(req.url, {
    method: req.method,
    headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : await req.arrayBuffer(),
    signal: req.signal,
  });
}
