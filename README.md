# Auto Backup Manager

A single-user web app for scheduled PostgreSQL 16 backups to a private Backblaze B2 bucket. Configure connections and schedules in the browser, review backup history, download compressed SQL archives, and receive email when a backup fails.

**Status: implemented initial version.** No npm packages are required. Live B2, SMTP, and browser passkey verification should be completed against your deployment before enabling scheduled backups.

## Quick start

Build the image (Podman needs Docker image format to preserve the health check):

```sh
podman build --format docker -t auto-backup-manager:local .
cp .env.example .env
podman run --rm auto-backup-manager:local node scripts/admin.js key
```

Put the generated key in `APP_ENCRYPTION_KEY`, then set your real user email and public HTTPS origin in `.env`. Keep `.env` readable only by your deployment user. Start the container using the deployment command below and connect your reverse proxy.

Generate the enrollment token, then open the public URL and enter it:

```sh
podman exec auto-backup-manager node scripts/admin.js enroll
```

The token expires after 15 minutes. Register a passkey, save the connection settings, test PostgreSQL and B2, and run a manual backup before enabling the schedule. SMTP is optional; enable it after a successful test email.

If the passkey is lost, reset it from the host:

```sh
podman exec auto-backup-manager node scripts/admin.js reset
```

This invalidates all sessions and prints a new enrollment token. To export a consistent settings database:

```sh
podman exec auto-backup-manager node scripts/admin.js backup-state /data/state-backup.sqlite
podman cp auto-backup-manager:/data/state-backup.sqlite ./state-backup.sqlite
```

Store that file securely together with a separately protected copy of the environment encryption key. To recover local state, stop the app and replace its data volume with the exported SQLite file named `app.sqlite` in a clean volume owned by container UID 1000; do not leave journals from a different database alongside it.

## Development and tests

Requires Node.js 24 or newer; no `npm install` step:

```sh
npm test
node scripts/large-upload.mjs
node scripts/integration.mjs
```

The first command runs cryptography, SQLite, scheduling, multipart failure/retry, HTTP security, and SMTP TLS tests. SMTP tests use OpenSSL to create a temporary certificate and skip if it is unavailable. It binds a local ephemeral port. The second streams a synthetic 1 GiB archive through a mocked B2 transport and checks memory usage. The third creates and removes an isolated PostgreSQL 16 container, uses the built application image's `pg_dump`, compresses the result, restores it, and checks the data. It also checks the non-root app container, health endpoint, enrollment/reset scripts, and SQLite persistence across restart. It requires Podman and may download the PostgreSQL image. Set `CONTAINER_RUNTIME=docker` to use Docker, or `APP_IMAGE` to choose another built app tag.

For local development, copy `.env.example` to `.env`, set `APP_DATA_DIR` to a writable local directory, configure the public origin for your HTTPS proxy (or `http://localhost:3000` for local browser development), and run `npm start`. PostgreSQL client tools must be available in PATH for connection tests and backups. The deployed image supplies version 16.

The frontend is served directly from `public/`. Backend modules live in `src/`; administration and integration tools live in `scripts/`. No generated frontend assets or package lockfile are needed.

## Scope

- One PostgreSQL database, one B2 destination, and one user defined in `.env`.
- One registered passkey, requiring device verification; no password or separate authenticator code.
- Plain JavaScript, HTML, and CSS frontend, without a framework or build step.
- Node.js backend using built-in modules only: no npm runtime dependencies.
- SQLite for configuration, passkey registration, and backup history through `node:sqlite`.
- One Docker/Podman-compatible container behind an HTTPS reverse proxy.
- PostgreSQL 16 client tools installed in the image; no PostgreSQL server in the container.
- Gzipped plain SQL archives (`.sql.gz`) streamed to B2 without a local backup file.
- UI-configurable daily schedule, initially 03:00 in `America/Chicago`.
- No catch-up backups after downtime, no backup deletion, and no automatic retention policy.
- SMTP failure notifications to multiple recipients, with a test-email action.

The first version does not restore databases, manage multiple users or databases, add archive encryption, or send success notifications. Existing local tools handle downloaded archives.

