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
const play = require('play-dl'); // Use play-dl as primary
// const ytdl = require('@distube/ytdl-core'); // REMOVED explicit ytdl import
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const logger = require('../utils/logger');
const config = require('../config');
const User = require('../database/models/User');
const { getUserSpotifyApi } = require('./spotifyAuth');
const SpotifyWebApi = require('spotify-web-api-node');

// --- Queue Management (createGuildQueue, handleIdleState, addToQueue remain mostly the same) ---
function createGuildQueue(interaction, voiceChannel) {
    const guildId = interaction.guild.id;
    logger.info(`Creating new queue for guild ${guildId}`);
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });

    player.on('stateChange', (oldState, newState) => {
        if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) {
             const queue = interaction.client.queues.get(guildId);
             if (queue) handleIdleState(queue, interaction.client.queues);
        } else if (newState.status === AudioPlayerStatus.Playing) {
            const queue = interaction.client.queues.get(guildId);
             if (queue) {
                queue.playing = true;
                if (queue.leaveTimeout) { clearTimeout(queue.leaveTimeout); queue.leaveTimeout = null; }
                updateNowPlayingMessage(queue);
             }
        }
    });
    player.on('error', error => { /* ... error handling ... */
        logger.error(`Audio Player Error (Guild: ${guildId}): ${error.message}`, error);
        const queue = interaction.client.queues.get(guildId);
        if (queue) { queue.playing = false; queue.currentTrack = null; if (queue.songs.length > 0) playNextTrack(guildId, interaction.client.queues); else handleQueueEnd(queue, interaction.client.queues); }
    });
    const queueConstruct = { textChannel: interaction.channel, voiceChannel: voiceChannel, connection: null, player: player, songs: [], volume: config.music.defaultVolume, playing: false, loop: false, currentTrack: null, nowPlayingMessage: null, leaveTimeout: null, guildId: guildId };
    return queueConstruct;
}
function handleIdleState(queue, queues) { /* ... idle logic ... */
    const guildId = queue.guildId; const oldTrack = queue.currentTrack; queue.currentTrack = null; queue.playing = false;
    if (queue.loop && oldTrack) { logger.info(`Looping track: ${oldTrack.title}`); queue.songs.push(oldTrack); }
    setTimeout(() => { const currentQueue = queues.get(guildId); if (currentQueue && currentQueue.player.state.status === AudioPlayerStatus.Idle) { if (currentQueue.songs.length > 0) playNextTrack(guildId, queues); else handleQueueEnd(currentQueue, queues); } }, 100);
}
async function addToQueue(interaction, queues, songData) { /* ... add logic ... */
    const guildId = interaction.guild.id; const queue = queues.get(guildId); if (!queue) { logger.error(`[${guildId}] Cannot add: No queue.`); return { addedCount: 0 }; }
    const duplicate = queue.songs.some(s => (s.spotifyUrl && songData.spotifyUrl && s.spotifyUrl === songData.spotifyUrl) || (!s.spotifyUrl && !songData.spotifyUrl && s.url === songData.url));
    if (duplicate) { logger.debug(`[${guildId}] Duplicate: "${songData.title}".`); return { addedCount: 0 }; }
    if (queue.songs.length >= (config.music.maxQueueSize || 100)) { logger.warn(`[${guildId}] Queue full.`); return { addedCount: 0 }; }
    queue.songs.push(songData); logger.debug(`[${guildId}] Added "${songData.title}". Queue: ${queue.songs.length}`); return { addedCount: 1 };
}

// --- Playback Logic ---
async function startPlayback(interaction, queues, queue) { /* ... connection logic ... */
    const guildId = queue.guildId; if (!queue.songs.length) return; if (!queue.voiceChannel) return;
    logger.info(`[${guildId}] startPlayback for channel: ${queue.voiceChannel.name}`); if (queue.leaveTimeout) clearTimeout(queue.leaveTimeout);
    let connection = getVoiceConnection(guildId); let connectionCreated = false;
    try {
        if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed || connection.state.status === VoiceConnectionStatus.Disconnected) {
            logger.info(`[${guildId}] Creating new voice connection...`); connection = joinVoiceChannel({ channelId: queue.voiceChannel.id, guildId: guildId, adapterCreator: interaction.guild.voiceAdapterCreator, selfDeaf: true }); connectionCreated = true; queue.connection = connection;
            connection.once(VoiceConnectionStatus.Destroyed, () => { logger.info(`[${guildId}] VC Destroyed.`); const q = queues.get(guildId); if (q) { q.player?.stop(true); q.playing = false; q.connection = null; queues.delete(guildId); updateNowPlayingMessage(q, true).catch(()=>{}); } });
            connection.on('error', (error) => { logger.error(`[${guildId}] VC Error:`, error); if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy(); });
            connection.on('stateChange', (o, n) => { logger.debug(`[${guildId}] VC State: ${o.status} -> ${n.status}`); if (n.status === VoiceConnectionStatus.Disconnected) { entersState(connection, VoiceConnectionStatus.Connecting, 5_000).catch(() => { if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy(); }); } });
        } else { logger.info(`[${guildId}] Reusing existing VC (State: ${connection.state.status}).`); queue.connection = connection; }
        if (connection.state.status !== VoiceConnectionStatus.Ready) { logger.debug(`[${guildId}] Waiting for VC Ready...`); await entersState(connection, VoiceConnectionStatus.Ready, 20_000); logger.info(`[${guildId}] VC Ready.`); }
        logger.debug(`[${guildId}] Subscribing player...`); connection.subscribe(queue.player); logger.debug(`[${guildId}] Player subscribed.`);
        if (queue.songs.length > 0) { logger.info(`[${guildId}] Calling playNextTrack.`); if(queue.player.state.status === AudioPlayerStatus.Idle) queue.playing = false; await playNextTrack(guildId, queues); }
        else { logger.info(`[${guildId}] VC ready but queue empty.`); queue.playing = false; }
    } catch (error) { logger.error(`[${guildId}] Error in startPlayback:`, error); if (connectionCreated && connection?.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy(); queue.playing = false; queue.connection = null; queues.delete(guildId); await interaction.followUp({ content: `Error starting playback: ${error.message}`, flags: 64 }).catch(e => {}); }
}

