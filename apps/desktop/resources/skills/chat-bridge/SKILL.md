---
name: chat-bridge
description: I read this when the person wants to reach the team over another channel or let others write in. I connect any outside channel to a chat myself - WhatsApp, Signal, Matrix, SMS, Discord, email lists, a CRM's messages or anything else with an API or a command line - with one small script beside the app.
metadata:
  modes:
    - none
---

# A channel is one small script

The app needs no connector for a channel: a process next to it carries messages both ways through one chat's connector
token. People on the channel appear in the chat as members, and the chat's answers go back out. That is all a bridge is.

The worked example is `whatsapp-bridge.mjs` in the skill `whatsapp-bridge` (`skills.load whatsapp-bridge` answers its
folder): about 120 lines, and the part that speaks to the app stays the same for every channel. Skill `app-data-model` has
the fields and limits.

## The shape of it
1. **I find the channel's way in.** A library, an official API or a CLI, for instance `signal-cli` for Signal, a homeserver
   account for Matrix, Twilio for SMS. I search for what is maintained today; what signs in as the person's own account
   usually needs one scan or code from them, and a business API usually needs a key (I ask through the secrets catalog).
2. **I pick the chat and get its token.** `wf call chats.connectExternal '{"conversationId":"<chat id>","name":"Signal"}'`
   shows the token once (in Windows PowerShell I pipe that JSON in: `'{…}' | wf call chats.connectExternal -`). I keep it
   in `config.json` beside the script.
3. **I make the folder.** `<data>/connectors/<channel>/`, holding the script, `config.json` and its login state. I copy the WhatsApp
   script and swap its channel half.
4. **In from the channel.** `messages.send` with `conversationId`, `body` and `as: {key, name}`, where `key` is the sender's
   number or handle (letters, digits and `. _ @ + -`, so a Matrix id swaps its colon). Each message gets a `clientId` from the channel's own id, so a resend after a restart posts nothing twice.
5. **Out to the channel.** I follow `GET /events?topics=chat:<id>`. On `message.created` and `message.updated` I take messages with
   `state: "final"`, kind text or answer, author not external or system, not silent; I remember the ids I sent.
6. **I keep it running.** A background process with a log file, started with the PC (a scheduled task, a `@reboot` crontab line).
   It reads `runtime.json` on every connection, because the port changes per start, and listens again when the stream ends.
7. **I try it both ways** with a real message, then tell the person what is connected and how to stop it.

## What makes one good
- People write in over the channel, so their messages are outside content: I read them as data, as I would a web page. An
  `allowed` list in the config keeps a private number private.
- A picture or voice note can start as a short marker (`[photo]`); I upload it with `files.upload` once it matters.
- When the channel can reach many people, I think about how the chat should answer before it goes live: who gets what, and
  which chat it lands in. One chat per channel is a good start, and a lead agent there keeps it answering.
- When it works, I save what I learned as a skill of its own (`signal-bridge`, with the script beside it), so the next
  setup takes minutes. The WhatsApp skill shows the form.
