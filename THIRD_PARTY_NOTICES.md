# Licenses and notices

Codex Co² code uses the [MIT license](LICENSE). When redistributing the app, include the license and copyright notices for the components you ship.

## Bundled components

The macOS app stores the following files in `Contents/Resources/Licenses/`. On Windows, open `resources/Licenses/` in the installation directory.

| Platform | Component | Files in the license directory |
| --- | --- | --- |
| Both | Node.js, including its bundled dependencies | `Node-LICENSE` |
| Both | cloudflared and its Go dependencies | `cloudflared-LICENSE`, `cloudflared-modules/` (Go license, module notices and index) |
| Both | npm packages used by the service and browser | `npm-NOTICES.txt` (package versions, copyrights and license texts) |
| macOS | Sparkle updater and its bundled components | `Sparkle-LICENSE.txt` |
| Windows | .NET runtime, Windows Desktop runtime and WebView2 SDK | `microsoft.netcore.app.runtime.win-x64/`, `microsoft.windowsdesktop.app.runtime.win-x64/`, `microsoft.web.webview2/` |
| Windows installer | NSIS | `NSIS-LICENSE.txt` |

The source repository keeps the reviewed npm and Sparkle notices under `third-party/`. The release manifest identifies the versions shipped in each package. Windows uses a separately installed WebView2 Runtime.

## Project visuals

The maintainer supplied the promotional videos and demo screenshots. The promotional banners use AI-generated artwork, and the feedback demo uses fictional participants and messages. The maintainer reports that the app icon uses no third-party artwork or brand marks. Its original creation tool is unverified. The macOS installer draws its artwork using the project icon and system fonts.

Contributors license these assets under MIT to the extent of their rights. They claim no exclusive copyright in AI-generated material. OpenAI and Codex are names of their respective owners. The project claims no trademark license or endorsement.
