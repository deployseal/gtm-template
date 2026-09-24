# Recommended trigger set-up

A GTM container is usually shared by staging and production. The DeploySeal widget belongs on
the environments being tested, so the tag's trigger — not the template — is what keeps it off
your live site.

## 1. Fire only on staging hostnames

Create a trigger:

- **Trigger type:** Page View (or DOM Ready)
- **This trigger fires on:** Some Page Views
- **Condition:** `Page Hostname` — `equals` — `staging.example.com`

For several hosts of one environment use `matches RegEx`, anchored:

```
^(staging|staging-admin)\.example\.com$
```

Never `contains example.com`: that matches production too.

## 2. One tag per environment

Every DeploySeal environment has its own public key, and the key alone decides which environment
the evidence lands in. Either:

**a. One tag per environment**, each with its own key, Environment label and hostname trigger:

| Tag | Site key | Environment | Trigger |
|---|---|---|---|
| DeploySeal — Staging | `ls_…` (Staging) | `staging` | Page Hostname equals `staging.example.com` |
| DeploySeal — UAT | `ls_…` (UAT) | `uat` | Page Hostname equals `uat.example.com` |

**b. One tag driven by Lookup Tables** on `{{Page Hostname}}`:

```
Variable "DeploySeal key"            Variable "DeploySeal environment"
  staging.example.com → ls_…           staging.example.com → staging
  uat.example.com     → ls_…           uat.example.com     → uat
  Default value: (empty)               Default value: (empty)
```

Set Site key to `{{DeploySeal key}}` and Environment to `{{DeploySeal environment}}`. With an
empty default the tag has no key on any other hostname, reports failure and loads nothing, so an
All Pages trigger is then safe — but a hostname trigger is still clearer.

Whichever you choose, register each environment's exact origins (scheme, host and port) as its
allowed origins in DeploySeal. Origin matching is exact: `https://staging.example.com` and
`https://www.staging.example.com` are two origins.

## 3. Build marker variable

Point **Build marker** at a variable your deployment fills, so it changes on every deployment:

- a **Data Layer Variable** your page pushes (`dataLayer.push({ dsBuild: 'a1b2c3d' })`),
- a **JavaScript Variable** such as `window.APP_BUILD`, or
- a **DOM Element** variable reading the `content` attribute of `meta[name="ds-build"]` (the
  widget also reads that meta tag on its own when the field is empty).

Prefer the git SHA (7+ characters). One token, no spaces, at most 64 characters.

## ⚠ Production

Do **not** fire the tag on production unless a DeploySeal campaign is testing production and the
production environment lists that origin. The widget only answers on registered origins and only
shows itself to invited testers, but it is still a script every visitor downloads.
