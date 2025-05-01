const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ComponentType } = require('discord.js');
const logger = require('../../utils/logger');
const config = require('../../config');
// Ensure this path is correct based on your project structure
const { getLavalinkPlayer, createGuildQueue, addToQueue, playNextTrack, updateNowPlayingMessage, handleQueueEnd } = require('../../spotify/spotifyPlayer');

// Debounce utility
const debounce = (func, wait) => {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    };
};

// Format duration utility (keep local or move to utils)
function formatDuration(ms) {
    if (ms === Infinity) return 'Live';
    if (!ms || typeof ms !== 'number' || ms < 0) return 'N/A';
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    let parts = [];
    if (hours > 0) parts.push(hours.toString());
    parts.push(minutes.toString().padStart(hours > 0 ? 2 : 1, '0'));
    parts.push(seconds.toString().padStart(2, '0'));
    return parts.join(':');
}

/**
 * Extracts tracks from a Lavalink V4 resolve response.
 * Handles different loadTypes and potential nesting under 'data'.
 * @param {object} lavalinkResponse - The response object from node.rest.resolve().
 * @param {string} guildId - For logging context.
 * @returns {Array<object>} An array of track objects, or an empty array if none found.
 */
function extractTracksFromLavalinkResponse(lavalinkResponse, guildId) { // Added guildId for logging
    // --- Start Added Logging ---
    logger.debug(`[${guildId}] extractTracks: Input Response: ${JSON.stringify(lavalinkResponse).substring(0, 500)}...`);
    // --- End Added Logging ---

    if (!lavalinkResponse) return [];

    const loadType = lavalinkResponse.loadType?.toUpperCase(); // Ensure uppercase for consistent checks
    let tracks = []; // Initialize as empty array

    // --- Updated Condition ---
    // Check common locations for tracks array based on loadType
    // Handle both TRACK_LOADED and TRACK as single track results
    if (['TRACK_LOADED', 'TRACK'].includes(loadType)) {
        logger.debug(`[${guildId}] extractTracks: Handling single track loadType: ${loadType}`);
        // Lavalink V4 often puts single tracks directly in 'data'
        // Ensure 'data' exists and is the track object (not an array)
        if (lavalinkResponse.data && typeof lavalinkResponse.data === 'object' && !Array.isArray(lavalinkResponse.data) && (lavalinkResponse.data.encoded || lavalinkResponse.data.track)) {
             logger.debug(`[${guildId}] extractTracks: Found track in response.data`);
             tracks = [lavalinkResponse.data];
        } else if (Array.isArray(lavalinkResponse.data) && lavalinkResponse.data.length > 0) {
             // Fallback if data is an array containing the track
             logger.debug(`[${guildId}] extractTracks: Found track in response.data[0]`);
             tracks = [lavalinkResponse.data[0]];
        } else if (Array.isArray(lavalinkResponse.tracks) && lavalinkResponse.tracks.length > 0) {
             // Older structure or fallback
             logger.debug(`[${guildId}] extractTracks: Found track in response.tracks[0]`);
             tracks = [lavalinkResponse.tracks[0]];
        } else {
             logger.warn(`[${guildId}] extractTracks: ${loadType} but track data not found in expected locations (data or tracks).`);
             // Attempt to use the top-level response if it looks like a track object
             if (typeof lavalinkResponse === 'object' && (lavalinkResponse.encoded || lavalinkResponse.track)) {
                  logger.debug(`[${guildId}] extractTracks: Using top-level response object as track.`);
                  tracks = [lavalinkResponse];
             }
        }
    // --- End Updated Condition ---
    } else if (['PLAYLIST_LOADED', 'SEARCH_RESULT', 'SEARCH'].includes(loadType)) { // Handle playlist/search types
         // Playlists and search results are typically under 'data' which is an object containing 'tracks' array
         if (lavalinkResponse.data && Array.isArray(lavalinkResponse.data.tracks)) {
             logger.debug(`[${guildId}] extractTracks: Found tracks in response.data.tracks`);
             tracks = lavalinkResponse.data.tracks;
         } else if (Array.isArray(lavalinkResponse.tracks)) {
             // Fallback to top-level 'tracks'
             logger.debug(`[${guildId}] extractTracks: Found tracks in response.tracks`);
             tracks = lavalinkResponse.tracks;
         } else if (Array.isArray(lavalinkResponse.data)) {
             // Sometimes search results might be directly in data array (less common)
             logger.debug(`[${guildId}] extractTracks: Found tracks directly in response.data (array)`);
             tracks = lavalinkResponse.data;
         } else {
              logger.warn(`[${guildId}] extractTracks: ${loadType} but tracks array not found in expected locations (data.tracks or tracks).`);
         }
    } else if (loadType === 'NO_MATCHES' || loadType === 'LOAD_FAILED') {
        logger.debug(`[${guildId}] extractTracks: LoadType is ${loadType}. Returning empty array.`);
        tracks = [];
    } else {
         logger.warn(`[${guildId}] extractTracks: Unknown or unhandled loadType '${loadType}'. Attempting fallback checks.`);
         // Unknown loadType, try checking common locations as a last resort
         tracks = lavalinkResponse.data?.tracks || lavalinkResponse.tracks || lavalinkResponse.data || [];
         if (!Array.isArray(tracks)) tracks = []; // Ensure it's an array
    }

    // --- Start Added Logging ---
    logger.debug(`[${guildId}] extractTracks: Tracks array BEFORE filtering (length ${Array.isArray(tracks) ? tracks.length : 'N/A'}): ${JSON.stringify(tracks).substring(0, 500)}...`);
    // --- End Added Logging ---

    // Ensure result is always an array and filter out any potential null/undefined entries
    // Also ensure each track has necessary info (like title and identifier)
    const filteredTracks = Array.isArray(tracks) ? tracks.filter(t => {
        const hasTrack = t && typeof t === 'object';
        const info = hasTrack ? (t.info || t) : null; // Get info object or use track itself
        const hasTitle = info && typeof info.title === 'string' && info.title.trim() !== '';
        const hasIdentifier = hasTrack && (typeof t.encoded === 'string' || typeof t.track === 'string'); // Check for encoded (v4) or track (v3)
        // --- Start Added Logging ---
        if (hasTrack && (!hasTitle || !hasIdentifier)) {
            logger.warn(`[${guildId}] extractTracks: Filtering out track due to missing title or identifier: ${JSON.stringify(t).substring(0, 200)}... (HasTitle: ${hasTitle}, HasIdentifier: ${hasIdentifier})`);
        }
        // --- End Added Logging ---
        return hasTitle && hasIdentifier;
    }) : [];

    // --- Start Added Logging ---
    logger.debug(`[${guildId}] extractTracks: Tracks array AFTER filtering (length ${filteredTracks.length}).`);
    // --- End Added Logging ---
    return filteredTracks;
}


