// commands/music/skip.js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const logger = require('../../utils/logger'); // Adjust path
const config = require('../../config'); // Adjust path

module.exports = {
    data: new SlashCommandBuilder()
        .setName('skip')
        .setDescription('Skips the current song.'),
    // Add options later? e.g., skip to specific track number?

    async execute(interaction, client, userProfile) {
        const guildId = interaction.guild.id;
        const queue = client.queues.get(guildId);

        // --- Pre-checks ---
        if (!queue) {
            return interaction.reply({ content: 'There is no music playing currently.', ephemeral: true });
        }
        if (!interaction.member.voice.channel || interaction.member.voice.channel.id !== queue.voiceChannel.id) {
            return interaction.reply({ content: 'You must be in the same voice channel as me to skip songs.', ephemeral: true });
        }
        if (!queue.currentTrack) {
             return interaction.reply({ content: 'There is no track currently playing to skip.', ephemeral: true });
        }
        // Optional: Add voting system or DJ role check here

        const skippedTrack = queue.currentTrack;

        try {
            // Stop the player. The 'idle' event listener in spotifyPlayer.js will handle playing the next track.
            const success = queue.player.stop(true); // Force stop

            if (success) {
                logger.info(`Track "${skippedTrack.title}" skipped in guild ${guildId} by ${interaction.user.tag}. Loop: ${queue.loop}`);
                const embed = new EmbedBuilder()
                    .setColor(config.colors.music)
                    .setTitle('Track Skipped')
                    .setDescription(`Skipped **[${skippedTrack.title}](${skippedTrack.url})**`)
                    .setFooter({ text: `Skipped by ${interaction.user.tag}` })
                    .setTimestamp();

                // If looping queue, mention the track was added back
                if (queue.loop === 'queue') {
                     embed.description += '\n(Track added back to the end of the queue due to loop mode).';
                }

                await interaction.reply({ embeds: [embed] });
                // The Now Playing message will update automatically when the next track starts via the player events

            } else {
                logger.warn(`player.stop() returned false for guild ${guildId} during skip.`);
                await interaction.reply({ content: 'Could not skip the track. The player might be in an unusual state.', ephemeral: true });
            }
        } catch (error) {
            logger.error(`Error skipping track in guild ${guildId}:`, error);
            await interaction.reply({ content: 'An error occurred while trying to skip the track.', ephemeral: true });
        }
    },
};
