// commands/music/search.js
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ComponentType } = require('discord.js');
const logger = require('../../utils/logger');
const config = require('../../config');
const { createGuildQueue, addToQueue, startPlayback, updateNowPlayingMessage, playNextTrack } = require('../../spotify/spotifyPlayer');
const { getClientCredentialsSpotifyApi } = require('../../spotify/spotifyAuth');
const play = require('play-dl'); // Add play-dl for YouTube search

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
        .setName('search')
        .setDescription('Searches Spotify for tracks and lets you choose one to add.')
        .addStringOption(option =>
            option.setName('query')
                .setDescription('The search term for the Spotify track.')
                .setRequired(true)),

    async execute(interaction, client, userProfile) {
        logger.info(`====== Executing /search command for query: "${interaction.options.getString('query')}" ======`);
        await interaction.deferReply();

        const query = interaction.options.getString('query');
        const voiceChannel = interaction.member.voice.channel;
        const guildId = interaction.guild.id;

        // --- Pre-checks ---
        if (!voiceChannel) {
            return interaction.editReply({ content: 'You need to be in a voice channel to use this command.', ephemeral: true });
        }
        const permissions = voiceChannel.permissionsFor(client.user);
        if (!permissions || !permissions.has('Connect') || !permissions.has('Speak')) {
            return interaction.editReply({ content: 'I require Connect and Speak permissions in the voice channel.', ephemeral: true });
        }

        try {
            // --- Step 1: Search Spotify ---
            logger.debug(`[${guildId}] Attempting to get Spotify client credentials API...`);
            const spotifyApi = await getClientCredentialsSpotifyApi();
            if (!spotifyApi) {
                return interaction.editReply({ content: 'Could not connect to Spotify services. Please try again later.', ephemeral: true });
            }
            logger.debug(`[${guildId}] Spotify client credentials API obtained successfully.`);

            logger.info(`[${guildId}] Searching Spotify API for tracks matching: "${query}"`);
            let searchData;
            try {
                searchData = await spotifyApi.searchTracks(query, { limit: config.music.searchResultLimit, market: 'US' });
                logger.debug(`[${guildId}] Spotify API search response received.`);
            } catch (spotifyError) {
                logger.error(`[${guildId}] Spotify search error:`, spotifyError);
                return interaction.editReply({ content: `An error occurred while searching Spotify: ${spotifyError.message}`, ephemeral: true });
            }

            const spotifyResults = searchData.body?.tracks?.items;
            logger.debug(`[${guildId}] Parsed ${spotifyResults?.length ?? 0} tracks from Spotify response.`);
            if (!spotifyResults || spotifyResults.length === 0) {
                return interaction.editReply({ content: `No Spotify tracks found for "${query}".` });
            }

            // --- Step 2: Display Spotify Results for Selection ---
            const embed = new EmbedBuilder()
                .setColor(config.colors.spotify)
                .setTitle(`Spotify Search Results for: "${query}"`)
                .setDescription('Select a track below to add it to the queue.')
                .setTimestamp();

            const options = spotifyResults.map((track, index) => {
                const trackTitle = track.name || 'Untitled Track';
                const trackArtists = track.artists?.map(artist => artist.name).join(', ') || 'Unknown Artist';
                const trackDuration = formatDuration(track.duration_ms);
                const label = `${index + 1}. ${trackTitle}`.substring(0, 100);
                const description = `${trackArtists} | ${trackDuration}`.substring(0, 100);
                return { label, description, value: track.id };
            }).filter(option => option.value);

            if (options.length === 0) {
                return interaction.editReply({ content: 'Found Spotify tracks, but there was an issue preparing the selection menu.', ephemeral: true });
            }

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`search_select_spotify_${interaction.id}`)
                .setPlaceholder('Select a Spotify track...')
                .addOptions(options);
            const row = new ActionRowBuilder().addComponents(selectMenu);
            const message = await interaction.editReply({ embeds: [embed], components: [row], fetchReply: true });

            // --- Step 3: Collect User Selection ---
            const filter = i => i.customId === `search_select_spotify_${interaction.id}` && i.user.id === interaction.user.id;
            if (!message) {
                return interaction.followUp({ content: 'Error setting up selection prompt.', ephemeral: true });
            }
            const collector = message.createMessageComponentCollector({ filter, componentType: ComponentType.StringSelect, time: 90000 });

            collector.on('collect', async i => {
                try {
                    await i.deferUpdate();
                    const selectedSpotifyId = i.values[0];
                    logger.debug(`[${guildId}] User selected Spotify ID: ${selectedSpotifyId}`);

                    const selectedSpotifyTrack = spotifyResults.find(track => track.id === selectedSpotifyId);
                    if (!selectedSpotifyTrack) {
                        logger.error(`[${guildId}] Selected Spotify track not found: ${selectedSpotifyId}`);
                        await interaction.editReply({ content: 'Selected track not found.', embeds: [], components: [] });
                        return collector.stop();
                    }

                    // --- Step 4: Search YouTube for Matching Track ---
                    const trackTitle = selectedSpotifyTrack.name || 'Untitled Track';
                    const trackArtists = selectedSpotifyTrack.artists?.map(artist => artist.name).join(', ') || '';
                    const youtubeQuery = `${trackTitle} ${trackArtists}`.trim();
                    logger.info(`[${guildId}] Searching YouTube for: "${youtubeQuery}"`);

                    let youtubeResults;
                    try {
                        youtubeResults = await play.search(youtubeQuery, { source: { youtube: 'video' }, limit: 1 });
                        logger.debug(`[${guildId}] YouTube search returned ${youtubeResults?.length ?? 0} results.`);
                    } catch (youtubeError) {
                        logger.error(`[${guildId}] YouTube search error:`, youtubeError);
                        await interaction.editReply({ content: `Failed to find a YouTube video for "${trackTitle}".`, embeds: [], components: [] });
                        return collector.stop();
                    }

                    if (!youtubeResults || youtubeResults.length === 0) {
                        logger.warn(`[${guildId}] No YouTube results found for: "${youtubeQuery}"`);
                        await interaction.editReply({ content: `No YouTube video found for "${trackTitle}".`, embeds: [], components: [] });
                        return collector.stop();
                    }

                    const youtubeTrack = youtubeResults[0];
                    logger.debug(`[${guildId}] Selected YouTube video: ${youtubeTrack.title} (${youtubeTrack.url})`);

                    // --- Step 5: Add Song to Queue ---
                    let queue = client.queues.get(guildId);
                    if (!queue) {
                        queue = createGuildQueue(interaction, voiceChannel);
                        client.queues.set(guildId, queue);
                    } else {
                        if (interaction.guild.members.me?.voice?.channel && interaction.guild.members.me.voice.channel.id !== voiceChannel.id) {
                            await interaction.editReply({ content: `I am in another voice channel: ${interaction.guild.members.me.voice.channel.name}.`, embeds: [], components: [] });
                            return collector.stop();
                        }
                        queue.voiceChannel = voiceChannel;
                        queue.textChannel = interaction.channel;
                    }

                    // Create song object with YouTube URL
                    const song = {
                        title: selectedSpotifyTrack.name || 'Untitled Track',
                        url: youtubeTrack.url, // Use YouTube URL
                        duration: formatDuration(selectedSpotifyTrack.duration_ms), // Use Spotify duration
                        thumbnail: selectedSpotifyTrack.album?.images?.[0]?.url || youtubeTrack.thumbnails?.[0]?.url,
                        requestedBy: i.user.tag,
                        source: 'Spotify', // Indicate Spotify as original source
                        spotifyUrl: selectedSpotifyTrack.external_urls?.spotify // Keep Spotify URL for reference
                    };

                    if (!song.url) {
                        logger.error(`[${guildId}] YouTube track missing URL: ${youtubeTrack.id}`);
                        await interaction.editReply({ content: 'Selected YouTube track is missing necessary information (URL). Cannot add.', embeds: [], components: [] });
                        return collector.stop();
                    }

                    logger.debug(`[${guildId}] Adding song to queue: ${song.title} (YouTube URL: ${song.url}, Spotify URL: ${song.spotifyUrl})`);
                    await addToQueue(interaction, client.queues, song);

                    const addEmbed = new EmbedBuilder()
                        .setColor(config.colors.success)
                        .setTitle(`Track Added: ${song.title}`)
                        .setURL(song.spotifyUrl) // Link to Spotify URL for user reference
                        .setDescription(`Added from Spotify (playing via YouTube).\nPosition in queue: **${queue.songs.length}**`)
                        .setThumbnail(song.thumbnail)
                        .addFields({ name: 'Duration', value: song.duration || 'N/A', inline: true })
                        .setFooter({ text: `Selected by ${i.user.tag} | Source: ${song.source}` });

                    // Edit the original reply, removing components
                    await interaction.editReply({ embeds: [addEmbed], components: [], content: '' });

                    // Start playback if needed
                    const botVC = interaction.guild.members.me?.voice?.channel;
                    if (!queue.playing && !botVC) {
                        await startPlayback(interaction, client.queues, queue);
                    } else if (!queue.playing && botVC) {
                        playNextTrack(guildId, client.queues);
                    } else if (queue.playing) {
                        await updateNowPlayingMessage(queue);
                    }

                    collector.stop();

                } catch (collectError) {
                    logger.error(`[${guildId}] Error processing search selection:`, collectError);
                    await interaction.editReply({ content: 'Error adding track to queue.', embeds: [], components: [] });
                    collector.stop();
                }
            });

            collector.on('end', (collected, reason) => {
                if (message) {
                    message.fetch().then(fetchedMessage => {
                        if (fetchedMessage && reason === 'time' && collected.size === 0) {
                            const timeoutEmbed = new EmbedBuilder()
                                .setColor(config.colors.warning)
                                .setTitle('Search Timed Out')
                                .setDescription('No track selected.');
                            fetchedMessage.edit({ embeds: [timeoutEmbed], components: [] }).catch(() => {});
                        } else if (fetchedMessage && collected.size === 0 && reason !== 'time') {
                            fetchedMessage.edit({ components: [] }).catch(() => {});
                        }
                    }).catch(() => {});
                }
            });

        } catch (error) {
            logger.error(`[${guildId}] Error during Spotify /search:`, error.body || error);
            await interaction.editReply({ content: `Error during Spotify search: ${error.body?.error?.message || error.message || 'Unknown'}`, embeds: [], components: [] });
        }
    },
};