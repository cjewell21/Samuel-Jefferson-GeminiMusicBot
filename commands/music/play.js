// commands/music/play.js
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { createGuildQueue, addToQueue, startPlayback, updateNowPlayingMessage, playNextTrack } = require('../../spotify/spotifyPlayer'); // Adjust path
const play = require('play-dl'); // For getting track/playlist info
const logger = require('../../utils/logger'); // Adjust path
const config = require('../../config'); // Adjust path
const { getUserSpotifyApi } = require('../../spotify/spotifyAuth'); // Adjust path
const { replyWithError, replyWithSuccess } = require('../../utils/interactionUtils'); // Use helpers

module.exports = {
    data: new SlashCommandBuilder()
        .setName('play')
        .setDescription('Plays a song or playlist from Spotify.')
        .addStringOption(option =>
            option.setName('query')
                .setDescription('Spotify track or playlist URL') // Updated description
                .setRequired(true)),

    async execute(interaction, client, userProfile) {
        await interaction.deferReply();

        const query = interaction.options.getString('query');
        const voiceChannel = interaction.member.voice.channel;
        const guildId = interaction.guild.id;

        // --- Pre-checks ---
        if (!voiceChannel) {
            return interaction.editReply({ content: 'You need to be in a voice channel to summon me for music!', ephemeral: true });
        }
        const permissions = voiceChannel.permissionsFor(client.user);
        if (!permissions || !permissions.has(PermissionFlagsBits.Connect) || !permissions.has(PermissionFlagsBits.Speak)) {
            return interaction.editReply({ content: 'I require the ancient rites (permissions) to join and speak in your voice channel!', ephemeral: true });
        }
        if (!query) {
             return interaction.editReply({ content: 'Pray tell, what Spotify melody shall I procure? Please provide a track or playlist URL.', ephemeral: true });
        }

        let queue = client.queues.get(guildId);
        const botCurrentVC = interaction.guild.members.me?.voice?.channel;

        // --- Handle Bot/User VC State ---
        if (botCurrentVC && botCurrentVC.id !== voiceChannel.id) {
            return interaction.editReply({ content: `I am currently bound to another channel (${botCurrentVC.name}). Please join me there or stop the current playback first.`, ephemeral: true });
        }

        // --- Create or Update Queue ---
        if (!queue) {
            queue = createGuildQueue(interaction, voiceChannel);
            client.queues.set(guildId, queue);
            logger.info(`Created new queue for guild ${guildId}`);
        } else {
            queue.textChannel = interaction.channel;
            queue.voiceChannel = voiceChannel;
            logger.debug(`Updated channel references for existing queue in guild ${guildId}`);
        }


        // --- Process Spotify Input ---
        try {
            let songs = [];
            let playlistInfo = null;
            let inputSource = 'Spotify'; // Assume Spotify input

            // Validate the query type using play-dl, focusing on Spotify
            const validation = await play.validate(query).catch(() => 'invalid'); // Treat validation errors as invalid input
            logger.debug(`Validation result for query "${query}": ${validation}`);

            // Get Spotify API instance if needed (mainly for private playlists)
            // const spotifyApi = validation?.startsWith('sp_') ? await getUserSpotifyApi(interaction.user.id) : null;
            // Note: getUserSpotifyApi might be needed if play.playlist_info fails on private lists

            if (validation === 'sp_track') {
                const trackInfo = await play.video_info(query); // play-dl uses this to get metadata
                if (!trackInfo) throw new Error(`Could not find track information for the provided Spotify track URL.`);
                const song = {
                    title: trackInfo.video_details.title || 'Untitled Track',
                    url: trackInfo.video_details.url, // This might be the Spotify URL, play-dl handles finding stream source later
                    duration: trackInfo.video_details.durationRaw,
                    thumbnail: trackInfo.video_details.thumbnails?.[0]?.url,
                    requestedBy: interaction.user.tag,
                    source: inputSource,
                };
                songs.push(song);

            } else if (validation === 'sp_playlist') {
                const playlist = await play.playlist_info(query, { incomplete: true });
                if (!playlist) throw new Error(`Could not find playlist information for the provided Spotify playlist URL.`);

                await interaction.editReply({ content: `Fetching tracks from Spotify playlist: **${playlist.title || 'Untitled Playlist'}**... (This might take a moment)` });

                await playlist.fetch(); // Fetch all tracks

                playlistInfo = {
                    title: playlist.title || 'Untitled Playlist',
                    url: playlist.url,
                    thumbnail: playlist.thumbnail?.url,
                    requestedBy: interaction.user.tag,
                    source: inputSource,
                    initialCount: playlist.total_videos,
                    addedCount: 0,
                };

                for (const track of playlist.videos) {
                     if (queue.songs.length + playlistInfo.addedCount >= config.music.maxQueueSize) {
                         logger.warn(`Queue full while adding Spotify playlist ${playlist.title}. Stopping.`);
                         break;
                     }
                     if (track && track.title && track.url) {
                        const song = {
                            title: track.title,
                            url: track.url, // Keep Spotify URL, play-dl resolves stream later
                            duration: track.durationRaw,
                            thumbnail: track.thumbnails?.[0]?.url,
                            requestedBy: interaction.user.tag,
                            source: inputSource,
                        };
                        // Skip duplicates (optional checks remain)
                        if (!config.music.allowPlaylistDuplicates && (songs.some(s => s.url === song.url) || queue.songs.some(s => s.url === song.url))) continue;

                        songs.push(song);
                        playlistInfo.addedCount++;
                     }
                }

            } else { // Input is not a valid Spotify track or playlist URL
                 logger.warn(`Invalid input for /play command: "${query}". Validation: ${validation}`);
                 return interaction.editReply({ content: `Invalid input. Please provide a valid Spotify track or playlist URL.` });
            }

            // --- Handle Results ---
            if (songs.length === 0) {
                 if (playlistInfo) {
                     return interaction.editReply({ content: `No new tracks were added from the playlist "${playlistInfo.title}". They might already be in the queue or duplicates.` });
                 }
                 // This case should ideally be caught by the track fetch error above
                 return interaction.editReply({ content: `Could not process the provided Spotify link.` });
            }

            // Add the found songs to the actual queue
            const { addedCount, totalSongsInQueue } = await addToQueue(interaction, client.queues, songs);

            // Build confirmation embed
            const embed = new EmbedBuilder().setColor(config.colors.success);
            if (playlistInfo) {
                embed.setTitle(`Playlist Added: ${playlistInfo.title}`)
                     .setURL(playlistInfo.url)
                     .setDescription(`Added **${playlistInfo.addedCount}** track(s) from ${playlistInfo.source} to the queue.`)
                     .setThumbnail(playlistInfo.thumbnail)
                     .setFooter({ text: `Requested by ${playlistInfo.requestedBy}` });
                 if (totalSongsInQueue >= config.music.maxQueueSize && playlistInfo.addedCount < playlistInfo.initialCount) {
                     embed.description += `\n*Queue is now full (${config.music.maxQueueSize} songs). Not all tracks from the playlist could be added.*`;
                 } else if (playlistInfo.addedCount < songs.length) {
                      embed.description += `\n*Some tracks were skipped (duplicates).*`;
                 }
            } else { // Single track added
                const addedSong = songs[0];
                embed.setTitle(`Track Added: ${addedSong.title}`)
                     .setURL(addedSong.url)
                     .setDescription(`Added from ${addedSong.source}. Position in queue: **${totalSongsInQueue}**`)
                     .setThumbnail(addedSong.thumbnail)
                     .addFields({ name: 'Duration', value: addedSong.duration || 'N/A', inline: true })
                     .setFooter({ text: `Requested by ${addedSong.requestedBy}` });
            }

            await interaction.editReply({ embeds: [embed], content: '' }); // Clear "Fetching..." content

            // --- Start Playback if not already playing ---
            const botVC = interaction.guild.members.me?.voice?.channel;
            if (!queue.playing && !botVC) {
                logger.info(`Starting playback as queue was not playing and bot was not in VC.`);
                await startPlayback(interaction, client.queues, queue);
            } else if (!queue.playing && botVC) {
                 logger.info(`Triggering playNextTrack as queue was not playing but bot was in VC.`);
                 playNextTrack(guildId, client.queues);
            } else if (queue.playing) {
                logger.debug(`Queue is already playing, updating Now Playing message.`);
                await updateNowPlayingMessage(queue);
            }


        } catch (error) {
            logger.error(`Error processing play command for query "${query}" in guild ${guildId}:`, error);
            // Use helper or direct editReply for error feedback
            await interaction.editReply({ content: `An error occurred while processing the Spotify link: ${error.message || 'Could not process your request.'}`, embeds: [], ephemeral: true });
        }
    },
};
