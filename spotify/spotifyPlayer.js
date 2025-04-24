// spotify/spotifyPlayer.js
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    entersState,
    StreamType,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    NoSubscriberBehavior,
    getVoiceConnection,
    demuxProbe,
} = require('@discordjs/voice');
const play = require('play-dl');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const logger = require('../utils/logger');
const config = require('../config');
const User = require('../database/models/User');
const { getUserSpotifyApi } = require('./spotifyAuth');
const SpotifyWebApi = require('spotify-web-api-node');

// --- Queue Management ---
function createGuildQueue(interaction, voiceChannel) {
    const guildId = interaction.guild.id;
    logger.info(`Creating new queue for guild ${guildId}`);
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });

    player.on('stateChange', (oldState, newState) => {
        logger.debug(`[${guildId}] AudioPlayer state change: ${oldState.status} -> ${newState.status}`);
        if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) {
            const queue = interaction.client.queues.get(guildId);
            if (queue) handleIdleState(queue, interaction.client.queues);
            else logger.warn(`Queue not found for guild ${guildId} during player Idle state change.`);
        } else if (newState.status === AudioPlayerStatus.Playing) {
            const queue = interaction.client.queues.get(guildId);
            if (queue) {
                queue.playing = true;
                if (queue.leaveTimeout) { clearTimeout(queue.leaveTimeout); queue.leaveTimeout = null; }
                updateNowPlayingMessage(queue);
            }
        } else if (newState.status === AudioPlayerStatus.Buffering) {
            logger.debug(`[${guildId}] Player entered Buffering state. Monitoring...`);
        }
    });

    player.on('error', error => {
        logger.error(`Audio Player Error (Guild: ${guildId}): ${error.message}`, error);
        const queue = interaction.client.queues.get(guildId);
        if (queue) {
            queue.playing = false;
            queue.currentTrack = null;
            if (queue.songs.length > 0) playNextTrack(guildId, interaction.client.queues);
            else handleQueueEnd(queue, interaction.client.queues);
        }
    });

    const queueConstruct = {
        textChannel: interaction.channel,
        voiceChannel: voiceChannel,
        connection: null,
        player: player,
        songs: [],
        volume: config.music.defaultVolume,
        playing: false,
        loop: false,
        currentTrack: null,
        nowPlayingMessage: null,
        leaveTimeout: null,
        guildId: guildId
    };
    return queueConstruct;
}

function handleIdleState(queue, queues) {
    const guildId = queue.guildId;
    const oldTrack = queue.currentTrack;
    queue.currentTrack = null;
    queue.playing = false;

    if (queue.loop && oldTrack) {
        logger.info(`Looping track: ${oldTrack.title}`);
        queue.songs.push(oldTrack);
    }

    setTimeout(() => {
        const currentQueue = queues.get(guildId);
        if (currentQueue && currentQueue.player.state.status === AudioPlayerStatus.Idle) {
            if (currentQueue.songs.length > 0) playNextTrack(guildId, queues);
            else handleQueueEnd(currentQueue, queues);
        }
    }, 100);
}

async function addToQueue(interaction, queues, songData) {
    const guildId = interaction.guild.id;
    const queue = queues.get(guildId);
    if (!queue) {
        logger.error(`[${guildId}] Cannot add: No queue.`);
        return { addedCount: 0 };
    }

    const duplicate = queue.songs.some(s =>
        (s.spotifyUrl && songData.spotifyUrl && s.spotifyUrl === songData.spotifyUrl) ||
        (!s.spotifyUrl && !songData.spotifyUrl && s.url === songData.url)
    );
    if (duplicate) {
        logger.debug(`[${guildId}] Duplicate: "${songData.title}".`);
        return { addedCount: 0 };
    }

    if (queue.songs.length >= (config.music.maxQueueSize || 100)) {
        logger.warn(`[${guildId}] Queue full.`);
        return { addedCount: 0 };
    }

    queue.songs.push(songData);
    logger.debug(`[${guildId}] Added "${songData.title}". Queue: ${queue.songs.length}`);
    return { addedCount: 1 };
}

