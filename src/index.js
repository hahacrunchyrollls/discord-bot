require("dotenv").config();

const express = require("express");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");
const { DisTube } = require("distube");
const { SpotifyPlugin } = require("@distube/spotify");
const { YtDlpPlugin } = require("@distube/yt-dlp");

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
    .setDescription("Open the music player and add a song to the queue."),
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
    textChannel?.send("Walang tao sa voice channel, kaya umalis na ako.").catch(() => null);
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
      .setDescription("Walang tugtog ngayon. Gumamit ng `/play` para magpatugtog.")
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
      { name: "Queue", value: nextSongs || "Wala pang kasunod.", inline: false }
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

function buildPlayModal() {
  const queryInput = new TextInputBuilder()
    .setCustomId("play_query")
    .setLabel("Song name, Spotify link, or YouTube link")
    .setPlaceholder("Halimbawa: BINI Pantropiko or Spotify playlist link")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(300);

  return new ModalBuilder()
    .setCustomId("music:play_modal")
    .setTitle("Play Music")
    .addComponents(new ActionRowBuilder().addComponents(queryInput));
}

function requireQueue(interaction) {
  const queue = distube.getQueue(interaction.guildId);
  if (!queue) {
    return null;
  }
  return queue;
}

async function handleSlashCommand(interaction) {
  const { commandName } = interaction;

  if (commandName === "play") {
    const voiceChannel = getMemberVoiceChannel(interaction);
    if (!voiceChannel) {
      await interaction.reply({ content: "Pumasok ka muna sa voice channel.", ephemeral: true });
      return;
    }

    await interaction.showModal(buildPlayModal());
    return;
  }

  const queue = requireQueue(interaction);
  if (!queue) {
    await interaction.reply({ content: "Walang music na tumutugtog ngayon.", ephemeral: true });
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
  }
}

async function handlePlayModal(interaction) {
  const voiceChannel = getMemberVoiceChannel(interaction);
  if (!voiceChannel) {
    await interaction.reply({ content: "Pumasok ka muna sa voice channel.", ephemeral: true });
    return;
  }

  await interaction.deferReply();
  const query = interaction.fields.getTextInputValue("play_query");
  const queue = distube.getQueue(interaction.guildId);

  await distube.play(voiceChannel, query, {
    member: interaction.member,
    textChannel: interaction.channel,
    metadata: { interaction }
  });

  await interaction.editReply(
    queue
      ? `Queued: **${query}**`
      : `Playing: **${query}**`
  );
}

async function handlePlayerButton(interaction) {
  const queue = requireQueue(interaction);
  if (!queue) {
    await interaction.reply({ content: "Walang active player ngayon.", ephemeral: true });
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

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
    } else if (interaction.isModalSubmit() && interaction.customId === "music:play_modal") {
      await handlePlayModal(interaction);
    } else if (interaction.isButton() && interaction.customId.startsWith("music:")) {
      await handlePlayerButton(interaction);
    }
  } catch (error) {
    console.error(error);
    const message = "May error habang pinoproseso yung command.";

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: message, ephemeral: true }).catch(() => null);
    } else {
      await interaction.reply({ content: message, ephemeral: true }).catch(() => null);
    }
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
      await queue.textChannel.send("Queue finished. Umalis na ako sa voice channel.");
    }
  })
  .on("error", (error, queue) => {
    console.error(error);
    queue?.textChannel?.send("Hindi ko ma-play yung request. Subukan ang ibang link o title.");
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