## Architecture

```text
Browser -- HTTPS --> Reverse proxy -- HTTP --> Node.js container
                                               |-- SQLite in persistent volume
                                               |-- PostgreSQL 16 pg_dump
                                               |      |-- gzip stream --> B2 multipart upload
                                               |-- SMTP over TLS --> failure recipients
                                               |-- B2 download stream --> browser
```

The Dockerfile uses the Node.js 24 Debian image with built-in SQLite. The base follows the Node 24 tag for updates; pin its digest in your deployment if immutable builds are required. Use built-in HTTP, TLS, cryptography, compression, child-process, and SQLite modules. The image includes PostgreSQL 16 client binaries, CA certificates, and timezone data. Node's `node:zlib` supplies gzip compression, so a separate gzip executable is unnecessary for backup creation.

SQLite stores small records, not backup contents. Backups and downloads use bounded memory with backpressure. Only one backup can run at a time. The app runs as one instance; deploying multiple replicas is outside this design.

## Initial setup and authentication

1. Set the single user's email, public HTTPS origin, and encryption key in `.env`.
2. Start the container with a persistent data volume and configure the reverse proxy.
3. Run a container administration command to generate a short-lived, single-use enrollment token. Use the enrollment command in the quick start below.
4. Open the enrollment page and use the token to register one passkey.
5. Sign in, configure PostgreSQL and B2, configure notifications, and enable the schedule.

Enrollment is unavailable without a valid server-generated token. A server-side reset command invalidates the registered credential and all sessions and generates a new enrollment token. Reset does not clear configuration or backup history. There is no public self-service recovery or email login.

Passkeys use WebAuthn with required user verification and no attestation requirement. Registration and login must validate origin, relying-party identity, challenge freshness, credential data, and signatures. Challenges are short-lived and single-use. Synced passkeys are allowed; one registered credential does not necessarily mean one physical device. Backup-eligible credentials must be handled correctly rather than assuming signature counters always increase.

Sessions use opaque random tokens in Secure, HttpOnly, SameSite cookies, with expiration and server-side invalidation. Protect state-changing requests against CSRF, limit authentication attempts and request sizes, and never log tokens or credentials. Authentication protects settings, history, backup execution, and downloads.

Changing the public hostname can require passkey re-enrollment. Configure the public origin explicitly rather than trusting arbitrary forwarded headers.

## Environment configuration

`.env` interface:

```dotenv
APP_USER_EMAIL=owner@example.com
APP_ORIGIN=https://backups.example.com
APP_ENCRYPTION_KEY=REPLACE_WITH_BASE64_ENCODED_32_RANDOM_BYTES
APP_DATA_DIR=/data
HOST=0.0.0.0
PORT=3000
```

`APP_USER_EMAIL` identifies the only allowed user; it is not an email login mechanism. The WebAuthn relying-party ID is derived from the configured origin's hostname. The encryption key protects stored database, B2, and SMTP secrets using authenticated encryption. Keep the key stable and backed up separately from the SQLite volume: losing it makes stored secrets unreadable. Encryption does not protect against compromise of the running container, which has access to the key.

Do not commit a real `.env`. The repository includes a placeholder `.env.example`. A container runtime must inject the environment using `--env-file`; the app need not implement a dotenv parser. Changing the configured identity must invalidate the existing credential and sessions and require enrollment again.

## Browser settings

### PostgreSQL

Configure hostname, port (default 5432), database name, username, password, and TLS verification settings. Support a custom CA for deployments that require one. Provide a connection test and actionable errors without exposing credentials.

Use a dedicated database account with permission to read everything that must be backed up. The app cannot guarantee a complete dump if that account lacks access. Invoke `pg_dump` directly with an argument array, never through an interpolated shell command. Pass credentials through a protected process environment or equivalent mechanism, not command-line arguments or logs.

### Backblaze B2

