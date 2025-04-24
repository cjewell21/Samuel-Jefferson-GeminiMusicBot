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
    demuxProbe, // Import demuxProbe for better resource creation
} = require('@discordjs/voice');
const play = require('play-dl');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const logger = require('../utils/logger');
const config = require('../config'); // Ensure config is imported correctly
const User = require('../database/models/User');
const { getUserSpotifyApi } = require('./spotifyAuth');
const SpotifyWebApi = require('spotify-web-api-node');

// --- Queue Management ---

function createGuildQueue(interaction, voiceChannel) {
    const guildId = interaction.guild.id;
    logger.info(`Creating new queue for guild ${guildId}`);
    const player = createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    player.on('stateChange', (oldState, newState) => {
        // Reduced logging for brevity, focus on Idle/Error
        if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) {
             const queue = interaction.client.queues.get(guildId);
             if (queue) handleIdleState(queue, interaction.client.queues);
             else logger.warn(`Queue not found for guild ${guildId} during player Idle state change.`);
        } else if (newState.status === AudioPlayerStatus.Playing) {
            const queue = interaction.client.queues.get(guildId);
             if (queue) {
                queue.playing = true;
                if (queue.leaveTimeout) { clearTimeout(queue.leaveTimeout); queue.leaveTimeout = null; }
                updateNowPlayingMessage(queue); // Update message when playback starts
             }
        }
    });

    player.on('error', error => {
        logger.error(`Audio Player Error (Guild: ${guildId}): ${error.message}`, error);
        const queue = interaction.client.queues.get(guildId);
        if (queue) {
            queue.playing = false; queue.currentTrack = null;
            if (queue.songs.length > 0) playNextTrack(guildId, interaction.client.queues);
            else handleQueueEnd(queue, interaction.client.queues);
        }
    });

    const queueConstruct = {
        textChannel: interaction.channel, voiceChannel: voiceChannel, connection: null,
        player: player, songs: [], volume: config.music.defaultVolume, playing: false,
        loop: false, // Using boolean based on uploaded code
        currentTrack: null,
        nowPlayingMessage: null, // Renamed from message for clarity
        leaveTimeout: null, guildId: guildId,
    };
    return queueConstruct;
}

function handleIdleState(queue, queues) {
    const guildId = queue.guildId;
    const oldTrack = queue.currentTrack;
    queue.currentTrack = null; queue.playing = false;

    // Handle loop based on boolean value from uploaded code
    if (queue.loop && oldTrack) {
        logger.info(`Looping track: ${oldTrack.title} in guild ${guildId}`);
        queue.songs.push(oldTrack); // Add to end for basic loop
    }

    setTimeout(() => {
        const currentQueue = queues.get(guildId);
        // Check if player is still idle before proceeding
        if (currentQueue && currentQueue.player.state.status === AudioPlayerStatus.Idle) {
             if (currentQueue.songs.length > 0) {
                 playNextTrack(guildId, queues);
             } else {
                 handleQueueEnd(currentQueue, queues);
             }
        } else if (currentQueue) {
             logger.debug(`[${guildId}] Player no longer idle (${currentQueue.player.state.status}) when idle timeout fired. Ignoring.`);
        }
    }, 100); // Small delay
}

async function addToQueue(interaction, queues, songData) {
    const guildId = interaction.guild.id;
    const queue = queues.get(guildId);
    if (!queue) { logger.error(`[${guildId}] Cannot add to queue: No queue found.`); return { addedCount: 0 }; }

    // Use spotifyUrl if available for duplicate check, otherwise fallback to url
    const duplicate = queue.songs.some(s =>
        (s.spotifyUrl && songData.spotifyUrl && s.spotifyUrl === songData.spotifyUrl) ||
        (!s.spotifyUrl && !songData.spotifyUrl && s.url === songData.url)
    );
    if (duplicate) { logger.debug(`[${guildId}] Song "${songData.title}" is a duplicate. Skipping.`); return { addedCount: 0 }; }

    if (queue.songs.length >= (config.music.maxQueueSize || 100)) { logger.warn(`[${guildId}] Queue is full. Cannot add "${songData.title}".`); return { addedCount: 0 }; }

    queue.songs.push(songData);
    logger.debug(`[${guildId}] Added "${songData.title}" to queue. Queue length: ${queue.songs.length}`);
    return { addedCount: 1 };
}


