# Social: YouTube and TikTok

Studio's **Social** tab (`#social`, `src/social.ts`, `dashboard/social.js`) connects the studio's YouTube channel and
TikTok account, and uploads finished videos to them. **Nothing goes public from Studio:**

- **YouTube:** uploads are **private** (category Gaming). J opens YouTube Studio (the post links it) and sets Public or
  Scheduled. An API project that hasn't passed Google's audit can only upload private videos anyway.
- **TikTok:** uploads land in the TikTok app's **inbox as a draft** (Content Posting API, `video.upload`). J gets a
  notification, adds the caption (the post keeps it: "Copy caption"), and posts.

So agents may post (`studio_social_post`, also in agents' MCP servers): the last step is always J's, on the platform.
Connecting, disconnecting and the app settings are J's alone: admin only (`auth.ts memberRefusal`) and never from the
sandbox (`guards.ts`).

## Setting up (once, J)

The redirect URIs are shown in the tab: `https://studio.hawkesgen.com/api/social/callback/youtube` and `.../tiktok`.

**YouTube** (Google Cloud console, the same project as the hawkesgen.com sign-in is fine):
1. APIs & Services › Library: enable **YouTube Data API v3**.
2. Credentials › Create credentials › OAuth client ID › **Web application**. Authorized redirect URI: the YouTube one above.
3. OAuth consent screen › Data access: add the scopes `youtube.upload` and `youtube.readonly`.
4. Publishing status: **In production** (in Testing, Google ends the sign-in after 7 days). Google shows an "unverified
   app" warning to J when he connects: Advanced › continue. Verification is only needed for other people's accounts.
5. Paste the client ID and secret in the Social tab, then **Connect YouTube** and pick the Pierce Hawkes channel.

**TikTok** (developers.tiktok.com):
1. Manage apps › Connect an app. Add products **Login Kit** and **Content Posting API**.
2. Login Kit: redirect URI the TikTok one above. Scopes: `user.info.basic`, `video.upload`.
3. Until the app is reviewed it's in **Sandbox**: add J's TikTok account as a target user (Sandbox settings).
4. Paste the client key and secret in the Social tab, then **Connect TikTok**. TikTok's sign-in lasts a year; the tab
   says when to reconnect.

## Storage

`.data/social.json` (0600): each app's client id and secret and its refresh token. `GET /api/social` never returns
them. Posts are the `social_posts` table (asset, title, caption, tags, platforms, each platform's result).

## Making videos for it

Videos are Gen assets (`.mp4`). Vertical 1080×1920 under 60 s for Shorts and TikTok (put `#Shorts` in the title or
description), 1920×1080 for a regular YouTube video. Content agents make them with Hawkes Gen and ffmpeg, then post
with `studio_social_post`; Talk can ask for one.
