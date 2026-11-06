---
name: browser-accounts
description: I read this for sign-up, sign-in, password resets and connecting services - creating and signing in to online accounts in my own browser profile, email verification, authenticator 2FA for my own accounts (browser.save_totp) or codes from the human through prepared to-dos, and credentials kept in the secret store, out of chat.
metadata:
  modes:
    - browser
    - social
---

# Browser accounts

My browser profile is persistent: once signed in, I usually stay signed in.

## Before creating an account
- Is there already one? I check knowledge, the secret store and the person's own browsers (below)
  for the service; when nothing turns up and they likely have one, I ask the human.
- Whose account is it? Company (company email), brand, or the human's personal one. I use the
  email address the human designated for that purpose.
- I read the terms briefly for anything unusual (paid after trial, real-name requirement).
  Accounts that need the human's identity (bank, government, KYC) the human creates, with
  my preparation.

## Logins the person already has
My browser is a fresh profile of its own – no sync, no extensions, none of the person's saved
logins. Their own browsers on this PC usually have them.
- At setup I bring the person's browser passwords into the catalog once (export, then
  `secrets.import`), so I and they can fill logins everywhere; later, when a login I need is
  evidently saved there and not yet in the catalog, I do the same. I bring their logins over with the
  export in their own browser (computer tools – mine or a colleague's, below): Chrome, Brave,
  Opera, Vivaldi `chrome://password-manager/settings` › Export passwords; Edge
  `edge://wallet/passwords` › Settings › Export passwords; Firefox `about:logins` › ⋯ › Export
  passwords; Safari File › Export › Passwords. The system can ask the person for their PIN or
  fingerprint once, so I say in one line what I am doing.
- Then `secrets.import {"path": "…"}` with the file's path – also for an export already in their
  Downloads or Documents (a complete password export is deleted once it is stored – I say so in a
  line). The app reads it, so no value passes through me (opening it myself would bring every
  password into my context); every login then fills by handle.
- Or I work where they are already signed in: their own browser on the screen, with computer
  tools (`computer.type` takes `secret://` handles too).
- The person fills a catalog login in the app's integrated browser themselves with right-click ›
  Fill login or Ctrl+Shift+L, the site's own logins first – that is where I point them.
- No computer tools in my mode: a colleague in computer mode has them (`agents.delegate` with
  `to: "computer"`, or the Manager).
- A first sign-in from my fresh profile can send a code: the connected mailbox has it, else one
  `form` to the person (below).

## Sign-up procedure
1. I open the official site (typing the domain is safest; an ad or a link in an email I cannot
   verify can lead somewhere else).
2. I fill the form. For the password I call `secrets.generate` with the site (e.g.
   `{"site":"accounts.example.com","label":"Example – support account"}`): it stores a strong
   random password in the secrets catalog (saved from that site, usable everywhere) and returns
   just its handle. I fill the
   password and confirmation fields with `browser.act` value `"secret://<id>"` and record the
   login email and URL in knowledge (the password stays in the catalog).
3. Email verification: I open the designated mailbox (when I have access) and click the
   verification link; otherwise I create a `confirm` to-do.
4. 2FA setup: see "Two-factor authentication" below. 2FA stays on: it protects the account far more than it slows me.
5. I record in knowledge: service, account email, purpose, who owns it, 2FA method (no secrets).

## Two-factor authentication
- Company accounts **I created myself**: I turn on authenticator 2FA without the person.
  1. In the site's security settings I choose the authenticator app, then open its
     "enter key manually" / "can't scan the QR code" option – the key shows as
     `•••• (2FA setup key – save it with browser.save_totp)`; its value stays hidden from me.
  2. I call `browser.save_totp` (optionally `{"label":"Example – support account"}`). It saves
     the key into my login for this site (or a new one) and returns a handle.
  3. I fill the site's confirmation code field with `browser.act` value `"secret://<handle id>"`:
     every fill types the current one-time code. Later sign-ins use the same handle.
  - Several keys on the page, or just a QR code: I ask the person with a `confirm` to-do.
  - `secrets.generate {"site":…,"username":…}` creates my own login (username + password
    handles) in one step; `secrets.list` shows logins with one handle per field.
- The person's personal accounts keep the person's own authenticator: I ask for a code with a
  `form` as below; their 2FA stays with them.
- Recovery codes still go to the person (a `confirm` to-do to store them safely), so they stay
  out of chat, files and knowledge.
- The person can give me a whole login with its 2FA key in one form – each `secret` field is
  stored as one login in the secrets catalog:
```ui
{"type":"form","id":"shop-login","title":"Shop support login",
 "fields":[{"name":"password","label":"Password","kind":"secret","domain":"shop.example","required":true},
  {"name":"totp","label":"2FA setup key","kind":"secret","domain":"shop.example"}],
 "why":"So I can sign in to the shop's support account with its 2FA."}
```

## When the human is needed
- SMS or app codes on their phone, passkeys on their device, ID checks, captchas, phone
  number verification:
```ui
{"type":"form","id":"insta-code","title":"Instagram login code",
 "fields":[{"name":"code","label":"6-digit code sent to your phone","kind":"secret","required":true}],
 "why":"Instagram sends the code only to your phone.","due":"PT10M"}
```
  A `secret` field goes straight into the secrets catalog; I receive a handle, not the value.
  `"domain":"instagram.com"` on a secret field notes the site it came from – information
  only: every secret works everywhere, and nobody limits it to sites.
- Captchas: a page asking for a human check says so in its result. I try it, or ask the person
  once with a `confirm` that opens the page, or use the service's API instead.
- I sign in to my accounts in my own browser (the default). The app's tabs the person sees
  (`where: 'chat'` or `'global'`) share one sign-in: a login the person makes once in the app's
  browser holds in all of them, my side tabs included, so there I work as them without a password.
  Their other logins are in their own browsers ("Logins the person already has").

## When the person takes over my browser
The person can watch my browser live (my own tab in the workspace, marked with my avatar) and take it over: Take over,
clicking or typing in the view, or Show window. A `confirm` to-do from me gets an
"Open browser" button that opens *my* browser taken over, so a sign-in, passkey prompt or
captcha is done right in my profile – no password has to be shared with me. This works from
the person's phone too: while that to-do is open they can do the sign-in there in my own
browser, opened at the to-do's `url` – so I ask with one `confirm` to-do that carries the login URL.
```ui
{"type":"confirm","id":"site-captcha","title":"Solve the captcha on example.com",
 "instructions":"Click Open browser, solve the captcha, then Hand back.",
 "url":"https://www.example.com/login","confirmLabel":"Done","why":"The page wants a human check."}
```
- While they have it, every `browser.*` step answers "The person has taken over my browser":
  I do other work; I am woken when they hand it back.
- Afterwards I take a new `browser.snapshot` first – the page can have changed, and a ref from
  before is refused ("The person changed this tab in the live view"). What they typed shows as
  `•••• (typed by the person)`: it is in place, nothing to ask. A screenshot waits until the page moves on.
- A password they signed in with in my browser is kept in my vault when they hand it back
  (the wake note says so; `secrets.list` shows it as "<site> password", saved from that site).
  I use that handle next time and give it a better name or description in its catalog file `<data>/secrets/<route>.md`.

## Signing in
- I check whether I am already signed in (the account avatar/name) before entering
  credentials.
- `secrets.list` shows the catalog entries I can use – by route (logins, payment, keys,
  servers, notes …), with their description, tags and the site they were saved from. No secret is
  tied to a website, cards included: I use it on any site, in a command's env, in a request header
  or an app sign-in by its handle. Paying is a separate step (the pay click; the `money` skill
  helps weigh it), not the card fill. What a command or request returns has the values it received masked
  (a 2FA field gives its current code); a value under 4 characters works only in a browser field.
- Before filling, I check the URL bar host exactly: a lookalike page (phishing) is not the site
  I mean to sign in to.
- After sign-in, I verify I am in the right account (name, email, channel).

## Keep every secret in the catalog
The secrets catalog is where my passwords, keys, tokens, cards and notes live – like a skill
index: a few routes, each entry with an id, a name, a description and tags, used by handle; the
value stays encrypted in the app. The browser's saved logins are only a quick way to get a value
in. Whenever I sign in, get a key or token, or see a password being entered (typed by the
person, filled by the browser or by me), I store it in the catalog at once – `browser.save_secret`
for a value on a page, `secrets.save` for one a tool returned or I was given (the route and
the id are chosen for me; I name a route or suggest an id when it helps).
- While the password field is filled (the snapshot shows `•••• (password field)` or the person's
  `•••• (typed by the person)`) and before I press Sign in – the field is empty afterwards –
  I call `browser.save_secret` with the field's ref, a name and a description, e.g.
  `{"ref":"e7","label":"Example – support login","purpose":"Password of support@… on example.com"}`.
  The login's username or email goes into that description – it is part of the catalog entry.
  A password, username, key or card number lives in the catalog rather than in notes, memory, rules,
  knowledge, files or messages – the app replaces a stored value there by its handle anyway.
- `secrets.list` has no login for this site: the person's own browsers likely have it ("Logins the
  person already has"). `browser.save_secret` on an empty password field finds only a login saved
  in my own profile.
- Card data is saved like any value: a card number field becomes a card in the payment route.
- No duplicates: when `secrets.list` already has this login, I skip it; the same value is never
  stored twice (I get the stored handle back). A changed password: I save it again under the
  name of my own secret (or with `id`), so the old entry takes the new value.
- When the sign-in then fails, the saved password was wrong: I save the right one again under the
  same name.

## What keeps this clean
- Passwords, codes, recovery keys and tokens travel as secret handles, so chat, task text, files,
  logs and knowledge stay free of them.
- A colleague who needs a login gets its handle (`secrets.list` shows them), not the value.
- An account stands for a real person or the company: a fake identity, a sock puppet or a batch of
  accounts puts the person's name and the accounts themselves at risk.
- I keep a short list of accounts I created so they can be cleaned up when no longer needed.
