# Volt — code-signing onboarding

How to go from no certificate to a **signed, published v1.0.1 release**.
Everything the repo knows about signing is exercised through three entry
points; this doc is the orchestration between them:

| Entry point | What it does |
|---|---|
| `npm run sign:setup` (`pdf-viewer/scripts/signing-setup.cjs`) | cert lifecycle: `status`, `import`, `dev-cert`, `trust`/`untrust`, `clear`, `check-release` |
| `npm run sign:check` (`pdf-viewer/scripts/check-signing.cjs`) | verifies built artifacts are Authenticode-signed by the configured publisher + `app-update.yml` carries a matching `publisherName` |
| `npm run release` (`pdf-viewer/scripts/release.cjs`) | refuses unsigned **and** self-signed/expired/keyless certs, builds + publishes to GitHub Releases, runs `sign:check` on the output |

`release` runs `sign:setup check-release` before anything else — that is the
guard that stopped the v1.0.1 tag run at `❌ REFUSING to release with a
SELF-SIGNED certificate`. This doc gets you past it.

---

## 0. Prerequisites

- A Windows machine (the cert operations use PowerShell cert stores).
- `pdf-viewer/` dependencies installed (`npm ci`).
- Repo admin access to set GitHub Actions secrets.
- **Time:** the CA validation is the long pole — plan a few business days.

## 1. Buy the certificate

Purchase an **Authenticode code-signing certificate** from a public CA. The
README names **DigiCert, Sectigo, SSL.com**.

**OV vs EV — choose OV for this project:**

- **OV (Organization Validation)** is the standard tier: the CA validates
  your legal entity, then issues a cert you can export as a `.pfx` with a
  software-protected private key. This is the PFX-based flow the whole repo
  is built around.
- **EV** gives faster SmartScreen reputation but almost always ships to a
  **hardware token** (USB dongle or cloud HSM) whose private key cannot be
  exported as a PFX — it doesn't fit the `CSC_LINK`-points-at-a-PFX model.
  Skip it unless you're already set up for token-based signing.

**Expect the CA to ask for:** legal entity name/address, DUNS or similar
identifier, a responsible-party contact, and often a notarized or callback-
verified form. The cert's **subject** becomes your `publisherName` — the
value the auto-updater will verify against on every future release, so keep
it stable across renewals.

## 2. Get the PFX (cert + private key)

After the CA issues the cert, export it **with its private key** from the
CA's portal / certificate utility (or from the Windows cert store: *Export…
→ Yes, export the private key → PFX*). You must have:

- a `.pfx`/`.p12` file containing the **certificate + private key** (the
  import rejects keyless PFXs),
- its **password** (you set this at export),
- a cert that is **not expired** (obviously) and ideally with > 30 days
  remaining — `sign:setup` warns under 30.

> **Treat the PFX like a server credential.** Anyone holding it can sign
> software as your organization. Store it in a password manager / secure
> vault, not in the repo, not on a shared drive.

## 3. Import it locally with `sign:setup`

From `pdf-viewer/`:

```bash
npm run sign:setup                        # status first — see the "before"
npm run sign:setup import C:\path\to\volt.pfx "your-pfx-password"
```

`import` validates the PFX (private key present, unexpired, expiry warning),
then writes `CSC_LINK` + `CSC_KEY_PASSWORD` into `pdf-viewer/.env`
(gitignored — never commit it). Confirm:

```bash
npm run sign:setup status
#   certificate : configured (path form, from .env)
#   subject     : CN=Your Org, O=Your Org          ← real CA now, not "Volt Dev Signing"
#   private key : present ✅
```

## 4. Prove it locally: build → sign → verify

```bash
npm run dist          # NSIS installer; signs Volt.exe + installer + uninstaller
npm run sign:check    # must PASS: artifacts signed by configured publisher,
                      # app-update.yml publisherName matches
```

`sign:check` is the same gate the release workflow runs. If it passes
locally with the real cert, the pipeline is proven on this machine.

## 5. Point CI at the real cert

The repo secrets currently hold the **dev cert** (that's why the signing-
secrets guard passed but `release` refused). Replace them:

