# Publishing ThesisTrack

## What the live site needs

- A host that runs **Node.js 20+** (a VPS, Render, Railway, or similar).
- A **MySQL** database (the host's managed MySQL, or MySQL on the same server).
- **HTTPS**. Most hosts give it for free; the site must not be served over plain http.
- A **persistent disk** for uploaded files, or the uploads disappear on every redeploy.

## Live mode vs. your computer

Setting `NODE_ENV=production` switches on the live behaviour:

| | Your computer | Live (`NODE_ENV=production`) |
| --- | --- | --- |
| Sample accounts | Created, shown on the sign-in page | **Not created, not shown** |
| First coordinator | `admin@school.edu.ph` | Created from `ADMIN_EMAIL` / `ADMIN_PASSWORD` |
| System administrator | `system@school.edu.ph` | Created from `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` |
| Session cookie | Works on http | HTTPS only (`Secure`) |
| `SESSION_SECRET` | Optional | **Required** (the app refuses to start without it) |
| `npm run seed` | Resets everything | **Refuses to run** |

Login sessions are stored in MySQL, so a restart or redeploy no longer signs everyone out.

## Steps

1. **Create the MySQL database** and note its host, port, user and password. The app creates its own tables on first start.
2. **Put the project on the host.** Upload the folder, or push it to git and connect the host. Do not upload `node_modules`, `.env`, `data/` or `uploads/`.
3. **Set the environment variables** from [.env.example](.env.example) in the host's settings screen. Generate `SESSION_SECRET` with the command shown in that file.
4. **Build and start commands:** `npm install` then `npm start`. A health check can use `/healthz`.
5. **Open the site** and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Then change that password and delete `ADMIN_PASSWORD` from the settings. Also set `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` (at least 10 characters) so a system administrator exists, sign in as it at /system/login and delete `SUPERADMIN_PASSWORD` too.
6. **Test with real roles:** invite an adviser (check the email arrives), register a test student, upload a chapter, review it, then delete the test data.

## Updating the live site

1. Test the change on your own computer first.
2. Back up the database (export it from phpMyAdmin or the host's tool) and the uploads folder.
3. Redeploy the new files. Users, groups and files are kept, because they live in MySQL and the uploads folder, not in the code.
4. Never run `npm run seed` on the live database.

## Before you announce it

- [ ] `NODE_ENV=production` and a long random `SESSION_SECRET` are set
- [ ] The site opens on `https://` and there are no sample accounts on the sign-in page
- [ ] The coordinator password was changed and `ADMIN_PASSWORD` removed
- [ ] Adviser invitation emails arrive (`SMTP_*` set on the host, not in the README)
- [ ] Uploads folder is on a persistent disk and is backed up
- [ ] A database backup exists and you know how to restore it
- [ ] Your school's data privacy rules are met for the student ID photos