// --- Playback Logic ---

async function startPlayback(interaction, queues, queue) {
     const guildId = queue.guildId;
    if (!queue.songs.length) { logger.info(`[${guildId}] Cannot start playback: Queue is empty.`); return; }
    if (!queue.voiceChannel) { logger.error(`[${guildId}] Cannot start playback: No voice channel specified.`); return; }

    logger.info(`[${guildId}] startPlayback initiated for channel: ${queue.voiceChannel.name}`);
    if (queue.leaveTimeout) clearTimeout(queue.leaveTimeout);

    let connection = getVoiceConnection(guildId);
    let connectionCreated = false; // Flag to track if we created the connection in this call

    try {
        // --- Establish or Verify Connection ---
        if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed || connection.state.status === VoiceConnectionStatus.Disconnected) {
            logger.info(`[${guildId}] Creating new voice connection...`);
            connection = joinVoiceChannel({
                channelId: queue.voiceChannel.id,
                guildId: guildId,
                adapterCreator: interaction.guild.voiceAdapterCreator,
                selfDeaf: true,
            });
            connectionCreated = true; // Mark that we created it
            queue.connection = connection; // Assign to queue immediately

            // Setup listeners ONCE per new connection
            connection.once(VoiceConnectionStatus.Destroyed, () => { // Use 'once' if cleanup should happen only once
                logger.info(`[${guildId}] Voice connection destroyed. Clearing queue.`);
                const currentQueue = queues.get(guildId);
                if (currentQueue) {
                    currentQueue.player?.stop(true); // Force stop player
                    currentQueue.playing = false;
                    currentQueue.connection = null;
                    queues.delete(guildId);
                    updateNowPlayingMessage(currentQueue, true).catch(()=>{});
                }
            });
            connection.on('error', (error) => { // Listen for connection errors
                 logger.error(`[${guildId}] Voice Connection Error:`, error);
                 // Attempt to destroy on error? Might trigger Destroyed listener.
                 if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
                     connection.destroy();
                 }
            });
             connection.on('stateChange', (oldState, newState) => {
                 logger.debug(`[${guildId}] VoiceConnection State Change: ${oldState.status} -> ${newState.status}`);
                 if (newState.status === VoiceConnectionStatus.Disconnected) {
                     // Use entersState with destroy signal for robust disconnect handling
                     entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
                         .then(() => {/* Recovering */})
                         .catch(() => {
                             if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
                                 logger.warn(`[${guildId}] Connection disconnected permanently. Destroying.`);
                                 connection.destroy();
                             }
                         });
                 }
            });

        } else {
            logger.info(`[${guildId}] Reusing existing voice connection (State: ${connection.state.status}).`);
            queue.connection = connection; // Ensure queue has the reference
        }

        // --- Wait for Connection Ready State ---
        if (connection.state.status !== VoiceConnectionStatus.Ready) {
             logger.debug(`[${guildId}] Waiting for connection to become Ready...`);
             try {
                 await entersState(connection, VoiceConnectionStatus.Ready, 20_000); // 20s timeout
                 logger.info(`[${guildId}] Connection Ready.`);
             } catch (error) {
                  logger.error(`[${guildId}] Connection failed to reach Ready state:`, error);
                  if (connectionCreated && connection.state.status !== VoiceConnectionStatus.Destroyed) {
                      connection.destroy(); // Clean up connection if we created it and it failed
                  }
                  queues.delete(guildId); // Remove queue if connection failed
                  throw new Error("Connection timed out or failed."); // Propagate error
             }
        }

        // --- Subscribe Player ---
        logger.debug(`[${guildId}] Subscribing player to connection...`);
        connection.subscribe(queue.player);
        logger.debug(`[${guildId}] Player subscribed.`);

        // --- Start Playback ---
        // Check if songs exist *after* connection is ready
        if (queue.songs.length > 0) {
            logger.info(`[${guildId}] Connection ready and songs available. Calling playNextTrack.`);
            // Ensure queue.playing is false before calling playNextTrack if player was idle
            if(queue.player.state.status === AudioPlayerStatus.Idle) {
                queue.playing = false;
            }
            await playNextTrack(guildId, queues);
        } else {
            logger.info(`[${guildId}] Connection ready but queue is empty. Playback not started.`);
            queue.playing = false; // Ensure playing is false
        }

    } catch (error) {
        logger.error(`[${guildId}] Error in startPlayback function:`, error);
        // Ensure connection is destroyed if created during this failed attempt
        if (connectionCreated && connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
             connection.destroy();
        }
        // Clean up queue state
        queue.playing = false;
        queue.connection = null;
        queues.delete(guildId);
        // Use interaction.followUp as reply might have been deferred
        await interaction.followUp({ content: `Error starting playback: ${error.message}`, ephemeral: true }).catch(e => {});
    }
}

