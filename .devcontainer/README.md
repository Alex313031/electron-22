# Electron Dev on Codespaces

Welcome to the Codespaces Electron Developer Environment.

## Quick Start

Upon creation of your codespace you should have [build tools](https://github.com/electron/build-tools) installed and an initialized gclient checkout of Electron.  In order to build electron you'll need to run the following commands.

```bash
e sync -vv
e build
```

The initial sync will take approximately ~30 minutes and the build will take ~8 minutes.  Incremental syncs and incremental builds are substantially quicker.

## Directory Structure

Codespaces doesn't lean very well into gclient based checkouts, the directory structure is slightly strange.  There are two locations for the `electron` checkout that both map to the same files under the hood.

```graphql
# Primary gclient checkout container
/workspaces/gclient/*
  └─ src/* - # Chromium checkout
     └─ electron - # Electron checkout
# Symlinked Electron checkout (identical to the above)
/workspaces/electron
```

## Goma

If you are a maintainer [with Goma access](../docs/development/goma.md) it should be automatically configured and authenticated when you spin up a new codespaces instance.  You can validate this by checking `e d goma_auth info` or by checking that your build-tools configuration has a goma mode of `cluster`.

## Running Electron

You can run Electron in a few ways.  If you just want to see if it launches:

```bash
# Enter an interactive JS prompt headlessly
xvfb-run e start -i
```

But if you want to actually see Electron you will need to use the built-in VNC capability.  If you click "Ports" in codespaces and then open the `VNC web client` forwarded port you should see a web based VNC portal in your browser.  When you are asked for a password use `builduser`.

Once in the VNC UI you can open `Applications -> System -> XTerm` which will open a VNC based terminal app and then you can run `e start` like normal and Electron will open in your VNC session.

## Running Tests

You run tests via build-tools and `xvfb`.

```bash
# Run all tests
xvfb-run e test

# Run the main process tests
xvfb-run e test --runners=main

# Run the old remote tests
xvfb-run e test --runners=remote
```
