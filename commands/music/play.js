// commands/music/play.js
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const logger = require('../../utils/logger'); // Adjust path
const config = require('../../config'); // Adjust path
// Import Lavalink player function and queue functions
const { getLavalinkPlayer, createGuildQueue, addToQueue, playNextTrack, updateNowPlayingMessage } = require('../../spotify/spotifyPlayer'); // Adjust path
// play-dl is no longer needed here
// const play = require('play-dl');
// Spotify API might still be useful for metadata if Lavalink fails on Spotify URLs
const { getClientCredentialsSpotifyApi } = require('../../spotify/spotifyAuth'); // Adjust path

// Helper function to format duration from ms to MM:SS
function formatDuration(ms) {
    if (!ms || typeof ms !== 'number' || ms < 0) return 'N/A';
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('play')
        .setDescription('Plays a song or playlist from URL or search query using Lavalink.') // Updated description
        .addStringOption(option =>
            option.setName('query')
                .setDescription('Song name, search term, or URL (YouTube, SoundCloud, Spotify etc.)') // Updated description
                .setRequired(true)),

    async execute(interaction, client, userProfile) {
        logger.info(`====== Executing /play command for query: "${interaction.options.getString('query')}" ======`);
        await interaction.deferReply();

        const query = interaction.options.getString('query');
        const voiceChannel = interaction.member.voice.channel;
        const guildId = interaction.guild.id;

        // --- Pre-checks ---
        if (!voiceChannel) return interaction.editReply({ content: 'You need to be in a voice channel...', flags: 64 });
        const permissions = voiceChannel.permissionsFor(client.user);
        if (!permissions || !permissions.has('Connect') || !permissions.has('Speak')) return interaction.editReply({ content: 'I require permissions...', flags: 64 });

        // --- Get Lavalink Player (ensure connection) ---
        const player = await getLavalinkPlayer(client, guildId, voiceChannel.id, interaction.channel);
        if (!player) {
            return interaction.editReply({ content: 'Failed to connect to voice or Lavalink node. Please try again.', flags: 64 });
        }
        // Ensure queue structure exists
        let queue = client.queues?.get(guildId);
        if (!queue) queue = createGuildQueue(interaction, voiceChannel);
        queue.lavalinkPlayer = player; // Ensure player is linked

        try {
            // --- Step 1: Load Tracks using Lavalink ---
            logger.info(`[${guildId}] Loading tracks via Lavalink for: "${query}"`);
            // Use node attached to the player to load tracks
            // Prepend search type if it's not a URL and default to YouTube search
            const searchQuery = query.startsWith('http') ? query : `ytsearch:${query}`;
            const searchResult = await player.node.rest.loadTracks(searchQuery);

            // --- Step 2: Handle Lavalink Load Results ---
            let tracksToAdd = [];
            let playlistInfo = null;

            if (searchResult.loadType === 'LOAD_FAILED') {
                logger.error(`[${guildId}] Lavalink load failed for "${searchQuery}". Reason: ${searchResult.exception?.message || 'Unknown'}`);
                return interaction.editReply({ content: `Error loading track(s): ${searchResult.exception?.message || 'Could not load track'}` });
            } else if (searchResult.loadType === 'NO_MATCHES') {
                logger.warn(`[${guildId}] Lavalink found no matches for "${searchQuery}".`);
                return interaction.editReply({ content: `Could not find any tracks matching "${query}".` });
            } else if (searchResult.loadType === 'TRACK_LOADED') {
                tracksToAdd.push(searchResult.data);
                logger.debug(`[${guildId}] Lavalink loaded single track: ${searchResult.data.info.title}`);
            } else if (searchResult.loadType === 'PLAYLIST_LOADED') {
                tracksToAdd = searchResult.data.tracks;
                playlistInfo = {
                    name: searchResult.data.info.name,
                    count: tracksToAdd.length,
                };
                logger.debug(`[${guildId}] Lavalink loaded playlist "${playlistInfo.name}" with ${playlistInfo.count} tracks.`);
                // Optionally edit reply to indicate playlist loading
                await interaction.editReply({ content: `Adding ${playlistInfo.count} tracks from playlist "${playlistInfo.name}"...`}).catch(()=>{});
            } else if (searchResult.loadType === 'SEARCH_RESULT') {
                // If it's a search result, ideally we'd let the user pick like in /search
                // For /play, we'll just take the first result for simplicity
                if (searchResult.data.length === 0) {
                     return interaction.editReply({ content: `Could not find any tracks matching "${query}".` });
                }
                tracksToAdd.push(searchResult.data[0]);
                logger.debug(`[${guildId}] Lavalink search found tracks. Taking first result: ${tracksToAdd[0].info.title}`);
            }

            if (tracksToAdd.length === 0) {
                 return interaction.editReply({ content: `No tracks were found or loaded for your query.` });
            }

            // --- Step 3: Add Tracks to Bot Queue ---
            let actuallyAddedCount = 0;
            for (const trackData of tracksToAdd) {
                const song = {
                    title: trackData.info.title || 'Untitled Track',
                    url: trackData.info.uri,
                    duration: formatDuration(trackData.info.length),
                    rawDurationMs: trackData.info.length,
                    thumbnail: trackData.info.artworkUrl, // Use artworkUrl if available
                    requestedBy: interaction.user.tag,
                    source: trackData.info.sourceName || 'Lavalink',
                    lavalinkTrack: trackData.track, // Store the Lavalink track identifier
                };

                // Add to queue (addToQueue handles duplicates/size limit)
                const { addedCount } = await addToQueue(interaction, client.queues, song);
                actuallyAddedCount += addedCount;

                // Stop adding if queue becomes full
                 if (queue.songs.length >= (config.music.maxQueueSize || 100) && addedCount === 0) {
                     logger.warn(`[${guildId}] Queue full during /play add. Added ${actuallyAddedCount} tracks.`);
                     break;
                 }
            }

            if (actuallyAddedCount === 0) {
                 // Handle cases where tracks were found but not added (e.g., all duplicates)
                 return interaction.editReply({ content: `Found track(s), but none were added (they might be duplicates or the queue is full).` });
            }

            // --- Step 4: Send Confirmation ---
            const embed = new EmbedBuilder().setColor(config.colors.success);
            if (playlistInfo) {
                embed.setTitle(`Playlist Added: ${playlistInfo.name}`)
                     .setDescription(`Added **${actuallyAddedCount}** track(s) to the queue.`)
                     // .setThumbnail(playlistInfo.thumbnail) // Lavalink playlist load doesn't usually provide thumbnail
                     .setFooter({ text: `Requested by ${interaction.user.tag}` });
                 if (actuallyAddedCount < playlistInfo.count) {
                     embed.description += `\n*Some tracks may have been skipped (duplicates or queue full).*`;
                 }
            } else { // Single track added
                const addedSong = queue.songs[queue.songs.length - 1]; // Get the last added song
                embed.setTitle(`Track Added: ${addedSong.title}`)
                     .setURL(addedSong.url)
                     .setDescription(`Added from ${addedSong.source}.\nPosition in queue: **${queue.songs.length}**`)
                     .setThumbnail(addedSong.thumbnail)
                     .addFields({ name: 'Duration', value: addedSong.duration || 'N/A', inline: true })
                     .setFooter({ text: `Requested by ${addedSong.requestedBy}` });
            }
            await interaction.editReply({ embeds: [embed], content: '' });


            // --- Step 5: Start Playback if Needed ---
            if (!player.playing && !player.paused) {
                 logger.info(`[${guildId}] Player not playing, starting playback after /play.`);
                 await playNextTrack(guildId, client.queues, client);
            } else {
                 // If already playing, update NP message queue count potentially
                 await updateNowPlayingMessage(queue);
            }

        } catch (error) {
             logger.error(`[${guildId}] Error during Lavalink /play command:`, error);
             // Use editReply since we deferred
             await interaction.editReply({ content: `An error occurred while processing your request: ${error.message || 'Unknown error'}`, embeds: [] });
        }
    },
};