async function updateNowPlayingMessage(queue, isFinished = false) {
    // ... (updateNowPlayingMessage logic remains the same - check color value) ...
     if (!queue || !queue.textChannel || !queue.textChannel.send) {
        logger.warn(`Cannot update Now Playing message: Invalid queue or textChannel for guild ${queue?.guildId}`);
        return;
    }
    if (queue.songs.length === 0 && !queue.currentTrack) isFinished = true;
    if (isFinished) { if (queue.nowPlayingMessage) { await queue.nowPlayingMessage.delete().catch(e => {}); queue.nowPlayingMessage = null; } return; }
    const currentTrack = queue.currentTrack;
    if (!currentTrack) { if (queue.nowPlayingMessage) { await queue.nowPlayingMessage.delete().catch(e => {}); queue.nowPlayingMessage = null; } return; }
    const musicColor = config?.colors?.music;
    const colorToSet = musicColor || 0xCCCCCC;
    logger.debug(`[${queue.guildId}] Setting embed color to: ${colorToSet} (Type: ${typeof colorToSet})`);
    const embed = new EmbedBuilder().setColor(colorToSet).setTitle('Now Playing').setDescription(`[${currentTrack.title}](${currentTrack.spotifyUrl || currentTrack.url})`).addFields({ name: 'Duration', value: String(currentTrack.duration || 'N/A'), inline: true },{ name: 'Requested By', value: String(currentTrack.requestedBy || 'Unknown'), inline: true }).setThumbnail(currentTrack.thumbnail).setTimestamp();
    try {
        if (queue.nowPlayingMessage && queue.nowPlayingMessage.editable) { await queue.nowPlayingMessage.edit({ embeds: [embed] }); }
        else { if (queue.nowPlayingMessage) { await queue.nowPlayingMessage.delete().catch(() => {}); queue.nowPlayingMessage = null; } const sentMessage = await queue.textChannel.send({ embeds: [embed] }); queue.nowPlayingMessage = await queue.textChannel.messages.fetch(sentMessage.id).catch(() => null); }
    } catch (error) { logger.error(`[${queue.guildId}] Error updating now playing message:`, error); if (error.code === 10008 || error.code === 10003) { queue.nowPlayingMessage = null; } }
}


