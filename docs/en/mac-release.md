# Mac builds, releases and acceptance

[中文](../mac-release.md) | English

The App targets macOS 14+ on Apple Silicon. Electron/Node is included. Current beta archives use ad-hoc signing, with no Developer ID signing, Apple notarization or accepted Intel build. Release notes must state the support scope and unfinished acceptance. Installation and model configuration are covered in [getting started](getting-started.md) and [configuration](configuration.md).

## Candidate archives

Prepare Node and npm on a supported Mac build machine; offline full archives also require uv:

```sh
npm ci
npm run verify
npx playwright install chromium
npm run test:browser
npm run desktop:pack
npm run test:desktop
npm run desktop:dist
# Separate internal fixture acceptance; does not certify the default archive.
npm run test:desktop
```

`desktop:pack` writes `.tmp/release/mac-arm64/Formicand.app`. `desktop:dist` creates and verifies `release/Formicand-<version>-mac-arm64.dmg` and SHA-256. Local builds never upload or publish. The hidden build directory avoids duplicate Spotlight/Launchpad installations.

`npm run test:desktop` checks the host, conversations and artifact previews, Pi with a local model, drafts, quit/recovery and relocated upgrades. Component installation and the removed editors are no longer packaged.

## App tags and draft Releases

The default release builds on a local Apple Silicon Mac to avoid hosted macOS minutes. Complete local regression before tagging, then install dependencies, check out the clean version tag, and run `npm run release:local -- v<version>`. The command validates the tag and versions, builds the DMG and CLI archive, and uploads a reviewable Release draft. Publish the draft by hand after reviewing its assets. Pushing a tag does not start a hosted Mac build. Beta/rc tags use Pre-release status.

The [Mac release workflow](../../.github/workflows/release-mac.yml) remains available as a manual cloud fallback. It rebuilds the candidate on macOS 15 arm64 and consumes hosted macOS minutes.

Review and commit release source, documentation and validation before tagging. Follow the steps above and existing release notes. Use a new version to repair an already-published artifact; never overwrite published assets or move a published tag. Publish the GitHub Release draft after reviewing its assets.

## App updates and signing

Settings → Updates in the installed App points to a local manual upgrade and performs no remote update check. Back up data, finish tasks and stop the standalone backend, retain the old App, then install a local DMG; see [installation](installation-reference.md#updates). Source updates require a clean fast-forward checkout; see [development](development.md#updating-a-source-checkout).

The npm packages, public update feed, signed ZIP/feed and in-app download/install left over from upstream were removed on 2026-11-25 (P9). A release channel of this fork's own is still to be decided.

Maintainers explicitly select a Developer ID Application identity using `CSC_NAME`; optional Actions credentials are `CSC_LINK` and `CSC_KEY_PASSWORD`. With an identity set, signing is enforced and the Developer ID signature is verified. With no explicit identity, automatic signing discovery is disabled and an ad-hoc signed DMG is built. Certificates and private keys never enter source.

Signing alone does not establish notarization or Gatekeeper acceptance.

## Data and installation acceptance

Users drag Formicand from DMG into Applications. Data remains under shared `~/.formicand/`, relocated with `FORMICAND_HOME`; external project originals require their own backups. Replacing the App preserves documents, conversations, settings. Back up important data before upgrades and verify recovery after restart. See [storage layout](../task-workspace-layout.md) (Chinese).

The selected execution host stores model and search keys in `credentials.json` (0600) beside its configuration; settings APIs return redacted status. Electron safeStorage encrypts client session credentials, and the renderer accesses the selected backend through the trusted host. See [connection storage](configuration-reference.md#connection-storage-and-compatibility) for boundaries and migration. Gatekeeper may require the system's explicit approval flow for the current beta. Stable distributions still require Developer ID signing, notarization, stapling and downloaded-quarantine acceptance. Do not disable system protections.

Actual model connections, a separate clean machine, interruption/upgrade recovery, source/license review and final artifact hashes are independent acceptance evidence. Skipped checks and protocol fixtures cannot be reported as passed. The App and development runtime omit the speech helper, microphone/speech privacy descriptions and audio-input entitlement. Electron’s generic system-audio capture description remains; Computer Use retains separate screen and accessibility permissions. Inspect the final App resources and signature with its hash. The [Chinese release guide](../mac-release.md) contains the detailed native resource and acceptance checklist.
