# Stale Follows for Bluesky

Find the accounts you follow on Bluesky that have gone quiet, and unfollow them.

Enter your handle and the app shows when each account you follow was last active, as a sorted chart and a sortable table. Deleted, deactivated and suspended accounts are flagged separately. With an app password you can select the stale accounts and unfollow them in one step.

It is a static site (plain HTML, CSS and JavaScript, with no build step or server), so it runs on GitHub Pages as-is.

## Using it

1. Open the site and enter your Bluesky handle.
2. Optionally enter an **app password**. Without one the analysis is read-only; with one you can unfollow. The in-app **Help** button explains how to create one (Bluesky → Settings → Privacy and security → App passwords).
3. Choose **Analyze follows**. Pick the threshold (3 months to 2 years) and whether activity means any activity or posts only.
4. Choose **Select all stale & gone**, uncheck anyone you want to keep, then choose **Unfollow** and confirm. **Export CSV** saves a copy of the list first.

## Privacy

- Your app password is never sent to or stored on GitHub Pages; there is no backend.
- It is sent from your browser directly to your Bluesky account server (bsky.social or your own PDS) to create a session, then cleared from the form.
- The session is kept in memory only (never in cookies or localStorage) and ends when you sign out or close the tab.
- Only app-password-formatted input (`xxxx-xxxx-xxxx-xxxx`) is accepted, so a main password can't be sent by mistake.
- A Content-Security-Policy restricts the page to its own scripts and styles.

## How activity is measured

Bluesky doesn't expose last-login times, so the app uses public activity:

| Signal | Source |
|---|---|
| **Last post**: newest post, reply or repost | `app.bsky.feed.getAuthorFeed` on the public AppView |
| **Last active**: newest write of any kind (posts, likes, reposts, follows, blocks, profile edits) | Timestamp in the latest repo commit revision, from `com.atproto.sync.getLatestCommit` on the account's PDS. Only looked up for accounts that haven't posted in 30 days. |
| **Gone**: deleted, deactivated or suspended | Missing from `app.bsky.actor.getProfiles`; the reason comes from `getProfile` |

Your follow list is read from your own repo (`com.atproto.repo.listRecords`), so follows of deleted accounts are included. Unfollowing deletes those follow records with `com.atproto.repo.applyWrites`.

Requests run with limited concurrency and back off automatically when a server rate-limits them. A few thousand follows usually take a minute or two.

## Deploying to GitHub Pages

1. Push this repository to GitHub.
2. In the repository, open **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**, choose the branch (e.g. `master`) and the `/ (root)` folder, then **Save**.
4. The site is published at `https://<user>.github.io/<repo>/` within a minute or two.

## Running locally

Any static file server works, since ES modules need to be served over HTTP:

```sh
python3 -m http.server 8080
# then open http://localhost:8080
```

## Files

```
index.html      markup, help text, dialogs
style.css       styles (light and dark)
js/atproto.js   minimal AT Protocol client (identity, session, follows, activity)
js/chart.js     sorted activity chart (SVG)
js/app.js       scan pipeline, table, selection, unfollow, CSV export
```
