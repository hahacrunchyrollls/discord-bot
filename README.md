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

- `/play title:<song name or spotify/youtube link>`
  - Type a song title and pick from the autocomplete options.
  - If music is already playing, the new song is added to the queue automatically.
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

## Debian 13 VPS Installer

On your Debian 13 VPS, clone your bot repo, then run:

```bash
git clone https://github.com/hahacrunchyrollls/discord-bot.git
cd discord-bot
sudo bash install-debian13.sh
```

You can also run the installer as a standalone script. If it does not find `package.json` beside the script, it will clone `https://github.com/hahacrunchyrollls/discord-bot.git` into `/opt/discord-music-bot`.

Optional overrides:

```bash
sudo INSTALL_DIR=/opt/my-bot REPO_BRANCH=main bash install-debian13.sh
```

After install, edit your `.env` file:

```bash
nano .env
```

Start and view logs:

```bash
sudo systemctl start discord-music-bot.service
sudo journalctl -u discord-music-bot.service -f
```

## Voice Connection Troubleshooting

If you see `VOICE_CONNECT_FAILED`, check these first:

- The bot has `Connect` and `Speak` permission in the voice channel.
- The bot role is not blocked by channel-specific permission overrides.
- The voice channel is not full.
- You redeployed the latest code after changing commands.
- If the error only happens on a hosting provider, make sure the host supports Discord voice connections.
