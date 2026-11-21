# Changelog

What changed in each release. The release workflow takes a version's block as its release notes.

## [Unreleased]

- With automatic updates switched off, Settings > Updates says when a newer version is out. Nothing is downloaded until the person switches them on or installs it.
- The release tool names its app on every request to the Vault, and says plainly when nobody answered the connect request.

## [0.1.0] - 2026-11-21

The first release of the Holochain Desktop Starter.

- A notes app on two networks: a shared board, and a private network of your own devices.
- Flowsta sign-in through the Vault, with each note checked against its author's identity.
- Private notes backed up to the Vault and restored on a new device.
- Updates that install only when your release identity signed them.
- The parts that run Holochain, from `flowsta-hc-lines`: start, watch, restart, a clean stop.
- A rename script, a release workflow for Linux, macOS and Windows, a UI suite, and guides for your own servers and for releasing.
