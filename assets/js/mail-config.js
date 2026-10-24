/* Newsletter email — Google OAuth client ID.

   Every club sends through its own Gmail: a founder or admin clicks
   "Connect Gmail" once in the Newsletters page, and announcements go out
   from their own address, against their own Gmail quota. Nothing is sent
   through a shared platform mailbox, so no club can spend another club's
   allowance or get a shared account suspended.

   To switch this on for the site (once, by the site operator):

     1. Google Cloud console, same project as Firebase (nchs-chess-club)
        → APIs & Services → Library → enable "Gmail API"
     2. → Google Auth Platform → Data Access → add three scopes:
          https://www.googleapis.com/auth/gmail.send          (sensitive)
          https://www.googleapis.com/auth/userinfo.email      (non-sensitive)
          https://www.googleapis.com/auth/userinfo.profile    (non-sensitive)
        The two userinfo scopes are what let the page read back WHICH
        mailbox was connected; without them the connect step fails.
        Until the app passes Google verification it shows an "unverified
        app" warning and allows at most 100 connected accounts.

        The club calendar uses this SAME client, so add one more there:
          https://www.googleapis.com/auth/calendar.events     (sensitive)
        Without it the Google Calendar switch on the events page connects
        and then fails on the first read, because consent was never asked
        for the scope the calls need.
     3. → Credentials → Create credentials → OAuth client ID → Web
        Authorized JavaScript origins:
          https://jagchess.web.app
          https://nchs-chess-club.web.app
          http://localhost:3000
     4. Paste the client ID below and redeploy.

   Left blank, the newsletter still publishes normally — only the email
   step is unavailable, and the panel says so. */
/* Only the client ID belongs here. It is public by design — it ships in every
   page and identifies the app during consent. The client_secret that came in
   the same downloaded JSON is NOT used by this flow and must never be added
   to the site; browser code has nowhere to keep a secret. */
window.MAIL_CONFIG = {
  googleClientId: '683171999944-o585apka0j4m0tjhognc07u46iq07v45.apps.googleusercontent.com',
};