async function updateNowPlayingMessage(queue, isFinished = false) { /* ... update message logic ... */
    if (!queue || !queue.textChannel?.send) return; if (queue.songs.length === 0 && !queue.currentTrack) isFinished = true;
    if (isFinished) { if (queue.nowPlayingMessage) { await queue.nowPlayingMessage.delete().catch(()=>{}); queue.nowPlayingMessage = null; } return; }
    const currentTrack = queue.currentTrack; if (!currentTrack) { if (queue.nowPlayingMessage) { await queue.nowPlayingMessage.delete().catch(()=>{}); queue.nowPlayingMessage = null; } return; }
    const musicColor = config?.colors?.music; const colorToSet = musicColor || 0xCCCCCC;
    const embed = new EmbedBuilder().setColor(colorToSet).setTitle('Now Playing').setDescription(`[${currentTrack.title}](${currentTrack.spotifyUrl || currentTrack.url})`).addFields({ name: 'Duration', value: String(currentTrack.duration || 'N/A'), inline: true },{ name: 'Requested By', value: String(currentTrack.requestedBy || 'Unknown'), inline: true }).setThumbnail(currentTrack.thumbnail).setTimestamp();
    try { if (queue.nowPlayingMessage?.editable) { await queue.nowPlayingMessage.edit({ embeds: [embed] }); } else { if (queue.nowPlayingMessage) { await queue.nowPlayingMessage.delete().catch(()=>{}); queue.nowPlayingMessage = null; } const sent = await queue.textChannel.send({ embeds: [embed] }); queue.nowPlayingMessage = await queue.textChannel.messages.fetch(sent.id).catch(()=>null); } } catch (error) { logger.error(`[${queue.guildId}] Error updating NP msg:`, error); if (error.code === 10008 || error.code === 10003) queue.nowPlayingMessage = null; }
}

