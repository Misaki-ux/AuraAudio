# AuraAudio Login

## Default access

AuraAudio opens in **Guest** mode. There is no shared default username or password. Guest mode keeps local playback available immediately and does not require Google or GitHub.

Click **Guest** in the top bar to open the account screen. Enter an email address and request a one-time PIN. On first successful verification, AuraAudio creates the account; later verifications sign into the same account. An optional display name can be supplied when requesting the first PIN.

## Email delivery setup

The embedded server sends codes through Resend. Configure these environment variables before launching AuraAudio:

- `AURA_EMAIL_API_KEY`
- `AURA_EMAIL_FROM`

See [HOW_TO_RUN.md](HOW_TO_RUN.md) for the PowerShell launch command. No default or demo PIN is printed or exposed by the server.

## PIN and session behavior

- A PIN is six digits, expires after 10 minutes, and can be tried up to five times.
- A new PIN can be requested once per minute per email address; the server also rate-limits requests per client address.
- A verified PIN can be used only once.
- Pending PINs are held in memory as keyed hashes. Restarting the server invalidates outstanding PINs.
- The session token is stored locally by the desktop app. Signing out removes it from this app, but does not revoke an already issued token server-side.

An email PIN is passwordless sign-in. It is not MFA on its own. To use true MFA, add a second independent factor after the first factor has been verified.
