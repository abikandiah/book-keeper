## Development

`package.json`'s `dev` script already binds to all interfaces
(`astro dev --host 0.0.0.0`), so plain `pnpm dev` is safe to use directly —
don't drop the `--host 0.0.0.0` if you ever invoke `astro dev` some other
way (e.g. the CLI directly, bypassing the npm script), since that's what
actually matters here, not the `--background` flag.

`--host 0.0.0.0` matters in this devcontainer: without it, Astro binds only
to the IPv6 loopback address (`::1`) and refuses plain IPv4 `127.0.0.1`
connections outright — `.devcontainer/devcontainer.json`'s `forwardPorts`
mechanism (and most container port-forwarding proxies in general) connects
via IPv4, so the forwarded port silently fails to reach anything even though
the server looks fine from a shell inside the container (`curl localhost`
succeeds because it resolves to `::1` there). Confirmed directly: without
`--host 0.0.0.0`, `curl http://127.0.0.1:PORT` gets connection refused while
`curl http://[::1]:PORT` succeeds; with it, both work. This has already bitten
the project once from the plain `astro dev --background` form (no `--host`)
being documented here as the recommended command — don't reintroduce that by
dropping the flag from either the npm script or a direct CLI invocation.

When starting the dev server for background/detached use (e.g. so it doesn't
block a terminal), run it via the Astro CLI directly rather than `pnpm dev`,
keeping the same host flag:

```
astro dev --host 0.0.0.0 --background
```

Manage that background server with `astro dev stop`, `astro dev status`, and
`astro dev logs`. Don't call `astro dev stop` reflexively after a one-off
check (e.g. a screenshot or a curl) — the user may be relying on the server
staying up in their own browser; only stop it if you started it for a
self-contained check and have reason to think nobody else needs it, or the
user asks.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
