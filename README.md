# Living Library

Living Library is a personal Magic: The Gathering collection manager. Browse
Scryfall printings, organize copies in multiple binders, and export your
collections for backup or transfer.

## Install

Use a build from [GitHub Releases](https://github.com/InsaaneUnicorn/Living-Library/releases)
when one is available, or follow the local build instructions below. The
desktop builds use Electron. Phones and tablets use the hosted web app.

### Windows

1. Choose the Setup executable for your PC. Use `LivingLibrary-win32-x64-Setup.exe`
   for most PCs, or an ARM64 build for a Windows on Arm device when available.
2. Run the installer from a source you trust and open Living Library from the
   Start menu. The installer includes the app runtime.
3. When a published update is ready, the app downloads it in the background
   and offers to restart.

### macOS

1. Choose the ZIP for your Mac. Use `darwin-arm64` for Apple silicon or
   `darwin-x64` for Intel.
2. Unzip the download, move `living-library.app` to **Applications**, and open
   it. Use a signed and notarized build for distribution. For local development,
   the source commands below also open the app on macOS.
3. To update, close the app and replace it with the newer build in
   **Applications**. Automatic updates are configured for Windows.

### iOS and iPadOS

1. Open your hosted Living Library **HTTPS** address in Safari.
2. Tap **Share → Add to Home Screen**. Turn on **Open as Web App** when offered,
   then tap **Add**.
3. Open Living Library from its Home Screen icon.

See [Apple’s web app installation instructions](https://support.apple.com/en-az/guide/iphone/iphea86e5236/26/ios/26).

### Android

1. Open your hosted Living Library **HTTPS** address in an up-to-date Chrome browser.
2. Tap **⋮ → Install and create shortcut → Install** when offered. Some Chrome
   versions list this under **Add to Home screen**.
3. Open Living Library from the Home screen or app drawer. You can also use it
   directly in Chrome.

See [Chrome’s web app instructions for Android](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid&hl=en).

## Using Living Library

### Find and add cards

- On first use, let the catalog download from Scryfall. **Refresh Catalog**
  checks for an update. When a newer snapshot is available, the app downloads
  it, then writes only new or changed printings and removes printings missing
  from the snapshot. Binders stay on the device and are not synced.
- Open **Show Card Catalog**. Search by a partial card name or an exact Scryfall
  ID. Filter by language, set, playable format, or finish, then click **Apply
  Filters**. **Secret Lair Printings** narrows the list to Secret Lair sets.
- Open a printing to see its artwork, collector number, finish options, owned
  copies, and format legalities. Use **Show other face** for double-faced cards.
- Choose a finish, click **Add to Binder**, select the destination binder if
  needed, and choose an empty pocket. The binder keeps that exact printing
  and finish.

### Manage binders

- Use **My Binders → New Binder** to make a binder. Use the **Active binder**
  menu to switch between saved binders and **Rename Binder** to change a name.
- In **Show Binder**, use **Previous** and **Next** to turn spreads and
  **Add Spread** to add pockets. Select a card in the custom layout, then
  select an empty or occupied pocket to move or swap it.
- Select an occupied pocket for **Card Details**, **Tag Card**, or
  **Remove Card**. Use **Select Cards** to select copies across spreads and
  **Add Tag** or **Remove Selected** to act on them together. Removal asks
  for confirmation.

### Search, filter, and sort

- In **Show Binder**, the navbar searches the active binder by a partial card
  name or exact Scryfall ID.
- Use **Apply Filters** to combine card type, mana color, mana cost or value,
  set, and tag. For example, use `{2}{U}` for a printed mana cost or `3`
  for mana value. Separate multiple sets with commas.
- Sort by tag or choose **Settings priorities** to use your own rules. Set
  their order under **Settings → Binder sorting**. Earlier rules take priority
  and later rules break ties. **Custom binder slot** uses saved pocket order.
- Click **Custom Layout** to clear filters and return to your saved pockets.

### Customize and back up binders

- Open **Settings** to change the theme, binding, rows, columns, and cover title.
  You can add front and back cover images and place text or image stickers.
  Click **Save Settings** to keep your changes.
- In **My Binders**, select a binder and click **Export JSON** or **Export CSV**.
  Backups include pocket positions, tags, finishes, cover settings, and sort
  priorities. Artwork loads from the local catalog’s matching printing.
- Use **Import Binder** to restore an export as a separate binder. CSV imports
  expect Living Library’s CSV headers.

Binders are stored locally on each device and browser profile. Use export and
import to move them between devices. Save a backup before clearing app data or
switching to a different hosting address.

## Build and host

For local development on Windows or macOS, install Node.js 22.12 or later.
From the project folder, run:

```sh
npm ci
npm run desktop
```

Run `npm run dev` for the browser development server. To make a distributable,
run `npm run make` on Windows for Setup or on macOS for a ZIP. On macOS, run
`npm run make -- --arch=arm64` for Apple silicon or use `--arch=x64` for Intel.
Build files go under `out/make/`.

### Host the mobile web app

#### GitHub Pages

1. Push the project files, including `.github/workflows/deploy-pages.yml`,
   to the default branch.
2. Open the repository’s **Settings → Pages** and choose **GitHub Actions**
   as the source.
3. Under **Actions**, open **Deploy Living Library to GitHub Pages** and click
   **Run workflow**. Run it again when you want to publish a web update.
4. Open the URL shown under **Settings → Pages** after deployment succeeds.
   For the default project site, the address is
   [insaaneunicorn.github.io/Living-Library/](https://insaaneunicorn.github.io/Living-Library/).

The workflow builds the app for the Pages URL and publishes only `dist/`.
Serving the unbuilt source folder or using root asset paths at a repository URL
can leave the page blank.

#### Other HTTPS hosts

Run `npm run build` and serve `dist/` at the root of a stable HTTPS address.
For a subdirectory, pass the URL path with `npm run build -- --base=/your-path/`.
Serve WebAssembly as `application/wasm`. Living Library’s SQLite worker uses
the OPFS SyncAccessHandle pool, which can run without custom isolation headers.

Share the hosted URL with users. A localhost preview runs on the development
computer. The first catalog download and card artwork need internet access.
See [SQLite’s web storage requirements](https://sqlite.org/wasm/doc/tip/persistence.md).

### Windows releases

1. Check the version in `package.json`. For an update, increment it before
   building, for example with `npm version patch --no-git-tag-version`.
2. Run `npm run make` on Windows. The installer, full `.nupkg`, and
   `RELEASES` file are generated under `out/make/squirrel.windows/`.
3. Publish a GitHub Release for the exact version, such as `v1.1.0`, in
   `InsaaneUnicorn/Living-Library`. Attach all three files. Use a public
   repository and a published stable release for the update feed.
4. Install the earlier release with its Setup executable, then open it after
   publishing a newer release to test the restart prompt and saved binders.

Keep the executable name, Squirrel package name, and desktop storage origin
the same across releases so existing installations can update and keep their
binders.

## Credits

The recolored [Book Open icon](https://fontawesome.com/icons/book-open?f=classic&s=solid)
is from [Font Awesome Free](https://fontawesome.com/license/free).
