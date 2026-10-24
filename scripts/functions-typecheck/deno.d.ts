// Minimal Deno surface used by the Edge Functions, so `tsc` can typecheck them without Deno.
declare namespace Deno {
  const env: { get(name: string): string | undefined };
  function serve(handler: (req: Request) => Response | Promise<Response>): void;
}
