# Auto Backup Manager

A minimal Node.js backend and plain HTML, CSS, and JavaScript frontend.
No npm dependencies or tests are included. All project files live in the root.
The container includes PostgreSQL client tools and gzip for streaming backups.

## Development

With Node.js/npm and Docker installed, run:

```sh
npm run dev
```

Open http://localhost:3000. This command builds the Node.js 26 image,
bind-mounts this directory into the container, and starts `node --watch server.js`.
Backend JavaScript changes restart the server. Refresh your browser to see HTML,
CSS, and frontend JavaScript changes. Stop the container with Ctrl+C.
No `npm install` is needed.

The development bind mount uses `:Z` so Docker/Podman can read the project
on systems with SELinux enabled.

## Run without watch mode

```sh
docker build -t auto-backup-manager .
docker run --rm -p 3000:3000 -v auto-backup-manager-data:/data auto-backup-manager
```

## Account setup

After signing in, use the floating left menu to switch between backup history
and Settings. Settings saves PostgreSQL, S3-compatible object storage, and SMTP
connection details in the same persistent SQLite database as the account.
Saved passwords and storage keys are never returned by the settings API. Leave
a credential blank to keep it, enter a new value to replace it, or select its
removal checkbox to clear it. Credentials are stored in the database, so protect
the data volume and backups. Use the connection checks to validate the current
form values before saving. The SMTP section also has a Send test email action.
These checks do not save changes.

On first launch, create the owner account using an email and a password of
12–128 characters. Open the authenticator setup link on a device with an
authenticator installed, or enter the displayed key manually. Verify a six-digit
code to finish setup, then log in using your email, password, and a fresh code.
Only one owner account can be created. The email is a login identifier; email
verification, password resets, and recovery codes are not implemented yet.

Passwords are salted and hashed with scrypt. Six-digit TOTP codes use 30-second
intervals, accept one interval of clock drift, and cannot be reused. Sessions
expire after 12 hours and use HttpOnly, SameSite cookies. Authentication attempts
are limited to 20 per IP per 15 minutes. Pending setup expires after 15 minutes
and resets when the server restarts.

Node's built-in SQLite stores the account and sessions in `/data/auth.sqlite`
inside the container. The named volume `auto-backup-manager-data` keeps them
across restarts and rebuilds. The database contains the authenticator secret;
keep the volume and its backups private. Outside Docker, the database defaults
to `auth.sqlite` in the project root, or the path specified by `DB_PATH`.

For deployment over HTTPS, set `APP_ORIGIN` to the public origin (for example,
`https://backups.example.com`) and `COOKIE_SECURE=true`. Complete initial owner
setup before exposing the app to other users. The server does not trust forwarded
IP headers; rate limits behind a reverse proxy apply to the proxy address.

## Publish to Docker Hub

`.github/workflows/docker-publish.yml` builds and publishes the Linux amd64 image
on every push to `main`. You can also run it manually from the Actions tab on
`main`. It publishes `YOUR_USERNAME/auto-backup-manager:latest` and a
`sha-COMMIT_SHA` tag identifying the source commit.

Create a Docker Hub repository named `auto-backup-manager` under your username.
Create a Docker Hub personal access token with Read & Write permissions.
In your GitHub repository, open **Settings → Secrets and variables → Actions →
New repository secret**, and add:

| Secret | Value |
| --- | --- |
| `DOCKERHUB_USERNAME` | Your Docker Hub username (not your email). |
| `DOCKERHUB_TOKEN` | Your Docker Hub personal access token. |

Add the secrets before pushing the workflow to `main`. No additional GitHub token
is needed. Publishing only runs on `main` pushes or manual runs on `main`, never
on pull requests. The Docker build context includes only the application files
listed in `.dockerignore`; local SQLite databases are excluded.

To run the published image:

```sh
docker run --rm -p 3000:3000 -v auto-backup-manager-data:/data YOUR_USERNAME/auto-backup-manager:latest
```

## Deploy with Docker Compose

Copy `.env.example` to `.env` and set `DOCKERHUB_USERNAME` to the account that
publishes the image. Set `APP_ORIGIN` to the exact URL you use to access the app,
including its scheme and port. For HTTPS behind a reverse proxy, use your public
HTTPS origin and set `COOKIE_SECURE=true`. Compose does not provide TLS itself.