```bash
# 1. base64-encode the PFX (CI-friendly; no path dependency on the runner)
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\volt.pfx"))
```

```bash
# 2. set the repo secrets
gh secret set CSC_LINK --body "<the base64 blob>"
gh secret set CSC_KEY_PASSWORD --body "your-pfx-password"

# 3. confirm GH_TOKEN is still present (release publishes via it)
gh secret list
```

> Environment variables always win over `pdf-viewer/.env` (via
> `scripts/load-env.cjs`), so CI uses the secrets and local builds use `.env`
> — both must carry the real cert, and they can differ. Update both when the
> cert lands.

## 6. Trigger the release

The `v1.0.1` tag points at an OLDER main commit, and the **stale-tag guard**
requires the release ref to be the CURRENT tip of origin/main — so re-cut the
tag at current main before pushing it (or skip tags entirely with the
manual-dispatch path):

```bash
# A — re-cut the tag at current main, then push it (runs the full guard set)
git tag -f -a v1.0.1 -F release-notes-v1.0.1.md
git push -f origin v1.0.1

# B — manual dispatch, no tag needed (empty main_sha = current tip)
gh workflow run "Release (signed)" --ref main
# or Actions tab → Release (signed) → Run workflow
```

What you should see in the run (`Build · sign · publish`):

1. ✅ Guard — release ref is on main (current tip by default)
2. ✅ Guard — generated artifacts match the tree (`npm run check:sw`)
3. ✅ Guard — signing secrets configured (GH_TOKEN always; CSC_LINK unless
   `scratch_unsigned` is set)
4. ✅ Guard — tag matches package.json version (push path only)
5. ✅ Pre-create the GitHub release — dedupes electron-builder's publisher
   race (the blockmap and installer artifacts otherwise create TWO releases
   with split assets and a broken `latest.yml` feed)
6. ✅ Signed release → publishes `Volt-Setup-1.0.1.exe` + `latest.yml` +
   `.blockmap` to GitHub Releases, **with the v1.0.1 notes as the release
   body** (`releaseInfo.releaseNotesFile`)
7. ✅ Verify signed artifacts (belt-and-braces `sign:check`)

## 7. Post-release checks

- The GitHub **release** page shows the installer + `latest.yml` + blockmap.
- `npm run sign:check` green in CI = artifacts Authenticode-signed by the
  configured publisher.
- Optionally grab the installer and verify locally:
  `Get-AuthenticodeSignature dist\Volt-Setup-1.0.1.exe` → `Status: Valid`.
- The auto-update feed path is covered by the **Release-feed round-trip**
  CI job whenever a cert secret is configured.

## Honest expectations

- A **brand-new** cert still shows a SmartScreen "unrecognized app" warning
  for a while — reputation builds with consistent signed releases and
  install counts.
- Signatures stay valid after cert expiry: `build.win.signtoolOptions`
  already pins an RFC3161 timestamp server (DigiCert), so every signature is
  time-stamped at build time.
- If you renew with a different **subject** than before, installed users'
  updaters will reject the new publisher (`ERR_UPDATER_INVALID_SIGNATURE`)
  until they reinstall. Keep the subject identical across renewals.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `import` → "has NO private key" | Exported without the key — re-export with *export the private key* |
| `import` → "could not read the PFX" | Wrong password — pass it as the second arg |
| `status` shows `Volt Dev Signing` | `.env` still points at the dev cert — re-run `import` |
| CI release fails at "Signed release" with REFUSING self-signed | Secrets still hold the dev cert — redo step 5 |
| CI fails the stale-tag guard | Tag predates current main — re-cut: `git tag -f -a v1.0.1 -F release-notes-v1.0.1.md && git push -f origin v1.0.1` |
| Renewal changed the publisher | Keep the subject; or plan a manual reinstall for existing users |

## Alternative: Azure Trusted Signing

The README also documents **Azure Trusted Signing** — HSM-issued short-lived
certs with no PFX password management (electron-builder `win.azureSignOptions`
+ `AZURE_*` env). Good option once distribution scales past a single release
key; overkill for the first real cert.
