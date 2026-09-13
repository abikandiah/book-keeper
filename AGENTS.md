## Development

When starting the dev server, use background mode and bind to all interfaces:

```
astro dev --host 0.0.0.0 --background
```

`--host 0.0.0.0` matters in this devcontainer: without it, Astro binds only
to the IPv6 loopback address (`::1`) and refuses plain IPv4 `127.0.0.1`
connections outright — `.devcontainer/devcontainer.json`'s `forwardPorts`
mechanism (and most container port-forwarding proxies in general) connects
via IPv4, so the forwarded port silently fails to reach anything even though
the server looks fine from a shell inside the container (`curl localhost`
succeeds because it resolves to `::1` there). Confirmed directly: with the
plain `astro dev --background` form, `curl http://127.0.0.1:PORT` gets
connection refused while `curl http://[::1]:PORT` succeeds; with
`--host 0.0.0.0` both work.

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
