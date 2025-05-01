const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const logger = require('../../utils/logger');
const config = require('../../config');
// You'll likely need a lyrics fetching library or API here.
// Example: const lyricsFinder = require('lyrics-finder');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('lyrics')
        .setDescription('Finds and displays lyrics for the current or a specified track.')
        .addStringOption(option =>
            option.setName('query')
                .setDescription('The song title or artist to search for lyrics (optional).')),

    async execute(interaction, client) {
        const guildId = interaction.guild.id;
        const query = interaction.options.getString('query');
        const player = client.lavalink.getPlayer(guildId); // Get the player

        // Defer reply
        try {
            await interaction.deferReply();
        } catch (deferError) {
            logger.error(`[${guildId}] Failed to defer reply for /lyrics:`, deferError);
            return;
        }

        let trackTitle = query;

        // If no query is provided, try to get lyrics for the current track
        if (!trackTitle) {
            if (!player || !player.queue.current) {
                logger.debug(`[${guildId}] /lyrics command used without query and nothing is playing.`);
                return interaction.editReply({ content: 'There is nothing currently playing, and no song title was provided.' }).catch(() => {});
            }
            trackTitle = player.queue.current.info.title; // Use track.info.title
            logger.debug(`[${guildId}] Searching for lyrics for current track: "${trackTitle}"`);
        } else {
             logger.debug(`[${guildId}] Searching for lyrics for query: "${trackTitle}"`);
        }

        if (!trackTitle) {
             return interaction.editReply({ content: 'Could not determine the track title to search for lyrics.' }).catch(() => {});
        }

        try {
            // --- Lyrics Fetching Logic ---
            // This is where you would integrate a lyrics fetching library or API.
            // Replace this placeholder with actual lyrics fetching code.
            // Example using a hypothetical lyricsFinder library:
            // const lyrics = await lyricsFinder(trackTitle, ''); // Search by title only for simplicity

            const lyrics = `(Lyrics fetching not implemented yet. Implement a lyrics fetching library here for "${trackTitle}")`; // Placeholder lyrics

            if (!lyrics || lyrics === '(Lyrics fetching not implemented yet. Implement a lyrics fetching library here for "undefined")') { // Check for placeholder or no lyrics found
                 return interaction.editReply({ content: `❌ Could not find lyrics for "${trackTitle}".` }).catch(() => {});
            }

            // --- Embed Color Fix ---
            const infoColor = config?.colors?.info ?? 0x0099FF;
            logger.debug(`[${guildId}] Using color for lyrics embed: ${infoColor}`);

            const lyricsEmbed = new EmbedBuilder()
                .setColor(infoColor)
                .setTitle(`📜 Lyrics for: "${trackTitle}"`)
                .setDescription(lyrics.substring(0, 4096)) // Embed description limit
                .setTimestamp();

            await interaction.editReply({ embeds: [lyricsEmbed] }).catch(() => {});

        } catch (error) {
            logger.error(`[${guildId}] Error fetching lyrics for "${trackTitle}":`, error);
            await interaction.editReply({ content: 'An error occurred while trying to fetch lyrics.' }).catch(() => {});
        }
    }
};