// --- Playback Logic ---
async function startPlayback(interaction, queues, queue) {
    const guildId = queue.guildId;
    if (!queue.songs.length) return;
    if (!queue.voiceChannel) return;

    logger.info(`[${guildId}] startPlayback for channel: ${queue.voiceChannel.name}`);
    if (queue.leaveTimeout) clearTimeout(queue.leaveTimeout);

    let connection = getVoiceConnection(guildId);
    let connectionCreated = false;

    try {
        if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed || connection.state.status === VoiceConnectionStatus.Disconnected) {
            logger.info(`[${guildId}] Creating new voice connection...`);
            connection = joinVoiceChannel({
                channelId: queue.voiceChannel.id,
                guildId: guildId,
                adapterCreator: interaction.guild.voiceAdapterCreator,
                selfDeaf: true
            });
            connectionCreated = true;
            queue.connection = connection;

            connection.once(VoiceConnectionStatus.Destroyed, () => {
                logger.info(`[${guildId}] VC Destroyed.`);
                const q = queues.get(guildId);
                if (q) {
                    q.player?.stop(true);
                    q.playing = false;
                    q.connection = null;
                    queues.delete(guildId);
                    updateNowPlayingMessage(q, true).catch(() => {});
                }
            });
            connection.on('error', (error) => {
                logger.error(`[${guildId}] VC Error:`, error);
                if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
            });
            connection.on('stateChange', (o, n) => {
                logger.debug(`[${guildId}] VC State: ${o.status} -> ${n.status}`);
                if (n.status === VoiceConnectionStatus.Disconnected) {
                    entersState(connection, VoiceConnectionStatus.Connecting, 5_000).catch(() => {
                        if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
                    });
                }
            });
        } else {
            logger.info(`[${guildId}] Reusing existing VC (State: ${connection.state.status}).`);
            queue.connection = connection;
        }

        if (connection.state.status !== VoiceConnectionStatus.Ready) {
            logger.debug(`[${guildId}] Waiting for VC Ready...`);
            await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
            logger.info(`[${guildId}] VC Ready.`);
        }

        logger.debug(`[${guildId}] Subscribing player...`);
        connection.subscribe(queue.player);
        logger.debug(`[${guildId}] Player subscribed.`);

        if (queue.songs.length > 0) {
            logger.info(`[${guildId}] Calling playNextTrack.`);
            if (queue.player.state.status === AudioPlayerStatus.Idle) queue.playing = false;
            await playNextTrack(guildId, queues);
        } else {
            logger.info(`[${guildId}] VC ready but queue empty.`);
            queue.playing = false;
        }
    } catch (error) {
        logger.error(`[${guildId}] Error in startPlayback:`, error);
        if (connectionCreated && connection?.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
        queue.playing = false;
        queue.connection = null;
        queues.delete(guildId);
        await interaction.followUp({ content: `Error starting playback: ${error.message}`, flags: 64 }).catch(() => {});
    }
}

async function updateNowPlayingMessage(queue, isFinished = false) {
    if (!queue || !queue.textChannel?.send) return;
    if (queue.songs.length === 0 && !queue.currentTrack) isFinished = true;

    if (isFinished) {
        if (queue.nowPlayingMessage) {
            await queue.nowPlayingMessage.delete().catch(() => {});
            queue.nowPlayingMessage = null;
        }
        return;
    }

    const currentTrack = queue.currentTrack;
    if (!currentTrack) {
        if (queue.nowPlayingMessage) {
            await queue.nowPlayingMessage.delete().catch(() => {});
            queue.nowPlayingMessage = null;
        }
        return;
    }

    const musicColor = config?.colors?.music;
    const colorToSet = musicColor || 0xCCCCCC;
    const embed = new EmbedBuilder()
        .setColor(colorToSet)
        .setTitle('Now Playing')
        .setDescription(`[${currentTrack.title}](${currentTrack.spotifyUrl || currentTrack.url})`)
        .addFields(
            { name: 'Duration', value: String(currentTrack.duration || 'N/A'), inline: true },
            { name: 'Requested By', value: String(currentTrack.requestedBy || 'Unknown'), inline: true }
        )
        .setThumbnail(currentTrack.thumbnail)
        .setTimestamp();

    try {
        if (queue.nowPlayingMessage?.editable) {
            await queue.nowPlayingMessage.edit({ embeds: [embed] });
        } else {
            if (queue.nowPlayingMessage) {
                await queue.nowPlayingMessage.delete().catch(() => {});
                queue.nowPlayingMessage = null;
            }
            const sent = await queue.textChannel.send({ embeds: [embed] });
            queue.nowPlayingMessage = await queue.textChannel.messages.fetch(sent.id).catch(() => null);
        }
    } catch (error) {
        logger.error(`[${queue.guildId}] Error updating NP msg:`, error);
        if (error.code === 10008 || error.code === 10003) queue.nowPlayingMessage = null;
    }
}

