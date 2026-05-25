require("dotenv").config();

const express = require("express");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder
} = require("discord.js");
const { DisTube } = require("distube");
const { SpotifyPlugin } = require("@distube/spotify");
const { YtDlpPlugin } = require("@distube/yt-dlp");
const ytSearch = require("yt-search");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;

if (!token) {
  throw new Error("Missing DISCORD_TOKEN. Add it to your .env or Render environment variables.");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages
  ]
});

const playerMessages = new Map();

const plugins = [
  new YtDlpPlugin()
];

if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
  plugins.unshift(new SpotifyPlugin({
    api: {
      clientId: process.env.SPOTIFY_CLIENT_ID,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET
    }
  }));
} else {
  plugins.unshift(new SpotifyPlugin());
}

const distube = new DisTube(client, {
  emitNewSongOnly: true,
  nsfw: false,
  plugins
});

const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play a song or add it to the queue.")
    .addStringOption(option =>
      option
        .setName("title")
        .setDescription("Song title, Spotify link, or YouTube link")
        .setRequired(true)
        .setAutocomplete(true)
    ),
  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Show the current music queue."),
  new SlashCommandBuilder()
    .setName("nowplaying")
    .setDescription("Show the current song."),
  new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Pause the current song."),
  new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Resume playback."),
  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip the current song."),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop music and leave the voice channel.")
].map(command => command.toJSON());

const emptyVoiceTimers = new Map();
const autocompleteCache = new Map();
const autocompleteTitles = new Map();

const AUTOCOMPLETE_TIMEOUT_MS = 1_800;

async function registerCommands() {
  if (!clientId) {
    console.warn("CLIENT_ID is not set. Slash commands were not registered.");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log("Slash commands registered.");
}

function leaveVoice(guildId) {
  try {
    distube.voices.leave(guildId);
  } catch (error) {
    if (error?.errorCode !== "NO_QUEUE") {
      console.error("Could not leave voice channel:", error);
    }
  }
}

function scheduleLeaveIfAlone(voiceChannel, textChannel) {
  if (!voiceChannel?.guild?.id) return;

  const guildId = voiceChannel.guild.id;
  const humanMembers = voiceChannel.members.filter(member => !member.user.bot);

  if (humanMembers.size > 0) {
    clearTimeout(emptyVoiceTimers.get(guildId));
    emptyVoiceTimers.delete(guildId);
    return;
  }

  if (emptyVoiceTimers.has(guildId)) return;

  const timer = setTimeout(() => {
    const queue = distube.getQueue(guildId);
    if (queue) {
      distube.stop(guildId);
    }

    leaveVoice(guildId);
    playerMessages.delete(guildId);
    emptyVoiceTimers.delete(guildId);
    textChannel?.send("The voice channel is empty, so I left.").catch(() => null);
  }, 60_000);

  emptyVoiceTimers.set(guildId, timer);
}

function buildPlayerRow(queue) {
  const isPaused = Boolean(queue?.paused);

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("music:pause_resume")
      .setLabel(isPaused ? "Resume" : "Pause")
      .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("music:skip")
      .setLabel("Skip")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("music:stop")
      .setLabel("Stop")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("music:queue")
      .setLabel("Queue")
      .setStyle(ButtonStyle.Secondary)
  );
}

function formatDuration(song) {
  return song?.formattedDuration || song?.duration || "Live";
}

function buildPlayerEmbed(queue) {
  const song = queue?.songs?.[0];

  if (!song) {
    return new EmbedBuilder()
      .setColor(0x2b2d31)
      .setTitle("Player idle")
      .setDescription("Nothing is playing right now. Use `/play` to start music.")
      .setFooter({ text: "Auto-leave is enabled when playback is done." });
  }

  const nextSongs = queue.songs
    .slice(1, 6)
    .map((queuedSong, index) => `${index + 1}. ${queuedSong.name}`)
    .join("\n");

  return new EmbedBuilder()
    .setColor(queue.paused ? 0xf1c40f : 0x2ecc71)
    .setTitle(queue.paused ? "Paused" : "Now Playing")
    .setDescription(`[${song.name}](${song.url})`)
    .setThumbnail(song.thumbnail)
    .addFields(
      { name: "Duration", value: formatDuration(song), inline: true },
      { name: "Requested by", value: song.user ? `<@${song.user.id}>` : "Unknown", inline: true },
      { name: "Queue", value: nextSongs || "No songs queued next.", inline: false }
    )
    .setFooter({ text: `${queue.songs.length} song(s) in queue` });
}

async function upsertPlayerMessage(queue, textChannel) {
  if (!textChannel || !queue) return;

  const payload = {
    embeds: [buildPlayerEmbed(queue)],
    components: [buildPlayerRow(queue)]
  };

  const oldMessage = playerMessages.get(queue.id);

  try {
    if (oldMessage) {
      const message = await textChannel.messages.fetch(oldMessage).catch(() => null);
      if (message) {
        await message.edit(payload);
        return;
      }
    }

    const message = await textChannel.send(payload);
    playerMessages.set(queue.id, message.id);
  } catch (error) {
    console.error("Could not update player UI:", error);
  }
}

