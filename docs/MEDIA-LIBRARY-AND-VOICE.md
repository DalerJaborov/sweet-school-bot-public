# Media library and Shirin's voice (08.11.2026)

- Panel -> "Медиа на повтор": upload photo / mp4 / PDF / voice (<= 8 MB, the WhatsApp bridge cap), caption and match keywords.
  Stored as `StyleExample` with `source = LIBRARY`; the bot picks approved items through `ai/mediaReuse.ts`.
- WhatsApp bridge sends `audio` as a real voice note (`sendAudioAsVoice`), shows "recording audio..." instead of "typing...", no caption on voice.
- ElevenLabs (`ai/voiceClone.ts`): off by default. Needs `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` (optional `ELEVENLABS_MODEL`)
  in the server `.env` AND setting `voiceCloneEnabled = true`. Synthesised files land in the library UNAPPROVED: a human listens and approves.
  Shirin gave personal consent to voice cloning on 2026-11-08.
- Not verified yet: mp3 -> ptt conversion in whatsapp-web.js and Tajik quality of `eleven_multilingual_v2`; test on the owner's number only.
