# ENA Read Submission Helper

Native Electron helper for direct ENA read submissions from a local workstation.

It exposes the same loopback API used by `mimicc-ena-submission-assistant` on
`127.0.0.1:9100`, but runs ENA Webin-CLI locally with Java instead of Docker.

## Development

```bash
npm install
npm run dev
```

The app assumes `java` is available on `PATH`. On first upload it looks for a
Webin-CLI JAR in this order:

1. `WEBIN_CLI_JAR`
2. the app data cache as `webin-cli.jar`
3. download from `enasequence/webin-cli` GitHub releases

Useful environment variables:

- `HELPER_PORT` - helper port, default `9100`
- `MIMICC_APP_ORIGIN` / `ALLOWED_ORIGINS` - hosted assistant origin(s)
- `WEBIN_CLI_JAR` - explicit path to a Webin-CLI JAR
- `WEBIN_CLI_VERSION` - specific release tag to download
- `JAVA_BIN` - Java executable, default `java`

## Packaging

```bash
npm run dist:mac      # macOS dmg + zip
npm run dist:win      # Windows NSIS installer + portable exe
npm run dist:linux    # Linux AppImage + deb + rpm
npm run dist:all      # macOS + Windows + Linux where cross-building is supported
```

Build distributable artifacts on the target platform where possible. Public
macOS releases should be Developer ID signed and notarized; public Windows
releases should be Authenticode signed. Java is not bundled in the app. Linux
RPM builds are best run on Linux; macOS cross-builds can fail later in
`rpmbuild` even when AppImage and deb packaging metadata is valid.

Linux `deb` and `rpm` packages require project metadata such as `homepage`.
The default metadata points at `https://github.com/timrozday-mgnify/read-helper-app`;
change `homepage`, `repository`, and `bugs` in `package.json` if the canonical
repository is different.

## API

- `GET /api/health`
- `POST /api/credentials`
- `DELETE /api/credentials`
- `POST /api/scan`
- `POST /api/submit`
- `GET /api/status/:job_id`
- `GET /api/stream/:job_id`
- `POST /api/shutdown`