function getMemberVoiceChannel(interaction) {
  return interaction.member?.voice?.channel;
}

function validateVoiceChannel(interaction, voiceChannel) {
  if (!voiceChannel) {
    return "Join a voice channel first.";
  }

  const botMember = interaction.guild?.members.me;
  const permissions = botMember ? voiceChannel.permissionsFor(botMember) : null;

  if (!permissions?.has(PermissionFlagsBits.Connect)) {
    return "I do not have permission to join your voice channel. Please give me the Connect permission.";
  }

  if (!permissions.has(PermissionFlagsBits.Speak)) {
    return "I do not have permission to speak in your voice channel. Please give me the Speak permission.";
  }

  if (voiceChannel.full && !permissions.has(PermissionFlagsBits.MoveMembers)) {
    return "That voice channel is full, so I cannot join it right now.";
  }

  return null;
}

function requireQueue(interaction) {
  const queue = distube.getQueue(interaction.guildId);
  if (!queue) {
    return null;
  }
  return queue;
}

function trimChoiceText(text, maxLength = 100) {
  if (!text) return "Unknown song";
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function isLikelyUrl(value) {
  return /^https?:\/\//i.test(value);
}

function fallbackSongChoice(query) {
  return [{
    name: trimChoiceText(`Search for "${query}"`),
    value: query
  }];
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise(resolve => {
      setTimeout(() => resolve(null), timeoutMs);
    })
  ]);
}

async function searchSongChoices(query) {
  const cleanQuery = query.trim();
  if (!cleanQuery || cleanQuery.length < 2 || isLikelyUrl(cleanQuery)) return [];

  const cacheKey = cleanQuery.toLowerCase();
  const cached = autocompleteCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < 60_000) {
    return cached.choices;
  }

  const result = await withTimeout(ytSearch(cleanQuery), AUTOCOMPLETE_TIMEOUT_MS);
  if (!result?.videos?.length) {
    return fallbackSongChoice(cleanQuery);
  }

  const choices = result.videos
    .slice(0, 10)
    .map(video => ({
      name: trimChoiceText(`${video.title} - ${video.author?.name || "Unknown artist"}`),
      value: video.url
    }));

  for (const choice of choices) {
    autocompleteTitles.set(choice.value, choice.name);
  }

  autocompleteCache.set(cacheKey, { choices, createdAt: Date.now() });
  return choices;
}

async function handleAutocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  if (interaction.commandName !== "play" || focused.name !== "title") {
    await interaction.respond([]);
    return;
  }

  try {
    const choices = await searchSongChoices(focused.value);
    await interaction.respond(choices);
  } catch (error) {
    console.error("Could not load autocomplete choices:", error);
    await interaction.respond(fallbackSongChoice(focused.value));
  }
}

async function safelyRespondToInteractionError(interaction, message) {
  if (interaction.isAutocomplete()) {
    await interaction.respond([]).catch(() => null);
    return;
  }

  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ content: message, ephemeral: true }).catch(() => null);
    return;
  }

  if (typeof interaction.reply === "function") {
    await interaction.reply({ content: message, ephemeral: true }).catch(() => null);
  }
}

async function handleSlashCommand(interaction) {
  const { commandName } = interaction;

  if (commandName === "play") {
    const voiceChannel = getMemberVoiceChannel(interaction);
    const voiceError = validateVoiceChannel(interaction, voiceChannel);
    if (voiceError) {
      await interaction.reply({ content: voiceError, ephemeral: true });
      return;
    }

    const query = interaction.options.getString("title", true);
    const displayQuery = autocompleteTitles.get(query) || query;
    const queue = distube.getQueue(interaction.guildId);

    await interaction.reply(
      queue
        ? `Adding to queue: **${displayQuery}**`
        : `Searching and connecting: **${displayQuery}**`
    );

    try {
      await distube.play(voiceChannel, query, {
        member: interaction.member,
        textChannel: interaction.channel,
        metadata: { interaction }
      });
    } catch (error) {
      console.error(error);
      await interaction.editReply(getFriendlyErrorMessage(error));
      return;
    }

    await interaction.editReply(
      queue
        ? `Queued: **${displayQuery}**`
        : `Playing: **${displayQuery}**`
    );
    return;
  }

  const queue = requireQueue(interaction);
  if (!queue) {
    await interaction.reply({ content: "No music is playing right now.", ephemeral: true });
    return;
  }

  if (commandName === "queue") {
    await interaction.reply({ embeds: [buildPlayerEmbed(queue)], ephemeral: true });
    return;
  }

  if (commandName === "nowplaying") {
    await interaction.reply({ embeds: [buildPlayerEmbed(queue)], components: [buildPlayerRow(queue)] });
    return;
  }

  if (commandName === "pause") {
    if (!queue.paused) distube.pause(interaction.guildId);
    await interaction.reply("Paused.");
    await upsertPlayerMessage(queue, interaction.channel);
    return;
  }

  if (commandName === "resume") {
    if (queue.paused) distube.resume(interaction.guildId);
    await interaction.reply("Resumed.");
    await upsertPlayerMessage(queue, interaction.channel);
    return;
  }

  if (commandName === "skip") {
    await distube.skip(interaction.guildId);
    await interaction.reply("Skipped.");
    return;
  }

  if (commandName === "stop") {
    distube.stop(interaction.guildId);
    leaveVoice(interaction.guildId);
    playerMessages.delete(interaction.guildId);
    await interaction.reply("Stopped and left the voice channel.");
    return;
  }
}

