# ThesisTrack

A web-based thesis management system. Students submit chapters, advisers review them, and the coordinator manages users, defense panels, schedules and reports.

Built with Node.js, Express, MySQL and EJS. It runs on the MySQL that comes with XAMPP.

## Run it

You need [Node.js](https://nodejs.org) 20 or newer and [XAMPP](https://www.apachefriends.org).

1. Open the XAMPP Control Panel and start **MySQL**.
2. In a terminal in this folder:

```bash
npm install
npm start
```

Open http://localhost:3000. The first run creates the `thesistrack` database, its tables and the sample data. You can browse it at http://localhost/phpmyadmin (start Apache in XAMPP too).

To wipe everything and start again with the sample data: `npm run seed`.

### Database settings

The defaults match a fresh XAMPP install. Change them with environment variables if yours differ.

| Variable | Default |
| --- | --- |
| `DB_HOST` | `localhost` |
| `DB_PORT` | `3306` |
| `DB_USER` | `root` |
| `DB_PASSWORD` | empty |
| `DB_NAME` | `thesistrack` |

## Sample accounts

Every sample account uses the password `password123`.

| Role | Email |
| --- | --- |
| Student (in Team Pagasa) | juan@student.edu.ph |
| Student (no group yet) | rico@student.edu.ph |
| Adviser | reyes@school.edu.ph |
| Coordinator | admin@school.edu.ph |
| System administrator (sign in at /system/login, not linked from the sign-in page) | system@school.edu.ph |

Delete the sample accounts before real use.

## System administrator

One level above the coordinators. It has no workspace and manages the whole site at `/system`:

- **Workspaces:** create one with its first coordinator, rename it, make a new join code, suspend or reactivate it, add more coordinators, delete it.
- **Users:** search every account in every workspace, filter by role, workspace and status, edit a name or email, reset a password, sign someone out of every device, deactivate, download a CSV, add another system administrator.
- **Groups:** a read-only list of every group with its adviser and progress.
- **Announcements:** send a notice to every workspace (or one), and choose who gets a notification.
- **Activity log:** every workspace in one place, with a workspace filter and CSV download.
- **System:** close coordinator sign-up, see server health and record counts, clear old sessions, reset links, invitations and notifications.

It cannot open students' chapters, comments or uploaded files. Run `npm run test:system` on a freshly seeded database to check it.

## Messages

Students, advisers and the coordinator talk under **Messages** in the top menu. Two kinds of thread:

- **Group thread:** one per thesis group. The group's students, their adviser and the coordinator can read and write in it.
- **Private thread with the coordinator:** one per student and one per adviser. Only that person and the workspace's coordinators can read it.

The coordinator starts a thread with any group or person from the list on the Messages page. Everything stays inside one workspace, and the system administrator cannot read message text. The coordinator can hide an abusive message (it stays in the database as evidence). Text only, up to 2000 characters, at most 20 messages a minute per person. New messages show a count in the menu and one notification per thread, and an open thread checks for new messages every 8 seconds. Run `npm run test:messages` on a freshly seeded database to check the rules.

## Adviser invitations

Nobody can register as an adviser on their own, and the registration form never sets a role.

1. The coordinator opens **Advisers**, enters the adviser's name and email, and sends the invitation. The system saves it with the role adviser and the status Invited, and emails a random 6-digit code.
2. The adviser opens `/register/adviser` (linked from the sign-in page), enters the invited email and the code, and chooses a password.
3. If the code is correct, unused and not expired (60 minutes), and the email matches the invitation, the account is created as an adviser and the code is marked used.

A code is stored only as a hash. Five wrong codes lock that invitation until the coordinator uses **Send a new code**. The coordinator can also cancel an invitation. The old "add a user" form no longer creates advisers.

### Sending real email (Gmail)

Put these in the `.env` file in the project folder (it is not committed to git), or set them in the terminal before `npm start`. Put your own Gmail address in `SMTP_USER` and its App Password in `SMTP_PASS`, and never paste the password into this README. For Gmail, turn on 2-step verification and create an App Password at https://myaccount.google.com/apppasswords.

| Variable | Example |
| --- | --- |
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `465` |
| `SMTP_USER` | `lovelybillones417@gmail.com` |
| `SMTP_PASS` | your 16-character Google App Password |
| `MAIL_FROM` | optional, defaults to `SMTP_USER` |

Terminal alternative, PowerShell: `$env:SMTP_HOST="smtp.gmail.com"; $env:SMTP_USER="you@gmail.com"; $env:SMTP_PASS="your-app-password"; npm start`

Without these settings nothing is emailed. The message, including the code, is written to `outbox/mail.log` in the project folder, which is enough for testing on your own computer.

## Workspaces (several coordinators, one website)

Every coordinator has a private **workspace**. The system administrator invites a teacher (name and email) under **Workspaces**, and the teacher gets a single-use invitation code by email. The code works once, for that email only, for 7 days, and five wrong tries lock it. The teacher opens `/register/coordinator`, enters the email and code, and gets a workspace with a join code. Students register with that code (or the link shown on the coordinator's Overview page) and advisers join through the coordinator's invitation, so each person belongs to exactly one workspace. Groups, users, panel members, announcements, invitations, reports, the activity log, uploaded files, ID photos and the similarity check are all limited to the workspace, so one coordinator never sees another's students.

- Nobody can open a workspace without an invitation. The system administrator can pause all invitation codes at once under System, and can also create a workspace directly.
- An existing database is upgraded on start: all current data moves into one "Default workspace".
- The sample data has two workspaces: `admin@school.edu.ph` and `admin2@school.edu.ph`. Sign in as each to see that they share nothing.
- `npm run test:workspaces` (server running, fresh `npm run seed`) tries to break the separation and reports each check.

## Panel members

Panel members do not sign in and have no dashboard. The coordinator adds them under Users with the role Panel member (no password needed) and records them on a group's page when scheduling its defense. Only the coordinator sees who is on a panel. Students and advisers see the defense date, time and room.

## Student registration

A new student enters their full name, a unique student ID number and email, and gives a photo of their student ID. The register page can open the device camera to take the photo. If the camera is unavailable it falls back to choosing a file; on a phone that opens the camera too. The camera needs `localhost` or HTTPS, so over plain `http://192.168...` use the file picker.

ID photos are stored in `uploads/` under random names and are only served to the coordinator and the student who owns the photo. The coordinator sees the student ID number and a photo thumbnail on the Users page. Sample students have ID numbers but no photo.

## Student page, groups and the group leader

After registering, a student sees their profile (photo, name, student ID) and chooses to **create a group** or **join one**. Nothing is created automatically.

- **Leader:** whoever creates a group is its leader. Only the leader adds or removes members, hands the role to another member, cancels invitations and makes a new join code. Any member can leave; a leader who leaves passes the role to the member who joined first. The last member cannot leave. A group holds up to 6 people, invitations included.
- **Join code and link:** every group has a 6-character code and a link (`/student/join/CODE`). A student with an account in the same workspace types the code under *Join a group*. A code from another workspace never works, and ten wrong tries in 15 minutes are blocked.
- **Invitations:** the leader can enter the email of a teammate who has no account yet. When that person registers with the workspace's join code, they join the group straight away.
- **Dashboard:** next-up strip (nearest deadline), first-steps checklist, defense countdown, adviser card, recent activity and an outline of what each chapter usually contains.
- `npm run test:groups` checks all of this (server running, fresh `npm run seed`).

## Try the workflow

1. Sign in as Juan. Open Chapter 4 and upload a PDF or Word file.
2. Sign out. Sign in as Dr. Reyes. Chapter 4 is waiting under Team Pagasa. Return it for revision with a comment.
3. Sign in as Juan again. The status changed and the comment is there. Mark it resolved and upload version 2.
4. Dr. Reyes approves it. The chapter locks.
5. Sign in as the coordinator. Schedule a defense for Team Pagasa and record two panel members.

Adviser assignment needs the adviser's consent. Create a new group as a student, then sign in as the coordinator and pick an adviser on the group's page. That only sends a request. Sign in as that adviser and accept it, or decline it with a reason. The coordinator is notified with the reason and sees it on the group's page.

To check the workflow automatically, run `npm run seed`, `npm start`, then `npm test` in a second terminal.

## Project layout

```
server.js        app setup, sessions, CSRF, route mounting
db.js            MySQL connection and all table definitions
seed.js          sample data
lib.js           constants (chapters, time slots), status logic, shared queries
middleware.js    login, role and CSRF checks
routes/          auth, student, adviser, admin, shared (downloads, notifications)
views/           EJS pages, one folder per role
public/          style.css
scripts/         smoke-test.js
uploads/         uploaded chapter files (created on first run)
```

## Where to change things

- **Chapter names:** `CH_NAMES` in `lib.js`.
- **Consultation time slots:** `SLOTS` in `lib.js`.
- **Allowed file types and size:** top of `routes/student.js`.
- **Database tables:** `db.js`. For your ERD chapter, the tables are users, thesis_groups, group_members, group_panelists, chapters, submissions, comments, consultations, announcements, notifications, activity_log, adviser_requests and adviser_invites.

## How the chapter workflow works

`Not submitted` → student uploads → `Pending review` → adviser decides → `Approved`, `For revision` or `Rejected`. A student can upload again only after a revision or rejection. Each upload is a new row in `submissions`, so old versions are never overwritten.

A group is **delayed** when a chapter is past its deadline and still Not submitted, For revision or Rejected. It is **completed** when all five chapters are approved.

## Security in this version

- Passwords are hashed with bcrypt.
- Every form carries a CSRF token.
- Every query uses bound parameters.
- Pages escape user text by default.
- Role checks guard every route, and file downloads check that you belong to the group.
- Uploads are limited to PDF, DOC and DOCX up to 10 MB and are stored under random names.
- Repeated failed logins from one address are blocked for 15 minutes.

## Before you put it online

See [DEPLOY.md](DEPLOY.md) for the full publishing steps. The points below are now handled by `NODE_ENV=production`: sessions are stored in MySQL, cookies are HTTPS-only, and sample accounts are not created.


- Set a real `SESSION_SECRET` environment variable.
- Serve it over HTTPS.
- Delete the sample accounts.
- Sessions are kept in memory, so they reset when the server restarts. Use a persistent session store for production.
- Notifications are in-app only. Email or SMS needs an extra package such as Nodemailer.

## Moving to Laravel

The database is already MySQL, so the tables and the status workflow carry over directly. `db.js` maps to migrations, `routes/` to controllers, `views/` to Blade templates and `lib.js` to model methods and a service class.

## Backup (free)

With MySQL running, `npm run backup` saves the database (`database.sql`) and the uploaded files into `backups/<date>/`. If `mysqldump` is not found, set `MYSQLDUMP` to its full path (XAMPP: `C:\xampp\mysql\bin\mysqldump.exe`). Copy the folder to a flash drive or a free cloud drive. Restore with `mysql -u root thesistrack < backups/<date>/database.sql`.

## Forgot password

Users can ask for a one-time reset link on `/forgot` (valid for 30 minutes). Without email settings, the link is written to `outbox/mail.log`; the system administrator can also reset a password (coordinators cannot), and is notified when someone asks for a reset link. Set `APP_URL` (for example `https://your-site.example`) so the link in the email points to the live site.

## Other features

- **Activity log** (coordinator): search, date range, paging and CSV download.
- **Privacy Notice** at `/privacy`; students agree to it when they register.
- **Notifications** can be deleted one by one or cleared.
- `/healthz` also checks the database. When MySQL is down, users see a "Service unavailable" page instead of an error.
