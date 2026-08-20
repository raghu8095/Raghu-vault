# RaghuVault

A private file vault that stores everything directly in **your own Google Drive**.
RaghuVault is a 100% static, client-side web app — there is no backend, no
database, and no third-party server sitting between your browser and Google.
Every upload, download, and delete is a direct call from JavaScript in your
browser to the Google Drive API v3, authenticated with Google Identity
Services (GIS).

```
raghu-vault/
├── index.html          Markup + inline SVG icon sprite
├── README.md            This file
├── .gitignore
├── css/
│   └── style.css        Dark glassmorphic "vault ledger" theme
└── js/
    ├── config.js         OAuth Client ID + Drive API constants
    ├── drive.js          Stateless Drive API v3 service layer
    └── app.js            Auth lifecycle, state, rendering, DOM wiring
```

## How it works

1. You sign in with **Google Identity Services'** token model
   (`google.accounts.oauth2.initTokenClient`), requesting only the
   `https://www.googleapis.com/auth/drive.file` scope.
2. That scope means RaghuVault can **only** see and manage files/folders it
   itself creates — it can never list, read, or touch the rest of your
   Drive. Google enforces this server-side; the app doesn't have to be
   trusted to behave.
3. On first connect, RaghuVault looks for a folder named `RaghuVault` at the
   root of your Drive. If it doesn't exist yet, it creates it. Every file you
   upload through the app goes into that one folder.
4. Uploads use the Drive API's `multipart` upload endpoint, streamed straight
   from your browser via `XMLHttpRequest` (so a real progress bar can be
   shown). Downloads stream the file's bytes back and save them via a
   temporary `Blob` URL. Deletes call the Drive API's `DELETE` endpoint.
   None of this ever passes through a server you'd have to run or trust.

## 1. Create a Google Cloud OAuth Client ID

You need a free Google Cloud project and an OAuth 2.0 **Web application**
Client ID. This takes about five minutes.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and
   create a new project (or pick an existing one).
2. Open **APIs & Services → Library**, search for **Google Drive API**, and
   click **Enable**.
3. Open **APIs & Services → OAuth consent screen**.
   - Choose **External** (unless you have a Google Workspace org and want
     **Internal**).
   - Fill in an app name, support email, and developer contact email.
   - Add the scope `https://www.googleapis.com/auth/drive.file` under
     **Data access**.
   - While the app is in **Testing** status, add your own Google account
     under **Test users** — otherwise Google will block sign-in.
4. Open **APIs & Services → Credentials → Create Credentials → OAuth client
   ID**.
   - Application type: **Web application**.
   - Under **Authorized JavaScript origins**, add every origin you'll load
     the app from, for example:
     - `http://localhost:8000` (for local development)
     - `https://yourname.github.io` (for GitHub Pages)
     - `https://your-project.pages.dev` (for Cloudflare Pages)
   - You do **not** need to set an Authorized redirect URI — the token model
     used here doesn't redirect.
5. Copy the generated Client ID (it ends in `.apps.googleusercontent.com`).

> **Publishing status:** while your OAuth consent screen is in "Testing"
> status, only the test users you listed can sign in, and Google shows an
> "unverified app" warning screen. That's normal for personal use. If you
> want anyone to be able to sign in without that warning, submit the app for
> Google's verification review from the OAuth consent screen — for a
> single, narrow scope like `drive.file` this is usually a light review.

## 2. Configure RaghuVault

Open `js/config.js` and set your Client ID:

```js
GOOGLE_CLIENT_ID: '123456789-abcdefg.apps.googleusercontent.com',
```

That's the only required change. Everything else in `config.js` has sane
defaults.

## 3. Run it locally

Because `js/app.js` is loaded as an ES module, opening `index.html` directly
from disk (`file://…`) won't work — browsers block module imports over
`file://` for security reasons. Serve the folder with any static file
server instead, for example:

```bash
cd raghu-vault
python3 -m http.server 8000
# or: npx serve .
```

Then visit `http://localhost:8000` (make sure that exact origin is in your
OAuth Client ID's **Authorized JavaScript origins**).

## 4. Deploy

RaghuVault is a static site — deploy the `raghu-vault/` folder as-is to any
static host.

**GitHub Pages**
1. Push this folder to a GitHub repository.
2. Repository **Settings → Pages → Deploy from a branch**, pick your branch
   and root folder.
3. Add the resulting `https://<username>.github.io` (and, if used, the
   `/<repo-name>` sub-path origin) to your OAuth Client ID's authorized
   origins.

**Cloudflare Pages**
1. Connect the repository (or drag-and-drop the folder) in the Cloudflare
   Pages dashboard. No build command is needed — the output directory is
   the project root.
2. Add the generated `https://your-project.pages.dev` origin (and any custom
   domain) to your OAuth Client ID's authorized origins.

Any other static host (Netlify, Vercel, S3 + CloudFront, plain nginx, etc.)
works the same way: upload the files, then add that host's origin to the
OAuth Client ID.

## Security notes

- **No secrets ship in this app.** OAuth Client IDs for browser apps are
  public identifiers, not secrets — the real security boundary is the
  Authorized JavaScript Origins list, which Google enforces server-side.
  There is no Client Secret anywhere in this codebase, and there shouldn't
  be one added.
- **Minimal scope.** `drive.file` is the narrowest Drive scope Google
  offers. RaghuVault cannot browse your existing Drive contents, only the
  files and folders it creates through the API.
- **Tokens live in memory only.** The access token is held in a JavaScript
  variable for the current tab session — never written to `localStorage`,
  `sessionStorage`, or a cookie. Reloading the page requires signing in
  again; closing the tab discards the token.
- **Explicit revocation.** "Sign out" calls
  `google.accounts.oauth2.revoke()`, immediately invalidating the access
  token with Google, not just clearing local UI state.
- **No analytics, no third-party scripts** beyond Google's own Identity
  Services library and Drive API, which are required for the app to
  function at all.

## Browser support

Any evergreen browser (Chrome, Edge, Firefox, Safari) with support for ES
modules, `fetch`, and `XMLHttpRequest` upload progress events — which is to
say, effectively all browsers in current use.

## License

Use, modify, and deploy this freely for your own projects.
