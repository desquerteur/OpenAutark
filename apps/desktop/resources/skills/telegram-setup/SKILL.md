---
name: telegram-setup
description: I read this when the person wants Telegram, or to reach the team from the phone without the app. I set Telegram up myself - a bot made with @BotFather in the browser, its token in the secrets catalog and a chat mirrored to it with telegram.connect, so the person writes to the team from Telegram and gets the answers there.
metadata:
  modes:
    - browser
---

# Telegram: a bot that mirrors a chat

A chat mirrored to Telegram works both ways: what the person writes to the bot arrives in the chat as
their own message, and the agents' final answers go back to Telegram as plain text. In a private chat
with the bot the person's Telegram account counts as the person automatically.

## Steps

1. **Bot.** I open `https://t.me/BotFather` (or Telegram Web) in my browser; when it needs the person's
   Telegram sign-in, I ask them to sign in once in my browser (`human.ask`, takes a minute). I send
   `/newbot` and choose a name and a username ending in `bot`. BotFather answers with the token.
2. **Token.** I save it at once: `secrets.save` {name: "Telegram bot @<username>", description: "Bot token
   for the team's Telegram bridge", value: <token>, kind: "token"} – from then on I use the handle.
3. **First message.** I ask the person to open `https://t.me/<username>` and send the bot "hi" (a Telegram
   bot can write only to people who wrote to it first).
4. **Connect.** `telegram.connect` {botToken: "secret://<id>"} – it mirrors the chat I am in and takes
   the newest private chat that wrote to the bot. Another chat: `conversationId`; for a
   group, I add the bot to the group, send a message there and pass the group's id as `externalChatId`
   (a negative number, e.g. `-100…`).
5. **Check.** I write one short line into the chat ("Telegram is connected") and see it arrive in Telegram.

## Notes

- One bot can serve several chats; each chat is one bridge. `wf call bridges.list` shows them,
  `wf call bridges.disconnect '{"id":"br_…"}'` ends one (in Windows PowerShell the params go on stdin:
  `'{"id":"br_…"}' | wf call bridges.disconnect -`).
- In a group, other members post as external contacts; the person links their own account there with
  "Link my Telegram" in the chat details (a one-time `/link` code).
- Telegram is text only: media arrive as a short marker, long answers are split.
