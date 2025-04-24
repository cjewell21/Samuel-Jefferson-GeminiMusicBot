// spotify/spotifyAuth.js
const SpotifyWebApi = require('spotify-web-api-node');
const logger = require('../utils/logger');
const config = require('../config');
const User = require('../database/models/User');

// Ensure required environment variables are set
const spotifyClientId = process.env.SPOTIFY_CLIENT_ID;
const spotifyClientSecret = process.env.SPOTIFY_CLIENT_SECRET;
const spotifyRedirectUri = process.env.SPOTIFY_REDIRECT_URI; // Needed for User Auth Flow

// Validate credentials at startup
if (!spotifyClientId || !spotifyClientSecret) {
    logger.error('Spotify API credentials (SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET) are missing or invalid in .env. Spotify features requiring API access (like search) will fail.');
    throw new Error('Spotify API credentials are not configured. Please set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env.');
}
if (!spotifyRedirectUri) {
    logger.warn('Spotify Redirect URI (SPOTIFY_REDIRECT_URI) not configured in .env. Spotify User Auth features will be disabled.');
}

// Base Spotify API client instance (used for both flows initially)
const spotifyApi = new SpotifyWebApi({
    clientId: spotifyClientId,
    clientSecret: spotifyClientSecret,
    redirectUri: spotifyRedirectUri,
});

// --- Client Credentials Flow (for Bot's own API access like search) ---
let clientCredentialsToken = null;
let clientCredentialsExpiryTime = 0;

/**
 * Gets a valid API access token for the bot itself using Client Credentials Flow.
 * Handles caching and refreshing.
 * @returns {Promise<string|null>} The access token or null on failure.
 */
async function getClientCredentialsToken() {
    const now = Date.now();
    // Refresh if token is missing or expired (60-second buffer)
    if (!clientCredentialsToken || now >= clientCredentialsExpiryTime - 60000) {
        logger.info('Spotify client credentials token expired or missing. Refreshing...');
        try {
            if (!spotifyClientId || !spotifyClientSecret) {
                logger.error('Spotify Client ID or Secret not configured for Client Credentials Grant.');
                throw new Error('Spotify Client ID or Secret not configured.');
            }
            const data = await spotifyApi.clientCredentialsGrant();
            clientCredentialsToken = data.body['access_token'];
            clientCredentialsExpiryTime = now + (data.body['expires_in'] * 1000);
            logger.info(`Successfully refreshed Spotify client credentials token. Expires in: ${data.body['expires_in']}s`);
            return clientCredentialsToken;
        } catch (error) {
            logger.error('Error refreshing Spotify client credentials token:', error.response ? error.response.data : error.message);
            clientCredentialsToken = null;
            clientCredentialsExpiryTime = 0;
            return null;
        }
    }
    logger.debug('Using cached Spotify client credentials token.');
    return clientCredentialsToken;
}

/**
 * Gets a SpotifyWebApi instance authenticated with the bot's client credentials.
 * @returns {Promise<SpotifyWebApi|null>} An authenticated SpotifyWebApi instance or null on failure.
 */
async function getClientCredentialsSpotifyApi() {
    const token = await getClientCredentialsToken();
    if (!token) {
        logger.error('Failed to obtain Spotify client credentials token.');
        return null;
    }
    // Create a new instance to avoid conflicts with user tokens
    const clientCredApi = new SpotifyWebApi({
        clientId: spotifyClientId,
        clientSecret: spotifyClientSecret,
        accessToken: token,
    });
    return clientCredApi;
}

// --- Authorization Code Flow (for User-Specific Data) ---
const getAuthorizationUrl = (discordId, randomString) => {
    if (!spotifyClientId || !spotifyRedirectUri) {
        logger.error('Spotify credentials or Redirect URI not configured for Authorization URL.');
        throw new Error('Spotify credentials or Redirect URI not configured.');
    }
    const state = `${discordId}:${randomString}`;
    const scopes = config.spotify.scopes || ['user-read-private', 'user-read-email', 'user-read-playback-state', 'user-read-currently-playing'];
    logger.info(`Generating Spotify auth URL for Discord ID ${discordId} with state: ${state}`);
    return spotifyApi.createAuthorizeURL(scopes, state);
};

const exchangeCodeForTokens = async (code) => {
    logger.info('Attempting to exchange Spotify authorization code for tokens...');
    try {
        spotifyApi.resetAccessToken();
        spotifyApi.resetRefreshToken();
        const data = await spotifyApi.authorizationCodeGrant(code);
        logger.info('Successfully exchanged code for tokens.');
        return data.body;
    } catch (error) {
        logger.error('Error exchanging Spotify authorization code:', error.response ? error.response.data : error.message);
        return null;
    }
};

const refreshAccessToken = async (user) => {
    if (!user || !user.spotify || !user.spotify.refreshToken) {
        logger.warn(`Cannot refresh Spotify token: No refresh token found for user ${user?.discordTag || user?.discordId || 'Unknown'}.`);
        return null;
    }
    logger.info(`Attempting to refresh Spotify access token for user ${user.discordTag} (${user.discordId})...`);
    try {
        spotifyApi.setRefreshToken(user.spotify.refreshToken);
        const data = await spotifyApi.refreshAccessToken();
        spotifyApi.resetRefreshToken();

        const newAccessToken = data.body['access_token'];
        const newExpiresIn = data.body['expires_in'];
        logger.info(`Successfully refreshed Spotify token for user ${user.discordTag}. New token expires in ${newExpiresIn} seconds.`);

        user.spotify.accessToken = newAccessToken;
        user.spotify.tokenExpiry = new Date(Date.now() + newExpiresIn * 1000);
        await user.save();
        return newAccessToken;
    } catch (error) {
        logger.error(`Error refreshing Spotify access token for user ${user.discordTag} (${user.discordId}):`, error.response ? error.response.data : error.message);
        spotifyApi.resetRefreshToken();
        if (error.statusCode === 400 && error.body?.error === 'invalid_grant') {
            logger.error(`Invalid refresh token for user ${user.discordTag}. Clearing Spotify data.`);
            user.spotify = undefined;
            await user.save();
        }
        return null;
    }
};

const getUserSpotifyApi = async (discordId) => {
    const user = await User.findOne({ discordId: discordId });
    if (!user || !user.spotify || !user.spotify.accessToken || !user.spotify.refreshToken) {
        logger.debug(`No valid Spotify credentials found for user ${discordId}.`);
        return null;
    }
    let currentToken = user.spotify.accessToken;
    if (user.isSpotifyTokenExpired()) {
        logger.info(`Spotify token expired or nearing expiry for user ${user.discordTag}. Refreshing...`);
        const newAccessToken = await refreshAccessToken(user);
        if (!newAccessToken) {
            logger.error(`Failed to refresh Spotify token for user ${user.discordTag}.`);
            return null;
        }
        currentToken = newAccessToken;
    }
    const userSpotifyApi = new SpotifyWebApi({
        clientId: spotifyClientId,
        accessToken: currentToken,
    });
    return userSpotifyApi;
};

module.exports = {
    getClientCredentialsToken,
    getClientCredentialsSpotifyApi,
    getAuthorizationUrl,
    exchangeCodeForTokens,
    refreshAccessToken,
    getUserSpotifyApi,
};