async function playNextTrack(guildId, queues) {
    const queue = queues.get(guildId);
    if (!queue) {
        logger.info(`[${guildId}] No queue for playNextTrack.`);
        return;
    }
    if (!queue.connection || queue.connection.state.status === VoiceConnectionStatus.Destroyed || queue.connection.state.status === VoiceConnectionStatus.Disconnected) {
        logger.warn(`[${guildId}] Invalid VC for playNextTrack (State: ${queue.connection?.state?.status}). Aborting.`);
        queues.delete(guildId);
        await updateNowPlayingMessage(queue, true);
        return;
    }
    if (queue.songs.length === 0 && !queue.currentTrack) {
        logger.info(`[${guildId}] Queue empty. Stopping.`);
        queue.playing = false;
        queue.currentTrack = null;
        await updateNowPlayingMessage(queue, true);
        handleQueueEnd(queue, queues);
        return;
    }
    if (queue.processingNext) return logger.debug(`[${guildId}] Already processing next track.`);
    queue.processingNext = true;

    if (!queue.currentTrack) {
        if (queue.songs.length === 0) {
            queue.processingNext = false;
            handleQueueEnd(queue, queues);
            return;
        }
        queue.currentTrack = queue.songs.shift();
    }

    logger.info(`[${guildId}] Attempting to play: "${queue.currentTrack.title}" (URL: ${queue.currentTrack.url})`);
    await updateNowPlayingMessage(queue);

    try {
        // Validate URL
        if (!queue.currentTrack.url || !queue.currentTrack.url.includes('youtube.com')) {
            logger.error(`[${guildId}] Invalid or non-YouTube URL: ${queue.currentTrack.url}`);
            throw new Error('Invalid URL: Must be a YouTube video URL.');
        }

        // Use play.stream() as primary
        logger.debug(`[${guildId}] Fetching stream using play.stream for: ${queue.currentTrack.url}`);
        const streamOpts = {
            discordPlayerCompatibility: true,
            quality: 2 // Highest audio quality
        };
        const streamInfo = await play.stream(queue.currentTrack.url, streamOpts);

        if (!streamInfo || !streamInfo.stream || !streamInfo.type) {
            logger.error(`[${guildId}] play.stream failed to return valid stream info. URL: ${queue.currentTrack.url}`);
            throw new Error('Failed to obtain stream info from play-dl.');
        }
        logger.debug(`[${guildId}] Stream obtained via play-dl. Type: ${streamInfo.type}`);

        // Add stream event listeners for debugging
        streamInfo.stream.on('error', (err) => {
            logger.error(`[${guildId}] Stream error:`, err);
        });
        streamInfo.stream.on('end', () => {
            logger.debug(`[${guildId}] Stream ended.`);
        });
        streamInfo.stream.on('readable', () => {
            logger.debug(`[${guildId}] Stream is readable. Data available: ${streamInfo.stream.readableLength} bytes`);
        });

        // Create audio resource
        const resource = createAudioResource(streamInfo.stream, {
            inputType: streamInfo.type,
            inlineVolume: true,
            metadata: queue.currentTrack,
        });

        if (!resource.playStream || resource.playStream.readableEnded || resource.playStream.errored) {
            logger.error(`[${guildId}] Invalid audio resource created.`);
            throw new Error('Invalid audio resource.');
        }
        logger.debug(`[${guildId}] Audio resource created successfully.`);

        resource.volume?.setVolume(queue.volume / 100 || 0.5);
        logger.debug(`[${guildId}] Volume set to ${queue.volume || 50}%`);

        // Ensure player is in Idle state
        if (queue.player.state.status !== AudioPlayerStatus.Idle) {
            logger.debug(`[${guildId}] Player not idle (${queue.player.state.status}). Stopping before play.`);
            queue.player.stop(true);
        }

        // Play resource
        queue.player.play(resource);
        logger.info(`[${guildId}] Play command issued for: "${queue.currentTrack.title}".`);

        // Monitor buffering
        const bufferingTimeout = setTimeout(() => {
            if (queue.player.state.status === AudioPlayerStatus.Buffering) {
                logger.warn(`[${guildId}] Player stuck buffering for track "${queue.currentTrack?.title}". Stopping player.`);
                queue.player.stop(true);
            } else if (queue.player.state.status !== AudioPlayerStatus.Playing) {
                logger.warn(`[${guildId}] Player in state ${queue.player.state.status} after 15s. Expected Playing.`);
            }
        }, 15000);

        const clearBufferingTimeout = (oldState, newState) => {
            if (newState.status === AudioPlayerStatus.Playing || newState.status === AudioPlayerStatus.Idle) {
                clearTimeout(bufferingTimeout);
                queue.player.off('stateChange', clearBufferingTimeout);
            }
        };
        queue.player.on('stateChange', clearBufferingTimeout);

    } catch (error) {
        logger.error(`[${guildId}] Error during playNextTrack for "${queue.currentTrack?.title || 'unknown'}":`, error);
        if (queue.textChannel) {
            let errorMessage = `Failed to play "${queue.currentTrack?.title || 'unknown track'}". Skipping.`;
            if (error.message.includes('403')) {
                errorMessage = `${errorMessage} YouTube access restricted (403). Try again later or check bot's network.`;
                logger.error(`[${guildId}] 403 Forbidden error. Possible YouTube rate limit or IP block.`);
            } else if (error.message.includes('Invalid URL')) {
                errorMessage = `${errorMessage} Provided URL is not a valid YouTube URL.`;
            } else {
                errorMessage = `${errorMessage} Reason: ${error.message}`;
            }
            await queue.textChannel.send({ content: errorMessage }).catch(() => {});
        }

        const failedTrack = queue.currentTrack;
        queue.currentTrack = null;
        if (queue.loop && failedTrack) queue.songs.push(failedTrack);

        if (queue.player.state.status !== AudioPlayerStatus.Idle) {
            queue.player.stop(true);
        } else {
            handleIdleState(queue, queues);
        }
    } finally {
        queue.processingNext = false;
    }
}

