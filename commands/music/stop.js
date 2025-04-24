// commands/music/stop.js
// Corrected: Ensure EmbedBuilder is destructured only once
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const logger = require('../../utils/logger'); // Adjust path
const config = require('../../config'); // Adjust path
// Import updateNowPlayingMessage to handle message updates after stopping
const { updateNowPlayingMessage } = require('../../spotify/spotifyPlayer'); // Adjust path

module.exports = {
    data: new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Stops the music, clears the queue, and leaves the voice channel.'),

    async execute(interaction, client, userProfile) {
        const guildId = interaction.guild.id;
        const queue = client.queues.get(guildId);

        // --- Pre-checks ---
        if (!queue) {
            return interaction.reply({ content: 'Nothing to stop, as I am not currently engaged in musical performance.', ephemeral: true });
        }
        if (!interaction.member.voice.channel || interaction.member.voice.channel.id !== queue.voiceChannel?.id) { // Added optional chaining for voiceChannel
            return interaction.reply({ content: 'You must be in the same voice channel as me to command a cessation of music.', ephemeral: true });
        }
        // Optional: Add DJ role check here

        // Defer reply while processing
        await interaction.deferReply();

        try {
            logger.info(`Stopping playback and clearing queue in guild ${guildId} by ${interaction.user.tag} via command.`);

            // Clear songs, loop, current track
            const stoppedTrack = queue.currentTrack; // Get track that was playing, if any
            queue.songs = [];
            queue.loop = 'off';
            queue.currentTrack = null;
            queue.playing = false;

            // Get the connection before potentially destroying it
            const connection = queue.connection;

            // Destroy connection (triggers cleanup in event listener)
            if (connection && connection.state.status !== 'destroyed') {
                 connection.destroy();
                 // The 'Destroyed' listener in spotifyPlayer.js should handle deleting the queue from client.queues map.
            } else {
                // If no connection or already destroyed, ensure queue is deleted from map manually
                client.queues.delete(guildId);
                 logger.info(`Manually deleted queue for guild ${guildId} as connection was absent or already destroyed.`);
                 // Manually update message if no connection event will fire
                 // Pass a copy of the queue object as it might be modified during async operations
                 const queueSnapshot = { ...queue, textChannel: interaction.channel }; // Ensure textChannel is valid
                 await updateNowPlayingMessage(queueSnapshot, true).catch(e => logger.error("Error updating NP message on manual stop:", e));
            }


            // Use EmbedBuilder imported at the top
            const embed = new EmbedBuilder()
                .setColor(config.colors.error)
                .setTitle('Playback Stopped')
                .setDescription('The music has been silenced, the queue cleared, and I shall take my leave from the channel.')
                .setTimestamp();
            if (stoppedTrack) {
                 embed.addFields({ name: 'Last Track Played', value: `[${stoppedTrack.title}](${stoppedTrack.url})` });
            }

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            logger.error(`Error stopping music in guild ${guildId}:`, error);
            // Ensure reply is edited even on error
            await interaction.editReply({ content: 'An error occurred while trying to stop the music.', embeds: [] }).catch(e => logger.error("Failed to edit reply on stop error:", e));
        }
    },
};
