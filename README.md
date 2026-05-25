# Discord Music Bot for Render

Node.js Discord music bot with:

- Spotify track, playlist, and album links
- Queue commands
- Player UI in chat with buttons
- Auto-leave from the voice channel when playback ends, stops, or the voice channel is empty
- Render deployment support

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env` from `.env.example`.

3. Run locally:

```bash
npm start
```

The bot registers slash commands on startup when `CLIENT_ID` is set.

## Discord Commands

- `/play :<song name or spotify/youtube link>`
- `/queue`
- `/nowplaying`
- `/pause`
- `/resume`
- `/skip`
- `/stop`

## Render

Push this folder to GitHub, then create a Render Blueprint from `render.yaml`.
Add these environment variables in Render:

- `DISCORD_TOKEN`
- `CLIENT_ID`
- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`

Spotify credentials are recommended because Spotify links provide metadata. Playback is resolved through available audio sources because Spotify itself does not provide raw Discord-playable audio streams.