async function playNextTrack(guildId, queues) {
    const queue = queues.get(guildId);
    // --- FIX: Check connection status *before* proceeding ---
    if (!queue) { logger.info(`[${guildId}] No queue found for playNextTrack.`); return; }
    if (!queue.connection || queue.connection.state.status === VoiceConnectionStatus.Destroyed || queue.connection.state.status === VoiceConnectionStatus.Disconnected) {
         logger.warn(`[${guildId}] playNextTrack called but connection is invalid (State: ${queue.connection?.state?.status}). Aborting playback.`);
         // Clean up queue if connection is invalid
         queues.delete(guildId);
         await updateNowPlayingMessage(queue, true); // Update message to reflect end
         return;
    }
    // --- End Fix ---

    if (queue.songs.length === 0 && !queue.currentTrack) { // Check if truly empty
        logger.info(`[${guildId}] Queue is empty. Stopping playback.`);
        queue.playing = false;
        queue.currentTrack = null;
        await updateNowPlayingMessage(queue, true);
        handleQueueEnd(queue, queues);
        return;
    }

    if (queue.processingNext) return logger.debug(`[${guildId}] Already processing next track. Skipping.`);
    queue.processingNext = true;

    // If currentTrack is null (meaning Idle state called this), get next song
    if (!queue.currentTrack) {
        if (queue.songs.length === 0) { // Double check queue empty
             logger.info(`[${guildId}] Queue became empty before processing next track.`);
             queue.processingNext = false;
             handleQueueEnd(queue, queues);
             return;
        }
        queue.currentTrack = queue.songs.shift();
    }
    // If currentTrack is already set (e.g., startPlayback called this), proceed with it

    logger.info(`[${guildId}] Attempting to play track: "${queue.currentTrack.title}" (URL: ${queue.currentTrack.url})`);
    await updateNowPlayingMessage(queue); // Update message *before* fetching stream

    try {
        logger.debug(`[${guildId}] Fetching stream using play.stream for: ${queue.currentTrack.url}`);
        const streamInfo = await play.stream(queue.currentTrack.url, { /* options */ });

        if (!streamInfo || !streamInfo.stream || !streamInfo.type || streamInfo.stream.readableEnded || streamInfo.stream.errored) {
             logger.error(`[${guildId}] Failed to obtain a valid stream from play-dl. StreamInfo:`, streamInfo);
             throw new Error('Failed to obtain a valid stream from play-dl.');
        }
        logger.debug(`[${guildId}] Stream obtained successfully. Type: ${streamInfo.type}`);

        const resource = createAudioResource(streamInfo.stream, {
            inputType: streamInfo.type, inlineVolume: true, metadata: queue.currentTrack,
        });
        resource.volume?.setVolume(queue.volume / 100 || 0.5);
        logger.debug(`[${guildId}] Volume set to ${queue.volume || 50}%`);

        queue.player.play(resource);
        logger.info(`[${guildId}] Play command issued for: "${queue.currentTrack.title}". Waiting for 'Playing' state...`);

        // Handle looping
        // Moved loop logic to handleIdleState for consistency

    } catch (error) {
        logger.error(`[${guildId}] Error during playNextTrack for "${queue.currentTrack?.title || 'unknown'}":`, error);
        if (queue.textChannel) {
            await queue.textChannel.send({ content: `Failed to play "${queue.currentTrack?.title || 'unknown track'}". Skipping. Reason: ${error.message}` }).catch(()=>{});
        }
        const failedTrack = queue.currentTrack; // Store failed track for potential loop check
        queue.currentTrack = null; // Clear failed track immediately

        // If looping was enabled for the failed track, add it back (check boolean loop)
        if (queue.loop && failedTrack) {
             queue.songs.push(failedTrack);
             logger.debug(`[${guildId}] Added failed track back to queue due to loop.`);
        }

        // Stop player to trigger Idle state for next song attempt
        if (queue.player.state.status !== AudioPlayerStatus.Idle) {
             queue.player.stop(true);
        } else {
             handleIdleState(queue, queues); // Manually trigger if already idle
        }
    } finally {
         queue.processingNext = false; // Release processing flag
    }
}

// --- Button Interaction Handler ---
async function handleMusicButtons(interaction, client, userProfile) {
     // Placeholder - Requires implementation
     logger.warn("handleMusicButtons function needs implementation!");
     if (!interaction.replied && !interaction.deferred) {
         await interaction.reply({ content: "Button controls not implemented yet.", ephemeral: true });
     }
}

// --- Queue End Handler ---
function handleQueueEnd(queue, queues) {
    // ... (handleQueueEnd logic remains the same) ...
    const guildId = queue.guildId;
    logger.info(`Queue ended for guild ${guildId}.`);
    queue.playing = false; queue.currentTrack = null;
    updateNowPlayingMessage(queue, true); // Pass true to indicate finished
    if (!config.music.stayInChannel && !queue.leaveTimeout) {
         queue.leaveTimeout = setTimeout(() => {
             const currentQueue = queues.get(guildId);
             if (currentQueue && currentQueue.connection && !currentQueue.playing && currentQueue.player.state.status !== AudioPlayerStatus.Playing) {
                 logger.info(`Leaving VC ${currentQueue.voiceChannel?.name || 'Unknown'} due to inactivity.`);
                 if (currentQueue.connection.state.status !== VoiceConnectionStatus.Destroyed) currentQueue.connection.destroy();
                 else queues.delete(guildId);
             } else if (currentQueue) { clearTimeout(currentQueue.leaveTimeout); currentQueue.leaveTimeout = null; }
         }, config.music.leaveTimeout * 1000);
         logger.debug(`Set leave timeout (${config.music.leaveTimeout}s) for guild ${guildId}`);
    }
}


module.exports = {
    createGuildQueue, addToQueue, startPlayback, updateNowPlayingMessage,
    playNextTrack, handleMusicButtons, handleQueueEnd,
};