async function playNextTrack(guildId, queues) {
    const queue = queues.get(guildId);
    if (!queue) { logger.info(`[${guildId}] No queue for playNextTrack.`); return; }
    if (!queue.connection || queue.connection.state.status === VoiceConnectionStatus.Destroyed || queue.connection.state.status === VoiceConnectionStatus.Disconnected) { logger.warn(`[${guildId}] Invalid VC for playNextTrack (State: ${queue.connection?.state?.status}). Aborting.`); queues.delete(guildId); await updateNowPlayingMessage(queue, true); return; }
    if (queue.songs.length === 0 && !queue.currentTrack) { logger.info(`[${guildId}] Queue empty. Stopping.`); queue.playing = false; queue.currentTrack = null; await updateNowPlayingMessage(queue, true); handleQueueEnd(queue, queues); return; }
    if (queue.processingNext) return logger.debug(`[${guildId}] Already processing next track.`);
    queue.processingNext = true;
    if (!queue.currentTrack) { if (queue.songs.length === 0) { queue.processingNext = false; handleQueueEnd(queue, queues); return; } queue.currentTrack = queue.songs.shift(); }
    logger.info(`[${guildId}] Attempting to play: "${queue.currentTrack.title}" (URL: ${queue.currentTrack.url})`);
    await updateNowPlayingMessage(queue);

    let resource = null;
    let sourceUsed = 'play-dl'; // Assume play-dl by default

    try {
        // --- Attempt play.stream() ---
        logger.debug(`[${guildId}] Attempting stream fetch with play.stream()...`);
        const streamOpts = { discordPlayerCompatibility: true };
        const streamInfo = await play.stream(queue.currentTrack.url, streamOpts);

        if (!streamInfo || !streamInfo.stream || !streamInfo.type) {
            // Log the URL that failed
            logger.error(`[${guildId}] play.stream() failed to return valid stream info for URL: ${queue.currentTrack.url}`);
            throw new Error('play.stream() returned invalid stream info.');
        }
        logger.debug(`[${guildId}] Stream obtained via play-dl. Type: ${streamInfo.type}`);
        resource = createAudioResource(streamInfo.stream, { inputType: streamInfo.type, inlineVolume: true, metadata: queue.currentTrack });

        // If resource creation failed (should be caught by the above check, but safety)
        if (!resource) {
            throw new Error('Failed to create audio resource from play-dl stream.');
        }

        logger.debug(`[${guildId}] Audio resource created using ${sourceUsed}.`);
        resource.volume?.setVolume(queue.volume / 100 || 0.5);
        logger.debug(`[${guildId}] Volume set to ${queue.volume || 50}%`);

        queue.player.play(resource);
        logger.info(`[${guildId}] Play command issued for: "${queue.currentTrack.title}" using ${sourceUsed}.`);

        // Monitor buffering
        const bufferingTimeout = setTimeout(() => {
            if (queue.player.state.status === AudioPlayerStatus.Buffering) {
                logger.warn(`[${guildId}] Player stuck buffering for track "${queue.currentTrack?.title}". Stopping player.`);
                queue.player.stop(true);
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
        logger.error(`[${guildId}] Error during playNextTrack for "${queue.currentTrack?.title || 'unknown'}" (URL: ${queue.currentTrack?.url}):`, error);
        let userMsg = `Failed to play "${queue.currentTrack?.title || 'unknown track'}". Skipping.`;
        // Check for specific error types or messages
        if (error.message.includes('403') || error.message.includes('Forbidden')) {
             logger.error(`[${guildId}] Received 403 Forbidden error. YouTube likely blocking. Update play-dl or check IP.`);
             userMsg = `Failed to play "${queue.currentTrack?.title || 'unknown track'}" due to access restrictions (403). Skipping. This is often due to YouTube blocking automated requests.`;
        } else if (error.message.includes('Sign in to confirm your age') || error.message.includes('age-restricted')) {
             logger.warn(`[${guildId}] Encountered age-restricted content for "${queue.currentTrack?.title}". Skipping.`);
             userMsg = `Failed to play "${queue.currentTrack?.title || 'unknown track'}". Content is age-restricted. Skipping.`;
        } else if (error.message.includes('private video') || error.message.includes('Private video')) {
             logger.warn(`[${guildId}] Encountered private video for "${queue.currentTrack?.title}". Skipping.`);
             userMsg = `Failed to play "${queue.currentTrack?.title || 'unknown track'}". Content is private. Skipping.`;
        } else if (error.message.includes('Invalid stream') || error.message.includes('stream info')) {
             logger.error(`[${guildId}] Could not get stream info. URL might be invalid or inaccessible.`);
             userMsg = `Failed to play "${queue.currentTrack?.title || 'unknown track'}". Could not retrieve stream data. Skipping.`;
        } else {
             userMsg += ` Reason: ${error.message}`;
        }
        if (queue.textChannel) await queue.textChannel.send({ content: userMsg }).catch(()=>{});

        const failedTrack = queue.currentTrack;
        queue.currentTrack = null;
        if (queue.loop && failedTrack) queue.songs.push(failedTrack);
        // Trigger Idle state to move to the next song
        if (queue.player.state.status !== AudioPlayerStatus.Idle) {
             queue.player.stop(true);
        } else {
             // If already idle, manually call handler after a delay
             setTimeout(() => handleIdleState(queue, queues), 50);
        }
    } finally {
         queue.processingNext = false;
    }
}

// --- Button Interaction Handler ---
async function handleMusicButtons(interaction, client, userProfile) { /* ... */ }

// --- Queue End Handler ---
function handleQueueEnd(queue, queues) { /* ... */
    const guildId = queue.guildId; logger.info(`Queue ended for guild ${guildId}.`); queue.playing = false; queue.currentTrack = null; updateNowPlayingMessage(queue, true);
    if (!config.music.stayInChannel && !queue.leaveTimeout) { queue.leaveTimeout = setTimeout(() => { const q = queues.get(guildId); if (q && q.connection && !q.playing && q.player.state.status !== AudioPlayerStatus.Playing) { logger.info(`Leaving VC ${q.voiceChannel?.name || 'Unknown'} due to inactivity.`); if (q.connection.state.status !== VoiceConnectionStatus.Destroyed) q.connection.destroy(); else queues.delete(guildId); } else if (q) { clearTimeout(q.leaveTimeout); q.leaveTimeout = null; } }, config.music.leaveTimeout * 1000); logger.debug(`Set leave timeout (${config.music.leaveTimeout}s) for guild ${guildId}`); }
}

module.exports = {
    createGuildQueue, addToQueue, startPlayback, updateNowPlayingMessage,
    playNextTrack, handleMusicButtons, handleQueueEnd,
};
