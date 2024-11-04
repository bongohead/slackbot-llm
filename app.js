require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const { WebClient } = require('@slack/web-api');
const crypto = require('crypto');

const app = express();
const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

// Middleware to capture raw body for Slack signature verification
app.use('/slack/commands', bodyParser.urlencoded({ extended: true, verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');  // Capture raw body as string
}}));

// Use JSON body parser for other routes
app.use(bodyParser.json());

const PORT = process.env.PORT || 3002;

// Function to verify Slack's request signature
// Modify verifySlackRequest to log whether the signature matched or not
function verifySlackRequest(req) {
    const slackSignature = req.headers['x-slack-signature'];
    const slackTimestamp = req.headers['x-slack-request-timestamp'];
    const time = Math.floor(Date.now() / 1000);

    // Check if the request is too old
    if (Math.abs(time - slackTimestamp) > 300) {
        console.warn('Request timestamp is too old.');
        return false;
    }

    // Use raw body for slash commands; fallback to JSON.stringify for other routes
    const sigBasestring = `v0:${slackTimestamp}:${req.rawBody || JSON.stringify(req.body)}`;
    const hmac = crypto.createHmac('sha256', process.env.SLACK_SIGNING_SECRET);
    hmac.update(sigBasestring);
    const mySignature = `v0=${hmac.digest('hex')}`;

    const isVerified = crypto.timingSafeEqual(Buffer.from(mySignature, 'utf8'), Buffer.from(slackSignature, 'utf8'));
    console.log(`Signature verification result: ${isVerified}`);
    return isVerified;
}

// Function to get user's name
async function getUserName(userId) {
    try {
        const result = await slackClient.users.info({ user: userId });
        return result.user.profile.display_name || result.user.real_name;
    } catch (error) {
        console.error('Error fetching user info:', error.message || error);
        return 'there';
    }
}


// Log startup
console.log('Starting CaramelBot server...');

// Test endpoint to verify the server is running
app.get('/health', (req, res) => {
    res.status(200).send('CaramelBot server is running.');
});

// Helper function to call OpenAI's API
async function getOpenAIResponse(prompt, userName) {
    // console.log(`Requesting OpenAI API with prompt: "${prompt}"`);
    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: 'gpt-4o',
                messages: [
                    {role: 'system', content: "You are Caramelbot, a helpful and useful assistant for responding to Slack messages on an internal Slack channel. The Slack is for a company called Macropredictions, which is an economic forecasting and AI research company. You are based off my whippet dog Caramel, who is extremely active, loves nature, hunting, and goofing, with a slightly masculine personality. You should speak casually yet intelligently, but with a tinge of a Caramel-like personality. You will be talking to your owners/friends, you can refer to them as your friends or by their name! The current message is from " + userName + "."},
                    {role: 'user', content: prompt}
                ],
                max_tokens: 4048
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
                }
            }
        );
        // console.log('Received response from OpenAI API');
        return response.data.choices[0].message.content.trim();  // Chat-based response format
    } catch (error) {
        // console.error('Error calling OpenAI API:', error);
        return 'Sorry, there was an error generating a response.';
    }
}

// Slack event endpoint
app.post('/slack/events', async (req, res) => {
    console.log('Received event from Slack:', JSON.stringify(req.body, null, 2));

    if (!verifySlackRequest(req)) {
        console.warn('Unauthorized request received.');
        return res.status(401).send('Unauthorized');
    }

    const { challenge, event } = req.body;

    // Handle Slack URL verification challenge
    if (challenge) return res.status(200).send({ challenge });

    // Log channel type and event type to trace the source
    console.log(`Event type: ${event.type}, Channel type: ${event.channel_type}`);

    // Determine if the bot should respond based on the type of event and channel type
    let shouldRespond = false;

    if (event.type === 'app_mention') {
        console.log('App mention detected in a channel or MPIM');
        shouldRespond = true;
    } else if (event.channel_type === 'im') {
        console.log('Direct message (1:1 DM) detected');
        shouldRespond = true;
    } else if (event.channel_type === 'mpim' && event.text.includes(`<@${process.env.BOT_USER_ID}>`)) {
        console.log('Multi-person DM (MPIM) detected with bot mention');
        shouldRespond = true;
    }

    if (shouldRespond) {
        const prompt = event.text.replace(/<@[\w]+>/, '').trim();
        console.log(`Prompt extracted: "${prompt}"`);

        try {
            // Fetch user's name
            const userName = await getUserName(event.user);

            // Generate response from OpenAI
            const responseText = await getOpenAIResponse(prompt, userName);

            // Send response back to Slack
            await slackClient.chat.postMessage({
                channel: event.channel,
                text: responseText
            });
            console.log('Response sent to Slack');
        } catch (error) {
            console.error('Error generating or sending response:', error);
        }
    } else {
        console.log('Event ignored: bot was not mentioned or not in a DM');
    }

    res.status(200).send();
});

// Endpoint for slash commands
app.post('/slack/commands', async (req, res) => {
    // Verify Slack request
    if (!verifySlackRequest(req)) {
        console.warn('Unauthorized slash command received.');
        return res.status(401).send('Unauthorized');
    }

    // Immediate response to acknowledge command receipt
    res.status(200).send();  // Acknowledge immediately

    const { text, user_id, user_name, response_url } = req.body;

    // Prepare the prompt for OpenAI with user's name
    const prompt = `${user_name} asks: ${text}`;

    try {
        // Display the command itself using the response URL
        await axios.post(response_url, {
            text: `/${req.body.command} ${text}`,
            response_type: 'in_channel'  // 'in_channel' shows it to all users; 'ephemeral' shows it only to the user
        });
        
        // Generate response from OpenAI
        const responseText = await getOpenAIResponse(prompt, user_name);

        // Send response back to Slack using response_url
        await axios.post(response_url, {
            text: responseText,
            response_type: 'in_channel' // 'in_channel' to share with everyone, 'ephemeral' for private response
        });
        console.log('Response sent via slash command');
    } catch (error) {
        console.error('Error generating or sending slash command response:', error.message || error);
        // Send error message back to Slack
        await axios.post(response_url, {
            text: 'Sorry, there was an error generating a response.'
        });
    }
});


// Start the Express server
app.listen(PORT, () => {
    console.log(`CaramelBot server listening on port ${PORT}`);
});
