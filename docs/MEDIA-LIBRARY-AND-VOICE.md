# Media library and Shirin's voice (08.11.2026)

- Panel -> "Медиа на повтор": upload photo / mp4 / PDF / voice (<= 8 MB, the WhatsApp bridge cap), caption and match keywords.
  Stored as `StyleExample` with `source = LIBRARY`; the bot picks approved items through `ai/mediaReuse.ts`.
- WhatsApp bridge sends `audio` as a real voice note (`sendAudioAsVoice`), shows "recording audio..." instead of "typing...", no caption on voice.
- ElevenLabs (`ai/voiceClone.ts`): off by default. Needs `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` (optional `ELEVENLABS_MODEL`)
  in the server `.env` AND setting `voiceCloneEnabled = true`. Synthesised files land in the library UNAPPROVED: a human listens and approves.
  Shirin gave personal consent to voice cloning on 2026-11-08.
- Not verified yet: mp3 -> ptt conversion in whatsapp-web.js and Tajik quality of `eleven_multilingual_v2`; test on the owner's number only.

## Update 2026-11-08 (after architect review)
- Voice is re-encoded to ogg/opus via ffmpeg (`ai/audioConvert.ts`) for uploads and ElevenLabs output; no ffmpeg -> original file kept.
- TTS cache on disk by hash(normalised text + voice + model + settings): the same text is never paid for twice.
- Monthly cap (`voiceMonthlyCapUsd`, default $20) and price (`voicePricePer1kUsd`, default 0.08 - the owner's figure, NOT verified on ElevenLabs' site). Owner-only alert at 80% and at the cap.
- Settings keys `voiceCloneEnabled`, `voiceMonthlyCapUsd`, `voicePricePer1kUsd` are now in SETTING_KEYS.
- LIBRARY rows are excluded from style-learning examples. Bridge rejects audio + text in one send.
- Voice-vs-text rule for the bot (who answers by voice) is NOT implemented: waiting for the owner's approval of the rule.
- Open: model/language measurement (Tajik, accent) needs an API key available locally; the key lives on the server only. Clone consent: the owner relayed the sister's consent; ask her to confirm in Telegram, then record date/wording here.

## Voice-or-text rule (ai/voiceReply.ts), switch `voiceReplyEnabled` OFF by default
Voice only for a short warm single-part reply on WhatsApp (<=160 chars, <=240 after the client's own voice note). Always text: links, any numbers/prices/money words, card/requisites, multi-line, long. Never two voice replies in a row (previous OUT message starts with the microphone mark). Any synthesis error (cap, network) falls back to text. Needs ElevenLabs key + `voiceCloneEnabled=true` too.