Configure application key ID, application key, bucket ID, and an optional object prefix. Use a private bucket and credentials scoped to the destination. The app needs authorization to inspect the bucket, list/read backups, upload parts, finish uploads, and cancel its own unfinished uploads. Grant `listFiles`, `readFiles`, and `writeFiles`, restricted to the bucket and prefix. Do not grant `deleteFiles`. [B2 cancellation](https://www.backblaze.com/apidocs/b2-cancel-large-file) uses `writeFiles`, so cleaning up unfinished uploads does not require completed-file deletion permission.

Provide a connection test. Backup names use UTC timestamps and a unique run identifier under the configured prefix to avoid collisions. The archive list shows completed `.sql.gz` objects in that prefix, including compatible existing archives, so downloads remain available if local history is lost. Keep unrelated objects outside that prefix.

### Schedule

Configure a daily local time and an IANA timezone, and enable or disable automatic backups. The initial values are `03:00` and `America/Chicago`; scheduling remains disabled until configuration is valid and the user enables it. Show the next scheduled run with its timezone.

Do not run missed schedules after restart. Record the execution date to avoid duplicate daily runs. For daylight-saving transitions, run once at the first occurrence of a repeated time; skip a local time that does not exist. If a backup is already running, skip the overlapping scheduled run and record that fact. A manual **Back up now** action is also available, subject to the same single-run lock.

### Email

Configure SMTP hostname, port, TLS mode, username, password, sender address, and multiple recipient addresses. Support implicit TLS and required STARTTLS with certificate verification; never fall back to sending credentials over plaintext. These settings support Resend SMTP credentials without a Resend SDK.

Provide **Send test email**. On backup failure, send the run time, database label, failure stage, and sanitized error details to all configured recipients. Record notification delivery errors separately, including partial recipient failures. Email failures must not replace the original backup error. The UI remains the source of status if SMTP is unavailable. A stopped container cannot send its own outage notification.

Saved secrets are masked and never returned in full to the browser. A blank unchanged secret field preserves the stored value; explicit replacement is supported.

## Backup pipeline

1. Snapshot the current configuration, acquire the backup lock, and record the run as in progress in SQLite.
2. Start PostgreSQL 16 `pg_dump` in plain SQL format for the configured database.
3. Pipe stdout through gzip and into the B2 Native API's large-file upload flow.
4. Buffer a bounded part in memory, compute its SHA-1, and upload it with a known content length. Apply backpressure to the dump pipeline while uploading. Retry transient part failures a limited number of times using the retained part.
5. Finish the B2 upload only after `pg_dump` exits successfully, compression completes, and every part is accepted.
6. Record the object ID, archive size, timestamps, duration, and final status. On failure, stop the pipeline, cancel its unfinished upload where possible, record the error, and notify recipients.

A typical compressed archive is approximately 1 GB. The full archive is never buffered in RAM or written to disk. Part sizes must satisfy B2's published limits, using 16 MiB parts. A synthetic 1 GiB transfer used approximately 149 MiB RSS in local verification; allow at least 512 MiB for the container, including PostgreSQL client processes and concurrent downloads. Disk space is needed only for the small SQLite database and its journal, not an archive-sized temporary file.

B2 requires content lengths for upload parts, so this is a bounded multipart stream rather than an unknown-length single PUT. Cancellation of an unfinished upload cleans up incomplete transfer data; the app never deletes completed backups. Track pending upload IDs so interrupted app-owned uploads can be cancelled on restart. If cancellation fails, show the failure; unfinished uploads may require operator cleanup in B2.

A crash after B2 completion but before the SQLite success update must be reconciled using the run identifier and B2 object metadata. Other interrupted runs are marked interrupted after restart; they are not automatically rerun. Graceful shutdown stops accepting new work and either completes or cancels the active pipeline within the container shutdown allowance.

These are logical backups of one database, not cluster-wide backups or point-in-time recovery. Global roles and tablespaces are outside the dump. Preserve ownership and privilege statements in the SQL by default; the local restore utility is responsible for preparing any required roles and extensions. No additional archive encryption is applied. Connections use TLS as configured, and B2 storage encryption is managed on the bucket side.

## Backup history and downloads

The dashboard shows current configuration readiness, schedule, next run, active run, and recent success/failure information. History includes start/end times, trigger (manual or scheduled), status, size when known, and sanitized errors. The archive list comes from B2, with pagination and refresh, rather than assuming every historical SQLite entry still exists remotely.

Downloads require authentication and stream through the backend directly from B2 to the browser with a safe `.sql.gz` attachment filename. Do not expose permanent B2 credentials or cache archives locally. Apply backpressure and stop the upstream download if the browser disconnects. Configure proxy timeouts to allow large downloads and long-running requests where needed; starting a backup returns promptly and progress is retrieved separately.

There are no deletion controls. Files removed externally are shown as unavailable rather than silently removing history. B2 lifecycle rules, if the operator configures them independently, are outside the app's control.

## Container deployment

The image contains the application, a supported Node runtime, and PostgreSQL 16 client tools. It runs as a non-root user, expose port 3000, and write application state only to `/data`. No package installation is required on the host beyond Docker or Podman.

Deployment:

```sh
podman run -d \
  --name auto-backup-manager \
  --env-file .env \
  -p 127.0.0.1:3000:3000 \
  -v auto-backup-manager-data:/data \
  --restart unless-stopped \
  auto-backup-manager:local
```

Alternatively, run `podman compose up -d --build` (with a Compose provider installed) or `docker compose up -d --build` using the included `compose.yaml`. The loopback binding assumes a reverse proxy running on the host; a containerized proxy should use a private container network instead. Terminate HTTPS at the proxy and forward to the app. Disable proxy disk buffering/caching for archive downloads and allow sufficiently long streaming transfers. Do not expose the app's plain HTTP port publicly.

Persist the `/data` volume across container replacement. Back up the SQLite state using a consistent SQLite backup method, and preserve `.env` securely. Copying a live SQLite file alone may omit journaled changes. Losing local state does not delete B2 archives, but requires user re-enrollment and configuration recovery. Never run two containers against the same data volume.

## Implementation and verification

The repository includes the server, static frontend, SQLite schema initialization, container build, environment template, and administration commands. The dependency-free requirement means WebAuthn, SMTP, and B2 protocol handling must be implemented and tested explicitly rather than delegated to packages. Keep cryptographic primitives in Node's built-in crypto APIs.

Required verification includes:

- Enrollment, login, reset, session expiry, CSRF protection, replay rejection, and invalid WebAuthn signatures/origins/user-verification flags.
- Secret encryption and masking, configuration validation, and SQLite persistence/migrations.
- Schedule edits, restart without catch-up, daylight-saving transitions, and overlapping run prevention.
- A real PostgreSQL 16 dump producing a valid `.sql.gz`, including a restore check against a disposable database.
- An approximately 1 GB archive upload with bounded memory and no local archive file; part retries, dump failures, upload failures, shutdown, and crash reconciliation.
- B2 archive listing and authenticated streaming downloads, including browser disconnects.
- SMTP TLS, multiple recipients, test messages, and notification delivery failures.
- Container execution under Podman with persistent state behind HTTPS, using a real browser passkey flow.

## Verification results and deployment checks

Local verification passed all 13 automated tests, the synthetic 1 GiB multipart transfer, the PostgreSQL 16 dump/restore integration, and container startup/persistence/enrollment/reset checks. The image was built with Podman as `auto-backup-manager:local`.

The B2 transport is mocked in the multipart tests; no real bucket or SMTP account was used. SMTP integration tests use a local TLS server. Passkey tests use generated ES256 credentials, not a physical authenticator. Before enabling the schedule, complete enrollment through your HTTPS hostname, test the real database and B2 settings, upload and download a manual backup, restore it using your local utility, and send a test email to the intended recipients.

## Technical references

- [Node.js built-in SQLite](https://nodejs.org/api/sqlite.html)
- [WebAuthn registration and authentication requirements](https://www.w3.org/TR/webauthn-3/)
- [B2 Native API upload flow](https://www.backblaze.com/docs/cloud-storage-upload-files-with-the-native-api)
- [B2 upload-part requirements](https://www.backblaze.com/apidocs/b2-upload-part)
- [B2 large-file completion](https://www.backblaze.com/apidocs/b2-finish-large-file)

## License

See [LICENSE](LICENSE).
