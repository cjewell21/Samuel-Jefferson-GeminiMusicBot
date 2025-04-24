// commands/music/nowplaying.js
// Corrected: Ensure EmbedBuilder is only destructured once (removed duplicate)
const { SlashCommandBuilder } = require('discord.js'); // EmbedBuilder is NOT needed here
const logger = require('../../utils/logger'); // Adjust path
const config = require('../../config'); // Adjust path
// Import updateNowPlayingMessage which handles embed creation internally
const { updateNowPlayingMessage } = require('../../spotify/spotifyPlayer'); // Adjust path

module.exports = {
    data: new SlashCommandBuilder()
        .setName('nowplaying')
        .setDescription('Shows the currently playing song and controls.'),

    async execute(interaction, client, userProfile) {
        const guildId = interaction.guild.id;
        const queue = client.queues.get(guildId);

        if (!queue) {
            // Use interaction.reply for initial responses if not deferred
            return interaction.reply({ content: 'There is no music being played at this moment.', ephemeral: true });
        }

        // Defer reply ephemerally while we potentially delete/resend the main message
        await interaction.deferReply({ ephemeral: true });

        // Delete the old message if it exists, to force sending a new one
        if (queue.message) {
            try {
                // Fetch the message first to ensure it exists before deleting
                const oldMessage = await interaction.channel.messages.fetch(queue.message.id).catch(() => null);
                if (oldMessage) {
                    await oldMessage.delete();
                    logger.debug(`Deleted old Now Playing message in guild ${guildId} on /nowplaying command.`);
                }
                queue.message = null; // Clear reference after successful deletion or if fetch failed
            } catch (e) {
                 // Log if deletion fails but continue, updateNowPlayingMessage will send a new one anyway
                 logger.warn(`Failed to delete old NP message on /nowplaying in guild ${guildId}: ${e.message}`);
                 queue.message = null; // Clear reference even if deletion failed
            }
        }

        try {
            // Call the update function - it handles creating/sending the message with its own EmbedBuilder
            // Ensure the queue object has a valid textChannel reference before calling
            if (!queue.textChannel) {
                 queue.textChannel = interaction.channel; // Assign current channel if missing
                 logger.warn(`Queue for guild ${guildId} was missing textChannel reference. Assigned current channel.`);
            }
            await updateNowPlayingMessage(queue);

            // Edit the deferred ephemeral reply to confirm the action
            await interaction.editReply({ content: 'Displayed the current track information.' });

        } catch (error) {
             logger.error(`Error updating Now Playing message via /nowplaying command for guild ${guildId}:`, error);
             // Edit the deferred reply with an error message
             await interaction.editReply({ content: 'An error occurred while trying to display the Now Playing information.' }).catch(e => logger.error("Failed to edit reply on nowplaying error:", e));
        }
    },
};
