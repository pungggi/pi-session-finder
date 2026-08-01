# Publishing `pi-session-finder`

Tag-driven CI publish with npm provenance.

```bash
# bump version in package.json, commit, then:
git tag v0.1.0
git push origin master --follow-tags
gh run watch
npm view pi-session-finder version    # expect 0.1.0
pi update npm:pi-session-finder       # refresh local install
```

Or atomically:

```bash
npm version patch -m "release: %s"   # or minor / major
git push origin master --follow-tags
gh run watch && pi update npm:pi-session-finder
```

## Auth (one-time) — Trusted Publisher / OIDC

1. npmjs.com → `pi-session-finder` → **Settings → Trusted Publisher**
2. Add GitHub Actions:
   - **Organization or user:** `pungggi`
   - **Repository:** `pi-session-finder`
   - **Workflow filename:** `release.yml`
   - **Environment:** *(empty)*
3. Leave `NPM_TOKEN` unset for pure OIDC.

Fallback: Classic **Automation** token as `NPM_TOKEN` repo secret.