module.exports = {
    data: new SlashCommandBuilder()
        .setName('search')
        .setDescription('Searches for tracks (Spotify/YouTube) via Lavalink and lets you choose.')
        .addStringOption(option =>
            option.setName('query')
                .setDescription('The search term or URL (Spotify or YouTube).')
                .setRequired(true)
                .setAutocomplete(true)), // Enable autocomplete

    async autocomplete(interaction, client) {
        const focusedValue = interaction.options.getFocused();
        const guildId = interaction.guildId;

        // Basic validation and logging
        if (!focusedValue || focusedValue.trim().length < 2) { // Require at least 2 chars to search
            try { await interaction.respond([]); } catch (e) { /* Ignore errors for empty response */ }
            return;
        }
        logger.debug(`[${guildId}] Autocomplete request for query: "${focusedValue}"`);

        // Check Shoukaku readiness
        if (!client.shoukaku || !client.shoukaku.nodes.size) {
            logger.warn(`[${guildId}] Shoukaku not ready or no nodes for autocomplete.`);
            try { await interaction.respond([]); } catch (e) { /* Ignore */ }
            return;
        }

        try {
            // Get a Lavalink node
            let node = client.shoukaku.options.nodeResolver(client.shoukaku.nodes);
             if (!node) node = Array.from(client.shoukaku.nodes.values()).find(n => n.state === 1) || Array.from(client.shoukaku.nodes.values())[0]; // Fallback logic
            if (!node) {
                logger.error(`[${guildId}] No Lavalink node available for autocomplete.`);
                try { await interaction.respond([]); } catch (e) { /* Ignore */ }
                return;
            }

            // Debounce the actual search logic
            const debouncedSearch = debounce(async (query) => {
                let choices = [];
                const searchTimeout = 3000; // 3 seconds timeout per source

                // Determine search prefix (try Spotify first unless it's clearly a non-Spotify URL)
                let isSpotify = query.includes('spotify.com') || (!query.startsWith('http') && !query.includes('youtube.com') && !query.includes('youtu.be'));
                let searchQuery = isSpotify ? `spsearch:${query}` : `ytsearch:${query}`;

                logger.debug(`[${guildId}] Attempting ${isSpotify ? 'Spotify' : 'YouTube'} autocomplete search: "${searchQuery}"`);

                try {
                    const searchResult = await Promise.race([
                        node.rest.resolve(searchQuery),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Search timeout')), searchTimeout))
                    ]);

                    logger.debug(`[${guildId}] Lavalink Autocomplete Response (${searchQuery}): Type=${searchResult?.loadType}, Data=${JSON.stringify(searchResult?.data).substring(0, 200)}...`);

                    // Pass guildId to extractor for logging context
                    let tracks = extractTracksFromLavalinkResponse(searchResult, guildId);

                    if (tracks.length > 0) {
                        choices = tracks
                            .slice(0, 10) // Limit choices for performance
                            .map(track => {
                                // Track structure might be nested under 'info' or directly properties
                                const trackInfo = track.info || track;
                                const title = trackInfo.title || 'Untitled Track';
                                const author = trackInfo.author || 'Unknown Artist';
                                // Ensure name and value are within Discord limits (100 chars)
                                const name = `[${formatDuration(trackInfo.length || 0)}] ${title} - ${author}`.substring(0, 100);
                                // Use URI if available, otherwise fallback to title (less reliable for selection)
                                const value = trackInfo.uri || title.substring(0, 100);
                                return { name, value };
                            })
                            // Filter out choices without a value or duplicates based on value
                            .filter((choice, index, self) => choice.value && index === self.findIndex((c) => c.value === choice.value))
                            .slice(0, 25); // Discord limit is 25 choices
                    } else {
                         logger.warn(`[${guildId}] No tracks found via ${isSpotify ? 'Spotify' : 'YouTube'} autocomplete for "${query}". LoadType: ${searchResult?.loadType}`);
                         // If Spotify search failed, try YouTube as fallback
                         if (isSpotify && !query.startsWith('http')) { // Only fallback if it was a text search, not a failed URL
                             logger.debug(`[${guildId}] Falling back to YouTube autocomplete search.`);
                             searchQuery = `ytsearch:${query}`;
                             const ytResult = await Promise.race([
                                 node.rest.resolve(searchQuery),
                                 new Promise((_, reject) => setTimeout(() => reject(new Error('Search timeout')), searchTimeout))
                             ]);
                             logger.debug(`[${guildId}] Lavalink Autocomplete Response (${searchQuery}): Type=${ytResult?.loadType}, Data=${JSON.stringify(ytResult?.data).substring(0, 200)}...`);
                             // Pass guildId
                             tracks = extractTracksFromLavalinkResponse(ytResult, guildId);
                             if (tracks.length > 0) {
                                 choices = tracks.slice(0, 10).map(track => {
                                     const trackInfo = track.info || track;
                                     const title = trackInfo.title || 'Untitled Track';
                                     const author = trackInfo.author || 'Unknown Artist';
                                     const name = `[${formatDuration(trackInfo.length || 0)}] ${title} - ${author}`.substring(0, 100);
                                     const value = trackInfo.uri || title.substring(0, 100);
                                     return { name, value };
                                 }).filter((choice, index, self) => choice.value && index === self.findIndex((c) => c.value === choice.value)).slice(0, 25);
                             } else {
                                 logger.warn(`[${guildId}] No tracks found via YouTube fallback autocomplete for "${query}". LoadType: ${ytResult?.loadType}`);
                             }
                         }
                    }

                } catch (error) {
                    logger.error(`[${guildId}] Error during autocomplete Lavalink resolve for "${searchQuery}": ${error.message}`);
                }

                // Respond with choices (or empty array)
                try {
                    if (!interaction.responded) {
                         await interaction.respond(choices);
                         logger.debug(`[${guildId}] Responded to autocomplete with ${choices.length} choices.`);
                    } else {
                         logger.warn(`[${guildId}] Autocomplete interaction already responded to. Skipping response.`);
                    }
                } catch (respondError) {
                    if (respondError.code !== 10062) { // Ignore "Unknown Interaction"
                        logger.warn(`[${guildId}] Error responding to autocomplete: ${respondError.message}`);
                    }
                }
            }, 350); // 350ms debounce delay

            debouncedSearch(focusedValue);

        } catch (error) {
            logger.error(`[${guildId}] General autocomplete error for query "${focusedValue}":`, error);
            try { if (!interaction.responded) await interaction.respond([]); } catch (e) { /* Ignore */ }
        }
    },

    async execute(interaction, client) {
        const query = interaction.options.getString('query');
        const guildId = interaction.guild.id;
        const member = interaction.member;
        const voiceChannel = member?.voice?.channel;

        logger.info(`====== Executing /search command in Guild ${guildId} for query: "${query}" ======`);

        try {
            await interaction.deferReply();
        } catch (deferError) {
            logger.error(`[${guildId}] Failed to defer reply for /search:`, deferError);
            return;
        }

        // --- Order Change: Get/Create Queue FIRST ---
        let queue = client.queues?.get(guildId);
        if (!queue) {
            queue = createGuildQueue(interaction, voiceChannel);
            logger.info(`[${guildId}] Created new queue.`);
        } else {
            // Update channels if user is in a different VC or used command in different text channel
            queue.voiceChannelId = voiceChannel.id;
            queue.textChannel = interaction.channel;
            logger.info(`[${guildId}] Using existing queue. Updated channels.`);
        }
        // --- End Order Change ---

        // Get Lavalink Player (includes joining VC logic if needed)
        // Pass the queue's text channel for error reporting inside getLavalinkPlayer
        const player = await getLavalinkPlayer(client, guildId, voiceChannel.id, queue.textChannel);
        if (!player) {
            // getLavalinkPlayer should have sent an error message if it failed
            return interaction.editReply({ content: 'Failed to initialize the music player. Please try again later.', ephemeral: true }).catch(() => {});
        }
        // Ensure the queue has the latest player instance associated
        queue.lavalinkPlayer = player;


        try {
            // Get Lavalink node
            let node = client.shoukaku.options.nodeResolver(client.shoukaku.nodes);
             if (!node) node = Array.from(client.shoukaku.nodes.values()).find(n => n.state === 1) || Array.from(client.shoukaku.nodes.values())[0];
            if (!node || typeof node.rest?.resolve !== 'function') {
                return interaction.editReply({ content: 'Music service node or search function is unavailable.', ephemeral: true }).catch(() => {});
            }

            // Resolve tracks using Lavalink REST API
            let searchResult;
            // Determine search type: URL, Spotify search, or YouTube search
            const isUrl = query.startsWith('http');
            const isSpotify = isUrl && query.includes('spotify.com');
            const isYoutube = isUrl && (query.includes('youtube.com') || query.includes('youtu.be'));

            let searchQuery;
            let isInitialSearchYoutube = false; // Flag to track if the first attempt is ytsearch

            if (isUrl) {
                searchQuery = query; // Use URL directly
                isInitialSearchYoutube = isYoutube;
            } else {
                // Default to Spotify search for non-URL queries (lavasrc handles this)
                searchQuery = `spsearch:${query}`;
            }

            logger.debug(`[${guildId}] Sending initial search to Lavalink: "${searchQuery}"`);
            try {
                searchResult = await node.rest.resolve(searchQuery);
                logger.debug(`[${guildId}] Lavalink Initial Search Response (${searchQuery}): Type=${searchResult?.loadType}`);
            } catch (resolveError) {
                logger.error(`[${guildId}] Lavalink resolve failed for "${searchQuery}":`, resolveError);
                 // Treat resolve error as LOAD_FAILED for fallback logic
                 searchResult = { loadType: 'LOAD_FAILED', exception: { message: resolveError.message, severity: 'COMMON' } };
                // return interaction.editReply({ content: `Error searching: ${resolveError.message}`, ephemeral: true }).catch(() => {});
            }

            // Extract tracks using the helper function, passing guildId for logging
            let tracks = extractTracksFromLavalinkResponse(searchResult, guildId);
            let loadType = searchResult?.loadType?.toUpperCase();

            // --- Start Added Logging ---
            logger.debug(`[${guildId}] Tracks extracted from initial search (length ${tracks.length}): ${JSON.stringify(tracks).substring(0, 500)}...`);
            // --- End Added Logging ---


            // --- Corrected Fallback Logic ---
            // Add logging right before the check
            logger.debug(`[${guildId}] Checking fallback condition: loadType='${loadType}', isInitialSearchYoutube=${isInitialSearchYoutube}, searchQuery='${searchQuery}', query='${query}'`);
            // Fallback to ytsearch ONLY IF the initial search FAILED or found NO MATCHES,
            // AND the initial search wasn't already a ytsearch or a YouTube URL.
            if (
                (loadType === 'LOAD_FAILED' || loadType === 'NO_MATCHES') &&
                !isInitialSearchYoutube && // Don't fallback if initial was already YT
                searchQuery !== `ytsearch:${query}` // Don't fallback if initial was spsearch that failed (let ytsearch be the explicit fallback)
            ) {
                const ytSearchQuery = `ytsearch:${query}`; // Always use ytsearch for fallback text query
                logger.debug(`[${guildId}] Initial search failed or no matches. Falling back to YouTube search: "${ytSearchQuery}"`);
                try {
                    const ytResult = await node.rest.resolve(ytSearchQuery);
                    logger.debug(`[${guildId}] Lavalink YouTube Fallback Response: Type=${ytResult?.loadType}`);
                    // Pass guildId
                    const ytTracks = extractTracksFromLavalinkResponse(ytResult, guildId);
                     // --- Start Added Logging ---
                     logger.debug(`[${guildId}] Tracks extracted from YT fallback (length ${ytTracks.length}): ${JSON.stringify(ytTracks).substring(0, 500)}...`);
                     // --- End Added Logging ---

                    // Only overwrite tracks and loadType if YouTube search was successful
                    if (ytResult.loadType?.toUpperCase() !== 'LOAD_FAILED' && ytResult.loadType?.toUpperCase() !== 'NO_MATCHES' && ytTracks.length > 0) {
                        tracks = ytTracks;
                        loadType = ytResult.loadType.toUpperCase();
                    } else {
                         logger.warn(`[${guildId}] YouTube fallback search also failed or found no matches. LoadType: ${ytResult?.loadType}`);
                         // Keep the original failure loadType if fallback also fails
                         loadType = loadType || ytResult?.loadType?.toUpperCase() || 'NO_MATCHES';
                    }
                } catch (ytError) {
                    logger.warn(`[${guildId}] YouTube fallback search threw an error for "${query}": ${ytError.message}`);
                     // Keep the original failure loadType if YT fallback errors
                     loadType = loadType || 'LOAD_FAILED';
                }
            }
            // --- End Corrected Fallback Logic ---


            // Handle final results: No tracks found anywhere
            if (tracks.length === 0) {
                let msg = `❌ No tracks found for "${query}".`;
                // Provide more specific reason if the load failed
                if (loadType === 'LOAD_FAILED') {
                    // Extract error message carefully from potential locations
                    const errorMessage = searchResult?.data?.message || searchResult?.exception?.message || 'Load Failed';
                    msg += `\nReason: ${errorMessage}`;
                }
                return interaction.editReply({ content: msg }).catch(() => {});
            }

            // --- Selection Menu Logic ---
            const tracksToShow = tracks.slice(0, config.music.searchResultLimit || 10);

            // --- Embed Color Fix ---
            // Use the configured info color, or fallback to a default blue if invalid/missing
            const infoColor = config?.colors?.info ?? 0x0099FF;
            logger.debug(`[${guildId}] Using color for search embed: ${infoColor}`); // Log the color being used

            const embed = new EmbedBuilder()
                .setColor(infoColor) // Use the validated/default color
                .setTitle(`🔎 Search Results for: "${query}"`)
                .setDescription(`Found ${tracks.length} track(s). Select one below to add it to the queue:`)
                .setTimestamp();
            // --- End Embed Color Fix ---

             // --- Updated Options Mapping ---
             const options = tracksToShow.map((trackData, index) => {
                 const info = trackData.info || trackData;
                 const title = info.title || 'Unknown Title';
                 const author = info.author || 'Unknown Artist';
                 const duration = formatDuration(info.length || 0);
                 // Use the index as the value, ensuring it's a string
                 const trackValue = index.toString();

                 logger.debug(`[${guildId}] Option ${index}: Value='${trackValue}' (Index)`);

                 const label = `${index + 1}. ${title}`.substring(0, 100);
                 const description = `${author} | ${duration}`.substring(0, 100);

                 return { label: label, description: description, value: trackValue };
             });
             // --- End Updated Options Mapping ---

             if (options.length === 0) {
                  logger.error(`[${guildId}] No valid track identifiers found in search results for "${query}".`);
                  return interaction.editReply({ content: 'Error processing search results (missing track identifiers).' }).catch(() => {});
             }

            // --- Start Select Menu Logging & Error Handling ---
            logger.debug(`[${guildId}] Generated options for select menu: ${JSON.stringify(options)}`);

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`search_select_lavalink_${interaction.id}`)
                .setPlaceholder('Select a track to add...');

            try {
                selectMenu.addOptions(options);
                logger.debug(`[${guildId}] Successfully added options to StringSelectMenuBuilder.`);
            } catch (menuError) {
                logger.error(`[${guildId}] Error adding options to StringSelectMenuBuilder:`, menuError);
                logger.error(`[${guildId}] Problematic options array: ${JSON.stringify(options)}`);
                // Provide more specific feedback to the user
                return interaction.editReply({ content: `Error creating selection menu: ${menuError.message}. Please check bot logs.`, embeds: [], components: [] }).catch(() => {});
            }
            // --- End Select Menu Logging & Error Handling ---


            const row = new ActionRowBuilder().addComponents(selectMenu);
            const message = await interaction.editReply({ embeds: [embed], components: [row], fetchReply: true });

            if (!message) {
                 logger.error(`[${guildId}] Failed to send search selection message.`);
                 return interaction.followUp({ content: 'Error displaying search results.', ephemeral: true }).catch(() => {});
            }

            // Collector setup
            const filter = i => i.customId === `search_select_lavalink_${interaction.id}` && i.user.id === interaction.user.id;
            const collector = message.createMessageComponentCollector({ filter, componentType: ComponentType.StringSelect, time: 90000 });

            collector.on('collect', async i => {
                try {
                    await i.deferUpdate();
                    // --- Updated Selection Logic ---
                    const selectedIndex = parseInt(i.values[0], 10); // Parse the index string back to a number
                    const selectedTrackData = tracksToShow[selectedIndex]; // Get track from the array using the index
                    // --- End Updated Selection Logic ---

                    if (!selectedTrackData) {
                        logger.error(`[${guildId}] Could not find selected track data for index: ${selectedIndex}`);
                        await interaction.editReply({ content: 'Error: Could not find the selected track data.', embeds: [], components: [] }).catch(() => {});
                        return collector.stop();
                    }

                     const info = selectedTrackData.info || selectedTrackData;
                    const song = {
                        title: info.title || 'Unknown Title',
                        url: info.uri,
                        duration: formatDuration(info.length || 0),
                        rawDurationMs: info.length || 0,
                        thumbnail: info.artworkUrl || info.thumbnail,
                        requestedBy: i.user.tag,
                        source: info.sourceName || 'Lavalink', // This should be correctly populated by lavasrc/lavalink
                        lavalinkTrack: selectedTrackData.encoded || selectedTrackData.track // The crucial identifier for Lavalink
                    };

                     // Log the source before adding to queue
                     logger.debug(`[${guildId}] Selected track source identified by Lavalink: ${song.source}`);

                    const { addedCount } = await addToQueue(interaction, client.queues, song); // Pass interaction for potential follow-ups in addToQueue

                    if (addedCount > 0) {
                        // --- Embed Color Fix ---
                         const successColor = config?.colors?.success ?? 0x57F287; // Default green
                         logger.debug(`[${guildId}] Using color for success embed: ${successColor}`);
                        const addEmbed = new EmbedBuilder()
                            .setColor(successColor) // Use validated/default color
                            .setTitle(`✅ Track Added`)
                            .setDescription(`**[${song.title}](${song.url})**`)
                            .setThumbnail(song.thumbnail)
                            .addFields(
                                 { name: 'Position', value: `\`${queue.songs.length}\``, inline: true }, // Position is current length AFTER adding
                                 { name: 'Duration', value: `\`${song.duration}\``, inline: true }
                            )
                             // Add source info if available
                             .setFooter({ text: `Selected by ${i.user.tag}${song.source ? ` | Source: ${song.source}` : ''}` })
                            .setTimestamp();
                        // --- End Embed Color Fix ---
                        await interaction.editReply({ embeds: [addEmbed], components: [], content: '' }).catch(() => {});

                        // Start playback if needed
                        if (!player.playing && !player.paused) {
                             await playNextTrack(guildId, client.queues, client);
                        }
                    } else {
                         // If addToQueue returned 0 (e.g., duplicate or queue full), inform user
                         await interaction.editReply({ content: 'Track was not added (maybe duplicate or queue full?).', embeds: [], components: [] }).catch(() => {});
                    }

                    collector.stop('trackSelected');
                } catch (collectError) {
                    logger.error(`[${guildId}] Error processing search selection:`, collectError);
                    await interaction.editReply({ content: 'An error occurred while adding the track.', embeds: [], components: [] }).catch(() => {});
                    collector.stop('error');
                }
            });

            collector.on('end', (collected, reason) => {
                 message.fetch().then(fetchedMessage => {
                     if (reason === 'time' && collected.size === 0) {
                         logger.debug(`[${guildId}] Search selection timed out.`);
                          // --- Embed Color Fix ---
                          const warningColor = config?.colors?.warning ?? 0xFEE75C; // Default yellow
                          logger.debug(`[${guildId}] Using color for warning embed: ${warningColor}`);
                         const timeoutEmbed = new EmbedBuilder().setColor(warningColor).setTitle('Search Timed Out').setDescription('You did not select a track in time.');
                         // --- End Embed Color Fix ---
                         fetchedMessage.edit({ embeds: [timeoutEmbed], components: [] }).catch(() => {});
                     } else if (reason !== 'trackSelected' && reason !== 'error') {
                          // Clean up components if ended for other reasons (e.g., message deleted)
                          fetchedMessage.edit({ components: [] }).catch(() => {});
                     }
                 }).catch(() => {
                      logger.debug(`[${guildId}] Search selection message was deleted before collector ended.`);
                 });
            });
        } catch (error) {
            logger.error(`[${guildId}] Critical error during /search execution:`, error);
            await interaction.editReply({ content: `An unexpected error occurred during the search: ${error.message}`, embeds: [], components: [] }).catch(() => {});
        }
    }
};