Start the app:

```sh
docker compose up -d
```

Pull a newly published image and recreate the container:

```sh
docker compose pull
docker compose up -d
```

`compose.yaml` mounts the named volume `auto-backup-manager-data` at `/data`,
where SQLite stores its database and journal files. The volume survives container
removal, image replacement, and `docker compose down`. Its explicit name also
keeps it the same if you move the Compose file to another directory on this host.
Do not use `docker compose down --volumes` or delete the volume unless you intend
to erase the database. Moving to another host requires transferring the data;
keep a separate database backup as well.


## Scheduled backups and connection checks

In Settings, save the PostgreSQL and object storage details, then enable Backup
schedule. For **3 AM US Central every day**, use:

- Cron: `0 3 * * *`
- Timezone: `America/Chicago`

The timezone follows daylight saving time regardless of the container's system
timezone. Standard five-field cron syntax supports numbers, `*`, comma-separated
lists, ranges, and steps; weekday 0 or 7 is Sunday. When both day-of-month and
weekday are restricted, either can match. The UI shows the next scheduled run.
Schedules start disabled so configuration can be completed first.

Keep **one app instance** running. The scheduler checks every five seconds,
claims each matching local minute in SQLite, and starts at most one backup at a
time. Repeated local minutes during the autumn clock change run once; nonexistent
local times during the spring change are skipped. Missed runs while stopped and
runs overlapping an active backup are not replayed. Restarting marks an interrupted
backup as failed and attempts to abort its unfinished multipart upload. A claimed run is not retried
automatically if the app crashes during it.

Backups stream `pg_dump --format=plain` directly through `gzip -c` into an
S3-compatible multipart upload. Files are named `.sql.gz`; there is **no local
dump file**. Uploads use 16 MiB parts, backpressure, and bounded memory rather
than buffering the whole database. The current part size supports up to 10,000
parts (about 156 GiB compressed); the old 5 GiB limit no longer applies. History
records the compressed upload size. Upload completion waits for both pg_dump
and gzip to exit successfully. Failed uploads are aborted; interrupted upload
IDs are persisted in SQLite so cleanup can be retried at startup. Configure a
bucket lifecycle rule to remove incomplete multipart uploads as well, since
abrupt network loss can prevent the app from receiving an upload ID.

Storage keys need multipart create/upload/complete and abort permissions in
addition to bucket access. Automatic retention is not implemented. A backup
contains the configured database, not cluster roles or tablespaces. Ensure the
PostgreSQL client version in the image is at least as new as the source server.
Restore a new SQL backup using:

```sh
gunzip -c backup.sql.gz | psql -X -v ON_ERROR_STOP=1 --dbname=your_database
```

Existing `.dump` backups remain custom-format archives restored with `pg_restore`.

The PostgreSQL check executes `SELECT 1`; it verifies login, not permission to
dump every database object. `verify-full` checks the server certificate and
hostname using system CAs, or a CA file provided through `PGSSLROOTCERT`.
The storage check uses authenticated `HEAD` bucket access; the keys additionally
need permission to upload objects for actual backups. It does not create or
delete a test object. Storage supports access-key/secret-key authentication;
temporary session tokens and cloud IAM role discovery are not implemented.

SMTP checks verify TLS and authentication without sending a message. SMTP
supports implicit TLS and STARTTLS, with AUTH PLAIN or LOGIN, or an unauthenticated
trusted relay. TLS certificates are verified. The test-email action sends to the
recipient in the current form; SMTP acceptance does not guarantee inbox delivery.
Enable the email-result checkbox to notify the saved recipient after each backup.
Manual backups use the same saved notification settings. Email failure is recorded separately and does not change a successful backup to
failed. SMTP changes must be saved to apply to scheduled notifications.

To try your saved connections immediately, select **Run backup now** on the
Backups page. A schedule does not need to be enabled. The request starts the
backup in the background, and history refreshes every five seconds. The button
is disabled while a backup is running; manual and scheduled runs share the same
worker so they cannot overlap.
