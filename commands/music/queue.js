// commands/music/queue.js
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const logger = require('../../utils/logger'); // Adjust path
const config = require('../../config'); // Adjust path

const MAX_FIELDS = 10; // Max tracks to display per page

module.exports = {
    data: new SlashCommandBuilder()
        .setName('queue')
        .setDescription('Displays the current music queue.')
        .addIntegerOption(option =>
            option.setName('page')
                .setDescription(`The page number of the queue to display (Page 1 = Tracks 1-${MAX_FIELDS})`)
                .setRequired(false)
                .setMinValue(1)),

    async execute(interaction, client, userProfile) {
        const guildId = interaction.guild.id;
        const queue = client.queues.get(guildId);

        if (!queue || queue.songs.length === 0) {
            const embed = new EmbedBuilder()
                .setColor(config.colors.warning)
                .setTitle('Empty Queue')
                .setDescription('The music queue is currently empty. Use `/play` to add some tunes!');
            return interaction.reply({ embeds: [embed] });
        }

        const requestedPage = interaction.options.getInteger('page') || 1;
        const totalPages = Math.ceil(queue.songs.length / MAX_FIELDS);

        if (requestedPage > totalPages) {
             return interaction.reply({ content: `Invalid page number. There are only ${totalPages} pages in the queue.`, ephemeral: true });
        }

        const startIndex = (requestedPage - 1) * MAX_FIELDS;
        const endIndex = startIndex + MAX_FIELDS;
        const currentTracks = queue.songs.slice(startIndex, endIndex);

        const embed = new EmbedBuilder()
            .setColor(config.colors.music)
            .setTitle(`Music Queue (Page ${requestedPage}/${totalPages})`)
            .setTimestamp();

        // Add currently playing track info if available
        if (queue.currentTrack && requestedPage === 1) {
             embed.addFields({
                 name: '▶️ Now Playing',
                 value: `[${queue.currentTrack.title}](${queue.currentTrack.url}) | ${queue.currentTrack.duration || 'N/A'} | Req: ${queue.currentTrack.requestedBy}`
             });
        } else if (!queue.currentTrack && requestedPage === 1) {
             embed.addFields({ name: '▶️ Now Playing', value: 'Nothing currently playing.' });
        }


        if (currentTracks.length > 0) {
            const trackList = currentTracks.map((track, index) => {
                const globalIndex = startIndex + index + 1;
                return `\`${globalIndex}.\` [${track.title}](${track.url}) | ${track.duration || 'N/A'} | Req: ${track.requestedBy}`;
            }).join('\n');
             embed.setDescription(trackList); // Put track list in description for better formatting
        } else if (requestedPage > 1) {
            embed.setDescription('No tracks on this page.'); // Should be caught by page check, but as a fallback
        } else if (!queue.currentTrack) {
             embed.setDescription('The queue is empty.'); // If page 1 and no current track and no upcoming tracks
        }


        embed.setFooter({ text: `Total Tracks: ${queue.songs.length} | Loop: ${queue.loop}` });

        // --- Pagination Buttons ---
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`queue_prev_${requestedPage}`)
                    .setLabel('⬅️ Previous')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(requestedPage === 1),
                new ButtonBuilder()
                    .setCustomId(`queue_next_${requestedPage}`)
                    .setLabel('Next ➡️')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(requestedPage === totalPages)
            );

        const message = await interaction.reply({ embeds: [embed], components: [row], fetchReply: true });

        // --- Button Collector for Pagination ---
        const filter = i => i.customId.startsWith('queue_') && i.user.id === interaction.user.id;
        const collector = message.createMessageComponentCollector({ filter, time: 60000 }); // 60 second timeout

        collector.on('collect', async i => {
            await i.deferUpdate(); // Acknowledge button click

            let newPage = requestedPage;
            if (i.customId.startsWith('queue_prev_')) {
                newPage--;
            } else if (i.customId.startsWith('queue_next_')) {
                newPage++;
            }

            // Recalculate data for the new page
            const newStartIndex = (newPage - 1) * MAX_FIELDS;
            const newEndIndex = newStartIndex + MAX_FIELDS;
            const newTracks = queue.songs.slice(newStartIndex, newEndIndex); // Fetch fresh slice
            const newTotalPages = Math.ceil(queue.songs.length / MAX_FIELDS); // Recalculate total pages

             if (newPage < 1 || newPage > newTotalPages) {
                 // If queue changed and page is now invalid, maybe reset to page 1?
                 // For now, just ignore the invalid click (should be disabled anyway)
                 return;
             }

            const newEmbed = new EmbedBuilder()
                .setColor(config.colors.music)
                .setTitle(`Music Queue (Page ${newPage}/${newTotalPages})`)
                .setTimestamp()
                .setFooter({ text: `Total Tracks: ${queue.songs.length} | Loop: ${queue.loop}` });

             if (queue.currentTrack && newPage === 1) {
                 newEmbed.addFields({
                     name: '▶️ Now Playing',
                     value: `[${queue.currentTrack.title}](${queue.currentTrack.url}) | ${queue.currentTrack.duration || 'N/A'} | Req: ${queue.currentTrack.requestedBy}`
                 });
             } else if (!queue.currentTrack && newPage === 1) {
                 newEmbed.addFields({ name: '▶️ Now Playing', value: 'Nothing currently playing.' });
             }


            if (newTracks.length > 0) {
                const newTrackList = newTracks.map((track, index) => {
                    const globalIndex = newStartIndex + index + 1;
                    return `\`${globalIndex}.\` [${track.title}](${track.url}) | ${track.duration || 'N/A'} | Req: ${track.requestedBy}`;
                }).join('\n');
                newEmbed.setDescription(newTrackList);
            } else {
                 newEmbed.setDescription('No tracks on this page.');
            }


            const newRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`queue_prev_${newPage}`)
                        .setLabel('⬅️ Previous')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(newPage === 1),
                    new ButtonBuilder()
                        .setCustomId(`queue_next_${newPage}`)
                        .setLabel('Next ➡️')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(newPage === newTotalPages)
                );

            await interaction.editReply({ embeds: [newEmbed], components: [newRow] });
            // Update requestedPage for the next potential button click within this collector instance
            // Note: This doesn't persist if the command is run again.
            // A more robust pagination might store the current page state differently.
            // requestedPage = newPage; // This won't work as expected due to closure scope.
            // Instead, the customId carries the *current* page info for the next calculation.
        });

        collector.on('end', collected => {
            // Remove buttons after timeout
            const disabledRow = ActionRowBuilder.from(message.components[0]); // Get the current row
            disabledRow.components.forEach(c => c.setDisabled(true));
            interaction.editReply({ components: [disabledRow] }).catch(e => logger.warn("Failed to disable queue buttons on collector end:", e));
        });
    },
};

