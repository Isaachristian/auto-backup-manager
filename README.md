# Auto Backup Manager

A minimal Node.js backend and plain HTML, CSS, and JavaScript frontend.
No dependencies or tests are included. All project files live in the root.

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