// --- Button Interaction Handler ---
async function handleMusicButtons(interaction, client, userProfile) {
    logger.warn("handleMusicButtons function needs implementation!");
    if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "Button controls not implemented yet.", flags: 64 });
    }
}

// --- Queue End Handler ---
function handleQueueEnd(queue, queues) {
    const guildId = queue.guildId;
    logger.info(`Queue ended for guild ${guildId}.`);
    queue.playing = false;
    queue.currentTrack = null;
    updateNowPlayingMessage(queue, true);
    if (!config.music.stayInChannel && !queue.leaveTimeout) {
        queue.leaveTimeout = setTimeout(() => {
            const q = queues.get(guildId);
            if (q && q.connection && !q.playing && q.player.state.status !== AudioPlayerStatus.Playing) {
                logger.info(`Leaving VC ${q.voiceChannel?.name || 'Unknown'} due to inactivity.`);
                if (q.connection.state.status !== VoiceConnectionStatus.Destroyed) q.connection.destroy();
                else queues.delete(guildId);
            } else if (q) {
                clearTimeout(q.leaveTimeout);
                q.leaveTimeout = null;
            }
        }, config.music.leaveTimeout * 1000);
        logger.debug(`Set leave timeout (${config.music.leaveTimeout}s) for guild ${guildId}`);
    }
}

module.exports = {
    createGuildQueue,
    addToQueue,
    startPlayback,
    updateNowPlayingMessage,
    playNextTrack,
    handleMusicButtons,
    handleQueueEnd,
};