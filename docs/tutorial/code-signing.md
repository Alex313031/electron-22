---
title: 'Code Signing'
description: 'Code signing is a security technology that you use to certify that an app was created by you.'
slug: code-signing
hide_title: false
---

Code signing is a security technology that you use to certify that an app was
created by you. You should sign your application so it does not trigger any
operating system security checks.

On macOS, the system can detect any change to the app, whether the change is
introduced accidentally or by malicious code.

On Windows, the system assigns a trust level to your code signing certificate
which if you don't have, or if your trust level is low, will cause security
dialogs to appear when users start using your application. Trust level builds
over time so it's better to start code signing as early as possible.

While it is possible to distribute unsigned apps, it is not recommended. Both
Windows and macOS will, by default, prevent either the download or the execution
of unsigned applications. Starting with macOS Catalina (version 10.15), users
have to go through multiple manual steps to open unsigned applications.

![macOS Catalina Gatekeeper warning: The app cannot be opened because the developer cannot be verified](../images/gatekeeper.png)

As you can see, users get two options: Move the app straight to the trash or
cancel running it. You don't want your users to see that dialog.

If you are building an Electron app that you intend to package and distribute,
it should be code signed.

## Signing & notarizing macOS builds

Properly preparing macOS applications for release requires two steps. First, the
app needs to be code signed. Then, the app needs to be uploaded to Apple for a
process called **notarization**, where automated systems will further verify that
your app isn't doing anything to endanger its users.

To start the process, ensure that you fulfill the requirements for signing and
notarizing your app:

1. Enroll in the [Apple Developer Program] (requires an annual fee)
2. Download and install [Xcode] - this requires a computer running macOS
3. Generate, download, and install [signing certificates]

Electron's ecosystem favors configuration and freedom, so there are multiple
ways to get your application signed and notarized.

### Using Electron Forge

If you're using Electron's favorite build tool, getting your application signed
and notarized requires a few additions to your configuration. [Forge](https://electronforge.io) is a
collection of the official Electron tools, using [`electron-packager`],
[`@electron/osx-sign`], and [`@electron/notarize`] under the hood.

Detailed instructions on how to configure your application can be found in the
[Signing macOS Apps](https://www.electronforge.io/guides/code-signing/code-signing-macos) guide in
the Electron Forge docs.

### Using Electron Packager

If you're not using an integrated build pipeline like Forge, you
are likely using [`electron-packager`], which includes [`@electron/osx-sign`] and
[`@electron/notarize`].

If you're using Packager's API, you can pass [in configuration that both signs
and notarizes your application](https://electron.github.io/electron-packager/main/interfaces/electronpackager.options.html).

```js
const packager = require('electron-packager')

packager({
  dir: '/path/to/my/app',
  osxSign: {},
  osxNotarize: {
    appleId: 'felix@felix.fun',
    appleIdPassword: 'my-apple-id-password'
  }
})
```

### Signing Mac App Store applications

See the [Mac App Store Guide].

## Signing Windows builds

Before signing Windows builds, you must do the following:

1. Get a Windows Authenticode code signing certificate (requires an annual fee)
2. Install Visual Studio to get the signing utility (the free [Community
   Edition](https://visualstudio.microsoft.com/vs/community/) is enough)

You can get a code signing certificate from a lot of resellers. Prices vary, so
it may be worth your time to shop around. Popular resellers include:

- [digicert](https://www.digicert.com/code-signing/microsoft-authenticode.htm)
- [Sectigo](https://sectigo.com/ssl-certificates-tls/code-signing)
- Amongst others, please shop around to find one that suits your needs! 😄

:::caution Keep your certificate password private
Your certificate password should be a **secret**. Do not share it publicly or
commit it to your source code.
:::

### Using Electron Forge

Electron Forge is the recommended way to sign your `Squirrel.Windows` and `WiX MSI` installers. Detailed instructions on how to configure your application can be found in the [Electron Forge Code Signing Tutorial](https://www.electronforge.io/guides/code-signing/code-signing-macos).

### Using electron-winstaller (Squirrel.Windows)

[`electron-winstaller`] is a package that can generate Squirrel.Windows installers for your
Electron app. This is the tool used under the hood by Electron Forge's
[Squirrel.Windows Maker][maker-squirrel]. If you're not using Electron Forge and want to use
`electron-winstaller` directly, use the `certificateFile` and `certificatePassword` configuration
options when creating your installer.

```js {10-11}
const electronInstaller = require('electron-winstaller')
// NB: Use this syntax within an async function, Node does not have support for
//     top-level await as of Node 12.
try {
  await electronInstaller.createWindowsInstaller({
    appDirectory: '/tmp/build/my-app-64',
    outputDirectory: '/tmp/build/installer64',
    authors: 'My App Inc.',
    exe: 'myapp.exe',
    certificateFile: './cert.pfx',
    certificatePassword: 'this-is-a-secret',
  })
  console.log('It worked!')
} catch (e) {
  console.log(`No dice: ${e.message}`)
}
```

For full configuration options, check out the [`electron-winstaller`] repository!

### Using electron-wix-msi (WiX MSI)

[`electron-wix-msi`] is a package that can generate MSI installers for your
Electron app. This is the tool used under the hood by Electron Forge's [MSI Maker][maker-msi].

If you're not using Electron Forge and want to use `electron-wix-msi` directly, use the
`certificateFile` and `certificatePassword` configuration options
or pass in parameters directly to [SignTool.exe] with the `signWithParams` option.

```js {12-13}
import { MSICreator } from 'electron-wix-msi'

// Step 1: Instantiate the MSICreator
const msiCreator = new MSICreator({
  appDirectory: '/path/to/built/app',
  description: 'My amazing Kitten simulator',
  exe: 'kittens',
  name: 'Kittens',
  manufacturer: 'Kitten Technologies',
  version: '1.1.2',
  outputDirectory: '/path/to/output/folder',
  certificateFile: './cert.pfx',
  certificatePassword: 'this-is-a-secret',
})

// Step 2: Create a .wxs template file
const supportBinaries = await msiCreator.create()

// 🆕 Step 2a: optionally sign support binaries if you
// sign you binaries as part of of your packaging script
supportBinaries.forEach(async (binary) => {
  // Binaries are the new stub executable and optionally
  // the Squirrel auto updater.
  await signFile(binary)
})

// Step 3: Compile the template to a .msi file
await msiCreator.compile()
```

For full configuration options, check out the [`electron-wix-msi`] repository!

### Using Electron Builder

Electron Builder comes with a custom solution for signing your application. You
can find [its documentation here](https://www.electron.build/code-signing).

### Signing Windows Store applications

See the [Windows Store Guide].

[apple developer program]: https://developer.apple.com/programs/
[`electron-forge`]: https://github.com/electron/forge
[`@electron/osx-sign`]: https://github.com/electron/osx-sign
[`electron-packager`]: https://github.com/electron/electron-packager
[`@electron/notarize`]: https://github.com/electron/notarize
[`electron-winstaller`]: https://github.com/electron/windows-installer
[`electron-wix-msi`]: https://github.com/electron-userland/electron-wix-msi
[xcode]: https://developer.apple.com/xcode
[signing certificates]: https://developer.apple.com/support/certificates/
[mac app store guide]: ./mac-app-store-submission-guide.md
[windows store guide]: ./windows-store-guide.md
[maker-squirrel]: https://www.electronforge.io/config/makers/squirrel.windows
[maker-msi]: https://www.electronforge.io/config/makers/wix-msi
[signtool.exe]: https://docs.microsoft.com/en-us/dotnet/framework/tools/signtool-exe
