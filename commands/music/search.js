// commands/music/search.js
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ComponentType } = require('discord.js');
const logger = require('../../utils/logger'); // Adjust path
const config = require('../../config'); // Adjust path
const { createGuildQueue, addToQueue, startPlayback, updateNowPlayingMessage, playNextTrack } = require('../../spotify/spotifyPlayer'); // Adjust path
// Import the function to get the bot's authenticated Spotify API client
const { getClientCredentialsSpotifyApi } = require('../../spotify/spotifyAuth'); // Adjust path
const play = require('play-dl'); // Import play-dl for YouTube search

// Helper function to format duration from ms to MM:SS
function formatDuration(ms) {
    if (!ms || typeof ms !== 'number' || ms < 0) return 'N/A';
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// REMOVED getYouTubeId function as it's not needed when using play.search result directly

module.exports = {
    data: new SlashCommandBuilder()
        .setName('search')
        .setDescription('Searches Spotify for tracks, finds a playable source, and lets you choose.') // Updated description
        .addStringOption(option =>
            option.setName('query')
                .setDescription('The search term for the Spotify track.') // Updated description
                .setRequired(true)),

    async execute(interaction, client, userProfile) {
        logger.info(`====== Executing /search command for query: "${interaction.options.getString('query')}" ======`);
        await interaction.deferReply();

        const query = interaction.options.getString('query');
        const voiceChannel = interaction.member.voice.channel;
        const guildId = interaction.guild.id;

        // --- Pre-checks ---
        if (!voiceChannel) { /* ... */ return interaction.editReply({ content: 'You need to be in a voice channel...', ephemeral: true }); }
        const permissions = voiceChannel.permissionsFor(client.user);
        if (!permissions || !permissions.has('Connect') || !permissions.has('Speak')) { /* ... */ return interaction.editReply({ content: 'I require permissions...', ephemeral: true }); }

        try {
            // --- Step 1: Search Spotify ---
            logger.debug(`[${guildId}] Attempting to get Spotify client credentials API...`);
            const spotifyApi = await getClientCredentialsSpotifyApi();
            if (!spotifyApi) { /* ... */ return interaction.editReply({ content: 'Could not connect to Spotify services...', ephemeral: true }); }
            logger.debug(`[${guildId}] Spotify client credentials API obtained successfully.`);

            logger.info(`[${guildId}] Searching Spotify API for tracks matching: "${query}"`);
            let searchData;
            try {
                searchData = await spotifyApi.searchTracks(query, { limit: config.music.searchResultLimit, market: 'US' });
                logger.debug(`[${guildId}] Spotify API search response received.`);
            } catch (spotifyError) {
                 logger.error(`[${guildId}] Error calling spotifyApi.searchTracks:`, spotifyError.body || spotifyError.message || spotifyError);
                 return interaction.editReply({ content: `An error occurred while searching Spotify: ${spotifyError.body?.error?.message || spotifyError.message || 'Unknown Spotify API error'}`, ephemeral: true });
            }

            const spotifyResults = searchData.body?.tracks?.items;
            logger.debug(`[${guildId}] Parsed ${spotifyResults?.length ?? 0} tracks from Spotify response.`);
            if (!spotifyResults || spotifyResults.length === 0) { /* ... */ return interaction.editReply({ content: `No Spotify tracks found...` }); }

            // --- Step 2: Display Spotify Results for Selection ---
            const embed = new EmbedBuilder()
                .setColor(config.colors.spotify)
                .setTitle(`Spotify Search Results for: "${query}"`)
                .setDescription('Select a track below. I will try to find a playable version.')
                .setTimestamp();

            const options = spotifyResults.map((track, index) => {
                 const trackTitle = track.name || 'Untitled Track';
                 const trackArtists = track.artists?.map(artist => artist.name).join(', ') || 'Unknown Artist';
                 const trackDuration = formatDuration(track.duration_ms);
                 const label = `${index + 1}. ${trackTitle}`.substring(0, 100);
                 const description = `${trackArtists} | ${trackDuration}`.substring(0, 100);
                 // Use Spotify Track ID as the value for reliable lookup
                 return { label, description, value: track.id };
            }).filter(option => option.value);

             if (options.length === 0) { /* ... */ return interaction.editReply({ content: 'Found Spotify tracks, but issue preparing selection.', ephemeral: true }); }

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`search_select_spotify_${interaction.id}`)
                .setPlaceholder('Select a Spotify track...')
                .addOptions(options);
            const row = new ActionRowBuilder().addComponents(selectMenu);
            const message = await interaction.editReply({ embeds: [embed], components: [row], fetchReply: true });

            // --- Step 3: Collect User Selection ---
            const filter = i => i.customId === `search_select_spotify_${interaction.id}` && i.user.id === interaction.user.id;
            // Ensure message is defined before creating collector
             if (!message) {
                 logger.error(`[${guildId}] Failed to fetch reply message for search collector.`);
                 return interaction.followUp({ content: "Error setting up selection prompt.", ephemeral: true }); // Follow up as initial reply failed implicitly
             }
            const collector = message.createMessageComponentCollector({ filter, componentType: ComponentType.StringSelect, time: 90000 });

            collector.on('collect', async i => {
                try {
                    await i.deferUpdate();
                    const selectedSpotifyId = i.values[0];
                    logger.debug(`[${guildId}] User selected Spotify ID: ${selectedSpotifyId}`);

                    // Find the full track info from original Spotify results
                    const selectedSpotifyTrack = spotifyResults.find(track => track.id === selectedSpotifyId);
                    if (!selectedSpotifyTrack) {
                         logger.error(`[${guildId}] Selected Spotify ID ${selectedSpotifyId} not found in results.`);
                         await interaction.editReply({ content: 'Error finding selected track details.', embeds: [], components: [] }).catch(()=>{});
                         return collector.stop();
                    }

                    // --- Step 4: Search YouTube for Playable Source ---
                    const trackTitle = selectedSpotifyTrack.name;
                    const trackArtist = selectedSpotifyTrack.artists?.[0]?.name; // Use first artist for search simplicity
                    const youtubeSearchQuery = `${trackTitle} ${trackArtist || ''}`.trim();

                    logger.info(`[${guildId}] Searching YouTube for: "${youtubeSearchQuery}" based on Spotify selection.`);
                    // Edit the original interaction reply
                    await interaction.editReply({ content: `Searching for a playable version of "${trackTitle}"...`, embeds: [], components: [] }).catch(e => logger.error("Failed to edit reply during YT search:", e));

                    let playDlResults;
                    try {
                         playDlResults = await play.search(youtubeSearchQuery, { limit: 1, source: { youtube: 'video' } });
                    } catch (ytError) {
                         logger.error(`[${guildId}] YouTube search failed for "${youtubeSearchQuery}":`, ytError);
                         await interaction.editReply({ content: `Found "${trackTitle}" on Spotify, but failed to find a playable source on YouTube.`, embeds: [], components: [] }).catch(()=>{});
                         return collector.stop();
                    }


                    if (!playDlResults || playDlResults.length === 0) {
                        logger.warn(`[${guildId}] No YouTube results found for "${youtubeSearchQuery}".`);
                        await interaction.editReply({ content: `Found "${trackTitle}" on Spotify, but couldn't find a matching playable source.`, embeds: [], components: [] }).catch(()=>{});
                        return collector.stop();
                    }

                    const playableTrackInfo = playDlResults[0];
                    logger.info(`[${guildId}] Found potential YouTube match: "${playableTrackInfo.title}" (${playableTrackInfo.url})`);

                    // --- Step 5: Add Playable Track to Queue ---
                    let queue = client.queues.get(guildId);
                    if (!queue) { /* ... create queue ... */ queue = createGuildQueue(interaction, voiceChannel); client.queues.set(guildId, queue); }
                    else { /* ... check VC ... */ if (interaction.guild.members.me?.voice?.channel && interaction.guild.members.me.voice.channel.id !== voiceChannel.id) { await interaction.editReply({ content: `I am in another channel...`, embeds: [], components: [] }).catch(()=>{}); return collector.stop(); } queue.voiceChannel = voiceChannel; queue.textChannel = interaction.channel; }

                    // **FIX:** Use the URL directly from the play.search result (playableTrackInfo)
                    const song = {
                        title: playableTrackInfo.title || selectedSpotifyTrack.name, // Prefer YT title
                        url: playableTrackInfo.url, // ** USE THIS URL **
                        duration: playableTrackInfo.durationRaw || formatDuration(selectedSpotifyTrack.duration_ms),
                        thumbnail: playableTrackInfo.thumbnails?.[0]?.url || selectedSpotifyTrack.album?.images?.[0]?.url,
                        requestedBy: i.user.tag,
                        source: 'YouTube (via Spotify Search)', // Indicate source
                        spotifyUrl: selectedSpotifyTrack.external_urls?.spotify // Store original Spotify URL for reference/duplicates
                    };

                    // Add check for valid URL before adding
                     if (!song.url || typeof song.url !== 'string' || !song.url.startsWith('http')) {
                         logger.error(`[${guildId}] Invalid playable URL found for "${song.title}": ${song.url}`);
                         await interaction.editReply({ content: `Found a playable source for "${song.title}", but its URL seems invalid. Cannot add.`, embeds: [], components: [] }).catch(()=>{});
                         return collector.stop();
                     }

                    logger.debug(`[${guildId}] Adding song to queue: ${song.title} (Playable URL: ${song.url})`);
                    await addToQueue(interaction, client.queues, song);

                    const addEmbed = new EmbedBuilder()
                        .setColor(config.colors.success)
                        .setTitle(`Track Added: ${song.title}`)
                        .setURL(song.url) // Link to playable URL
                        .setDescription(`Found playable version for "${selectedSpotifyTrack.name}".\nPosition in queue: **${queue.songs.length}**`)
                        .setThumbnail(song.thumbnail)
                        .addFields({ name: 'Duration', value: song.duration || 'N/A', inline: true })
                        .setFooter({ text: `Selected by ${i.user.tag} | Source: ${song.source}` });

                    await interaction.editReply({ embeds: [addEmbed], components: [], content: '' }).catch(e => logger.error("Failed final editReply:", e));

                    // Start playback if needed
                    const botVC = interaction.guild.members.me?.voice?.channel;
                    if (!queue.playing && !botVC) { await startPlayback(interaction, client.queues, queue); }
                    else if (!queue.playing && botVC) { playNextTrack(guildId, client.queues); }
                    else if (queue.playing) { await updateNowPlayingMessage(queue); }

                    collector.stop();

                } catch (collectError) { /* ... collector error handling ... */
                     logger.error(`Error processing search selection:`, collectError);
                     // Use interaction.editReply as the primary interaction is still available
                     await interaction.editReply({ content: 'Error adding track.', embeds: [], components: [] }).catch(()=>{});
                     collector.stop();
                }
            });

            collector.on('end', (collected, reason) => { /* ... collector end handling ... */
                 // Use optional chaining and check message existence
                 if (message) {
                     message.fetch().then(fetchedMessage => {
                         // Check if message still exists before editing
                         if (fetchedMessage && reason === 'time' && collected.size === 0) {
                             const timeoutEmbed = new EmbedBuilder().setColor(config.colors.warning).setTitle('Search Timed Out').setDescription('No track selected.');
                             fetchedMessage.edit({ embeds: [timeoutEmbed], components: [] }).catch(()=>{});
                         } else if (fetchedMessage && collected.size === 0 && reason !== 'time') {
                             // If stopped for other reasons without selection, remove components
                             fetchedMessage.edit({ components: [] }).catch(()=>{});
                         }
                     }).catch(()=>{ /* Ignore fetch errors if message deleted */ });
                 }
            });

        } catch (error) { /* ... initial search error handling ... */
             logger.error(`Error during Spotify /search:`, error.body || error);
             // Ensure reply is edited even on initial error
             await interaction.editReply({ content: `Error during Spotify search: ${error.body?.error?.message || error.message || 'Unknown'}`, embeds: [], components: [] });
        }
    },
};
