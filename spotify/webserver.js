// spotify/webserver.js
const express = require('express');
const cookieParser = require('cookie-parser');
const querystring = require('querystring');
const logger = require('../utils/logger');
const config = require('../config');
const { exchangeCodeForTokens, spotifyApi: baseSpotifyApi } = require('./spotifyAuth');
const User = require('../database/models/User');

// Simple function to generate a random state string for OAuth (remains the same)
const generateRandomString = (length) => {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < length; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
};

module.exports = (client) => {
    // Check if essential Spotify config is present before creating server
    const spotifyClientId = process.env.SPOTIFY_CLIENT_ID;
    const spotifyClientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    const spotifyRedirectUri = process.env.SPOTIFY_REDIRECT_URI;

    if (!spotifyClientId || !spotifyClientSecret || !spotifyRedirectUri) {
        logger.error("Spotify credentials missing in .env. Spotify auth server WILL NOT START.");
        return null; // Return null or indicate failure clearly
    } else {
         logger.info(`Spotify Redirect URI configured as: ${spotifyRedirectUri}`);
         logger.warn(`Ensure this EXACTLY matches the URI in your Spotify Developer Dashboard!`);
    }

    // Create Express app only if config is valid
    const app = express();
    const port = process.env.PORT || 8888;
    let serverInstance = null; // To hold the server instance

    app.use(cookieParser());

    // --- Spotify Callback Route ---
    app.get(config.spotify.callbackPath, async (req, res) => {
        const code = req.query.code || null;
        const stateFromQuery = req.query.state || null; // State received from Spotify
        const error = req.query.error || null;

        logger.debug(`Spotify Callback Received Raw Query: ${JSON.stringify(req.query)}`);

        // --- Handle Errors from Spotify ---
        if (error) {
            logger.error(`Spotify callback returned an error: ${error}`);
            let userMessage = `Spotify returned an error: ${error}.`;
            if (error === 'access_denied') {
                 userMessage = 'You denied the application access. Please try again and authorize the connection if you wish to link your account.';
            }
            // Avoid crashing on double response sending
            if (!res.headersSent) {
                return res.status(400).send(`<html><body><h1>Login Failed</h1><p>${userMessage}</p><p>You can close this window.</p></body></html>`);
            } else {
                 logger.warn("Headers already sent, could not send Spotify error response to user.");
                 return;
            }
        }

        // --- Validate State ---
        let discordId = null;
        let randomString = null;

        if (!stateFromQuery) {
            logger.error(`Spotify callback state parameter is MISSING.`);
             if (!res.headersSent) {
                return res.status(400).send(`<html><body><h1>Login Failed</h1><p>State validation failed: The required state parameter was missing in the response from Spotify. Please try initiating the login from the bot again.</p></body></html>`);
             } return;
        }
        if (!stateFromQuery.includes(':')) {
            logger.error(`Spotify callback state parameter is MALFORMED (missing ':'). Received: ${stateFromQuery}`);
             if (!res.headersSent) {
                return res.status(400).send(`<html><body><h1>Login Failed</h1><p>State validation failed: The state parameter received from Spotify was malformed. Please try initiating the login from the bot again.</p></body></html>`);
             } return;
        }
        const stateParts = stateFromQuery.split(':');
        if (stateParts.length !== 2 || !stateParts[0] || !stateParts[1]) {
             logger.error(`Could not extract valid Discord User ID or random string from state. Received: ${stateFromQuery}`);
              if (!res.headersSent) {
                return res.status(400).send(`<html><body><h1>Login Failed</h1><p>State validation failed: Could not properly parse the required information from the state parameter. Please try initiating the login from the bot again.</p></body></html>`);
              } return;
        }
        [discordId, randomString] = stateParts;
        logger.info(`Spotify callback state validated for Discord User ID: ${discordId}`);

        // --- Exchange Code for Tokens ---
        if (!code) {
             logger.error(`Spotify callback missing authorization code for user ${discordId}.`);
             if (!res.headersSent) {
                return res.status(400).send(`<html><body><h1>Login Failed</h1><p>No authorization code received from Spotify. Please try again.</p></body></html>`);
             } return;
        }

        try {
            const tokenData = await exchangeCodeForTokens(code);
            if (!tokenData || !tokenData.access_token || !tokenData.refresh_token) {
                throw new Error("Failed to exchange authorization code for tokens. Check bot logs for details.");
            }
            logger.info(`Successfully obtained Spotify tokens for Discord user ${discordId}`);

            const userSpotifyApi = new (require('spotify-web-api-node'))({ accessToken: tokenData.access_token });
            const spotifyUser = await userSpotifyApi.getMe();
            const spotifyUserId = spotifyUser.body.id;
            const spotifyDisplayName = spotifyUser.body.display_name || spotifyUserId;
            if (!spotifyUserId) throw new Error("Could not retrieve Spotify User ID after obtaining tokens.");
            logger.info(`Retrieved Spotify User ID (${spotifyUserId}) and display name (${spotifyDisplayName})`);

            const expiryDate = new Date(Date.now() + tokenData.expires_in * 1000);
            const currentUserTag = client.users.cache.get(discordId)?.tag || 'UnknownTag'; // Attempt to get current tag

            const user = await User.findOneAndUpdate(
                { discordId: discordId },
                {
                    $set: {
                        'spotify.userId': spotifyUserId,
                        'spotify.accessToken': tokenData.access_token,
                        'spotify.refreshToken': tokenData.refresh_token,
                        'spotify.tokenExpiry': expiryDate,
                        'spotify.scopes': tokenData.scope ? tokenData.scope.split(' ') : [],
                        'spotify.linkedAt': new Date(),
                        discordTag: currentUserTag
                    }
                },
                { new: true, upsert: false }
            );

            if (!user) {
                logger.error(`User ${discordId} not found in DB during Spotify callback update.`);
                 if (!res.headersSent) {
                    return res.status(404).send(`<html><body><h1>Login Failed</h1><p>Could not find your user profile in the bot's database. Please try using a bot command first and then attempt linking again.</p></body></html>`);
                 } return;
            }
            logger.info(`Successfully linked Spotify account ${spotifyDisplayName} (${spotifyUserId}) to Discord user ${user.discordTag} (${discordId}) in DB.`);

            // --- Success Response ---
             if (!res.headersSent) {
                res.send(`<html><body style="font-family: sans-serif; text-align: center; padding-top: 50px;"><h1>Login Successful!</h1><p>Thank you, ${user.discordTag}!</p><p>Your Spotify account (<b>${spotifyDisplayName}</b>) has been successfully linked to Samuel Jefferson.</p><p>You can now close this window.</p></body></html>`);
             }

            // Optional: Send DM confirmation
            client.users.fetch(discordId).then(discordUser => {
                if (discordUser) {
                    discordUser.send(`Huzzah! Your Spotify account (${spotifyDisplayName}) has been successfully linked. You may now utilize the full extent of my musical capabilities.`).catch(dmError => {
                         logger.warn(`Failed to send DM confirmation to user ${discordId}:`, dmError.message);
                    });
                }
            }).catch(fetchErr => {
                 logger.warn(`Could not fetch user ${discordId} to send DM confirmation: ${fetchErr.message}`);
            });

        } catch (err) {
             logger.error(`Error processing Spotify callback for user ${discordId}:`, err);
             if (!res.headersSent) {
                res.status(500).send(`<html><body><h1>Login Failed</h1><p>An internal error occurred while processing your Spotify login. Please check the bot's console logs for more details or contact the administrator.</p><p>Error: ${err.message || 'Unknown error'}</p></body></html>`);
             }
        }
    });

    // --- Basic Root Route ---
    app.get('/', (req, res) => {
        // Check if headers already sent before sending response
        if (!res.headersSent) {
            res.send(`<html><body><h1>Samuel Jefferson Bot - Spotify Auth</h1><p>This server handles Spotify authentication callbacks at the ${config.spotify.callbackPath} path.</p></body></html>`);
        }
    });

    // --- Start Server ---
    try {
        // Explicitly bind to '0.0.0.0' to listen on all available interfaces
        // This can help in environments like Docker or WSL.
        serverInstance = app.listen(port, '0.0.0.0', () => {
            logger.info(`Spotify OAuth callback server listening on all interfaces at http://<your-ip>:${port}`);
            logger.info(`Ensure your Redirect URI uses the correct hostname (e.g., localhost or public IP/domain) and port ${port}.`);
        });

        // Add error handling for the server instance itself
        serverInstance.on('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                logger.error(`FATAL: Port ${port} is already in use. Cannot start Spotify OAuth server.`);
            } else {
                logger.error(`Spotify OAuth server error:`, error);
            }
            // Optionally attempt to exit if server fails critically
            // process.exit(1);
        });

        logger.info(`Attempted to start Spotify OAuth server on port ${port}.`);

    } catch (serverError) {
         logger.error(`Failed to initiate Spotify OAuth server listening on port ${port}:`, serverError);
    }

    // Return the app instance OR the server instance if needed elsewhere
    // Returning app is common for testing, serverInstance for potential shutdown logic
    return { app, serverInstance };
};