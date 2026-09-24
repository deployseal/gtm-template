# DeploySeal widget — Google Tag Manager template

A Google Tag Manager tag template that loads the [DeploySeal](https://deployseal.com) tester
widget on staging pages, so invited testers can pin issues on the page and sign off a release.
It is the Tag Manager install path of the DeploySeal
[install contract](https://deployseal.com/docs/gtm) (v1.4, §10).

Full guide: **https://deployseal.com/docs/gtm**

## What it does

GTM templates cannot put attributes on the script tags they insert, so the template cannot write
the `data-ds-*` attributes the pasted snippet carries. Instead it:

1. returns success and inserts nothing when the page already has the widget
   (`window.__deploysealConfig` or `window.__deployseal` is set — a pasted snippet or a plugin
   got there first);
2. fails and inserts nothing when the site key is empty (for example a Lookup Table with no row
   for this hostname);
3. otherwise writes the configuration object, omitting empty values:

   ```js
   window.__deploysealConfig = {
     dsSiteKey: 'ls_…',                 // Site key
     dsEnvironment: 'staging',          // Environment, slugified: [a-z0-9-], ≤ 32
     dsBuild: 'a1b2c3d',                // Build marker (the placeholder is dropped)
     dsApiBase: 'https://…',            // Advanced → API base, only when set
     dsInstaller: 'gtm-template/1.0.0',
   }
   ```

4. and injects `https://cdn.deployseal.com/ds-widget.js`. The widget's loader keeps an object that
   is already set, and the widget reads it exactly as it reads the snippet's attributes.

## Fields

| Field | Required | Notes |
|---|---|---|
| Site key | yes | The environment's public key (`ls_…`) from its card on the DeploySeal site page. |
| Environment | no | A short label such as `staging`; letters, digits and hyphens. |
| Build marker | no, recommended | Use a GTM variable filled by your deployment (ideally the git SHA). `REPLACE-WITH-BUILD-MARKER` is never recorded. |
| Advanced → API base | no | Leave empty (`https://api.deployseal.com`). Self-hosted and preview deployments only. |

## Permissions

- **Injects scripts** from `https://cdn.deployseal.com/`.
- **Accesses global variables**: `__deploysealConfig` (read, write) and `__deployseal` (read).

Nothing else: no cookies, no URL reads, no pixels, no console.

## Install

Until the template is in the Community Template Gallery:

1. Download `template.tpl` from the [latest release](https://github.com/deployseal/gtm-template/releases/latest).
2. In your container: **Templates → Tag Templates → New**, then the ⋮ menu at the top right →
   **Import**, choose the file, **Save**.
3. **Tags → New → Tag Configuration → DeploySeal widget** (under Custom), fill in the fields.
4. Add a trigger that fires only on your staging hostnames — see
   [docs/triggers.md](docs/triggers.md). **Do not use All Pages** on a container that also serves
   production.
5. **Preview**, check the tag fired and succeeded, then **Submit**.
6. Load a page on that environment; its card on the DeploySeal site page turns **Live**.

Remove any pasted snippet from those pages, or DeploySeal will warn that two install paths are live.

## Development

`template.tpl` is the whole template. Its `___TESTS___` section holds GTM's own test scenarios
(run them in the template editor's **Tests** tab). There is no official CLI, so CI runs
`node scripts/check-template.mjs`, which:

- checks every section is present and every JSON section parses;
- checks the fields (site key required, every `data.x` declared) and that the permissions cover
  exactly what the code requires;
- runs every `___TESTS___` scenario in Node against a small stand-in for GTM's test API;
- compares the template's environment slug with DeploySeal's `slugifyEnvironmentLabel` on
  500+ inputs;
- checks `metadata.yaml` and the Apache-2.0 licence.

A release bumps `INSTALLER` in the code, adds a `metadata.yaml` version pointing at the commit,
and tags `vX.Y.Z`.

## Licence

Apache License 2.0 — see [LICENSE](LICENSE).
