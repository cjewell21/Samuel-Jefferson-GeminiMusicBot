// commands/music/volume.js
// Corrected: Ensure EmbedBuilder is destructured only once
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const logger = require('../../utils/logger'); // Adjust path
const config = require('../../config'); // Adjust path
// Import updateNowPlayingMessage as it updates the volume display
const { updateNowPlayingMessage } = require('../../spotify/spotifyPlayer'); // Adjust path

module.exports = {
    data: new SlashCommandBuilder()
        .setName('volume')
        .setDescription('Sets the music playback volume (1-100).')
        .addIntegerOption(option =>
            option.setName('level')
                .setDescription('The desired volume level (1-100)')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(100)), // Standard range, adjust if needed

    async execute(interaction, client, userProfile) {
        const guildId = interaction.guild.id;
        const queue = client.queues.get(guildId);
        const volumeLevel = interaction.options.getInteger('level');

        // --- Pre-checks ---
        if (!queue) {
            return interaction.reply({ content: 'Cannot set volume, as no music is currently playing or queued.', ephemeral: true });
        }
        if (!interaction.member.voice.channel || interaction.member.voice.channel.id !== queue.voiceChannel?.id) { // Optional chaining
            return interaction.reply({ content: 'You must be in the same voice channel as me to adjust the volume.', ephemeral: true });
        }
        // Optional: Add DJ role check?

        // Defer reply while processing
        await interaction.deferReply();

        try {
            let replyMessage = `Playback volume set to **${volumeLevel}%**.`;

             // Check if the player and its current resource support inline volume
             if (queue.player && queue.player.state.status !== 'idle' && queue.player.state.resource?.volume) {
                // Set volume on the currently playing resource
                queue.player.state.resource.volume.setVolumeLogarithmic(volumeLevel / 100);
                logger.info(`Inline volume set to ${volumeLevel}% for current track in guild ${guildId} by ${interaction.user.tag}.`);
             } else {
                 // If no active resource or inline volume not supported, just set for future tracks
                 logger.info(`Setting queue default volume to ${volumeLevel}% for future tracks in guild ${guildId} by ${interaction.user.tag} (no active resource volume).`);
                 // Add a note to the user reply if inline volume wasn't set
                 if (queue.player && queue.player.state.status !== 'idle') {
                    replyMessage += '\n(Note: The volume of the *currently playing* track could not be adjusted directly, but subsequent tracks will use this volume.)';
                 }
             }

            // Always update the queue's default volume for subsequent tracks
            queue.volume = volumeLevel;

            // Update the Now Playing message immediately to reflect the new default volume
            // Use a snapshot in case queue object changes during async operations
             const queueSnapshot = { ...queue, textChannel: interaction.channel };
             await updateNowPlayingMessage(queueSnapshot).catch(e => logger.error("Error updating NP message on volume change:", e));

            // Use EmbedBuilder imported at the top
            const embed = new EmbedBuilder()
                .setColor(config.colors.music)
                .setTitle('Volume Adjusted')
                .setDescription(replyMessage) // Use the potentially modified reply message
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            logger.error(`Error setting volume in guild ${guildId}:`, error);
            await interaction.editReply({ content: 'An error occurred while trying to set the volume.', embeds: [] }).catch(e => logger.error("Failed to edit reply on volume error:", e));
        }
    },
};