function getFriendlyErrorMessage(error) {
  if (error?.errorCode === "VOICE_CONNECT_FAILED") {
    return [
      "I could not connect to the voice channel within 30 seconds.",
      "Please check that I have Connect and Speak permissions, then try moving to another voice channel.",
      "If this only happens on Render, redeploy the latest code and make sure the host allows Discord voice connections."
    ].join("\n");
  }

  if (error?.errorCode === "VOICE_MISSING_PERMS") {
    return "I am missing voice permissions. Please give me Connect and Speak permissions for that voice channel.";
  }

  if (error?.errorCode === "VOICE_FULL") {
    return "That voice channel is full, so I cannot join it right now.";
  }

  if (error?.errorCode === "NO_RESULT") {
    return "I could not find a playable result for that title. Try another song name or link.";
  }

  if (error?.errorCode === "NOT_SUPPORTED_URL") {
    return "That link is not supported. Try a Spotify link, YouTube link, or song title.";
  }

  return "Something went wrong while processing that command.";
}

async function handlePlayerButton(interaction) {
  const queue = requireQueue(interaction);
  if (!queue) {
    await interaction.reply({ content: "There is no active player right now.", ephemeral: true });
    return;
  }

  if (interaction.customId === "music:pause_resume") {
    if (queue.paused) {
      distube.resume(interaction.guildId);
    } else {
      distube.pause(interaction.guildId);
    }

    await interaction.update({
      embeds: [buildPlayerEmbed(queue)],
      components: [buildPlayerRow(queue)]
    });
    return;
  }

  if (interaction.customId === "music:skip") {
    await interaction.deferUpdate();
    await distube.skip(interaction.guildId);
    return;
  }

  if (interaction.customId === "music:stop") {
    distube.stop(interaction.guildId);
    leaveVoice(interaction.guildId);
    playerMessages.delete(interaction.guildId);
    await interaction.update({
      embeds: [buildPlayerEmbed(null)],
      components: []
    });
    return;
  }

  if (interaction.customId === "music:queue") {
    await interaction.reply({ embeds: [buildPlayerEmbed(queue)], ephemeral: true });
  }
}

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("error", error => {
  console.error("Discord client error:", error);
});

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction);
    } else if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
    } else if (interaction.isButton() && interaction.customId.startsWith("music:")) {
      await handlePlayerButton(interaction);
    }
  } catch (error) {
    console.error(error);
    const message = getFriendlyErrorMessage(error);
    await safelyRespondToInteractionError(interaction, message);
  }
});

client.on("voiceStateUpdate", (oldState, newState) => {
  const affectedChannel = oldState.channel || newState.channel;
  const guildId = affectedChannel?.guild?.id;
  if (!affectedChannel || !guildId) return;

  const botVoice = affectedChannel.guild.members.me?.voice?.channel;
  if (!botVoice || botVoice.id !== affectedChannel.id) return;

  const queue = distube.getQueue(guildId);
  scheduleLeaveIfAlone(botVoice, queue?.textChannel);
});

distube
  .on("playSong", async queue => {
    clearTimeout(emptyVoiceTimers.get(queue.id));
    emptyVoiceTimers.delete(queue.id);
    await upsertPlayerMessage(queue, queue.textChannel);
  })
  .on("addSong", async queue => {
    await upsertPlayerMessage(queue, queue.textChannel);
  })
  .on("addList", async queue => {
    await upsertPlayerMessage(queue, queue.textChannel);
  })
  .on("finish", async queue => {
    playerMessages.delete(queue.id);
    leaveVoice(queue.id);
    if (queue.textChannel) {
      await queue.textChannel.send("Queue finished. I left the voice channel.");
    }
  })
  .on("error", (error, queue) => {
    console.error(error);
    queue?.textChannel?.send("I could not play that request. Try another link or title.");
  });

const app = express();
app.get("/", (_request, response) => response.send("Discord music bot is running."));
app.get("/health", (_request, response) => response.json({ ok: true }));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Health server listening on port ${port}`);
});

registerCommands()
  .then(() => client.login(token))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
